import { stickyRowVisibleBottom } from './stickyParentRows'
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

const treeShellSelector = '.item-shell, .template-item'

// The bottom of the parent rows pinned above an element, or null when its
// nearest parent row sits in its normal place and covers nothing.
function pinnedParentsBottom(element: Element): number | null {
  const parentShell = element.closest(treeShellSelector)?.parentElement?.closest(treeShellSelector)
  const parentRow = parentShell?.firstElementChild
  if (!parentShell || !parentRow?.classList.contains('sticky-parent')) return null
  const rowRect = parentRow.getBoundingClientRect()
  return rowRect.top > parentShell.getBoundingClientRect().top + 0.5 ? stickyRowVisibleBottom(parentRow) : null
}

// The viewport line an element must stay below to clear the parents that pin
// above it once it nears the top: where the outermost of them pins plus every
// pinned height below that. Null when no parent pins above it. Rows not yet
// measured count at full height. Sticky offsets count from the scroll
// container's padding edge and already include headers and rails pinned above
// the tree.
export function pinnedParentsLine(element: Element): number | null {
  let outermost: HTMLElement | null = null
  let heights = 0
  for (let shell = element.closest(treeShellSelector)?.parentElement?.closest<HTMLElement>(treeShellSelector); shell; shell = shell.parentElement?.closest<HTMLElement>(treeShellSelector)) {
    const parentRow = shell.firstElementChild
    if (!(parentRow instanceof HTMLElement) || !parentRow.classList.contains('sticky-parent')) continue
    outermost = parentRow
    heights += parseFloat(shell.style.getPropertyValue('--tree-sticky-height')) || parentRow.offsetHeight
  }
  if (!outermost) return null
  const rowRect = outermost.getBoundingClientRect()
  const scale = outermost.offsetHeight ? rowRect.height / outermost.offsetHeight : 1
  const scroller = scrollContainerFor(outermost)
  const edge = scroller
    ? scroller.getBoundingClientRect().top + (scroller.clientTop + parseFloat(getComputedStyle(scroller).paddingTop)) * scale
    : 0
  return edge + (parseFloat(getComputedStyle(outermost).top) + heights) * scale
}

// Nudges a just-revealed element out from behind the parents pinned above it.
export function keepBelowPinnedParents(element: HTMLElement, gap = 8) {
  const line = pinnedParentsLine(element)
  if (line === null) return
  const delta = element.getBoundingClientRect().top - (line + gap)
  if (delta >= 0) return
  const scroller = scrollContainerFor(element)
  const zoom = element.currentCSSZoom || 1
  if (scroller) scroller.scrollBy({ top: delta / zoom })
  else window.scrollBy({ top: delta })
}

// Keep a moved row (or selected block of rows) away from the viewport edges.
// Two surrounding rows are included in the required visible region whenever
// they exist, so repeated Option+Arrow moves retain useful visual context.
export function scrollMovedItemsIntoView(kind: ItemRowKind, itemIds: Id[], direction: MoveDirection) {
  if (itemIds.length === 0) return

  const selector = rowSelectors[kind]
  const rows = Array.from(document.querySelectorAll<HTMLElement>(selector))
    .filter((row) => !row.closest('.retained-day[hidden]'))
  const movedIds = new Set(itemIds)
  const movedIndexes = rows
    .map((row, index) => (movedIds.has(rowItemId(row, kind) ?? '') ? index : -1))
    .filter((index) => index >= 0)
  if (movedIndexes.length === 0) return

  const firstIndex = Math.min(...movedIndexes)
  const lastIndex = Math.max(...movedIndexes)
  const contextStart = rows[Math.max(0, firstIndex - 2)]
  // A pinned parent is already in view wherever the scroll lands.
  const visibleStart = contextStart.closest(treeShellSelector)?.contains(rows[firstIndex]) ? rows[firstIndex] : contextStart
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
  viewportTop = Math.max(viewportTop, pinnedParentsBottom(visibleStart) ?? viewportTop)
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

// Scroll just far enough for the caret (or the editor, when the selection is
// elsewhere) to be visible, leaving the rest of the view where the user had it.
export function revealCaret(editor: HTMLElement, margin = 24) {
  const selection = document.getSelection()
  const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
  const caret = range && editor.contains(range.startContainer) ? range.getBoundingClientRect() : null
  const rect = caret && caret.height > 0 ? caret : editor.getBoundingClientRect()
  const scrollContainer = scrollContainerFor(editor)
  const viewport = scrollContainer?.getBoundingClientRect()
  const viewportTop = Math.max(viewport?.top ?? 0, pinnedParentsBottom(editor) ?? 0) + margin
  const viewportBottom = (viewport?.bottom ?? window.innerHeight) - margin
  const delta = rect.bottom > viewportBottom ? rect.bottom - viewportBottom
    : rect.top < viewportTop ? rect.top - viewportTop : 0
  if (delta === 0) return
  const zoom = editor.currentCSSZoom || 1
  if (scrollContainer) scrollContainer.scrollBy({ top: delta / zoom })
  else window.scrollBy({ top: delta })
}
