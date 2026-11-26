# Architecture of the field app

A map for deciding where a change goes. Paths are from the repository root. The app is one Capacitor shell around one React app: `apps/mobile`.

## Contents
1. [The two halves: this repo and the web code](#1-the-two-halves)
2. [Folder map of `apps/mobile/src`](#2-folder-map)
3. [Native (Android) side](#3-native-side)
4. [Where data lives, and the offline rule](#4-data-and-offline)
5. [Build flavours and flags](#5-build-flavours-and-flags)
6. [Test hooks](#6-test-hooks)
7. [The e2e lanes](#7-the-e2e-lanes)
8. [Company configuration](#8-company-configuration)

---

## 1. The two halves

The app **reuses the FreeField web code** as TypeScript source through the git submodule `vendor/free-field` (a pnpm workspace member list in `pnpm-workspace.yaml`; no build step). Never edit `vendor/free-field` from here: it is the web repository, and a company's edits there would be lost or conflict on the next update.

| Package (import) | Folder in `vendor/free-field/packages/` | What the app takes from it |
|---|---|---|
| `@ff/auth` | `ff-auth` | The sign-in provider, current user, memberships, the one current project id (`useProjectId`, `useProjectSelection`) |
| `@ff/data` | `ff-data` | The local database (Dexie / IndexedDB): buildings, models, plans, calibrations, the outbox table |
| `@ff/firestore` | `ff-firestore` | Firestore schema (zod), the **security rules** (`firestore.rules`, `storage.rules`), Cloud Functions |
| `@ff/sync` | `ff-sync` | The engine that downloads buildings for offline use (checks, resume, hashes) |
| `@ff/tasks` | `ff-tasks` | Headless task logic: statuses and transitions, field normalisers, the action payloads, the outbox engine, BCF export |
| `@ff/tasks-react` | `ff-tasks-react` | Task React pieces and hooks: `useTaskEngine`, chips, the compose model, the CSV builder, sheet catalog |
| `@ff/types` | `ff-types` | Shared types (outbox records, sync kinds) |
| `@ff/viewer`, `@ff/viewer-react` | `ff-viewer`, `ff-viewer-react` | The 3D engine (`@thatopen/*`, `three` only through it) and its React wrapper |
| `@ff/telemetry`, `@ff/tooling` | `ff-telemetry`, `ff-tooling` | In the workspace; the app code does not import telemetry directly |

Also read from the submodule: `vendor/free-field/apps/settings/src/styles/tokens.css` (the `--ff-*` colour and size tokens, imported by `apps/mobile/src/main.tsx` and read by `apps/mobile/capacitor.config.ts`), and the demo data (demo builds only): `apps/mobile/demo-seed/` (app-owned, always present) or, when it exists, the web repository's larger `vendor/free-field/apps/settings/public/seed/`. `apps/documents/src/compare/` of the web is used by the plan comparison (`apps/mobile/src/plans/compare/webCompare.ts`).

### Which side does a change belong on?

Ask: **"If the website users did this too, would it be the same change?"**

| The change is about... | It belongs in | Via |
|---|---|---|
| What a task *is*: its fields, statuses, who may do what, how it is stored, the CSV or BCF columns | **The web repo** (`@ff/tasks`, `@ff/tasks-react`, `@ff/firestore`) | The web repo's `freefield-extend` skill, then bump the submodule here |
| The Firestore or Storage security rules, indexes, Cloud Functions | **The web repo** (`packages/ff-firestore`) | Same, then deploy with the web repo's `freefield-deploy` |
| How it looks and behaves **on the tablet**: screens, buttons, the toolbar, gestures, offline flow, notifications, the PDF report, branding | **This repo** (`apps/mobile`, `apps/mobile/android`) | This skill |
| Showing an existing task field on the tablet | **This repo** | Recipe 3 |
| A brand-new task field that the website must also know | **Both**: web first (schema, rules, deploy), then this repo | Recipe 4 |

When in doubt, prefer this repo and keep the diff small and additive. A change to shared packages affects every user of the website and needs the web's tests and a rules deploy.

## 2. Folder map

`apps/mobile/src/`, with the responsibilities. Tests sit beside the code as `*.test.ts(x)`.

| Folder / file | Responsibility |
|---|---|
| `main.tsx`, `App.tsx` | Boot (imports `tokens.css` then `styles.css`, wraps `@ff/auth`'s provider, hash router), the gate: sign-in, then project picker, then the routed app. All routes are in `App.tsx` |
| `shell/` | `AppShell.tsx` (the header, the five tabs Plans / Model / Tasks / Sync / More, rail on tablets and tab bar on phones), `SyncChip.tsx`, `ConfirmDialog.tsx` |
| `auth/` | Email-link sign-in: `emailLink.ts`, `AuthLinkHandler.tsx` (completes the link when Android opens it), `config.ts` (continue URL from `authLinkDomain`), `postSignIn.ts` |
| `session.ts`, `projects/` | Demo-mode session gate; the projects opened on this device (needed to enter one offline) |
| `data/` | `signOut.ts`, `wipe.ts`: sign-out deletes every local database, file and key (after warning about unsynced changes) |
| `sync/`, `platform/` | The outbox: `SyncController.tsx` and `syncController.ts` (drain on network back or app resume), `outboxModel.ts`, `useOutbox.ts`; `network.ts` and `reachability.ts` (online, offline or unreachable), `BackButtonController.tsx`, `useBreakpoint.ts` (tablet at 840 dp or wider) |
| `offline/` | Downloading buildings for offline use: `manager.ts`, `journal.ts`, `engineBridge.ts` (adapts `@ff/sync`), `OfflineController.tsx`, `sources.ts` and `useOffline.ts` (where the model and plans are read from). UI: `pages/OfflinePage.tsx` |
| `storage/` | `BlobStore` over Capacitor Filesystem (`capacitorBlobStore.ts`, `ffmFiles.ts`), a memory version for tests |
| `model/` | The 3D view. `ModelView.tsx` (the one big component), `engine.ts`, `useModelSource.ts`, the camera toolbar (`CameraToolbar.tsx`, `toolbarLayout.ts`, `toolbarIcons.tsx`), the Tools menu (`ToolsMenu.tsx`) and panels (`SectionPanel.tsx`, `TreePanel.tsx`, `SearchPanel.tsx`, `FiltersSheet.tsx`, `ViewsPanel.tsx`), properties (`PropertiesSheet.tsx`), measurement (`MeasureTools.tsx`, `measure3d.ts`), walk mode (`WalkLayer.tsx`, `WalkLevelPicker.tsx`, `walkSplit.ts`), pins (`PinLayer.tsx`), memory (`memoryConfig.ts`, `lifecycle.ts`, `backgroundGuard.ts`, `progressive.ts`) |
| `linkview/` | The plan and 3D side by side. `LinkviewPage.tsx` / `LinkviewEntry.tsx` (the stand-alone page), `WalkSplitPlan.tsx` and `PlanPane.tsx` (the split used inside walk mode: the level's plan next to the model), `sync.ts` (the walker's position and the marker on the plan), `overlay.ts`, `plans.ts` (calibrated plans per level) |
| `plans/` | PDF plans: `PlanViewer.tsx`, tiled rendering in a worker (`pdfWorker.ts`, `tileService.ts`, `tileCache.ts`), `pins.ts` (task pins on a plan), `revisions.ts`, `compare/` |
| `tasks/` | The Tasks tab and everything about tasks on the tablet: `ListPane.tsx`, `Detail.tsx`, `Form.tsx` (the New task screen), `Extras.tsx` (priority, checklist, watchers, sheets), `edits.ts` (field edits as one outbox action), `createExtras.ts`, `drafts.ts`, `PhotoAttach.tsx` and `camera.ts` and `photoStore.ts`, `filters.tsx`, `bulk/` (multi-select actions), `export/` (PDF report, CSV, BCF), `annotate/` (drawing on a photo) |
| `markup/` | The drawing editor for **task markups** (`MarkupEditor.tsx`, `tools.ts`, `ink.ts`, `inkRender.ts`) and `tasks/markupAttach.ts` / `MarkupAttachments.tsx` (a markup is an attachment carried by a tagged comment) |
| `measure/` | Plan measurement (`PlanMeasure.tsx`, `planMath.ts`, the touch loupe) |
| `notifications/` | On-device notifications: `events.ts` (what is worth telling), `engine.ts` (planning, dedupe, deadline alarms), `settings.ts` (the per-category switches, stored on the device), `NotificationSettings.tsx` (the More screen block), `platform.ts` (the Android local-notification plugin), `tapRoute.ts` |
| `recovery/`, `diagnostics/` | Crash and restart recovery (`recovery.ts`), logs (`logger.ts`, `exportLogs.ts`), storage usage, app info |
| `pages/` | One file per routed screen: `PlansPage`, `PlanViewerPage`, `PlanComparePage`, `ModelPage`, `TasksPage`, `NewTaskPage`, `TaskMarkupPage`, `SyncPage`, `MorePage`, `OfflinePage`, `ProjectPickerPage`, `SignInPage` |
| `seed/` | Demo seed (`demoSeed.ts`): demo mode only |
| `dev/` | `flag.ts` (`testHooksEnabled()`), `TestHooks.tsx` |
| `styles.css`, `theme.ts` | The light theme: mobile names (`--bg`, `--text`, `--accent`, `--touch: 44px`) aliased onto the web `--ff-*` tokens |

Other places: `apps/mobile/index.html`, `apps/mobile/vite.config.ts` (reads `company.config.json`, refuses placeholders in company builds), `apps/mobile/capacitor.config.ts`, `apps/mobile/scripts/prepare-assets.mjs` (copies demo assets and the pdf.js runtime into `public/`), `apps/mobile/scripts/emulator-env.sh`.

## 3. Native side

`apps/mobile/android/` is a standard Capacitor Android project. The Java code lives in the fixed package `app.freefield.field` (`namespace` in `app/build.gradle`); only the `applicationId` follows the company config.

| File | What it does |
|---|---|
| `app/src/main/java/app/freefield/field/MainActivity.java` | The activity: edge-to-edge insets, remote debugging in debug builds only |
| `.../FfmFilesPlugin.java` | A custom Capacitor plugin: downloads straight to disk with HTTP Range and resume, streaming SHA-256, free-space check, keep-awake. Used by `src/storage/ffmFiles.ts` and `src/offline/nativeFiles.ts` |
| `.../FfmWebViewClient.java`, `RendererRecovery.java` | WebView request handling and recovery when Android kills the renderer for memory |
| `app/src/main/AndroidManifest.xml` | Permissions and the App Links intent filter (sign-in link host from `authLinkDomain`), the FileProvider |
| `app/src/main/res/` | Icons (`mipmap-*`, `drawable-v24/ic_launcher_foreground.xml`, `values/ic_launcher_background.xml`), the splash (`drawable/splash.png` and the `drawable-port-*` and `drawable-land-*` copies), colours (`values/ff_colors.xml`), the notification icon (`drawable/ic_stat_ff.xml`), `values/styles.xml` |
| `app/build.gradle` | Reads `company.config.json`: applicationId, version, app name (`resValue`), release signing |
| Capacitor plugins | Camera, Filesystem, Local Notifications, Network, Preferences, Share, Splash Screen, App (listed in `apps/mobile/package.json`) |

Native changes need a real build and an install to check. Prefer a TypeScript-only change when there is a choice.

## 4. Data and offline

- **Reads** come from the local database and the offline files, kept fresh by the sync. The tablet shows data fine with no network.
- **Every write goes through the outbox, never straight to Firestore.** Build the payload with `buildActionPayload(...)` from `@ff/tasks` and call `engine.enqueue(payload)` on the engine from `useTaskEngine()` (see `tasks/Detail.tsx`, `tasks/Form.tsx`, `tasks/edits.ts`). The record is stored on the device first, shown immediately (with a "pending" flag), and sent when the network is back, with retries. A write that bypasses this loses data in a basement with no signal. Photos and markups travel the same way as attachments of a comment or task (`tasks/photoStore.ts`, `tasks/markupAttach.ts`).
- **Personal preferences** (filters, notification switches) go in `localStorage` through small wrapper modules (`notifications/settings.ts`, `model/filterPrefs.ts`), keys prefixed `ffm` so the sign-out wipe removes them (`data/wipe.ts` removes keys starting `ff-`, `ffm`, `emailForSignIn`).
- **Sign-out erases the device's project data.** Anything new you store must be covered by that wipe (use the existing prefixes or the Dexie databases it already enumerates).
- **Only one 3D viewer at a time.** Memory on tablets is tight: `model/lifecycle.ts` and `backgroundGuard.ts` tear a viewer down when the page leaves. Never mount a second `@ff/viewer-react` viewer next to the first.

## 5. Build flavours and flags

| Flavour | How | Flags | Contains |
|---|---|---|---|
| **Dev (browser)** | `pnpm dev` (http://localhost:5174) | `VITE_FF_DEMO_AUTH=true` | Demo mode, demo seed |
| **Demo debug APK** | `pnpm android:debug` | demo auth | Demo data bundled; debug key |
| **e2e APK** | `pnpm android:debug:e2e` (what `pnpm e2e` installs) | demo auth + `VITE_FFM_TEST_HOOKS=true` | The `window.__ffm*` test hooks |
| **Perf APK** | `pnpm android:debug:perf` | test hooks | For the performance spec |
| **Emulator (cloud-mode) APK** | `pnpm android:debug:emulator` | `apps/mobile/scripts/emulator-env.sh`: fake Firebase ids, `VITE_FIREBASE_USE_EMULATOR=true`, test hooks, `FFM_EMULATOR_BUILD=true` | Talks to the Firebase emulators |
| **Company release** | `node scripts/build-android.mjs` (see `freefield-app-deploy`) | `FFM_COMPANY_BUILD=true`, `FFM_SKIP_DEMO_ASSETS=true`, no demo auth, no hooks | Real Firebase, no demo data, signed |

`pnpm check:release` fails if any `window.__ffm*` hook ended up in a release bundle; `pnpm check:singletons` verifies a single bundled copy of react, dexie, firebase, three and `@thatopen/*`.

## 6. Test hooks

Only in builds with `VITE_FFM_TEST_HOOKS=true`, gated by `testHooksEnabled()` in `src/dev/flag.ts` (a literal `import.meta.env` comparison Vite folds away in release): `window.__ffmPlans`, `__ffmTest`, `__ffmLinkview`, `__ffmWalkSplit`, `__ffmModelDebug`, `__ffmLoadMarks`, `__ffmExportLog`. Add new hooks the same way, and never read them from production code paths.

## 7. The e2e lanes

Both lanes drive a real Android emulator through Playwright's `_android` support. They are **heavy** (a Gradle build, an emulator boot, minutes to hours) and need the Android emulator and a system image; the developer notes are in `docs/DEV.md`.

| Command | Lane |
|---|---|
| `pnpm e2e` | **Demo lane.** Builds the e2e debug APK, boots the emulator (AVD name `ffm_x216`, or `FFM_AVD=<name>`), runs the specs in `e2e/*.spec.ts`. One spec: `pnpm e2e e2e/app.spec.ts` |
| `pnpm e2e:emulator` | **Cloud-mode lane.** Adds the Firebase Auth, Firestore and Storage emulators (project `demo-freefield`, from `vendor/free-field/firebase.json`) and runs `e2e/emulator/*.spec.ts` |

Helpers: `e2e/app.ts` (launch, `ACTIVITY` is `${PKG}/app.freefield.field.MainActivity`), `e2e/company.ts` (reads the company config). The scripts use `flock /tmp/ffm-heavy.lock` on the original developer machine to serialise heavy jobs; it is Linux-only and optional elsewhere. Useful knobs: `FFM_EMU_SNAPSHOT=-no-snapshot`, `FFM_EMU_WINDOW=0` (headless), `FFM_GPU=host` if WebGL2 fails. Always tear down afterwards (`adb emu kill`, `./gradlew --stop`).

## 8. Company configuration

`company.config.json` (repo root) is the single source for `appName`, `applicationId`, `versionName`, `versionCode`, `authLinkDomain`, `signingCertSha256`. Gradle, `capacitor.config.ts`, `vite.config.ts`, the e2e helpers and the build scripts all read it through `scripts/lib/company.mjs`. A git-ignored `company.config.local.json` overrides it on one computer.

- **Never change `applicationId` or the signing key of an app already on tablets.**
- Raise `versionCode` by 1 for every release.
- Changing `appName` is safe: it only changes the label (`resValue` in `app/build.gradle`).
- The `Java` package `app.freefield.field` stays; do not rename it.
