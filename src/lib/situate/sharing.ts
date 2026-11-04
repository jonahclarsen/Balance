import { jsonEqual } from '../entityPatch'
import { defaults, regenerate, type Document, type Grant, type Platform } from './core'

/** The replicated rules and on/off state. Epochs and windows are derived on each device. */
export type SharedRules = Record<string, unknown> & {
  id: 'rules'
  settings: Document['settings']
  accessQuiz: Document['accessQuiz']
  modes: Document['modes']
  manual: Document['manual']
  /** IDs let two devices' passes merge instead of replacing each other. */
  grants: (Grant & { id: string })[]
}

// Fields from a newer client stay in the base, so an older client keeps them.
export function sharedRules(doc: Document): SharedRules {
  return {
    ...doc.syncBase,
    id: 'rules',
    settings: doc.settings,
    accessQuiz: doc.accessQuiz,
    modes: doc.modes,
    manual: doc.manual,
    grants: doc.grants.map(grant => ({ ...grant, id: `${grant.mode}|${grant.target}` })),
  }
}

type Plain = Record<string, unknown>
const isPlain = (value: unknown): value is Plain => value !== null && typeof value === 'object' && !Array.isArray(value)
const isRecords = (value: unknown): value is (Plain & { id: string })[] =>
  Array.isArray(value) && value.every(item => isPlain(item) && typeof item.id === 'string')

/** Keeps each side's changes since the base. When both changed one value, local wins. */
export function mergeRules(base: unknown, local: unknown, remote: unknown): unknown {
  if (jsonEqual(local, base)) return remote
  if (jsonEqual(remote, base) || jsonEqual(local, remote)) return local
  if (isPlain(local) && isPlain(remote)) {
    const from = isPlain(base) ? base : {}
    const merged: Plain = {}
    for (const key of new Set([...Object.keys(remote), ...Object.keys(local)])) {
      const value = mergeRules(from[key], local[key], remote[key])
      if (value !== undefined) merged[key] = value
    }
    return merged
  }
  if (isRecords(local) && isRecords(remote)) {
    const from = isRecords(base) ? base : []
    const ids = (items: { id: string }[]) => items.map(item => item.id)
    const find = (items: { id: string }[], id: string) => items.find(item => item.id === id)
    const order = jsonEqual(ids(local), ids(from)) ? [...ids(remote), ...ids(local)] : [...ids(local), ...ids(remote)]
    return [...new Set(order)].map(id => mergeRules(find(from, id), find(local, id), find(remote, id))).filter(item => item !== undefined)
  }
  return local
}

function customized(doc: Document): boolean {
  const preset = defaults(doc.generatedAt)
  return !jsonEqual(
    { settings: doc.settings, accessQuiz: doc.accessQuiz, modes: doc.modes },
    { settings: preset.settings, accessQuiz: preset.accessQuiz, modes: preset.modes },
  )
}

function applyRules(doc: Document, rules: SharedRules, now: number): Document {
  const { settings, accessQuiz, modes, manual } = rules
  const grants = rules.grants.map(({ id: _id, ...grant }) => grant)
  return regenerate({ ...doc, settings, accessQuiz, modes, manual, grants, syncBase: rules }, now)
}

/**
 * What it takes to bring this device and the replicated record together, or null
 * if they already agree. A phone adopts rules but never starts the record, and
 * untouched defaults never do, so a new device can't overwrite customized rules.
 */
export function reconcileRules(doc: Document, remote: SharedRules | null, platform: Platform, now = Date.now()): { document: Document; publish: SharedRules | null } | null {
  const base = doc.syncBase ?? null
  const local = sharedRules(doc)
  if (!base && !remote && (platform === 'android' || !customized(doc))) return null
  const merged = (base && remote ? mergeRules(base, local, remote) : remote ?? local) as SharedRules
  const publish = remote && jsonEqual(merged, remote) ? null : merged
  if (!publish && base && jsonEqual(merged, base) && jsonEqual(local, merged)) return null
  return { document: applyRules(doc, merged, now), publish }
}
