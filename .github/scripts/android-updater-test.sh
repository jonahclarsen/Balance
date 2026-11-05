#!/usr/bin/env bash
# Disposable CI emulator only. Reinstall its own debug APK through the exact
# PackageInstaller path used by the Update button; no GitHub download or real data.
set -euo pipefail
PKG=app.balance.local.debug
adb install -r balance-debug.apk
adb shell am force-stop --user 0 "$PKG"
adb shell run-as "$PKG" mkdir -p files
BEFORE_PATH="$(adb shell pm path --user 0 "$PKG" | tr -d '\r')"
adb shell run-as "$PKG" touch files/updater-ci-selftest
adb shell appops set --user 0 "$PKG" REQUEST_INSTALL_PACKAGES allow
adb logcat -c
adb shell am start --user 0 -n "$PKG/app.balance.local.MainActivity"
# A freshly booted emulator's adb link can drop for a moment; a failed poll
# is retried, and the attempt count still bounds the wait.
for _ in $(seq 1 50); do
  if ! adb logcat -d > android-updater-log.txt; then
    echo 'adb poll failed; waiting for the device.'
    timeout 10s adb wait-for-device || true
    sleep 2
    continue
  fi
  # Play Services crashes on these images; only Balance's own crash counts.
  if grep -q 'BALANCE_UPDATE_E2E: FAIL' android-updater-log.txt || grep -A1 'FATAL EXCEPTION' android-updater-log.txt | grep -q "Process: $PKG"; then
    cat android-updater-log.txt
    exit 1
  fi
  if grep -q 'BALANCE_UPDATE_E2E: OK installed' android-updater-log.txt; then
    # The installed APK path must change: success must mean actual replacement.
    AFTER_PATH="$(adb shell pm path --user 0 "$PKG" | tr -d '\r' || true)"
    if [ -n "$AFTER_PATH" ] && [ "$AFTER_PATH" != "$BEFORE_PATH" ]; then
      echo 'PASS: Balance installed its update without another confirmation.'
      exit 0
    fi
  fi
  sleep 2
done
cat android-updater-log.txt
echo 'FAIL: self-update did not replace the installed APK.'
exit 1
