# Build steps (verified against the repository)

The exact sequence behind `SKILL.md`, as run end to end on a Linux machine with a throwaway company config, a throwaway key and a fake Firebase file (build time about 2 minutes with warm caches; the very first build on a clean machine downloads Gradle and the Android libraries and takes 10 to 20 minutes). Windows and macOS use the same Node scripts but were not tested here.

## Contents
1. [Path A: try the demo](#1-path-a-try-the-demo)
2. [Path B: first company build](#2-path-b-first-company-build)
3. [Installing with adb](#3-installing-with-adb)
4. [Troubleshooting](#4-troubleshooting)
5. [Path C: update, and rollback](#5-path-c-update-and-rollback)
6. [Throwaway dry run (no real secrets)](#6-throwaway-dry-run)

All commands run from the repository root.

---

## 1. Path A: try the demo

The demo build runs the app in demo mode (`VITE_FF_DEMO_AUTH=true`): sample building, sample tasks, no sign-in, no backend.

**The demo data ships with this repository.** The app never parses IFC, so its demo uses pre-built files: the small app-owned demo seed in `apps/mobile/demo-seed/` (one 3D model and one calibrated floor plan), copied into the app by `apps/mobile/scripts/prepare-assets.mjs`. When the web repository's larger maintainer data set is present the build uses that instead; `FFM_FORCE_APP_SEED=1` forces the small one.

```bash
pnpm install
pnpm dev                       # in a browser: http://localhost:5174 (a quick look, not a real tablet)
```
For an emulator or a tablet, build the debug app. It needs `JAVA_HOME` and `ANDROID_HOME` in the environment (the setup script prints both at the end, and saves them in `~/.freefield-android/toolchain.json`):
```bash
JAVA_HOME=<java folder> ANDROID_HOME=<sdk folder> pnpm android:debug
~/.freefield-android/sdk/platform-tools/adb install -r apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
```
(On Windows, set the two variables first with `set`.) The debug app uses the application id from `company.config.json` (the placeholder is fine) and a debug key, so it **conflicts** with a real company app that has the same id and another key: use a different tablet or uninstall one of them. To keep a different id only on your own devices, put it in the git-ignored `company.config.local.json`.

Never run this against a tablet the company already uses without asking: installing over an app with another key fails, and uninstalling erases its offline data.

## 2. Path B: first company build

```bash
# 0. Prerequisites: node -v (20+), pnpm -v (10), git --version; vendor/free-field not empty
pnpm install

# 1. What is missing? (reads only; --offline skips the website test; --ascii for old Windows consoles)
node scripts/check-app-setup.mjs

# 2. Tools: show licences and disk space, ask, then
node scripts/setup-android-toolchain.mjs --check
node scripts/setup-android-toolchain.mjs --accept-licenses     # JDK 21 + Android SDK into ~/.freefield-android

# 3. company.config.json: appName, applicationId, authLinkDomain (see SKILL.md step 6)

# 4. Firebase web config -> apps/mobile/.env.production (git-ignored)
npx firebase-tools login                                        # browser sign-in, the user runs it
node scripts/fetch-firebase-config.mjs --project {{FIREBASE_PROJECT_ID}}
#   or: node scripts/fetch-firebase-config.mjs --from <web repo>/apps/settings/.env.production
#   --force replaces an existing file

# 5. Signing key (once). BACK IT UP NOW.
node scripts/make-signing-key.mjs

# 6. assetlinks.json goes to the WEB repo, then redeploy the website (ask first):
#    signing/assetlinks.json -> <web repo>/apps/settings/public/.well-known/assetlinks.json
node scripts/make-assetlinks.mjs          # regenerates signing/assetlinks.json any time

# 7. Check again, then build
node scripts/check-app-setup.mjs          # all green: "0 blocker(s)"
node scripts/build-android.mjs            # release/<AppName>-<version>.apk
node scripts/build-android.mjs --aab      # plus the .aab for a private Google Play listing
```

What each script does and writes:

| Script | Writes | Notes |
|---|---|---|
| `setup-android-toolchain.mjs` | `~/.freefield-android/` (JDK, SDK, `toolchain.json`), `apps/mobile/android/local.properties` | Checksummed downloads, safe to rerun. Flags: `--check`, `--accept-licenses`, `--dir <folder>`, `--own-jdk`. With `--dir`, set `FFM_TOOLCHAIN_DIR` to the same folder for the other scripts. It reuses a Java 21 found through `JAVA_HOME`. |
| `fetch-firebase-config.mjs` | `apps/mobile/.env.production` | Prints names, never values. Refuses to overwrite without `--force`. |
| `make-signing-key.mjs` | `signing/<id>.p12`, `signing.local.properties`, `signing/assetlinks.json`, fingerprint into `company.config.json` | Random passwords never printed. `--out <folder>`, `--alias <name>` (default `field-app`). |
| `make-assetlinks.mjs` | `signing/assetlinks.json` | `--fingerprint AA:BB:..` (repeatable, for example your key plus a private Google Play listing's key), `--out <file>`. |
| `build-android.mjs` | `release/<AppName>-<version>.apk` (and `.aab`) | Runs `pnpm install` first unless `--skip-install`. Verifies signature, application id, name, version. |

The build refuses placeholders on purpose (`My Company Field`, `com.example.field`, `freefield.example.com`), so nobody ships an app that points at somebody else's website.

Advanced: if the machine already has Java 21 and an Android SDK somewhere else, `FFM_JAVA_HOME` and `FFM_ANDROID_HOME` point `build-android.mjs` and `make-signing-key.mjs` at them (the SDK needs platform `android-35` and build-tools `35.0.0`). `FFM_COMPANY_CONFIG` and `FFM_SIGNING_PROPS` point at another config or properties file.

## 3. Installing with adb

adb is installed by the setup script at `~/.freefield-android/sdk/platform-tools/adb` (`adb.exe` on Windows).

1. On the tablet: Settings, About tablet, tap **Build number** 7 times; Settings, Developer options, **USB debugging** on.
2. Connect the cable and accept "Allow USB debugging?" on the tablet.
3. `adb devices` must show the tablet as `device` (not `unauthorized`, not empty).
4. `adb -s <serial> install -r release/<AppName>-<version>.apk` (`-r` keeps the data when updating). Success prints `Success`.
5. `adb -s <serial> shell monkey -p <applicationId> 1` opens the app (optional).

Ask before installing, name the device, and never run `adb uninstall`, `adb shell pm clear` or a wipe without an explicit yes: they delete the offline data.

## 4. Troubleshooting

| What you see | What it means and what to do |
|---|---|
| "The app cannot be built yet" followed by a list | Do each line. They point to `company.config.json`, `apps/mobile/.env.production`, the key or the tools. Rerun `node scripts/check-app-setup.mjs` |
| "Java 21 was not found" or `JAVA_HOME is not set` | `node scripts/setup-android-toolchain.mjs --accept-licenses`. Java 17 or 11 is not enough. If Java 21 is installed elsewhere, set `FFM_JAVA_HOME` |
| "The Android SDK was not found" / "SDK location not found" | Same script. It also writes `apps/mobile/android/local.properties` |
| "You have not accepted the license agreements" (Gradle) | The licences were not accepted: ask the user, then `node scripts/setup-android-toolchain.mjs --accept-licenses` |
| Gradle: "Could not resolve ..." / "Connection reset" / checksum mismatch during setup | Network or proxy. Check the internet connection first; behind a company proxy this is an IT request (`references/it-request-template.*.md`, hosts listed there) |
| The first build seems frozen | It downloads Gradle and libraries; 10 to 20 minutes is normal. Later builds reuse the downloaded files and are much faster |
| Gradle: "OutOfMemoryError" or the computer freezes | Close other programs; Gradle is set to use up to 1.5 GB (`apps/mobile/android/gradle.properties`) and the whole build needs a few GB free. Retry |
| `there is no signing key yet` | `node scripts/make-signing-key.mjs`. If the key already exists, restore `signing/` and `signing.local.properties` from the password manager (never create a second key for an app already on tablets) |
| "This key is not the one named in company.config.json" | The restored key is not the original one. Use the original (check `signingCertSha256`) |
| "VITE_EXPECTED_FIREBASE_PROJECT_ID must be exactly the same ..." | Typo in `apps/mobile/.env.production`; fix and rebuild |
| "The FreeField web code (vendor/free-field) is missing" | `git submodule update --init` |
| `prepare-assets: no demo seed found` | `apps/mobile/demo-seed/` was deleted. Restore it with `git checkout -- apps/mobile/demo-seed`. Not a company build problem |
| adb: `no devices/emulators found` | Cable or USB mode (File transfer), USB debugging off, or the driver (Windows); try another cable |
| adb: device `unauthorized` | Unlock the tablet and accept "Allow USB debugging?"; or toggle USB debugging |
| Tablet: "App not installed" | Most common cause: an older build with another key or another application id is installed, or the file is damaged or incomplete. Check with `adb install -r` (it prints the exact reason), uninstall the old build only with the user's yes (this deletes its offline data), copy the file again |
| adb: `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | **Key mismatch**: the installed app was signed with another key (a debug build, a build from another computer or a lost key). Updates are only possible with the original key. Options: find the original key, or uninstall (data lost) and install fresh, then keep this key for ever |
| adb: `INSTALL_FAILED_VERSION_DOWNGRADE` | `versionCode` is lower than the installed one. Raise it above the installed number and rebuild |
| adb: `INSTALL_FAILED_CONFLICTING_PROVIDER` or "conflicts with an existing package" | An older build with the same package name but a different key, or another app with the same application id. Same remedy as the key mismatch |
| Tablet blocks the file ("for security reasons your phone is not allowed to install unknown apps") | Allow installs from that source (Files or browser) once, or a company policy blocks it: ask IT. A "Play Protect" box: **More details, Install anyway** |
| The sign-in link opens the browser, not the app | `assetlinks.json` is missing, wrong or cached on the website. Fetch `https://{{WEBSITE_ADDRESS}}/.well-known/assetlinks.json` (it must be JSON, with the app's id and the key's fingerprint). Then **reinstall** the app (Android verifies at install time). Workaround: Settings, Apps, the app, **Open by default**, add the website address |
| Opening the link in the browser signs in "on the website", the app stays signed out | Same cause. The app has no paste-the-link box |
| The sign-in e-mail never arrives | Spam folder; the address must be invited in FreeField; Firebase console, Authentication, Sign-in method: **Email link** on; the website address in **Authorized domains**. That is the web side (freefield-deploy) |
| "configuration" or "tenant" error when the app starts | `apps/mobile/.env.production` points at a different Firebase project than the website; fix and rebuild |
| Out of disk space | Free about 6 GB, or install the tools on another drive: `--dir D:\freefield-android` and set `FFM_TOOLCHAIN_DIR` to it |
| Behind a proxy | pnpm and npm read the proxy from their own settings, and Gradle reads it from `~/.gradle/gradle.properties` (`systemProp.https.proxyHost` and `systemProp.https.proxyPort`). These proxy settings were not tested here. The simplest fix is for IT to allow the hosts listed in the request template for the build computer |
| `Failed to resolve import @ff/sync` (or another `@ff/*` import) | The submodule is at a web commit that lacks a package the app needs. Move `vendor/free-field` to the commit the app expects (`git submodule update --init`), then `pnpm install` |

## 5. Path C: update, and rollback

Update to a new upstream version:
```bash
git remote add upstream {{PUBLIC_REPO_ADDRESS}}      # first time only
git fetch upstream
git merge upstream/main                              # the agent resolves conflicts and tells the user
git submodule update --init
pnpm install
```
Then in `company.config.json` raise `versionCode` by 1 and set `versionName`, build, and install over the old app (`adb install -r`, a new file copy, the device-management tool, or Play). **Same application id, same key**: the offline data stays.

If the update changed the data the app syncs, the website may need the matching update first (read the release notes; use the web repository's freefield-deploy skill). Ask before touching the website.

Rollback: Android will not install a lower `versionCode`. Keep every released file, then to go back, check out the old code, set a **higher** `versionCode` than the broken release, rebuild and install. Never change the application id or the key to "start fresh": that wipes offline data.

## 6. Throwaway dry run

To check this whole flow without real data (what was done to validate this skill): point everything at scratch files, make a key in a scratch folder, write a fake Firebase file, build, then delete it all.
```bash
export FFM_COMPANY_CONFIG=<scratch>/company.json        # fake name, id, website
export FFM_SIGNING_PROPS=<scratch>/signing.local.properties
export FFM_JAVA_HOME=<java 21 folder> FFM_ANDROID_HOME=<sdk folder>
node scripts/make-signing-key.mjs --out <scratch>/signing
# write apps/mobile/.env.production with fake VITE_FIREBASE_* values and a matching VITE_EXPECTED_FIREBASE_PROJECT_ID
node scripts/build-android.mjs --skip-install --aab
# then: remove release/, apps/mobile/.env.production and the scratch folder
```
Never run this against the real `company.config.json` or `signing/`.
