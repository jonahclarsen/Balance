import { parseNoteClipboardHTML, parseNoteChecklistClipboard } from '../../noteClipboard'
// Notes clipboard formats (contract P-40 … P-45), written to the spec.

import { escapeHTML, htmlToPlainTextWithBreaks } from '../../planner'
import type { NoteItemKind } from '../../types'

export type ClipboardBlock = {
  kind: NoteItemKind
  depth: number
  html: string
  done: boolean
  number: number | null
}

export type ParsedClipboardItem = {
  kind: NoteItemKind
  html: string
  done: boolean
  children: ParsedClipboardItem[]
}

function marker(block: ClipboardBlock): string {
  switch (block.kind) {
    case 'quote': return '> '
    case 'bullet': return '- '
    case 'numbered': return `${block.number ?? 1}. `
    case 'checklist': return block.done ? '☑ ' : '☐ '
    default: return ''
  }
}

export function clipboardPlainText(blocks: ClipboardBlock[]): string {
  const minDepth = Math.min(...blocks.map((block) => block.depth))
  return blocks.map((block) => {
    const indent = '  '.repeat(Math.max(0, block.depth - minDepth))
    const prefix = marker(block)
    const lines = htmlToPlainTextWithBreaks(block.html).split('\n')
    return lines.map((line, index) => index === 0 ? `${indent}${prefix}${line}` : `${indent}${' '.repeat(prefix.length)}${line}`).join('\n')
  }).join('\n')
}

type Tree = { block: ClipboardBlock; children: Tree[] }

function forest(blocks: ClipboardBlock[]): Tree[] {
  const roots: Tree[] = []
  const stack: Tree[] = []
  for (const block of blocks) {
    const node: Tree = { block, children: [] }
    while (stack.length > 0 && stack[stack.length - 1].block.depth >= block.depth) stack.pop()
    if (stack.length === 0) roots.push(node)
    else stack[stack.length - 1].children.push(node)
    stack.push(node)
  }
  return roots
}

function listTag(kind: NoteItemKind): 'ul' | 'ol' | null {
  if (kind === 'bullet' || kind === 'checklist') return 'ul'
  if (kind === 'numbered') return 'ol'
  return null
}

function inline(html: string): string {
  return html.replace(/<br>/g, '\n')
}

function renderForest(nodes: Tree[]): string {
  let html = ''
  let index = 0
  while (index < nodes.length) {
    const tag = listTag(nodes[index].block.kind)
    if (tag) {
      let items = ''
      while (index < nodes.length && listTag(nodes[index].block.kind) === tag) {
        const { block, children } = nodes[index]
        const check = block.kind === 'checklist' ? (block.done ? '☑ ' : '☐ ') : ''
        items += `<li>${check}${inline(block.html) || (check ? '' : '<br>')}${children.length > 0 ? renderForest(children) : ''}</li>`
        index += 1
      }
      html += `<${tag}>${items}</${tag}>`
      continue
    }
    const { block, children } = nodes[index]
    const blockTag = block.kind === 'heading' ? 'h1' : block.kind === 'quote' ? 'blockquote' : 'p'
    html += `<${blockTag}>${inline(block.html) || '<br>'}</${blockTag}>${renderForest(children)}`
    index += 1
  }
  return html
}

export function clipboardHTML(blocks: ClipboardBlock[]): string {
  const minDepth = Math.min(...blocks.map((block) => block.depth))
  return renderForest(forest(blocks.map((block) => ({ ...block, depth: block.depth - minDepth }))))
}

function countItems(items: ParsedClipboardItem[]): number {
  return items.reduce((sum, item) => sum + 1 + countItems(item.children), 0)
}

// Checklist rows copied as text (☐ / ☑ lines, indented children).
export function parseChecklistClipboard(plain: string, html: string): ParsedClipboardItem[] | null {
  const items = parseNoteChecklistClipboard(plain, html)
  return countItems(items) >= 2 || (items.length === 1 && items[0].kind !== 'paragraph') ? items : null
}

// Multi-line plain text: every line becomes a paragraph.
export function parsePlainTextClipboard(plain: string): ParsedClipboardItem[] | null {
  const lines = plain.split(/\r?\n/)
  if (lines.length < 2) return null
  return lines.map((line) => ({ kind: 'paragraph', html: escapeHTML(line), done: false, children: [] }))
}

export function parseHTMLClipboard(html: string): ParsedClipboardItem[] | null {
  const items = parseNoteClipboardHTML(html)
  return countItems(items) >= 2 || (items.length === 1 && items[0].kind !== 'paragraph') ? items : null
}

export function parseNoteClipboard(plain: string, html: string): ParsedClipboardItem[] | null {
  const checklist = parseChecklistClipboard(plain, html)
  if (checklist) return checklist
  if (!html) return parsePlainTextClipboard(plain)
  return parseHTMLClipboard(html)
}
