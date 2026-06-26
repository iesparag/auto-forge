import express from 'express';
import {
  getSettings,
  saveSettings,
  SECRET_KEYS,
  PROVIDERS,
  PROVIDER_KEYS,
} from '../db/repo.js';
import * as claude from '../services/claudeService.js';
import * as github from '../services/githubService.js';
import * as email from '../services/emailService.js';
import { startScheduler } from '../services/schedulerService.js';

const router = express.Router();

const MASK = '••••••••';

// GET current settings, with secret values masked.
router.get('/', async (req, res) => {
  const settings = await getSettings();
  const out = { ...settings };
  for (const key of SECRET_KEYS) {
    out[key] = settings[key] ? MASK : '';
  }
  delete out.dashboard_password; // obsolete (auth is now user-based)
  // Per-provider model lists + labels for the picker.
  const providers = PROVIDER_KEYS.map((k) => ({
    key: k,
    label: PROVIDERS[k].label,
    models: PROVIDERS[k].models,
  }));
  res.json({
    settings: out,
    providers,
    priorityTiers: ['fast', 'balanced', 'max'],
    stages: ['default', 'problemFinder', 'codeGenerator'],
  });
});

// POST settings. Masked/empty secret fields are ignored (not overwritten).
router.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    const patch = {};
    const current = await getSettings();

    for (const [key, value] of Object.entries(body)) {
      if (key === 'dashboard_password') continue; // obsolete
      if (key === 'models') {
        // Accept either an object or a JSON string.
        patch.models = typeof value === 'string' ? value : JSON.stringify(value);
        continue;
      }
      // Don't overwrite a secret with the mask placeholder or an empty string.
      if (SECRET_KEYS.includes(key) && (value === MASK || value === '')) continue;
      patch[key] = value;
    }

    await saveSettings(patch);

    // Reschedule if frequency changed.
    if (patch.run_frequency && patch.run_frequency !== current.run_frequency) {
      await startScheduler();
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// --- Test connection endpoints -------------------------------------------

// Test the LLM provider (OpenAI or Anthropic). Uses the provider/key the user
// is currently editing, falling back to saved values.
router.post('/test-llm', async (req, res) => {
  try {
    const settings = await getSettings();
    const provider = req.body?.llm_provider || settings.llm_provider || 'openai';
    const pdef = PROVIDERS[provider] || PROVIDERS.openai;
    const typed = req.body?.[pdef.keyField];
    const apiKey = typed && typed !== MASK ? typed : settings[pdef.keyField];
    const result = await claude.testConnection({ provider, apiKey });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

router.post('/test-github', async (req, res) => {
  try {
    // githubService reads the token from saved settings; save first if provided.
    if (req.body?.github_token && req.body.github_token !== MASK) {
      await saveSettings({ github_token: req.body.github_token });
    }
    const result = await github.testToken();
    res.json({ ok: true, login: result.login });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

router.post('/test-email', async (req, res) => {
  try {
    // Persist any typed email fields first so testing works without a separate Save.
    const patch = {};
    for (const k of ['gmail_user', 'user_email', 'gmail_app_password']) {
      const v = req.body?.[k];
      if (v && v !== MASK) patch[k] = v;
    }
    if (Object.keys(patch).length) await saveSettings(patch);
    const result = await email.sendTestEmail();
    res.json({ ok: true, to: result.to });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

export default router;
