// ─────────────────────────────────────────────────────────────────────────────
//  Ghost browser engine — "real" ChatGPT + Google AI, scraped with a headless
//  (or headful) Chromium instead of an API. Optional and best-effort by design:
//  these sites bot-detect, change their markup, and may require a one-time login.
//  Every failure is returned as a normal engine error so a run never crashes.
//
//  Playwright is imported LAZILY so the app runs with zero extra deps until the
//  user actually turns this engine on.
//
//  Local-first: needs a real browser + (for ChatGPT) a logged-in session, so it
//  will not work on a headless cloud host. Run it on your own machine.
//    npm i playwright && npx playwright install chromium
// ─────────────────────────────────────────────────────────────────────────────

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = (k, d = '') => (process.env[k] || d).trim();

const PROFILE_DIR = env('GHOST_PROFILE_DIR', join(__dirname, '..', 'data', 'ghost-profile'));
const HEADLESS = env('GHOST_HEADLESS', '0') === '1';
const NAV_TIMEOUT = Number(env('GHOST_TIMEOUT_MS', '60000'));

let _ctx = null;        // persistent browser context (reused across calls)
let _ctxPromise = null; // in-flight launch
let _queue = Promise.resolve(); // serialize calls — one browser, one tab at a time

// Lazy, friendly Playwright load.
async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    throw new Error(
      'Headless browser engine needs Playwright. Install it once:  npm i playwright && npx playwright install chromium'
    );
  }
}

async function getContext() {
  if (_ctx) return _ctx;
  if (_ctxPromise) return _ctxPromise;
  _ctxPromise = (async () => {
    const { chromium } = await loadPlaywright();
    const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: HEADLESS,
      viewport: { width: 1280, height: 900 },
      locale: 'en-US',
      args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
    });
    ctx.setDefaultTimeout(NAV_TIMEOUT);
    ctx.on('close', () => { _ctx = null; });
    _ctx = ctx;
    _ctxPromise = null;
    return ctx;
  })();
  return _ctxPromise;
}

export async function closeGhost() {
  try { await _ctx?.close(); } catch {}
  _ctx = null;
}

// Public entry — serialized so parallel prompts queue through one browser.
export function ghostChat({ target, prompt }) {
  const run = _queue.then(() => scrape({ target, prompt }));
  // keep the chain alive even if this call rejects
  _queue = run.catch(() => {});
  return run;
}

async function scrape({ target, prompt }) {
  const ctx = await getContext();
  const page = await ctx.newPage();
  try {
    if (target === 'google') return await scrapeGoogle(page, prompt);
    return await scrapeChatGPT(page, prompt);
  } finally {
    try { await page.close(); } catch {}
  }
}

// ── ChatGPT (chatgpt.com) ────────────────────────────────────────────────────
async function scrapeChatGPT(page, prompt) {
  await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' });

  // Composer selectors drift; try the known ones.
  const composerSel = '#prompt-textarea, textarea[data-virtualkeyboard], div[contenteditable="true"]';
  const composer = await page.waitForSelector(composerSel, { timeout: 15000 }).catch(() => null);

  if (!composer) {
    const needsLogin = /\/auth|login/i.test(page.url()) ||
      await page.getByRole('link', { name: /log ?in/i }).first().isVisible().catch(() => false);
    if (needsLogin) {
      throw new Error('ChatGPT needs a login. Run with GHOST_HEADLESS=0, sign in once in the window that opens, then re-run — the session is remembered.');
    }
    throw new Error('ChatGPT composer not found (the page markup may have changed).');
  }

  await composer.click();
  await page.keyboard.type(prompt, { delay: 8 });
  await page.keyboard.press('Enter');

  // Wait until generation stops: the "Stop" button appears then disappears, and
  // the last assistant message text stabilises.
  const answerSel = 'div[data-message-author-role="assistant"]';
  await page.waitForSelector(answerSel, { timeout: NAV_TIMEOUT }).catch(() => null);

  let last = '', stable = 0;
  const deadline = Date.now() + NAV_TIMEOUT;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1200);
    const txt = await page.$$eval(answerSel, (els) => (els.at(-1)?.innerText || '').trim()).catch(() => '');
    const generating = await page.getByTestId('stop-button').isVisible().catch(() => false) ||
      await page.getByRole('button', { name: /stop/i }).first().isVisible().catch(() => false);
    if (txt && txt === last && !generating) { if (++stable >= 2) break; } else stable = 0;
    last = txt;
  }
  if (!last) throw new Error('ChatGPT returned no answer (timed out while generating).');

  const citations = await page.$$eval(
    `${answerSel}:last-of-type a[href^="http"]`,
    (as) => as.map((a) => ({ url: a.href, title: (a.textContent || '').trim() }))
  ).catch(() => []);

  return { text: last, citations: dedupeCitations(citations), provider: 'ghost', model: 'chatgpt-web' };
}

// ── Google (AI Overview + top results) ───────────────────────────────────────
async function scrapeGoogle(page, prompt) {
  const url = `https://www.google.com/search?q=${encodeURIComponent(prompt)}&hl=en&gl=us`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  // EU consent wall.
  const consent = page.getByRole('button', { name: /accept all|i agree|accept/i }).first();
  if (await consent.isVisible().catch(() => false)) { await consent.click().catch(() => {}); await page.waitForTimeout(800); }

  // CAPTCHA / "unusual traffic" wall.
  if (/sorry\/index|unusual traffic/i.test(page.url()) || await page.locator('form#captcha-form').isVisible().catch(() => false)) {
    throw new Error('Google served a CAPTCHA. Run with GHOST_HEADLESS=0 and solve it once, then re-run.');
  }

  await page.waitForTimeout(1500);

  // Best-effort: expand the AI Overview if a "Show more" is present.
  const showMore = page.getByRole('button', { name: /show more/i }).first();
  if (await showMore.isVisible().catch(() => false)) { await showMore.click().catch(() => {}); await page.waitForTimeout(800); }

  // Try to read an AI Overview block; selectors are unstable so we probe several,
  // then fall back to concatenating the top organic result snippets.
  const scraped = await page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    let overview = '';
    const probes = ['div[data-attrid="SGE"]', 'div[aria-label*="AI Overview" i]', 'div[jsname][data-rl]', '#rso [data-hveid] [role="heading"]'];
    for (const sel of probes) {
      const el = document.querySelector(sel);
      if (el && clean(el.innerText).length > 120) { overview = clean(el.innerText); break; }
    }
    // Organic results — titles, links, snippets.
    const results = [];
    for (const r of document.querySelectorAll('#search a h3, #rso a h3')) {
      const a = r.closest('a');
      const block = r.closest('[data-hveid], .g') || a?.parentElement;
      const snippet = block ? clean(block.querySelector('[data-sncf], .VwiC3b, [style*="line-clamp"]')?.innerText || '') : '';
      if (a?.href) results.push({ title: clean(r.innerText), url: a.href, snippet });
      if (results.length >= 8) break;
    }
    return { overview, results };
  });

  const results = (scraped.results || []).filter((r) => /^https?:/.test(r.url) && !/google\.com/.test(r.url));
  let text = scraped.overview;
  if (!text) {
    if (!results.length) throw new Error('Google returned no readable results (layout may have changed or a wall was shown).');
    text = 'Top Google results for this query:\n\n' +
      results.map((r, i) => `${i + 1}. ${r.title}${r.snippet ? ` — ${r.snippet}` : ''}`).join('\n');
  }
  const citations = dedupeCitations(results.map((r) => ({ url: r.url, title: r.title })));
  return { text, citations, provider: 'ghost', model: 'google-ai' };
}

function dedupeCitations(list) {
  const seen = new Set();
  const out = [];
  for (const c of list || []) {
    if (!c?.url || seen.has(c.url)) continue;
    seen.add(c.url);
    out.push({ url: c.url, title: c.title || '' });
  }
  return out.slice(0, 12);
}
