// Which Notes-page editor this device renders. This is a local, per-device
// preference (never a replicated operation): the three editors read and write
// the same note items, so switching only changes the view layer.

export type NoteEditorChoice = 'classic' | 'tiptap' | 'lexical'

export const NOTE_EDITOR_PREFERENCE_KEY = 'balance:noteEditor.v1'
export const DEFAULT_NOTE_EDITOR: NoteEditorChoice = 'classic'

export const NOTE_EDITOR_OPTIONS: ReadonlyArray<{ id: NoteEditorChoice; label: string; description: string }> = [
  { id: 'classic', label: 'Classic (0)', description: 'The original Notes editor.' },
  { id: 'tiptap', label: 'A · TipTap', description: 'Rebuilt on TipTap (ProseMirror).' },
  { id: 'lexical', label: 'B · Lexical', description: 'Rebuilt on Lexical.' },
]

export function normalizeNoteEditorChoice(value: unknown): NoteEditorChoice {
  return value === 'tiptap' || value === 'lexical' ? value : DEFAULT_NOTE_EDITOR
}

export function readNoteEditorPreference(): NoteEditorChoice {
  try {
    return normalizeNoteEditorChoice(localStorage.getItem(NOTE_EDITOR_PREFERENCE_KEY))
  } catch {
    return DEFAULT_NOTE_EDITOR
  }
}

export function writeNoteEditorPreference(choice: NoteEditorChoice): void {
  try {
    if (choice === DEFAULT_NOTE_EDITOR) localStorage.removeItem(NOTE_EDITOR_PREFERENCE_KEY)
    else localStorage.setItem(NOTE_EDITOR_PREFERENCE_KEY, choice)
  } catch {
    // Keep the in-memory choice for this session.
  }
}
