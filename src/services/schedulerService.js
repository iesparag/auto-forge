import cron from 'node-cron';
import { v4 as uuidv4 } from 'uuid';
import { getSettings, createRun, hasActiveRun, addLog, listAllProjects } from '../db/repo.js';
import { runAgent } from '../agent/orchestrator.js';

const FREQUENCY_CRON = {
  daily: '0 9 * * *', // 9 AM daily
  twice_daily: '0 9,21 * * *', // 9 AM and 9 PM
  weekly: '0 9 * * 1', // Monday 9 AM
};

let currentJob = null;

// Create a run for a project and launch the agent (fire-and-forget). Refuses if
// a run is already active. Returns { runId } or { error }.
export async function startManualRun(projectId, opts = {}) {
  if (!projectId) return { error: 'No project specified.' };
  if (await hasActiveRun()) {
    return { error: 'A run is already in progress. Stop it or wait for it to finish.' };
  }
  const runId = uuidv4();
  await createRun(runId, projectId, {
    userMessage: opts.userMessage || '',
    kind: opts.kind || 'build',
    images: opts.images || [],
    documents: opts.documents || [],
  });
  await addLog(runId, '🚀 Run started.', 'info');
  runAgent(runId).catch((err) => {
    console.error('runAgent crashed:', err);
  });
  return { runId };
}

// (Re)schedule the recurring job based on the saved run_frequency setting.
export async function startScheduler() {
  const settings = await getSettings();
  const expr = FREQUENCY_CRON[settings.run_frequency] || FREQUENCY_CRON.daily;

  if (currentJob) {
    currentJob.stop();
    currentJob = null;
  }
  if (!cron.validate(expr)) {
    console.warn(`⚠️  Invalid cron expression for "${settings.run_frequency}" — scheduler not started.`);
    return;
  }
  currentJob = cron.schedule(expr, () => {
    runAllProjects().catch((err) => console.error('scheduled run failed:', err));
  });
  console.log(`⏰ Scheduler active: "${settings.run_frequency}" (${expr})`);
}

// Run every project once, sequentially (so runs don't collide).
async function runAllProjects() {
  const projects = await listAllProjects();
  for (const p of projects) {
    if (await hasActiveRun()) break;
    const runId = uuidv4();
    await createRun(runId, p._id);
    await addLog(runId, '⏰ Scheduled run started.');
    await runAgent(runId);
  }
}

export function stopScheduler() {
  if (currentJob) {
    currentJob.stop();
    currentJob = null;
  }
}
