<script lang="ts">
  import { invoke, isTauri } from '@tauri-apps/api/core'
  import { confirm as confirmDialog, open as openDialog } from '@tauri-apps/plugin-dialog'
  import { onMount, tick } from 'svelte'
  import GoalColorPicker from './lib/GoalColorPicker.svelte'
  import GoalHistoryPanel from './lib/GoalHistoryPanel.svelte'
  import PlanItemEditor from './lib/PlanItemEditor.svelte'
  import TemplateItemEditor from './lib/TemplateItemEditor.svelte'
  import ListTemplateItemEditor from './lib/ListTemplateItemEditor.svelte'
  import ListPanel from './lib/ListPanel.svelte'
  import OverlayModal from './lib/OverlayModal.svelte'
  import SyncPanel from './lib/SyncPanel.svelte'
  import MetricQuiz from './lib/MetricQuiz.svelte'
  import MetricGraph from './lib/MetricGraph.svelte'
  import RichTextEditor from './lib/RichTextEditor.svelte'
  import SearchModal from './lib/SearchModal.svelte'
  import KeyboardShortcutsModal from './lib/KeyboardShortcutsModal.svelte'
  import Celebration from './lib/Celebration.svelte'
  import { filterGoalsByPhrase, goalDaysUntilLapse, goalLightnessShift, isGoalActiveOnDate, parseMatchTerms, sortGoalsByUrgency } from './lib/goals'
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
  import type { DailyPlan, Id, ListTemplateItem, Metric, MetricQuestion, MoveDirection, PlanItem, TemplateItem } from './lib/types'
  import type { SearchResult } from './lib/search'
  import { DEFAULT_DAILY_REMINDER, escapeHTML, expectedWordCount, formatPlanTitle, todayISO, totalWordCount, type ItemLink } from './lib/planner'

  // Pasting four or more items onto a different day routes through a review queue
  // so each pasted "thing" can be approved, skipped, or edited before it lands.
  const PASTE_REVIEW_THRESHOLD = 4
  const PASTE_REVIEW_COOLDOWN_MS = 2000

  type View = 'today' | 'templates' | 'listTemplates' | 'lists' | 'metrics' | 'goals' | 'settings'
  type Opener = { container: 'plan' | 'list'; containerId: Id; itemId: Id }
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
  const GOAL_RHYTHM_AUTO_SHOW_MS = 60_000
  const GOAL_HISTORY_HEIGHT_KEY = 'balance:goalHistoryHeight'
  const DONE_TINT_KEY = 'balance:doneTintColor'
  // Matches the light-theme --done-tint base in app.css; shown as the picker
  // value when the user hasn't chosen a custom color yet.
  const DEFAULT_DONE_TINT = '#3f9d54'

  let view: View = 'today'
  let searchOpen = false
  let shortcutsHelpOpen = false
  let workspaceEl: HTMLElement
  let scrollPositionsByPage: Record<string, number> = {}
  let lastScrolledPage = ''
  let scrollRestoreNonce = 0
  let restoringScroll = false
  let goalHistoryHeight: number | null = null
  let goalRhythmVisible = true
  let goalRhythmAutoShowTimer: number | null = null
  // Empty means "use the built-in green default"; a hex value overrides it.
  let doneTintColor = ''
  let completionTrackingReady = false
  let planCompletionById = new Map<Id, boolean>()
  let celebration: Celebration | null = null
  let celebrationDate: string | null = null
  let goalRhythmScrollRequest: { goalId: string; nonce: number } | null = null
  let selectedTemplateId = ''
  // Lists + Metrics feature state
  let selectedListTemplateId = ''
  let listViewTemplateId = ''
  // The list overlay toast lives inside a modal that doesn't reliably hold DOM
  // focus, so the global key handler routes arrows / Cmd+D into its ListPanel
  // through this binding. The Lists-tab ListPanel handles its own keys directly.
  let overlayListPanel: ListPanel | null = null
  let wordCapUnlocked = false
  let listTemplateDrag: {
    templateId: Id
    pointerId: number
    startX: number
    startY: number
    dragging: boolean
  } | null = null
  let listTemplateDropTargetId = ''
  let listTemplateDropPlacement: 'before' | 'after' = 'before'
  let suppressListTemplateClickId = ''
  let selectedMetricId = ''
  let listOverlay: { listId: Id; date: string; opener: Opener | null } | null = null
  let selectedListOverlayItemIdsByList: Record<Id, Id | null> = {}
  let listOverlayScrollTopsByList: Record<Id, number> = {}
  let listOverlayArmed = false
  // The page the list overlay was opened over. Navigating to any other page
  // hides the overlay, then returning shows it again with its state intact.
  let listOverlayView: View | null = null
  let metricOverlay: { metricId: Id; date: string; opener: Opener | null } | null = null
  let importMetricId = ''
  let importOverlayOpen = false
  let importRaw = ''
  let importParser = `// Return an array of rows: { date: 'YYYY-MM-DD', answers: { questionKey: value } }
// questionKey matches a question's prompt (case-insensitive) or its 0-based index.
// Booleans: true/'y'/'yes' -> yes, anything else -> no.
const rows = []
for (const block of raw.trim().split(/\\n(?=\\w+ \\d+:)/)) {
  const header = block.match(/^(\\w+ \\d+):/)
  if (!header) continue
  // map your header to an ISO date here
  rows.push({ date: header[1], answers: {} })
}
return rows`
  let importError = ''
  let importPreview: { date: string; answers: { questionId: Id; value: string }[] }[] | null = null
  let recoveryKeyStatus: RecoveryKeyStatus | null = null
  let recoveryKeySaved = false
  let recoveryKeyCopied = false
  let exportStatus = ''
  let exportStatusIsError = false
  let exportSavedPath = ''
  let exportSettings: ExportSettings | null = null
  let buildInfo: { version: string; commit: string } | null = null
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
  type ItemSurface = 'plan' | 'day-template' | 'list-template'
  type TreeNode = { id: Id; children: TreeNode[] }
  let selectedItemIds: Id[] = []
  let selectionAnchorId: Id | null = null
  let selectionFocusId: Id | null = null
  let selectedItemContext = ''
  let selectingItems = false
  type PlanItemClipboard = { items: PlanItem[]; cut: boolean; sourceDate: string }
  type TemplateItemClipboard =
    | { kind: 'day-template'; items: TemplateItem[]; cut: boolean }
    | { kind: 'list-template'; items: ListTemplateItem[]; cut: boolean }
  type ItemClipboard = PlanItemClipboard | TemplateItemClipboard
  type ClipboardContents = { structuredPayload: string | null; plainText: string | null; html: string | null }
  // Browser-only fallback for Vite/Playwright, where native pasteboard commands do
  // not exist. It is accepted only while its plain text still matches the real clipboard.
  let browserItemClipboard: ItemClipboard | null = null
  let clipboardWritePending: Promise<unknown> | null = null
  // Each pasted node — parent or child — is reviewed on its own, so the queue is a
  // flat list annotated with the node's original depth. Kept nodes are re-nested from
  // those depths once the queue empties.
  type PasteReviewNode = { item: PlanItem; depth: number }
  let pasteReview: {
    nodes: PasteReviewNode[]
    index: number
    approved: PasteReviewNode[]
    rejected: number[]
    targetId: Id | null
    placement: 'after' | 'replace'
    planId: Id
    cut: boolean
  } | null = null
  let pasteReviewEditing = false
  let pasteReviewRejecting = false
  let pasteReviewEditDraft = ''
  let pasteReviewInput: HTMLTextAreaElement | null = null
  let pasteReviewList: HTMLDivElement | null = null
  // Each card enforces a read-cooldown before "Keep"/Enter is armed, so items
  // can't be blown through without being read. pasteReviewProgress drives the bar.
  let pasteReviewReady = false
  let pasteReviewProgress = 0
  let pasteReviewCooldownFrame: number | null = null
  let itemTextDragOrigin: { itemId: Id; input: HTMLElement } | null = null
  let preserveSelectionFocusUntil = 0
  let newGoalName = ''
  let newGoalCadenceDays = 1
  let newGoalTerms = ''
  let newGoalTermsHtml = ''
  let newGoalHue = 165
  let newGoalLightness = 50
  let goalFormStatus = ''
  let goalSearch = ''
  let highlightedGoalCardId: Id | null = null

  $: templates = $plannerStore.templates
  $: activePlan = $plannerStore.plans.find((plan) => plan.date === $plannerStore.activePlanDate)
  // Scroll position is remembered per page. Today scrolls independently for each
  // date, and List Templates scrolls independently for each template.
  $: scrollPageKey =
    view === 'today'
      ? `today:${$plannerStore.activePlanDate || ''}`
      : view === 'listTemplates'
        ? `list-template:${selectedListTemplate?.id ?? ''}`
        : `view:${view}`
  $: restoreScrollForPage(scrollPageKey)
  $: dueTodayGoals = activePlan
    ? $plannerStore.goals.filter((goal) => {
        const daysUntilLapse = goalDaysUntilLapse(goal, $plannerStore.goalCompletions, activePlan.date)
        return daysUntilLapse !== null && daysUntilLapse <= 0
      })
    : []
  $: activeDailyReminder = activePlan?.dailyReminder ?? DEFAULT_DAILY_REMINDER
  $: if (!editingDailyReminder) dailyReminderDraft = activeDailyReminder
  $: selectedTemplate = templates.find((template) => template.id === selectedTemplateId) ?? templates[0]
  $: if (!selectedTemplateId && templates[0]) selectedTemplateId = templates[0].id

  // ---- Lists ----
  $: listTemplates = $plannerStore.listTemplates
  $: selectedListTemplate = listTemplates.find((template) => template.id === selectedListTemplateId) ?? listTemplates[0]
  $: if (!selectedListTemplateId && listTemplates[0]) selectedListTemplateId = listTemplates[0].id
  $: if (!listViewTemplateId && listTemplates[0]) listViewTemplateId = listTemplates[0].id
  $: selectedListWordCount = selectedListTemplate ? Math.round(expectedWordCount(selectedListTemplate.items)) : 0
  $: selectedListTotalWordCount = selectedListTemplate ? totalWordCount(selectedListTemplate.items) : 0
  $: listViewInstance = $plannerStore.lists.find(
    (list) => list.listTemplateId === listViewTemplateId && list.date === $plannerStore.activePlanDate,
  )
  // ---- Metrics ----
  $: metrics = $plannerStore.metrics
  $: selectedMetric = metrics.find((metric) => metric.id === selectedMetricId) ?? metrics[0]
  $: if (!selectedMetricId && metrics[0]) selectedMetricId = metrics[0].id
  $: if (!importMetricId && metrics[0]) importMetricId = metrics[0].id

  // ---- Overlays: auto-close a list toast once every box is checked ----
  // Only auto-close when the list *transitions* to complete while open, so
  // reopening an already-finished list lets you review it instead of slamming shut.
  $: listOverlayInstance = listOverlay ? $plannerStore.lists.find((list) => list.id === listOverlay?.listId) : null
  $: if (listOverlay && listOverlayInstance) {
    if (!allPlanItemsDone(listOverlayInstance.items)) {
      listOverlayArmed = true
    } else if (listOverlayArmed) {
      completeListOverlay()
    }
  }
  $: metricOverlayMetric = metricOverlay ? metrics.find((metric) => metric.id === metricOverlay?.metricId) : null
  $: metricOverlayAnswers =
    metricOverlay && metricOverlayMetric ? answersForEntry(metricOverlay.metricId, metricOverlay.date) : {}
  $: generateButtonLabel = $plannerStore.activePlanDate === todayISO() ? 'Generate today' : 'Generate selected day'
  $: selectedItemIdSet = new Set(selectedItemIds)
  $: activeGoalCount = $plannerStore.goals.filter((goal) => isGoalActiveOnDate(goal, todayISO())).length
  $: sortedGoals = sortGoalsByUrgency($plannerStore.goals, $plannerStore.goalCompletions, todayISO())
  $: filteredGoals = filterGoalsByPhrase(sortedGoals, goalSearch)
  $: doneTintHex = doneTintColor || DEFAULT_DONE_TINT
  // Blend the chosen color in lightly so the row reads as a tint, not a fill.
  $: doneTintValue = `color-mix(in srgb, ${doneTintHex} 14%, transparent)`
  $: contentShellStyle = [
    !goalRhythmVisible
      ? '--goal-history-height: 0px'
      : goalHistoryHeight != null
        ? `--goal-history-height: ${goalHistoryHeight}px`
        : '',
    doneTintColor ? `--done-tint: ${doneTintValue}` : '',
  ]
    .filter(Boolean)
    .join('; ')
  $: showAutoExportError = Boolean(
    exportSettings?.lastAutoJsonExportError &&
      exportSettings.lastAutoJsonExportErrorAt &&
      exportSettings.lastAutoJsonExportErrorAt !== exportSettings.autoJsonExportErrorAckAt,
  )
  $: if (selectedItemIds.length > 0 && activeItemContextKey() !== selectedItemContext) {
    clearItemSelection()
  }
  // The list overlay toast belongs to the page it was opened over: leaving that
  // page hides it, returning shows it again (its state + selection persist).
  $: listOverlayVisible = Boolean(listOverlay && listOverlayInstance && view === listOverlayView)
  $: filteredDatabaseOperations = filterDatabaseRows(databaseInspection?.operations ?? [], databaseSearch)
  $: filteredDatabaseHistoryEntries = filterDatabaseRows(databaseInspection?.historyEntries ?? [], databaseSearch)
  $: filteredDatabasePlans = filterDatabaseRows(databaseInspection?.plans ?? [], databaseSearch)
  $: observeActivePlanCompletion(activePlan, $plannerStore.activePlanDate, view, completionTrackingReady)

  function allPlanItemsDone(items: PlanItem[]): boolean {
    if (items.length === 0) return false
    return items.every((item) => item.done && (item.children.length === 0 || allPlanItemsDone(item.children)))
  }

  function observeActivePlanCompletion(
    plan: DailyPlan | undefined,
    selectedDate: string,
    currentView: View,
    ready: boolean,
  ) {
    if (!ready) return

    if (celebrationDate && (celebrationDate !== selectedDate || currentView !== 'today')) {
      dismissCelebration()
    }
    if (!plan) {
      dismissCelebration()
      return
    }

    const complete = allPlanItemsDone(plan.items)
    const wasComplete = planCompletionById.get(plan.id)
    planCompletionById.set(plan.id, complete)

    if (wasComplete === false && complete && currentView === 'today') {
      celebrationDate = plan.date
      celebration?.celebrate()
    } else if (wasComplete === true && !complete && celebrationDate === plan.date) {
      dismissCelebration()
    }
  }

  function dismissCelebration() {
    celebrationDate = null
    celebration?.dismiss()
  }

  function planItemCompletion(items: PlanItem[]): { done: number; total: number } {
    return items.reduce(
      (counts, item) => {
        const childCounts = planItemCompletion(item.children)
        return {
          done: counts.done + (item.done ? 1 : 0) + childCounts.done,
          total: counts.total + 1 + childCounts.total,
        }
      },
      { done: 0, total: 0 },
    )
  }

  function openLink(link: ItemLink, opener: Opener) {
    const date = $plannerStore.activePlanDate
    if (link.kind === 'list') {
      const listId = plannerStore.ensureListForDate(link.listTemplateId, date)
      if (listId) {
        listOverlayArmed = false
        listOverlayView = view
        delete listOverlayScrollTopsByList[listId]
        listOverlay = { listId, date, opener }
      }
    } else {
      metricOverlay = { metricId: link.metricId, date, opener }
    }
  }

  // Jump from a generated list item to the source item on the list-templates
  // page (so it can actually be edited). The overlay stays armed over the page
  // it opened from, so returning there brings it back.
  // Generated items carry fresh ids, so the template item is matched by content.
  function editListItemInTemplate(instance: { id: Id; listTemplateId: Id; items: PlanItem[] }, itemId: Id) {
    const listItem = findPlanItem(instance.items, itemId)
    if (!listItem) return

    const template = $plannerStore.listTemplates.find((candidate) => candidate.id === instance.listTemplateId)
    const templateItem = template ? findListTemplateItemByContent(template.items, listItem) : null

    view = 'listTemplates'
    selectedListTemplateId = instance.listTemplateId

    if (templateItem) void focusListTemplateItem(templateItem.id)
  }

  function findListTemplateItemByContent(items: ListTemplateItem[], target: PlanItem): ListTemplateItem | null {
    // Prefer an exact html+text match; fall back to plain text so items whose
    // html was normalized at generation time still resolve.
    const exact = findListTemplateItem(items, (item) => item.html === target.html && item.text === target.text)
    return exact ?? findListTemplateItem(items, (item) => item.text === target.text)
  }

  function findListTemplateItem(
    items: ListTemplateItem[],
    predicate: (item: ListTemplateItem) => boolean,
  ): ListTemplateItem | null {
    for (const item of items) {
      if (predicate(item)) return item
      const child = findListTemplateItem(item.children, predicate)
      if (child) return child
    }
    return null
  }

  async function focusListTemplateItem(itemId: Id) {
    // Switching views remounts the whole template editor, so the target row may
    // not exist yet after a single tick — poll a few frames until it appears.
    const input = await waitForListTemplateInput(itemId)
    if (!input) return

    input.focus()
    if (input.matches('[contenteditable="true"]')) {
      const range = document.createRange()
      range.selectNodeContents(input)
      range.collapse(false)
      const selection = document.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    }

    // Scroll last (after focus, on the next frame) so the browser's own
    // focus-scroll doesn't override the centering and the layout has settled.
    requestAnimationFrame(() => input.scrollIntoView({ block: 'center' }))
  }

  async function waitForListTemplateInput(itemId: Id, attempts = 10): Promise<HTMLElement | null> {
    for (let i = 0; i < attempts; i++) {
      await tick()
      const input = Array.from(
        document.querySelectorAll<HTMLElement>('[data-list-template-text-input-id]'),
      ).find((candidate) => candidate.dataset.listTemplateTextInputId === itemId)
      if (input) return input
      await new Promise((resolve) => requestAnimationFrame(resolve))
    }
    return null
  }

  function completeListOverlay() {
    const overlay = listOverlay
    if (!overlay) return
    listOverlay = null
    const opener = overlay.opener
    if (!opener) return
    // This runs from a reactive triggered by a store change; defer the opener
    // patch out of the current flush so the nested store update isn't dropped.
    queueMicrotask(() => {
      if (opener.container === 'plan') {
        plannerStore.patchPlanItem(opener.containerId, opener.itemId, { done: true })
      } else {
        plannerStore.patchListItem(opener.containerId, opener.itemId, { done: true })
      }
    })
  }

  // Finishing a metric survey checks off the list/plan item it was opened from,
  // mirroring completeListOverlay. Dismissing the survey early does not.
  function completeMetricOverlay() {
    const overlay = metricOverlay
    metricOverlay = null
    if (!overlay) return
    const opener = overlay.opener
    if (!opener) return
    if (opener.container === 'plan') {
      plannerStore.patchPlanItem(opener.containerId, opener.itemId, { done: true })
    } else {
      plannerStore.patchListItem(opener.containerId, opener.itemId, { done: true })
    }
  }

  function answersForEntry(metricId: Id, date: string): Record<Id, string> {
    const entry = $plannerStore.metricEntries.find((candidate) => candidate.metricId === metricId && candidate.date === date)
    const map: Record<Id, string> = {}
    for (const answer of entry?.answers ?? []) map[answer.questionId] = answer.value
    return map
  }

  type MetricGraphData = { type: 'number' | 'boolean'; points: { date: string; value: number }[] } | null

  function buildGraph(metric: Metric, question: MetricQuestion): MetricGraphData {
    const rows = $plannerStore.metricEntries
      .filter((entry) => entry.metricId === metric.id)
      .map((entry) => ({ date: entry.date, value: entry.answers.find((answer) => answer.questionId === question.id)?.value ?? '' }))

    if (question.type === 'boolean') {
      return { type: 'boolean', points: rows.map((row) => ({ date: row.date, value: row.value === 'y' ? 1 : 0 })) }
    }

    const nonEmpty = rows.filter((row) => row.value.trim() !== '')
    const numeric = nonEmpty.map((row) => ({ date: row.date, value: Number(row.value) }))
    if (nonEmpty.length > 0 && numeric.every((point) => Number.isFinite(point.value))) {
      return { type: 'number', points: numeric }
    }
    return null
  }

  function findImportQuestion(metric: Metric, key: string): MetricQuestion | null {
    const lower = key.trim().toLowerCase()
    const byId = metric.questions.find((question) => question.id === key)
    if (byId) return byId
    const byPrompt = metric.questions.find((question) => question.prompt.trim().toLowerCase() === lower)
    if (byPrompt) return byPrompt
    const index = Number(key)
    if (Number.isInteger(index) && metric.questions[index]) return metric.questions[index]
    return null
  }

  function normalizeImportValue(raw: unknown, question: MetricQuestion): string {
    if (question.type === 'boolean') {
      const truthy = raw === true || raw === 1 || ['y', 'yes', 'true', '1'].includes(String(raw).trim().toLowerCase())
      return truthy ? 'y' : 'n'
    }
    return String(raw)
  }

  function runImportPreview() {
    importError = ''
    importPreview = null
    const metric = metrics.find((candidate) => candidate.id === importMetricId)
    if (!metric) {
      importError = 'Select a metric first.'
      return
    }
    try {
      // eslint-disable-next-line no-new-func
      const parser = new Function('raw', importParser) as (raw: string) => unknown
      const result = parser(importRaw)
      if (!Array.isArray(result)) throw new Error('Parser must return an array of rows.')

      importPreview = result.map((row) => {
        const record = row as { date?: unknown; answers?: Record<string, unknown> }
        const date = String(record.date ?? '').trim()
        const answers: { questionId: Id; value: string }[] = []
        for (const [key, value] of Object.entries(record.answers ?? {})) {
          const question = findImportQuestion(metric, key)
          if (question) answers.push({ questionId: question.id, value: normalizeImportValue(value, question) })
        }
        return { date, answers }
      })
    } catch (error) {
      importError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    }
  }

  function runImport() {
    if (!importPreview) runImportPreview()
    if (!importPreview || importError) return
    const valid = importPreview.filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date) && row.answers.length > 0)
    if (valid.length === 0) {
      importError = 'No rows with a valid YYYY-MM-DD date and at least one mapped answer.'
      return
    }
    plannerStore.bulkImportMetricEntries(importMetricId, valid)
    importPreview = null
    importRaw = ''
  }

  function createListTemplateAndSelect() {
    const id = plannerStore.addListTemplate()
    selectedListTemplateId = id
    view = 'listTemplates'
  }

  function startListTemplateDrag(templateId: Id, event: PointerEvent) {
    if (event.button !== 0) return
    listTemplateDrag = {
      templateId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false,
    }
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  }

  function continueListTemplateDrag(event: PointerEvent) {
    if (!listTemplateDrag || listTemplateDrag.pointerId !== event.pointerId) return

    if (!listTemplateDrag.dragging) {
      const distance = Math.hypot(
        event.clientX - listTemplateDrag.startX,
        event.clientY - listTemplateDrag.startY,
      )
      if (distance < 5) return
      listTemplateDrag = { ...listTemplateDrag, dragging: true }
      suppressListTemplateClickId = listTemplateDrag.templateId
    }

    event.preventDefault()
    const tabs = document.querySelector<HTMLElement>('.list-template-tabs')
    if (tabs) {
      const rect = tabs.getBoundingClientRect()
      const edgeSize = Math.min(40, rect.width / 4)
      if (event.clientX < rect.left + edgeSize) tabs.scrollLeft -= 12
      else if (event.clientX > rect.right - edgeSize) tabs.scrollLeft += 12
    }

    const hovered = document.elementFromPoint(event.clientX, event.clientY)
    const target = hovered instanceof Element
      ? hovered.closest<HTMLElement>('[data-list-template-tab-id]')
      : null
    const targetId = target?.dataset.listTemplateTabId ?? ''
    if (!target || !targetId || targetId === listTemplateDrag.templateId) {
      listTemplateDropTargetId = ''
      return
    }

    const targetRect = target.getBoundingClientRect()
    listTemplateDropTargetId = targetId
    listTemplateDropPlacement = event.clientX < targetRect.left + targetRect.width / 2 ? 'before' : 'after'
  }

  function finishListTemplateDrag(event: PointerEvent) {
    if (!listTemplateDrag || listTemplateDrag.pointerId !== event.pointerId) return

    const sourceId = listTemplateDrag.templateId
    const wasDragging = listTemplateDrag.dragging
    const targetId = listTemplateDropTargetId
    const placement = listTemplateDropPlacement
    listTemplateDrag = null
    listTemplateDropTargetId = ''

    if (!wasDragging) return
    event.preventDefault()
    event.stopPropagation()
    if (targetId) plannerStore.moveListTemplate(sourceId, targetId, placement)

    window.setTimeout(() => {
      if (suppressListTemplateClickId === sourceId) suppressListTemplateClickId = ''
    }, 0)
  }

  function cancelListTemplateDrag() {
    listTemplateDrag = null
    listTemplateDropTargetId = ''
    suppressListTemplateClickId = ''
  }

  function selectListTemplateFromTab(templateId: Id) {
    if (suppressListTemplateClickId === templateId) {
      suppressListTemplateClickId = ''
      return
    }
    selectedListTemplateId = templateId
  }

  async function selectAdjacentListTemplate(direction: -1 | 1) {
    if (listTemplates.length < 2 || !selectedListTemplate) return

    const currentIndex = listTemplates.findIndex((template) => template.id === selectedListTemplate.id)
    if (currentIndex === -1) return

    const nextIndex = (currentIndex + direction + listTemplates.length) % listTemplates.length
    selectedListTemplateId = listTemplates[nextIndex].id

    await tick()
    const selectedTab = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-list-template-tab-id]'),
    ).find((tab) => tab.dataset.listTemplateTabId === selectedListTemplateId)
    selectedTab?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  async function confirmDeleteListTemplate(templateId: Id, templateName: string) {
    const savedListCount = $plannerStore.lists.filter((list) => list.listTemplateId === templateId).length
    const savedListMessage = savedListCount
      ? ` This will also delete ${savedListCount} generated list${savedListCount === 1 ? '' : 's'} made from it.`
      : ''
    const message = `Delete “${templateName || 'Untitled list'}”?${savedListMessage}`
    const confirmed = isTauri()
      ? await confirmDialog(message, { title: 'Delete list template?', kind: 'warning' })
      : window.confirm(message)
    if (!confirmed) return

    plannerStore.deleteListTemplate(templateId)
  }

  function createMetricAndSelect() {
    const id = plannerStore.addMetric()
    selectedMetricId = id
    if (!importMetricId) importMetricId = id
  }

  function openImportModal() {
    if (selectedMetricId) importMetricId = selectedMetricId
    importError = ''
    importOverlayOpen = true
  }

  onMount(() => {
    let mounted = true

    const storedGoalHistoryHeight = Number(localStorage.getItem(GOAL_HISTORY_HEIGHT_KEY))
    if (Number.isFinite(storedGoalHistoryHeight) && storedGoalHistoryHeight > 0) {
      goalHistoryHeight = clampGoalHistoryHeight(storedGoalHistoryHeight)
    }

    const storedDoneTint = normalizeHexColor(localStorage.getItem(DONE_TINT_KEY) ?? '')
    if (storedDoneTint) doneTintColor = storedDoneTint

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
      planCompletionById = new Map(
        $plannerStore.plans.map((plan) => [plan.id, allPlanItemsDone(plan.items)]),
      )
      completionTrackingReady = true
      await loadExportSettings()

      if (!mounted || !isTauri()) return

      try {
        buildInfo = await invoke<{ version: string; commit: string }>('build_info')
      } catch (error) {
        console.error('Failed to load build info', error)
      }

      window.addEventListener('focus', checkAutoJsonExport)
      document.addEventListener('visibilitychange', checkVisibleAutoJsonExport)
      restartAutoJsonExportScheduler()
    }

    void initialize()

    return () => {
      mounted = false
      clearAutoJsonExportTimers()
      clearGoalRhythmAutoShowTimer()
      dismissCelebration()
      window.removeEventListener('focus', checkAutoJsonExport)
      document.removeEventListener('visibilitychange', checkVisibleAutoJsonExport)
    }
  })

  function clampGoalHistoryHeight(value: number): number {
    return Math.max(140, Math.min(window.innerHeight * 0.7, value))
  }

  function normalizeHexColor(value: string): string | null {
    const hex = value.trim().replace(/^#/, '')
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null
    return `#${hex.toLowerCase()}`
  }

  function updateDoneTint(value: string) {
    const normalized = normalizeHexColor(value)
    if (!normalized) return
    doneTintColor = normalized
    localStorage.setItem(DONE_TINT_KEY, normalized)
  }

  function clearGoalRhythmAutoShowTimer() {
    if (goalRhythmAutoShowTimer === null) return
    window.clearTimeout(goalRhythmAutoShowTimer)
    goalRhythmAutoShowTimer = null
  }

  function showGoalRhythm() {
    clearGoalRhythmAutoShowTimer()
    goalRhythmVisible = true
  }

  function toggleGoalRhythm() {
    if (!goalRhythmVisible) {
      showGoalRhythm()
      return
    }

    goalRhythmVisible = false
    clearGoalRhythmAutoShowTimer()
    goalRhythmAutoShowTimer = window.setTimeout(showGoalRhythm, GOAL_RHYTHM_AUTO_SHOW_MS)
  }

  function focusGoalInRhythm(goalId: string) {
    showGoalRhythm()
    // Bump a nonce so repeated clicks on the same goal badge re-trigger the
    // scroll/highlight in the rhythm panel even when the id is unchanged.
    goalRhythmScrollRequest = { goalId, nonce: (goalRhythmScrollRequest?.nonce ?? 0) + 1 }
  }

  async function openGoals(goalId?: Id) {
    view = 'goals'
    if (!goalId) return

    await tick()
    // Page scroll restoration also settles after the view update. Center the
    // explicitly requested goal one frame later so that intentional jump wins.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    const goalCard = workspaceEl?.querySelector<HTMLElement>(`[data-goal-id="${goalId}"]`)
    if (!goalCard) return

    scrollElementToCenter(goalCard)
    highlightedGoalCardId = goalId
    setTimeout(() => {
      if (highlightedGoalCardId === goalId) highlightedGoalCardId = null
    }, 1600)
  }

  function scrollElementToCenter(element: HTMLElement) {
    const scrollContainer = findScrollContainer(element)
    const elementRect = element.getBoundingClientRect()
    if (scrollContainer) {
      const containerRect = scrollContainer.getBoundingClientRect()
      scrollContainer.scrollTop += elementRect.top - containerRect.top - (scrollContainer.clientHeight - elementRect.height) / 2
      return
    }

    window.scrollBy({ top: elementRect.top - (window.innerHeight - elementRect.height) / 2 })
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

  function usesWindowScroll() {
    return window.matchMedia('(max-width: 760px)').matches
  }

  function currentWorkspaceScrollTop() {
    return usesWindowScroll() ? window.scrollY : (workspaceEl?.scrollTop ?? 0)
  }

  function rememberWorkspaceScroll() {
    if (!restoringScroll && lastScrolledPage) {
      scrollPositionsByPage[lastScrolledPage] = currentWorkspaceScrollTop()
    }
  }

  function handleWorkspaceScroll() {
    if (!usesWindowScroll()) rememberWorkspaceScroll()
  }

  function handleWindowScroll() {
    if (usesWindowScroll()) rememberWorkspaceScroll()
  }

  async function restoreScrollForPage(pageKey: string) {
    if (!pageKey || pageKey === lastScrolledPage) return

    if (lastScrolledPage) {
      scrollPositionsByPage[lastScrolledPage] = currentWorkspaceScrollTop()
    }

    lastScrolledPage = pageKey
    const restoreTop = scrollPositionsByPage[pageKey] ?? 0
    const restoreNonce = ++scrollRestoreNonce
    restoringScroll = true
    await tick()
    if (restoreNonce !== scrollRestoreNonce) return
    if (!workspaceEl) {
      restoringScroll = false
      return
    }

    if (usesWindowScroll()) window.scrollTo(0, restoreTop)
    else workspaceEl.scrollTop = restoreTop

    requestAnimationFrame(() => {
      if (restoreNonce === scrollRestoreNonce) restoringScroll = false
    })
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

    plannerStore.addGoal(name, newGoalCadenceDays, matchTerms, newGoalHue, newGoalLightness, newGoalTermsHtml)
    newGoalName = ''
    newGoalCadenceDays = 1
    newGoalTerms = ''
    newGoalTermsHtml = ''
    newGoalHue = (newGoalHue + 47) % 360
    newGoalLightness = 50
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

  // When you add/remove/change a shortcut here, also update the user-facing
  // reference in src/lib/KeyboardShortcutsModal.svelte (opened with `?`).
  function handleGlobalKeydown(event: KeyboardEvent) {
    const key = event.key.toLowerCase()
    const primaryModifier = event.metaKey || event.ctrlKey

    // `?` (Shift+/) — or any of Cmd/Ctrl/Alt + / — toggles the shortcuts reference.
    // Modifier combos work even inside inputs; plain `?` only when not typing so it
    // can still be typed into text fields.
    if (event.code === 'Slash') {
      const withModifier = event.altKey || primaryModifier
      const plainQuestionMark = event.shiftKey && !withModifier
      if (withModifier || (plainQuestionMark && !isFormFieldActive() && !isRichTextActive())) {
        event.preventDefault()
        shortcutsHelpOpen = !shortcutsHelpOpen
        return
      }
    }

    if (shortcutsHelpOpen) {
      if (event.key === 'Escape') {
        event.preventDefault()
        shortcutsHelpOpen = false
      }
      return
    }

    if (
      event.code === 'KeyA' &&
      event.altKey &&
      !primaryModifier &&
      !event.shiftKey
    ) {
      event.preventDefault()
      event.stopPropagation()
      if (!event.repeat) toggleGoalRhythm()
      return
    }

    if (pasteReview) {
      if (pasteReviewEditing) {
        if (event.key === 'Enter') {
          event.preventDefault()
          savePasteReviewEdit()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          pasteReviewEditing = false
        }
        return
      }

      if (event.key === 'Enter' || event.key === 'ArrowRight') {
        event.preventDefault()
        pasteReviewDecide(true)
      } else if (event.key === 'Backspace' || event.key === 'Delete' || event.key === 'ArrowLeft') {
        event.preventDefault()
        pasteReviewDecide(false)
      } else if (key === 'e' && !primaryModifier) {
        event.preventDefault()
        startPasteReviewEdit()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        cancelPasteReview()
      }
      return
    }

    if (primaryModifier && !event.altKey && !event.shiftKey && key === 'k') {
      event.preventDefault()
      searchOpen = !searchOpen
      return
    }

    if (primaryModifier && !event.altKey && !event.shiftKey && key === 'f') {
      event.preventDefault()
      searchOpen = true
      return
    }

    if (searchOpen) {
      if (event.key === 'Escape') {
        event.preventDefault()
        searchOpen = false
      }
      return
    }

    // While the list overlay toast is open it owns the keyboard: route arrows and
    // Cmd-D to its own selection before any plan-level shortcut can fire (an
    // unscoped ArrowUp would otherwise jump focus to a plan row behind the toast).
    if (listOverlayVisible && overlayListPanel) {
      if (!event.shiftKey && !event.altKey && !primaryModifier && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        event.preventDefault()
        event.stopPropagation()
        overlayListPanel.moveSelection(event.key === 'ArrowUp' ? -1 : 1)
        return
      }

      if (primaryModifier && !event.altKey && !event.shiftKey && key === 'd' && overlayListPanel.hasSelection()) {
        event.preventDefault()
        event.stopPropagation()
        overlayListPanel.toggleSelectedDone()
        return
      }
    }

    if (primaryModifier && event.shiftKey && key === 'p') {
      event.preventDefault()
      void openRecoveryPanel()
      return
    }

    if (
      activeItemSurface() &&
      event.metaKey &&
      event.shiftKey &&
      !event.ctrlKey &&
      !event.altKey &&
      key === 'a' &&
      !isFormFieldActive()
    ) {
      const itemId = activeFocusedItemId()
      if (!itemId) return
      event.preventDefault()
      event.stopPropagation()
      selectSingleItem(itemId)
      return
    }

    if (event.key === 'Escape' && recoveryPanelOpen) {
      event.preventDefault()
      closeRecoveryPanel()
      return
    }

    if (event.key === 'Escape' && selectedItemIds.length > 0) {
      event.preventDefault()
      clearItemSelection()
      return
    }

    if (
      selectedItemIds.length > 0 &&
      !event.shiftKey &&
      !event.altKey &&
      !primaryModifier &&
      (event.key === 'ArrowUp' || event.key === 'ArrowDown')
    ) {
      event.preventDefault()
      event.stopPropagation()
      focusSelectedItemBoundary(event.key === 'ArrowUp' ? 'up' : 'down')
      return
    }

    if (
      selectedItemIds.length > 0 &&
      event.shiftKey &&
      !event.altKey &&
      !primaryModifier &&
      (event.key === 'ArrowUp' || event.key === 'ArrowDown')
    ) {
      event.preventDefault()
      event.stopPropagation()
      extendItemSelectionByKeyboard(event.key === 'ArrowUp' ? 'up' : 'down')
      return
    }

    if (selectedItemIds.length > 0 && (event.key === 'Backspace' || event.key === 'Delete')) {
      event.preventDefault()
      deleteSelectedItems()
      return
    }

    if (
      selectedItemIds.length > 0 &&
      event.key === 'Tab' &&
      !event.altKey &&
      !primaryModifier &&
      !isRichTextActive()
    ) {
      const rootIds = selectedRootIds()
      if (rootIds.length === 0) return
      event.preventDefault()
      indentSelectedItems(rootIds, event.shiftKey ? 'out' : 'in')
      return
    }

    if (
      selectedItemIds.length > 0 &&
      event.altKey &&
      !primaryModifier &&
      !event.shiftKey &&
      (event.key === 'ArrowUp' || event.key === 'ArrowDown')
    ) {
      const rootIds = selectedRootIds()
      if (rootIds.length === 0) return
      event.preventDefault()
      moveSelectedItems(rootIds, event.key === 'ArrowUp' ? 'up' : 'down')
      return
    }

    if (
      (view === 'today' || view === 'lists' || view === 'listTemplates') &&
      event.altKey &&
      !primaryModifier &&
      !event.shiftKey
    ) {
      if (event.code === 'KeyQ') {
        event.preventDefault()
        if (view === 'listTemplates') void selectAdjacentListTemplate(-1)
        else if (view === 'today' || view === 'lists') shiftActivePlanDate(-1)
        return
      }

      if (event.code === 'KeyW') {
        event.preventDefault()
        if (view === 'listTemplates') void selectAdjacentListTemplate(1)
        else if (view === 'today' || view === 'lists') shiftActivePlanDate(1)
        return
      }

      if (event.code === 'KeyT' && (view === 'today' || view === 'lists')) {
        event.preventDefault()
        plannerStore.setActivePlanDate(todayISO())
        return
      }
    }

    if (!primaryModifier || event.altKey) return

    if (activeItemSurface() === 'plan' && activePlan && key === 'd' && !event.shiftKey && selectedItemIds.length > 0) {
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

    if (activeItemSurface() && !hasActiveRichTextSelection() && !isFormFieldActive()) {
      if ((key === 'c' || key === 'x') && !event.shiftKey && selectedItemIds.length > 0) {
        event.preventDefault()
        if (key === 'x') cutSelectedItems()
        else copySelectedItems()
        return
      }

      if (key === 'v' && !event.shiftKey) {
        event.preventDefault()
        if (activeItemSurface() === 'plan') void pasteSystemClipboard()
        else void pasteTemplateSystemClipboard()
        return
      }

      if (key === 'a' && !event.shiftKey && !isRichTextActive()) {
        event.preventDefault()
        selectAllItems()
        return
      }
    }

    if (key === 'd' && !event.shiftKey) {
      const itemId = activeItemSurface() === 'plan' ? activeFocusedItemId() : null
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

  function findPlanItem(items: PlanItem[], itemId: string): PlanItem | null {
    for (const item of items) {
      if (item.id === itemId) return item
      const child = findPlanItem(item.children, itemId)
      if (child) return child
    }

    return null
  }

  function activeItemSurface(): ItemSurface | null {
    if (view === 'today' && activePlan) return 'plan'
    if (view === 'templates' && selectedTemplate) return 'day-template'
    if (view === 'listTemplates' && selectedListTemplate) return 'list-template'
    return null
  }

  function activeItemContainerId(): Id | null {
    const surface = activeItemSurface()
    if (surface === 'plan') return activePlan?.id ?? null
    if (surface === 'day-template') return selectedTemplate?.id ?? null
    if (surface === 'list-template') return selectedListTemplate?.id ?? null
    return null
  }

  function activeItemTree(): TreeNode[] {
    const surface = activeItemSurface()
    if (surface === 'plan') return (activePlan?.items ?? []) as TreeNode[]
    if (surface === 'day-template') return (selectedTemplate?.items ?? []) as TreeNode[]
    if (surface === 'list-template') return (selectedListTemplate?.items ?? []) as TreeNode[]
    return []
  }

  function activeItemContextKey() {
    const surface = activeItemSurface()
    const containerId = activeItemContainerId()
    return surface && containerId ? `${surface}:${containerId}` : ''
  }

  function itemRowSelector() {
    const surface = activeItemSurface()
    if (surface === 'plan') return '[data-plan-item-id]'
    if (surface === 'day-template') return '[data-template-item-id]'
    return '[data-list-template-item-id]'
  }

  function rowItemId(row: HTMLElement): Id | null {
    const surface = activeItemSurface()
    if (surface === 'plan') return row.dataset.planItemId ?? null
    if (surface === 'day-template') return row.dataset.templateItemId ?? null
    return row.dataset.listTemplateItemId ?? null
  }

  function flattenItemIds(items: TreeNode[]): Id[] {
    return items.flatMap((item) => [item.id, ...flattenItemIds(item.children)])
  }

  function activeFocusedItemId(): Id | null {
    const active = document.activeElement
    const row = active instanceof Element ? active.closest<HTMLElement>(itemRowSelector()) : null
    return row ? rowItemId(row) : null
  }

  function beginItemSelection(itemId: Id, event: PointerEvent) {
    if (event.button !== 0 || !activeItemSurface()) return
    event.preventDefault()
    event.stopPropagation()
    selectingItems = true
    selectedItemContext = activeItemContextKey()
    releaseTextEditingFocus()

    if (event.shiftKey && selectionAnchorId) {
      selectItemRange(selectionAnchorId, itemId, event.metaKey || event.ctrlKey)
      return
    }

    selectionAnchorId = itemId
    if (event.metaKey || event.ctrlKey) {
      selectedItemIds = selectedItemIds.includes(itemId)
        ? selectedItemIds.filter((selectedId) => selectedId !== itemId)
        : [...selectedItemIds, itemId]
      selectionFocusId = itemId
      return
    }
    selectSingleItem(itemId)
  }

  function selectSingleItem(itemId: Id) {
    if (!activeItemSurface()) return
    selectedItemContext = activeItemContextKey()
    selectionAnchorId = itemId
    selectionFocusId = itemId
    selectedItemIds = [itemId]
    releaseTextEditingFocus()
  }

  function selectItemRange(fromId: Id, toId: Id, additive: boolean) {
    const itemIds = flattenItemIds(activeItemTree())
    const fromIndex = itemIds.indexOf(fromId)
    const toIndex = itemIds.indexOf(toId)
    if (fromIndex === -1 || toIndex === -1) return
    const [start, end] = fromIndex < toIndex ? [fromIndex, toIndex] : [toIndex, fromIndex]
    const rangeIds = itemIds.slice(start, end + 1)
    selectedItemIds = additive ? [...new Set([...selectedItemIds, ...rangeIds])] : rangeIds
    selectedItemContext = activeItemContextKey()
    selectionFocusId = toId
    releaseTextEditingFocus()
  }

  function extendItemSelection(itemId: Id) {
    if (!selectingItems || !selectionAnchorId) return
    selectItemRange(selectionAnchorId, itemId, false)
  }

  function itemIdAtPoint(clientX: number, clientY: number): Id | null {
    const rows = Array.from(document.querySelectorAll<HTMLElement>(itemRowSelector()))
    const row = rows.find((candidate) => {
      const rect = candidate.getBoundingClientRect()
      return clientY >= rect.top && clientY <= rect.bottom && clientX >= rect.left && clientX <= rect.right
    })
    return row ? rowItemId(row) : null
  }

  function handleSelectionPointerMove(event: PointerEvent) {
    if (!selectingItems && itemTextDragOrigin && (event.buttons & 1) === 1 && pointerLeftElement(event, itemTextDragOrigin.input)) {
      event.preventDefault()
      selectingItems = true
      selectedItemContext = activeItemContextKey()
      selectionAnchorId = itemTextDragOrigin.itemId
      selectionFocusId = itemTextDragOrigin.itemId
      selectedItemIds = [itemTextDragOrigin.itemId]
      releaseTextEditingFocus()
    }
    if (!selectingItems) return
    const itemId = itemIdAtPoint(event.clientX, event.clientY)
    if (itemId) extendItemSelection(itemId)
  }

  function endItemSelection() {
    if (selectingItems && selectedItemIds.length > 0) preserveSelectionFocusUntil = Date.now() + 250
    selectingItems = false
    itemTextDragOrigin = null
  }

  function handleGlobalPointerDown(event: PointerEvent) {
    if (event.button !== 0 || !activeItemSurface()) {
      itemTextDragOrigin = null
      return
    }

    const target = event.target instanceof Element ? event.target : null
    const input = target?.closest<HTMLElement>('[data-rich-text-input]')
    const row = input?.closest<HTMLElement>(itemRowSelector())
    const itemId = row ? rowItemId(row) : null

    if (event.shiftKey && input && itemId) {
      const focusedItemId = activeFocusedItemId()

      if (focusedItemId && focusedItemId !== itemId) {
        event.preventDefault()
        event.stopPropagation()
        selectionAnchorId = focusedItemId
        selectItemRange(focusedItemId, itemId, false)
        itemTextDragOrigin = null
        return
      }
    }

    itemTextDragOrigin = input && itemId ? { itemId, input } : null
  }

  function handleGlobalFocusIn(event: FocusEvent) {
    const target = event.target instanceof Element ? event.target : null
    if (!target?.closest('input, textarea, [contenteditable="true"]')) return

    if (selectedItemIds.length > 0 && (selectingItems || Date.now() < preserveSelectionFocusUntil)) {
      releaseTextEditingFocus()
      return
    }

    clearItemSelection()
  }

  function selectItemWithAdjacent(itemId: Id, direction: MoveDirection) {
    const itemIds = flattenItemIds(activeItemTree())
    const index = itemIds.indexOf(itemId)
    if (index === -1) return
    const targetIndex = direction === 'up' ? Math.max(0, index - 1) : Math.min(itemIds.length - 1, index + 1)
    if (targetIndex === index) return
    selectionAnchorId = itemId
    selectItemRange(itemId, itemIds[targetIndex], false)
  }

  function extendItemSelectionByKeyboard(direction: MoveDirection) {
    const itemIds = flattenItemIds(activeItemTree())
    const anchorId = selectionAnchorId ?? selectedItemIds[0]
    const focusId = selectionFocusId ?? selectedItemIds.at(-1)
    const focusIndex = focusId ? itemIds.indexOf(focusId) : -1
    if (!anchorId || focusIndex === -1) return
    const targetIndex = direction === 'up' ? Math.max(0, focusIndex - 1) : Math.min(itemIds.length - 1, focusIndex + 1)
    const targetId = itemIds[targetIndex]
    if (targetId === anchorId) {
      clearItemSelection()
      focusItemTextInput(anchorId)
      return
    }
    selectItemRange(anchorId, targetId, false)
  }

  function selectAllItems() {
    selectedItemIds = flattenItemIds(activeItemTree())
    selectedItemContext = activeItemContextKey()
    selectionAnchorId = selectedItemIds[0] ?? null
    selectionFocusId = selectedItemIds.at(-1) ?? null
    releaseTextEditingFocus()
  }

  function clearItemSelection() {
    selectedItemIds = []
    selectedItemContext = ''
    selectionAnchorId = null
    selectionFocusId = null
    selectingItems = false
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

  function selectedRootIds(): Id[] {
    const surface = activeItemSurface()
    const containerId = activeItemContainerId()
    if (!surface || !containerId) return []
    if (surface === 'plan') return plannerStore.copyPlanItems(containerId, selectedItemIds).map((item) => item.id)
    if (surface === 'day-template') return plannerStore.copyTemplateItems(containerId, selectedItemIds).map((item) => item.id)
    return plannerStore.copyListTemplateItems(containerId, selectedItemIds).map((item) => item.id)
  }

  function selectedPlanItems() {
    if (!activePlan) return []
    return selectedItemIds
      .map((itemId) => findPlanItem(activePlan.items, itemId))
      .filter((item): item is PlanItem => item !== null)
  }

  function focusSelectedItemBoundary(direction: MoveDirection) {
    const selectedIds = new Set(selectedItemIds)
    const orderedIds = flattenItemIds(activeItemTree()).filter((itemId) => selectedIds.has(itemId))
    const targetId = direction === 'up' ? orderedIds[0] : orderedIds.at(-1)
    if (!targetId) return
    clearItemSelection()
    focusItemTextInput(targetId)
  }

  function copySelectedItems() {
    const surface = activeItemSurface()
    const containerId = activeItemContainerId()
    if (!surface || !containerId || selectedItemIds.length === 0) return
    if (surface === 'plan' && activePlan) {
      const items = plannerStore.copyPlanItems(containerId, selectedItemIds)
      if (items.length > 0) writePlanItemsToSystemClipboard({ items, cut: false, sourceDate: activePlan.date })
      return
    }
    if (surface === 'day-template') {
      const items = plannerStore.copyTemplateItems(containerId, selectedItemIds)
      if (items.length > 0) writeTemplateItemsToSystemClipboard({ kind: surface, items, cut: false })
    } else {
      const items = plannerStore.copyListTemplateItems(containerId, selectedItemIds)
      if (items.length > 0) writeTemplateItemsToSystemClipboard({ kind: 'list-template', items, cut: false })
    }
  }

  function cutSelectedItems() {
    const surface = activeItemSurface()
    const containerId = activeItemContainerId()
    if (!surface || !containerId || selectedItemIds.length === 0) return
    if (surface === 'plan' && activePlan) {
      const items = plannerStore.cutPlanItems(containerId, selectedItemIds)
      if (items.length > 0) writePlanItemsToSystemClipboard({ items, cut: true, sourceDate: activePlan.date })
      clearItemSelection()
      return
    }
    if (surface === 'day-template') {
      const items = plannerStore.cutTemplateItems(containerId, selectedItemIds)
      if (items.length > 0) writeTemplateItemsToSystemClipboard({ kind: surface, items, cut: true })
    } else {
      const items = plannerStore.cutListTemplateItems(containerId, selectedItemIds)
      if (items.length > 0) writeTemplateItemsToSystemClipboard({ kind: 'list-template', items, cut: true })
    }
    clearItemSelection()
  }

  function deleteSelectedItems() {
    const surface = activeItemSurface()
    const containerId = activeItemContainerId()
    if (!surface || !containerId || selectedItemIds.length === 0) return
    const deletedIds = surface === 'plan'
      ? plannerStore.deletePlanItems(containerId, selectedItemIds)
      : surface === 'day-template'
        ? plannerStore.deleteTemplateItems(containerId, selectedItemIds)
        : plannerStore.deleteListTemplateItems(containerId, selectedItemIds)
    if (deletedIds.length > 0) clearItemSelection()
  }

  function indentSelectedItems(rootIds: Id[], direction: 'in' | 'out') {
    const surface = activeItemSurface()
    const containerId = activeItemContainerId()
    if (!surface || !containerId) return
    if (surface === 'plan') {
      if (direction === 'in') plannerStore.indentPlanItems(containerId, rootIds)
      else plannerStore.outdentPlanItems(containerId, rootIds)
    } else if (surface === 'day-template') {
      if (direction === 'in') plannerStore.indentTemplateItems(containerId, rootIds)
      else plannerStore.outdentTemplateItems(containerId, rootIds)
    } else {
      if (direction === 'in') plannerStore.indentListTemplateItems(containerId, rootIds)
      else plannerStore.outdentListTemplateItems(containerId, rootIds)
    }
  }

  function moveSelectedItems(rootIds: Id[], direction: MoveDirection) {
    const surface = activeItemSurface()
    const containerId = activeItemContainerId()
    if (!surface || !containerId) return
    if (surface === 'plan') plannerStore.movePlanItemsWithinLevel(containerId, rootIds, direction)
    else if (surface === 'day-template') plannerStore.moveTemplateItemsWithinLevel(containerId, rootIds, direction)
    else plannerStore.moveListTemplateItemsWithinLevel(containerId, rootIds, direction)
  }

  async function pasteTemplateSystemClipboard() {
    const clipboard = await readSystemClipboard()
    const structured = parseTemplateItemClipboard(clipboard.structuredPayload)
    const surface = activeItemSurface()
    const containerId = activeItemContainerId()
    if (!structured || structured.kind !== surface || !containerId) {
      pastePlainClipboardIntoActiveEditor(clipboard)
      return
    }

    const targetId = activeFocusedItemId() ?? selectedRootIds().at(-1) ?? null
    const pastedIds = structured.kind === 'day-template'
      ? plannerStore.pasteTemplateItems(containerId, structured.items, targetId, 'after')
      : plannerStore.pasteListTemplateItems(containerId, structured.items, targetId, 'after')
    if (pastedIds.length === 0) return

    selectedItemIds = pastedIds
    selectedItemContext = activeItemContextKey()
    selectionAnchorId = pastedIds.at(-1) ?? null
    selectionFocusId = pastedIds.at(-1) ?? null
    releaseTextEditingFocus()
    if (structured.cut) writeTemplateItemsToSystemClipboard({ ...structured, cut: false })
  }

  async function pasteSystemClipboard() {
    const clipboard = await readSystemClipboard()
    const structured = parsePlanItemClipboard(clipboard.structuredPayload)
    if (structured) {
      pastePlanItemClipboard(structured)
      return
    }

    pastePlainClipboardIntoActiveEditor(clipboard)
  }

  function pastePlanItemClipboard(planItemClipboard: PlanItemClipboard) {
    if (!activePlan) return

    const targetId = pasteTargetPlanItemId()
    const placement = shouldReplaceFocusedPlanItemOnPaste(targetId) ? 'replace' : 'after'

    const nodes = flattenPlanItemsForReview(planItemClipboard.items)
    if (nodes.length >= PASTE_REVIEW_THRESHOLD && planItemClipboard.sourceDate !== activePlan.date) {
      pasteReview = {
        nodes,
        index: 0,
        approved: [],
        rejected: [],
        targetId,
        placement,
        planId: activePlan.id,
        cut: planItemClipboard.cut,
      }
      pasteReviewEditing = false
      releaseTextEditingFocus()
      startPasteReviewCooldown()
      return
    }

    insertPastedPlanItems(planItemClipboard.items, targetId, placement, planItemClipboard.cut)
  }

  // Walk the pasted forest depth-first into a flat queue, stripping children off each
  // node and recording how deep it was. Reviewing the flattened list means every child
  // gets its own keep/skip decision rather than riding along with its parent.
  function flattenPlanItemsForReview(items: PlanItem[], depth = 0): PasteReviewNode[] {
    return items.flatMap((item) => [
      { item: { ...item, children: [] }, depth },
      ...flattenPlanItemsForReview(item.children, depth + 1),
    ])
  }

  // Rebuild a forest from the kept nodes, honoring each node's original depth. A kept
  // child whose parent was skipped re-attaches to the nearest surviving ancestor (its
  // new parent), so it stays as deeply indented as the remaining tree allows instead of
  // being promoted all the way to the top.
  function buildReviewedForest(nodes: PasteReviewNode[]): PlanItem[] {
    const roots: PlanItem[] = []
    const ancestors: { item: PlanItem; depth: number }[] = []

    for (const { item, depth } of nodes) {
      const node: PlanItem = { ...item, children: [] }
      while (ancestors.length && ancestors[ancestors.length - 1].depth >= depth) ancestors.pop()

      const parent = ancestors[ancestors.length - 1]
      if (parent) parent.item.children.push(node)
      else roots.push(node)

      ancestors.push({ item: node, depth })
    }

    return roots
  }

  function startPasteReviewCooldown() {
    cancelPasteReviewCooldown()
    pasteReviewReady = false
    pasteReviewProgress = 0

    const start = performance.now()
    const step = (now: number) => {
      const elapsed = now - start
      pasteReviewProgress = Math.min(1, elapsed / PASTE_REVIEW_COOLDOWN_MS)
      if (elapsed >= PASTE_REVIEW_COOLDOWN_MS) {
        pasteReviewProgress = 1
        pasteReviewReady = true
        pasteReviewCooldownFrame = null
        return
      }
      pasteReviewCooldownFrame = requestAnimationFrame(step)
    }
    pasteReviewCooldownFrame = requestAnimationFrame(step)
  }

  function scrollCurrentPasteReviewItem() {
    const current = pasteReviewList?.querySelector<HTMLElement>('[aria-current="true"]')
    if (!pasteReviewList || !current) return

    const listRect = pasteReviewList.getBoundingClientRect()
    const currentRect = current.getBoundingClientRect()
    const top = pasteReviewList.scrollTop + currentRect.top - listRect.top - pasteReviewList.clientHeight * 0.3
    pasteReviewList.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
  }

  function cancelPasteReviewCooldown() {
    if (pasteReviewCooldownFrame != null) {
      cancelAnimationFrame(pasteReviewCooldownFrame)
      pasteReviewCooldownFrame = null
    }
  }

  function insertPastedPlanItems(
    items: PlanItem[],
    targetId: Id | null,
    placement: 'after' | 'replace',
    cut: boolean,
  ) {
    if (!activePlan) return

    const pastedRootIds = plannerStore.pastePlanItems(activePlan.id, items, targetId, placement)
    if (pastedRootIds.length === 0) return

    selectedItemIds = pastedRootIds
    selectedItemContext = activeItemContextKey()
    selectionAnchorId = pastedRootIds.at(-1) ?? null
    selectionFocusId = pastedRootIds.at(-1) ?? null
    releaseTextEditingFocus()
    // A cut becomes a copy after its first successful paste. Keeping the structured
    // clipboard alive makes subsequent pastes create more task rows instead of falling
    // through to the browser's plain-text clipboard handling.
    if (cut) {
      writePlanItemsToSystemClipboard({ items, cut: false, sourceDate: activePlan.date })
    }
  }

  // keep === true approves the current card, keep === false skips it; either way we
  // advance to the next card and commit the approved items once the queue is empty.
  // Keeping is gated on the read-cooldown; skipping is always allowed.
  async function pasteReviewDecide(keep: boolean) {
    if (!pasteReview || pasteReviewRejecting) return
    if (keep && !pasteReviewReady) return

    const review = pasteReview
    const current = pasteReview.nodes[pasteReview.index]
    const approved = keep && current ? [...pasteReview.approved, current] : pasteReview.approved
    if (!keep) {
      pasteReviewRejecting = true
      await new Promise((resolve) => window.setTimeout(resolve, 420))
      pasteReviewRejecting = false
      if (pasteReview !== review) return
    }
    const rejected = keep ? pasteReview.rejected : [...pasteReview.rejected, pasteReview.index]
    const next = pasteReview.index + 1
    pasteReviewEditing = false

    if (next >= pasteReview.nodes.length) {
      const { targetId, placement, cut } = pasteReview
      cancelPasteReviewCooldown()
      pasteReview = null
      if (approved.length > 0) insertPastedPlanItems(buildReviewedForest(approved), targetId, placement, cut)
      return
    }

    pasteReview = { ...pasteReview, approved, rejected, index: next }
    startPasteReviewCooldown()
    await tick()
    scrollCurrentPasteReviewItem()
  }

  function cancelPasteReview() {
    cancelPasteReviewCooldown()
    pasteReview = null
    pasteReviewEditing = false
    pasteReviewRejecting = false
  }

  function startPasteReviewEdit() {
    if (!pasteReview) return

    pasteReviewEditDraft = pasteReview.nodes[pasteReview.index]?.item.text ?? ''
    pasteReviewEditing = true
    void tick().then(() => pasteReviewInput?.focus())
  }

  // Grow the paste-review edit field to fit its content so large blocks of text
  // aren't clipped to a single line — matching how task items expand.
  function autoGrowPasteReviewEdit(node: HTMLTextAreaElement) {
    const resize = () => {
      node.style.height = 'auto'
      node.style.height = `${node.scrollHeight}px`
    }
    resize()
    node.addEventListener('input', resize)
    return {
      destroy() {
        node.removeEventListener('input', resize)
      },
    }
  }

  function savePasteReviewEdit() {
    if (!pasteReview) return

    const text = pasteReviewEditDraft.trim()
    const index = pasteReview.index
    const nodes = pasteReview.nodes.map((node, i) =>
      i === index ? { ...node, item: { ...node.item, text, html: escapeHTML(text) } } : node,
    )
    pasteReview = { ...pasteReview, nodes }
    pasteReviewEditing = false
  }

  function togglePasteReviewDone(done: boolean) {
    if (!pasteReview) return

    const index = pasteReview.index
    const nodes = pasteReview.nodes.map((node, i) =>
      i === index ? { ...node, item: { ...node.item, done } } : node,
    )
    pasteReview = { ...pasteReview, nodes }
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
    const focusedItemId = activeFocusedItemId()
    if (focusedItemId) return focusedItemId

    const rootIds = selectedRootIds()
    return rootIds.at(-1) ?? null
  }

  function writePlanItemsToSystemClipboard(clipboard: PlanItemClipboard) {
    const plainText = planItemsToPlainText(clipboard.items)
    writeItemClipboard(clipboard, plainText)
  }

  function writeTemplateItemsToSystemClipboard(clipboard: TemplateItemClipboard) {
    const plainText = templateClipboardPlainText(clipboard)
    writeItemClipboard(clipboard, plainText)
  }

  function writeItemClipboard(clipboard: ItemClipboard, plainText: string) {
    if (!plainText) return

    const structuredPayload = JSON.stringify(clipboard)
    if (isTauri()) {
      clipboardWritePending = invoke('write_balance_clipboard', { plainText, structuredPayload })
        .catch(async () => {
          browserItemClipboard = clipboard
          await navigator.clipboard?.writeText(plainText).catch(() => {})
        })
      return
    }

    browserItemClipboard = clipboard
    clipboardWritePending = navigator.clipboard?.writeText(plainText).catch(() => {}) ?? null
  }

  async function readSystemClipboard(): Promise<ClipboardContents> {
    await clipboardWritePending
    clipboardWritePending = null
    if (isTauri()) {
      const nativeClipboard = await invoke<ClipboardContents>('read_balance_clipboard')
      if (nativeClipboard.structuredPayload || nativeClipboard.plainText || nativeClipboard.html) return nativeClipboard
    }

    const plainText = await navigator.clipboard?.readText().catch(() => null) ?? null
    const structuredPayload = browserItemClipboard && (plainText === null || itemClipboardPlainText(browserItemClipboard) === plainText)
      ? JSON.stringify(browserItemClipboard)
      : null
    if (!structuredPayload) browserItemClipboard = null
    return { structuredPayload, plainText, html: null }
  }

  function parsePlanItemClipboard(raw: string | null): PlanItemClipboard | null {
    if (!raw) return null
    try {
      const value = JSON.parse(raw) as Partial<PlanItemClipboard>
      if (!Array.isArray(value.items) || typeof value.cut !== 'boolean' || typeof value.sourceDate !== 'string') return null
      return value as PlanItemClipboard
    } catch {
      return null
    }
  }

  function parseTemplateItemClipboard(raw: string | null): TemplateItemClipboard | null {
    if (!raw) return null
    try {
      const value = JSON.parse(raw) as Partial<TemplateItemClipboard>
      if (
        (value.kind !== 'day-template' && value.kind !== 'list-template') ||
        !Array.isArray(value.items) ||
        typeof value.cut !== 'boolean'
      ) return null
      return value as TemplateItemClipboard
    } catch {
      return null
    }
  }

  function pastePlainClipboardIntoActiveEditor(clipboard: ClipboardContents) {
    const editor = document.activeElement
    if (!(editor instanceof HTMLElement) || !editor.matches('[data-rich-text-input]')) return
    editor.dispatchEvent(new CustomEvent('balancepaste', { detail: clipboard }))
  }

  function itemClipboardPlainText(clipboard: ItemClipboard): string {
    return 'sourceDate' in clipboard ? planItemsToPlainText(clipboard.items) : templateClipboardPlainText(clipboard)
  }

  function templateClipboardPlainText(clipboard: TemplateItemClipboard): string {
    return clipboard.kind === 'day-template'
      ? dayTemplateItemsToPlainText(clipboard.items)
      : listTemplateItemsToPlainText(clipboard.items)
  }

  function dayTemplateItemsToPlainText(items: TemplateItem[], depth = 0): string {
    return items.map((item) => {
      const line = `${'  '.repeat(depth)}${item.options[0]?.text ?? ''}`
      const children = dayTemplateItemsToPlainText(item.children, depth + 1)
      return children ? `${line}\n${children}` : line
    }).join('\n')
  }

  function listTemplateItemsToPlainText(items: ListTemplateItem[], depth = 0): string {
    return items.map((item) => {
      const line = `${'  '.repeat(depth)}${item.text}`
      const children = listTemplateItemsToPlainText(item.children, depth + 1)
      return children ? `${line}\n${children}` : line
    }).join('\n')
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

  // A plain form field (e.g. the goal search box) has focus, so editing
  // shortcuts like Cmd+A should act on its text, not the daily plan.
  function isFormFieldActive() {
    return document.activeElement instanceof HTMLElement && document.activeElement.matches('input, textarea, select')
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

  function focusItemTextInput(itemId: Id) {
    const surface = activeItemSurface()
    const selector = surface === 'plan'
      ? `[data-plan-text-focus-target-id="${CSS.escape(itemId)}"]`
      : surface === 'day-template'
        ? `[data-template-item-id="${CSS.escape(itemId)}"] [data-template-option-text-input]`
        : `[data-list-template-text-input-id="${CSS.escape(itemId)}"]`
    const input = document.querySelector<HTMLDivElement>(selector)
    if (!input) return

    input.focus()
    if (!input.matches('[contenteditable="true"]')) return

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

  async function openSearchResult(result: SearchResult) {
    searchOpen = false
    clearItemSelection()

    if (result.kind === 'day') {
      plannerStore.setActivePlanDate(result.date)
      view = 'today'
    } else if (result.kind === 'list') {
      plannerStore.setActivePlanDate(result.date)
      listViewTemplateId = result.listTemplateId
      view = 'lists'
    } else if (result.kind === 'day-template') {
      selectedTemplateId = result.templateId
      view = 'templates'
    } else {
      selectedListTemplateId = result.templateId
      view = 'listTemplates'
    }

    if (!result.itemId) return
    await tick()
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

    const selector = result.kind === 'day-template'
      ? `[data-template-item-id="${CSS.escape(result.itemId)}"]`
      : result.kind === 'list-template'
        ? `[data-list-template-item-id="${CSS.escape(result.itemId)}"]`
        : `[data-plan-item-id="${CSS.escape(result.itemId)}"]`
    const row = workspaceEl?.querySelector<HTMLElement>(selector)
    if (!row) return

    scrollElementToCenter(row)
    row.classList.add('search-result-target')
    window.setTimeout(() => row.classList.remove('search-result-target'), 1800)
  }
</script>

<svelte:window
  on:keydown|capture={handleGlobalKeydown}
  on:focusin={handleGlobalFocusIn}
  on:scroll={handleWindowScroll}
  on:pointerdown|capture={handleGlobalPointerDown}
  on:pointermove={handleSelectionPointerMove}
  on:pointerup={endItemSelection}
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
      <button
        class:active={searchOpen}
        type="button"
        title="Search (Cmd/Ctrl+K)"
        aria-label="Search"
        on:click={() => (searchOpen = true)}
      >⌕ Search</button>
      <button class:active={view === 'today'} type="button" on:click={() => (view = 'today')}>Today</button>
      <button class:active={view === 'lists'} type="button" on:click={() => (view = 'lists')}>Lists</button>
      <button class:active={view === 'templates'} type="button" on:click={() => (view = 'templates')}>Day Templates</button>
      <button class:active={view === 'listTemplates'} type="button" on:click={() => (view = 'listTemplates')}>List Templates</button>
      <button class:active={view === 'metrics'} type="button" on:click={() => (view = 'metrics')}>Metrics</button>
      <button class:active={view === 'goals'} type="button" on:click={() => { void openGoals() }}>Goals</button>
      <button class:active={view === 'settings'} type="button" on:click={() => (view = 'settings')}>Settings</button>
    </nav>

    <div class="sidebar-footer">
      <button class="primary" type="button" on:click={generateSelectedDay}>{generateButtonLabel}</button>
      <p class="tiny">{templates.length} template · {$plannerStore.plans.length} saved days · {activeGoalCount} active goals</p>
    </div>
  </aside>

  <div class="content-shell" style={contentShellStyle}>
    <section
      class="workspace"
      class:list-template-workspace={view === 'listTemplates'}
      bind:this={workspaceEl}
      on:scroll={handleWorkspaceScroll}
    >
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
              selectedItemIds={selectedItemIdSet}
              selectionDragging={selectingItems}
              onSelectionPointerDown={beginItemSelection}
              onSelectionPointerMove={handleSelectionPointerMove}
              onSelectionPointerEnter={extendItemSelection}
              onTextShiftArrow={selectItemWithAdjacent}
              goals={$plannerStore.goals}
              goalCompletions={$plannerStore.goalCompletions}
              {dueTodayGoals}
              planDate={activePlan.date}
              onGoalBadgeClick={focusGoalInRhythm}
              {listTemplates}
              {metrics}
              onOpenLink={(link, itemId) => openLink(link, { container: 'plan', containerId: activePlan.id, itemId })}
            />
          {/each}

          <button class="add-row" type="button" on:click={() => plannerStore.addRootPlanItem(activePlan.id)}>
            + Add item
          </button>
        </div>
      {:else}
        <div class="empty-state">
          <h3>No plan for this date</h3>
          <p>Generate one from the template, or pick another date.</p>
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
          <!-- Bind to the resolved template's id (not the raw selectedTemplateId, which
               starts empty) so the select never renders blank while content is showing. -->
          <select
            class="day-template-select-hidden"
            value={selectedTemplate.id}
            on:change={(event) => (selectedTemplateId = event.currentTarget.value)}
            aria-label="Select template"
          >
            {#each templates as template (template.id)}
              <option value={template.id}>{template.name}</option>
            {/each}
          </select>
        {/if}
      </header>

      {#if selectedTemplate}
        <div class="template-panel">
          <div class="template-list">
            {#each selectedTemplate.items as item (item.id)}
              <TemplateItemEditor
                {item}
                allItems={selectedTemplate.items}
                templateId={selectedTemplate.id}
                patchItem={plannerStore.patchTemplateItem}
                splitItem={plannerStore.splitTemplateItem}
                backspaceOptionAtStart={plannerStore.backspaceTemplateOptionAtStart}
                deleteItem={plannerStore.deleteTemplateItem}
                moveItem={plannerStore.moveTemplateItem}
                moveItemWithinLevel={plannerStore.moveTemplateItemWithinLevel}
                outdentItem={plannerStore.outdentTemplateItem}
                addOption={plannerStore.addTemplateOption}
                patchOption={plannerStore.patchTemplateOption}
                deleteOption={plannerStore.deleteTemplateOption}
                historyRevision={$plannerStore.historyRevision}
                selectedItemIds={selectedItemIdSet}
                selectionDragging={selectingItems}
                onSelectionPointerDown={beginItemSelection}
                onSelectionPointerMove={handleSelectionPointerMove}
                onSelectionPointerEnter={extendItemSelection}
                onTextShiftArrow={selectItemWithAdjacent}
              />
            {/each}
          </div>

          <button class="add-row" type="button" on:click={() => plannerStore.addRootTemplateItem(selectedTemplate.id)}>
            + Add template item
          </button>
        </div>
      {/if}
    {/if}

    {#if view === 'listTemplates'}
      <header class="page-header">
        <div>
          <p class="eyebrow">Generator</p>
          <h2>List template</h2>
        </div>
      </header>

      {#if listTemplates.length > 0}
        <nav class="template-rail list-template-rail" aria-label="Select list template">
          <div class="list-template-tabs">
            {#each listTemplates as template (template.id)}
              <button
                type="button"
                class="rail-chip list-template-tab"
                class:active={selectedListTemplate?.id === template.id}
                class:dragging={listTemplateDrag?.dragging && listTemplateDrag.templateId === template.id}
                class:drop-before={listTemplateDropTargetId === template.id && listTemplateDropPlacement === 'before'}
                class:drop-after={listTemplateDropTargetId === template.id && listTemplateDropPlacement === 'after'}
                aria-current={selectedListTemplate?.id === template.id}
                data-list-template-tab-id={template.id}
                title="Drag to reorder list templates"
                on:click={() => selectListTemplateFromTab(template.id)}
                on:pointerdown={(event) => startListTemplateDrag(template.id, event)}
                on:pointermove={continueListTemplateDrag}
                on:pointerup={finishListTemplateDrag}
                on:pointercancel={cancelListTemplateDrag}
              >
                {template.name || 'Untitled list'}
              </button>
            {/each}
            <button type="button" class="rail-chip dashed-edge" on:click={createListTemplateAndSelect}>New list</button>
          </div>

          {#if selectedListTemplate}
            <div class="word-cap-bar">
              <span
                class="word-cap-count"
                class:over={selectedListTemplate.maxExpectedWords > 0 &&
                  selectedListWordCount > selectedListTemplate.maxExpectedWords}
              >
                {selectedListWordCount} / {selectedListTemplate.maxExpectedWords || '∞'} expected words ·
                {selectedListTotalWordCount} total words
              </span>
              <div class="word-cap-edit">
                <button
                  class="icon-button"
                  type="button"
                  title={wordCapUnlocked ? 'Lock max word count' : 'Unlock to edit max word count'}
                  aria-label={wordCapUnlocked ? 'Lock max word count' : 'Unlock to edit max word count'}
                  aria-pressed={wordCapUnlocked}
                  on:click={() => (wordCapUnlocked = !wordCapUnlocked)}
                >
                  <svg class="word-cap-lock-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                    {#if wordCapUnlocked}
                      <path d="M10.75 6V4.75a2.75 2.75 0 0 0-5.2-1.25" />
                    {:else}
                      <path d="M5.25 6V4.75a2.75 2.75 0 0 1 5.5 0V6" />
                    {/if}
                    <rect x="3.25" y="6" width="9.5" height="7.25" rx="1.5" />
                  </svg>
                </button>
                <label>
                  max
                  <input
                    type="number"
                    min="0"
                    disabled={!wordCapUnlocked}
                    value={selectedListTemplate.maxExpectedWords}
                    on:input={(event) =>
                      plannerStore.setListTemplateMaxWords(selectedListTemplate.id, Number(event.currentTarget.value) || 0)}
                  />
                </label>
              </div>
            </div>
          {/if}
        </nav>
      {/if}

      {#if selectedListTemplate}
        <div class="template-panel">
          <label class="field-label" for="list-template-name">List name</label>
          <input
            id="list-template-name"
            class="title-input"
            value={selectedListTemplate.name}
            on:input={(event) => plannerStore.renameListTemplate(selectedListTemplate.id, event.currentTarget.value)}
          />

          <div class="template-list">
            {#each selectedListTemplate.items as item (item.id)}
              <ListTemplateItemEditor
                {item}
                allItems={selectedListTemplate.items}
                templateId={selectedListTemplate.id}
                maxExpectedWords={selectedListTemplate.maxExpectedWords}
                patchItem={plannerStore.patchListTemplateItem}
                splitItem={plannerStore.splitListTemplateItem}
                backspaceItemAtStart={plannerStore.backspaceListTemplateItemAtStart}
                deleteItem={plannerStore.deleteListTemplateItem}
                moveItem={plannerStore.moveListTemplateItem}
                moveItemWithinLevel={plannerStore.moveListTemplateItemWithinLevel}
                outdentItem={plannerStore.outdentListTemplateItem}
                historyRevision={$plannerStore.historyRevision}
                selectedItemIds={selectedItemIdSet}
                selectionDragging={selectingItems}
                onSelectionPointerDown={beginItemSelection}
                onSelectionPointerMove={handleSelectionPointerMove}
                onSelectionPointerEnter={extendItemSelection}
                onTextShiftArrow={selectItemWithAdjacent}
              />
            {/each}
          </div>

          <div class="template-panel-actions">
            <button class="add-row" type="button" on:click={() => plannerStore.addRootListTemplateItem(selectedListTemplate.id)}>
              + Add list item
            </button>
            <button
              class="ghost danger"
              type="button"
              on:click={() => { void confirmDeleteListTemplate(selectedListTemplate.id, selectedListTemplate.name) }}
            >
              Delete list template
            </button>
          </div>
        </div>
      {:else}
        <div class="empty-state">
          <h3>No list templates yet</h3>
          <p>Create one to start building checklists.</p>
          <button class="primary" type="button" on:click={createListTemplateAndSelect}>+ New list template</button>
        </div>
      {/if}
    {/if}

    {#if view === 'lists'}
      <header class="page-header">
        <div>
          <p class="eyebrow">Checklists</p>
          <h2>{formatPlanTitle($plannerStore.activePlanDate)}</h2>
        </div>
        <div class="date-controls" aria-label="Day navigation">
          <button class="date-nav-button" type="button" aria-label="Previous day" on:click={() => shiftActivePlanDate(-1)}>&lt;</button>
          <button class="date-nav-button" type="button" aria-label="Next day" on:click={() => shiftActivePlanDate(1)}>&gt;</button>
          <input
            class="date-input"
            type="date"
            value={$plannerStore.activePlanDate}
            on:input={(event) => plannerStore.setActivePlanDate(event.currentTarget.value)}
          />
        </div>
      </header>

      {#if listTemplates.length > 0}
        <nav class="template-rail" aria-label="Select list">
          {#each listTemplates as template (template.id)}
            <button
              type="button"
              class="rail-chip"
              class:active={listViewTemplateId === template.id}
              aria-current={listViewTemplateId === template.id}
              on:click={() => (listViewTemplateId = template.id)}
            >
              {template.name || 'Untitled list'}
            </button>
          {/each}
        </nav>
      {/if}

      {#if listTemplates.length === 0}
        <div class="empty-state">
          <h3>No lists yet</h3>
          <p>Create a list template first (List Templates).</p>
          <button class="primary" type="button" on:click={createListTemplateAndSelect}>+ New list template</button>
        </div>
      {:else if listViewInstance}
        {@const instance = listViewInstance}
        <ListPanel
          {instance}
          {listTemplates}
          {metrics}
          escapeClearsSelection
          onOpenLink={(link, itemId) => openLink(link, { container: 'list', containerId: instance.id, itemId })}
          onEditTemplate={(itemId) => editListItemInTemplate(instance, itemId)}
        />
      {:else}
        <div class="empty-state">
          <h3>No list generated for this day</h3>
          <p>Generate this list for {$plannerStore.activePlanDate}.</p>
          <button
            class="primary"
            type="button"
            on:click={() => plannerStore.ensureListForDate(listViewTemplateId, $plannerStore.activePlanDate)}
          >
            Generate list
          </button>
        </div>
      {/if}
    {/if}

    {#if view === 'metrics'}
      <header class="page-header">
        <div>
          <p class="eyebrow">Tracking</p>
          <h2>Metrics</h2>
        </div>
        {#if metrics.length > 0}
          <button type="button" on:click={openImportModal}>Import past data</button>
        {/if}
      </header>

      {#if metrics.length > 0}
        <nav class="template-rail" aria-label="Select metric">
          {#each metrics as metric (metric.id)}
            <button
              type="button"
              class="rail-chip"
              class:active={selectedMetric?.id === metric.id}
              aria-current={selectedMetric?.id === metric.id}
              on:click={() => (selectedMetricId = metric.id)}
            >
              {metric.name || 'Untitled metric'}
            </button>
          {/each}
          <button type="button" class="rail-chip dashed-edge" on:click={createMetricAndSelect}>New metric</button>
        </nav>
      {/if}

      {#if metrics.length === 0}
        <div class="empty-state">
          <h3>No metrics yet</h3>
          <p>Create a metric to start gathering data, one question at a time.</p>
          <button class="primary" type="button" on:click={createMetricAndSelect}>+ New metric</button>
        </div>
      {:else if selectedMetric}
        {@const metric = selectedMetric}
        <div class="metric-list">
          <div class="metric-card">
            <div class="metric-card-header">
              <input
                class="title-input"
                value={metric.name}
                aria-label="Metric name"
                on:input={(event) => plannerStore.renameMetric(metric.id, event.currentTarget.value)}
              />
              <button class="icon-button danger" type="button" title="Delete metric" on:click={() => plannerStore.deleteMetric(metric.id)}>×</button>
            </div>

            {#each metric.questions as question, index (question.id)}
              <div class="metric-question-row">
                <RichTextEditor
                  className="metric-question-prompt"
                  kind="metric-question"
                  inputId={question.id}
                  placeholder="Question prompt"
                  html={question.html}
                  text={question.prompt}
                  ariaLabel="Question prompt"
                  revision={$plannerStore.historyRevision}
                  onChange={(html, prompt) => plannerStore.patchMetricQuestion(metric.id, question.id, { html, prompt })}
                />
                <select
                  aria-label="Question type"
                  value={question.type}
                  on:change={(event) =>
                    plannerStore.patchMetricQuestion(metric.id, question.id, {
                      type: event.currentTarget.value === 'boolean' ? 'boolean' : 'text',
                    })}
                >
                  <option value="text">Text / number</option>
                  <option value="boolean">Yes / no</option>
                </select>
                <button class="icon-button" type="button" title="Move up" disabled={index === 0} on:click={() => plannerStore.moveMetricQuestion(metric.id, question.id, 'up')}>↑</button>
                <button class="icon-button" type="button" title="Move down" disabled={index === metric.questions.length - 1} on:click={() => plannerStore.moveMetricQuestion(metric.id, question.id, 'down')}>↓</button>
                <button class="icon-button danger" type="button" title="Delete question" on:click={() => plannerStore.deleteMetricQuestion(metric.id, question.id)}>×</button>
              </div>
            {/each}
            <button class="add-row" type="button" on:click={() => plannerStore.addMetricQuestion(metric.id)}>+ Add question</button>

            {#each metric.questions as question (question.id)}
              {@const graph = buildGraph(metric, question)}
              {#if graph}
                <div class="metric-graph-block">
                  <h4>{@html question.html || escapeHTML(question.prompt || 'Untitled question')}</h4>
                  <MetricGraph type={graph.type} points={graph.points} />
                </div>
              {/if}
            {/each}
          </div>
        </div>
      {/if}
    {/if}

    {#if view === 'goals'}
      <header class="page-header">
        <div>
          <p class="eyebrow">Automatic habits</p>
          <h2>Goals</h2>
        </div>
        <input
          class="goal-search-input"
          type="search"
          aria-label="Search goals"
          placeholder="Search goals…"
          bind:value={goalSearch}
        />
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
          <RichTextEditor
            className="goal-rules-editor"
            kind="goal-match-terms"
            inputId="new-goal-match-terms"
            placeholder="lift, swim, bike"
            html={newGoalTermsHtml}
            text={newGoalTerms}
            ariaLabel="New goal matching terms"
            revision={$plannerStore.historyRevision}
            onChange={(html, text) => {
              newGoalTermsHtml = html
              newGoalTerms = text
            }}
          />
        </label>
        <div class="goal-color-field">
          <span>Color</span>
          <GoalColorPicker
            hue={newGoalHue}
            lightness={newGoalLightness}
            ariaLabel="New goal color"
            onChange={(color) => {
              newGoalHue = color.hue
              newGoalLightness = color.lightness
            }}
          />
        </div>
        <button class="primary goal-add-button" type="button" on:click={addGoal}>Add goal</button>
        {#if goalFormStatus}
          <p class="goal-form-status">{goalFormStatus}</p>
        {/if}
      </div>

      <div class="goal-list">
        {#each filteredGoals as goal (goal.id)}
          {@const active = isGoalActiveOnDate(goal, todayISO())}
          {@const completionCount = $plannerStore.goalCompletions.filter((completion) => completion.goalId === goal.id).length}
          {@const firstPeriod = goal.activityPeriods[0]}
          <article
            class="goal-card"
            class:archived={!active}
            class:goal-card-focus={highlightedGoalCardId === goal.id}
            data-goal-id={goal.id}
            style={`--goal-hue: ${goal.hue}; --goal-lightness-shift: ${goalLightnessShift(goal.lightness)}%`}
          >
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
                {#if firstPeriod}
                  <label class="goal-start-field">
                    <span>Started on</span>
                    <input
                      aria-label={`Start date for ${goal.name}`}
                      type="date"
                      value={firstPeriod.startDate}
                      max={firstPeriod.endDate ?? undefined}
                      on:change={(event) => {
                        const value = event.currentTarget.value
                        if (value) plannerStore.setGoalStartDate(goal.id, value)
                        else event.currentTarget.value = firstPeriod.startDate
                      }}
                    />
                  </label>
                {/if}
                <label class="goal-rules-field">
                  <span>A checked item matches any of</span>
                  <RichTextEditor
                    className="goal-rules-editor"
                    kind="goal-match-terms"
                    inputId={`goal-match-terms:${goal.id}`}
                    html={goal.matchTermsHtml}
                    text={goal.matchTerms.join(', ')}
                    ariaLabel={`Matching terms for ${goal.name}`}
                    revision={$plannerStore.historyRevision}
                    onChange={(html, text) => plannerStore.patchGoal(goal.id, {
                      matchTerms: parseMatchTerms(text),
                      matchTermsHtml: html,
                    })}
                  />
                </label>
                <div class="goal-color-field">
                  <span>Color</span>
                  <GoalColorPicker
                    hue={goal.hue}
                    lightness={goal.lightness}
                    ariaLabel={`Color for ${goal.name}`}
                    onChange={(color) => plannerStore.patchGoal(goal.id, color)}
                  />
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
            {#if goalSearch.trim()}
              <h3>No goals match “{goalSearch.trim()}”</h3>
              <p>Try a different word, or clear the search to see every goal.</p>
            {:else}
              <h3>No goals yet</h3>
              <p>Add one above. Matching starts immediately for completed items on recent plans.</p>
            {/if}
          </div>
        {/each}
      </div>
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
            <h3>Completed item color</h3>
            <p>The tint applied to checked plan items. Pick any color — it's blended in lightly.</p>
          </div>

          <div class="done-tint-row">
            <label class="done-tint-control">
              <input
                type="color"
                aria-label="Completed item tint color"
                value={doneTintHex}
                on:input={(event) => updateDoneTint(event.currentTarget.value)}
              />
              <input
                class="done-tint-hex"
                type="text"
                aria-label="Completed item tint hex code"
                spellcheck="false"
                maxlength="7"
                value={doneTintHex}
                on:change={(event) => updateDoneTint(event.currentTarget.value)}
              />
            </label>

            <div class="done-tint-preview plan-row done" aria-label="Example completed item">
              <span class="done-tint-check" aria-hidden="true">✓</span>
              <span class="item-text done">Dress up in a porcupine suit</span>
            </div>

          </div>
        </section>

        <SyncPanel />

        <section class="settings-section">
          <div>
            <h3>Manual export</h3>
            <p>Save a portable copy of your plans, templates, goals, and operation log.</p>
          </div>

          <div class="export-panel">
            <div>
              <h4>Canonical JSON</h4>
              <p>Full app state for restore or migration.</p>
              <button class="primary" type="button" on:click={downloadJSON}>Export JSON</button>
            </div>

            <div>
              <h4>Readable HTML</h4>
              <p>A simple document with every saved daily plan.</p>
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
        </section>

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

        {#if buildInfo}
          <section class="settings-section">
            <div>
              <h3>About</h3>
              <p>The version and source commit this build came from.</p>
            </div>

            <div class="path-row">
              <span>Balance {buildInfo.version} · {buildInfo.commit}</span>
            </div>
          </section>
        {/if}
      </div>

      {#if exportSettingsStatus}
        <p class:error={exportSettingsStatusIsError} class="export-status">{exportSettingsStatus}</p>
      {/if}
    {/if}
    </section>

    {#if goalRhythmVisible}
      <GoalHistoryPanel
        goals={$plannerStore.goals}
        completions={$plannerStore.goalCompletions}
        viewedDate={$plannerStore.activePlanDate || todayISO()}
        onOpenGoals={openGoals}
        onResizeStart={startGoalHistoryResize}
        scrollRequest={goalRhythmScrollRequest}
      />
    {/if}

    {#if listOverlayVisible && listOverlayInstance}
      {@const instance = listOverlayInstance}
      {@const template = listTemplates.find((candidate) => candidate.id === instance.listTemplateId)}
      {@const completion = planItemCompletion(instance.items)}
      {@const completionPercent = completion.total === 0 ? 0 : Math.round((completion.done / completion.total) * 100)}
      <OverlayModal title={template?.name ?? 'List'} z={60} onClose={() => (listOverlay = null)}>
        <div
          slot="header-middle"
          class="list-progress"
          style={`--list-progress: ${completionPercent}%`}
          role="progressbar"
          aria-label="List completion"
          aria-valuemin="0"
          aria-valuemax={completion.total}
          aria-valuenow={completion.done}
        >
          <span class="list-progress-fill"></span>
        </div>
        <ListPanel
          bind:this={overlayListPanel}
          {instance}
          {listTemplates}
          {metrics}
          bind:selectedItemId={selectedListOverlayItemIdsByList[instance.id]}
          initialScrollTop={listOverlayScrollTopsByList[instance.id] ?? null}
          onScrollTopChange={(scrollTop) => (listOverlayScrollTopsByList[instance.id] = scrollTop)}
          onOpenLink={(link, itemId) => openLink(link, { container: 'list', containerId: instance.id, itemId })}
          onEditTemplate={(itemId) => editListItemInTemplate(instance, itemId)}
        />
      </OverlayModal>
    {/if}

    {#if metricOverlay && metricOverlayMetric}
      {@const overlay = metricOverlay}
      <OverlayModal title={metricOverlayMetric.name} z={70} onClose={() => (metricOverlay = null)}>
        <MetricQuiz
          metric={metricOverlayMetric}
          answers={metricOverlayAnswers}
          onAnswer={(questionId, value) => plannerStore.upsertMetricAnswer(overlay.metricId, overlay.date, questionId, value)}
          onClose={() => (metricOverlay = null)}
          onComplete={completeMetricOverlay}
        />
      </OverlayModal>
    {/if}

    {#if importOverlayOpen}
      <OverlayModal title="Import past data" z={70} onClose={() => (importOverlayOpen = false)}>
        <div class="metric-import">
          <label class="field-label" for="import-metric">Target metric</label>
          <select id="import-metric" bind:value={importMetricId}>
            {#each metrics as metric (metric.id)}
              <option value={metric.id}>{metric.name}</option>
            {/each}
          </select>
          <label class="field-label" for="import-raw">Raw data</label>
          <textarea id="import-raw" bind:value={importRaw} placeholder="Paste your raw data here"></textarea>
          <label class="field-label" for="import-parser">Parser (JS function body, receives `raw`, returns rows)</label>
          <textarea id="import-parser" bind:value={importParser}></textarea>
          <div class="template-panel-actions">
            <button type="button" on:click={runImportPreview}>Preview</button>
            <button class="primary" type="button" on:click={runImport} disabled={!importPreview || Boolean(importError)}>Import</button>
          </div>
          {#if importError}
            <p class="metric-import-error">{importError}</p>
          {/if}
          {#if importPreview}
            <p class="metric-import-preview">
              Parsed {importPreview.length} row(s); {importPreview.filter((row) => row.answers.length > 0).length} with mapped answers.
            </p>
          {/if}
        </div>
      </OverlayModal>
    {/if}

    {#if searchOpen}
      <SearchModal
        state={$plannerStore}
        onClose={() => (searchOpen = false)}
        onSelect={(result) => { void openSearchResult(result) }}
      />
    {/if}

    {#if shortcutsHelpOpen}
      <KeyboardShortcutsModal onClose={() => (shortcutsHelpOpen = false)} />
    {/if}
  </div>
</main>

<Celebration bind:this={celebration} />

{#if pasteReview}
  <div class="paste-review-backdrop">
    <div class="paste-review" role="dialog" aria-modal="true" aria-labelledby="paste-review-title">
      <div class="paste-review-head">
        <div>
          <p class="eyebrow">Review pasted items</p>
          <h2 id="paste-review-title">Item {pasteReview.index + 1} of {pasteReview.nodes.length}</h2>
        </div>
        <button class="ghost" type="button" title="Cancel (Esc)" on:click={cancelPasteReview}>✕</button>
      </div>

      <div class="paste-review-list" aria-label="Items being pasted" bind:this={pasteReviewList}>
        {#each pasteReview.nodes as node, nodeIndex (node.item.id)}
          {@const isCurrent = nodeIndex === pasteReview.index}
          {@const wasKept = pasteReview.approved.includes(node)}
          <div
            class="paste-review-card paste-review-item"
            class:current={isCurrent}
            class:kept={wasKept}
            class:removed={pasteReview.rejected.includes(nodeIndex)}
            class:rejecting={isCurrent && pasteReviewRejecting}
            class:done={node.item.done}
            style:--paste-depth={node.depth}
            aria-current={isCurrent ? 'true' : undefined}
          >
            {#if isCurrent && pasteReviewEditing}
              <textarea
                class="paste-review-edit"
                rows="1"
                bind:value={pasteReviewEditDraft}
                bind:this={pasteReviewInput}
                placeholder="Item text"
                use:autoGrowPasteReviewEdit
              ></textarea>
            {:else}
              <div class="paste-review-line">
                {#if isCurrent}
                  <label class="check-target" title="Complete item">
                    <input
                      class="check"
                      type="checkbox"
                      checked={node.item.done}
                      on:change={(event) => togglePasteReviewDone(event.currentTarget.checked)}
                      aria-label="Complete item"
                    />
                  </label>
                {:else}
                  <span class="paste-review-status" aria-hidden="true">{wasKept ? '✓' : nodeIndex + 1}</span>
                {/if}
                <!-- Same read-only text treatment as a real (locked) list item:
                     .item-text + .item-text-display wraps and grows with content. -->
                <div
                  class="paste-review-text item-text item-text-display"
                  class:done={node.item.done}
                  class:empty={!node.item.text?.trim()}
                >{node.item.text?.trim() || '(empty item)'}</div>
              </div>
            {/if}
            {#if node.depth}
              <p class="paste-review-meta">Nested {node.depth} level{node.depth === 1 ? '' : 's'} deep</p>
            {/if}
          </div>
        {/each}
      </div>

      {#if !pasteReviewEditing}
        <div
          class="paste-review-cooldown"
          class:ready={pasteReviewReady}
          role="progressbar"
          aria-label="Read the item before keeping it"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow={Math.round(pasteReviewProgress * 100)}
        >
          <div class="paste-review-cooldown-fill" style="width: {pasteReviewProgress * 100}%"></div>
        </div>
      {/if}

      <div class="paste-review-actions">
        {#if pasteReviewEditing}
          <button class="primary" type="button" on:click={savePasteReviewEdit}>Save (Enter)</button>
          <button type="button" on:click={() => (pasteReviewEditing = false)}>Cancel (Esc)</button>
        {:else}
          <button type="button" disabled={pasteReviewRejecting} on:click={() => pasteReviewDecide(false)}>Skip (←)</button>
          <button type="button" on:click={startPasteReviewEdit}>Edit (E)</button>
          <button
            class="primary"
            type="button"
            disabled={!pasteReviewReady || pasteReviewRejecting}
            on:click={() => pasteReviewDecide(true)}
          >
            {pasteReviewReady ? 'Keep (→ / Enter)' : 'Read it…'}
          </button>
        {/if}
      </div>

      <p class="paste-review-hint">{pasteReview.approved.length}/{pasteReview.nodes.length} kept so far</p>
    </div>
  </div>
{/if}

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
