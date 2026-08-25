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
- See today’s progress and next tasks in small, medium, or large native macOS widgets. Widget snapshots are encrypted with an extension-owned Keychain key; the database key is never shared with the widget.
- Use the macOS 15+ “Add to Balance” action in Shortcuts to capture a task verbatim under “reminders from siri:”. Balance uses today while it has incomplete tasks, then rolls capture forward to tomorrow. To use Siri on Mac, create a custom shortcut named “Add to Balance” containing this action; Siri will run it by name and ask for the task. Apple does not support direct App Shortcut phrases on macOS.
- Record local mutations in an operation log for future sync work.

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
