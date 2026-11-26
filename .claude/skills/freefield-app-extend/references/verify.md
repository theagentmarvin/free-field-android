# Verifying a change to the field app

The exact commands to run before telling the user a change works. All run from the repository root. They come from the root `package.json`, `apps/mobile/package.json` and `docs/DEV.md`.

## Contents
1. [Setup and baseline](#1-setup-and-baseline)
2. [Typecheck](#2-typecheck)
3. [Lint](#3-lint)
4. [Unit tests](#4-unit-tests)
5. [Release-bundle checks](#5-release-bundle-checks)
6. [Emulator e2e (heavy)](#6-emulator-e2e)
7. [Run it and show the user](#7-run-it-and-show-the-user)
8. [Reading failures](#8-reading-failures)

---

## 1. Setup and baseline

- Node.js 20+ and pnpm 10 (`packageManager: pnpm@10.30.1`; `corepack enable` if pnpm is missing). `git submodule update --init` first if `vendor/free-field` is empty, then `pnpm install`.
- **Take a baseline before editing.** On a clean checkout the three checks below pass (about 866 unit tests when this skill was written). Then you can say "this failure was already there" with confidence.
- A check fails in code you did not touch? Reproduce it on the base commit before blaming your change: `git stash`, re-run, `git stash pop`; or a throwaway `git worktree add ../app-base <commit>`.

## 2. Typecheck

```bash
pnpm typecheck        # app (including the vendored web sources it imports) and the e2e project; about 20 s
```
`pnpm test` is not gated on type errors, so always run this too.

## 3. Lint

```bash
pnpm lint             # ESLint over apps/mobile/src; about 10 s. `any` is an error
```

## 4. Unit tests

```bash
pnpm test                                             # all of the app's unit tests, one file at a time; about 1 min
pnpm --filter @ffm/mobile exec vitest run src/tasks   # a folder or a file only
```
`pnpm test` runs `vitest run --no-file-parallelism` in `apps/mobile` (jsdom, fake IndexedDB). It does not run the vendored web packages' tests: those belong to the web repository (`pnpm --filter <package> test` there, plus its rules tests with `pnpm test:emulator`, which need JDK 21).

New behaviour gets a test next to the code (`foo.ts` and `foo.test.ts`). Prefer testing pure logic (a `*.ts` file with no React) over rendering. Never weaken a test to make it pass.

## 5. Release-bundle checks

Run these when you added a test hook, a dependency or a new import of a heavy library. Each builds the app twice, so they are slow:
```bash
pnpm check:release      # no window.__ffm* hook may appear in a release bundle
pnpm check:singletons   # exactly one bundled copy of react, dexie, firebase, three, @thatopen/*
```
`check:release` wraps itself in `flock` (Linux). Where `flock` does not exist (macOS, Windows), run `node scripts/check-release-bundle.mjs` directly.

## 6. Emulator e2e

The end-to-end specs drive the real app inside an **Android emulator**. They are heavy: a full Gradle build, an emulator boot with hardware acceleration, minutes to over an hour for the whole suite, several GB of memory. The setup script of the deploy skill does **not** install an emulator or a system image. They need `bash`, the Android emulator package and an AVD (the repository expects one named `ffm_x216`, API 36 x86_64 tablet; `FFM_AVD=<name>` picks another), so they are usually run by a developer or in CI, not on a business laptop. Say so plainly, and tell the user the change was verified by unit tests, typecheck and lint only, if you skip them.

```bash
source scripts/env.sh            # JAVA_HOME / ANDROID_HOME (defaults assume the original developer's paths; set them yourself otherwise)
pnpm e2e e2e/app.spec.ts         # demo lane, one spec (sign-in, tabs, More screen)
pnpm e2e                         # demo lane, every spec (needs the maintainer data set, see below)
FFM_FORCE_APP_SEED=1 pnpm e2e e2e/public-smoke.spec.ts   # public smoke lane: passes on the app-owned demo seed alone
pnpm e2e:emulator                # cloud-mode lane: Firebase emulators (Java 21) + specs in e2e/emulator/
```
- **Which lane needs which data.** `e2e/public-smoke.spec.ts` (sign in to the demo, the model loads, the plan opens, a task is created) passes on the app-owned demo seed that ships with the repository. Every other spec is written against the larger maintainer data set (plan names such as P-101, several MEP and architectural models, 20 MB sheets) and needs it in `vendor/free-field/apps/settings/public/seed/`; without it those specs fail on missing plans or models. Do not rewrite them for the small seed: run the smoke spec, and say that the full lane was not run.
- Run an e2e only when you changed app code that a spec covers. Start with the one spec nearest your change (`e2e/tasks.spec.ts`, `e2e/model.spec.ts`, `e2e/plans.spec.ts`, `e2e/notifications.spec.ts`, `e2e/linkview.spec.ts`, `e2e/task-markups.spec.ts`, `e2e/task-bulk-export.spec.ts`, `e2e/recovery.spec.ts`).
- `FFM_EMU_SNAPSHOT=-no-snapshot` boots the emulator cold (more reliable). `FFM_EMU_WINDOW=0` runs headless. `FFM_GPU=host` if the 3D view fails with a WebGL2 error.
- Screenshots and results land in `test-results/` (git-ignored).
- **Always tear down afterwards:** `adb emu kill`, `./gradlew --stop` (in `apps/mobile/android`). The scripts do it on exit, but check no emulator or Gradle process is left running. Only one emulator at a time.
- The scripts use `flock /tmp/ffm-heavy.lock` to serialise heavy jobs on the original developer machine; do not wrap the `pnpm e2e` commands in your own `flock`.
- Never run an e2e against a company tablet with real data: the specs install a debug app, rotate the screen and change device settings.

## 7. Run it and show the user

**Fastest: the browser (demo mode).**
```bash
pnpm dev          # then open http://localhost:5174 ; use a narrow window to look like a tablet
```
It runs the real app logic with demo data and no sign-in ("Continue in demo mode"). Camera, files, notifications and the 3D memory limits behave differently from a tablet, so say "this is a preview" and ask before claiming it works on a tablet.

**On an emulator or a tablet (demo build).**
```bash
JAVA_HOME=<java 21 folder> ANDROID_HOME=<sdk folder> pnpm android:debug
adb install -r apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
```
(`scripts/env.sh` can set the two variables.) The toolchain is installed by `freefield-app-deploy`'s setup step. Install on a spare tablet or an emulator, not on one with the company app (same id, different key: the install fails or, worse, needs an uninstall that erases data).

**The demo data.** The app never parses IFC; the demo's 3D model and plan are pre-built files that `apps/mobile/scripts/prepare-assets.mjs` copies into the app. It uses the larger maintainer data set of the web repository (`vendor/free-field/apps/settings/public/seed/`) when that folder exists, and otherwise the small **app-owned demo seed** in `apps/mobile/demo-seed/` (one `.frag` model, one generated floor plan with a calibration, built by `apps/mobile/scripts/build-demo-seed.mjs`). So the demo builds and runs from a public copy as it is. `FFM_FORCE_APP_SEED=1` picks the app-owned seed even when the maintainer data set is present. The unit test `src/dev/realDataDocs.test.ts` skips itself when the maintainer data set is absent.

**What to show.** After the app opens: "Continue in demo mode", then the tab where your change is (Tasks for fields and export, Model for 3D tools, More for settings and notifications). Walk the user through the exact taps and what they should see. Rotate to check both orientations. If the change only matters when signed in (sync, rules, a new synced field, notifications from other people's actions), demo mode cannot show it: use a company build against a **test** Firebase project, or the emulator lane (section 6).

## 8. Reading failures

- **Typecheck error in `vendor/free-field/...`**: the submodule is at a web commit that differs from what the app expects. Run `git submodule status`; do not edit the vendored file.
- **`Failed to resolve import "@ff/..."`**: the submodule lacks a package, or `pnpm install` was not run after a submodule change.
- **`theme.test.ts` fails**: a colour or token drifted (recipe 1). Fix the token, not the test, unless you deliberately extended the override rules.
- **A text test fails after a wording change**: update the text in the test (and the e2e spec that quotes it).
- **`check:release` says a hook is in the bundle**: a `window.__ffm*` access is not behind `testHooksEnabled()`.
- **A test passes alone and fails in the full run**: shared module state. Reset it in `beforeEach`.
- **e2e: "device offline" or boot timeout**: wait, then retry with `FFM_EMU_SNAPSHOT=-no-snapshot`; check that no old emulator or Gradle process is running.
