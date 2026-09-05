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

# ADB occasionally wedges while waiting for Android's accessibility stack
# (notably `uiautomator dump` against a WebView). Without a deadline, one such
# call holds the runner until GitHub's six-hour default job limit. Route every
# ADB invocation through GNU timeout so retries and diagnostics can actually run.
ADB_BIN="$(command -v adb)"
ADB_TIMEOUT_SECONDS="${ADB_TIMEOUT_SECONDS:-30}"

adb() {
  local status
  if timeout --foreground --kill-after=5s "${ADB_TIMEOUT_SECONDS}s" "$ADB_BIN" "$@"; then
    return 0
  else
    status=$?
  fi
  if [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; then
    echo "[adb-timeout] adb $* exceeded ${ADB_TIMEOUT_SECONDS}s." >&2
  fi
  return "$status"
}

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

# The debug app runs an on-device widget self-test after the encrypted database
# opens. It loads today's native snapshot through SQLCipher + Android Keystore,
# verifies the home-screen provider metadata and inflates its RemoteViews.
WIDGET_OK=0
for _ in $(seq 1 10); do
  adb logcat -d > widget-log.txt 2>/dev/null || true
  if grep -q "BALANCE_WIDGET_E2E: OK home native-snapshot" widget-log.txt; then
    WIDGET_OK=1
    break
  fi
  if grep -q "BALANCE_WIDGET_E2E: FAIL" widget-log.txt; then
    echo "[widgets] Android widget E2E FAILED on device:"
    grep -A 20 "BALANCE_WIDGET_E2E: FAIL" widget-log.txt | head -40
    exit 1
  fi
  sleep 2
done
if [ "$WIDGET_OK" != 1 ]; then
  echo "[widgets] Widget E2E marker never appeared."
  grep -iE "BalanceWidgets|AppWidget|nativeSnapshot|UnsatisfiedLink" widget-log.txt | head -40 || true
  exit 1
fi
echo "[widgets] home-screen provider loaded encrypted data and inflated successfully."

# WorkManager is registered only after the activity leaves the foreground, with
# a fresh five-minute delay. This prevents an overdue background pass from taking the
# database lock while the WebView is loading sync settings.
adb shell input keyevent KEYCODE_HOME
BACKGROUND_JOB_OK=0
for _ in $(seq 1 10); do
  adb shell dumpsys jobscheduler > jobscheduler.txt
  adb logcat -d > background-sync-log.txt 2>/dev/null || true
  if grep -Fq "$PKG/androidx.work.impl.background.systemjob.SystemJobService" jobscheduler.txt \
    && grep -q "Scheduled background relay sync in five minutes" background-sync-log.txt; then
    BACKGROUND_JOB_OK=1
    break
  fi
  sleep 2
done
if [ "$BACKGROUND_JOB_OK" != 1 ]; then
  echo "Android WorkManager did not register the automatic relay-sync job."
  grep -iE "$PKG|workmanager|systemjobservice" jobscheduler.txt | head -40 || true
  exit 1
fi
echo "[background-sync] WorkManager relay sync is registered only after backgrounding."

adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null
assert_running "foreground-after-background-registration" logcat.txt
FOREGROUND_DEFERRED=0
for _ in $(seq 1 10); do
  adb logcat -d > background-sync-log.txt 2>/dev/null || true
  if grep -q "Deferred background relay sync while Balance is foregrounded" background-sync-log.txt; then
    FOREGROUND_DEFERRED=1
    break
  fi
  sleep 1
done
if [ "$FOREGROUND_DEFERRED" != 1 ]; then
  echo "Android did not cancel/defer background relay sync on foreground entry."
  grep -i "BalanceBackgroundSync" background-sync-log.txt | tail -20 || true
  exit 1
fi
echo "[background-sync] Foreground entry cancels and defers background relay sync."

# The debug build is debuggable, so we can inspect its private storage. Both the
# encrypted database and the Keystore-wrapped key file must now exist - that only
# happens if the Keystore wrap and the SQLCipher open both succeeded.
echo "===== app-private files ====="
adb shell run-as "$PKG" find . -type f 2>/dev/null | tr -d '\r' | grep -iE "balance" || true
DB_FILE="$(adb shell run-as "$PKG" find . -name 'balance.sqlite3' 2>/dev/null | tr -d '\r')"
KEY_FILE="$(adb shell run-as "$PKG" find . -name 'balance-recovery-raw-v1.key.enc' 2>/dev/null | tr -d '\r')"
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
# through synthetic encrypted envelopes, and verifies data reached the joiner. This runs inside the APK,
# so it also proves the Android SQLCipher path works.
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
    grep -iE "UnsatisfiedLink|dlopen|library" sync-log.txt | head -20 || true
    exit 1
  fi
  sleep 3
done
if [ "$SYNC_OK" != 1 ]; then
  echo "[sync] E2E marker never appeared."
  grep -iE "UnsatisfiedLink|dlopen|RustStdoutStderr" sync-log.txt | head -20 || true
  exit 1
fi
echo "[sync] paired synthetic Android databases exchanged E2EE data and converged."
SYNC_PROFILE_OK=0
if grep -q "BALANCE_SYNC_E2E_PROFILE:" sync-log.txt; then
  grep "BALANCE_SYNC_E2E_PROFILE:" sync-log.txt \
    | tail -1 \
    | sed 's/^.*BALANCE_SYNC_E2E_PROFILE: //' \
    > sync-e2e-large-task-profile.json
  python3 -m json.tool sync-e2e-large-task-profile.json
  python3 -c 'import json; p=json.load(open("sync-e2e-large-task-profile.json")); assert p["fixturePlans"] == 365; assert p["fixturePlanItems"] == 7300'
  SYNC_PROFILE_OK=1
fi
if [ "$SYNC_PROFILE_OK" != 1 ]; then
  echo "[sync-profile] long-task profile marker never appeared."
  grep "BALANCE_SYNC_E2E" sync-log.txt | tail -20 || true
  exit 1
fi
echo "[sync-profile] synthetic large-workspace / long-duration-task timings captured."

# Profile only synthetic, app-generated data. The native harness compares the
# current two-connection blocking startup path with the same work performed on
# one SQLCipher connection, alternating order across seven iterations.
STARTUP_PROFILE_OK=0
for _ in $(seq 1 20); do
  adb logcat -d > startup-profile-log.txt 2>/dev/null || true
  if grep -q "BALANCE_ANDROID_STARTUP_PROFILE_FAIL" startup-profile-log.txt; then
    echo "[startup-profile] native profile failed:"
    grep "BALANCE_ANDROID_STARTUP_PROFILE_FAIL" startup-profile-log.txt | tail -5
    exit 1
  fi
  if grep -q "BALANCE_ANDROID_STARTUP_PROFILE:" startup-profile-log.txt; then
    grep "BALANCE_ANDROID_STARTUP_PROFILE:" startup-profile-log.txt \
      | tail -1 \
      | sed 's/^.*BALANCE_ANDROID_STARTUP_PROFILE: //' \
      > android-startup-profile.json
    python3 -m json.tool android-startup-profile.json >/dev/null
    STARTUP_PROFILE_OK=1
    break
  fi
  sleep 3
done
if [ "$STARTUP_PROFILE_OK" != 1 ]; then
  echo "[startup-profile] profile marker never appeared."
  grep -iE "BALANCE_ANDROID_STARTUP_PROFILE|RustStdoutStderr" startup-profile-log.txt | tail -40 || true
  exit 1
fi
echo "[startup-profile] synthetic Android startup profile:"
python3 -m json.tool android-startup-profile.json

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

# A database/key failure must never render the frontend's empty bootstrap state
# as if it were the user's real data. Corrupt only a disposable copy of the
# wrapped key, verify the blocking recovery screen appears and the encrypted DB
# stays byte-for-byte intact, then restore the key and prove the app reopens.
adb shell run-as "$PKG" cp "$KEY_FILE" "${KEY_FILE}.ci-backup"
DB_HASH_BEFORE="$(adb exec-out run-as "$PKG" cat "$DB_FILE" | sha256sum | awk '{print $1}')"
adb shell run-as "$PKG" dd if=/dev/null of="$KEY_FILE"
adb shell am force-stop "$PKG"
adb logcat -c
adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1
DATABASE_FAILURE_UI_OK=0
for _ in $(seq 1 10); do
  adb shell uiautomator dump /sdcard/sync-e2e-database-load-failure.xml >/dev/null 2>&1 || true
  adb exec-out cat /sdcard/sync-e2e-database-load-failure.xml > sync-e2e-database-load-failure.xml 2>/dev/null || true
  if grep -Fq "open your encrypted database" sync-e2e-database-load-failure.xml; then
    DATABASE_FAILURE_UI_OK=1
    break
  fi
  sleep 3
done
adb logcat -d > logcat-database-load-failure.txt || true
if [ "$DATABASE_FAILURE_UI_OK" != 1 ]; then
  echo "[database-failure] blocking recovery screen did not appear."
  grep -iE "database|keystore|recovery" sync-e2e-database-load-failure.xml | head -20 || true
  grep -iE "database|keystore|recovery|RustStdoutStderr" logcat-database-load-failure.txt | tail -60 || true
  exit 1
fi
DB_HASH_AFTER="$(adb exec-out run-as "$PKG" cat "$DB_FILE" | sha256sum | awk '{print $1}')"
if [ "$DB_HASH_BEFORE" != "$DB_HASH_AFTER" ]; then
  echo "[database-failure] encrypted database changed while its key was unavailable."
  exit 1
fi
echo "[database-failure] unavailable key was blocked without changing the encrypted database."

adb shell run-as "$PKG" mv "${KEY_FILE}.ci-backup" "$KEY_FILE"
adb shell am force-stop "$PKG"
adb logcat -c
adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1
sleep 18
adb logcat -d > logcat3.txt || true
if grep -qE "Could not load encrypted Balance app state|Keystore unwrap failed|FATAL EXCEPTION" logcat3.txt; then
  echo "[database-recovery] restored wrapped key did not reopen the database."
  grep -iE "Could not load encrypted Balance app state|Keystore unwrap failed|FATAL EXCEPTION|recovery|keystore" logcat3.txt | head -20
  exit 1
fi
assert_running "database-recovery" logcat3.txt
echo "[database-recovery] original key and database reopened after the simulated failure."

# Optional diagnostic for intermittent startup stalls. It uses only this
# emulator's generated database and test key, then overlaps a deliberately slow
# native relay pass with the same native state read that gates the loading
# screen. DevTools measures command latency without UI Automator's comparatively
# slow and flaky WebView accessibility bridge.
if [ "${BALANCE_RUN_RESUME_STRESS:-0}" = 1 ]; then
  node .github/scripts/android-resume-stress.mjs
fi

# Optional synthetic profile for delayed Android devices. It creates an
# isolated relay and app database, queues more batches than one background pass
# is allowed to download, forces the real WorkManager job, then measures the
# foreground catch-up. No installed or personal data is read.
if [ "${BALANCE_RUN_SYNC_CATCHUP_PROFILE:-0}" = 1 ]; then
  node .github/scripts/android-sync-catchup-profile.mjs
fi

# The checks above are the deterministic release gate: a real APK booted twice,
# exercised SQLCipher + Android Keystore recovery, registered background sync,
# loaded the home-screen widget provider, and reconciled two synthetic encrypted databases.
# The remaining camera/WebView journey depends on Android's external
# accessibility dumper, which can wedge even while the app and emulator remain
# healthy. Keep it available for deliberate CI debugging without charging every
# tagged release for that flaky system harness.
if [ "${BALANCE_RUN_UI_PAIRING_E2E:-0}" != 1 ]; then
  echo "[ui-sync] optional camera/UI pairing journey skipped; core Android smoke checks passed."
  echo "App builds, launches, reopens its encrypted database, and passes native encrypted sync verification."
  exit 0
fi

# ---------------------------------------------------------------------------
# Real UI pairing test
# ---------------------------------------------------------------------------
# Install the same APK into a managed profile. Android gives the profile an
# independent UID, process, Keystore namespace, and app-data directory, so the
# two installations behave like separate phones while sharing the emulator's
# network. Drive the visible WebView with UI Automator: create primary data and
# a key, scan that key on the joining installation, connect both to a test
# HTTP relay, then assert the primary's
# user-visible goal appears on the joiner.

UI_XML=sync-e2e-ui.xml
E2E_ACTIVE=1

capture_e2e_diagnostics() {
  if [ "${E2E_ACTIVE:-0}" != 1 ]; then
    return
  fi
  ADB_TIMEOUT_SECONDS=10 adb logcat -d > logcat-sync-e2e.txt 2>/dev/null || true
  ADB_TIMEOUT_SECONDS=10 adb shell uiautomator dump --compressed /sdcard/sync-e2e-window.xml >/dev/null 2>&1 || true
  ADB_TIMEOUT_SECONDS=10 adb exec-out cat /sdcard/sync-e2e-window.xml > sync-e2e-window.xml 2>/dev/null || true
  ADB_TIMEOUT_SECONDS=10 adb exec-out screencap -p > sync-e2e-failure.png 2>/dev/null || true
}
trap capture_e2e_diagnostics EXIT

dump_ui() {
  tmp_xml="${UI_XML}.tmp"
  for attempt in $(seq 1 5); do
    if ADB_TIMEOUT_SECONDS=10 adb shell uiautomator dump --compressed /sdcard/sync-e2e-window.xml >/dev/null \
      && ADB_TIMEOUT_SECONDS=10 adb exec-out cat /sdcard/sync-e2e-window.xml > "$tmp_xml" 2>/dev/null \
      && grep -q '<hierarchy' "$tmp_xml"; then
      mv "$tmp_xml" "$UI_XML"
      return 0
    fi
    # Do not kill device-side accessibility processes here: that recovery can
    # destabilize the emulator itself. Retry only while the device is healthy.
    if ! ADB_TIMEOUT_SECONDS=5 adb get-state >/dev/null 2>&1; then
      echo "The emulator disappeared from ADB while dumping the UI."
      return 1
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
        # Chromium can expose a control that is only a few pixels visible at
        # the screen edge. Reject clipped controls so the caller scrolls them
        # fully onscreen instead of tapping a sliver that cannot take input.
        if x2 - x1 < 30 or y2 - y1 < 30:
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
    # Stay in the card's right gutter so color/range inputs cannot consume the
    # gesture instead of scrolling the Settings page.
    adb shell input swipe 300 580 300 180 300
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
    adb shell input swipe 300 580 300 180 300
    sleep 1
  done
  echo "Could not find UI node after scrolling: $attribute contains $query"
  return 1
}

tap_ui_class_after_text_scrolling() {
  anchor="$1"
  target_class="$2"
  scroll_strategy="${3:-300}"
  for _ in $(seq 1 8); do
    dump_ui
    point="$(find_ui_class_after_text "$anchor" "$target_class" 2>/dev/null || true)"
    if [ -n "$point" ]; then
      # shellcheck disable=SC2086
      adb shell input tap $point
      return 0
    fi
    if [ "$scroll_strategy" = "page" ]; then
      # WebView handles Page Down at its scroll container, so nested cards and
      # inputs cannot swallow the gesture before the field becomes visible.
      adb shell input keyevent KEYCODE_PAGE_DOWN
    else
      adb shell input swipe "$scroll_strategy" 580 "$scroll_strategy" 180 300
    fi
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
    adb shell input swipe 300 180 300 580 300
    sleep 1
  done
  echo "Could not find UI node after scrolling up: $attribute=$query"
  return 1
}

scroll_page_to_top() {
  # Use the page's left gutter so form controls and the bottom goal-rhythm
  # panel cannot consume the gesture. Several swipes make this deterministic
  # regardless of the scroll position inherited from Settings.
  for _ in $(seq 1 8); do
    adb shell input swipe 8 180 8 580 300
    sleep 0.25
  done
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

wait_for_ui_text_gone() {
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
raise SystemExit(1 if found else 0)
PY
    then
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for UI text to disappear: $query"
  return 1
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
  scroll_strategy="${3:-300}"
  tap_ui_class_after_text_scrolling "$anchor" "android.widget.EditText" "$scroll_strategy" || return 1
  adb shell input text "$value"
}

type_into_ui_after_text_verified() {
  local anchor="$1"
  local value="$2"
  local scroll_strategy="${3:-300}"
  local retry_index
  for retry_index in $(seq 1 3); do
    type_into_ui_after_text "$anchor" "$value" "$scroll_strategy" || return 1
    if wait_for_ui_text "$value" 3; then
      return 0
    fi
    echo "Text injection for $anchor did not stick (attempt $retry_index); retrying."
    # Bring the label back into view before locating its input again. This also
    # recovers when a clipped field at the top edge consumed no injected text.
    scroll_page_to_top
  done
  echo "Could not enter $value after text=$anchor"
  return 1
}

dismiss_soft_keyboard() {
  # Escape dismisses an open IME without navigating away from Balance when
  # `adb input text` used the hardware-input path and no keyboard was opened.
  # Back cannot be used safely here: Android's input-method service can retain
  # stale "shown" state, causing Back to close the app instead.
  adb shell input keyevent KEYCODE_ESCAPE || true
  sleep 1
}

dismiss_recovery_key_setup() {
  # The Rust process can be ready several seconds before the WebView finishes
  # rendering this first-run dialog, especially after an emulator/GMS restart.
  for _ in $(seq 1 30); do
    dump_ui
    if [ -n "$(find_ui_node text "Save your recovery key" exact)" ]; then
      if [ -n "$(find_ui_node resource-id "recovery-key-confirmation" exact)" ]; then
        # Exercise the current confirmation flow with the synthetic key while
        # keeping the key out of the workflow log and test artifacts.
        tap_ui text "Copy key"
        tap_ui resource-id "recovery-key-confirmation"
        adb shell input keyevent KEYCODE_PASTE
      else
        # Older APK fixtures used an acknowledgement checkbox instead.
        tap_ui class "android.widget.CheckBox"
      fi
      # Enabling Continue is asynchronous in the WebView. tap_ui ignores
      # disabled nodes, so it waits for the confirmed state to render first.
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

open_mobile_view() {
  local view_name="$1"
  # Settings is a long document and the mobile header scrolls with it. Return
  # to the top before opening the drawer so the menu button is actually visible.
  scroll_page_to_top
  tap_ui text "Open navigation"
  tap_ui text "$view_name"
}

PAIRING_CODE="$(tr -d '\r\n' < sync-e2e-pairing-code.txt)"
if [[ "$PAIRING_CODE" != BALSYNC1:* ]]; then
  echo "The camera fixture did not contain a Balance pairing code."
  exit 1
fi

# This relay and its credential exist only for this synthetic CI fixture.
UI_RELAY_SECRET="$(openssl rand -hex 24)"
BALANCE_RELAY_SECRET="$UI_RELAY_SECRET" node scripts/relay-server.mjs 8791 > sync-e2e-relay.log 2>&1 &
UI_RELAY_PID=$!
trap 'capture_e2e_diagnostics; kill "$UI_RELAY_PID" 2>/dev/null || true' EXIT
adb reverse tcp:8791 tcp:8791
UI_RELAY_URL="http://127.0.0.1:8791/$UI_RELAY_SECRET"
for _ in $(seq 1 30); do
  if curl --fail --silent "$UI_RELAY_URL/v3/manifest" >/dev/null; then break; fi
  sleep 1
done
curl --fail --silent "$UI_RELAY_URL/v3/manifest" >/dev/null

echo "[ui-sync] enabling the source installation with the camera fixture key"
dismiss_recovery_key_setup
open_mobile_view "Settings"
tap_ui_scrolling_contains text "Connect to an existing setup"
type_into_ui_after_text "Sync server address" "$UI_RELAY_URL"
type_into_ui_after_text "Pairing code" "$PAIRING_CODE"
dismiss_soft_keyboard
tap_ui_scrolling text "Continue"
wait_for_ui_text "Use your existing synced planner?"
tap_ui_scrolling text "Connect and replace this planner"
wait_for_ui_text "Connected. This device now syncs automatically." 30

echo "[ui-sync] creating recognizable data on the source installation"
open_mobile_view "Goals"
wait_for_ui_text "Add a goal"
# A goal requires both a name and at least one matching phrase. Fill the real
# fields and press the visible Add button so seeing the name afterward proves a
# persisted goal card exists (rather than merely seeing text in an input).
scroll_page_to_top
type_into_ui_after_text_verified "NAME" "CISyncGoal" page
dismiss_soft_keyboard
type_into_ui_after_text_verified "MATCHES ANY" "ci-sync" page
dismiss_soft_keyboard
goal_created=0
for submit_attempt in $(seq 1 3); do
  tap_ui_scrolling text "Add goal"
  if wait_for_ui_text_gone "No goals yet" 5; then
    goal_created=1
    break
  fi
  echo "Goal submission did not persist (attempt $submit_attempt); retrying."
done
if [ "$goal_created" != 1 ]; then
  echo "The source goal was not created after retries."
  exit 1
fi
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
open_mobile_view "Settings"
tap_ui_scrolling_contains text "Connect to an existing setup"
type_into_ui_after_text "Sync server address" "$UI_RELAY_URL"
dismiss_soft_keyboard
tap_ui_scrolling text "Scan QR code"
wait_for_ui_text "Use your existing synced planner?" 30
tap_ui_scrolling text "Connect and replace this planner"
wait_for_ui_text "Connected. This device now syncs automatically." 30
echo "[ui-sync] camera QR scan connected the isolated joining installation through the relay"

# A successful sync rehydrates the frontend from the joining profile's encrypted
# database. The primary-only goal must now be present in that materialized state.
open_mobile_view "Goals"
wait_for_ui_text "CISyncGoal" 30
echo "[ui-sync] PASS: camera QR pairing transferred source user data to the isolated joiner"

E2E_ACTIVE=0
kill "$UI_RELAY_PID" 2>/dev/null || true
trap - EXIT
adb logcat -d > logcat-sync-e2e.txt 2>/dev/null || true

echo "App builds, launches, reopens its encrypted database, scans a real QR camera frame, and syncs two isolated Android installations."
