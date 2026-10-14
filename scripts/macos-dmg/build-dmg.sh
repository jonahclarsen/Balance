#!/usr/bin/env bash
# Packages Balance.app into the drag-to-Applications disk image.
# dmgbuild writes Finder's layout directly, so no Finder session is needed.
# Usage: scripts/macos-dmg/build-dmg.sh path/to/Balance.app out.dmg
set -euo pipefail

APP_PATH="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
DMG_PATH="$2"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../.."
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

python3 -m venv "$WORK/venv"
"$WORK/venv/bin/python3" -m pip install --quiet --disable-pip-version-check \
  --require-hashes --only-binary=:all: -r "$HERE/requirements.txt"

swift "$HERE/draw-background.swift" "$ROOT/website/public/assets/logo.png" "$WORK/background.tiff"

# The background's arrow and tile are drawn around these icon positions.
cat > "$WORK/settings.json" <<JSON
{
  "format": "UDZO",
  "filesystem": "HFS+",
  "files": ["$APP_PATH"],
  "symlinks": {"Applications": "/Applications"},
  "hide_extensions": ["Balance.app"],
  "icon": "$ROOT/src-tauri/icons/icon.icns",
  "background": "$WORK/background.tiff",
  "window_rect": [[200, 160], [680, 440]],
  "icon_locations": {"Balance.app": [200, 252], "Applications": [480, 252]},
  "icon_size": 96,
  "text_size": 13,
  "default_view": "icon-view",
  "arrange_by": null,
  "show_toolbar": false,
  "show_sidebar": false,
  "show_status_bar": false,
  "show_pathbar": false,
  "show_tab_view": false
}
JSON

rm -f "$DMG_PATH"
"$WORK/venv/bin/python3" - "$DMG_PATH" "$WORK/settings.json" <<'PY'
import json
import sys

import dmgbuild

with open(sys.argv[2], encoding="utf-8") as settings_file:
    settings = json.load(settings_file)
dmgbuild.build_dmg(sys.argv[1], "Balance", settings=settings)
PY
hdiutil verify "$DMG_PATH"
