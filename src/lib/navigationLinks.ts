// Navigation links contain only stable IDs or dates, never private record text.
export const LINKABLE_VIEWS = ['situate', 'next', 'today', 'templates', 'listTemplates', 'lists', 'notes', 'projects', 'prioritize', 'ideas', 'metrics', 'goals', 'settings'] as const
export type LinkableView = typeof LINKABLE_VIEWS[number]
export type NavigationTarget =
  | { kind: 'page'; view: LinkableView }
  | { kind: 'day'; date: string }
  | { kind: 'task' | 'day-template' | 'list-template' | 'list' | 'quiz' | 'goal' | 'idea-group' | 'note' | 'prioritize'; id: string; itemId?: string; date?: string }

const ID = /^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/
export function navigationURL(kind: NavigationTarget['kind'], id: string, itemId?: string, date?: string): string {
  const query = new URLSearchParams()
  if (itemId) query.set('item', itemId)
  if (date) query.set('date', date)
  return `balance://${kind}/${encodeURIComponent(id)}${query.size ? `?${query}` : ''}`
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T12:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export function parseNavigationURL(raw: string): NavigationTarget | null {
  let url: URL
  try { url = new URL(raw.trim()) } catch { return null }
  if (url.href !== raw.trim() || /[\u0000-\u001f\u007f]/.test(raw)) return null
  if (url.protocol !== 'balance:' || url.username || url.password || url.port || url.hash) return null
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length !== 1 || url.pathname !== `/${parts[0]}`) return null
  // Links copied before Buckets became Ideas keep opening it.
  const id = url.hostname === 'page' && parts[0] === 'buckets' ? 'ideas' : parts[0]
  const kind = url.hostname === 'bucket' ? 'idea-group' : url.hostname
  if (kind === 'page') return !url.search && LINKABLE_VIEWS.includes(id as LinkableView) ? { kind, view: id as LinkableView } : null
  if (kind === 'day') {
    return !url.search && isCalendarDate(id) ? { kind, date: id } : null
  }
  if (!['task', 'day-template', 'list-template', 'list', 'quiz', 'goal', 'idea-group', 'note', 'prioritize'].includes(kind) || !ID.test(id)) return null
  const itemId = url.searchParams.get('item') ?? undefined
  const date = url.searchParams.get('date') ?? undefined
  if (date !== undefined && (kind !== 'quiz' || !isCalendarDate(date) || url.searchParams.getAll('date').length > 1)) return null
  if ([...url.searchParams.keys()].some(key => key !== 'item' && key !== 'date') || url.searchParams.getAll('item').length > 1 || (itemId !== undefined && !ID.test(itemId))) return null
  if (itemId && ['task', 'goal', 'idea-group'].includes(kind)) return null
  return { kind: kind as Exclude<NavigationTarget['kind'], 'page' | 'day'>, id, ...(itemId ? { itemId } : {}), ...(date ? { date } : {}) }
}

// Scan complete tokens so malformed paths never turn into links to a prefix.
export function balanceURLMatches(text: string): Array<{ url: string; start: number; end: number }> {
  return [...text.matchAll(/balance:\/\/[^\s<>"'\[\]]+/g)].map(match => {
    const url = match[0].replace(/[.,;!?)]+$/, '')
    return { url, start: match.index!, end: match.index! + url.length }
  })
}

export function linkAtElement(target: Element): string | null {
  for (let element: Element | null = target; element; element = element.parentElement) {
    const data = (element as HTMLElement).dataset
    if (!data) continue
    if (data.balanceLink) return data.balanceLink
    if (data.planItemId) return navigationURL('task', data.planItemId)
    if (data.templateItemId && data.itemContainerId) return navigationURL('day-template', data.itemContainerId, data.templateItemId)
    if (data.listTemplateItemId && data.itemContainerId) return navigationURL('list-template', data.itemContainerId, data.listTemplateItemId)
    if (data.noteItemId) {
      const note = parseNavigationURL(element.closest<HTMLElement>('.note-document')?.dataset.balanceLink ?? '')
      const noteId = data.itemContainerId || (note?.kind === 'note' ? note.id : '')
      if (noteId) return navigationURL('note', noteId, data.noteItemId)
    }
    if (data.priorityId && data.itemContainerId) return navigationURL('prioritize', data.itemContainerId, data.priorityId)
    if (data.metricQuestionId && data.itemContainerId) return navigationURL('quiz', data.itemContainerId, data.metricQuestionId)
    if (data.goalId) return navigationURL('goal', data.goalId)
    if (data.goalDate) return navigationURL('day', data.goalDate)
    if (data.dayTemplateTabId) return navigationURL('day-template', data.dayTemplateTabId)
    if (data.listTemplateTabId) return navigationURL('list-template', data.listTemplateTabId)
    if (data.metricTabId || data.archivedMetricTabId) return navigationURL('quiz', data.metricTabId || data.archivedMetricTabId!)
    if (data.navView && LINKABLE_VIEWS.includes(data.navView as LinkableView)) return navigationURL('page', data.navView)
    // Never copy a page behind an unrelated modal.
    if (element.getAttribute('role') === 'dialog' || element.getAttribute('role') === 'alertdialog') return null
  }
  return null
}
