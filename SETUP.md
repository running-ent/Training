# Running Plan app: setup

No code skills needed. Everything is done in a web browser.

## How it fits together

- You and Claude keep the plan in the **Running Plan** doc in Claude.
- Claude **syncs** it into your private Firebase database (project `traininghoster`). Only your login can read it there.
- The app on your phone signs in and shows it. It keeps the last copy, so it works with no signal.

## 1. Firebase (done once)

In the Firebase console (console.firebase.google.com), project **traininghoster**:

1. **Authentication → Sign-in method:** Email/Password turned on.
2. **Authentication → Users:** two users: **you** (the login you type into the app) and a **sync login** for Claude (any made-up email, long random password).
3. **Authentication → Settings → User actions:** untick **Enable create (sign-up)** if you see it.
4. **Authentication → Settings → Authorized domains:** add `running-ent.github.io`.
5. **Firestore Database → Rules:** only you can read `plan/current`, only the sync login can write it, everything else is locked. (The rules stay in the console; they're not stored here because they contain your email addresses.)

## 2. Claude's access (done once)

In the Claude Code environment's settings (the environment menu in the session's title bar → **Edit**):

- Add two environment variables (or **Network secrets**, if offered): `RUNPLAN_SYNC_EMAIL` and `RUNPLAN_SYNC_PASSWORD`, set to the sync login. Never paste the password into a chat.
- Under **Network access**, add these allowed domains: `identitytoolkit.googleapis.com`, `securetoken.googleapis.com`, `firestore.googleapis.com`.

New sessions pick these up.

## 3. The app's web address (GitHub Pages)

The app is at **https://running-ent.github.io/Training/** (repository Settings → Pages → Deploy from the branch `claude/workout-plan-viewer-m7t1w9`, folder `/ (root)`).

It lives in its own GitHub organization (`running-ent`) on purpose: Chrome on Android installs only one web app per site address, and the recipe app already uses `entquine.github.io`.

## 4. Your phone

1. Open **https://running-ent.github.io/Training/** in **Chrome**, then **⋮ → Install app**.
2. Open the app, go to **Settings**, and sign in with **your** Firebase login (not the sync one).

## Day to day

- **Today** shows today's workout, which shoe to wear, the next race countdown and the next three days.
- **Plan** lists every week. Tap one to see all its days.
- **Guide** has the rest of the plan (paces, shoes, drills, rules), folded by section.
- **Changing the plan:** update the Running Plan doc in Claude, then ask Claude Code (this repository) to **"sync the plan"**. The app shows it the next time it opens, or tap **Settings → Check the plan for changes**.
- **No signal:** the app shows the last copy it loaded.
- **Backup:** Settings also accepts a Google Doc link, used only if Firebase has no plan. Leave it empty to keep the plan fully private.
