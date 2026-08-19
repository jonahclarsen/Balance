# Completion celebrations: implementation architecture

This proposal maps the repository as it existed on 2026-08-19, before the
completion-celebration implementation began. Line references are therefore
useful landmarks rather than promises that later edits will leave the numbers
unchanged.

## Executive recommendation

Build the feature around four deliberately separate pieces:

1. A typed, data-only catalog in `src/lib/celebrations.ts` is the single source
   of truth for all 30 IDs, names, short explanations, icons, categories,
   duration, and implementation recipe.
2. `src/lib/Celebration.svelte` remains the one fixed, pointer-transparent
   playback layer. Give it a request-based API and let it host a handful of
   reusable render engines rather than 30 unrelated mini-apps.
3. A new `src/lib/CelebrationSettings.svelte` renders the accessible 30-card
   picker and the exact all-caps reminder. It emits a selection; `App.svelte`
   owns persistence and preview navigation.
4. `App.svelte` owns a cancellable preview session with a **transient displayed
   date**. Never persist the temporary trip to yesterday through
   `plannerStore.setActivePlanDate()`.

The preference should affect day completions only. The existing bespoke list
completion animation is a different semantic event and should remain unchanged
unless the product scope is intentionally expanded.

## Current implementation seams

### Playback and completion detection

- `src/lib/Celebration.svelte:1-174` currently owns timers, canvas lifecycle,
  the day/list messages, reduced-motion detection, confetti particles, and the
  imperative `celebrate(kind)` / `dismiss()` API.
- `src/lib/Celebration.svelte:176-201` renders one always-mounted canvas, the
  list-only DOM burst, and a live-region banner.
- `src/lib/Celebration.svelte:203-410` contains all celebration styling. The
  day effect is canvas confetti; the list effect is a card plus check sparks.
- `src/App.svelte:167-174` holds the component binding plus the currently
  celebrated day/list identity.
- `src/App.svelte:536-544` invokes the day and list completion observers from
  reactive statements.
- `src/App.svelte:546-549` defines completeness recursively. Empty days are
  intentionally not complete.
- `src/App.svelte:657-685` diffs each active plan's current completeness against
  `planCompletionById`. A false-to-true transition while the Today view is
  visible triggers `celebration?.celebrate('day')`; leaving that day/view or
  unchecking dismisses it.
- `src/App.svelte:687-720` independently observes visible generated lists and
  plays the list celebration.
- `src/App.svelte:722-727` is the centralized App-level dismissal seam.
- `src/App.svelte:1305-1311` seeds both completion maps only after persistence
  hydration. This prevents already-complete saved work from celebrating at
  launch.
- `src/App.svelte:1335-1348` dismisses during component teardown.
- `src/App.svelte:5825` mounts the playback layer outside `.app-shell`, which is
  ideal: it can cover the whole WebView and remain outside any temporary `inert`
  state applied to the app during preview.

### Settings UI and view/date navigation

- `src/App.svelte:73` defines `View`, including `settings` and `today`.
- `src/App.svelte:117-173` contains local view and celebration state.
- `src/App.svelte:366-402` derives `activePlan`, the day panes, focused plan, and
  per-page scroll keys directly from `$plannerStore.activePlanDate`.
- `src/App.svelte:465-479` mirrors persisted preferences into display state.
- `src/App.svelte:570-581` is the mobile-drawer view-switch seam.
- `src/App.svelte:1674-1676` shifts the active date by committing through the
  store.
- `src/App.svelte:1767-1770` opens a Goal Rhythm date in Today by committing the
  date and switching the view.
- `src/App.svelte:1780-1835` already remembers and restores scroll per page.
  Switching Settings -> preview Today -> Settings will save/restore Settings
  scroll if the preview uses the normal `view` and `scrollPageKey` machinery.
- `src/App.svelte:1987-1995` has the local-calendar-safe `shiftISODate()` helper.
  Use `shiftISODate(currentDay, -1)`, not UTC string arithmetic, for the prior
  calendar day.
- `src/App.svelte:2319-2349` contains sidebar keyboard navigation. Preview mode
  must make the underlying UI inert or explicitly ignore global navigation keys
  so the timed return is deterministic.
- `src/App.svelte:4383-4393` is the `.app-shell`; it already uses the HTML
  `inert` attribute for database loading/error. Extend that expression with
  `Boolean(celebrationPreview)` during an automatic preview.
- `src/App.svelte:4575-4599` applies date-context classes and renders day panes.
  These are the important consumers of a transient displayed date.
- `src/App.svelte:5408-5717` is the current Settings view and
  `.settings-panel`. Put the celebration section near visual preferences (after
  theme/typography is coherent), and keep the user's exact reminder as the
  final heading inside that section.
- `src/app.css:1047-1075` defines workspace scrolling and date-edge chrome.
- `src/app.css:1153-1173` and `src/app.css:2068-2082` define the settings card,
  max width, section grid, and separators.
- `src/app.css:2116-2175` is a good visual/accessibility precedent for selectable
  card grids (`role=group`, real buttons, `aria-pressed`, selected mark).
- `src/app.css:3716-3917` is the main phone layout. The celebration picker needs
  a single-column phone rule, modest thumbnail height, and no horizontal
  overflow.

### Persistence, normalization, native storage, and sync

- `src/lib/types.ts:174-181` defines `ReplicatedPreferences`. Add the new
  preference here.
- `src/lib/preferences.ts:31-40` creates defaults; `src/lib/preferences.ts:83-104`
  normalizes old/corrupt preference objects. This is the forward-compatible
  migration seam; the top-level app schema can remain version 1.
- `src/lib/planner.ts:125-143` builds a new app state from default preferences.
- `src/lib/store.ts:271-285` parses persisted schema-version-1 state and then
  normalizes it.
- `src/lib/store.ts:587-600` commits active-date and preference changes.
  `patchPreferences()` is non-undoable and becomes a replicated
  `patch_preferences` operation.
- `src/lib/store.ts:2574-2579` also normalizes preferences when rebuilding state.
- `src-tauri/src/lib.rs:2510-2554` reconstructs the JS app state from the
  encrypted native store and replicated-preferences metadata.
- `src-tauri/src/lib.rs:2827-2904` provides native preference defaults,
  validation, reading, and patch merging. Validation deliberately preserves
  unknown future keys, as demonstrated by the sync test below.
- `src-tauri/src/lib.rs:3277-3285` installs preferences and active date from a
  full state.
- `src-tauri/src/lib.rs:3776-3780` applies `set_active_plan_date` and
  `patch_preferences` operations.
- `src-tauri/src/lib.rs:4230-4242` makes preference changes non-undoable while
  active-date changes do have a domain undo operation.
- `src-tauri/src/sync/tests.rs:1019-1068` verifies that replicated preferences,
  including a future/unknown preference, converge and survive a checkpoint.

No SQL migration is required. Preferences live as JSON metadata and old values
are normalized on read. Still add the default string to Rust's
`default_replicated_preferences()` and make native validation canonicalize an
optional string, so databases created or reconstructed entirely on the native
side return a complete preference shape. Do not make the field immediately
required: existing metadata will not contain it. The TypeScript normalizer
should be the authoritative allow-list and fall back safely for unknown IDs.

### Existing tests and build constraints

- `tests/visual/balance.spec.ts:757-789` covers final-day transition,
  live-region visibility, canvas launch, dismissal on uncheck, and replay.
- `tests/visual/balance.spec.ts:791-863` covers list and linked-list completion.
  Preserve these as regression coverage for the unchanged list effect.
- `tests/visual/balance.spec.ts:865-1105` shows the established preference test
  pattern: select in Settings, poll the serialized browser fixture state,
  reload, and verify the selected UI.
- `tests/visual/balance.spec.ts:300-332` already captures Settings in both
  desktop and mobile Playwright projects with synthetic browser data.
- `tests/visual/mobile-layout.spec.ts:1-103` seeds synthetic data directly into
  `balance.appState.v1`; normalizing a missing new preference must keep such old
  fixtures valid.
- `playwright.config.ts` runs Chromium at desktop and Pixel 7 sizes against Vite.
- `package.json` exposes `pnpm check` and `pnpm test:visual`; there is no current
  JS unit-test runner.
- Project guidance prohibits local Android builds. Android verification must be
  done only through `.github/workflows/android.yml` after pushing.

## Recommended data model and APIs

### Catalog

Create `src/lib/celebrations.ts` with a literal catalog and derive the ID type
from it so the cards and the player cannot drift:

```ts
export const COMPLETION_CELEBRATIONS = [
  {
    id: 'confetti-classic',
    name: 'Confetti Classic',
    description: 'The familiar victory storm, freshly tuned.',
    icon: '🎊',
    category: 'pretty',
    engine: 'particles',
    recipe: 'confetti',
    durationMs: 3200,
  },
  // 29 more
] as const satisfies readonly CompletionCelebrationDefinition[]

export type CompletionCelebrationId =
  (typeof COMPLETION_CELEBRATIONS)[number]['id']
export const DEFAULT_COMPLETION_CELEBRATION_ID: CompletionCelebrationId =
  'confetti-classic'
export function normalizeCompletionCelebrationId(value: unknown): CompletionCelebrationId
export function getCompletionCelebration(id: CompletionCelebrationId): CompletionCelebrationDefinition
```

Use an icon string or small inline-SVG component/data shape; both satisfy the
requested image-or-icon card without creating 30 binary assets. Keep visible
copy and implementation recipes in the same entry. Avoid accepting arbitrary
HTML from the catalog.

Add to `ReplicatedPreferences`:

```ts
completionCelebrationId: CompletionCelebrationId
```

Then default/normalize it in `preferences.ts` and persist a click with:

```ts
plannerStore.patchPreferences({ completionCelebrationId: id })
```

This intentionally syncs the choice across devices.

### Player

Replace the ambiguous positional call with a request object:

```ts
export type CelebrationPlayRequest =
  | { kind: 'day'; celebrationId: CompletionCelebrationId; preview?: boolean }
  | { kind: 'list' }

export function play(request: CelebrationPlayRequest): void
export function dismiss(): void
```

`play()` must always begin by running the same cleanup path as `dismiss()`:
cancel every rAF and timeout, remove any root dataset/class/style mutations,
clear canvas, stop Web Animations, and reset DOM recipe state. Use a monotonically
increasing run token so callbacks from an old run cannot mutate a new one.

Thirty choices do not require 30 independent particle loops. Prefer a small set
of engines:

- canvas particles: confetti, fireworks, bubbles, emoji rain, comets;
- CSS/DOM stage: cards, stamps, flowers, disco tiles, absurd mascots;
- filters/geometry: kaleidoscope, tunnel, chromatic split, moire;
- UI choreography: safe temporary transforms/filters on `.app-shell`, task
  rows, sidebar, or day heading;
- mixed: a UI treatment plus canvas/DOM overlay;
- native accent: optional mobile haptics for one or two recipes.

Expose the active recipe on stable test hooks such as
`data-celebration-id`, `data-celebration-engine`, and the existing accessible
status label. Do not assert individual random particle coordinates in tests.

For UI-play recipes, prefer setting
`document.documentElement.dataset.celebration = id` and defining narrowly
scoped selectors in `app.css`. Never overwrite an element's whole `style`
attribute. Remove the dataset in `dismiss()` and `onDestroy()`. Recipes must not
move focus, change data, click controls, or alter layout after cleanup.

The current component's fixed z-index, `pointer-events: none`, live region, and
outside-app mount are all worth retaining. Cap canvas DPR (for example at 2),
resize on play/viewport change, avoid per-frame DOM layout reads, and enforce a
bounded particle count on phones.

### Settings component

Recommended API:

```ts
export let selectedId: CompletionCelebrationId
export let previewingId: CompletionCelebrationId | null = null
export let onSelect: (id: CompletionCelebrationId) => void
```

Render one real `<button>` per definition, within a group labeled “Day
completion celebration.” Each card contains:

- an `aria-hidden` decorative icon/thumbnail;
- the visible name;
- the visible fun, brief explanation;
- `aria-pressed={selectedId === definition.id}`;
- a visible selected mark and a temporary “Previewing…” state.

The user's sentence must appear verbatim, with exactly the supplied casing and
punctuation, as the final heading in the component:

> REMINDER: YOU MIGHT WANT TO PICK YOUR FAVS AND JUST HAVE IT ASSIGN ONE AT RANDOM TO EACH DAY AND PLAY THAT AFTER THE DAY IS OVER, AND DELETE THE OTHERS AND THIS SETTINGS SECTION

Do not implement random favorites unless asked in a follow-up; this request asks
for the reminder, not that behavior.

## Safe preview state machine

### Why not use `setActivePlanDate()`

The tempting implementation is:

1. save `$plannerStore.activePlanDate`;
2. commit yesterday;
3. wait;
4. commit the saved date.

That produces two replicated operations for a visual preview. Another device
could observe the temporary date, and a crash/force-quit between steps would
leave the user's persisted navigation on yesterday. It also pollutes history
and wakes persistence/sync for presentation-only state.

### Transient displayed date

Add local state in `App.svelte`:

```ts
type CelebrationPreviewSession = {
  token: number
  celebrationId: CompletionCelebrationId
  previewDate: string
}

let celebrationPreview: CelebrationPreviewSession | null = null
let celebrationPreviewTimer: number | null = null
let celebrationPreviewToken = 0
$: displayedPlanDate =
  celebrationPreview?.previewDate ?? $plannerStore.activePlanDate
```

Use `displayedPlanDate` for Today-only presentation derivations during this
feature: `activePlan`, the primary `dayPanes` date, Today scroll-page key, date
context classes, date input/value, and the completion observer's selected date.
Do **not** replace the stored active date in hidden non-Today workflows. Make the
date controls/underlying app inert during preview.

### Transitions

`startCelebrationPreview(id)`:

1. Normalize the ID and immediately persist it with `patchPreferences()`; the
   click is selection plus preview.
2. Cancel/finish any prior preview and call the player's `dismiss()`.
3. Save Settings scroll through the existing `rememberWorkspaceScroll()` path.
4. Increment the token and create a session whose date is
   `shiftISODate(currentDay, -1)`.
5. Set `view = 'today'`. Do not modify persistent active date, plans, completion
   maps, compare-day state, selection, or overlays.
6. `await tick()` so the prior-day DOM exists, then verify that the session token
   is still current.
7. Set App's day-celebration bookkeeping for the transient displayed date and
   call `celebration.play({ kind: 'day', celebrationId: id, preview: true })`.
8. Start a timeout based on the catalog duration, bounded to a few seconds.

`finishCelebrationPreview(token)`:

1. Return immediately if the token is stale.
2. Clear the timeout and dismiss playback/root mutations.
3. Clear App celebration bookkeeping and the transient session.
4. Set `view = 'settings'`.
5. Let the existing `scrollPageKey` effect restore `view:settings` scroll after
   the next tick.

Also finish/cancel on `onDestroy`, database-error takeover, and any explicit
navigation escape that is intentionally allowed. A stale timeout must never
return a newer run to Settings. Do not fake a checkbox transition or alter the
completion map to preview.

While previewing, extend `.app-shell`'s existing `inert` binding. The fixed
player remains outside it, so animation and the live-region status still work.
This prevents a phone tap or global key shortcut from changing state in the
few-second interlude. If retaining `compareDayOpen` would render two days, use a
presentation-only condition (`dayPanes` excludes comparison while a preview is
active) rather than changing and re-persisting compare-day preferences.

### Normal completion path

At the existing false-to-true transition in `observeActivePlanCompletion()`,
call:

```ts
celebration?.play({
  kind: 'day',
  celebrationId: normalizeCompletionCelebrationId(
    $plannerStore.preferences.completionCelebrationId,
  ),
})
```

The list call remains `play({ kind: 'list' })`.

## Motion, accessibility, platform, and safety constraints

- `prefers-reduced-motion: reduce` must disable canvas/Web Animation loops and
  UI transforms. Still show a calm, static status/banner long enough to be
  perceived; the current CSS leaves the banner fully visible until its timer.
- Decorative stages are `aria-hidden`. Keep exactly one polite status message;
  do not announce dozens of particles/emoji.
- Honor `prefers-contrast` where practical and never depend on color alone for
  card selection.
- Use `@supports` fallbacks for newer CSS such as `filter`, `backdrop-filter`,
  `mask-image`, `@property`, `color-mix()`, or View Transitions. The effect can
  become simpler, but selection/playback must not fail.
- Treat the View Transition API as optional enhancement only. Tauri WebViews
  differ by OS version; feature-detect `document.startViewTransition` and keep
  a normal view switch.
- The repository already has mobile native haptics:
  `src/lib/TimeRange.svelte:114-147` shows the guarded native/browser fallback;
  `src-tauri/capabilities/mobile.json` grants `haptics:allow-vibrate`; and
  `src-tauri/src/lib.rs:9603-9607` registers the plugin only on mobile. Reuse
  that guarded approach for an explicitly haptic recipe. Never make playback
  fail when haptics are unavailable.
- Avoid desktop native-window shaking/moving. It needs platform-specific
  permissions, can be alarming, and is much harder to restore than a WebView
  transform. A CSS “window wobble” of `.app-shell` creates the joke safely.
- Do not load remote images/scripts/audio. Inline icons and local CSS/canvas keep
  the public app offline, deterministic, and free of content-security surprises.
- Effects must remain `pointer-events:none` and never cover controls after their
  cleanup deadline.
- No database access is needed for this work beyond synthetic browser/Rust test
  fixtures. Never inspect a real installed database or recovery key.

## Test strategy

### Type and build checks

Run:

```sh
pnpm check
```

This catches catalog/ID exhaustiveness, Svelte component API mismatches, and
preference shape omissions. A normal frontend build is appropriate; do not run
an Android build locally.

### Focused Playwright coverage

Add focused cases to `tests/visual/balance.spec.ts` or a new
`tests/visual/celebrations.spec.ts` using synthetic localStorage state:

1. Settings exposes exactly 30 card buttons in the named group; every card has
   nonempty visible name, explanation, decorative icon, and an `aria-pressed`
   state. Assert the exact reminder heading text.
2. Selecting a non-default card updates
   `preferences.completionCelebrationId`, survives reload, and restores its
   selected mark.
3. Clicking a card switches to Today showing the local prior calendar date,
   exposes the chosen `data-celebration-id`, and returns to Settings after the
   duration. Assert the persisted `activePlanDate` never changed before, during,
   or after preview.
4. Scroll Settings before selection and assert approximately the same scroll
   position after return on both desktop and mobile projects.
5. Seed an incomplete synthetic day, select a recipe, return/reload, complete
   the final task, and assert the selected recipe—not classic confetti—plays.
6. Unchecking during a normal (non-preview) run dismisses all stages and removes
   the root dataset/styles. Navigating away does the same.
7. Existing list-completion tests still see `.list-celebration` and do not see a
   day recipe.
8. With Playwright reduced motion enabled, assert no animated canvas/UI mutation
   is active, but the accessible “Day finished” status appears and cleanup
   completes.
9. On the mobile project, assert the grid is one column, cards remain within the
   viewport, and no horizontal overflow appears.

Use stable recipe/stage data attributes, not animation frames or random
coordinates. Screenshots are optional visual QA and must use only the synthetic
browser fixture, consistent with project policy.

### Native/sync coverage

Extend `replicated_preferences_converge_and_survive_a_checkpoint()` in
`src-tauri/src/sync/tests.rs` to include `completionCelebrationId`, and update
expected JSON. Add/adjust a Rust preference validation test if one exists near
the validator. Run focused host Rust tests if practical, but perform all Android
verification through the pushed branch's `.github/workflows/android.yml`.

## Suggested implementation order

1. Land catalog/types/default normalization plus TS/native sync persistence.
2. Refactor the current player to request-based playback without changing its
   classic day/list behavior; keep existing tests green.
3. Add reusable effect engines and the 30 recipes, with cleanup/reduced-motion
   first-class from the start.
4. Add the Settings card component and exact reminder.
5. Add the transient-date preview state machine and inert/scroll integration.
6. Add focused Playwright and native sync tests, run `pnpm check`, frontend
   visual tests, and CI Android validation.

This order isolates failures: persistence, player refactor, visual recipes, and
navigation preview can each be verified before they are stacked together.
