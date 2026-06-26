import * as problemFinder from './problemFinder.js';
import * as planner from './planner.js';
import * as repoBuilder from './repoBuilder.js';
import * as repoAnalyzer from './repoAnalyzer.js';
import * as issueManager from './issueManager.js';
import * as codeGenerator from './codeGenerator.js';
import * as sandbox from './sandbox.js';
import * as github from '../services/githubService.js';
import * as email from '../services/emailService.js';
import { throwIfStopped, clearStop } from './runControl.js';
import {
  getSettings,
  resolveModel,
  getProject,
  getIssues,
  addProjectMessage,
  setProjectBuiltRepo,
  getRunById,
  updateRunStatus,
  saveRunProblem,
  saveRunRepo,
  saveRunError,
  addLog,
  getPendingEmailQuery,
  getAnsweredEmailQuery,
} from '../db/repo.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REPLY_POLL_MS = 5 * 60 * 1000;

// Wait until the pending email query for a task is answered. Returns the answer.
async function waitForReply(runId, taskKey) {
  await updateRunStatus(runId, 'waiting_for_reply');
  for (;;) {
    const pending = await getPendingEmailQuery(runId, taskKey);
    if (!pending) break;
    await sleep(REPLY_POLL_MS);
    await email.checkForReplies(runId);
  }
  const answered = await getAnsweredEmailQuery(runId, taskKey);
  return answered?.answer || '';
}

// Build the run plan (problem + tasks + target) for the selected work mode.
async function planRun(runId, settings, project, run) {
  const mode = project.work_mode || 'new_idea';
  const maxTasks = parseInt(project.max_issues, 10) || 8;
  const self = settings.github_username;
  const token = settings.github_token;

  // CHANGE run: apply the user's new instruction to the existing repo, with
  // the full conversation history as context.
  if (run.kind === 'change' && project.builtRepo) {
    const { owner, name } = project.builtRepo;
    await updateRunStatus(runId, 'analyzing_repo');
    const meta = await github.getRepo(owner, name);
    const base = meta.default_branch;
    const sandboxDir = await sandbox.createWorkspace(runId);
    await addLog(runId, `📥 Cloning ${owner}/${name}…`);
    const cloned = await sandbox.cloneRepo(sandboxDir, owner, name, token);
    if (!cloned.ok) throw new Error(`git clone failed: ${cloned.output.slice(-400)}`);
    const files = await sandbox.readProject(sandboxDir);
    const history = (project.messages || []).slice(-12).map((m) => ({ role: m.role, text: m.text }));
    const problem = await planner.planChange(
      {
        repoName: name,
        instruction: run.userMessage,
        history,
        projectFiles: files,
        maxIssues: Math.min(maxTasks, 4),
        images: run.images || [],
        documents: run.documents || [],
      },
      runId
    );
    await saveRunProblem(runId, problem);
    await saveRunRepo(runId, { name, html_url: meta.html_url });
    const target = {
      commitOwner: owner, commitRepo: name, commitBase: base,
      prOwner: owner, prRepo: name, prBase: base, headPrefix: '',
      canMerge: true, issueOwner: owner, issueRepo: name, createIssues: false,
    };
    return { problem, tasks: problem.tasks, target, sandboxDir };
  }

  if (mode === 'new_idea') {
    await updateRunStatus(runId, 'finding_problem');
    const problem = await problemFinder.findProblem(
      {
        brief: run.userMessage || project.brief,
        domain: project.domain,
        images: run.images?.length ? run.images : project.images || [],
        documents: run.documents?.length ? run.documents : project.documents || [],
      },
      maxTasks,
      runId
    );
    await saveRunProblem(runId, problem);

    await updateRunStatus(runId, 'creating_repo');
    const repo = await repoBuilder.buildRepo(problem, runId);
    await saveRunRepo(runId, repo);

    const base = repo.default_branch || 'main';
    const tasks = (problem.issues || []).map((it) => ({ title: it.title, body: it.body || '', issueNumber: null, labels: it.labels }));
    const target = {
      commitOwner: self, commitRepo: repo.name, commitBase: base,
      prOwner: self, prRepo: repo.name, prBase: base, headPrefix: '',
      canMerge: true, issueOwner: self, issueRepo: repo.name, createIssues: true,
    };
    return { problem, tasks, target, sandboxDir: await sandbox.createWorkspace(runId) };
  }

  // fix_repo / open_source both operate on an existing repo.
  const parsed = github.parseRepo(project.target_repo);
  if (!parsed) throw new Error(`Invalid target repo "${project.target_repo}". Use owner/name or a GitHub URL.`);

  await updateRunStatus(runId, 'analyzing_repo');
  const meta = await github.getRepo(parsed.owner, parsed.repo);
  const upstreamBase = meta.default_branch;

  const sandboxDir = await sandbox.createWorkspace(runId);
  await addLog(runId, `📥 Cloning ${parsed.owner}/${parsed.repo}…`);
  const cloned = await sandbox.cloneRepo(sandboxDir, parsed.owner, parsed.repo, token);
  if (!cloned.ok) throw new Error(`git clone failed: ${cloned.output.slice(-500)}`);

  const repoMeta = {
    owner: parsed.owner, repo: parsed.repo, full_name: meta.full_name,
    description: meta.description, language: meta.language,
  };
  const problem = await repoAnalyzer.analyze(repoMeta, sandboxDir, mode, maxTasks, runId);
  await saveRunProblem(runId, problem);
  await saveRunRepo(runId, { name: parsed.repo, html_url: meta.html_url });

  if (mode === 'fix_repo') {
    const target = {
      commitOwner: parsed.owner, commitRepo: parsed.repo, commitBase: upstreamBase,
      prOwner: parsed.owner, prRepo: parsed.repo, prBase: upstreamBase, headPrefix: '',
      canMerge: true, issueOwner: parsed.owner, issueRepo: parsed.repo, createIssues: problem.createIssues,
    };
    return { problem, tasks: problem.tasks, target, sandboxDir };
  }

  // open_source: fork upstream, commit to the fork, PR to upstream (no merge).
  await updateRunStatus(runId, 'forking_repo');
  await addLog(runId, `🍴 Forking ${parsed.owner}/${parsed.repo}…`);
  const fork = await github.forkRepo(parsed.owner, parsed.repo);
  const target = {
    commitOwner: self, commitRepo: fork.name, commitBase: fork.default_branch || upstreamBase,
    prOwner: parsed.owner, prRepo: parsed.repo, prBase: upstreamBase, headPrefix: `${self}:`,
    canMerge: false, issueOwner: parsed.owner, issueRepo: parsed.repo, createIssues: false,
  };
  return { problem, tasks: problem.tasks, target, sandboxDir };
}

export async function runAgent(runId) {
  const run = await getRunById(runId);
  if (!run) {
    console.error(`runAgent: run ${runId} not found`);
    return;
  }

  try {
    const settings = await getSettings();
    const project = run.projectId ? await getProject(run.projectId) : null;
    if (!project) throw new Error('Project not found for this run.');

    const { provider, apiKey } = resolveModel(settings, 'default');
    if (!apiKey) throw new Error(`${provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} API key not configured.`);
    if (!settings.github_token) throw new Error('GitHub token not configured.');

    const kindLabel = run.kind === 'change' ? 'change' : 'build';
    await addLog(runId, `🧭 Project: ${project.name} · ${kindLabel} · Provider: ${provider}`);
    const { problem, tasks, target, sandboxDir } = await planRun(runId, settings, project, run);

    if (!tasks.length) throw new Error('No tasks/issues to work on.');

    await updateRunStatus(runId, 'creating_issues');
    await issueManager.prepareTasks(target, tasks, runId);

    // Baseline: tests already failing in the cloned repo BEFORE our changes, so
    // we don't endlessly "fix" pre-existing failures unrelated to each task.
    let baselineFails = 0;
    if (run.kind === 'change' && settings.verify_enabled !== 'false') {
      await addLog(runId, '🧪 Checking current test status…');
      const base = await sandbox.verify(sandboxDir, (msg) => addLog(runId, msg));
      baselineFails = base.ok ? 0 : base.stage === 'test' ? base.failCount : 0;
      if (baselineFails) await addLog(runId, `ℹ️ ${baselineFails} test(s) already failing before changes — only new regressions will be fixed.`, 'warn');
    }

    for (const task of tasks) {
      throwIfStopped(runId);
      await updateRunStatus(runId, `working_${task.key}`);
      let extraContext = null;
      for (;;) {
        throwIfStopped(runId);
        const result = await codeGenerator.solveTask(target, task, problem, runId, sandboxDir, extraContext, baselineFails);
        if (!result.waiting) {
          if (typeof result.failCount === 'number') baselineFails = result.failCount;
          break;
        }
        extraContext = await waitForReply(runId, task.key);
        await updateRunStatus(runId, `working_${task.key}`);
      }
    }

    await sandbox.cleanupWorkspace(runId);
    await updateRunStatus(runId, 'completed');
    await addLog(runId, '🎉 Run completed.', 'success');

    // Record the working repo (enables conversational follow-ups) and post an
    // assistant message summarising what changed this turn.
    if (!project.builtRepo && project.work_mode !== 'open_source') {
      await setProjectBuiltRepo(project._id, {
        owner: target.commitOwner,
        name: target.commitRepo,
        url: (await getRunById(runId)).repoUrl,
      });
    }
    try {
      const issues = await getIssues(runId);
      const files = [...new Set(issues.flatMap((i) => i.files || []))];
      const prs = issues.filter((i) => i.prNumber).map((i) => ({ number: i.prNumber, url: i.prUrl }));
      const verb = run.kind === 'change' ? 'Applied your change' : 'Built the project';
      const summary =
        `${verb}: ${issues.length} task(s), ${files.length} file(s) changed` +
        (prs.length ? `, ${prs.length} PR(s) merged.` : '.');
      await addProjectMessage(project._id, { role: 'assistant', text: summary, runId, files, prs });
    } catch {
      /* non-fatal */
    }

    try {
      const fresh = await getRunById(runId);
      await email.sendSummary(fresh, { html_url: fresh.repoUrl, name: fresh.repoName });
    } catch (e) {
      await addLog(runId, `⚠️ Could not send summary email: ${e.message}`, 'warn');
    }
  } catch (err) {
    await sandbox.cleanupWorkspace(runId).catch(() => {});
    if (err && err.stopped) {
      // User-requested stop — not a failure, no error email.
      await updateRunStatus(runId, 'stopped');
      await addLog(runId, '🛑 Run stopped by user.', 'warn');
    } else {
      await updateRunStatus(runId, 'failed');
      await saveRunError(runId, err.message);
      await addLog(runId, `❌ Run failed: ${err.message}`, 'error');
      try {
        await email.sendErrorNotification(err, runId);
      } catch {
        /* best-effort */
      }
    }
  } finally {
    clearStop(runId);
  }
}
