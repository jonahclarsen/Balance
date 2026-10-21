<script lang="ts">
  import { onDestroy } from 'svelte'
  import { beginHapticDrag, endHapticDrag, vibrateSteps } from './haptics'
  import { formatMinutes } from './planner'
  /** Minutes: a clock time (wraps around midnight) or a duration. */
  export let value: number
  export let kind: 'clock' | 'duration' | 'minutes'
  export let min = 5
  export let max = 1440
  export let label: string
  export let onChange: (value: number) => void
  const step = 5
  let preview: number | null = null
  let drag: { originY: number; origin: number; steps: number } | null = null
  $: shown = preview ?? value
  $: text = kind === 'clock' ? formatMinutes(shown) : kind === 'minutes' ? `${shown} min` : `${Math.floor(shown / 60)}h${shown % 60 ? ` ${shown % 60}m` : ''}`
  function settle(next: number) {
    const snapped = Math.round(next / step) * step
    return kind === 'clock' ? ((snapped % 1440) + 1440) % 1440 : Math.min(max, Math.max(min, snapped))
  }
  function begin(event: PointerEvent) {
    event.preventDefault()
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    drag = { originY: event.clientY, origin: value, steps: 0 }
    beginHapticDrag()
  }
  function move(event: PointerEvent) {
    if (!drag) return
    const steps = Math.round((drag.originY - event.clientY) / 10)
    if (steps !== drag.steps) { vibrateSteps(Math.abs(steps - drag.steps)); drag.steps = steps }
    preview = settle(drag.origin + steps * step)
  }
  function end() {
    if (!drag) return
    drag = null
    endHapticDrag()
    if (preview !== null && preview !== value) onChange(preview)
    preview = null
  }
  function key(event: KeyboardEvent) {
    const delta = event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0
    if (!delta) return
    event.preventDefault()
    const next = settle(value + delta)
    if (next !== value) onChange(next)
  }
  onDestroy(end)
</script>
<span class="time-range situate-drag-value">
  <button class="time-part" type="button" role="spinbutton" aria-label={label} aria-valuenow={value} aria-valuetext={text} title="Drag up or down, or use the arrow keys"
    on:pointerdown={begin} on:pointermove={move} on:pointerup={end} on:pointercancel={end} on:keydown={key}>{text}</button>
</span>
<style>.situate-drag-value .time-part { padding:5px 9px; }</style>
