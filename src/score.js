// Score & recommend: turn a batch of runs into share-of-voice, citation rate,
// average position, sentiment mix, a competitor leaderboard, the exact prompts
// where we're losing (gaps), and a prioritised action list.

import { analyzeJSON, hasAnalysisModel } from './llm.js';

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);

export function computeScore(project, runs) {
  const valid = runs.filter((r) => !r.error);
  const totalRuns = runs.length;
  const errored = totalRuns - valid.length;

  const brandMentions = valid.filter((r) => r.brand?.mentioned).length;
  const brandCitations = valid.filter((r) => r.brand?.cited).length;
  const brandRecommended = valid.filter((r) => r.brand?.recommended).length;
  const ranks = valid.map((r) => r.brand?.rank).filter((x) => typeof x === 'number');
  const avgRank = ranks.length ? Math.round((ranks.reduce((a, b) => a + b, 0) / ranks.length) * 10) / 10 : null;

  const sentiment = { positive: 0, neutral: 0, negative: 0, absent: 0 };
  for (const r of valid) sentiment[r.brand?.sentiment || 'absent']++;

  // Leaderboard: the brand + every OTHER brand the engines actually named
  // (auto-discovered from the judge's brandsNamed), plus any explicit competitors.
  // This gives a real ranking even when the user lists no competitors.
  const brandKey = (project.brandName || 'Us').toLowerCase();
  const tally = new Map();          // normalisedName -> {name, mentions}
  const bump = (name) => {
    const n = (name || '').trim();
    if (!n) return;
    const k = n.toLowerCase();
    if (!tally.has(k)) tally.set(k, { name: n, mentions: 0 });
    tally.get(k).mentions++;
  };
  tally.set(brandKey, { name: project.brandName || 'Us', mentions: 0 });
  for (const r of valid) {
    if (r.brand?.mentioned) tally.get(brandKey).mentions++;
    // auto-discovered brands named in this answer (unique per answer)
    const named = new Set((r.brandsNamed || []).map((x) => (x || '').trim()).filter(Boolean));
    for (const n of named) if (n.toLowerCase() !== brandKey) bump(n);
    // explicit competitors detected deterministically
    for (const c of r.competitors || []) if (c.mentioned) bump(c.name);
  }
  const entries = [...tally.values()].filter((e) => e.mentions > 0 || e.name === (project.brandName || 'Us'));
  const totalMentions = entries.reduce((a, b) => a + b.mentions, 0);
  const leaderboard = entries
    .map((e) => ({
      name: e.name,
      isBrand: e.name.toLowerCase() === brandKey,
      mentions: e.mentions,
      shareOfVoice: pct(e.mentions, totalMentions),
      presence: pct(e.mentions, valid.length),
    }))
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, 20);
  // The brand's rank on the leaderboard (1-based), or null if unranked.
  const brandRankOverall = (() => {
    const i = leaderboard.findIndex((l) => l.isBrand);
    return i >= 0 && leaderboard[i].mentions > 0 ? i + 1 : null;
  })();

  // Per-engine mention rate.
  const byEngine = {};
  for (const r of valid) {
    const k = r.engineLabel;
    byEngine[k] = byEngine[k] || { engine: k, runs: 0, mentions: 0, citations: 0 };
    byEngine[k].runs++;
    if (r.brand?.mentioned) byEngine[k].mentions++;
    if (r.brand?.cited) byEngine[k].citations++;
  }
  const engines = Object.values(byEngine).map((e) => ({
    ...e, mentionRate: pct(e.mentions, e.runs), citationRate: pct(e.citations, e.runs),
  }));

  // Gaps: prompts where we're absent but a competitor shows up.
  const gaps = valid
    .filter((r) => !r.brand?.mentioned && (r.competitors || []).some((c) => c.mentioned))
    .map((r) => ({
      promptText: r.promptText,
      engine: r.engineLabel,
      keyword: r.keyword,
      intent: r.intent,
      winners: (r.competitors || []).filter((c) => c.mentioned).map((c) => c.name),
    }));

  return {
    ts: new Date().toISOString(),
    totalRuns, validRuns: valid.length, errored,
    brand: {
      name: project.brandName || 'Us',
      mentionRate: pct(brandMentions, valid.length),
      citationRate: pct(brandCitations, valid.length),
      recommendRate: pct(brandRecommended, valid.length),
      avgRank,
      rankOverall: brandRankOverall,
      competitorsFound: Math.max(leaderboard.length - 1, 0),
      shareOfVoice: pct(brandMentions, totalMentions),
      mentions: brandMentions,
    },
    sentiment,
    leaderboard,
    engines,
    gaps,
  };
}

const STATIC_PLAYBOOK = [
  { priority: 'High', action: 'Publish answer-first, quotable content', why: 'LLMs lift clear claims, stats and definitions. Lead each page with a direct answer.' },
  { priority: 'High', action: 'Build comparison & "best X" pages', why: 'The exact format engines reach for when recommending tools — and where you are most absent.' },
  { priority: 'Medium', action: 'Earn mentions on sources models trust', why: 'Reddit, Wikipedia, YouTube, G2/Capterra, industry listicles and PR get corroborated and cited.' },
  { priority: 'Medium', action: 'Add structured data & clear entity naming', why: 'Helps engines identify and attribute your brand confidently.' },
  { priority: 'Low', action: 'Grow topical authority with content clusters', why: 'Depth around core themes makes models associate you with the topic.' },
];

export async function recommend(project, summary) {
  if (!hasAnalysisModel()) return { items: STATIC_PLAYBOOK, source: 'playbook' };

  const topGaps = summary.gaps.slice(0, 12).map((g) => `- "${g.promptText}" (${g.engine}) → winners: ${g.winners.join(', ')}`).join('\n');
  const leaders = summary.leaderboard.map((l) => `${l.name}: ${l.shareOfVoice}% SoV`).join(', ');

  const system = `You are a GEO (Generative Engine Optimization) strategist. Given a brand's AI-answer visibility data, produce a prioritised, specific action list to increase how often AI engines mention and cite the brand. Ground your advice in the proven GEO playbook: answer-first quotable content, comparison/"best X" pages, earning mentions on trusted sources (Reddit, Wikipedia, YouTube, G2/Capterra, PR), structured data + entity clarity, fresh consistent facts, and topical authority clusters. Be concrete and tie actions to the actual gaps.`;

  const user = `Brand: ${project.brandName}
Share of voice: ${summary.brand.shareOfVoice}% | mention rate ${summary.brand.mentionRate}% | citation rate ${summary.brand.citationRate}%
Competitor share of voice: ${leaders}

Prompts where we're absent but competitors win:
${topGaps || '(none — good coverage)'}

Return JSON exactly:
{"items": [{"priority": "High|Medium|Low", "action": "string", "why": "string", "example": "a concrete first step, e.g. a page/title to publish"}]}
Give 5-8 items, highest-impact first.`;

  try {
    const out = await analyzeJSON(system, user, { temperature: 0.4 });
    const items = (out.items || []).filter((i) => i && i.action);
    return { items: items.length ? items : STATIC_PLAYBOOK, source: 'llm' };
  } catch (e) {
    return { items: STATIC_PLAYBOOK, source: 'playbook', error: e.message };
  }
}
