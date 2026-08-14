import { writable } from 'svelte/store'
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

export type AutomaticSyncStatus = {
  running: boolean
  lastSuccessAt: number | null
  lastError: string
  pending: boolean
  configured: boolean | null
  initialSyncComplete: boolean
  phase: 'idle' | 'reading-settings' | 'waiting-database' | 'syncing'
}

export const automaticSyncStatus = writable<AutomaticSyncStatus>({
  running: false,
  lastSuccessAt: null,
  lastError: '',
  pending: false,
  configured: null,
  initialSyncComplete: false,
  phase: 'idle',
})

let running: Promise<SyncPassResult | null> | null = null
let queuedReason: string | null = null
let editTimer: ReturnType<typeof setTimeout> | null = null
let pollTimer: ReturnType<typeof setTimeout> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let retryMs = 5_000
let lastChangeAt = 0
let automaticSyncStarted = false
const SETTINGS_WAIT_NOTICE_MS = 750

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
  return ['edit', 'manual', 'warning-retry', 'sync-enabled', 'paired', 'relay-configured'].includes(reason)
}

async function reloadVisibleStateAfterLaunch(reason: string, stateChanged: boolean): Promise<void> {
  if (reason === 'launch' || stateChanged) await plannerStore.reloadFromBackend()
}

function scheduleRetry(): void {
  if (retryTimer) return
  const jitter = Math.floor(Math.random() * Math.max(1_000, retryMs / 4))
  retryTimer = setTimeout(() => {
    retryTimer = null
    void requestSync('retry')
  }, retryMs + jitter)
  retryMs = Math.min(MAX_RETRY_MS, retryMs * 2)
}

export async function requestSync(reason: string): Promise<SyncPassResult | null> {
  if (running) {
    if (requiresFollowup(reason)) queuedReason = reason
    automaticSyncStatus.update((status) => ({ ...status, pending: Boolean(queuedReason) }))
    return running
  }
  running = (async () => {
    automaticSyncStatus.update((status) => ({
      ...status,
      running: false,
      pending: false,
      configured: null,
      initialSyncComplete: false,
      phase: 'reading-settings',
    }))
    const waitingNotice = window.setTimeout(() => {
      automaticSyncStatus.update((status) =>
        status.phase === 'reading-settings' ? { ...status, phase: 'waiting-database' } : status,
      )
    }, SETTINGS_WAIT_NOTICE_MS)

    let syncConfigured: boolean
    try {
      syncConfigured = await configured()
    } catch (error) {
      window.clearTimeout(waitingNotice)
      if (reason === 'launch') {
        try {
          await plannerStore.reloadFromBackend()
        } catch (reloadError) {
          console.error('Could not refresh visible state after launch settings failed', reloadError)
        }
      }
      const message = syncErrorMessage(error)
      automaticSyncStatus.update((status) => ({
        ...status,
        running: false,
        lastError: message,
        configured: null,
        initialSyncComplete: false,
        phase: 'idle',
      }))
      scheduleRetry()
      return null
    }
    window.clearTimeout(waitingNotice)

    if (!syncConfigured) {
      automaticSyncStatus.set({
        running: false,
        lastSuccessAt: null,
        lastError: '',
        pending: false,
        configured: false,
        initialSyncComplete: true,
        phase: 'idle',
      })
      return null
    }

    automaticSyncStatus.update((status) => ({
      ...status,
      running: true,
      configured: true,
      phase: 'syncing',
    }))
    try {
      const result = await syncRelayOnce(reason)
      // A due WorkManager pass may have updated the database immediately before
      // this foreground pass. Reload on launch even when this pass sees no new
      // operations so the WebView cannot keep showing the pre-sync snapshot.
      await reloadVisibleStateAfterLaunch(reason, result.stateChanged)
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
        phase: 'idle',
      })
      return result
    } catch (error) {
      if (reason === 'launch') {
        try {
          await plannerStore.reloadFromBackend()
        } catch (reloadError) {
          console.error('Could not refresh visible state after launch sync failed', reloadError)
        }
      }
      const message = syncErrorMessage(error)
      automaticSyncStatus.update((status) => ({
        ...status,
        running: false,
        lastError: message,
        configured: true,
        initialSyncComplete: false,
        phase: 'idle',
      }))
      scheduleRetry()
      return null
    }
  })()
  const current = running
  const finish = () => {
    if (running !== current) return
    running = null
    const followup = queuedReason
    queuedReason = null
    if (followup) void requestSync(followup)
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
    phase: 'idle',
  }))
  schedulePoll()

  const triggerEdit = () => {
    if (editTimer) clearTimeout(editTimer)
    editTimer = setTimeout(() => {
      editTimer = null
      void requestSync('edit')
    }, EDIT_DEBOUNCE_MS)
  }
  const onOnline = () => void requestSync('online')
  const onFocus = () => void requestSync('focus')
  const onVisibility = () => {
    schedulePoll()
    if (document.visibilityState === 'visible') void requestSync('resume')
  }
  const stopPersisted = onPersistedOperation(triggerEdit)
  window.addEventListener('online', onOnline)
  window.addEventListener('focus', onFocus)
  document.addEventListener('visibilitychange', onVisibility)

  return () => {
    automaticSyncStarted = false
    stopPersisted()
    if (editTimer) clearTimeout(editTimer)
    if (pollTimer) clearTimeout(pollTimer)
    if (retryTimer) clearTimeout(retryTimer)
    window.removeEventListener('online', onOnline)
    window.removeEventListener('focus', onFocus)
    document.removeEventListener('visibilitychange', onVisibility)
  }
}
