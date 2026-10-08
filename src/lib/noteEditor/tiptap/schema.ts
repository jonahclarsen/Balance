// TipTap extensions for the Notes document.
//
// Model: the document is a list of generic `noteBlock` nodes. Each block holds
// exactly one `noteLine` (its inline text) followed by any number of nested
// `noteBlock` children, so every NoteItem kind can nest under every other kind
// at any depth, mirroring `NoteItem.children` one-to-one. The block carries the
// item id, kind and done flag as attributes; list markers, numbering and
// checkboxes are presentation (node view + decorations), never content.
//
// Inline vocabulary is exactly the Notes allowlist: bold / italic / underline /
// link marks, hard breaks and Balance images. Nothing else parses.

import { Extension, Mark, Node } from '@tiptap/core'
import { imageHTML, type ImageLayout } from '../../imageMarkup'
import { bucketsLinkFromURL, isGoalStatsURL, isURL, noteIdFromURL, projectIdFromURL, templateReviewFromURL } from '../../planner'
import type { NoteItemKind } from '../../types'
import { BlockNodeView } from './blockView'

export function isInternalHref(href: string): boolean {
  return isGoalStatsURL(href) || noteIdFromURL(href) !== null || projectIdFromURL(href) !== null || templateReviewFromURL(href) !== null || bucketsLinkFromURL(href) !== null
}

export function allowedHref(href: string | null): string | null {
  if (!href) return null
  const trimmed = href.trim()
  if (isInternalHref(trimmed) || isURL(trimmed)) return trimmed
  return null
}

const NoteDocument = Node.create({
  name: 'doc',
  topNode: true,
  content: 'noteBlock*',
})

const NoteText = Node.create({
  name: 'text',
  group: 'inline',
})

export const NoteBlock = Node.create({
  name: 'noteBlock',
  content: 'noteLine noteBlock*',
  defining: true,
  addAttributes() {
    return {
      id: { default: null, rendered: false },
      kind: { default: 'paragraph' as NoteItemKind, rendered: false },
      done: { default: false, rendered: false },
    }
  },
  parseHTML() {
    return [{ tag: 'div.note-item' }]
  },
  renderHTML() {
    return ['div', { class: 'note-item' }, 0]
  },
  addNodeView() {
    return ({ node }) => new BlockNodeView(node)
  },
})

export const NoteLine = Node.create({
  name: 'noteLine',
  content: 'inline*',
  whitespace: 'pre',
  parseHTML() {
    return [{ tag: 'div.note-block' }, { tag: 'p' }]
  },
  renderHTML() {
    return ['div', { class: 'note-block' }, 0]
  },
})

const HardBreak = Node.create({
  name: 'hardBreak',
  inline: true,
  group: 'inline',
  selectable: false,
  parseHTML() {
    return [{ tag: 'br' }]
  },
  renderHTML() {
    return ['br']
  },
  renderText() {
    return '\n'
  },
})

export const BalanceImage = Node.create({
  name: 'balanceImage',
  inline: true,
  group: 'inline',
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      id: { default: '', rendered: false },
      width: { default: 1, rendered: false },
      height: { default: 1, rendered: false },
      layout: { default: 'inline' as ImageLayout, rendered: false },
    }
  },
  parseHTML() {
    return [{
      tag: 'img[data-balance-image]',
      getAttrs: (element) => {
        const el = element as HTMLElement
        const id = el.getAttribute('data-balance-image') ?? ''
        if (!/^[a-f0-9]{64}$/.test(id)) return false
        const layout = el.getAttribute('data-image-layout')
        return {
          id,
          width: Number(el.getAttribute('width')) || 1,
          height: Number(el.getAttribute('height')) || 1,
          layout: layout === 'left' || layout === 'right' ? layout : 'inline',
        }
      },
    }]
  },
  renderHTML({ node }) {
    const template = document.createElement('template')
    template.innerHTML = imageHTML(node.attrs.id, node.attrs.width, node.attrs.height, node.attrs.layout)
    const img = template.content.firstElementChild
    const attrs: Record<string, string> = {}
    if (img) for (const attr of Array.from(img.attributes)) attrs[attr.name] = attr.value
    return ['img', attrs]
  },
})

// Link is ranked first so it is always the outermost mark (`<a><strong>…`).
const Link = Mark.create({
  name: 'link',
  priority: 1000,
  inclusive: false,
  addAttributes() {
    return { href: { default: null, rendered: false } }
  },
  parseHTML() {
    return [{
      tag: 'a[href]',
      getAttrs: (element) => {
        const href = allowedHref((element as HTMLElement).getAttribute('href'))
        return href ? { href } : false
      },
    }]
  },
  renderHTML({ mark }) {
    const href = String(mark.attrs.href ?? '')
    return isInternalHref(href)
      ? ['a', { href }, 0]
      : ['a', { href, target: '_blank', rel: 'noreferrer' }, 0]
  },
})

const Bold = Mark.create({
  name: 'bold',
  priority: 900,
  parseHTML() {
    return [{ tag: 'strong' }, { tag: 'b' }]
  },
  renderHTML() {
    return ['strong', 0]
  },
})

const Italic = Mark.create({
  name: 'italic',
  priority: 800,
  parseHTML() {
    return [{ tag: 'em' }, { tag: 'i' }]
  },
  renderHTML() {
    return ['em', 0]
  },
})

const Underline = Mark.create({
  name: 'underline',
  priority: 700,
  parseHTML() {
    return [{ tag: 'u' }]
  },
  renderHTML() {
    return ['u', 0]
  },
})

export function noteSchemaExtensions(behavior: Extension) {
  return [NoteDocument, NoteText, NoteBlock, NoteLine, HardBreak, BalanceImage, Link, Bold, Italic, Underline, behavior]
}
