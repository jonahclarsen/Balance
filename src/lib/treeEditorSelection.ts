import { noteTextOffset, noteTextPoint } from './noteSelection'

export type TreeEditorSelection = {
  containerId: string
  inputId: string
  html: string
  anchor: number
  focus: number
}

export function captureTreeEditorSelection(scope?: Element | null): TreeEditorSelection | null {
  const editor = document.activeElement
  const selection = document.getSelection()
  if (!(editor instanceof HTMLElement) || !editor.dataset.richTextInputId ||
    (scope !== undefined && !scope?.contains(editor)) ||
    !selection?.anchorNode || !selection.focusNode ||
    !editor.contains(selection.anchorNode) || !editor.contains(selection.focusNode)) return null
  const containerId = editor.closest<HTMLElement>('[data-item-container-id]')?.dataset.itemContainerId
  if (!containerId) return null
  return {
    containerId,
    inputId: editor.dataset.richTextInputId,
    html: editor.innerHTML,
    anchor: noteTextOffset(editor, selection.anchorNode, selection.anchorOffset),
    focus: noteTextOffset(editor, selection.focusNode, selection.focusOffset),
  }
}

// Call after rendering: a move may have replaced the editor's DOM node.
export function restoreTreeEditorSelection(saved: TreeEditorSelection | null) {
  if (!saved) return
  const editor = document.querySelector<HTMLElement>(
    `[data-item-container-id="${CSS.escape(saved.containerId)}"] [data-rich-text-input-id="${CSS.escape(saved.inputId)}"]`,
  )
  // Offsets belong to this content. Text undo must keep its own selection behavior.
  if (!editor || editor.innerHTML !== saved.html) return
  editor.focus({ preventScroll: true })
  const anchor = noteTextPoint(editor, saved.anchor)
  const focus = noteTextPoint(editor, saved.focus)
  document.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset)
}
