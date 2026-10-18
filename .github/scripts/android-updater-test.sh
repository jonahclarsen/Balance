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
for _ in $(seq 1 50); do
  adb logcat -d > android-updater-log.txt
  if grep -q 'BALANCE_UPDATE_E2E: FAIL\|FATAL EXCEPTION' android-updater-log.txt; then
    cat android-updater-log.txt
    exit 1
  fi
  if grep -q 'BALANCE_UPDATE_E2E: OK installed' android-updater-log.txt; then
    # The installed APK path must change: success must mean actual replacement.
    AFTER_PATH="$(adb shell pm path --user 0 "$PKG" | tr -d '\r')"
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
