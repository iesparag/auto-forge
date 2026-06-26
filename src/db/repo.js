import mongoose from 'mongoose';
import { encrypt, decrypt } from '../utils/crypto.js';

const Setting = mongoose.model('Setting');
const User = mongoose.model('User');
const Project = mongoose.model('Project');
const Run = mongoose.model('Run');
const RunLog = mongoose.model('RunLog');
const Issue = mongoose.model('Issue');
const EmailQuery = mongoose.model('EmailQuery');

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

// Keys whose values are encrypted at rest.
export const SECRET_KEYS = [
  'anthropic_api_key',
  'openai_api_key',
  'github_token',
  'gmail_app_password',
  'dashboard_password', // bcrypt hash — encrypted again for defence in depth
];

// Per-provider model lists (picker) and priority tiers.
// `effort` only applies to Anthropic (output_config.effort); OpenAI ignores it.
export const PROVIDERS = {
  openai: {
    label: 'OpenAI',
    keyField: 'openai_api_key',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini'],
    tiers: {
      fast: { model: 'gpt-4o-mini' },
      balanced: { model: 'gpt-4o' },
      max: { model: 'gpt-4.1' },
    },
  },
  anthropic: {
    label: 'Anthropic (Claude)',
    keyField: 'anthropic_api_key',
    models: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-fable-5'],
    tiers: {
      fast: { effort: 'low', model: 'claude-haiku-4-5' },
      balanced: { effort: 'high', model: 'claude-opus-4-8' },
      max: { effort: 'max', model: 'claude-opus-4-8' },
    },
  },
};

export const PROVIDER_KEYS = Object.keys(PROVIDERS);

const DEFAULT_SETTINGS = {
  llm_provider: 'openai', // openai | anthropic
  anthropic_api_key: '',
  openai_api_key: '',
  github_token: '',
  github_username: '',
  github_email: '',
  user_email: '',
  gmail_user: '',
  gmail_app_password: '',
  domain: 'CLI tools',
  // Free-text project brief (new-idea mode). When set, AutoForge builds exactly
  // this instead of inventing one from trends.
  project_brief: '',
  work_mode: 'new_idea', // new_idea | fix_repo | open_source
  target_repo: '', // owner/name or GitHub URL (for fix_repo / open_source)
  run_frequency: 'daily', // daily | twice_daily | weekly
  max_issues_per_repo: '8',
  dashboard_password: '',
  priority_tier: 'balanced', // fast | balanced | max
  // Per-stage model overrides. Empty string = use the tier's default model.
  models: JSON.stringify({ default: '', problemFinder: '', codeGenerator: '' }),
  // Self-correcting loop: run generated code locally and let Claude fix failures.
  verify_enabled: 'true', // 'true' | 'false'
  max_fix_attempts: '3',
};

// Returns a plain object of all settings (decrypted), backfilled with defaults.
export async function getSettings() {
  const docs = await Setting.find().lean();
  const stored = {};
  for (const d of docs) {
    stored[d.key] = SECRET_KEYS.includes(d.key) ? decrypt(d.value) : d.value;
  }
  return { ...DEFAULT_SETTINGS, ...stored };
}

// Persist a partial settings object. Only provided keys are written.
export async function saveSettings(partial) {
  const ops = [];
  for (const [key, raw] of Object.entries(partial)) {
    if (raw === undefined) continue;
    const value = SECRET_KEYS.includes(key) ? encrypt(raw) : String(raw);
    ops.push({
      updateOne: { filter: { key }, update: { $set: { key, value } }, upsert: true },
    });
  }
  if (ops.length) await Setting.bulkWrite(ops);
  return getSettings();
}

// Resolve provider + api key + model + effort for a given pipeline stage.
export function resolveModel(settings, stage) {
  const provider = PROVIDERS[settings.llm_provider] ? settings.llm_provider : 'openai';
  const pdef = PROVIDERS[provider];
  const tier = pdef.tiers[settings.priority_tier] || pdef.tiers.balanced;
  let models = {};
  try {
    models = JSON.parse(settings.models || '{}');
  } catch {
    models = {};
  }
  // Per-stage override only applies if it's a valid model for this provider.
  const override = models[stage] || models.default || '';
  const model = pdef.models.includes(override) ? override : tier.model || pdef.models[0];
  const apiKey = settings[pdef.keyField] || '';
  return { provider, apiKey, model, effort: tier.effort };
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export async function createUser({ id, email, name, passwordHash }) {
  return User.create({ _id: id, email, name: name || '', passwordHash });
}

export async function findUserByEmail(email) {
  return User.findOne({ email: String(email).toLowerCase().trim() }).lean();
}

export async function getUser(id) {
  return User.findById(id).lean();
}

export async function countUsers() {
  return User.countDocuments();
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export async function createProject({ id, ownerId, name, brief, work_mode, target_repo, domain, max_issues, images, documents }) {
  return Project.create({
    _id: id,
    ownerId,
    name,
    brief: brief || '',
    work_mode: work_mode || 'new_idea',
    target_repo: target_repo || '',
    domain: domain || 'CLI tools',
    max_issues: max_issues || 8,
    images: Array.isArray(images) ? images.slice(0, 5) : [],
    documents: Array.isArray(documents) ? documents.slice(0, 10) : [],
  });
}

// Projects for a given owner.
export async function listProjects(ownerId) {
  return Project.find({ ownerId }).sort({ createdAt: -1 }).lean();
}

// All projects (scheduler use only).
export async function listAllProjects() {
  return Project.find().sort({ createdAt: -1 }).lean();
}

export async function getProject(id) {
  return Project.findById(id).lean();
}

export async function updateProject(id, fields) {
  return Project.findByIdAndUpdate(id, { $set: fields }, { new: true }).lean();
}

export async function deleteProject(id) {
  await Run.deleteMany({ projectId: id });
  return Project.findByIdAndDelete(id);
}

export async function addProjectMessage(id, message) {
  return Project.findByIdAndUpdate(id, { $push: { messages: { ...message, createdAt: new Date() } } }, { new: true }).lean();
}

export async function setProjectBuiltRepo(id, builtRepo) {
  return Project.findByIdAndUpdate(id, { $set: { builtRepo } }, { new: true }).lean();
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

// Statuses that mean a run is finished (no longer active).
export const TERMINAL_STATUSES = ['completed', 'failed', 'stopped'];

export async function createRun(id, projectId = null, opts = {}) {
  return Run.create({
    _id: id,
    projectId,
    status: 'created',
    userMessage: opts.userMessage || '',
    kind: opts.kind || 'build',
    images: Array.isArray(opts.images) ? opts.images : [],
    documents: Array.isArray(opts.documents) ? opts.documents : [],
  });
}

export async function updateRunStatus(runId, status) {
  const update = { status };
  if (TERMINAL_STATUSES.includes(status)) update.completedAt = new Date();
  return Run.findByIdAndUpdate(runId, { $set: update }, { new: true });
}

export async function saveRunProblem(runId, problem) {
  return Run.findByIdAndUpdate(
    runId,
    { $set: { problemTitle: problem.display_name || problem.title, problemDescription: problem.description } },
    { new: true }
  );
}

export async function saveRunRepo(runId, repo) {
  return Run.findByIdAndUpdate(
    runId,
    { $set: { repoName: repo.name, repoUrl: repo.html_url } },
    { new: true }
  );
}

export async function saveRunError(runId, message) {
  return Run.findByIdAndUpdate(runId, { $set: { error: String(message) } }, { new: true });
}

export async function getRunById(runId) {
  return Run.findById(runId).lean();
}

// The active run if any, otherwise the most recent run.
export async function getCurrentRun() {
  const active = await Run.findOne({
    status: { $nin: TERMINAL_STATUSES },
  })
    .sort({ startedAt: -1 })
    .lean();
  if (active) return active;
  return Run.findOne().sort({ startedAt: -1 }).lean();
}

export async function hasActiveRun() {
  const count = await Run.countDocuments({ status: { $nin: TERMINAL_STATUSES } });
  return count > 0;
}

// Mark every non-terminal run as failed (used on startup so a server restart
// doesn't re-trigger half-finished runs). Returns the affected run ids.
export async function failIncompleteRuns(note) {
  const runs = await Run.find({ status: { $nin: TERMINAL_STATUSES } }).lean();
  if (runs.length) {
    await Run.updateMany(
      { status: { $nin: TERMINAL_STATUSES } },
      { $set: { status: 'failed', completedAt: new Date(), error: note } }
    );
  }
  return runs.map((r) => r._id);
}

export async function listRuns(page = 1, perPage = 20) {
  const skip = (page - 1) * perPage;
  const [runs, total] = await Promise.all([
    Run.find().sort({ startedAt: -1 }).skip(skip).limit(perPage).lean(),
    Run.countDocuments(),
  ]);
  return { runs, total, page, perPage };
}

export async function listRunsByProject(projectId, limit = 20) {
  return Run.find({ projectId }).sort({ startedAt: -1 }).limit(limit).lean();
}

// Latest run for a project (active one preferred).
export async function getProjectCurrentRun(projectId) {
  const active = await Run.findOne({ projectId, status: { $nin: TERMINAL_STATUSES } })
    .sort({ startedAt: -1 })
    .lean();
  if (active) return active;
  return Run.findOne({ projectId }).sort({ startedAt: -1 }).lean();
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

export async function addLog(runId, message, level = 'info') {
  console.log(`[${runId?.slice?.(0, 8) || '????????'}] ${message}`);
  return RunLog.create({ runId, message, level });
}

export async function getLogs(runId, sinceId = null) {
  const filter = { runId };
  if (sinceId && mongoose.isValidObjectId(sinceId)) filter._id = { $gt: sinceId };
  return RunLog.find(filter).sort({ _id: 1 }).limit(500).lean();
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

export async function createIssueRecord(runId, taskKey, title, githubIssueNumber = null) {
  return Issue.findOneAndUpdate(
    { runId, taskKey },
    { $set: { title, githubIssueNumber }, $setOnInsert: { status: 'pending' } },
    { upsert: true, new: true }
  );
}

export async function updateIssueByKey(runId, taskKey, fields) {
  return Issue.findOneAndUpdate({ runId, taskKey }, { $set: fields }, { new: true });
}

export async function getIssues(runId) {
  return Issue.find({ runId }).sort({ createdAt: 1 }).lean();
}

// ---------------------------------------------------------------------------
// Email queries
// ---------------------------------------------------------------------------

export async function createEmailQuery(runId, taskKey, issueNumber, question) {
  return EmailQuery.create({ runId, taskKey, issueNumber, question, status: 'pending', sentAt: new Date() });
}

export async function getPendingEmailQuery(runId, taskKey) {
  return EmailQuery.findOne({ runId, taskKey, status: 'pending' }).sort({ sentAt: -1 }).lean();
}

export async function getAnsweredEmailQuery(runId, taskKey) {
  return EmailQuery.findOne({ runId, taskKey, status: 'answered' }).sort({ answeredAt: -1 }).lean();
}

export async function answerEmailQuery(id, answer) {
  return EmailQuery.findByIdAndUpdate(
    id,
    { $set: { answer, status: 'answered', answeredAt: new Date() } },
    { new: true }
  );
}

export async function listPendingEmailQueries(runId) {
  return EmailQuery.find({ runId, status: 'pending' }).lean();
}
