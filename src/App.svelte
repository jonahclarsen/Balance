<script lang="ts">
  import { onBackButtonPress } from '@tauri-apps/api/app'
  import { invoke, isTauri } from '@tauri-apps/api/core'
  import { listen } from '@tauri-apps/api/event'
  import { confirm as confirmDialog, open as openDialog } from '@tauri-apps/plugin-dialog'
  import { onMount, tick } from 'svelte'
  import GoalColorPicker from './lib/GoalColorPicker.svelte'
  import IridescentGradientSettings from './lib/IridescentGradientSettings.svelte'
  import GoalHistoryPanel from './lib/GoalHistoryPanel.svelte'
  import PlanItemEditor from './lib/PlanItemEditor.svelte'
  import TemplateItemEditor from './lib/TemplateItemEditor.svelte'
  import TemplateTabs from './lib/TemplateTabs.svelte'
  import ListTemplateItemEditor from './lib/ListTemplateItemEditor.svelte'
  import ListPanel from './lib/ListPanel.svelte'
  import NotesPanel from './lib/NotesPanel.svelte'
  import ImaxButton from './lib/ImaxButton.svelte'
  import OverlayModal from './lib/OverlayModal.svelte'
  import SyncPanel from './lib/SyncPanel.svelte'
  import SyncStatusIndicator from './lib/SyncStatusIndicator.svelte'
  import MetricQuiz from './lib/MetricQuiz.svelte'
  import MetricGraph from './lib/MetricGraph.svelte'
  import RichTextEditor from './lib/RichTextEditor.svelte'
  import SearchModal from './lib/SearchModal.svelte'
  import KeyboardShortcutsModal from './lib/KeyboardShortcutsModal.svelte'
  import ThemeTaskPreview from './lib/ThemeTaskPreview.svelte'
  import DocumentFindBar from './lib/DocumentFindBar.svelte'
  import Celebration from './lib/Celebration.svelte'
  import CelebrationSettings from './lib/CelebrationSettings.svelte'
  import GoalBurst from './lib/GoalBurst.svelte'
  import { randomIridescentSelectionAnimationDelay, restartElementAnimations } from './lib/iridescentSelectionAnimation'
  import { filterGoalsByPhrase, goalLightnessShift, goalsMatchingItemText, isGoalActiveOnDate, parseMatchTerms, sortGoalsByUrgency } from './lib/goals'
  import {
    compactDatabase,
    completeDatabaseMaintenanceStartup,
    confirmRecoveryKey,
    databaseLoadError,
    databaseLoadPending,
    databaseLoadProgress,
    exportHTML,
    exportJSON,
    getDatabaseMaintenanceStatus,
    getRecoveryKeyStatus,
    inspectDatabase,
    listMetadata,
    listRecoveryEntries,
    persistenceError,
    plannerStore,
    recoverDatabaseWithKey,
    rotateDatabaseRecoveryKey,
    runDatabaseMaintenanceIfNeeded,
  } from './lib/store'
  import type { DatabaseHistoryEntry, DatabaseInspection, DatabaseMaintenanceStatus, DatabaseOperationEntry, MetadataEntry, RecoveryEntry, RecoveryKeyStatus } from './lib/store'
  import type { ArchivedListTemplateItem, DailyPlan, DeviceAppearancePreferences, Goal, Id, IridescentGradientPreferences, ListInstance, ListTemplateItem, Metric, MetricQuestion, MoveDirection, MovePlacement, PlanItem, TemplateItem } from './lib/types'
  import type { SearchResult } from './lib/search'
  import { scrollMovedItemsIntoView, type ItemRowKind } from './lib/itemScroll'
  import { buildItemTimeWarnings, DEFAULT_DAILY_REMINDER, defaultPlanItemTimeRange, defaultTemplateItemTimeRange, escapeHTML, expectedWordCount, formatPlanTitle, hasActiveTimeRange, linkifyItemText, MAX_TIMELINE_MINUTES, renderItemDisplayHTML, todayISO, totalWordCount, type ItemLink } from './lib/planner'
  import { hexToPickerColor, pickerColorToHex, type PickerColor } from './lib/colors'
  import { automaticSyncStatus, requestSync, startAutomaticSync } from './lib/syncScheduler'
  import { createDefaultIridescentGradient, DEFAULT_DATABASE_LOADING_MESSAGES, normalizeIridescentGradient, replicatedDayTheme } from './lib/preferences'
  import {
    createDefaultDeviceAppearance,
    deviceAppearanceFromLegacyPreferences,
    effectiveThemeForDate,
    normalizeDeviceAppearance,
    persistEncryptedDeviceAppearance,
    readDeviceAppearanceBootstrap,
    readEncryptedDeviceAppearance,
    selectedThemeForDate,
    writeDeviceAppearanceBootstrap,
  } from './lib/deviceAppearance'
  import {
    DEFAULT_PRESET_THEME_ID,
    DEFAULT_THEME_ID,
    normalizePresetThemeId,
    THEME_OPTIONS,
    THEME_PRESETS,
    type PresetThemeId,
    type ThemeId,
  } from './lib/themes'
  import { isNoteTrashed } from './lib/noteTrash'
  import { BALANCE_DEEP_LINK_EVENT, parseBalanceDeepLink } from './lib/deepLinks'
  import {
    DEFAULT_COMPLETION_CELEBRATION_ID,
    getCompletionCelebration,
    normalizeCompletionCelebrationId,
    type CompletionCelebrationId,
  } from './lib/celebrations'

  // Pasting four or more items onto a different day routes through a review queue
  // so each pasted "thing" can be approved, skipped, or edited before it lands.
  const PASTE_REVIEW_THRESHOLD = 4
  const PASTE_REVIEW_COOLDOWN_MS = 2000
  const PASTE_MATCH_STYLE_EVENT = 'balance-paste-match-style'
  const MACOS_ALT_SHORTCUT_EVENT = 'balance-macos-alt-shortcut'
  const TIME_KEYBOARD_STEP_MINUTES = 15
  const TIME_KEYBOARD_MERGE_WINDOW_MS = 1500

  type View = 'today' | 'templates' | 'listTemplates' | 'lists' | 'notes' | 'metrics' | 'goals' | 'settings'
  type Opener = { container: 'plan' | 'list'; containerId: Id; itemId: Id }
  type ExportSettings = {
    exportDirectory: string
    defaultExportDirectory: string
    usesDefaultExportDirectory: boolean
  }
  type AvailableUpdate = { version: string; url: string }
  type MacosWidgetSettings = { hideContentAfterClose: boolean }
  type MacosAltShortcut = { code: string; shiftKey: boolean; repeat: boolean }
  type CelebrationPreviewSession = {
    token: number
    celebrationId: CompletionCelebrationId
    previewDate: string
    returnView: View
    persistedActivePlanDate: string
    compareDayOpen: boolean
    compareDayDate: string
    settingsScrollTop: number
    focusCelebrationId: CompletionCelebrationId
  }

  const GOAL_RHYTHM_AUTO_SHOW_MS = 60_000
  const GOAL_HISTORY_UPDATE_DEBOUNCE_MS = 1_000
  const GOAL_HISTORY_EDIT_UPDATE_DEBOUNCE_MS = 5_000
  const defaultIridescentGradient = createDefaultIridescentGradient()
  const GOAL_HISTORY_HEIGHT_KEY = 'balance:goalHistoryHeight'
  const DISMISSED_UPDATE_VERSION_KEY = 'balance:dismissedUpdateVersion'
  const DATABASE_LOADING_MESSAGE_INTERVAL_MS = 10_000
  const DESKTOP_INACTIVITY_CLOSE_MS = 2 * 60 * 60 * 1000
  const isAndroid = /android/i.test(navigator.userAgent)
  const DAY_TEMPLATE_SELECTION_KEY = 'balance:selectedDayTemplateId'
  const LIST_TEMPLATES_VIEW_STATE_KEY = 'balance:listTemplatesViewState'
  const WORKSPACE_VIEW_STATE_KEY = 'balance:workspaceViewState'
  const COMPARE_DAY_KEY = 'balance:compareDay'
  const isMobile = /android|iphone|ipad|ipod/i.test(
    (typeof navigator !== 'undefined' && navigator.userAgent) || '',
  )
  const isMac = /Mac|iPhone|iPad|iPod/.test(
    (typeof navigator !== 'undefined' && (navigator.platform || navigator.userAgent)) || '',
  )

  function altShortcutLabel(key: string): string {
    return `${isMac ? '⌥' : 'Alt+'}${key}`
  }

  function primaryShortcutLabel(key: string): string {
    return `${isMac ? '⌘' : 'Ctrl+'}${key}`
  }

  function shiftShortcutLabel(key: string): string {
    return `${isMac ? '⇧' : 'Shift+'}${key}`
  }

  function altShiftShortcutLabel(key: string): string {
    return `${isMac ? '⌥⇧' : 'Alt+Shift+'}${key}`
  }

  let view: View = 'today'
  let currentDay = todayISO()
  let mobileDrawerOpen = false
  let mobileDrawerDragging = false
  let mobileDrawerEl: HTMLElement | null = null
  let mobileDrawerBackdropEl: HTMLButtonElement | null = null
  let mobileDrawerAnimationFrame: number | null = null
  let mobileDrawerPendingOffset = 0
  let mobileDrawerGesture: {
    pointerId: number
    startX: number
    startY: number
    axis: 'horizontal' | 'vertical' | null
    offset: number
  } | null = null
  // List History is a contextual child of Lists. Once opened, keep its sidebar
  // entry available while visiting other pages; returning to Lists dismisses it.
  let listHistoryNavigationVisible = false
  let searchOpen = false
  let activeNavAnimationTarget: View | 'search' = view
  let activeNavAnimationDelay = randomIridescentSelectionAnimationDelay()
  let activeNavAnimationRevision = 0
  let primaryNavEl: HTMLElement | null = null
  let documentFindOpen = false
  let documentFindBar: DocumentFindBar | null = null
  let shortcutsHelpOpen = false
  let workspaceEl: HTMLElement
  let scrollPositionsByPage: Record<string, number> = {}
  let lastScrolledPage = ''
  let scrollRestoreNonce = 0
  let restoringScroll = false
  let workspaceViewStateReady = false
  let listTemplatesViewStateReady = false
  let dayTemplateSelectionReady = false
  let goalHistoryHeight: number | null = null
  let goalRhythmVisible = true
  let goalRhythmAutoShowTimer: number | null = null
  let maximizedView: View | null = null
  let goalRhythmVisibleBeforeMaximize = true
  let maximizeClickHandoff: {
    left: number
    top: number
    width: number
    height: number
    pointerX: number
    pointerY: number
  } | null = null
  // Empty means "use the active theme color"; a hex value overrides it.
  let doneTintColor = ''
  let checkboxColor = ''

  function updateActiveNavAnimationDelay(target: View | 'search') {
    if (target === activeNavAnimationTarget) return
    activeNavAnimationTarget = target
    activeNavAnimationDelay = randomIridescentSelectionAnimationDelay()
    const revision = ++activeNavAnimationRevision
    void tick().then(() => {
      if (revision !== activeNavAnimationRevision) return
      restartElementAnimations(primaryNavEl?.querySelector('button.active'))
    })
  }

  $: updateActiveNavAnimationDelay(searchOpen ? 'search' : view)
  let themeId: ThemeId = DEFAULT_THEME_ID
  let effectiveThemeId: PresetThemeId = DEFAULT_PRESET_THEME_ID
  let preferencesReady = false
  let randomThemeScheduled = false
  let deviceAppearance: DeviceAppearancePreferences = readDeviceAppearanceBootstrap()
    ?? createDefaultDeviceAppearance()
  let deviceAppearanceDatabaseReady = false
  let lastObservedTodayKey = ''
  let historicalThemeId: string | null = null
  let displayedThemeId: PresetThemeId = DEFAULT_PRESET_THEME_ID
  let iridescentGradient = createDefaultIridescentGradient()
  let completionTrackingReady = false
  let planCompletionById = new Map<Id, boolean>()
  let listCompletionById = new Map<Id, boolean>()
  let celebration: Celebration | null = null
  let celebrationDate: string | null = null
  let celebrationListId: Id | null = null
  let celebrationKind: 'day' | 'list' | null = null
  let completionCelebrationId: CompletionCelebrationId = DEFAULT_COMPLETION_CELEBRATION_ID
  let celebrationPreview: CelebrationPreviewSession | null = null
  let celebrationPreviewTimer: number | null = null
  let celebrationPreviewToken = 0
  let celebrationPreviewAnnouncement = ''
  let celebrationPreviewAnnouncementTimer: number | null = null
  let goalBurst: GoalBurst | null = null
  // Tracks each plan item's done state so we can fire a goal burst the moment an
  // item that contributes to a goal transitions to done (via any completion path).
  let goalItemDoneById = new Map<Id, boolean>()
  let goalRhythmScrollRequest: { goalId: string; nonce: number } | null = null
  let selectedTemplateId = ''
  let emptyDayTemplateSelections: Record<string, Id> = {}
  // Lists + Metrics feature state
  let selectedListTemplateId = ''
  let listViewTemplateId = ''
  let listArchiveOpen = false
  // The list overlay toast lives inside a modal that doesn't reliably hold DOM
  // focus, so the global key handler routes arrows / Cmd+D into its ListPanel
  // through this binding. The Lists-tab ListPanel handles its own keys directly.
  let overlayListPanel: ListPanel | null = null
  let notesPanel: NotesPanel | null = null
  let notesTrashOpen = false
  let wordCapUnlocked = false
  let selectedMetricId = ''
  let selectedNoteId = ''
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
  let recoveryKeyConfirmation = ''
  let recoveryKeyConfirmationError = ''
  let recoveryKeyCopied = false
  let recoveryKeyRotationArchivedAccount = ''
  let recoveryKeyRotationBusy = false
  let recoveryKeyRotationStatus = ''
  let recoveryKeyRotationStatusIsError = false
  let databaseRecoveryKey = ''
  let databaseRecoveryBusy = false
  let databaseRecoveryStatus = ''
  let exportStatus = ''
  let exportStatusIsError = false
  let exportSavedPath = ''
  let exportSettings: ExportSettings | null = null
  let buildInfo: { version: string; commit: string } | null = null
  let availableUpdate: AvailableUpdate | null = null
  let exportSettingsStatus = ''
  let exportSettingsStatusIsError = false
  let exportSettingsBusy = false
  let widgetHideContentAfterClose = true
  let widgetPrivacySettingsReady = false
  let widgetPrivacySettingsBusy = false
  let widgetPrivacySettingsStatus = ''
  let widgetPrivacySettingsStatusIsError = false
  let recoveryPanelOpen = false
  let recoveryEntries: RecoveryEntry[] = []
  let recoveryBusy = false
  let recoveryStatus = ''
  let recoveryStatusIsError = false
  let recoveryExpandedId: string | null = null
  let recoveryListOpen = false
  let metadataEntries: MetadataEntry[] = []
  let databaseInspection: DatabaseInspection | null = null
  let databaseInspectionBusy = false
  let databaseCompactionBusy = false
  let databaseMaintenanceStatus: DatabaseMaintenanceStatus | null = null
  let launchMaintenanceStarted = false
  let databaseInspectionError = ''
  let databaseSearch = ''
  let databaseExpandedId: string | null = null
  let databaseCopyStatus = ''
  let databaseLoadingMessages = [...DEFAULT_DATABASE_LOADING_MESSAGES]
  let databaseLoadingMessagesDraft = databaseLoadingMessages.join('\n')
  let databaseLoadingMessageIndex = randomDatabaseLoadingMessageIndex(databaseLoadingMessages)
  let editingDatabaseLoadingMessages = false
  let previousDatabaseLoadingMessages = databaseLoadingMessages
  // Holds the id of the plan whose reminder is being edited, so either day in the
  // side-by-side comparison can be edited without the other pane's input opening.
  let editingReminderPlanId: Id | null = null
  let dailyReminderDraft = ''
  let dailyReminderInput: HTMLInputElement | null = null
  let dailyReminderHistoryRevision = 0
  // ---- Side-by-side days ----
  // The comparison day is view state, not app state: it lives next to the active
  // plan date rather than in the store, and only survives via localStorage.
  let compareDayOpen = false
  let compareDayDate = ''
  let compareDayStateReady = false
  // Which of the two panes owns the item selection / plan keyboard shortcuts.
  // Null (and always, when the comparison is closed) means the primary pane.
  let focusedPlanId: Id | null = null
  type ItemSurface = 'plan' | 'day-template' | 'list-template'
  type TreeNode = { id: Id; children: TreeNode[] }
  type ItemSelectionState = {
    selectedItemIds: Id[]
    selectionAnchorId: Id | null
    selectionFocusId: Id | null
  }
  type ItemCaretState = {
    inputId: Id
    start: number
    end: number
  }
  let selectedItemIds: Id[] = []
  let selectionAnchorId: Id | null = null
  let selectionFocusId: Id | null = null
  let selectedItemContext = ''
  let itemStateContext = ''
  let itemContextRestoreNonce = 0
  const itemSelectionsByContext: Record<string, ItemSelectionState> = {}
  const itemCaretsByContext: Record<string, ItemCaretState> = {}
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
  type AndroidBackListener = Awaited<ReturnType<typeof onBackButtonPress>>
  let androidSelectionBackListener: AndroidBackListener | null = null
  let androidSelectionBackRegistration: Promise<AndroidBackListener> | null = null
  let androidSelectionBackWanted = false
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
    placement: 'before' | 'after' | 'replace'
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
  $: syncAndroidSelectionBackListener(isAndroid && isTauri() && selectedItemIds.length > 0)
  let newGoalName = ''
  let newGoalCadenceDays = 1
  let newGoalTerms = ''
  let newGoalTermsHtml = ''
  let newGoalHue = 165
  let newGoalLightness = 50
  let goalFormStatus = ''
  let goalSearch = ''
  let goalSearchInput: HTMLInputElement | null = null
  let highlightedGoalCardId: Id | null = null
  let lockedGoalOrder: Id[] | null = null

  // Svelte's legacy prop/store equality treats arrays as changed even when the
  // reference is identical. Keep stable collection references so editing one
  // plan item does not invalidate unrelated, expensive trees (most notably the
  // goal-history grid) on every keystroke.
  let templates = $plannerStore.templates
  let listTemplates = $plannerStore.listTemplates
  let lists = $plannerStore.lists
  let metrics = $plannerStore.metrics
  let allNotes = $plannerStore.notes
  let notes = allNotes.filter((note) => !isNoteTrashed(note))
  let goals = $plannerStore.goals
  let goalCompletions = $plannerStore.goalCompletions
  let goalHistoryGoals = goals
  let goalHistoryUpdateTimer: number | null = null
  let goalNameEditing = false
  $: if (templates !== $plannerStore.templates) templates = $plannerStore.templates
  $: if (listTemplates !== $plannerStore.listTemplates) listTemplates = $plannerStore.listTemplates
  $: if (lists !== $plannerStore.lists) lists = $plannerStore.lists
  $: if (metrics !== $plannerStore.metrics) metrics = $plannerStore.metrics
  $: if (allNotes !== $plannerStore.notes) {
    allNotes = $plannerStore.notes
    notes = allNotes.filter((note) => !isNoteTrashed(note))
  }
  $: if (goals !== $plannerStore.goals) goals = $plannerStore.goals
  $: if (goalCompletions !== $plannerStore.goalCompletions) goalCompletions = $plannerStore.goalCompletions
  $: if (goals !== goalHistoryGoals) scheduleGoalHistoryUpdate()
  $: displayedPlanDate = celebrationPreview?.previewDate ?? $plannerStore.activePlanDate
  $: displayedCompareDayOpen = compareDayOpen && !celebrationPreview
  $: activePlan = $plannerStore.plans.find((plan) => plan.date === displayedPlanDate)
  $: activePlanTimeWarnings = buildItemTimeWarnings(activePlan?.items ?? [])
  $: comparePlan = displayedCompareDayOpen ? $plannerStore.plans.find((plan) => plan.date === compareDayDate) : undefined
  $: comparePlanTimeWarnings = buildItemTimeWarnings(comparePlan?.items ?? [])
  // One pane when closed, two when comparing. Rendering the normal day through
  // the same loop keeps a single copy of the day markup.
  $: dayPanes = [
    {
      key: 'primary' as const,
      date: displayedPlanDate,
      plan: activePlan,
      timeWarnings: activePlanTimeWarnings,
    },
    ...(displayedCompareDayOpen
      ? [
          {
            key: 'compare' as const,
            date: compareDayDate,
            plan: comparePlan,
            timeWarnings: comparePlanTimeWarnings,
          },
        ]
      : []),
  ]
  // Selection, clipboard and the plan keyboard shortcuts act on whichever day was
  // last touched; everything else (celebrations, goal tracking, generation) stays
  // anchored to the active plan date.
  $: focusedPlan = displayedCompareDayOpen && comparePlan && focusedPlanId === comparePlan.id ? comparePlan : activePlan
  $: if (compareDayStateReady) persistCompareDayState(compareDayOpen, compareDayDate)
  // Scroll position is remembered per page. Today scrolls independently for each
  // date, and List Templates scrolls independently for each template.
  $: scrollPageKey =
    view === 'today'
      ? `today:${displayedPlanDate || ''}`
      : view === 'listTemplates'
        ? `list-template:${selectedListTemplate?.id ?? ''}`
        : `view:${view}`
  $: if (workspaceViewStateReady) restoreScrollForPage(scrollPageKey)
  $: activeDailyReminder = activePlan?.dailyReminder ?? DEFAULT_DAILY_REMINDER
  $: if (!editingReminderPlanId) dailyReminderDraft = activeDailyReminder
  $: if ($plannerStore.historyRevision !== dailyReminderHistoryRevision) {
    dailyReminderHistoryRevision = $plannerStore.historyRevision
    if (editingReminderPlanId) {
      const editedPlan = $plannerStore.plans.find((plan) => plan.id === editingReminderPlanId)
      if (editedPlan) dailyReminderDraft = editedPlan.dailyReminder
    }
  }
  $: selectedTemplate = templates.find((template) => template.id === selectedTemplateId) ?? templates[0]
  $: selectedTemplateTimeWarnings = buildItemTimeWarnings(selectedTemplate?.items ?? [])
  $: if (!selectedTemplateId && templates[0]) selectedTemplateId = templates[0].id
  $: if (dayTemplateSelectionReady && templates.length > 0 && !templates.some((template) => template.id === selectedTemplateId)) {
    selectedTemplateId = templates[0].id
  }
  $: if (dayTemplateSelectionReady && selectedTemplate) {
    localStorage.setItem(DAY_TEMPLATE_SELECTION_KEY, selectedTemplate.id)
  }

  // ---- Lists ----
  $: if (view === 'lists') listHistoryNavigationVisible = true
  $: selectedListTemplate = listTemplates.find((template) => template.id === selectedListTemplateId) ?? listTemplates[0]
  $: if (!selectedListTemplateId && listTemplates[0]) selectedListTemplateId = listTemplates[0].id
  $: if (listTemplatesViewStateReady && !listTemplates.some((template) => template.id === selectedListTemplateId)) {
    selectedListTemplateId = listTemplates[0]?.id ?? ''
  }
  $: if (listTemplatesViewStateReady) persistListTemplatesViewState(selectedListTemplateId)
  $: if (!listViewTemplateId && listTemplates[0]) listViewTemplateId = listTemplates[0].id
  $: selectedListWordCount = selectedListTemplate ? Math.round(expectedWordCount(selectedListTemplate.items)) : 0
  $: selectedListTotalWordCount = selectedListTemplate ? totalWordCount(selectedListTemplate.items) : 0
  $: selectedArchivedListItems = [...(selectedListTemplate?.archivedItems ?? [])]
    .sort((left, right) => right.archivedAt.localeCompare(left.archivedAt))
  $: listViewInstance = lists.find(
    (list) => list.listTemplateId === listViewTemplateId && list.date === $plannerStore.activePlanDate,
  )

  // ---- Metrics ----
  $: selectedMetric = metrics.find((metric) => metric.id === selectedMetricId) ?? metrics[0]
  $: if (!selectedMetricId && metrics[0]) selectedMetricId = metrics[0].id
  $: if (!importMetricId && metrics[0]) importMetricId = metrics[0].id
  // ---- Notes ----
  $: if (!selectedNoteId && notes[0]) selectedNoteId = notes[0].id
  $: if (selectedNoteId && !allNotes.some((note) => note.id === selectedNoteId)) selectedNoteId = notes[0]?.id ?? ''

  // ---- Overlays: auto-close a list toast once every box is checked ----
  // Only auto-close when the list *transitions* to complete while open, so
  // reopening an already-finished list lets you review it instead of slamming shut.
  $: listOverlayInstance = listOverlay ? lists.find((list) => list.id === listOverlay?.listId) : null
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
  $: generateButtonLabel = displayedPlanDate === currentDay ? 'Generate today' : 'Generate selected day'
  $: selectedItemIdSet = new Set(selectedItemIds)
  $: activeGoalCount = goals.filter((goal) => isGoalActiveOnDate(goal, currentDay)).length
  $: sortedGoals = sortGoalsByUrgency(goals, goalCompletions, currentDay)
  $: displayedGoals = lockedGoalOrder ? applyGoalOrder(sortedGoals, lockedGoalOrder) : sortedGoals
  $: filteredGoals = filterGoalsByPhrase(displayedGoals, goalSearch)
  $: themeId = selectedThemeForDate(deviceAppearance, currentDay)
  $: effectiveThemeId = effectiveThemeForDate(deviceAppearance, currentDay)
  $: randomThemeScheduled = deviceAppearance.themeId !== 'random'
    && deviceAppearance.randomThemeStartDate > currentDay
  $: if (
    preferencesReady
    && deviceAppearance.themeId !== 'random'
    && deviceAppearance.randomThemeStartDate
    && deviceAppearance.randomThemeStartDate <= currentDay
  ) {
    activateScheduledRandomTheme()
  }
  $: doneTintColor = deviceAppearance.doneTintColor
  $: checkboxColor = deviceAppearance.checkboxColor
  $: completionCelebrationId = normalizeCompletionCelebrationId(
    $plannerStore.preferences.completionCelebrationId,
  )
  $: iridescentGradient = deviceAppearance.iridescentGradient
  $: historicalThemeId = view === 'today'
    && !celebrationPreview
    && displayedPlanDate < currentDay
    ? replicatedDayTheme($plannerStore.preferences, displayedPlanDate)
    : null
  $: displayedThemeId = historicalThemeId
    ? normalizePresetThemeId(historicalThemeId)
    : effectiveThemeId
  $: document.documentElement.dataset.theme = displayedThemeId
  $: observeCurrentTodayTheme(
    preferencesReady
      && view === 'today'
      && !celebrationPreview
      && displayedPlanDate === currentDay,
    currentDay,
    effectiveThemeId,
  )
  $: applyIridescentGradient(iridescentGradient)
  $: if ($plannerStore.preferences.databaseLoadingMessages !== previousDatabaseLoadingMessages) {
    previousDatabaseLoadingMessages = $plannerStore.preferences.databaseLoadingMessages
    databaseLoadingMessages = $plannerStore.preferences.databaseLoadingMessages
    databaseLoadingMessageIndex = randomDatabaseLoadingMessageIndex(databaseLoadingMessages)
    if (!editingDatabaseLoadingMessages) databaseLoadingMessagesDraft = databaseLoadingMessages.join('\n')
  }
  $: activeTheme = THEME_PRESETS.find((theme) => theme.id === displayedThemeId) ?? THEME_PRESETS[0]
  $: doneTintHex = doneTintColor || activeTheme.doneColor
  $: checkboxColorHex = checkboxColor || activeTheme.checkboxColor
  $: doneTintPickerColor = hexToPickerColor(doneTintHex)
  $: checkboxPickerColor = hexToPickerColor(checkboxColorHex)
  // Blend the chosen color in lightly so the row reads as a tint, not a fill.
  $: doneTintValue = `color-mix(in srgb, ${doneTintHex} 14%, transparent)`
  $: appShellStyle = [
    doneTintColor ? `--done-tint: ${doneTintValue}` : '',
    checkboxColor ? `--checkbox-checked: ${checkboxColorHex}` : '',
    checkboxColor
      ? `--checkbox-checked-hover: color-mix(in srgb, ${checkboxColorHex} 88%, black)`
      : '',
  ]
    .filter(Boolean)
    .join('; ')
  $: contentShellStyle = [
    !goalRhythmVisible
      ? '--goal-history-height: 0px'
      : goalHistoryHeight != null
        ? `--goal-history-height: ${goalHistoryHeight}px`
        : '',
  ]
    .filter(Boolean)
    .join('; ')
  $: viewMaximized = maximizedView === view
  $: if (maximizedView && view !== maximizedView) leaveViewMaximized()
  // Derived rather than computed on demand so that switching surfaces — including
  // switching between the two side-by-side days — retriggers the guard below.
  $: activeItemContext =
    view === 'today' && focusedPlan
      ? `plan:${focusedPlan.id}`
      : view === 'templates' && selectedTemplate
        ? `day-template:${selectedTemplate.id}`
        : view === 'listTemplates' && selectedListTemplate
          ? `list-template:${selectedListTemplate.id}`
          : ''
  $: if (activeItemContext !== itemStateContext) void switchItemContext(activeItemContext)
  // The list overlay toast belongs to the page it was opened over: leaving that
  // page hides it, returning shows it again (its state + selection persist).
  $: listOverlayVisible = Boolean(listOverlay && listOverlayInstance && view === listOverlayView)
  $: if (workspaceViewStateReady && !celebrationPreview) {
    persistWorkspaceViewState(
      view,
      listOverlay,
      listOverlayView,
      selectedListOverlayItemIdsByList,
      listOverlayScrollTopsByList,
    )
  }
  $: filteredDatabaseOperations = filterDatabaseRows(databaseInspection?.operations ?? [], databaseSearch)
  $: filteredDatabaseHistoryEntries = filterDatabaseRows(databaseInspection?.historyEntries ?? [], databaseSearch)
  $: filteredDatabasePlans = filterDatabaseRows(databaseInspection?.plans ?? [], databaseSearch)
  $: observeActivePlanCompletion(activePlan, displayedPlanDate, view, completionTrackingReady)
  $: observeGoalItemCompletions(activePlan, view, completionTrackingReady)
  $: observeGoalItemCompletions(comparePlan, view, completionTrackingReady)
  $: observeListCompletions(
    lists,
    view === 'lists' ? (listViewInstance?.id ?? null) : null,
    listOverlayVisible ? (listOverlayInstance?.id ?? null) : null,
    completionTrackingReady,
  )

  function allPlanItemsDone(items: PlanItem[]): boolean {
    if (items.length === 0) return false
    return items.every((item) => item.done && (item.children.length === 0 || allPlanItemsDone(item.children)))
  }

  function openLists() {
    view = 'listTemplates'
    listHistoryNavigationVisible = false
  }

  function openListHistory() {
    view = 'lists'
    listHistoryNavigationVisible = true
  }

  function mobileDrawerWidth() {
    return Math.min(window.innerWidth * 0.86, 320)
  }

  function closeMobileDrawer() {
    mobileDrawerOpen = false
    finishMobileDrawerGesture()
  }

  function openMobileDrawerView(nextView: View) {
    closeMobileDrawer()
    if (nextView === 'listTemplates') {
      openLists()
    } else if (nextView === 'lists') {
      openListHistory()
    } else if (nextView === 'goals') {
      void openGoals()
    } else {
      view = nextView
    }
  }

  function openMobileDrawerSearch() {
    closeMobileDrawer()
    documentFindOpen = false
    searchOpen = true
  }

  function undoViewForOperation(operationType: string): View | null {
    if (operationType.includes('list_template')) return 'listTemplates'
    if (operationType === 'generate_list' || operationType.includes('list_item')) return 'lists'
    if (
      operationType === 'generate_plan' ||
      operationType === 'set_active_plan_date' ||
      operationType.includes('plan_item') ||
      operationType.includes('plan_daily_reminder')
    ) return 'today'
    if (operationType.includes('template')) return 'templates'
    if (operationType.includes('note')) return 'notes'
    if (operationType.includes('metric')) return 'metrics'
    if (operationType.includes('goal')) return 'goals'
    return null
  }

  async function undoAndOpenDestination() {
    const operationType = await plannerStore.undo()
    if (!operationType) return

    const destination = undoViewForOperation(operationType)
    if (!destination) return

    searchOpen = false
    documentFindOpen = false
    openMobileDrawerView(destination)
  }

  function beginMobileDrawerGesture(event: PointerEvent) {
    if (!usesMobileLayout() || !mobileDrawerOpen || event.button !== 0 || mobileDrawerGesture) return

    mobileDrawerGesture = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      axis: null,
      offset: 0,
    }
  }

  function renderMobileDrawerOffset(offset: number) {
    mobileDrawerPendingOffset = offset
    if (mobileDrawerAnimationFrame != null) return
    mobileDrawerAnimationFrame = requestAnimationFrame(() => {
      mobileDrawerAnimationFrame = null
      const width = mobileDrawerWidth()
      mobileDrawerEl?.style.setProperty('transform', `translate3d(${mobileDrawerPendingOffset}px, 0, 0)`)
      mobileDrawerBackdropEl?.style.setProperty('opacity', String(1 - Math.abs(mobileDrawerPendingOffset) / width))
    })
  }

  function finishMobileDrawerGesture() {
    if (mobileDrawerAnimationFrame != null) {
      cancelAnimationFrame(mobileDrawerAnimationFrame)
      mobileDrawerAnimationFrame = null
    }
    mobileDrawerGesture = null
    mobileDrawerDragging = false
    void tick().then(() => {
      mobileDrawerEl?.style.removeProperty('transform')
      mobileDrawerBackdropEl?.style.removeProperty('opacity')
    })
  }

  function moveMobileDrawerGesture(event: PointerEvent) {
    const gesture = mobileDrawerGesture
    if (!gesture || event.pointerId !== gesture.pointerId) return
    const deltaX = event.clientX - gesture.startX
    const deltaY = event.clientY - gesture.startY

    if (!gesture.axis && Math.max(Math.abs(deltaX), Math.abs(deltaY)) >= 8) {
      gesture.axis = Math.abs(deltaX) > Math.abs(deltaY) ? 'horizontal' : 'vertical'
      if (gesture.axis === 'vertical') {
        finishMobileDrawerGesture()
        return
      }
      mobileDrawerDragging = true
    }
    if (gesture.axis !== 'horizontal') return

    event.preventDefault()
    const width = mobileDrawerWidth()
    gesture.offset = Math.max(-width, Math.min(0, deltaX))
    renderMobileDrawerOffset(gesture.offset)
  }

  function endMobileDrawerGesture(event?: PointerEvent) {
    const gesture = mobileDrawerGesture
    if (!gesture || (event && event.pointerId !== gesture.pointerId)) return
    const width = mobileDrawerWidth()
    if (gesture.axis === 'horizontal') {
      mobileDrawerOpen = gesture.offset > -width * 0.35
    }
    finishMobileDrawerGesture()
  }

  function observeActivePlanCompletion(
    plan: DailyPlan | undefined,
    selectedDate: string,
    currentView: View,
    ready: boolean,
  ) {
    if (!ready) return

    if (celebrationKind === 'day' && celebrationDate && (celebrationDate !== selectedDate || currentView !== 'today')) {
      dismissCelebration()
    }
    if (!plan) {
      if (celebrationKind === 'day') dismissCelebration()
      return
    }

    const complete = allPlanItemsDone(plan.items)
    const wasComplete = planCompletionById.get(plan.id)
    planCompletionById.set(plan.id, complete)

    if (wasComplete === false && complete && currentView === 'today') {
      celebrationDate = plan.date
      celebrationListId = null
      celebrationKind = 'day'
      celebration?.play({ kind: 'day', celebrationId: completionCelebrationId })
    } else if (wasComplete === true && !complete && celebrationKind === 'day' && celebrationDate === plan.date) {
      dismissCelebration()
    }
  }

  function observeListCompletions(
    lists: ListInstance[],
    visibleListId: Id | null,
    visibleOverlayListId: Id | null,
    ready: boolean,
  ) {
    if (!ready) return

    const currentListIds = new Set(lists.map((list) => list.id))
    for (const trackedId of listCompletionById.keys()) {
      if (!currentListIds.has(trackedId)) listCompletionById.delete(trackedId)
    }

    for (const list of lists) {
      const complete = allPlanItemsDone(list.items)
      const wasComplete = listCompletionById.get(list.id)
      listCompletionById.set(list.id, complete)

      const visible = list.id === visibleListId || list.id === visibleOverlayListId
      if (wasComplete === false && complete && visible) {
        celebrateList(list.id)
      } else if (wasComplete === true && !complete && celebrationKind === 'list' && celebrationListId === list.id) {
        dismissCelebration()
      }
    }
  }

  function celebrateList(listId: Id) {
    if (celebrationKind === 'list' && celebrationListId === listId) return
    celebrationDate = null
    celebrationListId = listId
    celebrationKind = 'list'
    celebration?.play({ kind: 'list' })
  }

  function dismissCelebration() {
    celebrationDate = null
    celebrationListId = null
    celebrationKind = null
    celebration?.dismiss()
  }

  function waitForAnimationFrame(): Promise<void> {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()))
  }

  function clearCelebrationPreviewTimer() {
    if (celebrationPreviewTimer !== null) {
      window.clearTimeout(celebrationPreviewTimer)
      celebrationPreviewTimer = null
    }
  }

  async function startCelebrationPreview(id: CompletionCelebrationId) {
    plannerStore.patchPreferences({ completionCelebrationId: id })
    clearCelebrationPreviewTimer()
    dismissCelebration()
    rememberWorkspaceScroll()

    const token = ++celebrationPreviewToken
    const settingsScrollTop = currentWorkspaceScrollTop()
    scrollPositionsByPage['view:settings'] = settingsScrollTop
    celebrationPreview = {
      token,
      celebrationId: id,
      previewDate: shiftISODate(currentDay, -1),
      returnView: view,
      persistedActivePlanDate: $plannerStore.activePlanDate,
      compareDayOpen,
      compareDayDate,
      settingsScrollTop,
      focusCelebrationId: id,
    }
    celebrationPreviewAnnouncement = ''
    closeMobileDrawer()
    view = 'today'

    await tick()
    await waitForAnimationFrame()
    if (!celebrationPreview || celebrationPreview.token !== token) return

    const definition = getCompletionCelebration(id)
    const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    const previewDuration = prefersReducedMotion
      ? 2_000
      : Math.min(5_000, Math.max(3_200, definition.durationMs))
    try {
      celebration?.play({ kind: 'day', celebrationId: definition.id, preview: true })
    } catch (error) {
      console.error(`Could not preview ${definition.name}`, error)
    }
    celebrationPreviewTimer = window.setTimeout(() => {
      void finishCelebrationPreview(token)
    }, previewDuration)
  }

  async function finishCelebrationPreview(token = celebrationPreview?.token) {
    const preview = celebrationPreview
    if (!preview || token !== preview.token || token !== celebrationPreviewToken) return

    clearCelebrationPreviewTimer()
    celebration?.dismiss()
    celebrationDate = null
    celebrationListId = null
    celebrationKind = null
    celebrationPreview = null
    view = preview.returnView
    scrollPositionsByPage['view:settings'] = preview.settingsScrollTop

    await tick()
    await waitForAnimationFrame()
    if (token !== celebrationPreviewToken || celebrationPreview) return

    if (usesWindowScroll()) window.scrollTo(0, preview.settingsScrollTop)
    else if (workspaceEl) workspaceEl.scrollTop = preview.settingsScrollTop
    document
      .querySelector<HTMLButtonElement>(`[data-celebration-option="${preview.focusCelebrationId}"]`)
      ?.focus({ preventScroll: true })
    celebrationPreviewAnnouncement = 'Preview finished. Settings restored.'
    if (celebrationPreviewAnnouncementTimer !== null) {
      window.clearTimeout(celebrationPreviewAnnouncementTimer)
    }
    celebrationPreviewAnnouncementTimer = window.setTimeout(() => {
      celebrationPreviewAnnouncement = ''
      celebrationPreviewAnnouncementTimer = null
    }, 2_500)
  }

  function handleCelebrationVisibilityChange() {
    if (document.hidden && celebrationPreview) {
      void finishCelebrationPreview(celebrationPreview.token)
    }
  }

  // Fire a fun burst whenever a plan item that contributes to a goal is checked
  // off. Diffing done state here (rather than at each checkbox) catches every
  // completion path — checkbox, keyboard `d`, and bulk toggles alike.
  function observeGoalItemCompletions(plan: DailyPlan | undefined, currentView: View, ready: boolean) {
    if (!ready || !plan) return

    const goals = $plannerStore.goals
    const justCompleted: { item: PlanItem; goals: Goal[] }[] = []

    const visit = (items: PlanItem[]) => {
      for (const item of items) {
        const wasDone = goalItemDoneById.get(item.id)
        if (wasDone === false && item.done) {
          const matched = goalsMatchingItemText(item, goals, plan.date)
          if (matched.length > 0) justCompleted.push({ item, goals: matched })
        }
        goalItemDoneById.set(item.id, item.done)
        visit(item.children)
      }
    }
    visit(plan.items)

    // Only celebrate on the plan surface, where the checked item is on screen.
    if (currentView !== 'today') return
    for (const { item, goals: matched } of justCompleted) fireGoalBurst(item.id, matched)
  }

  function fireGoalBurst(itemId: Id, goals: Goal[]) {
    requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(`[data-plan-item-id="${CSS.escape(itemId)}"]`)
      const check = row?.querySelector<HTMLElement>('.check') ?? row
      const rect = check?.getBoundingClientRect()
      if (!rect || rect.width === 0) return

      // A quick springy nudge on the completed row, tinted with the goal color.
      if (row) {
        const goal = goals[0]
        row.style.setProperty('--goal-pop-color', `hsla(${goal.hue}, 74%, 55%, 0.65)`)
        pulseElement(row, 'goal-row-pop', 600)
      }

      goalBurst?.burst(rect.left + rect.width / 2, rect.top + rect.height / 2, goals, goalRhythmTarget(goals[0]))
    })
  }

  // Where the burst's homing comet should fly: the goal's cell for today in the
  // Goal Rhythm strip, if that panel is open and the goal is showing. The comet
  // then flares the goal's row so completing an item visibly "feeds" the goal.
  function goalRhythmTarget(goal: Goal): { x: number; y: number; onArrive?: () => void } | undefined {
    if (!goalRhythmVisible) return undefined
    const goalRow = document.querySelector<HTMLElement>(`.goal-history-panel [data-goal-id="${CSS.escape(goal.id)}"]`)
    const todayHead = document.querySelector<HTMLElement>(`.goal-history-panel [data-goal-date="${todayISO()}"]`)
    if (!goalRow || !todayHead) return undefined

    const rowRect = goalRow.getBoundingClientRect()
    const headRect = todayHead.getBoundingClientRect()
    return {
      x: headRect.left + headRect.width / 2,
      y: rowRect.top + rowRect.height / 2,
      onArrive: () => pulseElement(goalRow, 'goal-rhythm-hit', 700),
    }
  }

  function pulseElement(element: HTMLElement, className: string, durationMs: number) {
    element.classList.remove(className)
    // Force reflow so re-adding the class restarts the animation on rapid repeats.
    void element.offsetWidth
    element.classList.add(className)
    window.setTimeout(() => element.classList.remove(className), durationMs)
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

  function openLink(link: ItemLink, opener: Opener | null) {
    const date = $plannerStore.activePlanDate
    if (link.kind === 'note') {
      if (notes.some((note) => note.id === link.noteId)) {
        selectedNoteId = link.noteId
        view = 'notes'
      }
    } else if (link.kind === 'list') {
      const listId = plannerStore.ensureListForDate(link.listTemplateId, date)
      if (listId) {
        if (!Object.prototype.hasOwnProperty.call(selectedListOverlayItemIdsByList, listId)) {
          const instance = $plannerStore.lists.find((list) => list.id === listId)
          selectedListOverlayItemIdsByList = {
            ...selectedListOverlayItemIdsByList,
            [listId]: instance ? (flattenItemIds(instance.items)[0] ?? null) : null,
          }
        }
        listOverlayArmed = false
        listOverlayView = view
        delete listOverlayScrollTopsByList[listId]
        listOverlay = { listId, date, opener }
      }
    } else {
      metricOverlay = { metricId: link.metricId, date, opener }
    }
  }

  function openLinkedListForActiveTask(): boolean {
    if (activeItemSurface() !== 'plan' || !focusedPlan) return false

    const itemId = selectedItemIds.length > 0
      ? (selectionFocusId ?? selectedItemIds.at(-1) ?? null)
      : activeFocusedItemId()
    const item = itemId ? findPlanItem(focusedPlan.items, itemId) : null
    if (!item || !itemId) return false

    const listLink = linkifyItemText(item.text, listTemplates, metrics, notes)
      .find((segment) => segment.link?.kind === 'list')?.link
    if (!listLink || listLink.kind !== 'list') return false

    openLink(listLink, { container: 'plan', containerId: focusedPlan.id, itemId })
    return true
  }

  function binNote(noteId: Id): boolean {
    const note = $plannerStore.notes.find((candidate) => candidate.id === noteId)
    if (!note || note.deletedAt) return false
    plannerStore.trashNote(noteId)
    return true
  }

  async function confirmPermanentlyDeleteNote(noteId: Id): Promise<boolean> {
    const note = $plannerStore.notes.find((candidate) => candidate.id === noteId)
    if (!note?.deletedAt) return false
    const message = `Delete “${note.title.trim() || 'Untitled note'}” now instead of waiting 30 days? You can still undo this action.`
    const confirmed = isTauri()
      ? await confirmDialog(message, { title: 'Delete note now?', kind: 'warning' })
      : window.confirm(message)
    if (!confirmed) return false
    plannerStore.permanentlyDeleteNote(noteId)
    return true
  }

  async function confirmEmptyNoteTrash(): Promise<boolean> {
    const count = $plannerStore.notes.filter((note) => note.deletedAt).length
    if (count === 0) return false
    const message = `Delete ${count} note${count === 1 ? '' : 's'} now instead of waiting 30 days? You can still undo this action.`
    const confirmed = isTauri()
      ? await confirmDialog(message, { title: 'Empty Bin?', kind: 'warning' })
      : window.confirm(message)
    if (!confirmed) return false
    plannerStore.emptyNoteTrash()
    return true
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

    openLists()
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
    celebrateList(overlay.listId)
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
    openLists()
  }

  function selectDayTemplate(templateId: Id) {
    selectedTemplateId = templateId
  }

  async function selectAdjacentDayTemplate(direction: -1 | 1) {
    if (templates.length < 2 || !selectedTemplate) return

    const currentIndex = templates.findIndex((template) => template.id === selectedTemplate.id)
    if (currentIndex === -1) return

    const nextIndex = (currentIndex + direction + templates.length) % templates.length
    selectedTemplateId = templates[nextIndex].id

    await tick()
    const selectedTab = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-day-template-tab-id]'),
    ).find((tab) => tab.dataset.dayTemplateTabId === selectedTemplateId)
    selectedTab?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  function createDayTemplateAndSelect() {
    selectedTemplateId = plannerStore.addTemplate()
    view = 'templates'
  }

  async function confirmDeleteDayTemplate(templateId: Id, templateName: string) {
    if (templates.length <= 1) return

    const message = `Delete “${templateName || 'Untitled day'}”? Saved days generated from it will be kept.`
    const confirmed = isTauri()
      ? await confirmDialog(message, { title: 'Delete day template?', kind: 'warning' })
      : window.confirm(message)
    if (!confirmed) return

    const currentIndex = templates.findIndex((template) => template.id === templateId)
    const nextTemplate = templates[currentIndex + 1] ?? templates[currentIndex - 1]
    plannerStore.deleteTemplate(templateId)
    if (selectedTemplateId === templateId) selectedTemplateId = nextTemplate?.id ?? ''
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
      ? await confirmDialog(message, { title: 'Delete list?', kind: 'warning' })
      : window.confirm(message)
    if (!confirmed) return

    plannerStore.deleteListTemplate(templateId)
  }

  function formatArchivedListItemDate(entry: ArchivedListTemplateItem): string {
    const [year, month, day] = entry.archivedDate.split('-').map(Number)
    if (!year || !month || !day) return entry.archivedDate
    return new Date(year, month - 1, day).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })
  }

  function archivedListItemChildCount(item: ListTemplateItem): number {
    return item.children.reduce((count, child) => count + 1 + archivedListItemChildCount(child), 0)
  }

  async function confirmPermanentlyDeleteArchivedListItem(entry: ArchivedListTemplateItem) {
    if (!selectedListTemplate) return
    const label = entry.item.text.trim() || 'Untitled list item'
    const message = `Delete “${label}” from the archive forever? You can still undo this action.`
    const confirmed = isTauri()
      ? await confirmDialog(message, { title: 'Delete archived item?', kind: 'warning' })
      : window.confirm(message)
    if (!confirmed) return
    plannerStore.permanentlyDeleteArchivedListTemplateItem(selectedListTemplate.id, entry.id)
  }

  function createMetricAndSelect() {
    const id = plannerStore.addMetric()
    selectedMetricId = id
    if (!importMetricId) importMetricId = id
  }

  async function selectAdjacentMetric(direction: -1 | 1) {
    if (metrics.length < 2 || !selectedMetric) return

    const currentIndex = metrics.findIndex((metric) => metric.id === selectedMetric.id)
    if (currentIndex === -1) return

    const nextIndex = (currentIndex + direction + metrics.length) % metrics.length
    selectedMetricId = metrics[nextIndex].id

    await tick()
    const selectedTab = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-metric-tab-id]'),
    ).find((tab) => tab.dataset.metricTabId === selectedMetricId)
    selectedTab?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  function openImportModal() {
    if (selectedMetricId) importMetricId = selectedMetricId
    importError = ''
    importOverlayOpen = true
  }

  onMount(() => {
    let mounted = true
    let stopAutomaticSync: (() => void) | null = null
    let stopPasteMatchStyleListener: (() => void) | null = null
    let stopMacosAltShortcutListener: (() => void) | null = null
    let stopDeepLinkListener: (() => void) | null = null
    let deepLinksReady = false
    const pendingDeepLinks: string[] = []
    let noteTrashCleanupTimer: number | null = null
    let desktopInactivityCloseTimer: number | null = null
    let desktopInactivityCloseRequested = false
    let lastDesktopActivityAt = Date.now()
    const desktopActivityEvents = ['keydown', 'pointerdown', 'pointermove', 'wheel', 'input'] as const

    function receiveDeepLink(raw: string) {
      pendingDeepLinks.push(raw)
      if (deepLinksReady) drainDeepLinks()
    }

    function drainDeepLinks() {
      if (!deepLinksReady || $databaseLoadError) return
      for (const raw of pendingDeepLinks.splice(0)) {
        const deepLink = parseBalanceDeepLink(raw)
        if (!deepLink) continue
        plannerStore.addPlanItemFromSiri(deepLink.text, deepLink.requestId, todayISO())
        closeCompareDay()
        closeMobileDrawer()
        view = 'today'
      }
    }

    if (isTauri() && isMac) {
      void listen<string>(BALANCE_DEEP_LINK_EVENT, ({ payload }) => {
        receiveDeepLink(payload)
      }).then(async (stopListening) => {
        if (!mounted) {
          stopListening()
          return
        }
        stopDeepLinkListener = stopListening
        const queued = await invoke<string[]>('take_pending_deep_links')
        for (const raw of queued) receiveDeepLink(raw)
      }).catch((error) => {
        console.error('Could not listen for Balance deep links', error)
      })
    }

    function closeDesktopIfInactive() {
      if (!isTauri() || isMobile || desktopInactivityCloseRequested) return

      const remaining = DESKTOP_INACTIVITY_CLOSE_MS - (Date.now() - lastDesktopActivityAt)
      if (remaining > 0) {
        desktopInactivityCloseTimer = window.setTimeout(closeDesktopIfInactive, remaining)
        return
      }

      desktopInactivityCloseRequested = true
      void invoke('exit_after_inactivity').catch((error) => {
        desktopInactivityCloseRequested = false
        console.error('Could not close Balance after desktop inactivity', error)
      })
    }

    function recordDesktopActivity() {
      if (!isTauri() || isMobile || desktopInactivityCloseRequested) return

      if (Date.now() - lastDesktopActivityAt >= DESKTOP_INACTIVITY_CLOSE_MS) {
        closeDesktopIfInactive()
        return
      }
      lastDesktopActivityAt = Date.now()
    }

    if (isTauri() && !isMobile) {
      desktopInactivityCloseTimer = window.setTimeout(
        closeDesktopIfInactive,
        DESKTOP_INACTIVITY_CLOSE_MS,
      )
      for (const eventName of desktopActivityEvents) {
        window.addEventListener(eventName, recordDesktopActivity, { passive: true })
      }
      window.addEventListener('focus', recordDesktopActivity)
      document.addEventListener('visibilitychange', recordDesktopActivity)
    }
    const databaseLoadingMessageTimer = window.setInterval(() => {
      if (!$databaseLoadPending || databaseLoadingMessages.length < 2) return
      databaseLoadingMessageIndex = randomDatabaseLoadingMessageIndex(
        databaseLoadingMessages,
        databaseLoadingMessageIndex,
      )
    }, DATABASE_LOADING_MESSAGE_INTERVAL_MS)
    const currentDayTimer = window.setInterval(refreshCurrentDay, 60_000)
    window.addEventListener('focus', refreshCurrentDay)
    document.addEventListener('visibilitychange', refreshCurrentDay)
    document.addEventListener('visibilitychange', handleCelebrationVisibilityChange)
    const storedWorkspaceViewState = readWorkspaceViewState()

    selectedTemplateId = localStorage.getItem(DAY_TEMPLATE_SELECTION_KEY) ?? selectedTemplateId

    const storedListTemplatesViewState = readListTemplatesViewState()
    if (storedListTemplatesViewState) {
      selectedListTemplateId = storedListTemplatesViewState.selectedTemplateId
      scrollPositionsByPage = {
        ...scrollPositionsByPage,
        ...Object.fromEntries(
          Object.entries(storedListTemplatesViewState.scrollTopsByTemplate).map(([templateId, scrollTop]) => [
            `list-template:${templateId}`,
            scrollTop,
          ]),
        ),
      }
    }

    const storedGoalHistoryHeight = Number(localStorage.getItem(GOAL_HISTORY_HEIGHT_KEY))
    if (Number.isFinite(storedGoalHistoryHeight) && storedGoalHistoryHeight > 0) {
      goalHistoryHeight = clampGoalHistoryHeight(storedGoalHistoryHeight)
    }

    restoreCompareDayState()

    async function initialize() {
      if (isTauri()) {
        try {
          recoveryKeyStatus = await getRecoveryKeyStatus()
        } catch (error) {
          databaseLoadError.set(error instanceof Error ? error.message : String(error))
          console.error('Could not open encrypted Balance database', error)
          return
        }
      }

      await plannerStore.ready

      // The store intentionally starts with a placeholder so Svelte can render
      // before native hydration. Never treat that placeholder as user data when
      // SQLCipher or Android Keystore failed to open the real database.
      if ($databaseLoadError) return

      const bootstrapAppearance = readDeviceAppearanceBootstrap()
      let encryptedAppearance: DeviceAppearancePreferences | null = null
      if (!bootstrapAppearance && isTauri()) {
        try {
          encryptedAppearance = await readEncryptedDeviceAppearance()
        } catch (error) {
          console.error('Could not read this device appearance', error)
        }
      }
      deviceAppearance = normalizeDeviceAppearance(
        bootstrapAppearance
          ?? encryptedAppearance
          ?? deviceAppearanceFromLegacyPreferences($plannerStore.preferences),
      )
      writeDeviceAppearanceBootstrap(deviceAppearance)
      deviceAppearanceDatabaseReady = true
      void persistEncryptedDeviceAppearance(deviceAppearance).catch((error) => {
        console.error('Could not save this device appearance', error)
      })

      preferencesReady = true

      plannerStore.purgeExpiredNotes()
      noteTrashCleanupTimer = window.setInterval(() => plannerStore.purgeExpiredNotes(), 60 * 1000)

      // Android may serialize event-plugin registration with command IPC while
      // the WebView is starting. Register optional listeners only after the
      // encrypted database has either opened or failed visibly.
      if (isTauri()) {
        void listen(PASTE_MATCH_STYLE_EVENT, () => {
          void pasteSystemClipboardAsPlainText()
        }).then((stopListening) => {
          if (mounted) stopPasteMatchStyleListener = stopListening
          else stopListening()
        }).catch((error) => {
          console.error('Could not listen for Paste and Match Style', error)
        })

        void listen<MacosAltShortcut>(MACOS_ALT_SHORTCUT_EVENT, ({ payload }) => {
          dispatchMacosAltShortcut(payload)
        }).then((stopListening) => {
          if (mounted) stopMacosAltShortcutListener = stopListening
          else stopListening()
        }).catch((error) => {
          console.error('Could not listen for native macOS Option shortcuts', error)
        })

        if (import.meta.env.PROD) {
          void invoke<AvailableUpdate | null>('check_for_update').then((update) => {
            if (
              mounted &&
              update &&
              localStorage.getItem(DISMISSED_UPDATE_VERSION_KEY) !== update.version
            ) {
              availableUpdate = update
            }
          }).catch((error) => {
            console.error('Failed to check GitHub Releases', error)
          })
        }
      }

      if (!templates.some((template) => template.id === selectedTemplateId)) {
        selectedTemplateId = templates[0]?.id ?? ''
      }
      dayTemplateSelectionReady = true

      if (storedWorkspaceViewState) {
        scrollPositionsByPage = {
          ...scrollPositionsByPage,
          ...storedWorkspaceViewState.scrollPositionsByPage,
        }
        selectedListOverlayItemIdsByList = storedWorkspaceViewState.selectedListOverlayItemIdsByList
        listOverlayScrollTopsByList = storedWorkspaceViewState.listOverlayScrollTopsByList

        const storedOverlay = storedWorkspaceViewState.listOverlay
        if (storedOverlay && $plannerStore.lists.some((list) => list.id === storedOverlay.listId)) {
          listOverlay = {
            listId: storedOverlay.listId,
            date: storedOverlay.date,
            opener: storedOverlay.opener,
          }
          listOverlayView = storedOverlay.view
          view = storedOverlay.view
          if ($plannerStore.activePlanDate !== storedOverlay.date) {
            plannerStore.setActivePlanDate(storedOverlay.date)
          }
        }
      }

      workspaceViewStateReady = true
      listTemplatesViewStateReady = true
      deepLinksReady = true
      drainDeepLinks()
      planCompletionById = new Map(
        $plannerStore.plans.map((plan) => [plan.id, allPlanItemsDone(plan.items)]),
      )
      listCompletionById = new Map(
        $plannerStore.lists.map((list) => [list.id, allPlanItemsDone(list.items)]),
      )
      completionTrackingReady = true
      await loadExportSettings()
      await loadMacosWidgetSettings()

      if (!mounted || !isTauri()) return

      stopAutomaticSync = startAutomaticSync()
      // Pull remote changes before evaluating threshold-based housekeeping.
      await requestSync('launch')
      plannerStore.purgeExpiredNotes()

      try {
        buildInfo = await invoke<{ version: string; commit: string }>('build_info')
      } catch (error) {
        console.error('Failed to load build info', error)
      }

      if (!recoveryKeyStatus?.recoveryKey) {
        await runLaunchDatabaseMaintenance()
      }

    }

    void initialize()

    return () => {
      rememberWorkspaceScroll()
      mounted = false
      stopAutomaticSync?.()
      stopPasteMatchStyleListener?.()
      stopMacosAltShortcutListener?.()
      stopDeepLinkListener?.()
      stopAndroidSelectionBackListener()
      window.clearInterval(databaseLoadingMessageTimer)
      window.clearInterval(currentDayTimer)
      if (desktopInactivityCloseTimer !== null) window.clearTimeout(desktopInactivityCloseTimer)
      if (noteTrashCleanupTimer !== null) window.clearInterval(noteTrashCleanupTimer)
      for (const eventName of desktopActivityEvents) {
        window.removeEventListener(eventName, recordDesktopActivity)
      }
      window.removeEventListener('focus', recordDesktopActivity)
      document.removeEventListener('visibilitychange', recordDesktopActivity)
      window.removeEventListener('focus', refreshCurrentDay)
      document.removeEventListener('visibilitychange', refreshCurrentDay)
      document.removeEventListener('visibilitychange', handleCelebrationVisibilityChange)
      if (goalHistoryUpdateTimer !== null) window.clearTimeout(goalHistoryUpdateTimer)
      clearCelebrationPreviewTimer()
      if (celebrationPreviewAnnouncementTimer !== null) {
        window.clearTimeout(celebrationPreviewAnnouncementTimer)
      }
      celebrationPreviewToken += 1
      celebrationPreview = null
      clearGoalRhythmAutoShowTimer()
      dismissCelebration()
    }
  })

  function refreshCurrentDay() {
    const nextDay = todayISO()
    if (nextDay !== currentDay) {
      currentDay = nextDay
      lastObservedTodayKey = ''
    }
    recordVisibleTodayTheme()
  }

  function observeCurrentTodayTheme(visible: boolean, date: string, concreteThemeId: PresetThemeId) {
    if (!visible) {
      lastObservedTodayKey = ''
      return
    }
    const observationKey = `${date}\0${concreteThemeId}`
    if (lastObservedTodayKey === observationKey) return
    lastObservedTodayKey = observationKey
    plannerStore.recordDayTheme(date, concreteThemeId)
  }

  function recordVisibleTodayTheme() {
    if (
      preferencesReady
      && view === 'today'
      && !celebrationPreview
      && displayedPlanDate === currentDay
    ) {
      plannerStore.recordDayTheme(currentDay, effectiveThemeId)
    }
  }

  function commitDeviceAppearance(patch: Partial<DeviceAppearancePreferences>) {
    deviceAppearance = normalizeDeviceAppearance({ ...deviceAppearance, ...patch })
    writeDeviceAppearanceBootstrap(deviceAppearance)
    if (deviceAppearanceDatabaseReady) {
      void persistEncryptedDeviceAppearance(deviceAppearance).catch((error) => {
        console.error('Could not save this device appearance', error)
      })
    }
  }

  function normalizeDatabaseLoadingMessages(value: string): string[] {
    return value
      .split(/\r?\n/)
      .map((message) => message.trim())
      .filter(Boolean)
  }

  function randomDatabaseLoadingMessageIndex(messages: string[], currentIndex = -1): number {
    if (messages.length < 2) return 0
    const nextOffset = 1 + Math.floor(Math.random() * (messages.length - 1))
    return currentIndex < 0 ? Math.floor(Math.random() * messages.length) : (currentIndex + nextOffset) % messages.length
  }

  function updateDatabaseLoadingMessages(value: string) {
    editingDatabaseLoadingMessages = true
    databaseLoadingMessagesDraft = value
    databaseLoadingMessages = normalizeDatabaseLoadingMessages(value)
    databaseLoadingMessageIndex = randomDatabaseLoadingMessageIndex(databaseLoadingMessages)
    plannerStore.patchPreferences({ databaseLoadingMessages })
  }

  function finishEditingDatabaseLoadingMessages() {
    editingDatabaseLoadingMessages = false
    databaseLoadingMessagesDraft = databaseLoadingMessages.join('\n')
  }

  function resetDatabaseLoadingMessages() {
    editingDatabaseLoadingMessages = false
    databaseLoadingMessages = [...DEFAULT_DATABASE_LOADING_MESSAGES]
    databaseLoadingMessagesDraft = databaseLoadingMessages.join('\n')
    databaseLoadingMessageIndex = randomDatabaseLoadingMessageIndex(databaseLoadingMessages)
    plannerStore.patchPreferences({ databaseLoadingMessages })
  }

  async function loadMacosWidgetSettings() {
    if (!isTauri() || !isMac || isMobile) return

    widgetPrivacySettingsBusy = true
    widgetPrivacySettingsStatus = ''
    widgetPrivacySettingsStatusIsError = false
    try {
      const settings = await invoke<MacosWidgetSettings>('get_macos_widget_settings')
      widgetHideContentAfterClose = settings.hideContentAfterClose
      widgetPrivacySettingsReady = true
    } catch (error) {
      widgetPrivacySettingsStatusIsError = true
      widgetPrivacySettingsStatus = error instanceof Error ? error.message : String(error)
    } finally {
      widgetPrivacySettingsBusy = false
    }
  }

  async function updateWidgetHideContentAfterClose(enabled: boolean) {
    const previous = widgetHideContentAfterClose
    widgetHideContentAfterClose = enabled
    widgetPrivacySettingsBusy = true
    widgetPrivacySettingsStatus = ''
    widgetPrivacySettingsStatusIsError = false
    try {
      const settings = await invoke<MacosWidgetSettings>('set_macos_widget_hide_content_after_close', { enabled })
      widgetHideContentAfterClose = settings.hideContentAfterClose
      widgetPrivacySettingsStatus = enabled
        ? 'Widget content will be hidden 15 minutes after Balance closes.'
        : 'Widget content will remain visible when Balance closes.'
    } catch (error) {
      widgetHideContentAfterClose = previous
      widgetPrivacySettingsStatusIsError = true
      widgetPrivacySettingsStatus = error instanceof Error ? error.message : String(error)
    } finally {
      widgetPrivacySettingsBusy = false
    }
  }

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
    commitDeviceAppearance({ doneTintColor: normalized })
  }

  function updateCheckboxColor(value: string) {
    const normalized = normalizeHexColor(value)
    if (!normalized) return
    commitDeviceAppearance({ checkboxColor: normalized })
  }

  function updateDoneTintFromPicker(color: PickerColor) {
    updateDoneTint(pickerColorToHex(color))
  }

  function updateCheckboxColorFromPicker(color: PickerColor) {
    updateCheckboxColor(pickerColorToHex(color))
  }

  function updateTheme(nextThemeId: ThemeId) {
    // A preset should look cohesive immediately. Fine-tuned completion colors
    // remain available below and become overrides only after the preset is set.
    if (nextThemeId === themeId && !deviceAppearance.randomThemeStartDate) return
    commitDeviceAppearance({
      themeId: nextThemeId,
      randomThemeStartDate: '',
      doneTintColor: '',
      checkboxColor: '',
    })
  }

  function toggleRandomThemeSchedule() {
    commitDeviceAppearance({
      randomThemeStartDate: randomThemeScheduled ? '' : shiftISODate(currentDay, 1),
    })
  }

  function activateScheduledRandomTheme() {
    commitDeviceAppearance({
      themeId: 'random',
      randomThemeStartDate: '',
      doneTintColor: '',
      checkboxColor: '',
    })
  }

  function adjustedIridescentBaseColor(
    hue: number,
    saturation: number,
    lightness: number,
    preferences: IridescentGradientPreferences,
  ): string {
    const adjustedSaturation = Math.max(0, Math.min(100, saturation * preferences.backgroundSaturation / 100))
    const adjustedLightness = Math.max(0, Math.min(100, lightness + preferences.backgroundLightness))
    return `hsl(${hue} ${adjustedSaturation.toFixed(1)}% ${adjustedLightness.toFixed(1)}%)`
  }

  function applyIridescentGradient(preferences: IridescentGradientPreferences) {
    const root = document.documentElement
    const colorNames = ['pink', 'aqua', 'gold']
    const isDefault = JSON.stringify(preferences) === JSON.stringify(defaultIridescentGradient)
    const defaultLightColors = ['rgb(242 76 159 / 0.13)', 'rgb(57 197 214 / 0.14)', 'rgb(240 162 62 / 0.13)']
    const defaultDarkColors = ['rgb(240 71 164 / 0.15)', 'rgb(51 198 218 / 0.14)', 'rgb(246 170 66 / 0.11)']
    const darkAdjustments = [
      { hue: -3, saturation: 0, lightness: -1, strength: 15 / 13 },
      { hue: 0, saturation: 4, lightness: 0, strength: 1 },
      { hue: 1, saturation: 5, lightness: 2, strength: 11 / 13 },
    ]
    preferences.colors.forEach((color, index) => {
      const alpha = Math.max(0, Math.min(1, color.strength / 100 * preferences.contrast / 100))
      const dark = darkAdjustments[index]
      const darkAlpha = Math.max(0, Math.min(1, alpha * dark.strength))
      root.style.setProperty(
        `--iridescent-${colorNames[index]}`,
        isDefault ? defaultLightColors[index] : `hsl(${color.hue} ${color.saturation}% ${color.lightness}% / ${alpha})`,
      )
      root.style.setProperty(
        `--iridescent-${colorNames[index]}-dark`,
        isDefault
          ? defaultDarkColors[index]
          : `hsl(${(color.hue + dark.hue + 360) % 360} ${Math.max(0, Math.min(100, color.saturation + dark.saturation))}% ${Math.max(0, Math.min(100, color.lightness + dark.lightness))}% / ${darkAlpha})`,
      )
    })
    root.style.setProperty('--iridescent-angle', `${preferences.angle}deg`)
    root.style.setProperty('--iridescent-pink-reach', `${preferences.reach}%`)
    root.style.setProperty('--iridescent-aqua-reach', `${Math.max(16, preferences.reach - 2)}%`)
    root.style.setProperty('--iridescent-gold-reach', `${Math.min(70, preferences.reach + 2)}%`)

    const lightBases = [[280, 50, 96.9, '#f8f3fb'], [195, 44.4, 96.5, '#f2f8fa'], [38, 52.4, 95.9, '#faf6ef']] as const
    const darkBases = [[273, 25.5, 8.4, '#15101b'], [201, 30.4, 9, '#10191e'], [35, 27.3, 8.6, '#1c1710']] as const
    lightBases.forEach(([hue, saturation, lightness, original], index) => {
      root.style.setProperty(
        `--iridescent-base-light-${index + 1}`,
        isDefault ? original : adjustedIridescentBaseColor(hue, saturation, lightness, preferences),
      )
    })
    darkBases.forEach(([hue, saturation, lightness, original], index) => {
      root.style.setProperty(
        `--iridescent-base-dark-${index + 1}`,
        isDefault ? original : adjustedIridescentBaseColor(hue, saturation, lightness, preferences),
      )
    })
  }

  function previewIridescentGradient(value: IridescentGradientPreferences) {
    iridescentGradient = normalizeIridescentGradient(value)
  }

  function commitIridescentGradient(value: IridescentGradientPreferences) {
    const normalized = normalizeIridescentGradient(value)
    iridescentGradient = normalized
    commitDeviceAppearance({ iridescentGradient: normalized })
  }

  function resetCompletedItemColors() {
    commitDeviceAppearance({ doneTintColor: '', checkboxColor: '' })
  }

  function clearGoalRhythmAutoShowTimer() {
    if (goalRhythmAutoShowTimer === null) return
    window.clearTimeout(goalRhythmAutoShowTimer)
    goalRhythmAutoShowTimer = null
  }

  function scheduleGoalHistoryUpdate() {
    if (goalHistoryUpdateTimer !== null) window.clearTimeout(goalHistoryUpdateTimer)
    goalHistoryUpdateTimer = window.setTimeout(() => {
      goalHistoryUpdateTimer = null
      goalHistoryGoals = goals
    }, goalNameEditing ? GOAL_HISTORY_EDIT_UPDATE_DEBOUNCE_MS : GOAL_HISTORY_UPDATE_DEBOUNCE_MS)
  }

  function setGoalNameEditing(focused: boolean) {
    goalNameEditing = focused
    if (goals !== goalHistoryGoals) scheduleGoalHistoryUpdate()
  }

  function leaveViewMaximized() {
    maximizeClickHandoff = null
    if (!maximizedView) return
    maximizedView = null
    goalRhythmVisible = goalRhythmVisibleBeforeMaximize
  }

  function toggleViewMaximized(targetView: View, event?: MouseEvent) {
    if (maximizedView === targetView) {
      leaveViewMaximized()
      return
    }

    const button = event?.currentTarget instanceof HTMLElement && event.detail > 0
      ? event.currentTarget
      : null
    const buttonRect = button?.getBoundingClientRect()
    maximizeClickHandoff = isMac && !isMobile && buttonRect && event
      ? {
          left: buttonRect.left,
          top: buttonRect.top,
          width: buttonRect.width,
          height: buttonRect.height,
          pointerX: event.clientX,
          pointerY: event.clientY,
        }
      : null
    goalRhythmVisibleBeforeMaximize = goalRhythmVisible
    maximizedView = targetView
    goalRhythmVisible = false
    clearGoalRhythmAutoShowTimer()
  }

  function showGoalRhythm() {
    clearGoalRhythmAutoShowTimer()
    leaveViewMaximized()
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

  function applyGoalOrder(goals: Goal[], order: Id[]): Goal[] {
    const positions = new Map(order.map((goalId, index) => [goalId, index]))
    return [...goals].sort(
      (left, right) => (positions.get(left.id) ?? Number.POSITIVE_INFINITY) - (positions.get(right.id) ?? Number.POSITIVE_INFINITY),
    )
  }

  function setGoalMatchTermsFocus(focused: boolean) {
    lockedGoalOrder = focused ? sortedGoals.map((goal) => goal.id) : null
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

  // ---- Side-by-side days ----

  function openCompareDay() {
    const activeDate = $plannerStore.activePlanDate || todayISO()
    const currentDate = todayISO()
    const nextCalendarDate = shiftISODate(currentDate, 1)

    if (activeDate === nextCalendarDate) {
      plannerStore.setActivePlanDate(currentDate)
      compareDayDate = nextCalendarDate
    } else {
      compareDayDate = shiftISODate(activeDate, 1)
    }
    compareDayOpen = true
  }

  function closeCompareDay() {
    compareDayOpen = false
    focusedPlanId = null
    // The compare pane's reminder input unmounts without blurring, so release the
    // edit explicitly rather than leaving the draft stuck to a hidden day.
    if (editingReminderPlanId && editingReminderPlanId !== activePlan?.id) editingReminderPlanId = null
    if (selectedItemIds.length > 0) clearItemSelection()
  }

  function toggleCompareDay() {
    if (compareDayOpen) closeCompareDay()
    else openCompareDay()
  }

  function shiftCompareDayDate(days: number) {
    compareDayDate = shiftISODate(compareDayDate || todayISO(), days)
  }

  function swapCompareDays() {
    const primaryDate = $plannerStore.activePlanDate
    plannerStore.setActivePlanDate(compareDayDate)
    compareDayDate = primaryDate
  }

  // Alt+Q / Alt+W walk whichever pane the user last touched, so the comparison
  // day can be scrubbed without reaching for its date picker.
  function shiftFocusedPaneDate(days: number) {
    if (compareDayOpen && focusedPlanId !== null && focusedPlanId === comparePlan?.id) {
      shiftCompareDayDate(days)
      return
    }
    shiftActivePlanDate(days)
  }

  function focusPane(planId: Id | undefined) {
    focusedPlanId = planId ?? null
  }

  function movePlanItemAcrossDays(
    sourcePlanId: Id,
    sourceItemId: Id,
    targetPlanId: Id,
    targetId: Id | null,
    placement: MovePlacement,
  ) {
    // Guard against a stray drop into some other plan-item surface (a generated
    // list renders through the same rows): only the two visible days are valid.
    const paneIds = dayPanes.map((pane) => pane.plan?.id).filter(Boolean)
    if (!paneIds.includes(sourcePlanId) || !paneIds.includes(targetPlanId)) return

    clearItemSelection()
    plannerStore.movePlanItemToPlan(sourcePlanId, targetPlanId, sourceItemId, targetId, placement)
    focusedPlanId = targetPlanId
  }

  function persistCompareDayState(open: boolean, date: string) {
    localStorage.setItem(COMPARE_DAY_KEY, JSON.stringify({ open, date }))
  }

  function restoreCompareDayState() {
    try {
      const stored = localStorage.getItem(COMPARE_DAY_KEY)
      if (stored) {
        const parsed = JSON.parse(stored) as { open?: unknown; date?: unknown }
        if (typeof parsed.date === 'string') compareDayDate = parsed.date
        if (parsed.open === true) compareDayOpen = true
      }
    } catch {
      // Corrupt view state just means the comparison starts closed.
    }
    compareDayStateReady = true
  }

  function openDateInToday(date: string) {
    plannerStore.setActivePlanDate(date)
    view = 'today'
  }

  function usesWindowScroll() {
    return window.matchMedia('(max-width: 760px)').matches
  }

  function currentWorkspaceScrollTop() {
    return usesWindowScroll() ? window.scrollY : (workspaceEl?.scrollTop ?? 0)
  }

  function rememberWorkspaceScroll() {
    if (!restoringScroll && lastScrolledPage) {
      rememberPageScroll(lastScrolledPage, currentWorkspaceScrollTop())
    }
  }

  function rememberPageScroll(pageKey: string, scrollTop: number) {
    scrollPositionsByPage[pageKey] = scrollTop
    if (pageKey.startsWith('list-template:')) persistListTemplatesViewState(selectedListTemplateId)
    if (pageKey.startsWith('today:')) {
      persistWorkspaceViewState(
        view,
        listOverlay,
        listOverlayView,
        selectedListOverlayItemIdsByList,
        listOverlayScrollTopsByList,
      )
    }
  }

  function handleWorkspaceScroll() {
    if (!usesWindowScroll()) {
      rememberWorkspaceScroll()
    }
  }

  function handleWindowScroll() {
    if (usesWindowScroll()) {
      rememberWorkspaceScroll()
    }
  }

  async function restoreScrollForPage(pageKey: string) {
    if (!pageKey || pageKey === lastScrolledPage) return

    if (lastScrolledPage) {
      rememberPageScroll(lastScrolledPage, currentWorkspaceScrollTop())
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

  function readWorkspaceViewState(): {
    scrollPositionsByPage: Record<string, number>
    listOverlay: ({ listId: Id; date: string; opener: Opener | null; view: View }) | null
    selectedListOverlayItemIdsByList: Record<Id, Id | null>
    listOverlayScrollTopsByList: Record<Id, number>
  } | null {
    const raw = localStorage.getItem(WORKSPACE_VIEW_STATE_KEY)
    if (!raw) return null

    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const rawOverlay = parsed.listOverlay
      let storedOverlay: { listId: Id; date: string; opener: Opener | null; view: View } | null = null

      if (rawOverlay && typeof rawOverlay === 'object' && !Array.isArray(rawOverlay)) {
        const overlay = rawOverlay as Record<string, unknown>
        const overlayView = isView(overlay.view) ? overlay.view : null
        const opener = readStoredOpener(overlay.opener)
        if (typeof overlay.listId === 'string' && typeof overlay.date === 'string' && overlayView) {
          storedOverlay = { listId: overlay.listId, date: overlay.date, opener, view: overlayView }
        }
      }

      return {
        scrollPositionsByPage: readStoredNumberRecord(parsed.scrollPositionsByPage, (key) => key.startsWith('today:')),
        listOverlay: storedOverlay,
        selectedListOverlayItemIdsByList: readStoredNullableIdRecord(parsed.selectedListOverlayItemIdsByList),
        listOverlayScrollTopsByList: readStoredNumberRecord(parsed.listOverlayScrollTopsByList),
      }
    } catch {
      return null
    }
  }

  function isView(value: unknown): value is View {
    return (
      value === 'today' ||
      value === 'templates' ||
      value === 'listTemplates' ||
      value === 'lists' ||
      value === 'metrics' ||
      value === 'goals' ||
      value === 'settings'
    )
  }

  function readStoredOpener(value: unknown): Opener | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const opener = value as Record<string, unknown>
    if (
      (opener.container === 'plan' || opener.container === 'list') &&
      typeof opener.containerId === 'string' &&
      typeof opener.itemId === 'string'
    ) {
      return { container: opener.container, containerId: opener.containerId, itemId: opener.itemId }
    }
    return null
  }

  function readStoredNumberRecord(value: unknown, includeKey: (key: string) => boolean = () => true): Record<string, number> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, number] =>
          includeKey(entry[0]) && typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] >= 0,
      ),
    )
  }

  function readStoredNullableIdRecord(value: unknown): Record<Id, Id | null> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, string | null] => typeof entry[1] === 'string' || entry[1] === null,
      ),
    )
  }

  function persistWorkspaceViewState(
    currentView: View,
    overlay: { listId: Id; date: string; opener: Opener | null } | null,
    overlayView: View | null,
    selectedItemIdsByList: Record<Id, Id | null>,
    overlayScrollTopsByList: Record<Id, number>,
  ) {
    if (!workspaceViewStateReady) return

    const scrollPositions = Object.fromEntries(
      Object.entries(scrollPositionsByPage).filter(
        ([pageKey, scrollTop]) => pageKey.startsWith('today:') && Number.isFinite(scrollTop) && scrollTop >= 0,
      ),
    )
    const visibleOverlay = overlay && overlayView === currentView ? { ...overlay, view: overlayView } : null

    localStorage.setItem(
      WORKSPACE_VIEW_STATE_KEY,
      JSON.stringify({
        scrollPositionsByPage: scrollPositions,
        listOverlay: visibleOverlay,
        selectedListOverlayItemIdsByList: selectedItemIdsByList,
        listOverlayScrollTopsByList: overlayScrollTopsByList,
      }),
    )
  }

  function readListTemplatesViewState(): {
    selectedTemplateId: string
    scrollTopsByTemplate: Record<string, number>
  } | null {
    const raw = localStorage.getItem(LIST_TEMPLATES_VIEW_STATE_KEY)
    if (!raw) return null

    try {
      const parsed = JSON.parse(raw) as {
        selectedTemplateId?: unknown
        scrollTopsByTemplate?: unknown
      }
      const scrollTopsByTemplate = Object.fromEntries(
        parsed.scrollTopsByTemplate && typeof parsed.scrollTopsByTemplate === 'object' && !Array.isArray(parsed.scrollTopsByTemplate)
          ? Object.entries(parsed.scrollTopsByTemplate).filter(
              (entry): entry is [string, number] =>
                typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] >= 0,
            )
          : [],
      )
      return {
        selectedTemplateId: typeof parsed.selectedTemplateId === 'string' ? parsed.selectedTemplateId : '',
        scrollTopsByTemplate,
      }
    } catch {
      return null
    }
  }

  function persistListTemplatesViewState(selectedTemplateId: string) {
    if (!listTemplatesViewStateReady) return

    const scrollTopsByTemplate = Object.fromEntries(
      Object.entries(scrollPositionsByPage)
        .filter(([pageKey, scrollTop]) =>
          pageKey.startsWith('list-template:') && Number.isFinite(scrollTop) && scrollTop >= 0)
        .map(([pageKey, scrollTop]) => [pageKey.slice('list-template:'.length), scrollTop]),
    )
    localStorage.setItem(
      LIST_TEMPLATES_VIEW_STATE_KEY,
      JSON.stringify({ selectedTemplateId, scrollTopsByTemplate }),
    )
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

  // `forDate` lets the comparison pane fill its own empty day instead of the
  // active one; without it this generates the active day, as before.
  function selectEmptyDayTemplate(date: string, templateId: Id) {
    emptyDayTemplateSelections = { ...emptyDayTemplateSelections, [date]: templateId }
    selectDayTemplate(templateId)
  }

  async function generateDayFromTemplate(templateId: Id, forDate?: string) {
    const template = templates.find((candidate) => candidate.id === templateId)
    if (!template) return

    const date = forDate || $plannerStore.activePlanDate || todayISO()
    const exists = $plannerStore.plans.some((plan) => plan.date === date)
    const replaceExisting = exists ? await confirmReplaceExistingPlan() : false

    if (exists && !replaceExisting) {
      if (!forDate) plannerStore.setActivePlanDate(date)
      view = 'today'
      return
    }

    plannerStore.generatePlan(template.id, date, replaceExisting, forDate ? $plannerStore.activePlanDate : date)
    const { [date]: _generatedDate, ...remainingSelections } = emptyDayTemplateSelections
    emptyDayTemplateSelections = remainingSelections
    view = 'today'
  }

  async function generateSelectedDay(forDate?: string) {
    if (!selectedTemplate) return
    await generateDayFromTemplate(selectedTemplate.id, forDate)
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
    if (isMobile) return

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

  // When you add/remove/change a shortcut here, also update the user-facing
  // reference in src/lib/KeyboardShortcutsModal.svelte (opened with `?`).
  function handleGlobalKeydown(event: KeyboardEvent) {
    // The native store begins with a disposable bootstrap state. Do not let a
    // shortcut mutate it while SQLCipher is still opening the real database.
    if ($databaseLoadPending || $databaseLoadError) return

    if (celebrationPreview) {
      if (event.key === 'Escape') {
        event.preventDefault()
        void finishCelebrationPreview(celebrationPreview.token)
      }
      return
    }

    if (mobileDrawerOpen && event.key === 'Escape') {
      event.preventDefault()
      closeMobileDrawer()
      return
    }

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
      documentFindOpen = false
      searchOpen = !searchOpen
      return
    }

    if (event.altKey && !primaryModifier && !event.shiftKey && event.code === 'KeyC') {
      event.preventDefault()
      documentFindOpen = false
      searchOpen = !searchOpen
      return
    }

    if (primaryModifier && !event.altKey && !event.shiftKey && key === 'f') {
      event.preventDefault()
      searchOpen = false
      if (view === 'goals') {
        documentFindOpen = false
        goalSearchInput?.focus()
        return
      }
      documentFindOpen = true
      void tick().then(() => documentFindBar?.focus())
      return
    }

    if (documentFindOpen && event.key === 'Escape') {
      event.preventDefault()
      documentFindOpen = false
      return
    }

    if (searchOpen) {
      if (event.key === 'Escape') {
        event.preventDefault()
        searchOpen = false
      }
      return
    }

    if (event.altKey && !primaryModifier && !event.shiftKey) {
      if (event.code === 'KeyI' && (view === 'today' || view === 'notes')) {
        event.preventDefault()
        if (!event.repeat) toggleViewMaximized(view)
        return
      }

      const sidebarViewByCode: Partial<Record<string, View>> = {
        KeyD: 'templates',
        KeyN: 'notes',
        KeyV: 'metrics',
        KeyS: 'settings',
      }
      const sidebarView = sidebarViewByCode[event.code]

      if (sidebarView) {
        event.preventDefault()
        view = sidebarView
        return
      }

      if (event.code === 'KeyE') {
        event.preventDefault()
        openLists()
        return
      }

      if (event.code === 'KeyR') {
        event.preventDefault()
        openListHistory()
        return
      }

      if (event.code === 'KeyT') {
        event.preventDefault()
        if (view === 'today') plannerStore.setActivePlanDate(todayISO())
        else view = 'today'
        return
      }

      if (event.code === 'KeyG') {
        event.preventDefault()
        void openGoals()
        return
      }

      if (event.code === 'KeyB') {
        event.preventDefault()
        view = 'today'
        toggleCompareDay()
        return
      }
    }

    if (
      event.altKey &&
      !primaryModifier &&
      !event.shiftKey &&
      event.code === 'KeyF' &&
      !metricOverlay
    ) {
      const openedLink = listOverlayVisible && overlayListPanel
        ? overlayListPanel.openSelectedMetric()
        : openLinkedListForActiveTask()
      if (openedLink) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
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

      if (
        key === 'e' &&
        !event.shiftKey &&
        !event.altKey &&
        !primaryModifier &&
        !metricOverlay &&
        !isFormFieldActive() &&
        !isRichTextActive() &&
        overlayListPanel.hasSelection()
      ) {
        event.preventDefault()
        event.stopPropagation()
        overlayListPanel.editSelectedTemplateItem()
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
      primaryModifier &&
      event.shiftKey &&
      !event.altKey &&
      key === 'a' &&
      !isFormFieldActive()
    ) {
      if (selectedItemIds.length > 0) {
        event.preventDefault()
        event.stopPropagation()
        selectAllItems()
        return
      }

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

    if (
      event.altKey &&
      !primaryModifier &&
      event.shiftKey &&
      event.code === 'KeyT'
    ) {
      const itemIds = activeTimeTargetIds()
      if (itemIds.length === 0) return
      event.preventDefault()
      event.stopPropagation()
      if (!event.repeat) toggleItemTimes(itemIds)
      return
    }

    if (
      event.altKey &&
      !primaryModifier &&
      (event.code === 'BracketLeft' || event.code === 'BracketRight')
    ) {
      const itemIds = activeTimeTargetIds()
      if (itemIds.length === 0) return
      event.preventDefault()
      event.stopPropagation()
      adjustItemTimes(
        itemIds,
        event.shiftKey ? 'both' : 'start',
        event.code === 'BracketLeft' ? -TIME_KEYBOARD_STEP_MINUTES : TIME_KEYBOARD_STEP_MINUTES,
      )
      return
    }

    if (
      primaryModifier &&
      !event.altKey &&
      !event.shiftKey &&
      (event.code === 'BracketLeft' || event.code === 'BracketRight')
    ) {
      const itemIds = activeTimeTargetIds()
      if (itemIds.length === 0) return
      event.preventDefault()
      event.stopPropagation()
      adjustItemTimes(
        itemIds,
        'end',
        event.code === 'BracketLeft' ? -TIME_KEYBOARD_STEP_MINUTES : TIME_KEYBOARD_STEP_MINUTES,
      )
      return
    }

    if (event.key === 'Escape' && selectedItemIds.length > 0) {
      event.preventDefault()
      clearItemSelection()
      return
    }

    if (
      selectedItemIds.length > 0 &&
      !event.altKey &&
      !primaryModifier &&
      !event.shiftKey &&
      event.code === 'KeyT'
    ) {
      event.preventDefault()
      event.stopPropagation()
      if (!event.repeat) toggleItemTimes(selectedItemIds)
      return
    }

    if (
      selectedItemIds.length > 0 &&
      !event.altKey &&
      !primaryModifier &&
      (event.code === 'BracketLeft' || event.code === 'BracketRight')
    ) {
      event.preventDefault()
      event.stopPropagation()
      adjustItemTimes(
        selectedItemIds,
        event.shiftKey ? 'end' : 'start',
        event.code === 'BracketLeft' ? -TIME_KEYBOARD_STEP_MINUTES : TIME_KEYBOARD_STEP_MINUTES,
      )
      return
    }

    if (
      selectedItemIds.length > 0 &&
      !event.shiftKey &&
      !event.altKey &&
      !primaryModifier &&
      (event.key === 'ArrowUp' ||
        event.key === 'ArrowDown' ||
        event.key === 'ArrowLeft' ||
        event.key === 'ArrowRight')
    ) {
      event.preventDefault()
      event.stopPropagation()
      focusSelectedItemBoundary(event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? 'start' : 'end')
      return
    }

    if (
      selectedItemIds.length > 0 &&
      event.shiftKey &&
      !event.altKey &&
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
      void moveSelectedItems(rootIds, event.key === 'ArrowUp' ? 'up' : 'down')
      return
    }

    if (
      (view === 'today' || view === 'templates' || view === 'lists' || view === 'listTemplates' || view === 'metrics') &&
      event.altKey &&
      !primaryModifier &&
      !event.shiftKey
    ) {
      if (event.code === 'KeyQ') {
        event.preventDefault()
        if (view === 'templates') void selectAdjacentDayTemplate(-1)
        else if (view === 'listTemplates') void selectAdjacentListTemplate(-1)
        else if (view === 'metrics') void selectAdjacentMetric(-1)
        else if (view === 'today') shiftFocusedPaneDate(-1)
        else if (view === 'lists') shiftActivePlanDate(-1)
        return
      }

      if (event.code === 'KeyW') {
        event.preventDefault()
        if (view === 'templates') void selectAdjacentDayTemplate(1)
        else if (view === 'listTemplates') void selectAdjacentListTemplate(1)
        else if (view === 'metrics') void selectAdjacentMetric(1)
        else if (view === 'today') shiftFocusedPaneDate(1)
        else if (view === 'lists') shiftActivePlanDate(1)
        return
      }
    }

    // The native macOS Edit menu owns Paste and Match Style in the desktop app.
    // Keep the canonical shortcut usable in browser-only development too. Use
    // `code` because Option changes `key` from "v" to a macOS symbol.
    if (
      !isTauri() &&
      event.code === 'KeyV' &&
      isRichTextActive() &&
      primaryModifier &&
      event.shiftKey &&
      event.altKey
    ) {
      event.preventDefault()
      event.stopPropagation()
      void pasteSystemClipboardAsPlainText()
      return
    }

    if (!primaryModifier || event.altKey) return

    if (activeItemSurface() === 'plan' && focusedPlan && key === 'd' && !event.shiftKey && selectedItemIds.length > 0) {
      const selectedItems = selectedPlanItems()
      if (selectedItems.length === 0) return

      event.preventDefault()
      plannerStore.patchPlanItemsDone(
        focusedPlan.id,
        selectedItems.map((item) => item.id),
        !selectedItems.every((item) => item.done),
      )
      return
    }

    if (activeItemSurface() && !hasActiveRichTextSelection() && !isFormFieldActive()) {
      if ((key === 'c' || key === 'x') && !event.shiftKey && selectedItemIds.length > 0) {
        event.preventDefault()
        if (key === 'x') void cutSelectedItems()
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
      const plan = itemId ? planContainingItem(itemId) : undefined
      const item = itemId && plan ? findPlanItem(plan.items, itemId) : null
      if (!plan || !item) return

      event.preventDefault()
      plannerStore.patchPlanItem(plan.id, item.id, { done: !item.done })
      return
    }

    if (key === 'z' && !event.shiftKey) {
      event.preventDefault()
      void undoAndOpenDestination()
      return
    }

    if (event.shiftKey && (key === 'z' || key === 'c')) {
      event.preventDefault()
      void plannerStore.redo()
    }
  }

  function dispatchMacosAltShortcut(shortcut: MacosAltShortcut) {
    const key = shortcut.code.startsWith('Key')
      ? shortcut.code.slice(3)
      : shortcut.code === 'Slash'
        ? '/'
        : shortcut.code === 'BracketLeft'
          ? '['
          : shortcut.code === 'BracketRight'
            ? ']'
            : shortcut.code
    const target = document.activeElement ?? window
    target.dispatchEvent(new KeyboardEvent('keydown', {
      altKey: true,
      shiftKey: shortcut.shiftKey,
      bubbles: true,
      cancelable: true,
      code: shortcut.code,
      key,
      repeat: shortcut.repeat,
    }))
  }

  function findPlanItem(items: PlanItem[], itemId: string): PlanItem | null {
    for (const item of items) {
      if (item.id === itemId) return item
      const child = findPlanItem(item.children, itemId)
      if (child) return child
    }

    return null
  }

  function collectSelectedTimeItems<T extends { id: Id; children: T[] }>(items: T[], selectedIds: Set<Id>): T[] {
    return items.flatMap((item) => [
      ...(selectedIds.has(item.id) ? [item] : []),
      ...collectSelectedTimeItems(item.children, selectedIds),
    ])
  }

  function timeItemsForIds(itemIds: Id[]): Array<PlanItem | TemplateItem> {
    const surface = activeItemSurface()
    const selectedIds = new Set(itemIds)

    if (surface === 'plan') return collectSelectedTimeItems(focusedPlan?.items ?? [], selectedIds)
    if (surface === 'day-template') return collectSelectedTimeItems(selectedTemplate?.items ?? [], selectedIds)

    return []
  }

  function activeTimeTargetIds(): Id[] {
    const surface = activeItemSurface()
    if (surface !== 'plan' && surface !== 'day-template') return []
    if (selectedItemIds.length > 0) return selectedItemIds

    const focusedItemId = activeFocusedItemId()
    return focusedItemId ? [focusedItemId] : []
  }

  function patchSelectedTimeItem(
    itemId: Id,
    patch: Pick<Partial<PlanItem>, 'startMinutes' | 'endMinutes' | 'timeHidden'>,
    mergeKey?: string,
  ) {
    const surface = activeItemSurface()
    const containerId = activeItemContainerId()
    if (!containerId) return

    const options = mergeKey
      ? { mergeKey, mergeWindowMs: TIME_KEYBOARD_MERGE_WINDOW_MS }
      : undefined

    if (surface === 'plan') plannerStore.patchPlanItem(containerId, itemId, patch, options)
    else if (surface === 'day-template') plannerStore.patchTemplateItem(containerId, itemId, patch, options)
  }

  function toggleItemTimes(itemIds: Id[]) {
    const surface = activeItemSurface()
    const items = timeItemsForIds(itemIds)
    if ((surface !== 'plan' && surface !== 'day-template') || items.length === 0) return

    const removeTimes = items.every(hasActiveTimeRange)

    for (const item of items) {
      if (removeTimes) {
        patchSelectedTimeItem(item.id, { timeHidden: true })
      } else if (item.timeHidden === true && item.startMinutes !== null && item.endMinutes !== null) {
        patchSelectedTimeItem(item.id, { timeHidden: null })
      } else if (!hasActiveTimeRange(item)) {
        const range = surface === 'plan'
          ? defaultPlanItemTimeRange(focusedPlan?.items ?? [], item.id)
          : defaultTemplateItemTimeRange(selectedTemplate?.items ?? [], item.id)
        patchSelectedTimeItem(item.id, { ...range, timeHidden: null })
      }
    }
  }

  function adjustItemTimes(itemIds: Id[], endpoint: 'start' | 'end' | 'both', delta: number) {
    const surface = activeItemSurface()
    if (surface !== 'plan' && surface !== 'day-template') return

    const timedItems = timeItemsForIds(itemIds).filter(
      (item): item is (PlanItem | TemplateItem) & { startMinutes: number; endMinutes: number } =>
        hasActiveTimeRange(item),
    )
    if (timedItems.length === 0) return

    const adjustedDelta = endpoint === 'both'
      ? Math.max(
          -Math.min(...timedItems.map((item) => item.startMinutes)),
          Math.min(delta, MAX_TIMELINE_MINUTES - Math.max(...timedItems.map((item) => item.endMinutes))),
        )
      : delta

    for (const item of timedItems) {
      const startMinutes = endpoint === 'both'
        ? item.startMinutes + adjustedDelta
        : endpoint === 'start'
          ? Math.max(0, Math.min(item.startMinutes + delta, item.endMinutes - TIME_KEYBOARD_STEP_MINUTES))
          : item.startMinutes
      const endMinutes = endpoint === 'both'
        ? item.endMinutes + adjustedDelta
        : endpoint === 'end'
          ? Math.min(MAX_TIMELINE_MINUTES, Math.max(item.endMinutes + delta, item.startMinutes + TIME_KEYBOARD_STEP_MINUTES))
          : item.endMinutes

      if (startMinutes === item.startMinutes && endMinutes === item.endMinutes) continue

      patchSelectedTimeItem(
        item.id,
        { startMinutes, endMinutes },
        `${surface}-item-time-keyboard:${activeItemContainerId()}:${item.id}:${endpoint}`,
      )
    }
  }

  // With the day comparison open a focused row can belong to either pane, so
  // resolve its owner rather than assuming the active plan.
  function planContainingItem(itemId: Id): DailyPlan | undefined {
    for (const pane of dayPanes) {
      if (pane.plan && findPlanItem(pane.plan.items, itemId)) return pane.plan
    }

    return undefined
  }

  function activeItemSurface(): ItemSurface | null {
    if (view === 'today' && focusedPlan) return 'plan'
    if (view === 'templates' && selectedTemplate) return 'day-template'
    if (view === 'listTemplates' && selectedListTemplate) return 'list-template'
    return null
  }

  function activeItemContainerId(): Id | null {
    const surface = activeItemSurface()
    if (surface === 'plan') return focusedPlan?.id ?? null
    if (surface === 'day-template') return selectedTemplate?.id ?? null
    if (surface === 'list-template') return selectedListTemplate?.id ?? null
    return null
  }

  function activeItemTree(): TreeNode[] {
    const surface = activeItemSurface()
    if (surface === 'plan') return (focusedPlan?.items ?? []) as TreeNode[]
    if (surface === 'day-template') return (selectedTemplate?.items ?? []) as TreeNode[]
    if (surface === 'list-template') return (selectedListTemplate?.items ?? []) as TreeNode[]
    return []
  }

  function activeItemContextKey() {
    return activeItemContext
  }

  async function switchItemContext(nextContext: string) {
    const previousContext = itemStateContext
    if (previousContext) {
      if (selectedItemContext === previousContext && selectedItemIds.length > 0) {
        itemSelectionsByContext[previousContext] = {
          selectedItemIds: [...selectedItemIds],
          selectionAnchorId,
          selectionFocusId,
        }
        delete itemCaretsByContext[previousContext]
      } else {
        delete itemSelectionsByContext[previousContext]
      }
    }

    itemStateContext = nextContext
    const restoreNonce = ++itemContextRestoreNonce
    const validItemIds = new Set(flattenItemIds(activeItemTree()))
    const savedSelection = nextContext ? itemSelectionsByContext[nextContext] : undefined
    const restoredItemIds = savedSelection?.selectedItemIds.filter((itemId) => validItemIds.has(itemId)) ?? []

    if (nextContext && restoredItemIds.length > 0) {
      selectedItemIds = restoredItemIds
      selectedItemContext = nextContext
      selectionAnchorId = savedSelection && validItemIds.has(savedSelection.selectionAnchorId ?? '')
        ? savedSelection.selectionAnchorId
        : restoredItemIds[0]
      selectionFocusId = savedSelection && validItemIds.has(savedSelection.selectionFocusId ?? '')
        ? savedSelection.selectionFocusId
        : restoredItemIds.at(-1) ?? null
      return
    }

    selectedItemIds = []
    selectedItemContext = ''
    selectionAnchorId = null
    selectionFocusId = null
    selectingItems = false

    const savedCaret = nextContext ? itemCaretsByContext[nextContext] : undefined
    if (!savedCaret) return

    await tick()
    if (restoreNonce !== itemContextRestoreNonce || activeItemContext !== nextContext) return

    const editor = workspaceEl?.querySelector<HTMLDivElement>(
      `[data-rich-text-input-id="${CSS.escape(savedCaret.inputId)}"]`,
    )
    if (!editor || !editorMatchesActiveItemSurface(editor)) {
      delete itemCaretsByContext[nextContext]
      return
    }

    editor.focus()
    const range = document.createRange()
    const start = domPositionForTextOffset(editor, savedCaret.start)
    const end = domPositionForTextOffset(editor, savedCaret.end)
    range.setStart(start.node, start.offset)
    range.setEnd(end.node, end.offset)

    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }

  function rememberActiveItemCaret() {
    if (!itemStateContext || itemStateContext !== activeItemContext || selectedItemIds.length > 0) return

    const active = document.activeElement
    const editor = active instanceof HTMLElement
      ? active.closest<HTMLDivElement>('[data-rich-text-input]')
      : null
    const selection = document.getSelection()
    if (!editor || !editorMatchesActiveItemSurface(editor) || !selection || selection.rangeCount === 0) return

    const range = selection.getRangeAt(0)
    if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return

    const inputId = editor.dataset.richTextInputId
    if (!inputId) return

    itemCaretsByContext[itemStateContext] = {
      inputId,
      start: textOffsetForRangeBoundary(editor, range.startContainer, range.startOffset),
      end: textOffsetForRangeBoundary(editor, range.endContainer, range.endOffset),
    }
    delete itemSelectionsByContext[itemStateContext]
  }

  function editorMatchesActiveItemSurface(editor: HTMLElement) {
    const kind = editor.dataset.richTextKind
    const surface = activeItemSurface()
    return (
      (surface === 'plan' && kind === 'plan') ||
      (surface === 'day-template' && kind === 'template-option') ||
      (surface === 'list-template' && kind === 'list-template-item')
    )
  }

  function textOffsetForRangeBoundary(editor: HTMLElement, boundaryNode: Node, boundaryOffset: number) {
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.setEnd(boundaryNode, boundaryOffset)
    return range.toString().length
  }

  function domPositionForTextOffset(editor: HTMLElement, offset: number) {
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    let remaining = offset
    let node = walker.nextNode()

    while (node) {
      const length = node.textContent?.length ?? 0
      if (remaining <= length) return { node, offset: remaining }
      remaining -= length
      node = walker.nextNode()
    }

    return { node: editor as Node, offset: editor.childNodes.length }
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

  function startMobileItemSelection(itemId: Id) {
    selectSingleItem(itemId)
  }

  function toggleMobileItemSelection(itemId: Id) {
    if (!activeItemSurface()) return

    const nextIds = selectedItemIds.includes(itemId)
      ? selectedItemIds.filter((selectedId) => selectedId !== itemId)
      : [...selectedItemIds, itemId]

    if (nextIds.length === 0) {
      clearItemSelection()
      return
    }

    selectedItemIds = nextIds
    selectedItemContext = activeItemContextKey()
    selectionAnchorId = nextIds[0]
    selectionFocusId = itemId
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
    if (usesMobileLayout() || !selectingItems || !selectionAnchorId) return
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
    if (
      maximizeClickHandoff
      && Math.hypot(
        event.clientX - maximizeClickHandoff.pointerX,
        event.clientY - maximizeClickHandoff.pointerY,
      ) > 2
    ) {
      maximizeClickHandoff = null
    }
    moveMobileDrawerGesture(event)
    if (usesMobileLayout()) {
      itemTextDragOrigin = null
      return
    }

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

  function endItemSelection(event?: PointerEvent) {
    endMobileDrawerGesture(event)
    if (selectingItems && selectedItemIds.length > 0) preserveSelectionFocusUntil = Date.now() + 250
    selectingItems = false
    itemTextDragOrigin = null
  }

  function handleGlobalPointerDown(event: PointerEvent) {
    beginMobileDrawerGesture(event)
    if (event.button !== 0 || !activeItemSurface()) {
      itemTextDragOrigin = null
      return
    }

    const target = event.target instanceof Element ? event.target : null
    const input = target?.closest<HTMLElement>('[data-rich-text-input]')

    // The short focus guard created after a whole-item pointer selection is only
    // meant to suppress focus from that same gesture. A new pointer-down in an
    // editor is an intentional target change and must be allowed to focus before
    // copy/paste resolves its insertion point.
    if (input) preserveSelectionFocusUntil = 0

    if (usesMobileLayout()) {
      itemTextDragOrigin = null
      return
    }

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

    const probabilityRow = target.closest('[data-item-probability-control]')?.closest<HTMLElement>(itemRowSelector())
    const probabilityItemId = probabilityRow ? rowItemId(probabilityRow) : null
    if (probabilityItemId && selectedItemIds.includes(probabilityItemId)) return

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
    const targetId = itemIds[targetIndex]
    selectItemRange(itemId, targetId, false)
    scrollItemTextInputIntoView(targetId)
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
    scrollItemTextInputIntoView(targetId)
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

  function syncAndroidSelectionBackListener(wanted: boolean) {
    androidSelectionBackWanted = wanted
    if (!wanted) {
      const listener = androidSelectionBackListener
      androidSelectionBackListener = null
      if (listener) void listener.unregister()
      return
    }
    if (androidSelectionBackListener || androidSelectionBackRegistration) return

    const registration = onBackButtonPress(() => {
      if (selectedItemIds.length > 0) clearItemSelection()
    })
    androidSelectionBackRegistration = registration
    void registration.then((listener) => {
      if (androidSelectionBackRegistration === registration) androidSelectionBackRegistration = null
      if (androidSelectionBackWanted) androidSelectionBackListener = listener
      else void listener.unregister()
    }).catch((error) => {
      if (androidSelectionBackRegistration === registration) androidSelectionBackRegistration = null
      console.error('Could not listen for the Android back button', error)
    })
  }

  function stopAndroidSelectionBackListener() {
    androidSelectionBackWanted = false
    const listener = androidSelectionBackListener
    androidSelectionBackListener = null
    if (listener) void listener.unregister()
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

  function usesMobileLayout() {
    return typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches
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
    if (!focusedPlan) return []
    const plan = focusedPlan
    return selectedItemIds
      .map((itemId) => findPlanItem(plan.items, itemId))
      .filter((item): item is PlanItem => item !== null)
  }

  function focusSelectedItemBoundary(position: 'start' | 'end') {
    const selectedIds = new Set(selectedItemIds)
    const orderedIds = flattenItemIds(activeItemTree()).filter((itemId) => selectedIds.has(itemId))
    const targetId = position === 'start' ? orderedIds[0] : orderedIds.at(-1)
    if (!targetId) return
    clearItemSelection()
    focusItemTextInput(targetId, position)
  }

  function copySelectedItems() {
    const surface = activeItemSurface()
    const containerId = activeItemContainerId()
    if (!surface || !containerId || selectedItemIds.length === 0) return
    if (surface === 'plan' && focusedPlan) {
      const items = plannerStore.copyPlanItems(containerId, selectedItemIds)
      if (items.length > 0) writePlanItemsToSystemClipboard({ items, cut: false, sourceDate: focusedPlan.date })
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

  function copyAndClearSelectedItems() {
    copySelectedItems()
    clearItemSelection()
  }

  function copyPlanItemFromMenu(planId: Id, itemId: Id) {
    const plan = $plannerStore.plans.find((candidate) => candidate.id === planId)
    if (!plan) return

    const items = plannerStore.copyPlanItems(planId, [itemId])
    if (items.length > 0) writePlanItemsToSystemClipboard({ items, cut: false, sourceDate: plan.date })
  }

  async function pastePlanItemFromMenu(planId: Id, itemId: Id) {
    focusPane(planId)
    const clipboard = await readSystemClipboard()
    const structured = parsePlanItemClipboard(clipboard.structuredPayload)
    if (!structured) return
    pastePlanItemClipboard(structured, null, { planId, targetId: itemId, placement: 'after' })
  }

  function cutPlanItemFromMenu(planId: Id, itemId: Id) {
    const plan = $plannerStore.plans.find((candidate) => candidate.id === planId)
    if (!plan) return

    const items = plannerStore.cutPlanItems(planId, [itemId])
    if (items.length > 0) writePlanItemsToSystemClipboard({ items, cut: true, sourceDate: plan.date })
  }

  async function cutSelectedItems() {
    const surface = activeItemSurface()
    const containerId = activeItemContainerId()
    if (!surface || !containerId || selectedItemIds.length === 0) return
    const orderedIds = flattenItemIds(activeItemTree())
    if (surface === 'plan' && focusedPlan) {
      const items = plannerStore.cutPlanItems(containerId, selectedItemIds)
      if (items.length > 0) writePlanItemsToSystemClipboard({ items, cut: true, sourceDate: focusedPlan.date })
      await finishCut(orderedIds, items)
      return
    }
    if (surface === 'day-template') {
      const items = plannerStore.cutTemplateItems(containerId, selectedItemIds)
      if (items.length > 0) writeTemplateItemsToSystemClipboard({ kind: surface, items, cut: true })
      await finishCut(orderedIds, items)
    } else {
      const items = plannerStore.cutListTemplateItems(containerId, selectedItemIds)
      if (items.length > 0) writeTemplateItemsToSystemClipboard({ kind: 'list-template', items, cut: true })
      await finishCut(orderedIds, items)
    }
  }

  async function finishCut(orderedIds: Id[], removedItems: TreeNode[]) {
    if (removedItems.length === 0) {
      clearItemSelection()
      return
    }

    const removedIds = new Set(flattenItemIds(removedItems))
    const lastRemovedIndex = orderedIds.reduce(
      (lastIndex, itemId, index) => removedIds.has(itemId) ? index : lastIndex,
      -1,
    )
    const nextItemId = orderedIds[lastRemovedIndex + 1]

    clearItemSelection()
    if (!nextItemId) return

    await tick()
    focusItemTextInput(nextItemId, 'start')
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

  async function moveSelectedItems(rootIds: Id[], direction: MoveDirection) {
    const surface = activeItemSurface()
    const containerId = activeItemContainerId()
    if (!surface || !containerId) return
    if (surface === 'plan') plannerStore.movePlanItemsWithinLevel(containerId, rootIds, direction)
    else if (surface === 'day-template') plannerStore.moveTemplateItemsWithinLevel(containerId, rootIds, direction)
    else plannerStore.moveListTemplateItemsWithinLevel(containerId, rootIds, direction)
    await tick()
    scrollMovedItemsIntoView(surface satisfies ItemRowKind, rootIds, direction)
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

    const explicitTargetId = activeFocusedItemId() ?? selectedRootIds().at(-1) ?? null
    const emptyPlaceholderId = explicitTargetId ? null : soleEmptyTemplateItemId(structured.kind)
    const targetId = explicitTargetId ?? emptyPlaceholderId
    const placement = targetId && isEmptyTemplateLeaf(structured.kind, targetId) ? 'replace' : 'after'
    const pastedIds = structured.kind === 'day-template'
      ? plannerStore.pasteTemplateItems(containerId, structured.items, targetId, placement)
      : plannerStore.pasteListTemplateItems(containerId, structured.items, targetId, placement)
    if (pastedIds.length === 0) return

    selectedItemIds = pastedIds
    selectedItemContext = activeItemContextKey()
    selectionAnchorId = pastedIds.at(-1) ?? null
    selectionFocusId = pastedIds.at(-1) ?? null
    releaseTextEditingFocus()
    if (structured.cut) writeTemplateItemsToSystemClipboard({ ...structured, cut: false })
  }

  async function pasteSystemClipboard() {
    // Read this before the asynchronous clipboard request: native pasteboard access can
    // briefly disturb the DOM selection even though the user has not moved the caret.
    const pasteBeforeItemId = planItemIdWithCaretAtStart()
    const clipboard = await readSystemClipboard()
    const structured = parsePlanItemClipboard(clipboard.structuredPayload)
    if (structured) {
      pastePlanItemClipboard(structured, pasteBeforeItemId)
      return
    }

    pastePlainClipboardIntoActiveEditor(clipboard)
  }

  async function pasteSystemClipboardAsPlainText() {
    const editor = document.activeElement
    if (!(editor instanceof HTMLElement) || !editor.matches('[data-rich-text-input]')) return

    const clipboard = await readSystemClipboard()
    // Clipboard reads are asynchronous. Do not paste into a different item if focus
    // moved while the native pasteboard request was in flight.
    if (document.activeElement !== editor) return
    editor.dispatchEvent(new CustomEvent('balancepaste', {
      detail: { plainText: clipboard.plainText, html: null },
    }))
  }

  function pastePlanItemClipboard(
    planItemClipboard: PlanItemClipboard,
    pasteBeforeItemId: Id | null,
    destination?: { planId: Id; targetId: Id; placement: 'after' },
  ) {
    const destinationPlan = destination
      ? $plannerStore.plans.find((plan) => plan.id === destination.planId)
      : focusedPlan
    if (!destinationPlan) return

    const targetId = destination?.targetId ?? pasteTargetPlanItemId()
    const placement = destination?.placement ?? (
      shouldReplaceFocusedPlanItemOnPaste(targetId)
        ? 'replace'
        : targetId === pasteBeforeItemId
          ? 'before'
          : 'after'
    )

    const nodes = flattenPlanItemsForReview(planItemClipboard.items)
    if (nodes.length >= PASTE_REVIEW_THRESHOLD && planItemClipboard.sourceDate !== destinationPlan.date) {
      pasteReview = {
        nodes,
        index: 0,
        approved: [],
        rejected: [],
        targetId,
        placement,
        planId: destinationPlan.id,
        cut: planItemClipboard.cut,
      }
      pasteReviewEditing = false
      releaseTextEditingFocus()
      startPasteReviewCooldown()
      return
    }

    insertPastedPlanItems(destinationPlan.id, planItemClipboard.items, targetId, placement, planItemClipboard.cut)
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
    planId: Id,
    items: PlanItem[],
    targetId: Id | null,
    placement: 'before' | 'after' | 'replace',
    cut: boolean,
  ) {
    const plan = $plannerStore.plans.find((candidate) => candidate.id === planId)
    if (!plan) return

    const pastedRootIds = plannerStore.pastePlanItems(plan.id, items, targetId, placement)
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
      writePlanItemsToSystemClipboard({ items, cut: false, sourceDate: plan.date })
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
      const { planId, targetId, placement, cut } = pasteReview
      cancelPasteReviewCooldown()
      pasteReview = null
      if (approved.length > 0) insertPastedPlanItems(planId, buildReviewedForest(approved), targetId, placement, cut)
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

  async function openRecoveryPanel(historyId: string | null = null) {
    recoveryPanelOpen = true
    recoveryExpandedId = historyId
    recoveryListOpen = historyId !== null
    await Promise.all([
      refreshRecoveryEntries(),
      refreshMetadata(),
      refreshDatabaseInspection(),
      refreshDatabaseMaintenanceStatus(),
    ])
    if (historyId) {
      await tick()
      document.querySelector<HTMLElement>(`[data-recovery-history-id="${CSS.escape(historyId)}"]`)
        ?.scrollIntoView({ block: 'center' })
    }
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

  function formatDatabaseBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    const units = ['KiB', 'MiB', 'GiB']
    let value = bytes / 1024
    let unit = units[0]
    for (let index = 1; index < units.length && value >= 1024; index += 1) {
      value /= 1024
      unit = units[index]
    }
    return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${unit}`
  }

  function formatMaintenanceTimestamp(timestamp: string | null | undefined): string {
    const milliseconds = Number(timestamp?.replace(/^unix-ms-/, ''))
    if (!Number.isFinite(milliseconds)) return 'Never'
    return new Date(milliseconds).toLocaleString()
  }

  async function refreshDatabaseMaintenanceStatus() {
    databaseMaintenanceStatus = await getDatabaseMaintenanceStatus()
  }

  async function runLaunchDatabaseMaintenance() {
    if (!isTauri() || launchMaintenanceStarted) return
    launchMaintenanceStarted = true

    try {
      await completeDatabaseMaintenanceStartup()
      await refreshDatabaseMaintenanceStatus()
      if (!databaseMaintenanceStatus?.due) return
      const result = await runDatabaseMaintenanceIfNeeded()
      if (!result) return
      await plannerStore.reloadFromBackend()
      await refreshDatabaseMaintenanceStatus()
    } catch (error) {
      console.error('Automatic database housekeeping failed', error)
    }
  }

  async function optimizeDatabase() {
    if (databaseCompactionBusy || recoveryBusy) return

    const confirmed = await confirmDialog(
      'Reclaim unused database pages now? Balance verifies the complete state before installing the smaller encrypted file. Sync operations, undo/recovery history, and independently scheduled backups are unchanged.',
      { title: 'Optimize database?', kind: 'warning' },
    )
    if (!confirmed) return

    databaseCompactionBusy = true
    recoveryStatus = 'Measuring and verifying the encrypted database…'
    recoveryStatusIsError = false

    try {
      await requestSync('manual-database-optimization-preflight')
      recoveryStatus = 'Reclaiming unused pages from a verified copy…'

      const result = await compactDatabase()
      if (!result) throw new Error('Database optimization is available only in the desktop or mobile app.')

      await plannerStore.reloadFromBackend()
      recoveryEntries = await listRecoveryEntries()
      await Promise.all([
        refreshMetadata(),
        refreshDatabaseInspection(),
        refreshDatabaseMaintenanceStatus(),
      ])
      recoveryStatus = `Optimized ${formatDatabaseBytes(result.beforeBytes)} → ${formatDatabaseBytes(result.afterBytes)} ` +
        `(${formatDatabaseBytes(result.reclaimedBytes)} reclaimed) without changing sync or recovery history.` +
        (result.backupPath ? ` Latest independent backup: ${result.backupPath}` : '')
    } catch (error) {
      recoveryStatusIsError = true
      recoveryStatus = error instanceof Error ? error.message : String(error)
    } finally {
      databaseCompactionBusy = false
    }
  }

  function closeRecoveryPanel() {
    if (databaseCompactionBusy) return
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

    const description = entry.restoredItemCount > 0
      ? `Restore ${entry.restoredItemCount} item${entry.restoredItemCount === 1 ? '' : 's'}${
          entry.preview ? ` (“${entry.preview}”)` : ''
        }? This reverses the action that removed them.`
      : `Restore the earlier state${entry.preview ? ` (“${entry.preview}”)` : ''}? ` +
        'This reverses that saved change against the current data.'
    const confirmed = await confirmDialog(
      description,
      { title: entry.restoredItemCount > 0 ? 'Restore items' : 'Restore earlier state', kind: 'warning' },
    )
    if (!confirmed) return

    recoveryBusy = true
    recoveryStatus = ''
    recoveryStatusIsError = false

    try {
      const restored = await plannerStore.restoreRecoveryEntry(entry.historyId)
      if (restored) {
        recoveryStatus = entry.restoredItemCount > 0
          ? 'Restored. Check your plan — the items should be back.'
          : 'Restored the earlier state. Check the affected item or document.'
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
    if (!focusedPlan || !targetId) return false
    if (!(document.activeElement instanceof HTMLElement) || !document.activeElement.matches('[data-plan-text-input]')) return false

    const item = findPlanItem(focusedPlan.items, targetId)
    // Only replace a genuinely empty leaf. Replacing an empty-titled item that still has
    // children would cascade-delete the whole subtree (data loss on paste).
    return Boolean(
      item && item.text.trim() === '' && item.html.trim() === '' && item.children.length === 0,
    )
  }

  function soleEmptyTemplateItemId(kind: TemplateItemClipboard['kind']): Id | null {
    const items = kind === 'day-template' ? selectedTemplate?.items : selectedListTemplate?.items
    const item = items?.length === 1 ? items[0] : null
    return item && isEmptyTemplateLeaf(kind, item.id) ? item.id : null
  }

  function isEmptyTemplateLeaf(kind: TemplateItemClipboard['kind'], itemId: Id): boolean {
    if (kind === 'day-template') {
      const item = findTreeItem(selectedTemplate?.items ?? [], itemId)
      return Boolean(
        item &&
        item.children.length === 0 &&
        item.options.every((option) => option.text.trim() === '' && option.html.trim() === ''),
      )
    }

    const item = findTreeItem(selectedListTemplate?.items ?? [], itemId)
    return Boolean(
      item && item.children.length === 0 && item.text.trim() === '' && item.html.trim() === '',
    )
  }

  function findTreeItem<T extends { id: Id; children: T[] }>(items: T[], itemId: Id): T | null {
    for (const item of items) {
      if (item.id === itemId) return item
      const child = findTreeItem(item.children, itemId)
      if (child) return child
    }

    return null
  }

  function planItemIdWithCaretAtStart(): Id | null {
    const editor = document.activeElement
    if (!(editor instanceof HTMLElement) || !editor.matches('[data-plan-text-input]')) return null

    const selection = document.getSelection()
    if (!selection || !selection.isCollapsed || selection.rangeCount === 0) return null

    const caret = selection.getRangeAt(0)
    if (!editor.contains(caret.startContainer)) return null

    const beforeCaret = document.createRange()
    beforeCaret.selectNodeContents(editor)
    beforeCaret.setEnd(caret.startContainer, caret.startOffset)
    return beforeCaret.toString().length === 0 ? editor.dataset.planTextInputId ?? null : null
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
    if (itemStateContext && selectedItemIds.length > 0) {
      delete itemCaretsByContext[itemStateContext]
    }
    document.getSelection()?.removeAllRanges()

    if (document.activeElement instanceof HTMLElement && document.activeElement.closest('input, textarea, [contenteditable="true"]')) {
      document.activeElement.blur()
    }
  }

  function itemTextInput(itemId: Id): HTMLDivElement | null {
    const surface = activeItemSurface()
    const selector = surface === 'plan'
      ? `[data-plan-text-focus-target-id="${CSS.escape(itemId)}"]`
      : surface === 'day-template'
        ? `[data-template-item-id="${CSS.escape(itemId)}"] [data-template-option-text-input]`
        : `[data-list-template-text-input-id="${CSS.escape(itemId)}"]`
    return document.querySelector<HTMLDivElement>(selector)
  }

  function scrollItemTextInputIntoView(itemId: Id) {
    const input = itemTextInput(itemId)
    if (!input) return

    const itemIds = flattenItemIds(activeItemTree())
    const itemIndex = itemIds.indexOf(itemId)
    if (itemIndex !== -1 && (itemIndex === 0 || itemIndex === itemIds.length - 1)) {
      const scrollContainer = findScrollContainer(input)
      const scrollToTop = itemIndex === 0
      if (scrollContainer) {
        scrollContainer.scrollTop = scrollToTop ? 0 : scrollContainer.scrollHeight
      } else {
        window.scrollTo(0, scrollToTop ? 0 : document.documentElement.scrollHeight)
      }
      return
    }

    input.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  function focusItemTextInput(itemId: Id, position: 'start' | 'end' = 'end') {
    const input = itemTextInput(itemId)
    if (!input) return

    input.focus()
    if (!input.matches('[contenteditable="true"]')) return

    const range = document.createRange()
    range.selectNodeContents(input)
    range.collapse(position === 'start')

    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }

  async function copyRecoveryKey() {
    const recoveryKey = recoveryKeyStatus?.recoveryKey
    if (!recoveryKey) return

    if (isTauri()) {
      await invoke('write_balance_clipboard', {
        plainText: recoveryKey,
        structuredPayload: '',
      }).catch(() => navigator.clipboard.writeText(recoveryKey))
    } else {
      await navigator.clipboard.writeText(recoveryKey)
    }
    recoveryKeyCopied = true
  }

  async function finishRecoveryKeySetup() {
    if (!recoveryKeyConfirmation.trim()) return

    recoveryKeyConfirmationError = ''
    try {
      await confirmRecoveryKey(recoveryKeyConfirmation)
      recoveryKeyConfirmation = ''
      recoveryKeyStatus = await getRecoveryKeyStatus()
      if (recoveryKeyRotationArchivedAccount) {
        recoveryKeyRotationStatus = `Database key rotated. The previous key remains in Keychain as “${recoveryKeyRotationArchivedAccount}” for older backups.`
        recoveryKeyRotationArchivedAccount = ''
      }
      await runLaunchDatabaseMaintenance()
    } catch (error) {
      recoveryKeyConfirmationError = error instanceof Error ? error.message : String(error)
    }
  }

  async function rotateRecoveryKey() {
    if (recoveryKeyRotationBusy || !isTauri()) return

    const confirmed = await confirmDialog(
      'Rotate the key that encrypts the live Balance database? Balance will build and verify a complete encrypted copy before switching. The previous key will remain in Keychain for backups created before this rotation.',
      { title: 'Rotate database key?', kind: 'warning' },
    )
    if (!confirmed) return

    recoveryKeyRotationBusy = true
    recoveryKeyRotationStatusIsError = false
    recoveryKeyRotationStatus = 'Creating and verifying a newly encrypted database…'
    try {
      await requestSync('manual-database-key-rotation-preflight')
      const result = await rotateDatabaseRecoveryKey()
      if (!result) throw new Error('Database-key rotation is available only in the installed app.')
      recoveryKeyStatus = result.recoveryKeyStatus
      recoveryKeyRotationArchivedAccount = result.archivedKeyAccount
      recoveryKeyConfirmation = ''
      recoveryKeyConfirmationError = ''
      recoveryKeyCopied = false
      recoveryKeyRotationStatus = 'Rotation verified. Save the new recovery key to finish.'
      await plannerStore.reloadFromBackend()
    } catch (error) {
      recoveryKeyRotationStatusIsError = true
      recoveryKeyRotationStatus = error instanceof Error ? error.message : String(error)
    } finally {
      recoveryKeyRotationBusy = false
    }
  }

  async function recoverAndroidDatabase() {
    if (!databaseRecoveryKey.trim()) {
      databaseRecoveryStatus = 'Enter the recovery key you saved when Balance was set up.'
      return
    }
    databaseRecoveryBusy = true
    databaseRecoveryStatus = 'Verifying the encrypted database…'
    try {
      await recoverDatabaseWithKey(databaseRecoveryKey)
      databaseRecoveryKey = ''
      databaseRecoveryStatus = 'Database verified. Reopening Balance…'
      window.location.reload()
    } catch (error) {
      databaseRecoveryStatus = error instanceof Error ? error.message : String(error)
    } finally {
      databaseRecoveryBusy = false
    }
  }

  async function startDailyReminderEdit(plan: DailyPlan | undefined) {
    if (!plan) return

    dailyReminderDraft = plan.dailyReminder
    editingReminderPlanId = plan.id
    await tick()
    dailyReminderInput?.focus()
    dailyReminderInput?.select()
  }

  function updateDailyReminder(value: string) {
    dailyReminderDraft = value
    if (editingReminderPlanId) plannerStore.patchPlanDailyReminder(editingReminderPlanId, value)
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

    if (result.kind === 'note') {
      selectedNoteId = result.noteId
      view = 'notes'
    } else if (result.kind === 'day') {
      plannerStore.setActivePlanDate(result.date)
      view = 'today'
    } else if (result.kind === 'list') {
      plannerStore.setActivePlanDate(result.date)
      listViewTemplateId = result.listTemplateId
      openListHistory()
    } else if (result.kind === 'day-template') {
      selectedTemplateId = result.templateId
      view = 'templates'
    } else if (result.kind === 'list-template') {
      selectedListTemplateId = result.templateId
      openLists()
    } else if (result.kind === 'history') {
      await openRecoveryPanel(result.historyId)
      return
    }

    if (!result.itemId) return
    await tick()
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

    const selector = result.kind === 'note'
      ? `[data-note-item-id="${CSS.escape(result.itemId)}"]`
      : result.kind === 'day-template'
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

  function dismissAvailableUpdate() {
    if (availableUpdate) {
      localStorage.setItem(DISMISSED_UPDATE_VERSION_KEY, availableUpdate.version)
    }
    availableUpdate = null
  }

  async function openAvailableUpdate() {
    if (!availableUpdate) return

    try {
      await invoke('open_external_url', { url: availableUpdate.url })
      dismissAvailableUpdate()
    } catch (error) {
      console.error('Could not open the GitHub release', error)
    }
  }
</script>

<svelte:window
  on:keydown|capture={handleGlobalKeydown}
  on:focusin={handleGlobalFocusIn}
  on:scroll={handleWindowScroll}
  on:pointerdown|capture={handleGlobalPointerDown}
  on:pointermove={handleSelectionPointerMove}
  on:pointerup={endItemSelection}
  on:pointercancel={endItemSelection}
/>
<svelte:document on:selectionchange={rememberActiveItemCaret} />

{#if documentFindOpen}
  <DocumentFindBar bind:this={documentFindBar} onClose={() => (documentFindOpen = false)} />
{/if}

{#if $persistenceError}
  <div class="app-error-banner persistence-error-banner" role="alert">
    <span class="app-error-banner-icon" aria-hidden="true">!</span>
    <div class="app-error-banner-text">
      <strong>Database save failed</strong>
      <span>{$persistenceError}</span>
    </div>
    <div class="app-error-banner-actions">
      <button type="button" class="ghost" on:click={() => { void openRecoveryPanel() }}>Inspect DB</button>
    </div>
  </div>
{/if}

{#if availableUpdate && !$persistenceError && $automaticSyncStatus.initialSyncComplete && !$automaticSyncStatus.lastError}
  <div class="app-error-banner update-available-banner" role="status" aria-live="polite">
    <span class="app-error-banner-icon" aria-hidden="true">↑</span>
    <div class="app-error-banner-text">
      <strong>Balance {availableUpdate.version} is available</strong>
      <span>A newer release is ready to download from GitHub.</span>
    </div>
    <div class="app-error-banner-actions">
      <button type="button" class="ghost" on:click={dismissAvailableUpdate}>Not now</button>
      <button type="button" class="primary" on:click={() => { void openAvailableUpdate() }}>View release</button>
    </div>
  </div>
{/if}

{#if $databaseLoadPending && !$databaseLoadError}
  <div class="database-loading-backdrop" role="status" aria-live="polite" aria-busy="true">
    <div class="database-loading-card">
      <span class="database-maintenance-spinner" aria-hidden="true"></span>
      <div>
        <p class="eyebrow">Balance</p>
        <h2>Loading…</h2>
        <div
          class="database-loading-progress"
          role="progressbar"
          aria-label="Database loading progress"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow={$databaseLoadProgress.percent}
          aria-valuetext={$databaseLoadProgress.stage}
        >
          <span style={`width: ${$databaseLoadProgress.percent}%`}></span>
        </div>
        <div class="database-loading-progress-copy">
          <span>{$databaseLoadProgress.stage}</span>
          <strong>{$databaseLoadProgress.percent}%</strong>
        </div>
        {#if databaseLoadingMessages.length > 0}
          <p class="database-loading-message">{databaseLoadingMessages[databaseLoadingMessageIndex]}</p>
        {/if}
      </div>
    </div>
  </div>
{/if}

{#if $databaseLoadError}
  <div class="modal-backdrop database-load-failure-backdrop">
    <div class="recovery-dialog" role="alertdialog" aria-modal="true" aria-labelledby="database-load-failure-title">
      <p class="eyebrow">Database protected</p>
      <h2 id="database-load-failure-title">Balance couldn’t open your encrypted database</h2>
      <p class="recovery-copy">
        Your saved database has not been replaced. The empty workspace behind this message is only a startup
        placeholder—do not enter new data or change sync settings in it.
      </p>
      <p class="database-load-error">{$databaseLoadError}</p>
      <p class="recovery-copy">
        Try again once. If this returns, keep the app installed so its private database and recovery-key file remain
        available for recovery.
      </p>
      <div class="recovery-actions">
        <button class="primary" type="button" on:click={() => window.location.reload()}>Try opening again</button>
      </div>
      {#if isAndroid}
        <div class="database-key-recovery">
          <p class="recovery-copy">
            If Android lost access to its Keystore entry, use the recovery key Balance asked you to save. It is
            verified against the existing database before any stored key file is changed.
          </p>
          <label for="database-recovery-key">Saved database recovery key</label>
          <input
            id="database-recovery-key"
            type="password"
            autocomplete="off"
            autocapitalize="none"
            spellcheck="false"
            bind:value={databaseRecoveryKey}
            disabled={databaseRecoveryBusy}
          />
          <button
            type="button"
            disabled={databaseRecoveryBusy || !databaseRecoveryKey.trim()}
            on:click={() => { void recoverAndroidDatabase() }}
          >{databaseRecoveryBusy ? 'Verifying…' : 'Unlock with recovery key'}</button>
          {#if databaseRecoveryStatus}
            <p class="database-recovery-status" role="status">{databaseRecoveryStatus}</p>
          {/if}
        </div>
      {/if}
    </div>
  </div>
{/if}

<main
  class="app-shell"
  class:android={isAndroid}
  class:macos-titlebar-overlay={isMac && !isMobile}
  class:sidebar-hidden={viewMaximized}
  class:page-maximized={viewMaximized}
  class:mobile-drawer-dragging={mobileDrawerDragging}
  style={appShellStyle}
  inert={$databaseLoadPending || Boolean($databaseLoadError) || Boolean(celebrationPreview)}
  aria-hidden={$databaseLoadPending || $databaseLoadError || celebrationPreview ? 'true' : undefined}
>
  {#if isMac && !isMobile}
    <div class="macos-titlebar-drag-region" data-tauri-drag-region aria-hidden="true"></div>
  {/if}

  {#if maximizeClickHandoff}
    <button
      class="imax-click-handoff"
      type="button"
      tabindex="-1"
      aria-hidden="true"
      style={`left: ${maximizeClickHandoff.left}px; top: ${maximizeClickHandoff.top}px; width: ${maximizeClickHandoff.width}px; height: ${maximizeClickHandoff.height}px`}
      on:click={leaveViewMaximized}
    ></button>
  {/if}

  <header class="mobile-app-header" aria-label="Mobile app header">
    <button
      class="mobile-menu-button"
      type="button"
      title="Open navigation"
      aria-label="Open navigation"
      aria-expanded={mobileDrawerOpen}
      aria-controls="primary-sidebar"
      on:click={() => (mobileDrawerOpen = true)}
    >
      <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
    </button>
    <div class="mobile-app-title">
      <strong>Balance</strong>
      {#if isTauri() && !$databaseLoadPending && !$databaseLoadError}
        <SyncStatusIndicator />
      {/if}
    </div>
    <div class="mobile-header-actions">
      {#if isMobile && view === 'today'}
        <button
          class="mobile-header-previous-day-button"
          type="button"
          title="Previous day"
          aria-label="Previous day"
          on:click={() => shiftActivePlanDate(-1)}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m14 6-6 6 6 6" /></svg>
        </button>
        <button
          class="mobile-header-next-day-button"
          type="button"
          title="Next day"
          aria-label="Next day"
          on:click={() => shiftActivePlanDate(1)}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m10 6 6 6-6 6" /></svg>
        </button>
      {/if}
      {#if isAndroid}
        {#if selectedItemIds.length > 0}
          <button
            class="mobile-header-copy-button"
            type="button"
            title="Copy selected tasks"
            aria-label="Copy selected tasks"
            on:click={copyAndClearSelectedItems}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24"><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>
          </button>
        {/if}
        <button class="mobile-header-undo-button" type="button" title="Undo" aria-label="Undo" on:click={() => { void undoAndOpenDestination() }}>
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m9 7-4 4 4 4" /><path d="M5 11h8a6 6 0 1 1-4.2 10.3" /></svg>
        </button>
      {/if}
      <button class="mobile-search-button" type="button" title="Search" aria-label="Search" on:click={openMobileDrawerSearch}>
        <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></svg>
      </button>
    </div>
  </header>

  <aside
    id="primary-sidebar"
    class="sidebar"
    class:sidebar-hidden={viewMaximized}
    class:mobile-drawer-open={mobileDrawerOpen}
    aria-label="Primary navigation drawer"
    bind:this={mobileDrawerEl}
  >
    <div>
      <div class="sidebar-brand-heading">
        <h1>Balance</h1>
        {#if isTauri() && !$databaseLoadPending && !$databaseLoadError}
          <SyncStatusIndicator />
        {/if}
      </div>
      <p class="muted">Focus on what matters today</p>
    </div>

    <button
      class="mobile-drawer-close-button"
      type="button"
      title="Close navigation"
      aria-label="Close navigation"
      on:click={closeMobileDrawer}
    >
      <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18" /></svg>
    </button>

    <nav
      class="primary-nav"
      aria-label="Primary"
      style:--active-nav-animation-delay={activeNavAnimationDelay}
      bind:this={primaryNavEl}
    >
      <button
        class:active={searchOpen}
        type="button"
        title="Search (Alt+C or Cmd/Ctrl+K)"
        aria-label="Search"
        aria-keyshortcuts="Alt+C"
        on:click={openMobileDrawerSearch}
      ><span>⌕ Search</span><kbd class="nav-shortcut" aria-hidden="true">{altShortcutLabel('C')}</kbd></button>
      <button class:active={view === 'today'} type="button" title="Today (Alt+T)" aria-keyshortcuts="Alt+T" on:click={() => openMobileDrawerView('today')}><span>Today</span><kbd class="nav-shortcut" aria-hidden="true">{altShortcutLabel('T')}</kbd></button>
      <button class:active={view === 'templates'} type="button" title="Day Templates (Alt+D)" aria-keyshortcuts="Alt+D" on:click={() => openMobileDrawerView('templates')}><span>Day Templates</span><kbd class="nav-shortcut" aria-hidden="true">{altShortcutLabel('D')}</kbd></button>
      <button class:active={view === 'listTemplates'} type="button" title="Lists (Alt+E)" aria-keyshortcuts="Alt+E" on:click={() => openMobileDrawerView('listTemplates')}><span>Lists</span><kbd class="nav-shortcut" aria-hidden="true">{altShortcutLabel('E')}</kbd></button>
      {#if listHistoryNavigationVisible}
        <button class="nav-child" class:active={view === 'lists'} type="button" title="List History (Alt+R)" aria-keyshortcuts="Alt+R" on:click={() => openMobileDrawerView('lists')}><span>List History</span><kbd class="nav-shortcut" aria-hidden="true">{altShortcutLabel('R')}</kbd></button>
      {/if}
      <button class:active={view === 'notes'} type="button" title="Notes (Alt+N)" aria-keyshortcuts="Alt+N" on:click={() => openMobileDrawerView('notes')}><span>Notes</span><kbd class="nav-shortcut" aria-hidden="true">{altShortcutLabel('N')}</kbd></button>
      <button class:active={view === 'metrics'} type="button" title="Metrics (Alt+V)" aria-keyshortcuts="Alt+V" on:click={() => openMobileDrawerView('metrics')}><span>Metrics</span><kbd class="nav-shortcut" aria-hidden="true">{altShortcutLabel('V')}</kbd></button>
      <button class:active={view === 'goals'} type="button" title="Goals (Alt+G)" aria-keyshortcuts="Alt+G" on:click={() => openMobileDrawerView('goals')}><span>Goals</span><kbd class="nav-shortcut" aria-hidden="true">{altShortcutLabel('G')}</kbd></button>
      <button class:active={view === 'settings'} type="button" title="Settings (Alt+S)" aria-keyshortcuts="Alt+S" on:click={() => openMobileDrawerView('settings')}><span>Settings</span><kbd class="nav-shortcut" aria-hidden="true">{altShortcutLabel('S')}</kbd></button>
      {#if !isAndroid}
        <button
          class="mobile-undo-button"
          type="button"
          title="Undo"
          aria-label="Undo"
          on:click={() => { void undoAndOpenDestination() }}
        >↶ Undo</button>
      {/if}
    </nav>

    <div class="sidebar-footer">
      {#if view === 'today' || view === 'templates'}
        <section class="time-shortcut-legend" aria-labelledby="time-shortcut-legend-title">
          <h2 id="time-shortcut-legend-title">Some Shortcuts</h2>
          <table>
            <thead>
              <tr>
                <th scope="col">Action</th>
                <th scope="col">Editing</th>
                <th scope="col">Selected</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Toggle</th>
                <td><kbd>{altShiftShortcutLabel('T')}</kbd></td>
                <td><kbd>T</kbd></td>
              </tr>
              <tr>
                <th scope="row">Start</th>
                <td><kbd>{altShortcutLabel('[ / ]')}</kbd></td>
                <td><kbd>[ / ]</kbd></td>
              </tr>
              <tr>
                <th scope="row">End</th>
                <td><kbd>{primaryShortcutLabel('[ / ]')}</kbd></td>
                <td><kbd>{shiftShortcutLabel('[ / ]')}</kbd></td>
              </tr>
              <tr>
                <th scope="row">Both</th>
                <td><kbd>{altShiftShortcutLabel('[ / ]')}</kbd></td>
                <td aria-label="Not available">—</td>
              </tr>
            </tbody>
          </table>
        </section>
      {/if}
      {#if selectedTemplate && view === 'today'}
        <label class="generation-template-field">
          <span>Template for new days</span>
          <select
            value={selectedTemplate.id}
            on:change={(event) => selectDayTemplate(event.currentTarget.value)}
          >
            {#each templates as template (template.id)}
              <option value={template.id}>{template.name || 'Untitled day'}</option>
            {/each}
          </select>
        </label>
      {/if}
      {#if view === 'today'}
        <button class="primary" type="button" on:click={() => { void generateSelectedDay() }}>{generateButtonLabel}</button>
      {/if}
      <p class="tiny">{$plannerStore.plans.length} saved days · {activeGoalCount} active goals</p>
    </div>
  </aside>

  <button
    class="mobile-drawer-backdrop"
    class:open={mobileDrawerOpen || mobileDrawerDragging}
    type="button"
    aria-label="Close navigation"
    tabindex={mobileDrawerOpen ? 0 : -1}
    on:click={closeMobileDrawer}
    bind:this={mobileDrawerBackdropEl}
  ></button>

  <div class="content-shell" style={contentShellStyle}>
    <section
      class="workspace"
      class:list-template-workspace={view === 'templates' || view === 'listTemplates'}
      class:comparing-days={view === 'today' && displayedCompareDayOpen}
      class:before-current-day-workspace={view === 'today' && !displayedCompareDayOpen && displayedPlanDate < currentDay}
      class:current-day-workspace={view === 'today' && !displayedCompareDayOpen && displayedPlanDate === currentDay}
      class:after-current-day-workspace={view === 'today' && !displayedCompareDayOpen && displayedPlanDate > currentDay}
      bind:this={workspaceEl}
      on:scroll={handleWorkspaceScroll}
    >
    {#if view === 'today'}
      <div class="day-panes" class:comparing={displayedCompareDayOpen}>
        {#each dayPanes as pane (pane.key)}
          {@const plan = pane.plan}
          <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
          <section
            class="day-pane"
            class:before-current-day-pane={pane.date < currentDay}
            class:current-day-pane={pane.date === currentDay}
            class:after-current-day-pane={pane.date > currentDay}
            class:focused-pane={displayedCompareDayOpen && focusedPlan?.id === plan?.id}
            aria-label={pane.key === 'compare' ? 'Compared day' : 'Daily plan'}
            aria-current={pane.date === currentDay ? 'date' : undefined}
            on:pointerdown|capture={() => focusPane(plan?.id)}
            on:focusin={() => focusPane(plan?.id)}
          >
            <header class="page-header">
              <div class="day-pane-heading">
                <p class="eyebrow day-pane-context">
                  <span>{pane.key === 'compare' ? 'Compared day' : 'Daily plan'}</span>
                </p>
                <h2>
                  {plan?.title ?? formatPlanTitle(pane.date)}
                  {#if editingReminderPlanId && plan && editingReminderPlanId === plan.id}
                    <span class="daily-reminder-prefix">—</span>
                    <input
                      bind:this={dailyReminderInput}
                      class="daily-reminder-input"
                      aria-label="Edit daily reminder"
                      value={dailyReminderDraft}
                      on:input={(event) => updateDailyReminder(event.currentTarget.value)}
                      on:blur={() => (editingReminderPlanId = null)}
                      on:keydown={handleDailyReminderKeydown}
                    />
                  {:else}
                    <button
                      class="daily-reminder-button"
                      type="button"
                      title={plan ? 'Edit daily reminder' : 'Generate a day before editing the reminder'}
                      on:click={() => { void startDailyReminderEdit(plan) }}
                    >
                      — {plan?.dailyReminder ?? DEFAULT_DAILY_REMINDER}
                    </button>
                  {/if}
                </h2>
              </div>
              <div class="date-controls" aria-label="Day navigation">
                {#if isMobile && pane.key === 'compare'}
                  <button
                    class="date-nav-button"
                    type="button"
                    aria-label="Previous compared day"
                    on:click={() => shiftCompareDayDate(-1)}
                  >
                    &lt;
                  </button>
                  <button
                    class="date-nav-button"
                    type="button"
                    aria-label="Next compared day"
                    on:click={() => shiftCompareDayDate(1)}
                  >
                    &gt;
                  </button>
                {/if}
                {#if pane.key === 'primary'}
                  <ImaxButton active={viewMaximized} onToggle={(event) => toggleViewMaximized('today', event)} />
                {/if}
                <input
                  class="date-input today-date-input"
                  type="date"
                  aria-label={pane.key === 'compare' ? 'Compared day date' : 'Day date'}
                  value={pane.date}
                  on:input={(event) =>
                    pane.key === 'compare'
                      ? (compareDayDate = event.currentTarget.value)
                      : plannerStore.setActivePlanDate(event.currentTarget.value)}
                />
                {#if pane.key === 'primary'}
                  <button
                    class="date-nav-button compare-toggle"
                    class:active={displayedCompareDayOpen}
                    type="button"
                    aria-pressed={displayedCompareDayOpen}
                    aria-label="Compare with another day"
                    title={`Compare with another day (${altShortcutLabel('B')})`}
                    on:click={toggleCompareDay}
                  >
                    ⧉
                  </button>
                {:else}
                  <button
                    class="date-nav-button"
                    type="button"
                    aria-label="Swap the two days"
                    title="Swap the two days"
                    on:click={swapCompareDays}
                  >
                    ⇄
                  </button>
                  <button
                    class="date-nav-button"
                    type="button"
                    aria-label="Close day comparison"
                    title="Close day comparison"
                    on:click={closeCompareDay}
                  >
                    ×
                  </button>
                {/if}
              </div>
            </header>

            {#if plan}
              <!-- The drop zone covers the whole panel, so an item dragged from the
                   other day can be released anywhere in this one to land at its end. -->
              <div
                class="list-panel"
                data-plan-item-scope={plan.id}
                data-item-drop-zone={displayedCompareDayOpen ? plan.id : undefined}
              >
                {#if plan.items.length === 0}
                  <p class="empty">No items yet.</p>
                {/if}

                {#each plan.items as item (item.id)}
                  <PlanItemEditor
                    {item}
                    allItems={plan.items}
                    timeWarnings={pane.timeWarnings}
                    planId={plan.id}
                    patchItem={plannerStore.patchPlanItem}
                    patchItemsDone={plannerStore.patchPlanItemsDone}
                    splitItem={plannerStore.splitPlanItem}
                    backspaceItemAtStart={plannerStore.backspacePlanItemAtStart}
                    deleteItem={plannerStore.deletePlanItem}
                    deleteItemPreservingChildren={plannerStore.deletePlanItemPreservingChildren}
                    moveItem={plannerStore.movePlanItem}
                    moveItemAcrossContainers={displayedCompareDayOpen ? movePlanItemAcrossDays : null}
                    moveItemWithinLevel={plannerStore.movePlanItemWithinLevel}
                    outdentItem={plannerStore.outdentPlanItem}
                    historyRevision={$plannerStore.historyRevision}
                    selectedItemIds={selectedItemIdSet}
                    selectionDragging={selectingItems}
                    mobile={isMobile}
                    mobileSelectionMode={isMobile && selectedItemIds.length > 0}
                    onSelectionPointerDown={beginItemSelection}
                    onSelectionPointerMove={handleSelectionPointerMove}
                    onSelectionPointerEnter={extendItemSelection}
                    onMobileSelectionStart={startMobileItemSelection}
                    onMobileSelectionToggle={toggleMobileItemSelection}
                    onCopyItem={copyPlanItemFromMenu}
                    onPasteItem={pastePlanItemFromMenu}
                    onCutItem={cutPlanItemFromMenu}
                    onTextShiftArrow={selectItemWithAdjacent}
                    {goals}
                    {goalCompletions}
                    planDate={plan.date}
                    onGoalBadgeClick={focusGoalInRhythm}
                    {listTemplates}
                    {metrics}
                    {notes}
                    onOpenLink={(link, itemId) => openLink(link, { container: 'plan', containerId: plan.id, itemId })}
                  />
                {/each}

                <button class="add-row" type="button" on:click={() => plannerStore.addRootPlanItem(plan.id)}>
                  + Add item
                </button>
              </div>
            {:else}
              <div class="empty-state">
                <h3>No plan for this date</h3>
                <p>Choose a template to generate this day, or pick another date.</p>
                {#if templates.length > 0}
                  <fieldset class="day-template-picker">
                    <legend>Day template</legend>
                    <div class="day-template-options">
                      {#each templates as template (template.id)}
                        <label
                          class="day-template-option"
                          class:selected={emptyDayTemplateSelections[pane.date] === template.id}
                        >
                          <input
                            type="radio"
                            name={`day-template-${pane.key}-${pane.date}`}
                            value={template.id}
                            checked={emptyDayTemplateSelections[pane.date] === template.id}
                            on:change={() => selectEmptyDayTemplate(pane.date, template.id)}
                          />
                          <span>{template.name || 'Untitled day'}</span>
                        </label>
                      {/each}
                    </div>
                  </fieldset>
                  <button
                    class="primary"
                    type="button"
                    disabled={!templates.some((template) => template.id === emptyDayTemplateSelections[pane.date])}
                    on:click={() => {
                      void generateDayFromTemplate(
                        emptyDayTemplateSelections[pane.date],
                        pane.key === 'compare' ? pane.date : undefined,
                      )
                    }}
                  >
                    {pane.key === 'compare' ? 'Generate this day' : generateButtonLabel}
                  </button>
                {/if}
              </div>
            {/if}
          </section>
        {/each}
      </div>
    {/if}

    {#if view === 'templates'}
      <header class="page-header">
        <div>
          <h2>Daily template</h2>
        </div>
      </header>

      {#if templates.length > 0}
        <nav class="template-rail list-template-rail" aria-label="Select day template">
          <TemplateTabs
            {templates}
            selectedId={selectedTemplate?.id ?? ''}
            kind="day"
            untitledLabel="Untitled day"
            newLabel="New day"
            onSelect={selectDayTemplate}
            onCreate={createDayTemplateAndSelect}
            onMove={plannerStore.moveTemplate}
          />
        </nav>
      {/if}

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
                timeWarnings={selectedTemplateTimeWarnings}
                templateId={selectedTemplate.id}
                patchItem={plannerStore.patchTemplateItem}
                splitItem={plannerStore.splitTemplateItem}
                backspaceOptionAtStart={plannerStore.backspaceTemplateOptionAtStart}
                deleteItem={plannerStore.deleteTemplateItem}
                deleteItemPreservingChildren={plannerStore.deleteTemplateItemPreservingChildren}
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
                {listTemplates}
                {metrics}
                {notes}
                onOpenLink={(link) => openLink(link, null)}
              />
            {/each}
          </div>

          <div class="template-panel-actions">
            <button class="add-row" type="button" on:click={() => plannerStore.addRootTemplateItem(selectedTemplate.id)}>
              + Add template item
            </button>
            <button
              class="ghost danger"
              type="button"
              disabled={templates.length <= 1}
              title={templates.length <= 1 ? 'Keep at least one day template' : 'Delete day template'}
              on:click={() => { void confirmDeleteDayTemplate(selectedTemplate.id, selectedTemplate.name) }}
            >
              Delete day template
            </button>
          </div>
        </div>
      {:else}
        <div class="empty-state">
          <h3>No day templates yet</h3>
          <p>Create one to start generating daily plans.</p>
          <button class="primary" type="button" on:click={createDayTemplateAndSelect}>+ New day template</button>
        </div>
      {/if}
    {/if}

    {#if view === 'listTemplates'}
      <header class="page-header">
        <div>
          <h2>Lists</h2>
        </div>
        <button class="primary outlined" type="button" on:click={openListHistory}>View List History →</button>
      </header>

      {#if listTemplates.length > 0}
        <nav class="template-rail list-template-rail" aria-label="Select list">
          <TemplateTabs
            templates={listTemplates}
            selectedId={selectedListTemplate?.id ?? ''}
            kind="list"
            untitledLabel="Untitled list"
            newLabel="New list"
            onSelect={(templateId) => (selectedListTemplateId = templateId)}
            onCreate={createListTemplateAndSelect}
            onMove={plannerStore.moveListTemplate}
          />

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
                deleteItemPreservingChildren={plannerStore.deleteListTemplateItemPreservingChildren}
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
                {listTemplates}
                {metrics}
                {notes}
                onOpenLink={(link) => openLink(link, null)}
              />
            {/each}
          </div>

          <div class="template-panel-actions">
            <button class="add-row" type="button" on:click={() => plannerStore.addRootListTemplateItem(selectedListTemplate.id)}>
              + Add list item
            </button>
            <button
              class="ghost"
              class:active={listArchiveOpen}
              type="button"
              aria-expanded={listArchiveOpen}
              aria-controls="list-item-archive"
              on:click={() => (listArchiveOpen = !listArchiveOpen)}
            >
              View Archive
            </button>
            <button
              class="ghost danger"
              type="button"
              on:click={() => { void confirmDeleteListTemplate(selectedListTemplate.id, selectedListTemplate.name) }}
            >
              Delete list
            </button>
          </div>

          {#if listArchiveOpen}
            <section id="list-item-archive" class="list-item-archive" aria-labelledby="list-item-archive-title">
              <div class="list-item-archive-header">
                <div>
                  <p class="eyebrow">Deleted items</p>
                  <h3 id="list-item-archive-title">Archive</h3>
                </div>
                <span>{selectedArchivedListItems.length} saved</span>
              </div>

              {#if selectedArchivedListItems.length === 0}
                <p class="list-item-archive-empty">Deleted list items will appear here.</p>
              {:else}
                <ul class="list-item-archive-list">
                  {#each selectedArchivedListItems as archived (archived.id)}
                    {@const childCount = archivedListItemChildCount(archived.item)}
                    <li class="list-item-archive-row">
                      <div class="list-item-archive-copy">
                        <strong>{archived.item.text.trim() || 'Untitled list item'}</strong>
                        <span>
                          Deleted <time datetime={archived.archivedDate}>{formatArchivedListItemDate(archived)}</time>
                          {#if childCount > 0}
                            · {childCount} nested item{childCount === 1 ? '' : 's'}
                          {/if}
                        </span>
                      </div>
                      <div class="list-item-archive-actions">
                        <button
                          type="button"
                          on:click={() => plannerStore.restoreArchivedListTemplateItem(selectedListTemplate.id, archived.id)}
                        >Restore</button>
                        <button
                          class="ghost danger"
                          type="button"
                          on:click={() => { void confirmPermanentlyDeleteArchivedListItem(archived) }}
                        >Delete forever</button>
                      </div>
                    </li>
                  {/each}
                </ul>
              {/if}
            </section>
          {/if}
        </div>
      {:else}
        <div class="empty-state">
          <h3>No lists yet</h3>
          <p>Create one to start building checklists.</p>
          <button class="primary" type="button" on:click={createListTemplateAndSelect}>+ New list</button>
        </div>
      {/if}
    {/if}

    {#if view === 'lists'}
      <header class="page-header list-history-header">
        <div class="list-history-heading">
          <button class="list-history-back" type="button" on:click={openLists}>← Back to Lists</button>
          <div>
            <h2>List History</h2>
            <p class="list-history-date">{formatPlanTitle($plannerStore.activePlanDate)}</p>
          </div>
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
          <p>Create a list first.</p>
          <button class="primary" type="button" on:click={createListTemplateAndSelect}>+ New list</button>
        </div>
      {:else if listViewInstance}
        {@const instance = listViewInstance}
        <ListPanel
          {instance}
          {listTemplates}
          {metrics}
          {notes}
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

    {#if view === 'notes'}
      <header class="page-header notes-page-header">
        <div>
          <h2>Notes</h2>
        </div>
        <div class="notes-page-actions">
          <button
            class="notes-trash-header-button"
            class:active={notesTrashOpen}
            type="button"
            aria-pressed={notesTrashOpen}
            title={notesTrashOpen ? 'Back to Notes' : 'Open Notes Bin'}
            on:click={() => (notesTrashOpen ? notesPanel?.showNotes() : notesPanel?.openTrash())}
          >Bin</button>
          <ImaxButton active={viewMaximized} onToggle={(event) => toggleViewMaximized('notes', event)} />
        </div>
      </header>
      <NotesPanel
        bind:this={notesPanel}
        bind:trashOpen={notesTrashOpen}
        notes={allNotes}
        {selectedNoteId}
        {listTemplates}
        {metrics}
        historyRevision={$plannerStore.historyRevision}
        onSelect={(noteId) => (selectedNoteId = noteId)}
        onCreate={plannerStore.addNote}
        onTrash={binNote}
        onRestore={plannerStore.restoreNote}
        onPermanentlyDelete={confirmPermanentlyDeleteNote}
        onEmptyTrash={confirmEmptyNoteTrash}
        onRename={plannerStore.renameNote}
        onAddItem={plannerStore.addRootNoteItem}
        patchItem={plannerStore.patchNoteItem}
        splitItem={plannerStore.splitNoteItem}
        backspaceItemAtStart={plannerStore.backspaceNoteItemAtStart}
        deleteItem={plannerStore.deleteNoteItem}
        deleteItemPreservingChildren={plannerStore.deleteNoteItemPreservingChildren}
        moveItem={plannerStore.moveNoteItem}
        moveItemWithinLevel={plannerStore.moveNoteItemWithinLevel}
        outdentItem={plannerStore.outdentNoteItem}
        onOpenLink={(link) => openLink(link, null)}
      />
    {/if}

    {#if view === 'metrics'}
      <header class="page-header metric-page-header">
        <div>
          <h2>Metrics</h2>
        </div>
        {#if metrics.length > 0}
          <button type="button" on:click={openImportModal}>Import past data</button>
        {/if}
      </header>

      {#if metrics.length > 0}
        <nav class="template-rail metric-rail" aria-label="Select metric">
          {#each metrics as metric (metric.id)}
            <button
              type="button"
              class="rail-chip"
              class:active={selectedMetric?.id === metric.id}
              aria-current={selectedMetric?.id === metric.id}
              data-metric-tab-id={metric.id}
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
          <h2>Goals</h2>
        </div>
        <input
          class="goal-search-input"
          type="search"
          aria-label="Search goals"
          placeholder={`Search goals… (${isMac ? '⌘F' : 'Ctrl+F'})`}
          bind:this={goalSearchInput}
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
            mobile={isMobile}
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
          {@const active = isGoalActiveOnDate(goal, currentDay)}
          {@const completionCount = goalCompletions.filter((completion) => completion.goalId === goal.id).length}
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
                <RichTextEditor
                  className="goal-name-input"
                  kind="goal-name"
                  inputId={`goal-name:${goal.id}`}
                  html={goal.nameHtml}
                  text={goal.name}
                  ariaLabel={`Goal name: ${goal.name}`}
                  revision={$plannerStore.historyRevision}
                  singleLine
                  onFocusChange={setGoalNameEditing}
                  onChange={(html, text) => plannerStore.patchGoal(goal.id, { name: text, nameHtml: html })}
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
                    onFocusChange={setGoalMatchTermsFocus}
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
                    mobile={isMobile}
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
          <h2>Settings</h2>
        </div>
      </header>

      <div class="settings-panel">
        <section class="settings-section">
          <div>
            <h3>Color theme</h3>
            <p>Pick a theme based on your mood. Each theme adapts automatically to light and dark mode.</p>
          </div>

          <div class="theme-options-stack">
            <div class="theme-grid" role="group" aria-label="Color theme">
              {#each THEME_OPTIONS as theme (theme.id)}
                <div
                  class="theme-option"
                  class:active={themeId === theme.id}
                  class:has-schedule={theme.id === 'random' && themeId !== 'random'}
                >
                  <button
                    type="button"
                    class="theme-option-select"
                    aria-pressed={themeId === theme.id}
                    on:click={() => updateTheme(theme.id)}
                  >
                    <span class="theme-swatches" aria-hidden="true">
                      {#each theme.swatches as swatch}
                        <span style={`--theme-swatch: ${swatch}`}></span>
                      {/each}
                    </span>
                    <span class="theme-option-copy">
                      <strong>{theme.name}</strong>
                      <small>{theme.description}</small>
                    </span>
                    <span class="theme-selected-mark" aria-hidden="true">✓</span>
                  </button>
                  {#if theme.id === 'random' && themeId !== 'random'}
                    <button
                      type="button"
                      class="random-theme-schedule"
                      class:scheduled={randomThemeScheduled}
                      aria-pressed={randomThemeScheduled}
                      on:click={toggleRandomThemeSchedule}
                    >
                      {randomThemeScheduled ? 'Cancel start' : 'Start next day'}
                    </button>
                  {/if}
                </div>
              {/each}
            </div>

            <ThemeTaskPreview mobile={isMobile} />

            {#if themeId === 'iridescent'}
              <IridescentGradientSettings
                value={iridescentGradient}
                defaults={defaultIridescentGradient}
                onPreview={previewIridescentGradient}
                onCommit={commitIridescentGradient}
              />
            {/if}
          </div>
        </section>

        <section class="settings-section">
          <div>
            <h3>Opening messages</h3>
            <p>
              Add or remove messages, one per line. Balance picks a different one every 10 seconds while your database
              opens. Leave this empty to show only the opening status.
            </p>
          </div>

          <label class="loading-messages-control">
            <span>Messages</span>
            <textarea
              aria-label="Database opening messages"
              rows="3"
              value={databaseLoadingMessagesDraft}
              on:input={(event) => updateDatabaseLoadingMessages(event.currentTarget.value)}
              on:blur={finishEditingDatabaseLoadingMessages}
            ></textarea>
          </label>

          <div class="settings-actions">
            <button type="button" on:click={resetDatabaseLoadingMessages}>Restore defaults</button>
          </div>
        </section>

        {#if isMac && !isMobile && isTauri()}
          <section class="settings-section">
            <div>
              <h3>Widget visibility</h3>
              <p>
                When enabled, Balance reloads WidgetKit when the app quits normally and hides your tasks after a
                15-minute grace period. A crash or force-quit can prevent the hide timer from being scheduled.
              </p>
            </div>

            <label class="widget-privacy-control">
              <input
                type="checkbox"
                checked={widgetHideContentAfterClose}
                disabled={!widgetPrivacySettingsReady || widgetPrivacySettingsBusy}
                on:change={(event) => { void updateWidgetHideContentAfterClose(event.currentTarget.checked) }}
              />
              <span>
                <strong>Hide widget content 15 minutes after Balance closes</strong>
                <small>Enabled by default. Reopening Balance during the grace period cancels the pending hide.</small>
              </span>
            </label>

            {#if widgetPrivacySettingsStatus}
              <p class:error={widgetPrivacySettingsStatusIsError} class="export-status">
                {widgetPrivacySettingsStatus}
              </p>
            {/if}
          </section>
        {/if}

        <SyncPanel />

        <section class="settings-section">
          <div>
            <h3>Completed item colors</h3>
            <p>Fine-tune the checkbox and checked-row colors, or keep them matched to your theme.</p>
          </div>

          <div class="done-tint-row">
            <div class="completed-color-controls">
              <div class="done-tint-control">
                <span class="color-control-label">Checkbox</span>
                <GoalColorPicker
                  hue={checkboxPickerColor.hue}
                  lightness={checkboxPickerColor.lightness}
                  ariaLabel="Checked checkbox color"
                  mobile={isMobile}
                  onChange={updateCheckboxColorFromPicker}
                />
                <input
                  class="done-tint-hex"
                  type="text"
                  aria-label="Checked checkbox hex code"
                  spellcheck="false"
                  maxlength="7"
                  value={checkboxColorHex}
                  on:change={(event) => updateCheckboxColor(event.currentTarget.value)}
                />
              </div>

              <div class="done-tint-control">
                <span class="color-control-label">Row tint</span>
                <GoalColorPicker
                  hue={doneTintPickerColor.hue}
                  lightness={doneTintPickerColor.lightness}
                  ariaLabel="Completed item tint color"
                  mobile={isMobile}
                  onChange={updateDoneTintFromPicker}
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
              </div>
            </div>

            <div class="done-tint-preview plan-row done" aria-label="Example completed item">
              <input class="check" type="checkbox" checked disabled aria-label="Example checked checkbox" />
              <span class="item-text done">Dress up in a porcupine suit</span>
            </div>
          </div>

          <div class="settings-actions">
            <button type="button" disabled={!doneTintColor && !checkboxColor} on:click={resetCompletedItemColors}>Match theme</button>
          </div>
        </section>

        <CelebrationSettings
          selectedId={completionCelebrationId}
          onSelect={(id) => { void startCelebrationPreview(id) }}
        />

        {#if isMac && !isMobile}
          <section class="settings-section">
            <div>
              <h3>Database encryption key</h3>
              <p>
                Replace the key used by the live encrypted database. Balance verifies a complete newly encrypted copy
                before switching, and retains the previous key in Keychain so backups from before the rotation remain
                recoverable.
              </p>
            </div>

            <div class="settings-actions">
              <button
                type="button"
                disabled={!isTauri() || recoveryKeyRotationBusy || databaseCompactionBusy || recoveryBusy}
                on:click={() => { void rotateRecoveryKey() }}
              >
                {recoveryKeyRotationBusy ? 'Rotating and verifying…' : 'Rotate database key'}
              </button>
            </div>

            {#if recoveryKeyRotationStatus}
              <p class:error={recoveryKeyRotationStatusIsError} class="export-status">
                {recoveryKeyRotationStatus}
              </p>
            {/if}
          </section>
        {/if}

        <section class="settings-section">
          <div>
            <h3>Recovery &amp; diagnostics</h3>
            {#if isTauri()}
              <p>
                Balance continuously bounds undo and sync history, creates a verified encrypted backup after the first
                change each day, and reclaims file space only when enough unused pages accumulate.
              </p>
            {:else}
              <p>Restore removed items or earlier states and inspect database history. Automatic housekeeping runs in the installed app.</p>
            {/if}
          </div>

          {#if isTauri()}
            <p class="export-status">
              Last physical optimization: {formatMaintenanceTimestamp(databaseMaintenanceStatus?.lastCompletedAt)}
              · {formatDatabaseBytes(databaseMaintenanceStatus?.reclaimableBytes ?? 0)} currently reclaimable
            </p>
          {/if}

          <div class="settings-actions">
            <button type="button" on:click={() => { void openRecoveryPanel() }}>
              Open recovery &amp; diagnostics
            </button>
          </div>
        </section>

        <section class="settings-section">
          <div>
            <h3>Manual export</h3>
            <p>Save a portable copy of your plans, templates, goals, and operation log.</p>
          </div>

          <div class="export-panel">
            {#if !isMobile}
              <div>
                <h4>Canonical JSON</h4>
                <p>Full app state for restore or migration.</p>
                <button class="primary" type="button" on:click={downloadJSON}>Export JSON</button>
              </div>
            {/if}

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

    {#if goalRhythmVisible || viewMaximized}
      <GoalHistoryPanel
        goals={goalHistoryGoals}
        completions={goalCompletions}
        viewedDate={$plannerStore.activePlanDate || todayISO()}
        visible={goalRhythmVisible}
        onOpenGoals={openGoals}
        onOpenDate={openDateInToday}
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
          {notes}
          bind:selectedItemId={selectedListOverlayItemIdsByList[instance.id]}
          initialScrollTop={listOverlayScrollTopsByList[instance.id] ?? null}
          onScrollTopChange={(scrollTop) => {
            listOverlayScrollTopsByList = { ...listOverlayScrollTopsByList, [instance.id]: scrollTop }
          }}
          onOpenLink={(link, itemId) => openLink(link, { container: 'list', containerId: instance.id, itemId })}
          onEditTemplate={(itemId) => editListItemInTemplate(instance, itemId)}
          showEditShortcutHint
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

{#if celebrationPreviewAnnouncement}
  <div class="celebration-preview-announcement" role="status" aria-live="polite">
    {celebrationPreviewAnnouncement}
  </div>
{/if}

<Celebration bind:this={celebration} />
<GoalBurst bind:this={goalBurst} />

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
                <!-- Render the saved rich text just like a real task so formatting
                     such as explicit line breaks survives in the review preview. -->
                <div
                  class="paste-review-text item-text item-text-display"
                  class:done={node.item.done}
                  class:empty={!node.item.text?.trim()}
                >{@html node.item.text?.trim() ? renderItemDisplayHTML(node.item.html, node.item.text, []) : '(empty item)'}</div>
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
      <h2 id="recovery-title">
        {recoveryKeyRotationArchivedAccount ? 'Save your new recovery key' : 'Save your recovery key'}
      </h2>
      <p class="recovery-copy">
        {#if recoveryKeyRotationArchivedAccount}
          This key now unlocks your live Balance database. Your previous key remains in Keychain as
          “{recoveryKeyRotationArchivedAccount}” for backups created before the rotation.
        {:else}
          This key unlocks your encrypted Balance database from a backup or another device. Keep it somewhere private;
          Balance cannot recover it for you.
        {/if}
      </p>

      <div class="recovery-key" aria-label="Recovery key">{recoveryKeyStatus.recoveryKey}</div>

      <form class="recovery-actions" on:submit|preventDefault={finishRecoveryKeySetup}>
        <button type="button" on:click={copyRecoveryKey}>{recoveryKeyCopied ? 'Copied' : 'Copy key'}</button>
        <label class="confirm-line" for="recovery-key-confirmation">
          <span>Re-enter the complete key to prove your saved copy works.</span>
        </label>
        <input
          id="recovery-key-confirmation"
          class="recovery-key-confirmation"
          type="text"
          autocomplete="off"
          enterkeyhint="done"
          spellcheck="false"
          bind:value={recoveryKeyConfirmation}
        />
        {#if recoveryKeyConfirmationError}
          <p class="database-load-error">{recoveryKeyConfirmationError}</p>
        {/if}
        <button class="primary" type="submit" disabled={!recoveryKeyConfirmation.trim()}>
          Continue
        </button>
      </form>

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
          <h2 id="recovery-panel-title">Recovery history</h2>
        </div>
        <button type="button" class="ghost" on:click={closeRecoveryPanel} disabled={databaseCompactionBusy}>Close</button>
      </div>
      <p class="recovery-copy">
        Each entry is a saved undo snapshot. It can restore removed content or an earlier version of edited text.
      </p>

      {#if recoveryStatus}
        <p class="recovery-panel-status" class:error={recoveryStatusIsError}>{recoveryStatus}</p>
      {/if}

      <div class="recovery-actions-row">
        <button
          type="button"
          on:click={() => { void refreshRecoveryEntries(); void refreshMetadata(); void refreshDatabaseInspection() }}
          disabled={recoveryBusy || databaseInspectionBusy || databaseCompactionBusy}
        >
          Refresh
        </button>
        <button
          type="button"
          class="primary"
          on:click={() => { void optimizeDatabase() }}
          disabled={recoveryBusy || databaseInspectionBusy || databaseCompactionBusy}
        >
          {databaseCompactionBusy ? 'Optimizing…' : 'Optimize database'}
        </button>
      </div>
      <p class="recovery-copy metadata-hint">
        Optimization only returns unused pages to the filesystem. It does not remove sync operations or undo/recovery
        entries. Balance performs logical history cleanup and encrypted daily backups independently.
      </p>

      <div class="recovery-scroll">
      <details class="metadata-section" bind:open={recoveryListOpen}>
        <summary>Saved states ({recoveryEntries.length})</summary>
        <ul class="recovery-list">
          {#each recoveryEntries as entry (entry.historyId)}
            <li
              class="recovery-row"
              class:undone={entry.undone}
              class:search-result-target={recoveryExpandedId === entry.historyId}
              data-recovery-history-id={entry.historyId}
            >
              <div class="recovery-row-main">
                <div class="recovery-row-info">
                  <span class="recovery-row-title">
                    {entry.restoredItemCount > 0
                      ? `Restores ${entry.restoredItemCount} item${entry.restoredItemCount === 1 ? '' : 's'}`
                      : 'Restores an earlier state'}
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
                  <button type="button" class="primary" disabled={recoveryBusy || databaseCompactionBusy} on:click={() => restoreRecoveryEntry(entry)}>
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
        <p class="recovery-copy metadata-hint">Session and database diagnostics.</p>
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
