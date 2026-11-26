// JustPrompt front-end — simple linear flow: scan → keywords → prompts → ranking.
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const state = { projects: [], project: null, health: null, selectedEngines: new Set() };

// ── Tabs — show one section at a time, auto-advance, no long scrolling ────────
const TAB_ORDER = ['setup', 'website', 'keywords', 'ranks', 'prompts', 'results'];
function showTab(name) {
  if (!TAB_ORDER.includes(name)) return;
  $$('#tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tabpanel').forEach((p) => p.classList.toggle('active', p.dataset.tab === name));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function currentTab() { return $('#tabs .tab.active')?.dataset.tab || 'setup'; }
// Mark which tabs have data (green dot); does NOT change the active tab.
function updateStepper() {
  const p = state.project || {};
  const ready = {
    keywords: !!((p.keywords && p.keywords.length) || (p.rawKeywords && p.rawKeywords.length)),
    ranks: !!(p.rankResults && p.rankResults.keywords && p.rankResults.keywords.length),
    prompts: !!(p.prompts && p.prompts.length),
    results: !!p.lastSummary,
  };
  $$('#tabs .tab').forEach((t) => {
    if (t.dataset.tab in ready) t.classList.toggle('ready', ready[t.dataset.tab]);
  });
}
// The furthest tab that has data — where to land when opening a project.
function furthestTab() {
  const p = state.project || {};
  if (p.lastSummary) return 'results';
  if (p.prompts && p.prompts.length) return 'prompts';
  if ((p.keywords && p.keywords.length) || (p.rawKeywords && p.rawKeywords.length)) return 'keywords';
  return 'website';
}

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'request failed');
  return data;
}

// ── API keys (saved in this browser, sent to the server) ──────────────────────
const KEY_FIELDS = ['groq', 'gemini', 'openrouter', 'openai', 'anthropic', 'perplexity'];

function readStoredKeys() {
  try { return JSON.parse(localStorage.getItem('jp_keys') || '{}'); } catch { return {}; }
}
function fillKeyInputs() {
  const stored = readStoredKeys();
  for (const f of KEY_FIELDS) { const el = $('#key_' + f); if (el) el.value = stored[f] || ''; }
}
async function pushStoredKeys() {
  const stored = readStoredKeys();
  if (Object.values(stored).some(Boolean)) {
    try { await api('/api/keys', { method: 'POST', body: JSON.stringify(stored) }); } catch { /* ignore */ }
  }
}
async function saveKeys() {
  const keys = {};
  for (const f of KEY_FIELDS) { const v = ($('#key_' + f)?.value || '').trim(); if (v) keys[f] = v; }
  try { localStorage.setItem('jp_keys', JSON.stringify(keys)); } catch {}
  $('#keysStatus').innerHTML = '<span class="spin"></span> saving…';
  try {
    await api('/api/keys', { method: 'POST', body: JSON.stringify(keys) });
    await loadHealth();
    $('#keysStatus').textContent = 'saved ✓';
  } catch (e) { $('#keysStatus').innerHTML = `<span class="no">${esc(e.message)}</span>`; }
}
async function clearKeys() {
  try { localStorage.removeItem('jp_keys'); } catch {}
  for (const f of KEY_FIELDS) { const el = $('#key_' + f); if (el) el.value = ''; }
  try { await api('/api/keys', { method: 'POST', body: JSON.stringify(Object.fromEntries(KEY_FIELDS.map((f) => [f, '']))) }); } catch {}
  await loadHealth();
  $('#keysStatus').textContent = 'cleared';
}

// ── Demo data ─────────────────────────────────────────────────────────────────
async function loadDemo() {
  $('#demoBtn').disabled = true;
  $('#demoStatus').innerHTML = '<span class="spin"></span> building 8 weeks of demo data…';
  try {
    const { project } = await api('/api/demo', { method: 'POST', body: '{}' });
    $('#demoStatus').textContent = 'loaded ✓';
    await loadRecent();
    await openProject(project.id);
    showTab('ranks');
  } catch (e) { $('#demoStatus').innerHTML = `<span class="no">${esc(e.message)}</span>`; }
  $('#demoBtn').disabled = false;
}

// ── Ghost (headless browser) engine toggle ────────────────────────────────────
function ghostStored() { try { return localStorage.getItem('jp_ghost') === '1'; } catch { return false; } }
async function pushGhost(on) {
  try { await api('/api/ghost', { method: 'POST', body: JSON.stringify({ enabled: !!on }) }); } catch { /* ignore */ }
}
async function onGhostToggle() {
  const on = $('#ghostToggle').checked;
  try { localStorage.setItem('jp_ghost', on ? '1' : '0'); } catch {}
  $('#ghostHint').classList.toggle('hidden', !on);
  await pushGhost(on);
  await loadHealth();
}

// ── Keys / engines ───────────────────────────────────────────────────────────
async function loadHealth() {
  state.health = await api(`/api/health?preferFree=${$('#preferFree').checked}`);
  const h = state.health;
  $('#engineStatus').innerHTML = h.engines.map((e) => {
    const b = e.binding;
    const badges = b ? `${b.free ? '<span class="badge free">free</span>' : '<span class="badge paid">paid</span>'}${b.live ? '<span class="badge live">live</span>' : ''}` : '<span class="badge">no key</span>';
    const tip = b ? `${e.note}\nmodel: ${b.resolvedModel || b.model}${b.remapped ? ' (auto-picked — your key lacks ' + b.model + ')' : ''}` : (e.note + '\n' + (e.hint || ''));
    return `<span class="eng ${e.enabled ? 'on' : 'off'}" title="${esc(tip)}"><span class="dot"></span>${esc(e.label)} ${badges}</span>`;
  }).join('');
  if (!h.anyKey) {
    $('#keyHint').innerHTML = `<div class="hint"><b>Ranking needs one API key.</b> Scanning + keywords work without one. Add a <b>free</b> key below (🔑 Add / manage API keys) — <a href="https://console.groq.com/keys" target="_blank">Groq</a> is the quickest. No restart needed.</div>`;
  } else {
    const live = h.engines.filter((e) => e.enabled && e.binding?.live).map((e) => e.label);
    const active = Object.entries(h.keys || {}).filter(([, v]) => v).map(([k, v]) => `${k.replace('_API_KEY', '').toLowerCase()} (${v})`);
    $('#keyHint').innerHTML = `<p class="muted small" style="margin-top:6px">Analysis: <b>${h.analysis ? esc(h.analysis.provider + '/' + h.analysis.model) : 'heuristics'}</b>${live.length ? ` · live-web: <b>${live.map(esc).join(', ')}</b>` : ''}${active.length ? ` · keys: ${active.map(esc).join(', ')}` : ''}</p>`;
  }
  renderTrackEngines();
}

// ── Recent projects ────────────────────────────────────────────────────────────
async function loadRecent() {
  const { projects } = await api('/api/projects');
  state.projects = projects;
  if (!projects.length) { $('#recent').innerHTML = ''; return; }
  $('#recent').innerHTML = '<span class="muted small" style="width:100%">Recent:</span>' + projects.map((p) =>
    `<div class="proj ${state.project?.id === p.id ? 'active' : ''}" data-id="${p.id}"><b>${esc(p.brandName || p.name)}</b><small>${p.runs} runs · ${p.prompts} prompts</small></div>`).join('');
  $$('#recent .proj').forEach((el) => el.onclick = () => openProject(el.dataset.id));
}

async function openProject(id) {
  const { project } = await api(`/api/projects/${id}`);
  state.project = project;
  $('#siteUrl').value = project.brandDomain || '';
  $('#brandName').value = project.brandName || '';
  $('#brandAliases').value = (project.brandAliases || []).join(', ');
  renderCompetitors(project.competitors || []);
  if ((project.rawKeywords || []).length) { renderKeywords(); $('#kwCard').classList.remove('hidden'); }
  if ((project.prompts || []).length) { renderPrompts(); $('#promptCard').classList.remove('hidden'); }
  if (project.lastSummary) renderScore({ summary: project.lastSummary, rec: project.recommendations, runs: project.runs, snapshots: project.snapshots });
  $('#rankKeywords').value = '';   // let loadRanks repopulate from this project
  $('#rankOut').innerHTML = '<p class="muted">No rank check yet. Set your keywords above and click <b>Check Google rankings</b>, or load demo data from <b>Setup</b>.</p>';
  loadRanks();
  updateStepper();
  showTab(furthestTab());
  loadRecent();
}

// ── Competitors (advanced) ──────────────────────────────────────────────────────
function compRow(c = {}) {
  const div = document.createElement('div');
  div.className = 'comp-row';
  div.innerHTML = `<input type="text" class="c-name" placeholder="Name" value="${esc(c.name || '')}">
    <input type="text" class="c-domain" placeholder="competitor.com" value="${esc(c.domain || '')}">
    <button class="btn-x small">✕</button>`;
  div.querySelector('button').onclick = () => div.remove();
  return div;
}
function renderCompetitors(list) {
  const c = $('#competitors'); c.innerHTML = '';
  (list.length ? list : []).forEach((x) => c.appendChild(compRow(x)));
}
function readAdvanced() {
  const competitors = $$('#competitors .comp-row').map((r) => ({
    name: r.querySelector('.c-name').value.trim(), domain: r.querySelector('.c-domain').value.trim(),
  })).filter((c) => c.name || c.domain);
  return {
    brandName: $('#brandName').value.trim(),
    brandAliases: $('#brandAliases').value,
    competitors,
    preferFree: $('#preferFree').checked,
  };
}

// ── STEP 1: scan whole site ──────────────────────────────────────────────────
async function ensureProject(url) {
  const dom = (u) => { try { return new URL(/^https?:/.test(u) ? u : 'https://' + u).hostname.replace(/^www\./, ''); } catch { return ''; } };
  const adv = readAdvanced();
  // Reuse a project for the same domain, else create.
  let proj = state.project;
  if (!proj || dom(proj.brandDomain) !== dom(url)) {
    proj = state.projects.find((p) => dom(p.brandDomain) === dom(url) && dom(url));
    if (proj) { proj = (await api(`/api/projects/${proj.id}`)).project; }
  }
  if (proj) {
    const { project } = await api(`/api/projects/${proj.id}`, { method: 'PATCH', body: JSON.stringify({ brandDomain: url, ...adv }) });
    state.project = project;
  } else {
    const { project } = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: dom(url) || 'site', brandDomain: url, ...adv }) });
    state.project = project;
  }
  return state.project;
}

async function scan() {
  const url = $('#siteUrl').value.trim();
  if (!url) { $('#scanStatus').innerHTML = '<span class="no">Enter a website URL.</span>'; return; }
  $('#scanBtn').disabled = true;
  $('#scanStatus').innerHTML = '<span class="spin"></span> preparing…';
  $('#scanOut').innerHTML = '';
  try {
    const project = await ensureProject(url);
    const max = +$('#maxPages').value || 150;
    const es = new EventSource(`/api/projects/${project.id}/scan?url=${encodeURIComponent(url)}&max=${max}`);
    es.addEventListener('start', (ev) => {
      const d = JSON.parse(ev.data);
      $('#scanStatus').innerHTML = `<span class="spin"></span> crawling ${esc(d.startUrl)} …`;
    });
    es.addEventListener('progress', (ev) => {
      const d = JSON.parse(ev.data);
      $('#scanStatus').innerHTML = d.phase
        ? `<span class="spin"></span> ${esc(d.phase)}`
        : `<span class="spin"></span> crawled ${d.crawled} pages (${d.queued} queued, max ${d.max})…`;
    });
    es.addEventListener('done', (ev) => {
      const d = JSON.parse(ev.data); es.close(); $('#scanBtn').disabled = false;
      state.project.keywords = d.source === 'llm' ? d.keywords : [];
      state.project.rawKeywords = d.rawKeywords || [];
      state.project.themes = d.themes || [];
      state.project.pages = d.pages;
      const srcNote = d.source === 'llm' ? `${d.counts.keywords} keywords` : `${d.counts.keywords} raw terms (add a key for clean AI keywords)`;
      $('#scanStatus').textContent = `✓ ${d.counts.ok}/${d.counts.total} pages · ${srcNote}` + (d.error ? ` · ${d.error}` : '');
      $('#scanOut').innerHTML = renderPageList(d.pages);
      renderKeywords();
      updateStepper();
      showTab('keywords');
      loadRecent();
    });
    es.addEventListener('error', (ev) => {
      es.close(); $('#scanBtn').disabled = false;
      let msg = 'scan failed'; try { msg = JSON.parse(ev.data).error; } catch {}
      $('#scanStatus').innerHTML = `<span class="no">${esc(msg)}</span>`;
    });
  } catch (e) { $('#scanBtn').disabled = false; $('#scanStatus').innerHTML = `<span class="no">${esc(e.message)}</span>`; }
}

function renderPageList(pages) {
  const bad = pages.filter((p) => !p.ok);
  return `<details style="margin-top:10px"><summary class="small" style="cursor:pointer;color:var(--ink-soft)">${pages.length} pages crawled${bad.length ? ` (${bad.length} failed)` : ''}</summary>
    <div style="max-height:220px;overflow:auto;margin-top:6px"><table>${pages.map((p) => `<tr><td>${esc(p.title || p.url)}<br><span class="muted small">${esc(p.url)}</span></td><td>${p.ok ? '<span class="chk">✓</span>' : `<span class="no">${esc(p.error)}</span>`}</td></tr>`).join('')}</table></div></details>`;
}

// ── STEP 2: keywords (show ALL) ───────────────────────────────────────────────
function renderKeywords() {
  const p = state.project;
  const clean = p.keywords && p.keywords.length ? p.keywords : null;
  const raw = p.rawKeywords || [];
  const list = clean || raw.map((k) => ({ phrase: k.phrase }));
  $('#kwCount').textContent = `(${list.length}${clean ? ', AI-extracted' : ' raw'})`;

  let html = '';
  if (clean && p.themes?.length) {
    // Group by theme when available.
    html += p.themes.map((t) => `<div style="margin-bottom:8px"><b class="small">${esc(t.name)}</b><br>${(t.keywords || []).map((k) => `<span class="kw">${esc(k)}</span>`).join('')}</div>`).join('');
    const themed = new Set(p.themes.flatMap((t) => (t.keywords || []).map((x) => x.toLowerCase())));
    const rest = list.filter((k) => !themed.has(k.phrase.toLowerCase()));
    if (rest.length) html += `<div><b class="small">Other</b><br>${rest.map((k) => `<span class="kw">${esc(k.phrase)}${k.intent ? ` <span class="i">${esc(k.intent)}</span>` : ''}</span>`).join('')}</div>`;
  } else {
    html += list.map((k) => `<span class="kw">${esc(k.phrase)}${k.intent ? ` <span class="i">${esc(k.intent)}</span>` : ''}</span>`).join('') || '<span class="muted">No keywords found.</span>';
  }
  // Raw extracted terms as an optional dig-in (only when we have clean ones too).
  if (clean && raw.length) {
    html += `<details style="margin-top:10px"><summary class="small" style="cursor:pointer;color:var(--ink-soft)">Show ${raw.length} raw extracted terms</summary>
      <div style="margin-top:6px">${raw.map((k) => `<span class="kw">${esc(k.phrase)}${k.pages > 1 ? ` <span class="i">${k.pages}p</span>` : ''}</span>`).join('')}</div></details>`;
  }
  $('#kwOut').innerHTML = html;
}

async function refineKeywords() {
  $('#refineBtn').disabled = true; $('#kwStatus').innerHTML = '<span class="spin"></span> refining…';
  try {
    const out = await api(`/api/projects/${state.project.id}/keywords/refine`, { method: 'POST', body: '{}' });
    state.project.keywords = out.keywords; state.project.themes = out.themes;
    renderKeywords();
    $('#kwStatus').textContent = `${out.keywords.length} keywords (${out.source})` + (out.error ? ` — ${out.error}` : '');
  } catch (e) { $('#kwStatus').innerHTML = `<span class="no">${esc(e.message)}</span>`; }
  $('#refineBtn').disabled = false;
}

function copyKeywords() {
  const kws = (state.project.keywords?.length ? state.project.keywords : state.project.rawKeywords || []).map((k) => k.phrase);
  navigator.clipboard.writeText(kws.join('\n')).then(() => { $('#kwStatus').textContent = 'copied'; });
}

// ── STEP 3: prompts ────────────────────────────────────────────────────────────
function renderPrompts() {
  const list = state.project.prompts || [];
  $('#promptOut').innerHTML = list.length
    ? list.map((pr, i) => `<div class="prompt-item" data-i="${i}">
        <div class="txt"><input type="text" value="${esc(pr.text)}" data-field="text" style="border:none;background:transparent;padding:4px 0;width:100%">
          <div class="meta"><span class="pill">${esc(pr.intent)}</span> ${pr.keyword ? '· ' + esc(pr.keyword) : ''}</div></div>
        <button class="btn-x small" data-del="${i}">✕</button></div>`).join('')
    : '<span class="muted">No prompts yet.</span>';
  $$('#promptOut [data-del]').forEach((b) => b.onclick = () => { state.project.prompts.splice(+b.dataset.del, 1); renderPrompts(); });
}

async function genPrompts() {
  $('#genPromptsBtn').disabled = true; $('#suggestBtn').disabled = true;
  $('#promptStatus').innerHTML = '<span class="spin"></span> generating…';
  try {
    const count = +$('#promptCount').value || 15;
    const out = await api(`/api/projects/${state.project.id}/prompts/generate`, { method: 'POST', body: JSON.stringify({ count }) });
    state.project.prompts = out.prompts;
    renderPrompts(); renderTrackEngines();
    updateStepper();
    $('#promptStatus').textContent = `${out.prompts.length} prompts (${out.source})` + (out.error ? ` — ${out.error}` : '');
    showTab('prompts');
  } catch (e) { $('#promptStatus').innerHTML = `<span class="no">${esc(e.message)}</span>`; }
  $('#genPromptsBtn').disabled = false; $('#suggestBtn').disabled = false;
}

function addPrompt() {
  state.project.prompts = state.project.prompts || [];
  state.project.prompts.push({ id: 'p' + Date.now(), text: '', intent: 'commercial', keyword: '' });
  renderPrompts();
  const inputs = $$('#promptOut input[data-field="text"]'); inputs[inputs.length - 1]?.focus();
}

async function savePrompts() {
  $$('#promptOut .prompt-item').forEach((el) => {
    const i = +el.dataset.i; if (state.project.prompts[i]) state.project.prompts[i].text = el.querySelector('[data-field="text"]').value.trim();
  });
  const prompts = state.project.prompts.filter((p) => p.text);
  const out = await api(`/api/projects/${state.project.id}/prompts`, { method: 'PUT', body: JSON.stringify({ prompts }) });
  state.project.prompts = out.prompts; renderPrompts(); $('#promptStatus').textContent = 'saved';
}

// ── Engines to check ────────────────────────────────────────────────────────────
function renderTrackEngines() {
  if (!state.health) return;
  const enabled = state.health.engines.filter((e) => e.enabled);
  if (!state.selectedEngines.size) enabled.forEach((e) => state.selectedEngines.add(e.id));
  $('#trackEngines').innerHTML = state.health.engines.map((e) => {
    const sel = e.enabled && state.selectedEngines.has(e.id);
    return `<span class="eng ${sel ? 'on' : 'off'}" data-eng="${e.id}" style="cursor:${e.enabled ? 'pointer' : 'not-allowed'}"><span class="dot"></span>${esc(e.label)}${e.enabled ? '' : ' <span class="badge">no key</span>'}</span>`;
  }).join('');
  $$('#trackEngines .eng').forEach((el) => {
    const id = el.dataset.eng; const eng = state.health.engines.find((x) => x.id === id);
    if (!eng.enabled) return;
    el.onclick = () => { state.selectedEngines.has(id) ? state.selectedEngines.delete(id) : state.selectedEngines.add(id); renderTrackEngines(); };
  });
}

// ── STEP 4: ranking ──────────────────────────────────────────────────────────────
function checkRanking() {
  const engines = [...state.selectedEngines].join(',');
  if (!engines) { $('#trackStatus').innerHTML = '<span class="no">Select at least one engine (needs a key).</span>'; return; }
  if (!state.project.prompts?.length) { $('#trackStatus').innerHTML = '<span class="no">Generate prompts first.</span>'; return; }
  $('#rankBtn').disabled = true;
  const es = new EventSource(`/api/projects/${state.project.id}/track?engines=${encodeURIComponent(engines)}`);
  es.addEventListener('start', (ev) => { const d = JSON.parse(ev.data); $('#trackStatus').innerHTML = `<span class="spin"></span> asking ${d.engines.length} engines × ${d.total} prompts…`; });
  es.addEventListener('progress', (ev) => { const d = JSON.parse(ev.data); $('#trackStatus').innerHTML = `<span class="spin"></span> ${d.done}/${d.total} prompts…`; });
  es.addEventListener('done', (ev) => {
    const d = JSON.parse(ev.data); es.close(); $('#rankBtn').disabled = false;
    $('#trackStatus').textContent = `done — ${d.runs.length} answers`;
    Object.assign(state.project, { runs: d.runs, lastSummary: d.summary, recommendations: d.rec });
    renderScore(d); loadRecent();
  });
  es.addEventListener('error', (ev) => { es.close(); $('#rankBtn').disabled = false; let m = 'stream error'; try { m = JSON.parse(ev.data).error; } catch {} $('#trackStatus').innerHTML = `<span class="no">${esc(m)}</span>`; });
}

// ── Google keyword rank tracking (DataForSEO) ─────────────────────────────────
const rankState = { configured: false };

function renderDfsBanner(d) {
  rankState.configured = d.configured;
  const bar = $('#rankConnBar');
  if (!bar) return;
  bar.className = 'hint';
  if (d.configured) {
    bar.innerHTML = `<b>✓ DataForSEO connected</b> <span class="muted">(${esc(d.login || 'account')}, ${d.source})</span> — live Google rank checks are ready.`;
    $('#rankSettings').open = false;
  } else {
    bar.innerHTML = `<b>Connect DataForSEO to run live checks.</b> Add your login &amp; password under <b>⚙️ DataForSEO credentials</b> below. You can still preview the dashboard with demo data.`;
    $('#rankSettings').open = true;
  }
}

// Connection status without a project (runs on page load).
async function loadDfsStatus() {
  try { renderDfsBanner(await api('/api/dataforseo')); } catch { /* ignore */ }
}

async function loadRanks() {
  if (!state.project) return;
  try {
    const d = await api(`/api/projects/${state.project.id}/ranks`);
    renderDfsBanner(d);
    // Config.
    if (d.config?.location) $('#rankLocation').value = d.config.location;
    if (d.config?.language) $('#rankLanguage').value = d.config.language;
    // Tracked keyword list (textarea).
    const kws = d.trackedKeywords || [];
    if (kws.length && !$('#rankKeywords').value.trim()) $('#rankKeywords').value = kws.join('\n');
    updateRankKwCount();
    // Stored results.
    if (d.results) renderRanks(d.results, d.snapshots || []);
  } catch (e) { /* non-fatal */ }
  loadSemrush();
}

function updateRankKwCount() {
  const n = $('#rankKeywords').value.split('\n').map((s) => s.trim()).filter(Boolean).length;
  $('#rankKwCount').textContent = n ? `(${n} keyword${n === 1 ? '' : 's'} · ~$${(n * 0.0035).toFixed(2)}/check)` : '';
}

async function saveDfs() {
  const login = $('#dfs_login').value.trim();
  const password = $('#dfs_password').value.trim();
  if (!login || !password) { $('#dfsStatus').innerHTML = '<span class="no">Enter both login and password.</span>'; return; }
  $('#saveDfsBtn').disabled = true; $('#dfsStatus').innerHTML = '<span class="spin"></span> testing…';
  try {
    const d = await api('/api/dataforseo', { method: 'POST', body: JSON.stringify({ login, password }) });
    if (d.error) { $('#dfsStatus').innerHTML = `<span class="no">${esc(d.error)}</span>`; }
    else if (d.account?.ok) {
      const bal = d.account.balance != null ? ` · balance $${Number(d.account.balance).toFixed(2)}` : '';
      $('#dfsStatus').innerHTML = `<span class="chk">✓ connected${esc(bal)}</span>`;
      $('#dfs_password').value = '';
      await loadRanks();
    } else $('#dfsStatus').textContent = d.configured ? 'saved' : 'not configured';
  } catch (e) { $('#dfsStatus').innerHTML = `<span class="no">${esc(e.message)}</span>`; }
  $('#saveDfsBtn').disabled = false;
}

async function saveRankConfig() {
  if (!state.project) return;
  const keywords = $('#rankKeywords').value.split('\n').map((s) => s.trim()).filter(Boolean);
  const body = { keywords, location: $('#rankLocation').value, language: $('#rankLanguage').value };
  try {
    await api(`/api/projects/${state.project.id}/ranks/config`, { method: 'PUT', body: JSON.stringify(body) });
    $('#rankStatus').textContent = `saved ${keywords.length} keywords`;
  } catch (e) { $('#rankStatus').innerHTML = `<span class="no">${esc(e.message)}</span>`; }
}

function checkGoogleRanks() {
  if (!state.project) { $('#rankStatus').innerHTML = '<span class="no">Scan a website first.</span>'; return; }
  if (!rankState.configured) { $('#rankStatus').innerHTML = '<span class="no">Connect DataForSEO first (⚙️ settings above).</span>'; $('#rankSettings').open = true; return; }
  const keywords = $('#rankKeywords').value.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!keywords.length) { $('#rankStatus').innerHTML = '<span class="no">Add at least one keyword.</span>'; return; }
  const loc = $('#rankLocation').value, lang = $('#rankLanguage').value;
  $('#rankGoBtn').disabled = true;
  $('#rankStatus').innerHTML = '<span class="spin"></span> starting…';
  // Persist the list/config first so a reload keeps it.
  saveRankConfig();
  const qs = `keywords=${encodeURIComponent(keywords.join('\n'))}&location=${encodeURIComponent(loc)}&language=${encodeURIComponent(lang)}`;
  const es = new EventSource(`/api/projects/${state.project.id}/ranks/track?${qs}`);
  es.addEventListener('start', (ev) => { const d = JSON.parse(ev.data); $('#rankStatus').innerHTML = `<span class="spin"></span> checking ${d.total} keywords on Google (${esc(d.location)})…`; });
  es.addEventListener('progress', (ev) => { const d = JSON.parse(ev.data); $('#rankStatus').innerHTML = `<span class="spin"></span> ${d.done}/${d.total} keywords checked…`; });
  es.addEventListener('done', (ev) => {
    const d = JSON.parse(ev.data); es.close(); $('#rankGoBtn').disabled = false;
    const s = d.results.summary;
    $('#rankStatus').textContent = `done — ${s.found}/${s.tracked} ranking${d.results.cost ? ` · cost $${d.results.cost.toFixed(2)}` : ''}`;
    state.project.rankResults = d.results;
    renderRanks(d.results, d.snapshots || []);
    updateStepper();
  });
  es.addEventListener('error', (ev) => { es.close(); $('#rankGoBtn').disabled = false; let m = 'rank check failed'; try { m = JSON.parse(ev.data).error; } catch {} $('#rankStatus').innerHTML = `<span class="no">${esc(m)}</span>`; });
}

// ── Semrush (keyword data, organic rankings, competitor comparison) ───────────
const semState = { configured: false };

function renderSemBanner(d) {
  semState.configured = d.configured;
  const bar = $('#semConnBar');
  if (!bar) return;
  bar.className = 'hint';
  if (d.configured) {
    bar.innerHTML = `<b>✓ Semrush connected</b> <span class="muted">(${esc(d.key || 'key')}, ${d.source})</span> — keyword data &amp; comparison ready.`;
    $('#semSettings').open = false;
  } else {
    bar.innerHTML = `<b>Connect Semrush for keyword data.</b> Add your API key under <b>⚙️ Semrush API key</b> below.`;
    $('#semSettings').open = true;
  }
}

async function loadSemStatus() {
  try { renderSemBanner(await api('/api/semrush')); } catch { /* ignore */ }
}

async function loadSemrush() {
  if (!state.project) return;
  try {
    const d = await api(`/api/projects/${state.project.id}/semrush`);
    renderSemBanner(d);
    renderSem(d);
  } catch { /* non-fatal */ }
}

async function saveSemrush() {
  const key = $('#sem_key').value.trim();
  if (!key) { $('#semStatus').innerHTML = '<span class="no">Paste your Semrush API key.</span>'; return; }
  $('#saveSemBtn').disabled = true; $('#semStatus').innerHTML = '<span class="spin"></span> testing…';
  try {
    const d = await api('/api/semrush', { method: 'POST', body: JSON.stringify({ key }) });
    if (d.account?.ok) { $('#semStatus').innerHTML = '<span class="chk">✓ connected</span>'; $('#sem_key').value = ''; renderSemBanner(d); }
    else $('#semStatus').innerHTML = `<span class="no">${esc(d.error || 'not configured')}</span>`;
  } catch (e) { $('#semStatus').innerHTML = `<span class="no">${esc(e.message)}</span>`; }
  $('#saveSemBtn').disabled = false;
}

function semGuard() {
  if (!state.project) { $('#semActStatus').innerHTML = '<span class="no">Scan a website first.</span>'; return false; }
  if (!semState.configured) { $('#semActStatus').innerHTML = '<span class="no">Connect Semrush first (⚙️ above).</span>'; $('#semSettings').open = true; return false; }
  return true;
}

async function semPost(path, body, label) {
  if (!semGuard()) return null;
  $('#semActStatus').innerHTML = `<span class="spin"></span> ${esc(label)}…`;
  try {
    const d = await api(`/api/projects/${state.project.id}/semrush/${path}`, { method: 'POST', body: JSON.stringify(body || {}) });
    $('#semActStatus').textContent = 'done';
    await loadSemrush();
    return d;
  } catch (e) { $('#semActStatus').innerHTML = `<span class="no">${esc(e.message)}</span>`; return null; }
}

const semEnrich = () => semPost('keywords', { related: true }, 'fetching keyword metrics');
const semRanks = () => semPost('ranks', {}, 'fetching organic rankings');
const semCompare = () => semPost('compare', {}, 'comparing domains');

const n0 = (v) => (v == null ? '—' : Number(v).toLocaleString());
const money = (v) => (v == null ? '—' : '$' + Number(v).toFixed(2));

function renderSem(d) {
  const box = $('#semOut');
  if (!box) return;
  let html = '';

  const kw = d.keywords;
  if (kw?.keywords?.length) {
    const rows = kw.keywords.filter((k) => !k.error).slice().sort((a, b) => (b.volume ?? -1) - (a.volume ?? -1));
    html += `<div style="margin-bottom:16px"><b class="small">Keyword metrics</b> <span class="muted small">(${rows.length} · ${kw.country?.toUpperCase?.() || ''}${kw.estUnits ? ` · ~${kw.estUnits} units` : ''})</span>
      <table class="semtbl"><thead><tr><th>Keyword</th><th>Volume</th><th>Difficulty</th><th>CPC</th><th>Intent</th></tr></thead><tbody>
      ${rows.map((k) => `<tr><td>${esc(k.phrase)}</td><td>${n0(k.volume)}</td><td>${k.difficulty == null ? '—' : esc(String(k.difficulty))}</td><td>${money(k.cpc)}</td><td class="muted">${esc(k.intent || '—')}</td></tr>`).join('')}
      </tbody></table></div>`;
  }

  const rel = d.related;
  if (rel?.ideas?.length) {
    html += `<details style="margin-bottom:16px"><summary class="small" style="cursor:pointer"><b>Related keyword ideas</b> <span class="muted">(seed: ${esc(rel.seed || '')})</span></summary>
      <div style="margin-top:8px">${rel.ideas.map((k) => `<span class="kw">${esc(k.phrase)}${k.volume != null ? ` <span class="i">${n0(k.volume)}/mo</span>` : ''}</span>`).join('')}</div></details>`;
  }

  const rk = d.ranks;
  if (rk?.rows?.length) {
    const rows = rk.rows.slice().sort((a, b) => (a.position ?? 999) - (b.position ?? 999)).slice(0, 100);
    html += `<div style="margin-bottom:16px"><b class="small">Your organic rankings</b> <span class="muted small">(${esc(rk.domain)} · ${rows.length} keywords)</span>
      <table class="semtbl"><thead><tr><th>#</th><th>Keyword</th><th>Volume</th><th>Traffic</th></tr></thead><tbody>
      ${rows.map((k) => `<tr><td><b>${k.position ?? '—'}</b></td><td>${esc(k.keyword)}</td><td>${n0(k.volume)}</td><td>${n0(k.traffic)}</td></tr>`).join('')}
      </tbody></table></div>`;
  }

  const cmp = d.compare;
  if (cmp?.rows?.length) {
    html += `<div style="margin-bottom:8px"><b class="small">Brand vs competitors</b> <span class="muted small">(${cmp.country?.toUpperCase?.() || ''} · organic visibility)</span>
      <table class="semtbl"><thead><tr><th>Domain</th><th>Rank</th><th>Keywords</th><th>Est. traffic</th></tr></thead><tbody>
      ${cmp.rows.map((r) => `<tr${r.isBrand ? ' style="font-weight:600;background:rgba(99,102,241,.08)"' : ''}><td>${esc(r.domain)}${r.isBrand ? ' <span class="i">you</span>' : ''}</td><td>${r.error ? '<span class="no">err</span>' : n0(r.rank)}</td><td>${n0(r.positions)}</td><td>${n0(r.traffic)}</td></tr>`).join('')}
      </tbody></table></div>`;
  }

  box.innerHTML = html || '<p class="muted">No Semrush data yet. Click <b>Enrich keywords</b>, <b>My organic rankings</b> or <b>Compare vs competitors</b> above.</p>';
}

function posCell(k) {
  if (k.position == null) return '<span class="muted">not in top 100</span>';
  let chg = '';
  if (k.change != null && k.change !== 0) {
    const up = k.change > 0;
    chg = ` <span class="delta ${up ? 'up' : 'down'}" style="margin-left:4px">${up ? '▲' : '▼'} ${Math.abs(k.change)}</span>`;
  } else if (k.change === 0) chg = ' <span class="delta flat">●</span>';
  else if (k.prevPosition == null) chg = ' <span class="muted small">new</span>';
  const cls = k.position <= 3 ? 'good' : k.position <= 10 ? '' : 'faint';
  return `<b class="rankpos ${cls}" style="font-variant-numeric:tabular-nums">#${k.position}</b>${chg}`;
}

function renderRanks(results, snapshots) {
  $('#rankCard').classList.remove('hidden');
  const s = results.summary;
  const snaps = snapshots || [];

  const tile = (l, v, spark, sub) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div><div class="foot">${spark || ''}<span class="sub">${sub || ''}</span></div></div>`;
  const avgH = snaps.map((x) => x.avgPosition).filter((x) => typeof x === 'number');
  const visH = snaps.map((x) => x.visibility).filter((x) => typeof x === 'number');
  const t10H = snaps.map((x) => x.top10).filter((x) => typeof x === 'number');
  const kpis = `<div class="kpis">
    ${tile('Avg. position', s.avgPosition ?? '—', sparkline(avgH.length > 1 ? avgH : [], 'var(--s1)'), s.avgPosition ? 'when you rank (lower = better)' : 'not ranking yet')}
    ${tile('Visibility', s.visibility + '%', sparkline(visH, 'var(--s2)'), 'click-weighted share')}
    ${tile('Top 3', s.top3, '', `of ${s.tracked} keywords`)}
    ${tile('Top 10', s.top10, sparkline(t10H, 'var(--s3)'), 'first page of Google')}
    ${tile('Ranking', `${s.found}/${s.tracked}`, '', `${s.improved}↑ ${s.declined}↓ since last`)}
  </div>`;

  // Trend line over snapshots: Top-10 count + visibility.
  let trend = '';
  if (snaps.length > 1) {
    const labels = snaps.map((x) => fmtDate(x.ts));
    const series = [
      { name: 'Keywords in top 10', color: 'var(--s1)', values: snaps.map((x) => x.top10 || 0) },
      { name: 'Keywords in top 3', color: 'var(--s2)', values: snaps.map((x) => x.top3 || 0) },
    ];
    trend = `<div class="viz"><h3>Ranking progress over time</h3>
      <p class="cap"><b>How to read:</b> how many of your tracked keywords sit on Google's first page (top 10) and in the top 3 across each check. Higher is better.</p>
      ${legend(series.map((x) => ({ label: x.name, color: x.color, line: true })))}
      <div class="chartbox">${lineChartCount(series, labels)}</div></div>`;
  } else {
    trend = `<div class="viz"><h3>Ranking progress over time</h3><p class="cap">Run the check again (or on a schedule) to build a trend line — each check adds a point.</p></div>`;
  }

  // Position distribution.
  const buckets = [
    { label: '#1–3', n: s.top3, color: 'var(--good)' },
    { label: '#4–10', n: s.top10 - s.top3, color: 'var(--s1)' },
    { label: '#11–20', n: s.top20 - s.top10, color: 'var(--s3)' },
    { label: '#21–100', n: s.found - s.top20, color: 'var(--neutralbar)' },
    { label: 'Not ranking', n: s.tracked - s.found, color: 'var(--surface-3)' },
  ];
  const bmax = Math.max(...buckets.map((b) => b.n), 1);
  const dist = `<div class="viz"><h3>Where your keywords rank</h3>
    <p class="cap"><b>How to read:</b> how your ${s.tracked} tracked keywords spread across Google positions.</p>
    <div class="hbars">${buckets.map((b) => hbar(b.label, b.n, bmax, { color: b.color, val: b.n })).join('')}</div></div>`;

  // Keyword table (sorted: ranking first by position, then not-ranking).
  const rows = [...results.keywords].sort((a, b) => {
    if (a.position == null && b.position == null) return 0;
    if (a.position == null) return 1;
    if (b.position == null) return -1;
    return a.position - b.position;
  });
  const table = `<div class="viz"><h3>Keyword positions <span class="muted" style="font-weight:500">· ${esc(results.location)}, ${esc(results.language)}</span></h3>
    <div style="max-height:460px;overflow:auto"><table class="ranktable">
      <tr><th>Keyword</th><th>Position</th><th>Ranking URL</th><th>Top competitor</th></tr>
      ${rows.map((k) => `<tr>
        <td><b>${esc(k.keyword)}</b>${(k.features || []).includes('ai_overview') ? ' <span class="pill" title="An AI Overview appears on this SERP">AI</span>' : ''}</td>
        <td>${posCell(k)}</td>
        <td>${rankUrlCell(k)}</td>
        <td>${k.topCompetitor ? `${esc(k.topCompetitor.name)} <span class="muted">#${k.topCompetitor.position}</span>` : '<span class="muted">—</span>'}</td>
      </tr>`).join('')}
    </table></div>
    <p class="muted small" style="margin-top:6px">Checked ${fmtDate(results.ts)} · organic positions (ads &amp; snippets excluded).</p></div>`;

  $('#rankOut').innerHTML = kpis + trend + dist + table;
}

function rankUrlCell(k) {
  if (!k.found) return '<span class="muted small">—</span>';
  // A real, clickable URL when available; otherwise the readable breadcrumb path.
  if (k.url && !/google\.com\/goto/.test(k.url)) return `<a href="${esc(k.url)}" target="_blank" rel="noopener" class="small">${esc(prettyUrl(k.url))}</a>`;
  if (k.displayUrl) return `<span class="small" style="color:var(--ink-soft)">${esc(k.displayUrl.slice(0, 52))}</span>`;
  return '<span class="muted small">—</span>';
}

function prettyUrl(u) {
  try { const x = new URL(u); return (x.hostname.replace(/^www\./, '') + x.pathname).replace(/\/$/, '').slice(0, 48); } catch { return (u || '').slice(0, 48); }
}

// Count-based line chart (integer y-axis, no % suffix) — reuses the viz palette.
function lineChartCount(series, xLabels) {
  const W = 720, H = 240, L = 34, R = 16, T = 16, B = 30;
  const n = xLabels.length;
  const ymax = niceMax(Math.max(...series.flatMap((s) => s.values), 1));
  const px = (i) => L + (n <= 1 ? 0 : (i / (n - 1)) * (W - L - R));
  const py = (v) => T + (1 - v / ymax) * (H - T - B);
  const ticks = [0, 0.5, 1].map((f) => Math.round(f * ymax));
  const grid = ticks.map((t) => `<line x1="${L}" y1="${py(t)}" x2="${W - R}" y2="${py(t)}" stroke="var(--grid)" stroke-width="1"/>
    <text x="${L - 6}" y="${py(t) + 3}" text-anchor="end" class="axis-txt">${t}</text>`).join('');
  const xlabIdx = n <= 2 ? xLabels.map((_, i) => i) : [0, Math.floor((n - 1) / 2), n - 1];
  const xlabs = xlabIdx.map((i) => `<text x="${px(i)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}" class="axis-txt">${esc(xLabels[i])}</text>`).join('');
  const lines = series.map((sObj) => {
    const pts = sObj.values.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ');
    const last = sObj.values.length - 1;
    return `<polyline fill="none" stroke="${sObj.color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" points="${pts}"/>
      <circle cx="${px(last).toFixed(1)}" cy="${py(sObj.values[last]).toFixed(1)}" r="3.5" fill="${sObj.color}" stroke="var(--surface)" stroke-width="1.5"/>
      <text x="${(px(last) - 6).toFixed(1)}" y="${(py(sObj.values[last]) - 8).toFixed(1)}" text-anchor="end" style="fill:${sObj.color};font-size:12px;font-weight:700">${sObj.values[last]}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(series.map((s) => s.name).join(' and '))} over time">
    ${grid}<line x1="${L}" y1="${py(0)}" x2="${W - R}" y2="${py(0)}" stroke="var(--axis)" stroke-width="1.5"/>${xlabs}${lines}</svg>`;
}

// ── Chart helpers (inline SVG, theme-aware, validated dataviz palette) ─────────
function niceMax(v) {
  const m = Math.max(v, 1);
  const mag = Math.pow(10, Math.floor(Math.log10(m)));
  return Math.max(Math.ceil(m / (mag / 2)) * (mag / 2), mag / 2);
}
function fmtDate(iso) {
  try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch { return ''; }
}
// Tiny sparkline for a KPI tile.
function sparkline(values, color) {
  const v = (values || []).filter((x) => typeof x === 'number');
  if (v.length < 2) return '';
  const w = 92, h = 28, p = 3;
  const lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1;
  const x = (i) => p + (i / (v.length - 1)) * (w - 2 * p);
  const y = (val) => h - p - ((val - lo) / span) * (h - 2 * p);
  const pts = v.map((val, i) => `${x(i).toFixed(1)},${y(val).toFixed(1)}`).join(' ');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="trend">
    <polyline fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${pts}"/>
    <circle cx="${x(v.length - 1).toFixed(1)}" cy="${y(v[v.length - 1]).toFixed(1)}" r="2.6" fill="${color}"/></svg>`;
}
// A delta chip comparing the latest two values. goodUp=false flips polarity (rank).
function deltaChip(arr, { unit = 'pp', goodUp = true } = {}) {
  const v = (arr || []).filter((x) => typeof x === 'number');
  if (v.length < 2) return '<span class="delta flat">● first run</span>';
  const diff = Math.round((v[v.length - 1] - v[v.length - 2]) * 10) / 10;
  if (diff === 0) return '<span class="delta flat">● no change</span>';
  const improving = goodUp ? diff > 0 : diff < 0;
  const arrow = diff > 0 ? '▲' : '▼';
  return `<span class="delta ${improving ? 'up' : 'down'}">${arrow} ${Math.abs(diff)}${unit} <span style="color:var(--ink-faint);font-weight:600">vs last</span></span>`;
}
// Multi-series line chart over time. series=[{name,color,values}], xLabels aligned.
function lineChart(series, xLabels) {
  const W = 720, H = 260, L = 40, R = 16, T = 16, B = 30;
  const n = xLabels.length;
  const allVals = series.flatMap((s) => s.values);
  const ymax = niceMax(Math.max(...allVals, 1));
  const px = (i) => L + (n <= 1 ? 0 : (i / (n - 1)) * (W - L - R));
  const py = (v) => T + (1 - v / ymax) * (H - T - B);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * ymax));
  const grid = ticks.map((t) => `<line x1="${L}" y1="${py(t)}" x2="${W - R}" y2="${py(t)}" stroke="var(--grid)" stroke-width="1"/>
    <text x="${L - 6}" y="${py(t) + 3}" text-anchor="end" class="axis-txt">${t}%</text>`).join('');
  const xlabIdx = n <= 2 ? xLabels.map((_, i) => i) : [0, Math.floor((n - 1) / 2), n - 1];
  const xlabs = xlabIdx.map((i) => `<text x="${px(i)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}" class="axis-txt">${esc(xLabels[i])}</text>`).join('');
  const lines = series.map((s) => {
    const pts = s.values.map((v, i) => `${px(i).toFixed(1)},${py(v).toFixed(1)}`).join(' ');
    const last = s.values.length - 1;
    return `<polyline fill="none" stroke="${s.color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" points="${pts}"/>
      <circle cx="${px(last).toFixed(1)}" cy="${py(s.values[last]).toFixed(1)}" r="3.5" fill="${s.color}" stroke="var(--surface)" stroke-width="1.5"/>
      <text x="${(px(last) - 6).toFixed(1)}" y="${(py(s.values[last]) - 8).toFixed(1)}" text-anchor="end" style="fill:${s.color};font-size:12px;font-weight:700">${s.values[last]}%</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(series.map((s) => s.name).join(' vs '))} over time">
    ${grid}<line x1="${L}" y1="${py(0)}" x2="${W - R}" y2="${py(0)}" stroke="var(--axis)" stroke-width="1.5"/>${xlabs}${lines}</svg>`;
}
const hbar = (name, pct, max, { me = false, color = 'var(--s1)', val } = {}) =>
  `<div class="hbar ${me ? 'me' : ''}"><div class="nm" title="${esc(name)}">${esc(name)}${me ? '<span class="tag-you">YOU</span>' : ''}</div>
    <div class="track"><div class="fill" style="width:${Math.max((pct / (max || 1)) * 100, 1)}%;background:${me ? 'var(--accent)' : color}"></div></div>
    <div class="val">${val ?? pct + '%'}</div></div>`;
const legend = (items) => `<div class="legend">${items.map((i) => `<span class="key"><span class="sw ${i.line ? 'line' : ''}" style="background:${i.color}"></span>${esc(i.label)}</span>`).join('')}</div>`;

function renderScore({ summary, rec, runs, snapshots }) {
  if (!summary) return;
  $('#scoreCard').classList.remove('hidden');
  const b = summary.brand;
  const snaps = snapshots || [];
  const sovH = snaps.map((s) => s.shareOfVoice);
  const menH = snaps.map((s) => s.mentionRate);
  const citH = snaps.map((s) => s.citationRate);

  // Verdict — one plain-English sentence with the trend direction.
  const trendWord = sovH.length > 1 ? (sovH[sovH.length - 1] > sovH[sovH.length - 2] ? 'up from last run' : sovH[sovH.length - 1] < sovH[sovH.length - 2] ? 'down from last run' : 'flat vs last run') : 'first run';
  const verdict = b.rankOverall
    ? `<div class="verdict"><span class="ico">📊</span><div><b>${esc(b.name)}</b> is named in <b>${b.mentionRate}%</b> of AI answers and ranks <b>#${b.rankOverall}</b> of ${summary.leaderboard.length} brands. Its share of voice is <b>${b.shareOfVoice}%</b> — <b>${trendWord}</b>.</div></div>`
    : `<div class="verdict" style="border-left-color:var(--red)"><span class="ico">⚠️</span><div><b>${esc(b.name)}</b> wasn't named in any answer this run, while <b>${summary.leaderboard.length}</b> other brands were. The charts below show who's winning and where to break in.</div></div>`;

  // KPI tiles with deltas + sparklines.
  const tile = (l, v, spark, chip, sub) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div>
    <div class="foot">${chip || `<span class="sub">${sub || ''}</span>`}${spark || ''}</div></div>`;
  const kpis = `<div class="kpis">
    ${tile('Share of voice', b.shareOfVoice + '%', sparkline(sovH, 'var(--s1)'), deltaChip(sovH))}
    ${tile('Mention rate', b.mentionRate + '%', sparkline(menH, 'var(--s3)'), deltaChip(menH))}
    ${tile('Citation rate', b.citationRate + '%', sparkline(citH, 'var(--s2)'), deltaChip(citH))}
    ${tile('Avg position', b.avgRank ?? '—', '', '', b.avgRank ? 'when you appear (1 = first)' : 'not yet ranked')}
    ${tile('Overall rank', b.rankOverall ? '#' + b.rankOverall : '—', '', '', `of ${summary.leaderboard.length} brands named`)}
  </div>`;

  // Trend line — you vs the strongest competitor, over every run.
  let trend = '';
  if (snaps.length > 1) {
    const brandKey = (b.name || '').toLowerCase();
    const topComp = snaps.map((s) => {
      const others = (s.leaderboard || []).filter((l) => (l.name || '').toLowerCase() !== brandKey);
      return others.length ? Math.max(...others.map((l) => l.shareOfVoice)) : 0;
    });
    const series = [
      { name: b.name + ' (you)', color: 'var(--s1)', values: sovH },
      { name: 'Top competitor', color: 'var(--s2)', values: topComp },
    ];
    trend = `<div class="viz"><h3>Share of voice over time</h3>
      <p class="cap"><b>How to read:</b> your slice of all brand mentions across ${snaps.length} runs, next to the single strongest competitor each run. Higher is better.</p>
      ${legend(series.map((s) => ({ label: s.name, color: s.color, line: true })))}
      <div class="chartbox">${lineChart(series, snaps.map((s) => fmtDate(s.ts)))}</div></div>`;
  } else {
    trend = `<div class="viz"><h3>Share of voice over time</h3><p class="cap">Run the tracker again (or on a schedule) to build a trend line here — each run adds a point.</p></div>`;
  }

  // Leaderboard — horizontal bars, you highlighted.
  const lbMax = Math.max(...summary.leaderboard.map((l) => l.shareOfVoice), 1);
  const lb = `<div class="viz"><h3>Who AI recommends</h3>
    <p class="cap"><b>How to read:</b> each brand's share of all mentions across every answer. Your bar is highlighted.</p>
    <div class="hbars">${summary.leaderboard.slice(0, 10).map((l) => hbar(l.name, l.shareOfVoice, lbMax, { me: l.isBrand })).join('')}</div></div>`;

  // By engine — grouped mention vs citation.
  const engMax = Math.max(...summary.engines.flatMap((e) => [e.mentionRate, e.citationRate]), 1);
  const eng = `<div class="viz"><h3>How you do on each engine</h3>
    <p class="cap"><b>How to read:</b> the share of that engine's answers that <b>mention</b> you vs. that <b>link</b> to your site. Different assistants surface different brands.</p>
    ${legend([{ label: 'Mentioned', color: 'var(--s1)' }, { label: 'Cited (linked)', color: 'var(--s2)' }])}
    <div class="enggrid">${summary.engines.map((e) => `<div class="engrow"><div class="nm">${esc(e.engine)}</div><div class="pair">
      <div class="mini"><div class="track"><div class="fill" style="width:${(e.mentionRate / engMax) * 100}%;background:var(--s1)"></div></div><div class="val">${e.mentionRate}%</div></div>
      <div class="mini"><div class="track"><div class="fill" style="width:${(e.citationRate / engMax) * 100}%;background:var(--s2)"></div></div><div class="val">${e.citationRate}%</div></div>
    </div></div>`).join('')}</div></div>`;

  // Sentiment — stacked bar + legend (status colors, labelled).
  const s = summary.sentiment;
  const sTot = s.positive + s.neutral + s.negative + s.absent || 1;
  const seg = (count, color, dark) => count ? `<span style="width:${(count / sTot) * 100}%;background:${color}${dark ? ';color:#0b0b0b' : ''}">${count / sTot > 0.06 ? count : ''}</span>` : '';
  const sentiment = `<div class="viz"><h3>How AI talks about you</h3>
    <p class="cap"><b>How to read:</b> the tone of the ${sTot} answers — positive, neutral, negative, or you were absent.</p>
    ${legend([{ label: 'Positive', color: 'var(--good)' }, { label: 'Neutral', color: 'var(--neutralbar)' }, { label: 'Negative', color: 'var(--critical)' }, { label: 'Absent', color: 'var(--surface-3)' }])}
    <div class="stack">${seg(s.positive, 'var(--good)')}${seg(s.neutral, 'var(--neutralbar)')}${seg(s.negative, 'var(--critical)')}${seg(s.absent, 'var(--surface-3)', true)}</div>
    ${summary.errored ? `<p class="muted small" style="margin-top:6px">${summary.errored} answer(s) errored.</p>` : ''}</div>`;

  const ownerBadge = (o) => o === 'own' ? '<span class="pill" style="background:var(--accent);color:var(--on-accent)">you</span>'
    : o === 'competitor' ? '<span class="pill" style="background:var(--red-soft);color:var(--red)">competitor</span>'
    : '<span class="pill">third-party</span>';
  const cited = (summary.topCited && summary.topCited.length)
    ? `<div class="viz"><h3>Most cited websites</h3><p class="cap"><b>How to read:</b> the sources AI leans on for these topics — get featured on these and you're more likely to be cited.</p>
        <table><tr><th>#</th><th>Website</th><th>Type</th><th>Answers citing it</th></tr>
        ${summary.topCited.map((c, i) => `<tr><td>${i + 1}</td><td><b>${esc(c.domain)}</b></td><td>${ownerBadge(c.owner)}</td><td style="font-variant-numeric:tabular-nums">${c.count}</td></tr>`).join('')}</table></div>`
    : '';
  const opps = (summary.opportunities && summary.opportunities.length)
    ? `<div class="viz"><h3>Opportunity sites <span class="muted" style="font-weight:500">(${summary.opportunities.length})</span></h3>
        <p class="cap"><b>How to read:</b> sites cited in answers that name a competitor but <b>not you</b> — earning a mention here is the fastest way to close the gap.</p>
        <table><tr><th>#</th><th>Website</th><th>Missed answers</th></tr>
        ${summary.opportunities.map((o, i) => `<tr><td>${i + 1}</td><td><b>${esc(o.domain)}</b></td><td><span style="color:var(--amber);font-weight:700;font-variant-numeric:tabular-nums">${o.count}</span></td></tr>`).join('')}</table></div>`
    : '';

  const gaps = summary.gaps.length
    ? `<div class="viz"><details class="bigfold"><summary><h3 style="display:inline;margin:0">Where you're losing <span class="muted" style="font-weight:500">(${summary.gaps.length})</span></h3><span class="muted small"> · click to expand</span></summary><p class="cap">Prompts where a competitor is named but you aren't.</p>${summary.gaps.slice(0, 25).map((g) => `<div class="gap">“${esc(g.promptText)}” <span class="muted">(${esc(g.engine)})</span> → <span class="w">${g.winners.map(esc).join(', ')}</span></div>`).join('')}</details></div>`
    : '';

  const recs = rec?.items?.length
    ? `<div class="viz"><h3>How to rank higher</h3>${rec.items.map((r) => `<div class="rec ${esc(r.priority)}"><span class="p">${esc(r.priority)}</span><b>${esc(r.action)}</b><span class="muted">${esc(r.why)}</span>${r.example ? `<div class="small" style="margin-top:4px">▸ ${esc(r.example)}</div>` : ''}</div>`).join('')}</div>`
    : '';

  const evidence = runs?.length
    ? `<div class="viz"><details class="bigfold"><summary><h3 style="display:inline;margin:0">Evidence — ${runs.length} answers</h3><span class="muted small"> · click to expand</span></summary>
      <p class="cap">Every answer the engines gave, with the brands and sources we detected.</p>${runs.slice(0, 80).map((r) => `<details class="run"><summary>
        <span class="pill">${esc(r.engineLabel)}</span> ${r.brand?.mentioned ? '<span class="chk">✓ you</span>' : '<span class="no">✕</span>'} ${r.brand?.cited ? '<span class="chk">cited</span>' : ''} ${r.error ? '<span class="no">error</span>' : ''}
        <span style="flex:1">“${esc(r.promptText)}”</span></summary>
        ${r.error ? `<div class="ans no">${esc(r.error)}</div>` : `<div class="ans">${esc((r.answer || '').slice(0, 2500))}</div>`}
        ${(r.citations || []).length ? `<div class="cite">Sources: ${r.citations.slice(0, 8).map((c) => `<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc((c.title || c.url).slice(0, 40))}</a>`).join('')}</div>` : ''}
      </details>`).join('')}</details></div>`
    : '';

  $('#scoreOut').innerHTML = verdict + kpis + trend + lb + eng + sentiment + cited + opps + gaps + recs + evidence;
  updateStepper();
  showTab('results');
}

// ── Wiring ──────────────────────────────────────────────────────────────────────
$$('#tabs .tab').forEach((t) => t.onclick = () => showTab(t.dataset.tab));
$('#preferFree').onchange = loadHealth;
$('#ghostToggle').onchange = onGhostToggle;
$('#demoBtn').onclick = loadDemo;
$('#saveKeysBtn').onclick = saveKeys;
$('#clearKeysBtn').onclick = clearKeys;
$('#addCompBtn').onclick = () => $('#competitors').appendChild(compRow());
$('#scanBtn').onclick = scan;
$('#siteUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') scan(); });
$('#suggestBtn').onclick = genPrompts;
$('#genPromptsBtn').onclick = genPrompts;
$('#refineBtn').onclick = refineKeywords;
$('#copyKwBtn').onclick = copyKeywords;
$('#addPromptBtn').onclick = addPrompt;
$('#savePromptsBtn').onclick = () => savePrompts().catch((e) => alert(e.message));
$('#rankBtn').onclick = checkRanking;
$('#rankGoBtn').onclick = checkGoogleRanks;
$('#saveDfsBtn').onclick = saveDfs;
$('#saveRankCfgBtn').onclick = () => saveRankConfig();
$('#rankKeywords').addEventListener('input', updateRankKwCount);
$('#saveSemBtn').onclick = saveSemrush;
$('#semKwBtn').onclick = semEnrich;
$('#semRankBtn').onclick = semRanks;
$('#semCompBtn').onclick = semCompare;

(async function init() {
  fillKeyInputs();
  const ghostOn = ghostStored();
  $('#ghostToggle').checked = ghostOn;
  $('#ghostHint').classList.toggle('hidden', !ghostOn);
  await pushStoredKeys(); // re-apply browser-saved keys to the server (survives restarts)
  if (ghostOn) await pushGhost(true); // re-apply ghost toggle (server holds it in memory)
  try { await loadHealth(); } catch (e) { $('#keyHint').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  loadDfsStatus();
  loadSemStatus();
  updateStepper();
  await loadRecent();
})();
