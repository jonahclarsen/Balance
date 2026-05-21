# Balance

Balance is a local-first daily planner built with Svelte, TypeScript, and Tauri.

Current slice:

- Generate a daily checklist from a probability-based template.
- Save generated daily plans as historical snapshots.
- Edit nested checklist items.
- Drag checklist items before, after, or inside other items.
- Add inline time ranges and drag the start/end times in 15-minute increments.
- Export the app state as JSON or readable plan history as HTML.
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
