<script lang="ts">
  import { onDestroy } from 'svelte'
  import { beginHapticDrag, endHapticDrag, vibrateSteps } from './haptics'
  import { ideaReviewDays, IDEA_REVIEW_MAX_DAYS, type ScheduledIdeaReviewKind } from './ideas'
  import { plannerStore } from './store'
  import type { IdeaGroup } from './types'

  export let kind: ScheduledIdeaReviewKind
  export let groups: IdeaGroup[]
  export let label: string
  // A press that never drags counts as a press on whatever holds the value.
  export let onTap: (() => void) | undefined = undefined

  // Dragged like Today's times: one day per step of the pointer.
  const PX_PER_DAY = 8
  let preview: number | null = null
  let drag: { originY: number; origin: number; steps: number; moved: boolean } | null = null

  $: days = ideaReviewDays(groups, kind)
  $: shown = preview ?? days
  $: text = `Every ${shown} ${shown === 1 ? 'day' : 'days'}`

  function clamp(value: number) {
    return Math.min(IDEA_REVIEW_MAX_DAYS, Math.max(1, value))
  }

  function save(next: number) {
    if (next !== days) plannerStore.setIdeaReviewDays(kind, next)
  }

  function begin(event: PointerEvent) {
    event.preventDefault()
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    drag = { originY: event.clientY, origin: days, steps: 0, moved: false }
    beginHapticDrag()
  }

  function move(event: PointerEvent) {
    if (!drag) return
    const steps = Math.round((drag.originY - event.clientY) / PX_PER_DAY)
    if (steps !== drag.steps) {
      vibrateSteps(Math.abs(steps - drag.steps))
      drag.steps = steps
      drag.moved = true
    }
    preview = clamp(drag.origin + steps)
  }

  function end(event?: PointerEvent) {
    if (!drag) return
    const tapped = event?.type === 'pointerup' && !drag.moved
    drag = null
    endHapticDrag()
    if (preview !== null) save(preview)
    preview = null
    if (tapped) onTap?.()
  }

  function key(event: KeyboardEvent) {
    const delta = event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : 0
    if (!delta) return
    event.preventDefault()
    event.stopPropagation()
    save(clamp(days + delta * (event.shiftKey ? 7 : 1)))
  }

  onDestroy(() => end())
</script>

<span class="time-range idea-review-cadence">
  <button
    class="time-part"
    type="button"
    role="spinbutton"
    aria-label={`${label} review days`}
    aria-valuenow={shown}
    aria-valuemin={1}
    aria-valuemax={IDEA_REVIEW_MAX_DAYS}
    aria-valuetext={text}
    title="Drag up or down, or use the arrow keys"
    on:pointerdown={begin}
    on:pointermove={move}
    on:pointerup={end}
    on:pointercancel={() => end()}
    on:keydown={key}
  >{text}</button>
</span>

<style>
  .idea-review-cadence { font-size: 12px; }
  .idea-review-cadence .time-part { padding: 3px 8px; white-space: nowrap; }
</style>
