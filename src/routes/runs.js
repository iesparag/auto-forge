import express from 'express';
import {
  listRuns,
  getCurrentRun,
  getRunById,
  getLogs,
  getIssues,
  hasActiveRun,
  getProject,
  updateRunStatus,
} from '../db/repo.js';
import { startManualRun } from '../services/schedulerService.js';
import { requestStop } from '../agent/runControl.js';
import * as github from '../services/githubService.js';

// Load a run and verify it belongs to the current user (via its project).
async function ownedRun(req, res) {
  const run = await getRunById(req.params.id);
  if (!run) { res.status(404).json({ error: 'not found' }); return null; }
  const project = run.projectId ? await getProject(run.projectId) : null;
  if (!project || project.ownerId !== req.userId) { res.status(403).json({ error: 'forbidden' }); return null; }
  return run;
}

const router = express.Router();

// Start a run now.
router.post('/runs/start', async (req, res) => {
  const result = await startManualRun();
  if (result.error) return res.status(409).json({ ok: false, error: result.error });
  res.json({ ok: true, runId: result.runId });
});

// Stop the active run. It halts at the next safe checkpoint.
router.post('/runs/stop', async (req, res) => {
  const current = await getCurrentRun();
  if (!current || TERMINAL.includes(current.status)) {
    return res.status(409).json({ ok: false, error: 'No active run to stop.' });
  }
  requestStop(current._id);
  await updateRunStatus(current._id, 'stopping');
  res.json({ ok: true, runId: current._id });
});

const TERMINAL = ['completed', 'failed', 'stopped'];

// List runs (paginated, 20 per page).
router.get('/runs', async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const data = await listRuns(page, 20);
  res.json(data);
});

// Current (or last) run, with whether one is active.
router.get('/runs/current', async (req, res) => {
  const run = await getCurrentRun();
  const active = await hasActiveRun();
  res.json({ run, active });
});

// File tree of a run's repo (for the in-dashboard browser).
router.get('/runs/:id/tree', async (req, res) => {
  try {
    const run = await ownedRun(req, res);
    if (!run) return;
    const loc = github.parseRepo(run.repoUrl);
    if (!loc) return res.status(404).json({ error: 'no repo for this run' });
    const paths = await github.getTree(loc.repo, loc.owner);
    res.json({ owner: loc.owner, repo: loc.repo, paths });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Single file's content from a run's repo.
router.get('/runs/:id/file', async (req, res) => {
  try {
    const run = await ownedRun(req, res);
    if (!run) return;
    const loc = github.parseRepo(run.repoUrl);
    if (!loc || !req.query.path) return res.status(400).json({ error: 'repo or path missing' });
    const content = await github.getFileContent(loc.repo, String(req.query.path), loc.owner);
    res.json({ path: req.query.path, content });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Single run with its logs and issues.
router.get('/runs/:id', async (req, res) => {
  const run = await ownedRun(req, res);
  if (!run) return;
  const [logs, issues] = await Promise.all([getLogs(req.params.id), getIssues(req.params.id)]);
  res.json({ run, logs, issues });
});

// SSE stream of run logs.
router.get('/logs/stream', async (req, res) => {
  const runId = req.query.runId;
  if (!runId) return res.status(400).json({ error: 'runId required' });

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders?.();

  let lastId = null;
  let closed = false;
  req.on('close', () => {
    closed = true;
  });

  const tick = async () => {
    if (closed) return;
    try {
      const logs = await getLogs(runId, lastId);
      for (const log of logs) {
        lastId = log._id;
        res.write(`data: ${JSON.stringify(log)}\n\n`);
      }
    } catch {
      /* ignore transient errors */
    }
    if (!closed) setTimeout(tick, 2000);
  };
  tick();
});

// Health check.
router.get('/health', (req, res) => res.json({ status: 'ok', version: '1.0.0' }));

export default router;
