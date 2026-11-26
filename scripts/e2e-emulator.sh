#!/usr/bin/env bash
# pnpm e2e:emulator: cloud-mode e2e against the Firebase emulators from the monorepo.
#
# Everything heavy runs under `flock /tmp/ffm-heavy.lock` (shared 7 GB box):
#   1. Gradle build of the debug APK with the emulator env (scripts/emulator-env.sh)
#   2. firebase emulators (auth, firestore, storage) from vendor/free-field/firebase.json
#   3. headless Android emulator session (scripts/emu-session.sh) with adb reverse
#   4. Playwright specs (playwright.emulator.config.ts); the seed runs in its global setup
# Teardown always stops the Firebase emulators, the Android emulator and Gradle.
# The functions emulator is not started: the vendored functions have no installed deps
# and building them would modify vendor/ (specs that need it are skipped, see cloud.spec.ts).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ -z "${FFM_LOCK_HELD:-}" ]]; then
# Leash: no run may hold the shared lock forever. `timeout` signals the whole process group
  # (emulator, Playwright, Firebase emulators), the traps tear down, KILL follows 60 s later.
  exec env FFM_LOCK_HELD=1 flock -o /tmp/ffm-heavy.lock timeout -k 60 "${FFM_LOCK_MAX_SECS:-2700}" "$0" "$@"
fi
# shellcheck source=env.sh
source scripts/env.sh

OUT="$ROOT/test-results"
EMU_DIR="$OUT/firebase-emulators"
mkdir -p "$EMU_DIR"
rm -f "$EMU_DIR/firebase.pid"
PROJECT="demo-freefield"
PORTS=(9099 8080 5001 9199)
# Host-side ports are shifted so a Firebase emulator another agent left on the standard ports
# cannot collide; the device keeps seeing the standard ports through `adb reverse dev:std host:std+offset`.
export FFM_EMU_PORT_OFFSET="${FFM_EMU_PORT_OFFSET:-10000}"
OFF="$FFM_EMU_PORT_OFFSET"

# 1. Build
pnpm --filter @ffm/mobile android:debug:emulator
APK="$ROOT/apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk"

# 2. Firebase emulators. Config derived from the vendored firebase.json: same rules and
#    indexes, absolute paths, no UI, bound to 127.0.0.1, only the services we need.
node scripts/emulator/make-config.mjs "$ROOT/vendor/free-field/firebase.json" "$EMU_DIR/firebase.json"
# Fail fast when the (shifted) host ports are taken.
for std in 9099 8080 9199; do
  port=$((std + OFF))
  if ss -ltn 2>/dev/null | grep -qE "[:.]$port\\b"; then
    echo "e2e-emulator: port $port is already in use (another Firebase emulator running?)" >&2
    exit 6
  fi
done
FB_PGID=""
stop_firebase() {
  if [[ -n "$FB_PGID" ]]; then
    kill -TERM -- "-$FB_PGID" 2>/dev/null || true
    for _ in $(seq 1 20); do kill -0 -- "-$FB_PGID" 2>/dev/null || break; sleep 1; done
    kill -KILL -- "-$FB_PGID" 2>/dev/null || true
  fi
}
trap 'stop_firebase' EXIT
trap 'exit 143' INT TERM # run the EXIT teardown on the leash timeout too
# setsid + exec: the shell's pid becomes the pid of firebase AND of its process group, so
# stop_firebase can signal the whole tree (firebase spawns java children).
setsid bash -c 'echo $$ >"$1/firebase.pid"; cd "$1"; exec firebase emulators:start --only auth,firestore,storage --project "$2" --config "$1/firebase.json"' _ "$EMU_DIR" "$PROJECT" >"$OUT/firebase-emulators.log" 2>&1 &
for _ in $(seq 1 20); do [[ -s "$EMU_DIR/firebase.pid" ]] && break; sleep 0.2; done
FB_PGID="$(cat "$EMU_DIR/firebase.pid")"
for std in 9099 8080 9199; do
  port=$((std + OFF))
  for i in $(seq 1 90); do
    curl -s -o /dev/null "http://127.0.0.1:$port" && break
    [[ $i -eq 90 ]] && { echo "e2e-emulator: port $port never came up (see $OUT/firebase-emulators.log)" >&2; exit 5; }
    sleep 1
  done
done
echo "e2e-emulator: firebase emulators up"

# 3 + 4. Android emulator session; adb reverse so the WebView's localhost reaches the host.
export PORTS_STR="${PORTS[*]}"
# FFM_ALLOW_DEVICE=<serial> runs the same lane on that physical device (scripts/device-session.sh, no AVD).
SESSION=scripts/emu-session.sh
[[ -n "${FFM_ALLOW_DEVICE:-}" ]] && SESSION=scripts/device-session.sh
FFM_LOCK_HELD=1 "$SESSION" "$APK" -- bash -c '
  for p in $PORTS_STR; do adb -s "$ANDROID_SERIAL" reverse "tcp:$p" "tcp:$((p + FFM_EMU_PORT_OFFSET))" >/dev/null; done
  cd "'"$ROOT"'" && pnpm exec playwright test -c playwright.emulator.config.ts "$@"
' _ "$@"
