#!/usr/bin/env bash
# Physical-device counterpart of emu-session.sh: no AVD boot, one explicitly allowed serial.
#
#   FFM_ALLOW_DEVICE=<serial> scripts/device-session.sh <apk> -- <command...>
#
# Touches ONLY that serial and ONLY the app package. Runs under the shared heavy lock. On exit
# (success, failure or signal) it turns airplane mode off, removes the adb reverse mappings and
# force-stops our package. It never changes size, density, font scale, rotation, night mode or other apps.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -z "${FFM_LOCK_HELD:-}" ]]; then
  exec env FFM_LOCK_HELD=1 flock -o /tmp/ffm-heavy.lock timeout -k 60 "${FFM_LOCK_MAX_SECS:-2700}" "$0" "$@"
fi

# shellcheck source=env.sh
source "$ROOT/scripts/env.sh"

APK="${1:?usage: FFM_ALLOW_DEVICE=<serial> device-session.sh <apk> -- <command...>}"
shift
[[ "${1:-}" == "--" ]] && shift
[[ $# -gt 0 ]] || { echo "device-session: no command given" >&2; exit 2; }

SERIAL="${FFM_ALLOW_DEVICE:-}"
[[ -n "$SERIAL" ]] || { echo "device-session: FFM_ALLOW_DEVICE is not set" >&2; exit 3; }
[[ "$SERIAL" != emulator-* ]] || { echo "device-session: use emu-session.sh for emulators" >&2; exit 3; }
adb devices | awk -v s="$SERIAL" '$1==s && $2=="device" {f=1} END {exit !f}' \
  || { echo "device-session: $SERIAL is not attached (adb devices)" >&2; exit 4; }
export ANDROID_SERIAL="$SERIAL"
export FFM_ALLOW_DEVICE="$SERIAL"
PKG="$(node "$ROOT/scripts/company-config.mjs" get applicationId)"
OUT="$ROOT/test-results"
mkdir -p "$OUT"

cleanup() {
  local rc=$?
  set +e
  adb -s "$SERIAL" shell cmd connectivity airplane-mode disable >/dev/null 2>&1
  adb -s "$SERIAL" reverse --remove-all >/dev/null 2>&1
  adb -s "$SERIAL" shell am force-stop "$PKG" >/dev/null 2>&1
  echo "device-session: cleanup done (airplane_mode_on=$(adb -s "$SERIAL" shell settings get global airplane_mode_on 2>/dev/null | tr -d '\r'))"
  exit $rc
}
trap cleanup EXIT
trap 'exit 143' INT TERM

# A locked screen cannot be bypassed: wait for the user.
for i in $(seq 1 40); do
  adb -s "$SERIAL" shell dumpsys window | grep -q "isKeyguardShowing=true" || break
  echo "device-session: waiting for the user to unlock the tablet"
  sleep 30
done

adb -s "$SERIAL" shell input keyevent KEYCODE_WAKEUP >/dev/null
adb -s "$SERIAL" install -r -t "$APK" >/dev/null
echo "device-session: installed $(basename "$APK") on $SERIAL; running: $*"
set +e
"$@"
rc=$?
set -e
echo "device-session: command exited $rc"
adb -s "$SERIAL" logcat -d -t 400 >"$OUT/logcat.txt" 2>/dev/null || true
exit $rc
