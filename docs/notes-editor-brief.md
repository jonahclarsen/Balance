# Notes editor implementation brief (Options A and B)

You are building one of two clean-room replacements for the body editor of the
Notes page. Read `docs/notes-contract.md` in full first; it is the parity
specification. This brief covers what the shared foundation already does for
you, exactly what your view must provide, and the visual bar.

## What already exists (do not re-implement)

- `src/lib/noteEditor/types.ts` — the `NoteEditorView` interface you implement.
- `src/lib/noteEditor/noteItems.ts` — `NoteBlock` (what you read/write),
  sanitizing, `text` derivation, id assignment, diff classification.
- `src/lib/noteEditor/NoteEditorAdapter.ts` — ALL persistence. It loads items
  into your view, reads blocks back after every change, assigns ids to new
  blocks (`adoptIds`), preserves unknown fields, chooses the store operation,
  handles undo/redo reloads, remote updates (deferred during IME composition),
  and caret clamping. Your view never touches the store.
- `src/lib/noteEditor/NoteEditorHost.svelte` — mounts your view under
  `.note-document`, renders the shared formatting toolbar
  (`.note-format-toolbar`, with mobile docking), the "Start writing…" empty
  surface, remembers scroll/caret view state, flushes on blur/hide/unmount.
- Settings switch, `NotesPanel` swap point, corpus fixture
  (`tests/fixtures/notesCorpus.ts`), conformance suite
  (`tests/notes-editors/*.spec.ts`, config `playwright.notes-editors.config.ts`).
- Dependencies are installed: `@tiptap/*` 3.x (`core`, `pm`, `starter-kit`,
  `extension-link`, `extension-underline`, `extension-task-list`,
  `extension-task-item`, `extension-highlight`, `extension-placeholder`) and
  `lexical` 0.51 with `@lexical/{rich-text,list,link,history,utils,selection,html,clipboard,text}`.
  Add more with `pnpm add` if needed (never npm).

## Your deliverable

Replace the placeholder factory in your file with a real implementation:

- Option A (TipTap): `src/lib/noteEditor/tiptap/TipTapNoteEditor.ts` exporting
  `createTipTapNoteEditor(): NoteEditorView`. Put helpers/extensions/CSS in
  `src/lib/noteEditor/tiptap/`.
- Option B (Lexical): `src/lib/noteEditor/lexical/LexicalNoteEditor.ts`
  exporting `createLexicalNoteEditor(): NoteEditorView`. Put helpers/nodes/CSS
  in `src/lib/noteEditor/lexical/`.

Do not modify files outside your directory except: you may add CSS to
`src/app.css` in a clearly delimited section `/* Notes editor: <A|B> */`, and
you may fix genuine bugs in the shared `noteEditor/` foundation or the tests
if you find them (describe each such change in your report). Do NOT read the
old editor files listed in contract section 3.4 (`NotesPanel.svelte`,
`NoteItemEditor.svelte`, `RichTextEditor.svelte`, `ReadOnlyNoteItem.svelte`,
`noteClipboard.ts`, `noteSelection.ts`, `caretGeometry.ts`,
`mobileNoteToolbar.ts`, or the Notes CSS section of `app.css`). You may import
`noteClipboard.ts` exports (its API is specified in P-40/P-43) without reading
the file, or write your own clipboard serializer to the same spec.

## Document model mapping (the riskiest part)

- One block per `NoteItem`, nested exactly as `children`. Any kind may nest
  under any kind at any depth (contract 1.2). Do not use a structure that
  forbids, e.g., a paragraph child under a heading or a quote under a bullet.
  Model this as a generic "block with kind + children" node, not as
  HTML-semantic list/blockquote nesting.
- Each block carries the item id as an attribute. On `readBlocks()` return the
  same ids you were given; blocks you create report `id: null` (or a duplicated
  id) and the adapter calls `adoptIds` right after — apply those ids without
  creating an undo step or emitting `onDocumentChanged`.
- Splits: the ORIGINAL block keeps its id for the half that keeps the caret's
  left side (Enter mid-block: left half keeps id, right half is new; Enter at
  start: contract P-21 case 3 — the new empty block goes above). Merges: the
  surviving (previous) block keeps its id.
- Inline HTML in `readBlocks()` must be the allowlisted subset only:
  `<strong>`, `<em>`, `<u>`, `<br>`, `<a href … target="_blank" rel="noreferrer">`
  (or bare `<a href="balance://…">`), `<img data-balance-image=… width height data-image-layout alt draggable>`.
  Nothing else (no `<p>`, `<span>`, `<b>`, `<i>`). Serialize your marks to that
  vocabulary yourself; the adapter re-sanitizes as a safety net but relies on
  you for stable, byte-identical round trips: loading a note and reading it
  back with no edits must return exactly the same html strings.
- Soft line breaks inside a block are `<br>`.
- `done` only for checklists; report `false` otherwise.
- Disable the framework's own history (ProseMirror `history`, Lexical
  `HistoryPlugin`). App owns undo: Mod+Z / Mod+Shift+Z are handled at the window
  and reach you as prevented keydowns; ignore them. Also route `beforeinput`
  `historyUndo` / `historyRedo` to `callbacks.onUndo/onRedo`.
- Call `callbacks.onDocumentChanged('typing' | 'paste' | 'image' | 'command')`
  once per user transaction (not for `load` / `adoptIds` / `setCaret`).
  Call `onCompositionEnd` after IME composition ends.
- `getCaret()` / `setCaret()` offsets: plain-text characters within the block
  where a `<br>` counts as 1 and an image counts as 0.
- Performance: the adapter reuses unchanged item objects, but your
  `readBlocks()` runs after every keystroke — keep it linear and cheap (no
  DOM parsing per block if you can serialize from your model; the "Long note"
  corpus entry has ~200 blocks).

## DOM contract (tests and the host depend on it)

- Root editable element: `contenteditable="true"`, attributes
  `data-rich-text-input` and `data-note-text-input`, `aria-label="Note text"`.
- Every block's row element: class `note-item` plus kind classes exactly as
  contract P-12 (`note-heading`, `note-quote`, `note-list-item note-bullet`,
  `note-list-item note-numbered`, `note-list-item` (+ `note-done`) for
  checklists), attributes `data-note-item-id="<id>"`, `data-item-id="<id>"`,
  `data-note-item-depth="<0-based>"`, `data-note-item-number="<n>"` (numbered
  only, positional per P-14), `data-kind="<kind>"`, `aria-label="Note block: <text or Empty>"`.
  Inside it the content wrapper `.note-block` and, for checklists, an
  `input.check.note-check[type=checkbox]` with `aria-label` "Mark checked" /
  "Mark unchecked" that toggles with click and Space and cascades (P-17).
- Empty block placeholder text "Type / for styles" ("Heading" for headings)
  via `data-placeholder` + CSS `::before`, shown when focused or only block.
- Slash menu: `div.note-slash-menu[role=listbox][aria-label="Note styles"]`
  with `button[role=option][aria-selected]` per P-31.
- Handle the custom event `balancepaste` (`detail: { plainText, html }`) on the
  root: insert plain text inline (linkified), P-45.
- Search reveal adds class `search-result-target` to the row; document find
  needs real DOM text.
- Link clicks: external anchors → `openExternalURL(href)` from
  `src/lib/externalLinks.ts`; internal `balance://` anchors and auto-detected
  internal links (P-18, via `linkifyItemText` from `planner.ts`, display only,
  never persisted) → `callbacks.onOpenLink(link)`.
- Images (P-20): reuse `imageEditing` from `src/lib/imageEditing.ts` if it can be
  attached to your root; at minimum, `img[data-balance-image]` must round-trip
  and be hydrated by `ImageLayer` (it observes the document).

## Visual bar

Load the `frontend-design:frontend-design` skill before styling. The editor
must be genuinely beautiful and feel native to Balance:

- Use only theme tokens from contract 3.2 (`--paper`, `--ink`, `--muted`,
  `--line`, `--accent`, `--accent-strong`, `--font-content`, …). Read
  `src/app.css` `:root` and theme blocks and `src/lib/themes.ts` to see how
  themes (light/dark, Graphite, Iridescent, custom) set them. Never hard-code
  colors. Test in light and dark, Graphite and Iridescent.
- Typography and rhythm per P-12 (15 px / 1.7 body, 25 px headings, 24 px
  child indent, quote rule, marker columns). Refine: optical alignment of
  bullets/numbers/checkboxes with the first text line; heading spacing;
  balanced measure; consistent vertical rhythm between kinds.
- Polished states: focus (calm, not a harsh outline), selection across
  blocks (accent at ~24–30%), checklist done (muted + line-through with a
  gentle transition), hover on checkboxes, empty placeholder, the slash menu
  (elevated card, `--paper-strong`, subtle shadow, active option tint).
- Motion: restrained and short (≤180 ms), transform/opacity only. Obey the
  Goal Rhythm containment rule (AGENTS.md): no animating inherited variables
  or backgrounds on `:root`/`body`; keep effects scoped to your elements.
- Mobile (≤760 px): comfortable tap targets, no horizontal scroll, the shared
  toolbar docks above the keyboard (host does this), caret stays visible.
- Do not change the shared toolbar's markup; you may style your own content.

## Verification you must run

```
pnpm check
pnpm exec playwright test --config playwright.notes-editors.config.ts --project=<tiptap|lexical>
pnpm exec playwright test --config playwright.notes-editors.config.ts --project=<tiptap|lexical>-mobile
```

Iterate until every test passes or you can explain precisely why a remaining
failure is a test bug (then fix the test). Also run `pnpm test:unit`. Do not
build Android. Do not touch the user's database. Commit on your branch with
clear messages as you go (`git add` only your files plus any shared fixes) and
report: what passes, what fails and why, design decisions, and anything the
orchestrator should merge carefully.
