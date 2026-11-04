# Running Plan: training plan viewer

A small installable web app (PWA) that shows the owner's running plan on their phone: today's workout, the weeks ahead, and the guide sections (paces, shoes, rules). It is hosted on GitHub Pages from this repository. The owner is not a developer: explain things in plain language and don't ask them to run commands. It is built like the recipe app in `entquine/recipes`.

## Privacy rule (important)

**This repository is public. Never commit the plan or anything from it**: no copy of the plan (HTML, Markdown, docx, JSON), no workout text, no race names, dates, paces or heart-rate numbers in code, comments, tests, fixtures or commit messages, and **no Google Doc link** (anyone with that link can read the plan). Test files built from the real plan stay outside the repository (for example in a scratch directory).

## Where the plan lives

- The plan is a **Google Doc** owned by the owner, shared as "Anyone with the link: Viewer".
- The link is pasted into the app's **Settings** on each phone and kept there (in the browser's local storage). It is not in the code.
- The app downloads the doc as HTML (`https://docs.google.com/document/d/<id>/export?format=html`), and keeps the last copy on the phone so it still works with no signal. "Publish to the web" links (`/document/d/e/.../pub`) also work.
- To change the plan, edit the Google Doc. The phone picks it up the next time the app opens (or Settings → Check the plan for changes). No push is needed.
- The master copy of the plan is the "Running Plan" doc in Claude (claude.ai). After Claude updates that doc, copy the changes into the Google Doc, or export the doc to Google Docs again and paste the new link into Settings.

## What the app expects in the doc

The app reads the structure, not specific wording:

- **Title**: the first Heading 1 (or a "Title" paragraph). It becomes the app's title.
- **Sections**: each Heading 2 starts a section. Sections that aren't weeks show on the **Guide** tab, folded.
- **Weeks**: a heading `Week N: <dates> (<summary>)`, Heading 2 or 3, followed by a 2-column table whose first row is `Day | Workout`. Each row's day cell must contain a date as `month/day` (e.g. `Mon 3/2`). Years are worked out automatically (the year goes up when the month goes back to a smaller number). Paragraphs under the table show below that week.
- Week headings under a Heading 2 (as Heading 3) are grouped under that Heading 2 on the **Plan** tab, and the Heading 2's own text shows as "About these weeks".
- **Shoes**: a table whose header row is `Week | Sun | Mon | ...` gives each day's shoe, by week number.
- A workout containing the word "done" is shown as completed, with "Done" highlighted.
- Day type colors are guessed from the workout text: `REST...`, races (race day, half, 5K, 10K, marathon in the first phrase), `Long run`, workouts (ladder, tempo, intervals, fartlek, progression, hills, ...), otherwise easy.

## Files

- `index.html`, `styles.css`, `app.js`: the app. No build step; edit them directly.
- `sw.js`: service worker for offline use. **Bump `VERSION` in `sw.js` and `APP_VERSION` in `app.js` together** whenever any app file changes, so phones pick up the new version (Settings → Check for app updates).
- `manifest.webmanifest`, `icons/`: home-screen install.
- Preview another date with `?today=2026-03-15` on the app's address.

## Checking a change

Serve the folder (`python3 -m http.server`) and open it in Playwright with a test doc served in place of `docs.google.com` (route the request). Keep that test doc outside the repository (see the privacy rule).
