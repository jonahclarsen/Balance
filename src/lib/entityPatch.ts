// The replicated patch vocabulary is independent from feature/action names.
// Objects merge changed fields; arrays of records address elements by stable id.
export type EntityPatch =
  | { kind: 'replace'; value: unknown }
  | { kind: 'object'; fields: Record<string, EntityPatch>; remove: string[] }
  | { kind: 'records'; keyField?: string; entries: Record<string, EntityPatch>; remove: string[]; order?: string[] }

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function records(value: unknown, keyField: string): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every((item) => object(item) && typeof item[keyField] === 'string') &&
    new Set(value.map((item) => item[keyField])).size === value.length
}
export function entityPatch(before: unknown, after: unknown): EntityPatch {
  return diff(before, after)
}
// Whether two values serialize to the same JSON, ignoring key order. Shared
// references short-circuit, so a one-item edit compares one path instead of
// serializing the whole record twice.
export function jsonEqual(before: unknown, after: unknown): boolean {
  if (before === after) return true
  if (Array.isArray(before) || Array.isArray(after)) {
    if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length) return false
    for (let index = 0; index < before.length; index += 1) {
      if (!jsonEqual(before[index] ?? null, after[index] ?? null)) return false
    }
    return true
  }
  if (object(before) && object(after)) {
    if (typeof before.toJSON === 'function' || typeof after.toJSON === 'function') return JSON.stringify(before) === JSON.stringify(after)
    let defined = 0
    for (const key of Object.keys(before)) {
      if (before[key] === undefined) continue
      defined += 1
      if (after[key] === undefined || !jsonEqual(before[key], after[key])) return false
    }
    for (const key of Object.keys(after)) if (after[key] !== undefined) defined -= 1
    return defined === 0
  }
  return JSON.stringify(before) === JSON.stringify(after)
}
function diff(before: unknown, after: unknown): EntityPatch {
  if (object(before) && object(after)) {
    const fields: Record<string, EntityPatch> = Object.create(null)
    for (const key of Object.keys(after)) {
      // JSON omits undefined properties. Preserve shared references so a small
      // edit does not clone and serialize every unrelated nested record.
      if (after[key] === undefined || before[key] === after[key]) continue
      if (before[key] === undefined || !jsonEqual(before[key], after[key])) {
        fields[key] = diff(before[key], after[key])
      }
    }
    return { kind: 'object', fields, remove: Object.keys(before).filter((key) => before[key] !== undefined && (!Object.hasOwn(after, key) || after[key] === undefined)) }
  }
  for (const keyField of ['id', 'questionId']) {
    if (records(before, keyField) && records(after, keyField)) {
      const key = (item: Record<string, unknown>) => item[keyField] as string
      const previous = new Map(before.map((item) => [key(item), item]))
      const entries: Record<string, EntityPatch> = Object.create(null)
      for (const item of after) {
        const prior = previous.get(key(item))
        if (prior !== item && (prior === undefined || !jsonEqual(prior, item))) entries[key(item)] = diff(prior, item)
      }
      const ids = after.map(key)
      const kept = new Set(ids)
      const remove = before.filter((item) => !kept.has(key(item))).map(key)
      const sameOrder = before.length === ids.length && before.every((item, index) => key(item) === ids[index])
      return { kind: 'records', ...(keyField === 'id' ? {} : { keyField }), entries, remove, ...(sameOrder ? {} : { order: ids }) }
    }
  }
  return { kind: 'replace', value: after ?? null }
}
