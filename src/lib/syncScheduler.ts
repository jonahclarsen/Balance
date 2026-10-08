import { get, writable } from 'svelte/store'
import { invoke, isTauri } from '@tauri-apps/api/core'
import {
  getSyncSettings,
  onPersistedOperation,
  plannerStore,
  syncRelayOnce,
  type SyncPassResult,
} from './store'

const EDIT_DEBOUNCE_MS = 2_000
const ACTIVE_CHANGE_POLL_MS = 2_000
const ACTIVE_CHANGE_WINDOW_MS = 60_000
const QUIET_VISIBLE_POLL_MS = 8_000
const BACKGROUND_POLL_MS = 5 * 60 * 1_000
const MAX_RETRY_MS = 5 * 60 * 1_000
// A phone catching up after a quick app switch stays quiet unless the pass
// drags on. A desktop window regains focus constantly, so only a pass that is
// genuinely slow earns the cue there.
const SLOW_ACTIVITY_MS = 1_000
const DESKTOP_SLOW_ACTIVITY_MS = 6_000
// After this long away, a phone shows Syncing at once so stale state is never
// mistaken for current.
const STALE_AFTER_MS = 60_000
const isMobileDevice = typeof navigator !== 'undefined' && /android|iphone|ipad|ipod/i.test(navigator.userAgent)

export type AutomaticSyncStatus = {
  running: boolean
  lastSuccessAt: number | null
  lastError: string
  pending: boolean
  configured: boolean | null
  initialSyncComplete: boolean
  offline: boolean
  showActivity: boolean
}

let offline = !isTauri() && typeof navigator !== 'undefined' && !navigator.onLine

export const automaticSyncStatus = writable<AutomaticSyncStatus>({
  running: false,
  lastSuccessAt: null,
  lastError: '',
  pending: false,
  configured: null,
  initialSyncComplete: false,
  offline,
  showActivity: false,
})

let running: Promise<SyncPassResult | null> | null = null
let queuedReason: string | null = null
let queuedPromise: Promise<SyncPassResult | null> | null = null
let resolveQueued: ((result: SyncPassResult | null | PromiseLike<SyncPassResult | null>) => void) | null = null
let editTimer: ReturnType<typeof setTimeout> | null = null
let pollTimer: ReturnType<typeof setTimeout> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let retryMs = 5_000
let lastChangeAt = 0
let automaticSyncStarted = false
let backendRefreshPending = false
let uploadStarted = false
let slowActivityTimer: ReturnType<typeof setTimeout> | null = null

async function refreshConnectivity(syncReportedOffline = false): Promise<boolean> {
  // Prefer an explicit OS result over potentially stale WebView hints. If the
  // native monitor is unavailable (including during startup), retain the
  // WebView's offline signal instead of attempting a doomed relay pass.
  const nativeOffline = isTauri()
    ? await invoke<boolean | null>('get_sync_network_offline').catch(() => null)
    : null
  offline = syncReportedOffline || (nativeOffline ?? !navigator.onLine)
  automaticSyncStatus.update((status) => ({
    ...status,
    offline,
    lastError: offline ? '' : status.lastError,
    showActivity: offline ? false : status.showActivity,
  }))
  if (offline && retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
  return offline
}

function pollDelay(): number {
  if (document.visibilityState !== 'visible') return BACKGROUND_POLL_MS
  if (Date.now() - lastChangeAt < ACTIVE_CHANGE_WINDOW_MS) return ACTIVE_CHANGE_POLL_MS
  return QUIET_VISIBLE_POLL_MS
}

function schedulePoll(): void {
  if (!automaticSyncStarted) return
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = setTimeout(() => {
    pollTimer = null
    void requestSync('poll').finally(schedulePoll)
  }, pollDelay())
}

function hasActualChanges(result: SyncPassResult): boolean {
  return result.pulledOperations > 0 || result.pushedOperations > 0 || result.stateChanged
}

function syncErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const cleaned = message.replace(/^codec:\s*/i, '').trim()
  return cleaned ? `${cleaned[0].toUpperCase()}${cleaned.slice(1)}` : 'Unknown sync error.'
}

async function configured(): Promise<boolean> {
  const settings = await getSyncSettings()
  return settings.enabled && Boolean(settings.pairingCode && settings.relayUrl)
}

function requiresFollowup(reason: string): boolean {
  return ['edit', 'manual', 'resume', 'focus', 'online', 'sync-enabled', 'paired', 'relay-configured'].includes(reason)
}

// Which passes show the Syncing cue, and when. User-requested passes show it
// at once. Launch and a return to the app show it at once on a phone that has
// been away for a while, and otherwise only when the pass is slow. Polls,
// edits, and retries never show it; errors and offline have their own cues.
function activityDelay(reason: string, lastSuccessAt: number | null): number | null {
  if (['manual', 'sync-enabled', 'paired', 'relay-configured'].includes(reason)) return 0
  if (!['launch', 'resume', 'focus'].includes(reason)) return null
  if (isMobileDevice) {
    const stale = lastSuccessAt === null || Date.now() - lastSuccessAt > STALE_AFTER_MS
    return stale ? 0 : SLOW_ACTIVITY_MS
  }
  return DESKTOP_SLOW_ACTIVITY_MS
}

function shouldShowActivity(reason: string): boolean {
  return activityDelay(reason, null) === 0
}

function refreshesVisibleState(reason: string): boolean {
  return ['launch', 'resume', 'focus', 'manual'].includes(reason)
}

async function reloadVisibleState(reason: string, stateChanged: boolean): Promise<void> {
  if (refreshesVisibleState(reason) || stateChanged) await plannerStore.reloadFromBackend()
}

function scheduleRetry(): void {
  if (offline || retryTimer) return
  const jitter = Math.floor(Math.random() * Math.max(1_000, retryMs / 4))
  retryTimer = setTimeout(() => {
    retryTimer = null
    void requestSync('retry')
  }, retryMs + jitter)
  retryMs = Math.min(MAX_RETRY_MS, retryMs * 2)
}

export async function requestSync(reason: string): Promise<SyncPassResult | null> {
  if (running) {
    if (requiresFollowup(reason)) {
      // Keep an explicit refresh when an edit joins the same queued pass.
      if (!queuedReason || !refreshesVisibleState(queuedReason) || reason === 'manual') queuedReason = reason
      if (!queuedPromise) {
        queuedPromise = new Promise((resolve) => { resolveQueued = resolve })
      }
    }
    automaticSyncStatus.update((status) => ({
      ...status,
      pending: Boolean(queuedReason),
      showActivity: status.showActivity || shouldShowActivity(reason),
    }))
    return requiresFollowup(reason) ? queuedPromise : running
  }
  running = (async () => {
    // initialSyncComplete is a launch latch. Routine polls, resumes, and edits
    // must not reset it and make unrelated foreground UI look uninitialized.
    automaticSyncStatus.update((status) => ({
      ...status,
      running: false,
      pending: false,
      configured: null,
      showActivity: false,
    }))

    await refreshConnectivity()

    let syncConfigured: boolean
    try {
      syncConfigured = await configured()
    } catch (error) {
      if (reason === 'launch') {
        try {
          await plannerStore.reloadFromBackend()
        } catch (reloadError) {
          console.error('Could not refresh visible state after launch settings failed', reloadError)
        }
      }
      await refreshConnectivity(error === 'sync-offline')
      const message = syncErrorMessage(error)
      automaticSyncStatus.update((status) => ({
        ...status,
        running: false,
        lastError: offline || error === 'sync-offline' ? '' : message,
        configured: null,
        offline,
        showActivity: false,
      }))
      scheduleRetry()
      return null
    }

    if (!syncConfigured) {
      automaticSyncStatus.set({
        running: false,
        lastSuccessAt: null,
        lastError: '',
        pending: false,
        configured: false,
        initialSyncComplete: true,
        offline,
        showActivity: false,
      })
      return null
    }

    try {
      if (offline) {
        // Local durability and Android background updates still matter offline.
        await plannerStore.flushPendingOperations()
        await reloadVisibleState(reason, backendRefreshPending)
        backendRefreshPending = false
        automaticSyncStatus.update((status) => ({
          ...status,
          configured: true,
          initialSyncComplete: true,
          lastError: '',
          offline: true,
        }))
        return null
      }

      const delay = activityDelay(reason, get(automaticSyncStatus).lastSuccessAt)
      automaticSyncStatus.update((status) => ({
        ...status,
        running: true,
        configured: true,
        offline,
        showActivity: status.showActivity || delay === 0,
      }))
      if (delay !== null && delay > 0) {
        slowActivityTimer = setTimeout(() => {
          slowActivityTimer = null
          automaticSyncStatus.update((status) => (
            status.running ? { ...status, showActivity: true } : status
          ))
        }, delay)
      }
      // A mobile WebView can be suspended before the ordinary persistence
      // debounce fires. Reconcile only after every edit still visible in the
      // frontend is durable, or an incoming checkpoint can replace its older
      // database state before the pending operation is applied.
      await plannerStore.flushPendingOperations()
      uploadStarted = true
      const result = await syncRelayOnce(reason)
      // WorkManager can update the database without
      // this WebView observing it. A no-op relay pass does not imply that the
      // visible state is current when returning to the app or syncing manually.
      await reloadVisibleState(reason, result.stateChanged || backendRefreshPending)
      backendRefreshPending = false
      if (hasActualChanges(result)) {
        lastChangeAt = Date.now()
        schedulePoll()
      }
      retryMs = 5_000
      if (retryTimer) clearTimeout(retryTimer)
      retryTimer = null
      automaticSyncStatus.set({
        running: false,
        lastSuccessAt: Date.now(),
        lastError: '',
        pending: false,
        configured: true,
        initialSyncComplete: true,
        offline,
        showActivity: false,
      })
      return result
    } catch (error) {
      // A failed pass can still have committed earlier incoming batches. Its
      // error carries no stateChanged flag, so refresh once and retain a latch
      // if that read fails too. Empty successful polls remain read-free.
      backendRefreshPending = true
      try {
        await plannerStore.reloadFromBackend()
        backendRefreshPending = false
      } catch (reloadError) {
        console.error('Could not refresh visible state after sync failed', reloadError)
      }
      await refreshConnectivity(error === 'sync-offline')
      const message = syncErrorMessage(error)
      automaticSyncStatus.update((status) => ({
        ...status,
        running: false,
        lastError: offline || error === 'sync-offline' ? '' : message,
        configured: true,
        initialSyncComplete: offline || status.initialSyncComplete,
        offline,
        showActivity: false,
      }))
      scheduleRetry()
      return null
    }
  })()
  const current = running
  const finish = () => {
    if (running !== current) return
    running = null
    if (slowActivityTimer) clearTimeout(slowActivityTimer)
    slowActivityTimer = null
    uploadStarted = false
    const followup = queuedReason
    const settleFollowup = resolveQueued
    queuedReason = null
    queuedPromise = null
    resolveQueued = null
    // Manual callers must observe the pass requested after their click, not an
    // older pass whose upload may already have missed their latest edit.
    if (followup) settleFollowup?.(requestSync(followup))
  }
  void current.then(finish, finish)
  return current
}

export function startAutomaticSync(): () => void {
  automaticSyncStarted = true
  lastChangeAt = 0
  automaticSyncStatus.update((status) => ({
    ...status,
    configured: null,
    initialSyncComplete: false,
    offline,
    showActivity: false,
  }))
  schedulePoll()

  const triggerEdit = () => {
    if (editTimer) clearTimeout(editTimer)
    editTimer = null
    if (running && uploadStarted) {
      // The active upload may already have captured its outbox. Queue now:
      // Android can suspend the WebView before a debounce callback runs.
      void requestSync('edit')
      return
    }
    editTimer = setTimeout(() => {
      editTimer = null
      void requestSync('edit')
    }, EDIT_DEBOUNCE_MS)
  }
  // Events accelerate discovery; native snapshots remain authoritative. Polls
  // also recover from WebViews that omit connectivity events while suspended.
  const onOnline = () => void requestSync('online')
  const onOffline = () => void refreshConnectivity()
  const onFocus = () => void requestSync('focus')
  const onVisibility = () => {
    schedulePoll()
    if (document.visibilityState === 'visible') {
      void requestSync('resume')
    } else {
      // Start the native write while Android still gives the WebView time to
      // finish its background transition instead of relying on a paused timer.
      void plannerStore.flushPendingOperations()
    }
  }
  const onPageHide = () => void plannerStore.flushPendingOperations()
  const stopPersisted = onPersistedOperation(triggerEdit)
  window.addEventListener('online', onOnline)
  window.addEventListener('offline', onOffline)
  window.addEventListener('focus', onFocus)
  window.addEventListener('pagehide', onPageHide)
  document.addEventListener('visibilitychange', onVisibility)

  return () => {
    automaticSyncStarted = false
    stopPersisted()
    if (editTimer) clearTimeout(editTimer)
    if (pollTimer) clearTimeout(pollTimer)
    if (retryTimer) clearTimeout(retryTimer)
    window.removeEventListener('online', onOnline)
    window.removeEventListener('offline', onOffline)
    window.removeEventListener('focus', onFocus)
    window.removeEventListener('pagehide', onPageHide)
    document.removeEventListener('visibilitychange', onVisibility)
  }
}
