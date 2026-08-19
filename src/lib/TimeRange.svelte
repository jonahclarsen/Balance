<script lang="ts" module>
  export type TimeShiftTarget = {
    itemId: string
    startMinutes: number
    endMinutes: number
  }
</script>

<script lang="ts">
  import { isTauri } from '@tauri-apps/api/core'
  import { vibrate } from '@tauri-apps/plugin-haptics'
  import { clampMinutes, formatMinutes, MAX_TIMELINE_MINUTES } from './planner'

  const STEP_HAPTIC_MS = 16
  const STEP_HAPTIC_PAUSE_MS = 24

  export let startMinutes: number
  export let endMinutes: number
  export let onChange: (startMinutes: number, endMinutes: number) => void
  export let onRemove: () => void
  export let overlapsPrevious = false
  export let overlapsNext = false
  export let precedesAncestor = false
  export let exceedsAncestor = false
  export let getShiftTargets: (() => TimeShiftTarget[] | null) | null = null
  export let onShift: ((targets: TimeShiftTarget[], delta: number) => void) | null = null
  export let expanded = false
  export let hapticSteps = false
  export let dragPixelsPerStep = 10
  export let showRemove = true

  $: warningReasons = [
    overlapsPrevious ? 'starts before the previous timed item ends' : null,
    overlapsNext ? 'ends after the next timed item starts' : null,
    precedesAncestor ? 'starts before a parent or ancestor starts' : null,
    exceedsAncestor ? 'ends after a parent or ancestor ends' : null,
  ].filter(Boolean)
  $: warningTitle = warningReasons.length > 0 ? `This time ${warningReasons.join(' and ')}` : null

  let dragState:
    | {
        mode: 'start' | 'end'
        adjustStartOnly: boolean
        originY: number
        originStart: number
        originEnd: number
        shiftTargets: TimeShiftTarget[] | null
        lastSteps: number
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
      lastSteps: 0,
    }
  }

  function continueDrag(event: PointerEvent) {
    if (!dragState) return

    const steps = Math.round((dragState.originY - event.clientY) / dragPixelsPerStep)
    const delta = steps * 15

    if (hapticSteps && steps !== dragState.lastSteps) {
      const crossedSteps = Math.abs(steps - dragState.lastSteps)
      dragState.lastSteps = steps
      vibrateCrossedSteps(crossedSteps)
    }

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

  function vibrateCrossedSteps(count: number) {
    if (count < 1) return

    if (isTauri()) {
      // Android WebViews may expose navigator.vibrate() while silently
      // ignoring it. Tauri's mobile plugin calls the native vibrator service.
      void vibrateNatively(count).catch(() => vibrateInBrowser(count))
      return
    }

    vibrateInBrowser(count)
  }

  async function vibrateNatively(count: number) {
    for (let index = 0; index < count; index += 1) {
      const result = await vibrate(STEP_HAPTIC_MS)
      if (result.status === 'error') throw new Error('Native haptic feedback failed')
      if (index < count - 1) {
        await new Promise((resolve) => window.setTimeout(resolve, STEP_HAPTIC_PAUSE_MS))
      }
    }
  }

  function vibrateInBrowser(count: number) {
    if (typeof navigator.vibrate !== 'function') return

    // Pointer events can skip several 15-minute boundaries during a quick
    // swipe. A single vibration call with a pulse pattern preserves one tactile
    // tick per crossed boundary instead of collapsing them into one buzz.
    const pattern = Array.from(
      { length: count * 2 - 1 },
      (_, index) => (index % 2 === 0 ? STEP_HAPTIC_MS : STEP_HAPTIC_PAUSE_MS),
    )
    navigator.vibrate(pattern)
  }
</script>

<span
  class="time-range"
  class:expanded
  class:warning-start={overlapsPrevious || precedesAncestor}
  class:warning-end={overlapsNext || exceedsAncestor}
  aria-label="Time range"
  title={warningTitle}
>
  <span class="time-side time-start-side">
    <button
      class="time-part"
      class:warning={overlapsPrevious || precedesAncestor}
      type="button"
      aria-label={`Start time ${formatMinutes(startMinutes)}. Drag up or down to move the scheduled block.`}
      title="Drag up or down to move the whole time range. Hold Alt to change only the start time."
      on:pointerdown={(event) => beginDrag('start', event)}
      on:pointermove={continueDrag}
      on:pointerup={endDrag}
      on:pointercancel={endDrag}
    >
      {formatMinutes(startMinutes)}
    </button>
  </span>
  <span class="dash">-</span>
  <span class="time-side time-end-side">
    <button
      class="time-part"
      class:warning={overlapsNext || exceedsAncestor}
      type="button"
      aria-label={`End time ${formatMinutes(endMinutes)}. Drag up or down to change the end time.`}
      title="Drag up or down to change only the end time"
      on:pointerdown={(event) => beginDrag('end', event)}
      on:pointermove={continueDrag}
      on:pointerup={endDrag}
      on:pointercancel={endDrag}
    >
      {formatMinutes(endMinutes)}
    </button>
    {#if showRemove}
      <button class="icon-button quiet" type="button" title="Remove time" on:click={onRemove}>×</button>
    {/if}
  </span>
</span>
