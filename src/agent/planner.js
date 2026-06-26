import { complete, completeJSON } from '../services/claudeService.js';
import { CONVENTIONS } from './conventions.js';
import { addLog } from '../db/repo.js';

const ANALYST_SYSTEM = `You are a principal software engineer doing a deep design analysis BEFORE any code is written. Think rigorously and step by step, the way a senior engineer reasons through a problem.`;

// Deep, step-by-step reasoning pass — produces a design analysis that the
// planner and code generator build on (this is the "thinking" step).
async function analyze({ spec, domain, images = [], documents = [] }, runId) {
  await addLog(runId, '🧠 Thinking through the design (requirements, data model, edge cases)…');
  const docsBlock = documents.length
    ? '\n\nReference material from attached files:\n' + documents.map((d) => `--- ${d.name} ---\n${d.text}`).join('\n\n')
    : '';
  const user = `Analyse this software project request and produce a rigorous design analysis.

Request:
${spec}
Domain: ${domain}${docsBlock}
${images.length ? '\n(Images are attached — study them.)' : ''}

Work step by step and cover, in Markdown:
1. Restated requirements & explicit assumptions
2. Core domain entities and the data model (fields, relationships)
3. Architecture: components, folder structure, how data flows
4. Key user/API flows
5. Edge cases, failure modes, and how to handle them
6. Security, validation, and configuration concerns
7. Testing strategy (what to test)
8. An ordered, incremental build approach (which feature first and why)

Be concrete and specific to THIS project — no generic filler.`;

  try {
    return await complete({ stage: 'problemFinder', system: ANALYST_SYSTEM, user, maxTokens: 4000 });
  } catch {
    return ''; // analysis is best-effort; planning continues without it
  }
}

const SYSTEM = `You are a principal software architect. You design substantial, real-world backend/API/CLI systems and break them into a coherent, ordered set of implementation issues that together build the COMPLETE system with working code and passing tests. You reason carefully about data models, edge cases, and how the pieces fit before deciding the breakdown.

${CONVENTIONS}`;

// Build a full project plan from either an explicit brief or trending topics.
// Returns: { title, display_name, description, problem_statement, tech_stack,
//            architecture (md), plan (md), files_to_create[], issues[] }
export async function buildPlan({ brief, trends, domain, maxIssues, images = [], documents = [] }, runId) {
  const hasBrief = brief && brief.trim();
  await addLog(runId, hasBrief ? '🧱 Planning your project…' : '🧱 Choosing & planning a project…');
  if (images.length) await addLog(runId, `🖼️  Using ${images.length} uploaded image(s) for context.`);
  if (documents.length) await addLog(runId, `📄 Using ${documents.length} uploaded document(s) for context.`);

  const docsBlock = documents.length
    ? '\n\nReference material extracted from uploaded files:\n' +
      documents.map((d) => `--- ${d.name} ---\n${d.text}`).join('\n\n')
    : '';

  const spec = hasBrief
    ? `Build EXACTLY this project (this is the user's brief — honour it precisely):\n"""\n${brief.trim()}\n"""`
    : `Pick ONE ambitious, portfolio-worthy project for the domain "${domain}" from these trending topics, then plan it:\n${JSON.stringify(trends || [], null, 2)}`;
  const imageNote = images.length
    ? '\n\nThe user attached image(s) (designs, diagrams, schemas, or screenshots). Study them and let them inform the architecture, data models, and features.'
    : '';

  // Deep reasoning pass first — the plan is built ON TOP of this analysis.
  const analysis = await analyze({ spec, domain, images, documents }, runId);
  const analysisBlock = analysis
    ? `\n\nUse this design analysis (already reasoned through) as the foundation:\n${analysis}`
    : '';

  const user = `${spec}${imageNote}${docsBlock}${analysisBlock}

Design a substantial system (not a toy). Produce a complete plan with a real architecture and ${maxIssues} ordered issues that together implement the WHOLE thing with working code and passing tests.

CRITICAL — one issue per FEATURE/MODULE, not per file or per trivial tweak:
- Issue 1 MUST scaffold the project: package.json (with a runnable "test" script), folder structure, base config, .gitignore, README, .env.example.
- Every issue AFTER #1 must implement ONE complete, user-facing feature/module end to end — its data model + business logic + API/CLI surface + tests, all in that one issue. Name each issue by the feature (e.g. "User authentication (register, login, JWT)", "Task management (CRUD, status, assignees)", "Order management", "Rider assignment").
- Do NOT create issues for a single file, or for trivial/infra chores like "add env validation", "add a config file", "add error middleware" — fold those into the relevant feature or the scaffolding issue.
- Pick the most important ${maxIssues - 1} features that fit; each issue body lists the files it creates/modifies and what each must do.

Respond in EXACT JSON (no markdown, no commentary):
{
  "title": "short-repo-name-with-dashes",
  "display_name": "Human Readable Project Name",
  "description": "One-sentence description",
  "problem_statement": "What it does and for whom",
  "tech_stack": ["node", "express", "..."],
  "architecture": "Markdown: components, folder tree, data flow, key decisions",
  "plan": "Markdown: ordered build plan and milestones",
  "files_to_create": [ { "path": "src/index.js", "purpose": "..." } ],
  "issues": [
    { "title": "Setup project structure and dependencies", "body": "Detailed, file-by-file...", "labels": ["setup"] }
  ]
}`;

  const plan = await completeJSON({ stage: 'problemFinder', system: SYSTEM, user, maxTokens: 16000, images });

  plan.title = (plan.title || 'project')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);
  plan.issues = Array.isArray(plan.issues) ? plan.issues.slice(0, maxIssues) : [];
  plan.files_to_create = Array.isArray(plan.files_to_create) ? plan.files_to_create : [];
  plan.architecture = plan.architecture || '';
  plan.plan = plan.plan || '';
  plan.analysis = analysis || ''; // the deep reasoning, used in code-gen + DESIGN.md

  await addLog(runId, `💡 Project: ${plan.display_name || plan.title} — ${plan.issues.length} issues planned.`, 'success');
  return plan;
}

const CHANGE_SYSTEM = `You are a principal engineer applying a requested CHANGE to an existing codebase. First reason about what the request really implies: which files/modules it touches, ripple effects, edge cases, and tests that must be updated. Honour the conversation so far and implement exactly what the user now asks — no more, no unrelated rewrites. Break the change into a few concrete, ordered tasks. ${CONVENTIONS}`;

// Plan a follow-up change to an existing repo from the user's new instruction,
// the conversation history, and the current files.
// Returns { tasks: [{title, body, issueNumber:null}] } plus display fields.
export async function planChange({ repoName, instruction, history = [], projectFiles = {}, maxIssues = 4, images = [], documents = [] }, runId) {
  await addLog(runId, '🧠 Planning your change (with full history)…');
  if (images.length) await addLog(runId, `🖼️  Using ${images.length} attached image(s).`);
  if (documents.length) await addLog(runId, `📄 Using ${documents.length} attached document(s).`);
  const convo = history.length
    ? history.map((m) => `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${m.text}`).join('\n')
    : '(no prior messages)';
  const filesBlock = Object.entries(projectFiles)
    .map(([p, c]) => `--- FILE: ${p} ---\n${c}`)
    .join('\n\n')
    .slice(0, 60000);

  const user = `Repository: ${repoName}

Conversation so far:
${convo}

The user's NEW request:
"""
${instruction}
"""
${documents.length ? '\nReference material from attached files:\n' + documents.map((d) => `--- ${d.name} ---\n${d.text}`).join('\n\n') : ''}
${images.length ? '\n(The user also attached image(s) — study them.)' : ''}

Current project files:
${filesBlock || '(empty)'}

Produce up to ${maxIssues} concrete task(s) that implement ONLY this new request, building on the existing code and prior context. Each task lists the files to create/modify and what to do.

Respond in EXACT JSON (no markdown):
{ "tasks": [ { "title": "short title", "body": "file-by-file detail" } ] }`;

  const result = await completeJSON({ stage: 'codeGenerator', system: CHANGE_SYSTEM, user, maxTokens: 16000, images });
  const tasks = (Array.isArray(result.tasks) ? result.tasks : [])
    .slice(0, maxIssues)
    .map((t) => ({ title: t.title, body: t.body || '', issueNumber: null }));
  await addLog(runId, `📋 ${tasks.length} change task(s) planned.`, 'success');
  return {
    title: repoName,
    display_name: repoName,
    description: instruction.slice(0, 120),
    problem_statement: instruction,
    tech_stack: [],
    architecture: '',
    plan: '',
    files_to_create: [],
    tasks,
  };
}
