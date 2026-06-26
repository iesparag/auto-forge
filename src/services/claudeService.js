// LLM facade: dispatches to the configured provider (OpenAI or Anthropic).
// Kept as claudeService.js so existing imports stay unchanged.
import { getSettings, resolveModel, PROVIDERS } from '../db/repo.js';
import * as anthropic from './providers/anthropicProvider.js';
import * as openai from './providers/openaiProvider.js';

const backends = { anthropic, openai };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseJsonLoose(text) {
  const t = (text || '').trim();

  // 1. A ```json fenced block, if present (don't match other fences like ```bash).
  const jsonFence = t.match(/```json\s*([\s\S]*?)```/i);
  if (jsonFence) {
    try {
      return JSON.parse(jsonFence[1].trim());
    } catch {
      /* fall through */
    }
  }

  // 2. The whole response (json_object mode returns pure JSON → this works).
  try {
    return JSON.parse(t);
  } catch {
    /* fall through */
  }

  // 3. Slice from the first { or [ to the LAST } or ] — ignores any trailing
  //    prose or example code fences the model appended after the JSON.
  const start = t.search(/[{[]/);
  const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (start >= 0 && end > start) {
    return JSON.parse(t.slice(start, end + 1));
  }
  return JSON.parse(t); // throw a clear error → caller retries
}

// Retry with exponential backoff (2s, 4s, 8s); fail fast on 4xx (except 429).
async function withRetry(fn) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err?.status;
      if (status && status >= 400 && status < 500 && status !== 429) throw err;
      if (attempt < 2) await sleep(2000 * Math.pow(2, attempt));
    }
  }
  throw lastErr;
}

function backendFor(provider) {
  return backends[provider] || backends.openai;
}

export async function complete({ stage = 'default', system, user, maxTokens }) {
  const settings = await getSettings();
  const { provider, apiKey, model, effort } = resolveModel(settings, stage);
  const backend = backendFor(provider);
  return withRetry(() => backend.complete({ apiKey, model, effort, system, user, maxTokens }));
}

export async function completeJSON({ stage = 'default', system, user, maxTokens, images = [] }) {
  const settings = await getSettings();
  const { provider, apiKey, model, effort } = resolveModel(settings, stage);
  const backend = backendFor(provider);

  let userPrompt = user;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const text = await withRetry(() =>
        backend.complete({ apiKey, model, effort, system, user: userPrompt, maxTokens, json: true, images })
      );
      return parseJsonLoose(text);
    } catch (err) {
      lastErr = err;
      userPrompt =
        user +
        '\n\nYour previous response was not valid JSON. Return ONLY the JSON object, with no markdown, no code fences, and no explanation.';
    }
  }
  throw lastErr;
}

// Test the configured provider (or an explicitly supplied provider/key).
export async function testConnection({ provider, apiKey, model } = {}) {
  const settings = await getSettings();
  const prov = provider || settings.llm_provider || 'openai';
  const pdef = PROVIDERS[prov] || PROVIDERS.openai;
  const key = apiKey || settings[pdef.keyField];
  const m = model || pdef.tiers[settings.priority_tier]?.model || pdef.models[0];
  const backend = backendFor(prov);
  const result = await backend.test(key, m);
  return { ok: true, provider: prov, model: m, reply: result.reply };
}
