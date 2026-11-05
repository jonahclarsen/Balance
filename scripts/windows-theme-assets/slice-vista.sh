#!/usr/bin/env bash
# Slices the original Windows Vista RTM (6.0.6000) aero.msstyles images into theme assets.
#   AERO   directory of IMAGE resources dumped from aero.msstyles (<id>.png)
#   OUT    public/themes/windowsvista/ui
# Image IDs, frame counts and 9-grid margins come from the theme's VARIANT and CMAP tables.
# aero.msstyles stores premultiplied alpha, so every frame is converted to straight alpha.
# See docs/windows-theme-assets.json for provenance.
set -euo pipefail
AERO=$1; OUT=$2
mkdir -p "$OUT"

straight() { magick "$1" -channel RGB -fx 'a>0?u/a:0' +channel "PNG32:$2"; }
# frame <id> <frame height> <index> <out>
frame() { magick "$AERO/$1.png" -crop "x$2+0+$(( $2 * $3 ))" +repage -channel RGB -fx 'a>0?u/a:0' +channel "PNG32:$4"; }

n=0; for s in normal hot pressed disabled default; do frame 515 23 $n "$OUT/button-$s.png"; n=$((n+1)); done
straight "$AERO/508.png" "$OUT/check.png"
straight "$AERO/516.png" "$OUT/radio.png"
straight "$AERO/514.png" "$OUT/groupbox.png"

# Glossy read-only combo face and its arrow; edit borders.
n=0; for s in normal hot pressed disabled; do
  frame 524 21 $n "$OUT/combo-$s.png"
  # The stretched centre of the face, painted under the arrow.
  magick "$OUT/combo-$s.png" -crop 1x13+5+4 +repage "PNG32:$OUT/combo-fill-$s.png"
  n=$((n+1))
done
frame 520 19 0 "$OUT/combo-glyph.png"
n=0; for s in normal hot focus disabled; do frame 526 5 $n "$OUT/edit-$s.png"; n=$((n+1)); done

# Scrollbar. 20 arrow frames: up, down, left, right × normal, hot, pressed, disabled, then 4 bar-hover.
rows=()
for i in $(seq 0 19); do
  magick \( "$AERO/666.png" -crop "x17+0+$((i * 17))" +repage -channel RGB -fx 'a>0?u/a:0' +channel \) \
    \( "$AERO/667.png" -crop "x13+0+$((i * 13))" +repage -channel RGB -fx 'a>0?u/a:0' +channel \) \
    -gravity center -composite "PNG32:$OUT/sa.$i.png"
  rows+=("$OUT/sa.$i.png")
done
cp "$OUT/sa.0.png" "$OUT/scroll-up.png"; cp "$OUT/sa.4.png" "$OUT/scroll-down.png"; cp "$OUT/sa.8.png" "$OUT/scroll-left.png"; cp "$OUT/sa.12.png" "$OUT/scroll-right.png"
rm -f "${rows[@]}"
n=0; for s in normal hot pressed; do
  frame 678 22 $n "$OUT/scroll-thumb-v-$s.png"
  frame 677 17 $n "$OUT/scroll-thumb-h-$s.png"
  frame 671 10 $n "$OUT/scroll-grip-v-$s.png"
  frame 669 9 $n "$OUT/scroll-grip-h-$s.png"
  magick "$OUT/scroll-thumb-v-$s.png" -gravity center -crop 1x1+0+0 +repage "PNG32:$OUT/scroll-fill-v-$s.png"
  magick "$OUT/scroll-thumb-h-$s.png" -gravity center -crop 1x1+0+0 +repage "PNG32:$OUT/scroll-fill-h-$s.png"
  n=$((n+1))
done
frame 674 1 0 "$OUT/scroll-track-v.png"
frame 673 8 0 "$OUT/scroll-track-h.png"

# Explorer's list selection frames: 7 × 74 with 3px margins.
straight "$AERO/565.png" "$OUT/select.png"
straight "$AERO/566.png" "$OUT/select-hot.png"
straight "$AERO/567.png" "$OUT/select-hot-selected.png"
straight "$AERO/568.png" "$OUT/select-unfocused.png"

# Containers and toolbars.
n=0; for s in normal hot pressed; do frame 551 24 $n "$OUT/header-$s.png"; n=$((n+1)); done
frame 559 24 0 "$OUT/header-bg.png"
n=0; for s in normal hot selected; do frame 730 19 $n "$OUT/tab-$s.png"; n=$((n+1)); done
straight "$AERO/725.png" "$OUT/tab-pane.png"
n=0; for s in normal hot pressed disabled checked; do frame 745 26 $n "$OUT/toolbar-$s.png"; n=$((n+1)); done
straight "$AERO/642.png" "$OUT/gripper.png"
straight "$AERO/804.png" "$OUT/tree.png"
straight "$AERO/807.png" "$OUT/tree-arrow.png"
straight "$AERO/810.png" "$OUT/tree-arrow-hot.png"
straight "$AERO/618.png" "$OUT/progress-track.png"
straight "$AERO/626.png" "$OUT/progress-fill.png"
frame 771 11 0 "$OUT/tooltip.png"
straight "$AERO/803.png" "$OUT/slider-track.png"
straight "$AERO/790.png" "$OUT/slider-thumb.png"

# Explorer's command bar and details pane; the glow behind glass caption text; Back and Forward.
# Its centre column only; the outer columns are the band's ends.
magick "$AERO/775.png" -crop 1x31+1+0 +repage -channel RGB -fx 'a>0?u/a:0' +channel "PNG32:$OUT/command-bg.png"
n=0; for s in hot pressed; do frame 776 26 $((n+1)) "$OUT/command-$s.png"; n=$((n+1)); done
straight "$AERO/917.png" "$OUT/text-glow.png"
straight "$AERO/784.png" "$OUT/details-bg.png"
straight "$AERO/933.png" "$OUT/nav-back.png"
straight "$AERO/935.png" "$OUT/nav-forward.png"

# Menus.
straight "$AERO/851.png" "$OUT/menu-gutter.png"
n=0; for s in hot; do frame 852 19 $n "$OUT/menu-$s.png"; n=$((n+1)); done
straight "$AERO/855.png" "$OUT/menu-check.png"

# Caption bevels and glyphs at 96 dpi: 8 frames, normal/hot/pressed/disabled × active/inactive.
n=0; for s in normal hot pressed disabled; do
  frame 815 15 $n "$OUT/caption-close-$s.png"
  frame 816 13 $n "$OUT/glyph-close-$s.png"
  frame 826 15 $n "$OUT/caption-max-$s.png"
  frame 827 13 $n "$OUT/glyph-max-$s.png"
  frame 840 13 $n "$OUT/glyph-restore-$s.png"
  frame 835 15 $n "$OUT/caption-min-$s.png"
  frame 836 13 $n "$OUT/glyph-min-$s.png"
  n=$((n+1))
done
frame 815 15 4 "$OUT/caption-close-inactive.png"
frame 826 15 4 "$OUT/caption-max-inactive.png"
frame 835 15 4 "$OUT/caption-min-inactive.png"
