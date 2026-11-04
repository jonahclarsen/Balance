import { get } from 'svelte/store'
import { isTauri } from '@tauri-apps/api/core'
import { databaseLoadError, databaseLoadPending, plannerStore } from '../store'
import { validate } from './core'
import { reconcileRules, type SharedRules } from './sharing'
import { mutateSituate, situate, situatePlatform, situateReady } from './store'

const SETTLE_MS = 1000

// The main window carries Situate across devices. Enforcement and the quiz window
// keep working from rules.json, without the planner database.
export function startSituateSync(): () => void {
  if (!isTauri()) return () => {}
  let timer: number | undefined
  const remote = () => (get(plannerStore).situateRules[0] ?? null) as SharedRules | null
  const run = () => {
    timer = undefined
    if (get(databaseLoadPending) || get(databaseLoadError) || !get(situateReady)) return
    if (!reconcileRules(get(situate), remote(), situatePlatform)) return
    void mutateSituate(current => {
      const result = reconcileRules(current, remote(), situatePlatform)
      if (!result) return current
      validate(result.document)
      if (result.publish) plannerStore.publishSituateRules(result.publish)
      return result.document
    }).catch(() => {})
  }
  const schedule = () => { window.clearTimeout(timer); timer = window.setTimeout(run, SETTLE_MS) }
  const flush = () => { if (document.hidden && timer !== undefined) { window.clearTimeout(timer); run() } }
  let known: unknown
  const stops = [
    plannerStore.subscribe(state => { if (state.situateRules !== known) { known = state.situateRules; schedule() } }),
    situate.subscribe(schedule),
    situateReady.subscribe(schedule),
    databaseLoadPending.subscribe(schedule),
  ]
  document.addEventListener('visibilitychange', flush)
  return () => {
    window.clearTimeout(timer)
    document.removeEventListener('visibilitychange', flush)
    stops.forEach(stop => stop())
  }
}
