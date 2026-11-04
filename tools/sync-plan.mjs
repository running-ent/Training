#!/usr/bin/env node
// Sends the running plan to the app: writes an HTML file into the Firestore
// document plan/current, which only the owner's login can read.
//
// Usage:  node tools/sync-plan.mjs /path/outside/the/repo/plan.html
//
// Needs two environment variables (set in the Claude Code environment's
// settings, never in this repository):
//   RUNPLAN_SYNC_EMAIL     the sync login's email (a Firebase Authentication user)
//   RUNPLAN_SYNC_PASSWORD  its password
// The Firestore rules let this login write plan/current and nothing else.
//
// PRIVACY: never commit the HTML file or print its contents. It is the plan.
import { readFileSync } from 'node:fs';

const FIREBASE = { apiKey: 'AIzaSyC3DjWnRYTlyKdMY_Y1tZrH0-3JNNkAg9U', projectId: 'traininghoster' };
const DOC = `https://firestore.googleapis.com/v1/projects/${FIREBASE.projectId}/databases/(default)/documents/plan/current`;

function fail(msg) { console.error('sync-plan: ' + msg); process.exit(1); }

const file = process.argv[2];
if (!file) fail('give the path of the plan HTML file.');
const html = readFileSync(file, 'utf8');
if (!/<h[1-6][^>]*>\s*(<[^>]+>\s*)*Week\s+\d+/i.test(html)) fail('this file has no "Week N" headings, so it does not look like the plan. Nothing was sent.');
if (Buffer.byteLength(html) >= 900000) fail('the file is too big (the limit is 900 KB).');

const email = process.env.RUNPLAN_SYNC_EMAIL, password = process.env.RUNPLAN_SYNC_PASSWORD;
if (!email || !password) fail('RUNPLAN_SYNC_EMAIL and RUNPLAN_SYNC_PASSWORD must be set in the environment settings.');

const signIn = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE.apiKey}`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password, returnSecureToken: true }),
});
const s = await signIn.json().catch(() => ({}));
if (!signIn.ok) fail('sign-in failed: ' + ((s.error && s.error.message) || signIn.status));

const fields = {
  html: { stringValue: html },
  updatedAt: { timestampValue: new Date().toISOString() },
  source: { stringValue: 'Claude Running Plan doc' },
};
const mask = Object.keys(fields).map((k) => 'updateMask.fieldPaths=' + k).join('&');
const put = await fetch(`${DOC}?${mask}`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + s.idToken },
  body: JSON.stringify({ fields }),
});
if (!put.ok) {
  const e = await put.json().catch(() => ({}));
  fail(`write failed (${put.status}): ${(e.error && e.error.message) || ''}`);
}
const weeks = (html.match(/<h[1-6][^>]*>\s*(<[^>]+>\s*)*Week\s+\d+/gi) || []).length;
console.log(`sync-plan: sent ${Buffer.byteLength(html)} bytes (${weeks} weeks) at ${fields.updatedAt.timestampValue}.`);
