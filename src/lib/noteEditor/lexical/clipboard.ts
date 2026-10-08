import { parseNoteClipboardHTML, parseNoteChecklistClipboard } from '../../noteClipboard'
// Notes clipboard formats (contract P-40..P-43), written to the spec.

import { escapeHTML, htmlToPlainTextWithBreaks } from '../../planner'
import type { NoteItemKind } from '../../types'

export type ClipboardBlock = {
  kind: NoteItemKind
  depth: number
  html: string
  done: boolean
  number: number | null
}

export type PastedBlock = {
  kind: NoteItemKind
  html: string
  done: boolean
  children: PastedBlock[]
}

const CHECKED = '☑'
const UNCHECKED = '☐'

function marker(block: ClipboardBlock): string {
  switch (block.kind) {
    case 'quote': return '> '
    case 'bullet': return '- '
    case 'numbered': return `${block.number ?? 1}. `
    case 'checklist': return `${block.done ? CHECKED : UNCHECKED} `
    default: return ''
  }
}

export function clipboardPlainText(blocks: ClipboardBlock[]): string {
  if (blocks.length === 0) return ''
  const base = Math.min(...blocks.map((block) => block.depth))
  return blocks.map((block) => {
    const indent = '  '.repeat(Math.max(0, block.depth - base))
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

function inlineForClipboard(html: string): string {
  // Notion drops <br> from external HTML; a literal newline survives.
  return html.replace(/<br\s*\/?>/g, '\n')
}

function renderTrees(trees: Tree[]): string {
  let html = ''
  let index = 0
  while (index < trees.length) {
    const tag = listTag(trees[index].block.kind)
    if (tag) {
      html += `<${tag}>`
      while (index < trees.length && listTag(trees[index].block.kind) === tag) {
        const { block, children } = trees[index]
        const check = block.kind === 'checklist' ? `${block.done ? CHECKED : UNCHECKED} ` : ''
        html += `<li>${check}${inlineForClipboard(block.html)}${renderTrees(children)}</li>`
        index += 1
      }
      html += `</${tag}>`
      continue
    }
    const { block, children } = trees[index]
    const inner = inlineForClipboard(block.html) || '<br>'
    const element = block.kind === 'heading' ? 'h1' : block.kind === 'quote' ? 'blockquote' : 'p'
    html += `<${element}>${inner}</${element}>${renderTrees(children)}`
    index += 1
  }
  return html
}

export function clipboardHTML(blocks: ClipboardBlock[]): string {
  const base = blocks.length > 0 ? Math.min(...blocks.map((block) => block.depth)) : 0
  return renderTrees(forest(blocks.map((block) => ({ ...block, depth: block.depth - base }))))
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export function countPasted(blocks: PastedBlock[]): number {
  return blocks.reduce((sum, block) => sum + 1 + countPasted(block.children), 0)
}

export function parseChecklistClipboard(plain: string, html: string): PastedBlock[] {
  return parseNoteChecklistClipboard(plain, html)
}

export function parsePlainTextClipboard(plain: string): PastedBlock[] {
  const lines = plain.split(/\r?\n/)
  if (lines.length < 2) return []
  return lines.map((line) => ({ kind: 'paragraph', html: escapeHTML(line), done: false, children: [] }))
}

export function parseClipboardHTML(html: string): PastedBlock[] {
  const items = parseNoteClipboardHTML(html)
  return countPasted(items) >= 2 || (items.length === 1 && items[0].kind !== 'paragraph') ? items : []
}
