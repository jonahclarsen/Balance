<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { PEAKS_PER_SECOND } from './voiceClips'

  // A scrolling waveform: the spacer gives the full width to scroll through and
  // the sticky canvas redraws only the visible window, so long clips stay cheap.
  export let peaks: number[]
  export let durationSeconds: number
  export let playhead = 0
  export let range: { start: number; end: number } | null = null
  export let onSeek: (seconds: number) => void
  export let onSelectRange: (start: number, end: number) => void = () => {}

  // Long clips scroll at this density; short ones stretch to fill the width.
  const MIN_PIXELS_PER_SECOND = 60
  const BAR_STEP = 4
  let scroller: HTMLDivElement
  let canvas: HTMLCanvasElement
  let width = 0
  let frame = 0
  let drag: { x: number; start: number; moved: boolean } | null = null

  $: pixelsPerSecond = width > 0 && durationSeconds > 0 ? Math.max(MIN_PIXELS_PER_SECOND, width / durationSeconds) : MIN_PIXELS_PER_SECOND
  $: totalWidth = Math.max(width, Math.ceil(durationSeconds * pixelsPerSecond))
  $: void [peaks, playhead, range, width, totalWidth], schedule()

  function schedule() {
    if (!canvas || frame) return
    frame = requestAnimationFrame(() => { frame = 0; draw() })
  }

  function draw() {
    const ratio = window.devicePixelRatio || 1
    const height = canvas.clientHeight
    canvas.width = Math.round(width * ratio)
    canvas.height = Math.round(height * ratio)
    const context = canvas.getContext('2d')
    if (!context) return
    context.scale(ratio, ratio)
    const style = getComputedStyle(canvas)
    const offset = scroller.scrollLeft
    const x = (seconds: number) => seconds * pixelsPerSecond - offset
    if (range) {
      context.fillStyle = style.getPropertyValue('--voice-range')
      context.fillRect(x(range.start), 0, Math.max(2, (range.end - range.start) * pixelsPerSecond), height)
    }
    const played = style.getPropertyValue('--voice-played')
    const unplayed = style.getPropertyValue('--voice-unplayed')
    const peaksPerPixel = PEAKS_PER_SECOND / pixelsPerSecond
    const last = Math.min(Math.ceil(durationSeconds * pixelsPerSecond), offset + width)
    // Each bar shows the loudest slice it covers.
    for (let left = Math.floor(offset / BAR_STEP) * BAR_STEP; left < last; left += BAR_STEP) {
      const from = Math.floor(left * peaksPerPixel)
      const to = Math.max(from + 1, Math.ceil((left + BAR_STEP) * peaksPerPixel))
      let peak = 0
      for (let index = from; index < Math.min(to, peaks.length); index += 1) peak = Math.max(peak, peaks[index]!)
      const barHeight = Math.max(0.04, peak / 255) * (height - 8)
      context.fillStyle = left / pixelsPerSecond < playhead ? played : unplayed
      context.fillRect(left - offset, (height - barHeight) / 2, BAR_STEP - 1, barHeight)
    }
    context.fillStyle = style.getPropertyValue('--voice-playhead')
    context.fillRect(x(playhead) - 1, 0, 2, height)
  }

  // Centers a moment unless it is already comfortably in view.
  export function reveal(seconds: number, smooth = true) {
    if (!scroller) return
    const position = seconds * pixelsPerSecond
    const margin = width * 0.15
    if (position >= scroller.scrollLeft + margin && position <= scroller.scrollLeft + width - margin) return
    scroller.scrollTo({ left: Math.max(0, position - width / 2), behavior: smooth ? 'smooth' : 'auto' })
  }

  function secondsAt(clientX: number) {
    const left = scroller.getBoundingClientRect().left
    return Math.min(durationSeconds, Math.max(0, (clientX - left + scroller.scrollLeft) / pixelsPerSecond))
  }

  // Touch scrolls natively; a tap seeks. A mouse drag selects a span.
  function handlePointerDown(event: PointerEvent) {
    if (event.button !== 0) return
    drag = { x: event.clientX, start: secondsAt(event.clientX), moved: false }
    if (event.pointerType === 'mouse') scroller.setPointerCapture(event.pointerId)
  }

  function handlePointerMove(event: PointerEvent) {
    if (!drag) return
    if (Math.abs(event.clientX - drag.x) > 4) drag.moved = true
    if (drag.moved && event.pointerType === 'mouse') {
      const now = secondsAt(event.clientX)
      range = { start: Math.min(drag.start, now), end: Math.max(drag.start, now) }
    }
  }

  function handlePointerUp(event: PointerEvent) {
    const current = drag
    drag = null
    if (!current) return
    if (!current.moved) onSeek(current.start)
    else if (event.pointerType === 'mouse' && range) onSelectRange(range.start, range.end)
  }

  let observer: ResizeObserver
  onMount(() => {
    observer = new ResizeObserver(() => { width = scroller.clientWidth })
    observer.observe(scroller)
    width = scroller.clientWidth
  })
  onDestroy(() => {
    observer?.disconnect()
    if (frame) cancelAnimationFrame(frame)
  })
</script>

<div
  class="voice-waveform"
  bind:this={scroller}
  on:scroll={schedule}
  on:pointerdown={handlePointerDown}
  on:pointermove={handlePointerMove}
  on:pointerup={handlePointerUp}
  on:pointercancel={() => { drag = null }}
  role="slider"
  tabindex="-1"
  aria-label="Audio position"
  aria-valuemin={0}
  aria-valuemax={Math.round(durationSeconds)}
  aria-valuenow={Math.round(playhead)}
>
  <canvas bind:this={canvas}></canvas>
  <div class="voice-waveform-spacer" style:width={`${totalWidth}px`}></div>
</div>

<style>
  .voice-waveform {
    --voice-played: var(--accent);
    --voice-unplayed: color-mix(in srgb, var(--muted) 55%, transparent);
    --voice-playhead: var(--ink);
    --voice-range: color-mix(in srgb, var(--accent) 18%, transparent);
    position: relative;
    height: 72px;
    overflow-x: auto;
    overflow-y: hidden;
    cursor: pointer;
    user-select: none;
    touch-action: pan-x;
  }
  canvas {
    position: sticky;
    left: 0;
    display: block;
    width: 100%;
    height: 100%;
  }
  .voice-waveform-spacer {
    height: 1px;
    margin-top: -1px;
  }
</style>
