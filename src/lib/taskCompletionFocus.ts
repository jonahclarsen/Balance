import { tick } from 'svelte'
import type { Id } from './types'

export const TASK_COMPLETION_FOCUS_EVENT = 'balance-task-completion-focus'

export async function focusTaskBelow(containerId: Id, completedItemIds: Iterable<Id>): Promise<boolean> {
  const completedIds = new Set(completedItemIds)
  if (completedIds.size === 0) return false

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

  target.focus()
  if (target.matches('[contenteditable="true"]')) {
    const range = document.createRange()
    range.selectNodeContents(target)
    range.collapse(false)
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }
  target.dispatchEvent(new CustomEvent(TASK_COMPLETION_FOCUS_EVENT, {
    bubbles: true,
    detail: { itemId: targetRow.dataset.planItemId },
  }))

  return true
}
