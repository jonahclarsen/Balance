// Option A: the TipTap (ProseMirror) Notes editor. Implemented in Phase 2.
// This placeholder satisfies the host's dynamic import until then.

import type { NoteEditorView } from '../types'
import { createPlaceholderNoteEditor } from '../placeholderEditor'

export function createTipTapNoteEditor(): NoteEditorView {
  return createPlaceholderNoteEditor('tiptap')
}
