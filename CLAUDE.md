# FreeField field app: notes for Claude Code

An offline-first Android tablet app (Capacitor 7, React 18, TypeScript strict, Vite) for FreeField. It reuses the FreeField web code through the git submodule `vendor/free-field` (`@ff/*` packages as TypeScript source). The app lives in `apps/mobile`; build and company scripts are in `scripts/`; the company settings are in `company.config.json`.

## Skills

Two skills for non-programmers ship in `.claude/skills/`. Use them instead of improvising:

- **`freefield-app-deploy`**: build the company's own signed app and get it onto tablets (toolchain, config, signing key, App Links, build, install, updates, IT request).
- **`freefield-app-extend`**: change the app (branding, texts, task fields, tools, settings, notifications, the PDF report).

The FreeField website itself is deployed with the web repository's `freefield-deploy` skill, and web-owned changes use its `freefield-extend` skill; both are also available under `vendor/free-field/.claude/skills/`.

## Commands (repository root)

```bash
pnpm install
pnpm typecheck        # tsc, app plus e2e project
pnpm lint             # ESLint
pnpm test             # Vitest unit tests
pnpm dev              # browser demo preview at http://localhost:5174 (runs on the app-owned demo seed in apps/mobile/demo-seed)
node scripts/check-app-setup.mjs        # what is missing to build the company app
node scripts/build-android.mjs          # signed APK in release/
```
More in `docs/DEV.md` and `docs/company/INSTALL.md`.

## House rules

- Never print, paste or commit secrets: `signing/`, `signing.local.properties`, `*.p12`, `apps/mobile/.env.production`, `company.config.local.json` are git-ignored on purpose. Never ask for passwords in chat.
- Never change `applicationId` or the signing key of an app already installed on tablets. Raise `versionCode` by 1 for every release.
- Do not edit `vendor/free-field` from this repository. Task data, security rules and Cloud Functions belong to the web repository; bump the submodule afterwards.
- Every write goes through the offline outbox (`buildActionPayload` then `engine.enqueue`), never straight to Firestore.
- Light theme only: colours come from the `--ff-*` tokens; touch targets are at least 44 px; check both orientations; one 3D viewer at a time; no raw `three` imports outside the viewer packages.
- Small, additive diffs on a feature branch. Stage exact files (`git add <file>`), never `git add -A` or `git add .`.
- Ask before installing software, deploying, spending money or installing on a tablet that holds real data.
- Never name third-party commercial BIM or construction platforms, or device-management or store products, in code, comments, docs or commits.
