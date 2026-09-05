# Balance

Balance is a local-first daily planner built with Svelte, TypeScript, and Tauri.

Current slice:

- Generate a daily checklist from a probability-based template.
- Save generated daily plans as historical snapshots.
- Edit nested checklist items.
- Keep day-independent notes with rich text, headings, nested lists, and checklists.
- Copy stable `balance://note/...` links that open a note from plans, templates, lists, or other notes.
- Drag checklist items before, after, or inside other items.
- Add inline time ranges and drag the start/end times in 15-minute increments.
- Define recurring goals that complete automatically from checked plan-item text.
- Review goal completions in an always-available, scrollable cadence history panel.
- Export the app state as JSON or readable plan history as HTML.
- Browse and search encrypted daily backups, then copy older text back into the workspace even after undo history expires.
- See today’s progress and next tasks in small, medium, or large native macOS widgets. Widget snapshots are encrypted with an extension-owned Keychain key; the database key is never shared with the widget.
- Use the macOS 15+ “Add Task to Balance” action in Shortcuts to capture a task verbatim under “reminders from siri:”. Balance uses today while it has incomplete tasks, then rolls capture forward to tomorrow. To use Siri on Mac, create a custom shortcut named “Add to Balance” containing this action; the distinct names keep Siri from bypassing the custom shortcut's input prompt. Siri will run the shortcut by name and ask for the task. Apple does not support direct App Shortcut phrases on macOS.
- Record local mutations in an operation log for future sync work.

## Browse backups

In the installed app, open **Settings → Recovery & diagnostics → Open recovery & diagnostics → Browse encrypted backups**
(or open recovery with **Cmd/Ctrl+Shift+P**). Choose a backup or step through **Older** / **Newer**, search its content,
and use **Copy text** to recover a document by pasting it into your current workspace. Text is selectable for copying individual passages.

The browser includes plans, notes, day and list templates, archived list items, generated lists, metrics, and goals.
It shows plain text, including nested items, without images or rich formatting. It does not restore an entire database.
Balance retains the latest seven daily backups, created after the first change each day; any retained optimization backups also appear.
Content that was never captured in a retained backup cannot be recovered here.

Backups remain encrypted on disk and are opened read-only, without migrations or decrypted temporary copies.
Previews stay in memory and are discarded when the browser closes. Only **Copy text** writes to the system clipboard.
An older recovery key can unlock a backup from before a key rotation without changing the live database key.
On macOS, previous keys are retained under their archived accounts in Keychain.

## Development

Install dependencies:

```bash
pnpm install
```

Run the web app:

```bash
pnpm run dev
```

Run the Tauri shell:

```bash
pnpm run dev:tauri
```

Run checks:

```bash
pnpm run check
pnpm run build
pnpm run test:visual
```

Visual smoke screenshots are written to `artifacts/visual-smoke/`, which is intentionally ignored by git.
