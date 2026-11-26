#!/usr/bin/env bash
# Boot the headless emulator, install the APK, run a command, tear everything down.
#
#   scripts/emu-session.sh <apk> -- <command...>
#
# The whole session runs under `flock /tmp/ffm-heavy.lock` (7 GB box shared with
# other agents), and ALWAYS ends with `adb emu kill` + `gradlew --stop`.
#
# Env:
#   FFM_AVD   AVD name                    (default ffm_tablet)
#   FFM_GPU   -gpu mode                   (default swiftshader_indirect; try "host" if WebGL2 fails)
#   FFM_BOOT_TIMEOUT  seconds             (default 240)
#   ANDROID_SERIAL is exported to the command (emulator-5554).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -z "${FFM_LOCK_HELD:-}" ]]; then
# Leash: no run may hold the shared lock forever. `timeout` signals the whole process group
  # (emulator, Playwright, Firebase emulators), the traps tear down, KILL follows 60 s later.
  exec env FFM_LOCK_HELD=1 flock -o /tmp/ffm-heavy.lock timeout -k 60 "${FFM_LOCK_MAX_SECS:-2700}" "$0" "$@"
fi

# shellcheck source=env.sh
source "$ROOT/scripts/env.sh"

APK="${1:?usage: emu-session.sh <apk> -- <command...>}"
shift
[[ "${1:-}" == "--" ]] && shift
[[ $# -gt 0 ]] || { echo "emu-session: no command given" >&2; exit 2; }

AVD="${FFM_AVD:-ffm_x216}"
GPU="${FFM_GPU:-swiftshader_indirect}"
# Visible emulator window when a desktop session is available (watch the tests run);
# FFM_EMU_WINDOW=0 forces headless, 1 forces a window.
WINDOW_FLAG="-no-window"
case "${FFM_EMU_WINDOW:-auto}" in
  1) WINDOW_FLAG="" ;;
  auto) [[ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]] && WINDOW_FLAG="" ;;
esac
TIMEOUT="${FFM_BOOT_TIMEOUT:-240}"
OUT="$ROOT/test-results"
mkdir -p "$OUT"
export ANDROID_SERIAL="emulator-5554"

EMU_PID=""
cleanup() {
  local rc=$?
  set +e
  adb -s "$ANDROID_SERIAL" emu kill >/dev/null 2>&1
  if [[ -n "$EMU_PID" ]]; then
    for _ in $(seq 1 30); do kill -0 "$EMU_PID" 2>/dev/null || break; sleep 1; done
    kill -9 "$EMU_PID" 2>/dev/null
  fi
  # qemu child can outlive the launcher
  pkill -f "qemu-system-x86_64.*-avd $AVD" 2>/dev/null
  # do not release the lock while qemu is still shutting down
  for _ in $(seq 1 20); do pgrep -f "qemu-system-x86_64.*-avd $AVD" >/dev/null || break; sleep 1; done
  pkill -9 -f "qemu-system-x86_64.*-avd $AVD" 2>/dev/null
  if [[ -x "$ROOT/apps/mobile/android/gradlew" ]]; then
    (cd "$ROOT/apps/mobile/android" && ./gradlew --stop >/dev/null 2>&1)
  fi
  exit $rc
}
trap cleanup EXIT INT TERM

if adb devices 2>/dev/null | grep -q "^emulator-"; then
  echo "emu-session: an emulator is already running; refusing to start a second one" >&2
  exit 3
fi

boot_emulator() {
  # stale locks of a crashed emulator block the next start; only remove them when no emulator process exists
  pgrep -f "qemu-system-x86_64.*-avd $AVD" >/dev/null || rm -f ~/.android/avd/"$AVD".avd/*.lock
  nohup emulator -avd "$AVD" $WINDOW_FLAG -no-audio ${FFM_EMU_SNAPSHOT:--no-snapshot-save} -no-boot-anim \
    -gpu "$GPU" -no-metrics >"$OUT/emulator.log" 2>&1 &
  EMU_PID=$!
  # `adb wait-for-device` blocks forever when the emulator dies during start (seen under memory pressure:
  # the hang watchdog aborts it); poll instead, so a dead emulator fails fast and releases the lock.
  local deadline=$((SECONDS + TIMEOUT))
  until adb -s "$ANDROID_SERIAL" get-state 2>/dev/null | grep -q device; do
    kill -0 "$EMU_PID" 2>/dev/null || return 1
    (( SECONDS < deadline )) || return 1
    sleep 2
  done
  until [[ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == "1" ]]; do
    kill -0 "$EMU_PID" 2>/dev/null || return 1
    (( SECONDS < deadline )) || return 1
    sleep 2
  done
}

echo "emu-session: booting $AVD (gpu=$GPU)"
tries="${FFM_BOOT_TRIES:-3}"
for attempt in $(seq 1 "$tries"); do
  if boot_emulator; then break; fi
  echo "emu-session: emulator did not come up (attempt $attempt/$tries, see $OUT/emulator.log)" >&2
  adb -s "$ANDROID_SERIAL" emu kill >/dev/null 2>&1 || true
  kill -9 "$EMU_PID" 2>/dev/null || true
  [[ $attempt -eq $tries ]] && exit 4
  sleep 15
done
echo "emu-session: booted in ${SECONDS}s"

# Settle: package manager can lag a few seconds behind sys.boot_completed.
until adb shell pm path android >/dev/null 2>&1; do sleep 1; done
adb shell settings put global window_animation_scale 0 >/dev/null
adb shell settings put global transition_animation_scale 0 >/dev/null
adb shell settings put global animator_duration_scale 0 >/dev/null
# A slow software GPU can trigger ANR dialogs over the app; never show them.
adb shell settings put global hide_error_dialogs 1 >/dev/null
# Keep the display on for the whole session: a sleeping screen makes every device
# framebuffer capture (the only one with WebGL pixels) come back solid black.
adb shell svc power stayon true >/dev/null
adb shell settings put system screen_off_timeout 2147483647 >/dev/null
adb shell input keyevent KEYCODE_WAKEUP >/dev/null
adb shell wm dismiss-keyguard >/dev/null 2>&1 || true

adb install -r -t "$APK" >/dev/null
echo "emu-session: installed $(basename "$APK"); running: $*"
set +e
"$@"
rc=$?
set -e
echo "emu-session: command exited $rc"
adb logcat -d -t 400 >"$OUT/logcat.txt" 2>/dev/null || true
exit $rc
