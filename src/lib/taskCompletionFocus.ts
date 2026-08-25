import { tick } from 'svelte'
import type { Id } from './types'

export const TASK_COMPLETION_FOCUS_EVENT = 'balance-task-completion-focus'
export type TaskCaretOffsets = { start: number; end: number }
export type TaskCompletionFocusDetail = {
  containerId: Id
  itemId: Id
  completedItemId?: Id
  completedCaret?: TaskCaretOffsets
}

export async function focusTaskBelow(containerId: Id, completedItemIds: Iterable<Id>): Promise<boolean> {
  const completedIds = new Set(completedItemIds)
  if (completedIds.size === 0) return false
  const completedCaret = caretForLastCompletedTask(containerId, completedIds)

  await tick()

  const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-plan-item-id]')).filter(
    (row) => row.dataset.itemContainerId === containerId,
  )
  let lastCompletedIndex = -1

  for (let index = 0; index < rows.length; index += 1) {
    if (completedIds.has(rows[index].dataset.planItemId ?? '')) lastCompletedIndex = index
  }

  if (lastCompletedIndex === -1) return false

  const targetRow = rows[lastCompletedIndex + 1]
  const target = targetRow?.querySelector<HTMLElement>(
    '[data-plan-text-focus-target], .item-text-display',
  )
  if (!target) return false

  const completedItemId = rows[lastCompletedIndex].dataset.planItemId
  const itemId = targetRow.dataset.planItemId
  if (!completedItemId || !itemId) return false

  focusTaskTarget(target, {
    containerId,
    itemId,
    completedItemId,
    completedCaret: completedCaret?.itemId === completedItemId ? completedCaret.caret : undefined,
  })

  return true
}

export async function focusTaskById(
  containerId: Id,
  itemId: Id,
  caret?: TaskCaretOffsets,
): Promise<boolean> {
  await tick()

  const row = Array.from(document.querySelectorAll<HTMLElement>('[data-plan-item-id]')).find(
    (candidate) => candidate.dataset.itemContainerId === containerId && candidate.dataset.planItemId === itemId,
  )
  const target = row?.querySelector<HTMLElement>('[data-plan-text-focus-target], .item-text-display')
  if (!target) return false

  focusTaskTarget(target, { containerId, itemId }, caret)
  return true
}

function focusTaskTarget(
  target: HTMLElement,
  detail: TaskCompletionFocusDetail,
  caret?: TaskCaretOffsets,
) {
  target.focus()
  if (target.matches('[contenteditable="true"]')) {
    const range = document.createRange()
    if (caret) {
      const start = domPositionForTextOffset(target, caret.start)
      const end = domPositionForTextOffset(target, caret.end)
      range.setStart(start.node, start.offset)
      range.setEnd(end.node, end.offset)
    } else {
      range.selectNodeContents(target)
      range.collapse(false)
    }
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }
  target.dispatchEvent(new CustomEvent<TaskCompletionFocusDetail>(TASK_COMPLETION_FOCUS_EVENT, {
    bubbles: true,
    detail,
  }))
}

function caretForLastCompletedTask(
  containerId: Id,
  completedIds: ReadonlySet<Id>,
): { itemId: Id; caret: TaskCaretOffsets } | null {
  const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-plan-item-id]')).filter(
    (row) => row.dataset.itemContainerId === containerId && completedIds.has(row.dataset.planItemId ?? ''),
  )
  const row = rows.at(-1)
  const itemId = row?.dataset.planItemId
  const target = row?.querySelector<HTMLElement>('[data-plan-text-focus-target], .item-text-display')
  const selection = document.getSelection()
  if (!itemId || !target?.matches('[contenteditable="true"]') || !selection || selection.rangeCount === 0) return null

  const range = selection.getRangeAt(0)
  if (!target.contains(range.startContainer) || !target.contains(range.endContainer)) return null
  return {
    itemId,
    caret: {
      start: textOffsetForBoundary(target, range.startContainer, range.startOffset),
      end: textOffsetForBoundary(target, range.endContainer, range.endOffset),
    },
  }
}

function textOffsetForBoundary(target: HTMLElement, node: Node, offset: number) {
  const range = document.createRange()
  range.selectNodeContents(target)
  range.setEnd(node, offset)
  return range.toString().length
}

function domPositionForTextOffset(target: HTMLElement, offset: number) {
  const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT)
  let remaining = Math.max(0, offset)
  let node = walker.nextNode()

  while (node) {
    const length = node.textContent?.length ?? 0
    if (remaining <= length) return { node, offset: remaining }
    remaining -= length
    node = walker.nextNode()
  }

  return { node: target as Node, offset: target.childNodes.length }
}
