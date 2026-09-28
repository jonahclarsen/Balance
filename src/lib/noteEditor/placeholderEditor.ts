// A deliberately tiny NoteEditorView used as a stand-in until the real
// TipTap / Lexical views exist. It renders one contenteditable element per
// block (flat; nesting is shown by indentation) and supports typing, Enter to
// split, and caret get/set — enough to exercise the adapter and the
// conformance harness end to end. Not a product editor.

import type { Id, NoteItemKind } from '../types'
import type { NoteBlock } from './noteItems'
import type {
  NoteEditorCaret,
  NoteEditorHostCallbacks,
  NoteEditorMountOptions,
  NoteEditorSelectionState,
  NoteEditorView,
  NoteInlineMark,
} from './types'

type Row = { element: HTMLDivElement; block: NoteBlock; depth: number }

function textLength(element: HTMLElement): number {
  return plainText(element).length
}

// Plain text as NoteItem.text counts it: <br> is "\n".
function plainText(element: HTMLElement): string {
  let text = ''
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) text += node.textContent ?? ''
    else if (node.nodeName === 'BR') text += '\n'
    else node.childNodes.forEach(walk)
  }
  walk(element)
  return text
}

function offsetOf(element: HTMLElement, node: Node, offset: number): number {
  let count = 0
  let found = false
  const walk = (current: Node) => {
    if (found) return
    if (current === node) {
      if (current.nodeType === Node.TEXT_NODE) count += offset
      else {
        for (let index = 0; index < offset; index += 1) count += current.childNodes[index].nodeName === 'BR' ? 1 : (current.childNodes[index].textContent ?? '').length
      }
      found = true
      return
    }
    if (current.nodeType === Node.TEXT_NODE) count += (current.textContent ?? '').length
    else if (current.nodeName === 'BR') count += 1
    else current.childNodes.forEach(walk)
  }
  walk(element)
  return count
}

function pointAt(element: HTMLElement, target: number): { node: Node; offset: number } {
  let remaining = target
  let result: { node: Node; offset: number } | null = null
  const walk = (current: Node) => {
    if (result) return
    if (current.nodeType === Node.TEXT_NODE) {
      const length = (current.textContent ?? '').length
      if (remaining <= length) { result = { node: current, offset: remaining }; return }
      remaining -= length
    } else if (current.nodeName === 'BR') {
      if (remaining <= 0) { result = { node: current.parentNode as Node, offset: Array.prototype.indexOf.call(current.parentNode?.childNodes ?? [], current) }; return }
      remaining -= 1
    } else current.childNodes.forEach(walk)
  }
  walk(element)
  return result ?? { node: element, offset: element.childNodes.length }
}

export function createPlaceholderNoteEditor(name: 'tiptap' | 'lexical'): NoteEditorView {
  let root: HTMLDivElement | null = null
  let callbacks: NoteEditorHostCallbacks | null = null
  let rows: Row[] = []
  let composing = false

  const selectionState = (): NoteEditorSelectionState => {
    const row = activeRow()
    return { activeKind: row?.block.kind ?? null, marks: { bold: false, italic: false, underline: false }, multiBlock: false }
  }

  function activeRow(): Row | null {
    const active = document.activeElement
    return rows.find((row) => row.element === active) ?? null
  }

  function render(blocks: NoteBlock[]) {
    if (!root) return
    root.replaceChildren()
    rows = []
    const add = (list: NoteBlock[], depth: number) => {
      for (const block of list) {
        const element = document.createElement('div')
        element.className = `placeholder-block placeholder-${block.kind}`
        element.contentEditable = 'true'
        element.dataset.noteBlock = 'true'
        element.dataset.itemId = block.id ?? ''
        element.dataset.kind = block.kind
        element.dataset.done = String(block.done)
        element.style.paddingLeft = `${depth * 24}px`
        element.innerHTML = block.html
        element.addEventListener('input', () => { if (!composing) callbacks?.onDocumentChanged() })
        element.addEventListener('compositionstart', () => { composing = true })
        element.addEventListener('compositionend', () => { composing = false; callbacks?.onDocumentChanged(); callbacks?.onCompositionEnd() })
        element.addEventListener('keydown', handleKeydown)
        element.addEventListener('focus', () => callbacks?.onSelectionChanged(selectionState()))
        element.addEventListener('blur', (event) => {
          if (!(event.relatedTarget instanceof Node) || !root?.contains(event.relatedTarget)) callbacks?.onBlur()
        })
        root!.append(element)
        const row: Row = { element, block: { ...block, children: [] }, depth }
        rows.push(row)
        add(block.children, depth + 1)
      }
    }
    add(blocks, 0)
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
    event.preventDefault()
    const element = event.currentTarget as HTMLDivElement
    const row = rows.find((candidate) => candidate.element === element)
    if (!row) return
    const selection = document.getSelection()
    const at = selection?.anchorNode && element.contains(selection.anchorNode)
      ? offsetOf(element, selection.anchorNode, selection.anchorOffset)
      : textLength(element)
    const text = plainText(element)
    element.textContent = text.slice(0, at)
    const next = document.createElement('div')
    next.className = `placeholder-block placeholder-${row.block.kind}`
    next.contentEditable = 'true'
    next.dataset.noteBlock = 'true'
    next.dataset.itemId = ''
    next.dataset.kind = row.block.kind
    next.dataset.done = 'false'
    next.style.paddingLeft = element.style.paddingLeft
    next.textContent = text.slice(at)
    next.addEventListener('input', () => { if (!composing) callbacks?.onDocumentChanged() })
    next.addEventListener('keydown', handleKeydown)
    element.after(next)
    const index = rows.indexOf(row)
    const nextRow: Row = { element: next, block: { id: null, kind: row.block.kind, html: '', done: false, children: [] }, depth: row.depth }
    rows.splice(index + 1, 0, nextRow)
    next.focus()
    const point = pointAt(next, 0)
    document.getSelection()?.setBaseAndExtent(point.node, point.offset, point.node, point.offset)
    callbacks?.onDocumentChanged()
  }

  function readBlocks(): NoteBlock[] {
    // Rebuild nesting from depth.
    const result: NoteBlock[] = []
    const stack: Array<{ block: NoteBlock; depth: number }> = []
    for (const row of rows) {
      const block: NoteBlock = {
        id: row.element.dataset.itemId || null,
        kind: (row.element.dataset.kind as NoteItemKind) ?? 'paragraph',
        html: row.element.innerHTML,
        done: row.element.dataset.done === 'true',
        children: [],
      }
      row.block = block
      while (stack.length > 0 && stack[stack.length - 1].depth >= row.depth) stack.pop()
      if (stack.length === 0) result.push(block)
      else stack[stack.length - 1].block.children.push(block)
      stack.push({ block, depth: row.depth })
    }
    return result
  }

  const view: NoteEditorView = {
    name,
    mount(options: NoteEditorMountOptions) {
      root = document.createElement('div')
      root.className = 'placeholder-note-editor'
      root.dataset.richTextInput = 'true'
      options.host.append(root)
      callbacks = options.callbacks
    },
    destroy() {
      root?.remove()
      root = null
      rows = []
    },
    load(blocks, caret) {
      render(blocks)
      if (caret) view.setCaret(caret)
    },
    readBlocks,
    adoptIds(assignments) {
      for (const { block, id } of assignments) {
        const row = rows.find((candidate) => candidate.block === block)
        if (row) { row.element.dataset.itemId = id; row.block.id = id }
      }
    },
    getCaret(): NoteEditorCaret | null {
      const row = activeRow()
      const selection = document.getSelection()
      if (!row || !row.element.dataset.itemId || !selection || selection.rangeCount === 0) return null
      const range = selection.getRangeAt(0)
      if (!row.element.contains(range.startContainer)) return null
      return {
        itemId: row.element.dataset.itemId,
        start: offsetOf(row.element, range.startContainer, range.startOffset),
        end: offsetOf(row.element, range.endContainer, range.endOffset),
      }
    },
    setCaret(caret) {
      const row = rows.find((candidate) => candidate.element.dataset.itemId === caret.itemId)
      if (!row) return
      row.element.focus({ preventScroll: true })
      const start = pointAt(row.element, caret.start)
      const end = pointAt(row.element, caret.end)
      document.getSelection()?.setBaseAndExtent(start.node, start.offset, end.node, end.offset)
    },
    focus() { (activeRow() ?? rows[0])?.element.focus() },
    blur() { activeRow()?.element.blur() },
    hasFocus() { return activeRow() !== null },
    isComposing() { return composing },
    setBlockKind(kind: NoteItemKind) {
      const row = activeRow()
      if (!row) return
      row.element.dataset.kind = kind
      if (kind !== 'checklist') row.element.dataset.done = 'false'
      callbacks?.onDocumentChanged()
      callbacks?.onSelectionChanged(selectionState())
    },
    toggleMark(_mark: NoteInlineMark) {},
    toggleChecked() {
      const row = activeRow()
      if (!row || row.element.dataset.kind !== 'checklist') return
      row.element.dataset.done = String(row.element.dataset.done !== 'true')
      callbacks?.onDocumentChanged()
    },
    indent() {},
    outdent() {},
    moveBlock() {},
    selectAll() {},
    getSelectionState: selectionState,
  }
  return view
}

export type { Id }
