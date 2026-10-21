import { derived, get, writable } from 'svelte/store'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { situate, situatePlatform } from './store'
export type Browser = { id: string; name: string; extension: boolean; host: boolean }
export const extensionStatus = writable<{ browsers: Browser[]; folder: string } | null>(null)
export const extensionSetupOpen = writable(false)
/** Installed browsers still missing the extension, once Situate is on. */
export const browsersMissingExtension = derived([extensionStatus, situate], ([status, doc]) =>
  doc.enabled ? (status?.browsers ?? []).filter(b => !b.extension || !b.host) : [])
export async function checkExtension(action: 'status' | 'install' | `open-${string}` = 'status') {
  if (!isTauri() || situatePlatform !== 'mac') return
  try { extensionStatus.set(await invoke('situate_extension', { action })) } catch { /* Keep the last result. */ }
}
export function watchExtension(): () => void {
  if (!isTauri() || situatePlatform !== 'mac') return () => {}
  void checkExtension()
  // Check quickly while the setup steps are open so each browser ticks off as it connects.
  let timer = 0
  const schedule = () => { timer = window.setTimeout(() => { void checkExtension().finally(schedule) }, get(extensionSetupOpen) ? 2000 : 60000) }
  schedule()
  const stop = extensionSetupOpen.subscribe(open => { if (open) { window.clearTimeout(timer); void checkExtension('install').finally(schedule) } })
  return () => { window.clearTimeout(timer); stop() }
}
