import { completeJSON } from '../services/claudeService.js';
import * as github from '../services/githubService.js';
import * as sandbox from './sandbox.js';
import { addLog } from '../db/repo.js';

// Keep context small so requests fit within tight TPM rate limits (~10k tokens).
const MAX_CONTEXT_CHARS = 40000;

function renderRepo(projectFiles) {
  let out = '';
  for (const [p, content] of Object.entries(projectFiles)) {
    const block = `--- FILE: ${p} ---\n${content}\n\n`;
    if (out.length + block.length > MAX_CONTEXT_CHARS) {
      out += `\n[...additional files omitted for length...]`;
      break;
    }
    out += block;
  }
  return out || '(no readable source files)';
}

const SYSTEM = `You are a senior software engineer reviewing an existing repository. You propose concrete, self-contained bug fixes and improvements that a developer could implement and verify in isolation. The work must read as a human's: never mention AI, Claude, AutoForge, or "auto-generated" anywhere.`;

// Build a task list for an existing repo.
// mode: 'fix_repo' (your repo) | 'open_source' (fork & upstream PR)
// Returns { display_name, description, problem_statement, tech_stack,
//           files_to_create: [], tasks: [{title, body, issueNumber|null}],
//           createIssues: bool }
export async function analyze(repoMeta, dir, mode, maxTasks, runId) {
  const { owner, repo } = repoMeta;
  await addLog(runId, `🔬 Analyzing ${owner}/${repo}…`);

  // Prefer existing open issues (especially for open source).
  let openIssues = [];
  try {
    openIssues = await github.listOpenIssues(owner, repo, maxTasks);
  } catch (e) {
    await addLog(runId, `⚠️ Could not list issues: ${e.message}`, 'warn');
  }

  const base = {
    title: repo,
    display_name: repoMeta.full_name || `${owner}/${repo}`,
    description: repoMeta.description || '',
    problem_statement: `Improve and fix issues in the existing repository ${owner}/${repo}.`,
    tech_stack: repoMeta.language ? [repoMeta.language] : [],
    files_to_create: [],
  };

  // Open-source with existing issues → work those directly, don't create new ones.
  if (mode === 'open_source' && openIssues.length) {
    await addLog(runId, `📋 Found ${openIssues.length} open issue(s); will address up to ${maxTasks}.`);
    return {
      ...base,
      tasks: openIssues.slice(0, maxTasks).map((i) => ({ title: i.title, body: i.body, issueNumber: i.number })),
      createIssues: false,
    };
  }

  // Otherwise analyze the code to propose tasks.
  const projectFiles = await sandbox.readProject(dir);
  const user = `Repository: ${owner}/${repo}
Mode: ${mode}
Existing open issues:
${openIssues.length ? openIssues.map((i) => `#${i.number} ${i.title}`).join('\n') : '(none)'}

Codebase (files + content):
${renderRepo(projectFiles)}

Propose up to ${maxTasks} SUBSTANTIAL, self-contained improvements for THIS codebase — real features, meaningful refactors, or genuine bug fixes that add value. Each must be independently implementable and verifiable against the project's tests/build.

Do NOT propose trivial or cosmetic tasks: no "fix a typo", no "add a config/plugin", no README wording tweaks, no formatting-only changes. If the codebase has few meaningful improvements, return fewer tasks rather than padding with nits.

Respond in EXACT JSON (no markdown):
{
  "tasks": [
    { "title": "short task title", "body": "what to change and why, referencing real files" }
  ]
}`;

  const result = await completeJSON({ stage: 'problemFinder', system: SYSTEM, user });
  const tasks = (Array.isArray(result.tasks) ? result.tasks : [])
    .slice(0, maxTasks)
    .map((t) => ({ title: t.title, body: t.body || '', issueNumber: null }));

  await addLog(runId, `📋 Proposed ${tasks.length} task(s) for ${owner}/${repo}.`, 'success');
  // For your own repo we create issues; for open source without issues we just PR.
  return { ...base, tasks, createIssues: mode === 'fix_repo' };
}
