// JustPrompt front-end — simple linear flow: scan → keywords → prompts → ranking.
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const state = { projects: [], project: null, health: null, selectedEngines: new Set() };

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'request failed');
  return data;
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
    $('#keyHint').innerHTML = `<div class="hint"><b>Ranking needs one free key.</b> Scanning + keywords work without one. Add a key to <code>.env</code> and restart:
      <a href="https://aistudio.google.com/apikey" target="_blank">Gemini</a> (free + live web) ·
      <a href="https://console.groq.com/keys" target="_blank">Groq</a> (free) ·
      <a href="https://openrouter.ai/keys" target="_blank">OpenRouter</a> (free + all models).</div>`;
  } else {
    const live = h.engines.filter((e) => e.enabled && e.binding?.live).map((e) => e.label);
    $('#keyHint').innerHTML = `<p class="muted small" style="margin-top:6px">Analysis: <b>${h.analysis ? esc(h.analysis.provider + '/' + h.analysis.model) : 'heuristics'}</b>${live.length ? ` · live-web: <b>${live.map(esc).join(', ')}</b>` : ''}</p>`;
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
      renderKeywords(); $('#kwCard').classList.remove('hidden');
      $('#kwCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
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
    $('#promptCard').classList.remove('hidden');
    $('#promptStatus').textContent = `${out.prompts.length} prompts (${out.source})` + (out.error ? ` — ${out.error}` : '');
    $('#promptCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
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

function renderScore({ summary, rec, runs, snapshots }) {
  if (!summary) return;
  $('#scoreCard').classList.remove('hidden');
  const b = summary.brand;
  const headline = b.rankOverall
    ? `<p style="font-size:1.1rem;margin:0 0 10px"><b>${esc(b.name)}</b> ranks <b style="color:var(--accent)">#${b.rankOverall}</b> of ${summary.leaderboard.length} brands AI named — mentioned in <b>${b.mentionRate}%</b> of answers.</p>`
    : `<p style="font-size:1.1rem;margin:0 0 10px"><b>${esc(b.name)}</b> was <b style="color:var(--pin-red)">not mentioned</b> in any answer yet — ${summary.leaderboard.length} other brands were.</p>`;

  const metrics = `<div class="metrics">
    <div class="metric"><div class="v">${b.rankOverall ? '#' + b.rankOverall : '—'}</div><div class="l">Overall rank</div></div>
    <div class="metric"><div class="v">${b.shareOfVoice}%</div><div class="l">Share of voice</div></div>
    <div class="metric"><div class="v">${b.mentionRate}%</div><div class="l">Mention rate</div></div>
    <div class="metric"><div class="v">${b.citationRate}%</div><div class="l">Citation rate</div></div>
    <div class="metric"><div class="v">${b.avgRank ?? '—'}</div><div class="l">Avg position</div></div>
  </div>`;

  const lb = `<h3>Leaderboard — who AI recommends</h3><table><tr><th>#</th><th>Brand</th><th>Answers</th><th style="width:45%">Share of voice</th></tr>
    ${summary.leaderboard.map((l, i) => `<tr><td>${i + 1}</td><td>${l.isBrand ? '<b>' + esc(l.name) + ' (you)</b>' : esc(l.name)}</td>
      <td>${l.mentions}</td><td><div class="bar ${l.isBrand ? 'us' : ''}"><span style="width:${l.shareOfVoice}%"></span></div> ${l.shareOfVoice}%</td></tr>`).join('')}</table>`;

  const eng = `<h3>By engine</h3><table><tr><th>Engine</th><th>Mention rate</th><th>Citation rate</th><th>Answers</th></tr>
    ${summary.engines.map((e) => `<tr><td>${esc(e.engine)}</td><td>${e.mentionRate}%</td><td>${e.citationRate}%</td><td>${e.runs}</td></tr>`).join('')}</table>`;

  const s = summary.sentiment;
  const sentLine = `<p class="muted small">Sentiment — +${s.positive} · ~${s.neutral} · −${s.negative} · absent ${s.absent}${summary.errored ? ` · ${summary.errored} errored` : ''}</p>`;

  const gaps = summary.gaps.length
    ? `<h3>Where you're losing (${summary.gaps.length})</h3>${summary.gaps.slice(0, 15).map((g) => `<div class="gap">“${esc(g.promptText)}” <span class="muted">(${esc(g.engine)})</span> → <span class="w">${g.winners.map(esc).join(', ')}</span></div>`).join('')}`
    : '';

  const recs = rec?.items?.length
    ? `<h3>How to rank higher</h3>${rec.items.map((r) => `<div class="rec ${esc(r.priority)}"><span class="p">${esc(r.priority)}</span><b>${esc(r.action)}</b><span class="muted">${esc(r.why)}</span>${r.example ? `<div class="small" style="margin-top:4px">▸ ${esc(r.example)}</div>` : ''}</div>`).join('')}`
    : '';

  let trend = '';
  if (snapshots && snapshots.length > 1) {
    const max = Math.max(...snapshots.map((x) => x.shareOfVoice), 1);
    trend = `<h3>Share-of-voice trend</h3><div class="trend">${snapshots.map((x) => `<div class="b" title="${esc(x.ts)}: ${x.shareOfVoice}%" style="height:${(x.shareOfVoice / max) * 100}%"></div>`).join('')}</div>`;
  }

  const evidence = runs?.length
    ? `<h3>Evidence — ${runs.length} answers</h3>${runs.slice(0, 80).map((r) => `<details class="run"><summary>
        <span class="pill">${esc(r.engineLabel)}</span> ${r.brand?.mentioned ? '<span class="chk">✓ you</span>' : '<span class="no">✕</span>'} ${r.brand?.cited ? '<span class="chk">cited</span>' : ''} ${r.error ? '<span class="no">error</span>' : ''}
        <span style="flex:1">“${esc(r.promptText)}”</span></summary>
        ${r.error ? `<div class="ans no">${esc(r.error)}</div>` : `<div class="ans">${esc((r.answer || '').slice(0, 2500))}</div>`}
        ${(r.citations || []).length ? `<div class="cite">Sources: ${r.citations.slice(0, 8).map((c) => `<a href="${esc(c.url)}" target="_blank">${esc((c.title || c.url).slice(0, 40))}</a>`).join('')}</div>` : ''}
      </details>`).join('')}`
    : '';

  $('#scoreOut').innerHTML = headline + metrics + sentLine + lb + eng + trend + gaps + recs + evidence;
  $('#scoreCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── Wiring ──────────────────────────────────────────────────────────────────────
$('#preferFree').onchange = loadHealth;
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

(async function init() {
  try { await loadHealth(); } catch (e) { $('#keyHint').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  await loadRecent();
})();
