<script lang="ts">
  import { onMount, tick } from 'svelte'
  import PlanItemEditor from './PlanItemEditor.svelte'
  import { findPlanItem, itemMetricLink, type ItemLink } from './planner'
  import { plannerStore } from './store'
  import type { Id, ListTemplate, Metric, PlanItem } from './types'

  export let instance: { id: Id; items: PlanItem[] }
  export let listTemplates: ListTemplate[]
  export let metrics: Metric[]
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

  let panel: HTMLDivElement
  let scrollContainer: HTMLElement | null = null

  // Drop a stale selection when the item it pointed at disappears.
  $: if (selectedItemId && !findPlanItem(instance.items, selectedItemId)) selectedItemId = null
  $: selectedItemIdSet = new Set(selectedItemId ? [selectedItemId] : [])

  onMount(() => {
    const setup = async () => {
      await tick()
      if (!panel) return

      scrollContainer = findScrollContainer(panel)
      if (scrollContainer && onScrollTopChange) {
        scrollContainer.addEventListener('scroll', handleScrollContainerScroll)
      }

      if (initialScrollTop != null && scrollContainer) {
        scrollContainer.scrollTop = initialScrollTop
        focusSelectedRowWithoutScroll()
      } else if (selectedItemId) {
        await focusSelectedRow('auto')
      }
    }

    void setup()

    return () => {
      scrollContainer?.removeEventListener('scroll', handleScrollContainerScroll)
    }
  })

  function flattenIds(items: PlanItem[]): Id[] {
    return items.flatMap((item) => [item.id, ...flattenIds(item.children)])
  }

  // Selecting a row also moves DOM focus onto it (keeping focus inside the panel
  // so the next keystroke still reaches handleKeydown) and scrolls it into view.
  // Advancing past a row checks it off; revisiting one (moving up, or clicking)
  // does not.
  function selectItem(itemId: Id, completePrevious = false) {
    const previousItemId = selectedItemId
    selectedItemId = itemId
    if (completePrevious) completeItem(previousItemId, itemId)
    void focusSelectedRow('smooth')
  }

  function completeItem(previousItemId: Id | null, nextItemId: Id) {
    if (!previousItemId || previousItemId === nextItemId) return
    const previousItem = findPlanItem(instance.items, previousItemId)
    if (!previousItem || previousItem.done) return
    // Items that reference a metric can only be completed via their survey, so
    // advancing past one must not silently check it off.
    if (itemMetricLink(previousItem.text, listTemplates, metrics)) return
    plannerStore.patchListItem(instance.id, previousItem.id, { done: true })
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

  function scrollRowTopToOneThird(row: HTMLElement, behavior: ScrollBehavior) {
    const scrollContainer = findScrollContainer(row)
    const rowRect = row.getBoundingClientRect()
    if (scrollContainer) {
      scrollContainer.scrollTo({
        top: scrollContainer.scrollTop + rowRect.top - window.innerHeight / 3,
        behavior,
      })
      return
    }
    window.scrollBy({ top: rowRect.top - window.innerHeight / 3, behavior })
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

  // Arrow keys move the selection; only moving down completes the row you leave.
  export function moveSelection(direction: -1 | 1) {
    const ids = flattenIds(instance.items)
    if (ids.length === 0) return

    const currentIndex = selectedItemId ? ids.indexOf(selectedItemId) : -1
    const nextIndex =
      currentIndex === -1
        ? direction === 1
          ? 0
          : ids.length - 1
        : Math.min(ids.length - 1, Math.max(0, currentIndex + direction))

    selectItem(ids[nextIndex], direction === 1)
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
    plannerStore.patchListItem(instance.id, item.id, { done: !item.done })
  }

  export function hasSelection() {
    return Boolean(selectedItemId)
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

    if (primaryModifier && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'd' && selectedItemId) {
      event.preventDefault()
      toggleSelectedDone()
    }
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
      planId={instance.id}
      patchItem={plannerStore.patchListItem}
      splitItem={plannerStore.splitListItem}
      backspaceItemAtStart={plannerStore.backspaceListItemAtStart}
      addChild={plannerStore.addListChild}
      deleteItem={plannerStore.deleteListItem}
      moveItem={plannerStore.moveListItem}
      moveItemWithinLevel={plannerStore.moveListItemWithinLevel}
      outdentItem={plannerStore.outdentListItem}
      historyRevision={$plannerStore.historyRevision}
      {listTemplates}
      {metrics}
      selectedItemIds={selectedItemIdSet}
      onLockedSelect={(itemId) => selectItem(itemId, true)}
      onOpenLink={(link, itemId) => onOpenLink(link, itemId)}
      onEditTemplate={onEditTemplate}
      locked
    />
  {/each}
</div>
