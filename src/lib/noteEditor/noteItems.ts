// Pure helpers shared by the Notes editor adapter, the store, and tests.
// They never touch the DOM except through the sanitizer.

import { createId, escapeHTML, htmlToPlainText, sanitizeInlineHTML } from '../planner'
import type { Id, NoteItem, NoteItemKind } from '../types'

export const NOTE_ITEM_KINDS: readonly NoteItemKind[] = ['paragraph', 'heading', 'quote', 'bullet', 'numbered', 'checklist']

export function isNoteItemKind(value: unknown): value is NoteItemKind {
  return typeof value === 'string' && (NOTE_ITEM_KINDS as readonly string[]).includes(value)
}

// A block as a view layer reports it. `id` is null for a block the view created
// itself (Enter, paste, autoformat) and has not yet been given a stable id.
export type NoteBlock = {
  id: Id | null
  kind: NoteItemKind
  html: string
  done: boolean
  children: NoteBlock[]
}

export function createNoteItemId(): Id {
  return createId('note_item')
}

export function flattenNoteItems(items: NoteItem[]): NoteItem[] {
  return items.flatMap((item) => [item, ...flattenNoteItems(item.children)])
}

export function noteItemById(items: NoteItem[]): Map<Id, NoteItem> {
  return new Map(flattenNoteItems(items).map((item) => [item.id, item]))
}

// Structural equality on the fields the editors own. Unknown fields ride along
// with the previous item object, so they never differ here.
export function noteItemsEqual(a: NoteItem[], b: NoteItem[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index]
    const right = b[index]
    if (left === right) continue
    if (
      left.id !== right.id ||
      left.kind !== right.kind ||
      left.text !== right.text ||
      left.html !== right.html ||
      left.done !== right.done ||
      !noteItemsEqual(left.children, right.children)
    ) return false
  }
  return true
}

export type NoteItemsDiff =
  | { kind: 'none' }
  // Same tree shape; exactly one item changed, and only its text/html.
  | { kind: 'text'; itemId: Id }
  // Same tree shape; only `done` flags changed.
  | { kind: 'done'; itemIds: Id[]; done: boolean }
  // Anything else: kind changes, several items, inserts, removals, moves.
  | { kind: 'structure' }

function shapeSignature(items: NoteItem[]): string {
  return items.map((item) => `${item.id}[${shapeSignature(item.children)}]`).join(',')
}

// Classifies how `next` differs from `previous` so the adapter can choose the
// narrowest store operation (typing coalesces in undo; toggles stay toggles).
export function classifyNoteItemsDiff(previous: NoteItem[], next: NoteItem[]): NoteItemsDiff {
  if (noteItemsEqual(previous, next)) return { kind: 'none' }
  if (shapeSignature(previous) !== shapeSignature(next)) return { kind: 'structure' }

  const before = flattenNoteItems(previous)
  const after = flattenNoteItems(next)
  const textChanged: Id[] = []
  const doneChanged: Id[] = []
  let doneValue: boolean | null = null
  for (let index = 0; index < before.length; index += 1) {
    const left = before[index]
    const right = after[index]
    if (left === right) continue
    if (left.kind !== right.kind) return { kind: 'structure' }
    if (left.text !== right.text || left.html !== right.html) textChanged.push(right.id)
    if (left.done !== right.done) {
      if (doneValue === null) doneValue = right.done
      else if (doneValue !== right.done) return { kind: 'structure' }
      doneChanged.push(right.id)
    }
  }
  if (textChanged.length === 1 && doneChanged.length === 0) return { kind: 'text', itemId: textChanged[0] }
  if (textChanged.length === 0 && doneChanged.length > 0 && doneValue !== null) return { kind: 'done', itemIds: doneChanged, done: doneValue }
  return { kind: 'structure' }
}

// The canonical derivation used by the app: textContent of the sanitized
// HTML, so a <br> contributes no character (internal-link offsets rely on it).
export function noteTextFromHTML(html: string): string {
  return htmlToPlainText(html)
}

// Caret offsets (NoteViewState, NoteEditorCaret) count each <br> as one
// character, unlike `text`. This is the maximum caret offset for an item.
export function noteItemCaretLength(item: Pick<NoteItem, 'text' | 'html'>): number {
  const breaks = item.html ? (item.html.match(/<br\s*\/?>/g)?.length ?? 0) : 0
  return item.text.length + breaks
}

function hasImage(html: string): boolean {
  return html.includes('data-balance-image')
}

// Turns the view's block tree into note items:
//   - sanitizes inline HTML to the app's allowlist and derives `text` from it,
//   - keeps every field of the previous item with the same id (unknown fields
//     from newer clients included) and reuses the previous object when nothing
//     the editor owns changed, so replicated patches stay minimal,
//   - assigns a fresh stable id to any block without one or with a duplicate id
//     and reports those assignments so the view can adopt them.
export type MaterializedNoteItems = {
  items: NoteItem[]
  assignments: Array<{ block: NoteBlock; id: Id }>
}

export function materializeNoteBlocks(blocks: NoteBlock[], previousItems: NoteItem[]): MaterializedNoteItems {
  const previousById = noteItemById(previousItems)
  const seen = new Set<Id>()
  const assignments: Array<{ block: NoteBlock; id: Id }> = []

  const build = (list: NoteBlock[]): NoteItem[] => list.map((block) => {
    let id = block.id
    if (!id || seen.has(id)) {
      id = createNoteItemId()
      assignments.push({ block, id })
    }
    seen.add(id)
    const previous = previousById.get(id)
    const children = build(block.children)
    let html = block.html === previous?.html ? previous.html : sanitizeInlineHTML(block.html)
    let text = html === previous?.html ? previous.text : noteTextFromHTML(html)
    // Whitespace-only blocks (no image) are stored empty.
    if (text.trim() === '' && !hasImage(html)) {
      html = ''
      text = ''
    }
    // `done` only means something on checklists; leave a legacy flag on a
    // non-checklist item alone rather than emitting a spurious change.
    const done = block.kind === 'checklist'
      ? block.done
      : previous && previous.kind === block.kind ? Boolean(previous.done) : false
    if (
      previous &&
      previous.kind === block.kind &&
      previous.html === html &&
      previous.text === text &&
      previous.done === done &&
      (previous.children === children || noteItemsEqual(previous.children, children))
    ) {
      return previous.children === children ? previous : { ...previous, children }
    }
    return {
      ...(previous ?? { startMinutes: null, endMinutes: null }),
      id,
      kind: block.kind,
      text,
      html,
      done,
      children,
    }
  })

  return { items: build(blocks), assignments }
}

// The inverse direction: items as the view should render them. `html` falls
// back to escaped text for legacy items that only carry `text`.
export function noteBlocksFromItems(items: NoteItem[]): NoteBlock[] {
  return items.map((item) => ({
    id: item.id,
    kind: isNoteItemKind(item.kind) ? item.kind : 'paragraph',
    html: item.html || escapeHTML(item.text ?? ''),
    done: Boolean(item.done),
    children: noteBlocksFromItems(item.children ?? []),
  }))
}
