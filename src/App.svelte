<script lang="ts">
  import { invoke, isTauri } from '@tauri-apps/api/core'
  import { confirm as confirmDialog, open as openDialog } from '@tauri-apps/plugin-dialog'
  import { onMount, tick } from 'svelte'
  import GoalHistoryPanel from './lib/GoalHistoryPanel.svelte'
  import PlanItemEditor from './lib/PlanItemEditor.svelte'
  import TemplateItemEditor from './lib/TemplateItemEditor.svelte'
  import { hueToHex, isGoalActiveOnDate, parseMatchTerms, sortGoalsByUrgency } from './lib/goals'
  import {
    confirmRecoveryKey,
    exportHTML,
    exportJSON,
    getRecoveryKeyStatus,
    inspectDatabase,
    listMetadata,
    listRecoveryEntries,
    persistenceError,
    plannerStore,
  } from './lib/store'
  import type { DatabaseHistoryEntry, DatabaseInspection, DatabaseOperationEntry, MetadataEntry, RecoveryEntry, RecoveryKeyStatus } from './lib/store'
  import type { Id, MoveDirection, PlanItem } from './lib/types'
  import { DEFAULT_DAILY_REMINDER, formatPlanTitle, todayISO } from './lib/planner'

  type View = 'today' | 'templates' | 'goals' | 'history' | 'export' | 'settings'
  type ExportSettings = {
    exportDirectory: string
    defaultExportDirectory: string
    usesDefaultExportDirectory: boolean
    autoJsonExportEnabled: boolean
    autoJsonExportTime: string
    lastAutoJsonExportDate: string | null
    lastAutoJsonExportPath: string | null
    lastAutoJsonExportError: string | null
    lastAutoJsonExportErrorAt: string | null
    autoJsonExportErrorAckAt: string | null
  }

  const AUTO_JSON_EXPORT_CHECK_INTERVAL_MS = 15 * 60 * 1000
  const GOAL_HISTORY_HEIGHT_KEY = 'balance:goalHistoryHeight'

  let view: View = 'today'
  let goalHistoryHeight: number | null = null
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
  let autoJsonExportBusy = false
  let autoJsonExportTimer: number | null = null
  let autoJsonExportCheckTimer: number | null = null
  let recoveryPanelOpen = false
  let recoveryEntries: RecoveryEntry[] = []
  let recoveryBusy = false
  let recoveryStatus = ''
  let recoveryStatusIsError = false
  let recoveryExpandedId: string | null = null
  let metadataEntries: MetadataEntry[] = []
  let databaseInspection: DatabaseInspection | null = null
  let databaseInspectionBusy = false
  let databaseInspectionError = ''
  let databaseSearch = ''
  let databaseExpandedId: string | null = null
  let databaseCopyStatus = ''
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
  let newGoalName = ''
  let newGoalCadenceDays = 1
  let newGoalTerms = ''
  let newGoalHue = 165
  let newGoalNeutral = false
  let goalFormStatus = ''

  const NEUTRAL_SWATCH = '#9aa0a6'

  $: templates = $plannerStore.templates
  $: activePlan = $plannerStore.plans.find((plan) => plan.date === $plannerStore.activePlanDate)
  $: activeDailyReminder = activePlan?.dailyReminder ?? DEFAULT_DAILY_REMINDER
  $: if (!editingDailyReminder) dailyReminderDraft = activeDailyReminder
  $: selectedTemplate = templates.find((template) => template.id === selectedTemplateId) ?? templates[0]
  $: if (!selectedTemplateId && templates[0]) selectedTemplateId = templates[0].id
  $: generateButtonLabel = $plannerStore.activePlanDate === todayISO() ? 'Generate today' : 'Generate selected day'
  $: selectedPlanItemIdSet = new Set(selectedPlanItemIds)
  $: activeGoalCount = $plannerStore.goals.filter((goal) => isGoalActiveOnDate(goal, todayISO())).length
  $: sortedGoals = sortGoalsByUrgency($plannerStore.goals, $plannerStore.goalCompletions, todayISO())
  $: showAutoExportError = Boolean(
    exportSettings?.lastAutoJsonExportError &&
      exportSettings.lastAutoJsonExportErrorAt &&
      exportSettings.lastAutoJsonExportErrorAt !== exportSettings.autoJsonExportErrorAckAt,
  )
  $: if ((view !== 'today' || activePlan?.id !== selectedPlanPlanId) && selectedPlanItemIds.length > 0) {
    clearPlanSelection()
  }
  $: filteredDatabaseOperations = filterDatabaseRows(databaseInspection?.operations ?? [], databaseSearch)
  $: filteredDatabaseHistoryEntries = filterDatabaseRows(databaseInspection?.historyEntries ?? [], databaseSearch)
  $: filteredDatabasePlans = filterDatabaseRows(databaseInspection?.plans ?? [], databaseSearch)

  onMount(() => {
    let mounted = true

    const storedGoalHistoryHeight = Number(localStorage.getItem(GOAL_HISTORY_HEIGHT_KEY))
    if (Number.isFinite(storedGoalHistoryHeight) && storedGoalHistoryHeight > 0) {
      goalHistoryHeight = clampGoalHistoryHeight(storedGoalHistoryHeight)
    }

    const checkAutoJsonExport = () => {
      if (!mounted) return
      void runAutoJsonExportCatchup()
    }
    const checkVisibleAutoJsonExport = () => {
      if (document.visibilityState === 'visible') checkAutoJsonExport()
    }

    async function initialize() {
      recoveryKeyStatus = await getRecoveryKeyStatus()
      await plannerStore.ready
      await loadExportSettings()

      if (!mounted || !isTauri()) return

      window.addEventListener('focus', checkAutoJsonExport)
      document.addEventListener('visibilitychange', checkVisibleAutoJsonExport)
      restartAutoJsonExportScheduler()
    }

    void initialize()

    return () => {
      mounted = false
      clearAutoJsonExportTimers()
      window.removeEventListener('focus', checkAutoJsonExport)
      document.removeEventListener('visibilitychange', checkVisibleAutoJsonExport)
    }
  })

  function clampGoalHistoryHeight(value: number): number {
    return Math.max(140, Math.min(window.innerHeight * 0.7, value))
  }

  function startGoalHistoryResize(event: PointerEvent) {
    event.preventDefault()

    const handle = event.currentTarget as HTMLElement | null
    const panel = handle?.closest('.goal-history-panel') as HTMLElement | null
    const shell = handle?.closest('.content-shell') as HTMLElement | null
    const startY = event.clientY
    const startHeight = goalHistoryHeight ?? panel?.getBoundingClientRect().height ?? 230
    let nextHeight = startHeight
    let frame = 0

    handle?.setPointerCapture?.(event.pointerId)
    document.body.style.userSelect = 'none'

    // While dragging, write the CSS variable straight to the DOM (rAF-coalesced) instead of
    // mutating the reactive `goalHistoryHeight`, which would re-render the whole App component on
    // every pointermove. We commit to reactive state + persist only once on pointerup.
    const onMove = (move: PointerEvent) => {
      nextHeight = clampGoalHistoryHeight(startHeight + (startY - move.clientY))
      if (frame === 0) {
        frame = requestAnimationFrame(() => {
          frame = 0
          shell?.style.setProperty('--goal-history-height', `${nextHeight}px`)
        })
      }
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (frame !== 0) cancelAnimationFrame(frame)
      document.body.style.userSelect = ''
      goalHistoryHeight = nextHeight
      localStorage.setItem(GOAL_HISTORY_HEIGHT_KEY, String(nextHeight))
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

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

  function addGoal() {
    const name = newGoalName.trim()
    const matchTerms = parseMatchTerms(newGoalTerms)
    if (!name || matchTerms.length === 0) {
      goalFormStatus = 'Add a name and at least one matching word or phrase.'
      return
    }

    plannerStore.addGoal(name, newGoalCadenceDays, matchTerms, newGoalHue, newGoalNeutral)
    newGoalName = ''
    newGoalCadenceDays = 1
    newGoalTerms = ''
    newGoalHue = (newGoalHue + 47) % 360
    newGoalNeutral = false
    goalFormStatus = ''
  }

  async function confirmDeleteGoal(goalId: Id, goalName: string) {
    const completionCount = $plannerStore.goalCompletions.filter((completion) => completion.goalId === goalId).length
    const firstMessage =
      completionCount > 0
        ? `“${goalName}” has ${completionCount} saved completion${completionCount === 1 ? '' : 's'}. Archiving it keeps that history visible when you scroll back. Delete it and all of its history anyway?`
        : `Delete “${goalName}”?`
    const confirmed = isTauri()
      ? await confirmDialog(firstMessage, { title: completionCount > 0 ? 'Archive instead?' : 'Delete goal?', kind: 'warning' })
      : window.confirm(firstMessage)
    if (!confirmed) return

    if (completionCount > 0) {
      const finalMessage = `Permanently delete “${goalName}” and its ${completionCount} saved completion${completionCount === 1 ? '' : 's'}?`
      const finalConfirmed = isTauri()
        ? await confirmDialog(finalMessage, { title: 'Permanently delete goal?', kind: 'warning' })
        : window.confirm(finalMessage)
      if (!finalConfirmed) return
    }

    plannerStore.deleteGoal(goalId)
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

  async function saveTauriExportFile(filename: string, content: string): Promise<string> {
    return invoke<string>('save_export_file', { filename, content })
  }

  async function download(filename: string, content: string, type: string) {
    exportStatus = ''
    exportStatusIsError = false
    exportSavedPath = ''

    if (isTauri()) {
      try {
        const savedPath = await saveTauriExportFile(filename, content)
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

  async function loadExportSettings(): Promise<ExportSettings | null> {
    if (!isTauri()) return null

    try {
      exportSettings = await invoke<ExportSettings>('get_export_settings')
      return exportSettings
    } catch (error) {
      exportSettingsStatusIsError = true
      exportSettingsStatus = error instanceof Error ? error.message : String(error)
      return null
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
        restartAutoJsonExportScheduler()
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
      restartAutoJsonExportScheduler()
    } catch (error) {
      exportSettingsStatusIsError = true
      exportSettingsStatus = error instanceof Error ? error.message : String(error)
    } finally {
      exportSettingsBusy = false
    }
  }

  async function updateAutoJsonExportSettings(enabled: boolean, time: string) {
    if (!isTauri()) return

    exportSettingsStatus = ''
    exportSettingsStatusIsError = false
    autoJsonExportBusy = true

    try {
      exportSettings = await invoke<ExportSettings>('set_auto_json_export_settings', { enabled, time })
      exportSettingsStatus = exportSettings.autoJsonExportEnabled
        ? `Automatic JSON export runs at ${exportSettings.autoJsonExportTime}.`
        : 'Automatic JSON export is disabled.'
      restartAutoJsonExportScheduler()
    } catch (error) {
      exportSettingsStatusIsError = true
      exportSettingsStatus = error instanceof Error ? error.message : String(error)
    } finally {
      autoJsonExportBusy = false
    }
  }

  function clearAutoJsonExportTimers() {
    if (autoJsonExportTimer !== null) {
      window.clearTimeout(autoJsonExportTimer)
      autoJsonExportTimer = null
    }

    if (autoJsonExportCheckTimer !== null) {
      window.clearInterval(autoJsonExportCheckTimer)
      autoJsonExportCheckTimer = null
    }
  }

  function restartAutoJsonExportScheduler() {
    clearAutoJsonExportTimers()

    if (!isTauri() || !exportSettings?.autoJsonExportEnabled) return

    void runAutoJsonExportCatchup()
    scheduleNextAutoJsonExport()
    autoJsonExportCheckTimer = window.setInterval(() => {
      void runAutoJsonExportCatchup()
    }, AUTO_JSON_EXPORT_CHECK_INTERVAL_MS)
  }

  function scheduleNextAutoJsonExport() {
    if (!exportSettings?.autoJsonExportEnabled) return

    if (autoJsonExportTimer !== null) window.clearTimeout(autoJsonExportTimer)

    autoJsonExportTimer = window.setTimeout(() => {
      void (async () => {
        await runAutoJsonExportCatchup()
        scheduleNextAutoJsonExport()
      })()
    }, millisecondsUntilNextAutoJsonExport(exportSettings))
  }

  async function runAutoJsonExportCatchup() {
    if (!isTauri() || autoJsonExportBusy || !exportSettings || !shouldRunAutoJsonExport(exportSettings)) return

    autoJsonExportBusy = true

    try {
      const date = todayISO()
      const savedPath = await saveTauriExportFile(`balance-auto-export-${date}.json`, exportJSON($plannerStore))
      exportSettings = await invoke<ExportSettings>('record_auto_json_export_success', { date, path: savedPath })
      scheduleNextAutoJsonExport()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)

      try {
        exportSettings = await invoke<ExportSettings>('record_auto_json_export_error', { error: message })
      } catch {
        exportSettings = {
          ...exportSettings,
          lastAutoJsonExportError: message,
        }
      }
    } finally {
      autoJsonExportBusy = false
    }
  }

  function shouldRunAutoJsonExport(settings: ExportSettings): boolean {
    // Export once per day. Previously this also required the current time to be past the
    // configured time, so a day where the app wasn't open at that moment was skipped entirely
    // (and never backfilled). Now any launch or periodic check on a not-yet-exported day runs
    // the export, guaranteeing one daily backup whenever the app is opened. The configured time
    // still drives scheduleNextAutoJsonExport for sessions that stay open across the boundary.
    return settings.autoJsonExportEnabled && settings.lastAutoJsonExportDate !== todayISO()
  }

  async function dismissAutoExportError() {
    try {
      exportSettings = await invoke<ExportSettings>('acknowledge_auto_json_export_error')
    } catch {
      // If the ack write fails, hide it locally so we don't nag; a genuinely new failure
      // (new error timestamp) will still resurface because it won't match this ack.
      if (exportSettings) {
        exportSettings = { ...exportSettings, autoJsonExportErrorAckAt: exportSettings.lastAutoJsonExportErrorAt }
      }
    }
  }

  function millisecondsUntilNextAutoJsonExport(settings: ExportSettings): number {
    const scheduledMinutes = parseTimeMinutes(settings.autoJsonExportTime) ?? 23 * 60 + 55
    const now = new Date()
    const target = new Date(now)
    target.setHours(Math.floor(scheduledMinutes / 60), scheduledMinutes % 60, 0, 0)

    if (target.getTime() <= now.getTime() || settings.lastAutoJsonExportDate === todayISO()) {
      target.setDate(target.getDate() + 1)
    }

    return Math.max(1_000, target.getTime() - now.getTime())
  }

  function parseTimeMinutes(time: string): number | null {
    const match = /^(\d{2}):(\d{2})$/.exec(time)
    if (!match) return null

    const hour = Number(match[1])
    const minute = Number(match[2])
    if (hour > 23 || minute > 59) return null

    return hour * 60 + minute
  }

  function handleGlobalKeydown(event: KeyboardEvent) {
    const key = event.key.toLowerCase()
    const primaryModifier = event.metaKey || event.ctrlKey

    if (primaryModifier && event.shiftKey && key === 'p') {
      event.preventDefault()
      void openRecoveryPanel()
      return
    }

    if (event.key === 'Escape' && recoveryPanelOpen) {
      event.preventDefault()
      closeRecoveryPanel()
      return
    }

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

    if (
      view === 'today' &&
      activePlan &&
      selectedPlanItemIds.length > 0 &&
      event.key === 'Tab' &&
      !event.altKey &&
      !primaryModifier &&
      !isRichTextActive()
    ) {
      const rootIds = selectedPlanRootIds()
      if (rootIds.length === 0) return

      event.preventDefault()
      if (event.shiftKey) {
        plannerStore.outdentPlanItems(activePlan.id, rootIds)
      } else {
        plannerStore.indentPlanItems(activePlan.id, rootIds)
      }
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
    const placement = shouldReplaceFocusedPlanItemOnPaste(targetId) ? 'replace' : 'after'
    const pastedRootIds = plannerStore.pastePlanItems(activePlan.id, planItemClipboard.items, targetId, placement)
    if (pastedRootIds.length === 0) return

    selectedPlanItemIds = pastedRootIds
    selectedPlanPlanId = activePlan.id
    planSelectionAnchorId = pastedRootIds.at(-1) ?? null
    planSelectionFocusId = pastedRootIds.at(-1) ?? null
    releaseTextEditingFocus()
    if (planItemClipboard.cut) planItemClipboard = null
  }

  async function openRecoveryPanel() {
    recoveryPanelOpen = true
    recoveryExpandedId = null
    await Promise.all([refreshRecoveryEntries(), refreshMetadata(), refreshDatabaseInspection()])
  }

  async function refreshMetadata() {
    try {
      metadataEntries = await listMetadata()
    } catch (error) {
      metadataEntries = []
      recoveryStatusIsError = true
      recoveryStatus = error instanceof Error ? error.message : String(error)
    }
  }

  async function refreshDatabaseInspection() {
    databaseInspectionBusy = true
    databaseInspectionError = ''
    databaseCopyStatus = ''

    try {
      databaseInspection = await inspectDatabase()
    } catch (error) {
      databaseInspection = null
      databaseInspectionError = error instanceof Error ? error.message : String(error)
    } finally {
      databaseInspectionBusy = false
    }
  }

  function closeRecoveryPanel() {
    recoveryPanelOpen = false
  }

  async function refreshRecoveryEntries() {
    recoveryBusy = true
    recoveryStatus = ''
    recoveryStatusIsError = false

    try {
      recoveryEntries = await listRecoveryEntries()
      if (recoveryEntries.length === 0) {
        recoveryStatus = 'No recoverable history was found.'
      }
    } catch (error) {
      recoveryStatusIsError = true
      recoveryStatus = error instanceof Error ? error.message : String(error)
    } finally {
      recoveryBusy = false
    }
  }

  async function restoreRecoveryEntry(entry: RecoveryEntry) {
    if (recoveryBusy) return

    const confirmed = await confirmDialog(
      `Restore ${entry.restoredItemCount} item${entry.restoredItemCount === 1 ? '' : 's'}${
        entry.preview ? ` (“${entry.preview}”)` : ''
      }? This reverses the action that removed them.`,
      { title: 'Restore items', kind: 'warning' },
    )
    if (!confirmed) return

    recoveryBusy = true
    recoveryStatus = ''
    recoveryStatusIsError = false

    try {
      const restored = await plannerStore.restoreRecoveryEntry(entry.historyId)
      if (restored) {
        recoveryStatus = 'Restored. Check your plan — the items should be back.'
        await refreshRecoveryEntries()
      } else {
        recoveryStatusIsError = true
        recoveryStatus = 'Nothing was restored for that entry.'
      }
    } catch (error) {
      recoveryStatusIsError = true
      recoveryStatus = error instanceof Error ? error.message : String(error)
    } finally {
      recoveryBusy = false
    }
  }

  function formatRecoveryTimestamp(entry: RecoveryEntry): string {
    const source = entry.timestamp ? Date.parse(entry.timestamp) : entry.createdAtMs
    if (Number.isNaN(source)) return ''
    return new Date(source).toLocaleString()
  }

  function filterDatabaseRows<T>(rows: T[], search: string): T[] {
    const needle = search.trim().toLowerCase()
    if (!needle) return rows

    return rows.filter((row) => JSON.stringify(row).toLowerCase().includes(needle))
  }

  function databaseRowId(prefix: string, id: string | number) {
    return `${prefix}:${id}`
  }

  function prettyJson(value: unknown): string {
    if (typeof value === 'string') {
      try {
        return JSON.stringify(JSON.parse(value), null, 2)
      } catch {
        return value
      }
    }

    return JSON.stringify(value, null, 2)
  }

  function planPreview(plan: { items: PlanItem[] }) {
    const texts = flattenPlanItemTexts(plan.items).filter((value) => value.trim() !== '')
    return texts.slice(0, 5).join(' · ')
  }

  function flattenPlanItemTexts(items: PlanItem[]): string[] {
    return items.flatMap((item) => [item.text, ...flattenPlanItemTexts(item.children)])
  }

  async function copyDatabaseJson(value: unknown) {
    if (!navigator.clipboard?.writeText) return

    await navigator.clipboard.writeText(prettyJson(value))
    databaseCopyStatus = 'Copied JSON'
    window.setTimeout(() => {
      databaseCopyStatus = ''
    }, 1500)
  }

  function operationPayload(entry: DatabaseOperationEntry) {
    return prettyJson(entry.payloadJson)
  }

  function historyJson(entry: DatabaseHistoryEntry) {
    return prettyJson({
      undo: parseJsonString(entry.undoJson),
      redo: parseJsonString(entry.redoJson),
    })
  }

  function parseJsonString(value: string): unknown {
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }

  function shouldReplaceFocusedPlanItemOnPaste(targetId: Id | null) {
    if (!activePlan || !targetId) return false
    if (!(document.activeElement instanceof HTMLElement) || !document.activeElement.matches('[data-plan-text-input]')) return false

    const item = findPlanItem(activePlan.items, targetId)
    // Only replace a genuinely empty leaf. Replacing an empty-titled item that still has
    // children would cascade-delete the whole subtree (data loss on paste).
    return Boolean(
      item && item.text.trim() === '' && item.html.trim() === '' && item.children.length === 0,
    )
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

{#if showAutoExportError}
  <div class="auto-export-banner" role="alert">
    <span class="auto-export-banner-icon" aria-hidden="true">⚠</span>
    <div class="auto-export-banner-text">
      <strong>Auto-export failed</strong>
      <span>{exportSettings?.lastAutoJsonExportError}</span>
    </div>
    <div class="auto-export-banner-actions">
      <button type="button" class="ghost" on:click={() => { void openRecoveryPanel() }}>Details</button>
      <button type="button" class="ghost" on:click={() => { void dismissAutoExportError() }}>Dismiss</button>
    </div>
  </div>
{/if}

{#if $persistenceError}
  <div class="auto-export-banner persistence-error-banner" role="alert">
    <span class="auto-export-banner-icon" aria-hidden="true">!</span>
    <div class="auto-export-banner-text">
      <strong>Database save failed</strong>
      <span>{$persistenceError}</span>
    </div>
    <div class="auto-export-banner-actions">
      <button type="button" class="ghost" on:click={() => { void openRecoveryPanel() }}>Inspect DB</button>
    </div>
  </div>
{/if}

<main class="app-shell">
  <aside class="sidebar">
    <div>
      <h1>Balance</h1>
      <p class="muted">Local-first daily planning</p>
    </div>

    <nav aria-label="Primary">
      <button class:active={view === 'today'} type="button" on:click={() => (view = 'today')}>Today</button>
      <button class:active={view === 'templates'} type="button" on:click={() => (view = 'templates')}>Templates</button>
      <button class:active={view === 'goals'} type="button" on:click={() => (view = 'goals')}>Goals</button>
      <button class:active={view === 'history'} type="button" on:click={() => (view = 'history')}>History</button>
      <button class:active={view === 'export'} type="button" on:click={() => (view = 'export')}>Export</button>
      <button class:active={view === 'settings'} type="button" on:click={() => (view = 'settings')}>Settings</button>
    </nav>

    <div class="sidebar-footer">
      <button class="primary" type="button" on:click={generateSelectedDay}>{generateButtonLabel}</button>
      <p class="tiny">{templates.length} template · {$plannerStore.plans.length} saved days · {activeGoalCount} active goals</p>
    </div>
  </aside>

  <div class="content-shell" style={goalHistoryHeight != null ? `--goal-history-height: ${goalHistoryHeight}px` : ''}>
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
              goals={$plannerStore.goals}
              goalCompletions={$plannerStore.goalCompletions}
              planDate={activePlan.date}
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

    {#if view === 'goals'}
      <header class="page-header">
        <div>
          <p class="eyebrow">Automatic habits</p>
          <h2>Goals</h2>
        </div>
      </header>

      <div class="goal-create-panel">
        <div class="goal-create-intro">
          <h3>Add a goal</h3>
          <p>It completes automatically when a checked daily-plan item contains any matching word or phrase.</p>
        </div>
        <label class="goal-name-field">
          <span>Name</span>
          <input
            aria-label="New goal name"
            placeholder="Strenuous exercise"
            bind:value={newGoalName}
            on:keydown={(event) => {
              if (event.key === 'Enter') addGoal()
            }}
          />
        </label>
        <label class="goal-cadence-field">
          <span>Every</span>
          <div>
            <input aria-label="New goal cadence days" type="number" min="1" max="3650" bind:value={newGoalCadenceDays} />
            <span>days</span>
          </div>
        </label>
        <label class="goal-terms-field">
          <span>Matches any</span>
          <input
            aria-label="New goal matching terms"
            placeholder="lift, swim, bike"
            bind:value={newGoalTerms}
            on:keydown={(event) => {
              if (event.key === 'Enter') addGoal()
            }}
          />
        </label>
        <div class="goal-color-field">
          <span>Color</span>
          <div class="goal-color-controls">
            <span
              class="goal-color-swatch"
              style={`background: ${newGoalNeutral ? NEUTRAL_SWATCH : hueToHex(newGoalHue)}`}
            ></span>
            <input
              class="goal-hue-slider"
              aria-label="New goal hue"
              type="range"
              min="0"
              max="359"
              disabled={newGoalNeutral}
              class:dimmed={newGoalNeutral}
              value={newGoalHue}
              on:input={(event) => (newGoalHue = Number(event.currentTarget.value))}
            />
            <button
              class="goal-neutral-toggle"
              class:active={newGoalNeutral}
              type="button"
              aria-pressed={newGoalNeutral}
              aria-label="Make this goal gray"
              on:click={() => (newGoalNeutral = !newGoalNeutral)}
            >
              Gray
            </button>
          </div>
        </div>
        <button class="primary goal-add-button" type="button" on:click={addGoal}>Add goal</button>
        {#if goalFormStatus}
          <p class="goal-form-status">{goalFormStatus}</p>
        {/if}
      </div>

      <div class="goal-list">
        {#each sortedGoals as goal (goal.id)}
          {@const active = isGoalActiveOnDate(goal, todayISO())}
          {@const completionCount = $plannerStore.goalCompletions.filter((completion) => completion.goalId === goal.id).length}
          <article class="goal-card" class:archived={!active} style={`--goal-hue: ${goal.hue}; --goal-sat-factor: ${goal.neutral ? 0 : 1}`}>
            <div class="goal-card-accent"></div>
            <div class="goal-card-main">
              <div class="goal-card-title-row">
                <input
                  class="goal-name-input"
                  aria-label={`Goal name: ${goal.name}`}
                  value={goal.name}
                  on:input={(event) => plannerStore.patchGoal(goal.id, { name: event.currentTarget.value })}
                />
                <span class:active class="goal-state">{active ? 'Active' : 'Archived'}</span>
              </div>
              <div class="goal-card-fields">
                <label class="goal-cadence-field">
                  <span>Complete every</span>
                  <div>
                    <input
                      aria-label={`Cadence days for ${goal.name}`}
                      type="number"
                      min="1"
                      max="3650"
                      value={goal.cadenceDays}
                      on:change={(event) => plannerStore.patchGoal(goal.id, { cadenceDays: Number(event.currentTarget.value) })}
                    />
                    <span>days</span>
                  </div>
                </label>
                <label class="goal-rules-field">
                  <span>A checked item matches any of</span>
                  <input
                    aria-label={`Matching terms for ${goal.name}`}
                    value={goal.matchTerms.join(', ')}
                    on:change={(event) => plannerStore.patchGoal(goal.id, { matchTerms: parseMatchTerms(event.currentTarget.value) })}
                  />
                </label>
                <div class="goal-color-field">
                  <span>Color</span>
                  <div class="goal-color-controls">
                    <span
                      class="goal-color-swatch"
                      style={`background: ${goal.neutral ? NEUTRAL_SWATCH : hueToHex(goal.hue)}`}
                    ></span>
                    <input
                      class="goal-hue-slider"
                      aria-label={`Hue for ${goal.name}`}
                      type="range"
                      min="0"
                      max="359"
                      disabled={goal.neutral}
                      class:dimmed={goal.neutral}
                      value={goal.hue}
                      on:input={(event) => plannerStore.patchGoal(goal.id, { hue: Number(event.currentTarget.value) })}
                    />
                    <button
                      class="goal-neutral-toggle"
                      class:active={goal.neutral}
                      type="button"
                      aria-pressed={goal.neutral}
                      aria-label={`Make ${goal.name} gray`}
                      on:click={() => plannerStore.patchGoal(goal.id, { neutral: !goal.neutral })}
                    >
                      Gray
                    </button>
                  </div>
                </div>
              </div>
              <p class="goal-card-meta">
                {completionCount} saved completion{completionCount === 1 ? '' : 's'}
              </p>
            </div>
            <div class="goal-card-actions">
              <button
                type="button"
                on:click={() => plannerStore.setGoalActive(goal.id, !active)}
              >
                {active ? 'Archive' : 'Reactivate'}
              </button>
              <button class="danger-text" type="button" on:click={() => { void confirmDeleteGoal(goal.id, goal.name) }}>Delete</button>
            </div>
          </article>
        {:else}
          <div class="empty-state">
            <h3>No goals yet</h3>
            <p>Add one above. Matching starts immediately for completed items on recent plans.</p>
          </div>
        {/each}
      </div>
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

        {#if isTauri()}
          <section class="settings-section">
            <div>
              <h3>Automatic JSON export</h3>
              <p>
                {exportSettings?.autoJsonExportEnabled
                  ? `Runs once per day at ${exportSettings.autoJsonExportTime}.`
                  : 'Automatic daily JSON export is off.'}
              </p>
            </div>

            <label class="setting-toggle">
              <input
                type="checkbox"
                checked={Boolean(exportSettings?.autoJsonExportEnabled)}
                disabled={autoJsonExportBusy || !exportSettings}
                on:change={(event) =>
                  updateAutoJsonExportSettings(
                    event.currentTarget.checked,
                    exportSettings?.autoJsonExportTime ?? '23:55',
                  )}
              />
              <span>Export JSON automatically every day</span>
            </label>

            <label class="time-setting">
              <span>Daily export time</span>
              <input
                type="time"
                value={exportSettings?.autoJsonExportTime ?? '23:55'}
                disabled={autoJsonExportBusy || !exportSettings?.autoJsonExportEnabled}
                on:change={(event) =>
                  updateAutoJsonExportSettings(Boolean(exportSettings?.autoJsonExportEnabled), event.currentTarget.value)}
              />
            </label>

            {#if exportSettings?.lastAutoJsonExportPath}
              <p class="export-status">Last auto-export: {exportSettings.lastAutoJsonExportPath}</p>
            {:else if exportSettings?.lastAutoJsonExportDate}
              <p class="export-status">Last auto-export: {exportSettings.lastAutoJsonExportDate}</p>
            {/if}

            {#if exportSettings?.lastAutoJsonExportError}
              <p class="export-status error">Last auto-export failed: {exportSettings.lastAutoJsonExportError}</p>
            {/if}
          </section>
        {/if}
      </div>

      {#if exportSettingsStatus}
        <p class:error={exportSettingsStatusIsError} class="export-status">{exportSettingsStatus}</p>
      {/if}
    {/if}
    </section>

    <GoalHistoryPanel
      goals={$plannerStore.goals}
      completions={$plannerStore.goalCompletions}
      viewedDate={$plannerStore.activePlanDate || todayISO()}
      onOpenGoals={() => (view = 'goals')}
      onResizeStart={startGoalHistoryResize}
    />
  </div>
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

{#if recoveryPanelOpen}
  <div class="modal-backdrop">
    <div class="recovery-panel" role="dialog" aria-modal="true" aria-labelledby="recovery-panel-title">
      <div class="recovery-panel-head">
        <div>
          <p class="eyebrow">Recovery &amp; diagnostics</p>
          <h2 id="recovery-panel-title">Restore removed items</h2>
        </div>
        <button type="button" class="ghost" on:click={closeRecoveryPanel}>Close</button>
      </div>
      <p class="recovery-copy">
        Each entry is a saved undo snapshot. Restoring reverses the action that removed those items — useful when an
        edit deleted something it shouldn't have.
      </p>

      {#if recoveryStatus}
        <p class="recovery-panel-status" class:error={recoveryStatusIsError}>{recoveryStatus}</p>
      {/if}

      <div class="recovery-actions-row">
        <button
          type="button"
          on:click={() => { void refreshRecoveryEntries(); void refreshMetadata(); void refreshDatabaseInspection() }}
          disabled={recoveryBusy || databaseInspectionBusy}
        >
          Refresh
        </button>
      </div>

      <div class="recovery-scroll">
      <details class="metadata-section">
        <summary>Restore removed items ({recoveryEntries.length})</summary>
        <ul class="recovery-list">
          {#each recoveryEntries as entry (entry.historyId)}
            <li class="recovery-row" class:undone={entry.undone}>
              <div class="recovery-row-main">
                <div class="recovery-row-info">
                  <span class="recovery-row-title">
                    {entry.restoredItemCount > 0
                      ? `Restores ${entry.restoredItemCount} item${entry.restoredItemCount === 1 ? '' : 's'}`
                      : entry.operationType ?? 'Operation'}
                  </span>
                  {#if entry.preview}<span class="recovery-row-preview">“{entry.preview}”</span>{/if}
                  <span class="recovery-row-meta">
                    {entry.operationType ?? 'unknown'} · seq {entry.sequence} · {formatRecoveryTimestamp(entry)}
                    {#if entry.undone} · already undone{/if}
                  </span>
                </div>
                <div class="recovery-row-buttons">
                  <button
                    type="button"
                    class="ghost"
                    on:click={() => (recoveryExpandedId = recoveryExpandedId === entry.historyId ? null : entry.historyId)}
                  >
                    {recoveryExpandedId === entry.historyId ? 'Hide' : 'Inspect'}
                  </button>
                  <button type="button" class="primary" disabled={recoveryBusy} on:click={() => restoreRecoveryEntry(entry)}>
                    Restore
                  </button>
                </div>
              </div>
              {#if recoveryExpandedId === entry.historyId}
                <pre class="recovery-json">{entry.undoJson}</pre>
              {/if}
            </li>
          {/each}
        </ul>
      </details>

      <details class="metadata-section" open>
        <summary>
          Database inspector
          {#if databaseInspectionBusy} loading{/if}
          {#if databaseInspection}
            ({databaseInspection.operations.length} operations · {databaseInspection.historyEntries.length} history · {databaseInspection.plans.length} plans)
          {/if}
        </summary>
        <p class="recovery-copy metadata-hint">
          Read-only view of recent SQLite rows. Search for text, dates, operation types, ids, or URLs from the missing plan.
        </p>
        <div class="database-search-row">
          <input
            type="search"
            placeholder="Search DB rows"
            aria-label="Search database rows"
            bind:value={databaseSearch}
          />
          {#if databaseCopyStatus}<span>{databaseCopyStatus}</span>{/if}
        </div>

        {#if databaseInspectionError}
          <p class="recovery-panel-status error">{databaseInspectionError}</p>
        {/if}

        {#if databaseInspection}
          <details class="database-subsection" open>
            <summary>Current plans ({filteredDatabasePlans.length})</summary>
            <ul class="recovery-list">
              {#each filteredDatabasePlans as plan (plan.id)}
                <li class="recovery-row">
                  <div class="recovery-row-main">
                    <div class="recovery-row-info">
                      <span class="recovery-row-title">{plan.date} · {plan.title}</span>
                      <span class="recovery-row-preview">{planPreview(plan) || 'No visible item text'}</span>
                      <span class="recovery-row-meta">{plan.items.length} top-level items · created {plan.createdAt}</span>
                    </div>
                    <div class="recovery-row-buttons">
                      <button
                        type="button"
                        class="ghost"
                        on:click={() => (databaseExpandedId = databaseExpandedId === databaseRowId('plan', plan.id) ? null : databaseRowId('plan', plan.id))}
                      >
                        {databaseExpandedId === databaseRowId('plan', plan.id) ? 'Hide' : 'Inspect'}
                      </button>
                      <button type="button" class="ghost" on:click={() => { void copyDatabaseJson(plan) }}>Copy</button>
                    </div>
                  </div>
                  {#if databaseExpandedId === databaseRowId('plan', plan.id)}
                    <pre class="recovery-json">{prettyJson(plan)}</pre>
                  {/if}
                </li>
              {/each}
            </ul>
          </details>

          <details class="database-subsection" open>
            <summary>Recent operations ({filteredDatabaseOperations.length})</summary>
            <ul class="recovery-list">
              {#each filteredDatabaseOperations as entry (entry.id)}
                <li class="recovery-row">
                  <div class="recovery-row-main">
                    <div class="recovery-row-info">
                      <span class="recovery-row-title">{entry.type}</span>
                      <span class="recovery-row-meta">seq {entry.sequence} · {entry.timestamp} · {entry.id}</span>
                    </div>
                    <div class="recovery-row-buttons">
                      <button
                        type="button"
                        class="ghost"
                        on:click={() => (databaseExpandedId = databaseExpandedId === databaseRowId('operation', entry.id) ? null : databaseRowId('operation', entry.id))}
                      >
                        {databaseExpandedId === databaseRowId('operation', entry.id) ? 'Hide' : 'Inspect'}
                      </button>
                      <button type="button" class="ghost" on:click={() => { void copyDatabaseJson(entry) }}>Copy</button>
                    </div>
                  </div>
                  {#if databaseExpandedId === databaseRowId('operation', entry.id)}
                    <pre class="recovery-json">{operationPayload(entry)}</pre>
                  {/if}
                </li>
              {/each}
            </ul>
          </details>

          <details class="database-subsection">
            <summary>Raw history ({filteredDatabaseHistoryEntries.length})</summary>
            <ul class="recovery-list">
              {#each filteredDatabaseHistoryEntries as entry (entry.id)}
                <li class="recovery-row" class:undone={entry.undone}>
                  <div class="recovery-row-main">
                    <div class="recovery-row-info">
                      <span class="recovery-row-title">{entry.operationType ?? 'unknown history operation'}</span>
                      <span class="recovery-row-meta">
                        seq {entry.sequence} · {entry.timestamp ?? 'no timestamp'} · {entry.id}
                        {#if entry.undone} · undone{/if}
                      </span>
                    </div>
                    <div class="recovery-row-buttons">
                      <button
                        type="button"
                        class="ghost"
                        on:click={() => (databaseExpandedId = databaseExpandedId === databaseRowId('history', entry.id) ? null : databaseRowId('history', entry.id))}
                      >
                        {databaseExpandedId === databaseRowId('history', entry.id) ? 'Hide' : 'Inspect'}
                      </button>
                      <button type="button" class="ghost" on:click={() => { void copyDatabaseJson(entry) }}>Copy</button>
                    </div>
                  </div>
                  {#if databaseExpandedId === databaseRowId('history', entry.id)}
                    <pre class="recovery-json">{historyJson(entry)}</pre>
                  {/if}
                </li>
              {/each}
            </ul>
          </details>
        {/if}
      </details>

      <details class="metadata-section">
        <summary>Database metadata ({metadataEntries.length})</summary>
        <p class="recovery-copy metadata-hint">
          Session and export diagnostics. Watch <code>last_auto_json_export_error</code> and
          <code>last_auto_json_export_date</code> to see whether auto-export is running.
        </p>
        <table class="metadata-table">
          <tbody>
            {#each metadataEntries as entry (entry.key)}
              <tr>
                <th scope="row">{entry.key}</th>
                <td>{entry.value}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </details>
      </div>
    </div>
  </div>
{/if}
