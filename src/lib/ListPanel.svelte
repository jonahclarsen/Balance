<script lang="ts">
  import { onMount, tick } from 'svelte'
  import PlanItemEditor from './PlanItemEditor.svelte'
  import { buildItemTimeWarnings, findPlanItem, itemMetricLink, type ItemLink } from './planner'
  import { plannerStore } from './store'
  import { focusTaskBelow, TASK_COMPLETION_FOCUS_EVENT } from './taskCompletionFocus'
  import type { Id, ListTemplate, Metric, Note, PlanItem } from './types'

  export let instance: { id: Id; items: PlanItem[] }
  export let listTemplates: ListTemplate[]
  export let metrics: Metric[]
  export let notes: Note[] = []
  // Open an internal [[list]] / [[metric]] link from one of the rows.
  export let onOpenLink: (link: ItemLink, itemId: Id) => void
  // Jump a generated row to its source item on the list-templates page to edit.
  export let onEditTemplate: (itemId: Id) => void
  // In a modal the panel doesn't reliably hold DOM focus, so Escape is left to
  // the dialog to close it. On a plain page Escape just drops the selection.
  export let escapeClearsSelection = false
  export let selectedItemId: Id | null = null
  export let initialScrollTop: number | null = null
  export let onScrollTopChange: ((scrollTop: number) => void) | null = null
  export let initialBottomCollapse = 0
  export let onBottomCollapseSettled: ((pixels: number) => void) | null = null
  // Modal list panels show the E hint beneath each edit button. The page version
  // omits it because the plain-key shortcut is modal-only.
  export let showEditShortcutHint = false
  // In the overlay, arrowing onto a metric-linked row starts its survey. Keep
  // this opt-in so keyboard navigation on the full Lists page stays unchanged.
  export let openMetricOnArrowSelection = false

  let panel: HTMLDivElement
  let scrollContainer: HTMLElement | null = null
  let scrollAnimationFrame: number | null = null
  let animationBottomCollapseTarget: number | null = null
  let bottomCollapse = initialBottomCollapse
  let expandedModalHeight: number | null = null

  const selectionScrollDurationMs = 235

  // Drop a stale selection when the item it pointed at disappears.
  $: if (selectedItemId && !findPlanItem(instance.items, selectedItemId)) selectedItemId = null
  $: selectedItemIdSet = new Set(selectedItemId ? [selectedItemId] : [])
  $: timeWarnings = buildItemTimeWarnings(instance.items)

  onMount(() => {
    panel.addEventListener(TASK_COMPLETION_FOCUS_EVENT, handleCompletionFocus)
    const setup = async () => {
      await tick()
      if (!panel) return

      scrollContainer = findScrollContainer(panel)
      setBottomCollapse(initialBottomCollapse)
      if (scrollContainer && onScrollTopChange) {
        scrollContainer.addEventListener('scroll', handleScrollContainerScroll)
      }
      scrollContainer?.addEventListener('wheel', handleScrollContainerWheel, { passive: true })

      if (initialScrollTop != null && scrollContainer) {
        scrollContainer.scrollTop = initialScrollTop
        focusSelectedRowWithoutScroll()
      } else if (selectedItemId) {
        await focusSelectedRow('auto')
      }
    }

    void setup()

    return () => {
      panel.removeEventListener(TASK_COMPLETION_FOCUS_EVENT, handleCompletionFocus)
      scrollContainer?.removeEventListener('scroll', handleScrollContainerScroll)
      scrollContainer?.removeEventListener('wheel', handleScrollContainerWheel)
      if (scrollAnimationFrame !== null) cancelAnimationFrame(scrollAnimationFrame)
      onBottomCollapseSettled?.(bottomCollapse)
    }
  })

  function flattenItems(items: PlanItem[]): PlanItem[] {
    return items.flatMap((item) => [item, ...flattenItems(item.children)])
  }

  // Selecting a row also moves DOM focus onto it (keeping focus inside the panel
  // so the next keystroke still reaches handleKeydown) and scrolls it into view.
  // Moving down checks off the row being left; moving up reopens both the row
  // being left and the row being selected. Clicking a different row completes
  // the previous row.
  function selectItem(itemId: Id, selectedItemDone?: boolean, updateWhenUnchanged = false) {
    const previousItemId = selectedItemId
    selectedItemId = itemId
    if (selectedItemDone !== undefined && (previousItemId !== itemId || updateWhenUnchanged)) {
      updateItemsForSelectionMove(previousItemId, itemId, selectedItemDone)
    }
    void focusSelectedRow('smooth')
  }

  function updateItemsForSelectionMove(itemId: Id | null, nextItemId: Id, done: boolean) {
    if (!itemId) return

    const itemIds = done ? [itemId] : Array.from(new Set([itemId, nextItemId]))
    for (const id of itemIds) {
      const item = findPlanItem(instance.items, id)
      if (!item || item.done === done) continue
      // Items that reference a metric can only be completed via their survey,
      // so advancing past one must not silently check it off.
      if (done && itemMetricLink(item.text, listTemplates, metrics)) continue
      plannerStore.patchListItem(instance.id, item.id, { done })
    }
  }

  async function focusSelectedRow(behavior: ScrollBehavior) {
    await tick()
    if (!selectedItemId || !panel) return

    const row = Array.from(panel.querySelectorAll<HTMLElement>('[data-plan-item-id]')).find(
      (candidate) => candidate.dataset.planItemId === selectedItemId,
    )
    const focusTarget = row?.querySelector<HTMLElement>('.item-text-display')
    if (focusTarget && row) {
      focusTarget.focus({ preventScroll: true })
      scrollRowTopToOneThird(row, behavior)
    }
  }

  function focusSelectedRowWithoutScroll() {
    if (!selectedItemId || !panel) return

    const row = Array.from(panel.querySelectorAll<HTMLElement>('[data-plan-item-id]')).find(
      (candidate) => candidate.dataset.planItemId === selectedItemId,
    )
    row?.querySelector<HTMLElement>('.item-text-display')?.focus({ preventScroll: true })
  }

  function handleScrollContainerScroll() {
    if (scrollContainer) onScrollTopChange?.(scrollContainer.scrollTop)
  }

  function handleScrollContainerWheel(event: WheelEvent) {
    if (event.deltaY >= 0 || bottomCollapse <= 0 || animationBottomCollapseTarget === 0) return
    animateBottomCollapse(0)
  }

  function scrollRowTopToOneThird(row: HTMLElement, behavior: ScrollBehavior) {
    const scrollContainer = findScrollContainer(row)
    const rowRect = row.getBoundingClientRect()
    if (scrollContainer) {
      const targetTop = Math.max(0, scrollContainer.scrollTop + rowRect.top - window.innerHeight / 3)
      const expandedMaxScrollTop = Math.max(
        0,
        scrollContainer.scrollHeight - scrollContainer.clientHeight - bottomCollapse,
      )
      const targetBottomCollapse = Math.max(0, targetTop - expandedMaxScrollTop)
      scrollToPosition(scrollContainer, targetTop, behavior, targetBottomCollapse)
      return
    }
    scrollToPosition(null, window.scrollY + rowRect.top - window.innerHeight / 3, behavior, 0)
  }

  function scrollToPosition(
    container: HTMLElement | null,
    top: number,
    behavior: ScrollBehavior,
    targetBottomCollapse: number,
  ) {
    if (scrollAnimationFrame !== null) {
      cancelAnimationFrame(scrollAnimationFrame)
      scrollAnimationFrame = null
    }
    animationBottomCollapseTarget = targetBottomCollapse

    const setScrollTop = (nextTop: number) => {
      if (container) container.scrollTo({ top: nextTop, behavior: 'auto' })
      else window.scrollTo({ top: nextTop, behavior: 'auto' })
    }
    const startTop = container ? container.scrollTop : window.scrollY
    if (behavior !== 'smooth' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setBottomCollapse(targetBottomCollapse)
      setScrollTop(top)
      onBottomCollapseSettled?.(bottomCollapse)
      animationBottomCollapseTarget = null
      return
    }

    const startedAt = performance.now()
    const distance = top - startTop
    const startBottomCollapse = bottomCollapse
    const collapseDistance = targetBottomCollapse - startBottomCollapse
    const step = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / selectionScrollDurationMs)
      const easedProgress = 1 - Math.pow(1 - progress, 3)
      setBottomCollapse(startBottomCollapse + collapseDistance * easedProgress)
      setScrollTop(startTop + distance * easedProgress)
      if (progress < 1) scrollAnimationFrame = requestAnimationFrame(step)
      else {
        scrollAnimationFrame = null
        animationBottomCollapseTarget = null
        onBottomCollapseSettled?.(bottomCollapse)
      }
    }
    scrollAnimationFrame = requestAnimationFrame(step)
  }

  function animateBottomCollapse(targetBottomCollapse: number) {
    if (scrollAnimationFrame !== null) {
      cancelAnimationFrame(scrollAnimationFrame)
      scrollAnimationFrame = null
    }

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setBottomCollapse(targetBottomCollapse)
      animationBottomCollapseTarget = null
      onBottomCollapseSettled?.(bottomCollapse)
      return
    }

    animationBottomCollapseTarget = targetBottomCollapse
    const startedAt = performance.now()
    const startBottomCollapse = bottomCollapse
    const collapseDistance = targetBottomCollapse - startBottomCollapse
    const step = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / selectionScrollDurationMs)
      const easedProgress = 1 - Math.pow(1 - progress, 3)
      setBottomCollapse(startBottomCollapse + collapseDistance * easedProgress)
      if (progress < 1) scrollAnimationFrame = requestAnimationFrame(step)
      else {
        scrollAnimationFrame = null
        animationBottomCollapseTarget = null
        onBottomCollapseSettled?.(bottomCollapse)
      }
    }
    scrollAnimationFrame = requestAnimationFrame(step)
  }

  // Flex centering would normally move both card edges as its height changes.
  // Lifting it by half the collapse cancels the top-edge movement, so only the
  // bottom edge rises. The shared selection animation drives both CSS variables.
  function setBottomCollapse(pixels: number) {
    const modalCard = panel?.closest<HTMLElement>('.overlay-card')
    if (!modalCard) {
      bottomCollapse = 0
      return
    }

    const requestedCollapse = Math.max(0, pixels)
    if (requestedCollapse === 0) {
      bottomCollapse = 0
      modalCard.style.setProperty('--overlay-bottom-collapse', '0px')
      modalCard.style.setProperty('--overlay-bottom-lift', '0px')
      expandedModalHeight = null
      return
    }
    if (expandedModalHeight === null) {
      expandedModalHeight = modalCard.getBoundingClientRect().height
    }
    const maxCollapse = expandedModalHeight === null ? 0 : Math.max(0, expandedModalHeight - 160)
    bottomCollapse = Math.min(requestedCollapse, maxCollapse)
    modalCard.style.setProperty('--overlay-bottom-collapse', `${bottomCollapse}px`)
    modalCard.style.setProperty('--overlay-bottom-lift', `${bottomCollapse / 2}px`)
  }

  function findScrollContainer(element: HTMLElement): HTMLElement | null {
    let current = element.parentElement
    while (current) {
      const overflowY = window.getComputedStyle(current).overflowY
      if (/(auto|scroll|overlay)/.test(overflowY) && current.scrollHeight > current.clientHeight) {
        return current
      }
      current = current.parentElement
    }
    return null
  }

  // Arrow keys move the selection, updating the row behind the direction of
  // travel: down completes the row being left (including the final row), while
  // up reopens both the row being left and the row being selected.
  export function moveSelection(direction: -1 | 1) {
    const items = flattenItems(instance.items)
    if (items.length === 0) return

    const currentIndex = selectedItemId ? items.findIndex((item) => item.id === selectedItemId) : -1
    const nextIndex =
      currentIndex === -1
        ? direction === 1
          ? 0
          : items.length - 1
        : Math.min(items.length - 1, Math.max(0, currentIndex + direction))
    const nextItem = items[nextIndex]
    const selectionChanged = nextItem.id !== selectedItemId

    selectItem(nextItem.id, direction === 1, true)
    if (!openMetricOnArrowSelection || !selectionChanged) return

    // Resolve only the row reached by this keypress. This avoids maintaining a
    // reactive full-list link index while adding only the existing bounded
    // metric-name lookup to an actual selection change.
    const metricLink = itemMetricLink(nextItem.text, listTemplates, metrics)
    if (metricLink) onOpenLink(metricLink, nextItem.id)
  }

  export function toggleSelectedDone() {
    if (!selectedItemId) return
    const item = findPlanItem(instance.items, selectedItemId)
    if (!item) return
    // A metric-linked item can only be checked off through its survey; route the
    // keyboard shortcut there instead. Unchecking a done item stays direct.
    const metricLink = itemMetricLink(item.text, listTemplates, metrics)
    if (metricLink && !item.done) {
      onOpenLink(metricLink, item.id)
      return
    }
    const done = !item.done
    plannerStore.patchListItem(instance.id, item.id, { done })
    if (done) void focusTaskBelow(instance.id, [item.id])
  }

  export function hasSelection() {
    return Boolean(selectedItemId)
  }

  export function openSelectedMetric(): boolean {
    if (!selectedItemId) return false
    const item = findPlanItem(instance.items, selectedItemId)
    if (!item) return false
    const metricLink = itemMetricLink(item.text, listTemplates, metrics)
    if (!metricLink) return false

    onOpenLink(metricLink, item.id)
    return true
  }

  export function editSelectedTemplateItem() {
    if (selectedItemId) onEditTemplate(selectedItemId)
  }

  // The panel only holds focus once a row is clicked, so this fires reliably
  // regardless of what else is on the page. When the panel lives inside a modal
  // the host also routes keys here via the exported helpers above.
  function handleKeydown(event: KeyboardEvent) {
    const primaryModifier = event.metaKey || event.ctrlKey

    if (escapeClearsSelection && event.key === 'Escape' && selectedItemId) {
      event.preventDefault()
      selectedItemId = null
      return
    }

    if (!event.shiftKey && !event.altKey && !primaryModifier && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault()
      moveSelection(event.key === 'ArrowUp' ? -1 : 1)
      return
    }

    if (event.altKey && !primaryModifier && !event.shiftKey && event.code === 'KeyF' && openSelectedMetric()) {
      event.preventDefault()
      event.stopPropagation()
      return
    }

    if (primaryModifier && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'd' && selectedItemId) {
      event.preventDefault()
      toggleSelectedDone()
    }
  }

  function handleCompletionFocus(event: Event) {
    const itemId = (event as CustomEvent<{ itemId?: Id }>).detail?.itemId
    if (itemId && findPlanItem(instance.items, itemId)) selectedItemId = itemId
  }
</script>

<!-- svelte-ignore a11y-no-noninteractive-element-interactions -->
<div class="list-panel checklist-panel" role="list" bind:this={panel} on:keydown={handleKeydown}>
  {#if instance.items.length === 0}
    <p class="empty">This list generated no items.</p>
  {/if}
  {#each instance.items as item (item.id)}
    <PlanItemEditor
      {item}
      allItems={instance.items}
      {timeWarnings}
      planId={instance.id}
      patchItem={plannerStore.patchListItem}
      splitItem={plannerStore.splitListItem}
      backspaceItemAtStart={plannerStore.backspaceListItemAtStart}
      deleteItem={plannerStore.deleteListItem}
      deleteItemPreservingChildren={plannerStore.deleteListItemPreservingChildren}
      moveItem={plannerStore.moveListItem}
      moveItemWithinLevel={plannerStore.moveListItemWithinLevel}
      outdentItem={plannerStore.outdentListItem}
      historyRevision={$plannerStore.historyRevision}
      {listTemplates}
      {metrics}
      {notes}
      selectedItemIds={selectedItemIdSet}
      onLockedSelect={(itemId) => selectItem(itemId, true)}
      onOpenLink={(link, itemId) => onOpenLink(link, itemId)}
      onEditTemplate={onEditTemplate}
      {showEditShortcutHint}
      locked
    />
  {/each}
</div>
