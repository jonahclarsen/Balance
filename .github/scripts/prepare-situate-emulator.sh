#!/usr/bin/env bash
# Retry corrupt SDK/CDN downloads on disposable hosted CI runners only.
set -euo pipefail
[[ "${CI:-}" == true && "${GITHUB_ACTIONS:-}" == true ]] || exit 1
api=${1:?Android API required}
[[ "$api" =~ ^[0-9]+$ ]] || exit 1
sdk=${ANDROID_HOME:?}
manager="$sdk/cmdline-tools/latest/bin/sdkmanager"
version=$api
[[ "$api" != 37 ]] || version=37.0
target=${2:-google_apis}
[[ "$target" == google_apis || "$target" == google_apis_ps16k ]] || exit 1
image="system-images;android-$version;$target;x86_64"
"$manager" --licenses < <(yes) >/dev/null
for attempt in 1 2 3; do
  if "$manager" --install emulator "$image" &&
      [[ -x "$sdk/emulator/emulator" && -f "$sdk/system-images/android-$version/$target/x86_64/system.img" ]]; then
    exit 0
  fi
  echo "SDK download attempt $attempt failed; discarding incomplete temporary downloads"
  rm -rf "$sdk/.temp"
  sleep 5
done
echo 'Android SDK downloads failed after three attempts'
exit 1
