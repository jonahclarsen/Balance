<script lang="ts">
  import { tick } from 'svelte'
  import AlarmClockIcon from './AlarmClockIcon.svelte'
  import { goalLightnessShift, goalMatchesForItem, goalsMatchingItemText } from './goals'
  import { defaultPlanItemTimeRange, formatMinutes, hasActiveTimeRange, itemLinkFromAnchor, linkifyItemText, MAX_TIMELINE_MINUTES, renderItemDisplayHTML, type ItemLink, type ItemTextSegment, type ItemTimeWarning } from './planner'
  import { scrollMovedItemsIntoView } from './itemScroll'
  import RichTextEditor from './RichTextEditor.svelte'
  import TimeRange, { type TimeShiftTarget } from './TimeRange.svelte'
  import TreeItemRow from './TreeItemRow.svelte'
  import type { Goal, GoalCompletion, Id, ListTemplate, Metric, MoveDirection, MovePlacement, Note, PlanItem } from './types'

  type TextChangeOptions = {
    mergeHistory?: boolean
    mergeKey?: string
    mergeWindowMs?: number
  }

  const TIME_DRAG_MERGE_WINDOW_MS = 1500

  export let item: PlanItem
  export let allItems: PlanItem[]
  export let timeWarnings: ReadonlyMap<Id, ItemTimeWarning>
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
  export let deleteItem: (planId: Id, itemId: Id) => void
  export let deleteItemPreservingChildren: (planId: Id, itemId: Id) => void = deleteItem
  export let moveItem: (planId: Id, sourceId: Id, targetId: Id, placement: MovePlacement) => void
  // Only the side-by-side day comparison supplies this; elsewhere a drag that
  // leaves its own plan does nothing.
  export let moveItemAcrossContainers:
    | ((sourcePlanId: Id, sourceId: Id, targetPlanId: Id, targetId: Id | null, placement: MovePlacement) => void)
    | null = null
  export let moveItemWithinLevel: (planId: Id, itemId: Id, direction: MoveDirection) => void
  export let outdentItem: (planId: Id, itemId: Id) => void
  export let historyRevision: number
  export let goals: Goal[] = []
  export let goalCompletions: GoalCompletion[] = []
  export let planDate = ''
  export let selectedItemIds: Set<Id> = new Set()
  export let selectionDragging = false
  export let mobile = false
  export let mobileSelectionMode = false
  export let onSelectionPointerDown: (itemId: Id, event: PointerEvent) => void = () => {}
  export let onSelectionPointerMove: (event: PointerEvent) => void = () => {}
  export let onSelectionPointerEnter: (itemId: Id) => void = () => {}
  export let onMobileSelectionStart: (itemId: Id) => void = () => {}
  export let onMobileSelectionToggle: (itemId: Id) => void = () => {}
  export let onCopyItem: (planId: Id, itemId: Id) => void = () => {}
  export let onCutItem: (planId: Id, itemId: Id) => void = () => {}
  export let onTextShiftArrow: (itemId: Id, direction: MoveDirection) => void = () => {}
  export let onGoalBadgeClick: (goalId: Id) => void = () => {}
  // Internal links: a plan/list item whose text matches a list template name or
  // contains a metric name becomes a clickable opener.
  export let listTemplates: ListTemplate[] = []
  export let metrics: Metric[] = []
  export let notes: Note[] = []
  export let onOpenLink: (link: ItemLink, itemId: Id) => void = () => {}
  // Locked (generated) list items can't be edited, but clicking one selects it so
  // it can be marked done / navigated by keyboard from the list view.
  export let onLockedSelect: (itemId: Id) => void = () => {}
  // When set on a locked (generated) list item, an edit button is shown that
  // jumps to the matching item on the list-templates page so it can be edited.
  export let onEditTemplate: ((itemId: Id) => void) | null = null
  export let showEditShortcutHint = false
  // Generated list instances are fixed once created for a day: structure and text
  // come from the list template, so locked items expose only the done checkbox and
  // any inline links. To change a list, edit its template and regenerate.
  export let locked = false

  $: selected = selectedItemIds.has(item.id)
  let matchedGoals: Goal[] = []
  let matchedGoalItemId: Id | null = null
  let matchedGoalDate: string | null = null
  let matchedGoalSource: Goal[] | null = null
  let matchedCompletionSource: GoalCompletion[] | null = null
  $: if (
    item.id !== matchedGoalItemId ||
    planDate !== matchedGoalDate ||
    goals !== matchedGoalSource ||
    goalCompletions !== matchedCompletionSource
  ) {
    matchedGoalItemId = item.id
    matchedGoalDate = planDate
    matchedGoalSource = goals
    matchedCompletionSource = goalCompletions
    matchedGoals = goalMatchesForItem(goals, goalCompletions, planDate, item.id)
  }
  // Only rescan the item text when it or the available goals actually change:
  // in legacy mode the `item` and `goals` props invalidate on every
  // parent render, so a plain reactive call would rescan on each keystroke
  // anywhere in the plan.
  let matchingGoals: Goal[] = []
  let goalScanText: string | null = null
  let goalScanDate: string | null = null
  let goalScanSource: Goal[] | null = null
  $: if (item.text !== goalScanText || planDate !== goalScanDate || goals !== goalScanSource) {
    goalScanText = item.text
    goalScanDate = planDate
    goalScanSource = goals
    matchingGoals = goalsMatchingItemText(item, goals, planDate)
  }
  $: matchedGoalIds = new Set(matchedGoals.map((goal) => goal.id))
  $: previewGoals = item.done ? [] : matchingGoals.filter((goal) => !matchedGoalIds.has(goal.id))
  $: timeWarning = timeWarnings.get(item.id)

  let mobileMenuOpen = false
  let mobileTimeEditorOpen = false
  let mobileTaskActions: HTMLDivElement | null = null

  // Recompute link segments only when the text or the available targets change,
  // so unrelated edits elsewhere in the tree don't trigger a rescan per keystroke.
  let linkSegments: ItemTextSegment[] = [{ text: item.text, link: null }]
  let linkScanText: string | null = null
  let linkTemplateSource: ListTemplate[] | null = null
  let linkMetricSource: Metric[] | null = null
  let linkNoteSource: Note[] | null = null
  $: if (
    item.text !== linkScanText ||
    listTemplates !== linkTemplateSource ||
    metrics !== linkMetricSource ||
    notes !== linkNoteSource
  ) {
    linkScanText = item.text
    linkTemplateSource = listTemplates
    linkMetricSource = metrics
    linkNoteSource = notes
    linkSegments = linkifyItemText(item.text, listTemplates, metrics, notes)
  }

  // An item whose text references a metric can only be checked off by finishing
  // that metric's survey, so row clicks / Enter open the survey instead of
  // toggling done. (Unchecking an already-done item is still allowed directly.)
  $: metricLink =
    (linkSegments.find((segment) => segment.link?.kind === 'metric')?.link as
      | Extract<ItemLink, { kind: 'metric' }>
      | undefined) ?? null

  // Locked (generated) list items render the item's saved HTML read-only, so
  // their formatting (bold/italic/underline) shows exactly as in the editor.
  // The same renderer re-inserts clickable internal-link anchors when the text
  // carries no inline formatting; handleDisplayLinkClick below delegates anchor
  // clicks back to onOpenLink.
  $: displayHTML = locked ? renderItemDisplayHTML(item.html, item.text, linkSegments) : ''

  function addTime() {
    patchItem(
      planId,
      item.id,
      { ...defaultPlanItemTimeRange(allItems, item.id), timeHidden: null },
    )
  }

  function addTimeAndOpenEditor() {
    addTime()
    mobileMenuOpen = false
    mobileTimeEditorOpen = true
  }

  function openMobileTimeEditor() {
    mobileMenuOpen = false
    mobileTimeEditorOpen = true
  }

  function removeTime() {
    mobileMenuOpen = false
    patchItem(planId, item.id, { timeHidden: true })
  }

  function startMobileSelection() {
    mobileMenuOpen = false
    onMobileSelectionStart(item.id)
  }

  function copyTask() {
    mobileMenuOpen = false
    onCopyItem(planId, item.id)
  }

  function cutTask() {
    mobileMenuOpen = false
    onCutItem(planId, item.id)
  }

  function removeTask() {
    mobileMenuOpen = false
    deleteItem(planId, item.id)
  }

  function handleWindowPointerDown(event: PointerEvent) {
    if (!mobileMenuOpen || mobileTaskActions?.contains(event.target as Node)) return
    mobileMenuOpen = false
  }

  function handleWindowKeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape') return
    if (mobileTimeEditorOpen) {
      mobileTimeEditorOpen = false
      return
    }
    mobileMenuOpen = false
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
      if (selectedIds.has(planItem.id) && hasActiveTimeRange(planItem)) {
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

  async function handleTextArrowKey(direction: MoveDirection, current: HTMLDivElement, event: KeyboardEvent) {
    if (event.altKey) {
      moveItemWithinLevel(planId, item.id, direction)
      await tick()
      focusItemTextInput(item.id)
      scrollMovedItemsIntoView('plan', [item.id], direction)
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
    const scope = planScopeFor(current)
    const targets = Array.from(scope.querySelectorAll<HTMLDivElement>('[data-plan-text-focus-target]'))
    const index = targets.indexOf(current)

    deleteItem(planId, item.id)
    await tick()

    const nextTargets = Array.from(scope.querySelectorAll<HTMLDivElement>('[data-plan-text-focus-target]'))
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
    const scope = planScopeFor(current)
    const targets = Array.from(scope.querySelectorAll<HTMLDivElement>('[data-plan-text-focus-target]'))
    const index = targets.indexOf(current)

    deleteItemPreservingChildren(planId, item.id)
    await tick()

    const nextTargets = Array.from(scope.querySelectorAll<HTMLDivElement>('[data-plan-text-focus-target]'))
    const target = nextTargets[Math.max(0, index - 1)] ?? nextTargets[0]
    if (target) focusTextTarget(target)
  }

  function handleHorizontalBoundaryKey(direction: 'left' | 'right', current: HTMLDivElement) {
    focusAdjacentTextInput(current, direction === 'left' ? 'up' : 'down', direction === 'left' ? 'end' : 'start')
  }

  // Two plans can be on screen at once (side-by-side days), so keyboard traversal
  // is scoped to the panel the caret is in rather than the whole document.
  function planScopeFor(element: HTMLElement): ParentNode {
    return element.closest<HTMLElement>('[data-plan-item-scope]') ?? document
  }

  async function handleTextTab(direction: 'in' | 'out', current: HTMLDivElement) {
    const caretOffset = textOffsetForCaret(current)

    if (direction === 'in') {
      const rows = Array.from(planScopeFor(current).querySelectorAll<HTMLElement>('[data-plan-item-id]'))
      const currentRow = current.closest<HTMLElement>('[data-plan-item-id]')
      const index = currentRow ? rows.indexOf(currentRow) : -1
      const targetId = findPreviousSameDepthPlanItemId(rows, index)

      if (targetId) {
        moveItem(planId, item.id, targetId, 'inside')
        await tick()
        focusItemTextInputAtOffset(item.id, caretOffset)
      }
      return
    }

    if (parentId) {
      outdentItem(planId, item.id)
      await tick()
      focusItemTextInputAtOffset(item.id, caretOffset)
    }
  }

  function textOffsetForCaret(input: HTMLDivElement) {
    const selection = document.getSelection()
    if (!selection || selection.rangeCount === 0) return input.textContent?.length ?? 0

    const range = selection.getRangeAt(0)
    if (!input.contains(range.startContainer)) return input.textContent?.length ?? 0

    const beforeCaret = document.createRange()
    beforeCaret.selectNodeContents(input)
    beforeCaret.setEnd(range.startContainer, range.startOffset)
    return beforeCaret.toString().length
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
    const targets = planTextFocusTargets(current)
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

  function planTextFocusTargets(scopeFrom?: HTMLElement) {
    const root = scopeFrom ? planScopeFor(scopeFrom) : document
    return Array.from(root.querySelectorAll<HTMLDivElement>('[data-plan-text-focus-target]'))
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
      if (metricLink && !item.done) {
        onOpenLink(metricLink, item.id)
        return
      }
      patchItem(planId, item.id, { done: !item.done })
    }
  }

  // The locked display renders via {@html}, so internal-link anchors have no
  // Svelte handlers. Catch clicks on them here and route to onOpenLink, stopping
  // the event before handleLockedRowClick toggles the row done.
  function handleDisplayLinkClick(event: MouseEvent) {
    const target = event.target instanceof Element ? event.target : null
    const anchor = target?.closest<HTMLAnchorElement>('a[data-internal-link-kind]')
    if (!anchor) return

    const link = itemLinkFromAnchor(anchor)
    if (!link) return

    event.preventDefault()
    event.stopPropagation()
    onOpenLink(link, item.id)
  }

  function handleLockedRowClick(event: MouseEvent) {
    if (!locked) return

    const target = event.target instanceof Element ? event.target : null
    if (target?.closest('a, button, input, textarea, select, [contenteditable="true"], .time-range, .check-target')) return

    onLockedSelect(item.id)
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

<svelte:window on:pointerdown={handleWindowPointerDown} on:keydown={handleWindowKeydown} />

<TreeItemRow
  kind="plan"
  itemId={item.id}
  containerId={planId}
  {depth}
  ariaLabel={`Plan item: ${item.text || 'Untitled'}`}
  {selected}
  done={item.done}
  {selectionDragging}
  wholeRowSelection={mobileSelectionMode}
  interactive={!locked}
  showSelectionHandle={!mobile}
  {moveItem}
  {moveItemAcrossContainers}
  {onSelectionPointerDown}
  {onSelectionPointerMove}
  {onSelectionPointerEnter}
  onWholeRowSelectionToggle={onMobileSelectionToggle}
  onRowClick={handleLockedRowClick}
>
  <label class="check-target" title="Complete item">
    <input
      class="check"
      type="checkbox"
      checked={item.done}
      on:change={(event) => patchItem(planId, item.id, { done: event.currentTarget.checked })}
      aria-label="Complete item"
    />
  </label>

  <div class="plan-item-main" class:timed={hasActiveTimeRange(item)}>
    {#if hasActiveTimeRange(item)}
      {#if mobile}
        <button
          class="mobile-time-summary"
          class:warning-start={Boolean(timeWarning?.overlapsPrevious || timeWarning?.precedesAncestor)}
          class:warning-end={Boolean(timeWarning?.overlapsNext || timeWarning?.exceedsAncestor)}
          type="button"
          aria-label={`Edit time ${formatMinutes(item.startMinutes)} to ${formatMinutes(item.endMinutes)}`}
          on:click|stopPropagation={openMobileTimeEditor}
        >
          <span class="mobile-time-side mobile-time-start-side">{formatMinutes(item.startMinutes)}</span>
          <span class="mobile-time-dash">–</span>
          <span class="mobile-time-side mobile-time-end-side">{formatMinutes(item.endMinutes)}</span>
        </button>
      {:else}
        <TimeRange
          startMinutes={item.startMinutes}
          endMinutes={item.endMinutes}
          overlapsPrevious={timeWarning?.overlapsPrevious}
          overlapsNext={timeWarning?.overlapsNext}
          precedesAncestor={timeWarning?.precedesAncestor}
          exceedsAncestor={timeWarning?.exceedsAncestor}
          onChange={patchTimeRange}
          getShiftTargets={selectedTimeShiftTargets}
          onShift={shiftSelectedTimeRanges}
          onRemove={() => patchItem(planId, item.id, { timeHidden: true })}
        />
      {/if}
    {:else if !locked && !mobile}
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
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div
        class="item-text item-text-display"
        class:done={item.done}
        role="button"
        tabindex="0"
        aria-label="Toggle item"
        on:keydown={handleDisplayKeydown}
        on:click={handleDisplayLinkClick}
      >{@html displayHTML}</div>
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
        interceptShiftArrowAtBoundary
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
  </div>

  {#if matchedGoals.length > 0 || previewGoals.length > 0}
      <div class="plan-goal-badges" aria-label="Goals matched by this item">
        {#each previewGoals as goal (goal.id)}
          <button
            type="button"
            class="plan-goal-badge"
            style={`--goal-hue: ${goal.hue}; --goal-lightness-shift: ${goalLightnessShift(goal.lightness)}%`}
            title={`Will complete goal: ${goal.name} — show in goal rhythm`}
            aria-label={`${goal.name} — show in goal rhythm`}
            on:click|stopPropagation={() => onGoalBadgeClick(goal.id)}
          >{goal.name}</button>
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

  {#if mobile && !locked}
    <div class="mobile-task-actions" bind:this={mobileTaskActions}>
      {#if mobileSelectionMode}
        <button
          class="mobile-selection-toggle"
          class:selected
          type="button"
          aria-label={selected ? `Deselect ${item.text || 'task'}` : `Select ${item.text || 'task'}`}
          aria-pressed={selected}
          on:click|stopPropagation={() => onMobileSelectionToggle(item.id)}
        >{selected ? '✓' : ''}</button>
      {:else}
        <button
          class="mobile-task-menu-button"
          type="button"
          title="Task options"
          aria-label={`Task options for ${item.text || 'untitled task'}`}
          aria-haspopup="menu"
          aria-expanded={mobileMenuOpen}
          on:click|stopPropagation={() => (mobileMenuOpen = !mobileMenuOpen)}
        >⋮</button>
        {#if mobileMenuOpen}
          <div class="mobile-task-menu" role="menu" aria-label={`Options for ${item.text || 'untitled task'}`}>
            {#if hasActiveTimeRange(item)}
              <button type="button" role="menuitem" on:click|stopPropagation={openMobileTimeEditor}>Edit time</button>
              <button type="button" role="menuitem" on:click|stopPropagation={removeTime}>Remove time</button>
            {:else}
              <button type="button" role="menuitem" on:click|stopPropagation={addTimeAndOpenEditor}>Add time</button>
            {/if}
            <button type="button" role="menuitem" on:click|stopPropagation={copyTask}>Copy</button>
            <button type="button" role="menuitem" on:click|stopPropagation={cutTask}>Cut</button>
            <button type="button" role="menuitem" on:click|stopPropagation={removeTask}>Remove</button>
            <button type="button" role="menuitem" on:click|stopPropagation={startMobileSelection}>Select tasks</button>
          </div>
        {/if}
      {/if}
    </div>
  {/if}

  <!-- Editable rows carry no per-row buttons: add-child is Tab and delete is
       Backspace / Del on a selection, and the width they cost is what makes
       deeply indented text unreadable. -->
  {#if locked && onEditTemplate}
      {@const edit = onEditTemplate}
      <div class="row-actions" class:edit-shortcut-action={showEditShortcutHint}>
        <button
          class="icon-button"
          type="button"
          title="Edit this item in Lists"
          aria-label="Edit this item in Lists"
          aria-keyshortcuts={showEditShortcutHint ? 'E' : undefined}
          on:click|stopPropagation={() => edit(item.id)}
        >✎</button>
        {#if showEditShortcutHint}
          <kbd class="edit-shortcut-hint" aria-hidden="true">E</kbd>
        {/if}
      </div>
  {/if}

  <svelte:fragment slot="children">
    {#if item.children.length > 0}
      <div class="children">
        {#each item.children as child (child.id)}
          <svelte:self
            item={child}
            {allItems}
            {timeWarnings}
            depth={depth + 1}
            {planId}
            parentId={item.id}
            {patchItem}
            {splitItem}
            {backspaceItemAtStart}
            {deleteItem}
            {deleteItemPreservingChildren}
            {moveItem}
            {moveItemAcrossContainers}
            {moveItemWithinLevel}
            {outdentItem}
            {historyRevision}
            {goals}
            {goalCompletions}
            {planDate}
            {selectedItemIds}
            {selectionDragging}
            {mobile}
            {mobileSelectionMode}
            {onSelectionPointerDown}
            {onSelectionPointerMove}
            {onSelectionPointerEnter}
            {onMobileSelectionStart}
            {onMobileSelectionToggle}
            {onCopyItem}
            {onCutItem}
            {onTextShiftArrow}
            {onGoalBadgeClick}
            {listTemplates}
            {metrics}
            {notes}
            {onOpenLink}
            {onLockedSelect}
            {onEditTemplate}
            {showEditShortcutHint}
            {locked}
          />
        {/each}
      </div>
    {/if}
  </svelte:fragment>
</TreeItemRow>

{#if mobile && mobileTimeEditorOpen && hasActiveTimeRange(item)}
  <!-- Changes persist during the drag, so tapping the backdrop only dismisses
       the editor; there is no separate save or cancel state to reconcile. -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="mobile-time-editor-backdrop"
    role="presentation"
    on:click|self={() => (mobileTimeEditorOpen = false)}
  >
    <div
      class="mobile-time-editor"
      role="dialog"
      aria-modal="true"
      aria-label={`Edit time for ${item.text || 'task'}`}
      tabindex="-1"
    >
      <TimeRange
        startMinutes={item.startMinutes}
        endMinutes={item.endMinutes}
        overlapsPrevious={timeWarning?.overlapsPrevious}
        overlapsNext={timeWarning?.overlapsNext}
        precedesAncestor={timeWarning?.precedesAncestor}
        exceedsAncestor={timeWarning?.exceedsAncestor}
        onChange={patchTimeRange}
        onRemove={() => {}}
        expanded
        hapticSteps
        showRemove={false}
      />
      <p>Drag either time up or down in 15-minute steps. Tap outside to close.</p>
    </div>
  </div>
{/if}
