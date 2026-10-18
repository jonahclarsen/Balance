#!/usr/bin/env bash
# Disposable CI emulator only. No installed phone, planner data, or recovery key.
set -euo pipefail
[[ "${CI:-}" == true ]] || { echo 'Situate enforcement verification requires CI'; exit 1; }
PKG=app.balance.local
COMPONENT="$PKG/$PKG.SituateAccessibility"
LISTENER="$PKG/$PKG.SituateNotifications"
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
  adb shell am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p "$PKG" >/dev/null || true
}
trap cleanup EXIT
wait_for() {
  for _ in $(seq 1 30); do
    if "$@"; then return 0; fi
    sleep 1
  done
  echo "Situate emulator assertion timed out: $*"
  return 1
}
resumed() { adb shell dumpsys activity activities | grep -E 'mResumedActivity|topResumedActivity' | grep "$1" >/dev/null; }
notification_present() { adb shell dumpsys notification --noredact | grep 'NotificationRecord(' | grep "tag=$1" >/dev/null; }
notification_absent() {
  local records
  records=$(adb shell dumpsys notification --noredact) || return 1
  ! printf '%s\n' "$records" | grep 'NotificationRecord(' | grep "tag=$1" >/dev/null
}

adb shell cmd notification allow_listener "$LISTENER"
adb shell settings put secure enabled_accessibility_services "$COMPONENT"
adb shell settings put secure accessibility_enabled 1
# A control notification proves that posting and observing notifications work.
adb shell cmd notification post -t 'Situate synthetic control' situate-ci-allowed 'SYNTHETIC_ALLOWED'
wait_for notification_present situate-ci-allowed

python3 - <<'PY' | adb shell run-as "$PKG" tee no_backup/situate-rules.json >/dev/null
import json, time
now = int(time.time() * 1000)
targets = [{'id': 'app:' + app, 'kind': 'app', 'category': 'custom', 'value': app}
           for app in ['com.android.settings', 'com.android.shell']]
print(json.dumps({'version': 1, 'enabled': True, 'generatedAt': now,
                  'manual': {'ci-boundary': now}, 'grants': [], 'epochs': [],
                  'modes': [{'id': 'ci-boundary', 'name': 'CI boundary', 'platforms': ['android'],
                             'scheduled': False, 'targets': targets}]}))
PY

adb shell am start -a android.settings.SETTINGS >/dev/null
wait_for resumed SituateBlockedActivity
# Wait for the OS to connect the listener before testing a blocked delivery.
listener_connected() { adb shell dumpsys notification | grep -A 30 'Live services' | grep SituateNotifications >/dev/null; }
wait_for listener_connected
adb shell cmd notification post -t 'Situate synthetic blocked' situate-ci-blocked 'SYNTHETIC_BLOCKED'
wait_for notification_absent situate-ci-blocked

adb shell run-as "$PKG" rm no_backup/situate-rules.json
adb shell am start -a android.settings.SETTINGS >/dev/null
wait_for resumed com.android.settings
echo 'Situate enforcement passed: app blocked, notification silenced, app allowed after disabling.'
