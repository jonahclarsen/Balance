#!/usr/bin/env bash
# Only for the disposable AOSP CI emulator, before Balance is installed.
set -euo pipefail
test "$(adb shell getprop ro.kernel.qemu | tr -d '\r')" = 1
ci_webview_path="$(adb shell pm path com.android.webview | tr -d '\r' | sed -n 's/^package://p' | head -n 1)"
case "$ci_webview_path" in
  /system/*.apk|/product/*.apk) ;;
  *) echo "Unexpected preinstalled WebView path"; exit 1 ;;
esac
# On hosted runners the lavapipe emulator process sometimes exits during a
# guest reboot (its console port closes and the device never returns). The
# system and data images keep this script's changes, so start it again.
emulator_relaunches=0
emulator_running() { (exec 3<>/dev/tcp/127.0.0.1/5554) 2>/dev/null; }
relaunch_emulator() {
  if (( emulator_relaunches >= 2 )) || [[ -z "${BALANCE_EMULATOR_OPTIONS:-}" ]]; then
    echo "Emulator exited while rebooting"; exit 1
  fi
  emulator_relaunches=$((emulator_relaunches + 1))
  echo "Emulator exited while rebooting; relaunching it (attempt $emulator_relaunches)."
  # shellcheck disable=SC2086 # the options are a word list
  setsid nohup "$ANDROID_HOME/emulator/emulator" -port 5554 -avd "${BALANCE_AVD_NAME:-test}" \
    $BALANCE_EMULATOR_OPTIONS > "emulator-relaunch-$emulator_relaunches.log" 2>&1 < /dev/null &
}
wait_for_boot() {
  for attempt in $(seq 1 120); do
    if [[ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == 1 ]]; then return; fi
    # Give a reboot a few seconds to drop the console before checking it.
    if (( attempt > 5 )) && ! emulator_running; then relaunch_emulator; fi
    sleep 2
  done
  echo "Emulator did not finish rebooting"; exit 1
}
adb root
adb disable-verity
adb reboot
wait_for_boot
adb root
adb remount
adb shell rm -f "$ci_webview_path"
# ActivityManager reads this setting during boot. Merely writing the setting
# after boot does not update its in-memory flag on all tested Android versions.
if [[ "${BALANCE_LIFECYCLE_SCENARIO:-}" == activity ]]; then
  adb shell settings put global always_finish_activities 1
  # SettingsProvider persists asynchronously; an immediate reboot can lose it.
  sleep 3
  adb shell sync
fi
adb reboot
wait_for_boot
if [[ "${BALANCE_LIFECYCLE_SCENARIO:-}" == activity ]]; then
  test "$(adb shell settings get global always_finish_activities | tr -d '\r')" = 1
fi
adb install -r ci-webview.apk
adb shell cmd webviewupdate set-webview-implementation com.android.webview
adb shell dumpsys webviewupdate
adb shell input keyevent KEYCODE_WAKEUP
adb shell wm dismiss-keyguard
