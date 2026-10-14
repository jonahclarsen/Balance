#!/usr/bin/env bash
# Only for the disposable AOSP CI emulator, before Balance is installed.
set -euo pipefail
test "$(adb shell getprop ro.kernel.qemu | tr -d '\r')" = 1
ci_webview_path="$(adb shell pm path com.android.webview | tr -d '\r' | sed -n 's/^package://p' | head -n 1)"
case "$ci_webview_path" in
  /system/*.apk|/product/*.apk) ;;
  *) echo "Unexpected preinstalled WebView path"; exit 1 ;;
esac
wait_for_boot() {
  timeout 120s adb wait-for-device
  for attempt in $(seq 1 90); do
    if [[ "$(adb shell getprop sys.boot_completed | tr -d '\r')" == 1 ]]; then return; fi
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
