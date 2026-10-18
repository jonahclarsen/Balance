#!/usr/bin/env bash
# Disposable CI emulator only. Reinstall its own debug APK through the exact
# PackageInstaller path used by the Update button; no GitHub download or real data.
set -euo pipefail
PKG=app.balance.local.debug
adb shell am force-stop --user 0 "$PKG"
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
    # Success alone isn't enough: the updated app must reopen without an ADB launch.
    if adb shell dumpsys activity activities | grep -E 'mResumedActivity|topResumedActivity' | grep -q "$PKG"; then
      echo 'PASS: Balance silently installed itself and reopened.'
      exit 0
    fi
  fi
  sleep 2
done
cat android-updater-log.txt
echo 'FAIL: self-update did not install and reopen Balance.'
exit 1
