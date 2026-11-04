# Running Plan: training plan viewer

A small installable web app (PWA) that shows the owner's running plan on their phone: today's and tomorrow's runs in detail (Upcoming), the weeks (Plan), and a short summary, highlights and goals (Guide). It is hosted on GitHub Pages from this repository (`running-ent/Training`, branch `claude/workout-plan-viewer-m7t1w9`) at **https://running-ent.github.io/Training/**.

**Why a separate GitHub organization:** Chrome on Android lets only one installed web app per site address, and the recipe app already lives on `entquine.github.io`. This app must stay on its own address (`running-ent.github.io`), or one of the two apps can't be installed. Don't move it back under `entquine`. The owner is not a developer: explain things in plain language and don't ask them to run commands. It is built like the recipe app in `entquine/recipes`.

## Privacy rule (important)

**This repository is public. Never commit the plan or anything from it**: no copy of the plan (HTML, Markdown, docx, JSON), no workout text, no race names, dates, paces or heart-rate numbers in code, comments, tests, fixtures or commit messages, and **no Google Doc link** (anyone with that link can read the plan). Test files built from the real plan stay outside the repository (for example in a scratch directory).

## Where the plan lives

- **Master copy:** the "Running Plan" doc in Claude (a Claude Docs document, `https://claude.ai/artifact/X4e3PY7mMom94a8aNprpY1`; the doc is private to the owner, so this link alone shows nothing to anyone else). The owner and Claude edit the plan there.
- **What the app reads:** the Firestore document `plan/current` in the Firebase project `traininghoster` (fields `html`, `updatedAt`, `source`). Its rules (kept in the Firebase console only, since they contain email addresses) let **only the owner's login read it** and **only the sync login write it**. Everything else is denied.
- The app signs in with email and password through Firebase's REST APIs (no SDK, no build), keeps the sign-in on the phone, and keeps the last plan it loaded so it works with no signal.

## Syncing the plan to the app (the usual task)

When the owner asks to "sync the plan" (or a scheduled task does):

1. Read the Running Plan doc with the Claude Docs connector: `read` the tab's content node (`ref {"object":"node","id":"1967751b-6cad"}`, `container {"kind":"project","id":"f37437f2-d72d-435e-8d17-3aed85d5a51a"}`). If that node id no longer works, `read` the project first to find the tab's content node. The result is large and is saved to a file; note its path.
2. Send it: `node tools/sync-plan.mjs <saved result>`. It converts the read in memory (with `tools/xml_to_html.py`, so no plan file is written), refuses anything with no "Week N" headings, and prints one line (bytes, weeks, time). It needs `RUNPLAN_SYNC_EMAIL` and `RUNPLAN_SYNC_PASSWORD` from the environment settings, and network access to `identitytoolkit.googleapis.com` and `firestore.googleapis.com`. (It also accepts an HTML file made with `python3 -I tools/xml_to_html.py <saved result> > <scratch dir>/plan.html`.)
3. Tell the owner it's synced and that the app picks it up within about 2 minutes while open, or as soon as it's opened or brought back on screen (or Settings → Check for updates). Don't print or quote the plan in the output beyond what the owner asked about.

Never commit `plan.html` or the saved read result, and never ask the owner to paste a password into the chat.

## What the app expects in the doc

The app reads the structure, not specific wording:

- **Title**: the first Heading 1 (or a "Title" paragraph). It becomes the app's title.
- **Guide tab**: shows only the Heading 2 sections whose titles start with **Summary**, **Highlights** and **Goals** (in that order). Every other non-week section stays in the doc for Claude's use and isn't shown.
- **Weeks**: a heading `Week N: <dates> (<summary>)`, Heading 2 or 3, followed by a 2-column table whose first row is `Day | Workout`. Each row's day cell must contain a date as `month/day` (e.g. `Mon 3/2`). Years are worked out automatically. Paragraphs under the table show below that week. Week headings under a Heading 2 (as Heading 3) are grouped under that Heading 2 on the **Plan** tab.
- **A day's Workout cell** is separate paragraphs, each starting with a label and a colon:
  - The first paragraph (no label needed, or `Plan:`) is a **short headline**, e.g. `Hill session, 5 mi`. Bullets right under it are the **steps**, one per bullet: `1 mi easy`, `6 x 1 min hard with 2 min jog`, `2 mi at m:ss`. The app draws a colored bar of the run from them (easy, steady, tempo, hard, recover; paced steps get warmer as the pace gets faster).
  - `Keep in mind:`, `Before:`, `During:`, `After:`: shown for today and future days (Upcoming tab and week view). Bullets under a label belong to it.
  - `Done:` what actually happened. A `Done:` starting with "Skipped", "Missed" or "Rested" marks a planned run as **skipped** (red). A plan starting with `REST` is a **planned rest** (purple).
  - `Review:` the coach's take on a finished day.
  - `Shoe:` the shoe for that day when it differs from the shoe table (planned swap, or what was actually worn). It replaces the table's shoe for that day.
  - Older one-line cells still work: `Title: a, b, c` is split into steps, and "Done:" mid-sentence starts the Done part.
- **Shoes**: a table whose header row is `Week | Sun | Mon | ...` gives each day's shoe, by week number. A day's own `Shoe:` line wins over it.
- Day type colors come from the plan text: `REST...`, races (race day, half, 5K, 10K, marathon in the first phrase; gold), `Long run`, workouts (ladder, tempo, intervals, fartlek, progression, hills, ...), otherwise easy.

## Files

- `index.html`, `styles.css`, `app.js`: the app. No build step; edit them directly.
- `sw.js`: service worker for offline use. **Bump `VERSION` in `sw.js` and `APP_VERSION` in `app.js` together** whenever any app file changes, so phones pick up the new version (Settings → Check for updates).
- `manifest.webmanifest`, `icons/`: home-screen install.
- `tools/xml_to_html.py`, `tools/sync-plan.mjs`: the sync (see above).
- Preview another date with `?today=2026-03-15` on the app's address.

## Checking a change

Serve the folder (`python3 -m http.server`) and open it in Playwright, routing `identitytoolkit.googleapis.com`, `securetoken.googleapis.com` and `firestore.googleapis.com` to mocked responses that carry a test plan. Keep that test doc outside the repository (see the privacy rule).
