// Running Plan viewer.
// Loads the plan from a Google Doc, works out today's workout, and shows the
// weeks and the guide. No build step.
// PRIVACY: this repository is public. The plan itself and the doc link never go
// in it; the link is pasted in Settings and kept on the phone only.
'use strict';

const APP_VERSION = 'r2'; // keep in step with VERSION in sw.js
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---------- small helpers ----------
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const dayKey = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const fmtDate = (d) => `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}`;
const daysBetween = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / 86400000);

function today() {
  // ?today=2026-03-15 lets you preview another day.
  const q = new URLSearchParams(location.search).get('today');
  if (q && /^\d{4}-\d{1,2}-\d{1,2}$/.test(q)) { const [y, m, d] = q.split('-').map(Number); return new Date(y, m - 1, d); }
  return startOfDay(new Date());
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2600);
}

// ---------- where the plan comes from ----------
function docLink() { return (store.get('docUrl') || '').trim(); }
// Turns any Google Doc link into an address the app can download the doc from.
function fetchUrl(link) {
  if (!link) return null;
  let m = link.match(/\/document\/d\/e\/([\w-]+)/); // "Publish to the web" link
  if (m) return `https://docs.google.com/document/d/e/${m[1]}/pub`;
  m = link.match(/\/document\/(?:u\/\d+\/)?d\/([\w-]+)/) || link.match(/^([\w-]{25,})$/);
  if (m) return `https://docs.google.com/document/d/${m[1]}/export?format=html`;
  return link; // any other web address of an HTML copy of the plan
}

// ---------- parsing the document ----------
// Works on the doc's HTML export from Google Docs (and on any similar HTML).
function parsePlan(htmlText) {
  const doc = new DOMParser().parseFromString(htmlText, 'text/html');
  // Google Docs marks bold text with CSS classes; find them.
  const bold = new Set();
  for (const st of doc.querySelectorAll('style')) {
    for (const m of st.textContent.matchAll(/\.([\w-]+)\s*\{[^}]*font-weight\s*:\s*(700|bold)/g)) bold.add(m[1]);
  }
  const isBold = (el) => /^(STRONG|B)$/.test(el.tagName) || /font-weight\s*:\s*(700|bold)/.test(el.getAttribute('style') || '') || [...el.classList].some((c) => bold.has(c));

  function inline(node) {
    let out = '';
    for (const n of node.childNodes) {
      if (n.nodeType === 3) { out += esc(n.textContent.replace(/ /g, ' ')); continue; }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName;
      if (tag === 'BR') { out += ' '; continue; }
      if (tag === 'STYLE' || tag === 'SCRIPT') continue;
      let inner = inline(n);
      if (tag === 'P' || tag === 'DIV') inner = (out ? ' ' : '') + inner;
      if (tag === 'A' && n.getAttribute('href')) {
        let href = n.getAttribute('href');
        try { const u = new URL(href, 'https://x.invalid/'); if (/google\.com$/.test(u.hostname) && u.pathname === '/url') href = u.searchParams.get('q') || href; } catch { /* keep */ }
        if (/^https?:/i.test(href)) inner = `<a href="${esc(href)}" target="_blank" rel="noopener">${inner}</a>`;
      }
      if (isBold(n) && inner.trim()) inner = `<strong>${inner}</strong>`;
      if (tag === 'EM' || tag === 'I') inner = `<em>${inner}</em>`;
      out += inner;
    }
    return out.replace(/<\/strong><strong>/g, '');
  }
  const plain = (h) => { const d = document.createElement('div'); d.innerHTML = h; return d.textContent.replace(/\s+/g, ' ').trim(); };

  // Collect top-level blocks in document order.
  const blocks = [];
  (function walk(el) {
    for (const c of el.children) {
      const t = c.tagName;
      if (/^H[1-6]$/.test(t)) blocks.push({ type: 'h', level: +t[1], text: plain(inline(c)) });
      else if (t === 'P') { const h = inline(c).trim(); if (plain(h)) blocks.push({ type: 'p', html: h, title: c.classList.contains('title') }); }
      else if (t === 'UL' || t === 'OL') {
        const items = [...c.children].filter((li) => li.tagName === 'LI').map((li) => inline(li).trim()).filter((h) => plain(h));
        const prev = blocks[blocks.length - 1];
        if (prev && prev.type === 'list' && prev.ordered === (t === 'OL')) prev.items.push(...items); // Google splits lists
        else if (items.length) blocks.push({ type: 'list', ordered: t === 'OL', items });
      } else if (t === 'TABLE') {
        const rows = [...c.querySelectorAll('tr')].map((tr) => [...tr.children].map((td) => inline(td).trim()));
        if (rows.length) blocks.push({ type: 'table', rows });
      } else if (t === 'HR') { /* ignore */ } else walk(c);
    }
  })(doc.body);

  // Group blocks into sections by heading.
  const plan = { title: 'Running Plan', intro: [], sections: [], weeks: [], shoes: {} };
  let cur = null, parent = null, titled = false;
  for (const b of blocks) {
    if (!titled && (b.type === 'h' && b.level === 1 || b.type === 'p' && b.title)) { plan.title = b.text || plain(b.html); titled = true; continue; }
    if (b.type === 'h') {
      cur = { level: b.level, title: b.text, blocks: [], parent: null };
      if (b.level <= 2) parent = cur; else cur.parent = parent;
      plan.sections.push(cur);
      continue;
    }
    (cur ? cur.blocks : plan.intro).push(b);
  }

  // Weeks: a heading "Week N: ..." with a Day / Workout table.
  for (const s of plan.sections) {
    const m = s.title.match(/^Week\s+(\d+)\s*[:\-–—]\s*(.*)$/i);
    const table = s.blocks.find((b) => b.type === 'table' && /^day$/i.test(plain(b.rows[0][0] || '')));
    // Shoe rotation: a table with Week, Sun, Mon... columns.
    for (const b of s.blocks) {
      if (b.type !== 'table') continue;
      const head = b.rows[0].map(plain);
      if (/^week$/i.test(head[0]) && head.some((h) => /^sun/i.test(h))) {
        for (const r of b.rows.slice(1)) {
          const n = parseInt(plain(r[0]), 10); if (!n) continue;
          plan.shoes[n] = {};
          head.forEach((h, i) => { if (i && r[i]) plan.shoes[n][h.slice(0, 3).toLowerCase()] = plain(r[i]); });
        }
      }
    }
    if (!m || !table) continue;
    s.isWeek = true;
    const rest = m[2].trim();
    const mm = rest.match(/^(.*?)\s*\((.*)\)\s*$/);
    const week = {
      num: +m[1], heading: s.title, range: mm ? mm[1] : rest, summary: mm ? mm[2] : '',
      group: s.parent && s.parent !== s ? s.parent.title : '',
      extra: s.blocks.filter((b) => b !== table), days: [],
    };
    for (const r of table.rows.slice(1)) {
      const label = plain(r[0] || '');
      const html = r.slice(1).join(' ');
      if (!label) continue;
      const dm = label.match(/(\d{1,2})\/(\d{1,2})/);
      week.days.push({ label, html, text: plain(html), m: dm ? +dm[1] : null, d: dm ? +dm[2] : null, week });
    }
    plan.weeks.push(week);
  }
  for (const s of plan.sections) if (!s.isWeek && plan.sections.some((w) => w.isWeek && w.parent === s)) s.isGroup = true;

  // Work out each day's year: the first dated day is put in the year that puts it
  // closest to today, and the year goes up whenever the month goes back down.
  const dated = plan.weeks.flatMap((w) => w.days).filter((d) => d.m);
  if (dated.length) {
    const now = today();
    let year = [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1]
      .sort((a, b) => Math.abs(new Date(a, dated[0].m - 1, dated[0].d) - now) - Math.abs(new Date(b, dated[0].m - 1, dated[0].d) - now))[0];
    let lastM = dated[0].m;
    for (const d of dated) {
      if (d.m < lastM) year++;
      lastM = d.m;
      d.date = new Date(year, d.m - 1, d.d);
    }
  }
  for (const w of plan.weeks) {
    for (const d of w.days) { d.kind = kindOf(d.text); d.done = /\bdone\b/i.test(d.text); d.shoe = shoeFor(plan, w.num, d); }
    const ds = w.days.filter((d) => d.date);
    w.start = ds.length ? ds[0].date : null;
    w.end = ds.length ? ds[ds.length - 1].date : null;
  }
  return plan;
}

function kindOf(text) {
  const first = text.split(/[.:;]/)[0];
  if (/^rest\b/i.test(text)) return 'rest';
  if (/\b(race day|half|5k|10k|marathon)\b/i.test(first) && !/rehearsal|effort|fueling|shakeout/i.test(first)) return 'race';
  if (/^long(est)? run/i.test(text)) return 'long';
  if (/ladder|tempo|interval|fartlek|progression|hills|sharpener|steady|benchmark|rehearsal|cruise|\d+\s*x\s*\d/i.test(first) || /^1 mi easy,/i.test(text)) return 'workout';
  return 'easy';
}
const KIND_LABEL = { rest: 'Rest', race: 'Race', long: 'Long run', workout: 'Workout', easy: 'Easy' };

function shoeFor(plan, weekNum, day) {
  const row = plan.shoes[weekNum];
  if (!row) return '';
  const abbr = (day.label.match(/^[A-Za-z]{3}/) || [''])[0].toLowerCase();
  return row[abbr] || '';
}

// Marks the "Done:" part of a workout so it stands out.
function workoutHtml(html) {
  return html.replace(/(\(?)\b(done)\b/i, (all, paren, word) => `${paren}<mark class="done">${word[0].toUpperCase() + word.slice(1)}</mark>`);
}

// ---------- state ----------
const state = { plan: null, source: 'none', loadedAt: 0, error: '', loading: false };

function usePlan(html, source, at) {
  const plan = parsePlan(html);
  if (!plan.weeks.length) throw new Error('No weeks found in the document. Each week needs a heading like "Week 3: Nov 8 to 14" followed by a Day / Workout table.');
  state.plan = plan; state.source = source; state.loadedAt = at || 0;
  return plan;
}

async function refresh(manual) {
  const url = fetchUrl(docLink());
  if (!url) { state.plan = null; state.error = ''; render(); return; }
  state.loading = true; setStatus();
  try {
    const html = await fetchDoc(url), source = 'google';
    usePlan(html, source, Date.now());
    store.set('planHtml', html); store.set('planSource', source); store.set('planAt', String(state.loadedAt)); store.set('planLink', docLink());
    state.error = '';
    if (manual) toast('Plan updated');
  } catch (e) {
    state.error = e.message || String(e);
    if (manual) toast('Couldn’t update the plan');
  } finally {
    state.loading = false; render();
  }
}

async function fetchDoc(url) {
  let r;
  try { r = await fetch(url, { cache: 'no-store', credentials: 'omit' }); } catch {
    throw new Error(navigator.onLine === false ? 'No signal, so the plan couldn’t be checked for changes.' : 'Couldn’t open the Google Doc. Check that it’s shared as “Anyone with the link”.');
  }
  if (!r.ok) throw new Error(r.status === 404 || r.status === 401 || r.status === 403 ? 'Google won’t share this doc with the app. Set sharing to “Anyone with the link: Viewer”.' : 'Google Docs answered with error ' + r.status + '.');
  const t = await r.text();
  if (/accounts\.google\.com\/(ServiceLogin|v3\/signin)/.test(t)) throw new Error('The doc asks for a Google sign-in. Set sharing to “Anyone with the link: Viewer”.');
  return t;
}

function boot() {
  const html = store.get('planHtml');
  // Only reuse the saved copy if it came from the same place.
  if (html && (store.get('planLink') || '') === docLink()) {
    try { usePlan(html, 'google', +store.get('planAt') || 0); } catch { /* reload below */ }
  }
  render();
  refresh(false);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    render(); // the day may have changed
    if (Date.now() - state.loadedAt > 10 * 60 * 1000) refresh(false);
  });
}

// ---------- status pill ----------
function setStatus() {
  const el = $('#sync');
  let cls = 'none', txt = 'No doc';
  if (state.loading && !state.plan) { cls = 'pending'; txt = 'Loading'; }
  else if (state.plan) { cls = state.error ? 'offline' : 'ok'; txt = state.error ? 'Saved copy' : 'Google Doc'; }
  else if (state.error) { cls = 'error'; txt = 'Doc error'; }
  el.className = 'sync ' + cls;
  el.querySelector('span').textContent = txt;
}

// ---------- finding days ----------
function allDays() { return state.plan ? state.plan.weeks.flatMap((w) => w.days).filter((d) => d.date) : []; }
function findDay(date) { const k = dayKey(date); return allDays().find((d) => dayKey(d.date) === k) || null; }
function currentWeek() {
  const t = today();
  const ws = state.plan.weeks.filter((w) => w.start);
  return ws.find((w) => t >= w.start && t <= w.end) || ws.find((w) => w.start > t) || ws[ws.length - 1] || state.plan.weeks[0];
}
function nextRace() { const t = today(); return allDays().find((d) => d.kind === 'race' && d.date >= t) || null; }

// ---------- rendering ----------
function render() {
  setStatus();
  const view = $('#view');
  const route = (location.hash.replace(/^#\/?/, '') || '').split('/');
  const tab = route[0] || 'today';
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === (tab === 'week' ? 'plan' : tab)));
  $('#back').hidden = tab !== 'week';
  if (!state.plan) {
    $('#title').textContent = 'Running Plan';
    if (state.error) view.innerHTML = `<div class="card warn"><strong>Couldn’t load the plan.</strong><p>${esc(state.error)}</p><a class="btn" href="#/settings">Open Settings</a></div>`;
    else if (!docLink()) view.innerHTML = `<div class="card"><h2>Connect your plan</h2><p class="muted">Paste the link to your Running Plan Google Doc in Settings. It’s saved on this phone only.</p><a class="btn" href="#/settings">Open Settings</a></div>`;
    else view.innerHTML = '<p class="loading">Loading…</p>';
    if (tab === 'settings') view.innerHTML = settingsView();
    bindSettings();
    return;
  }
  $('#title').textContent = tab === 'week' ? `Week ${route[1]}` : state.plan.title;
  document.title = state.plan.title;
  if (tab === 'plan') view.innerHTML = planView();
  else if (tab === 'week') view.innerHTML = weekView(+route[1]);
  else if (tab === 'guide') view.innerHTML = guideView();
  else if (tab === 'settings') view.innerHTML = settingsView();
  else view.innerHTML = todayView();
  bindSettings();
  if (tab === 'week') { const t = view.querySelector('.day.is-today'); if (t && !render.scrolled) { t.scrollIntoView({ block: 'center' }); } }
}

function kindBadge(kind) { return `<span class="kind k-${kind}">${KIND_LABEL[kind]}</span>`; }
function shoeChip(shoe) {
  return shoe ? `<span class="shoe"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 16.5h16.5a1.5 1.5 0 0 0 1.5-1.5c0-1.7-1.6-2.4-3.4-2.9l-3.8-1-2.3-3.6H8.4L7.8 10 5 9.5 3 13z M3 16.5V19h18v-2.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>${esc(shoe)}</span>` : '';
}

function dayCard(d, opts = {}) {
  const t = today();
  const cls = ['day', 'k-' + d.kind];
  if (d.date && dayKey(d.date) === dayKey(t)) cls.push('is-today');
  else if (d.date && d.date < t) cls.push('is-past');
  if (d.done) cls.push('is-done');
  return `<div class="${cls.join(' ')}">
    <div class="day-head"><span class="day-label">${esc(d.date ? fmtDate(d.date) : d.label)}</span>${d.done ? '<span class="check" title="Done">✓</span>' : ''}${kindBadge(d.kind)}</div>
    <div class="workout${opts.big ? ' big' : ''}">${workoutHtml(d.html)}</div>
    ${shoeChip(d.shoe)}
  </div>`;
}

function todayView() {
  const t = today();
  const d = findDay(t);
  const days = allDays();
  let out = '';
  if (d) {
    out += `<p class="eyebrow">Today · Week ${d.week.num}${d.week.summary ? ' · ' + esc(d.week.summary) : ''}</p>`;
    out += `<div class="hero k-${d.kind}">${dayCard(d, { big: true })}</div>`;
  } else if (days.length && t < days[0].date) {
    out += `<div class="card"><p class="eyebrow">Not started yet</p><h2>The plan starts ${esc(fmtDate(days[0].date))}</h2><p class="muted">${daysBetween(t, days[0].date)} days to go.</p></div>`;
  } else if (days.length && t > days[days.length - 1].date) {
    out += `<div class="card"><p class="eyebrow">Plan complete</p><h2>The last day in the plan was ${esc(fmtDate(days[days.length - 1].date))}</h2><p class="muted">Ask Claude for the next block and update the doc.</p></div>`;
  } else {
    out += `<div class="card"><p class="eyebrow">Today</p><h2>No workout listed for ${esc(fmtDate(t))}</h2></div>`;
  }

  const race = nextRace();
  if (race) {
    const n = daysBetween(t, race.date);
    const name = race.text.split(/[.:(]/)[0].trim();
    out += `<a class="card race-card" href="#/week/${race.week.num}"><div class="race-n"><b>${n === 0 ? 'Today' : n}</b>${n === 0 ? '' : (n === 1 ? 'day' : 'days')}</div><div><p class="eyebrow">Next race</p><strong>${esc(name)}</strong><p class="muted">${esc(fmtDate(race.date))}</p></div></a>`;
  }

  const upcoming = days.filter((x) => x.date > t).slice(0, 3);
  if (upcoming.length) {
    out += '<h3 class="section-label">Coming up</h3>';
    out += upcoming.map((x) => dayCard(x)).join('');
  }
  const w = currentWeek();
  if (w) out += `<a class="btn wide" href="#/week/${w.num}">See all of Week ${w.num}</a>`;
  return out;
}

function weekStatus(w) {
  const t = today();
  if (!w.start) return '';
  if (t > w.end) return 'past';
  if (t >= w.start) return 'now';
  return 'next';
}

function planView() {
  let out = '', lastGroup = null;
  for (const w of state.plan.weeks) {
    if (w.group !== lastGroup) {
      if (w.group) {
        const g = state.plan.sections.find((s) => s.title === w.group);
        out += `<h3 class="group">${esc(w.group)}</h3>`;
        if (g && g.blocks.length) out += `<details class="card note"><summary>About these weeks</summary>${renderBlocks(g.blocks)}</details>`;
      }
      lastGroup = w.group;
    }
    const st = weekStatus(w);
    const dots = w.days.map((d) => `<i class="dot k-${d.kind}${d.done ? ' done' : ''}" title="${esc(d.label)}"></i>`).join('');
    out += `<a class="card week-card ${st}" href="#/week/${w.num}">
      <div class="wk-top"><span class="wk-num">Week ${w.num}</span>${st === 'now' ? '<span class="pill">This week</span>' : ''}</div>
      <div class="wk-range">${esc(w.range)}</div>
      ${w.summary ? `<div class="muted">${esc(w.summary)}</div>` : ''}
      <div class="dots">${dots}</div>
    </a>`;
  }
  return out;
}

function weekView(num) {
  const ws = state.plan.weeks;
  const i = ws.findIndex((w) => w.num === num);
  if (i < 0) return '<p class="empty">That week isn’t in the plan.</p>';
  const w = ws[i];
  let out = `<div class="week-head"><h2>${esc(w.range)}</h2>${w.summary ? `<p class="muted">${esc(w.summary)}</p>` : ''}${w.group ? `<p class="eyebrow">${esc(w.group)}</p>` : ''}</div>`;
  out += w.days.map((d) => dayCard(d)).join('');
  if (w.extra.length) out += `<div class="card">${renderBlocks(w.extra)}</div>`;
  out += '<div class="row-btns">';
  out += i > 0 ? `<a class="btn ghost" href="#/week/${ws[i - 1].num}">‹ Week ${ws[i - 1].num}</a>` : '<span></span>';
  out += i < ws.length - 1 ? `<a class="btn ghost" href="#/week/${ws[i + 1].num}">Week ${ws[i + 1].num} ›</a>` : '<span></span>';
  return out + '</div>';
}

function renderBlocks(blocks) {
  return blocks.map((b) => {
    if (b.type === 'h') return `<h4>${esc(b.text)}</h4>`;
    if (b.type === 'p') return `<p>${b.html}</p>`;
    if (b.type === 'list') { const t = b.ordered ? 'ol' : 'ul'; return `<${t}>${b.items.map((x) => `<li>${x}</li>`).join('')}</${t}>`; }
    if (b.type === 'table') {
      const [head, ...rows] = b.rows;
      return `<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    }
    return '';
  }).join('');
}

function guideView() {
  const p = state.plan;
  let out = p.intro.length ? `<div class="card intro">${renderBlocks(p.intro)}</div>` : '';
  const open = (() => { try { return JSON.parse(store.get('guideOpen') || '[]'); } catch { return []; } })();
  for (const s of p.sections) {
    if (s.isWeek || s.isGroup || (s.parent && s.parent.isGroup)) continue;
    // Fold sub-headings (h3) into their h2 section.
    if (s.level > 2 && s.parent) continue;
    const subs = p.sections.filter((x) => x.parent === s && !x.isWeek);
    const body = renderBlocks(s.blocks) + subs.map((x) => `<h4>${esc(x.title)}</h4>${renderBlocks(x.blocks)}`).join('');
    out += `<details class="card guide" data-key="${esc(s.title)}"${open.includes(s.title) ? ' open' : ''}><summary>${esc(s.title)}</summary><div class="guide-body">${body}</div></details>`;
  }
  return out;
}

function settingsView() {
  const link = docLink();
  const when = state.loadedAt ? new Date(state.loadedAt).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  let src;
  if (state.plan) src = `Your Google Doc${when ? ', last loaded ' + esc(when) : ''}. A copy is saved on this phone for when there’s no signal.`;
  else src = link ? 'Nothing loaded yet.' : 'No doc connected yet.';
  return `
  <div class="card">
    <h2>Google Doc</h2>
    <p class="muted">Paste the link to your Running Plan doc. In Google Docs, set <b>Share → General access</b> to <b>Anyone with the link</b>, as a <b>Viewer</b>. The link is saved on this phone only, never in the app’s code.</p>
    <form id="docform">
      <input id="doclink" type="url" inputmode="url" placeholder="https://docs.google.com/document/d/…" value="${esc(link)}" autocomplete="off">
      <div class="row-btns">
        <button class="btn" type="submit">Save</button>
        ${link ? `<a class="btn ghost" href="${esc(link)}" target="_blank" rel="noopener">Open doc</a>` : ''}
      </div>
    </form>
  </div>
  <div class="card">
    <h2>Showing</h2>
    <p>${src}</p>
    ${state.error ? `<p class="warn-text">${esc(state.error)}</p>` : ''}
    <button class="btn" id="reload"${link ? '' : ' hidden'}>${state.loading ? 'Checking…' : 'Check the plan for changes'}</button>
  </div>
  <div class="card">
    <h2>App</h2>
    <p class="muted">Version ${APP_VERSION}</p>
    <button class="btn ghost" id="update">Check for app updates</button>
  </div>`;
}

function bindSettings() {
  const f = $('#docform');
  if (f) f.onsubmit = (e) => {
    e.preventDefault();
    const v = $('#doclink').value.trim();
    if (v && !fetchUrl(v)) { toast('That doesn’t look like a link'); return; }
    if (v) store.set('docUrl', v); else store.del('docUrl');
    store.del('planHtml'); store.del('planLink'); state.plan = null; state.error = '';
    refresh(!!v);
  };
  const r = $('#reload'); if (r) r.onclick = () => refresh(true);
  const u = $('#update'); if (u) u.onclick = async () => {
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) await reg.update();
    } catch { /* offline */ }
    location.reload();
  };
  document.querySelectorAll('details.guide').forEach((d) => d.addEventListener('toggle', () => {
    const open = [...document.querySelectorAll('details.guide[open]')].map((x) => x.dataset.key);
    store.set('guideOpen', JSON.stringify(open));
  }));
}

// ---------- start ----------
window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
$('#back').addEventListener('click', () => { if (history.length > 1) history.back(); else location.hash = '#/plan'; });
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
  // A new version took over: reload once to show it (not on the very first install).
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloaded) { reloaded = true; location.reload(); } });
}
boot();
