# Contributing to the FreeField field app

Thanks for your interest. Bug reports, fixes, docs and features are welcome.

## Setup

Requirements: Node.js 24, pnpm 10 (see `packageManager` in `package.json`), and for Android builds JDK 21 plus the Android SDK (`node scripts/setup-android-toolchain.mjs --accept-licenses` installs both in your home directory). The full developer guide is [`docs/DEV.md`](docs/DEV.md).

```bash
git clone --recurse-submodules <address>
pnpm install
pnpm dev            # browser demo preview on the small app-owned demo data set
```

## Checks before opening a PR

```bash
pnpm typecheck
pnpm lint
pnpm test           # Vitest unit tests
```

For changes that touch screens or the native side, also run the public smoke test on the Android emulator:

```bash
FFM_FORCE_APP_SEED=1 pnpm e2e e2e/public-smoke.spec.ts
```

The other specs in `e2e/` are written against a larger maintainer data set and need it; see `docs/DEV.md`.

## Pull requests

- Fork, then branch from `main`: `git checkout -b feature/<short-name>`. One feature or fix per branch.
- Keep PRs focused, with tests for behaviour changes.
- Stage exact files (avoid `git add -A`) so local files are never committed.
- Do not commit secrets or local configuration: `signing/`, `signing.local.properties`, `apps/mobile/.env.production` and `company.config.local.json` are git-ignored on purpose.
- Every write goes through the offline outbox; light theme only, touch targets of at least 44 px.
- Do not edit `vendor/free-field`; changes to the web code belong in the web repository.
- Describe what changed, why, and how you tested it.

## Reporting bugs and security issues

Open an issue with reproduction steps and the tablet model and Android version. Do not attach confidential models or plans. For vulnerabilities see [SECURITY.md](SECURITY.md).
