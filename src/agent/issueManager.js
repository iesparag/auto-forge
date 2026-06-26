import * as github from '../services/githubService.js';
import { addLog, createIssueRecord, updateIssueByKey } from '../db/repo.js';

const slugify = (s) =>
  (s || 'task')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

export const branchName = (task) =>
  `${task.number ? `fix/issue-${task.number}` : 'task'}-${slugify(task.title)}`.slice(0, 60);

// Prepare tasks: optionally create GitHub issues (for repos we own), and record
// each task in the DB. Mutates each task with `.key` and `.number`.
// `target` = { commitOwner, commitRepo, createIssues }
export async function prepareTasks(target, tasks, runId) {
  let i = 0;
  for (const task of tasks) {
    task.key = task.issueNumber ? `gh-${task.issueNumber}` : `task-${i}`;
    task.number = task.issueNumber || null;

    if (!task.number && target.createIssues) {
      const labels = Array.isArray(task.labels) ? task.labels : [];
      const gh = await github.createIssue(target.issueRepo, task.title, task.body || '', labels, target.issueOwner);
      task.number = gh.number;
      task.key = `gh-${gh.number}`;
      await github.addLabels(target.issueRepo, gh.number, ['in-progress'], target.issueOwner);
    }
    await createIssueRecord(runId, task.key, task.title, task.number);
    i++;
  }
  await addLog(runId, `📝 Prepared ${tasks.length} task(s).`, 'success');
  return tasks;
}

// Open a PR for an already-committed branch. Merges + closes the issue only when
// we own the repo (canMerge). Records PR + files on the task's Issue doc.
export async function finalizeTask(target, task, branch, runId, summary, files) {
  const body = `${summary || 'Implementation for this task.'}${task.number ? `\n\nCloses #${task.number}.` : ''}`;
  const pr = await github.createPR({
    owner: target.prOwner,
    repo: target.prRepo,
    head: target.headPrefix + branch,
    base: target.prBase,
    title: task.number ? `closes #${task.number}: ${task.title}` : task.title,
    body,
  });

  const fields = { branch, files: files || [], prNumber: pr.number, prUrl: pr.html_url };

  if (target.canMerge) {
    await github.mergePR(target.prRepo, pr.number, target.prOwner);
    if (task.number) {
      await github.addIssueComment(target.issueRepo, task.number, `Resolved in #${pr.number}.`, target.issueOwner);
      await github.addLabels(target.issueRepo, task.number, ['completed'], target.issueOwner);
      await github.closeIssue(target.issueRepo, task.number, target.issueOwner);
    }
    fields.status = 'completed';
    await addLog(runId, `✅ ${task.title} — PR #${pr.number} merged.`, 'success');
  } else {
    // Open source: we can't merge upstream; leave the PR open for review.
    fields.status = 'pr_open';
    await addLog(runId, `🔀 ${task.title} — PR #${pr.number} opened upstream (awaiting maintainer): ${pr.html_url}`, 'success');
  }

  await updateIssueByKey(runId, task.key, fields);
  return { prNumber: pr.number, prUrl: pr.html_url };
}
