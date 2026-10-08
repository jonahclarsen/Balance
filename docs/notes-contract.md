# Notes page contract (clean-room specification)

## Rich paste additions (October 2026)

The historical inventory below predates the shared rich-paste importer. Current
entry points are `externalNotePaste.ts` (all three note editors),
`noteClipboard.ts` (shared block/list parsing), and the macOS
`NoteClipboardBridge.swift` (RTF/RTFD to self-contained HTML with attachments).
Notesnook HTML checklists preserve `checked` state. Text styles use the restricted
`inlineTextStyle.ts` allowlist and survive Classic, TipTap, and Lexical editing;
the historical assertion below that all font/color/span markup is stripped no
longer applies. Heading levels retain their imported size in inline HTML.

External images must pass through `importImage`, including its existing size
threshold, compression preview, and 6 MB limit. Multiple pasted images are
reviewed sequentially with an image index; skipping one retains the surrounding
note content. Image assets are staged before the editor commits the complete
paste, so one undo reverses the note insertion. No new persisted action or record
field is used. Unavailable cross-app blob/file URLs produce an import error;
they are never saved as dangling image references. Keep clipboard examples out
of the repository and use synthetic fixtures in tests.

This document specifies the behavior of the existing Balance **Notes** page so
that replacement Notes editors can be built without reading the existing Notes
UI code. It covers the data and persistence contract, a complete behavioral
inventory with parity IDs (`P-xx`), host integration points, and known risks.

Scope and provenance:

- Describes the committed code at `a299471` (branch `notes-editors` was created
  from it). Line numbers are omitted where possible. Functions are named
  exactly. Where a line number is given, it refers to that commit.
- The worktree also contains **uncommitted, in-progress** work that is not
  described here as existing behavior: `src/lib/noteEditorPreference.ts`,
  `src/lib/noteEditor/*`, `tests/fixtures/notesCorpus.ts`, an `editor` prop on
  `NotesPanel`, and a new `plannerStore.replaceNoteItems`. Section 4 lists
  constraints that apply to that work.
- Behaviors marked **(verified)** were confirmed by driving the existing app in
  Chromium with synthetic data while writing this document. The existing
  Playwright suites confirm the others where cited.
- "Mac / non-Mac": wherever the code checks `event.metaKey || event.ctrlKey`,
  this document writes **Mod** (⌘ on macOS, Ctrl elsewhere). Code that checks
  only `metaKey` is marked **Meta only**. On non-Mac platforms, that means the
  Windows/Super key, so Ctrl does not trigger it.

---

## 1. Data model and persistence contract

### 1.1 Types (`src/lib/types.ts`)

```ts
export type Id = string

export type PlanItem = {
  id: Id
  text: string
  html: string
  done: boolean
  generatedGoalId?: Id          // plan-only; never set on note items
  startMinutes: number | null
  endMinutes: number | null
  timeHidden?: boolean | null   // plan-only; never set on note items
  children: PlanItem[]
}

export type NoteItemKind = 'paragraph' | 'heading' | 'quote' | 'bullet' | 'numbered' | 'checklist'

// Notes reuse the plan-item text/HTML/tree shape.
export type NoteItem = PlanItem & {
  kind: NoteItemKind
  children: NoteItem[]
}

export type Note = {
  id: Id
  title: string
  items: NoteItem[]
  createdAt: string          // ISO timestamp
  updatedAt: string          // ISO timestamp
  deletedAt?: string | null  // ISO timestamp when binned; null/absent = active
}

export type NoteViewState = {
  scrollTop: number
  caret: { itemId: Id; start: number; end: number } | null
}

export type MovePlacement = 'before' | 'after' | 'inside'
export type MoveDirection = 'up' | 'down'
```

`AppState.notes: Note[]` is one of the generic entity collections (see 1.10).

### 1.2 Invariants

**IDs**
- Note ids come from `createId('note')`. The format is `note_<uuid>`, with a
  random fallback when `crypto.randomUUID` is unavailable.
- Item ids come from `createId('note_item')`, producing `note_item_<uuid>`.
  Both are generated in `src/lib/planner.ts` (`createNote`, `createNoteItem`).
  Ids are stable and never reused. Every mutation addresses items by id.
- A split, paste, or insert always creates a **fresh** item id. The original
  item keeps its id. See `splitNoteItem` for which half keeps the id.

**Shape of a freshly created item** (`createNoteItem(text = '', kind = 'paragraph')`):
`{ id, text, html: escapeHTML(text), done: false, startMinutes: null, endMinutes: null, kind, children: [] }`.
- `startMinutes` and `endMinutes` are **always present and `null`** on note
  items. Notes never use them. They exist because the type is shared with plan
  items. `normalizeNoteItems` fills them with `?? null` on load.
- `timeHidden` and `generatedGoalId` are **never written** on note items.
- `done` is present (boolean) on every created item. `normalizeNoteItems` does
  **not** default a missing `done`, so tolerate `undefined` as false.

**Shape of a freshly created note** (`createNote(title = formatDefaultNoteTitle())`):
`{ id, title, items: [createNoteItem()], createdAt: now, updatedAt: now }`.
There is no `deletedAt` key. The default title is local time in the format
`YYYY/MM/DD hh:mmAM` (for example `2026/09/27 05:39PM`). Hours use a 12-hour
clock zero-padded to 2 digits, followed by `AM` or `PM`.

**`kind`**
- Any of the 6 kinds may appear at any depth, and **any kind may have children
  of any kind**. Examples: a paragraph under a heading, a checklist under a
  numbered item, or a bullet wrapping checklists. No kind is restricted from
  nesting. Nesting depth is unlimited.
- On load, an unknown `kind` is normalized to `'paragraph'`
  (`normalizeNoteItems` in `store.ts`).

**`done`**
- It is only meaningful for `kind === 'checklist'`. UI paths that change an
  item to a non-checklist kind always send `done: false`. The store does not
  enforce that for arbitrary patches, so treat `done` on a non-checklist item
  as ignorable.
- Checklist parent/child consistency is enforced by
  `reconcileNoteChecklistItems` after structural edits. See 1.5, "Checklist
  cascade".

**`html` and `text`**
- `html` is the **source of truth**. It is sanitized inline HTML (see 1.3).
- `text` is a derived plain-text mirror. It is used by search (`search.ts`),
  the sidebar preview and filter, the internal-link detector
  (`linkifyItemText`), the `aria-label` of rows, and "is empty" checks.
- The canonical derivation, used on the typing path, is
  `text = htmlToPlainText(html)` (`planner.ts`). That is the `textContent` of
  the sanitized HTML, so **`<br>` contributes no character**. Literal `\n`
  characters in text nodes are kept.
- The existing code is inconsistent. Paste and replace-selection paths use
  `htmlToPlainTextWithBreaks(html)`, where `<br>` becomes `\n`. The store never
  re-derives `text`. New editors should use `htmlToPlainText(html)`, because
  internal-link rendering maps link offsets onto DOM text nodes where `<br>`
  has length 0 (see Section 4, R-05).
- Whitespace-only content is stored as empty. When sanitized HTML `.trim()` is
  `''`, the item is saved as `html: ''`, `text: ''`.
- A **line break inside a block** ("soft break", Shift+Enter) may be stored as
  `<br>` or as a literal `\n` inside a text node. Chromium's
  `execCommand('insertLineBreak')` in a `white-space: pre-wrap` editor inserts
  `\n` **(verified: `"Alpha\n\nBeta"`)**. WebKit and paste paths produce
  `<br>`. Both render identically because `.note-text` uses
  `white-space: pre-wrap`, and both must be accepted on load.
- A trailing `<br>` in stored HTML means "a trailing empty line". When
  displaying such HTML in a contenteditable, the existing editor appends **one
  extra** `<br>` (a caret placeholder) so the empty last line has height. It
  removes that placeholder again before saving (only when the block has
  non-whitespace text). An editor must not accumulate or lose trailing `<br>`s
  on round trip.

**`children`**
- Always an array. Order is document order. The flattened pre-order
  (parent, then its children, then next sibling) is the **visual order** used
  for arrow navigation, merge-with-previous, selection ranges, and "next/previous
  block".

**Note-level**
- Every item mutation sets `note.updatedAt = nowISO()`. Title rename sets it
  too. Trash and restore do **not** change `updatedAt`.
- `deletedAt` is an ISO string when the note is in the Bin. On load, any
  non-parseable value becomes `null`.
- `AppState.notes` order is creation order with the newest **first**
  (`addNote` prepends). The UI never shows this order directly. The list is
  sorted, as described in P-02.

### 1.3 Inline HTML allowlist and sanitization

Sanitizer: **`sanitizeInlineHTML(value: string): string`** in `src/lib/planner.ts`.
Helper: `sanitizeNode` (private). Images: **`sanitizeImage(element)`** in
`src/lib/imageMarkup.ts`. Escaping: **`escapeHTML(value)`** in `planner.ts`
(escapes `& < > " '`). Without `document` (non-DOM runtime), `sanitizeInlineHTML`
returns `escapeHTML(value)`.

The sanitizer parses into a `<template>`, rebuilds only allowed output, then
calls `cleanTrailingLineBreaks`. Output vocabulary (exhaustive):

| Input | Output |
|---|---|
| text node | `escapeHTML(text)` (literal `\n` kept) |
| `<br>` | `<br>` |
| `<b>`, `<strong>` | `<strong>…</strong>` |
| `<i>`, `<em>` | `<em>…</em>` |
| `<u>` | `<u>…</u>` |
| `<p>`, `<div>` | children followed by `<br>` (or nothing if empty). Block wrappers become line breaks. |
| `<a href>` with `isURL(href)` (`http:`, `https:`, `file:`) | `<a href="HREF" target="_blank" rel="noreferrer">…</a>` |
| `<a href>` where href is `balance://note/<id>`, `balance://projects` or `balance://projects/<id>`, or `balance://goals/stats` | `<a href="HREF">…</a>` (no target/rel) |
| `<a>` with any other href (including `#`) | children only (the anchor is dropped) |
| `<img data-balance-image="<64 hex>" …>` | `imageHTML(id, width, height, layout)`, which is `<img data-balance-image="ID" width="W" height="H" data-image-layout="inline\|left\|right" alt="Image" draggable="true">`. Width and height are clamped to 1–30000. An invalid id gives `''`. |
| any other element (`s`, `strike`, `code`, `mark`, `span`, `h1`–`h6`, `li`, `script`, `table`, …) | its children only (formatting dropped, text kept) |
| comments and other node types | removed |

All attributes not listed above are dropped. **There is no strikethrough, code,
highlight, color, or font markup in notes.** Those are stripped on paste
**(verified)**. Strikethrough appears only as the CSS style of done checklist
items.

`cleanTrailingLineBreaks`:
- If the whole value has no text and no image, **all** trailing `<br>`s are
  removed. Formatting wrappers that become empty are removed too, so an item
  cannot persist a phantom newline.
- Otherwise, trailing raw `\n` characters at the very end of the last text node
  are stripped, and trailing `<br>` elements are **kept**.

Related helpers (all in `planner.ts`):
- `htmlToPlainText(value)`: `textContent` of `sanitizeInlineHTML(value)`.
- `htmlToPlainTextWithBreaks(value)`: same, but `<br>` becomes `\n` first.
- `linkifyExternalURLs(value)`: sanitizes, then wraps bare `https?://…` runs
  that are not already inside an `<a>` into external anchors. Trailing
  `.,!?;:)]` characters are excluded from the URL. It re-sanitizes afterward.
- `isURL`, `noteIdFromURL` (`^balance://note/([a-zA-Z0-9_-]+)$`),
  `projectIdFromURL`, `isGoalStatsURL`.

Where sanitization happens:
- **On load:** `normalizeState` → `normalizeNoteItems`
  (`html = sanitizeInlineHTML(item.html ?? escapeHTML(item.text ?? ''))`,
  and `text = item.text ?? htmlToPlainText(html)`). This runs on every state
  parse: browser `localStorage` load, native `read_app_state`, backend reloads,
  and full-state undo results.
- **On save:** the store does **not** sanitize patches. The editor must send
  sanitized HTML. The existing editor sanitizes the DOM before every commit
  (input, blur, split, paste, format). Clipboard parsing sanitizes each block.
- **On paste:** clipboard HTML is sanitized and linkified (P-44, P-45).
- **On render of the read-only Bin view:** `sanitizeInlineHTML(item.html)`.

Display-only transform (not persisted):
**`renderItemDisplayHTML(sourceHTML, sourceText, segments)`** with
**`linkifyItemText(text, listTemplates, metrics, notes)`**. This inserts
`<a href="#" data-internal-link-kind data-internal-link-id data-internal-link-label title="Open …">`
around internal-link matches, located by plain-text offset (see P-18). Because
`href="#"` is not allowed, these anchors are removed by the sanitizer on save.
They must never be persisted.

### 1.4 Mutation API (exported by `plannerStore` in `src/lib/store.ts`)

All note mutations go through `commitEntities(action, payload, mutate, options)`.
Each call is synchronous. It updates the Svelte store immediately, records
undo history (unless `undoable: false`), and queues one operation of type
`apply_entity_changes`. `payload.action` is only a label. The operation carries
`entityChanges` (version 2) for collection `notes`, keyed by note id, with an
id-addressed `records` patch for `items` (see 1.10).

**If a mutation produces an identical state, nothing is committed.** There is
no operation and no history entry. This also holds for `applyPatch` when no
value changes.

Unless stated otherwise, each call is **one undo step** (a separate history
entry). All item-level mutations run `reconcileNoteChecklistItems` on the
result, and set `updatedAt`.

| Purpose | Exact function | Semantics |
|---|---|---|
| Create note | `addNote(): Id` | `createNote()` prepended to `state.notes`. It contains one empty paragraph and the default title. Returns the id. Action `add_note`. |
| Rename (edit title) | `renameNote(noteId: Id, title: string): void` | Sets `title` and `updatedAt`. **Merges history** with `mergeKey: note-title:<noteId>` and a `TEXT_MERGE_WINDOW_MS` (1200 ms) window. Called on every `input` event of the title. |
| Bin (trash) | `trashNote(noteId: Id): void` | Sets `deletedAt = nowISO()` if not already set. Undoable. The UI uses no confirmation (App `binNote`). |
| Restore | `restoreNote(noteId: Id): void` | Sets `deletedAt: null` if set. |
| Permanently delete | `permanentlyDeleteNote(noteId: Id): void` | Removes the note record. **Undoable.** App asks for confirmation first (`confirmPermanentlyDeleteNote`). |
| Empty Bin | `emptyNoteTrash(): void` | Removes all notes with `deletedAt`. Undoable. App confirms first (`confirmEmptyNoteTrash`). |
| Auto-purge | `purgeExpiredNotes(now = Date.now()): void` | Removes Bin notes whose `deletedAt + 30 days <= now` (`isNoteTrashExpired` in `noteTrash.ts`). **`undoable: false`.** App calls it at startup and every 60 s. |
| Append empty item | `addRootNoteItem(noteId: Id, kind: NoteItemKind = 'paragraph'): Id` | Appends `createNoteItem('', kind)` at the **end of the root list**. Returns the new id. |
| Edit item / change kind / set done on one item | `patchNoteItem(noteId: Id, itemId: Id, patch: Partial<NoteItem>, options: { mergeHistory?: boolean } = {}): void` | Shallow-merges `patch` into the item. It preserves every other field, including unknown ones. If `patch` contains `kind` or `done`, it runs `reconcileNoteChecklistItems`. **History merging:** if the patch contains `text` or `html` and `options.mergeHistory !== false`, it uses `mergeKey: note-item-text:<noteId>:<itemId>` with a 1200 ms window (see 1.6). Patches without text/html, such as a bare kind change, are separate undo steps. |
| Toggle checklist (one or many, with cascade) | `patchNoteItemsDone(noteId: Id, itemIds: Id[], done: boolean): void` | `patchNoteChecklistItemsDone(items, itemIds, done)`. It sets `done` on each **checklist** item in `itemIds` and on **all checklist descendants** of those items. Then it reconciles checklist ancestors. Non-checklist ids are ignored, except that their checklist descendants are **not** cascaded unless an ancestor checklist was selected. It is a no-op for `[]`. |
| Split at caret (Enter) | `splitNoteItem(noteId: Id, itemId: Id, before: {html, text}, after: {html, text}): Id` | See the split rules below the table. Returns the **new** item's id. |
| Merge with previous (Backspace at start) | `backspaceNoteItemAtStart(noteId: Id, itemId: Id): { focusItemId: Id; focusOffset: number } \| null` | Uses the flattened visual order. If the item is first, it returns `null`. **If the previous item is empty (no text, no image) and has no children**, it deletes the previous item and returns `{ focusItemId: itemId, focusOffset: 0 }`. **Otherwise it merges:** `previous.text += current.text`, `previous.html = sanitizeInlineHTML(prevHTML + curHTML)`, and `previous.children = [...previous.children, ...current.children]`. It deletes the current item and returns `{ focusItemId: previous.id, focusOffset: previous.text.length }` (the old length of the previous text). The previous item keeps its own `kind`. **It also returns `null` while a native undo/redo is in flight**, in which case the action is deferred and replayed later. See R-10. |
| Merge with next (Delete at end) | *(no dedicated function)* | The existing UI calls `backspaceNoteItemAtStart(noteId, nextItemIdInVisualOrder)`. |
| Delete one item, keeping its children | `deleteNoteItemPreservingChildren(noteId: Id, itemId: Id): void` | If the item has a previous sibling, its children are appended to that sibling's children. Otherwise they replace the item at the same position and level. |
| Delete many items with their subtrees | `deleteNoteItems(noteId: Id, itemIds: Id[]): void` | Removes each listed item **and its whole subtree**. No-op for `[]`. |
| Indent | `moveNoteItem(noteId: Id, sourceId: Id, targetId: Id, placement: MovePlacement): void` | Generic move. The UI's indent uses `placement 'inside'` with target = the nearest preceding row at the **same depth**. The item (with its subtree) is appended as the **last child** of the target. It refuses to move into its own subtree. |
| Outdent | `outdentNoteItem(noteId: Id, itemId: Id): void` | Moves the item to just after its parent, at the parent's level. **Following siblings become the item's children**, appended after its existing children. |
| Move up/down | `moveNoteItemWithinLevel(noteId: Id, itemId: Id, direction: MoveDirection): void` | Swaps with the adjacent sibling in the same children array. It is a no-op at the ends and never crosses levels. |
| Replace a range (paste, typing over a multi-block selection) | `replaceNoteItemRange(noteId: Id, itemId: Id, itemIds: Id[], replacement: { html; text; kind?; done?; children?: ParsedNoteClipboardItem[] }, followingItems: ParsedNoteClipboardItem[] = []): Id[]` | See the range-replacement steps below the table. Returns `[itemId, ...flattened ids of pasted children, ...flattened ids of inserted items]`. Action `replace_note_item_range`. |

`splitNoteItem` rules:
- `emptyItem = !before.text.trim() && !after.text.trim()`.
- `placement` is `'after'` if `emptyItem`. Otherwise it is `'before'` when
  `before.html === '' && before.text === ''` (caret at the very start), and
  `'after'` otherwise.
- With `'after'`, the original item receives `before`, and a new item with
  `after` is inserted **as the next sibling**, placed after the original's
  whole subtree. The original **keeps its children**. The new item has none
  **(verified)**.
- With `'before'`, the original item receives `after`, and a new item with
  `before` (empty) is inserted as the **previous** sibling.
- New item kind: `'paragraph'` if the source is a `heading` and the placement is
  `'after'`. Otherwise it is the same kind as the source, so bullets continue
  bullets, quotes continue quotes, and checklists continue checklists
  (`done: false`).

`replaceNoteItemRange` steps:
1. `{html, text, kind?, done?}` of `replacement` is shallow-merged into
   `itemId` (children excluded).
2. Every other id in `itemIds` is deleted with
   `deletePlanItemPreservingChildren`, one at a time.
3. `replacement.children` (converted into fresh items) are **prepended** to
   `itemId`'s children.
4. `followingItems` (fresh items with nested children) are inserted as
   siblings right **after** `itemId`.

Fresh items are created with `createNoteItem(text, kind)`, plus `html`, `done`,
and recursive children.

Undo and redo: `plannerStore.undo(): Promise<string | null>` and
`plannerStore.redo(): Promise<boolean>`. The Notes page does not call these.
`App.svelte` does (see 1.6).

Other store members relevant to editors:
- `plannerStore.subscribe`.
- `plannerStore.flushPendingOperations()`: native only. It waits for native
  history and then persists queued operations.
- `plannerStore.reloadFromBackend()`: native only. It re-reads the whole state
  once local edits are quiet.
- `plannerStore.stageImage(asset)`.
- `plannerStore.moveImage(edit)`: groups image moves into one operation.
- The `historyRevision` field on `AppState`.

Pure helpers used by the store (`planner.ts`): `createNote`, `createNoteItem`,
`createId`, `reconcileNoteChecklistItems(items)`,
`patchNoteChecklistItemsDone(items, ids, done)`, `updatePlanItem`,
`splitPlanItem`, `deletePlanItems`, `deletePlanItemPreservingChildren`,
`backspacePlanItemAtStart`, `movePlanItem`, `movePlanItemWithinLevel`,
`outdentPlanItem`, `pastePlanItems`, and `findPlanItem`.

### 1.5 Checklist cascade (`updateNoteChecklistItems` in `planner.ts`)

It is covered by `tests/unit/note-checklist.spec.ts`. The same traversal
implements both `reconcileNoteChecklistItems(items)` (no selection) and
`patchNoteChecklistItemsDone(items, ids, done)`:

1. **Downward cascade.** A checklist item whose id is selected gets
   `done = value`. So does **every checklist descendant**, at any depth,
   including checklists nested under non-checklist wrappers such as bullets.
   Non-checklist items never change `done`.
2. **Upward reconciliation.** For every checklist item not being cascaded, the
   algorithm looks at its **checklist frontier**. That is the nearest checklist
   descendants along each path, looking through non-checklist wrappers. If the
   frontier is non-empty, `done = every(frontier.done)`. If it has no checklist
   descendants, its own `done` is kept.
3. Consequences:
   - Checking the last unchecked child checks every satisfied checklist
     ancestor.
   - Unchecking any child unchecks all checklist ancestors.
   - Adding a new unchecked checklist child, for example with Enter below a
     checked child, unchecks the parent **(verified)**.
   - Outdenting that child back out re-checks the parent **(verified)**.
   - A checked parent whose only checklist descendant is unchecked becomes
     unchecked on reconcile.

### 1.6 Undo/redo integration

- **App owns undo.** In `handleGlobalKeydown` (`App.svelte`,
  `<svelte:window on:keydown|capture>`), **Mod+Z** calls
  `undoAndOpenDestination()`. **Mod+Shift+Z** and **Mod+Shift+C** call
  `redoAndOpenDestination()`. It calls `preventDefault()`, which suppresses
  native contenteditable undo, but not `stopPropagation()`. The window capture
  listener runs **before** any document or element listener. Editors must
  **not** implement their own undo stack. ProseMirror/TipTap `history` and the
  Lexical `HistoryPlugin` must be disabled, or at least never fed Mod+Z.
- `applyHistoryAndReveal` runs `plannerStore.undo()` or `redo()`, then
  `historyDestination(before, after)` (`historyNavigation.ts`), then
  `revealHistoryDestination`. For notes, that sets `selectedNoteId`, sets
  `notesTrashOpen` to whether the note is binned, switches the view to Notes,
  and scrolls. See 3.1 about item reveal. It also calls
  `captureTreeEditorSelection()` / `restoreTreeEditorSelection()`, which only
  work for editors inside `[data-item-container-id]`. Note rows don't have that
  attribute, so this is a no-op for notes today.
- Every undo or redo **increments `state.historyRevision`**. It is passed to
  the editor as the `historyRevision` prop. An editor must treat a revision
  change as "the store is authoritative; re-render from it" (see 1.8).
  Observed behavior of the existing editor after undo or redo:
  - An unfocused block re-renders from the store.
  - The focused block re-renders only if its sanitized content differs, and
    then the **caret goes to the end of that block** **(verified)**.
  - If the focused block was removed, focus is lost (`document.activeElement`
    becomes `body`).
- **Coalescing (history boundaries).** Text edits commit on **every** `input`
  event (no debounce). Consecutive commits merge into one history entry when
  all of the following hold:
  - Each has the same `mergeKey` (`note-item-text:<noteId>:<itemId>`, or
    `note-title:<noteId>` for the title).
  - The previous history entry is the latest operation.
  - Less than **1200 ms** has passed since the **last** merged edit. It is a
    sliding window, because each merge refreshes `updatedAt`.

  The following start a new undo step:
  - A pause of at least 1200 ms.
  - Editing a different block or the title.
  - Any non-text commit in between (kind change, split, merge, toggle, move,
    indent).
  - Undo or redo.
  - A commit with `mergeHistory: false`. The existing editor passes that for
    **paste** (`insertHTML` or `createLink` from a paste) and for **image
    edits**.

  So a paste is its own undo step, and the typing after it starts a new one.
- The following are **text patches**, so they merge into the surrounding typing
  burst:
  - Markdown autoformat (P-31), because its patch includes `html`/`text`.
    **An autoformat cannot be undone separately from the typing that triggered
    it.** Mod+Z after typing `- item` quickly returns the block to its
    pre-burst state.
  - Mod+B/I/U and Shift+Enter.

  Verified undo sequence: typing `# Head`, pausing more than 1.2 s, then typing
  ` more` gives these undo steps: `Head more` → `Head` (heading) → `""`
  (paragraph) → note removed.
- The operation log: on native builds, operations are flushed to SQLite after a
  500 ms debounce (`PERSIST_DEBOUNCE_MS`). While an operation is still pending,
  further merged edits rewrite it in place. After a flush, the next keystroke
  creates a new operation but can still continue the same history group. Tested
  by `tests/ci/note-undo.spec.ts`: 6 keystrokes with a 2 s gap produce
  6 operations and 2 history entries. Undo, undo, redo, redo yields `abc`, `''`,
  `abc`, `abcdef`.
- Native undo (`withNativeHistory`): while a native undo/redo IPC is in flight,
  **all commits are deferred** and replayed afterward in order.
  `backspaceNoteItemAtStart` returns `null` in that window (see R-10).

### 1.7 When edits are committed (debounce/flush)

- **Title:** every `input` event → `renameNote`.
- **Block text:** every `input` event → `patchNoteItem(… { html, text }, { mergeHistory })`.
  The sanitized HTML is taken from the DOM each time. There is **no frontend
  debounce**.
- **Blur:** the existing editor re-sanitizes and commits on `blur`. That is a
  no-op when nothing changed.
- **Structural keys** (Enter, Backspace, Delete, Tab, Alt+Arrow, kind changes,
  checkbox) commit immediately.
- **Browser (dev/test) mode:** the whole `AppState` is written to
  `localStorage['balance.appState.v1']` synchronously on every store update.
- **Native mode:** operations are queued and persisted after a 500 ms debounce.
  `syncScheduler.ts` also calls `plannerStore.flushPendingOperations()` on
  `visibilitychange` (hidden) and `pagehide`.
- **Note switch, page switch, or unmount:** there is no separate text flush.
  Every keystroke is already in the store. On unmount, the Notes panel saves
  scroll and caret view state (1.9). **Requirement for new editors:** if an
  editor batches or debounces its own model→store sync, it must flush
  synchronously before a note switch, page switch, unmount, blur, undo (Mod+Z
  keydown), window `pagehide`, and `visibilitychange: hidden`.

### 1.8 Remote/sync updates while editing

- Sync never patches items directly. It replaces the whole state through
  `plannerStore.reloadFromBackend()` → `reloadFromBackendWhenStable()`.
  - It waits for a **500 ms quiet period** with no local mutations, for native
    history, and for pending flushes.
  - It **discards** a read if a local mutation happened during it, then retries
    after another quiet period.
  - If the stored state is identical, it keeps the current state but still
    increments `historyRevision`.
  - Otherwise it replaces the state, clears the undo and redo stacks, and
    increments `historyRevision`.

  So remote changes arrive only after about 0.5 s of typing inactivity, and
  always with a `historyRevision` bump. Undo and redo also bump it.
- Reconciliation rules of the existing block editor (behavioral contract):
  1. **Unfocused block:** whenever the store's `html`/`text` (or its internal
     link segments) differ from what is displayed, the DOM is replaced from the
     store.
  2. **Focused block, no revision change:** the DOM is **never** overwritten by
     store updates. The DOM is the source of truth while typing. This is the
     "don't clobber the item being edited" rule.
  3. **Focused block, revision changed:** if
     `sanitizeInlineHTML(dom) === sanitizeInlineHTML(storeRender)`, the DOM and
     caret are kept. This avoids caret jumps when only browser markup differs,
     such as `<b>` versus `<strong>`. Otherwise the DOM is replaced and the
     caret moves to the **end** of the block. This came from commit `c55f538`,
     "Fix task caret jumps after background sync refreshes".
  4. Blocks that are added or removed remotely appear or disappear. A focused
     block that is removed loses focus.
- A new editor must implement 1–3 or better. The minimum is: never reset the
  focused block's content or caret for an update that doesn't change its
  sanitized content.

### 1.9 View state (`NoteViewState`)

- **Storage:** an in-memory `Map<Id, NoteViewState>` owned by `App.svelte`
  (`noteViewStatesById`), passed to the panel as `viewStatesByNote`. It is
  written through `onViewStateChange(noteId, state)`, which is App's
  `rememberNoteViewState`. It is **not** persisted: not in `localStorage`, not
  in preferences, and not in the store. It lasts for the app session only and
  is not synced.
- **`caret`:** `{ itemId, start, end }`. Offsets are computed by
  **`noteTextOffset(editor, node, offset)`** (`src/lib/noteSelection.ts`).
  These are character counts over text nodes, and **each `<br>` counts as 1**.
  Images count 0. The caret is restored with **`noteTextPoint(editor, offset)`**.
- **Saved:**
  - Scroll is saved on every scroll or resize of the note scroller (throttled
    with `requestAnimationFrame`), when the selected note changes (the old
    note's scroll), and on unmount.
  - The caret is saved on every document `selectionchange` whose range lies
    wholly inside one block editor of the selected note, and on unmount.
  - Nothing is saved while a restore is in progress (`restoringNoteViewState`).
- **Restored** when the selected note changes, including the first render after
  mounting the page:
  - After the DOM renders, if a saved caret exists and its block exists, that
    block is focused and the selection is set to `[start, end]`.
  - Then, after one animation frame, `scrollTop` is set.
  - If the note has **no** saved state, `scrollTop = 0` and **nothing is
    focused**. Opening a note for the first time in a session does not
    autofocus the body.
- Scroller used (`noteScrollContainer`):
  - `.note-document` if its computed `overflow-y` is `auto` or `scroll`. This
    is the desktop case.
  - Otherwise, when `(max-width: 760px)` matches, `document.scrollingElement`.
    This is the mobile case.
  - Otherwise `.workspace`, or the document scroller if `.workspace` can't
    scroll.
- App separately remembers the `.workspace` scroll per page (`view:notes`).

### 1.10 Replication rules (from `.agents/skills/balance-operations/SKILL.md`)

- Notes live in the generic `state_entities` storage (`ENTITY_COLLECTIONS`
  includes `'notes'`). Every note change is persisted as
  `type: "apply_entity_changes"`. Its `entityChanges` field is
  `{ version: 2, upserts: [{ collection: 'notes', key: noteId, position, value, patches: [entityPatch(before, after)] }], deletes: [...] }`.
- `entityPatch` (`src/lib/entityPatch.ts`) emits these patch kinds:
  - `object`: changed fields plus removed keys.
  - `records`: for arrays of objects with unique string `id`, so
    `note.items` and every nested `children` array. They are **id-addressed**
    `entries`, with explicit `remove` and `order` (only when order changed).
  - `replace`: for primitives and atomic arrays.
- Rules that apply to any Notes editor:
  1. **Only mutate through the `plannerStore` note functions** (1.4). Never
     construct a new `AppState`/`notes` array by hand, and never add a new
     operation type or feature-specific command.
  2. **Preserve unknown fields.** Items and notes may carry fields written by
     newer clients, for example `futureField`. A test note with `futureField`
     kept it through a text edit **(verified)**. Mutators must spread the
     existing record (`{ ...item, ...patch }`) and never rebuild records from
     known fields. "Omission of a previously visible field means explicit
     removal."
  3. **Keep ids stable.** A text edit, kind change, move, or indent must keep
     the item's id. Only genuinely new blocks get new ids from
     `createId('note_item')`. Re-creating a block with a new id turns an edit
     into delete-plus-insert and breaks undo, sync merges, search targets, and
     view-state carets.
  4. **Unchanged items must keep object identity** (`===`). The diff skips
     identical references cheaply, so a small edit must not clone and
     serialize the whole tree.
  5. **Domain deletion removes a whole record**, including unknown fields. This
     is fine for deleting blocks. Merging (Backspace) intentionally drops the
     merged item's own unknown fields.
  6. **The persisted vocabulary is frozen.** That means the 6 kinds, the fields
     above, and the HTML allowlist. Adding a mark (strike/code/highlight), a
     block kind, or a field is a storage-contract change:
     - Older clients sanitize unknown tags away on load.
     - Older clients normalize unknown kinds to `paragraph`.
     - It requires the rollout process in the skill (mixed-version CI,
       future-schema fixture).
  7. Image references must use the established `data-balance-image="<sha256>"`
     encoding, so that image retention scans find them.
  8. Tests must use generated synthetic data only (see `AGENTS.md`).

---

## 2. User-facing feature inventory (parity checklist)

The layout is App → `NotesPanel` shell → body editor. Each item states keys and
the exact expected result. Headings group items. IDs are stable for test
references.

### A. Page shell, note list, Bin

**P-01 Page and empty states.**
- The Notes page renders a sidebar (`aside.notes-sidebar`, `aria-label="Notes"`)
  and a document section (`section.note-document`) inside `.notes-workspace`.
- With no active notes, the document shows `.empty-state.note-empty` with the
  heading "Your notes live here". With active notes but none selectable, it
  shows "Choose a note". Either way it shows the text "Keep reference material,
  lists, and ideas separate from any particular day." and a button
  `.primary.note-empty-new` "+ New note" with `<kbd class="note-new-shortcut">`
  (`⌘N` on Mac, `Ctrl+N` elsewhere).
- In the Bin with nothing selected, it shows `.note-empty-trash-icon` "✓",
  the heading "Bin is empty", and "Binned notes stay here for 30 days before
  they are permanently deleted."

**P-02 Note list.**
- `.notes-list` holds one `button.note-card` per visible note.
  - `strong`: title, or "Untitled note" if blank. Clamped to 2 lines.
  - `span`: the flattened text of all items (each item `text` joined with
    spaces, depth-first), whitespace-collapsed, first 90 characters. "Empty
    note" if blank.
  - `<time datetime>`: `Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })`
    of `updatedAt`, plus the year when it isn't the current year. The Bin uses
    `deletedAt`.
- The active card has class `.active`.
- **Order:** active notes by `updatedAt` descending, so editing a note moves it
  to the top **(verified)**. Bin notes by `deletedAt` descending.
- The list scrolls independently of the document (desktop).

**P-03 Filter.**
- `input.notes-filter[type=search]`, with `placeholder` and `aria-label` both
  set to "Filter notes", or "Filter Bin" in the Bin.
- A card matches when the lowercase string `"<title> <flattened text>"`
  contains the trimmed lowercase filter as one substring.
- With visible notes but no match, it shows `p.notes-no-match` "No matching
  notes."
- The filter is cleared when switching between Notes and the Bin.

**P-04 Create a note.**
- Triggers:
  - `button.note-new` "New" (`title="New note (⌘N)"` or `(Ctrl+N)`,
    `aria-keyshortcuts="Control+N Meta+N"`, with `<kbd class="note-new-shortcut">`),
    shown only outside the Bin.
  - The empty-state button.
  - **Mod+N** on the Notes page. App handles it with `event.code === 'KeyN'`,
    no Alt/Shift, and ignores key repeats. It works even while typing in a note
    and even in the Bin view.
- Effect:
  1. Leaves the Bin.
  2. `addNote()`.
  3. Selects the new note.
  4. Focuses `#note-title` and **selects all of the title text**.
- The new note has one empty paragraph.

**P-05 Selecting notes.**
- Clicking a card calls `onSelect(id)`.
- If `selectedNoteId` isn't among the visible notes, the panel shows the
  **first note in store order** among the visible ones. Store order is newest
  created first, not the sorted list's first.
- App picks `notes[0]` (the first non-binned note in store order) when nothing
  is selected, and resets the selection when the selected note is deleted.
- Switching notes:
  - Clears multi-block selection.
  - Resets the toolbar's inline-format state.
  - Sets the toolbar's target block to the note's first item.
  - Restores that note's view state (1.9).

**P-06 Title.**
- `textarea#note-title.note-title`, `rows=1`, `placeholder="Untitled note"`,
  `aria-label="Note title"`.
- It auto-grows to fit wrapped text with no internal scrollbar, and re-measures
  on width change.
- Each input calls `renameNote` (merged undo, 1200 ms).
- **Enter** without modifiers and not composing:
  - Calls `preventDefault`.
  - Focuses the **last** block editor in visual order, with the caret at its
    end.
  - If the note has no items, it first calls `addRootNoteItem`.
- **Shift+Enter** in the title inserts a newline, because it's a native
  textarea. The title can contain newlines. Other modifier+Enter combinations
  do nothing special.
- In the Bin, the title renders as `h1.note-title.note-trashed-title`
  (read-only).

**P-07 Copy note link.**
- Button in `.note-actions`, text "Copy note link",
  `title="Copy an app link to this note"`, `aria-live="polite"`.
- It writes `balance://note/<id>` with `navigator.clipboard.writeText`. If that
  fails, it falls back to a hidden textarea and `execCommand('copy')`.
- The button text becomes "Link copied!" or "Copy failed" for 1000 ms.

**P-08 Bin a note.**
- `.note-actions` button `.ghost.danger` "Bin it" calls `trashNote`
  immediately. There is no confirmation, and it is undoable.
- Selection moves to the next note in **store order** (index + 1). If there is
  none, it moves to the previous one (index − 1). If neither exists, it goes
  to `''`, and App then falls back per P-05.
- Mod+Z restores the note, and it is shown again.

**P-09 Bin view.**
- It is toggled by App's header button `.notes-trash-header-button` "Bin",
  with `aria-pressed` and class `.active` while open.
  - `title="Open Notes Bin"` when closed, "Back to Notes" when open.
  - It calls the panel's exported `openTrash()` or `showNotes()`.
  - `trashOpen` is two-way bound (`bind:trashOpen`).
- The sidebar shows:
  - An `h3` "Bin".
  - `button.ghost.danger.note-empty-trash` "Empty" (`aria-label="Empty Bin"`),
    only when the Bin is non-empty.
  - A filter.
  - Cards.
  - `button.notes-back-link` "← Back to Notes".
- The document shows:
  - The read-only title.
  - `.note-actions`: `button.primary` "Restore" and `button.ghost.danger`
    "Delete now".
  - `div.note-trash-notice[role=status]` with "⌛", then
    `<strong>` "Permanently deleted in N days" (or "Permanently deleted within
    1 day" when N ≤ 1). N comes from `noteTrashDaysRemaining`, which is
    `ceil((deletedAt + 30d − now) / 1d)`. Then `<small>` "Notes stay in Bin
    for 30 days. Restore this note to edit it again."
  - `.note-blocks.note-readonly-blocks` rendering items read-only
    (`.note-item.note-readonly-item`) with the same classes and markers,
    disabled checkboxes (`aria-label` "Completed" or "Not completed"),
    sanitized HTML, and no editors. An empty note shows
    `p.note-readonly-empty` "This note is empty."
  - No toolbar and no bottom space control.
- **Restore:**
  1. `restoreNote`.
  2. Leave the Bin.
  3. Clear the filter.
  4. Select the note.
  5. Focus the title (not select).
- **Delete now:** confirm with "Delete “<title or Untitled note>” now instead of
  waiting 30 days? You can still undo this action." (title "Delete note now?").
  This uses Tauri `confirmDialog` natively and `window.confirm` in the browser.
  Then `permanentlyDeleteNote`, and select the next/previous Bin note in
  deletedAt order.
- **Empty:** confirm with "Delete N note(s) now instead of waiting 30 days? You
  can still undo this action." (title "Empty Bin?"). Then `emptyNoteTrash`, and
  select `''`.
- Both are undoable. Undoing a permanent delete re-shows the note in the Bin.

**P-10 Auto-purge.** Notes binned more than 30 days ago disappear at startup and
on a 60 s interval (`purgeExpiredNotes`, not undoable).

**P-11 Zoom and IMAX.**
- `.notes-view-workspace` has `zoom: 1.1` on top of the app's 1.1. Text inside
  notes is therefore about 1.21× the CSS size. Caret and geometry code must
  account for `currentCSSZoom`.
- **Alt+I** (App, `event.code === 'KeyI'`) or the IMAX button toggles
  maximized mode. That hides the sidebar, page header, and Goal Rhythm, and
  gives the document the full width. Desktop only.

### B. Blocks and rendering

**P-12 Block kinds.**
- DOM contract per block: `div.note-item` (the row) containing
  `div.note-block`, which contains an optional checkbox followed by the
  editable text element, and an optional `div.note-children`.

| kind | Row classes | Marker | Text style |
|---|---|---|---|
| `paragraph` | `note-item` | none | 15 px, line-height 1.7 (25.5 px), min-height 30 px, padding 3px 2px |
| `heading` | `note-heading` | none | `clamp(20px, 2.5vw, 25px)` (25 px at desktop width), weight 720, letter-spacing −0.02em, line-height 1.35, min-height 40 px. The row has 12 px top padding except as the first child. Placeholder "Heading". |
| `quote` | `note-quote` | 3 px solid `var(--muted)` left border on `.note-block`, 12 px left padding | body style |
| `bullet` | `note-list-item note-bullet` | `::before` "•", 17 px, weight 600, `var(--ink)`, in a 20 px column, padding-top 5 px | body style |
| `numbered` | `note-list-item note-numbered` | `::before` `attr(data-note-item-number) "."`, 14 px, weight 500, muted, right-aligned in a 24 px column, baseline-aligned | body style |
| `checklist` | `note-list-item`, plus `note-done` when done | `input.check.note-check[type=checkbox]` (18 px, margin 6px 3px 0 2px). `aria-label` is "Mark checked" when unchecked and "Mark unchecked" when checked. | body style. When done: `color: var(--muted)` and `text-decoration: line-through`. |

- All text uses `font-family: var(--font-content)`, `white-space: pre-wrap`,
  and `font-synthesis: style`. The last one gives a synthetic italic in the
  rounded font, and a test asserts it.
- Children are indented with `margin-left: 24px` (18 px at ≤760 px).
- Links in text are `var(--accent-strong)` and underlined.

**P-13 Nesting.**
- Any kind nests under any kind, with unlimited depth (tested to 3 levels for
  each list kind).
- Each row exposes `data-note-item-id`, `data-note-item-depth` (0-based), and
  `aria-label="Note block: <text or 'Empty'>"`.

**P-14 Numbered list numbering.**
- A `numbered` item's number is its 1-based index within the **run of
  consecutive `numbered` siblings in the same `children` array** that ends at
  it. Any non-numbered sibling restarts the count.
- Nested children don't break the parent-level run. `a` (1), nested child `b`
  (1 at depth 1), `c` (2), `d` (3) **(verified)**.
- The typed number in `N. ` is ignored. Numbering is always positional.
- The number is exposed as `data-note-item-number` on both the row and
  `.note-block`, only for numbered items. Clipboard output uses it.

**P-15 Placeholders.**
- A block shows its placeholder (`data-placeholder`) when it is empty **and**
  either focused or the only block in the note.
- The text is "Type / for styles", or "Heading" for headings, in muted color.

**P-16 Empty note surface.**
- When `note.items.length === 0` (for example after deleting all blocks), the
  body shows `button.note-empty-editor` "Start writing…" (min-height 240 px).
- Clicking it calls `addRootNoteItem`, focuses the new block, and places the
  caret at its end.

**P-17 Checklist toggling.**
- Clicking or pressing Space on a checkbox calls
  `patchNoteItemsDone(noteId, ids, checked)`. `ids` is **all multi-selected
  block ids** if the clicked item is part of the multi-block selection, and
  otherwise `[itemId]`. Cascade rules are in 1.5.
- Clicking a checkbox of a selected row keeps the multi-block selection. The
  toggle is a separate undo step.
- Done items stay in place. They are **not reordered**.
- **There is no keyboard shortcut to toggle done inside Notes.** Mod+D does
  nothing on the Notes page **(verified)**.

**P-18 Internal links (display-only auto-links).**
- The block text is scanned with `linkifyItemText(item.text, listTemplates, metrics, activeNotes)`.
  Matches, earliest first, longest match winning ties and overlaps skipped:
  - Any **list template name** (case-insensitive substring) → list link.
  - Any **metric name** (case-insensitive substring) → metric link.
  - `balance://note/<id>` of an **active** note → note link, labeled with the
    note title.
  - `balance://projects[/<id>]` → projects link, labeled "Project vibes".
  - `balance://goals/stats` → goal stats link.
- Matches render as anchors (P-12 link style) inside the editable text. They
  are recomputed when the text, list names, metric names, or note titles
  change. The focused block is not re-rendered for a link-set change until it
  loses focus.
- **Plain click** on one calls `onOpenLink(link)`, which is App's
  `openLink(link, null)`:
  - note: select the note and switch to Notes (only if it isn't binned).
  - list: ensure today's list instance and open the list overlay.
  - metric: open the metric survey overlay.
  - projects: open Projects.
  - goalStats: open Goals with stats.
- Stored HTML anchors with `balance://` hrefs, for example from pasting a note
  link over selected text, are also internal links.
- Internal-link anchors are never persisted (1.3).

**P-19 External links.**
- A plain click on an `<a href>` with an http/https/file URL, inside a block
  (even while editing), calls `preventDefault`. It opens the URL with
  `openExternalURL(href)` (`src/lib/externalLinks.ts`): native
  `open_external_url`, or `window.open(url, '_blank', 'noopener,noreferrer')`
  in the browser.
- There is no link-editing UI, no hover card, and no Mod+K link shortcut
  (Mod+K is global search).
- Links are created only by pasting (P-45).

**P-20 Images.**
- Handled by the shared `imageEditing` action (`src/lib/imageEditing.ts`),
  attached to every rich-text editor, plus the global `ImageLayer`. That code
  is not Notes-specific and may be reused. See `docs/images.md`.
- Paste a copied image or drop an image file. New images get
  `data-image-layout="left"` and display width `min(natural, 480, editorWidth)`.
- Click to select, which reveals resize handles and layout controls.
  Backspace/Delete removes a selected image. Double-click opens the viewer.
- Drag moves an image and Alt-drag copies it. Moves between blocks are grouped
  into one operation by `plannerStore.moveImage`.
- An image edit commits with `mergeHistory: false`.
- A block containing an image is never considered empty:
  - Enter doesn't reset its kind.
  - Backspace-at-start empty logic doesn't delete it.
  - Markdown autoformat is disabled for it.
- `ImageLayer` hydrates `src` for any `img[data-balance-image]` in the document
  through a MutationObserver. The editor root must be `[data-rich-text-input]`
  for image drop targets (`closest('[data-rich-text-input]')`).

### C. Keyboard inside a block

Unless stated otherwise, these apply when a block editor has focus and there is
no multi-block selection (see section D for selections). "Visual order" means
flattened pre-order.

**P-21 Enter** (no Mod/Alt/Shift, and `!event.isComposing`; IME composition
Enter is never intercepted):

1. **Selection inside the block:** the selected text is deleted first. Then the
   block is split at the collapsed point.
2. **The block is empty** (no non-whitespace text in `before + after`, and no
   image):
   - If the kind isn't `paragraph` (list, quote, or heading): the block is
     converted in place to `paragraph` with `done: false`. It keeps its id,
     position, and children, and the caret stays at its start. No new block is
     created. This is the "exit list/quote" behavior **(tested)**.
   - If the kind is `paragraph`: a new empty paragraph is inserted after it and
     the caret moves into the new block **(tested)**.
3. **Caret at the very start of a non-empty block:** a new empty block of the
   **same kind** (including heading) is inserted **before** it. The original
   block keeps its id and text. **Existing quirk: the caret moves into the new
   empty block above** **(verified)**.
4. **Otherwise** (middle or end): the block keeps the text before the caret,
   and a new block with the text after the caret is inserted as the next
   sibling. It goes after the whole subtree of the current block, and the
   current block keeps its children **(verified)**.
   - The new block's kind is the same as the current block's, except that a
     heading continues as a `paragraph`.
   - Inline formatting is preserved on both halves **(tested)**.
   - The caret goes to offset 0 of the new block.
5. The operation is `splitNoteItem` or, in case 2 for non-paragraphs,
   `patchNoteItem({kind:'paragraph', done:false})`. It is undoable. Undo
   restores the unsplit block **(tested)**.

**P-22 Shift+Enter.** Inserts a soft line break inside the block
(`execCommand('insertLineBreak')`) and commits as a text patch. No new block is
created **(tested)**.

**P-23 Backspace with the caret at the start of a block.** "At the start" means
the collapsed caret has no text, image, or `<br>` before it. A `<br>` before the
caret means native Backspace just deletes that line break.

1. **The kind isn't `paragraph`:** convert to `paragraph` (`done: false`) in
   place, with the caret at the start. Pressing again then merges.
2. **Paragraph that isn't first in visual order:** `backspaceNoteItemAtStart`.
   - If the previous block (in visual order, which may be its parent or a
     nested block) is empty and has no children, **the previous block is
     deleted** and the caret stays at offset 0.
   - Otherwise the text and HTML are **appended to the previous block**, which
     keeps its own kind. The current block's children are appended to the
     previous block's children. The caret goes to the join point, at
     `previous.text.length`.
   - Verified examples: paragraph after a bullet → `BulPara` stays a bullet.
     Nested paragraph under its parent → it merges into the parent.
3. **First block in visual order:**
   - If it has text: nothing happens.
   - If it is empty and it is the only block: it is reset to an empty
     paragraph and keeps focus.
   - If it is empty and other blocks exist: it is deleted with its children
     preserved (`deleteNoteItemPreservingChildren`). Focus goes to the block
     now at its index, with the **caret at the end** **(verified)**.

Backspace does not outdent.

**P-24 Backspace/Meta+Backspace on an empty block.**
- **Meta only** (`metaKey`, with no Ctrl, Alt, or Shift), collapsed caret, and
  the block's stored `text` is empty with no image:
  - If other blocks exist: delete the block, preserving its children, and put
    the caret at the **end of the previous block** in visual order (or the
    first block if none).
  - If it is the only block: reset it to an empty paragraph with the caret in
    it **(tested)**.
- With text, Meta+Backspace is native: it deletes to the start of the line and
  never removes the block **(tested)**.
- Ctrl+Backspace (non-Mac) is always native word deletion.

**P-25 Delete with the caret at the end of a block** (no modifiers, collapsed,
nothing but whitespace or `<br>` after the caret).
- **If there is a next block in visual order, it is merged into the current
  one.** The current block keeps its kind. The next block's text and HTML are
  appended, and its children are appended to the current block's children.
- If the current block is empty and has no children, the current block is
  instead deleted and the caret goes to the next block at offset 0. This
  follows the `backspaceNoteItemAtStart` rules.
- The caret stays at the join point **(tested)**.
- At the end of the last block: nothing happens.

**P-26 Tab / Shift+Tab** (no Mod or Alt; always `preventDefault`, so focus
never leaves the editor):
- **Tab:** find the nearest preceding row in visual order with the **same
  depth**, stopping if a shallower row is reached first. If found, move the
  block, with its subtree, to be that row's **last child**
  (`moveNoteItem(…, 'inside')`). The caret offset is preserved. If not found,
  for example on the first child of a parent, nothing happens. This works for
  every kind, including paragraphs and headings **(verified)**.
- **Shift+Tab on a top-level (depth 0) `bullet`, `numbered`, or `checklist`:**
  convert to `paragraph` (`done: false`) in place, preserving the caret offset
  **(tested)**. This works even when focus is on the block's checkbox. In that
  case the caret goes into the text at its end, and the test expects
  `{text:'', offset:0}` for an empty block.
- **Shift+Tab on a nested block (any kind):** `outdentNoteItem`. The block
  moves after its parent at the parent's level, and **its following siblings
  become its children** **(verified)**. The caret offset is preserved.
- **Shift+Tab on a top-level paragraph, heading, or quote:** nothing happens.

**P-27 Alt+Up / Alt+Down** (Option on Mac; no Mod or Shift):
`moveNoteItemWithinLevel` swaps the block, with its subtree, with the
previous/next sibling at the same level. It is a no-op at the ends and never
crosses levels. Afterwards the caret is placed at the **end** of the moved
block **(verified)**. Only the focused block moves. There is no multi-block
move, and this also clears a multi-block selection.

**P-28 Arrow navigation between blocks.**
- **Up/Down** (no modifiers) when the caret is on the first/last **visual**
  line of the block: move to the previous/next block in visual order.
  - The caret lands on the adjacent block's nearest line: the last line when
    moving up, the first line when moving down.
  - It keeps the **same horizontal pixel column**, which includes list-marker
    indentation. An empty source block uses its content-box left edge as the
    column.
  - The target line is detected with `caretPositionFromPoint` /
    `caretRangeFromPoint`.
  - At a soft-wrap boundary the caret must land on the actual last visual line
    when moving up. Tests cover wrapped paragraphs, empty bullets, and numbered
    items (±6–12 px tolerance).
  - Inside a multi-line block, Up/Down move natively between lines.
  - The line-boundary tolerance is 0.4 × line-height.
  - Empty lines and element-boundary carets must be measurable. Existing bugs
    were fixed here (see R-07).
- **Meta+Up / Meta+Down (Meta only)** always jump to the adjacent block, even
  mid-block. It does not go to the document start or end. Any Up/Down with
  Ctrl held is left entirely native, so non-Mac platforms have no Ctrl
  equivalent.
- **Left at offset 0:** go to the end of the previous block. **Right at the end
  of a block:** go to offset 0 of the next block. At the ends of the document:
  nothing happens.

**P-29 Inline formatting.**
- **Mod+B / Mod+I / Mod+U** (no Alt) toggle bold, italic, or underline on the
  selection, or set typing style at a collapsed caret, using
  `document.execCommand`. The result is committed as a text patch, merged with
  typing.
- Toolbar buttons Bold / Italic / Underline (`aria-label`, `aria-pressed`,
  class `.active`; titles "Bold (⌘B)", "Italic (⌘I)", "Underline (⌘U)") are
  **true toggles**. Applying twice removes the formatting, with no nested
  `<b><b>` **(tested)**.
- The toolbar keeps the editor's selection:
  - `mousedown` on the button calls `preventDefault` and remembers the range.
  - Then the formatting is applied to that range in the block that was last
    focused.
- `aria-pressed` reflects `document.queryCommandState` for the current
  selection inside the active block. It updates on `selectionchange` and
  `keyup`. It is all false when the selection isn't inside the active block.
- No other inline formats exist (1.3).

**P-30 Markdown autoformat.**
- On every input, the **whole block text** is tested, unless the block
  contains an image. `\s` includes NBSP, which contenteditable inserts for
  typed spaces.

| Pattern (whole text) | Becomes |
|---|---|
| `/^#\s(.*)$/s` | heading |
| `/^>\s(.*)$/s` | quote |
| `/^(?:-\|\*)\s(.*)$/s` | bullet |
| `/^[1-9]\d*\.\s(.*)$/s` | numbered (not applied if the block is already a heading, which keeps `1. ` as text **(tested)**) |
| `/^\[\s?\]\s(.*)$/s` (`[] ` or `[ ] `) | checklist (unchecked) |

- Effect:
  - `patchNoteItem({ kind, done: false, html: escapeHTML(rest), text: rest })`.
  - The DOM is replaced with the rest of the text.
  - The caret is placed at `oldCaretOffset − markerLength`, clamped to ≥ 0.
- Because the test is on the whole text, typing the marker **before existing
  text** converts the block, keeps the text, and leaves the caret at offset 0.
  This works for `- `, `* `, `1. `, `[] `, and `[ ] ` **(tested)**.
- Existing quirk: the remaining content is re-escaped as plain text, so
  **inline formatting in the rest of the block is lost** (R-06).
- A marker on an existing list block changes its kind. For example, `> ` in a
  bullet makes it a quote. `2. ` typed in an empty paragraph produced by
  outdenting resumes a numbered list, numbered positionally **(tested)**.
- Undo: the autoformat is merged into the typing burst (1.6). There is no
  separate "undo to literal marker" step.

**P-31 Slash menu.**
- When the **entire** block text matches `/^\/([^\s/]*)$/`, a listbox
  `div.note-slash-menu[role=listbox][aria-label="Note styles"]` appears below
  the block. The query is lowercased.
- Commands, in order:
  - Text (paragraph) — "Plain body text"
  - Heading, aliases `h1`, `header` — "Large section heading"
  - Quote, alias `blockquote` — "Quote a passage"
  - Bulleted list — "Start a simple list"
  - Numbered list — "Start an ordered list"
  - Checklist — "Track something to do"
- They are filtered by case-insensitive substring of the label or aliases. For
  example `/li` shows Bulleted list, Numbered list, and Checklist
  **(verified)**. With zero matches, no menu is shown and the text stays
  literal.
- Options: `button[role=option][aria-selected]`, with `.active` on the
  highlighted one. Each has a `.note-slash-icon` (Aa, H, quote SVG, •, 1., ✓),
  a `<strong>` label, and a `<small>` hint.
- Keys:
  - **Down/Up** cycle the highlight with wrap-around (overriding block
    navigation).
  - **Enter** applies the highlighted command.
  - **Escape** closes the menu and leaves `/query` as text.
- Mouse: `mousedown` (with `preventDefault`) on an option applies it.
- Applying calls `patchNoteItem({ kind, done: false, html: '', text: '' })`.
  The block is emptied and the caret goes to its start.
- The menu closes 150 ms after the block blurs, and when the text stops
  matching.
- Positioning: below the block (top + 4 px), clamped inside both the
  `.note-document` rectangle and the viewport with 8 px gaps. It accounts for
  CSS zoom, and repositions on resize and scroll. Size: width
  `min(310px, 100vw − 48px)`, max-height `min(320px, 100dvh − 16px)`, scrolls.
  A test asserts it stays inside the viewport and the `.notes-workspace`
  bottom.

**P-32 Toolbar block-kind buttons.**
- `div.note-format-toolbar[role=toolbar][aria-label="Note formatting"]`
  contains four `.note-format-group`s:
  - Text style: "Aa" (`aria-label="Text"`) and "H1" (`aria-label="Heading"`,
    `title="Heading (# then Space)"`).
  - Quotes: an SVG button (`aria-label="Quote"`,
    `title="Quote (> then Space)"`).
  - Lists: "•" (`aria-label="Bulleted list"`, `title="Bulleted list (- then Space)"`),
    "1." (`aria-label="Numbered list"`, `title="Numbered list (1. then Space)"`),
    and "✓" (`aria-label="Checklist"`, `title="Checklist ([] then Space)"`).
  - Inline formatting: Bold, Italic, Underline.
- After the groups: `span.note-format-hint` "Type <kbd>/</kbd> for more". The
  slash is an SVG with `role=img` and `aria-label="Slash"`. The hint is hidden
  on mobile.
- A kind button shows `.active` when the **toolbar target block** has that
  kind. The target is the last-focused block, defaulting to the note's first
  block.
- Clicking a kind button:
  1. `patchNoteItem(target, { kind, done: kind === 'checklist' ? currentDone : false })`.
     This is **not a toggle**: clicking Bulleted list on a bullet leaves it a
     bullet. Converting a checked checklist to bullet and back gives an
     unchecked checklist **(verified)**.
  2. Focus the block with the caret at its **end**.
- If the note has no blocks, a block is added first.
- It is a separate undo step, so undo reverts only the kind **(tested with
  Quote)**.

**P-33 Select all (Mod+A, no Alt/Shift).**
- If the note has more than one block **and** the current block's text is
  already fully selected (offset 0 to end), all rows become multi-selected
  (section D).
- Otherwise it is native: select all text within the current block only.
- So Mod+A twice selects all blocks **(tested)**. With a single block, Mod+A
  never produces a row selection **(verified)**.
- Mod+A also clears any cross-block text highlight.
- App's Mod+A and Mod+Shift+A item-selection shortcuts are inactive on the
  Notes page.

**P-34 Escape.**
1. If the slash menu is open: close it.
2. Else, if there is a multi-block row selection: clear it.
3. Else, if there is a cross-block text selection: collapse it to its **end**
   point with the caret there.
4. Else: nothing happens in Notes. App may use Escape to close the find bar,
   search, and overlays first. On Android, the hardware Back key dispatches
   Escape to `document.activeElement`. If the Escape isn't default-prevented,
   App then opens the navigation drawer.

**P-35 Other keys.**
- Home, End, Page Up/Down, and word/line deletion are native.
- **W/S hold-to-scroll** is Today-only.
- `?` is ignored while a rich-text editor has focus. Mod+/ or Alt+/ opens the
  shortcuts reference anywhere.
- App's time and probability bracket shortcuts, Alt+F, and Mod+D are inactive
  in Notes.

### D. Multi-block selection

There are two distinct selection models. WebKit clamps a native DOM selection
to one contenteditable host when list decoration sits between editors, so the
existing implementation keeps its own selection state.

- **Text selection across blocks** ("cross-block text selection"): an exact
  character range from a point in one block to a point in a later block. It is
  painted with the CSS Custom Highlight named **`balance-note-selection`** over
  every intersecting block fragment. While active, `.note-blocks` gets class
  `note-text-selection`, which makes native `::selection` transparent. It is
  used when **neither endpoint block is a list item** (bullet, numbered, or
  checklist).
- **Row selection** ("item selection"): a contiguous range of rows in visual
  order, from an anchor row to a focus row. Each selected row gets class
  **`note-multi-selected`**, with a background of `var(--accent)` at 24% and
  radius 5 px on `.note-block`. The native selection is cleared. It is used
  when **either endpoint block is a list item**, and for Mod+A-twice (any
  kinds). A range with anchor equal to focus means no selection.

**P-36 Mouse drag** (mouse or pen, primary button; touch uses native selection
only).
- Press in a block and drag into another block.
  - Text selection updates live if no list is involved.
  - Otherwise it becomes a row selection with the native selection cleared
    **(tested)**.
- Forward and reverse drags both work.
- On release, the selection is re-applied, and again on the next frame, to
  defeat WebKit clamping. After a pause it must still be intact. The test waits
  1200 ms, then Backspace deletes the full range.
- Pressing anywhere (not Shift) clears existing selections, except a press on
  the checkbox of a selected row. Clicking elsewhere and typing affects only the
  new caret, and the highlight is removed **(tested)**.

**P-37 Shift+click.**
- Extends from the current anchor to the clicked point. The anchor is the
  tracked row-selection anchor, or else the native selection anchor.
- If a list is involved, it produces a row range. Otherwise it produces a text
  range.
- Shift-clicking again re-ranges from the same anchor. For example, it can
  shrink from 3 rows to 2 **(tested)**.

**P-38 Keyboard extension.**
- **Shift+Up/Down, when the selection focus is on the block's first/last visual
  line:**
  - If the current or adjacent block is a list item: row selection extends or
    shrinks by one row. The caret is placed at the start or end of the new
    focus row. Shrinking back to the anchor clears it **(tested)**.
  - Otherwise: text selection extends to the **same character offset**
    (clamped) in the adjacent block, or to the block's start or end if there is
    no adjacent block. It can continue through several blocks and shrink again
    **(tested: `pha\nMiddle\nBe` → `pha\nMi`)**.
- **Shift+Left at offset 0 / Shift+Right at the end:** extends a text selection
  across the block boundary. For example, selecting the boundary and typing a
  space joins `Alpha Beta` **(tested)**.
- Once a cross-block text selection exists, every Shift+Arrow is handled by the
  note code:
  - Horizontal moves go by character (by line boundary with Meta).
  - Vertical moves go by line, crossing into the adjacent block at the same
    offset at boundary lines.
- **Meta+Shift+Up/Down:** extends the selection to the start of the first block
  or the end of the last block (the whole document). This applies only when no
  row selection exists.

**P-39 Acting on a cross-block text selection, or on a row selection.** A row
selection is treated as the range from the start of its first block to the end
of its last block.

| Action | Result |
|---|---|
| Typing a character (`beforeinput` `insertText` / `insertReplacementText`) | Replace the range with the character. The start block keeps its kind, and later blocks in the range are removed with their children hoisted. `AlXta` **(tested)**. Row selection: all selected rows are replaced by one block containing the character **(verified)**. |
| Backspace / Delete / Meta+Backspace | **Text selection:** delete the range and merge the remainder into the start block, giving `Alta` with the caret at the join **(tested)**. **Row selection:** Backspace/Delete deletes all selected rows **with their subtrees** (`deleteNoteItems`). The caret goes to the end of the block now at the first deleted index. Deleting every row shows "Start writing…" **(tested)**. |
| Enter | Replace the range with a block boundary: `['Al','ta']`. The second block has the start block's kind, or paragraph if the start was a heading. |
| Shift+Enter | Replace the range with a soft line break: `Al\nta` **(tested)**. |
| Paste | See P-43. The selection is replaced. |
| Cut | Copy (P-41), then delete as for Backspace. |
| Copy | P-41. |
| Escape | Clears a row selection. A text selection collapses to its end. |
| Arrow without Shift | **Text selection:** collapse to the start (Left/Up) or end (Right/Down) and place the caret there. **Row selection:** clear the selection, then native caret movement **(verified)**. |
| Tab / Alt+Arrow / other non-character keys with a row selection | Clear the selection, then the key acts on the focused block only **(verified)**. There is no multi-block indent or move. |
| Mod+Z | App undo. The note selection state is cleared. |
| Checkbox click on a selected row | Toggles **all** selected rows (P-17), and the selection is kept. |

All replace operations go through `replaceNoteItemRange` or `deleteNoteItems`
as **one undo step**. Undo restores the original blocks, and redo reapplies
**(tested for each action)**.

### E. Clipboard

**P-40 Clipboard formats** (`src/lib/noteClipboard.ts`).

Block descriptor used for copying:
`NoteClipboardBlock = { kind, depth, html, text, done, number }`, where `number`
is the displayed number.

**Plain text** (`noteClipboardPlainText`):
- Blocks are joined with `\n`.
- Each line is `indent + marker + text`:
  - `indent` is 2 spaces per depth level relative to the shallowest block.
  - Markers:
    - quote: `> `
    - bullet: `- `
    - numbered: `N. ` (displayed number)
    - checklist: `☐ ` or `☑ ` (U+2610, U+2611)
    - paragraph and heading: none. There is no `# `.
- `text` is `htmlToPlainTextWithBreaks(html)`.
- Internal newlines continue with `indent + spaces(marker.length)`.
- Examples:
  - `- Alpha\n- Beta\n  Beta continuation\n- Gamma`
  - `☐ Alpha\n☐ Beta`
  - `> A quoted passage`

**HTML** (`noteClipboardHTML`):
- The blocks are rebuilt into a forest by depth.
- Consecutive root/sibling blocks with the same list tag are grouped: bullet
  and checklist go in `<ul>`, numbered in `<ol>`.
- List items are `<li>` + (`☑ ` / `☐ ` for checklists) + inline HTML +
  rendered children.
- Non-list blocks: heading → `<h1>`, quote → `<blockquote>`, paragraph → `<p>`.
  Empty content is written as `<br>`. Children of a non-list block are rendered
  **after** it as siblings.
- Inline HTML has **`<br>` replaced by a literal `\n`** (for Notion
  compatibility).
- Finally `imageClipboardHTML` embeds image bytes as `src` data URLs, with
  `data-image-source-width/height`.
- Examples:
  - `<ul><li><strong>Alpha</strong></li><li>Beta\nBeta continuation</li><li>Gamma</li></ul>`
  - `<blockquote>A quoted passage</blockquote>`

**P-41 Copy (Mod+C / Edit menu).**
- Handled when the document `copy` event fires with **either**:
  - A row selection of 2 or more rows, where each row is copied whole.
  - A non-collapsed range whose endpoints are inside note blocks: a
    cross-block text selection, or a native range in a single block. Each
    intersecting block contributes the selected fragment of its HTML.
- **Unless** the result is a single block that isn't a quote and has no
  `<br>`. That case is left to the browser's native copy. A partial selection
  within one paragraph is copied natively **(verified)**.
- When handled:
  - `preventDefault`.
  - `text/plain` and `text/html` are set per P-40.
  - **Natively (Tauri):** also `invoke('write_note_clipboard', { plainText, html: "<meta charset='utf-8'>" + html })`
    in a `setTimeout`. This writes the HTML directly to the macOS pasteboard,
    because WKWebView's clipboard event HTML isn't reliable. Errors are
    ignored.
- If the selection contains an image, the image action's copy handler runs
  first. It writes `application/x-balance-inline-images` plus HTML and plain
  text (`U+FFFC` if there is no text), then stops propagation.

**P-42 Cut.** Runs the copy logic. If handled, it then:
- For a row selection: deletes the rows (`deleteNoteItems`). For example,
  cutting two checklist rows yields `☐ Alpha\n☐ Beta` and 0 rows remain
  **(tested)**.
- Otherwise: deletes the range as in P-39.

**P-43 Paste** (`paste` in the capture phase on `.note-blocks`). Precedence:
1. If the clipboard holds a direct image file (and no textual HTML), or the
   `application/x-balance-inline-images` type, it goes to the image handler
   (P-20).
2. The target must be inside a block editor.
3. `stageClipboardImages(html)` registers embedded images so references
   persist.
4. `items = parseNoteChecklistClipboard(plain, html)`:
   - If the HTML parses to 2 or more blocks, **all** checklists, those are used.
   - Otherwise the plain text is parsed for lines of the form
     `^(\s*)([☐☑])(\s+|$)(.*)$`. The depth is the indent width, where a tab
     counts as 2. Nesting follows increasing indentation. Non-matching,
     non-blank lines are continuation lines, appended as `<br>` + text.
   - This is used only if it yields 2 or more blocks in total.
5. If that yielded nothing and there is **no HTML**:
   `parseNotePlainTextClipboard(plain)`. With 2 or more lines (split on
   `\r?\n`), **every** line becomes a `paragraph`, blank lines included.
6. If that yielded nothing and there **is HTML**:
   `parseNoteClipboardHTML(html)` over the top-level `<body>` children:
   - `ul`/`ol` produce `bullet`/`numbered` items per `li`. Nested lists become
     children. A `ul > li` whose first text starts with `☐`/`☑` (plus
     whitespace) becomes a `checklist` with `done` set, and the marker is
     removed.
   - `p` and `div` become paragraphs, `h1`–`h6` a heading, and `blockquote` a
     quote.
   - **Other top-level nodes are ignored**, including bare text, `span`, and
     `table`.
   - It is used only if it yields 2 or more blocks.
7. **Fewer than 2 blocks:**
   - With a cross-block or row selection: replace the selection with
     `sanitizeInlineHTML(html)`, or with escaped plain text where `\n` becomes
     `<br>`.
   - Otherwise it is a native in-block paste (P-44).
8. **2 or more blocks** (`replaceNoteItemRange`):
   - The HTML before the caret or range start is prepended to the first pasted
     block.
   - The HTML after the caret or range end is appended to the **last** pasted
     block in flattened order, which may be a nested child.
   - The first pasted block's **kind and done replace the host block's**. For
     example, pasting two plain lines into a bullet turns the host into a
     paragraph **(verified; R-08)**.
   - The remaining blocks are inserted after it, and pasted children are nested.
   - The caret goes to the end of the pasted text in the last block.
   - Examples:
     - `AlphaBeta`, caret at 5, pasting `One\nTwo` gives
       `['AlphaOne','TwoBeta']` with the caret at `{index 1, offset 3}`
       **(tested)**.
     - With 2–7 selected, it gives `['AlOne','Twota']` and keeps
       `<b>One</b>` **(tested)**.
     - `<ul><li>Alpha</li><li>Beta</li></ul>` gives 2 bullets **(tested)**.
     - `<p>Alpha</p><p>Beta</p>` gives 2 paragraphs **(tested)**.
   - Copied checklist rows re-paste as checklists with their states, whether
     from plain text or HTML **(tested)**.
   - Copied quote HTML pastes as a quote.
   - The paste is one undo step.

**P-44 Native in-block paste** (single-block or single-line content).
- If the plain text is a URL (http/https/file), a `balance://note/…`,
  `balance://projects…`, or `balance://goals/stats` link, **and** there is a
  non-collapsed selection inside the block: the selected text becomes a link
  to it (`execCommand('createLink')`) **(verified; tested for note links)**.
- Otherwise: insert `linkifyExternalURLs(html || escapeHTML(plain).replace(/\r?\n/g, '<br>'))`
  at the caret. Bare `http(s)` URLs become external links, with trailing
  punctuation excluded **(verified: `see <a …>https://example.com/x</a>. ok`)**.
  Formatting is sanitized per 1.3.
- The commit has `mergeHistory: false`, so it is a separate undo step.

**P-45 Paste and Match Style** (Mod+Alt+Shift+V).
- Browser: App's keydown calls `pasteSystemClipboardAsPlainText`.
- macOS app: the native Edit menu item, which emits `PASTE_MATCH_STYLE_EVENT`.
- It reads the system clipboard and dispatches
  `CustomEvent('balancepaste', { detail: { plainText, html: null } })` on the
  **focused `[data-rich-text-input]` element**. The editor must handle this
  event by inserting the plain text (linkified, per P-44). The existing
  handler inserts it inline even when it has several lines, **without**
  splitting into blocks.
- The same event is also used by the image action for `imageDataURL` details.

### F. Persistence, undo, caret

**P-46 Commit-per-keystroke and coalesced undo.** See 1.6 and 1.7. Keyboard
shortcuts are handled by App: Mod+Z undoes, and Mod+Shift+Z or Mod+Shift+C
redoes. Tests show them working for kind changes, splits, cross-block edits,
pastes, Bin, Delete now, and Empty Bin.

**P-47 Undo reveals the change.** App switches to Notes, selects the affected
note, and opens the Bin if the note is binned there. It scrolls
`.note-document` into view. On mobile it shows `.history-notice`, for example
"Undid item change · <note title>". See 3.1 for why the row isn't targeted
today.

**P-48 Caret and scroll restore per note** (1.9). After visiting another page
and returning, the previously focused block is focused with its exact selection
offsets, and the scroll position is restored exactly **(tested)**.

**P-49 Caret restore after app or window switch.**
- If the window loses focus while a block is being edited, the caret position
  from the **last trusted interaction** (the last `input`, `keyup`, or
  `pointerup` in the block) is restored when focus returns. The restore runs
  after a rAF, at 0 ms, and at 75 ms.
- It even works if the webview collapsed the selection to offset 0 before
  delivering `blur`. Test: typing `x` at 5, blurring with the selection
  collapsed to 0, then refocusing puts the caret at 6 **(tested)**.
- The same applies to `visibilitychange: hidden`.

**P-50 Remote updates** (1.8).

### G. Scrolling and layout

**P-51 Sticky toolbar.**
- Desktop: `position: sticky; top: 8px` inside `.note-document`. It stays
  8–48 px from the scroller top while scrolling, and its offset varies by at
  most 1 px **(tested)**.
- The Iridescent theme uses a static 1 px pink border
  (`var(--iridescent-border-pink)`). There is no animated `::after` ring on the
  toolbar **(tested)**.
- Mobile: `top: calc(var(--mobile-header-height) + 4px)`, full width.

**P-52 Bottom writing space.**
- `div.note-scroll-space` sits below the blocks, inside `.note-document`. Its
  height is `max(56px, share% × scroller clientHeight)`.
- The slider is `input[type=range].note-scroll-space-native-slider`, 0–100,
  step 1, `aria-label="Bottom writing space"`,
  `aria-valuetext="<share with 1 decimal>% of note area"`. It is painted with
  `.note-scroll-space-track`, `-fill`, and `-thumb`.
- Share mapping:
  - 0 → 6%.
  - 60 → 31.2% (the default).
  - 100 → 49.2%.
  - Piecewise linear between those points.
- It is persisted in `localStorage['balance:noteScrollSpacePercent']`. The
  legacy `balance:noteScrollSpaceVh` value is migrated and removed on mount.
- The control `label.note-scroll-space-control` is `.visible` (opacity 1)
  **only** when the scroller is within 4 px of the bottom, or while dragging.
  Otherwise it has opacity 0 and `visibility: hidden`, with a 180 ms fade.
- Changing the value while at the bottom keeps the scroller at the bottom.
- It is hidden on mobile.
- Dragging this slider must **not** trigger native haptics. Other app sliders
  do (test in `balance.spec.ts`).

**P-53 Follow the bottom while typing.**
- If the scroller is at the bottom (within 4 px) when Enter, Backspace, Delete,
  or Tab is pressed, or a `beforeinput` happens in a block, the scroller is
  scrolled to the bottom again after layout.
- When a collapsed caret moves onto the **last visual line of the last block**
  and the scroller isn't at the bottom, it scrolls to the bottom **(tested)**.
- Pressing Enter at the end of a long note leaves the view at the bottom
  **(tested)**.
- If the user has scrolled up, typing does not force the scroll position
  **(tested)**.

**P-54 Mobile layout (≤760 px).**
- The sidebar becomes a horizontal, scrollable strip of cards
  (`grid-auto-flow: column`, cards `minmax(180px, 70vw)`).
- The document flows in the page and scrolls with the page, with
  `overflow: visible` and padding `0 12px 28px`.
- Goal Rhythm is not shown on the Notes page on mobile.
- Touch selection is native. The note's mouse selection logic ignores touch.

**P-55 Mobile toolbar docking** (`mobileNoteToolbar` action).
- Condition: `(max-width: 760px)`, the focused element is a block editor
  (`[data-note-text-input]` inside the toolbar's parent) or inside the toolbar,
  **and** the keyboard is open (`fullHeight − visualViewport.height > 100`).
- While docked:
  - The toolbar node is moved to `document.body`, and a spacer of equal height
    is left behind.
  - It gets `position: fixed; z-index: 25`.
  - It is placed 8 px above the visual viewport's bottom and 8 px inset left
    and right, divided by `currentCSSZoom`. It tracks `visualViewport`
    resize and scroll.
  - `pointerdown` on its buttons calls `preventDefault`, so tapping Bold
    doesn't dismiss the IME or blur the editor **(tested)**.
- When the keyboard closes, it is restored to the sticky position.

**P-56 Mobile keyboard scroll** (`installMobileKeyboardScroll`, app-wide, for
`(pointer: coarse)`).
- It keeps the caret visible above the keyboard.
- **For note blocks** (`editor.matches('[data-note-text-input]')`), it treats a
  fixed `.note-format-toolbar` as the bottom edge.
- It adds temporary `padding-bottom` to scrollers.
- Test: the caret stays between 136 px and the toolbar top minus 16 px.

### H. Integration features

**P-57 Global search** (Mod+K or Alt+C).
- `search.ts` indexes non-binned notes by title plus item `text` and returns
  `{ kind: 'note', noteId, itemId }`.
- Opening a result:
  1. Sets `selectedNoteId` and switches to Notes.
  2. Waits a tick and one rAF.
  3. Finds `[data-note-item-id="<itemId>"]` in `.workspace`.
  4. Scrolls it to the center of its scroll container.
  5. Adds class `search-result-target` for 1800 ms, a highlight animation on
     the row element.

**P-58 Document find** (Mod+F, the `DocumentFindBar`).
- A DOM-text find over all visible text nodes in `document.body`. Matching is
  case-insensitive, and runs of text within the same block-level element are
  concatenated.
- The active match is highlighted with the CSS highlight
  `balance-document-find-match` plus overlay rectangles. Matches are
  re-computed through a MutationObserver after 100 ms.
- Enter goes to the next match and Shift+Enter to the previous one.
- The editor text must be real, visible DOM text. There must be no
  canvas-rendered text and no `aria-hidden` on content. Stable text nodes
  between keystrokes keep the active match.

**P-59 Links into notes from elsewhere.** A `balance://note/<id>` link in any
item (plan, list, list template) opens the note (P-18). Tests: `notes.spec.ts`,
`list-overlay-edit.spec.ts`.

**P-60 Keyboard shortcuts reference.** `KeyboardShortcutsModal.svelte`
currently lists **only** "Create note (while in Notes)" (Mod+N) for Notes, plus
the general Mod+Z, Mod+Shift+Z, Mod+F, Mod+K, and Alt+I entries. Per
`AGENTS.md`, adding or changing a shortcut in `handleGlobalKeydown` requires
updating the modal. Editor-local shortcuts are not currently listed.

### I. Performance characteristics (existing)

**P-61**
- There is no virtualization and no `content-visibility`. Every block is its
  own `contenteditable` element, rendered recursively.
- Each keystroke commits one store update, which replaces the note object, and
  re-runs `linkifyItemText` for every block. Unchanged blocks don't touch their
  DOM, because the editor only writes `innerHTML` when the content differs.
- Each commit also does the following work:
  - Computes `entityChangesBetween` (JSON comparison of the changed note).
  - Re-renders the sidebar list (sort, flattened text for filter and preview).
  - In browser mode, serializes the whole state to `localStorage`.
- Constraint from `AGENTS.md` (Goal Rhythm containment): note edits must not
  cause `buildGoalDayCells` calls or restyle Goal Rhythm. Notes code must not
  animate inherited CSS variables on `:root` or `body`.

---

## 3. Host integration points

### 3.1 How `NotesPanel` is mounted (`src/App.svelte`)

It is rendered only while `view === 'notes'`, so it unmounts on page switch.
Inside `div.workspace.notes-view-workspace` it comes after
`header.page-header.imax-page-header.notes-page-header`, which contains
`h2` "Notes", `.notes-page-actions`, the Bin toggle, and `ImaxButton`.

```svelte
<NotesPanel
  bind:this={notesPanel}
  bind:trashOpen={notesTrashOpen}
  notes={allNotes}                       <!-- ALL notes incl. binned -->
  {selectedNoteId}
  {listTemplates}
  {metrics}
  historyRevision={$plannerStore.historyRevision}
  viewStatesByNote={noteViewStatesById}  <!-- Map<Id, NoteViewState>, in-memory -->
  onViewStateChange={rememberNoteViewState}
  onSelect={(noteId) => (selectedNoteId = noteId)}
  onCreate={plannerStore.addNote}
  onTrash={binNote}                                  <!-- (id) => boolean -->
  onRestore={plannerStore.restoreNote}
  onPermanentlyDelete={confirmPermanentlyDeleteNote} <!-- (id) => Promise<boolean> -->
  onEmptyTrash={confirmEmptyNoteTrash}               <!-- () => Promise<boolean> -->
  onRename={plannerStore.renameNote}
  onAddItem={plannerStore.addRootNoteItem}
  patchItem={plannerStore.patchNoteItem}
  patchItemsDone={plannerStore.patchNoteItemsDone}
  splitItem={plannerStore.splitNoteItem}
  backspaceItemAtStart={plannerStore.backspaceNoteItemAtStart}
  deleteItems={plannerStore.deleteNoteItems}
  replaceItemRange={plannerStore.replaceNoteItemRange}
  deleteItemPreservingChildren={plannerStore.deleteNoteItemPreservingChildren}
  moveItem={plannerStore.moveNoteItem}
  moveItemWithinLevel={plannerStore.moveNoteItemWithinLevel}
  outdentItem={plannerStore.outdentNoteItem}
  onOpenLink={(link) => openLink(link, null)}
/>
```

(The uncommitted worktree also passes `editor={noteEditorChoice}`.)

Prop types, as declared in `NotesPanel`:
- `notes: Note[]`
- `selectedNoteId: Id`
- `listTemplates: ListTemplate[] = []`
- `metrics: Metric[] = []`
- `historyRevision = 0`
- `onSelect(noteId)`
- `onCreate(): Id`
- `onTrash(noteId): boolean | Promise<boolean>`
- `onRestore(noteId)`
- `onPermanentlyDelete(noteId): boolean | Promise<boolean>`
- `onEmptyTrash(): boolean | Promise<boolean>`
- `onRename(noteId, title)`
- `onAddItem(noteId, kind?): Id`
- The store functions above, typed as `typeof plannerStore.<fn>`
- `onOpenLink(link: ItemLink)`
- `trashOpen = false` (bindable)
- `viewStatesByNote: ReadonlyMap<Id, NoteViewState> = new Map()`
- `onViewStateChange(noteId, state) = () => {}`

Exported methods that App calls:
- `createNote()` (Mod+N).
- `showNotes()`: leave the Bin, clear the filter, and select the last active
  note or the first.
- `openTrash()`: enter the Bin, clear the filter, and select the last Bin note
  or the first.

App state and reactivity:
- `selectedNoteId` fallbacks: `if (!selectedNoteId && notes[0]) selectedNoteId = notes[0].id`,
  and when the selected note no longer exists → `notes[0]?.id ?? ''`, where
  `notes` holds the non-binned notes in store order.
- App selects a note (and switches view) in these places:
  - `openLink` (note links; only non-binned notes).
  - `openSearchResult` (P-57).
  - `revealHistoryDestination` (undo/redo). It also sets `notesTrashOpen`
    according to whether the note is binned.
- **Undo reveal quirk:** `revealHistoryDestination` looks for
  `[data-note-item-id="<id>"][data-item-container-id="<noteId>"]`. Existing
  note rows have **no** `data-item-container-id`, so it always falls back to
  scrolling `.note-document` into view. Adding
  `data-item-container-id="<noteId>"` to each note row element carrying
  `data-note-item-id` would enable row reveal and App's
  `restoreTreeEditorSelection`. The latter also requires
  `data-rich-text-input-id` on the focused editor. This is optional; parity
  only requires `.note-document` to be in the viewport.

`handleGlobalKeydown` (window **capture**, so it runs before every editor
handler) on the Notes page:

- **Consumed by App**, with `preventDefault` and no `stopPropagation`, so
  editors still receive them:
  - Mod+Z (undo), Mod+Shift+Z and Mod+Shift+C (redo).
  - Mod+K and Alt+C (search).
  - Mod+F (document find).
  - Mod+Shift+P (recovery panel).
  - Mod+Shift+G (generate day).
  - Alt+A (Goal Rhythm), Alt+I (IMAX).
  - Alt+D/N/P/V/Y/S/E/R/T/G (page navigation), Alt+Q/W (not on Notes).
  - Mod+/ and Alt+/ (shortcuts reference).
  - Escape while search, find, shortcuts, the drawer, or the recovery panel is
    open.
- **Mod+N:** `preventDefault` **and `stopPropagation`**. The editor never sees
  it.
- **Suppressed entirely** while any of these is showing: an image dialog,
  database loading or error, the backup browser, a celebration preview, the
  paste review, the shortcuts modal, or search. App returns early without
  preventing the key. In that case editors still receive keys, except those App
  explicitly prevents.
- **Selected image:** if `$selectedImage.editor === event.target` and the key is
  Backspace, Delete, Escape, or an arrow, App returns early. The image action
  handles those keys.
- **Plain `?`:** ignored when `document.activeElement.matches('[data-rich-text-input]')`
  (`isRichTextActive`), or when an `input`, `textarea`, or `select` is focused.
- **Plan item-surface handlers** (`activeItemSurface()` returns `null` on
  Notes) are inactive: item selection, Mod+A, Mod+C/X/V, Tab, Alt+Arrow, time
  and bracket shortcuts, Mod+D, `handleNativeEditorPaste`, and W/S scroll.
- **Alt shortcuts on macOS:** Option changes `key`. App keys off `event.code`,
  and native macOS Option shortcuts are re-dispatched as synthetic `keydown`
  events on `document.activeElement` (`dispatchMacosAltShortcut`). Editors
  should also use `event.code` for Alt+letter.

App markers and checks that editors must satisfy:
- `[data-rich-text-input]` on each focusable editable element. It is used by
  `isRichTextActive`, `hasActiveRichTextSelection`,
  `pasteSystemClipboardAsPlainText`, the image action, and `ImageLayer` CSS.
- `[contenteditable="true"]` is checked by `canKeyboardScroll` and
  `handleGlobalFocusIn`.
- `[data-note-text-input]` on the focused editable element. It is used by
  `mobileKeyboardScroll.ts` (toolbar-aware padding), `mobileNoteToolbar.ts`
  (docking), and the tests.
- `.note-format-toolbar` (mobile docking and keyboard scroll).
- `.note-document` (scroller, reveal target), `.workspace`, and
  `.notes-view-workspace` (zoom).
- The editor element must accept the custom events **`balancepaste`**
  (`detail: { plainText: string | null; html: string | null }`) and
  **`balanceformat`** (`detail: { command: 'bold' | 'italic' | 'underline' }`).
  The toolbar dispatches the latter in the existing panel.

### 3.2 CSS variables and theme tokens used by the Notes UI

Defined on `:root` and per theme in `src/app.css`. Values are chosen by
`src/lib/themes.ts` and the theme CSS blocks. The notes UI must use tokens, not
literal colors:

- Surface and text: `--paper`, `--paper-strong`, `--ink`, `--muted`, `--line`,
  `--line-strong`, `--sidebar`, `--active-nav`, `--shadow`, `--focus-ring`.
- Accent: `--accent`, `--accent-strong`, `--accent-soft`.
- State: `--danger`.
- Checkbox: `--checkbox-checked`, `--checkbox-checked-hover` (derived from
  `--theme-checkbox`), and `--done-tint`. `.check` is the shared checkbox
  style.
- Fonts: `--font-content` (block text, title, empty editor), `--font-interface`.
- Layout: `--notes-page-zoom` (1.1), `--notes-page-zoom-inverse`,
  `--mobile-header-height`, `--imax-page-header-min-height`.
- Panel-local: `--note-scroll-space-height`, `--note-scroll-space-progress`.
- Iridescent theme: `--iridescent-border-pink`, `-aqua`, `-gold`, and
  `--iridescent-border-angle`. `.notes-workspace`, `.note-trash-notice`,
  `.note-scroll-space-control`, and `.note-slash-icon` get the animated
  conic-gradient `::after` ring. `.notes-workspace::after` uses `inset: 0`
  because it clips. `.note-format-toolbar` gets a static pink border instead.
  The Goal Rhythm containment rules in `AGENTS.md` apply: animation stays on
  pseudo-elements, never on inherited variables.
- Selection colors:
  - `.note-multi-selected > .note-block` uses
    `color-mix(in srgb, var(--accent) 24%, transparent)`.
  - `::highlight(balance-note-selection)` uses `var(--accent)` at 30%.
  - Search and find use `.search-result-target` and
    `::highlight(balance-document-find-match)`.

### 3.3 Class names, attributes, and strings other code depends on

**Tests (`tests/visual/notes*.spec.ts`, `images.spec.ts`, `balance.spec.ts`,
`undo-navigation.spec.ts`, `list-overlay-edit.spec.ts`,
`mobile-navigation.spec.ts`) and the Android stress script
(`.github/scripts/android-interaction-stress.mjs`):**

- **Shell:**
  - `.notes-view-workspace`, `.notes-page-header`, `.notes-page-actions`.
  - `.notes-trash-header-button`: a button named "Bin", with `aria-pressed`.
  - `.notes-workspace`, `.notes-sidebar`, `.notes-list`.
  - `.note-card` (`.active`, and `.note-card.active strong` holds the title).
  - `.note-new`: button "New", with `aria-keyshortcuts="Control+N Meta+N"` and
    a `kbd` matching `/^(Ctrl\+|⌘)N$/`.
  - `.notes-filter`: searchbox named "Filter notes".
  - `.note-empty`, and `.note-empty button.primary` "+ New note".
- **Document:**
  - `.note-document`, `.note-title`: `getByLabel('Note title')`, with
    `id="note-title"`.
  - `.note-actions`: buttons "Copy note link", "Bin it", "Restore",
    "Delete now". `.note-actions .danger` and `.note-actions .primary`.
  - Text "Link copied!".
  - Headings "Bin is empty" and "Recoverable thought" (the trashed title as a
    heading).
  - A `role=status` element containing "Permanently deleted in 30 days".
  - `.note-readonly-blocks`, and the button "Empty Bin".
  - The button "Back to Notes".
- **Toolbar:** role `toolbar` named "Note formatting", with buttons named
  "Text", "Heading", "Quote", "Bulleted list", "Numbered list", "Checklist",
  "Bold", "Italic", "Underline" (Bold, Italic, and Underline have
  `aria-pressed`). Also `.note-format-hint` and `.note-format-hint kbd`.
- **Blocks:**
  - `.note-blocks`, and `.note-item`, whose class list includes
    `note-heading`, `note-quote`, `note-list-item`, `note-bullet`,
    `note-numbered`, `note-done`, or `note-multi-selected`.
  - `[data-note-item-id]`, `[data-note-item-depth]`, `[data-note-item-number]`.
  - `.note-item[aria-label="Note block: <text>"] > .note-block > .note-check`.
  - `.note-block`, with a solid `border-left-style` for quotes.
  - `.note-check`: role checkbox named "Mark checked" or "Mark unchecked".
  - `[data-note-text-input]`, also reachable as `getByLabel('Note text')`.
    Tests use `.fill()`, `.type()`, `.press()`, `toHaveText`, and
    `useInnerText`. They expect the element to be `contenteditable`. It is
    labelled "Note text", and its text equals the block text.
- **Other:**
  - `button` "Start writing…".
  - Listbox "Note styles" with `.note-slash-menu`.
  - `.note-scroll-space`, `.note-scroll-space-control` (`.visible`),
    `.note-scroll-space-track`, `-fill`, and `-thumb`.
  - `getByLabel('Bottom writing space')`.
  - CSS highlight name `balance-note-selection`.
  - `.note-empty-editor`.
- **Heading typography:** the heading text is 25 px.
- **Body typography:** font-size 15 px, `min-height` 30 px, line-height
  25.5 px.
- **Italic:** `fontSynthesis: 'style'`.

**App and search depend on:**
- `[data-note-item-id]` on the row (search target, and the undo reveal
  attempt).
- `.note-document` and `.workspace`.
- `search-result-target` (a class added to the row).

### 3.4 Files that constitute the "old Notes editor" (do not read)

Notes UI implementation:
- `src/lib/NotesPanel.svelte`: shell, list, Bin, toolbar, multi-block
  selection, clipboard, and scrolling.
- `src/lib/NoteItemEditor.svelte`: per-block editor, key handling, slash menu,
  and markdown.
- `src/lib/ReadOnlyNoteItem.svelte`: Bin rendering.
- `src/lib/RichTextEditor.svelte`: the contenteditable core. It is **shared
  with plans, templates, lists, metrics, and goals**. Do not read it or modify
  it. Other surfaces depend on it.
- `src/lib/noteClipboard.ts`: clipboard serialize and parse. Its API is fully
  specified in P-40 and P-43. If the project lead allows it, its exports may be
  imported without being read.
- `src/lib/noteSelection.ts` (`noteTextOffset` and `noteTextPoint`, specified
  in 1.9). This is also used by `treeEditorSelection.ts`.
- `src/lib/caretGeometry.ts` (`caretPointFromCoordinates` and
  `collapsedCaretClientX`, used only by notes).
- `src/lib/mobileNoteToolbar.ts`: toolbar docking (P-55).
- The Notes CSS in `src/app.css`: the `/* Notes */` section (roughly
  `.notes-page-actions` through the `@media (max-width: 760px)` note rules) and
  the iridescent note selectors near the top of the file. The needed visual
  values are restated in P-12 and 3.2.
- Tests describe behavior and may be read: `tests/visual/notes.spec.ts`,
  `tests/visual/notes-paragraph-audit.spec.ts`,
  `tests/unit/note-checklist.spec.ts`, and `tests/ci/note-undo.spec.ts`.

Shared infrastructure that may be used as-is (not Notes UI):
- `src/lib/store.ts` (the note functions in 1.4)
- `src/lib/planner.ts` (sanitizer, linkify, tree helpers)
- `src/lib/types.ts`, `src/lib/noteTrash.ts`, `src/lib/entityPatch.ts`
- `src/lib/imageEditing.ts`, `src/lib/imageMarkup.ts`, `src/lib/imageService.ts`,
  `src/lib/ImageLayer.svelte`
- `src/lib/externalLinks.ts`, `src/lib/mobileKeyboardScroll.ts`
- `src/lib/search.ts`, `src/lib/historyNavigation.ts`, `src/lib/DocumentFindBar.svelte`
- `src/App.svelte` (host)

`src/lib/treeEditorSelection.ts` and `src/lib/itemScroll.ts` are
plan-editor helpers and are not used by Notes.

### 3.5 Seeding synthetic notes in tests

Playwright config: `playwright.config.ts`. It runs `vite` on `127.0.0.1:5123`,
with `testDir` `tests/visual`, and these projects:
- `desktop` (Chrome 1280×820)
- `mobile` (Pixel 7)
- `webkit-notes` (Desktop Safari 1280×820, runs `notes*.spec.ts`)
- `webkit-images`, `webkit-document-find`

In a plain browser (no Tauri), the store reads and writes the entire `AppState`
as JSON in **`localStorage['balance.appState.v1']`**, synchronously on every
change. There are no test hooks or query parameters. Tests seed that key and
reload.

Mechanism 1 (seed the state and reload). This was verified to render
correctly, including nested items and a binned note:

```ts
import { test, expect, type Page } from '@playwright/test'

const now = new Date().toISOString()
const item = (id: string, kind: string, html: string, children: any[] = [], done = false) =>
  ({ id, kind, text: html.replace(/<[^>]+>/g, ''), html, done, startMinutes: null, endMinutes: null, children })

async function seedNotes(page: Page, notes: unknown[]) {
  await page.goto('/')
  await page.evaluate((notes) => {
    localStorage.clear()
    localStorage.setItem('balance.appState.v1', JSON.stringify({
      schemaVersion: 1, deviceId: 'test-device', localSequence: 0, historyRevision: 0,
      activePlanDate: '2026-09-11', templates: [], plans: [], lists: [], listTemplates: [],
      metrics: [], metricEntries: [], projects: [], projectCheckIns: [], goals: [],
      goalCompletions: [], images: [], uneditedPlanItems: [], operations: [], notes,
    }))
  }, notes)
  await page.reload()
  await page.getByRole('button', { name: 'Notes', exact: true }).click() // mobile: open drawer first
}

test('seeded note renders', async ({ page }) => {
  await seedNotes(page, [
    { id: 'note_a', title: 'Alpha', createdAt: now, updatedAt: now, items: [
      item('i1', 'heading', 'Head'),
      item('i2', 'numbered', 'one', [item('i3', 'checklist', 'sub', [], true)]),
      item('i4', 'numbered', '<strong>two</strong>'),
    ] },
    { id: 'note_b', title: 'Binned', createdAt: now, updatedAt: now, deletedAt: now, items: [item('j1', 'quote', 'q')] },
  ])
  await expect(page.getByLabel('Note title')).toHaveValue('Alpha')
})
```

To read results back, use
`JSON.parse(localStorage.getItem('balance.appState.v1')!).notes`. The last
operation is `state.operations.at(-1)`: its `type` is `apply_entity_changes`,
and `payload.action` is, for example, `patch_note_item`.

Mechanism 2 (drive the real store module through Vite, as in
`undo-navigation.spec.ts` and `tests/ci/note-undo.spec.ts`):

```ts
await page.goto('/')
await page.evaluate(async () => {
  const { plannerStore } = await import(/* @vite-ignore */ '/src/lib/store.ts')
  await plannerStore.ready
  const id = plannerStore.addNote()
  plannerStore.renameNote(id, 'Synthetic note')
})
```

Other conventions:
- To start from a fresh state, call `page.evaluate(() => localStorage.clear())`,
  then reload.
- Most tests create notes through the UI instead: click "Notes", then
  "+ New note".
- Clipboard events are synthesized with `new DataTransfer()` and
  `new ClipboardEvent('paste' | 'copy' | 'cut', { bubbles: true, cancelable: true, clipboardData })`,
  dispatched on the focused editor. "handled" means the event was
  default-prevented.
- `window.confirm` dialogs are accepted with
  `page.once('dialog', d => d.accept())`.
- Theme: set `localStorage['balance:deviceAppearance.v1']` to
  `{"version":1,"themeId":"iridescent",…}`.
- Undo from a test: `page.keyboard.press('Meta+Z')`, or dispatch a
  `KeyboardEvent('keydown', { key:'z', code:'KeyZ', metaKey:true, bubbles:true, cancelable:true })`
  on `window`. Headless Chromium on Linux accepts Meta.
- Local-only keys:
  - `balance:noteScrollSpacePercent`
  - `balance:noteEditor.v1` (new, uncommitted editor choice)
- Data must be synthetic (`AGENTS.md`). Never open or copy a real database.

---

## 4. Risks and gotchas

**R-01 WebKit clamps DOM selections to one contenteditable.**
- Any design with one contenteditable per block cannot rely on a native
  multi-block `Selection`. The existing code keeps its own model: CSS Custom
  Highlight plus a row-selection state (section D).
- It re-applies selections on the next frame after `pointerup`.
- History: commits `fb542bb`, `de341b7`, `9a3dcd1`, and `1f3ea76`, among
  others.
- A single-contenteditable document editor (ProseMirror/Lexical) avoids this
  class of bugs. It must still preserve the row-selection behaviors in
  section D: list rows select as whole rows, checkbox toggles apply to all
  selected rows, and Backspace deletes subtrees.

**R-02 Blur can overwrite the replacement.**
- Before removing blocks during a replace, the existing code clears the native
  range. Otherwise a `blur` handler could save a browser-mutated version of an
  endpoint block over the replacement.
- Any editor that commits on blur must avoid committing stale DOM after a
  structural change.

**R-03 Remote refreshes must not jump the caret** (commit `c55f538`, R-rule 1.8).
- Background reads bump `historyRevision` even when nothing changed.
- Replacing a focused block's DOM because of harmless markup differences (for
  example `<b>` versus `<strong>`, or `<i>` versus `<em>` from `execCommand`)
  moves the caret to the end.
- Compare sanitized forms before re-rendering.

**R-04 Native webviews collapse the selection to offset 0 before `blur`.**
- Commits `4a5bb5d` and `cbfb231`.
- Save the caret on trusted interactions (input, keyup, pointerup) and restore
  it on window focus. Don't read the selection during `blur`.
- The window `blur` and the editor `blur` can arrive in separate tasks.

**R-05 `text` versus `<br>` offsets.**
- `renderItemDisplayHTML` maps internal-link ranges using plain-text offsets
  against DOM text nodes, where `<br>` counts 0.
- If `text` contains `\n` for a `<br>` (the paste path uses
  `htmlToPlainTextWithBreaks`), link anchors after a line break shift by one
  character per break.
- Use `htmlToPlainText` for `text`.
- Also, caret offsets in `NoteViewState` count `<br>` as 1
  (`noteTextOffset`), while `backspaceNoteItemAtStart` returns
  `focusOffset = previous.text.length`, where `<br>` counts 0. Carets after
  soft breaks can land early.

**R-06 Markdown autoformat drops inline formatting.**
- The remainder is re-escaped as plain text, so bold after a typed `- ` is lost.
- Also, autoformat runs on every `input`, including IME composition updates.
  There is no `isComposing` guard, only Enter checks composition.
- Contenteditable inserts NBSP for spaces, and the `\s` in the patterns matches
  it. Keep that.

**R-07 Caret measurement on empty lines and element boundaries.**
- A collapsed range at `(editor, childCount)` reports a 0×0 rect in Blink and
  WebKit, which broke Down-arrow navigation (commits `34c925c` and `744fbf3`).
- The existing code probes adjacent characters or inserts a temporary
  zero-width marker.
- At soft-wrap boundaries, the same DOM offset is both the end of one line and
  the start of the next. Up from an empty block needs a forward nudge in
  Chromium (commit `40e0c30`).
- Tests assert pixel columns within 6 px.

**R-08 Paste kind override (existing behavior).**
- A multi-block paste applies the first pasted block's kind and done state to
  the host block.
- Plain multi-line text is all paragraphs, so pasting two lines into a bullet
  converts that bullet into a paragraph.
- It is replicated here for parity. Deciding whether to keep it is a product
  call. If changed, update the conformance tests deliberately.

**R-09 Enter at the start of a block.**
- The new empty block is inserted above and the caret moves into it. This is
  existing behavior and is unusual. Most editors keep the caret with the text.
- There is no test for it. Decide on it explicitly.

**R-10 Deferred commits during native undo** (`withNativeHistory`).
- While a native undo or redo is in flight, commits are queued, and
  `backspaceNoteItemAtStart` returns `null`.
- The existing Backspace handler treats `null` plus an empty block as "delete
  this block". A fast Backspace right after Mod+Z on an empty block could
  therefore enqueue two actions.
- `splitNoteItem` returns an id immediately, but its commit may be deferred,
  so focusing the new id after one tick can fail.
- New editors should tolerate commits that land later than the call.

**R-11 Every keystroke writes the store.**
- In browser mode that is a full `localStorage` JSON write per keystroke. The
  sidebar re-sorts and re-flattens every note.
- Also, `addNote` prepends to `state.notes`, which shifts every existing note's
  position. `entityChangesBetween` then emits an upsert with a numeric
  position and the full `value` for **every** note.
- Neither is a Notes-editor bug, but a new editor must not add heavier
  per-keystroke work, such as serializing the whole tree to compare. Keep
  unchanged item references identical.

**R-12 Whitespace-only blocks are stored empty.**
- Typing spaces into an empty block commits `''`, and the existing editor
  resets the DOM, so the spaces vanish.
- Trailing `<br>` placeholders are removed only when the block has text.
  Round-trips must not add or lose line breaks (commits `227241d` and
  `95f34a8`).
- Backspacing a leading newline must delete the `<br>` rather than merge
  blocks (`c7ad19b`).

**R-13 WKWebView clipboard.**
- HTML set via `clipboardData` in a copy event isn't reliably delivered to
  other macOS apps. The existing code also writes through the Tauri command
  `write_note_clipboard` (commit `54f92db`).
- Notion drops `<br>` from external HTML, which is why the HTML flavor uses a
  literal `\n` (commit `c3b459c`).
- On paste in the native app, Notes uses the event's `clipboardData`. App's
  `handleNativeEditorPaste` is inactive on Notes.

**R-14 Safari focus after a checkbox toggle.**
- Focus can land on `document.body` after toggling a selected checkbox. The
  existing keydown capture accepts `event.target === document.body` while a row
  selection exists, so Backspace still deletes the selected rows.
- Space on a focused checkbox toggles it natively.

**R-15 Scroll restore versus search reveal.**
- Opening a search result sets the note, waits a tick plus one rAF, then
  centers the row.
- The panel's view-state restore also waits a tick and then a rAF, and then
  sets `scrollTop`.
- The ordering is fragile. A new editor must ensure a search or undo reveal
  isn't overwritten by a later restore of a stale `scrollTop`.

**R-16 Undo stack ownership.**
- ProseMirror and Lexical ship their own history. App prevents Mod+Z at the
  window, but the macOS Edit menu "Undo" item, or a `beforeinput` of type
  `historyUndo`, could still reach a contenteditable's native undo stack.
  Disable editor-internal history.
- Consider intercepting `beforeinput` `historyUndo` and `historyRedo` and
  routing them to App's undo. Existing code doesn't, but a framework history
  would make the problem visible.
- After undo, reconcile from the store (1.8). Don't keep a parallel model.

**R-17 Full-tree replacement APIs** (the uncommitted
`plannerStore.replaceNoteItems`, or any "diff the whole document" approach).
- Such an API must:
  - Reuse the **existing item objects**, including their unknown fields, for
    unchanged blocks.
  - Create changed items as `{ ...storedItem, ...changedFields }`.
  - Keep ids stable across splits and merges according to 1.4. The kept half
    keeps the id.
  - Never create a new id for an existing block.
- It must preserve undo granularity:
  - Text changes must still coalesce per block. The current key is
    `note-item-text:<noteId>:<itemId>`, with a 1200 ms window.
  - Structural edits must be separate steps.
  - Paste and image edits must use `mergeHistory: false`.
- It must run `reconcileNoteChecklistItems` afterward.

**R-18 Keyboard-shortcut reference drift.** Any new App-level shortcut must be
added to `KeyboardShortcutsModal.svelte` in the same change (`AGENTS.md`).

**R-19 Goal Rhythm containment.**
- Note editing must cause zero `buildGoalDayCells` calls. Commits go through
  `commitEntities` with goal reconciliation, which is cheap for notes.
- Don't animate inherited theme variables.
- If you touch animated theme or iridescent styles near the Notes page, run the
  interaction performance profile (`pnpm test:interaction-performance`) with
  Graphite and Iridescent, as required by `AGENTS.md`.

**R-20 Android.** Don't build Android locally. The CI stress script
(`.github/scripts/android-interaction-stress.mjs`) relies on these, and pushes
through CI will exercise them:
- `.note-card`, `.note-new`, `.note-empty button.primary`, `.note-title`
- `.note-empty-editor`, `[data-note-text-input]`, and
  `[data-note-text-input]:focus`
- `.note-format-toolbar button[aria-label="Bold|Italic|Underline"]`
- `.note-check`, `.notes-filter`, `.note-actions .danger`,
  `.notes-trash-header-button`, `.note-actions .primary`
