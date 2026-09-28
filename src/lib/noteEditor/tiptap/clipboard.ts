// Notes clipboard formats (contract P-40 … P-45), written to the spec.

import { escapeHTML, htmlToPlainTextWithBreaks, sanitizeInlineHTML } from '../../planner'
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

function allChecklists(items: ParsedClipboardItem[]): boolean {
  return items.every((item) => item.kind === 'checklist' && allChecklists(item.children))
}

// Checklist rows copied as text (☐ / ☑ lines, indented children).
export function parseChecklistClipboard(plain: string, html: string): ParsedClipboardItem[] | null {
  if (html) {
    const fromHTML = parseHTMLClipboard(html)
    if (fromHTML && allChecklists(fromHTML)) return fromHTML
  }
  if (!plain) return null
  const roots: ParsedClipboardItem[] = []
  const stack: Array<{ depth: number; item: ParsedClipboardItem }> = []
  let current: ParsedClipboardItem | null = null
  for (const line of plain.split(/\r?\n/)) {
    const match = /^(\s*)([☐☑])(\s+|$)(.*)$/.exec(line)
    if (match) {
      const depth = match[1].replace(/\t/g, '  ').length
      const item: ParsedClipboardItem = { kind: 'checklist', html: escapeHTML(match[4]), done: match[2] === '☑', children: [] }
      while (stack.length > 0 && stack[stack.length - 1].depth >= depth) stack.pop()
      if (stack.length === 0) roots.push(item)
      else stack[stack.length - 1].item.children.push(item)
      stack.push({ depth, item })
      current = item
    } else if (line.trim()) {
      if (!current) return null
      current.html += `<br>${escapeHTML(line.trim())}`
    }
  }
  return countItems(roots) >= 2 ? roots : null
}

// Multi-line plain text: every line becomes a paragraph.
export function parsePlainTextClipboard(plain: string): ParsedClipboardItem[] | null {
  const lines = plain.split(/\r?\n/)
  if (lines.length < 2) return null
  return lines.map((line) => ({ kind: 'paragraph', html: escapeHTML(line), done: false, children: [] }))
}

function stripCheckMarker(html: string): { html: string; done: boolean } | null {
  const match = /^((?:<[^>]+>)*)([☐☑])\s*/.exec(html)
  if (!match) return null
  return { html: match[1] + html.slice(match[0].length), done: match[2] === '☑' }
}

function listItems(list: Element, ordered: boolean): ParsedClipboardItem[] {
  const items: ParsedClipboardItem[] = []
  for (const li of Array.from(list.children)) {
    if (li.tagName !== 'LI') continue
    const clone = li.cloneNode(true) as Element
    const nested: ParsedClipboardItem[] = []
    for (const child of Array.from(clone.children)) {
      if (child.tagName === 'UL' || child.tagName === 'OL') {
        nested.push(...listItems(child, child.tagName === 'OL'))
        child.remove()
      }
    }
    let html = sanitizeInlineHTML(clone.innerHTML)
    let kind: NoteItemKind = ordered ? 'numbered' : 'bullet'
    let done = false
    if (!ordered) {
      const checked = stripCheckMarker(html)
      if (checked) {
        kind = 'checklist'
        html = checked.html
        done = checked.done
      }
    }
    items.push({ kind, html, done, children: nested })
  }
  return items
}

export function parseHTMLClipboard(html: string): ParsedClipboardItem[] | null {
  const template = document.createElement('template')
  template.innerHTML = html
  const items: ParsedClipboardItem[] = []
  for (const node of Array.from(template.content.children)) {
    const tag = node.tagName
    if (tag === 'UL' || tag === 'OL') items.push(...listItems(node, tag === 'OL'))
    else if (tag === 'P' || tag === 'DIV') items.push({ kind: 'paragraph', html: sanitizeInlineHTML(node.innerHTML), done: false, children: [] })
    else if (/^H[1-6]$/.test(tag)) items.push({ kind: 'heading', html: sanitizeInlineHTML(node.innerHTML), done: false, children: [] })
    else if (tag === 'BLOCKQUOTE') items.push({ kind: 'quote', html: sanitizeInlineHTML(node.innerHTML), done: false, children: [] })
  }
  return countItems(items) >= 2 ? items : null
}

export function parseNoteClipboard(plain: string, html: string): ParsedClipboardItem[] | null {
  const checklist = parseChecklistClipboard(plain, html)
  if (checklist) return checklist
  if (!html) return parsePlainTextClipboard(plain)
  return parseHTMLClipboard(html)
}
