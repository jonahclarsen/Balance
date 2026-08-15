#!/usr/bin/env bash
set -euo pipefail

PKG=app.balance.local
TIMING_FILE=arm-release-smoke-timing.txt
START_SECONDS="$SECONDS"

record_timing() {
  printf '%s=%s\n' "$1" "$((SECONDS - START_SECONDS))" | tee -a "$TIMING_FILE"
}

wait_for_process() {
  local phase="$1"
  local log_file="$2"
  local pid=""

  for _ in $(seq 1 30); do
    pid="$(adb shell pidof "$PKG" | tr -d '\r' || true)"
    if [[ -n "$pid" ]]; then
      adb logcat -d > "$log_file" || true
      if grep -qE "FATAL EXCEPTION|UnsatisfiedLinkError" "$log_file"; then
        echo "[$phase] fatal Android or native-library error"
        grep -A 20 -E "FATAL EXCEPTION|UnsatisfiedLinkError" "$log_file" | head -80
        return 1
      fi
      echo "[$phase] release process is running (pid $pid)"
      record_timing "$phase"
      return 0
    fi
    sleep 2
  done

  adb logcat -d > "$log_file" || true
  echo "[$phase] release process did not remain running"
  grep -iE "FATAL EXCEPTION|UnsatisfiedLink|libbalance_lib|RustStdoutStderr" "$log_file" | tail -80 || true
  return 1
}

: > "$TIMING_FILE"
echo "host_arch=$(uname -m)" | tee -a "$TIMING_FILE"
echo "device_abi=$(adb shell getprop ro.product.cpu.abi | tr -d '\r')" | tee -a "$TIMING_FILE"

adb install -r balance-arm64.apk
record_timing install_seconds

adb logcat -c
adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1
wait_for_process first_launch_seconds arm-release-logcat-first.txt

adb shell am force-stop "$PKG"
adb logcat -c
adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1
wait_for_process relaunch_seconds arm-release-logcat-second.txt
