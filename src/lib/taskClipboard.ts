import { createListTemplateItem, createTemplateItem, escapeHTML, htmlToPlainText, sanitizeInlineHTML } from './planner'
import type { ListTemplateItem, NoteItemKind, PlanItem, TemplateItem } from './types'

// A marked block avoids interpreting ordinary multiline prose as planner rows.
// Newlines inside a task stay real newlines (continuation lines indented past
// the "- " marker) so the text reads naturally wherever it is pasted.
// Backslash escapes keep literal brackets and tabs unambiguous.
function escapeText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\r/g, '').replace(/\t/g, '\\t').replace(/([\[\]])/g, '\\$1')
}

function taskLine(item: PlanItem): string {
  if (!item.html || !globalThis.document) return escapeText(item.text)
  const template = document.createElement('template')
  template.innerHTML = sanitizeInlineHTML(item.html)
  function render(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return escapeText(node.textContent ?? '')
    if (node.nodeType !== Node.ELEMENT_NODE) return ''
    const element = node as HTMLElement
    if (element.tagName === 'BR') return '\n'
    const label = Array.from(element.childNodes).map(render).join('')
    if (element.tagName !== 'A') return label
    const href = (element.getAttribute('href') ?? '').replace(/[\\()\s]/g, (char) => encodeURIComponent(char).replace('(', '%28').replace(')', '%29'))
    return `[${label}](${href})`
  }
  return Array.from(template.content.childNodes).map(render).join('')
}

export function planItemsClipboardText(items: PlanItem[], portable = false): string {
  const lines: string[] = []
  function visit(nodes: PlanItem[], depth: number) {
    for (const item of nodes) {
      if (!portable) {
        lines.push(`${'  '.repeat(depth)}${item.text}`)
      } else {
        const marker = `${'  '.repeat(depth)}- `
        const continuation = ' '.repeat(marker.length)
        taskLine(item).split('\n').forEach((line, index) => lines.push(`${index === 0 ? marker : continuation}${line}`))
      }
      visit(item.children, depth + 1)
    }
  }
  visit(items, 0)
  return portable ? `<balance>\n${lines.join('\n')}\n</balance>` : lines.join('\n')
}

function decodeText(text: string): string {
  return text.replace(/\\([\\nt\[\]])/g, (_, char: string) => char === 'n' ? '\n' : char === 't' ? '\t' : char)
}

function lineHTML(text: string): string {
  const links = /\[((?:\\.|[^\]\\])*)\]\(([^\s()]*)\)/g
  let html = ''
  let offset = 0
  const plain = (value: string) => escapeHTML(decodeText(value)).replace(/\n/g, '<br>')
  for (const match of text.matchAll(links)) {
    // Escaped brackets belong to literal task text, not link syntax.
    const precedingSlashes = text.slice(0, match.index).match(/\\+$/)?.[0].length ?? 0
    if (precedingSlashes % 2) continue
    html += plain(text.slice(offset, match.index))
    html += `<a href="${escapeHTML(match[2]!)}">${plain(match[1]!)}</a>`
    offset = match.index! + match[0].length
  }
  return sanitizeInlineHTML(html + plain(text.slice(offset)))
}

export function parsePlainTaskClipboard(raw: string | null): PlanItem[] | null {
  if (!raw) return null
  const lines = raw.trim().replace(/\r\n?/g, '\n').split('\n')
  if (lines.shift()?.trim() !== '<balance>' || lines.pop()?.trim() !== '</balance>') return null
  type Row = { indent: number; lines: string[]; children: Row[] }
  const roots: Row[] = []
  const ancestors: Row[] = []
  let baseIndent: number | null = null
  for (const line of lines) {
    const match = /^([ \t]*)(.*)$/.exec(line)!
    const indent = match[1]!.replace(/\t/g, '  ').length
    const task = /^-(?: |$)(.*)$/.exec(match[2]!)
    const current = ancestors.at(-1)
    if (!task && current) {
      // A line without a marker continues the task above it; its indentation
      // matches the marker width, so strip at most that much.
      current.lines.push(line.replace(new RegExp(`^[ \\t]{0,${current.indent + 2}}`), ''))
      continue
    }
    if (!line.trim()) continue
    baseIndent ??= indent
    if (indent < baseIndent) return null
    const row: Row = { indent, lines: [task ? task[1]! : match[2]!], children: [] }
    while (ancestors.length && ancestors.at(-1)!.indent >= indent) ancestors.pop()
    const parent = ancestors.at(-1)
    ;(parent ? parent.children : roots).push(row)
    ancestors.push(row)
  }
  const build = (row: Row): PlanItem => {
    const content = row.lines
    while (content.length > 1 && !content.at(-1)!.trim()) content.pop()
    const html = lineHTML(content.join('\n'))
    return {
      id: crypto.randomUUID(), text: htmlToPlainText(html), html,
      done: false, startMinutes: null, endMinutes: null, children: row.children.map(build),
    }
  }
  return roots.length ? roots.map(build) : null
}

export type TaskNoteBlock = { kind: NoteItemKind; html: string; text: string; done: boolean; children: TaskNoteBlock[] }

// Tasks pasted into a note become one bulleted item per task, nested the same way.
export function parseTaskClipboardAsNoteBlocks(raw: string | null): TaskNoteBlock[] | null {
  const items = parsePlainTaskClipboard(raw)
  if (!items) return null
  const convert = (nodes: PlanItem[]): TaskNoteBlock[] =>
    nodes.map((item) => ({ kind: 'bullet', html: item.html, text: item.text, done: false, children: convert(item.children) }))
  return convert(items)
}

const BLOCK_TAGS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'LI', 'UL', 'OL', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'NAV', 'DL', 'DT', 'DD', 'FIGURE', 'FIGCAPTION', 'HR', 'FORM', 'FIELDSET', 'ADDRESS'])
const SKIPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'META', 'LINK', 'TITLE', 'HEAD', 'TEMPLATE', 'NOSCRIPT'])

// Block-structured HTML (a bulleted list copied from Notes, paragraphs from a
// web page) pasted into a single task keeps its line breaks and list markers
// as inline content, the way the plain-text rendering would read. Returns
// null when the HTML is already inline so callers keep their usual path.
export function flattenClipboardHTML(html: string): string | null {
  if (!html.trim() || typeof DOMParser === 'undefined') return null
  const body = new DOMParser().parseFromString(html, 'text/html').body
  if (!body.querySelector('p,div,h1,h2,h3,h4,h5,h6,blockquote,pre,li,ul,ol,table,tr,hr,dl')) return null
  let out = ''
  let atLineStart = true
  const breakLine = () => {
    if (atLineStart) return
    out += '<br>'
    atLineStart = true
  }
  const append = (markup: string) => {
    if (!markup) return
    out += markup
    atLineStart = false
  }
  const visit = (node: Node, depth: number) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent ?? '').replace(/\r\n?/g, '\n')
      if (!text.trim()) {
        if (!text.includes('\n') && !atLineStart) append(' ')
        return
      }
      text.split('\n').forEach((segment, index) => {
        if (index > 0) { out += '<br>'; atLineStart = true }
        append(escapeHTML(segment))
      })
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const element = node as Element
    const tag = element.tagName
    if (SKIPPED_TAGS.has(tag)) return
    if (tag === 'BR') {
      out += '<br>'
      atLineStart = true
      return
    }
    if (tag === 'IMG') {
      append(element.outerHTML)
      return
    }
    if (tag === 'UL' || tag === 'OL') {
      breakLine()
      let number = 0
      for (const child of Array.from(element.children)) {
        if (child.tagName !== 'LI') { visit(child, depth); continue }
        number += 1
        breakLine()
        const text = (child.textContent ?? '').trimStart()
        const marker = /^[☐☑]/.test(text) ? '' : tag === 'OL' ? `${number}. ` : '- '
        append(`${'  '.repeat(depth)}${marker}`)
        for (const grandchild of Array.from(child.childNodes)) visit(grandchild, depth + 1)
        breakLine()
      }
      return
    }
    if (tag === 'TD' || tag === 'TH') {
      if (!atLineStart) append('\t')
      for (const child of Array.from(element.childNodes)) visit(child, depth)
      return
    }
    if (BLOCK_TAGS.has(tag)) {
      breakLine()
      for (const child of Array.from(element.childNodes)) visit(child, depth)
      breakLine()
      return
    }
    const shell = element.cloneNode(false) as Element
    shell.textContent = ''
    const outer = shell.outerHTML
    const close = `</${tag.toLowerCase()}>`
    const open = outer.endsWith(close) ? outer.slice(0, -close.length) : outer
    out += open
    for (const child of Array.from(element.childNodes)) visit(child, depth)
    if (outer.endsWith(close)) out += close
  }
  for (const child of Array.from(body.childNodes)) visit(child, 0)
  return out.replace(/^(?:<br>)+/, '').replace(/(?:<br>)+$/, '')
}

// Tasks copied from Today paste into templates as always-included rows. Store
// pastes assign fresh ids, so only the content and hierarchy matter here.
export function planItemsToTemplateItems(items: PlanItem[]): TemplateItem[] {
  return items.map((item) => {
    const templateItem = createTemplateItem()
    Object.assign(templateItem.options[0]!, { text: item.text, html: item.html })
    return {
      ...templateItem, startMinutes: item.startMinutes, endMinutes: item.endMinutes,
      ...(item.timeHidden ? { timeHidden: true } : {}), children: planItemsToTemplateItems(item.children),
    }
  })
}

export function planItemsToListTemplateItems(items: PlanItem[]): ListTemplateItem[] {
  return items.map((item) => ({
    ...createListTemplateItem(), text: item.text, html: item.html, children: planItemsToListTemplateItems(item.children),
  }))
}

// List rows have one choice; day alternatives become individual list rows.
export function templateItemsToListTemplateItems(items: TemplateItem[]): ListTemplateItem[] {
  return items.flatMap((item) => item.options.map((option) => ({
    ...createListTemplateItem(), text: option.text, html: option.html,
    probability: option.probability, children: templateItemsToListTemplateItems(item.children),
  })))
}

export function listTemplateItemsToTemplateItems(items: ListTemplateItem[]): TemplateItem[] {
  return items.map((item) => {
    const row = createTemplateItem()
    Object.assign(row.options[0]!, { text: item.text, html: item.html, probability: item.probability })
    return { ...row, children: listTemplateItemsToTemplateItems(item.children) }
  })
}
