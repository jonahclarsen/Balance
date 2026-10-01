#!/bin/sh
set -eu

if [ "$#" -lt 1 ]; then
  echo "usage: run-macos-dev-app.sh <executable> [arguments...]" >&2
  exit 64
fi

source_executable=$1
shift

if [ ! -f "$source_executable" ] || [ ! -x "$source_executable" ]; then
  echo "macOS dev app runner: executable not found: $source_executable" >&2
  exit 66
fi

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
build_directory=$(CDPATH= cd -- "$(dirname -- "$source_executable")" && pwd)
bridge_source="$script_directory/../src-tauri/macos/BalanceWidgetDevBridge.swift"
notification_source="$script_directory/../src-tauri/macos/TaskNotificationBridge.swift"
bridge_info="$script_directory/../src-tauri/macos/BalanceWidgetDevBridgeInfo.plist"
bridge_app="$build_directory/BalanceWidgetDevBridge.app"
bridge_executable="$bridge_app/Contents/MacOS/BalanceWidgetDevBridge"
bridge_runtime_directory=$(mktemp -d /tmp/balance-dev-bridge.XXXXXX)
ready_file="$bridge_runtime_directory/ready"
export BALANCE_DEV_NOTIFICATION_SOCKET="$bridge_runtime_directory/notifications.sock"
trap 'rm -f "$ready_file" "$BALANCE_DEV_NOTIFICATION_SOCKET"; rmdir "$bridge_runtime_directory" 2>/dev/null || true' EXIT

# The full Tauri process is rejected by WidgetKit even from an app-shaped path.
# Keep one tiny valid app process alive for widget reloads and OS reminders.
# Widget reload notifications carry no payload; reminders use a private socket.
if [ ! -x "$bridge_executable" ] || [ "$bridge_source" -nt "$bridge_executable" ] || [ "$notification_source" -nt "$bridge_executable" ] || [ "$bridge_info" -nt "$bridge_executable" ]; then
  architecture=$(uname -m)
  mkdir -p "$bridge_app/Contents/MacOS"
  cp "$bridge_info" "$bridge_app/Contents/Info.plist"
  xcrun swiftc -parse-as-library -O -target "$architecture-apple-macosx13.0" -framework WidgetKit -framework UserNotifications \
    "$bridge_source" "$notification_source" -o "$bridge_executable"
fi

rm -f "$ready_file"
"$bridge_executable" "$$" "$ready_file" "$BALANCE_DEV_NOTIFICATION_SOCKET" &
bridge_process_identifier=$!

attempt=0
while [ ! -f "$ready_file" ] && [ "$attempt" -lt 100 ]; do
  if ! kill -0 "$bridge_process_identifier" 2>/dev/null; then
    echo "macOS dev app runner: widget bridge exited before becoming ready" >&2
    exit 70
  fi
  attempt=$((attempt + 1))
  sleep 0.01
done

if [ ! -f "$ready_file" ]; then
  kill "$bridge_process_identifier" 2>/dev/null || true
  echo "macOS dev app runner: timed out waiting for widget bridge" >&2
  exit 70
fi

rm -f "$ready_file"

# WidgetKit needs the helper to present the production app's bundle identity,
# but launching that app-shaped helper also makes Launch Services register it as
# another app.balance.local owner. That can make Shortcuts resolve Balance's
# App Intent against the helper (which has no intent metadata). Keep the helper
# running, remove only its registration, and make the installed app canonical.
launch_services_register=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
if [ -x "$launch_services_register" ]; then
  "$launch_services_register" -u "$bridge_app" >/dev/null 2>&1 || true
  if [ -d /Applications/Balance.app ]; then
    "$launch_services_register" -f /Applications/Balance.app >/dev/null 2>&1 || true
  fi
fi

exec "$source_executable" "$@"
