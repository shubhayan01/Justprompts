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

export const KEYS = {
  OPENROUTER_API_KEY: env('OPENROUTER_API_KEY'),
  GEMINI_API_KEY: env('GEMINI_API_KEY'),
  GROQ_API_KEY: env('GROQ_API_KEY'),
  OPENAI_API_KEY: env('OPENAI_API_KEY'),
  ANTHROPIC_API_KEY: env('ANTHROPIC_API_KEY'),
  PERPLEXITY_API_KEY: env('PERPLEXITY_API_KEY'),
};

export const PORT = Number(env('PORT', '4505'));

// A binding = one concrete way to run an engine.
//   provider: how providers.js should call it
//   model:    the model id (env-overridable)
//   live:     does it search the live web (and return real citations)
//   free:     is it free on its provider's free tier
//   needs:    env keys that must be present
//   grounding:(gemini only) turn on Google Search grounding
const bind = (provider, model, { live = false, free = false, needs = [], grounding = false, match = [] } = {}) =>
  ({ provider, model, live, free, needs, grounding, match });

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
      bind('groq', env('GROQ_DEEPSEEK_MODEL', 'deepseek-r1-distill-llama-70b'), { free: true, needs: ['GROQ_API_KEY'], match: ['deepseek'] }),
    ],
  },
];

const haveKeys = (needs) => needs.every((k) => KEYS[k]);

// Resolve one engine to a concrete binding given the available keys.
// preferFree: when true, only consider free bindings if any free binding is usable.
export function resolveEngine(engine, { preferFree = true } = {}) {
  const usable = engine.bindings.filter((b) => haveKeys(b.needs));
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
    const anyUsable = e.bindings.find((b) => haveKeys(b.needs));
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
        : anyUsable
        ? 'Available if you turn off "free only".'
        : `Add a key: ${[...new Set(e.bindings.flatMap((b) => b.needs))].join(' or ')}`,
    };
  });
}

// Pick a fast, free model for the internal analysis work (keyword mining,
// prompt generation, mention + sentiment judging). Prefer Groq → OpenRouter → Gemini.
export function resolveAnalysisModel() {
  // Default to gpt-oss-20b on Groq: consistently available, fast, free, good at JSON.
  if (KEYS.GROQ_API_KEY) return { provider: 'groq', model: env('GROQ_ANALYSIS_MODEL', 'openai/gpt-oss-20b'), match: ['openai/gpt-oss-20b', 'gpt-oss-20b', 'gpt-oss', 'llama-3.3-70b', 'llama-3.1-8b-instant', 'llama', 'qwen'] };
  if (KEYS.OPENROUTER_API_KEY) return { provider: 'openrouter', model: env('OR_ANALYSIS_MODEL', 'meta-llama/llama-3.3-70b-instruct:free'), match: ['meta-llama/llama-3.3-70b-instruct:free', 'llama-3.3-70b', 'deepseek/deepseek-chat', 'meta-llama/llama', 'gpt-oss'] };
  if (KEYS.GEMINI_API_KEY) return { provider: 'gemini', model: env('GEMINI_ANALYSIS_MODEL', 'gemini-2.5-flash'), match: ['gemini-2.5-flash', 'gemini-2.0-flash', 'flash', 'gemini'] };
  if (KEYS.OPENAI_API_KEY) return { provider: 'openai', model: 'gpt-4o-mini', match: ['gpt-4o-mini', 'gpt-4o', 'gpt'] };
  if (KEYS.ANTHROPIC_API_KEY) return { provider: 'anthropic', model: 'claude-3-5-haiku-latest', match: ['haiku', 'claude'] };
  return null;
}

export function anyKeyPresent() {
  return Object.values(KEYS).some(Boolean);
}
