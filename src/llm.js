// Helper for the internal "analysis" LLM work (keyword mining, prompt generation,
// mention + sentiment judging). Always uses the fast/free analysis model and
// forces JSON output, with graceful failure so callers can fall back to heuristics.

import { chat, parseJSON } from './providers.js';
import { resolveAnalysisModel } from './config.js';
import { pickModel } from './models.js';

export function hasAnalysisModel() {
  return !!resolveAnalysisModel();
}

export async function analyzeJSON(system, user, { temperature = 0.3 } = {}) {
  const m = resolveAnalysisModel();
  if (!m) throw new Error('No analysis model available — add a Groq, OpenRouter or Gemini key.');
  const model = await pickModel(m.provider, m.model, m.match || []);
  const { text } = await chat({
    provider: m.provider,
    model,
    temperature,
    json: true,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });
  return parseJSON(text);
}
