// The replicated patch vocabulary is independent from feature/action names.
// Objects merge changed fields; arrays of records address elements by stable id.
export type EntityPatch =
  | { kind: 'replace'; value: unknown }
  | { kind: 'object'; fields: Record<string, EntityPatch>; remove: string[] }
  | { kind: 'records'; entries: Record<string, EntityPatch>; remove: string[]; order?: string[] }

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function records(value: unknown): value is (Record<string, unknown> & { id: string })[] {
  return Array.isArray(value) && value.every((item) => object(item) && typeof item.id === 'string') &&
    new Set(value.map((item) => item.id)).size === value.length
}
export function entityPatch(before: unknown, after: unknown): EntityPatch {
  // Match JSON persistence: undefined object fields are absent, not malformed
  // replace patches whose required value disappears during serialization.
  const json = (value: unknown) => value === undefined ? null : JSON.parse(JSON.stringify(value))
  return diff(json(before), json(after))
}
function diff(before: unknown, after: unknown): EntityPatch {
  if (object(before) && object(after)) {
    const fields: Record<string, EntityPatch> = Object.create(null)
    for (const key of Object.keys(after)) {
      if (!Object.hasOwn(before, key) || JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
        fields[key] = diff(before[key], after[key])
      }
    }
    return { kind: 'object', fields, remove: Object.keys(before).filter((key) => !Object.hasOwn(after, key)) }
  }
  if (records(before) && records(after)) {
    const previous = new Map(before.map((item) => [item.id, item]))
    const entries: Record<string, EntityPatch> = Object.create(null)
    for (const item of after) {
      if (JSON.stringify(previous.get(item.id)) !== JSON.stringify(item)) entries[item.id] = diff(previous.get(item.id), item)
    }
    const ids = after.map((item) => item.id)
    const remove = before.filter((item) => !ids.includes(item.id)).map((item) => item.id)
    return { kind: 'records', entries, remove, ...(JSON.stringify(before.map((item) => item.id)) === JSON.stringify(ids) ? {} : { order: ids }) }
  }
  return { kind: 'replace', value: after }
}
