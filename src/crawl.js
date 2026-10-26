// Crawl & ingest. Fetches pages server-side (no browser CORS limits), pulls out
// title / meta / headings / body text / internal links, and derives a free
// heuristic keyword set (tf-weighted n-grams, headings boosted).
// crawlSite() walks the WHOLE site (internal links + sitemap, same domain).

import * as cheerio from 'cheerio';

const UA = 'Mozilla/5.0 (compatible; JustPromptBot/0.1; +https://localhost)';
const MAX_BYTES = 1_500_000;
const ASSET_RE = /\.(jpg|jpeg|png|gif|webp|svg|ico|css|js|mjs|json|pdf|zip|mp4|mp3|woff2?|ttf|eot|xml|rss)(\?|$)/i;

export function normalizeUrl(input) {
  let u = (input || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try { return new URL(u).toString(); } catch { return ''; }
}

export function domainOf(input) {
  try { return new URL(normalizeUrl(input)).hostname.replace(/^www\./, ''); } catch { return ''; }
}

// Dedupe key: host + pathname (ignore query/hash) to avoid crawler traps.
function canonicalKey(url) {
  try { const u = new URL(url); return u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/$/, ''); }
  catch { return url; }
}

// "justwords.co.uk" -> "Justwords"
export function brandFromDomain(input) {
  const host = domainOf(input);
  if (!host) return '';
  const core = host.split('.')[0];
  return core.charAt(0).toUpperCase() + core.slice(1);
}

async function fetchText(url, timeout = 20_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    const ctype = res.headers.get('content-type') || '';
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (ctype && !/html|xml|text/.test(ctype)) throw new Error(`skipped ${ctype.split(';')[0]}`);
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      chunks.push(value);
      if (size > MAX_BYTES) { ctrl.abort(); break; }
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchPage(url) {
  const norm = normalizeUrl(url);
  if (!norm) return { url, ok: false, error: 'invalid URL' };
  try {
    const html = await fetchText(norm);
    const $ = cheerio.load(html);

    // Collect internal links BEFORE stripping nav/footer (menus live there).
    const dom = domainOf(norm);
    const links = [];
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href || /^(mailto:|tel:|javascript:|#)/i.test(href)) return;
      let abs;
      try { abs = new URL(href, norm).toString(); } catch { return; }
      if (!/^https?:/i.test(abs)) return;
      if (domainOf(abs) !== dom) return;
      if (ASSET_RE.test(abs)) return;
      links.push(abs.split('#')[0]);
    });

    const title = ($('title').first().text() || '').trim();
    const description = ($('meta[name="description"]').attr('content') || '').trim();
    const keywordsMeta = ($('meta[name="keywords"]').attr('content') || '').trim();

    $('script, style, noscript, svg, nav, footer, header, form').remove();
    // Insert a space after every element so adjacent styled words don't merge
    // ("<span>for</span><span>agency</span>" must read "for agency", not "foragency").
    $('body *').each((_, el) => $(el).append(' '));

    const headings = $('h1, h2, h3').map((_, el) => $(el).text().replace(/\s+/g, ' ').trim()).get().filter(Boolean).slice(0, 60);
    const text = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 14_000);
    return { url: norm, ok: true, title, description, keywordsMeta, headings, text, links: [...new Set(links)], chars: text.length };
  } catch (e) {
    return { url: norm, ok: false, error: e.message };
  }
}

// Pull URLs out of /sitemap.xml for a domain (best effort, follows one level of index).
export async function discoverFromSitemap(domain, max = 500) {
  const base = `https://${domainOf(domain)}`;
  const found = new Set();
  const read = async (path) => {
    try {
      const xml = await fetchText(base + path, 15_000);
      const locs = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => m[1].trim());
      const sitemaps = locs.filter((u) => /sitemap.*\.xml/i.test(u));
      for (const u of locs) if (!/\.xml$/i.test(u) && !ASSET_RE.test(u)) found.add(u);
      // follow nested sitemaps (index files)
      for (const sm of sitemaps.slice(0, 5)) {
        if (found.size >= max) break;
        try {
          const nested = await fetchText(sm, 15_000);
          for (const m of nested.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)) {
            const u = m[1].trim();
            if (!/\.xml$/i.test(u) && !ASSET_RE.test(u)) found.add(u);
          }
        } catch { /* ignore */ }
      }
    } catch { /* try next */ }
  };
  await read('/sitemap.xml');
  if (found.size < 5) await read('/sitemap_index.xml');
  return [...found].slice(0, max);
}

// Crawl the whole site: BFS over internal links, seeded by the sitemap.
export async function crawlSite(startUrl, { maxPages = 150, concurrency = 5, onProgress } = {}) {
  const start = normalizeUrl(startUrl);
  if (!start) return [];
  const dom = domainOf(start);
  const seen = new Set();
  const queue = [];
  const enqueue = (u) => {
    const n = (u || '').split('#')[0];
    if (!n || domainOf(n) !== dom || ASSET_RE.test(n)) return;
    const key = canonicalKey(n);
    if (seen.has(key)) return;
    seen.add(key);
    queue.push(n);
  };
  enqueue(start);
  try { (await discoverFromSitemap(start, maxPages)).forEach(enqueue); } catch { /* ignore */ }

  const results = [];
  while (queue.length && results.length < maxPages) {
    const room = maxPages - results.length;
    const batch = queue.splice(0, Math.min(concurrency, room));
    const pages = await Promise.all(batch.map(fetchPage));
    for (const pg of pages) {
      results.push(pg);
      if (pg.ok) for (const l of pg.links || []) enqueue(l);
    }
    if (onProgress) onProgress({ crawled: results.length, queued: queue.length, max: maxPages });
  }
  return results;
}

// ── Heuristic keyword extraction (free, no API) ──────────────────────────────
const STOP = new Set(('a about above after again against all am an and any are aren\'t as at be because been before being below between both but by can\'t cannot could couldn\'t did didn\'t do does doesn\'t doing don\'t down during each few for from further had hadn\'t has hasn\'t have haven\'t having he he\'d he\'ll he\'s her here here\'s hers herself him himself his how how\'s i i\'d i\'ll i\'m i\'ve if in into is isn\'t it it\'s its itself let\'s me more most mustn\'t my myself no nor not of off on once only or other ought our ours ourselves out over own same shan\'t she she\'d she\'ll she\'s should shouldn\'t so some such than that that\'s the their theirs them themselves then there there\'s these they they\'d they\'ll they\'re they\'ve this those through to too under until up very was wasn\'t we we\'d we\'ll we\'re we\'ve were weren\'t what what\'s when when\'s where where\'s which while who who\'s whom why why\'s with won\'t would wouldn\'t you you\'d you\'ll you\'re you\'ve your yours yourself yourselves get got also just like one two use using used may might new see learn read more home page click here contact privacy cookie cookies terms toggle menu skip navigation search').split(' '));

function tokenize(s) {
  return (s.toLowerCase().match(/[a-z][a-z0-9'+-]{1,}/g) || []).filter((w) => !STOP.has(w) && w.length > 2);
}

// Extract keywords across all pages. limit = 0 means "all".
export function extractKeywords(pages, limit = 0) {
  const ok = pages.filter((p) => p.ok);
  const score = new Map();
  const pagesWith = new Map(); // phrase -> number of pages it appears on (for prominence)
  const add = (phrase, weight, pageIdx) => {
    const key = phrase.trim();
    if (!key || key.length < 4) return;
    score.set(key, (score.get(key) || 0) + weight);
    if (!pagesWith.has(key)) pagesWith.set(key, new Set());
    pagesWith.get(key).add(pageIdx);
  };
  ok.forEach((p, idx) => {
    // explicit meta keywords are gold
    for (const k of (p.keywordsMeta || '').split(',').map((s) => s.trim()).filter(Boolean)) add(k.toLowerCase(), 6, idx);
    // headings & title carry intent — weight heavily
    for (const h of [p.title, ...(p.headings || [])]) {
      const toks = tokenize(h);
      for (let n = 1; n <= 3; n++) for (let i = 0; i + n <= toks.length; i++) add(toks.slice(i, i + n).join(' '), 4 * n, idx);
    }
    // body 2-3 grams
    const toks = tokenize(p.text || '');
    for (let n = 2; n <= 3; n++) for (let i = 0; i + n <= toks.length; i++) add(toks.slice(i, i + n).join(' '), 1, idx);
    // salient unigrams by frequency
    const freq = new Map();
    for (const t of toks) freq.set(t, (freq.get(t) || 0) + 1);
    for (const [t, f] of freq) if (f >= 3) add(t, Math.min(f, 8), idx);
  });
  const list = [...score.entries()]
    .map(([phrase, s]) => ({ phrase, score: s, pages: pagesWith.get(phrase)?.size || 1 }))
    // Cut the single-occurrence body-ngram noise; keep terms that recur or come
    // from titles/headings/meta (higher weight).
    .filter((k) => k.score >= 3 || k.pages >= 2)
    .sort((a, b) => b.score - a.score || b.pages - a.pages);
  return limit > 0 ? list.slice(0, limit) : list;
}
