#!/usr/bin/env bash
# Attaches the notarized Mac app to a nightly release. Nightly tags build
# Android and macOS in separate workflows, and both call this when they
# finish: whichever runs second finds the other's result and uploads.
# Android creates the release before calling this, and macOS calls it only
# after its build job succeeded, so one of the two always sees both.
set -euo pipefail

: "${RELEASE_TAG:?}" "${RELEASE_SHA:?}" "${GITHUB_REPOSITORY:?}"

run_id="${MACOS_RUN_ID:-}"
if [[ -z "$run_id" ]]; then
  run_id="$(gh run list \
    --repo "$GITHUB_REPOSITORY" \
    --workflow macos-arm64.yml \
    --commit "$RELEASE_SHA" \
    --event workflow_dispatch \
    --limit 20 \
    --json databaseId,headBranch,createdAt \
    --jq "map(select(.headBranch == \"$RELEASE_TAG\")) | sort_by(.createdAt) | last | .databaseId // empty")"
fi
if [[ -z "$run_id" ]]; then
  echo "No macOS build ran for $RELEASE_TAG"
  exit 0
fi

build_result="$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$run_id/jobs" \
  --jq '.jobs[] | select(.name == "Build and notarize .app") | .conclusion // "pending"')"
if [[ "$build_result" != "success" ]]; then
  echo "macOS run $run_id build is $build_result; not attaching it"
  exit 0
fi

is_draft="$(gh release view "$RELEASE_TAG" --repo "$GITHUB_REPOSITORY" --json isDraft --jq .isDraft 2>/dev/null || true)"
if [[ "$is_draft" != "false" ]]; then
  echo "$RELEASE_TAG is not published yet; Android attaches the Mac app when it publishes"
  exit 0
fi

dir="$(mktemp -d)"
gh run download "$run_id" --repo "$GITHUB_REPOSITORY" --name Balance-macos-arm64 --dir "$dir"
test -f "$dir/Balance-macos-arm64.dmg"
gh release upload "$RELEASE_TAG" "$dir/Balance-macos-arm64.dmg" --repo "$GITHUB_REPOSITORY" --clobber
echo "Attached the Mac app from run $run_id to $RELEASE_TAG"
