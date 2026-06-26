import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import {
  getSettings,
  listPendingEmailQueries,
  answerEmailQuery,
  addLog,
} from '../db/repo.js';

// mailparser ships with nodemailer's deps; if unavailable we fall back to raw text.
let parserAvailable = true;
async function parseBody(source) {
  if (!parserAvailable) return source.toString();
  try {
    const parsed = await simpleParser(source);
    return (parsed.text || parsed.html || '').toString();
  } catch {
    return source.toString();
  }
}

function shortId(runId) {
  return String(runId).slice(0, 8);
}

async function transporter() {
  const s = await getSettings();
  if (!s.gmail_user || !s.gmail_app_password) {
    throw new Error('Gmail credentials are not configured. Set them in Settings.');
  }
  return {
    tx: nodemailer.createTransport({
      service: 'gmail',
      auth: { user: s.gmail_user, pass: s.gmail_app_password },
    }),
    settings: s,
  };
}

async function send({ to, subject, text }) {
  const { tx, settings } = await transporter();
  await tx.sendMail({ from: settings.gmail_user, to, subject, text });
}

// Sent when Claude is stuck. Subject embeds the run id so replies can be matched.
export async function sendQuery({ runId, repoName, issueNumber, question }) {
  const s = await getSettings();
  const subject = `Need your input on issue #${issueNumber} [#${shortId(runId)}]`;
  const text = `Hi,

A task could not be completed automatically and needs your input.

Repository: ${repoName}
Issue #${issueNumber}

Details:
${question}

To continue, please REPLY to this email with your answer/instruction
(keep the subject line so the reply can be matched). Replies are checked
every 5 minutes and work resumes automatically.

[ref:${runId}]`;
  await send({ to: s.user_email, subject, text });
}

export async function sendSummary(run, repo) {
  const s = await getSettings();
  const subject = `Completed: ${run.problemTitle || repo?.name || 'task'} [#${shortId(run._id)}]`;
  const text = `Work finished.

Project: ${run.problemTitle}
Repository: ${repo?.html_url || run.repoUrl}`;
  await send({ to: s.user_email, subject, text });
}

export async function sendErrorNotification(err, runId) {
  const s = await getSettings();
  if (!s.user_email) return; // nothing configured; skip silently
  const subject = `A task failed [#${shortId(runId)}]`;
  const text = `A fatal error occurred on task ${runId}:

${err?.stack || err?.message || String(err)}`;
  try {
    await send({ to: s.user_email, subject, text });
  } catch {
    /* email itself failed — already logged elsewhere */
  }
}

export async function sendTestEmail() {
  const s = await getSettings();
  if (!s.user_email) throw new Error('Set "user_email" in Settings first.');
  await send({
    to: s.user_email,
    subject: 'Test email',
    text: 'This is a test email. Your email configuration works.',
  });
  return { ok: true, to: s.user_email };
}

// Poll the mailbox for replies to pending queries for a run. Matches on the
// short run id appearing in the message subject. Stores the answer and sends a
// confirmation. Returns the number of queries answered.
export async function checkForReplies(runId) {
  const pending = await listPendingEmailQueries(runId);
  if (!pending.length) return 0;

  const s = await getSettings();
  if (!s.gmail_user || !s.gmail_app_password) return 0;

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: s.gmail_user, pass: s.gmail_app_password },
    logger: false,
  });

  let answered = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const tag = shortId(runId);
      for (const query of pending) {
        // Search messages received since the query was sent whose subject
        // carries the run tag.
        const uids = await client.search({
          since: new Date(query.sentAt),
          subject: tag,
        });
        if (!uids || !uids.length) continue;
        // Take the most recent matching message.
        const uid = uids[uids.length - 1];
        const msg = await client.fetchOne(uid, { source: true });
        if (!msg?.source) continue;
        const body = (await parseBody(msg.source)).trim();
        if (!body) continue;
        await answerEmailQuery(query._id, body);
        answered++;
        await addLog(runId, `📨 Received reply for issue #${query.issueNumber}; resuming.`, 'success');
        try {
          await send({
            to: s.user_email,
            subject: `Got it — resuming work on issue #${query.issueNumber} [#${tag}]`,
            text: 'Thanks — your reply was received and work is resuming.',
          });
        } catch {
          /* confirmation is best-effort */
        }
      }
    } finally {
      lock.release();
    }
  } catch (err) {
    await addLog(runId, `⚠️ IMAP reply check failed: ${err.message}`, 'warn');
  } finally {
    try {
      await client.logout();
    } catch {
      /* ignore */
    }
  }
  return answered;
}
