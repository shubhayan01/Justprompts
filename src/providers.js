// Unified LLM call layer. One function — chat() — that speaks to every provider.
// OpenRouter / Groq / OpenAI / Perplexity are all OpenAI-compatible. Gemini uses
// its own REST endpoint (needed for live Google Search grounding). Anthropic uses
// its Messages API. Each call returns a normalised shape:
//   { text, citations: [{url, title}], provider, model }

import { KEYS } from './config.js';

const TIMEOUT_MS = 75_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postJSON(url, { headers, body, timeout = TIMEOUT_MS, retries = 3 }) {
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const txt = await res.text();
      let json;
      try { json = txt ? JSON.parse(txt) : {}; } catch { json = { _raw: txt }; }
      if (!res.ok) {
        // Rate-limited / transient → back off and retry (free tiers hit this a lot).
        if ((res.status === 429 || res.status === 503 || res.status === 502) && attempt < retries) {
          const ra = Number(res.headers.get('retry-after'));
          const wait = (Number.isFinite(ra) && ra > 0 ? ra * 1000 : 0) || Math.min(1500 * 2 ** attempt, 12_000);
          clearTimeout(timer);
          await sleep(wait);
          continue;
        }
        const msg = json?.error?.message || json?.error || json?._raw || res.statusText;
        throw new Error(`${res.status} ${typeof msg === 'string' ? msg.slice(0, 300) : JSON.stringify(msg).slice(0, 300)}`);
      }
      return json;
    } catch (e) {
      if (e.name === 'AbortError') {
        if (attempt < retries) { clearTimeout(timer); await sleep(1000); continue; }
        throw new Error(`timed out after ${timeout / 1000}s`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── OpenAI-compatible providers ──────────────────────────────────────────────
const OPENAI_COMPAT = {
  openrouter: { base: 'https://openrouter.ai/api/v1', key: () => KEYS.OPENROUTER_API_KEY,
    extraHeaders: { 'HTTP-Referer': 'https://localhost', 'X-Title': 'JustPrompt GEO Tracker' } },
  groq:       { base: 'https://api.groq.com/openai/v1', key: () => KEYS.GROQ_API_KEY },
  openai:     { base: 'https://api.openai.com/v1', key: () => KEYS.OPENAI_API_KEY },
  perplexity: { base: 'https://api.perplexity.ai', key: () => KEYS.PERPLEXITY_API_KEY },
};

async function chatOpenAICompat(providerName, { model, messages, temperature = 0.4, json = false }) {
  const cfg = OPENAI_COMPAT[providerName];
  const url = `${cfg.base}/chat/completions`;
  const headers = { Authorization: `Bearer ${cfg.key()}`, ...(cfg.extraHeaders || {}) };
  // When asking for JSON, also instruct it in-prompt so it still works if we have
  // to drop the strict response_format (some models — e.g. Groq gpt-oss reasoning
  // models — reject or fail to validate strict json_object mode).
  const msgs = json ? withJsonInstruction(messages) : messages;
  let data;
  try {
    const body = { model, messages: msgs, temperature };
    if (json) body.response_format = { type: 'json_object' };
    data = await postJSON(url, { headers, body });
  } catch (e) {
    if (json && /\b400\b/.test(e.message) && /json|response_format|validate/i.test(e.message)) {
      // Retry without strict JSON mode; the prompt still demands JSON and parseJSON extracts it.
      data = await postJSON(url, { headers, body: { model, messages: msgs, temperature } });
    } else throw e;
  }
  const text = data?.choices?.[0]?.message?.content ?? '';
  // Perplexity (and OpenRouter-routed Perplexity) return a top-level citations array.
  const citations = normaliseCitations(data?.citations || data?.choices?.[0]?.message?.citations);
  return { text, citations, provider: providerName, model };
}

// ── Gemini (direct) with Google Search grounding ─────────────────────────────
async function chatGemini({ model, messages, temperature = 0.4, json = false, grounding = false }) {
  const key = KEYS.GEMINI_API_KEY;
  const sys = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const body = {
    contents,
    generationConfig: { temperature, ...(json ? { responseMimeType: 'application/json' } : {}) },
  };
  if (sys) body.systemInstruction = { parts: [{ text: sys }] };
  if (grounding) body.tools = [{ google_search: {} }];
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const data = await postJSON(url, { headers: {}, body });
  const cand = data?.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p) => p.text || '').join('');
  const chunks = cand?.groundingMetadata?.groundingChunks || [];
  const citations = normaliseCitations(
    chunks.map((c) => c.web).filter(Boolean).map((w) => ({ url: w.uri, title: w.title }))
  );
  return { text, citations, provider: 'gemini', model };
}

// ── Anthropic (direct) ───────────────────────────────────────────────────────
async function chatAnthropic({ model, messages, temperature = 0.4, json = false }) {
  const key = KEYS.ANTHROPIC_API_KEY;
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const msgs = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
  const body = { model, max_tokens: 2048, temperature, messages: msgs };
  if (system) body.system = system + (json ? '\n\nRespond with raw JSON only, no markdown fences.' : '');
  const data = await postJSON('https://api.anthropic.com/v1/messages', {
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body,
  });
  const text = (data?.content || []).map((b) => b.text || '').join('');
  return { text, citations: [], provider: 'anthropic', model };
}

// Append a firm JSON-only directive to the system message (or add one).
function withJsonInstruction(messages) {
  const note = 'Respond with ONLY a single valid JSON object. No markdown, no code fences, no commentary, no reasoning text.';
  const out = messages.map((m) => ({ ...m }));
  const sys = out.find((m) => m.role === 'system');
  if (sys) sys.content += '\n\n' + note;
  else out.unshift({ role: 'system', content: note });
  return out;
}

function normaliseCitations(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((c) => (typeof c === 'string' ? { url: c, title: '' } : { url: c?.url || c?.uri || '', title: c?.title || '' }))
    .filter((c) => c.url)
    .map((c) => ({ url: c.url, title: c.title || '' }));
}

// Public entry point.
export async function chat({ provider, model, messages, temperature = 0.4, json = false, grounding = false }) {
  if (provider === 'gemini') return chatGemini({ model, messages, temperature, json, grounding });
  if (provider === 'anthropic') return chatAnthropic({ model, messages, temperature, json });
  if (OPENAI_COMPAT[provider]) return chatOpenAICompat(provider, { model, messages, temperature, json });
  throw new Error(`unknown provider: ${provider}`);
}

// Parse a JSON object out of an LLM reply that may be wrapped in prose / fences.
export function parseJSON(text) {
  if (!text) throw new Error('empty response');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  try { return JSON.parse(candidate); } catch {}
  const start = candidate.search(/[[{]/);
  if (start >= 0) {
    for (let end = candidate.length; end > start; end--) {
      const slice = candidate.slice(start, end);
      try { return JSON.parse(slice); } catch {}
    }
  }
  throw new Error('could not parse JSON from model reply');
}
