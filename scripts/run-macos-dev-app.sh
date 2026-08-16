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
app_bundle="$build_directory/BalanceDev.app"
app_executable="$app_bundle/Contents/MacOS/Balance"

mkdir -p "$app_bundle/Contents/MacOS"
cp "$script_directory/../src-tauri/macos/BalanceDevInfo.plist" \
  "$app_bundle/Contents/Info.plist"

# WidgetKit associates WidgetCenter calls with the caller's containing app.
# A symlink still resolves as the raw Cargo binary, so use a physical hard link.
# Replacing this link is only a few milliseconds on APFS and preserves the
# compiled binary's existing ad-hoc signature without signing the outer shell.
rm -f "$app_executable"
ln "$source_executable" "$app_executable"

exec "$app_executable" "$@"
