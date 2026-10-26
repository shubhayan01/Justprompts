// Multi-engine tracker. For each prompt × engine:
//   1. Run the engine to get a real answer (+ citations for live-web engines).
//   2. Detect brand & competitor mentions DETERMINISTICALLY from the text + citations
//      (ground truth — no hallucination), then use the analysis LLM only to judge
//      the softer signals: recommended?, rank among named brands, sentiment.
// Deterministic + LLM are merged so a name the judge misses is still counted.

import { chat } from './providers.js';
import { ENGINES, resolveEngine } from './config.js';
import { pickModel } from './models.js';
import { analyzeJSON, hasAnalysisModel } from './llm.js';
import { domainOf } from './crawl.js';
import { uid } from './store.js';

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Deterministic presence check for one entity (brand or competitor).
function detect(text, citations, { names = [], domain = '' }) {
  const hay = text || '';
  let count = 0;
  let firstPos = Infinity;
  for (const name of names.filter(Boolean)) {
    const re = new RegExp(`\\b${esc(name)}\\b`, 'gi');
    const matches = hay.match(re);
    if (matches) {
      count += matches.length;
      const idx = hay.search(re);
      if (idx >= 0) firstPos = Math.min(firstPos, idx);
    }
  }
  // Domain appears in the answer body as a URL / bare domain.
  let domainInText = false;
  if (domain) {
    const dre = new RegExp(esc(domain).replace(/\\\./g, '\\.'), 'i');
    domainInText = dre.test(hay);
  }
  // Domain appears in the engine's citations.
  const cited = domain ? (citations || []).some((c) => domainOf(c.url) === domain || domainOf(c.url).endsWith('.' + domain)) : false;
  const mentioned = count > 0 || domainInText || cited;
  return { mentioned, count, cited, firstPos: firstPos === Infinity ? null : firstPos };
}

async function runEngine(binding, promptText) {
  const system = 'You are a helpful AI assistant answering a user. Give a natural, useful answer as you normally would, naming specific tools, companies or brands where relevant.';
  const model = await pickModel(binding.provider, binding.model, binding.match || []);
  const { text, citations } = await chat({
    provider: binding.provider,
    model,
    temperature: 0.4,
    grounding: binding.grounding,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: promptText },
    ],
  });
  return { answer: text, citations: citations || [], resolvedModel: model };
}

async function judge({ answer, brandName, competitorNames, deterministic }) {
  if (!hasAnalysisModel() || !answer) return null;
  const system = `You are an impartial analyst scoring an AI assistant's answer for brand visibility (GEO). Be strict and literal: only report what the answer actually says.`;
  const user = `The brand we care about is: "${brandName}".
Competitors to watch: ${competitorNames.length ? competitorNames.join(', ') : '(none given)'}.

AI assistant's answer:
"""
${answer.slice(0, 6000)}
"""

Return JSON exactly:
{
  "brandMentioned": true/false,
  "brandRecommended": true/false,   // actively recommended / endorsed, not just named in passing
  "brandRank": null or integer,     // 1-based position among named brands/tools, null if absent
  "sentiment": "positive|neutral|negative|absent",
  "brandsNamed": ["in order of appearance"],
  "competitorsMentioned": ["which of the listed competitors appear"]
}`;
  try {
    return await analyzeJSON(system, user, { temperature: 0 });
  } catch {
    return null;
  }
}

// Track a single prompt across the chosen engines.
export async function trackPrompt({ project, prompt, engineIds }) {
  const brandNames = [project.brandName, ...(project.brandAliases || [])].filter(Boolean);
  const brandDomain = domainOf(project.brandDomain);
  const competitors = (project.competitors || []).map((c) => ({
    name: c.name,
    domain: domainOf(c.domain || ''),
    names: [c.name].filter(Boolean),
  }));

  const engines = engineIds
    .map((id) => ENGINES.find((e) => e.id === id))
    .filter(Boolean)
    .map((e) => ({ engine: e, binding: resolveEngine(e, { preferFree: project.preferFree !== false }) }))
    .filter((x) => x.binding);

  const runs = [];
  for (const { engine, binding } of engines) {
    const run = {
      id: uid(),
      ts: new Date().toISOString(),
      engineId: engine.id,
      engineLabel: engine.label,
      provider: binding.provider,
      model: binding.model,
      live: binding.live,
      promptId: prompt.id,
      promptText: prompt.text,
      intent: prompt.intent,
      keyword: prompt.keyword,
    };
    try {
      const { answer, citations, resolvedModel } = await runEngine(binding, prompt.text);
      run.model = resolvedModel; // the model that actually ran (after drift-resolution)
      run.answer = answer;
      run.citations = citations;

      const brandDet = detect(answer, citations, { names: brandNames, domain: brandDomain });
      const j = await judge({
        answer,
        brandName: project.brandName,
        competitorNames: competitors.map((c) => c.name),
      });

      run.brand = {
        mentioned: brandDet.mentioned || !!j?.brandMentioned,
        cited: brandDet.cited,
        count: brandDet.count,
        rank: j?.brandRank ?? null,
        recommended: !!j?.brandRecommended,
        sentiment: j?.sentiment || (brandDet.mentioned ? 'neutral' : 'absent'),
      };
      run.brandsNamed = j?.brandsNamed || [];
      run.competitors = competitors.map((c) => {
        const det = detect(answer, citations, { names: c.names, domain: c.domain });
        const inJudge = (j?.competitorsMentioned || []).some((n) => n && c.name && n.toLowerCase().includes(c.name.toLowerCase()));
        return { name: c.name, mentioned: det.mentioned || inJudge, cited: det.cited, count: det.count };
      });
    } catch (e) {
      run.error = e.message;
      run.brand = { mentioned: false, cited: false, count: 0, rank: null, recommended: false, sentiment: 'absent' };
      run.competitors = competitors.map((c) => ({ name: c.name, mentioned: false, cited: false, count: 0 }));
    }
    runs.push(run);
  }
  return runs;
}

// Track many prompts across engines, in parallel with a concurrency cap so we
// stay under free-tier rate limits. onProgress(done, total, lastRun) for streaming UIs.
export async function trackProject({ project, promptIds, engineIds, onProgress, concurrency }) {
  const prompts = project.prompts.filter((p) => !promptIds || promptIds.includes(p.id));
  const total = prompts.length;
  const all = [];
  let done = 0;
  let idx = 0;
  const cc = Math.max(1, Math.min(concurrency || Number(process.env.TRACK_CONCURRENCY) || 4, total || 1));

  async function worker() {
    while (idx < prompts.length) {
      const prompt = prompts[idx++];
      const runs = await trackPrompt({ project, prompt, engineIds });
      all.push(...runs);
      done++;
      if (onProgress) onProgress(done, total, runs);
    }
  }
  await Promise.all(Array.from({ length: cc }, worker));
  return all;
}
