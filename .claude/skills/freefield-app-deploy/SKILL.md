---
name: freefield-app-deploy
description: >-
  Guide a non-programmer through getting their company's OWN FreeField Android tablet app: trying the
  demo on an emulator or a tablet, building a first signed company app, installing it on the tablets,
  updating it to a new version, or writing the request to IT. Use this skill whenever the user talks
  about "build the app", "make the APK", "APK", "AAB", "install the app on the tablets",
  "instalar la app en las tablets", "app para mi empresa", "publicar la app", "actualizar la app",
  "nueva versión de la app", "firmar la app", "signing key", "llave de firma", "keystore", "Play
  privado" / "private Google Play", "MDM" / "gestión de dispositivos", "sideload", "adb", "the sign-in
  link opens the browser" / "el enlace de inicio de sesión abre el navegador", "App not installed",
  "la app no se instala", "applicationId", "assetlinks", or asks "¿qué le pido a TI para la app?",
  "what do I ask IT for the tablet app?", "write the email to IT about the app". Trigger it even when
  the request is vague ("quiero la app en las tablets del equipo", "how do we get this on our
  tablets?"), in Spanish or English. Not for changing what the app does or looks like (that is
  freefield-app-extend). The company's FreeField WEBSITE is put online with the FreeField web
  repository's freefield-deploy skill, not this one.
---

# FreeField field app: from this repository to your company's tablets

The field app is an offline-first Android app (Capacitor + React) that goes with the FreeField website. Every company builds **its own copy**: named for the company, signed with the company's own key, signing in against the company's own website and Firebase project. Your job is to get the user there safely. You do the typing and explain each step in plain words, **in the user's language** (often Spanish).

The user is usually a BIM/VDC manager, field engineer or ops lead, not a developer. So:
- Run commands yourself and say in one sentence what each one does and why, before running it.
- Avoid jargon. Define unavoidable terms once; `references/glossary.es-en.md` has plain definitions. (The FreeField website's own glossary, in `vendor/free-field/.claude/skills/freefield-deploy/references/glossary.es-en.md`, covers Firebase, Hosting, Blaze and the rest. In Spanish the product says *incidencias* for tasks and *plano* for a PDF plan.)
- Show progress as a short checklist, not walls of log output. Summarise errors, then fix them.

## Ground rules (and why)

- **Ask before anything that installs software, costs money, or touches the website or production.** That covers the build tools (about 3 GB), any `firebase deploy`, billing, DNS, the website's `.well-known` file, and a Google Play developer account (it has a one-time fee). Say what will happen, then wait for a clear yes.
- **Never handle secrets in chat.** No passwords, key passwords, tokens or service-account files. The signing key and its passwords live in files you never print or read back (`signing/`, `signing.local.properties`). The Firebase *web config* is public by design (every browser that opens the website downloads it); even so, fetch it with the script instead of asking the user to paste it.
- **`firebase login` is a browser sign-in, not a password exchange.** Say: "A browser window opens; you sign in with your company Google account and click Allow. I never see your password." It is interactive, so the user runs it in a VS Code terminal (Terminal, then New Terminal).
- **Never invent names, ids, emails or addresses.** Use `{{…}}` placeholders until the user supplies the real value.
- **Reuse the repository's scripts; do not improvise.** Everything below uses `scripts/*.mjs` that already exist. `references/build-steps.md` is the verified sequence, with failures and fixes. The authoritative guides are `docs/company/INSTALL.md` and `docs/company/IT-REQUEST.md`.
- **Don't stall.** If you can't ask, state your assumptions at the top and proceed with safe defaults, then invite corrections.
- **Warn about synced folders.** If the repository is inside OneDrive, Dropbox, Google Drive or iCloud, strongly recommend moving it before `pnpm install` or any build. Those apps lock files while pnpm and Gradle write tens of thousands of them, which causes errors and very slow builds, and they can upload the signing key to the cloud. Offer `C:\dev\field-app` or `~/dev/field-app`, and let the user move or re-clone it.

## Step 1. Clarify the goal

If the intent is clear (for example "write the email to IT"), skip ahead. Otherwise ask once, "¿Qué quieres lograr?" / "What are you aiming for?", and offer:

| Path | What it is | Needs |
|---|---|---|
| **A. Try the demo** | The app with sample data and no sign-in, on an Android emulator or one tablet. Nothing is sent anywhere | Build tools. No Firebase. See `references/build-steps.md` §1 (and, for the demo seed, the extend skill's `references/verify.md` §7) |
| **B. First company build** | The company's own signed app, signing in against its website | The website online, a private copy of this repo, the build tools, about an hour the first time |
| **C. Update** | A new version over the one already on tablets | The same key and application id as before, a higher `versionCode` |
| **D. IT request only** | The ready-to-send email and annex | Nothing technical |

Path A is only for looking. Say so: the demo is never for company use.

## Step 2. Check the prerequisites

For paths B and C:
1. **The company's FreeField website must already be online on its own Firebase project, with sign-in working.** The app signs in with an e-mailed link that points at the website and uses the same Firestore and Storage. If it isn't online, stop and send the user to the FreeField web repository's **freefield-deploy** skill first (it lives in `vendor/free-field/.claude/skills/freefield-deploy/` here and in the web repository itself). Come back when the site loads over HTTPS and the sign-in e-mail arrives.
2. Android tablets on Android 8 or newer, and about 6 GB of free disk space on the computer.
3. Node.js 20+, pnpm 10 and Git. If missing, ask before installing (`corepack enable` gives pnpm).

## Step 3. A private copy of the repository

A fork of a public repository is always public, so **never fork for private use**. Offer one of:
- **Use this template**: on the public field-app repository, the green **Use this template**, then **Create a new repository**, owner = the company, visibility **Private**.
- **Import**: <https://github.com/new/import>, paste the public repository's address, choose **Private**.

Then clone it **with the web code it is built from** (the `vendor/free-field` submodule):
```bash
git clone --recurse-submodules <address of the private repository>
```
If it was cloned without that, run `git submodule update --init`. `vendor/free-field` must not be empty. Create a branch for the company's settings (`git checkout -b company/setup`) so the main branch stays easy to update.

## Step 4. Readiness check

```bash
pnpm install
node scripts/check-app-setup.mjs            # add --ascii on an old Windows console, --offline to skip the website test
```
It reads only your files (never prints a secret), and tests that the website serves `assetlinks.json`. Exit code 1 means blockers. Translate the result into: fine, I'll fix it now, needs IT. On a fresh copy it lists the settings, tools, Firebase file and key as missing; that is expected.

## Step 5. The build tools

```bash
node scripts/setup-android-toolchain.mjs --check          # changes nothing
```
Before installing, show the user: the **two licences** (Google's Android SDK terms, <https://developer.android.com/studio/terms>, and the Eclipse Temurin Java licence, GPLv2 with Classpath Exception), the **disk space** (about 3 GB for the tools plus about 2 GB for the first build; the script prints the free space), and that it installs **only into the user's own folder** (`~/.freefield-android`), needs no administrator rights, and verifies every download. Ask: "Do you accept these licences and shall I install?" Only then:
```bash
node scripts/setup-android-toolchain.mjs --accept-licenses
```
`--accept-licenses` means the user accepted them: never add it without asking. If the computer already has Java 21 (set `JAVA_HOME`), the script reuses it. If a company proxy blocks the downloads, that is an IT request (path D).

## Step 6. The company settings

Ask for exactly two things: the **app name** (under the icon, up to 30 characters, plain letters, numbers and spaces) and the **website address** (without `https://`, e.g. `{{WEBSITE_ADDRESS}}`).

Then **derive the application id** from the company's domain, reversed: `acme.com` gives `com.acme.field`; `acme-sa.cl` gives `cl.acme_sa.field` (hyphens become underscores; lowercase letters, digits and underscores only; every part starts with a letter). Propose it and explain, in one sentence, why it matters: **"This is the app's permanent identity on every tablet and in Google's eyes. If you change it later, tablets treat it as a different app and the old one keeps its offline data. Choose it once."** Wait for a clear confirmation. Never copy an id from an example.

Edit `company.config.json`: `appName`, `applicationId`, `authLinkDomain`; keep `versionName` `1.0.0` and `versionCode` `1`; leave `signingCertSha256` empty (the key script fills it). Commit this file (nothing in it is secret).

## Step 7. The Firebase config

The app needs the website's Firebase **web config** (six public values) in `apps/mobile/.env.production`, which Git ignores:
```bash
npx firebase-tools login                                   # the user runs this in a terminal; a browser opens
node scripts/fetch-firebase-config.mjs --project {{FIREBASE_PROJECT_ID}}
```
Check it with `firebase projects:list` first if unsure which project. Alternative if the website was deployed from this computer: `--from <the web repo's apps/settings/.env.production>`. The script prints the names it wrote, never the values, and adds the safety catch `VITE_EXPECTED_FIREBASE_PROJECT_ID` so a build can never target the wrong project. Never ask the user to paste values in chat.

## Step 8. The signing key (say this loudly)

```bash
node scripts/make-signing-key.mjs
```
It creates the key in `signing/` and random passwords in `signing.local.properties` (never printed), writes the public fingerprint into `company.config.json`, and writes `signing/assetlinks.json`.

Stop and say it plainly, in the user's language, before moving on:

> **Back up the key now, in your company password manager: the file `signing/<id>.p12` and the file `signing.local.properties`.** If you lose them, tablets that already have the app can never be updated again: the only way out is to uninstall the app, which erases that tablet's offline data. Do not send them by e-mail or paste them in chat, and never commit them (Git ignores them on purpose).

Ask them to confirm it is saved before you continue. Remind them that if this computer dies, the key goes with it.

## Step 9. App Links: make the sign-in e-mail open the app

For Android to open the e-mailed sign-in link **in the app** and not in a browser, the **website** must serve `/.well-known/assetlinks.json`. This changes the website (production), so **ask first**: "This adds one small file to your website repository and needs a website redeploy. Shall I prepare it?"

1. In the **web repository** (the one the website is deployed from, a separate folder), copy `signing/assetlinks.json` to `apps/settings/public/.well-known/assetlinks.json` (the folder name starts with a dot). Commit it there on a branch.
2. Redeploy the website with the web repository's **freefield-deploy** skill (it knows the order and asks for its own confirmation).
3. Check `https://{{WEBSITE_ADDRESS}}/.well-known/assetlinks.json` in a browser: JSON text, not the website's home page. `node scripts/check-app-setup.mjs` tests it too.

Android checks this file when the app is **installed**, so if it was published after tablets installed the app, reinstall. If the user wants to build before the website is ready, that works: the app is fine, only the sign-in link falls back to the browser until the file is live.

## Step 10. Build

```bash
node scripts/build-android.mjs            # signed .apk -> release/<AppName>-<version>.apk
node scripts/build-android.mjs --aab      # also the .aab, only for a private Google Play listing
```
It checks everything first and lists in plain words what is missing. The first build downloads a lot and takes 10 to 20 minutes; later ones are faster. At the end it verifies the signature, the application id and the name. Tell the user where the file is. The `release/` folder is git-ignored. Failures: `references/build-steps.md` §4.

## Step 11. Install on the tablets

Offer the options with their trade-offs from `references/distribution.md`, then do the one they choose:
- **USB with adb** (a few tablets; the agent can do it). The user turns on Developer options and USB debugging on the tablet and accepts the "Allow USB debugging?" box; then you run `adb devices` and `adb install -r release/<AppName>-<version>.apk` (adb is at `~/.freefield-android/sdk/platform-tools/adb`). Ask before installing on each device, and name the device.
- **Copy the file** to the tablet (cable, file share, link) and open it.
- **The company's device-management tool**: upload the `.apk` as a private app and assign it.
- **A private Google Play listing** with the `.aab`.

Then the user opens the app and signs in with a work e-mail address **that was invited in FreeField**.

## Step 12. Smoke test on a tablet (with the user)

1. Open the app and sign in: the e-mail arrives, the link **opens the app** (not the browser).
2. Pick the project.
3. More, then **Offline buildings**: download one building (model, plans, tasks). Wait until it says it is available offline.
4. Turn on airplane mode. Open **Model**: the 3D model shows, orbit with one finger, tap an element.
5. Open **Plans**: a plan opens and zooms.
6. **Tasks**: create a task (long-press on the plan or the model), take a photo, add a markup (draw on a capture of the location).
7. Turn the network back on. The header chip goes from offline to online and the **Sync** tab empties. Open the website on a computer and check the task and its photo arrived.
8. Rotate the tablet: both orientations work.

Anything that fails: `references/build-steps.md` §4, then ask whether the website is the issue.

## Step 13. Operate

- **Updates:** pull the newer app code, raise `versionCode` by 1 (and update `versionName`), build, and install the new `.apk` **over** the old one. Same application id and same key, so the offline data stays. Commands in `references/build-steps.md` §5. A new version of the **website** does not need a new app, unless the website address changes.
- **Rollback:** keep every released `.apk` (and its `versionCode`) in a company folder. Android refuses to install a lower `versionCode` over a higher one, so to go back, rebuild the old code with a **new, higher** `versionCode` and install that.
- **Backups:** the signing key (password manager) and the `company.config.json` in Git. Offline data on a tablet is a cache of what is in the cloud; unsynced changes are only on that tablet, so check the **Sync** tab before wiping or replacing a device.
- **Support:** MIT open source, **no SLA**. App bugs go to the app's public GitHub issues; Firebase outages and billing go through the company's Google support.

## Reference files (read when…)

- `references/build-steps.md`: before any build command and on any failure; the update, rollback and adb steps; the troubleshooting table.
- `references/distribution.md`: step 11, the install options and their trade-offs.
- `references/it-request-template.es.md` / `.en.md`: path D, or whenever IT must allow downloads, installs or a deploy window.
- `references/glossary.es-en.md`: plain definitions of APK, AAB, signing key, application id, App Links, sideload, adb.
- `docs/company/INSTALL.md` and `docs/company/IT-REQUEST.md`: the same flow as the repository's own guides.
- `scripts/check-app-setup.mjs`: step 4, and after every change.
