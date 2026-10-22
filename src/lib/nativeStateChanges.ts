// Incremental native workspace reads; the native side is
// src-tauri/src/state_changes.rs. The frontend sends fingerprints of the
// snapshot it last applied and receives only the values and records that
// differ, so a refresh after one edit does not reparse years of history.

export type NativeFingerprints = {
  values: Record<string, string>
  collections: Record<string, { ids: string[]; hashes: string[] }>
}

type CollectionChanges = { ids: string[]; records: unknown[]; hashes: string[] }

export type NativeStateChanges = {
  values: Record<string, unknown>
  valueHashes: Record<string, string>
  collections: Record<string, CollectionChanges>
}

// `revision` is the database revision the snapshot reflects, when known.
// `current` means the store already holds every change since its known revision.
export type NativeStateResponse =
  | { state: Record<string, unknown>; fingerprints?: NativeFingerprints; revision?: number | null }
  | { changes: NativeStateChanges; revision?: number | null }
  | { current: true }
  | null

export type NativeStateNormalizers = {
  value: (key: string, value: unknown) => unknown
  record: (key: string, record: unknown) => unknown
}

/**
 * Identifies the small values every read carries in full (see `Part::Always`
 * natively). A changes response with no other changes and the same signature
 * holds nothing the applied snapshot lacks.
 */
export function scalarSignature(values: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(values)
    .filter((key) => key === 'operations' || values[key] === null || typeof values[key] !== 'object')
    .sort()
    .map((key) => [key, values[key]]))
}

export function hasNoRecordChanges(changes: NativeStateChanges): boolean {
  return Object.keys(changes.collections).length === 0 && Object.keys(changes.valueHashes).length === 0
}

export function sameFingerprints(left: NativeFingerprints, right: NativeFingerprints): boolean {
  const sameKeys = (a: object, b: object) => Object.keys(a).length === Object.keys(b).length
  return sameKeys(left.values, right.values) && sameKeys(left.collections, right.collections) &&
    Object.entries(left.values).every(([key, hash]) => right.values[key] === hash) &&
    Object.entries(left.collections).every(([key, collection]) => {
      const other = right.collections[key]
      return other !== undefined && collection.ids.length === other.ids.length &&
        collection.ids.every((id, index) => other.ids[index] === id && other.hashes[index] === collection.hashes[index])
    })
}

function recordId(record: unknown): string | undefined {
  if (!record || typeof record !== 'object') return undefined
  const id = (record as { id?: unknown }).id
  return typeof id === 'string' ? id : undefined
}

/**
 * Applies a changes response to the normalized state the fingerprints
 * describe. Unchanged records keep their object identity. Returns null when
 * the held state lacks a record the native side considers unchanged; the
 * caller then rereads the complete snapshot.
 */
export function* mergeNativeChanges(
  held: Record<string, unknown>,
  fingerprints: NativeFingerprints,
  changes: NativeStateChanges,
  normalize: NativeStateNormalizers,
): Generator<void, { state: Record<string, unknown>; fingerprints: NativeFingerprints } | null, void> {
  const state = { ...held }
  const values = { ...fingerprints.values }
  const collections = { ...fingerprints.collections }

  for (const [key, value] of Object.entries(changes.values)) {
    state[key] = normalize.value(key, value)
    if (Object.hasOwn(changes.valueHashes, key)) {
      values[key] = changes.valueHashes[key]
      delete collections[key]
    }
  }

  for (const [key, change] of Object.entries(changes.collections)) {
    const known = collections[key]
    const knownHashes = new Map(known?.ids.map((id, index) => [id, known.hashes[index]]))
    const updates = new Map(change.records.map((record, index) => [recordId(record), { record, hash: change.hashes[index] }]))
    const heldRecords = new Map((Array.isArray(held[key]) ? held[key] as unknown[] : []).map((record) => [recordId(record), record]))
    const records: unknown[] = []
    const hashes: string[] = []
    for (const id of change.ids) {
      const update = updates.get(id)
      if (update) {
        records.push(normalize.record(key, update.record))
        hashes.push(update.hash)
        yield
        continue
      }
      const record = heldRecords.get(id)
      const hash = knownHashes.get(id)
      if (record === undefined || hash === undefined) return null
      records.push(record)
      hashes.push(hash)
    }
    state[key] = records
    collections[key] = { ids: change.ids, hashes }
    delete values[key]
  }

  return { state, fingerprints: { values, collections } }
}
