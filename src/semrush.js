// ─────────────────────────────────────────────────────────────────────────────
//  Semrush v4 API client — keyword data, Google rankings and domain comparison.
//
//  One token (a v4 "Apikey", prefix `semrtkn-pat-…`) authenticates every call via
//  the `Authorization: Apikey <token>` header. The classic Analytics API (?key=…)
//  does NOT accept this token — it is v4 only. Keys & permissions are managed at
//  https://www.semrush.com/accounts/api-keys/active and the account must have API
//  access on its plan + API units, or every call returns HTTP 403 Forbidden.
//
//  COST CONTROL (units are charged per call / per returned line):
//    • keyword metrics ...... 20 units / request  → 1 keyword per request, so we
//                             DEDUPE, CAP the count, and CACHE each result.
//    • related ideas ........ 40 units / line      → tight `limit`.
//    • domain organic ....... 10 units / line      → `limit` + field selection.
//    • domain summaries ..... 10 units / request   → the cheap way to COMPARE
//                             several domains (flat per domain, not per line).
//  We prefer the cheapest endpoint for each job, never auto-run, cache within a
//  TTL, and estimate the unit cost up front so the UI can warn before spending.
// ─────────────────────────────────────────────────────────────────────────────

import { getSemrush, semrushConfigured } from './config.js';

const BASE = 'https://api.semrush.com/apis/v4';
const TIMEOUT_MS = 30_000;
const CONCURRENCY = Number(process.env.SEMRUSH_CONCURRENCY) || 4;
// Keyword metrics barely move month-to-month, so a long cache is safe and cheap.
const CACHE_TTL_MS = Number(process.env.SEMRUSH_CACHE_TTL_MS) || 7 * 24 * 60 * 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Unit prices per endpoint (from the v4 docs) — used only to ESTIMATE cost for the UI.
export const UNIT_COST = { metrics: 20, related: 40, organic: 10, summary: 10 };

// ── Country mapping ───────────────────────────────────────────────────────────
// The app speaks location NAMES ("United Kingdom"); Semrush wants ISO alpha-2.
const COUNTRY_BY_NAME = {
  'united kingdom': 'gb', uk: 'gb', 'great britain': 'gb',
  'united states': 'us', usa: 'us', us: 'us', america: 'us',
  india: 'in', canada: 'ca', australia: 'au',
  'united arab emirates': 'ae', uae: 'ae', singapore: 'sg',
  germany: 'de', france: 'fr', spain: 'es',
};
export function countryCode(location) {
  if (!location) return 'us';
  const s = String(location).trim().toLowerCase();
  if (/^[a-z]{2}$/.test(s)) return s; // already an alpha-2 code
  return COUNTRY_BY_NAME[s] || 'us';
}

// ── Low-level request (Apikey auth, timeout, 429/5xx retry, clear errors) ──────
const cache = new Map(); // key → { ts, value }
function cacheKey(path, params) {
  const q = Object.entries(params).filter(([, v]) => v != null && v !== '').sort().map(([k, v]) => `${k}=${v}`).join('&');
  return `${path}?${q}`;
}

async function semGet(path, params = {}, { retries = 2, cache: useCache = true } = {}) {
  const key = cacheKey(path, params);
  if (useCache) {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return { data: hit.value, cached: true, cost: 0 };
  }
  const qs = Object.entries(params).filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const url = `${BASE}${path}${qs ? '?' + qs : ''}`;

  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { Authorization: `Apikey ${getSemrush()}`, Accept: 'application/json' }, signal: ctrl.signal });
      const txt = await res.text();
      let json; try { json = txt ? JSON.parse(txt) : {}; } catch { json = { _raw: txt }; }
      clearTimeout(timer);

      if (res.status === 429 && attempt < retries) { await sleep(Math.min(1500 * 2 ** attempt, 8000)); continue; }
      if (!res.ok || json?.meta?.success === false || json?.error) {
        throw new Error(semError(res.status, json));
      }
      const data = json.data ?? json;
      if (useCache) cache.set(key, { ts: Date.now(), value: data });
      return { data, cached: false, cost: json?.meta?.cost ?? null };
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') {
        if (attempt < retries) { await sleep(1000); continue; }
        throw new Error(`Semrush timed out after ${TIMEOUT_MS / 1000}s`);
      }
      // A 5xx is worth one more try; everything else (4xx) is final.
      if (/Semrush server error/.test(e.message) && attempt < retries) { await sleep(1000); continue; }
      throw e;
    }
  }
}

function semError(status, json) {
  const code = json?.error?.code || json?.meta?.status_code || status;
  const msg = json?.error?.message || json?.meta?.message || json?._raw || 'request failed';
  if (code === 401) return 'Semrush rejected the API key (401). Check the token in Rank tracking → Semrush settings.';
  if (code === 403) {
    return 'Semrush returned 403 Forbidden — the key is valid but this account/plan has no API access to these reports. '
      + 'Enable API access on your Semrush plan (Business tier + API units) and grant this key the Keyword/Domain Analytics '
      + 'products at semrush.com/accounts/api-keys/active, then retry.';
  }
  if (code === 429) return 'Semrush rate limit hit (429) — slow down and retry in a moment.';
  if (code >= 500) return `Semrush server error (${code}).`;
  return `Semrush: ${String(msg).slice(0, 200)} (${code})`;
}

// Pull the first present field from a row (v4 field names vary by report).
const pick = (o, names, d = null) => { for (const n of names) if (o && o[n] != null) return o[n]; return d; };
const asRows = (data) => (Array.isArray(data) ? data : data?.rows || data?.items || (data ? [data] : []));
const num = (v) => (v == null || v === '' ? null : Number(v));

// ── Validate the key (one cheap probe) ─────────────────────────────────────────
// There is no free balance endpoint, so we do the smallest real call and read the
// outcome. A 403 is reported verbatim so the UI can tell the user exactly what to fix.
export async function validateSemrush() {
  if (!semrushConfigured()) return { ok: false, error: 'No Semrush API key set.' };
  try {
    await semGet('/keywords/v1/metrics', { keyword: 'seo', country: 'us' }, { cache: false });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Keyword metrics (volume / difficulty / CPC / competition) ──────────────────
export async function keywordMetrics(keyword, country = 'us') {
  const { data, cached } = await semGet('/keywords/v1/metrics', { keyword, country });
  const row = asRows(data)[0] || {};
  return {
    phrase: keyword,
    volume: num(pick(row, ['search_volume', 'volume', 'Nq'])),
    difficulty: num(pick(row, ['keyword_difficulty', 'difficulty', 'Kd'])),
    cpc: num(pick(row, ['cpc', 'Cp'])),
    competition: num(pick(row, ['competitive_density', 'competition', 'Co'])),
    results: num(pick(row, ['number_of_results', 'results', 'Nr'])),
    intent: pick(row, ['intent', 'keyword_intent']),
    cached,
  };
}

// Enrich a list of keywords, cost-capped. Dedupes, caps to `limit`, caches each,
// runs with limited concurrency. Returns { keywords, charged, cached, estUnits }.
export async function enrichKeywords(keywords, { country = 'us', limit = 25, onProgress } = {}) {
  const clean = [...new Set((keywords || []).map((k) => String(k).trim().toLowerCase()).filter(Boolean))].slice(0, limit);
  if (!clean.length) return { keywords: [], charged: 0, cached: 0, estUnits: 0 };
  const out = new Array(clean.length);
  let next = 0, done = 0, charged = 0, cachedN = 0;
  async function worker() {
    while (next < clean.length) {
      const i = next++;
      try {
        const m = await keywordMetrics(clean[i], country);
        if (m.cached) cachedN++; else charged++;
        out[i] = m;
      } catch (e) {
        out[i] = { phrase: clean[i], error: e.message };
        // Auth/entitlement errors are fatal for the whole run — stop burning calls.
        if (/\b(401|403)\b/.test(e.message)) { next = clean.length; throw e; }
      }
      done++;
      if (onProgress) onProgress(done, clean.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, clean.length) }, worker));
  return { keywords: out.filter(Boolean), charged, cached: cachedN, estUnits: charged * UNIT_COST.metrics };
}

// ── Related keyword ideas (discovery → feeds better prompts) ───────────────────
export async function relatedKeywords(seed, { country = 'us', limit = 20 } = {}) {
  const { data } = await semGet('/keywords/v1/ideas/related', {
    keyword: seed, country, limit: Math.min(limit, 100), order_by: 'search_volume', direction: 'DESC',
  });
  return asRows(data).map((row) => ({
    phrase: pick(row, ['keyword', 'phrase', 'Ph']),
    volume: num(pick(row, ['search_volume', 'volume', 'Nq'])),
    difficulty: num(pick(row, ['keyword_difficulty', 'difficulty', 'Kd'])),
    cpc: num(pick(row, ['cpc', 'Cp'])),
    relevance: num(pick(row, ['relevance'])),
  })).filter((k) => k.phrase);
}

// ── A domain's Google organic rankings (keyword + position + volume + traffic) ──
export async function domainOrganic(domain, { country = 'us', limit = 50, device = 'DESKTOP' } = {}) {
  const { data } = await semGet('/domain-analytics/v1/organic-search/keywords/monthly', {
    url: domain, scope: 'ROOT_DOMAIN', country, device_type: device,
    fields: 'keyword,position,volume,cpc,traffic,url', limit,
  });
  return asRows(data).map((row) => ({
    keyword: pick(row, ['keyword', 'Ph']),
    position: num(pick(row, ['position', 'Po'])),
    volume: num(pick(row, ['volume', 'search_volume', 'Nq'])),
    cpc: num(pick(row, ['cpc', 'Cp'])),
    traffic: num(pick(row, ['traffic', 'Tr'])),
    url: pick(row, ['url', 'Ur']),
  })).filter((k) => k.keyword);
}

// ── Domain comparison (brand vs competitors) via the cheap summaries endpoint ──
export async function domainSummary(domain, { country = 'us', device = 'DESKTOP' } = {}) {
  const { data } = await semGet('/domain-analytics/v1/domain-summaries/monthly', {
    url: domain, scope: 'ROOT_DOMAIN', country, device_type: device,
    fields: 'rank,organic_traffic,organic_positions,organic_cost',
  });
  const row = asRows(data)[0] || {};
  return {
    domain,
    rank: num(pick(row, ['rank', 'Rk'])),
    traffic: num(pick(row, ['organic_traffic', 'traffic', 'Ot'])),
    positions: num(pick(row, ['organic_positions', 'positions', 'Or'])),
    cost: num(pick(row, ['organic_cost', 'cost', 'Oc'])),
  };
}

// Compare the brand against its competitors. Each domain is a flat 10-unit call,
// so N domains cost N×10 — cheap and predictable. Returns a ranked table.
export async function compareDomains(domains, { country = 'us', device = 'DESKTOP' } = {}) {
  const clean = [...new Set((domains || []).map((d) => String(d || '').trim().toLowerCase()).filter(Boolean))];
  const rows = [];
  let charged = 0;
  for (const d of clean) {
    try {
      const s = await domainSummary(d, { country, device });
      rows.push(s);
      charged++;
    } catch (e) {
      rows.push({ domain: d, error: e.message });
      if (/\b(401|403)\b/.test(e.message)) throw e; // fatal — stop spending
    }
  }
  // Rank by organic traffic (desc); unknowns sink to the bottom.
  rows.sort((a, b) => (b.traffic ?? -1) - (a.traffic ?? -1));
  return { rows, charged, estUnits: charged * UNIT_COST.summary };
}
