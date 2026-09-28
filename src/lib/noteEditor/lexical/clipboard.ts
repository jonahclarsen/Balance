// Notes clipboard formats (contract P-40..P-43), written to the spec.

import { escapeHTML, htmlToPlainTextWithBreaks, sanitizeInlineHTML } from '../../planner'
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

function flattenPasted(blocks: PastedBlock[]): PastedBlock[] {
  return blocks.flatMap((block) => [block, ...flattenPasted(block.children)])
}

function cleanPastedHTML(html: string): string {
  // Block wrappers (<p>, <div>) sanitize to a trailing <br>; drop it.
  return sanitizeInlineHTML(html).replace(/(?:<br>)+$/, '')
}

const CHECK_LINE = /^(\s*)([☐☑])(\s+|$)(.*)$/

function indentWidth(value: string): number {
  let width = 0
  for (const character of value) width += character === '\t' ? 2 : 1
  return width
}

function parseChecklistPlain(plain: string): PastedBlock[] {
  const lines = plain.split(/\r?\n/)
  const roots: PastedBlock[] = []
  const stack: Array<{ indent: number; block: PastedBlock }> = []
  let last: PastedBlock | null = null
  for (const line of lines) {
    const match = CHECK_LINE.exec(line)
    if (!match) {
      if (!line.trim()) continue
      if (!last) return []
      last.html += `<br>${escapeHTML(line.trim())}`
      continue
    }
    const indent = indentWidth(match[1])
    const block: PastedBlock = { kind: 'checklist', html: escapeHTML(match[4]), done: match[2] === CHECKED, children: [] }
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop()
    if (stack.length === 0) roots.push(block)
    else stack[stack.length - 1].block.children.push(block)
    stack.push({ indent, block })
    last = block
  }
  return roots
}

export function parseChecklistClipboard(plain: string, html: string): PastedBlock[] {
  if (html) {
    const parsed = parseClipboardHTML(html)
    const flat = flattenPasted(parsed)
    if (flat.length >= 2 && flat.every((block) => block.kind === 'checklist')) return parsed
  }
  const fromPlain = plain ? parseChecklistPlain(plain) : []
  return countPasted(fromPlain) >= 2 ? fromPlain : []
}

export function parsePlainTextClipboard(plain: string): PastedBlock[] {
  const lines = plain.split(/\r?\n/)
  if (lines.length < 2) return []
  return lines.map((line) => ({ kind: 'paragraph', html: escapeHTML(line), done: false, children: [] }))
}

function listItems(list: Element, kind: 'bullet' | 'numbered'): PastedBlock[] {
  const items: PastedBlock[] = []
  for (const li of Array.from(list.children)) {
    if (li.tagName !== 'LI') continue
    const inline = document.createElement('div')
    const children: PastedBlock[] = []
    for (const node of Array.from(li.childNodes)) {
      if (node instanceof Element && (node.tagName === 'UL' || node.tagName === 'OL')) {
        children.push(...listItems(node, node.tagName === 'OL' ? 'numbered' : 'bullet'))
      } else inline.append(node.cloneNode(true))
    }
    let html = cleanPastedHTML(inline.innerHTML)
    let itemKind: NoteItemKind = kind
    let done = false
    if (kind === 'bullet') {
      const text = (inline.textContent ?? '').trimStart()
      const match = /^([☐☑])\s*/.exec(text)
      if (match) {
        itemKind = 'checklist'
        done = match[1] === CHECKED
        html = removeLeadingMarker(html)
      }
    }
    items.push({ kind: itemKind, html, done, children })
  }
  return items
}

// Strips a leading ☐/☑ marker (and following whitespace) from inline HTML.
function removeLeadingMarker(html: string): string {
  const template = document.createElement('template')
  template.innerHTML = html
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT)
  let removing = true
  for (let node = walker.nextNode(); node && removing; node = walker.nextNode()) {
    const text = node.textContent ?? ''
    const stripped = text.replace(/^\s*[☐☑]?\s*/, '')
    if (/[☐☑]/.test(text.slice(0, text.length - stripped.length)) || text.trim() === '') {
      node.textContent = stripped
      if (stripped) removing = false
    } else removing = false
  }
  return sanitizeInlineHTML(template.innerHTML)
}

export function parseClipboardHTML(html: string): PastedBlock[] {
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  const blocks: PastedBlock[] = []
  for (const element of Array.from(parsed.body.children)) {
    const tag = element.tagName
    if (tag === 'UL') blocks.push(...listItems(element, 'bullet'))
    else if (tag === 'OL') blocks.push(...listItems(element, 'numbered'))
    else if (tag === 'P' || tag === 'DIV') blocks.push({ kind: 'paragraph', html: cleanPastedHTML(element.innerHTML), done: false, children: [] })
    else if (/^H[1-6]$/.test(tag)) blocks.push({ kind: 'heading', html: cleanPastedHTML(element.innerHTML), done: false, children: [] })
    else if (tag === 'BLOCKQUOTE') blocks.push({ kind: 'quote', html: cleanPastedHTML(element.innerHTML), done: false, children: [] })
  }
  return countPasted(blocks) >= 2 ? blocks : []
}
