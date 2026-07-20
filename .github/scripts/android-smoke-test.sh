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

# Multi-device sync E2E: on debug launch the app creates real primary/joiner
# Balance databases, pairs them with an encoded key, syncs their operation logs
# over TCP, and verifies user data reached the joiner. This runs inside the APK,
# so it also proves the Android cr-sqlite .so and SQLCipher paths work.
SYNC_OK=0
for _ in $(seq 1 10); do
  adb logcat -d > sync-log.txt 2>/dev/null || true
  if grep -q "BALANCE_SYNC_E2E: OK" sync-log.txt; then
    SYNC_OK=1
    break
  fi
  if grep -q "BALANCE_SYNC_E2E: FAIL" sync-log.txt; then
    echo "[sync] Android E2E FAILED on device:"
    grep "BALANCE_SYNC_E2E" sync-log.txt | head
    grep -iE "crsqlite|load_extension|UnsatisfiedLink|dlopen|library" sync-log.txt | head -20 || true
    exit 1
  fi
  sleep 3
done
if [ "$SYNC_OK" != 1 ]; then
  echo "[sync] E2E marker never appeared."
  grep -iE "crsqlite|load_extension|UnsatisfiedLink|dlopen|RustStdoutStderr" sync-log.txt | head -20 || true
  exit 1
fi
echo "[sync] paired Android databases exchanged E2EE data over TCP and converged."

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

# ---------------------------------------------------------------------------
# Real UI pairing test
# ---------------------------------------------------------------------------
# Install the same APK into a managed profile. Android gives the profile an
# independent UID, process, Keystore namespace, and app-data directory, so the
# two installations behave like separate phones while sharing the emulator's
# network. Drive the visible WebView with UI Automator: create primary data and
# a key, submit that key on the joining installation with the keyboard's Enter
# action, connect to the primary's displayed address, then assert the primary's
# user-visible goal appears on the joiner.

UI_XML=sync-e2e-ui.xml
E2E_ACTIVE=1

capture_e2e_diagnostics() {
  if [ "${E2E_ACTIVE:-0}" != 1 ]; then
    return
  fi
  adb logcat -d > logcat-sync-e2e.txt 2>/dev/null || true
  adb shell uiautomator dump /sdcard/sync-e2e-window.xml >/dev/null 2>&1 || true
  adb exec-out cat /sdcard/sync-e2e-window.xml > sync-e2e-window.xml 2>/dev/null || true
  adb exec-out screencap -p > sync-e2e-failure.png 2>/dev/null || true
}
trap capture_e2e_diagnostics EXIT

dump_ui() {
  tmp_xml="${UI_XML}.tmp"
  for attempt in $(seq 1 5); do
    if adb shell uiautomator dump /sdcard/sync-e2e-window.xml >/dev/null 2>&1 \
      && adb exec-out cat /sdcard/sync-e2e-window.xml > "$tmp_xml" 2>/dev/null \
      && grep -q '<hierarchy' "$tmp_xml"; then
      mv "$tmp_xml" "$UI_XML"
      return 0
    fi
    echo "UI Automator dump attempt $attempt failed; retrying."
    sleep 1
  done
  rm -f "$tmp_xml"
  echo "UI Automator could not capture the app hierarchy after retries."
  return 1
}

# Print the center of the best matching accessibility node. Inputs and buttons
# are preferred over their associated label text.
find_ui_node() {
  attribute="$1"
  query="$2"
  match_mode="${3:-exact}"
  python3 - "$UI_XML" "$attribute" "$query" "$match_mode" <<'PY'
import re
import sys
import xml.etree.ElementTree as ET

path, attribute, query, mode = sys.argv[1:]
root = ET.parse(path).getroot()
candidates = []
for node in root.iter("node"):
    value = node.attrib.get(attribute, "")
    matches = value == query if mode == "exact" else query in value
    if not matches:
        continue
    bounds = node.attrib.get("bounds", "")
    numbers = [int(number) for number in re.findall(r"\d+", bounds)]
    if len(numbers) != 4:
        continue
    x1, y1, x2, y2 = numbers
    if x2 <= x1 or y2 <= y1 or node.attrib.get("enabled") != "true":
        continue
    class_name = node.attrib.get("class", "")
    score = 0
    if "EditText" in class_name:
        score += 20
    if "Button" in class_name:
        score += 10
    if node.attrib.get("clickable") == "true":
        score += 5
    if node.attrib.get("focusable") == "true":
        score += 2
    candidates.append((score, (x1 + x2) // 2, (y1 + y2) // 2))

if candidates:
    _, x, y = max(candidates)
    print(f"{x} {y}")
PY
}

# Print the center of the first matching class after an anchor node in the
# accessibility tree. Chromium omits HTML ids for some WebView inputs, but it
# preserves their DOM/accessibility order after the visible label.
find_ui_class_after_text() {
  anchor="$1"
  target_class="$2"
  python3 - "$UI_XML" "$anchor" "$target_class" <<'PY'
import re
import sys
import xml.etree.ElementTree as ET

path, anchor, target_class = sys.argv[1:]
nodes = list(ET.parse(path).getroot().iter("node"))
for index, node in enumerate(nodes):
    if node.attrib.get("text") != anchor:
        continue
    for candidate in nodes[index + 1:]:
        if candidate.attrib.get("class") != target_class:
            continue
        if candidate.attrib.get("enabled") != "true":
            continue
        numbers = [int(number) for number in re.findall(r"\d+", candidate.attrib.get("bounds", ""))]
        if len(numbers) != 4:
            continue
        x1, y1, x2, y2 = numbers
        if x2 <= x1 or y2 <= y1:
            continue
        print(f"{(x1 + x2) // 2} {(y1 + y2) // 2}")
        raise SystemExit(0)
raise SystemExit(1)
PY
}

tap_ui() {
  attribute="$1"
  query="$2"
  attempts="${3:-20}"
  for _ in $(seq 1 "$attempts"); do
    dump_ui
    point="$(find_ui_node "$attribute" "$query" exact)"
    if [ -n "$point" ]; then
      # shellcheck disable=SC2086
      adb shell input tap $point
      return 0
    fi
    sleep 1
  done
  echo "Could not find UI node: $attribute=$query"
  return 1
}

tap_ui_scrolling() {
  attribute="$1"
  query="$2"
  for _ in $(seq 1 8); do
    if tap_ui "$attribute" "$query" 1; then
      return 0
    fi
    adb shell input swipe 160 580 160 180 300
    sleep 1
  done
  echo "Could not find UI node after scrolling: $attribute=$query"
  return 1
}

tap_ui_scrolling_contains() {
  attribute="$1"
  query="$2"
  for _ in $(seq 1 8); do
    dump_ui
    point="$(find_ui_node "$attribute" "$query" contains)"
    if [ -n "$point" ]; then
      # shellcheck disable=SC2086
      adb shell input tap $point
      return 0
    fi
    adb shell input swipe 160 580 160 180 300
    sleep 1
  done
  echo "Could not find UI node after scrolling: $attribute contains $query"
  return 1
}

tap_ui_class_after_text_scrolling() {
  anchor="$1"
  target_class="$2"
  for _ in $(seq 1 8); do
    dump_ui
    point="$(find_ui_class_after_text "$anchor" "$target_class" 2>/dev/null || true)"
    if [ -n "$point" ]; then
      # shellcheck disable=SC2086
      adb shell input tap $point
      return 0
    fi
    adb shell input swipe 160 580 160 180 300
    sleep 1
  done
  echo "Could not find $target_class after text=$anchor"
  return 1
}

tap_ui_scrolling_up() {
  attribute="$1"
  query="$2"
  for _ in $(seq 1 8); do
    if tap_ui "$attribute" "$query" 1; then
      return 0
    fi
    adb shell input swipe 160 180 160 580 300
    sleep 1
  done
  echo "Could not find UI node after scrolling up: $attribute=$query"
  return 1
}

wait_for_ui_text() {
  query="$1"
  attempts="${2:-30}"
  for _ in $(seq 1 "$attempts"); do
    dump_ui
    if python3 - "$UI_XML" "$query" <<'PY'
import sys
import xml.etree.ElementTree as ET

root = ET.parse(sys.argv[1]).getroot()
query = sys.argv[2]
found = any(
    query in node.attrib.get(attribute, "")
    for node in root.iter("node")
    for attribute in ("text", "content-desc")
)
raise SystemExit(0 if found else 1)
PY
    then
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for UI text: $query"
  return 1
}

read_lan_address() {
  dump_ui
  python3 - "$UI_XML" <<'PY'
import re
import sys
import xml.etree.ElementTree as ET

root = ET.parse(sys.argv[1]).getroot()
pattern = re.compile(r"(?:\d{1,3}\.){3}\d{1,3}:\d+")
for node in root.iter("node"):
    for attribute in ("text", "content-desc"):
        match = pattern.search(node.attrib.get(attribute, ""))
        if match:
            print(match.group(0))
            raise SystemExit(0)
raise SystemExit(1)
PY
}

type_into_ui() {
  attribute="$1"
  query="$2"
  value="$3"
  tap_ui_scrolling "$attribute" "$query" || return 1
  adb shell input text "$value"
}

type_into_ui_contains() {
  attribute="$1"
  query="$2"
  value="$3"
  tap_ui_scrolling_contains "$attribute" "$query" || return 1
  adb shell input text "$value"
}

type_into_ui_after_text() {
  anchor="$1"
  value="$2"
  tap_ui_class_after_text_scrolling "$anchor" "android.widget.EditText" || return 1
  adb shell input text "$value"
}

dismiss_recovery_key_setup() {
  # The Rust process can be ready several seconds before the WebView finishes
  # rendering this first-run dialog, especially after an emulator/GMS restart.
  for _ in $(seq 1 30); do
    dump_ui
    if [ -n "$(find_ui_node text "Save your recovery key" exact)" ]; then
      tap_ui class "android.widget.CheckBox"
      # Enabling Continue is asynchronous in the WebView. tap_ui ignores
      # disabled nodes, so it waits for the checked state to render first.
      tap_ui text "Continue"
      for _ in $(seq 1 20); do
        dump_ui
        if [ -z "$(find_ui_node text "Save your recovery key" exact)" ]; then
          return 0
        fi
        sleep 1
      done
      echo "Recovery-key setup did not close."
      return 1
    fi
    sleep 1
  done
  echo "Recovery-key setup never appeared."
  return 1
}

PAIRING_CODE="$(tr -d '\r\n' < sync-e2e-pairing-code.txt)"
if [[ "$PAIRING_CODE" != BALSYNC1:* ]]; then
  echo "The camera fixture did not contain a Balance pairing code."
  exit 1
fi

echo "[ui-sync] enabling the source installation with the camera fixture key"
dismiss_recovery_key_setup
tap_ui text "Settings"
type_into_ui_after_text "Pair with another device" "$PAIRING_CODE"
# The emulator injects text through its hardware input path, so no soft keyboard
# is guaranteed to be visible. Submit with Enter and never send Back here: Back
# would close Balance when the soft keyboard is absent or already dismissed.
adb shell input keyevent KEYCODE_ENTER
for _ in $(seq 1 8); do
  if wait_for_ui_text "Paired." 1; then
    break
  fi
  adb shell input swipe 160 580 160 180 300
done
wait_for_ui_text "Paired." 20

PRIMARY_ADDRESS=""
for _ in $(seq 1 60); do
  PRIMARY_ADDRESS="$(read_lan_address 2>/dev/null || true)"
  if [ -n "$PRIMARY_ADDRESS" ]; then
    break
  fi
  sleep 1
done
if [ -z "$PRIMARY_ADDRESS" ]; then
  echo "[ui-sync] source never exposed a LAN address after pairing"
  exit 1
fi
echo "[ui-sync] source is paired and listening at $PRIMARY_ADDRESS"

echo "[ui-sync] creating recognizable data on the source installation"
tap_ui_scrolling_up text "Goals"
wait_for_ui_text "Add a goal"
# A goal requires both a name and at least one matching phrase. Fill the real
# fields and press the visible Add button so seeing the name afterward proves a
# persisted goal card exists (rather than merely seeing text in an input).
type_into_ui_after_text "NAME" "CISyncGoal"
adb shell input keyevent KEYCODE_BACK || true
type_into_ui_after_text "MATCHES ANY" "ci-sync"
adb shell input keyevent KEYCODE_BACK || true
tap_ui_scrolling text "Add goal"
wait_for_ui_text "CISyncGoal"
# Let the normal debounced operation writer commit before sync snapshots it.
sleep 2

echo "[ui-sync] installing an isolated joining copy in a managed profile"
PROFILE_OUTPUT="$(adb shell pm create-user --profileOf 0 --managed --for-testing BalanceSyncPeer | tr -d '\r')"
PEER_USER="$(printf '%s\n' "$PROFILE_OUTPUT" | awk '{print $NF}')"
if ! [[ "$PEER_USER" =~ ^[0-9]+$ ]]; then
  echo "Managed profile creation failed: $PROFILE_OUTPUT"
  exit 1
fi
adb shell am start-user -w "$PEER_USER"
adb shell cmd package install-existing --user "$PEER_USER" "$PKG"
# Avoid a system permission dialog obscuring the scanner. The app still checks
# the real Android camera permission before it calls the native plugin.
adb shell pm grant --user "$PEER_USER" "$PKG" android.permission.CAMERA

COMPONENT="$(adb shell cmd package resolve-activity --brief --user 0 \
  -a android.intent.action.MAIN -c android.intent.category.LAUNCHER "$PKG" \
  | tr -d '\r' | tail -n 1)"
if [[ "$COMPONENT" != */* ]]; then
  echo "Could not resolve Balance launcher component: $COMPONENT"
  exit 1
fi
adb shell am start --user "$PEER_USER" -n "$COMPONENT"
sleep 8

echo "[ui-sync] scanning the pairing QR through Android's emulated back camera"
dismiss_recovery_key_setup
tap_ui_scrolling_up text "Settings"
tap_ui_scrolling text "Scan QR code"
for _ in $(seq 1 30); do
  if wait_for_ui_text "Paired." 1; then
    break
  fi
done
wait_for_ui_text "Paired." 20
echo "[ui-sync] camera QR scan paired the isolated joining installation"

echo "[ui-sync] connecting the joiner to the primary's manual LAN address"
type_into_ui_after_text "Direct device-to-device (same Wi-Fi)" "$PRIMARY_ADDRESS"
adb shell input keyevent KEYCODE_BACK || true
tap_ui_scrolling text "Sync with address"
wait_for_ui_text "Synced directly with" 30

# A successful sync rehydrates the frontend from the joining profile's encrypted
# database. The primary-only goal must now be present in that materialized state.
tap_ui_scrolling_up text "Goals"
wait_for_ui_text "CISyncGoal" 30
echo "[ui-sync] PASS: camera QR pairing transferred source user data to the isolated joiner"

E2E_ACTIVE=0
trap - EXIT
adb logcat -d > logcat-sync-e2e.txt 2>/dev/null || true

echo "App builds, launches, reopens its encrypted database, scans a real QR camera frame, and syncs two isolated Android installations."
