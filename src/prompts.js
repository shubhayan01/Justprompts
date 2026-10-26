// Prompt engine: turn keywords into realistic prompts a buyer would actually type
// into ChatGPT / Perplexity / Gemini, ranked by commercial intent. These are the
// questions we then track across the engines — the heart of GEO measurement.

import { analyzeJSON, hasAnalysisModel } from './llm.js';

const INTENT_TEMPLATES = {
  comparison: (k) => `What are the best tools for ${k}?`,
  commercial: (k) => `Which company is best for ${k}?`,
  transactional: (k) => `Where can I get ${k}?`,
  informational: (k) => `How do I approach ${k}?`,
  navigational: (k) => `Tell me about ${k}`,
};

export async function generatePrompts({ brandName, keywords, themes = [], count = 15 }) {
  const kwList = keywords.map((k) => (typeof k === 'string' ? { phrase: k, intent: 'informational' } : k));

  if (!hasAnalysisModel()) {
    // Heuristic fallback: template the keywords.
    const prompts = kwList.slice(0, count).map((k, i) => ({
      id: 'p' + i,
      text: (INTENT_TEMPLATES[k.intent] || INTENT_TEMPLATES.informational)(k.phrase),
      intent: k.intent || 'informational',
      keyword: k.phrase,
      commercialScore: k.intent === 'comparison' || k.intent === 'commercial' ? 8 : 4,
    }));
    return { prompts, source: 'heuristic' };
  }

  const system = `You generate realistic end-user prompts for GEO (Generative Engine Optimization) tracking. These are natural questions real buyers type into AI assistants (ChatGPT, Perplexity, Gemini) when researching or buying — NOT keywords, NOT branded queries. Favour prompts where an AI would naturally name/recommend specific companies, tools or brands (comparison, "best X", "recommend", "alternatives"), because those are where a brand can win or lose visibility. Do NOT mention the brand name in the prompts — we want to see if the engine surfaces it unprompted.`;

  const user = `Brand context: ${brandName || '(a company)'}
Themes: ${themes.map((t) => t.name).join(', ') || '(none)'}
Keywords: ${kwList.map((k) => `${k.phrase} [${k.intent}]`).join(', ')}

Produce ${count} prompts. Return JSON exactly as:
{"prompts": [{"text": "string", "intent": "informational|commercial|transactional|navigational|comparison", "keyword": "the source keyword", "commercialScore": 1-10}]}
Rank so the most commercially valuable, brand-surfacing prompts come first.`;

  try {
    const out = await analyzeJSON(system, user, { temperature: 0.6 });
    const prompts = (out.prompts || [])
      .filter((p) => p && p.text)
      .slice(0, count)
      .map((p, i) => ({
        id: 'p' + i,
        text: p.text,
        intent: p.intent || 'informational',
        keyword: p.keyword || '',
        commercialScore: Number(p.commercialScore) || 5,
      }));
    return { prompts, source: 'llm' };
  } catch (e) {
    const prompts = kwList.slice(0, count).map((k, i) => ({
      id: 'p' + i,
      text: (INTENT_TEMPLATES[k.intent] || INTENT_TEMPLATES.informational)(k.phrase),
      intent: k.intent || 'informational',
      keyword: k.phrase,
      commercialScore: 5,
    }));
    return { prompts, source: 'heuristic', error: e.message };
  }
}
