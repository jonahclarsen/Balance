#!/usr/bin/env bash
# Extract measured results even when cargo fails; never turn a failed gate green.
set -euo pipefail

results_directory="${1:?usage: profile-native-theme.sh OUTPUT_DIRECTORY [TEST_NAME]}"
profile_test="${2:-tests::theme_state_performance_profile}"
mkdir -p "$results_directory"

set +e
cargo test --manifest-path src-tauri/Cargo.toml \
  "$profile_test" -- --exact --ignored --nocapture \
  2>&1 | tee "$results_directory/theme-native-performance.log"
pipeline_status=("${PIPESTATUS[@]}")
set -e

extraction_status=0
sed -n 's/^.*THEME_NATIVE_PERF //p' "$results_directory/theme-native-performance.log" \
  > "$results_directory/theme-native-performance.json" || extraction_status=$?

if (( pipeline_status[0] != 0 )); then
  exit "${pipeline_status[0]}"
fi
if (( pipeline_status[1] != 0 )); then
  exit "${pipeline_status[1]}"
fi
if (( extraction_status != 0 )); then
  exit "$extraction_status"
fi
test -s "$results_directory/theme-native-performance.json"
