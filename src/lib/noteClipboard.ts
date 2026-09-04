import { escapeHTML, htmlToPlainText, sanitizeInlineHTML } from './planner'
import type { NoteItemKind } from './types'

export type NoteClipboardBlock = {
  kind: NoteItemKind
  depth: number
  html: string
  text: string
  done: boolean
  number: number
}

type NoteClipboardNode = NoteClipboardBlock & {
  children: NoteClipboardNode[]
}

export type ParsedNoteClipboardItem = {
  kind: NoteItemKind
  html: string
  text: string
  done: boolean
  children: ParsedNoteClipboardItem[]
}

export function noteClipboardPlainText(blocks: NoteClipboardBlock[]): string {
  if (blocks.length === 0) return ''

  const baseDepth = Math.min(...blocks.map((block) => block.depth))
  return blocks.map((block) => {
    const indent = '  '.repeat(Math.max(0, block.depth - baseDepth))
    const marker = plainTextMarker(block)
    const continuationIndent = `${indent}${' '.repeat(marker.length)}`
    const text = block.text.replace(/\r?\n/g, `\n${continuationIndent}`)
    return `${indent}${marker}${text}`
  }).join('\n')
}

export function noteClipboardHTML(blocks: NoteClipboardBlock[]): string {
  return renderNodes(buildForest(blocks))
}

export function parseNoteClipboardHTML(html: string): ParsedNoteClipboardItem[] {
  if (!html.trim() || typeof DOMParser === 'undefined') return []

  const document = new DOMParser().parseFromString(html, 'text/html')
  return parseClipboardContainer(document.body)
}

export function parseNoteChecklistClipboard(plainText: string, html: string): ParsedNoteClipboardItem[] {
  const htmlItems = parseNoteClipboardHTML(html)
  const flattenedHTMLItems = flattenParsedItems(htmlItems)
  if (flattenedHTMLItems.length >= 2 && flattenedHTMLItems.every((item) => item.kind === 'checklist')) {
    return htmlItems
  }

  const roots: ParsedNoteClipboardItem[] = []
  const stack: { depth: number; item: ParsedNoteClipboardItem }[] = []
  let current: ParsedNoteClipboardItem | null = null

  for (const line of plainText.split(/\r?\n/)) {
    const match = line.match(/^(\s*)([☐☑])(?:\s+|$)(.*)$/)
    if (!match) {
      if (current && line.trim()) {
        const continuation = line.trimStart()
        current.html += `<br>${escapeHTML(continuation)}`
        current.text += `\n${continuation}`
      }
      continue
    }

    const depth = indentationWidth(match[1])
    const text = match[3]
    const item: ParsedNoteClipboardItem = {
      kind: 'checklist',
      html: escapeHTML(text),
      text,
      done: match[2] === '☑',
      children: [],
    }
    while (stack.length > 0 && stack[stack.length - 1].depth >= depth) stack.pop()
    const parent = stack[stack.length - 1]
    if (parent) parent.item.children.push(item)
    else roots.push(item)
    stack.push({ depth, item })
    current = item
  }

  return flattenParsedItems(roots).length >= 2 ? roots : []
}

export function parseNotePlainTextClipboard(plainText: string): ParsedNoteClipboardItem[] {
  const lines = plainText.split(/\r?\n/)
  if (lines.length < 2) return []
  return lines.map((text) => ({
    kind: 'paragraph',
    html: escapeHTML(text),
    text,
    done: false,
    children: [],
  }))
}

function flattenParsedItems(items: ParsedNoteClipboardItem[]): ParsedNoteClipboardItem[] {
  return items.flatMap((item) => [item, ...flattenParsedItems(item.children)])
}

function indentationWidth(indentation: string) {
  return Array.from(indentation).reduce((width, character) => width + (character === '\t' ? 2 : 1), 0)
}

function parseClipboardContainer(container: Element): ParsedNoteClipboardItem[] {
  return Array.from(container.children).flatMap((element) => {
    if (element.matches('ul, ol')) return parseClipboardList(element)
    if (!element.matches('p, div, h1, h2, h3, h4, h5, h6')) return []

    const html = sanitizeInlineHTML(element.innerHTML)
    return [{
      kind: element.matches('h1, h2, h3, h4, h5, h6') ? 'heading' : 'paragraph',
      html,
      text: htmlToPlainText(html),
      done: false,
      children: [],
    } satisfies ParsedNoteClipboardItem]
  })
}

function parseClipboardList(list: Element): ParsedNoteClipboardItem[] {
  return Array.from(list.children)
    .filter((element) => element.matches('li'))
    .map((element) => {
      const nestedLists = Array.from(element.children).filter((child) => child.matches('ul, ol'))
      const inline = element.cloneNode(true) as HTMLElement
      Array.from(inline.children).filter((child) => child.matches('ul, ol')).forEach((child) => child.remove())

      let kind: NoteItemKind = list.matches('ol') ? 'numbered' : 'bullet'
      let done = false
      if (list.matches('ul')) {
        const walker = document.createTreeWalker(inline, NodeFilter.SHOW_TEXT)
        const firstText = walker.nextNode() as Text | null
        const checkbox = firstText?.data.match(/^([☐☑])\s*/)
        if (firstText && checkbox) {
          kind = 'checklist'
          done = checkbox[1] === '☑'
          firstText.data = firstText.data.slice(checkbox[0].length)
        }
      }

      const html = sanitizeInlineHTML(inline.innerHTML)
      return {
        kind,
        html,
        text: htmlToPlainText(html),
        done,
        children: nestedLists.flatMap(parseClipboardList),
      }
    })
}

function plainTextMarker(block: NoteClipboardBlock): string {
  if (block.kind === 'bullet') return '- '
  if (block.kind === 'numbered') return `${block.number}. `
  if (block.kind === 'checklist') return `${block.done ? '☑' : '☐'} `
  return ''
}

function buildForest(blocks: NoteClipboardBlock[]): NoteClipboardNode[] {
  const forest: NoteClipboardNode[] = []
  const stack: NoteClipboardNode[] = []

  for (const block of blocks) {
    const node: NoteClipboardNode = { ...block, children: [] }
    while (stack.length > 0 && stack[stack.length - 1].depth >= block.depth) stack.pop()

    const parent = stack[stack.length - 1]
    if (parent) parent.children.push(node)
    else forest.push(node)
    stack.push(node)
  }

  return forest
}

function renderNodes(nodes: NoteClipboardNode[]): string {
  let result = ''
  let index = 0

  while (index < nodes.length) {
    const node = nodes[index]
    const listTag = htmlListTag(node.kind)
    if (listTag) {
      const listNodes: NoteClipboardNode[] = []
      while (index < nodes.length && htmlListTag(nodes[index].kind) === listTag) {
        listNodes.push(nodes[index])
        index += 1
      }
      result += `<${listTag}>${listNodes.map(renderListItem).join('')}</${listTag}>`
      continue
    }

    const tag = node.kind === 'heading' ? 'h1' : 'p'
    result += `<${tag}>${clipboardInlineHTML(node.html) || '<br>'}</${tag}>`
    if (node.children.length > 0) result += renderNodes(node.children)
    index += 1
  }

  return result
}

function renderListItem(node: NoteClipboardNode): string {
  const checkbox = node.kind === 'checklist' ? `${node.done ? '☑' : '☐'} ` : ''
  const children = node.children.length > 0 ? renderNodes(node.children) : ''
  return `<li>${checkbox}${clipboardInlineHTML(node.html)}${children}</li>`
}

function clipboardInlineHTML(html: string): string {
  // Notion represents soft line breaks as literal newlines in its HTML
  // clipboard flavor and drops <br> elements when importing external HTML.
  return html.replace(/<br>/g, '\n')
}

function htmlListTag(kind: NoteItemKind): 'ul' | 'ol' | null {
  if (kind === 'numbered') return 'ol'
  if (kind === 'bullet' || kind === 'checklist') return 'ul'
  return null
}
