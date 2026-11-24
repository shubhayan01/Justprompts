// ─────────────────────────────────────────────────────────────────────────────
//  Demo data — build a full "Demo project" with 8 weeks of FAKE results so the
//  dashboard can be explored with NO API keys and NO waiting. Ported from the
//  Python seed_demo.py idea, but it generates runs in OUR shape and scores them
//  with the real computeScore(), so every dashboard section is populated for real.
//
//  Used by:  POST /api/demo  (the "Load demo data" button)  and  `npm run seed`.
// ─────────────────────────────────────────────────────────────────────────────

import { computeScore } from './score.js';
import { summarize, snapshotOf } from './ranktrack.js';
import { uid } from './store.js';

// Deterministic RNG so the demo looks the same every time.
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const BRAND = { name: 'Acme CRM', aliases: ['AcmeCRM'], domain: 'acmecrm.com', is_own: true };
const COMPETITORS = [
  { name: 'Zoho CRM', aliases: ['Zoho'], domain: 'zoho.com' },
  { name: 'HubSpot', aliases: ['HubSpot CRM'], domain: 'hubspot.com' },
  { name: 'Freshsales', aliases: ['Freshworks CRM'], domain: 'freshworks.com' },
  { name: 'Pipedrive', aliases: [], domain: 'pipedrive.com' },
];
const PROMPT_GROUPS = {
  'Best X for Y': ['best CRM for small business in India', 'best free CRM for startups', 'best CRM for real estate agents'],
  Comparisons: ['Zoho CRM vs HubSpot for a 10 person team', 'Pipedrive alternatives that are cheaper'],
  'How to': ['how to track sales leads without spreadsheets', 'how to set up a sales pipeline for a new business'],
  Brand: ['is Acme CRM good for small teams', 'Acme CRM pricing and reviews'],
};
const ENGINES = [
  { id: 'chatgpt', label: 'ChatGPT', bias: 0.0, live: false },
  { id: 'perplexity', label: 'Perplexity', bias: 0.12, live: true },
  { id: 'gemini', label: 'Gemini', bias: -0.08, live: true },
  { id: 'claude', label: 'Claude', bias: 0.04, live: false },
];
const THIRD_PARTY = ['g2.com', 'capterra.com', 'reddit.com', 'forbes.com', 'techradar.com', 'zapier.com', 'youtube.com', 'softwaresuggest.com', 'quora.com'];
const TONES = ['is widely praised for its ease of use', 'is a common choice for growing teams', 'has mixed reviews about pricing'];
const SENTS = ['positive', 'neutral', 'negative'];

const intentFor = (grp) => (grp === 'Brand' ? 'navigational' : grp === 'Comparisons' ? 'commercial' : grp === 'How to' ? 'informational' : 'commercial');

// Generate one week's runs (every prompt × engine × 3 attempts).
function weekRuns(rng, prompts, entities, growth) {
  const runs = [];
  for (const pr of prompts) {
    for (const eng of ENGINES) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        const ownP = 0.3 + growth + eng.bias + (pr.grp === 'Brand' ? 0.35 : 0) - (pr.grp === 'How to' ? 0.15 : 0);
        const picked = entities.filter((e) => rng() < (e.is_own ? ownP : 0.55));
        // shuffle
        for (let i = picked.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [picked[i], picked[j]] = [picked[j], picked[i]]; }

        const lines = ['Here are some options worth considering:\n'];
        const citations = [];
        picked.forEach((e, i) => {
          lines.push(`${i + 1}. **${e.name}** ${TONES[Math.floor(rng() * TONES.length)]}.`);
          if (rng() < (e.is_own ? 0.35 + growth : 0.5)) citations.push({ url: `https://${e.domain}/`, title: e.name });
        });
        // 3 third-party sources
        const picks = [...THIRD_PARTY].sort(() => rng() - 0.5).slice(0, 3);
        for (const d of picks) citations.push({ url: `https://www.${d}/article-${1 + Math.floor(rng() * 40)}`, title: d });

        const answer = picked.length ? lines.join('\n') : 'It depends on your budget and team size. Compare pricing and support before choosing.';
        const brandIdx = picked.findIndex((e) => e.is_own);
        const brandPicked = brandIdx >= 0;
        // Mostly positive/neutral, with a minority of negatives that shrinks as
        // visibility (growth) improves.
        const roll = rng();
        const negCut = 0.9 + growth * 0.3;
        const sentiment = !brandPicked ? 'absent' : roll < 0.52 ? 'positive' : roll < negCut ? 'neutral' : 'negative';

        runs.push({
          id: uid(),
          ts: new Date().toISOString(),
          engineId: eng.id,
          engineLabel: eng.label,
          provider: 'demo',
          model: `${eng.id}-demo`,
          live: eng.live,
          promptId: pr.id,
          promptText: pr.text,
          intent: pr.intent,
          keyword: pr.grp,
          attempt,
          answer,
          citations,
          brand: {
            mentioned: brandPicked,
            cited: brandPicked && citations.some((c) => c.url.includes(BRAND.domain)),
            count: brandPicked ? 1 : 0,
            rank: brandPicked ? brandIdx + 1 : null,
            recommended: brandPicked && brandIdx === 0,
            sentiment,
          },
          brandsNamed: picked.map((e) => e.name),
          competitors: COMPETITORS.map((c) => ({
            name: c.name,
            mentioned: picked.some((e) => e.name === c.name),
            cited: citations.some((ci) => ci.url.includes(c.domain)),
            count: picked.some((e) => e.name === c.name) ? 1 : 0,
          })),
        });
      }
    }
  }
  return runs;
}

// ── Demo Google rank-tracking data (DataForSEO shape) ─────────────────────────
// Realistic SEO keywords with positions that improve over 8 weekly checks, so the
// Google Rank tab shows a populated table + trend with NO API calls.
const RANK_KEYWORDS = [
  { kw: 'best crm for small business', end: 4, start: 11 },
  { kw: 'free crm software', end: 7, start: 14 },
  { kw: 'crm for real estate agents', end: 2, start: 6 },
  { kw: 'sales pipeline software', end: 5, start: 12 },
  { kw: 'best crm for startups', end: 3, start: 9 },
  { kw: 'hubspot alternatives', end: 8, start: 19 },
  { kw: 'zoho crm vs hubspot', end: 6, start: 10 },
  { kw: 'lead tracking software', end: 11, start: 22 },
  { kw: 'cheap crm software', end: 9, start: 15 },
  { kw: 'crm with email integration', end: 13, start: 25 },
  { kw: 'contact management software', end: 1, start: 3 },
  { kw: 'crm for sales teams', end: 5, start: 8 },
  { kw: 'best crm india', end: 16, start: 40 },
  { kw: 'pipedrive alternatives', end: 10, start: null }, // broke into top 100 recently
];
const COMP_FOR_KW = [
  { name: 'HubSpot', domain: 'hubspot.com' },
  { name: 'Zoho CRM', domain: 'zoho.com' },
  { name: 'Pipedrive', domain: 'pipedrive.com' },
];

function demoRankWeek(rng, weekIdx, totalWeeks) {
  // weekIdx 0 = oldest, totalWeeks-1 = newest. Interpolate start→end.
  const f = totalWeeks > 1 ? weekIdx / (totalWeeks - 1) : 1;
  const keywords = RANK_KEYWORDS.map((k) => {
    let position = null;
    if (k.start == null) {
      // Appears only in the last ~3 weeks.
      if (weekIdx >= totalWeeks - 3) position = Math.round(18 - (weekIdx - (totalWeeks - 3)) * 4);
    } else {
      const base = Math.round(k.start + (k.end - k.start) * f);
      const jitter = Math.round((rng() - 0.5) * 2); // ±1 wobble
      position = Math.max(1, base + jitter);
    }
    if (position != null && position > 100) position = null;
    const comp = COMP_FOR_KW[Math.floor(rng() * COMP_FOR_KW.length)];
    const compPos = Math.max(1, Math.round((position || 20) - 1 - rng() * 3));
    return {
      keyword: k.kw,
      found: position != null,
      position,
      url: position != null ? `https://acmecrm.com/${k.kw.replace(/\s+/g, '-')}` : '',
      title: position != null ? `${k.kw} — Acme CRM` : '',
      topCompetitor: position != null ? { name: comp.name, domain: comp.domain, position: compPos } : null,
      features: rng() < 0.4 ? ['ai_overview', 'people_also_ask'] : ['people_also_ask'],
      resultsCount: 1_000_000 + Math.floor(rng() * 9_000_000),
    };
  });
  return keywords;
}

// Build the whole demo project object (ready to insert into the store).
export function buildDemoProject() {
  const rng = makeRng(7);
  const now = Date.now();
  const entities = [BRAND, ...COMPETITORS.map((c) => ({ ...c, is_own: false }))];

  const prompts = [];
  let i = 0;
  for (const [grp, texts] of Object.entries(PROMPT_GROUPS)) {
    for (const text of texts) prompts.push({ id: 'p' + i++, text, grp, intent: intentFor(grp) });
  }

  const project = {
    id: uid(),
    name: 'Demo project (fake data)',
    brandName: BRAND.name,
    brandDomain: 'https://' + BRAND.domain + '/',
    brandAliases: BRAND.aliases,
    competitors: COMPETITORS.map((c) => ({ name: c.name, domain: 'https://' + c.domain + '/' })),
    preferFree: true,
    isDemo: true,
    pages: [],
    keywords: [],
    themes: Object.entries(PROMPT_GROUPS).map(([name, texts]) => ({ name, keywords: texts })),
    prompts,
    runs: [],
    snapshots: [],
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };

  // 8 weeks of history; visibility improves ~3.5% per week.
  for (let week = 8; week >= 1; week--) {
    const growth = (8 - week) * 0.035;
    const runs = weekRuns(rng, prompts, entities, growth);
    const ts = new Date(now - (week - 1) * 7 * 86400000).toISOString();
    for (const r of runs) r.ts = ts;
    const summary = computeScore(project, runs);
    summary.ts = ts;
    project.snapshots.push({
      ts,
      shareOfVoice: summary.brand.shareOfVoice,
      mentionRate: summary.brand.mentionRate,
      citationRate: summary.brand.citationRate,
      leaderboard: summary.leaderboard.map((l) => ({ name: l.name, shareOfVoice: l.shareOfVoice })),
    });
    if (week === 1) { project.runs = runs; project.lastSummary = summary; } // keep the latest week's detail
  }

  // ── Google rank-tracking demo: 8 weekly checks, improving over time. ──
  const rankRng = makeRng(42);
  const WEEKS = 8;
  project.rankConfig = { location: 'United Kingdom', language: 'en' };
  project.trackedKeywords = RANK_KEYWORDS.map((k) => k.kw);
  project.rankSnapshots = [];
  let prevRank = null;
  for (let w = 0; w < WEEKS; w++) {
    const kws = demoRankWeek(rankRng, w, WEEKS);
    // Movement vs the previous check.
    const prevMap = new Map((prevRank?.keywords || []).map((k) => [k.keyword, k.position]));
    for (const k of kws) {
      k.prevPosition = prevMap.has(k.keyword) ? prevMap.get(k.keyword) : null;
      k.change = (k.position != null && k.prevPosition != null) ? k.prevPosition - k.position : null;
    }
    const ts = new Date(now - (WEEKS - 1 - w) * 7 * 86400000).toISOString();
    const rankResults = { ts, location: 'United Kingdom', language: 'en', brandDomain: 'acmecrm.com', cost: 0.049, keywords: kws, summary: summarize(kws) };
    project.rankSnapshots.push(snapshotOf(rankResults));
    prevRank = rankResults;
    if (w === WEEKS - 1) project.rankResults = rankResults; // latest detail
  }

  project.recommendations = {
    source: 'playbook',
    items: [
      { priority: 'High', action: 'Publish answer-first comparison pages ("Acme CRM vs Zoho / HubSpot")', why: 'Comparisons is where you are most absent and where engines reach for a source to cite.', example: 'Create /compare/acme-vs-hubspot with a clear verdict table in the first screen.' },
      { priority: 'High', action: 'Earn mentions on G2, Capterra and Reddit threads', why: 'These are the exact third-party sites cited in answers that name competitors but not you.', example: 'Seed an honest G2 profile and answer 3 relevant Reddit r/CRM threads this month.' },
      { priority: 'Medium', action: 'Win the "best free CRM for startups" intent', why: 'High-commercial prompt where your mention rate lags on ChatGPT and Gemini.', example: 'Publish a "Best free CRM for startups (2026)" guide that lists Acme first with proof.' },
      { priority: 'Medium', action: 'Add structured data + consistent entity naming', why: 'Helps engines attribute "Acme CRM" confidently and lift your citation rate.', example: 'Add Organization + Product JSON-LD and use the exact name "Acme CRM" everywhere.' },
      { priority: 'Low', action: 'Build topical authority around sales-pipeline how-tos', why: 'Informational prompts rarely name you; depth here grows topic association.', example: 'Cluster 5 how-to posts around "sales pipeline setup" linking to your product.' },
    ],
  };

  return project;
}
