#!/usr/bin/env bash
# Converts captured PNGs to the WebP images the site serves.
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p website/public/images
for png in artifacts/site-shots/*.png; do
  name="$(basename "$png" .png)"
  case "$name" in
    mac-*) cwebp -quiet -q 82 -resize 1920 0 "$png" -o "website/public/images/$name.webp" ;;
    *) cwebp -quiet -q 82 -resize 720 0 "$png" -o "website/public/images/$name.webp" ;;
  esac
done
