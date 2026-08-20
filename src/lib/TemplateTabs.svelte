<script lang="ts">
  import { tick } from 'svelte'
  import { randomIridescentSelectionAnimationDelay, restartElementAnimations } from './iridescentSelectionAnimation'
  import type { Id } from './types'

  export let templates: { id: Id; name: string }[]
  export let selectedId: Id
  export let kind: 'day' | 'list'
  export let untitledLabel: string
  export let newLabel: string
  export let onSelect: (templateId: Id) => void
  export let onCreate: () => void
  export let onMove: (sourceId: Id, targetId: Id, placement: 'before' | 'after') => void

  let tabs: HTMLElement
  let drag: {
    templateId: Id
    pointerId: number
    startX: number
    startY: number
    dragging: boolean
  } | null = null
  let dropTargetId = ''
  let dropPlacement: 'before' | 'after' = 'before'
  let suppressClickId = ''
  let animatedSelectedId = selectedId
  let selectionAnimationDelay = randomIridescentSelectionAnimationDelay()
  let selectionAnimationRevision = 0

  function updateSelectionAnimation(templateId: Id) {
    if (templateId === animatedSelectedId) return
    animatedSelectedId = templateId
    selectionAnimationDelay = randomIridescentSelectionAnimationDelay()
    const revision = ++selectionAnimationRevision
    void tick().then(() => {
      if (revision !== selectionAnimationRevision) return
      restartElementAnimations(tabs?.querySelector('.template-tab.active'))
    })
  }

  $: updateSelectionAnimation(selectedId)

  function startDrag(templateId: Id, event: PointerEvent) {
    if (event.button !== 0) return
    drag = {
      templateId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
    }
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  }

  function continueDrag(event: PointerEvent) {
    if (!drag || drag.pointerId !== event.pointerId) return

    if (!drag.dragging) {
      const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY)
      if (distance < 5) return
      drag = { ...drag, dragging: true }
      suppressClickId = drag.templateId
    }

    event.preventDefault()
    const tabsRect = tabs.getBoundingClientRect()
    const edgeSize = Math.min(40, tabsRect.width / 4)
    if (event.clientX < tabsRect.left + edgeSize) tabs.scrollLeft -= 12
    else if (event.clientX > tabsRect.right - edgeSize) tabs.scrollLeft += 12

    const hovered = document.elementFromPoint(event.clientX, event.clientY)
    const target = hovered instanceof Element
      ? hovered.closest<HTMLElement>('[data-template-tab-id]')
      : null
    const targetId = target?.dataset.templateTabId ?? ''
    if (!target || !tabs.contains(target) || !targetId || targetId === drag.templateId) {
      dropTargetId = ''
      return
    }

    const targetRect = target.getBoundingClientRect()
    dropTargetId = targetId
    dropPlacement = event.clientX < targetRect.left + targetRect.width / 2 ? 'before' : 'after'
  }

  function finishDrag(event: PointerEvent) {
    if (!drag || drag.pointerId !== event.pointerId) return

    const sourceId = drag.templateId
    const wasDragging = drag.dragging
    const targetId = dropTargetId
    const placement = dropPlacement
    drag = null
    dropTargetId = ''

    if (!wasDragging) return
    event.preventDefault()
    event.stopPropagation()
    if (targetId) onMove(sourceId, targetId, placement)

    window.setTimeout(() => {
      if (suppressClickId === sourceId) suppressClickId = ''
    }, 0)
  }

  function cancelDrag() {
    drag = null
    dropTargetId = ''
    suppressClickId = ''
  }

  function select(templateId: Id) {
    if (suppressClickId === templateId) {
      suppressClickId = ''
      return
    }
    onSelect(templateId)
  }
</script>

<div
  class="list-template-tabs"
  style:--active-nav-animation-delay={selectionAnimationDelay}
  bind:this={tabs}
>
  {#each templates as template (template.id)}
    <button
      type="button"
      class="rail-chip template-tab"
      class:active={selectedId === template.id}
      class:dragging={drag?.dragging && drag.templateId === template.id}
      class:drop-before={dropTargetId === template.id && dropPlacement === 'before'}
      class:drop-after={dropTargetId === template.id && dropPlacement === 'after'}
      aria-current={selectedId === template.id}
      data-template-tab-id={template.id}
      data-day-template-tab-id={kind === 'day' ? template.id : undefined}
      data-list-template-tab-id={kind === 'list' ? template.id : undefined}
      title={`Drag to reorder ${kind === 'list' ? 'lists' : 'day templates'}`}
      on:click={() => select(template.id)}
      on:pointerdown={(event) => startDrag(template.id, event)}
      on:pointermove={continueDrag}
      on:pointerup={finishDrag}
      on:pointercancel={cancelDrag}
    >
      {template.name || untitledLabel}
    </button>
  {/each}
  <button type="button" class="rail-chip dashed-edge" on:click={onCreate}>{newLabel}</button>
</div>
