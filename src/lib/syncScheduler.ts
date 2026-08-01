import { writable } from 'svelte/store'
import {
  getSyncSettings,
  onPersistedOperation,
  plannerStore,
  syncRelayOnce,
  type SyncPassResult,
} from './store'

const EDIT_DEBOUNCE_MS = 2_000
const SAFETY_POLL_MS = 5 * 60 * 1_000
const MAX_RETRY_MS = 5 * 60 * 1_000

export type AutomaticSyncStatus = {
  running: boolean
  lastSuccessAt: number | null
  lastError: string
  pending: boolean
}

export const automaticSyncStatus = writable<AutomaticSyncStatus>({
  running: false,
  lastSuccessAt: null,
  lastError: '',
  pending: false,
})

let running: Promise<SyncPassResult | null> | null = null
let queuedReason: string | null = null
let editTimer: ReturnType<typeof setTimeout> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let retryMs = 5_000

async function configured(): Promise<boolean> {
  const settings = await getSyncSettings()
  return settings.enabled && Boolean(settings.pairingCode && settings.relayUrl)
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
    queuedReason = reason
    automaticSyncStatus.update((status) => ({ ...status, pending: true }))
    return running
  }
  if (!(await configured())) return null

  running = (async () => {
    automaticSyncStatus.update((status) => ({ ...status, running: true, pending: false }))
    try {
      const result = await syncRelayOnce(reason)
      if (result.stateChanged) await plannerStore.reloadFromBackend()
      retryMs = 5_000
      if (retryTimer) clearTimeout(retryTimer)
      retryTimer = null
      automaticSyncStatus.set({ running: false, lastSuccessAt: Date.now(), lastError: '', pending: false })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      automaticSyncStatus.update((status) => ({ ...status, running: false, lastError: message }))
      scheduleRetry()
      return null
    } finally {
      running = null
      const followup = queuedReason
      queuedReason = null
      if (followup) void requestSync(followup)
    }
  })()
  return running
}

export function startAutomaticSync(): () => void {
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
    if (document.visibilityState === 'visible') void requestSync('resume')
  }
  const stopPersisted = onPersistedOperation(triggerEdit)
  const poll = setInterval(() => void requestSync('safety-poll'), SAFETY_POLL_MS)
  window.addEventListener('online', onOnline)
  window.addEventListener('focus', onFocus)
  document.addEventListener('visibilitychange', onVisibility)

  return () => {
    stopPersisted()
    clearInterval(poll)
    if (editTimer) clearTimeout(editTimer)
    if (retryTimer) clearTimeout(retryTimer)
    window.removeEventListener('online', onOnline)
    window.removeEventListener('focus', onFocus)
    document.removeEventListener('visibilitychange', onVisibility)
  }
}
