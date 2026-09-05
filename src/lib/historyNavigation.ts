import type { AppState } from './types'

export type HistoryDestination = {
  view: 'today' | 'templates' | 'listTemplates' | 'lists' | 'notes' | 'metrics' | 'goals'
  entityId: string
  itemId?: string
  date?: string
  listTemplateId?: string
  label: string
  removed: boolean
}

type Item = { id: string; children?: Item[] }
type ItemLocation = { item: Item; parentId?: string; index: number }

function locations(items: Item[], parentId?: string, result = new Map<string, ItemLocation>()) {
  items.forEach((item, index) => {
    result.set(item.id, { item, parentId, index })
    locations(item.children ?? [], item.id, result)
  })
  return result
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  return sameFields(left, right)
}

function sameFields(left: object, right: object, ignored: string[] = []): boolean {
  if (left === right) return true
  const a = left as Record<string, unknown>
  const b = right as Record<string, unknown>
  const keys = Object.keys(a).filter((key) => !ignored.includes(key))
  return keys.length === Object.keys(b).filter((key) => !ignored.includes(key)).length &&
    keys.every((key) => Object.hasOwn(b, key) && sameValue(a[key], b[key]))
}

// Compare the actual before/after state so reveal also works after restart, when
// native history has no cached frontend entry. Ignore derived timestamps and
// inspect children individually instead of selecting their unchanged ancestors.
function changedItem(before: Item[], after: Item[]) {
  if (before === after) return null
  const previous = locations(before)
  const next = locations(after)
  const ids = [...new Set([...next.keys(), ...previous.keys()])]
  const changedId = ids.find((id) => {
    const a = previous.get(id)
    const b = next.get(id)
    return !a || !b || !sameFields(a.item, b.item, ['children']) || a.parentId !== b.parentId
  }) ?? ids.find((id) => previous.get(id)?.index !== next.get(id)?.index)
  if (!changedId) return null
  const a = previous.get(changedId)
  const b = next.get(changedId)
  const completion = a && b && (a.item as { done?: boolean }).done !== (b.item as { done?: boolean }).done
  // When a row disappears, reveal its surviving parent or nearest sibling.
  let itemId: string | undefined = b ? changedId : a?.parentId
  while (itemId && !next.has(itemId)) itemId = previous.get(itemId)?.parentId
  if (!b && !itemId) {
    const siblings = [...next.values()].filter((entry) => entry.parentId === a?.parentId)
    itemId = (siblings[Math.min(a?.index ?? 0, siblings.length - 1)])?.item.id
  }
  return { itemId, removed: !b, completion: !!completion }
}

export function historyDestination(before: AppState, after: AppState): HistoryDestination | null {
  const collections = [
    ['plans', 'today'], ['templates', 'templates'], ['listTemplates', 'listTemplates'],
    ['lists', 'lists'], ['notes', 'notes'], ['metrics', 'metrics'], ['goals', 'goals'],
  ] as const
  for (const [collection, view] of collections) {
    if (before[collection] === after[collection]) continue
    const previous = new Map<string, { id: string }>(before[collection].map((entity) => [entity.id, entity]))
    const next = new Map<string, { id: string }>(after[collection].map((entity) => [entity.id, entity]))
    const movedId = previous.size === next.size && [...next.keys()].every((id) => previous.has(id))
      ? [...next.keys()].find((id, index) => before[collection][index].id !== id) : undefined
    const destinations: HistoryDestination[] = []
    for (const id of new Set([...next.keys(), ...previous.keys()])) {
      const a = previous.get(id)
      const b = next.get(id)
      if (a && b && id !== movedId && sameFields(a, b, ['updatedAt', 'presentationTrackingStartedAt'])) continue
      const entity = (b ?? a)! as {
        id: string; items?: Item[]; questions?: Item[]; date?: string
        listTemplateId?: string; title?: string; name?: string
      }
      const old = a as typeof entity | undefined
      const current = b as typeof entity | undefined
      const change = changedItem(old?.items ?? old?.questions ?? [], current?.items ?? current?.questions ?? [])
      const name = entity.title || entity.name
      const subject = change?.completion ? 'completion' : change ? 'item change' : 'change'
      const context = entity.date ?? name ?? ({ today: 'Today', templates: 'Day Templates', listTemplates: 'Lists', lists: 'List History', notes: 'Notes', metrics: 'Metrics', goals: 'Goals' }[view])
      destinations.push({
        view, entityId: id, itemId: change?.itemId, date: entity.date,
        listTemplateId: entity.listTemplateId,
        label: `${subject} · ${context}`,
        removed: !b || (change?.removed ?? false),
      })
    }
    if (destinations.length) return destinations.find((target) => !target.removed) ?? destinations[0]
  }
  for (const entry of [...after.metricEntries, ...before.metricEntries]) {
    const a = before.metricEntries.find((candidate) => candidate.id === entry.id)
    const b = after.metricEntries.find((candidate) => candidate.id === entry.id)
    if (a && b && sameFields(a, b, ['updatedAt'])) continue
    const metric = after.metrics.find((candidate) => candidate.id === entry.metricId)
    const questionId = [...(b?.answers ?? []), ...(a?.answers ?? [])].find((answer) =>
      a?.answers.find((value) => value.questionId === answer.questionId)?.value !==
      b?.answers.find((value) => value.questionId === answer.questionId)?.value,
    )?.questionId
    return {
      view: 'metrics', entityId: entry.metricId, itemId: questionId, date: entry.date,
      label: `answer · ${metric?.name || 'Metric'} · ${entry.date}`, removed: !b,
    }
  }
  return null
}
