#!/usr/bin/env bash
# Disposable CI emulator only. No installed phone, planner data, or recovery key.
set -Eeuo pipefail
[[ "${CI:-}" == true && "$(adb shell getprop ro.kernel.qemu | tr -d '\r')" == 1 ]] || { echo 'Situate enforcement verification requires a CI emulator'; exit 1; }
PKG=${BALANCE_TEST_PACKAGE:-app.balance.local.debug}
COMPONENT="$PKG/app.balance.local.SituateAccessibility"
LISTENER="$PKG/app.balance.local.SituateNotifications"
if [[ "${BALANCE_SITUATE_INSTALL:-0}" == 1 ]]; then
  adb install -r balance-debug.apk
  adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null
  sleep 5
fi
adb shell input keyevent KEYCODE_HOME
adb shell run-as "$PKG" touch files/situate-ci-trace
old_services=$(adb shell settings get secure enabled_accessibility_services | tr -d '\r')
old_enabled=$(adb shell settings get secure accessibility_enabled | tr -d '\r')
backup=0
if adb shell run-as "$PKG" test -f no_backup/situate-rules.json; then
  adb shell run-as "$PKG" cp no_backup/situate-rules.json cache/situate-ci-rules.backup
  backup=1
fi
cleanup() {
  adb shell settings put secure enabled_accessibility_services "$old_services" >/dev/null || true
  adb shell settings put secure accessibility_enabled "$old_enabled" >/dev/null || true
  adb shell cmd notification disallow_listener "$LISTENER" >/dev/null || true
  if [[ "$backup" == 1 ]]; then
    adb shell run-as "$PKG" mv cache/situate-ci-rules.backup no_backup/situate-rules.json || true
  else
    adb shell run-as "$PKG" rm -f no_backup/situate-rules.json || true
  fi
  adb shell run-as "$PKG" rm -f files/situate-ci-trace || true
  adb logcat -d -s BalanceSituate:I ActivityTaskManager:I AndroidRuntime:E '*:S' > logcat-situate-enforcement.txt || true
  adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null || true
}
trap cleanup EXIT
failed() {
  echo "Situate assertion failed at line $1"
  adb shell dumpsys accessibility > situate-accessibility.txt || true
  adb shell dumpsys window windows > situate-windows.txt || true
}
trap 'failed "$LINENO"' ERR
wait_for() {
  for _ in $(seq 1 40); do
    if "$@"; then return 0; fi
    sleep 0.25
  done
  echo "Situate emulator assertion timed out at line ${BASH_LINENO[0]}: $*"
  adb shell dumpsys accessibility > situate-accessibility.txt || true
  adb shell dumpsys window windows > situate-windows.txt || true
  return 1
}
resumed() { adb shell dumpsys activity activities | grep -E 'mResumedActivity|topResumedActivity' | grep "$1" >/dev/null; }
home_resumed() {
  local component
  component=$(adb shell cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME | tr -d '\r' | tail -n 1)
  resumed "$component"
}
gate_present() {
  adb shell dumpsys window windows | python3 -c '
import re, sys
windows = re.split(r"(?=^  Window #)", sys.stdin.read(), flags=re.M)
visible = any("Situate app boundary" in window.splitlines()[0]
              and all(state in window for state in ["mHasSurface=true", "mDrawState=HAS_DRAWN", "isVisible=true", "mObscured=false"])
              for window in windows if window.splitlines())
sys.exit(0 if visible else 1)
'
}
gate_absent() {
  local windows
  windows=$(adb shell dumpsys window windows) || return 1
  ! printf '%s\n' "$windows" | grep -E 'Window #[0-9]+.*Situate app boundary' >/dev/null
}
assert_allowed() {
  wait_for gate_absent
  for _ in $(seq 1 6); do gate_absent; sleep 0.25; done
}
notification_present() { adb shell dumpsys notification --noredact | grep 'NotificationRecord(' | grep "tag=$1" >/dev/null; }
notification_absent() {
  local records
  records=$(adb shell dumpsys notification --noredact) || return 1
  ! printf '%s\n' "$records" | grep 'NotificationRecord(' | grep "tag=$1" >/dev/null
}
# Atomic replacement matches the real JNI save path. Only synthetic, local rule data.
rules() {
  python3 - "$1" <<'PY' | adb shell run-as "$PKG" tee no_backup/situate-ci-rules.tmp >/dev/null
import json, sys, time
now = int(time.time() * 1000)
state = sys.argv[1]
targets = [{'id': 'app:' + app, 'kind': 'app', 'category': 'custom', 'value': app}
           for app in ['com.android.settings', 'com.android.shell']]
mode = {'id': 'ci-boundary', 'name': 'CI boundary', 'platforms': ['android'],
        'scheduled': False, 'targets': targets}
doc = {'version': 1, 'generatedAt': now - 10000,
       'manual': {'ci-boundary': now - 10000}, 'grants': [], 'epochs': [], 'modes': [mode]}
if state in ['off', 'pass', 'overlap']:
    doc['grants'] = [{'mode': 'ci-boundary', 'epoch': now, 'until': now + (6000 if state == 'pass' else 600000)}]
if state == 'overlap':
    doc['modes'].append(dict(mode, id='ci-second', name='Second boundary'))
    doc['manual']['ci-second'] = now - 10000
if state == 'scheduled':
    doc['manual'] = {}
    mode['scheduled'] = True
    doc['epochs'] = [{'at': now + 5000, 'end': now + 600000, 'phase': 'night'}]
    # Before the first generated epoch the native policy uses generatedAt.
    doc['grants'] = [{'mode': 'ci-boundary', 'epoch': now, 'until': now + 600000}]
if state == 'removed': doc['modes'] = []
print(json.dumps(doc))
PY
  adb shell run-as "$PKG" mv no_backup/situate-ci-rules.tmp no_backup/situate-rules.json
}

rules off
adb shell cmd notification allow_listener "$LISTENER"
adb shell settings put secure enabled_accessibility_services "$COMPONENT"
adb shell settings put secure accessibility_enabled 1
service_connected() { adb shell dumpsys accessibility | grep -E 'Bound services:|BoundServices:' | grep 'Situate app blocking' >/dev/null; }
wait_for service_connected
adb shell cmd notification post -t Situate-control situate-ci-allowed SYNTHETIC_ALLOWED
wait_for notification_present situate-ci-allowed
adb shell am start -a android.settings.SETTINGS >/dev/null
wait_for resumed com.android.settings
assert_allowed

# Activate while the target is already foreground; no fresh launch/event is required.
rules on
wait_for gate_present
adb shell screencap -p /sdcard/situate-gate.png
adb pull /sdcard/situate-gate.png situate-gate.png >/dev/null
adb shell dumpsys window windows > situate-gate-window.txt
# A pass dismisses the existing gate without leaving/reopening the target.
rules pass
assert_allowed
wait_for resumed com.android.settings
# Expiry must re-block the same foreground app, including without exact-alarm access.
wait_for gate_present
rules overlap
wait_for gate_present
sleep 1
gate_present
rules off
assert_allowed
rules scheduled
assert_allowed
wait_for gate_present

# Back leaves the blocked task; no delayed result may bring the gate back over Home.
adb shell input keyevent KEYCODE_BACK
wait_for home_resumed
assert_allowed
# Exercise rapid repeated launches, well inside the old suppression interval.
for attempt in $(seq 1 10); do
  adb shell am start -a android.settings.SETTINGS >/dev/null
  wait_for gate_present
  if (( attempt % 2 )); then
    adb shell input keyevent KEYCODE_BACK
    wait_for home_resumed
    assert_allowed
  else
    adb shell input keyevent KEYCODE_HOME
    wait_for gate_absent
  fi
done
assert_allowed
adb shell am start -a android.settings.SETTINGS >/dev/null
wait_for gate_present
# No blocking window over the lock screen. Re-evaluate on wake/unlock.
adb shell input keyevent KEYCODE_SLEEP
wait_for gate_absent
adb shell input keyevent KEYCODE_WAKEUP
adb shell wm dismiss-keyguard
wait_for gate_present
# Disabling accessibility must remove its window and cancel queued work.
adb shell settings put secure enabled_accessibility_services null
assert_allowed
adb shell settings put secure enabled_accessibility_services "$COMPONENT"
wait_for service_connected
adb shell input keyevent KEYCODE_HOME
adb shell am start -a android.settings.SETTINGS >/dev/null
wait_for gate_present
# Never show a stale gate after the last applicable mode is removed.
rules removed
assert_allowed
rules on
wait_for gate_present
listener_connected() { adb shell dumpsys notification | grep -A 30 -E 'Live (services|notification listeners)' | grep SituateNotifications >/dev/null; }
wait_for listener_connected
adb shell cmd notification post -t Situate-blocked situate-ci-blocked SYNTHETIC_BLOCKED
wait_for notification_absent situate-ci-blocked
sleep 1
notification_absent situate-ci-blocked
rules off
assert_allowed
adb shell cmd notification post -t Situate-after-pass situate-ci-after-pass SYNTHETIC_ALLOWED
wait_for notification_present situate-ci-after-pass

# Out-of-order worker results must not resurrect a gate after rapid rule changes.
for attempt in $(seq 1 5); do rules on; rules off; done
assert_allowed
rules on
wait_for gate_present
# Keyboard navigation finds the first button without screen scraping or fixed coordinates.
# UI Automator would suppress the accessibility service being tested.
adb shell input keyevent KEYCODE_DPAD_UP KEYCODE_DPAD_UP KEYCODE_DPAD_CENTER
wait_for resumed "$PKG/.*MainActivity"
assert_allowed

echo 'Situate enforcement passed: foreground activation, pass, expiry, overlap, schedule, rapid reopen, Home/Back, lock/unlock, reconnect, removal, notifications on/off.'
