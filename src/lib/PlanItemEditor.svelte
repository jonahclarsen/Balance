<script lang="ts">
  import { tick } from 'svelte'
  import AlarmClockIcon from './AlarmClockIcon.svelte'
  import { dueTodayGoalsForItem, goalLightnessShift, goalMatchesForItem } from './goals'
  import { defaultPlanItemTimeRange, htmlToPlainTextWithBreaks, linkifyItemText, MAX_TIMELINE_MINUTES, planItemTimeOverlapsPrevious, type ItemLink, type ItemTextSegment } from './planner'
  import RichTextEditor from './RichTextEditor.svelte'
  import TimeRange, { type TimeShiftTarget } from './TimeRange.svelte'
  import type { Goal, GoalCompletion, Id, ListTemplate, Metric, MoveDirection, MovePlacement, PlanItem } from './types'

  type TextChangeOptions = {
    mergeHistory?: boolean
    mergeKey?: string
    mergeWindowMs?: number
  }

  const TIME_DRAG_MERGE_WINDOW_MS = 1500

  export let item: PlanItem
  export let allItems: PlanItem[]
  export let depth = 0
  export let planId: Id
  export let parentId: Id | null = null
  export let patchItem: (
    planId: Id,
    itemId: Id,
    patch: Partial<Omit<PlanItem, 'id' | 'children'>>,
    options?: TextChangeOptions,
  ) => void
  export let splitItem: (
    planId: Id,
    itemId: Id,
    patch: Partial<Omit<PlanItem, 'id' | 'children'>>,
    after: { html: string; text: string },
  ) => Id
  export let backspaceItemAtStart: (
    planId: Id,
    itemId: Id,
  ) => { focusItemId: Id; focusOffset: number } | null = () => null
  export let addChild: (planId: Id, parentId: Id) => void
  export let deleteItem: (planId: Id, itemId: Id) => void
  export let moveItem: (planId: Id, sourceId: Id, targetId: Id, placement: MovePlacement) => void
  export let moveItemWithinLevel: (planId: Id, itemId: Id, direction: MoveDirection) => void
  export let outdentItem: (planId: Id, itemId: Id) => void
  export let historyRevision: number
  export let goals: Goal[] = []
  export let goalCompletions: GoalCompletion[] = []
  export let dueTodayGoals: Goal[] = []
  export let planDate = ''
  export let selectedItemIds: Set<Id> = new Set()
  export let selectionDragging = false
  export let onSelectionPointerDown: (itemId: Id, event: PointerEvent) => void = () => {}
  export let onSelectionPointerMove: (event: PointerEvent) => void = () => {}
  export let onSelectionPointerEnter: (itemId: Id) => void = () => {}
  export let onTextShiftArrow: (itemId: Id, direction: MoveDirection) => void = () => {}
  export let onGoalBadgeClick: (goalId: Id) => void = () => {}
  // Internal links: a plan/list item whose text matches a list template name or
  // contains a metric name becomes a clickable opener.
  export let listTemplates: ListTemplate[] = []
  export let metrics: Metric[] = []
  export let onOpenLink: (link: ItemLink, itemId: Id) => void = () => {}
  // Locked (generated) list items can't be edited, but clicking one selects it so
  // it can be marked done / navigated by keyboard from the list view.
  export let onLockedSelect: (itemId: Id) => void = () => {}
  // Generated list instances are fixed once created for a day: structure and text
  // come from the list template, so locked items expose only the done checkbox and
  // any inline links. To change a list, edit its template and regenerate.
  export let locked = false

  let dragging = false
  let activeDropRow: HTMLElement | null = null
  $: selected = selectedItemIds.has(item.id)
  $: matchedGoals = goalMatchesForItem(goals, goalCompletions, planDate, item.id)
  // Only rescan the item text when it or the due-goal set actually changes:
  // in legacy mode the `item` and `dueTodayGoals` props invalidate on every
  // parent render, so a plain reactive call would rescan on each keystroke
  // anywhere in the plan.
  let dueTodayMatches: Goal[] = []
  let dueTodayScanKey: string | null = null
  $: {
    const scanKey = `${dueTodayGoals.map((goal) => goal.id).join(',')} ${item.text}`
    if (scanKey !== dueTodayScanKey) {
      dueTodayScanKey = scanKey
      dueTodayMatches = dueTodayGoalsForItem(item, dueTodayGoals)
    }
  }
  $: matchedGoalIds = new Set(matchedGoals.map((goal) => goal.id))
  $: visibleDueTodayMatches = dueTodayMatches.filter((goal) => !matchedGoalIds.has(goal.id))
  $: timeOverlapsPrevious =
    item.startMinutes !== null &&
    item.endMinutes !== null &&
    planItemTimeOverlapsPrevious(allItems, item.id, item.startMinutes)

  // Recompute link segments only when the text or the available targets change,
  // so unrelated edits elsewhere in the tree don't trigger a rescan per keystroke.
  let linkSegments: ItemTextSegment[] = [{ text: item.text, link: null }]
  let linkScanKey: string | null = null
  $: {
    const scanKey = `${item.text}|${listTemplates.map((template) => `${template.id}:${template.name}`).join(',')}|${metrics
      .map((metric) => `${metric.id}:${metric.name}`)
      .join(',')}`
    if (scanKey !== linkScanKey) {
      linkScanKey = scanKey
      linkSegments = linkifyItemText(item.text, listTemplates, metrics)
    }
  }

  // Locked (generated) list items render static text via these segments. Their
  // plain `item.text` has lost the line breaks that htmlToPlainText drops, so for
  // display we re-derive text from the HTML with <br> kept as newlines, then let
  // white-space: pre-wrap show them. (The editable path keeps editing item.html.)
  let displaySegments: ItemTextSegment[] = linkSegments
  let displayScanKey: string | null = null
  $: if (locked) {
    const displayText = htmlToPlainTextWithBreaks(item.html) || item.text
    const scanKey = `${displayText}|${listTemplates.map((template) => `${template.id}:${template.name}`).join(',')}|${metrics
      .map((metric) => `${metric.id}:${metric.name}`)
      .join(',')}`
    if (scanKey !== displayScanKey) {
      displayScanKey = scanKey
      displaySegments = linkifyItemText(displayText, listTemplates, metrics)
    }
  }

  function addTime() {
    patchItem(planId, item.id, defaultPlanItemTimeRange(allItems, item.id))
  }

  function patchTimeRange(startMinutes: number, endMinutes: number) {
    patchItem(
      planId,
      item.id,
      { startMinutes, endMinutes },
      { mergeKey: `plan-item-time:${planId}:${item.id}`, mergeWindowMs: TIME_DRAG_MERGE_WINDOW_MS },
    )
  }

  function selectedTimeShiftTargets(): TimeShiftTarget[] | null {
    if (!selected || selectedItemIds.size < 2) return null

    const targets = collectSelectedTimedItems(allItems, selectedItemIds)
    return targets.some((target) => target.itemId === item.id) ? targets : null
  }

  function collectSelectedTimedItems(items: PlanItem[], selectedIds: Set<Id>): TimeShiftTarget[] {
    const targets: TimeShiftTarget[] = []

    for (const planItem of items) {
      if (selectedIds.has(planItem.id) && planItem.startMinutes !== null && planItem.endMinutes !== null) {
        targets.push({
          itemId: planItem.id,
          startMinutes: planItem.startMinutes,
          endMinutes: planItem.endMinutes,
        })
      }

      targets.push(...collectSelectedTimedItems(planItem.children, selectedIds))
    }

    return targets
  }

  function shiftSelectedTimeRanges(targets: TimeShiftTarget[], delta: number) {
    const clampedDelta = clampTimeShiftDelta(targets, delta)

    for (const target of targets) {
      patchItem(planId, target.itemId, {
        startMinutes: target.startMinutes + clampedDelta,
        endMinutes: target.endMinutes + clampedDelta,
      })
    }
  }

  function clampTimeShiftDelta(targets: TimeShiftTarget[], delta: number) {
    const earliestStart = Math.min(...targets.map((target) => target.startMinutes))
    const latestEnd = Math.max(...targets.map((target) => target.endMinutes))

    return Math.max(-earliestStart, Math.min(delta, MAX_TIMELINE_MINUTES - latestEnd))
  }

  function placementForRow(row: HTMLElement, clientY: number): MovePlacement {
    const rect = row.getBoundingClientRect()
    const y = clientY - rect.top

    if (y < rect.height * 0.28) return 'before'
    if (y > rect.height * 0.72) return 'after'
    return 'inside'
  }

  function clearDropMarker() {
    activeDropRow?.classList.remove('drop-before', 'drop-inside', 'drop-after')
    activeDropRow = null
  }

  function markDropTarget(row: HTMLElement, placement: MovePlacement) {
    if (activeDropRow !== row) clearDropMarker()
    activeDropRow = row
    row.classList.remove('drop-before', 'drop-inside', 'drop-after')
    row.classList.add(`drop-${placement}`)
  }

  function startPointerDrag(event: PointerEvent) {
    event.preventDefault()
    event.stopPropagation()
    dragging = true
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  }

  function continuePointerDrag(event: PointerEvent) {
    if (!dragging) return

    const hovered = document.elementFromPoint(event.clientX, event.clientY)
    const row = hovered instanceof Element ? hovered.closest<HTMLElement>('[data-plan-item-id]') : null

    if (!row || row.dataset.planItemId === item.id) {
      clearDropMarker()
      return
    }

    markDropTarget(row, placementForRow(row, event.clientY))
  }

  function endPointerDrag(event: PointerEvent) {
    if (!dragging) return

    const row = activeDropRow
    const targetId = row?.dataset.planItemId
    const placement = row ? placementForRow(row, event.clientY) : null

    clearDropMarker()
    dragging = false

    if (targetId && targetId !== item.id && placement) {
      moveItem(planId, item.id, targetId, placement)
    }
  }

  async function handleTextArrowKey(direction: MoveDirection, current: HTMLDivElement, event: KeyboardEvent) {
    if (event.altKey) {
      moveItemWithinLevel(planId, item.id, direction)
      await tick()
      focusItemTextInput(item.id)
      return
    }

    if (event.shiftKey) {
      onTextShiftArrow(item.id, direction)
      return
    }

    focusAdjacentTextInput(current, direction)
  }

  async function handleTextSplit(before: { html: string; text: string }, after: { html: string; text: string }) {
    const newItemId = splitItem(planId, item.id, before, after)
    await tick()
    focusItemTextInput(newItemId, 'start')
  }

  async function handleBackspaceEmpty(current: HTMLDivElement) {
    const targets = planTextFocusTargets()
    const index = targets.indexOf(current)

    deleteItem(planId, item.id)
    await tick()

    const nextTargets = planTextFocusTargets()
    const target = nextTargets[Math.max(0, index - 1)] ?? nextTargets[0]
    if (target) focusTextTarget(target)
  }

  async function handleBackspaceStart(current: HTMLDivElement) {
    const result = backspaceItemAtStart(planId, item.id)

    if (!result) {
      if (item.text.trim() === '') await handleBackspaceEmpty(current)
      return
    }

    await tick()
    focusItemTextInputAtOffset(result.focusItemId, result.focusOffset)
  }

  async function handleMetaBackspaceEnd(current: HTMLDivElement) {
    await handleBackspaceEmpty(current)
  }

  function handleHorizontalBoundaryKey(direction: 'left' | 'right', current: HTMLDivElement) {
    focusAdjacentTextInput(current, direction === 'left' ? 'up' : 'down', direction === 'left' ? 'end' : 'start')
  }

  async function handleTextTab(direction: 'in' | 'out', current: HTMLDivElement) {
    if (direction === 'in') {
      const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-plan-item-id]'))
      const currentRow = current.closest<HTMLElement>('[data-plan-item-id]')
      const index = currentRow ? rows.indexOf(currentRow) : -1
      const targetId = findPreviousSameDepthPlanItemId(rows, index)

      if (targetId) {
        moveItem(planId, item.id, targetId, 'inside')
        await tick()
        focusItemTextInput(item.id)
      }
      return
    }

    if (parentId) {
      outdentItem(planId, item.id)
      await tick()
      focusItemTextInput(item.id)
    }
  }

  function findPreviousSameDepthPlanItemId(rows: HTMLElement[], currentIndex: number): Id | null {
    for (let index = currentIndex - 1; index >= 0; index -= 1) {
      const rowDepth = Number(rows[index].dataset.planItemDepth ?? 0)

      if (rowDepth === depth) return rows[index].dataset.planItemId ?? null
      if (rowDepth < depth) return null
    }

    return null
  }

  function focusAdjacentTextInput(current: HTMLDivElement, direction: MoveDirection, position: 'start' | 'end' = 'end') {
    const targets = planTextFocusTargets()
    const index = targets.indexOf(current)
    const target = targets[direction === 'up' ? index - 1 : index + 1]

    if (target) focusTextTarget(target, position)
  }

  function focusItemTextInput(itemId: Id, position: 'start' | 'end' = 'end') {
    const input = planTextFocusTargets().find(
      (candidate) => candidate.dataset.planTextFocusTargetId === itemId,
    )

    if (input) focusTextTarget(input, position)
  }

  function focusItemTextInputAtOffset(itemId: Id, offset: number) {
    const input = Array.from(document.querySelectorAll<HTMLDivElement>('[data-plan-text-input]')).find(
      (candidate) => candidate.dataset.planTextInputId === itemId,
    )

    if (input) focusTextInputAtOffset(input, offset)
  }

  function planTextFocusTargets() {
    return Array.from(document.querySelectorAll<HTMLDivElement>('[data-plan-text-focus-target]'))
  }

  function focusTextTarget(target: HTMLDivElement, position: 'start' | 'end' = 'end') {
    target.focus()

    if (!target.matches('[contenteditable="true"]')) return

    const range = document.createRange()
    range.selectNodeContents(target)
    range.collapse(position === 'start')

    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }

  function handleDisplayKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onLockedSelect(item.id)
      patchItem(planId, item.id, { done: !item.done })
    }
  }

  function handleLockedRowClick(event: MouseEvent) {
    if (!locked) return

    const target = event.target instanceof Element ? event.target : null
    if (target?.closest('a, button, input, textarea, select, [contenteditable="true"], .time-range, .check-target')) return

    onLockedSelect(item.id)
    patchItem(planId, item.id, { done: !item.done })
  }

  function focusTextInputAtOffset(input: HTMLDivElement, offset: number) {
    input.focus()

    const walker = document.createTreeWalker(input, NodeFilter.SHOW_TEXT)
    let remaining = offset
    let targetNode: Node = input
    let nodeOffset = 0
    let node = walker.nextNode()

    while (node) {
      const length = node.textContent?.length ?? 0
      if (remaining <= length) {
        targetNode = node
        nodeOffset = remaining
        break
      }

      remaining -= length
      node = walker.nextNode()
    }

    if (!node) {
      targetNode = input
      nodeOffset = input.childNodes.length
    }

    const range = document.createRange()
    range.setStart(targetNode, nodeOffset)
    range.collapse(true)

    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }
</script>

<div class="item-shell" style={`--depth: ${depth}`}>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
  <div
    class="plan-row"
    data-plan-item-id={item.id}
    data-plan-item-depth={depth}
    role="listitem"
    aria-label={`Plan item: ${item.text || 'Untitled'}`}
    class:done={item.done}
    class:selected
    on:click={handleLockedRowClick}
    on:pointerenter={() => {
      if (selectionDragging) onSelectionPointerEnter(item.id)
    }}
  >
    {#if !locked}
      <button
        class="select-handle"
        class:selected
        type="button"
        title={selected ? 'Selected' : 'Select item'}
        aria-label={selected ? 'Selected item' : 'Select item'}
        aria-pressed={selected}
        on:pointerdown={(event) => onSelectionPointerDown(item.id, event)}
        on:pointermove={onSelectionPointerMove}
      ></button>

      <button
        class="drag-handle"
        class:dragging
        type="button"
        title="Drag to move item"
        aria-label="Drag to move item"
        on:pointerdown={startPointerDrag}
        on:pointermove={continuePointerDrag}
        on:pointerup={endPointerDrag}
        on:pointercancel={() => {
          dragging = false
          clearDropMarker()
        }}
      >
        <span class="handle-dots" aria-hidden="true"></span>
      </button>
    {/if}

    <label class="check-target" title="Complete item">
      <input
        class="check"
        type="checkbox"
        checked={item.done}
        on:change={(event) => patchItem(planId, item.id, { done: event.currentTarget.checked })}
        aria-label="Complete item"
      />
    </label>

    {#if item.startMinutes !== null && item.endMinutes !== null}
      <TimeRange
        startMinutes={item.startMinutes}
        endMinutes={item.endMinutes}
        overlapsPrevious={timeOverlapsPrevious}
        onChange={patchTimeRange}
        getShiftTargets={selectedTimeShiftTargets}
        onShift={shiftSelectedTimeRanges}
        onRemove={() => patchItem(planId, item.id, { startMinutes: null, endMinutes: null })}
      />
    {:else if !locked}
      <button
        class="icon-button quiet add-time"
        type="button"
        title="Add time range"
        aria-label="Add time range"
        on:click={addTime}
      >
        <AlarmClockIcon />
      </button>
    {/if}

    {#if locked}
      <!-- Generated list items are fixed: text is static, but inline links stay
           clickable and row clicks toggle completion. -->
      <div
        class="item-text item-text-display"
        class:done={item.done}
        role="button"
        tabindex="0"
        aria-label="Toggle item"
        on:keydown={handleDisplayKeydown}
      >{#each displaySegments as segment, index (index)}{#if segment.link}{@const link = segment.link}<a
            href={'#'}
            class="inline-link"
            title={`Open ${link.label}`}
            aria-label={`Open ${link.label}`}
            on:click|preventDefault|stopPropagation={() => onOpenLink(link, item.id)}
          >{segment.text}</a>{:else}{segment.text}{/if}{/each}</div>
    {:else}
      <RichTextEditor
        className="item-text"
        kind="plan"
        inputId={item.id}
        html={item.html}
        text={item.text}
        done={item.done}
        placeholder="Plan item"
        ariaLabel="Plan item"
        revision={historyRevision}
        onChange={(html, text, options) => patchItem(planId, item.id, { html, text }, options)}
        onArrowKey={handleTextArrowKey}
        onSplit={handleTextSplit}
        onBackspaceEmpty={handleBackspaceEmpty}
        onBackspaceStart={handleBackspaceStart}
        onMetaBackspaceEnd={handleMetaBackspaceEnd}
        onHorizontalBoundaryKey={handleHorizontalBoundaryKey}
        onTabKey={handleTextTab}
        internalLinkSegments={linkSegments}
        onInternalLinkClick={(link) => onOpenLink(link, item.id)}
      />
    {/if}

    {#if matchedGoals.length > 0 || visibleDueTodayMatches.length > 0}
      <div class="plan-goal-badges" aria-label="Goals completed by this item">
        {#each visibleDueTodayMatches as goal (goal.id)}
          <span class="plan-due-today" title={`${goal.name} is due today to stay on track`}>due today</span>
        {/each}
        {#each matchedGoals as goal (goal.id)}
          <button
            type="button"
            class="plan-goal-badge"
            style={`--goal-hue: ${goal.hue}; --goal-lightness-shift: ${goalLightnessShift(goal.lightness)}%`}
            title={`Completes goal: ${goal.name} — show in goal rhythm`}
            on:click|stopPropagation={() => onGoalBadgeClick(goal.id)}
          >
            <span aria-hidden="true">✓</span>{goal.name}
          </button>
        {/each}
      </div>
    {/if}

    {#if !locked}
      <div class="row-actions">
        <button class="icon-button" type="button" title="Add child item" on:click={() => addChild(planId, item.id)}>↳</button>
        <button class="icon-button danger" type="button" title="Delete item" on:click={() => deleteItem(planId, item.id)}>×</button>
      </div>
    {/if}
  </div>

  {#if item.children.length > 0}
    <div class="children">
      {#each item.children as child (child.id)}
        <svelte:self
          item={child}
          {allItems}
          depth={depth + 1}
          {planId}
          parentId={item.id}
          {patchItem}
          {splitItem}
          {backspaceItemAtStart}
          {addChild}
          {deleteItem}
          {moveItem}
          {moveItemWithinLevel}
          {outdentItem}
          {historyRevision}
          {goals}
          {goalCompletions}
          {dueTodayGoals}
          {planDate}
          {selectedItemIds}
          {selectionDragging}
          {onSelectionPointerDown}
          {onSelectionPointerMove}
          {onSelectionPointerEnter}
          {onTextShiftArrow}
          {onGoalBadgeClick}
          {listTemplates}
          {metrics}
          {onOpenLink}
          {onLockedSelect}
          {locked}
        />
      {/each}
    </div>
  {/if}
</div>
