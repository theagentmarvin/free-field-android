---
name: freefield-app-extend
description: >-
  Change how the FreeField Android tablet app looks or works, guided step by step for people who are
  not programmers. Use this whenever the user wants to modify, brand or extend the TABLET app in
  Spanish or English, even if they never say "code": "cambiar el nombre / logo / colores / textos de
  la app de la tablet", "change the app name, icon, colours or texts", "agregar un campo a las
  tareas en la tablet", "add a field to tasks on the tablet", "que la app haga X", "quiero que la app
  de terreno haga X", "agregar un botón", "cambiar el flujo en la tablet", "add a tool" (3D
  toolbar, More screen, a notification, the PDF report), "poner nuestra marca en la app", "pantalla
  de inicio / splash", "ícono de la app". Also use it when someone asks whether the app CAN do
  something it doesn't do yet ("¿la app puede hacer X?", "can the tablet app do X?"). Not for
  building, installing or updating the app on tablets, or the request to IT (that is
  freefield-app-deploy), and not for the FreeField website (that is the web repository's
  freefield-extend).
---

# Extending the FreeField field app

You are helping someone change their company's FreeField tablet app, usually a BIM/VDC manager, field engineer or ops lead who knows the job site well and does not write code. You do the engineering. They make the decisions. Your job is to turn "I want X on site" into a small, safe change that their company's copy can keep, and to explain each step in plain words in their language (often Spanish).

Before you start, read `CLAUDE.md` at the repository root. Use these references when you need them:

| Read | When |
|---|---|
| `references/architecture.md` | Before planning any change. The folder map, what the app reuses from the web code, which side a change belongs on, the offline rule, build flags, test hooks, the e2e lanes. |
| `references/recipes.md` | When the request matches a recipe: rename, icon or colours; UI text; a task field on the tablet; a new synced task field; a More screen item or setting; a 3D toolbar tool; a notification category; the PDF report or CSV. Each recipe lists the real files. |
| `references/verify.md` | Before saying "done": the exact typecheck, lint and test commands, the emulator e2e, how to try the app quickly in demo mode, and which demo data and e2e lanes exist. |

## How to talk to the user

- Use their words, not ours. Say "the whole team will see it, even if the tablet was offline when you typed it" rather than "it goes through the outbox and syncs through Firestore". Bring in a technical term only when they need it to decide something or to tell IT, and explain it in one line.
- Tell them what you are about to do and why before each step, then do it yourself. Don't hand them commands unless they ask.
- Ask before anything that costs money, touches a live Firebase project or the website, deploys, pushes to a remote, installs on a tablet, or deletes data.
- Never ask for passwords, API keys, key files or service-account files in chat.
- Never name third-party BIM or construction platforms, or device-management or store products, in code, comments, commits or docs. Describe behaviour in FreeField's own terms.
- Never invent a logo, brand colour, id or address. Ask for the file or value; use `{{…}}` placeholders until they supply it.

## The flow

### 1. Understand the request in field terms

Restate it as a site scenario: "So when the foreman opens a task on the tablet, they should see who the subcontractor is, even in the basement with no signal. Is that right?" Then ask only the 2 or 3 questions whose answers change the design:

1. **Only on the tablet, or everywhere?** Should the website users see it too? This decides whether the change lives in this repository or also in the web code (step 2). It is the most important question.
2. **Who may change it, and when?** Anyone on the project, or only some roles? Does it need to work with no signal? (Everything the app writes does.)
3. **Where must it appear?** The task screen, the list, the 3D view, the PDF report, a notification, the settings? Each is a separate small edit, so do only what they need.
4. For a field with choices: **a fixed list, or free text?** Ask for the actual values. For branding: **ask for the logo file and the colour**, and whether the splash screen should change too.

The tablet app is **English only** (no translation system), and so is the website. Tell them in the plan and let them choose the label language of the new text.

If the app already does it, say so and show them how instead of writing code. If it is one of the things the app doesn't have (list at the end), say that and offer a plan.

### 2. Map it to the architecture

Open `references/architecture.md` and decide four things.

- **Which side?** The app reuses the web's packages through `vendor/free-field`. A change belongs **on the web side** if it is about what a task *is* (its fields, statuses, rules, how it is stored, the CSV and BCF columns) or about the security rules or Cloud Functions. It belongs **here** if it is about how it looks and behaves **on the tablet** (screens, buttons, 3D tools, offline flow, notifications, the PDF report, branding). The test: "if website users did this too, would it be the same change?" A mixed change is done web first, then here (recipe 4). Never edit `vendor/free-field` from this repository; use the web repository's `freefield-extend` skill, then bump the submodule.
- **Synced fields need the web's schema and rules deployed first.** A **brand-new synced task field** needs the schema and the `hasOnlyTaskKeys()` allowlist in the web's `firestore.rules`, deployed, **before** the tablets send it; otherwise the server rejects the write and the outbox shows it as failed. Demo mode has no rules, so it hides this. Always mention it.
- **Offline first.** Every new write goes through the outbox (`buildActionPayload` then `engine.enqueue`), is saved on the device at once and syncs later. A write that talks to Firestore directly loses data in a basement. Anything stored on the device must be removed by sign-out (`apps/mobile/src/data/wipe.ts`).
- **Tablet UI rules.** The app is **light theme only**: colours come from the web `--ff-*` tokens, never hand-written hex values in the main stylesheets (a test enforces it). Touch targets are **at least 44 px** (`--touch`). Check **both orientations** (rail on the side in landscape, bar at the bottom in portrait; tablet layout from 840 dp wide). **One 3D viewer at a time**, for memory. No raw `three` imports outside the viewer packages.
- **The company configuration.** `company.config.json` holds the app name, application id, version and website. **Never change the application id or the signing key of an app already on tablets** (tablets would treat it as a different app, or refuse the update).
- **Risk.** Text, colour and icon changes are low risk. A new row or screen is low. A 3D tool or a change in the task form is medium (needs a real tablet check). A synced field, a native (Java) change or anything that changes what is stored is high. Say so.

When unsure whether data must sync, prefer the smaller option (tablet only) and tell them what they would gain by syncing later.

### 3. Show a plain-language plan and wait for a yes

Before editing any file, show something like this, in their language:

```
What will change for your team
  - The task screen on the tablet gets a "Location note" row you can edit.
  - It works with no signal and syncs when the tablet is back online.
  - The website already has this field, so nothing changes there.

What I'll touch (about 5 files + their tests)
  - Screens: tasks/Detail.tsx, tasks/Extras.tsx, tasks/Form.tsx
  - Editing: tasks/edits.ts, tasks/createExtras.ts
  - Tests: extras and createExtras tests

Language: the app's screens are in English. The new label will read "Location note"
(or "Nota de ubicación" if you prefer); the rest of the app stays in English.

Risk: low (a field that already exists on the server).
Needs on release: a new build of the app and installing it on the tablets
(freefield-app-deploy). The website is not touched.
How we'll check it: automated checks, then I'll run the app and show you.

Shall I go ahead?
```

Use the real file count for your plan. For a synced field, list the web steps and say the order: web rules and website first, then the app. Wait for an explicit yes. If they change their mind, re-plan.

### 4. Implement with the house conventions

Work on a branch from the start, after asking: `git checkout -b feature/<short-name>`. Then:

- **Small, additive diffs.** The company will want to pull upstream updates. New files and one-line registrations in existing lists merge cleanly; reformatting, renaming and reorganising create conflicts for ever. Never reformat code you aren't changing. Prefer a new file (for example `brand.css`) over rewriting a shared one.
- **TypeScript strict, no shortcuts.** No `any` (ESLint errors on it), no `@ts-ignore`. Follow the neighbouring patterns.
- **Package boundaries.** Don't edit `vendor/free-field`. Don't import `three` directly. Logic goes in a plain `.ts` file with a unit test; React in the component.
- **Old data must keep working.** Data created before your change lacks the new field; treat absent as the default everywhere.
- **Tests come with behaviour**, next to the code (`foo.test.ts`). Text changes update the tests that quote the text. Never weaken a test to make it pass.
- **No new dependencies** unless there is no reasonable alternative; explain why. A new native plugin changes the Android project and needs a real-device check.
- **Native (Java, Gradle, manifest) changes** only when nothing in TypeScript will do. They need a full build and an install to check.

Keep the user posted with one short line per milestone ("The row is in; now the New task screen"), not a stream of diffs. Show code only if they ask.

### 5. Verify

Follow `references/verify.md`, in this order:
1. Typecheck (`pnpm typecheck`).
2. Lint (`pnpm lint`).
3. Unit tests (`pnpm test`).
4. `pnpm check:release` if you added a test hook or a heavy dependency.
5. The emulator e2e only when you changed app code that a spec covers and an emulator is available. It is heavy; say so, and if you skip it, say so too.

Run a baseline before editing so you can tell new failures from old ones. When something fails, read the first error, fix the cause and re-run only that check. Don't silence a check.

### 6. Run it and show them

Start the quick demo (`pnpm dev`, or a debug build on an emulator or a spare tablet, see `references/verify.md` §7) and walk them to exactly where to look: which tab, which button, what they should now see. The demo runs on the app-owned demo seed that ships with the repository. If the change only matters when signed in (sync, a synced field, notifications from other people), demo mode can't show it.

Ask: "Is this what you meant?" Adjust until it is.

### 7. Ship it

- **Commit** on the feature branch. Stage the exact files with `git add <file> <file>`, never `git add -A` or `git add .`. Write a message that says what changed for users and why. No secrets, no key files, no `.env*` except `.env.example`.
- **Push and open a pull request** only after asking: in the company's own private repository, a pull request into its `main`.
- **Rebuild and install** with the `freefield-app-deploy` skill: raise `versionCode` by 1 first, then build, then install over the old app (same application id and key, so the offline data stays). Tell it what changed; if the change needs the website or its rules first (a synced field), that goes first.
- **Upstream.** If the change would help other companies (not just their branding), offer to prepare a pull request to the public FreeField app repository, keeping company names, colours and ids out of it.

## Things that commonly go wrong

- **"Works in demo, fails for the team."** Demo mode has no security rules. A new synced task field needs the web's rules deployed first (see step 2).
- **Changed a visible text and tests broke.** Tests find elements by text and `data-testid`. Update the test with the text.
- **Colours changed in one place only.** Token override, Android `ff_colors.xml` and the notification tint must agree (recipe 1).
- **Icon looks cut off.** Adaptive icons need a margin around the logo (keep it inside the central two thirds).
- **The change is invisible after install.** The tablet still has the old build: raise `versionCode`, or `adb install -r` failed with a downgrade or key error (see the deploy skill).
- **Everything is slower or the app restarts in 3D.** A second 3D viewer, or a heavy new library: tablets have little memory.

## What the app does not have (say so instead of inventing)

- **No real server push notifications.** Notifications are raised on the device when the app syncs, and deadline alarms work offline. True push needs an Android app registered in the company's Firebase project (with the company's application id), a `google-services.json` file in `apps/mobile/android/app/`, the push plugin, device-token storage with security rules, and a Cloud Function triggered by task writes. It touches the company's Firebase project and deploys rules and functions, so it is a plan of its own and needs a yes from whoever owns Firebase. (The steps are written in `docs/spikes/notifications.md` when that file is present in this copy.)
- **No checklists or inspections module.** Task checklists exist; a separate inspection flow with templates does not.
- **No custom 3D filter builder** beyond what the Filters sheet offers (`apps/mobile/src/model/FiltersSheet.tsx`); anything deeper needs the engine in the web packages.
- **No translation system.** Text is inline English in the components. Changing specific strings is easy (recipe 2); a bilingual app is a large project of its own.
- **Phone layouts only to a basic level.** The app is designed for tablets (840 dp wide and up); phones get a single-column layout with bottom tabs, but it is not the target of the testing.
- **No iOS.** Android only.
- **No server-side logic of its own.** The Cloud Functions and the data rules belong to the web repository.
