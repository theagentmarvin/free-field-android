# FreeField field app: developer setup

## Prerequisites
- node 24, pnpm 10.30 (`corepack enable`), JDK 21, Android SDK with an AVD named `ffm_x216` (API 36, x86_64, KVM, 1200x1920 @240dpi, 2 GB: matches the target 10-inch tablet). Optional `ffm_tablet` (API 35, 2560x1600) for the large layout: `FFM_AVD=ffm_tablet pnpm e2e`.
- `source scripts/env.sh` sets `JAVA_HOME`, `ANDROID_HOME` and `PATH` (defaults: `~/local/jdk-21-full`, `~/Android/Sdk`).

## First checkout
```bash
git clone --recurse-submodules <repo>      # or: git submodule update --init
pnpm install                               # one lockfile, vendored @ff/* packages are workspace members
```
`vendor/free-field` is the public FreeField web repository (tracks `main`, pinned by commit). Never edit it from here; changes to the web code go to the web repository.

## Scripts (repo root)
| Command | What |
|---|---|
| `pnpm typecheck` | `tsc --noEmit` for the app (including vendored sources) and the e2e project |
| `pnpm lint` | ESLint (minimal) |
| `pnpm test` | Vitest (BlobStore contract tests etc.) |
| `pnpm build` | Vite build (demo auth on) |
| `pnpm android:debug` | build + `cap sync` + `gradlew assembleDebug` -> `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`. No test hooks inside |
| `pnpm android:debug:e2e` | the same with `VITE_FFM_TEST_HOOKS=true` (what `pnpm e2e` installs) |
| `pnpm e2e` | debug APK, headless emulator session, Playwright `_android` specs; screenshots in `test-results/` |
| `pnpm e2e:emulator` | cloud-mode lane: emulator-env APK, Firebase auth/firestore/storage emulators from the vendored `firebase.json` (project `demo-freefield`), `adb reverse` 9099/8080/5001/9199, Playwright specs in `e2e/emulator/` |
| `pnpm check:release` | two Vite builds (under the lock): fails when any `window.__ffm*` hook is in the release bundle, and when the e2e bundle lacks them |
| `pnpm check:singletons` | builds and verifies exactly one bundled copy of react, dexie, firebase, three, @thatopen/* ... |

## Resource rules (7 GB box)
Every heavy command runs under `flock /tmp/ffm-heavy.lock`. `scripts/emu-session.sh <apk> -- <cmd>` takes the lock, boots the emulator (with a visible window when a desktop session is available; `FFM_EMU_WINDOW=0` forces headless) (`FFM_GPU=swiftshader_indirect` by default; set `FFM_GPU=host` if WebGL2 fails), installs the APK, runs the command, then always does `adb emu kill` and `gradlew --stop`. Gradle's daemon is disabled in `android/gradle.properties`. Gradle builds: wrap manually, e.g. `flock -o /tmp/ffm-heavy.lock pnpm android:debug`. Every lock holder is capped: `FFM_LOCK_MAX_SECS` (default 2700 s) for emulator sessions, 900 s for builds; on expiry `timeout` signals the whole process group, the traps tear the emulators down and KILL follows. Always pass `-o`: without it, a daemon started inside the lock (adb server, Gradle) inherits the lock fd and holds it forever.

## Demo mode and demo data
`VITE_FF_DEMO_AUTH=true` (set by the dev/build scripts) runs `@ff/auth` in demo mode with zero backend. The seed (`src/seed/demoSeed.ts`) injects project/building/storey metadata from the demo manifest and the shared task engine seeds its demo tasks. `apps/mobile/scripts/prepare-assets.mjs` copies the demo `.frag`, plan PDFs and manifest into `public/` (git-ignored) before dev/build.

Two data sets exist:
- **App-owned demo seed** (`apps/mobile/demo-seed/`, always in the repository): one `.frag` model converted from the web repository's public `sample.ifc`, one generated floor plan PDF ("S-101 - First Floor", grid, columns, beams, title block "FreeField demo") and the calibration that links it to the storey "101 FIRST FLOOR", so the Link view and the walk split work. The demo tasks come from the shared task engine. Rebuild it with `node apps/mobile/scripts/build-demo-seed.mjs <path to sample.ifc>`; the script neutralises the IFC header and application names first, so the `.frag` carries no authoring-tool names.
- **Maintainer data set** (`vendor/free-field/apps/settings/public/seed/`, only in private development): three models (structural, MEP, architectural) and several plans, including a 20 MB sheet. `prepare-assets.mjs` uses it when present. `FFM_FORCE_APP_SEED=1` forces the app-owned seed even then, to verify the public setup (`FFM_FORCE_APP_SEED=1 pnpm e2e e2e/public-smoke.spec.ts`).

The e2e specs other than `e2e/public-smoke.spec.ts`, the emulator-lane seed helpers (`e2e/emulator/realSeed.ts`, `offlineSeed.ts`, `plan-revisions.spec.ts`) and the unit test `src/dev/realDataDocs.test.ts` are written against the maintainer data set (plan names such as P-101, MEP models). Without it, `realDataDocs.test.ts` skips itself and those e2e lanes cannot run; the public smoke spec is the check a contributor can run.

## Models
Mobile loads only `.frag` (SPEC A5b); IFC is never parsed on device. The Model tab installs the bundled sample into the BlobStore (Capacitor Filesystem, `Directory.Data`) and the viewer reads it back from there.

## Debugging
Debug builds enable WebView remote debugging (`chrome://inspect`); release builds do not.

## Cloud mode and the Firebase emulator lane
- Cloud sign-in is an email link. The continue URL is `https://$VITE_FF_AUTH_LINK_DOMAIN/finish-sign-in` (taken from `authLinkDomain` in `company.config.json`; `VITE_FF_AUTH_LINK_DOMAIN` overrides it; there is no built-in default); the debug/release manifest has an App Links intent filter for that host, and `@capacitor/app` `appUrlOpen` completes `signInWithEmailLink`. The verification file (`assetlinks.json`) is produced by `node scripts/make-assetlinks.mjs`; see `docs/company/INSTALL.md`.
- `apps/mobile/scripts/emulator-env.sh` holds the build env of the emulator APK (`VITE_FIREBASE_USE_EMULATOR=true`, `VITE_FFM_TEST_HOOKS=true`, fake API key). `@ff/auth` honours `VITE_FIREBASE_EMULATOR_HOST` (default `localhost`; `adb reverse` makes that reach the host) and `VITE_FIREBASE_FUNCTIONS_REGION`.
- The e2e specs fetch the sign-in link from the Auth emulator REST API (`/emulator/v1/projects/demo-freefield/oobCodes`) and deliver it with an explicit-package VIEW intent. The seed (users, projects, memberships) runs in Playwright's global setup through the emulators' REST admin endpoints.
- The functions emulator is not started (vendored functions have no installed dependencies). The whole lane runs under `/tmp/ffm-heavy.lock`; teardown stops the Firebase emulators, the AVD and Gradle.
- Debug builds allow cleartext http (emulator traffic over adb reverse); the emulator build also sets Capacitor `allowMixedContent`.

## Offline packages
- `apps/mobile/src/offline/`: journal (Dexie `ffm-offline`), download manager, native streaming plugin wrapper, sources/hooks. Native side: `android/app/src/main/java/app/freefield/field/FfmFilesPlugin.java` (HTTP Range download straight to disk, streaming sha256, free space, keep-awake).
- `OfflineController` runs `@ff/sync` (`createSyncEngine`) for the current project (stopped on project switch/sign-out) and the manager; UI at `/offline` (More > Offline buildings).
- Emulator e2e `e2e/emulator/offline.spec.ts` seeds Storage through the emulator REST API and reaches it through a rate-limiting proxy (device 9199 -> proxy -> emulator) so a kill can land mid-download. 

## Test hooks
`window.__ffmPlans` (render probe) and `window.__ffmTest` (task seam) exist only in builds with `VITE_FFM_TEST_HOOKS=true` (`android:debug:e2e`, `scripts/emulator-env.sh`). They are guarded by `testHooksEnabled()` (`src/dev/flag.ts`), a literal `import.meta.env` comparison that Vite folds at build time, so release bundles contain neither the hooks nor their lazy chunks; `pnpm check:release` enforces it. The Model tab probes (`__ffmModel`, `__ffmModelDebug`, `__ffmBgGuard`) are gated the same way; the check has no exceptions.

## Plans: A/B renderer measurement
`FFM_PERF_AB=1 FFM_PERF_VARIANTS=legacy,new bash scripts/e2e.sh e2e/plans-perf.spec.ts` renders the 20 MB A0 sheet once per variant in a fresh app process (peak PSS of the app and the WebView renderer, wall time, per-level time, a max-zoom crop of the same page region). Results: `test-results/plans-ab-<variant>.json` and `-crop.png`. 

## QA specs
`e2e/qa-ui.spec.ts` (demo lane) and `e2e/emulator/qa-sync.spec.ts` (emulator lane) are the exploratory device-action suites; They change device state (rotation, font scale, clock, time zone, disk filler, tunnels) and restore it in `afterEach`/`afterAll` (`e2e/qa.ts`). Clock, time-zone and disk-fill tests need a root shell (`adb root`, google_apis images) and skip themselves otherwise. `scripts/emu-session.sh` knobs: `FFM_BOOT_TRIES`, `FFM_BOOT_TIMEOUT`, `FFM_EMU_SNAPSHOT` (e.g. `-no-snapshot`).

## Sync chip and reachability
The header chip (`data-state` online / offline / unreachable) combines the OS link state (`@capacitor/network`) with backend reachability (`src/platform/reachability.ts`): the outbox engine's reachability signal, network-class download failures and stalls, and a rare probe that runs only while outbox work is waiting (backoff 5 to 60 s, never while idle). Demo mode has no backend and shows only Online/Offline. The download manager has a stall watchdog (30 s without bytes or state change; e2e builds can shorten it with `localStorage["ffm.stallMs"]`).

## 3D model tools
Filters button + sheet, Tools menu (Section, Model tree, Search). They rely on `addSectionPlane` options, `updateSectionPlane` and `removeSectionPlane` of `@ff/viewer-react`. The e2e probes (`dbg(...).tools()`, `sampleElement()`, `selectionScreen()`, `drawStats()`) are test-hook builds only.

## Company build (open-source distribution)
- `company.config.json` (repo root) is the one place for the app name, Android `applicationId`, version, sign-in domain and the public signing fingerprint. Gradle, `capacitor.config.ts`, `vite.config.ts`, the e2e helpers and `scripts/device-session.sh` all read it (`scripts/lib/company.mjs`). A git-ignored `company.config.local.json` (same keys) overrides it for local development, for example to keep a different application id on your own tablets; `FFM_COMPANY_CONFIG=<file>` points everything at another file.
- The Java code stays in the fixed package `app.freefield.field` (Gradle `namespace`); only `applicationId` changes. So the launch intent in e2e is `${PKG}/app.freefield.field.MainActivity` (`ACTIVITY` in `e2e/app.ts`), not `${PKG}/.MainActivity`.
- Demo and e2e builds (`VITE_FF_DEMO_AUTH=true`, emulator lane) work with the placeholder config. A real build (`FFM_COMPANY_BUILD=true`, set by `scripts/ci-build-android.sh`) refuses placeholders and checks the Firebase web variables and the signing secrets.
- Company build, local (the main path): `node scripts/setup-android-toolchain.mjs --accept-licenses` (user-local JDK 21 + Android SDK in `~/.freefield-android`, `--check`, `--dir`, `--own-jdk`; `FFM_TOOLCHAIN_DIR` points the other scripts at another folder), `node scripts/make-signing-key.mjs` (keytool, PKCS12; passwords in git-ignored `signing.local.properties`; `FFM_SIGNING_PROPS` overrides its location), `node scripts/fetch-firebase-config.mjs` (writes git-ignored `apps/mobile/.env.production`), `node scripts/build-android.mjs [--aab]` -> `release/<AppName>-<version>.apk`. `FFM_GRADLE_PREFIX="flock -o /tmp/ffm-heavy.lock"` wraps Gradle on the shared dev box. A throwaway end-to-end check: set `FFM_COMPANY_CONFIG`, `FFM_SIGNING_PROPS`, `FFM_TOOLCHAIN_DIR` to scratch paths, run the key helper with `--out <scratch>`, write a fake `.env.production`, then build.
- Optional GitHub workflow `.github/workflows/build-android.yml` runs the same `scripts/build-android.mjs` (through `scripts/ci-build-android.sh`) with secrets/variables.
- Company-facing guides: `docs/company/INSTALL.md`, `docs/company/IT-REQUEST.md`. Readiness check: `node scripts/check-app-setup.mjs`.
