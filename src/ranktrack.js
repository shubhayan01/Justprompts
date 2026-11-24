// ─────────────────────────────────────────────────────────────────────────────
//  Google keyword rank tracking via the DataForSEO SERP API.
//
//  For each tracked keyword we ask DataForSEO for a live Google SERP, find where
//  the brand's domain appears in the organic results, and (for context) which
//  competitor outranks it. Results are scored into a small summary + a history
//  snapshot so the dashboard can show position, movement and a trend over time.
//
//  Auth is HTTP Basic (login:password) — DataForSEO does NOT use a single token.
//  Credentials come from the env (.env) or are set at runtime from the UI.
//
//  NOTE on domains: Google now returns redirect URLs (google.com/goto?url=…) for
//  organic results, so the item's `url`/`domain` fields read as "google.com".
//  The REAL publisher domain is in the `breadcrumb` field — we parse it from there.
// ─────────────────────────────────────────────────────────────────────────────

import { getDfs, dfsConfigured } from './config.js';
import { domainOf } from './crawl.js';

const BASE = 'https://api.dataforseo.com';
const TIMEOUT_MS = 60_000;
// Many DataForSEO plans only accept ONE task per request ("You can set only one
// task at a time"), so we send one keyword per request and run several in parallel.
const CONCURRENCY = Number(process.env.DATAFORSEO_CONCURRENCY) || 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function authHeader() {
  const { login, password } = getDfs();
  return 'Basic ' + Buffer.from(`${login}:${password}`).toString('base64');
}

async function dfsPost(path, body, { timeout = TIMEOUT_MS, retries = 2 } = {}) {
  const url = BASE + path;
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: authHeader() },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const txt = await res.text();
      let json; try { json = txt ? JSON.parse(txt) : {}; } catch { json = { _raw: txt }; }
      if (!res.ok || (json.status_code && json.status_code >= 40000)) {
        if ((res.status === 429 || res.status === 502 || res.status === 503) && attempt < retries) {
          clearTimeout(timer); await sleep(Math.min(1500 * 2 ** attempt, 8000)); continue;
        }
        const msg = json.status_message || json._raw || res.statusText;
        if (res.status === 401 || json.status_code === 40100) {
          throw new Error('DataForSEO rejected the login/password (401). Check your credentials in Rank tracking → settings.');
        }
        throw new Error(`DataForSEO: ${String(msg).slice(0, 200)}`);
      }
      return json;
    } catch (e) {
      if (e.name === 'AbortError') {
        if (attempt < retries) { clearTimeout(timer); await sleep(1000); continue; }
        throw new Error(`DataForSEO timed out after ${timeout / 1000}s`);
      }
      throw e;
    } finally { clearTimeout(timer); }
  }
}

async function dfsGet(path, { timeout = 25_000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(BASE + path, { headers: { Authorization: authHeader() }, signal: ctrl.signal });
    const json = await res.json();
    if (json.status_code === 40100 || res.status === 401) throw new Error('Invalid DataForSEO login or password.');
    if (json.status_code >= 40000) throw new Error(json.status_message || 'DataForSEO error');
    return json;
  } finally { clearTimeout(timer); }
}

// Validate credentials and report the account balance (used when saving keys).
export async function validateDfs() {
  if (!dfsConfigured()) return { ok: false, error: 'No DataForSEO login/password set.' };
  const json = await dfsGet('/v3/appendix/user_data');
  const r = json?.tasks?.[0]?.result?.[0] || {};
  const money = r.money || {};
  return { ok: true, login: r.login || '', balance: money.balance ?? null, currency: money.currency || 'USD' };
}

// ── Domain parsing ────────────────────────────────────────────────────────────
function hostOf(s) {
  if (!s) return '';
  try { return new URL(/^https?:/i.test(s) ? s : 'https://' + s).hostname.replace(/^www\./, '').toLowerCase(); }
  catch { return ''; }
}

// The true publisher domain of an organic result (works around Google's redirect URLs).
function itemDomain(item) {
  const bc = (item.breadcrumb || '').trim();
  if (bc) {
    const first = bc.split(/[\s›>|]/).filter(Boolean)[0] || '';
    const h = hostOf(first);
    if (h && h !== 'google.com') return h;
  }
  const h = hostOf(item.url || '');
  if (h && h !== 'google.com') return h;
  return '';
}

// A clean, human-readable URL/path for a result. Google obfuscates `url` as a
// redirect, so prefer the real `url` only when it's not a google.com/goto link,
// otherwise rebuild a readable path from the breadcrumb ("justwords.in › blog › …").
function displayUrlFor(item, dom) {
  const u = item.url || '';
  if (u && !/google\.com\/goto/i.test(u)) return u;
  const bc = (item.breadcrumb || '').replace(/\s*›\s*/g, '/').replace(/^https?:\/\//, '').replace(/^www\./, '');
  return bc || dom;
}

// Does a result domain belong to a target domain (exact or subdomain)?
function domainMatches(resultDomain, target) {
  if (!resultDomain || !target) return false;
  return resultDomain === target || resultDomain.endsWith('.' + target) || target.endsWith('.' + resultDomain);
}

// ── Core: check one keyword's SERP for the brand (and competitors) ─────────────
function analyzeSerp(result, brandDomain, competitors) {
  const items = (result?.items || []).filter((it) => it.type === 'organic');
  let brand = null;
  const compHits = [];
  for (const it of items) {
    const dom = itemDomain(it);
    if (!dom) continue;
    const pos = it.rank_group;                 // organic position (1-based, excludes ads/features)
    if (!brand && domainMatches(dom, brandDomain)) {
      brand = { position: pos, rankAbsolute: it.rank_absolute, url: it.url, title: it.title || '', domain: dom, displayUrl: displayUrlFor(it, dom) };
    }
    for (const c of competitors) {
      if (c.domain && domainMatches(dom, c.domain) && !compHits.some((x) => x.name === c.name)) {
        compHits.push({ name: c.name, domain: c.domain, position: pos });
      }
    }
  }
  const topCompetitor = compHits.sort((a, b) => a.position - b.position)[0] || null;
  // SERP features present (useful context for the boss: "you're below an AI Overview").
  const features = [...new Set((result?.items || []).map((it) => it.type).filter((t) => t && t !== 'organic'))];
  return {
    found: !!brand,
    position: brand ? brand.position : null,
    url: brand ? brand.url : '',
    displayUrl: brand ? brand.displayUrl : '',
    title: brand ? brand.title : '',
    topCompetitor,
    features,
    resultsCount: result?.se_results_count ?? null,
  };
}

// Check ONE keyword's Google SERP. Returns { result, cost }.
async function trackOne(keyword, { brandDomain, competitors, locationName, languageCode }) {
  const task = { keyword, location_name: locationName, language_code: languageCode, depth: 100, device: 'desktop' };
  let json;
  try {
    json = await dfsPost('/v3/serp/google/organic/live/advanced', [task]);
  } catch (e) {
    return { result: { keyword, found: false, position: null, error: e.message, features: [], topCompetitor: null }, cost: 0 };
  }
  const t = (json.tasks || [])[0] || {};
  const r = (t.result || [])[0];
  const cost = json.cost || t.cost || 0;
  // DataForSEO can return a warning status (e.g. "partial results") while still
  // delivering usable SERP items — parse whenever items are present.
  if (r && Array.isArray(r.items)) {
    const a = analyzeSerp(r, brandDomain, competitors);
    if (t.status_code >= 40000) a.warning = t.status_message;
    return { result: { keyword, ...a }, cost };
  }
  return { result: { keyword, found: false, position: null, error: t.status_message || 'no result', features: [], topCompetitor: null }, cost };
}

// Run an async worker over items with a fixed concurrency; calls onDone(result,i)
// as each finishes (order of completion).
async function pool(items, concurrency, worker, onDone) {
  let next = 0, done = 0;
  const results = new Array(items.length);
  async function run() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
      done++;
      if (onDone) onDone(results[i], done);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

// ── Public: run a full rank-tracking pass over the project's tracked keywords ──
export async function trackRanks({ project, keywords, location, language, onProgress }) {
  if (!dfsConfigured()) throw new Error('Add your DataForSEO login & password in Rank tracking → settings first.');
  const brandDomain = domainOf(project.brandDomain);
  if (!brandDomain) throw new Error('This project has no brand website/domain to rank — add one on the Website tab.');
  const competitors = (project.competitors || []).map((c) => ({ name: c.name, domain: domainOf(c.domain) })).filter((c) => c.domain);
  const locationName = location || project.rankConfig?.location || 'United Kingdom';
  const languageCode = language || project.rankConfig?.language || 'en';

  const clean = [...new Set(keywords.map((k) => String(k).trim()).filter(Boolean))];
  if (!clean.length) throw new Error('No keywords to track. Add keywords on the Keywords tab first.');

  const prev = indexPrev(project.rankResults);
  let totalCost = 0;
  const opts = { brandDomain, competitors, locationName, languageCode };
  const results = await pool(clean, CONCURRENCY,
    async (kw) => {
      const { result, cost } = await trackOne(kw, opts);
      totalCost += cost;
      result.prevPosition = prev.get(result.keyword) ?? null;
      result.change = (result.position != null && result.prevPosition != null) ? result.prevPosition - result.position : null; // + = improved
      return result;
    },
    (r, done) => { if (onProgress) onProgress(done, clean.length, [r]); },
  );

  // Preserve the input keyword order.
  const byKw = new Map(results.map((r) => [r.keyword, r]));
  const all = clean.map((kw) => byKw.get(kw));
  const summary = summarize(all);
  const ts = new Date().toISOString();
  const rankResults = {
    ts, location: locationName, language: languageCode, brandDomain,
    cost: Math.round(totalCost * 10000) / 10000,
    keywords: all, summary,
  };
  return rankResults;
}

function indexPrev(prevResults) {
  const m = new Map();
  for (const k of (prevResults?.keywords || [])) if (k.position != null) m.set(k.keyword, k.position);
  return m;
}

export function summarize(keywords) {
  const found = keywords.filter((k) => k.position != null);
  const positions = found.map((k) => k.position);
  const avg = positions.length ? Math.round((positions.reduce((a, b) => a + b, 0) / positions.length) * 10) / 10 : null;
  const top3 = positions.filter((p) => p <= 3).length;
  const top10 = positions.filter((p) => p <= 10).length;
  const top20 = positions.filter((p) => p <= 20).length;
  // Visibility: share-of-click-weighted score (top positions count more). 0–100.
  const CTR = { 1: 0.32, 2: 0.17, 3: 0.11, 4: 0.08, 5: 0.06, 6: 0.05, 7: 0.04, 8: 0.03, 9: 0.025, 10: 0.02 };
  const visibility = keywords.length
    ? Math.round((positions.reduce((s, p) => s + (CTR[p] || (p <= 20 ? 0.01 : 0)), 0) / keywords.length) * 100 * 10) / 10
    : 0;
  const improved = keywords.filter((k) => k.change != null && k.change > 0).length;
  const declined = keywords.filter((k) => k.change != null && k.change < 0).length;
  return { tracked: keywords.length, found: found.length, top3, top10, top20, avgPosition: avg, visibility, improved, declined };
}

// A compact snapshot for the trend chart / history.
export function snapshotOf(rankResults) {
  const s = rankResults.summary;
  return { ts: rankResults.ts, tracked: s.tracked, found: s.found, top3: s.top3, top10: s.top10, avgPosition: s.avgPosition, visibility: s.visibility };
}

// Default keyword set for a project: the AI-extracted phrases (fallback to raw).
export function defaultTrackedKeywords(project, limit = 25) {
  const clean = (project.keywords || []).map((k) => k.phrase).filter(Boolean);
  const raw = (project.rawKeywords || []).map((k) => k.phrase).filter(Boolean);
  const list = clean.length ? clean : raw;
  return [...new Set(list)].slice(0, limit);
}
