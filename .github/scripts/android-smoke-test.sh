#!/usr/bin/env bash
# Install the debug APK on a booted emulator, launch it, and fail if the app
# crashes on startup. Invoked from .github/workflows/android.yml inside the
# reactivecircus/android-emulator-runner step. It must run as a single script
# (that action executes a multi-line `script:` input line-by-line in separate
# shells, which breaks loops and variable scope), so the workflow calls it with
# `bash .github/scripts/android-smoke-test.sh`.
set -euo pipefail

# The debug applicationId is the tauri identifier plus the configured
# debugApplicationIdSuffix (".debug").
PKG=app.balance.local.debug

adb install -r balance-debug.apk

# PackageManager can lag a second or two behind a successful install, so wait
# until it can resolve the package before launching.
for _ in $(seq 1 15); do
  if adb shell pm path "$PKG" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
# Fail loudly if the package never registered.
adb shell pm path "$PKG"

adb logcat -c
adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1

# Give the webview time to initialize, open the SQLCipher/OpenSSL database and
# render the frontend.
sleep 25

adb logcat -d > logcat.txt || true
echo "===== app / crash log lines ====="
grep -iE "FATAL EXCEPTION|beginning of crash|libbalance_lib|UnsatisfiedLink|RustStdoutStderr|balance" logcat.txt || true

echo "===== checks ====="
# The process must still be alive. If the native library had failed to load, the
# process would have died with an UnsatisfiedLinkError before reaching here.
PID="$(adb shell pidof "$PKG" | tr -d '\r' || true)"
echo "App pid: '$PID'"
if [ -z "$PID" ]; then
  echo "App process is not running - it crashed or never started."
  exit 1
fi

# No fatal native or Java crash anywhere in the log.
if grep -qE "FATAL EXCEPTION" logcat.txt; then
  echo "Found a fatal exception in logcat:"
  grep -A 20 "FATAL EXCEPTION" logcat.txt
  exit 1
fi

echo "App launched and is running (pid $PID) with no fatal exceptions."
