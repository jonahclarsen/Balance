#!/usr/bin/env bash
# Slices the original Windows XP SP3 visual-style bitmaps into theme assets.
#   LUNA   directory of bitmaps dumped from luna.msstyles (BLUE_*_BMP.bmp)
#   SHELL  directory of bitmaps dumped from the Blue shellstyle.dll (blue_ss.dll)
#   OUT    public/themes/windowsxp/ui
# Frame order and 9-grid margins come from the theme's own NORMALBLUE_INI.
# See docs/windows-theme-assets.json for provenance.
set -euo pipefail
LUNA=$1; SHELL_BMP=$2; OUT=$3; PREFIX=${4:-BLUE}
mkdir -p "$OUT"

# frame <source> <frame height> <index>: one frame, magenta keyed out.
frame() { magick "$LUNA/${PREFIX}_$1_BMP.bmp" -crop "x$2+0+$(( $2 * $3 ))" +repage -alpha set -transparent '#ff00ff' "PNG32:$4"; }
whole() { magick "$1" -alpha set -transparent '#ff00ff' "PNG32:$2"; }
h() { magick identify -format '%h' "$LUNA/${PREFIX}_$1_BMP.bmp"; }

n=0; for s in normal hot pressed disabled default; do frame BUTTON 23 $n "$OUT/button-$s.png"; n=$((n+1)); done
whole "$LUNA/${PREFIX}_CHECKBOX13_BMP.bmp" "$OUT/check.png"
whole "$LUNA/${PREFIX}_RADIOBUTTON13_BMP.bmp" "$OUT/radio.png"

# Caption and frame edges, active window only.
fh=$(( $(h FRAMECAPTION) / 2 )); frame FRAMECAPTION $fh 0 "$OUT/caption.png"
frame FRAMECAPTION $fh 1 "$OUT/caption-inactive.png"
fh=$(( $(h SMALLFRAMECAPTION) / 2 )); frame SMALLFRAMECAPTION $fh 0 "$OUT/caption-small.png"
fl=$(( $(h FRAMELEFT) / 2 )); frame FRAMELEFT $fl 0 "$OUT/frame-left.png"
fr=$(( $(h FRAMERIGHT) / 2 )); frame FRAMERIGHT $fr 0 "$OUT/frame-right.png"
fb=$(( $(h FRAMEBOTTOM) / 2 )); frame FRAMEBOTTOM $fb 0 "$OUT/frame-bottom.png"
# One 9-grid of the three edges for border-image: a 5px left and right, a 5px bottom.
fbw=$(magick identify -format '%w' "$OUT/frame-bottom.png")
magick \( \( "$OUT/frame-left.png" -crop 5x5+0+0 +repage \) -size "$((fbw - 10))x5" xc:none \( "$OUT/frame-right.png" -crop 5x5+0+0 +repage \) +append \) \
  "$OUT/frame-bottom.png" -append "PNG32:$OUT/frame.png"

# Caption buttons: Windows paints the glyph over the bevel, so bake both.
caption_btn() { # <bevel> <glyph> <out>
  local rows=() i
  for i in 0 1 2 3; do
    magick \( "$LUNA/${PREFIX}_$1_BMP.bmp" -crop "x21+0+$((i * 21))" +repage -alpha set -transparent '#ff00ff' \) \
      \( "$LUNA/${PREFIX}_$2_BMP.bmp" -crop "x$(( $(h "$2") / 8 ))+0+$((i * $(h "$2") / 8))" +repage -alpha set -transparent '#ff00ff' \) \
      -gravity center -composite "PNG32:$3.$i.png"
    rows+=("$3.$i.png")
  done
  magick "${rows[@]}" -append "PNG32:$3"; rm -f "${rows[@]}"
}
caption_btn CLOSEBUTTON CLOSEGLYPH "$OUT/caption-close.png"
caption_btn CAPTIONBUTTON MINIMIZEGLYPH "$OUT/caption-min.png"
caption_btn CAPTIONBUTTON MAXIMIZEGLYPH "$OUT/caption-max.png"
caption_btn CAPTIONBUTTON RESTOREGLYPH "$OUT/caption-restore.png"

# Combo arrow bevel + glyph, in the four native states.
cb=$(( $(h COMBOBUTTON) / 4 )); gb=$(( $(h COMBOBUTTONGLYPH) / 4 )); rows=()
for i in 0 1 2 3; do
  magick \( "$LUNA/${PREFIX}_COMBOBUTTON_BMP.bmp" -crop "x$cb+0+$((i * cb))" +repage -alpha set -transparent '#ff00ff' \) \
    \( "$LUNA/${PREFIX}_COMBOBUTTONGLYPH_BMP.bmp" -crop "x$gb+0+$((i * gb))" +repage -alpha set -transparent '#ff00ff' \) \
    -gravity center -composite "PNG32:$OUT/combo.$i.png"
  rows+=("$OUT/combo.$i.png")
done
magick "${rows[@]}" -append "PNG32:$OUT/combo.png"; rm -f "${rows[@]}"
# Windows stretches that bevel to the 19px inside of a standard 21px combo (3px margins).
rows=()
for i in 0 1 2 3; do
  y=$((i * cb))
  magick \( "$OUT/combo.png" -crop "15x3+0+$y" +repage \) \( "$OUT/combo.png" -crop "15x$((cb - 6))+0+$((y + 3))" +repage -filter point -resize '15x13!' \) \
    \( "$OUT/combo.png" -crop "15x3+0+$((y + cb - 3))" +repage \) -append "PNG32:$OUT/combo.$i.png"
  rows+=("$OUT/combo.$i.png")
done
magick "${rows[@]}" -append "PNG32:$OUT/combo.png"; rm -f "${rows[@]}"

# Scrollbar. The arrow sheet has 16 frames: up, down, left, right × normal, hot, pressed, disabled.
ah=$(( $(h SCROLLARROWS) / 16 )); gh=$(( $(h SCROLLARROWGLYPHS) / 16 )); rows=()
for i in $(seq 0 15); do
  magick \( "$LUNA/${PREFIX}_SCROLLARROWS_BMP.bmp" -crop "x$ah+0+$((i * ah))" +repage -alpha set -transparent '#ff00ff' \) \
    \( "$LUNA/${PREFIX}_SCROLLARROWGLYPHS_BMP.bmp" -crop "x$gh+0+$((i * gh))" +repage -alpha set -transparent '#ff00ff' \) \
    -gravity center -composite "PNG32:$OUT/sa.$i.png"
  rows+=("$OUT/sa.$i.png")
done
cp "$OUT/sa.0.png" "$OUT/scroll-up.png"; cp "$OUT/sa.4.png" "$OUT/scroll-down.png"; cp "$OUT/sa.8.png" "$OUT/scroll-left.png"; cp "$OUT/sa.12.png" "$OUT/scroll-right.png"
rm -f "${rows[@]}"
tv=$(( $(h SCROLLTHUMBVERTICAL) / 4 )); th=$(( $(h SCROLLTHUMBHORIZONTAL) / 4 ))
gv=$(( $(h SCROLLTHUMBGRIPPERVERTICAL) / 4 )); gz=$(( $(h SCROLLTHUMBGRIPPERHORIZONTAL) / 4 ))
n=0; for s in normal hot pressed; do
  frame SCROLLTHUMBVERTICAL $tv $n "$OUT/scroll-thumb-v-$s.png"
  frame SCROLLTHUMBHORIZONTAL $th $n "$OUT/scroll-thumb-h-$s.png"
  frame SCROLLTHUMBGRIPPERVERTICAL $gv $n "$OUT/scroll-grip-v-$s.png"
  frame SCROLLTHUMBGRIPPERHORIZONTAL $gz $n "$OUT/scroll-grip-h-$s.png"
  magick "$OUT/scroll-thumb-v-$s.png" -gravity center -crop 1x1+0+0 +repage "PNG32:$OUT/scroll-fill-v-$s.png"
  magick "$OUT/scroll-thumb-h-$s.png" -gravity center -crop 1x1+0+0 +repage "PNG32:$OUT/scroll-fill-h-$s.png"
  n=$((n+1))
done
sv=$(( $(h SCROLLSHAFTVERTICAL) / 4 )); sh=$(( $(h SCROLLSHAFTHORIZONTAL) / 4 ))
frame SCROLLSHAFTVERTICAL $sv 0 "$OUT/scroll-track-v.png"
frame SCROLLSHAFTHORIZONTAL $sh 0 "$OUT/scroll-track-h.png"
magick "$LUNA/${PREFIX}_RESIZEGRIP2_BMP.bmp" -crop "x$(( $(h RESIZEGRIP2) / 2 ))+0+0" +repage -alpha set -transparent '#ff0000' "PNG32:$OUT/grip.png"

# Containers.
whole "$LUNA/${PREFIX}_GROUPBOX_BMP.bmp" "$OUT/groupbox.png"
hh=$(( $(h LISTVIEWHEADER) / 5 )); n=0; for s in normal hot pressed; do
  magick "$LUNA/${PREFIX}_LISTVIEWHEADER_BMP.bmp" -crop "x$hh+0+$((n * hh))" +repage -alpha set -transparent '#ff0000' "PNG32:$OUT/header-$s.png"; n=$((n+1))
done
whole "$LUNA/${PREFIX}_LISTVIEWHEADERBACKGROUND_BMP.bmp" "$OUT/header-bg.png"
th=$(( $(h TABITEMTOP) / 5 )); n=0; for s in normal hot selected; do frame TABITEMTOP $th $n "$OUT/tab-$s.png"; n=$((n+1)); done
whole "$LUNA/${PREFIX}_TABPANEEDGE_BMP.bmp" "$OUT/tab-pane.png"
whole "$LUNA/${PREFIX}_PROGRESSTRACK_BMP.bmp" "$OUT/progress-track.png"
whole "$LUNA/${PREFIX}_PROGRESSCHUNK_BMP.bmp" "$OUT/progress-chunk.png"
tb=$(( $(h TOOLBARBUTTONS) / 6 )); n=0; for s in normal hot pressed disabled checked; do frame TOOLBARBUTTONS $tb $n "$OUT/toolbar-$s.png"; n=$((n+1)); done
whole "$LUNA/${PREFIX}_TOOLBARBACKGROUND_BMP.bmp" "$OUT/toolbar-bg.png"
# The tiling middle of the gripper (SizingMargins 0, 0, 6, 4).
# Royale Noir's RLE gripper doesn't decode, so that theme reuses Luna's.
magick "$LUNA/${PREFIX}_GRIPPER_BMP.bmp" -crop 6x6+0+6 +repage -alpha set -transparent '#ff0000' "PNG32:$OUT/gripper.png" 2>/dev/null || true
magick "$LUNA/${PREFIX}_SEPARATOR_BMP.bmp" -alpha set -transparent '#ff0000' "PNG32:$OUT/separator.png" 2>/dev/null || true
whole "$LUNA/${PREFIX}_STATUSBACKGROUND_BMP.bmp" "$OUT/status-bg.png"
magick "$LUNA/${PREFIX}_STATUSPANE_BMP.bmp" -alpha set -transparent '#ff0000' "PNG32:$OUT/status-pane.png" 2>/dev/null || true
whole "$LUNA/${PREFIX}_TREEEXPANDCOLLAPSE_BMP.bmp" "$OUT/tree.png"
whole "$LUNA/${PREFIX}_SLIDERTRACK_BMP.bmp" "$OUT/slider-track.png"
magick "$LUNA/${PREFIX}_TRACKBARDOWN13_BMP.bmp" -alpha set -transparent 'rgb(242,241,231)' "PNG32:$OUT/slider-thumb.png"

# Explorer task pane. Head and chevrons from shellstyle.dll, as Explorer drew them.
if [ -n "$SHELL_BMP" ]; then
  whole "$SHELL_BMP/110.bmp" "$OUT/pane-head-special.png"
  whole "$SHELL_BMP/112.bmp" "$OUT/pane-head.png"
  whole "$LUNA/${PREFIX}_NORMALGROUPBACKGROUND_BMP.bmp" "$OUT/pane-body.png"
  for pair in 100:collapse 101:collapse-hot 102:expand 103:expand-hot 104:special-collapse 105:special-collapse-hot 106:special-expand 107:special-expand-hot; do
    magick "$SHELL_BMP/${pair%%:*}.bmp" "PNG32:$OUT/pane-${pair##*:}.png"
  done
fi
