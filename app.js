// Running Plan viewer.
// Loads the plan from Firebase (Firestore document plan/current, readable only by
// the signed-in owner). Works out today's
// workout, and shows the weeks and the guide. No build step, no Firebase SDK:
// it talks to Firebase's REST APIs directly.
// PRIVACY: this repository is public. The plan itself and the doc link never go
// in it; it lives in Firebase / on the phone only.
'use strict';

const APP_VERSION = 'r15'; // keep in step with VERSION in sw.js
// Firebase web config: public by design. The Firestore rules protect the data.
const FIREBASE = { apiKey: 'AIzaSyC3DjWnRYTlyKdMY_Y1tZrH0-3JNNkAg9U', projectId: 'traininghoster' };
const PLAN_DOC = `https://firestore.googleapis.com/v1/projects/${FIREBASE.projectId}/databases/(default)/documents/plan/current`;
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

// ---------- Firebase sign-in (email and password, REST API) ----------
const auth = {
  get() { try { return JSON.parse(store.get('auth') || 'null'); } catch { return null; } },
  save(a) { store.set('auth', JSON.stringify(a)); },
  email() { const a = this.get(); return a ? a.email : ''; },
  async call(url, body, form) {
    let r;
    try {
      r = await fetch(url, form
        ? { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    } catch { throw new Error('No signal, so you couldn’t be signed in. Try again with signal.'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const code = (j.error && j.error.message) || String(r.status);
      const err = new Error(/INVALID_LOGIN|INVALID_PASSWORD|EMAIL_NOT_FOUND|INVALID_EMAIL/.test(code) ? 'That email and password don’t match.'
        : /TOO_MANY/.test(code) ? 'Too many tries. Wait a few minutes, then try again.'
        : /USER_DISABLED/.test(code) ? 'This account is turned off in Firebase.'
        : 'Sign-in error: ' + code);
      err.code = code; throw err;
    }
    return j;
  },
  async signIn(email, password) {
    const j = await this.call(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE.apiKey}`, { email, password, returnSecureToken: true });
    this.save({ email: j.email, idToken: j.idToken, refreshToken: j.refreshToken, exp: Date.now() + (+j.expiresIn || 3600) * 1000 });
  },
  async token() {
    const a = this.get();
    if (!a) return null;
    if (Date.now() < a.exp - 120000) return a.idToken;
    try {
      const j = await this.call(`https://securetoken.googleapis.com/v1/token?key=${FIREBASE.apiKey}`, { grant_type: 'refresh_token', refresh_token: a.refreshToken }, true);
      this.save({ ...a, idToken: j.id_token, refreshToken: j.refresh_token, exp: Date.now() + (+j.expires_in || 3600) * 1000 });
      return j.id_token;
    } catch (e) {
      if (e.code && !/^\d+$/.test(e.code)) { this.signOut(); throw new Error('You’ve been signed out. Sign in again in Settings.'); }
      throw e;
    }
  },
  signOut() { store.del('auth'); },
  async resetPassword(email) {
    await this.call(`https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${FIREBASE.apiKey}`, { requestType: 'PASSWORD_RESET', email });
  },
};

// Reads plan/current. Returns null if nothing has been synced yet.
async function fetchFirebasePlan() {
  const tok = await auth.token();
  let r;
  try { r = await fetch(PLAN_DOC, { headers: { Authorization: 'Bearer ' + tok }, cache: 'no-store' }); } catch {
    throw new Error('No signal, so the plan couldn’t be checked for changes.');
  }
  if (r.status === 404) return null;
  if (r.status === 403) throw new Error(`Firebase won’t show the plan to ${auth.email()}. The email in the Firestore rules must match the one you signed in with.`);
  if (!r.ok) throw new Error('Firebase answered with error ' + r.status + '.');
  const j = await r.json();
  const f = j.fields || {};
  if (!f.html || typeof f.html.stringValue !== 'string') return null;
  return { html: f.html.stringValue, updatedAt: f.updatedAt ? Date.parse(f.updatedAt.timestampValue) : 0 };
}
// Asks Firebase only for the time of the last sync (a few bytes), so the app can
// check often and download the whole plan only when it has changed.
// Returns the time, 0 if nothing has been synced, or null if it couldn't tell.
async function fetchFirebaseStamp() {
  try {
    const tok = await auth.token();
    const r = await fetch(PLAN_DOC + '?mask.fieldPaths=updatedAt', { headers: { Authorization: 'Bearer ' + tok }, cache: 'no-store' });
    if (r.status === 404) return 0;
    if (!r.ok) return null;
    const f = (await r.json()).fields || {};
    return f.updatedAt ? Date.parse(f.updatedAt.timestampValue) : 0;
  } catch { return null; }
}
// Which login the saved copy on the phone belongs to, so a sign-out drops it.
const sourceKey = () => auth.email() + '|';

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
  // A table cell as separate paragraphs (list items become bullet paragraphs).
  function cellParas(td) {
    const out = [];
    const kids = [...td.children].filter((k) => /^(P|DIV|UL|OL|H[1-6])$/.test(k.tagName));
    if (!kids.length) { const h = inline(td).trim(); return h ? [{ html: h }] : []; }
    for (const k of kids) {
      if (k.tagName === 'UL' || k.tagName === 'OL') {
        for (const li of k.querySelectorAll('li')) { const h = inline(li).trim(); if (h) out.push({ html: h, bullet: true }); }
      } else { const h = inline(k).trim(); if (h) out.push({ html: h }); }
    }
    return out;
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
        const trs = [...c.querySelectorAll('tr')];
        const rows = trs.map((tr) => [...tr.children].map((td) => inline(td).trim()));
        const paras = trs.map((tr) => [...tr.children].map(cellParas));
        if (rows.length) blocks.push({ type: 'table', rows, paras });
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
      extra: s.blocks.filter((b) => b !== table && !(b.type === 'table' && /^week$/i.test(plain(b.rows[0][0] || '')))), days: [],
    };
    table.rows.slice(1).forEach((r, ri) => {
      const label = plain(r[0] || '');
      if (!label) return;
      const parts = splitDay(table.paras[ri + 1].slice(1).flat(), plain);
      const html = parts.plan.map((x) => x.html).join(' ');
      const dm = label.match(/(\d{1,2})\/(\d{1,2})/);
      week.days.push({ label, html, text: plain(html), parts, m: dm ? +dm[1] : null, d: dm ? +dm[2] : null, week });
    });
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
    for (const d of w.days) {
      const doneText = d.parts.done.map((x) => plain(x.html)).join(' ');
      // The type comes from the headline only, so words in the steps ("lower half") don't count.
      const headline = (d.parts.plan.find((x) => !x.bullet) || d.parts.plan[0] || { html: '' }).html;
      d.kind = kindOf(plain(headline) || d.text);
      d.done = !!doneText || /\bdone\b/i.test(d.text);
      // Skipped: something other than rest was planned, and the Done line says it didn't happen.
      d.missed = d.kind !== 'rest' && MISSED.test(doneText);
      const ownShoe = d.parts.shoe.map((x) => plain(x.html)).join(', ');
      d.shoe = ownShoe || shoeFor(plan, w.num, d);
    }
    const ds = w.days.filter((d) => d.date);
    w.start = ds.length ? ds[0].date : null;
    w.end = ds.length ? ds[ds.length - 1].date : null;
  }
  return plan;
}

// Labels a day's cell can use, one per paragraph ("Before: a light snack an hour ahead").
const LABELS = [
  ['plan', /^(plan|planned|workout)$/i],
  ['mind', /^(keep in mind|focus|notes?|tips?|cues?)$/i],
  ['before', /^(before|prep|ahead of time|the night before|pre-run)$/i],
  ['during', /^(during|fuel(ing)?|on the run)$/i],
  ['after', /^(after|recovery|post-run|stretch(es)?)$/i],
  ['done', /^(done|actual|did|result|what you did)$/i],
  ['review', /^(review|how it went|coach|take|feedback)$/i],
  ['rating', /^(rating|grade|verdict|score)$/i], // one word: Great, Good, OK, Tough
  ['shoe', /^(shoes?|wore|wearing)$/i], // overrides the shoe table for that day
];
const MISSED = /^\W*(skipped|missed|rested|didn[’']?t run|did not run|not done|rest instead)/i;
// Sorts a day's paragraphs by their labels. Unlabeled text belongs to the label
// above it (or to the plan). Older cells with "Done:" mid-sentence are split there.
function splitDay(paras, plain) {
  const parts = { plan: [], mind: [], before: [], during: [], after: [], done: [], review: [], shoe: [], rating: [] };
  let cur = 'plan';
  for (const p0 of paras) {
    let p = { ...p0 };
    // Old style: "... (done: 5 mi ...)" or "... Done: m:ss, ..." inside the plan text.
    if (cur === 'plan') {
      const m = p.html.match(/\s*\(?\b(done)\s*:\s*/i);
      if (m && m.index > 0) {
        const before = p.html.slice(0, m.index).trim(), after = p.html.slice(m.index + m[0].length).replace(/\)\s*$/, '').trim();
        if (before) parts.plan.push({ ...p, html: before });
        if (after) parts.done.push({ html: after });
        cur = 'done'; continue;
      }
    }
    const m = p.html.match(/^\s*(?:<strong>)?\s*([A-Za-z][A-Za-z’' -]{0,20}?)\s*(?:<\/strong>)?\s*:\s*(?:<\/strong>)?\s*/);
    const key = m && (LABELS.find(([, re]) => re.test(m[1].trim())) || [])[0];
    if (key) {
      cur = key;
      p.html = p.html.slice(m[0].length).replace(/^<\/strong>\s*/, '');
      if (!plain(p.html)) continue;
    }
    parts[cur].push(p);
  }
  return parts;
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

// ---------- state ----------
const state = { plan: null, source: 'none', loadedAt: 0, updatedAt: 0, error: '', loading: false, waiting: false };

function usePlan(html, source, at, updatedAt) {
  const plan = parsePlan(html);
  if (!plan.weeks.length) throw new Error('No weeks found in the plan. Each week needs a heading like "Week N: dates" followed by a Day / Workout table.');
  state.plan = plan; state.source = source; state.loadedAt = at || 0; state.updatedAt = updatedAt || 0;
  return plan;
}

async function refresh(manual) {
  if (!auth.get()) { state.plan = null; state.error = ''; state.waiting = false; render(); return; }
  state.loading = true; setStatus();
  const hadPlan = !!state.plan, before = state.updatedAt;
  let changed = false;
  try {
    const d = await fetchFirebasePlan();
    const html = d ? d.html : null, source = 'firebase', updatedAt = d ? d.updatedAt : 0;
    state.waiting = !html;
    if (!html) { state.plan = null; state.error = ''; return; } // signed in, nothing synced yet
    usePlan(html, source, Date.now(), updatedAt);
    changed = updatedAt !== before;
    store.set('planHtml', html); store.set('planAt', String(state.loadedAt));
    store.set('planUpdated', String(updatedAt)); store.set('planKey', sourceKey());
    state.error = '';
    if (changed && hadPlan) toast('Plan updated');
    else if (manual) toast('Up to date');
  } catch (e) {
    state.error = e.message || String(e);
    if (manual) toast('Couldn’t update the plan');
  } finally {
    state.loading = false; render();
  }
}

function boot() {
  store.del('docUrl'); // the old backup Google Doc link, no longer used
  const html = store.get('planHtml');
  // Only reuse the saved copy if it came from the same place.
  if (html && store.get('planKey') === sourceKey()) {
    try { usePlan(html, 'firebase', +store.get('planAt') || 0, +store.get('planUpdated') || 0); } catch { /* reload below */ }
  }
  render();
  refresh(false);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    render(); // the day may have changed
    quickCheck();
  });
  window.addEventListener('online', quickCheck);
  setInterval(() => { if (document.visibilityState === 'visible') quickCheck(); }, 2 * 60 * 1000);
}

// Picks up a new sync soon after it happens: whenever the app comes back on screen,
// when signal returns, and every 2 minutes while it's open. Each check is tiny.
let lastQuick = 0;
async function quickCheck() {
  if (state.loading || Date.now() - lastQuick < 20000) return;
  lastQuick = Date.now();
  if (!auth.get()) return;
  if (!state.plan || state.error) { refresh(false); return; }
  const stamp = await fetchFirebaseStamp();
  if (stamp === null) return; // no signal: keep the saved copy
  if (stamp !== state.updatedAt) refresh(false);
  else { state.loadedAt = Date.now(); store.set('planAt', String(state.loadedAt)); }
}

// ---------- status pill ----------
function setStatus() {
  const el = $('#sync');
  let cls = 'none', txt = 'Signed out';
  if (state.loading && !state.plan) { cls = 'pending'; txt = 'Loading'; }
  else if (state.plan) { cls = state.error ? 'offline' : 'ok'; txt = state.error ? 'Saved copy' : 'Synced'; }
  else if (state.error) { cls = 'error'; txt = 'Error'; }
  else if (state.waiting) { cls = 'pending'; txt = 'Waiting'; }
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
    else if (state.waiting) view.innerHTML = `<div class="card"><h2>Waiting for the first sync</h2><p class="muted">You’re signed in and everything is set up. Your plan appears here once Claude sends it: in Claude Code, ask it to <b>sync the plan</b>.</p></div>`;
    else if (!auth.get()) view.innerHTML = `<div class="card"><h2>Sign in to see your plan</h2><p class="muted">Use the email and password you added in Firebase.</p><a class="btn" href="#/settings">Sign in</a></div>`;
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

// ---------- a run's shape ----------
// A run is written as a short headline plus steps (bullets under the plan), e.g.
//   Hill session, 5 mi  /  • 1 mi easy  • 6 x 1 min hard with 2 min jog  • 1 mi easy
// Older one-line plans ("Title: 1 mi easy, 2 mi at m:ss, ...") are split the same way.
const txt = (h) => { const d = document.createElement('div'); d.innerHTML = h; return d.textContent.replace(/\s+/g, ' ').trim(); };
function stepAmount(t) { // rough length in "minutes" so the bar's pieces are in proportion
  const m = t.match(/(\d+(?:\.\d+)?)\s*(?:to\s*\d+(?:\.\d+)?\s*)?(mi\b|miles?|min\b|minutes?|km\b|k\b|m\b|sec|s\b)/i);
  if (!m) { const c = t.match(/^(\d+):(\d\d)\b/); return c ? +c[1] + c[2] / 60 : 0; }
  const n = +m[1], u = m[2].toLowerCase();
  if (u.startsWith('mi')) return u === 'min' || u.startsWith('minute') ? n : n * 11;
  if (u === 'km' || u === 'k') return n * 7;
  if (u === 'm') return n / 1609 * 11;
  if (u.startsWith('s')) return n / 60;
  return n;
}
function stepEffort(t) {
  if (/\b(walk|rest|standing|recover(y)? (jog|walk)|jog(\/walk)? between|between)\b/i.test(t) && !/\b(at|@)\s*\d/.test(t)) return 'rec';
  if (/\b(warm[- ]?up|cool[- ]?down|easy|recovery|conversational|jog)\b/i.test(t) && !/\b(at|@)\s*\d{1,2}:\d\d/.test(t)) return 'easy';
  if (/\b(fast|hard|sprint|strides?|5k pace|mile pace|max|all[- ]out|interval|rep)\b/i.test(t)) return 'hard';
  if (/\b(tempo|threshold|10k pace|race pace|cruise)\b/i.test(t)) return 'tempo';
  if (/\b(steady|progress|marathon pace|half pace|moderate)\b/i.test(t)) return 'steady';
  if (/\d{1,2}:\d\d/.test(t)) return 'pace';
  return 'easy';
}
const EFFORT_LABEL = { easy: 'Easy', steady: 'Steady', tempo: 'Tempo', hard: 'Hard', rec: 'Recover', pace: 'At pace' };
function runShape(plan) {
  const paras = plan.filter((x) => !x.bullet), bullets = plan.filter((x) => x.bullet);
  let head = paras[0] ? paras[0].html : '', notes = paras.slice(1).map((x) => x.html), steps = bullets.map((x) => x.html);
  if (!steps.length && head) {
    const t = txt(head);
    const m = t.match(/^([^:]{3,70}?):\s*(.+)$/);
    if (m) {
      let rest = m[2], tail = '';
      const end = rest.match(/^(.*?[^\d])\.\s+([A-Z].*)$/); // "... 1 mi easy. Go easy on rep 1." → note
      if (end) { rest = end[1]; tail = end[2]; }
      const parts = rest.replace(/\s*\(([^)]*)\)\s*$/, (a, b) => { tail = (b + (tail ? '. ' + tail : '')); return ''; })
        .split(/,\s*(?:then\s+|and\s+)?|\s+then\s+/).map((x) => x.trim()).filter(Boolean);
      if (parts.length >= 2 && parts.every((x) => /^(\d|\d?x\b|warm|cool|easy)/i.test(x))) {
        head = esc(m[1]); steps = parts.map(esc); if (tail) notes.unshift(esc(tail));
      }
    }
    if (!steps.length) { // split a long one-liner into headline + note at the first sentence
      const s2 = t.match(/^(.{8,80}?[^\d\s])\.\s+([A-Z(].*)$/);
      if (s2 && paras[0].html === esc(t)) { head = esc(s2[1]); notes.unshift(esc(s2[2])); }
    }
  }
  // Steps run at a given pace get warmer colors the faster the pace (when there are several).
  const secs = (t) => { const m = t.match(/\b(\d{1,2}):(\d\d)\b/); return m ? +m[1] * 60 + +m[2] : 0; };
  const paced = [...new Set(steps.map(txt).filter((t) => stepEffort(t) === 'pace').map(secs))].sort((a, b) => b - a);
  const effort = (t) => {
    const e = stepEffort(t);
    if (e !== 'pace' || paced.length < 2) return e;
    const i = paced.indexOf(secs(t));
    return i === 0 ? 'steady' : i === paced.length - 1 ? 'hard' : 'tempo';
  };
  // Pieces of the bar: repeats like "4 x N m at m:ss with m:ss jog" become 3 work + 2 recovery pieces.
  const pieces = [], efforts = steps.map((h) => effort(txt(h).replace(/^\d+\s*[x×]\s*/i, '').split(/\s+(?:with|w\/)\s+/i)[0]));
  // A bare number ("N" in "N, N, N mi at m:ss") shares the effort and unit of the step it leads into.
  for (let i = efforts.length - 2; i >= 0; i--) if (/^\d+(\.\d+)?$/.test(txt(steps[i]))) efforts[i] = efforts[i + 1];
  steps.forEach((h, si) => {
    const t = txt(h);
    const rep = t.match(/^(\d+)\s*[x×]\s*(.+)$/i);
    if (rep) {
      const n = Math.min(+rep[1], 20), [work, rec] = rep[2].split(/\s+(?:with|w\/)\s+/i);
      for (let i = 0; i < n; i++) {
        pieces.push({ e: efforts[si], a: stepAmount(work) || 3 });
        if (rec && i < n - 1) pieces.push({ e: 'rec', a: stepAmount(rec) || 1.5 });
      }
    } else pieces.push({ e: efforts[si], a: stepAmount(/^\d+(\.\d+)?$/.test(t) ? t + ' mi' : t) || 4 });
  });
  return { head, notes, steps, pieces, efforts };
}
function runShapeHtml(d, big) {
  const r = runShape(d.parts.plan);
  if (!r.head && !r.steps.length) return '<p class="muted">Nothing listed.</p>';
  let out = `<div class="run-head${big ? ' big' : ''}">${r.head}</div>`;
  if (r.steps.length >= 2 && d.kind !== 'rest') {
    const total = r.pieces.reduce((a, x) => a + x.a, 0) || 1;
    out += `<div class="shape" aria-hidden="true">${r.pieces.map((x) => `<i class="e-${x.e}" style="flex-grow:${(x.a / total * 100).toFixed(2)}"></i>`).join('')}</div>`;
  }
  if (r.steps.length) out += `<ol class="steps">${r.steps.map((h, i) => { const e = r.efforts[i]; return `<li><i class="e-${e}" title="${EFFORT_LABEL[e]}"></i><span>${h}</span></li>`; }).join('')}</ol>`;
  if (r.notes.length) out += `<div class="run-notes">${r.notes.map((h) => `<p>${h}</p>`).join('')}</div>`;
  return out;
}

// ---------- what you did, and the review ----------
// Splits text into sentences (not at decimals or times like m:ss).
function sentences(html) {
  return html.split(/(?<=[.!?])\s+(?=[A-Z(“"])/).map((x) => x.trim()).filter(Boolean);
}
// Pulls the numbers out of a run report's first sentence: "N mi in 50 min, HR N, m:ss pace".
const SPLITS = /^\s*((?:\d{1,2}:\d\d(?:\s*\([^)]*\))?\s*,\s*){2,}(?:and\s+)?\d{1,2}:\d\d(?:\s*\([^)]*\))?)\s*[,;:]?\s*/;
const SPLITS_ANY = /((?:\d{1,2}:\d\d(?:\s*\([^)]*\))?\s*(?:,\s*(?:and\s+)?|\s+and\s+)){2,}\d{1,2}:\d\d(?:\s*\([^)]*\))?)/;
function runStats(t) {
  const st = [];
  // Splits: "m:ss, m:ss, m:ss" or "m:ss (1 mi), m:ss (N), ..." at the start.
  // ...or anywhere in the sentence ("ladder of 1, N and N mi at m:ss, m:ss and m:ss").
  const splits = t.match(SPLITS) || t.match(SPLITS_ANY);
  if (splits) t = t.replace(splits[0], ' ');
  const dist = t.match(/(\d+(?:\.\d+)?)\s*(mi|miles|km)\b/i);
  const time = t.match(/\b(\d{1,2}:\d\d:\d\d)\b/) || t.match(/\bin\s+(\d+(?::\d\d)?)\s*min\b/i);
  const pace = t.match(/\b(\d{1,2}:\d\d)\s*(?:\/\s*mi|per mile|min\/mi|running pace|pace|average)\b/i);
  const hr = t.match(/\bHR\s*(?:of\s*|about\s*)?(\d{2,3}(?:\s*(?:to|-|–)\s*\d{2,3})?)/i) || t.match(/(?<!(?:to|-|–)\s*)\b(\d{2,3})\s*bpm\b/i);
  const peak = t.match(/\b(?:peak(?:ed)?|max(?:imum)?)\s*(?:HR|heart rate)?\s*(?:of|at)?\s*(\d{2,3})\b/i) || t.match(/\b(?:HR|heart rate)\s*peak(?:ed|ing)?\s*(?:at)?\s*(\d{2,3})\b/i);
  if (dist && !splits) st.push(['Distance', dist[1], dist[2].toLowerCase().startsWith('k') ? 'km' : 'mi']);
  if (time && !splits) st.push(['Time', time[1], time[1].split(':').length === 3 ? '' : 'min']);
  if (pace && !splits) st.push(['Pace', pace[1], '/mi']);
  if (peak) st.push(['Peak HR', peak[1], 'bpm']);
  else if (hr) st.push(['HR', hr[1].replace(/\s*(to|-|–)\s*/, '–'), 'bpm']);
  return { st, splits: splits ? splits[1].split(/\s*,\s*(?:and\s+)?|\s+and\s+/).map((x) => x.replace(/\s*\((.*)\)/, ' · $1')) : [], matched: [dist, time, pace, peak || hr, splits].filter(Boolean).map((m) => m[0]) };
}
function doneHtml(d) {
  const items = d.parts.done;
  if (!items.length) return '';
  let out = '', notes = [];
  if (!d.missed) {
    const first = sentences(items[0].html);
    const r = runStats(txt(first[0] || ''));
    if (r.st.length || r.splits.length) {
      if (r.st.length) out += `<div class="stats">${r.st.map(([k, v, u]) => `<div class="stat${v.length > 5 ? ' long' : ''}"><b>${esc(v)}<small>${u}</small></b><span>${k}</span></div>`).join('')}</div>`;
      if (r.splits.length) out += `<div class="splits"><span>Splits</span>${r.splits.map((x) => `<b>${esc(x)}</b>`).join('')}</div>`;
      // Drop the first sentence if it was only numbers (the tiles show them now).
      let left = txt(first[0]);
      for (const m of r.matched) left = left.replace(m, '');
      left = left.replace(/\b(in|at|about|with|and|rests?|running|pace|average|avg|HR|on|of)\b|[(),.;:–-]/gi, '').trim();
      // With splits, keep what follows them ("with m:ss rests, ...") as its own note.
      if (r.splits.length) {
        const after = first[0].replace(SPLITS, '');
        first[0] = after ? after[0].toUpperCase() + after.slice(1) : '';
        left = txt(first[0]).replace(/[(),.;:–-]/g, '').trim();
      }
      notes = (left.length > 14 ? first : first.slice(1)).concat(items.slice(1).flatMap((x) => x.bullet ? [x.html] : sentences(x.html)));
    }
  }
  if (!out) notes = items.flatMap((x) => x.bullet ? [x.html] : sentences(x.html));
  if (notes.length) out += notes.length > 1 ? `<ul class="notes">${notes.map((h) => `<li>${h}</li>`).join('')}</ul>` : `<p>${notes[0]}</p>`;
  return `<div class="part p-done${d.missed ? ' missed' : ''}"><h4>${d.missed ? 'Skipped' : 'What you did'}</h4>${out}</div>`;
}
function reviewHtml(d) {
  const items = d.parts.review;
  if (!items.length) return '';
  const all = items.flatMap((x) => x.bullet ? [{ h: x.html, b: true }] : sentences(x.html).map((h) => ({ h })));
  const [lead, ...rest] = all;
  return `<div class="part p-review"><h4>Review</h4><p class="verdict">${lead.h}</p>${rest.length ? `<ul class="notes">${rest.map((x) => `<li>${x.h}</li>`).join('')}</ul>` : ''}</div>`;
}
const RATING = [[/^(great|excellent|strong|perfect|awesome|crushed)/i, 'great'], [/^(good|solid|nice|fine)/i, 'good'], [/^(ok|okay|mixed|average|fair)/i, 'ok'], [/^(tough|rough|hard|poor|bad|struggle)/i, 'tough']];
function ratingPill(d) {
  const t = d.parts.rating.map((x) => txt(x.html)).join(' ').trim();
  if (!t) return '';
  const k = (RATING.find(([re]) => re.test(t)) || [, 'ok'])[1];
  return `<span class="rating r-${k}">${esc(t.split(/[.,;(]/)[0].slice(0, 20))}</span>`;
}

// One day, with everything the doc says about it. Days that haven't happened
// show how to get ready; finished days show the plan next to what happened,
// then the review.
const PART_TITLE = { mind: 'Keep in mind', before: 'Before', during: 'During', after: 'After', done: 'What you did', review: 'Review' };
function paraList(items) {
  let out = '', ul = '';
  for (const x of items) {
    if (x.bullet) { ul += `<li>${x.html}</li>`; continue; }
    if (ul) { out += `<ul>${ul}</ul>`; ul = ''; }
    out += `<p>${x.html}</p>`;
  }
  return out + (ul ? `<ul>${ul}</ul>` : '');
}
function dayCard(d, opts = {}) {
  const t = today();
  const isToday = d.date && dayKey(d.date) === dayKey(t);
  const past = d.date && d.date < t && !isToday;
  const cls = ['day', 'k-' + d.kind];
  if (isToday) cls.push('is-today');
  if (d.done) cls.push('is-done');
  if (d.missed) cls.push('is-missed');
  const p = d.parts;
  const section = (key, extra = '') => p[key].length ? `<div class="part p-${key}${extra}"><h4>${PART_TITLE[key]}</h4>${paraList(p[key])}</div>` : '';
  let body = `<div class="part p-plan">${d.done || past ? '<h4>Planned</h4>' : ''}<div class="workout">${runShapeHtml(d, opts.big)}</div></div>`;
  if (d.done) {
    body += doneHtml(d) + reviewHtml(d);
  } else if (!past) {
    body += section('mind') + section('before') + section('during') + section('after');
  } else body += reviewHtml(d);
  const status = d.missed ? '<span class="status missed">Skipped</span>' : d.done ? '<span class="status ok">✓ Done</span>' : '';
  return `<div class="${cls.join(' ')}">
    <div class="day-head"><span class="day-label">${opts.title ? `${esc(opts.title)} · ` : ''}${esc(d.date ? fmtDate(d.date) : d.label)}</span>${status}${ratingPill(d)}${kindBadge(d.kind)}</div>
    ${body}
    ${shoeChip(d.shoe)}
  </div>`;
}

// Upcoming: today and tomorrow, in full.
function todayView() {
  const t = today();
  const tm = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1);
  const days = allDays();
  const d = findDay(t), n = findDay(tm);
  let out = '';
  if (!days.length) return '<p class="empty">No days in the plan yet.</p>';
  if (t < days[0].date) {
    out += `<div class="card"><p class="eyebrow">Not started yet</p><h2>The plan starts ${esc(fmtDate(days[0].date))}</h2><p class="muted">${daysBetween(t, days[0].date)} days to go.</p></div>`;
  } else if (t > days[days.length - 1].date) {
    return `<div class="card"><p class="eyebrow">Plan complete</p><h2>The last day in the plan was ${esc(fmtDate(days[days.length - 1].date))}</h2><p class="muted">Ask Claude for the next block and update the doc.</p></div>`;
  }
  out += '<h3 class="section-label">Today</h3>';
  out += d ? `<div class="hero">${dayCard(d, { big: true })}</div>` : `<div class="card"><p class="muted">Nothing listed for ${esc(fmtDate(t))}.</p></div>`;
  out += '<h3 class="section-label">Tomorrow</h3>';
  out += n ? dayCard(n) : `<div class="card"><p class="muted">Nothing listed for ${esc(fmtDate(tm))}.</p></div>`;
  const w = d ? d.week : currentWeek();
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
    // A rest counts as done once its day has passed (rests rarely get a Done line).
    const t = today();
    const dots = w.days.map((d) => `<i class="dot k-${d.kind}${d.missed ? ' missed' : d.done || (d.kind === 'rest' && d.date && d.date < t) ? ' done' : ''}" title="${esc(d.label)}${d.missed ? ': skipped' : ''}"></i>`).join('');
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

// Guide: just the short sections. Everything else in the doc stays there for
// Claude's own use and isn't shown.
const GUIDE = [/^(summary|overview|in short|breakdown)\b/i, /^highlights?\b/i, /^goals?\b/i];
function guideView() {
  const secs = state.plan.sections.filter((s) => !s.isWeek && !s.isGroup);
  let out = '';
  for (const re of GUIDE) {
    const s = secs.find((x) => re.test(x.title));
    if (!s) continue;
    const subs = secs.filter((x) => x.parent === s);
    out += `<div class="card guide"><h2>${esc(s.title)}</h2><div class="guide-body">${renderBlocks(s.blocks)}${subs.map((x) => `<h4>${esc(x.title)}</h4>${renderBlocks(x.blocks)}`).join('')}</div></div>`;
  }
  return out || '<div class="card"><p class="muted">Nothing here yet. The Guide shows the doc’s <b>Summary</b>, <b>Highlights</b> and <b>Goals and odds</b> sections.</p></div>';
}

function settingsView() {
  const email = auth.email();
  const signIn = email
    ? `<p>Signed in as <b>${esc(email)}</b>.</p><button class="btn ghost" id="signout">Sign out</button>`
    : `<form id="signin">
        <input id="email" type="email" autocomplete="username" placeholder="Email" required>
        <input id="password" type="password" autocomplete="current-password" placeholder="Password" required>
        <div class="row-btns"><button class="btn" type="submit">Sign in</button><button class="linkbtn" type="button" id="forgot">Forgot password?</button></div>
      </form>`;
  return `
  <div class="card">
    <h2>Your account</h2>
    ${signIn}
  </div>
  <div class="card">
    <h2>App</h2>
    <p class="muted">Version ${APP_VERSION}</p>
    ${state.error ? `<p class="warn-text">${esc(state.error)}</p>` : ''}
    <button class="btn" id="update"${state.loading ? ' disabled' : ''}>${state.loading ? 'Checking…' : 'Check for updates'}</button>
  </div>`;
}

function bindSettings() {
  const si = $('#signin');
  if (si) si.onsubmit = async (e) => {
    e.preventDefault();
    const btn = si.querySelector('button[type=submit]'); btn.disabled = true; btn.textContent = 'Signing in…';
    try {
      await auth.signIn($('#email').value.trim(), $('#password').value);
      store.del('planHtml'); state.plan = null; state.error = '';
      toast('Signed in');
      location.hash = '#/';
      refresh(false);
    } catch (err) { toast(err.message); btn.disabled = false; btn.textContent = 'Sign in'; }
  };
  const fg = $('#forgot');
  if (fg) fg.onclick = async () => {
    const em = $('#email').value.trim();
    if (!em) { toast('Type your email first'); return; }
    try { await auth.resetPassword(em); toast('Check your email for a reset link'); } catch (err) { toast(err.message); }
  };
  const so = $('#signout');
  if (so) so.onclick = () => {
    auth.signOut(); store.del('planHtml'); state.plan = null; state.error = '';
    toast('Signed out'); refresh(false);
  };
  // One button: checks the plan for changes, and the app itself for a new version
  // (a new version installs and the page reloads into it by itself).
  const u = $('#update'); if (u) u.onclick = async () => {
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) reg.update().catch(() => {});
    } catch { /* offline */ }
    if (auth.get()) refresh(true); else toast('Sign in first');
  };
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
