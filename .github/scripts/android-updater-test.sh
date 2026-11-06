#!/usr/bin/env bash
# Disposable CI emulator only. Reinstall its own debug APK through the exact
# PackageInstaller path used by the Update button; no GitHub download or real data.
set -euo pipefail
PKG=app.balance.local.debug

# A freshly booted emulator's adb link can drop for a moment (adb exits 255).
# Every step here is safe to repeat, so retry it once the device is back.
adb_retry() {
  local attempt status
  for attempt in 1 2 3 4; do
    if adb "$@"; then return 0; else status=$?; fi
    echo "adb $1 failed with $status (attempt $attempt); waiting for the device." >&2
    timeout 10s adb wait-for-device || true
    sleep 2
  done
  return "$status"
}

save_full_log() {
  adb logcat -d > android-updater-log.txt 2>&1 || true
}

adb_retry install -r balance-debug.apk
adb_retry shell am force-stop --user 0 "$PKG"
adb_retry shell run-as "$PKG" mkdir -p files
BEFORE_PATH="$(adb_retry shell pm path --user 0 "$PKG" | tr -d '\r')"
adb_retry shell run-as "$PKG" touch files/updater-ci-selftest
adb_retry shell appops set --user 0 "$PKG" REQUEST_INSTALL_PACKAGES allow
adb_retry logcat -c
adb_retry shell am start --user 0 -n "$PKG/app.balance.local.MainActivity"

# Poll only the updater's result and crash reports: dumping the whole log
# every two seconds is slow and makes a dropped link more likely.
for _ in $(seq 1 50); do
  if ! adb logcat -d -s BalanceUpdater:V AndroidRuntime:E > android-updater-poll.txt; then
    echo 'adb poll failed; waiting for the device.'
    timeout 10s adb wait-for-device || true
    sleep 2
    continue
  fi
  # Play Services crashes on these images; only Balance's own crash counts.
  if grep -q 'BALANCE_UPDATE_E2E: FAIL' android-updater-poll.txt || grep -A1 'FATAL EXCEPTION' android-updater-poll.txt | grep -q "Process: $PKG"; then
    save_full_log
    cat android-updater-poll.txt
    exit 1
  fi
  if grep -q 'BALANCE_UPDATE_E2E: OK installed' android-updater-poll.txt; then
    # The installed APK path must change: success must mean actual replacement.
    AFTER_PATH="$(adb shell pm path --user 0 "$PKG" | tr -d '\r' || true)"
    if [ -n "$AFTER_PATH" ] && [ "$AFTER_PATH" != "$BEFORE_PATH" ]; then
      save_full_log
      echo 'PASS: Balance installed its update without another confirmation.'
      exit 0
    fi
  fi
  sleep 2
done
save_full_log
cat android-updater-poll.txt
echo 'FAIL: self-update did not replace the installed APK.'
exit 1
