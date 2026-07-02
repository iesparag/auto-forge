import 'dotenv/config';
import { setGlobalDispatcher, Agent } from 'undici';
// Tune the global fetch (undici) used by the OpenAI SDK: short keep-alive so we
// don't reuse a stale socket the peer already closed (the root cause of
// "Premature close"), and long body/headers timeouts so slow streamed
// responses aren't aborted.
setGlobalDispatcher(
  new Agent({
    connect: { timeout: 30_000 },
    keepAliveTimeout: 4_000,
    keepAliveMaxTimeout: 10_000,
    headersTimeout: 600_000,
    bodyTimeout: 600_000,
  })
);

import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import { connectDB } from './db/database.js';
import dashboardRoutes from './routes/dashboard.js';
import settingsRoutes from './routes/settings.js';
import projectsRoutes from './routes/projects.js';
import runsRoutes from './routes/runs.js';
import { requireUser, handleRegister, handleLogin, handleLogout, handleMe } from './middleware/auth.js';
import { startScheduler } from './services/schedulerService.js';
import { getSettings, resolveModel, failIncompleteRuns, addLog } from './db/repo.js';
import { cleanupWorkspace } from './agent/sandbox.js';
import { sendErrorNotification } from './services/emailService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, '..', 'data');

function crashLog(label, err) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(
      path.join(DATA_DIR, 'crash.log'),
      `[${new Date().toISOString()}] ${label}: ${err?.stack || err}\n`
    );
  } catch {
    /* nothing more we can do */
  }
}

async function main() {
  await connectDB();

  const app = express();
  app.use(express.json({ limit: '25mb' })); // base64 image uploads
  app.use(cookieParser());

  // Auth endpoints (reachable without a session).
  app.post('/api/auth/register', handleRegister);
  app.post('/api/auth/login', handleLogin);
  app.post('/api/auth/logout', handleLogout);
  app.get('/api/auth/me', handleMe);

  // Everything below requires a logged-in user (auth endpoints + static + the
  // login/register pages are allowed through inside requireUser).
  app.use(requireUser);
  app.use(express.static(path.join(__dirname, 'public')));

  app.use('/api/settings', settingsRoutes);
  app.use('/api', projectsRoutes);
  app.use('/api', runsRoutes);
  app.use('/', dashboardRoutes);

  app.listen(PORT, async () => {
    console.log(`\n🔧 AutoForge started on http://localhost:${PORT}`);
    const settings = await getSettings();
    const { apiKey } = resolveModel(settings, 'default');
    if (!apiKey || !settings.github_token) {
      console.log(`👉 Visit http://localhost:${PORT}/settings to configure.`);
    }
    await startScheduler();

    // Any run left mid-flight by a previous process is marked interrupted (not
    // auto-resumed) so a restart doesn't re-trigger half-finished work.
    try {
      const ids = await failIncompleteRuns('Interrupted by server restart.');
      for (const id of ids) {
        await addLog(id, '🔁 Server restarted — run marked interrupted. Start a fresh run from the dashboard.', 'warn');
        await cleanupWorkspace(id).catch(() => {});
      }
      if (ids.length) console.log(`ℹ️  Marked ${ids.length} interrupted run(s) as failed.`);
    } catch (err) {
      console.error('startup cleanup failed:', err.message);
    }
  });
}

// Global safety nets — log, notify, but never crash the server.
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
  crashLog('uncaughtException', err);
  sendErrorNotification(err, 'process').catch(() => {});
});
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason);
  crashLog('unhandledRejection', reason);
});

main().catch((err) => {
  console.error('Fatal startup error:', err);
  crashLog('startup', err);
  process.exit(1);
});
