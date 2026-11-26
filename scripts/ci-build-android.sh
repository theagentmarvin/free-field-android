#!/usr/bin/env bash
# Thin wrapper used by the optional GitHub workflow (.github/workflows/build-android.yml): all the logic lives in
# scripts/build-android.mjs, which reads ANDROID_KEYSTORE_BASE64 / _PASSWORD / ANDROID_KEY_ALIAS / _PASSWORD and the
# VITE_FIREBASE_* variables from the environment. On a computer, run `node scripts/build-android.mjs` directly.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
exec node scripts/build-android.mjs "$@"
