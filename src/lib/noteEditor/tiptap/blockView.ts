// Node view for one note block (row). The row element is also the content
// element: ProseMirror renders the checkbox widget, the block's text line and
// its nested child rows directly inside it. The view only owns the classes and
// data attributes derived from the block's own attributes and text; positional
// attributes (depth, number) and selection classes arrive as decorations.
// Classes are toggled individually so classes other code adds to the row (for
// example the search reveal's `search-result-target`) survive updates.

import type { Node as PMNode } from '@tiptap/pm/model'
import type { NodeView, ViewMutationRecord } from '@tiptap/pm/view'
import type { NoteItemKind } from '../../types'

const KIND_CLASSES: Record<NoteItemKind, string[]> = {
  paragraph: [],
  heading: ['note-heading'],
  quote: ['note-quote'],
  bullet: ['note-list-item', 'note-bullet'],
  numbered: ['note-list-item', 'note-numbered'],
  checklist: ['note-list-item', 'note-checklist'],
}
const ALL_KIND_CLASSES = [...new Set(Object.values(KIND_CLASSES).flat()), 'note-done']

export class BlockNodeView implements NodeView {
  dom: HTMLElement
  contentDOM: HTMLElement
  private node: PMNode

  constructor(node: PMNode) {
    this.node = node
    this.dom = document.createElement('div')
    this.dom.classList.add('note-item')
    this.contentDOM = this.dom
    this.apply(node)
  }

  private apply(node: PMNode) {
    const kind = node.attrs.kind as NoteItemKind
    const done = kind === 'checklist' && Boolean(node.attrs.done)
    const wanted = new Set([...(KIND_CLASSES[kind] ?? []), ...(done ? ['note-done'] : [])])
    for (const name of ALL_KIND_CLASSES) this.dom.classList.toggle(name, wanted.has(name))
    const id = node.attrs.id as string | null
    if (id) {
      this.dom.dataset.noteItemId = id
    } else {
      delete this.dom.dataset.noteItemId
    }
    this.dom.dataset.kind = kind
    const text = node.firstChild?.textContent ?? ''
    this.dom.setAttribute('aria-label', `Note block: ${text.trim() ? text : 'Empty'}`)
  }

  update(node: PMNode) {
    if (node.type !== this.node.type) return false
    this.node = node
    this.apply(node)
    return true
  }

  // Attribute changes on the row come from us or from app code (search
  // reveal); neither is document content.
  ignoreMutation(mutation: ViewMutationRecord) {
    return mutation.type === 'attributes' && mutation.target === this.dom
  }
}
