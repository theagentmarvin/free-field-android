#!/usr/bin/env bash
# pnpm e2e: build the debug APK, boot the emulator, run the Playwright _android specs.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
# shellcheck source=env.sh
source scripts/env.sh

# Heavy step #1: Gradle build (under the shared lock, daemon disabled in gradle.properties).
flock -o /tmp/ffm-heavy.lock timeout -k 30 "${FFM_BUILD_MAX_SECS:-900}" pnpm android:debug:e2e

APK="$ROOT/apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk"
# Heavy step #2: emulator session (takes the lock itself, always tears down).
# FFM_ALLOW_DEVICE=<serial> uses that physical device instead of the AVD (scripts/device-session.sh).
SESSION=scripts/emu-session.sh
[[ -n "${FFM_ALLOW_DEVICE:-}" ]] && SESSION=scripts/device-session.sh
exec "$SESSION" "$APK" -- pnpm exec playwright test "$@"
