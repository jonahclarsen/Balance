#!/usr/bin/env bash
# Build the cr-sqlite (Superfly fork) extension for Balance's multi-device sync.
#
#   * Desktop (macOS/Linux/Windows): a runtime-loadable extension
#     (crsqlite.dylib/.so/.dll), bundled as a Tauri resource and loaded with
#     rusqlite's load_extension (see src-tauri/src/sync/load_extension).
#   * Android: a static library per ABI (libcrsql_bundle_static.a) to be linked
#     into the app, because runtime extension loading is fragile on Android.
#     This path needs NO Android NDK — it is pure `cargo build` against the
#     installed rust std for the target.
#
# All commands here are verified working. Outputs land in src-tauri/resources/
# (desktop) and src-tauri/resources/android/<abi>/ (static libs).
set -euo pipefail

# Pinned to a known-good Superfly fork commit + the repo's pinned nightly.
CRSQLITE_REPO="https://github.com/superfly/cr-sqlite.git"
CRSQLITE_REF="${CRSQLITE_REF:-3133cacac0177ff11a2022a5ebd08f17749559f5}"
NIGHTLY="nightly-2023-10-05"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RES="$ROOT/src-tauri/resources"
WORK="${CRSQLITE_WORK:-$ROOT/.crsqlite-build}"

mkdir -p "$RES"

# --- Fetch source (shallow, with the sqlite-rs-embedded submodule) -----------
if [ ! -d "$WORK/cr-sqlite" ]; then
  mkdir -p "$WORK"
  git clone "$CRSQLITE_REPO" "$WORK/cr-sqlite"
fi
cd "$WORK/cr-sqlite"
git fetch --depth 1 origin "$CRSQLITE_REF" || true
git checkout "$CRSQLITE_REF"
# The sqlite-rs-embedded submodule is pinned with an SSH URL (git@github.com:),
# which CI runners can't authenticate. Rewrite SSH GitHub URLs to HTTPS so it
# clones anonymously: edit .gitmodules + sync the recorded URLs, and also pass
# the rewrite inline with -c so it propagates to any nested submodule clones.
if [ -f .gitmodules ]; then
  sed -i.bak 's#git@github.com:#https://github.com/#g' .gitmodules
  rm -f .gitmodules.bak
  git submodule sync --recursive
fi
git -c url."https://github.com/".insteadOf="git@github.com:" \
    submodule update --init --recursive

# --- Toolchain ---------------------------------------------------------------
rustup toolchain install "$NIGHTLY" --component rust-src --profile minimal
COMMIT_SHA="$(git rev-parse HEAD)"

build_android() {
  local triple="$1" abi="$2"
  rustup target add "$triple" --toolchain "$NIGHTLY"
  ( cd core/rs/bundle_static
    CRSQLITE_COMMIT_SHA="$COMMIT_SHA" \
      cargo +"$NIGHTLY" build --release --features static --target "$triple" )
  mkdir -p "$RES/android/$abi"
  cp "core/rs/bundle_static/target/$triple/release/libcrsql_bundle_static.a" \
     "$RES/android/$abi/"
  echo "built android $abi static lib"
}

case "${1:-all}" in
  desktop|all)
    ( cd core && make loadable )
    # macOS dylib / Linux .so / Windows dll all land as crsqlite.<ext>.
    cp core/dist/crsqlite.* "$RES/" 2>/dev/null || true
    echo "built desktop loadable extension"
    ;;
esac

case "${1:-all}" in
  android|all)
    build_android aarch64-linux-android arm64-v8a
    build_android x86_64-linux-android  x86_64
    ;;
esac

echo "done. artifacts in $RES"
