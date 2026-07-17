import type { Id, MoveDirection } from './types'

export type ItemRowKind = 'plan' | 'day-template' | 'list-template'

const rowSelectors: Record<ItemRowKind, string> = {
  plan: '[data-plan-item-id]',
  'day-template': '[data-template-item-id]',
  'list-template': '[data-list-template-item-id]',
}

function rowItemId(row: HTMLElement, kind: ItemRowKind): Id | null {
  if (kind === 'plan') return row.dataset.planItemId ?? null
  if (kind === 'day-template') return row.dataset.templateItemId ?? null
  return row.dataset.listTemplateItemId ?? null
}

function scrollContainerFor(element: HTMLElement): HTMLElement | null {
  let current = element.parentElement
  while (current) {
    const overflowY = window.getComputedStyle(current).overflowY
    if (/(auto|scroll|overlay)/.test(overflowY) && current.scrollHeight > current.clientHeight) return current
    current = current.parentElement
  }
  return null
}

// Keep a moved row (or selected block of rows) away from the viewport edges.
// Two surrounding rows are included in the required visible region whenever
// they exist, so repeated Option+Arrow moves retain useful visual context.
export function scrollMovedItemsIntoView(kind: ItemRowKind, itemIds: Id[], direction: MoveDirection) {
  if (itemIds.length === 0) return

  const selector = rowSelectors[kind]
  const rows = Array.from(document.querySelectorAll<HTMLElement>(selector))
  const movedIds = new Set(itemIds)
  const movedIndexes = rows
    .map((row, index) => (movedIds.has(rowItemId(row, kind) ?? '') ? index : -1))
    .filter((index) => index >= 0)
  if (movedIndexes.length === 0) return

  const firstIndex = Math.min(...movedIndexes)
  const lastIndex = Math.max(...movedIndexes)
  const visibleStart = rows[Math.max(0, firstIndex - 2)]
  const visibleEnd = rows[Math.min(rows.length - 1, lastIndex + 2)]
  const scrollContainer = scrollContainerFor(rows[firstIndex])
  const viewport = scrollContainer?.getBoundingClientRect()
  let viewportTop = viewport?.top ?? 0
  const viewportBottom = viewport?.bottom ?? window.innerHeight
  const stickyRail = kind === 'list-template'
    ? rows[firstIndex].closest('.workspace')?.querySelector<HTMLElement>('.list-template-rail')
    : null
  const stickyRailRect = stickyRail?.getBoundingClientRect()
  if (stickyRailRect && stickyRailRect.top <= viewportTop && stickyRailRect.bottom > viewportTop) {
    viewportTop = stickyRailRect.bottom
  }
  const requiredTop = visibleStart.getBoundingClientRect().top
  const requiredBottom = visibleEnd.getBoundingClientRect().bottom
  const topDelta = requiredTop - viewportTop
  const bottomDelta = requiredBottom - viewportBottom

  let delta = 0
  if (topDelta < 0 && bottomDelta > 0) delta = direction === 'up' ? topDelta : bottomDelta
  else if (topDelta < 0) delta = topDelta
  else if (bottomDelta > 0) delta = bottomDelta
  if (delta === 0) return

  if (scrollContainer) scrollContainer.scrollBy({ top: delta })
  else window.scrollBy({ top: delta })
}
