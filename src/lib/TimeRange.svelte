<script lang="ts" module>
  export type TimeShiftTarget = {
    itemId: string
    startMinutes: number
    endMinutes: number
  }
</script>

<script lang="ts">
  import { clampMinutes, formatMinutes, MAX_TIMELINE_MINUTES } from './planner'

  export let startMinutes: number
  export let endMinutes: number
  export let onChange: (startMinutes: number, endMinutes: number) => void
  export let onRemove: () => void
  export let getShiftTargets: (() => TimeShiftTarget[] | null) | null = null
  export let onShift: ((targets: TimeShiftTarget[], delta: number) => void) | null = null

  let dragState:
    | {
        mode: 'start' | 'end'
        adjustStartOnly: boolean
        originY: number
        originStart: number
        originEnd: number
        shiftTargets: TimeShiftTarget[] | null
      }
    | null = null

  function beginDrag(mode: 'start' | 'end', event: PointerEvent) {
    event.preventDefault()
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    const adjustStartOnly = mode === 'start' && event.altKey
    dragState = {
      mode,
      adjustStartOnly,
      originY: event.clientY,
      originStart: startMinutes,
      originEnd: endMinutes,
      shiftTargets: adjustStartOnly ? null : getShiftTargets?.() ?? null,
    }
  }

  function continueDrag(event: PointerEvent) {
    if (!dragState) return

    const steps = Math.round((dragState.originY - event.clientY) / 10)
    const delta = steps * 15

    if (dragState.shiftTargets) {
      onShift?.(dragState.shiftTargets, delta)
      return
    }

    if (dragState.mode === 'start') {
      if (dragState.adjustStartOnly) {
        const latestStart = dragState.originEnd - 15
        const nextStart = clampMinutes(Math.min(dragState.originStart + delta, latestStart))
        onChange(nextStart, dragState.originEnd)
        return
      }

      const duration = dragState.originEnd - dragState.originStart
      const latestStart = Math.max(0, MAX_TIMELINE_MINUTES - duration)
      const nextStart = clampMinutes(Math.min(dragState.originStart + delta, latestStart))
      onChange(nextStart, nextStart + duration)
      return
    }

    const desiredEnd = dragState.originEnd + delta
    const minimumEnd = dragState.originStart + 15

    if (desiredEnd >= minimumEnd) {
      onChange(dragState.originStart, clampMinutes(desiredEnd))
      return
    }

    const nextStart = clampMinutes(desiredEnd - 15)
    onChange(nextStart, nextStart + 15)
  }

  function endDrag() {
    dragState = null
  }
</script>

<span class="time-range" aria-label="Time range">
  <button
    class="time-part"
    type="button"
    title="Drag up or down to move the whole time range. Hold Alt to change only the start time."
    on:pointerdown={(event) => beginDrag('start', event)}
    on:pointermove={continueDrag}
    on:pointerup={endDrag}
    on:pointercancel={endDrag}
  >
    {formatMinutes(startMinutes)}
  </button>
  <span class="dash">-</span>
  <button
    class="time-part"
    type="button"
    title="Drag up or down to change only the end time"
    on:pointerdown={(event) => beginDrag('end', event)}
    on:pointermove={continueDrag}
    on:pointerup={endDrag}
    on:pointercancel={endDrag}
  >
    {formatMinutes(endMinutes)}
  </button>
  <button class="icon-button quiet" type="button" title="Remove time" on:click={onRemove}>×</button>
</span>
