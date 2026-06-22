#!/usr/bin/env bash
# Install the debug APK on a booted emulator, launch it, and fail if the app
# crashes on startup. Also verifies that the SQLCipher database and the
# Keystore-wrapped recovery key get created, and that a relaunch (which must
# unwrap the key again) still runs.
#
# Invoked from .github/workflows/android.yml inside the
# reactivecircus/android-emulator-runner step. It must run as a single script
# (that action executes a multi-line `script:` input line-by-line in separate
# shells, which breaks loops and variable scope), so the workflow calls it with
# `bash .github/scripts/android-smoke-test.sh`.
set -euo pipefail

# The debug applicationId is the tauri identifier plus the configured
# debugApplicationIdSuffix (".debug").
PKG=app.balance.local.debug

launch() {
  adb logcat -c
  adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1
  # Give the webview time to initialize, derive the recovery key via the Android
  # Keystore, open the SQLCipher/OpenSSL database and render the frontend.
  sleep 25
}

assert_running() {
  phase="$1"
  logfile="$2"
  adb logcat -d > "$logfile" || true
  PID="$(adb shell pidof "$PKG" | tr -d '\r' || true)"
  echo "[$phase] app pid: '$PID'"
  if [ -z "$PID" ]; then
    echo "[$phase] app process is not running - it crashed or never started."
    echo "----- recovery / db related log lines -----"
    grep -iE "recovery|keystore|sqlite|sqlcipher|libbalance_lib|UnsatisfiedLink|RustStdoutStderr" "$logfile" || true
    exit 1
  fi
  if grep -qE "FATAL EXCEPTION" "$logfile"; then
    echo "[$phase] found a fatal exception in logcat:"
    grep -A 20 "FATAL EXCEPTION" "$logfile"
    exit 1
  fi
  echo "[$phase] running (pid $PID) with no fatal exceptions."
}

adb install -r balance-debug.apk

# Wait until PackageManager can resolve the package before launching.
for _ in $(seq 1 15); do
  if adb shell pm path "$PKG" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
adb shell pm path "$PKG"

# First launch: generates the recovery key, wraps it with a hardware-backed
# Keystore key, writes the ciphertext, and creates the encrypted database.
launch
assert_running "first-launch" logcat.txt

# The debug build is debuggable, so we can inspect its private storage. Both the
# encrypted database and the Keystore-wrapped key file must now exist - that only
# happens if the Keystore wrap and the SQLCipher open both succeeded.
echo "===== app-private files ====="
adb shell run-as "$PKG" find . -type f 2>/dev/null | tr -d '\r' | grep -iE "balance" || true
DB_FILE="$(adb shell run-as "$PKG" find . -name 'balance.sqlite3' 2>/dev/null | tr -d '\r')"
KEY_FILE="$(adb shell run-as "$PKG" find . -name 'balance-recovery.key.enc' 2>/dev/null | tr -d '\r')"
echo "database file: '$DB_FILE'"
echo "wrapped key file: '$KEY_FILE'"
if [ -z "$DB_FILE" ]; then
  echo "The encrypted database was never created."
  exit 1
fi
if [ -z "$KEY_FILE" ]; then
  echo "The Keystore-wrapped recovery key file was never created."
  exit 1
fi

# Second launch: the key file and database already exist, so the app must unwrap
# the recovery key via the Keystore again and reopen the database. A failed
# unwrap surfaces as the frontend's "Could not load encrypted Balance app state"
# error (the same signature the pre-fix ndk_context panic produced) and the DB
# never reopens. We also require the process to stay alive, but retry if the
# emulator's Play Services cycles and collaterally kills the app (its Chromium
# webview depends on the GMS fonts provider) - an environment flake, not a bug.
UNWRAP_OK=0
for attempt in 1 2 3; do
  adb shell am force-stop "$PKG"
  sleep 2
  adb logcat -c
  adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1
  sleep 18
  adb logcat -d > logcat2.txt || true

  if grep -qE "Could not load encrypted Balance app state|Keystore unwrap failed|FATAL EXCEPTION" logcat2.txt; then
    echo "[relaunch] unwrap / load failed:"
    grep -iE "Could not load encrypted Balance app state|Keystore unwrap failed|FATAL EXCEPTION|recovery|keystore" logcat2.txt | head -20
    exit 1
  fi

  PID="$(adb shell pidof "$PKG" | tr -d '\r' || true)"
  if [ -n "$PID" ]; then
    echo "[relaunch] running (pid $PID); unwrapped the key and reopened the database with no errors."
    UNWRAP_OK=1
    break
  fi

  if grep -qE "depends on provider com.google.android.gms|dying proc com.google.android.gms.persistent" logcat2.txt; then
    echo "[relaunch] attempt $attempt: app collaterally killed by Play Services cycling; retrying."
    continue
  fi

  echo "[relaunch] app process is gone with no app-level error and no GMS kill - treating as failure."
  exit 1
done

if [ "$UNWRAP_OK" != 1 ]; then
  echo "[relaunch] could not get a stable relaunch after retries (emulator instability)."
  exit 1
fi

echo "App builds, launches, persists an encrypted database, and reopens it via the Keystore on relaunch."
