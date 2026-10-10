# Notes editor contract

Notes uses Lexical with one contenteditable for the complete note. The persisted
format is Balance's `NoteItem[]` tree, not Lexical JSON. Existing notes need no
migration.

## Architecture and persistence

- `NotesPanel.svelte` owns the sidebar, title, Bin, scroll controls, and bottom
  breathing room. `ReadOnlyNoteItem.svelte` renders binned notes.
- `noteEditor/NoteEditorHost.svelte` mounts Lexical, renders the formatting
  toolbar, and remembers the caret and scroll position by note ID.
- `NoteEditorAdapter.ts` owns store integration, stable block IDs, sanitization,
  typing coalescing, undo boundaries, and reloads after history or remote changes.
  Reloads are deferred during IME composition.
- `lexical/LexicalNoteEditor.ts` owns editing, selection, keyboard commands,
  paste, links, and serialization. Its custom nodes mirror the nested item tree.
  Lexical has no independent history stack: undo and redo use the app's history.
- `noteItems.ts` converts the shared item tree to view blocks and assigns IDs to
  newly created blocks. View updates preserve existing IDs and item fields.

Each note has a stable ID, title, items, creation/update timestamps, and optional
`deletedAt`. Each item has a stable ID, plain text, sanitized inline HTML, kind,
checklist completion, and children. The kinds are paragraph, heading, quote,
bullet, numbered, and checklist. Any kind may have nested children. Shared
planner timing fields remain null on note items. HTML carries inline formatting
and image references; text is its searchable plain-text mirror.

Keep stored actions, fields, and collections compatible with older clients.
Consult the balance-operations skill before changing their vocabulary.

## Editing behavior

Enter splits a block at the selection and creates a fresh ID for the inserted
block. Empty list and quote blocks exit to paragraphs. Shift+Enter creates a soft
line break. Backspace/Delete at block boundaries merge adjacent text; deleting
across blocks retains the prefix and suffix. An empty note always offers a way
to start writing.

Tab/Shift+Tab indent and outdent nested blocks. A top-level list can become a
paragraph. Alt+Arrow moves blocks. Arrow and Shift+Arrow navigation use the
single native selection across paragraphs, including wrapped lines and images.
Title Enter focuses the end of the body, Tab its beginning, and Shift+Tab at the
first body block returns to the title.

Bold, italic, and underline are toggles through shortcuts and the toolbar.
Typing a quote around selected text preserves its formatting and selection,
and forms its own undo step. Markdown prefixes and the slash menu change block kinds. Checklist toggles
cascade to descendants and reconcile ancestors. Selected checklist blocks can
be toggled together. External URLs and Balance app links retain their navigation
behavior. Search and document find include the note body.

## Clipboard and images

`externalNotePaste.ts`, `noteClipboard.ts`, and macOS
`NoteClipboardBridge.swift` import external rich text and attachments. Semantic
lists, quotes, headings, and checklist completion survive paste. Pasted text
uses Balance's typography: CSS weight, slant, and underline become `<strong>`,
`<em>`, and `<u>`; fonts, sizes, and colors are dropped. Apple Notes titles marked
only by size become headings when at least 1.25× the dominant body size.

Internal copy/cut carries semantic HTML, plain text, and Balance's structured
payload. Multi-block replacement, paste, and cut operate on the Lexical model.
A native image paste and the app's clipboard bridge must deliver one insertion.

External images pass through `importImage`, including its compression review and
6 MB limit. Multiple images are reviewed sequentially. Skipping an image keeps
surrounding content. Assets are staged before committing the complete paste so
one undo reverses insertion. Unavailable blob/file URLs cause an import error
instead of saving a dangling reference.

Inline image nodes reserve an internal selection position so a caret can appear
before, between, and after images, including images in otherwise empty blocks.
Public remembered caret offsets count images as zero and soft breaks as one
character. Image resize, layout, and deletion changes synchronize only the
changed image attributes through the view; editing wrappers are not persisted.

## Verification

Use synthetic notes, image assets, clipboard payloads, and test-only databases.
Never inspect the installed database or take screenshots containing personal
application data.

`tests/notes-editors` covers persistence, undo, keyboard editing, selection,
clipboard, links, checklist trees, mobile toolbar usability, and image behavior.
`tests/visual/notes*.spec.ts` covers the Notes shell and editing integration.
`tests/visual/images.spec.ts` also covers shared image import and compression.
The `P-xx` labels in the conformance suite are stable behavior identifiers, not
references to a retired implementation. Their descriptions live in the tests.

Run `pnpm check`, `pnpm test:unit`, `pnpm test:relay`, the Notes conformance suite,
and `pnpm test:visual` for editor changes. The notes-editor performance workflow
profiles the sole Notes editor with synthetic small and large documents; the
results report measured timings, not an editor preference or migration format.
