// Running Plan viewer.
// Loads the plan from Firebase (Firestore document plan/current, readable only by
// the signed-in owner). Works out today's
// workout, and shows the weeks and the guide. No build step, no Firebase SDK:
// it talks to Firebase's REST APIs directly.
// PRIVACY: this repository is public. The plan itself and the doc link never go
// in it; it lives in Firebase / on the phone only.
'use strict';

const APP_VERSION = 'r43'; // keep in step with VERSION in sw.js
// Firebase web config: public by design. The Firestore rules protect the data.
const FIREBASE = { apiKey: 'AIzaSyC3DjWnRYTlyKdMY_Y1tZrH0-3JNNkAg9U', projectId: 'traininghoster' };
const PLAN_DOC = `https://firestore.googleapis.com/v1/projects/${FIREBASE.projectId}/databases/(default)/documents/plan/current`;
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
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
  // ?today=YYYY-MM-DD lets you preview another day.
  const q = new URLSearchParams(location.search).get('today');
  if (q && /^\d{4}-\d{1,2}-\d{1,2}$/.test(q)) { const [y, m, d] = q.split('-').map(Number); return new Date(y, m - 1, d); }
  return startOfDay(new Date());
}

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), ms);
}

// A yes/no question in the app's own style (like the recipe app). Resolves true for OK.
function confirmDialog(text, okLabel, sub = '') {
  const dlg = $('#confirm');
  $('#confirm-text').textContent = text; $('#confirm-sub').textContent = sub; $('#confirm-ok').textContent = okLabel;
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
    dlg.returnValue = ''; dlg.showModal();
  });
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
    takeRecap(week, plain);
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

// Week recap: paragraphs under a week's table starting "Recap:" (plus any bullets
// or plain paragraphs right after it) and "Rating:". They show at the top of the week.
const RECAP = /^\s*(?:<strong>)?\s*(recap|week recap|how the week went|week review)\s*(?:<\/strong>)?\s*:\s*(?:<\/strong>)?\s*/i;
const WEEK_RATING = /^\s*(?:<strong>)?\s*(rating|week rating)\s*(?:<\/strong>)?\s*:\s*(?:<\/strong>)?\s*/i;
function takeRecap(week, plain) {
  week.recap = []; week.rating = '';
  const keep = [];
  let inRecap = false;
  for (const b of week.extra) {
    if (b.type === 'p' && WEEK_RATING.test(b.html)) { week.rating = plain(b.html.replace(WEEK_RATING, '')); inRecap = false; continue; }
    if (b.type === 'p' && RECAP.test(b.html)) {
      inRecap = true;
      const h = b.html.replace(RECAP, '').trim();
      if (plain(h)) week.recap.push({ html: h });
      continue;
    }
    if (inRecap && b.type === 'list') { week.recap.push(...b.items.map((h) => ({ html: h, bullet: true }))); continue; }
    if (inRecap && b.type === 'p' && !/^\s*(?:<strong>)?[A-Za-z][A-Za-z ]{0,24}(?:<\/strong>)?\s*:/.test(b.html)) { week.recap.push({ html: b.html }); continue; }
    inRecap = false;
    keep.push(b);
  }
  week.extra = keep;
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
  ['actual', /^(steps|step by step|by step|laps|step log)$/i], // one bullet per planned step, in order: what actually happened
  ['rating', /^(rating|grade|verdict|score)$/i], // one word: Great, Good, OK, Tough
  ['shoe', /^(shoes?|wore|wearing)$/i], // overrides the shoe table for that day
];
const MISSED = /^\W*(skipped|missed|rested|didn[’']?t run|did not run|not done|rest instead)/i;
// Sorts a day's paragraphs by their labels. Unlabeled text belongs to the label
// above it (or to the plan). Older cells with "Done:" mid-sentence are split there.
function splitDay(paras, plain) {
  const parts = { plan: [], mind: [], before: [], during: [], after: [], done: [], review: [], shoe: [], rating: [], actual: [] };
  let cur = 'plan';
  for (const p0 of paras) {
    let p = { ...p0 };
    // Old style: "... (done: N mi ...)" or "... Done: m:ss, ..." inside the plan text.
    if (cur === 'plan') {
      const m = p.html.match(/\s*\(?\b(done)\s*:\s*/i);
      const lead = p.html.match(/^\s*(?:<[^>]+>\s*)*/)[0].length; // a "Done:" label at the start (even in bold) isn't mid-text
      if (m && m.index > lead) {
        const before = p.html.slice(0, m.index).trim(), after = p.html.slice(m.index + m[0].length).replace(/\)\s*$/, '').trim();
        if (plain(before)) parts.plan.push({ ...p, html: before });
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

// Loads the plan. quiet: no messages (the update button says its own). Returns { changed, failed }.
async function refresh(manual, quiet) {
  if (!auth.get()) { state.plan = null; state.error = ''; state.waiting = false; render(); return { changed: false, failed: false }; }
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
    if (!quiet && changed && hadPlan) toast('Plan updated');
    else if (!quiet && manual) toast('Everything’s up to date');
    return { changed: changed && hadPlan, failed: false };
  } catch (e) {
    state.error = e.message || String(e);
    if (!quiet && manual) toast('Couldn’t update the plan');
    return { changed: false, failed: true };
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
  render(); scrollForRoute();
  if (store.get('justUpdated')) { store.del('justUpdated'); setTimeout(() => toast('Up to Date!', 3000), 300); }
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
function ago(t) {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 60 ? Math.max(m, 1) + ' min old' : m < 48 * 60 ? Math.round(m / 60) + ' h old' : Math.round(m / 1440) + ' days old';
}
function setStatus() {
  const el = $('#sync');
  let cls = 'none', txt = 'Signed out';
  if (state.loading && !state.plan) { cls = 'pending'; txt = 'Loading'; }
  else if (state.plan) { cls = state.error ? 'offline' : 'ok'; txt = state.error ? 'Saved copy' + (state.loadedAt ? ' · ' + ago(state.loadedAt) : '') : 'Synced'; }
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

}

function kindBadge(kind) { return `<span class="kind k-${kind}">${KIND_LABEL[kind]}</span>`; }
function shoeChip(shoe) {
  return shoe ? `<span class="shoe"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 16.5h16.5a1.5 1.5 0 0 0 1.5-1.5c0-1.7-1.6-2.4-3.4-2.9l-3.8-1-2.3-3.6H8.4L7.8 10 5 9.5 3 13z M3 16.5V19h18v-2.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>${esc(shoe)}</span>` : '';
}

// ---------- a run's shape ----------
// A run is written as a short headline plus steps (bullets under the plan), e.g.
//   Headline, N mi  /  • N mi easy  • N x N min hard with N min jog  • N mi easy
// Older one-line plans ("Title: N mi easy, N mi at m:ss, ...") are split the same way.
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
  t = t.replace(/\([^)]*\)/g, ' '); // notes in brackets ("optional if rep 4 felt good") don't change the effort
  // An effort word wins, even when the step also gives a pace ("N mi easy at m:ss" is easy).
  // Only steps with no effort word are colored by how fast their pace is.
  if (/\b(walk|rest|standing|recover(y)? (jog|walk)|jog(\/walk)? between|between)\b/i.test(t)) return 'rec';
  if (/\b(warm[- ]?up|cool[- ]?down|easy|recovery|conversational|jog)\b/i.test(t)) return 'easy';
  if (/\b(fast|hard|sprint|strides?|5k pace|mile pace|max|all[- ]out|interval|rep)\b/i.test(t)) return 'hard';
  if (/\b(tempo|threshold|10k pace|race pace|cruise)\b/i.test(t)) return 'tempo';
  if (/\b(steady|progress|marathon pace|half pace|moderate)\b/i.test(t)) return 'steady';
  if (/\d{1,2}:\d\d/.test(t)) return 'pace';
  return 'easy';
}
// Where a repeat's recovery starts: "N x N mi hard with N min jog" or "N x N mi hard, N min walk between".
const RECOVERY_SPLIT = /\s+(?:with|w\/)\s+|,\s*(?=[^,]*\b(?:walk|jog|rest|recover\w*)\b[^,]*$)/i;
const BETWEEN = /\b(between (?:reps|repeats|intervals|sets|each)|between)\b/i;
const MIDWAY = /\b(half[- ]?way|mid[- ]?way|midpoint|middle)\b/i;
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
  // Pieces of the bar: repeats like "N x N m at m:ss with m:ss jog" become N work pieces with a recovery piece between each.
  let between = null;
  const pieces = [], efforts = steps.map((h) => effort(txt(h).replace(/^\d+\s*[x×]\s*/i, '').split(RECOVERY_SPLIT)[0]));
  // A bare number (the middle ones in "a, b, c mi at m:ss") shares the effort and unit of the step it leads into.
  for (let i = efforts.length - 2; i >= 0; i--) if (/^\d+(\.\d+)?$/.test(txt(steps[i]))) efforts[i] = efforts[i + 1];
  steps.forEach((h, si) => {
    let t = txt(h);
    // "N mi at m:ss, three times" is the same as "3 x N mi at m:ss".
    const { n, base } = timesOf(t);
    if (n > 1) { for (let i = 0; i < n; i++) pieces.push({ e: efforts[si], a: stepAmount(base) || 3, rep: !!(paceIn(base) && milesIn(base)) }); return; }
    const rep = t.match(/^(\d+)\s*[x×]\s*(.+)$/i);
    if (rep) {
      const n = Math.min(+rep[1], 20), [work, rec] = rep[2].split(RECOVERY_SPLIT);
      for (let i = 0; i < n; i++) {
        pieces.push({ e: efforts[si], a: stepAmount(work) || 3 });
        if (rec && i < n - 1) pieces.push({ e: 'rec', a: stepAmount(rec) || 1.5 });
      }
    } else if (BETWEEN.test(t) && !paceIn(t)) {
      between = { e: 'rec', a: stepAmount(t) || 1.5 }; // drawn between the reps below, not where it's listed
    } else if (MIDWAY.test(t) && pieces.length) {
      // "Walk break near halfway": split the longest piece so far and put the break in the middle.
      let k = 0; pieces.forEach((x, i) => { if (x.a > pieces[k].a) k = i; });
      const half = pieces[k].a / 2;
      pieces.splice(k, 1, { ...pieces[k], a: half }, { e: efforts[si], a: stepAmount(t) || 1.5 }, { ...pieces[k], a: half });
    } else pieces.push({ e: efforts[si], a: stepAmount(/^\d+(\.\d+)?$/.test(t) ? t + ' mi' : t) || 4, rep: !!(paceIn(t) && milesIn(t)) });
  });
  // "N sec walk between reps": one recovery piece between each pair of reps.
  if (between) {
    for (let i = pieces.length - 2; i >= 0; i--) if (pieces[i].rep && pieces[i + 1].rep) pieces.splice(i + 1, 0, { ...between });
  }
  return { head, notes, steps, pieces, efforts };
}
// ---------- how long a run will take ----------
// Pace written in a step: "at m:ss" or "at m:ss to m:ss" (the middle of the range).
function paceIn(t) {
  const m = t.match(/\b(?:at|@)\s*(\d{1,2}):(\d\d)(?:\s*(?:to|-|–)\s*(\d{1,2}):(\d\d))?/i);
  if (!m) return 0;
  const a = +m[1] + m[2] / 60;
  return m[3] ? (a + +m[3] + m[4] / 60) / 2 : a;
}
// Minutes for one step, or null when it can't be told ("cool-down until HR is below N").
function stepMinutes(t) {
  const sec = t.match(/(\d+)\s*(?:sec|s)\b/i), min = t.match(/(\d+(?:\.\d+)?)\s*(?:to\s*\d+\s*)?min\b/i), clock = t.match(/^(\d{1,2}):(\d\d)\b/);
  if (min) return +min[1];
  if (clock) return +clock[1] + clock[2] / 60;
  if (sec) return sec[1] / 60;
  const mi = milesIn(t);
  return mi ? mi * (paceIn(t) || easyPace()) : null;
}
// "N mi at m:ss, three times" → { n: 3, base: "N mi at m:ss" }.
function timesOf(t) {
  const m = t.match(/,?\s*\(?(?:x\s*)?(two|three|four|five|six|seven|eight|\d+)\s*(?:times|x)\)?\s*$/i);
  if (!m || /^\d+\s*[x×]/i.test(t)) return { n: 1, base: t };
  const n = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 }[m[1].toLowerCase()] || +m[1];
  return n > 1 && n <= 20 ? { n, base: t.slice(0, m.index) } : { n: 1, base: t };
}
// Estimated time for a run written in miles, or distance for one written in minutes.
function estimate(d) { return d.done ? null : planEstimate(d); }
// Planned minutes for any day (finished or not); 0 for rests or when it can't be told.
function plannedMinutes(d) { const e = planEstimate(d); return e ? e.mins || 0 : 0; }
const fmtDur = (m) => { m = Math.round(m); return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` : `${m} min`; };
function planEstimate(d) {
  if (d.kind === 'rest') return null;
  const steps = d.parts.plan.filter((x) => x.bullet).map((x) => txt(x.html));
  if (!steps.length) {
    const h = headlineOf(d), mi = milesIn(h), mn = minutesIn(h);
    if (mi && !mn) return { mins: mi * easyPace(), byDistance: true, extra: '' };
    if (mn && !mi) return { miles: mn / easyPace(), mins: mn, byDistance: false, extra: '' };
    return null;
  }
  const reps = steps.filter((t) => paceIn(t) && milesIn(t) && !/^\d+\s*[x×]/i.test(t)).reduce((a, t) => a + timesOf(t).n, 0);
  let mins = 0, byDistance = false, extra = '';
  for (const t of steps) {
    const rp = t.match(/^(\d+)\s*[x×]\s*(.+)$/i);
    if (rp) {
      const [work, rec] = rp[2].split(RECOVERY_SPLIT);
      const wm = stepMinutes(work), rm = rec ? stepMinutes(rec) || 0 : 0;
      if (wm !== null) mins += +rp[1] * wm + (+rp[1] - 1) * rm;
      if (milesIn(work)) byDistance = true;
      continue;
    }
    if (/\bbetween\b/i.test(t) && !paceIn(t)) { const m = stepMinutes(t); if (m) mins += m * Math.max(reps - 1, 0); continue; }
    const tm = timesOf(t);
    const m = stepMinutes(tm.base) === null ? null : stepMinutes(tm.base) * tm.n;
    if (m === null) {
      if (/cool[- ]?down/i.test(t)) extra = 'cool-down';
      else if (/warm[- ]?up/i.test(t)) extra = extra || 'warm-up';
      continue; // gels, drills and other notes take no time of their own
    }
    if (milesIn(t) && !/\bmin\b/i.test(t)) byDistance = true;
    mins += m;
  }
  if (!mins) return null;
  return byDistance ? { mins, byDistance, extra } : { miles: plannedMiles(d) || mins / easyPace(), mins, byDistance, extra };
}
function estimateHtml(d) {
  const e = estimate(d);
  if (!e) return '';
  const fmtMins = (m) => { m = Math.round(m / 5) * 5; return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60 ? String(m % 60).padStart(2, '0') + ' min' : ''}`.trim() : `${m} min`; };
  const text = e.byDistance ? `About ${fmtMins(e.mins)}${e.extra ? ' plus ' + e.extra : ''}` : `About ${r1(e.miles)} mi`;
  return `<div class="estimate"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="13" r="8" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 9v4l2.5 2M9.5 3h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>${esc(text)}</div>`;
}

// ---------- heart rate per step ----------
// A step's heart-rate target: "at HR a to b", "(HR about a to b)", "HR below N", "HR about N".
function hrTarget(t) {
  let m = t.match(/\bHR\s*(?:of\s*|about\s*|around\s*)?(\d{2,3})\s*(?:to|-|–)\s*(\d{2,3})/i);
  if (m) return { lo: +m[1], hi: +m[2], label: `${m[1]}–${m[2]}` };
  m = t.match(/\bHR\s*(?:is\s*|stays?\s*)?(?:below|under)\s*(\d{2,3})/i);
  if (m) return { lo: 0, hi: +m[1], label: `under ${m[1]}` };
  m = t.match(/\bHR\s*(?:is\s*)?(?:above|over)\s*(\d{2,3})/i);
  if (m) return { lo: +m[1], hi: 999, label: `over ${m[1]}` };
  m = t.match(/\bHR\s*(?:about|around|~)\s*(\d{2,3})\b/i);
  if (m) return { lo: +m[1] - 5, hi: +m[1] + 5, label: `~${m[1]}` };
  return null;
}
// The step's text without its heart-rate phrase, when that phrase is just a target ("at HR a to b").
function withoutHr(h) {
  return h.replace(/\s*\((?:HR|heart rate)[^)]*\)/i, '').replace(/\s*(?:,\s*|\bat\s+|\bwith\s+)(?:HR|heart rate)\s*(?:of\s*|about\s*)?\d{2,3}\s*(?:to|-|–)\s*\d{2,3}(?:\s*bpm)?/i, '').trim();
}
// Actual heart rate in a step-by-step log line: "N mi in m:ss, HR N" (or "avg HR N", "N bpm").
function hrActual(t) {
  const m = t.match(/\b(?:avg\.?\s*|average\s*)?HR\s*(?:of\s*|avg\s*)?(\d{2,3})(?!\s*(?:to|-|–)\s*\d)/i) || t.match(/\b(?:avg|average)\s*(?:HR\s*)?(\d{2,3})\b/i) || t.match(/\b(\d{2,3})\s*bpm\b/i);
  return m ? +m[1] : 0;
}
// The low-to-high heart rate during a logged step: "HR avg, range low to high" or "HR avg (low-high)".
function hrRange(t) {
  const m = t.match(/\brange\s*(?:of\s*)?(\d{2,3})\s*(?:to|-|–)\s*(\d{2,3})/i) || t.match(/\(\s*(\d{2,3})\s*(?:to|-|–)\s*(\d{2,3})\s*\)/) || t.match(/\bHR\s*(\d{2,3})\s*(?:to|-|–)\s*(\d{2,3})/i);
  return m ? `${m[1]}–${m[2]}` : '';
}
const heart = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.5s-7.5-4.6-7.5-10.1A4.2 4.2 0 0 1 12 7.6a4.2 4.2 0 0 1 7.5 2.8c0 5.5-7.5 10.1-7.5 10.1z" fill="currentColor"/></svg>';
// Did the step go as planned in amount? (the same miles, or the same minutes, as planned)
function sameAmount(planT, actT) {
  const pm = milesIn(planT), am = milesIn(actT);
  if (pm && am) return Math.abs(pm - am) < 0.05;
  const pn = minutesIn(planT), an = minutesIn(actT);
  return !!(pn && an && pn === an);
}
// One step. Upcoming: its heart-rate target as a chip. Finished (with a step log): the average heart
// rate as the chip (green in range, amber out), the result only when it differs from the plan, and a
// tap to see the target and the full result.
function stepRow(h, e, actualHtml) {
  const t = txt(h), target = hrTarget(t);
  const shown = target ? withoutHr(h) : h;
  const targetChip = target && shown !== h ? `<span class="hr" title="Heart-rate target">${heart}${esc(target.label)}</span>` : '';
  if (actualHtml === undefined) {
    return `<li><i class="e-${e}" title="${EFFORT_LABEL[e]}"></i><div class="step"><div class="plan-line"><span>${shown}</span>${targetChip}</div></div></li>`;
  }
  const at = txt(actualHtml), a = hrActual(at);
  const ok = target && a ? a >= target.lo && a <= target.hi : null;
  const range = hrRange(at);
  const aText = (a ? actualHtml.replace(/\s*,?\s*range\s*(?:of\s*)?\d{2,3}\s*(?:to|-|–)\s*\d{2,3}/i, '').replace(/\s*\(\s*\d{2,3}\s*(?:to|-|–)\s*\d{2,3}\s*\)/, '').replace(/\s*,?\s*(?:avg\.?\s*|average\s*)?HR\s*(?:of\s*|avg\s*)?\d{2,3}(?!\s*(?:to|-|–)\s*\d)(?:\s*avg)?/i, '') : actualHtml).replace(/^[,;\s]+|[,;\s]+$/g, '');
  const avgChip = a ? `<span class="hr ${ok === null ? '' : ok ? 'in' : 'out'}" title="Average heart rate${ok === null ? '' : ok ? ', in the target range' : ', outside the target range'}">${heart}${a}</span>` : targetChip;
  const differs = aText && !sameAmount(t, txt(aText));
  const more = [
    range ? `<div><span>Range</span><span class="hr">${heart}${esc(range)}</span></div>` : '',
    target ? `<div><span>Target</span><span class="hr">${heart}${esc(target.label)}</span></div>` : '',
  ].join('');
  if (!more) return `<li><i class="e-${e}" title="${EFFORT_LABEL[e]}"></i><div class="step"><div class="plan-line"><span>${shown}</span>${avgChip}</div>${differs ? `<div class="actual"><span class="did">${aText}</span></div>` : ''}</div></li>`;
  return `<li class="has-actual" tabindex="0" role="button" aria-expanded="false"><i class="e-${e}" title="${EFFORT_LABEL[e]}"></i><div class="step"><div class="plan-line"><span>${shown}</span>${avgChip}</div>${more ? `<div class="step-more">${more}</div>` : ''}${differs ? `<div class="actual"><span class="did">${aText}</span></div>` : ''}</div></li>`;
}
// Tap (or Enter) on a finished step opens its target and full result.
function toggleStep(li) { const o = li.classList.toggle('open'); li.setAttribute('aria-expanded', o); }
document.addEventListener('click', (e) => { const li = e.target.closest('.steps li.has-actual'); if (li && !e.target.closest('a')) toggleStep(li); });
document.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('.steps li.has-actual')) { e.preventDefault(); toggleStep(e.target); } });

function runShapeHtml(d, big, noHead) {
  const r = runShape(d.parts.plan);
  if (!r.head && !r.steps.length) return '<p class="muted">Nothing listed.</p>';
  let out = noHead ? '' : `<div class="run-head${big ? ' big' : ''}">${r.head}</div>${estimateHtml(d)}`;
  if (r.steps.length >= 2 && d.kind !== 'rest') {
    const total = r.pieces.reduce((a, x) => a + x.a, 0) || 1;
    out += `<div class="shape" aria-hidden="true">${r.pieces.map((x) => `<i class="e-${x.e}" style="flex-grow:${(x.a / total * 100).toFixed(2)}"></i>`).join('')}</div>`;
  }
  // Finished runs with a step-by-step log ("Steps:" bullets, in order) show each step's result under it.
  const log = d.done ? d.parts.actual.map((x) => x.html) : [];
  if (r.steps.length) out += `<ol class="steps${log.length ? ' with-actual' : ''}">${r.steps.map((h, i) => stepRow(h, r.efforts[i], log.length ? (log[i] ?? '') : undefined)).join('')}</ol>`;
  if (log.length > r.steps.length) out += `<ul class="notes extra-log">${log.slice(r.steps.length).map((h) => `<li>${h}</li>`).join('')}</ul>`;
  if (r.notes.length) out += `<div class="run-notes">${r.notes.map((h) => `<p>${h}</p>`).join('')}</div>`;
  return out;
}

// ---------- what you did, and the review ----------
// Splits text into sentences (not at decimals or times).
function sentences(html) {
  return html.split(/(?<=[.!?])\s+(?=[A-Z(“"])/).map((x) => x.trim()).filter(Boolean);
}
// Pulls the numbers out of a run report's first sentence: distance, time, heart rate, pace.
const SPLITS = /^\s*((?:\d{1,2}:\d\d(?:\s*\([^)]*\))?\s*,\s*){2,}(?:and\s+)?\d{1,2}:\d\d(?:\s*\([^)]*\))?)\s*[,;:]?\s*/;
const SPLITS_ANY = /((?:\d{1,2}:\d\d(?:\s*\([^)]*\))?\s*(?:,\s*(?:and\s+)?|\s+and\s+)){2,}\d{1,2}:\d\d(?:\s*\([^)]*\))?)/;
function runStats(t) {
  const st = [];
  // Splits: "m:ss, m:ss, m:ss" or "m:ss (N mi), m:ss (N), ..." at the start.
  // ...or anywhere in the sentence ("ladder of a, b and c mi at m:ss, m:ss and m:ss").
  const splits = t.match(SPLITS) || t.match(SPLITS_ANY);
  if (splits) t = t.replace(splits[0], ' ');
  const dist = t.match(/(\d+(?:\.\d+)?)\s*(mi|miles|km)\b/i);
  const time = t.match(/\b(\d{1,2}:\d\d:\d\d)\b/) || t.match(/\bin\s+(\d+(?::\d\d)?)\s*min\b/i);
  const pace = t.match(/\b(\d{1,2}:\d\d)\s*(?:\/\s*mi|per mile|min\/mi|running pace|pace|average)\b/i);
  const hr = t.match(/\bHR\s*(?:of\s*|about\s*)?(\d{2,3}(?:\s*(?:to|-|–)\s*\d{2,3})?)/i) || t.match(/(?<!(?:to|-|–)\s*)\b(\d{2,3})\s*bpm\b/i);
  const peak = t.match(/\b(?:peak(?:ed)?|max(?:imum)?)\s*(?:HR|heart rate)?\s*(?:of|at)?\s*(\d{2,3})\b/i) || t.match(/\b(?:HR|heart rate)\s*peak(?:ed|ing)?\s*(?:at)?\s*(\d{2,3})\b/i);
  // On split days a distance is usually a rep length, so only an explicit total counts.
  const total = t.match(/(\d+(?:\.\d+)?)\s*(?:mi|miles)\s*(?:total|in all|overall)\b/i) || t.match(/\btotal(?:\s*of)?\s*(\d+(?:\.\d+)?)\s*(?:mi|miles)\b/i);
  if (splits && total) st.push(['Distance', total[1], 'mi']);
  if (dist && !splits) st.push(['Distance', dist[1], dist[2].toLowerCase().startsWith('k') ? 'km' : 'mi']);
  if (time && (!splits || /^in\b/i.test(time[0]))) st.push(['Time', time[1], time[1].split(':').length === 3 ? '' : 'min']);
  if (pace && !splits) st.push(['Pace', pace[1], '/mi']);
  if (peak) st.push(['Peak HR', peak[1], 'bpm']);
  else if (hr) st.push(['HR', hr[1].replace(/\s*(to|-|–)\s*/, '–'), 'bpm']);
  return { st, splits: splits ? splits[1].split(/\s*,\s*(?:and\s+)?|\s+and\s+/).map((x) => x.replace(/\s*\((.*)\)/, ' · $1')) : [], matched: [splits && total ? total : dist, time, pace, peak || hr, splits].filter(Boolean).map((m) => m[0]) };
}
// mode: 'tiles' (just the numbers), 'notes' (just the notes) or full.
function doneHtml(d, mode) {
  const items = d.parts.done;
  if (!items.length) return '';
  let out = '', notes = [];
  if (!d.missed) {
    const first = sentences(items[0].html);
    const r = runStats(txt(first[0] || ''));
    if (r.st.length || r.splits.length) {
      const pm = plannedMinutes(d);
      if (r.st.length) out += `<div class="stats">${r.st.map(([k, v, u]) => `<div class="stat${v.length > 5 ? ' long' : ''}"><b>${esc(v)}<small>${u}</small></b><span>${k}</span>${k === 'Time' && pm ? `<em>plan ${Math.round(pm)}</em>` : ''}</div>`).join('')}</div>`;
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
  if (mode === 'tiles') {
    if (d.missed) return `<p class="missed-line">${notes[0] || 'Skipped'}</p>`;
    return out ? `<div class="p-done tiles-only">${out}</div>` : '';
  }
  if (mode === 'notes') {
    if (d.missed) notes = notes.slice(1);
    if (!notes.length) return '';
    out = '';
  }
  if (notes.length) out += notes.length > 1 ? `<ul class="notes">${notes.map((h) => `<li>${h}</li>`).join('')}</ul>` : `<p>${notes[0]}</p>`;
  return `<div class="part p-done${d.missed ? ' missed' : ''}"><h4>${d.missed ? 'Skipped' : 'What you did'}</h4>${out}</div>`;
}
// mode: 'lead' (just the verdict), 'rest' (the points after it) or full.
function reviewHtml(d, mode) {
  const items = d.parts.review;
  if (!items.length) return '';
  const all = items.flatMap((x) => x.bullet ? [{ h: x.html, b: true }] : sentences(x.html).map((h) => ({ h })));
  const [lead, ...rest] = all;
  if (mode === 'lead') return `<p class="verdict compact-verdict">${lead.h}</p>`;
  if (mode === 'rest') return rest.length ? `<div class="part p-review"><h4>Review</h4><ul class="notes">${rest.map((x) => `<li>${x.h}</li>`).join('')}</ul></div>` : '';
  return `<div class="part p-review"><h4>Review</h4><p class="verdict">${lead.h}</p>${rest.length ? `<ul class="notes">${rest.map((x) => `<li>${x.h}</li>`).join('')}</ul>` : ''}</div>`;
}
const RATING = [[/^(great|excellent|strong|perfect|awesome|crushed)/i, 'great'], [/^(good|solid|nice|fine)/i, 'good'], [/^(ok|okay|mixed|average|fair)/i, 'ok'], [/^(tough|rough|hard|poor|bad|struggle)/i, 'tough']];
function ratingPill(d) { return ratingBadge(d.parts.rating.map((x) => txt(x.html)).join(' ')); }
function ratingBadge(t) {
  t = (t || '').trim();
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
  const head = `<div class="day-head"><div class="day-when">${d.date ? `<span class="dow">${DAY_NAMES[d.date.getDay()]}</span><span class="dt">${MONTHS[d.date.getMonth()]} ${d.date.getDate()}</span>` : `<span class="dow">${esc(d.label)}</span>`}</div><div class="badges">${status}${ratingPill(d)}${kindBadge(d.kind)}</div></div>`;
  // Finished days in a week's list: just the headline, the numbers and the verdict; tap for the rest.
  if (opts.compact && past) {
    const r = runShape(p.plan);
    const more = `<div class="part p-plan"><h4>${d.done && p.actual.length ? 'Planned vs actual' : 'Planned'}</h4><div class="workout">${runShapeHtml(d, false, true)}</div></div>` + (d.done ? doneHtml(d, 'notes') + reviewHtml(d, 'rest') : reviewHtml(d)) + shoeChip(d.shoe);
    return `<details class="${cls.join(' ')} compact"><summary>${head}
      <div class="run-head">${r.head || '<span class="muted">Nothing listed</span>'}</div>
      ${d.done ? doneHtml(d, 'tiles') + reviewHtml(d, 'lead') : ''}
      <span class="more"><span class="m-open">Details</span><span class="m-close">Hide details</span></span></summary>${more}</details>`;
  }
  return `<div class="${cls.join(' ')}">
    ${head}
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

// A week's numbers, in miles and in time: done, still to run, planned, and how far finished
// runs came in over or under their plan.
function weekNumbers(w) {
  const t = today();
  const behindDays = w.days.filter((d) => d.done || (d.date && d.date < t));
  const aheadDays = w.days.filter((d) => d.date && d.date >= t && !d.done);
  const finished = w.days.filter((d) => d.done && !d.missed);
  const any = finished.length > 0;
  // Miles: the app's day estimates are scaled to add up to the week heading's total (they rarely agree
  // exactly, since minutes are turned into miles at the typical easy pace).
  const mi = weekMiles(w);
  const mBehind = behindDays.reduce((a, d) => a + plannedMiles(d), 0), mAhead = aheadDays.reduce((a, d) => a + plannedMiles(d), 0);
  const mPlanned = +r1(mi.planned || mBehind + mAhead), scale = mBehind + mAhead ? mPlanned / (mBehind + mAhead) : 1;
  const mDone = +r1(mi.done || 0);
  // Time: each finished run's own time, or its planned time when the report has none.
  const tBehind = behindDays.reduce((a, d) => a + plannedMinutes(d), 0), tAhead = aheadDays.reduce((a, d) => a + plannedMinutes(d), 0);
  const tDone = finished.reduce((a, d) => { const n = runNumbers(d); return a + ((n && n.mins) || plannedMinutes(d)); }, 0);
  return {
    any,
    miles: { done: mDone, toGo: +r1(mAhead * scale), planned: mPlanned, off: +r1(mDone - mBehind * scale) },
    time: { done: tDone, toGo: tAhead, planned: tBehind + tAhead, off: tDone - tBehind },
  };
}
// The week in progress: miles and time done, to go and planned, with a bar and an on-track note.
function weekProgressHtml(w, small) {
  if (weekStatus(w) !== 'now') return '';
  const { miles: m, time: tm } = weekNumbers(w);
  const pct = (v) => Math.max(0, Math.min(100, (v / Math.max(m.planned, m.done + m.toGo, 1)) * 100)).toFixed(1);
  const cell = (mv, tv, label) => `<div><b>${r1(mv)}<small>mi</small></b><em>${fmtDur(tv)}</em><span>${label}</span></div>`;
  const notes = [];
  if (Math.abs(m.off) >= 0.5) notes.push(`${r1(Math.abs(m.off))} mi ${m.off < 0 ? 'under' : 'over'}`);
  if (Math.abs(tm.off) >= 5) notes.push(`${fmtDur(Math.abs(tm.off))} ${tm.off < 0 ? 'under' : 'over'}`);
  const note = !small && notes.length ? `<p class="wp-note">On track for ${r1(m.done + m.toGo)} mi and ${fmtDur(tm.done + tm.toGo)}: ${notes.join(', ')} the plan so far.</p>` : '';
  return `<div class="wk-progress${small ? ' small' : ''}">
    <div class="wp-nums">${cell(m.done, tm.done, 'done')}${cell(m.toGo, tm.toGo, 'to go')}${cell(m.planned, tm.planned, 'planned')}</div>
    <div class="wp-bar" role="img" aria-label="${r1(m.done)} of ${r1(m.planned)} miles done, ${r1(m.toGo)} still to run"><i class="wp-done" style="width:${pct(m.done)}%"></i><i class="wp-togo" style="width:${pct(m.toGo)}%"></i></div>${note}
  </div>`;
}
// Past and coming weeks: one line with miles and time.
function weekTotalsHtml(w) {
  if (weekStatus(w) === 'now') return '';
  const { any, miles: m, time: tm } = weekNumbers(w);
  if (!m.planned && !tm.planned) return '';
  const txt2 = any
    ? `<b>${r1(m.done)}</b> of ${r1(m.planned)} mi · <b>${fmtDur(tm.done)}</b> of ${fmtDur(tm.planned)}`
    : `${r1(m.planned)} mi · about ${fmtDur(tm.planned)} planned`;
  return `<p class="wk-miles">${txt2}</p>`;
}
// The week heading's words without its mileage ("about N mi planned, N done, peak week" → "Peak week").
function summaryRest(w) {
  const parts = (w.summary || '').split(/\s*,\s*/).filter((x) => x && !/^(about\s+)?\d+(\.\d+)?\s*(mi|miles)?\s*(planned|done|completed|total|run)?$/i.test(x.trim()));
  return parts.join(', ').trim();
}
// A week's seven dots. A rest counts as done once its day has passed (rests rarely get a Done line).
function weekDots(w) {
  const t = today();
  return w.days.map((d) => `<i class="dot k-${d.kind}${d.missed ? ' missed' : d.done || (d.kind === 'rest' && d.date && d.date < t) ? ' done' : ''}" title="${esc(d.label)}${d.missed ? ': skipped' : ''}"></i>`).join('');
}
function planView() {
  let out = mileageChart(), lastGroup = null;
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
    const dots = weekDots(w);
    out += `<a class="card week-card ${st}" id="wk-${w.num}" href="#/week/${w.num}">
      <div class="wk-top"><span class="wk-title">Week ${w.num}</span>${st === 'now' ? '<span class="pill">This week</span>' : ''}${ratingBadge(w.rating)}</div>
      <div class="wk-range">${esc(w.range)}</div>
      ${(() => { const rest = summaryRest(w); return rest ? `<div class="muted">${esc(rest[0].toUpperCase() + rest.slice(1))}</div>` : ''; })()}
      ${st === 'now' ? weekProgressHtml(w, true) : weekTotalsHtml(w)}
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
  const mi = weekMiles(w);
  let out = `<div class="week-head">${w.group ? `<p class="eyebrow">${esc(w.group)}</p>` : ''}<h2>${esc(w.range)}</h2>${weekTotalsHtml(w)}${weekProgressHtml(w)}<div class="dots">${weekDots(w)}</div>${(() => { const rest = summaryRest(w); return rest ? `<p class="muted">${esc(rest[0].toUpperCase() + rest.slice(1))}</p>` : ''; })()}</div>`;
  if (w.recap.length || w.rating) {
    const [lead, ...rest] = w.recap.flatMap((x) => x.bullet ? [{ h: x.html, b: true }] : sentences(x.html).map((h) => ({ h })));
    out += `<div class="card recap"><div class="recap-head"><h3>How the week went</h3>${ratingBadge(w.rating)}</div>${lead ? `<p class="verdict">${lead.h}</p>` : ''}${rest.length ? `<ul class="notes">${rest.map((x) => `<li>${x.h}</li>`).join('')}</ul>` : ''}</div>`;
  }
  out += w.days.map((d) => dayCard(d, { compact: true })).join('');
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
  const body = (s) => renderBlocks(s.blocks) + secs.filter((x) => x.parent === s).map((x) => `<h4>${esc(x.title)}</h4>${renderBlocks(x.blocks)}`).join('');
  let out = '';
  GUIDE.forEach((re, gi) => {
    if (gi === 2) out += progressChart(); // between Highlights and Goals
    const s = secs.find((x) => re.test(x.title));
    if (!s) return;
    if (gi === 0) out += `<div class="card guide g-summary"><h2>${esc(s.title)}</h2>${glanceHtml()}<div class="guide-body">${body(s)}</div></div>`;
    else if (gi === 1) out += `<div class="card guide g-highlights"><h2>${esc(s.title)}</h2>${highlightsHtml(s) || `<div class="guide-body">${body(s)}</div>`}</div>`;
    else out += `<div class="card guide g-goals"><h2>${esc(s.title)}</h2>${goalsHtml(s) || `<div class="guide-body">${body(s)}</div>`}</div>`;
  });
  return out.trim() ? out : '<div class="card"><p class="muted">Nothing here yet. The Guide shows the doc’s <b>Summary</b>, <b>Highlights</b> and <b>Goals and odds</b> sections.</p></div>';
}
// At a glance (worked out by the app): next race, which week, miles and runs done.
function glanceHtml() {
  const t = today(), days = allDays();
  const race = days.find((d) => d.kind === 'race' && d.date >= t);
  const ws = state.plan.weeks, cur = currentWeek();
  const fin = days.filter((d) => d.done && !d.missed);
  const miles = ws.reduce((a, w) => a + (weekMiles(w).done || 0), 0);
  const tiles = [];
  if (race) {
    const n = daysBetween(t, race.date), name = headlineOf(race).split(/[,:(]/)[0].trim();
    tiles.push(`<div class="gl gl-race"><b>${n === 0 ? 'Today' : n}</b><span>${n === 0 ? '' : n === 1 ? 'day to ' : 'days to '}${esc(name)}</span></div>`);
  }
  if (cur) tiles.push(`<div class="gl gl-week"><b>${cur.num}<small>/${ws.length}</small></b><span>week of the plan</span></div>`);
  if (fin.length) tiles.push(`<div class="gl gl-miles"><b>${r1(miles)}</b><span>miles in ${fin.length} runs</span></div>`);
  return tiles.length ? `<div class="glance">${tiles.join('')}</div>` : '';
}
// Highlights: each bullet as a small card with an icon picked from its topic, its label in bold
// ("Label: the rest") and numbers made to stand out.
const HL_TOPICS = [
  ['race', /\b(race|5k|10k|half|marathon|pr)\b/i, '<path d="M5 21V4h11l-2 4 2 4H5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>'],
  ['workout', /\b(ladder|tempo|interval|rep|progression|fartlek|hill|cruise|speed)\b/i, '<path d="M13 2 4 14h7l-1 8 9-12h-7z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>'],
  ['heart', /\b(hr|bpm|heart|pace)\b/i, '<path d="M12 20.5s-7.5-4.6-7.5-10.1A4.2 4.2 0 0 1 12 7.6a4.2 4.2 0 0 1 7.5 2.8c0 5.5-7.5 10.1-7.5 10.1z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>'],
  ['long', /\b(long run|longest|long)\b/i, '<path d="M4 19c4 0 4-6 8-6s4 6 8 6M4 11c4 0 4-6 8-6s4 6 8 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'],
  ['shoe', /\b(shoes?|sneakers?|trainers?|brooks|asics|saucony|adidas|nike|hoka|new balance|on running|puma|mizuno)\b/i, '<path d="M3 16.5h16.5a1.5 1.5 0 0 0 1.5-1.5c0-1.7-1.6-2.4-3.4-2.9l-3.8-1-2.3-3.6H8.4L7.8 10 5 9.5 3 13zM3 16.5V19h18v-2.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>'],
  ['fitness', /\b(vo2|garmin|fitness|threshold|watch)\b/i, '<path d="M4 18 9 12l4 3 7-9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'],
];
function emphasizeNumbers(h) {
  // Only outside tags: times, decimals and whole numbers (with a unit when there is one).
  return h.split(/(<[^>]+>)/).map((part) => part.startsWith('<') ? part
    : part.replace(/(\d{1,2}:\d\d(?:\s*(?:to|–|-)\s*\d{1,2}:\d\d)?|\d+(?:\.\d+)?(?:\s*(?:to|–|-)\s*\d+(?:\.\d+)?)?\s*(?:mi|miles|min|bpm|%|k)?\b)/gi, (m) => /\d/.test(m) ? `<b class="num">${m.trim()}</b>${/\s$/.test(m) ? ' ' : ''}` : m)).join('');
}
function highlightsHtml(s) {
  const items = s.blocks.filter((b) => b.type === 'list').flatMap((b) => b.items);
  if (!items.length) return '';
  const extra = s.blocks.filter((b) => b.type !== 'list');
  return `<ul class="hl">${items.map((h) => {
    const t = txt(h), m = h.match(/^(.{2,60}?):\s*(.*)$/s);
    const [key, , icon] = HL_TOPICS.find(([, re]) => re.test(m ? txt(m[1]) : t)) || HL_TOPICS.find(([, re]) => re.test(t)) || ['other', null, '<circle cx="12" cy="12" r="4" fill="currentColor"/>'];
    return `<li class="hl-${key}"><i><svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg></i><div>${m ? `<strong>${m[1]}</strong>` : ''}<span>${emphasizeNumbers(m ? m[2] : h)}</span></div></li>`;
  }).join('')}</ul>${extra.length ? `<div class="guide-body">${renderBlocks(extra)}</div>` : ''}`;
}
// Goals and odds: a table with a chance column becomes goal cards with a bar for the chance.
function goalsHtml(s) {
  const ti = s.blocks.findIndex((b) => b.type === 'table' && b.rows.length > 1 && b.rows[0].some((c) => /chance|odds|probab|likel/i.test(txt(c))));
  if (ti < 0) return '';
  const tb = s.blocks[ti], head = tb.rows[0].map(txt);
  const ci = head.findIndex((c) => /chance|odds|probab|likel/i.test(c));
  const pct = (t) => { const n = (t.match(/\d+(?:\.\d+)?/g) || []).map(Number).filter((x) => x <= 100); return n.length ? n.reduce((a, b) => a + b, 0) / n.length : null; };
  const cards = tb.rows.slice(1).map((r) => {
    const cells = r.map(txt), chance = cells[ci] || '', p = pct(chance);
    const others = cells.map((c, k) => ({ c, k })).filter(({ k }) => k !== 0 && k !== ci);
    const [main, ...rest] = others;
    const level = p === null ? '' : p >= 70 ? 'hi' : p >= 30 ? 'mid' : 'lo';
    return `<div class="goal ${level}">
      <div class="goal-top"><span class="goal-badge">${esc(cells[0])}</span><div class="goal-main">${main ? `<b>${esc(main.c)}</b>` : ''}${rest.map(({ c }) => `<span>${esc(c)}</span>`).join('')}</div></div>
      ${chance ? `<div class="goal-chance"><div class="goal-bar"><i style="width:${p === null ? 0 : Math.max(3, Math.min(100, p))}%"></i></div><span>${esc(chance)}</span></div>` : ''}
    </div>`;
  }).join('');
  // Anything after the table (like when the odds get updated) stays in the doc and isn't shown.
  const before = s.blocks.slice(0, ti);
  return `${before.length ? `<div class="guide-body">${renderBlocks(before)}</div>` : ''}<div class="goals">${cards}</div>`;
}

// ---------- charts ----------
// Miles in a piece of text ("N mi", "N miles", "N km").
function milesIn(t) {
  t = t || '';
  const m = t.match(/(\d+(?:\.\d+)?)\s*(mi\b|miles?|km\b|k\b)/i);
  if (m) return +m[1] * (/^k/i.test(m[2]) ? 0.621 : 1);
  if (/\bhalf(?:[- ]marathon)?\b/i.test(t) && /\b(race|half marathon|half\b)/i.test(t) && !/\b(first|second|lower|upper) half\b/i.test(t)) return 13.1;
  if (/\bmarathon\b/i.test(t)) return 26.2;
  return 0;
}
function minutesIn(t) { const m = (t || '').match(/(\d+)\s*(?:to\s*\d+\s*)?min\b/i); return m ? +m[1] : 0; }
// Your typical easy pace (minutes per mile), to turn "N min" into miles.
function easyPace() {
  if (state.plan._pace) return state.plan._pace;
  const ps = allDays().filter((d) => d.kind === 'easy' || d.kind === 'long').map(runNumbers).filter((n) => n && n.pace > 6 && n.pace < 20).map((n) => n.pace).sort((a, b) => a - b);
  return (state.plan._pace = ps.length ? ps[Math.floor(ps.length / 2)] : 12);
}
function headlineOf(d) { return txt((d.parts.plan.find((x) => !x.bullet) || { html: '' }).html); }
// A finished run's numbers: from the start of its Done line, with pace worked out
// from distance and time when it isn't given.
function runNumbers(d) {
  if (!d.done || d.missed || !d.parts.done.length) return null;
  const first = sentences(d.parts.done[0].html)[0] || '';
  const r = runStats(txt(first));
  const get = (k) => (r.st.find((x) => x[0] === k) || [])[1];
  let miles = get('Distance') ? +get('Distance') : 0;
  if (miles && r.st.find((x) => x[0] === 'Distance')[2] === 'km') miles *= 0.621;
  const tm = get('Time');
  const mins = tm ? (tm.includes(':') ? tm.split(':').reduce((a, x) => a * 60 + +x, 0) / (tm.split(':').length === 3 ? 60 : 1) : +tm) : 0;
  const p = get('Pace');
  const pace = p ? +p.split(':')[0] + p.split(':')[1] / 60 : (miles && mins ? mins / miles : 0);
  const hr = get('HR') ? parseInt(get('HR'), 10) : 0;
  return { miles, mins, pace, hr };
}
// A day's planned miles: the steps added up (repeats counted), or the headline's distance.
function plannedMiles(d) {
  if (d.kind === 'rest') return 0;
  let sum = 0;
  for (const x of d.parts.plan.filter((p) => p.bullet)) {
    const t = txt(x.html), rep = t.match(/^(\d+)\s*[x×]\s*(.+)$/i);
    sum += rep ? +rep[1] * milesIn(rep[2].split(RECOVERY_SPLIT)[0]) : milesIn(t.split(RECOVERY_SPLIT)[0]);
  }
  const head = headlineOf(d);
  const miles = Math.max(sum, milesIn(head.replace(/^[^,]*:\s*[\d.,\sand]+mi\b/i, '')));
  if (miles) return miles;
  // Only minutes given: estimate with the typical easy pace.
  let mins = 0;
  for (const x of d.parts.plan.filter((p) => p.bullet)) mins += minutesIn(txt(x.html));
  return (mins || minutesIn(head)) / easyPace();
}
function weekMiles(w) {
  const sm = (w.summary || '').match(/(\d+(?:\.\d+)?)\s*mi\b/i); // only an explicit "about 27 mi"
  const planned = sm ? +sm[1] : w.days.reduce((a, d) => a + plannedMiles(d), 0);
  let done = 0, any = false;
  for (const d of w.days) {
    if (!d.done || d.missed) continue;
    any = true;
    const n = runNumbers(d);
    done += (n && n.miles) || plannedMiles(d); // splits-only reports: count the planned distance
  }
  return { planned, done: any ? done : null };
}
const fmtPace = (v) => { const m = Math.floor(v), s = Math.round((v - m) * 60); return s === 60 ? `${m + 1}:00` : `${m}:${String(s).padStart(2, '0')}`; };
const r1 = (v) => (Math.round(v * 10) / 10).toString();
function niceMax(v) { const steps = [5, 10, 15, 20, 25, 30, 40, 50, 60, 80, 100]; return steps.find((x) => x >= v) || Math.ceil(v / 50) * 50; }

// A race's short name for the chart: 5K, 10K, Half, Marathon (or Race).
function raceShort(d) {
  const t = headlineOf(d);
  if (/\bhalf\b/i.test(t)) return 'Half';
  if (/\bmarathon\b/i.test(t)) return 'Full';
  const m = t.match(/\b(\d{1,2})\s*k\b/i);
  return m ? m[1] + 'K' : 'Race';
}
function mileageChart() {
  const ws = state.plan.weeks;
  const data = ws.map((w) => ({ w, ...weekMiles(w) }));
  if (data.filter((x) => x.planned).length < 2) return '';
  const W = 360, H = 162, L = 26, B = 18, T = 24, n = data.length; // room at the top for race flags
  const max = niceMax(Math.max(...data.map((x) => Math.max(x.planned, x.done || 0))));
  const slot = (W - L) / n, bw = Math.min(16, slot - 2);
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const bar = (x, v, cls) => {
    if (!v) return '';
    const top = y(v), h = H - B - top, r = Math.min(4, h);
    return `<path class="${cls}" d="M${x},${H - B}V${top + r}q0,-${r} ${r},-${r}h${bw - 2 * r}q${r},0 ${r},${r}V${H - B}z"/>`;
  };
  const cur = currentWeek();
  let g = '';
  for (const v of [0, max / 2, max]) g += `<line class="grid" x1="${L}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${L - 5}" y="${y(v) + 3.5}" text-anchor="end">${r1(v)}</text>`;
  data.forEach((x, i) => {
    const bx = L + i * slot + (slot - bw) / 2;
    const race = x.w.days.find((d) => d.kind === 'race');
    const tip = `Week ${x.w.num} · ${x.planned ? r1(x.planned) + ' mi planned' : 'no total planned'}${x.done !== null ? ' · ' + r1(x.done) + ' mi done' : ''}${race ? ' · ' + headlineOf(race).split(/[,:(]/)[0].trim() : ''}`;
    g += `<g class="hit" data-tip="${esc(tip)}" data-week="${x.w.num}"><rect x="${L + i * slot}" y="0" width="${slot}" height="${H}" fill="transparent"/>`;
    g += bar(bx, x.planned, 'b-plan') + bar(bx, x.done, 'b-done');
    // Race weeks: a small gold flag above the bar with a short label (5K, 10K, Half, ...).
    const races = x.w.days.filter((d) => d.kind === 'race');
    if (races.length) {
      const top = y(Math.max(x.planned, x.done || 0)) - 3, cx = bx + bw / 2;
      g += `<g class="race-flag"><path d="M${cx - 1.5},${top}V${top - 12}l7,2.5-7,2.5" /><text x="${cx}" y="${top - 15}" text-anchor="middle">${esc(raceShort(races[0]))}</text></g>`;
    }
    g += `<text class="ax${x.w === cur ? ' cur' : ''}" x="${bx + bw / 2}" y="${H - 5}" text-anchor="middle">${x.w.num}</text></g>`;
  });
  const lastDone = [...data].reverse().find((x) => x.done !== null);
  const head = lastDone ? `Week ${lastDone.w.num}: ${r1(lastDone.done)} of ${r1(lastDone.planned)} mi` : 'Planned miles per week';
  return `<div class="card chart">
    <div class="chart-head"><h3>Weekly miles</h3><div class="legend"><span><i class="sw b-plan"></i>Planned</span><span><i class="sw b-done"></i>Done</span><span><svg class="sw-flag" viewBox="0 0 12 14" aria-hidden="true"><path d="M2,13V1l8,3-8,3"/></svg>Race</span></div></div>
    <p class="readout muted">${esc(head)}. Tap a bar for details.</p>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Planned and done miles for each week">${g}</svg>
  </div>`;
}

// A run done (or planned) on a treadmill: the word appears in its plan or its Done line.
function isTreadmill(d) {
  return /\btread(mill)?\b/i.test([...d.parts.plan, ...d.parts.done].map((x) => txt(x.html)).join(' '));
}
// Easy-run pace and heart rate over time: two small charts sharing the same dates.
function progressChart() {
  // Recovery runs are slow on purpose, and treadmill runs aren't comparable, so both are left out.
  const pts = allDays().filter((d) => (d.kind === 'easy' || d.kind === 'long') && d.date <= today() && !/recovery/i.test(headlineOf(d)) && !isTreadmill(d))
    .map((d) => ({ d, n: runNumbers(d) })).filter((x) => x.n && (x.n.pace || x.n.hr));
  const pace = pts.filter((x) => x.n.pace > 4 && x.n.pace < 25), hr = pts.filter((x) => x.n.hr);
  if (pace.length < 3 && hr.length < 3) return '';
  const t0 = pts[0].d.date, t1 = pts[pts.length - 1].d.date;
  const span = Math.max(1, t1 - t0);
  const W = 360, H = 120, L = 34, R = 10, T = 12, B = 18;
  const x = (dt) => L + (W - L - R) * ((dt - t0) / span);
  function chart(list, val, fmt, invert, label, unit, minSpan) {
    if (list.length < 3) return '';
    const vs = list.map(val);
    let lo = Math.min(...vs), hi = Math.max(...vs);
    if (hi - lo < minSpan) { const mid = (hi + lo) / 2; lo = mid - minSpan / 2; hi = mid + minSpan / 2; } // keep small changes looking small
    const pad = (hi - lo) * 0.2 || 1; lo -= pad; hi += pad;
    const y = (v) => T + (H - T - B) * (invert ? (v - lo) / (hi - lo) : 1 - (v - lo) / (hi - lo));
    let g = '';
    // Round tick values inside the range: the smallest step that gives at most 3.
    const step = [0.25, 0.5, 1, 2, 5, 10, 20, 50].find((st) => Math.floor(hi / st) - Math.ceil(lo / st) + 1 <= 3) || 100;
    const ticks = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) ticks.push(v);
    for (const v of ticks) g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${L - 5}" y="${y(v) + 3.5}" text-anchor="end">${fmt(v)}</text>`;
    g += `<text class="ax" x="${L}" y="${H - 4}">${esc(fmtDate(t0).slice(4))}</text><text class="ax" x="${W - R}" y="${H - 4}" text-anchor="end">${esc(fmtDate(t1).slice(4))}</text>`;
    g += `<polyline class="ln" points="${list.map((p) => `${x(p.d.date).toFixed(1)},${y(val(p)).toFixed(1)}`).join(' ')}"/>`;
    list.forEach((p, i) => {
      const cx = x(p.d.date), cy = y(val(p));
      const tip = `${fmtDate(p.d.date)} · ${fmt(val(p))} ${unit}`;
      g += `<g class="hit" data-tip="${esc(tip)}" data-week="${p.d.week.num}"><circle cx="${cx}" cy="${cy}" r="22" fill="transparent"/><circle class="pt${i === list.length - 1 ? ' last' : ''}" cx="${cx}" cy="${cy}" r="4"/></g>`;
    });
    const last = list[list.length - 1], first = list[0];
    return `<div class="sub"><p class="sub-head"><b>${label}</b> <span class="muted">${fmt(val(first))} → ${fmt(val(last))} ${unit}</span></p>
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)} over time">${g}</svg></div>`;
  }
  return `<div class="card chart">
    <div class="chart-head"><h3>Progress</h3></div>
    <p class="readout muted">Easy and long runs outdoors. Tap a dot for details.</p>
    ${chart(pace, (p) => p.n.pace, fmtPace, true, 'Pace', 'per mi', 1.5)}
    ${chart(hr, (p) => p.n.hr, (v) => String(Math.round(v)), false, 'Average heart rate', 'bpm', 25)}
  </div>`;
}
// Tapping a bar or dot shows its numbers; tapping the same one again opens its week.
document.addEventListener('click', (e) => {
  const h = e.target.closest('.chart .hit');
  if (!h) return;
  const card = h.closest('.chart');
  if (h.classList.contains('on')) { location.hash = '#/week/' + h.dataset.week; return; }
  card.querySelectorAll('.hit.on').forEach((x) => x.classList.remove('on'));
  h.classList.add('on');
  card.querySelector('.readout').innerHTML = `<b>${esc(h.dataset.tip)}</b> · <a href="#/week/${h.dataset.week}">Open week</a>`;
});

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
  if (so) so.onclick = async () => {
    if (!await confirmDialog('Sign out?', 'Sign out', 'You’ll need your email and password to sign back in, and the saved copy of the plan on this phone is cleared.')) return;
    auth.signOut(); store.del('planHtml'); state.plan = null; state.error = '';
    toast('Signed out'); refresh(false);
  };
  // One button: checks the plan for changes, and the app itself for a new version
  // (a new version installs and the page reloads into it by itself).
  const u = $('#update'); if (u) u.onclick = () => checkForUpdates(u);
}

// Check for updates (Settings button and the status pill), worded like the recipe app:
// "Updating…" while it looks, then "Already Up to Date", or "Up to Date!" when the plan changed,
// or a reload into the new version, which then says "Up to Date!".
let updating = false;
async function checkForUpdates(btn) {
  if (updating) return;
  updating = true;
  const done = () => { updating = false; if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = 'Check for updates'; } };
  if (btn) { btn.disabled = true; btn.textContent = 'Updating…'; }
  toast('Updating…', 30000);
  const plan = auth.get() ? await refresh(false, true) : { changed: false, failed: false };
  btn = $('#update') || btn; // the page was redrawn
  if (btn) { btn.disabled = true; btn.textContent = 'Updating…'; }
  try {
    const r = await fetch('sw.js', { cache: 'no-store' });
    const v = ((await r.text()).match(/VERSION = '([^']+)'/) || [])[1];
    if (!v) throw new Error('no version');
    if (v === APP_VERSION) {
      toast(plan.failed ? 'Couldn’t update. Check your connection.' : plan.changed ? 'Up to Date!' : 'Already Up to Date', 3000);
      done();
      return;
    }
    store.set('justUpdated', '1'); // the reloaded app says "Up to Date!"
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) {
      await reg.update();
      const sw = reg.installing || reg.waiting;
      if (sw && sw.state !== 'activated') await new Promise((res) => { sw.addEventListener('statechange', () => sw.state === 'activated' && res()); setTimeout(res, 15000); });
    }
    location.reload();
  } catch {
    toast('Couldn’t update. Check your connection.', 3500);
    done();
  }
}
$('#sync').addEventListener('click', () => checkForUpdates());

// ---------- start ----------
// Where a page opens: the Plan tab at this week, a week at today, everything else at the top.
function scrollForRoute() {
  window.scrollTo(0, 0);
  const tab = (location.hash.replace(/^#\/?/, '') || '').split('/')[0];
  let el = null;
  if (tab === 'plan' && state.plan) { const w = currentWeek(); el = w && $('#wk-' + w.num); }
  if (tab === 'week') el = $('#view .day.is-today');
  if (!el) return;
  const top = el.getBoundingClientRect().top - $('.topbar').offsetHeight - 12;
  if (tab === 'plan' && top < innerHeight * 0.55) return; // already in view (the first weeks): keep the chart showing
  window.scrollTo(0, tab === 'week' ? top - innerHeight * 0.15 : top);
}
window.addEventListener('hashchange', () => {
  render(); scrollForRoute();
  if (swipeDir) { const v = $('#view'); v.classList.remove('slide-l', 'slide-r'); void v.offsetWidth; v.classList.add(swipeDir > 0 ? 'slide-l' : 'slide-r'); swipeDir = 0; }
});

// On a week's page, swipe left for the next week and right for the one before.
// Swipes that start on something that scrolls sideways (a table) are left alone.
let swipeDir = 0, touch = null;
$('#view').addEventListener('touchstart', (e) => {
  touch = null;
  if (!location.hash.startsWith('#/week/') || e.touches.length !== 1 || e.target.closest('.table-wrap, input, textarea')) return;
  touch = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
}, { passive: true });
$('#view').addEventListener('touchend', (e) => {
  if (!touch || !state.plan) return;
  const dx = e.changedTouches[0].clientX - touch.x, dy = e.changedTouches[0].clientY - touch.y;
  const quick = Date.now() - touch.t < 800;
  touch = null;
  if (!quick || Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
  const ws = state.plan.weeks, i = ws.findIndex((w) => w.num === +location.hash.split('/')[2]);
  const next = ws[i + (dx < 0 ? 1 : -1)];
  if (i < 0 || !next) return;
  swipeDir = dx < 0 ? 1 : -1;
  location.replace('#/week/' + next.num); // replace, so Back still returns to the Plan tab
}, { passive: true });
$('#back').addEventListener('click', () => { if (history.length > 1) history.back(); else location.hash = '#/plan'; });
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
  // A new version took over: reload once to show it (not on the very first install).
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !reloaded) { reloaded = true; location.reload(); } });
}
boot();
