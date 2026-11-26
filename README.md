# FreeField field app

An offline-first Android app for tablets that goes with the FreeField website: site tasks, PDF plans and 3D models that keep working without a connection and sync when the network returns. It is built with Capacitor, React and TypeScript, and it reuses the FreeField web code (`vendor/free-field`, a git submodule).

It is open source (MIT). The web app it goes with lives in [free-field-app](https://github.com/theagentmarvin/free-field-app), included here as the git submodule `vendor/free-field`.

## What it does

- **Tasks** that work offline: create, photograph, annotate and assign on site; everything waits in a local outbox and syncs when the network returns.
- **Plans**: PDF sheets rendered as tiles, with task pins, measuring and revision compare.
- **3D model**: the federated building model (`.frag`), with filters, section tools, search and properties.
- **Link view**: a calibrated plan beside the 3D view, with a camera marker and first-person walking.
- **Notifications**, a PDF task report, and offline building packages for areas without coverage.

Screenshots: _placeholder, to be added (tasks list, plan with pins, 3D model, link view)_.

Every company builds **its own copy**: named for the company, signed with the company's own key, and signing in against the company's own FreeField website and Firebase project.

## Get started

- Install on your company's tablets: [`docs/company/INSTALL.md`](docs/company/INSTALL.md)
- What to ask your IT department for: [`docs/company/IT-REQUEST.md`](docs/company/IT-REQUEST.md)
- Developer setup, scripts and tests: [`docs/DEV.md`](docs/DEV.md)

## Try the demo

The repository ships a small demo data set (`apps/mobile/demo-seed/`: one 3D model, one generated floor plan calibrated to its storey, and demo tasks), so the demo runs from a plain clone, with no sign-in and no backend:

```bash
git clone --recurse-submodules https://github.com/theagentmarvin/free-field-android.git
cd free-field-android
pnpm install
pnpm dev        # browser preview at http://localhost:5174, then "Continue in demo mode"
```

On an Android emulator or tablet: `pnpm android:debug` (see [`docs/DEV.md`](docs/DEV.md)). To check a build end to end, run the public smoke test: `FFM_FORCE_APP_SEED=1 pnpm e2e e2e/public-smoke.spec.ts`.

Clone with the submodule: `git clone --recurse-submodules <address>`. Use a **private** copy (the repository template or an import), not a fork: a fork of a public repository is always public.

## Using an AI agent to set this up

You do not need to be a programmer. If you use [Claude Code](https://claude.com/claude-code), this repository includes two skills in `.claude/skills/` that let the agent do the technical work on your computer while you make the decisions. Open the repository folder in Claude Code and describe what you want, in English or Spanish.

- **`freefield-app-deploy`**: gets the app onto your tablets. It checks what is missing, installs the build tools after asking you, writes your company settings, creates the signing key (and reminds you to back it up), builds the app, helps you install it, and writes the request for IT. Try: "build the app for my company" or "instalar la app en las tablets".
- **`freefield-app-extend`**: changes the app. Name, logo, colours, texts, a field on tasks, a new tool or setting. It explains the plan in plain words, waits for your yes, checks the result and helps you ship it. Try: "change the app name and colour" or "agregar un campo a las tareas en la tablet".

Your company's FreeField **website** must already be online on its own Firebase project. It is put online with the `freefield-deploy` skill of the FreeField web repository (also found in `vendor/free-field/.claude/skills/`). Nothing is installed, deployed or paid for without your explicit yes, and the agent never needs your passwords: sign-in to Firebase happens in your browser.

## Licence

MIT, see [LICENSE](LICENSE). Third-party components and their licences: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Contributions are welcome: [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).

## Support

This is open-source software with no service-level agreement. Report problems with the app on this repository's issue tracker.
