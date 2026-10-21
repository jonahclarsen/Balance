import { writable, get } from 'svelte/store'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { defaults, regenerate, upgradePresets, validate, enableMode, grant, type Document, type Answers, type Platform } from './core'
export const situate = writable<Document>(defaults())
export const situateError = writable('')
export const situateReady = writable(false)
export const situateNow = writable(Date.now())
export const quizRequest = writable<{ mode: string; target: string; startedAt: number; revision: number } | null>(null)
export const situatePlatform: Platform = /Android/i.test(navigator.userAgent) ? 'android' : /Win/i.test(navigator.userAgent) ? 'windows' : 'mac'
let queue = Promise.resolve()
export function mutateSituate(change: (current: Document) => Document): Promise<void> {
  const operation = queue.then(async () => {
    const current = get(situate)
    const next = change(structuredClone(current))
    validate(next)
    next.revision = current.revision + 1
    if (isTauri()) await invoke('situate_save', { document: next, expectedRevision: current.revision })
    else localStorage.setItem('balance-situate-v1', JSON.stringify(next))
    situate.set(next); situateNow.set(Date.now()); situateError.set('')
  })
  queue = operation.catch(error => { situateError.set(String(error)) })
  return operation
}
export async function startSituate(): Promise<() => void> {
  try {
    const saved = isTauri() ? await invoke<Document | null>('situate_load') : JSON.parse(localStorage.getItem('balance-situate-v1') ?? 'null')
    // Upgrade before validating: older rules lack fields that validation now requires.
    if (saved) { const upgraded = upgradePresets(saved); validate(upgraded); situate.set(upgraded) }
    situateReady.set(true)
    await mutateSituate(current => regenerate(upgradePresets(current)))
  } catch (error) { situateError.set(String(error)); return () => {} }
  const stopListening = isTauri() ? await listen<number>('situate-rules-changed', ({ payload }) => {
    void queue.then(async () => {
      if (payload <= get(situate).revision) return
      const current = await invoke<Document | null>('situate_load')
      if(current) { const upgraded = upgradePresets(current); validate(upgraded); situate.set(upgraded) }
    }).catch(error => situateError.set(String(error)))
  }) : () => {}
  const clockKey = () => `${new Date().toDateString()}:${new Date().getTimezoneOffset()}`
  let day = clockKey()
  const timer = window.setInterval(() => {
    situateNow.set(Date.now())
    if (clockKey() !== day) { day = clockKey(); void mutateSituate(current => regenerate(current)).catch(() => {}) }
  }, 1000)
  return () => { window.clearInterval(timer); stopListening() }
}
export function requestQuiz(mode: string, target = '') { quizRequest.set({ mode, target, startedAt: Date.now(), revision: get(situate).revision }) }
export function activateMode(mode: string) { return mutateSituate(current => enableMode(current, mode)) }
export function answerQuiz(answers: Answers) {
  const request = get(quizRequest)
  if (!request) return Promise.resolve()
  return mutateSituate(current => {
    if(current.revision !== request.revision) throw new Error('Rules changed. Reopen the quiz.')
    return grant(current, request.mode, answers, request.startedAt, Date.now(), request.target)
  }).then(() => quizRequest.set(null))
}
export function situateDeepLink(raw: string): boolean {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'balance:' || url.hostname !== 'situate') return false
    const mode = url.searchParams.get('mode')
    if (mode && get(situate).modes.some(m => m.id === mode)) requestQuiz(mode, url.searchParams.get('target') ?? '')
    return true
  } catch { return false }
}
