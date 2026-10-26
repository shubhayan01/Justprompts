// Keyword extraction. The GOOD keywords come from the page's TOPICS — its titles,
// headings and meta — read by an LLM the way an SEO analyst would, returning clean
// search terms grouped by theme. Raw body n-grams are noise, so they're only a
// no-API fallback (and even then we filter hard).

import { analyzeJSON, hasAnalysisModel } from './llm.js';

// Build a compact, high-signal corpus from the crawl: titles, headings, meta.
export function buildCorpus(pages) {
  const ok = pages.filter((p) => p.ok);
  const titles = [...new Set(ok.map((p) => p.title).filter(Boolean))];
  const metas = [...new Set(ok.map((p) => p.description).filter(Boolean))];
  const metaKw = [...new Set(ok.flatMap((p) => (p.keywordsMeta || '').split(',').map((s) => s.trim())).filter(Boolean))];
  const headings = [...new Set(ok.flatMap((p) => p.headings || []))].filter((h) => h.length > 2 && h.length < 90);
  return [
    titles.length ? 'PAGE TITLES:\n' + titles.slice(0, 60).join('\n') : '',
    metaKw.length ? '\nMETA KEYWORDS:\n' + metaKw.slice(0, 60).join(', ') : '',
    metas.length ? '\nMETA DESCRIPTIONS:\n' + metas.slice(0, 40).join('\n') : '',
    headings.length ? '\nHEADINGS:\n' + headings.slice(0, 160).join('\n') : '',
  ].filter(Boolean).join('\n').slice(0, 9000);
}

// Primary: extract real SEO keywords/topics from the site via the LLM.
export async function extractSiteKeywords({ pages, brandName }) {
  if (!hasAnalysisModel()) return { keywords: [], themes: [], source: 'none' };
  const corpus = buildCorpus(pages);
  if (!corpus.trim()) return { keywords: [], themes: [], source: 'none' };

  const system = `You are an SEO keyword strategist. From a website's titles, headings and meta, extract the REAL keywords the business should rank for — the search terms its potential customers would actually type into Google or an AI assistant.

STRICT RULES:
- Output clean search terms (mostly 2-4 words), NOT sentences or slogans copied from the page.
- EXCLUDE: the brand's own name, people's names, testimonials, navigation ("home", "contact"), CTAs ("get started", "book demo"), pricing-plan names, and any merged/garbled tokens.
- Focus on the PRODUCTS, SERVICES, PROBLEMS SOLVED and TOPICS — what a buyer searches for, not what the site calls itself.
- Group into a few clear themes. Classify intent: informational, commercial, transactional, comparison.`;

  const user = `Brand (exclude its name from keywords): ${brandName || '(unknown)'}

Website content:
${corpus}

Return JSON exactly:
{
  "themes": [{"name": "string", "keywords": ["string", ...]}],
  "keywords": [{"phrase": "string", "intent": "informational|commercial|transactional|comparison"}]
}
Give 20-40 of the strongest keywords. No duplicates, no brand name, no garbled words.`;

  try {
    const out = await analyzeJSON(system, user);
    const keywords = (out.keywords || []).filter((k) => k && k.phrase && k.phrase.length > 2);
    return { keywords, themes: out.themes || [], source: 'llm' };
  } catch (e) {
    return { keywords: [], themes: [], source: 'none', error: e.message };
  }
}

// Kept for the "Refine with AI" button — same thing, re-run on demand.
export async function refineKeywords({ brandName, pages }) {
  return extractSiteKeywords({ pages, brandName });
}
