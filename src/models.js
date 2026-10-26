// Live model discovery + auto-fallback. Model IDs drift (providers retire them),
// so instead of trusting a hardcoded id we ask each provider which models it
// actually serves right now and map our desired model to a real one. Cached 5 min.

import { KEYS } from './config.js';

const cache = new Map(); // provider -> { ts, ids:[] }
const TTL = 5 * 60 * 1000;
const BAD = /whisper|tts|embed|guard|moderation|distil-whisper|prompt-guard|rerank|vision-ocr/i;

async function getJSON(url, headers = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally { clearTimeout(timer); }
}

export async function availableModels(provider) {
  const c = cache.get(provider);
  if (c && Date.now() - c.ts < TTL) return c.ids;
  let ids = [];
  try {
    if (provider === 'groq' && KEYS.GROQ_API_KEY) {
      ids = (await getJSON('https://api.groq.com/openai/v1/models', { Authorization: `Bearer ${KEYS.GROQ_API_KEY}` })).data.map((m) => m.id);
    } else if (provider === 'openrouter' && KEYS.OPENROUTER_API_KEY) {
      ids = (await getJSON('https://openrouter.ai/api/v1/models', { Authorization: `Bearer ${KEYS.OPENROUTER_API_KEY}` })).data.map((m) => m.id);
    } else if (provider === 'openai' && KEYS.OPENAI_API_KEY) {
      ids = (await getJSON('https://api.openai.com/v1/models', { Authorization: `Bearer ${KEYS.OPENAI_API_KEY}` })).data.map((m) => m.id);
    } else if (provider === 'gemini' && KEYS.GEMINI_API_KEY) {
      ids = (await getJSON(`https://generativelanguage.googleapis.com/v1beta/models?key=${KEYS.GEMINI_API_KEY}`)).models
        .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map((m) => m.name.replace(/^models\//, ''));
    } else if (provider === 'anthropic' && KEYS.ANTHROPIC_API_KEY) {
      ids = (await getJSON('https://api.anthropic.com/v1/models', { 'x-api-key': KEYS.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' })).data.map((m) => m.id);
    }
  } catch { ids = []; }
  cache.set(provider, { ts: Date.now(), ids });
  return ids;
}

// Map a desired model to one that actually exists on the provider.
// hints = ordered substrings to match when the exact id is gone.
export async function pickModel(provider, desired, hints = []) {
  // Perplexity has no reliable list endpoint — trust the configured id.
  if (provider === 'perplexity') return desired;
  const ids = await availableModels(provider);
  if (!ids.length) return desired; // couldn't list → try desired (errors surface in UI)
  const lc = (s) => s.toLowerCase();
  if (ids.includes(desired)) return desired;

  const base = desired.replace(/:free$/, '');
  if (ids.includes(base)) return base;
  const freeVariant = ids.find((id) => lc(id) === lc(base + ':free'));
  if (freeVariant) return freeVariant;

  const usable = ids.filter((id) => !BAD.test(id));
  const pool = usable.length ? usable : ids;
  for (const h of [...hints, base.split('/').pop().split(/[-:]/)[0]]) {
    if (!h) continue;
    const m = pool.find((id) => lc(id).includes(lc(h)));
    if (m) return m;
  }
  return pool[0] || desired;
}
