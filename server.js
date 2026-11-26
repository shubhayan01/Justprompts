import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PORT, engineStatus, resolveAnalysisModel, anyKeyPresent, ENGINES, KEY_NAMES, getKeys, setKeys, keySources, ghostEnabled, setGhost, setDfs, dfsConfigured, dfsSource, dfsLoginMasked, setSemrush, semrushConfigured, semrushSource, semrushKeyMasked } from './src/config.js';
import { pickModel, clearModelCache } from './src/models.js';
import * as store from './src/store.js';
import { crawlSite, extractKeywords, brandFromDomain, domainOf, normalizeUrl } from './src/crawl.js';
import { refineKeywords, extractSiteKeywords } from './src/keywords.js';
import { generatePrompts } from './src/prompts.js';
import { trackProject } from './src/track.js';
import { computeScore, recommend } from './src/score.js';
import { trackRanks, validateDfs, defaultTrackedKeywords, snapshotOf } from './src/ranktrack.js';
import { validateSemrush, enrichKeywords, relatedKeywords, domainOrganic, compareDomains, countryCode, UNIT_COST } from './src/semrush.js';

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
    keys: keySources(), // { KEY_NAME: 'session' | 'env' | null }
    ghost: ghostEnabled(),
    engines,
    analysis,
  });
}));

// ── Ghost (headless browser) engine toggle ─────────────────────────────────────
app.post('/api/ghost', (req, res) => {
  setGhost(!!(req.body && req.body.enabled));
  ok(res, { ghost: ghostEnabled() });
});

// ── Runtime API keys (set from the UI; stored in memory, merged over env) ──────
app.get('/api/keys', (req, res) => ok(res, { sources: keySources() }));

app.post('/api/keys', (req, res) => {
  const b = req.body || {};
  // Accept either full env names or short names (groq, gemini, ...).
  const short = { groq: 'GROQ_API_KEY', gemini: 'GEMINI_API_KEY', openrouter: 'OPENROUTER_API_KEY', openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', perplexity: 'PERPLEXITY_API_KEY' };
  const patch = {};
  for (const [k, v] of Object.entries(b)) {
    const name = KEY_NAMES.includes(k) ? k : short[k.toLowerCase()];
    if (name) patch[name] = v;
  }
  setKeys(patch);
  clearModelCache(); // re-discover models with the new key(s)
  ok(res, { sources: keySources() });
});

// ── DataForSEO credentials (Google keyword rank tracking) ──────────────────────
app.get('/api/dataforseo', (req, res) => ok(res, {
  configured: dfsConfigured(), source: dfsSource(), login: dfsLoginMasked(),
}));

app.post('/api/dataforseo', wrap(async (req, res) => {
  const b = req.body || {};
  // Accept login/password (or email as an alias for login).
  if ('login' in b || 'email' in b || 'password' in b) {
    setDfs({ login: b.login ?? b.email, password: b.password });
  }
  // Validate against the account so the UI can confirm it works + show balance.
  let account = null, error = null;
  if (dfsConfigured()) {
    try { account = await validateDfs(); } catch (e) { error = e.message; }
  }
  ok(res, { configured: dfsConfigured(), source: dfsSource(), login: dfsLoginMasked(), account, error });
}));

// ── Semrush API key (keyword data, Google rankings, domain comparison) ─────────
app.get('/api/semrush', (req, res) => ok(res, {
  configured: semrushConfigured(), source: semrushSource(), key: semrushKeyMasked(),
}));

app.post('/api/semrush', wrap(async (req, res) => {
  const b = req.body || {};
  if ('key' in b || 'apikey' in b) setSemrush(b.key ?? b.apikey);
  let account = null, error = null;
  if (semrushConfigured()) {
    const v = await validateSemrush();
    if (v.ok) account = { ok: true }; else error = v.error;
  }
  ok(res, { configured: semrushConfigured(), source: semrushSource(), key: semrushKeyMasked(), account, error });
}));

// ── Demo data (no API keys needed) ─────────────────────────────────────────────
app.post('/api/demo', wrap(async (req, res) => {
  const { buildDemoProject } = await import('./src/demo.js');
  const project = await store.insertProject(buildDemoProject());
  ok(res, { project });
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

  // Heartbeat: a comment line every 15s keeps the SSE connection alive through
  // proxies/browsers during long runs (prevents mid-run "connection lost" errors).
  const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15_000);
  req.on('close', () => clearInterval(heartbeat));

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
    send('done', { summary, rec, runs, snapshots: project.snapshots || [] });
  } catch (e) {
    send('error', { error: e.message });
  }
  clearInterval(heartbeat);
  res.end();
});

// ── Google keyword rank tracking (DataForSEO) ─────────────────────────────────
// Stored results + suggested keyword set + config.
app.get('/api/projects/:id/ranks', wrap(async (req, res) => {
  const project = await store.getProject(req.params.id);
  if (!project) return fail(res, 404, 'not found');
  ok(res, {
    configured: dfsConfigured(),
    source: dfsSource(),
    login: dfsLoginMasked(),
    results: project.rankResults || null,
    snapshots: project.rankSnapshots || [],
    config: project.rankConfig || { location: 'United Kingdom', language: 'en' },
    trackedKeywords: project.trackedKeywords?.length ? project.trackedKeywords : defaultTrackedKeywords(project),
  });
}));

// Save the tracked-keyword set + location/language for a project.
app.put('/api/projects/:id/ranks/config', wrap(async (req, res) => {
  const project = await store.getProject(req.params.id);
  if (!project) return fail(res, 404, 'not found');
  const b = req.body || {};
  const kws = cleanList(b.keywords).slice(0, 100);
  const config = {
    location: (b.location || project.rankConfig?.location || 'United Kingdom').toString(),
    language: (b.language || project.rankConfig?.language || 'en').toString(),
  };
  await store.mutate(project.id, (p) => { p.trackedKeywords = kws; p.rankConfig = config; });
  ok(res, { trackedKeywords: kws, config });
}));

// Run a live rank check (SSE streaming progress).
app.get('/api/projects/:id/ranks/track', async (req, res) => {
  const project = await store.getProject(req.params.id);
  if (!project) return fail(res, 404, 'not found');
  if (!dfsConfigured()) return fail(res, 400, 'Add your DataForSEO login & password first (Rank tracking → settings).');

  const qKeywords = req.query.keywords ? String(req.query.keywords).split('\n').map((s) => s.trim()).filter(Boolean) : null;
  const keywords = qKeywords?.length ? qKeywords
    : (project.trackedKeywords?.length ? project.trackedKeywords : defaultTrackedKeywords(project));
  const location = req.query.location || project.rankConfig?.location;
  const language = req.query.language || project.rankConfig?.language;
  if (!keywords.length) return fail(res, 400, 'No keywords to track — add some on the Keywords tab.');

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15_000);
  req.on('close', () => clearInterval(heartbeat));
  send('start', { total: keywords.length, location, language });

  try {
    const rankResults = await trackRanks({
      project, keywords, location, language,
      onProgress: (done, total, batch) => send('progress', { done, total, batch }),
    });
    await store.mutate(project.id, (p) => {
      p.rankResults = rankResults;
      p.rankConfig = { location: rankResults.location, language: rankResults.language };
      p.trackedKeywords = keywords;
      p.rankSnapshots = p.rankSnapshots || [];
      p.rankSnapshots.push(snapshotOf(rankResults));
    });
    const fresh = await store.getProject(project.id);
    send('done', { results: rankResults, snapshots: fresh.rankSnapshots || [] });
  } catch (e) {
    send('error', { error: e.message });
  }
  clearInterval(heartbeat);
  res.end();
});

// ── Semrush: keyword data, rankings & domain comparison for a project ──────────
// Stored results so the UI (and reloads) don't re-spend API units.
app.get('/api/projects/:id/semrush', wrap(async (req, res) => {
  const project = await store.getProject(req.params.id);
  if (!project) return fail(res, 404, 'not found');
  ok(res, {
    configured: semrushConfigured(), source: semrushSource(), key: semrushKeyMasked(),
    keywords: project.semrushKeywords || null,
    related: project.semrushRelated || null,
    ranks: project.semrushRanks || null,
    compare: project.semrushCompare || null,
    unitCost: UNIT_COST,
  });
}));

// Enrich the project's tracked/mined keywords with Semrush volume, difficulty, CPC
// & intent (cost-capped by `limit`), and optionally pull related-keyword ideas.
app.post('/api/projects/:id/semrush/keywords', wrap(async (req, res) => {
  const project = await store.getProject(req.params.id);
  if (!project) return fail(res, 404, 'not found');
  if (!semrushConfigured()) return fail(res, 400, 'Add your Semrush API key first (Rank tracking → Semrush settings).');
  const b = req.body || {};
  const country = countryCode(b.country || project.rankConfig?.location || 'us');
  const limit = Math.min(Math.max(Number(b.limit) || 25, 1), 100);
  const source = cleanList(b.keywords);
  const keywords = source.length ? source
    : (project.trackedKeywords?.length ? project.trackedKeywords : defaultTrackedKeywords(project, limit));
  if (!keywords.length) return fail(res, 400, 'No keywords to enrich — mine keywords or add some first.');

  const metrics = await enrichKeywords(keywords, { country, limit });
  let related = null;
  if (b.related && keywords[0]) {
    try { related = await relatedKeywords(keywords[0], { country, limit: Math.min(Number(b.relatedLimit) || 20, 50) }); }
    catch (e) { related = { error: e.message }; }
  }
  const payload = { ts: new Date().toISOString(), country, ...metrics };
  await store.mutate(project.id, (p) => {
    p.semrushKeywords = payload;
    if (related && Array.isArray(related)) p.semrushRelated = { ts: payload.ts, country, seed: keywords[0], ideas: related };
  });
  ok(res, { keywords: payload, related });
}));

// A domain's Google organic rankings (keyword + position + volume + traffic).
app.post('/api/projects/:id/semrush/ranks', wrap(async (req, res) => {
  const project = await store.getProject(req.params.id);
  if (!project) return fail(res, 404, 'not found');
  if (!semrushConfigured()) return fail(res, 400, 'Add your Semrush API key first.');
  const domain = domainOf(req.body?.domain || project.brandDomain);
  if (!domain) return fail(res, 400, 'This project has no brand domain to rank — add one on the Website tab.');
  const country = countryCode(req.body?.country || project.rankConfig?.location || 'us');
  const limit = Math.min(Math.max(Number(req.body?.limit) || 50, 1), 500);
  const rows = await domainOrganic(domain, { country, limit });
  const payload = { ts: new Date().toISOString(), domain, country, rows, estUnits: rows.length * UNIT_COST.organic };
  await store.mutate(project.id, (p) => { p.semrushRanks = payload; });
  ok(res, { ranks: payload });
}));

// Compare the brand vs its competitors on organic visibility (cheap summaries).
app.post('/api/projects/:id/semrush/compare', wrap(async (req, res) => {
  const project = await store.getProject(req.params.id);
  if (!project) return fail(res, 404, 'not found');
  if (!semrushConfigured()) return fail(res, 400, 'Add your Semrush API key first.');
  const country = countryCode(req.body?.country || project.rankConfig?.location || 'us');
  const brand = domainOf(project.brandDomain);
  const comps = (project.competitors || []).map((c) => domainOf(c.domain)).filter(Boolean);
  const domains = [brand, ...comps].filter(Boolean);
  if (!domains.length) return fail(res, 400, 'Add a brand domain and competitors first (Website tab).');
  const { rows, charged, estUnits } = await compareDomains(domains, { country });
  // Mark which row is the brand for the UI.
  for (const r of rows) r.isBrand = !!brand && r.domain === brand;
  const payload = { ts: new Date().toISOString(), country, brand, rows, charged, estUnits };
  await store.mutate(project.id, (p) => { p.semrushCompare = payload; });
  ok(res, { compare: payload });
}));

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

const server = app.listen(PORT, () => {
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

// Don't crash with a raw stack trace if the port is already taken (the usual
// cause of a confusing "system error" — a previous instance is still running).
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  ✗ Port ${PORT} is already in use — JustPrompt is probably already running.`);
    console.error(`    Open http://localhost:${PORT}, or stop the other instance, or set a different PORT in .env.\n`);
    process.exit(1);
  }
  throw e;
});
