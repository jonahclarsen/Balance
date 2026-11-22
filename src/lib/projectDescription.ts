// Project descriptions are edited with the Notes editor but stored as lines of
// text, one per block: list markers and two-space indents spell out the
// structure ("- ", "1. ", "[ ] ", "# ", "> "), so older clients, card previews
// and search keep reading plain text. A line break inside a list item (Shift+
// Enter) continues on a line indented to the item's text, as in Markdown.

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
      const continuation = INDENT.repeat(depth) + ' '.repeat(prefix.length - INDENT.length * depth)
      const itemHTML = item.html || escapeHTML(item.text)
      htmlToPlainTextWithBreaks(itemHTML).split('\n').forEach((line, index) => text.push((index ? continuation : prefix) + line))
      itemHTML.split('<br>').forEach((line, index) => html.push(escapeHTML(index ? continuation : prefix) + line))
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
  // The last list item and the column its text starts at, for continuations.
  let last: { item: NoteItem; column: number } | null = null

  for (const lineHTML of lines) {
    let html = lineHTML
    let text = noteTextFromHTML(html)
    let spaces = 0
    while (text[spaces] === ' ' && html[spaces] === ' ') spaces += 1
    text = text.slice(spaces)
    html = html.slice(spaces)
    const depth = Math.floor(spaces / INDENT.length)
    let kind: NoteItemKind = 'paragraph'
    let done = false
    let markerLength = 0
    for (const entry of MARKERS) {
      const match = entry.pattern.exec(text)
      const escaped = match && escapeHTML(match[0])
      if (!escaped || !html.startsWith(escaped)) continue
      kind = entry.kind
      done = Boolean(entry.done)
      html = html.slice(escaped.length)
      text = text.slice(match[0].length)
      markerLength = match[0].length
      break
    }
    if (kind === 'paragraph' && last && spaces === last.column) {
      last.item.html = `${last.item.html}<br>${html}`
      last.item.text = noteTextFromHTML(last.item.html)
      continue
    }
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop()
    const item: NoteItem = {
      id: ids.shift() ?? createNoteItemId(),
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
    last = markerLength ? { item, column: depth * INDENT.length + markerLength } : null
  }
  return roots
}
