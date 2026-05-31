<script lang="ts">
  import { invoke, isTauri } from '@tauri-apps/api/core'
  import { confirm as confirmDialog, open as openDialog } from '@tauri-apps/plugin-dialog'
  import { onMount, tick } from 'svelte'
  import PlanItemEditor from './lib/PlanItemEditor.svelte'
  import TemplateItemEditor from './lib/TemplateItemEditor.svelte'
  import { confirmRecoveryKey, exportHTML, exportJSON, getRecoveryKeyStatus, plannerStore } from './lib/store'
  import type { RecoveryKeyStatus } from './lib/store'
  import type { Id, MoveDirection, PlanItem } from './lib/types'
  import { DEFAULT_DAILY_REMINDER, formatPlanTitle, todayISO } from './lib/planner'

  type View = 'today' | 'templates' | 'history' | 'export' | 'settings'
  type ExportSettings = {
    exportDirectory: string
    defaultExportDirectory: string
    usesDefaultExportDirectory: boolean
  }

  let view: View = 'today'
  let selectedTemplateId = ''
  let recoveryKeyStatus: RecoveryKeyStatus | null = null
  let recoveryKeySaved = false
  let recoveryKeyCopied = false
  let exportStatus = ''
  let exportStatusIsError = false
  let exportSavedPath = ''
  let exportSettings: ExportSettings | null = null
  let exportSettingsStatus = ''
  let exportSettingsStatusIsError = false
  let exportSettingsBusy = false
  let editingDailyReminder = false
  let dailyReminderDraft = ''
  let dailyReminderInput: HTMLInputElement | null = null
  let selectedPlanItemIds: Id[] = []
  let planSelectionAnchorId: Id | null = null
  let planSelectionFocusId: Id | null = null
  let selectedPlanPlanId: Id | null = null
  let selectingPlanItems = false
  let planItemClipboard: { items: PlanItem[]; cut: boolean } | null = null
  let planTextDragOrigin: { itemId: Id; input: HTMLElement } | null = null
  let preservePlanSelectionFocusUntil = 0

  $: templates = $plannerStore.templates
  $: activePlan = $plannerStore.plans.find((plan) => plan.date === $plannerStore.activePlanDate)
  $: activeDailyReminder = activePlan?.dailyReminder ?? DEFAULT_DAILY_REMINDER
  $: if (!editingDailyReminder) dailyReminderDraft = activeDailyReminder
  $: selectedTemplate = templates.find((template) => template.id === selectedTemplateId) ?? templates[0]
  $: if (!selectedTemplateId && templates[0]) selectedTemplateId = templates[0].id
  $: generateButtonLabel = $plannerStore.activePlanDate === todayISO() ? 'Generate today' : 'Generate selected day'
  $: selectedPlanItemIdSet = new Set(selectedPlanItemIds)
  $: if ((view !== 'today' || activePlan?.id !== selectedPlanPlanId) && selectedPlanItemIds.length > 0) {
    clearPlanSelection()
  }

  onMount(async () => {
    recoveryKeyStatus = await getRecoveryKeyStatus()
    await loadExportSettings()
  })

  function shiftActivePlanDate(days: number) {
    plannerStore.setActivePlanDate(shiftISODate($plannerStore.activePlanDate || todayISO(), days))
  }

  function shiftISODate(date: string, days: number): string {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
    if (!match) return todayISO()

    const shifted = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days)
    const year = shifted.getFullYear()
    const month = String(shifted.getMonth() + 1).padStart(2, '0')
    const day = String(shifted.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  async function confirmReplaceExistingPlan(): Promise<boolean> {
    const message = 'This date already has a plan. Replace it with a freshly generated one?'

    if (isTauri()) {
      return confirmDialog(message, { title: 'Replace existing plan?', kind: 'warning' })
    }

    return window.confirm(message)
  }

  async function generateSelectedDay() {
    if (!selectedTemplate) return

    const date = $plannerStore.activePlanDate || todayISO()
    const exists = $plannerStore.plans.some((plan) => plan.date === date)
    const replaceExisting = exists ? await confirmReplaceExistingPlan() : false

    if (exists && !replaceExisting) {
      plannerStore.setActivePlanDate(date)
      view = 'today'
      return
    }

    plannerStore.generatePlan(selectedTemplate.id, date, replaceExisting)
    view = 'today'
  }

  async function download(filename: string, content: string, type: string) {
    exportStatus = ''
    exportStatusIsError = false
    exportSavedPath = ''

    if (isTauri()) {
      try {
        const savedPath = await invoke<string>('save_export_file', { filename, content })
        exportSavedPath = savedPath
      } catch (error) {
        exportStatusIsError = true
        exportStatus = error instanceof Error ? error.message : String(error)
      }
      return
    }

    const blob = new Blob([content], { type })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.append(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
    exportStatus = `Download started for ${filename}`
  }

  async function revealSavedExport() {
    if (!exportSavedPath) return

    exportStatus = ''
    exportStatusIsError = false

    try {
      await invoke('reveal_path_in_file_manager', { path: exportSavedPath })
    } catch (error) {
      exportStatusIsError = true
      exportStatus = error instanceof Error ? error.message : String(error)
    }
  }

  function downloadJSON() {
    void download(`balance-export-${todayISO()}.json`, exportJSON($plannerStore), 'application/json')
  }

  function downloadHTML() {
    void download(`balance-history-${todayISO()}.html`, exportHTML($plannerStore), 'text/html')
  }

  async function loadExportSettings() {
    if (!isTauri()) return

    try {
      exportSettings = await invoke<ExportSettings>('get_export_settings')
    } catch (error) {
      exportSettingsStatusIsError = true
      exportSettingsStatus = error instanceof Error ? error.message : String(error)
    }
  }

  async function chooseExportDirectory() {
    if (!isTauri()) return

    exportSettingsStatus = ''
    exportSettingsStatusIsError = false
    exportSettingsBusy = true

    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: 'Choose export folder',
        defaultPath: exportSettings?.exportDirectory,
      })

      if (typeof selected === 'string') {
        exportSettings = await invoke<ExportSettings>('set_export_directory', { directory: selected })
        exportSettingsStatus = `Exports save to ${exportSettings.exportDirectory}`
      }
    } catch (error) {
      exportSettingsStatusIsError = true
      exportSettingsStatus = error instanceof Error ? error.message : String(error)
    } finally {
      exportSettingsBusy = false
    }
  }

  async function resetExportDirectory() {
    if (!isTauri()) return

    exportSettingsStatus = ''
    exportSettingsStatusIsError = false
    exportSettingsBusy = true

    try {
      exportSettings = await invoke<ExportSettings>('reset_export_directory')
      exportSettingsStatus = `Exports save to ${exportSettings.exportDirectory}`
    } catch (error) {
      exportSettingsStatusIsError = true
      exportSettingsStatus = error instanceof Error ? error.message : String(error)
    } finally {
      exportSettingsBusy = false
    }
  }

  function handleGlobalKeydown(event: KeyboardEvent) {
    const key = event.key.toLowerCase()
    const primaryModifier = event.metaKey || event.ctrlKey

    if (event.key === 'Escape' && selectedPlanItemIds.length > 0) {
      event.preventDefault()
      clearPlanSelection()
      return
    }

    if (
      view === 'today' &&
      activePlan &&
      selectedPlanItemIds.length > 0 &&
      !event.shiftKey &&
      !event.altKey &&
      !primaryModifier &&
      (event.key === 'ArrowUp' || event.key === 'ArrowDown')
    ) {
      event.preventDefault()
      event.stopPropagation()
      focusSelectedPlanBoundary(event.key === 'ArrowUp' ? 'up' : 'down')
      return
    }

    if (
      view === 'today' &&
      activePlan &&
      selectedPlanItemIds.length > 0 &&
      event.shiftKey &&
      !event.altKey &&
      !primaryModifier &&
      (event.key === 'ArrowUp' || event.key === 'ArrowDown')
    ) {
      event.preventDefault()
      event.stopPropagation()
      extendPlanSelectionByKeyboard(event.key === 'ArrowUp' ? 'up' : 'down')
      return
    }

    if (
      view === 'today' &&
      activePlan &&
      selectedPlanItemIds.length > 0 &&
      (event.key === 'Backspace' || event.key === 'Delete')
    ) {
      event.preventDefault()
      deleteSelectedPlanItems()
      return
    }

    if (view === 'today' && event.altKey && !primaryModifier && !event.shiftKey) {
      if (activePlan && selectedPlanItemIds.length > 0 && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        const rootIds = selectedPlanRootIds()
        if (rootIds.length === 0) return

        event.preventDefault()
        plannerStore.movePlanItemsWithinLevel(activePlan.id, rootIds, event.key === 'ArrowUp' ? 'up' : 'down')
        return
      }

      if (event.code === 'KeyQ') {
        event.preventDefault()
        shiftActivePlanDate(-1)
        return
      }

      if (event.code === 'KeyW') {
        event.preventDefault()
        shiftActivePlanDate(1)
        return
      }
    }

    if (!primaryModifier || event.altKey) return

    if (view === 'today' && activePlan && key === 'd' && !event.shiftKey && selectedPlanItemIds.length > 0) {
      const selectedItems = selectedPlanItems()
      if (selectedItems.length === 0) return

      event.preventDefault()
      plannerStore.patchPlanItemsDone(
        activePlan.id,
        selectedItems.map((item) => item.id),
        !selectedItems.every((item) => item.done),
      )
      return
    }

    if (view === 'today' && activePlan && !hasActiveRichTextSelection()) {
      if ((key === 'c' || key === 'x') && !event.shiftKey && selectedPlanItemIds.length > 0) {
        event.preventDefault()
        if (key === 'x') {
          cutSelectedPlanItems()
        } else {
          copySelectedPlanItems()
        }
        return
      }

      if (key === 'v' && !event.shiftKey && planItemClipboard) {
        event.preventDefault()
        pastePlanItemClipboard()
        return
      }

      if (key === 'a' && !event.shiftKey && !isRichTextActive()) {
        event.preventDefault()
        selectAllPlanItems()
        return
      }
    }

    if (key === 'd' && !event.shiftKey) {
      const itemId = activeFocusedPlanItemId()
      const item = itemId && activePlan ? findPlanItem(activePlan.items, itemId) : null
      if (!activePlan || !item) return

      event.preventDefault()
      plannerStore.patchPlanItem(activePlan.id, item.id, { done: !item.done })
      return
    }

    if (key === 'z' && !event.shiftKey) {
      event.preventDefault()
      void plannerStore.undo()
      return
    }

    if (event.shiftKey && (key === 'z' || key === 'c')) {
      event.preventDefault()
      void plannerStore.redo()
    }
  }

  function activeFocusedPlanItemId(): string | null {
    if (view !== 'today') return null

    const active = document.activeElement
    const row = active instanceof Element ? active.closest<HTMLElement>('[data-plan-item-id]') : null
    return row?.dataset.planItemId ?? null
  }

  function findPlanItem(items: PlanItem[], itemId: string): PlanItem | null {
    for (const item of items) {
      if (item.id === itemId) return item
      const child = findPlanItem(item.children, itemId)
      if (child) return child
    }

    return null
  }

  function beginPlanItemSelection(itemId: Id, event: PointerEvent) {
    if (event.button !== 0 || !activePlan) return

    event.preventDefault()
    event.stopPropagation()
    selectingPlanItems = true
    selectedPlanPlanId = activePlan.id
    releaseTextEditingFocus()

    if (event.shiftKey && planSelectionAnchorId) {
      selectPlanItemRange(planSelectionAnchorId, itemId, event.metaKey || event.ctrlKey)
      return
    }

    planSelectionAnchorId = itemId

    if (event.metaKey || event.ctrlKey) {
      selectedPlanItemIds = selectedPlanItemIds.includes(itemId)
        ? selectedPlanItemIds.filter((selectedId) => selectedId !== itemId)
        : [...selectedPlanItemIds, itemId]
      planSelectionFocusId = itemId
      return
    }

    selectedPlanItemIds = [itemId]
    planSelectionFocusId = itemId
  }

  function extendPlanItemSelection(itemId: Id) {
    if (!selectingPlanItems || !planSelectionAnchorId) return
    selectPlanItemRange(planSelectionAnchorId, itemId, false)
  }

  function handlePlanSelectionPointerMove(event: PointerEvent) {
    if (!selectingPlanItems && planTextDragOrigin && (event.buttons & 1) === 1 && pointerLeftElement(event, planTextDragOrigin.input)) {
      event.preventDefault()
      selectingPlanItems = true
      selectedPlanPlanId = activePlan?.id ?? null
      planSelectionAnchorId = planTextDragOrigin.itemId
      planSelectionFocusId = planTextDragOrigin.itemId
      selectedPlanItemIds = [planTextDragOrigin.itemId]
      releaseTextEditingFocus()
    }

    if (!selectingPlanItems) return

    const itemId = planItemIdAtPoint(event.clientX, event.clientY)
    if (itemId) extendPlanItemSelection(itemId)
  }

  function endPlanItemSelection() {
    if (selectingPlanItems && selectedPlanItemIds.length > 0) {
      preservePlanSelectionFocusUntil = Date.now() + 250
    }

    selectingPlanItems = false
    planTextDragOrigin = null
  }

  function handleGlobalPointerDown(event: PointerEvent) {
    if (event.button !== 0 || view !== 'today' || !activePlan) {
      planTextDragOrigin = null
      return
    }

    const target = event.target instanceof Element ? event.target : null
    const input = target?.closest<HTMLElement>('[data-plan-text-input]')
    const row = input?.closest<HTMLElement>('[data-plan-item-id]')
    const itemId = row?.dataset.planItemId

    if (event.shiftKey && input && itemId) {
      const focusedItemId = activeFocusedPlanItemId()

      if (focusedItemId && focusedItemId !== itemId) {
        event.preventDefault()
        event.stopPropagation()
        planSelectionAnchorId = focusedItemId
        selectPlanItemRange(focusedItemId, itemId, false)
        planTextDragOrigin = null
        return
      }
    }

    planTextDragOrigin = input && itemId ? { itemId, input } : null
  }

  function handleGlobalFocusIn(event: FocusEvent) {
    const target = event.target instanceof Element ? event.target : null
    if (!target?.closest('input, textarea, [contenteditable="true"]')) return

    if (selectedPlanItemIds.length > 0 && (selectingPlanItems || Date.now() < preservePlanSelectionFocusUntil)) {
      releaseTextEditingFocus()
      return
    }

    clearPlanSelection()
  }

  function selectPlanItemRange(fromId: Id, toId: Id, additive: boolean) {
    if (!activePlan) return

    const itemIds = flattenPlanItemIds(activePlan.items)
    const fromIndex = itemIds.indexOf(fromId)
    const toIndex = itemIds.indexOf(toId)
    if (fromIndex === -1 || toIndex === -1) return

    const [start, end] = fromIndex < toIndex ? [fromIndex, toIndex] : [toIndex, fromIndex]
    const rangeIds = itemIds.slice(start, end + 1)
    selectedPlanItemIds = additive ? [...new Set([...selectedPlanItemIds, ...rangeIds])] : rangeIds
    selectedPlanPlanId = activePlan.id
    planSelectionFocusId = toId
    releaseTextEditingFocus()
  }

  function selectPlanItemWithAdjacent(itemId: Id, direction: MoveDirection) {
    if (!activePlan) return

    const itemIds = flattenPlanItemIds(activePlan.items)
    const index = itemIds.indexOf(itemId)
    if (index === -1) return

    const targetIndex = direction === 'up' ? Math.max(0, index - 1) : Math.min(itemIds.length - 1, index + 1)
    if (targetIndex === index) return

    planSelectionAnchorId = itemId
    selectPlanItemRange(itemId, itemIds[targetIndex], false)
  }

  function extendPlanSelectionByKeyboard(direction: MoveDirection) {
    if (!activePlan) return

    const itemIds = flattenPlanItemIds(activePlan.items)
    const anchorId = planSelectionAnchorId ?? selectedPlanItemIds[0]
    const focusId = planSelectionFocusId ?? selectedPlanItemIds.at(-1)
    const focusIndex = focusId ? itemIds.indexOf(focusId) : -1
    if (!anchorId || focusIndex === -1) return

    const targetIndex = direction === 'up' ? Math.max(0, focusIndex - 1) : Math.min(itemIds.length - 1, focusIndex + 1)
    const targetId = itemIds[targetIndex]
    if (targetId === anchorId) {
      clearPlanSelection()
      focusPlanItemTextInput(anchorId)
      return
    }

    selectPlanItemRange(anchorId, targetId, false)
  }

  function selectAllPlanItems() {
    if (!activePlan) return

    selectedPlanItemIds = flattenPlanItemIds(activePlan.items)
    selectedPlanPlanId = activePlan.id
    planSelectionAnchorId = selectedPlanItemIds[0] ?? null
    planSelectionFocusId = selectedPlanItemIds.at(-1) ?? null
    releaseTextEditingFocus()
  }

  function clearPlanSelection() {
    selectedPlanItemIds = []
    selectedPlanPlanId = null
    planSelectionAnchorId = null
    planSelectionFocusId = null
    selectingPlanItems = false
  }

  function flattenPlanItemIds(items: PlanItem[]): Id[] {
    return items.flatMap((item) => [item.id, ...flattenPlanItemIds(item.children)])
  }

  function planItemIdAtPoint(clientX: number, clientY: number): Id | null {
    const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-plan-item-id]'))

    for (const row of rows) {
      const rect = row.getBoundingClientRect()
      const isInsideRow = clientY >= rect.top && clientY <= rect.bottom && clientX >= rect.left && clientX <= rect.right
      if (isInsideRow) return row.dataset.planItemId ?? null
    }

    return null
  }

  function pointerLeftElement(event: PointerEvent, element: HTMLElement) {
    const rect = element.getBoundingClientRect()
    const threshold = 3

    return (
      event.clientX < rect.left - threshold ||
      event.clientX > rect.right + threshold ||
      event.clientY < rect.top - threshold ||
      event.clientY > rect.bottom + threshold
    )
  }

  function selectedPlanRootIds() {
    if (!activePlan) return []

    return plannerStore.copyPlanItems(activePlan.id, selectedPlanItemIds).map((item) => item.id)
  }

  function selectedPlanItems() {
    if (!activePlan) return []

    return selectedPlanItemIds
      .map((itemId) => findPlanItem(activePlan.items, itemId))
      .filter((item): item is PlanItem => item !== null)
  }

  function focusSelectedPlanBoundary(direction: MoveDirection) {
    if (!activePlan) return

    const selectedIds = new Set(selectedPlanItemIds)
    const orderedSelectedIds = flattenPlanItemIds(activePlan.items).filter((itemId) => selectedIds.has(itemId))
    const targetId = direction === 'up' ? orderedSelectedIds[0] : orderedSelectedIds.at(-1)
    if (!targetId) return

    clearPlanSelection()
    focusPlanItemTextInput(targetId)
  }

  function copySelectedPlanItems() {
    if (!activePlan || selectedPlanItemIds.length === 0) return

    const items = plannerStore.copyPlanItems(activePlan.id, selectedPlanItemIds)
    if (items.length === 0) return

    planItemClipboard = { items, cut: false }
    writePlanItemsToSystemClipboard(items)
  }

  function cutSelectedPlanItems() {
    if (!activePlan || selectedPlanItemIds.length === 0) return

    const items = plannerStore.cutPlanItems(activePlan.id, selectedPlanItemIds)
    if (items.length === 0) return

    planItemClipboard = { items, cut: true }
    writePlanItemsToSystemClipboard(items)
    clearPlanSelection()
  }

  function deleteSelectedPlanItems() {
    if (!activePlan || selectedPlanItemIds.length === 0) return

    const deletedIds = plannerStore.deletePlanItems(activePlan.id, selectedPlanItemIds)
    if (deletedIds.length > 0) clearPlanSelection()
  }

  function pastePlanItemClipboard() {
    if (!activePlan || !planItemClipboard) return

    const targetId = pasteTargetPlanItemId()
    const pastedRootIds = plannerStore.pastePlanItems(activePlan.id, planItemClipboard.items, targetId, 'after')
    if (pastedRootIds.length === 0) return

    selectedPlanItemIds = pastedRootIds
    selectedPlanPlanId = activePlan.id
    planSelectionAnchorId = pastedRootIds.at(-1) ?? null
    planSelectionFocusId = pastedRootIds.at(-1) ?? null
    releaseTextEditingFocus()
    if (planItemClipboard.cut) planItemClipboard = null
  }

  function pasteTargetPlanItemId() {
    const focusedItemId = activeFocusedPlanItemId()
    if (focusedItemId) return focusedItemId

    const rootIds = selectedPlanRootIds()
    return rootIds.at(-1) ?? null
  }

  function writePlanItemsToSystemClipboard(items: PlanItem[]) {
    const text = planItemsToPlainText(items)
    if (!text || !navigator.clipboard?.writeText) return

    void navigator.clipboard.writeText(text).catch(() => {
      // The internal clipboard still works when system clipboard access is blocked.
    })
  }

  function planItemsToPlainText(items: PlanItem[], depth = 0): string {
    return items
      .map((item) => {
        const line = `${'  '.repeat(depth)}${item.text}`
        const children = planItemsToPlainText(item.children, depth + 1)
        return children ? `${line}\n${children}` : line
      })
      .join('\n')
  }

  function isRichTextActive() {
    return document.activeElement instanceof HTMLElement && document.activeElement.matches('[data-rich-text-input]')
  }

  function hasActiveRichTextSelection() {
    const selection = document.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false

    const active = document.activeElement
    const input = active instanceof HTMLElement ? active.closest('[data-rich-text-input]') : null
    if (!input) return false

    const range = selection.getRangeAt(0)
    return input.contains(range.commonAncestorContainer)
  }

  function releaseTextEditingFocus() {
    document.getSelection()?.removeAllRanges()

    if (document.activeElement instanceof HTMLElement && document.activeElement.closest('input, textarea, [contenteditable="true"]')) {
      document.activeElement.blur()
    }
  }

  function focusPlanItemTextInput(itemId: Id) {
    const input = document.querySelector<HTMLDivElement>(`[data-plan-text-input-id="${CSS.escape(itemId)}"]`)
    if (!input) return

    input.focus()
    const range = document.createRange()
    range.selectNodeContents(input)
    range.collapse(false)

    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }

  async function copyRecoveryKey() {
    if (!recoveryKeyStatus?.recoveryKey) return

    await navigator.clipboard.writeText(recoveryKeyStatus.recoveryKey)
    recoveryKeyCopied = true
  }

  async function finishRecoveryKeySetup() {
    await confirmRecoveryKey()
    recoveryKeyStatus = await getRecoveryKeyStatus()
    recoveryKeySaved = false
  }

  async function startDailyReminderEdit() {
    if (!activePlan) return

    dailyReminderDraft = activePlan.dailyReminder
    editingDailyReminder = true
    await tick()
    dailyReminderInput?.focus()
    dailyReminderInput?.select()
  }

  function updateDailyReminder(value: string) {
    dailyReminderDraft = value
    if (activePlan) plannerStore.patchPlanDailyReminder(activePlan.id, value)
  }

  function handleDailyReminderKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault()
      dailyReminderInput?.blur()
    }
  }
</script>

<svelte:window
  on:keydown|capture={handleGlobalKeydown}
  on:focusin={handleGlobalFocusIn}
  on:pointerdown|capture={handleGlobalPointerDown}
  on:pointermove={handlePlanSelectionPointerMove}
  on:pointerup={endPlanItemSelection}
/>

<main class="app-shell">
  <aside class="sidebar">
    <div>
      <h1>Balance</h1>
      <p class="muted">Local-first daily planning</p>
    </div>

    <nav aria-label="Primary">
      <button class:active={view === 'today'} type="button" on:click={() => (view = 'today')}>Today</button>
      <button class:active={view === 'templates'} type="button" on:click={() => (view = 'templates')}>Templates</button>
      <button class:active={view === 'history'} type="button" on:click={() => (view = 'history')}>History</button>
      <button class:active={view === 'export'} type="button" on:click={() => (view = 'export')}>Export</button>
      <button class:active={view === 'settings'} type="button" on:click={() => (view = 'settings')}>Settings</button>
    </nav>

    <div class="sidebar-footer">
      <button class="primary" type="button" on:click={generateSelectedDay}>{generateButtonLabel}</button>
      <p class="tiny">{templates.length} template · {$plannerStore.plans.length} saved days</p>
    </div>
  </aside>

  <section class="workspace">
    {#if view === 'today'}
      <header class="page-header">
        <div>
          <p class="eyebrow">Daily plan</p>
          <h2>
            {activePlan?.title ?? formatPlanTitle($plannerStore.activePlanDate)}
            {#if editingDailyReminder && activePlan}
              <span class="daily-reminder-prefix">—</span>
              <input
                bind:this={dailyReminderInput}
                class="daily-reminder-input"
                aria-label="Edit daily reminder"
                value={dailyReminderDraft}
                on:input={(event) => updateDailyReminder(event.currentTarget.value)}
                on:blur={() => (editingDailyReminder = false)}
                on:keydown={handleDailyReminderKeydown}
              />
            {:else}
              <button
                class="daily-reminder-button"
                type="button"
                title={activePlan ? 'Edit daily reminder' : 'Generate a day before editing the reminder'}
                on:click={startDailyReminderEdit}
              >
                — {activeDailyReminder}
              </button>
            {/if}
          </h2>
        </div>
        <div class="date-controls" aria-label="Day navigation">
          <button
            class="date-nav-button"
            type="button"
            aria-label="Previous day"
            title="Previous day (Option+Q)"
            on:click={() => shiftActivePlanDate(-1)}
          >
            &lt;
          </button>
          <button
            class="date-nav-button"
            type="button"
            aria-label="Next day"
            title="Next day (Option+W)"
            on:click={() => shiftActivePlanDate(1)}
          >
            &gt;
          </button>
          <input
            class="date-input"
            type="date"
            value={$plannerStore.activePlanDate}
            on:input={(event) => plannerStore.setActivePlanDate(event.currentTarget.value)}
          />
        </div>
      </header>

      {#if activePlan}
        <div class="list-panel">
          {#if activePlan.items.length === 0}
            <p class="empty">No items yet.</p>
          {/if}

          {#each activePlan.items as item (item.id)}
            <PlanItemEditor
              {item}
              allItems={activePlan.items}
              planId={activePlan.id}
              patchItem={plannerStore.patchPlanItem}
              splitItem={plannerStore.splitPlanItem}
              backspaceItemAtStart={plannerStore.backspacePlanItemAtStart}
              addChild={plannerStore.addPlanChild}
              deleteItem={plannerStore.deletePlanItem}
              moveItem={plannerStore.movePlanItem}
              moveItemWithinLevel={plannerStore.movePlanItemWithinLevel}
              outdentItem={plannerStore.outdentPlanItem}
              historyRevision={$plannerStore.historyRevision}
              selectedItemIds={selectedPlanItemIdSet}
              selectionDragging={selectingPlanItems}
              onSelectionPointerDown={beginPlanItemSelection}
              onSelectionPointerMove={handlePlanSelectionPointerMove}
              onSelectionPointerEnter={extendPlanItemSelection}
              onTextShiftArrow={selectPlanItemWithAdjacent}
            />
          {/each}

          <button class="add-row" type="button" on:click={() => plannerStore.addRootPlanItem(activePlan.id)}>
            + Add item
          </button>
        </div>
      {:else}
        <div class="empty-state">
          <h3>No plan for this date</h3>
          <p>Generate one from the template, or switch to a saved day in History.</p>
          <button class="primary" type="button" on:click={generateSelectedDay}>{generateButtonLabel}</button>
        </div>
      {/if}
    {/if}

    {#if view === 'templates'}
      <header class="page-header">
        <div>
          <p class="eyebrow">Generator</p>
          <h2>Daily template</h2>
        </div>
        {#if selectedTemplate}
          <select bind:value={selectedTemplateId} aria-label="Select template">
            {#each templates as template (template.id)}
              <option value={template.id}>{template.name}</option>
            {/each}
          </select>
        {/if}
      </header>

      {#if selectedTemplate}
        <div class="template-panel">
          <label class="field-label" for="template-name">Template name</label>
          <input
            id="template-name"
            class="title-input"
            value={selectedTemplate.name}
            on:input={(event) => plannerStore.renameTemplate(selectedTemplate.id, event.currentTarget.value)}
          />

          <div class="template-list">
            {#each selectedTemplate.items as item (item.id)}
              <TemplateItemEditor
                {item}
                allItems={selectedTemplate.items}
                templateId={selectedTemplate.id}
                patchItem={plannerStore.patchTemplateItem}
                splitItem={plannerStore.splitTemplateItem}
                deleteItem={plannerStore.deleteTemplateItem}
                moveItem={plannerStore.moveTemplateItem}
                moveItemWithinLevel={plannerStore.moveTemplateItemWithinLevel}
                outdentItem={plannerStore.outdentTemplateItem}
                addChild={plannerStore.addTemplateChild}
                addOption={plannerStore.addTemplateOption}
                patchOption={plannerStore.patchTemplateOption}
                deleteOption={plannerStore.deleteTemplateOption}
                historyRevision={$plannerStore.historyRevision}
              />
            {/each}
          </div>

          <button class="add-row" type="button" on:click={() => plannerStore.addRootTemplateItem(selectedTemplate.id)}>
            + Add template item
          </button>
        </div>
      {/if}
    {/if}

    {#if view === 'history'}
      <header class="page-header">
        <div>
          <p class="eyebrow">Archive</p>
          <h2>Saved days</h2>
        </div>
      </header>

      <div class="history-grid">
        {#each $plannerStore.plans as plan (plan.id)}
          <button
            class="history-card"
            type="button"
            on:click={() => {
              plannerStore.setActivePlanDate(plan.date)
              view = 'today'
            }}
          >
            <strong>{plan.title}</strong>
            <span>{plan.date}</span>
            <small>{plan.items.length} top-level items</small>
          </button>
        {:else}
          <p class="empty">Generated plans will show up here.</p>
        {/each}
      </div>
    {/if}

    {#if view === 'export'}
      <header class="page-header">
        <div>
          <p class="eyebrow">Portability</p>
          <h2>Export everything</h2>
        </div>
      </header>

      <div class="export-panel">
        <div>
          <h3>Canonical JSON</h3>
          <p>Full app state, including templates, generated plans, and the operation log.</p>
          <button class="primary" type="button" on:click={downloadJSON}>Export JSON</button>
        </div>

        <div>
          <h3>Readable HTML</h3>
          <p>A simple history document with every saved daily plan.</p>
          <button type="button" on:click={downloadHTML}>Export HTML</button>
        </div>
      </div>

      {#if exportStatusIsError && exportStatus}
        <p class:error={exportStatusIsError} class="export-status">{exportStatus}</p>
      {:else if exportSavedPath}
        <p class="export-status">
          Saved to
          <button class="path-link" type="button" on:click={revealSavedExport}>{exportSavedPath}</button>
        </p>
      {:else if exportStatus}
        <p class:error={exportStatusIsError} class="export-status">{exportStatus}</p>
      {/if}
    {/if}

    {#if view === 'settings'}
      <header class="page-header">
        <div>
          <p class="eyebrow">Preferences</p>
          <h2>Settings</h2>
        </div>
      </header>

      <div class="settings-panel">
        <section class="settings-section">
          <div>
            <h3>Export folder</h3>
            {#if isTauri()}
              <p>
                {exportSettings?.usesDefaultExportDirectory
                  ? 'Using the default downloads folder.'
                  : 'Using a custom folder.'}
              </p>
            {:else}
              <p>Browser preview exports use the browser download location.</p>
            {/if}
          </div>

          <div class="path-row">
            <span>{exportSettings?.exportDirectory ?? 'Browser downloads'}</span>
          </div>

          {#if isTauri()}
            <div class="settings-actions">
              <button class="primary" type="button" disabled={exportSettingsBusy} on:click={chooseExportDirectory}>
                Choose folder
              </button>
              <button
                type="button"
                disabled={exportSettingsBusy || Boolean(exportSettings?.usesDefaultExportDirectory)}
                on:click={resetExportDirectory}
              >
                Reset to downloads
              </button>
            </div>
          {/if}
        </section>
      </div>

      {#if exportSettingsStatus}
        <p class:error={exportSettingsStatusIsError} class="export-status">{exportSettingsStatus}</p>
      {/if}
    {/if}
  </section>
</main>

{#if recoveryKeyStatus?.recoveryKey}
  <div class="modal-backdrop">
    <div class="recovery-dialog" role="dialog" aria-modal="true" aria-labelledby="recovery-title">
      <p class="eyebrow">Encryption</p>
      <h2 id="recovery-title">Save your recovery key</h2>
      <p class="recovery-copy">
        This key unlocks your encrypted Balance database from a backup or another device. Keep it somewhere private;
        Balance cannot recover it for you.
      </p>

      <div class="recovery-key" aria-label="Recovery key">{recoveryKeyStatus.recoveryKey}</div>

      <div class="recovery-actions">
        <button type="button" on:click={copyRecoveryKey}>{recoveryKeyCopied ? 'Copied' : 'Copy key'}</button>
        <label class="confirm-line">
          <input type="checkbox" bind:checked={recoveryKeySaved} />
          <span>I saved this recovery key somewhere safe.</span>
        </label>
        <button class="primary" type="button" disabled={!recoveryKeySaved} on:click={finishRecoveryKeySetup}>
          Continue
        </button>
      </div>

      <p class="database-path">Database: {recoveryKeyStatus.databasePath}</p>
    </div>
  </div>
{/if}
