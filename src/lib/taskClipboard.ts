import { escapeHTML, htmlToPlainText, sanitizeInlineHTML } from './planner'
import type { PlanItem } from './types'

// A marked block avoids interpreting ordinary multiline prose as planner rows.
// Backslash escapes keep multiline tasks and literal Markdown unambiguous.
function escapeText(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '').replace(/\t/g, '\\t').replace(/([\[\]])/g, '\\$1')
}

function taskLine(item: PlanItem): string {
  if (!item.html || !globalThis.document) return escapeText(item.text)
  const template = document.createElement('template')
  template.innerHTML = sanitizeInlineHTML(item.html)
  function render(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return escapeText(node.textContent ?? '')
    if (node.nodeType !== Node.ELEMENT_NODE) return ''
    const element = node as HTMLElement
    if (element.tagName === 'BR') return '\\n'
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
      lines.push(`${'  '.repeat(depth)}${portable ? '- ' + taskLine(item) : item.text}`)
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
  const roots: PlanItem[] = []
  const ancestors: { indent: number; item: PlanItem }[] = []
  let baseIndent: number | null = null
  for (const line of lines) {
    if (!line.trim()) continue
    const match = /^([ \t]*)(.*)$/.exec(line)!
    const indent = match[1]!.replace(/\t/g, '  ').length
    baseIndent ??= indent
    if (indent < baseIndent) return null
    const content = match[2]!.replace(/^- /, '')
    const html = lineHTML(content)
    const item: PlanItem = {
      id: crypto.randomUUID(), text: htmlToPlainText(html), html,
      done: false, startMinutes: null, endMinutes: null, children: [],
    }
    while (ancestors.length && ancestors.at(-1)!.indent >= indent) ancestors.pop()
    const parent = ancestors.at(-1)?.item
    const siblings = parent ? parent.children : roots
    siblings.push(item)
    ancestors.push({ indent, item })
  }
  return roots.length ? roots : null
}
