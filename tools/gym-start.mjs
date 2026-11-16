#!/usr/bin/env node
// Sends someone's starting gym weights to the app: numbers with no date, used when an
// exercise has no sessions yet. Writes the Firestore document gymstart/<email name>,
// which only that person's login can read (see the Firestore rules in the console).
//
// Usage:  node tools/gym-start.mjs <starting weights JSON file> --to <email name>
// The JSON file is a list: [{ "ex": "Bench", "wtype": "bar", "side": N }, { "ex": "Seated Fly", "wtype": "total", "weight": N }, ...]
//   wtype: "bar" (give "side", the weight on each side; the total is worked out with a 45 lb bar),
//          "each" (give "weight", one dumbbell) or "total" (give "weight").
// Needs RUNPLAN_SYNC_EMAIL and RUNPLAN_SYNC_PASSWORD, like tools/sync-plan.mjs.
//
// PRIVACY: keep the JSON file outside this repository (the numbers are personal).
import { readFileSync } from 'node:fs';

const FIREBASE = { apiKey: 'AIzaSyC3DjWnRYTlyKdMY_Y1tZrH0-3JNNkAg9U', projectId: 'traininghoster' };
const argv = process.argv.slice(2);
const ti = argv.indexOf('--to');
const target = ti >= 0 ? argv[ti + 1] : '';
function fail(msg) { console.error('gym-start: ' + msg); process.exit(1); }
if (!target || !/^[A-Za-z0-9_-]{1,128}$/.test(target)) fail('--to needs the email name of the person.');
if (!argv[0] || argv[0] === '--to') fail('give the path of the starting weights JSON file.');

let list;
try { list = JSON.parse(readFileSync(argv[0], 'utf8')); } catch (e) { fail('could not read the file: ' + e.message); }
if (!Array.isArray(list) || !list.length) fail('the file should be a list of exercises.');
const clean = list.map((e, i) => {
  const ex = String(e.ex || '').trim(), wtype = e.wtype;
  if (!ex || !['bar', 'each', 'total'].includes(wtype)) fail(`item ${i + 1}: needs "ex" and a "wtype" of bar, each or total.`);
  if (wtype === 'bar') {
    const side = Number(e.side);
    if (!(side >= 0)) fail(`${ex}: a barbell needs "side".`);
    return { ex, wtype, side, weight: Math.round((2 * side + 45) * 10) / 10 };
  }
  const weight = Number(e.weight);
  if (!(weight >= 0)) fail(`${ex}: needs "weight".`);
  return { ex, wtype, weight };
});

const email = process.env.RUNPLAN_SYNC_EMAIL, password = process.env.RUNPLAN_SYNC_PASSWORD;
if (!email || !password) fail('RUNPLAN_SYNC_EMAIL and RUNPLAN_SYNC_PASSWORD must be set in the environment settings.');
const signIn = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE.apiKey}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }),
});
const s = await signIn.json().catch(() => ({}));
if (!signIn.ok) fail('sign-in failed: ' + ((s.error && s.error.message) || signIn.status));

const fields = { start: { stringValue: JSON.stringify(clean) }, updatedAt: { timestampValue: new Date().toISOString() } };
const put = await fetch(`https://firestore.googleapis.com/v1/projects/${FIREBASE.projectId}/databases/(default)/documents/gymstart/${target}?updateMask.fieldPaths=start&updateMask.fieldPaths=updatedAt`, {
  method: 'PATCH', headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + s.idToken }, body: JSON.stringify({ fields }),
});
if (!put.ok) {
  const e = await put.json().catch(() => ({}));
  fail(`write failed (${put.status}): ${(e.error && e.error.message) || ''}${put.status === 403 ? ' (the Firestore rules need a gymstart block for this person)' : ''}`);
}
console.log(`gym-start: sent ${clean.length} starting weights at ${fields.updatedAt.timestampValue}.`);
