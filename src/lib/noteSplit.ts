import type { Id } from './types'

export const NOTE_DRAG_TYPE = 'application/x-balance-note'

export type NoteSplitSide = 'left' | 'right'
export type NoteSplit = { noteId: Id; side: NoteSplitSide } | null

/** Which side of the notes area a drop at `clientX` lands on. */
export function noteSplitSideAt(clientX: number, rect: Pick<DOMRect, 'left' | 'width'>): NoteSplitSide {
  return clientX < rect.left + rect.width / 2 ? 'left' : 'right'
}

/**
 * Shows `droppedId` on `side`. The primary pane keeps the other side; a note
 * already open in the other pane swaps places instead of opening twice.
 */
export function dropNoteIntoSplit(primaryId: Id, split: NoteSplit, droppedId: Id, side: NoteSplitSide): { primaryId: Id; split: NoteSplit } {
  if (!split) {
    if (droppedId === primaryId) return { primaryId, split }
    return { primaryId, split: { noteId: droppedId, side } }
  }
  if (side === split.side) {
    if (droppedId === primaryId) return { primaryId: split.noteId, split: { ...split, noteId: primaryId } }
    return { primaryId, split: { ...split, noteId: droppedId } }
  }
  if (droppedId === split.noteId) return { primaryId: split.noteId, split: { ...split, noteId: primaryId } }
  return { primaryId: droppedId, split }
}
