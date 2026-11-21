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
if (( $(adb shell getprop ro.build.version.sdk | tr -d '\r') >= 33 )); then
  adb shell pm grant "$PKG" android.permission.POST_NOTIFICATIONS
fi
adb shell input keyevent KEYCODE_HOME
adb shell run-as "$PKG" touch files/situate-ci-trace
old_services=$(adb shell settings get secure enabled_accessibility_services | tr -d '\r')
old_enabled=$(adb shell settings get secure accessibility_enabled | tr -d '\r')
planner_stopped=""
# Use the shell builtin so signal errors are consistent across emulator APIs.
signal_planner() { adb shell run-as "$PKG" sh -c "'kill -s $1 $planner_stopped'"; }
backup=0
if adb shell run-as "$PKG" test -f no_backup/situate-rules.json; then
  adb shell run-as "$PKG" cp no_backup/situate-rules.json cache/situate-ci-rules.backup
  backup=1
fi
cleanup() {
  if [[ -n "$planner_stopped" ]]; then signal_planner CONT || true; fi
  adb shell settings put secure enabled_accessibility_services "$old_services" >/dev/null || true
  adb shell settings put secure accessibility_enabled "$old_enabled" >/dev/null || true
  adb shell cmd notification disallow_listener "$LISTENER" >/dev/null || true
  if [[ "$backup" == 1 ]]; then
    adb shell run-as "$PKG" mv cache/situate-ci-rules.backup no_backup/situate-rules.json || true
  else
    adb shell run-as "$PKG" rm -f no_backup/situate-rules.json || true
  fi
  adb shell run-as "$PKG" rm -f files/situate-ci-trace || true
  adb logcat -d -s BalanceSituate:I ActivityTaskManager:I AndroidRuntime:E NotificationListeners:V ManagedServices:V ActivityManager:I '*:S' > logcat-situate-enforcement.txt || true
  adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null || true
}
trap cleanup EXIT
failed() {
  echo "Situate assertion failed at line $1 (emulator $(emulator_time))"
  adb shell dumpsys accessibility > situate-accessibility.txt || true
  adb shell dumpsys window windows > situate-windows.txt || true
  adb shell dumpsys notification > situate-notification.txt || true
  adb shell run-as "$PKG" cat no_backup/situate-rules.json > situate-rules-at-failure.txt || true
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
  adb shell dumpsys notification > situate-notification.txt || true
  return 1
}
resumed() { adb shell dumpsys activity activities | grep -E 'mResumedActivity|topResumedActivity' | grep "$1" >/dev/null; }
home_resumed() {
  local component
  component=$(adb shell cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME | tr -d '\r' | tail -n 1)
  resumed "$component"
}
launcher_events() { adb logcat -d -s BalanceSituate:I | grep -c "window package=${1%%/*} changes" || true; }
events_after() { (( $(launcher_events "$1") > $2 )); }
# Key injection returns before Android handles Home, and the launcher can report
# its window after a quickly following app start. Wait until the service has seen
# Home and the launcher has settled, so the next start is the newest event.
press_home() {
  local launcher seen
  launcher=$(adb shell cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME | tr -d '\r' | tail -n 1)
  seen=$(launcher_events "$launcher")
  adb shell input keyevent KEYCODE_HOME
  wait_for home_resumed
  wait_for events_after "$launcher" "$seen"
  sleep 1
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
# Emulator time, to line script steps up with the uploaded logcat.
emulator_time() { adb shell date +%H:%M:%S.%N 2>/dev/null | tr -d '\r' | cut -c1-12; }
assert_allowed() {
  wait_for gate_absent
  local cleared
  cleared=$(emulator_time)
  for sample in $(seq 1 6); do
    if ! gate_absent; then
      echo "Situate gate came back at emulator $(emulator_time) (sample $sample; absent at $cleared, called from line ${BASH_LINENO[0]})"
      return 1
    fi
    sleep 0.25
  done
}
notification_present() { adb shell dumpsys notification --noredact | grep 'NotificationRecord(' | grep "tag=$1" >/dev/null; }
notification_absent() {
  local records
  records=$(adb shell dumpsys notification --noredact) || return 1
  ! printf '%s\n' "$records" | grep 'NotificationRecord(' | grep "tag=$1" >/dev/null
}
code_notice_present() {
  adb shell dumpsys notification --noredact | python3 -c '
import re, sys
code, package = sys.argv[1:]
records = re.split(r"(?=^[ \t]*NotificationRecord\()", sys.stdin.read(), flags=re.M)
for record in records:
    header = record.splitlines()[0] if record.splitlines() else ""
    if "tag=situate-code-" not in header or "pkg=" + package + " " not in header: continue
    title = re.search(r"android.title=String \((.*?)\)\s*$", record, re.M)
    text = re.search(r"android.text=String \((.*?)\)\s*$", record, re.M)
    if title and title[1] == "Sign-in code received" and text and re.fullmatch(re.escape(code) + r" · [^\n]+", text[1]):
        # No original sender/message text is copied into any expanded content.
        if "SYNTHETIC_" in text[1] or "android.bigText=" in record: sys.exit(1)
        sys.exit(0)
sys.exit(1)
' "$1" "$PKG"
}
code_notice_count() { adb shell dumpsys notification --noredact | grep 'NotificationRecord(' | grep "pkg=$PKG " | grep -c 'tag=situate-code-' || true; }
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
    press_home
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
press_home
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
# The notification listener must remain independent of the planner's main thread.
listener_pid=$(adb shell pidof "$PKG:situate_notifications" | tr -d '\r')
[[ -n "$listener_pid" ]]
adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null
planner_stopped=$(adb shell pidof "$PKG" | tr -d '\r')
[[ "$planner_stopped" =~ ^[0-9]+$ && "$planner_stopped" != "$listener_pid" ]]
signal_planner STOP
rules on
adb shell cmd notification post -t Situate-stalled situate-ci-stalled SYNTHETIC_BLOCKED
wait_for notification_absent situate-ci-stalled
sleep 1
notification_absent situate-ci-stalled
signal_planner CONT
planner_gone() {
  local current
  current=$(adb shell pidof "$PKG" | tr -d '\r') || true
  [[ " $current " != *" $planner_stopped "* ]]
}
# API 31 forbids SIGKILL from run-as even though STOP/CONT work. Reclaim
# the cached planner through ActivityManager, without force-stopping the app
# (which would disable the OS-bound listener and accessibility service too).
press_home
for _ in $(seq 1 120); do
  adb shell am kill "$PKG"
  if planner_gone; then break; fi
  sleep 0.25
done
planner_gone
planner_stopped=""
# Once resumed, the planner saves its own Situate rules to Android (on startup,
# sync or a schedule tick), replacing this script's file. With it gone, restore
# the test rules: the listener alone must silence what follows.
rules on
[[ "$(adb shell pidof "$PKG:situate_notifications" | tr -d '\r')" == "$listener_pid" ]]
for attempt in $(seq 1 5); do
  adb shell cmd notification post -t Situate-burst "situate-ci-burst-$attempt" SYNTHETIC_BLOCKED
  wait_for notification_absent "situate-ci-burst-$attempt"
done
# Rule edits sweep already-posted notifications even when no mode ID changes.
rules off
adb shell cmd notification post -t Situate-edit situate-ci-edit SYNTHETIC_ALLOWED
wait_for notification_present situate-ci-edit
rules on
wait_for notification_absent situate-ci-edit
# Conversation updates must not keep bypassing blocking because of an old code.
adb shell cmd notification post -S messaging --conversation Synthetic --message Them:SYNTHETIC_CODE_482913 --message Them:SYNTHETIC_ORDINARY situate-ci-old-code SYNTHETIC_ORDINARY
wait_for notification_absent situate-ci-old-code
sleep 1
notification_absent situate-ci-old-code
[[ "$(code_notice_count)" == 0 ]]
adb shell cmd notification post -S messaging --conversation Synthetic --message Them:SYNTHETIC_ORDINARY --message Them:SYNTHETIC_CODE_482913 situate-ci-new-code SYNTHETIC_CODE_482913
wait_for notification_absent situate-ci-new-code
wait_for code_notice_present 482913
sleep 1
notification_absent situate-ci-new-code
[[ "$(code_notice_count)" == 1 ]]
# Pass expiry sweeps without the planner or a new notification callback.
rules pass
adb shell cmd notification post -t Situate-expiry situate-ci-expiry SYNTHETIC_ALLOWED
wait_for notification_present situate-ci-expiry
wait_for notification_absent situate-ci-expiry
# Codes are replaced by a minimal Balance notice; the original stays blocked.
adb shell cmd notification post -t Situate-code situate-ci-code SYNTHETIC_CODE_482913
wait_for notification_absent situate-ci-code
wait_for code_notice_present 482913
sleep 1
notification_absent situate-ci-code
[[ "$(code_notice_count)" == 1 ]]
# Reconnect also replaces missed codes without keeping the original messages.
adb shell cmd notification disallow_listener "$LISTENER"
adb shell cmd notification post -t Situate-missed situate-ci-missed SYNTHETIC_BLOCKED
wait_for notification_present situate-ci-missed
adb shell cmd notification post -t Situate-missed-code situate-ci-missed-code SYNTHETIC_CODE_582914
wait_for notification_present situate-ci-missed-code
adb shell cmd notification allow_listener "$LISTENER"
wait_for notification_absent situate-ci-missed-code
wait_for code_notice_present 582914
wait_for notification_absent situate-ci-missed
notification_absent situate-ci-code
rules off
assert_allowed
adb shell cmd notification post -t Situate-after-pass situate-ci-after-pass SYNTHETIC_ALLOWED
wait_for notification_present situate-ci-after-pass

# Killing the planner can return to Home instead of the older Settings task.
# Restore the foreground premise before checking app gates again.
adb shell am start -a android.settings.SETTINGS >/dev/null
wait_for resumed com.android.settings
assert_allowed
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

echo 'Situate enforcement passed: foreground activation, pass, expiry, overlap, schedule, rapid reopen, Home/Back, lock/unlock, reconnect, removal, notifications on/off, planner stall/death, rule-edit sweep, pass-expiry sweep, conversation updates, reconnect sweep, codes.'
