import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PORT, engineStatus, resolveAnalysisModel, anyKeyPresent, ENGINES, KEYS } from './src/config.js';
import { pickModel } from './src/models.js';
import * as store from './src/store.js';
import { crawlSite, extractKeywords, brandFromDomain, domainOf, normalizeUrl } from './src/crawl.js';
import { refineKeywords, extractSiteKeywords } from './src/keywords.js';
import { generatePrompts } from './src/prompts.js';
import { trackProject } from './src/track.js';
import { computeScore, recommend } from './src/score.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // behind Render's proxy

// Lightweight health check for the platform (no provider calls).
app.get('/healthz', (req, res) => res.type('text').send('ok'));

// Optional password gate. When APP_PASSWORD is set, everything except /healthz
// requires HTTP Basic auth — important for a public deploy so strangers can't
// burn your API keys. The browser caches the credentials for EventSource too.
const APP_PASSWORD = (process.env.APP_PASSWORD || '').trim();
if (APP_PASSWORD) {
  app.use((req, res, next) => {
    if (req.path === '/healthz') return next();
    const [scheme, creds] = (req.headers.authorization || '').split(' ');
    if (scheme === 'Basic' && creds) {
      const pass = Buffer.from(creds, 'base64').toString().split(':')[1];
      if (pass === APP_PASSWORD) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="JustPrompt"').status(401).send('Authentication required');
  });
}

app.use(express.json({ limit: '2mb' }));
app.use(express.static(join(__dirname, 'public')));

const ok = (res, data) => res.json({ ok: true, ...data });
const fail = (res, code, msg) => res.status(code).json({ ok: false, error: msg });
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => fail(res, 500, e.message));

// ── Status ───────────────────────────────────────────────────────────────────
app.get('/api/health', wrap(async (req, res) => {
  const preferFree = req.query.preferFree !== 'false';
  const engines = engineStatus({ preferFree });
  // Resolve the model that will ACTUALLY run for each enabled engine (handles drift).
  await Promise.all(engines.map(async (e) => {
    if (e.binding) {
      const real = await pickModel(e.binding.provider, e.binding.model, e.binding.match || []);
      e.binding.resolvedModel = real;
      e.binding.remapped = real !== e.binding.model;
    }
  }));
  const a = resolveAnalysisModel();
  let analysis = null;
  if (a) {
    const real = await pickModel(a.provider, a.model, a.match || []);
    analysis = { provider: a.provider, model: real, remapped: real !== a.model };
  }
  ok(res, {
    anyKey: anyKeyPresent(),
    keys: Object.fromEntries(Object.entries(KEYS).map(([k, v]) => [k, !!v])),
    engines,
    analysis,
  });
}));

// ── Projects ──────────────────────────────────────────────────────────────────
app.get('/api/projects', wrap(async (req, res) => ok(res, { projects: await store.listProjects() })));

app.post('/api/projects', wrap(async (req, res) => {
  const b = req.body || {};
  const brandDomain = b.brandDomain ? normalizeUrl(b.brandDomain) : '';
  const project = await store.createProject({
    name: b.name,
    brandName: b.brandName || brandFromDomain(brandDomain),
    brandDomain,
    brandAliases: cleanList(b.brandAliases),
    competitors: (b.competitors || []).map((c) => ({
      name: c.name || brandFromDomain(c.domain),
      domain: c.domain ? normalizeUrl(c.domain) : '',
    })).filter((c) => c.name || c.domain),
    preferFree: b.preferFree !== false,
  });
  ok(res, { project });
}));

app.get('/api/projects/:id', wrap(async (req, res) => {
  const p = await store.getProject(req.params.id);
  return p ? ok(res, { project: p }) : fail(res, 404, 'not found');
}));

app.patch('/api/projects/:id', wrap(async (req, res) => {
  const b = req.body || {};
  const patch = {};
  for (const k of ['name', 'brandName', 'preferFree']) if (k in b) patch[k] = b[k];
  if ('brandDomain' in b) patch.brandDomain = b.brandDomain ? normalizeUrl(b.brandDomain) : '';
  if ('brandAliases' in b) patch.brandAliases = cleanList(b.brandAliases);
  if ('competitors' in b) patch.competitors = (b.competitors || []).map((c) => ({
    name: c.name || brandFromDomain(c.domain), domain: c.domain ? normalizeUrl(c.domain) : '',
  })).filter((c) => c.name || c.domain);
  const p = await store.updateProject(req.params.id, patch);
  return p ? ok(res, { project: p }) : fail(res, 404, 'not found');
}));

app.delete('/api/projects/:id', wrap(async (req, res) => {
  const done = await store.deleteProject(req.params.id);
  return done ? ok(res, {}) : fail(res, 404, 'not found');
}));

// ── Step 1-2: whole-site scan + keyword mining (SSE progress) ──────────────────
app.get('/api/projects/:id/scan', async (req, res) => {
  const project = await store.getProject(req.params.id);
  if (!project) return fail(res, 404, 'not found');
  const startUrl = normalizeUrl(req.query.url || project.brandDomain);
  if (!startUrl) return fail(res, 400, 'Need a website URL to scan.');
  const maxPages = Math.min(Math.max(Number(req.query.max) || 150, 1), 400);

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('start', { startUrl, maxPages });

  try {
    const pages = await crawlSite(startUrl, { maxPages, onProgress: (p) => send('progress', p) });
    const raw = extractKeywords(pages, 800); // heuristic fallback / raw terms
    const brandName = project.brandName || brandFromDomain(startUrl);

    // PRIMARY: real SEO keywords read from the site's topics by the LLM.
    send('progress', { crawled: pages.length, queued: 0, max: maxPages, phase: 'extracting keywords…' });
    let site = { keywords: [], themes: [], source: 'none' };
    try { site = await extractSiteKeywords({ pages, brandName }); } catch (e) { site.error = e.message; }

    // Keep per-page signals (small) so "Refine" can re-run later.
    const slim = pages.map((p) => ({
      url: p.url, ok: p.ok, title: p.title, error: p.error, chars: p.chars,
      headings: (p.headings || []).slice(0, 25), description: p.description || '', keywordsMeta: p.keywordsMeta || '',
    }));
    const keywords = site.keywords.length ? site.keywords : raw.map((k) => ({ phrase: k.phrase, intent: 'informational' }));

    await store.mutate(project.id, (p) => {
      p.pages = slim;
      p.rawKeywords = raw;
      p.keywords = site.keywords;
      p.themes = site.themes;
      if (!p.brandDomain) p.brandDomain = startUrl;
      if (!p.brandName) p.brandName = brandName;
    });
    send('done', {
      pages: slim,
      keywords,
      themes: site.themes || [],
      rawKeywords: raw,
      source: site.source,
      error: site.error,
      counts: { ok: slim.filter((p) => p.ok).length, total: slim.length, keywords: keywords.length, raw: raw.length },
    });
  } catch (e) {
    send('error', { error: e.message });
  }
  res.end();
});

app.post('/api/projects/:id/keywords/refine', wrap(async (req, res) => {
  const project = await store.getProject(req.params.id);
  if (!project) return fail(res, 404, 'not found');
  const out = await refineKeywords({ brandName: project.brandName, pages: project.pages || [] });
  await store.mutate(project.id, (p) => { p.keywords = out.keywords; p.themes = out.themes; });
  ok(res, out);
}));

// ── Step 3: prompt engine ──────────────────────────────────────────────────────
app.post('/api/projects/:id/prompts/generate', wrap(async (req, res) => {
  const project = await store.getProject(req.params.id);
  if (!project) return fail(res, 404, 'not found');
  const kws = (project.keywords && project.keywords.length
    ? project.keywords
    : (project.rawKeywords || []).slice(0, 40).map((k) => ({ phrase: k.phrase, intent: 'informational' })));
  const out = await generatePrompts({
    brandName: project.brandName,
    keywords: kws,
    themes: project.themes || [],
    count: Number(req.body?.count) || 15,
  });
  await store.mutate(project.id, (p) => { p.prompts = out.prompts; });
  ok(res, out);
}));

// Replace the prompt set manually (edit/add/remove).
app.put('/api/projects/:id/prompts', wrap(async (req, res) => {
  const project = await store.getProject(req.params.id);
  if (!project) return fail(res, 404, 'not found');
  const prompts = (req.body?.prompts || [])
    .filter((p) => p && p.text)
    .map((p, i) => ({ id: p.id || 'p' + i, text: p.text, intent: p.intent || 'informational', keyword: p.keyword || '', commercialScore: p.commercialScore || 5 }));
  await store.mutate(project.id, (p) => { p.prompts = prompts; });
  ok(res, { prompts });
}));

// ── Step 4-5: track (SSE streaming progress) ────────────────────────────────────
app.get('/api/projects/:id/track', async (req, res) => {
  const project = await store.getProject(req.params.id);
  if (!project) return fail(res, 404, 'not found');

  let engineIds = (req.query.engines || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!engineIds.length) {
    engineIds = engineStatus({ preferFree: project.preferFree !== false }).filter((e) => e.enabled).map((e) => e.id);
  }
  const promptIds = req.query.prompts ? String(req.query.prompts).split(',').filter(Boolean) : null;
  if (!project.prompts?.length) return fail(res, 400, 'No prompts yet — generate prompts first.');
  if (!engineIds.length) return fail(res, 400, 'No engines enabled — add an API key in .env.');

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const selectedPrompts = promptIds ? project.prompts.filter((p) => promptIds.includes(p.id)) : project.prompts;
  send('start', { total: selectedPrompts.length, engines: engineIds });

  try {
    const runs = await trackProject({
      project, engineIds, promptIds,
      onProgress: (done, total, batch) => send('progress', { done, total, batch }),
    });
    const summary = computeScore(project, runs);
    const rec = await recommend(project, summary);
    await store.mutate(project.id, (p) => {
      p.runs = runs;
      p.lastSummary = summary;
      p.recommendations = rec;
      p.snapshots = p.snapshots || [];
      p.snapshots.push({
        ts: summary.ts,
        shareOfVoice: summary.brand.shareOfVoice,
        mentionRate: summary.brand.mentionRate,
        citationRate: summary.brand.citationRate,
        leaderboard: summary.leaderboard.map((l) => ({ name: l.name, shareOfVoice: l.shareOfVoice })),
      });
    });
    send('done', { summary, rec, runs });
  } catch (e) {
    send('error', { error: e.message });
  }
  res.end();
});

// ── Score / history ─────────────────────────────────────────────────────────────
app.get('/api/projects/:id/score', wrap(async (req, res) => {
  const project = await store.getProject(req.params.id);
  if (!project) return fail(res, 404, 'not found');
  if (!project.runs?.length) return ok(res, { summary: null, rec: null, snapshots: project.snapshots || [] });
  ok(res, { summary: project.lastSummary, rec: project.recommendations, runs: project.runs, snapshots: project.snapshots || [] });
}));

function cleanList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  return [];
}

app.listen(PORT, () => {
  console.log(`\n  JustPrompt — GEO/AEO prompt tracker`);
  console.log(`  ▶  http://localhost:${PORT}\n`);
  if (!anyKeyPresent()) {
    console.log('  ⚠  No API keys found. Copy .env.example to .env and add at least one free key');
    console.log('     (Groq / Gemini / OpenRouter are free). The UI will guide you.\n');
  } else {
    const en = engineStatus().filter((e) => e.enabled).map((e) => e.label);
    console.log(`  Engines live: ${en.join(', ') || '(none — check keys)'}\n`);
  }
});
