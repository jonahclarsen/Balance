// Project descriptions are edited with the Notes editor but stored as lines of
// text, one per block: list markers and two-space indents spell out the
// structure ("- ", "1. ", "[ ] ", "# ", "> "), so older clients, card previews
// and search keep reading plain text.

import { escapeHTML, htmlToPlainTextWithBreaks, sanitizeInlineHTML } from './planner'
import { createNoteItemId, flattenNoteItems, noteTextFromHTML } from './noteEditor/noteItems'
import type { NoteItem, NoteItemKind } from './types'

export type SerializedDescription = { description: string; descriptionHtml: string }

const INDENT = '  '

export function descriptionFromNoteItems(items: NoteItem[]): SerializedDescription {
  const text: string[] = []
  const html: string[] = []
  const visit = (list: NoteItem[], depth: number) => {
    let number = 0
    for (const item of list) {
      number = item.kind === 'numbered' ? number + 1 : 0
      const prefix = INDENT.repeat(depth) + marker(item, number)
      text.push(prefix + htmlToPlainTextWithBreaks(item.html || escapeHTML(item.text)))
      html.push(escapeHTML(prefix) + (item.html || escapeHTML(item.text)))
      visit(item.children, depth + 1)
    }
  }
  visit(items, 0)
  const description = text.join('\n')
  return { description, descriptionHtml: description.trim() ? html.join('<br>') : '' }
}

function marker(item: NoteItem, number: number): string {
  switch (item.kind) {
    case 'bullet': return '- '
    case 'numbered': return `${number}. `
    case 'checklist': return item.done ? '[x] ' : '[ ] '
    case 'heading': return '# '
    case 'quote': return '> '
    default: return ''
  }
}

const MARKERS: Array<{ pattern: RegExp; kind: NoteItemKind; done?: boolean }> = [
  { pattern: /^[-*•] /, kind: 'bullet' },
  { pattern: /^\d+\. /, kind: 'numbered' },
  { pattern: /^\[ \] /, kind: 'checklist' },
  { pattern: /^\[x\] /i, kind: 'checklist', done: true },
  { pattern: /^# /, kind: 'heading' },
  { pattern: /^> /, kind: 'quote' },
]

// Rebuilds blocks from a stored description. Ids are reused by position from
// `previous` so undo and sync reloads keep the caret in place. Always returns
// at least one block, so the editor is ready to type into.
export function noteItemsFromDescription(description: string, descriptionHtml: string | undefined, previous: NoteItem[] = []): NoteItem[] {
  const lines = descriptionHtml
    ? sanitizeInlineHTML(descriptionHtml).split('<br>').map((line) => sanitizeInlineHTML(line))
    : description.split('\n').map((line) => escapeHTML(line))
  const ids = flattenNoteItems(previous).map((item) => item.id)
  const roots: NoteItem[] = []
  const stack: Array<{ depth: number; item: NoteItem }> = []

  lines.forEach((lineHTML, index) => {
    let html = lineHTML
    let text = noteTextFromHTML(html)
    let depth = 0
    while (text.startsWith(INDENT) && html.startsWith(INDENT)) {
      depth += 1
      text = text.slice(INDENT.length)
      html = html.slice(INDENT.length)
    }
    let kind: NoteItemKind = 'paragraph'
    let done = false
    for (const entry of MARKERS) {
      const match = entry.pattern.exec(text)
      const escaped = match && escapeHTML(match[0])
      if (!escaped || !html.startsWith(escaped)) continue
      kind = entry.kind
      done = Boolean(entry.done)
      html = html.slice(escaped.length)
      text = text.slice(match[0].length)
      break
    }
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop()
    const item: NoteItem = {
      id: ids[index] ?? createNoteItemId(),
      kind,
      text: noteTextFromHTML(html),
      html: text.trim() ? html : '',
      done,
      startMinutes: null,
      endMinutes: null,
      children: [],
    }
    if (!item.html) item.text = ''
    const parent = stack[stack.length - 1]
    if (parent) parent.item.children.push(item)
    else roots.push(item)
    stack.push({ depth, item })
  })
  return roots
}
