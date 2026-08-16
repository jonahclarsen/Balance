#!/bin/sh
set -eu

if [ "${1:-}" = "run" ]; then
  script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
  development_runner="$script_directory/run-macos-dev-app.sh"

  CARGO_TARGET_AARCH64_APPLE_DARWIN_RUNNER="$development_runner" \
  CARGO_TARGET_X86_64_APPLE_DARWIN_RUNNER="$development_runner" \
    exec cargo "$@"
fi

exec cargo "$@"
