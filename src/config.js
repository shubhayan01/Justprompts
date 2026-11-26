// Engine registry + key detection.
// Every engine the user wants to track (ChatGPT, Claude, Gemini, Perplexity, …)
// is a logical slot with an ordered list of "bindings". A binding says HOW to run
// that engine (which provider + model), whether it is free, and whether it hits
// the live web. At resolve time we pick the first binding whose keys are present,
// preferring free bindings unless the project opts into paid ones.
//
// Model IDs drift over time. Each binding's model can be overridden via env
// (e.g. GROQ_LLAMA_MODEL=...) and the app surfaces provider errors instead of
// failing silently, so you can always point an engine at a model that exists today.

import 'dotenv/config';

const env = (k, d = '') => (process.env[k] || d).trim();

export const KEY_NAMES = ['OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'PERPLEXITY_API_KEY'];

// Keys come from the environment (.env / Render dashboard) AND can be set at
// runtime from the UI (stored in memory, highest priority). getKeys() merges them.
const ENV_KEYS = Object.fromEntries(KEY_NAMES.map((k) => [k, env(k)]));
const overrides = {};

export function getKeys() {
  const out = { ...ENV_KEYS };
  for (const k of KEY_NAMES) if (overrides[k]) out[k] = overrides[k];
  return out;
}
export function setKeys(patch = {}) {
  for (const k of KEY_NAMES) {
    if (!(k in patch)) continue;
    const v = (patch[k] ?? '').toString().trim();
    if (v) overrides[k] = v; else delete overrides[k];
  }
}
// Where each key currently comes from, for the UI: 'session' | 'env' | null.
export function keySources() {
  const out = {};
  for (const k of KEY_NAMES) out[k] = overrides[k] ? 'session' : (ENV_KEYS[k] ? 'env' : null);
  return out;
}

export const PORT = Number(env('PORT', '4505'));

// ── DataForSEO (Google keyword rank tracking) ─────────────────────────────────
// Basic-auth login + password (NOT a single token). From the env, overridable at
// runtime from the UI (held in memory, like the LLM keys above).
const ENV_DFS = { login: env('DATAFORSEO_LOGIN'), password: env('DATAFORSEO_PASSWORD') };
const dfsOverride = { login: '', password: '' };
export function getDfs() {
  return { login: dfsOverride.login || ENV_DFS.login, password: dfsOverride.password || ENV_DFS.password };
}
export function setDfs({ login, password } = {}) {
  if (login !== undefined) dfsOverride.login = (login ?? '').toString().trim();
  if (password !== undefined) dfsOverride.password = (password ?? '').toString().trim();
}
export function dfsConfigured() { const d = getDfs(); return !!(d.login && d.password); }
export function dfsSource() {
  if (dfsOverride.login || dfsOverride.password) return 'session';
  if (ENV_DFS.login && ENV_DFS.password) return 'env';
  return null;
}
// A safely-masked view of the current login for the UI (never returns the password).
export function dfsLoginMasked() {
  const { login } = getDfs();
  if (!login) return '';
  const [name, dom] = login.split('@');
  if (!dom) return login.slice(0, 2) + '…';
  return name.slice(0, 2) + '…@' + dom;
}

// ── Semrush (v4 API — keyword data, Google rankings, domain comparison) ───────
// A single v4 "Apikey" token (prefix semrtkn-pat-…), NOT the classic ?key= hex.
// From the env, overridable at runtime from the UI (held in memory, like above).
const ENV_SEMRUSH = env('SEMRUSH_API_KEY');
let semrushOverride = '';
export function getSemrush() { return semrushOverride || ENV_SEMRUSH; }
export function setSemrush(key) { semrushOverride = (key ?? '').toString().trim(); }
export function semrushConfigured() { return !!getSemrush(); }
export function semrushSource() {
  if (semrushOverride) return 'session';
  if (ENV_SEMRUSH) return 'env';
  return null;
}
// A safely-masked view of the key for the UI (never returns the full token).
export function semrushKeyMasked() {
  const k = getSemrush();
  if (!k) return '';
  return k.slice(0, 12) + '…' + k.slice(-4);
}

// ── Ghost browser engine toggle ───────────────────────────────────────────────
// Optional headless-browser engines (real ChatGPT / Google AI) are off by default
// and can be flipped on from the UI (session) or via ENABLE_GHOST=1 in the env.
let ghostFlag = env('ENABLE_GHOST') === '1';
export function ghostEnabled() { return ghostFlag; }
export function setGhost(on) { ghostFlag = !!on; }

// A binding = one concrete way to run an engine.
//   provider: how providers.js should call it
//   model:    the model id (env-overridable)
//   live:     does it search the live web (and return real citations)
//   free:     is it free on its provider's free tier
//   needs:    env keys that must be present
//   grounding:(gemini only) turn on Google Search grounding
const bind = (provider, model, { live = false, free = false, needs = [], grounding = false, match = [], flag = null } = {}) =>
  ({ provider, model, live, free, needs, grounding, match, flag });

export const ENGINES = [
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    note: 'OpenAI GPT. Free via gpt-oss open weights; real GPT-4o with an OpenAI/OpenRouter key.',
    bindings: [
      bind('openrouter', env('OR_GPT_MODEL', 'openai/gpt-oss-120b'), { free: true, needs: ['OPENROUTER_API_KEY'], match: ['openai/gpt-oss-120b', 'gpt-oss-120b', 'openai/gpt-oss', 'gpt-oss', 'gpt-4o-mini', 'gpt-4o', 'gpt'] }),
      bind('groq', env('GROQ_GPT_MODEL', 'openai/gpt-oss-120b'), { free: true, needs: ['GROQ_API_KEY'], match: ['openai/gpt-oss-120b', 'gpt-oss-120b', 'openai/gpt-oss-20b', 'gpt-oss-20b', 'gpt-oss'] }),
      bind('openai', env('OPENAI_MODEL', 'gpt-4o-mini'), { needs: ['OPENAI_API_KEY'], match: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt'] }),
    ],
  },
  {
    id: 'claude',
    label: 'Claude',
    note: 'Anthropic Claude. No free tier — needs an Anthropic or OpenRouter key (cheap Haiku).',
    bindings: [
      bind('anthropic', env('ANTHROPIC_MODEL', 'claude-3-5-haiku-latest'), { needs: ['ANTHROPIC_API_KEY'], match: ['haiku', 'claude-3-5', 'claude'] }),
      bind('openrouter', env('OR_CLAUDE_MODEL', 'anthropic/claude-3.5-haiku'), { needs: ['OPENROUTER_API_KEY'], match: ['anthropic/claude-3.5-haiku', 'claude-3.5-haiku', 'anthropic/claude', 'claude'] }),
    ],
  },
  {
    id: 'gemini',
    label: 'Gemini',
    note: 'Google Gemini. Free tier includes LIVE Google Search grounding + real citations.',
    bindings: [
      bind('gemini', env('GEMINI_MODEL', 'gemini-2.5-flash'), { live: true, free: true, grounding: true, needs: ['GEMINI_API_KEY'], match: ['gemini-2.5-flash', 'gemini-2.0-flash', 'flash', 'gemini'] }),
      bind('openrouter', env('OR_GEMINI_MODEL', 'google/gemini-2.0-flash-exp:free'), { free: true, needs: ['OPENROUTER_API_KEY'], match: ['google/gemini-2.0-flash-exp:free', 'gemini-2.0-flash', 'google/gemini', 'gemini'] }),
    ],
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    note: 'Live-web answer engine with citations. Paid (cheap) — needs a Perplexity or OpenRouter key.',
    bindings: [
      bind('perplexity', env('PPLX_MODEL', 'sonar'), { live: true, needs: ['PERPLEXITY_API_KEY'], match: ['sonar'] }),
      bind('openrouter', env('OR_PPLX_MODEL', 'perplexity/sonar'), { live: true, needs: ['OPENROUTER_API_KEY'], match: ['perplexity/sonar', 'perplexity', 'sonar'] }),
    ],
  },
  {
    id: 'llama',
    label: 'Llama',
    note: "Meta Llama — fast and free. A good proxy for open-model answers.",
    bindings: [
      bind('groq', env('GROQ_LLAMA_MODEL', 'llama-3.3-70b-versatile'), { free: true, needs: ['GROQ_API_KEY'], match: ['llama-3.3-70b', 'llama-3.3', 'llama-4', 'llama-3.1-8b-instant', 'llama-3', 'llama'] }),
      bind('openrouter', env('OR_LLAMA_MODEL', 'meta-llama/llama-3.3-70b-instruct:free'), { free: true, needs: ['OPENROUTER_API_KEY'], match: ['meta-llama/llama-3.3-70b-instruct:free', 'llama-3.3-70b', 'meta-llama/llama-4', 'meta-llama/llama-3', 'llama'] }),
    ],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    note: 'DeepSeek V3 — free and strong. Good coverage of the open-model surface.',
    bindings: [
      bind('openrouter', env('OR_DEEPSEEK_MODEL', 'deepseek/deepseek-chat-v3-0324:free'), { free: true, needs: ['OPENROUTER_API_KEY'], match: ['deepseek/deepseek-chat', 'deepseek-chat', 'deepseek/deepseek-v3', 'deepseek'] }),
      bind('groq', env('GROQ_DEEPSEEK_MODEL', 'deepseek-r1-distill-llama-70b'), { free: true, needs: ['GROQ_API_KEY'], match: ['deepseek', 'qwen'] }),
    ],
  },
  // ── Headless-browser engines (optional, no API cost) — the REAL consumer pages.
  //    Enabled only when the ghost toggle is on; best-effort and may need login.
  {
    id: 'chatgpt-web',
    label: 'ChatGPT (web)',
    note: 'The real ChatGPT app, scraped with a headless browser. No API cost. One-time login; best-effort.',
    bindings: [bind('ghost', 'chatgpt-web', { live: true, free: true, needs: [], flag: 'ghost' })],
  },
  {
    id: 'google-ai',
    label: 'Google AI',
    note: 'Google AI Overview + top results, scraped with a headless browser. No API cost; best-effort.',
    bindings: [bind('ghost', 'google-ai', { live: true, free: true, needs: [], flag: 'ghost' })],
  },
];

// A binding is available only if its keys are present AND (if flagged) its flag is on.
const bindingAvailable = (b) => haveKeys(b.needs) && (!b.flag || (b.flag === 'ghost' && ghostFlag));

const haveKeys = (needs) => { const K = getKeys(); return needs.every((k) => K[k]); };

// Resolve one engine to a concrete binding given the available keys.
// preferFree: when true, only consider free bindings if any free binding is usable.
export function resolveEngine(engine, { preferFree = true } = {}) {
  const usable = engine.bindings.filter(bindingAvailable);
  if (!usable.length) return null;
  if (preferFree && usable.some((b) => b.free)) {
    return usable.find((b) => b.free);
  }
  return usable[0];
}

// Full status of every engine for the UI (live / free / needs-key).
export function engineStatus({ preferFree = true } = {}) {
  return ENGINES.map((e) => {
    const binding = resolveEngine(e, { preferFree });
    // also compute the best possible binding ignoring preferFree, to tell the
    // user "you *could* enable this paid" vs "no key at all".
    const anyUsable = e.bindings.find(bindingAvailable);
    const ghostOnly = e.bindings.every((b) => b.flag === 'ghost');
    return {
      id: e.id,
      label: e.label,
      note: e.note,
      enabled: !!binding,
      binding: binding
        ? { provider: binding.provider, model: binding.model, live: binding.live, free: binding.free, match: binding.match || [] }
        : null,
      hint: binding
        ? null
        : ghostOnly
        ? 'Turn on the headless browser engine to use this.'
        : anyUsable
        ? 'Available if you turn off "free only".'
        : `Add a key: ${[...new Set(e.bindings.flatMap((b) => b.needs))].join(' or ')}`,
    };
  });
}

// Pick a fast, free model for the internal analysis work (keyword mining,
// prompt generation, mention + sentiment judging). Prefer Groq → OpenRouter → Gemini.
export function resolveAnalysisModel() {
  const K = getKeys();
  // Default to gpt-oss-20b on Groq: consistently available, fast, free, good at JSON.
  if (K.GROQ_API_KEY) return { provider: 'groq', model: env('GROQ_ANALYSIS_MODEL', 'openai/gpt-oss-20b'), match: ['openai/gpt-oss-20b', 'gpt-oss-20b', 'gpt-oss', 'llama-3.3-70b', 'llama-3.1-8b-instant', 'llama', 'qwen'] };
  if (K.OPENROUTER_API_KEY) return { provider: 'openrouter', model: env('OR_ANALYSIS_MODEL', 'meta-llama/llama-3.3-70b-instruct:free'), match: ['meta-llama/llama-3.3-70b-instruct:free', 'llama-3.3-70b', 'deepseek/deepseek-chat', 'meta-llama/llama', 'gpt-oss'] };
  if (K.GEMINI_API_KEY) return { provider: 'gemini', model: env('GEMINI_ANALYSIS_MODEL', 'gemini-2.5-flash'), match: ['gemini-2.5-flash', 'gemini-2.0-flash', 'flash', 'gemini'] };
  if (K.OPENAI_API_KEY) return { provider: 'openai', model: 'gpt-4o-mini', match: ['gpt-4o-mini', 'gpt-4o', 'gpt'] };
  if (K.ANTHROPIC_API_KEY) return { provider: 'anthropic', model: 'claude-3-5-haiku-latest', match: ['haiku', 'claude'] };
  return null;
}

export function anyKeyPresent() {
  const K = getKeys();
  return KEY_NAMES.some((k) => K[k]);
}
