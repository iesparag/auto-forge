import { completeJSON } from '../services/claudeService.js';
import * as github from '../services/githubService.js';
import * as issueManager from './issueManager.js';
import * as sandbox from './sandbox.js';
import { pushFiles } from './commitPusher.js';
import * as email from '../services/emailService.js';
import { CONVENTIONS } from './conventions.js';
import { throwIfStopped } from './runControl.js';
import {
  addLog,
  updateIssueByKey,
  createEmailQuery,
  getPendingEmailQuery,
  getSettings,
} from '../db/repo.js';

const SYSTEM = `You are a principal Node.js engineer. Before writing a file, reason about how it fits the architecture, its inputs/outputs, and the edge cases it must handle. You write clean, production-quality, runnable code with thorough error handling and meaningful tests. You produce complete files (never partial snippets, stubs, or "..." placeholders).

${CONVENTIONS}`;

// Cap total context so requests fit within tight TPM rate limits (~10k tokens).
const MAX_CONTEXT_CHARS = 40000;
function renderProject(projectFiles) {
  const entries = Object.entries(projectFiles || {});
  if (!entries.length) return '(empty project so far)';
  let out = '';
  let omitted = 0;
  for (const [p, content] of entries) {
    const block = `--- FILE: ${p} ---\n${content}\n\n`;
    if (out.length + block.length > MAX_CONTEXT_CHARS) {
      omitted++;
      continue;
    }
    out += block;
  }
  if (omitted) out += `[...${omitted} more file(s) omitted to fit context...]`;
  return out || '(project too large to include in full)';
}

function buildInitialPrompt({ target, task, problem, projectFiles, extraContext }) {
  const arch = (problem.files_to_create || []).map((f) => `- ${f.path}: ${f.purpose}`).join('\n');
  let user = `Resolve this task by writing complete, working code.

Repo: ${target.commitRepo}
${task.number ? `Issue #${task.number}: ` : 'Task: '}${task.title}
Description: ${task.body || ''}

Project context: ${problem.problem_statement || problem.description || ''}
Tech stack: ${(problem.tech_stack || []).join(', ')}
${problem.analysis ? `Design analysis (reasoned through up front):\n${problem.analysis}\n` : ''}
${problem.architecture ? `System architecture:\n${problem.architecture}\n` : ''}
${arch ? `Planned files:\n${arch}\n` : ''}
Current project files (full content) — build on these, edit them if needed:
${renderProject(projectFiles)}

Rules:
- Return COMPLETE file contents for every file you create OR modify (no diffs, no "...").
- The project must have a package.json with a runnable "test" or "build" script so the code can be verified.
- Keep the codebase coherent: imports/paths must match existing files.

Respond in EXACT JSON (no markdown):
{
  "files": [ { "path": "relative/path/file.js", "content": "complete file content here" } ],
  "commit_message": "feat: ${task.title}"
}`;
  if (extraContext) user += `\n\nAdditional guidance from the user (apply this):\n${extraContext}`;
  return user;
}

function buildFixPrompt({ target, task, projectFiles, errorOutput }) {
  return `The code for this task in repo ${target.commitRepo} FAILED verification. Fix it.

Verification output (errors):
${errorOutput}

Current project files (full content):
${renderProject(projectFiles)}

Return COMPLETE file contents for every file you need to create or modify to make verification pass.
Respond in EXACT JSON (no markdown):
{
  "files": [ { "path": "...", "content": "..." } ],
  "commit_message": "fix: resolve verification errors"
}`;
}

// Solve one task end-to-end with a self-correcting verify loop.
// Returns { waiting: true } if stuck (email sent), else { waiting: false, files }.
export async function solveTask(target, task, problem, runId, sandboxDir, extraContext = null, baselineFails = 0) {
  await addLog(runId, `🤖 Working on: ${task.title}`);
  await updateIssueByKey(runId, task.key, { status: 'in_progress' });

  const settings = await getSettings();
  const verifyEnabled = settings.verify_enabled !== 'false';
  const maxFix = parseInt(settings.max_fix_attempts, 10) || 3;

  const projectFiles = sandboxDir ? await sandbox.readProject(sandboxDir) : {};

  let result;
  try {
    result = await completeJSON({
      stage: 'codeGenerator',
      system: SYSTEM,
      user: buildInitialPrompt({ target, task, problem, projectFiles, extraContext }),
    });
  } catch (err) {
    return askForHelp(runId, target, task, err);
  }

  const fileMap = {};
  const merge = (files) => {
    for (const f of files || []) if (f && f.path) fileMap[f.path] = f.content ?? '';
  };
  merge(result.files);
  let commitMessage = result.commit_message || `feat: ${task.title}`;

  if (!Object.keys(fileMap).length) {
    await addLog(runId, `⚠️ No files returned for "${task.title}"; skipping.`, 'warn');
    await updateIssueByKey(runId, task.key, { status: 'failed' });
    return { waiting: false, files: [] };
  }

  // Verify → fix loop.
  let finalFails = baselineFails;
  if (verifyEnabled && sandboxDir) {
    for (let attempt = 0; attempt <= maxFix; attempt++) {
      throwIfStopped(runId);
      await sandbox.writeFiles(sandboxDir, toFiles(fileMap));
      await addLog(runId, `🧪 Verifying "${task.title}" (attempt ${attempt + 1})…`);
      const { ok, output, stage, failCount } = await sandbox.verify(sandboxDir, (msg) => addLog(runId, msg));
      if (ok) {
        await addLog(runId, `✅ Verification passed.`, 'success');
        await updateIssueByKey(runId, task.key, { status: 'verified' });
        finalFails = 0;
        break;
      }
      // Pre-existing test failures this task didn't introduce → accept, don't loop.
      if (stage === 'test' && failCount >= 0 && failCount <= baselineFails) {
        await addLog(runId, `ℹ️ ${failCount} pre-existing test failure(s) unrelated to this task — accepting.`, 'warn');
        await updateIssueByKey(runId, task.key, { status: 'committed' });
        finalFails = failCount;
        break;
      }
      const reason = verifyReason(output);
      if (attempt === maxFix) {
        await addLog(runId, `⚠️ Still failing after ${maxFix} fixes: ${reason}`, 'warn');
        finalFails = stage === 'test' ? failCount : baselineFails;
        break;
      }
      await addLog(runId, `🔧 Verification failed: ${reason} — fixing…`, 'warn');
      try {
        const fix = await completeJSON({
          stage: 'codeGenerator',
          system: SYSTEM,
          user: buildFixPrompt({ target, task, projectFiles: { ...projectFiles, ...fileMap }, errorOutput: output }),
        });
        merge(fix.files);
        if (fix.commit_message) commitMessage = fix.commit_message;
      } catch (err) {
        await addLog(runId, `⚠️ Fix generation failed: ${err.message}; committing best effort.`, 'warn');
        break;
      }
    }
  } else if (sandboxDir) {
    await sandbox.writeFiles(sandboxDir, toFiles(fileMap));
  }

  // Commit + PR.
  const branch = issueManager.branchName(task);
  await github.createBranch(target.commitRepo, branch, target.commitBase, target.commitOwner);
  const files = toFiles(fileMap);
  await pushFiles(target, files, commitMessage, branch, runId);
  await issueManager.finalizeTask(target, task, branch, runId, commitMessage, Object.keys(fileMap));

  return { waiting: false, files: Object.keys(fileMap), failCount: finalFails };
}

function toFiles(map) {
  return Object.entries(map).map(([path, content]) => ({ path, content }));
}

// Pull the most informative line(s) out of verify output for the dashboard log.
function verifyReason(output) {
  const lines = (output || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return 'unknown error';
  const header = lines.find((l) => /failed:|Syntax error|not valid JSON/i.test(l));
  const errLine = [...lines].reverse().find((l) => /error|err!|cannot|not found|fail|missing/i.test(l));
  return (header ? header + ' ' : '') + (errLine || lines[lines.length - 1]).slice(0, 240);
}

async function askForHelp(runId, target, task, err) {
  await addLog(runId, `⚠️ Code generation failed for "${task.title}": ${err.message}`, 'warn');
  const pending = await getPendingEmailQuery(runId, task.key);
  if (!pending) {
    const question = `Could not generate valid code for this task after several attempts.\nLast error: ${err.message}\n\nTask:\n${task.body || task.title}`;
    await createEmailQuery(runId, task.key, task.number, question);
    try {
      await email.sendQuery({ runId, repoName: target.commitRepo, issueNumber: task.number || '—', question });
      await addLog(runId, `✉️  Emailed you for help; pausing.`, 'warn');
    } catch (mailErr) {
      await addLog(runId, `❌ Could not send help email: ${mailErr.message}`, 'error');
    }
  }
  return { waiting: true };
}
