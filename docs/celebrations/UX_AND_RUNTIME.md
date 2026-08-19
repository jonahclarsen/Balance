# Completion celebrations: picker and runtime contract

This document is the interaction and safety contract for the 30 day-completion
celebrations. It is intentionally narrower than the effect catalogue: the
catalogue decides what each spectacle looks like; this contract makes all 30
spectacles selectable, previewable, accessible, interruptible, and incapable of
changing a plan.

## What exists today

- `src/lib/Celebration.svelte` exposes `celebrate('day' | 'list')` and `dismiss()`.
  Day completion renders one full-window 2D canvas plus a polite status banner;
  list completion renders a DOM card and checkmark burst. Both are fixed,
  pointer-transparent, and clean up timers / animation frames on dismissal and
  component destruction.
- `src/App.svelte` detects a false-to-true completion transition while the Today
  surface is visible. Leaving the date or Today surface dismisses the day
  celebration. List completion has independent behavior and should remain
  independent in this project.
- Settings is a single `max-width: 760px` panel made from separated
  `.settings-section` blocks. Theme and font options establish the local visual
  convention: a responsive grid of pressable cards, visible selected state, and
  `aria-pressed`.
- Preferences are replicated app state, normalized in `src/lib/preferences.ts`,
  and changed with `plannerStore.patchPreferences(...)`. The selected effect
  belongs there, not in a freestanding `localStorage` key, so devices converge on
  the same choice. Unknown or retired ids must normalize to the default effect.
- Today scroll position is keyed by date and Settings has its own `view:settings`
  scroll entry. `plannerStore.setActivePlanDate()` is a persisted operation, so a
  preview must restore the user's original active date at the end.
- Existing visual tests assert the `Day finished` live region and canvas behavior.
  Preserve a stable `role="status"` / `aria-label="Day finished"` contract even
  when the visual implementation changes.

## Settings section

Place a new `Day completion celebration` section after Completed item colors.
This keeps visual rewards with the other completion presentation controls and
away from encryption, recovery, and export.

Introductory copy should say that choosing a card saves it immediately, then
opens yesterday in a read-only preview for a few seconds and returns here. Also
state that reduced-motion mode substitutes a calm still version.

### Card anatomy

Render all 30 registry entries; do not hand-maintain a second list in the
component. Each entry is an outer `div.celebration-option` containing one card
button. That satisfies the requested per-effect div while retaining honest
button semantics. The button contains:

1. A fixed-aspect preview tile (`aria-hidden="true"`) made from a compact inline
   SVG or CSS illustration supplied by the registry. Do not load remote images or
   play 30 miniature effects at once.
2. The effect's name in a `strong` element.
3. Its one-sentence fun description in a `small` or `p` element. Aim for 45–90
   characters and two lines at desktop width.
4. A selected check badge whose visible text is `Selected`; hide only the icon
   from assistive technology.

The button's accessible name should naturally include name and description. Set
`aria-pressed` to the saved selection. Clicking the already-selected card must
preview it again; therefore handle `click`, not only a preference `change`.
Selection is committed before preview begins. If an individual visual effect
cannot start, keep the selection, render its reduced/static fallback, and report
the error to the console without breaking the return trip.

### Layout and visual behavior

- At the existing 760px panel width, use three columns when they fit:
  `repeat(auto-fit, minmax(min(210px, 100%), 1fr))` with a 10–12px gap.
- Under roughly 560px, use two columns if each stays at least 150px. Under 390px,
  use one column. Let container width, rather than platform sniffing, decide.
- Use `aspect-ratio: 16 / 10` for art tiles, `object-fit: cover` for any bundled
  raster art, and `overflow: clip` with an `overflow: hidden` fallback.
- Keep names and copy aligned at the top; do not force equal text truncation.
  Every joke must remain readable at 200% zoom.
- A selected card has more than a color cue: border, checkmark, and `Selected`
  text. Hover is enhancement only. Focus uses the existing `--focus-ring` with a
  two-pixel outline and spacing from the card border.
- Lazy rendering is optional, but all card text must remain in the accessibility
  tree. Lightweight static inline SVG/CSS art is preferred to an observer or 30
  canvas instances.

The final child of this celebration Settings section must be a real heading, not
an image and not generated content. Its text must be exactly:

> REMINDER: YOU MIGHT WANT TO PICK YOUR FAVS AND JUST HAVE IT ASSIGN ONE AT RANDOM TO EACH DAY AND PLAY THAT AFTER THE DAY IS OVER, AND DELETE THE OTHERS AND THIS SETTINGS SECTION

Keep the exact capitalization and punctuation. It may wrap normally; style it as
a playful footer heading without reducing it below the surrounding body-text
size.

### Keyboard model

Thirty ordinary tab stops is usable but tedious. Follow a roving-button model:

- The selected card has `tabindex="0"`; if nothing valid is selected, the first
  card does. Other card buttons have `tabindex="-1"`.
- Arrow Left/Right moves focus to the previous/next card. Arrow Up/Down moves by
  the current computed column count where practical; falling back to
  previous/next is acceptable in a one-column layout. Home/End moves to the first
  or last card.
- Moving focus does not save or preview. Enter or Space activates the focused
  card. Pointer click also activates. This avoids launching a four-second preview
  merely because someone is exploring names with arrow keys.
- After a preview returns, restore focus to its originating card with
  `{ preventScroll: true }`, then restore the exact Settings scroll offset. Focus
  restoration comes after the Settings DOM has rendered.
- The persistent preview controls support Escape to return early. Do not assign a
  new global shortcut for the picker.

If the implementation uses native radio inputs instead, it must preserve those
same outcomes, including clicking the checked radio to replay and avoiding an
automatic preview on arrow-only exploration. Custom buttons with `aria-pressed`
match the repository's current theme/font controls and are the simpler option.

## Preview journey

The requested “prior day” means yesterday by calendar date:
`shiftISODate(todayISO(), -1)`. It does not mean the last saved plan or one day
before whatever future/past date happened to be active when Settings opened. An
empty yesterday is still a valid preview stage and must not generate a plan.

Nominal duration is 4.2 seconds (2 seconds in reduced-motion mode). Effects may
finish sooner visually, but the return timer owns navigation. The stage should
have a small persistent control outside the inert app shell:

`Previewing <name> on yesterday · Returning to Settings…  [Return now]`

The message is a polite live region. Focus the `Return now` button after the
preview surface mounts, because the card that previously held focus has been
unmounted. On return, announce `Preview finished. Settings restored.` and put
focus back on the card.

### Snapshot and restoration

Before changing surfaces, capture a plain preview snapshot:

```ts
type PreviewReturnState = {
  sessionId: number
  effectId: CelebrationId
  view: View                 // normally settings
  activePlanDate: string
  compareDayOpen: boolean
  compareDayDate: string
  settingsScrollTop: number
  focusEffectId: CelebrationId
}
```

Then follow this order:

1. Save the selected id with `patchPreferences`.
2. Cancel and fully dispose any active celebration/preview.
3. Capture Settings scroll, active date, comparison state, and originating id.
4. Set `previewActive`; close comparison only in transient component state; set
   yesterday as the active date; set `view = 'today'`.
5. Await `tick()` and one animation frame so layout rects are current.
6. Start the effect explicitly in `preview` mode. Do not manufacture a task
   completion transition.
7. At 4.2 seconds, or on Escape / Return now, abort the effect, restore the
   captured date, comparison state, and view, await render, restore Settings
   scroll, then restore focus.

Temporarily setting the active date uses the existing store and can create a
synced `set_active_plan_date` operation. Prefer adding a view-only date override
for preview if that can be done cleanly. If the implementation must use
`setActivePlanDate`, restoring it is mandatory and the two operations must never
be undoable. No plan, preference other than the chosen id, selection, overlay,
or item completion state may change.

The app shell should be `inert` and `aria-hidden` for the duration of preview,
with the status / Return now control mounted outside it. Combine this condition
with the shell's existing database-loading inert expression. A preview is visual
theatre, not an opportunity to edit yesterday accidentally. Window-level Escape
handling remains available while the shell is inert.

## Cancellation and reentrancy

Use one monotonically increasing session id plus one `AbortController`. Every
effect receives the signal and returns an idempotent disposer:

```ts
type CelebrationRunContext = {
  kind: 'day' | 'list'
  mode: 'completion' | 'preview'
  seed: number
  reducedMotion: boolean
  signal: AbortSignal
  stage: HTMLElement
  canvas: HTMLCanvasElement
  ui: Readonly<{
    shell: HTMLElement | null
    sidebar: HTMLElement | null
    content: HTMLElement | null
    dayPane: HTMLElement | null
  }>
}

type CelebrationEffect = {
  id: CelebrationId
  name: string
  description: string
  art: CelebrationArt
  run(context: CelebrationRunContext): void | (() => void)
  runReduced?(context: CelebrationRunContext): void | (() => void)
}
```

On a new run: abort the old controller, invoke its disposer, clear registered
timeouts, cancel every rAF, remove transient listeners/classes/attributes/CSS
custom properties, reset and clear the canvas, and empty only the dedicated
stage. The new session may start only after this synchronous cleanup. A return
timer closes over its session id and does nothing unless it still matches.

`dismiss()` and component destruction use the exact same cleanup path. Add a
six-second fail-safe cleanup even when an effect's own animation promises to end.
Listen for `visibilitychange`; pause rAF work while hidden and dispose a preview
instead of surprising the user with a late automatic return. Errors inside one
effect go through cleanup and a static success badge, never through an uncaught
animation callback.

While a preview is active, a second activation is normally impossible because
Settings is unmounted. Still make the API reentrant for test hooks and future UI.
If another app navigation route becomes available outside the inert shell, it
must cancel without restoring Settings so a stale timer cannot yank the user
away from their deliberate destination.

## Effects that “play with the UI”

Effects may visually bend, tint, echo, shuffle, magnify, or tunnel the interface,
but they do not own the interface.

Allowed:

- Render in the fixed `.celebration-stage`, which is `pointer-events: none`,
  `aria-hidden`, isolated, contained, and clipped to the viewport.
- Read bounding rectangles once at launch to aim particles or draw temporary
  representations of panels.
- Apply a single namespaced token such as
  `data-celebration-effect="accordion-reality"` plus namespaced CSS custom
  properties to the shell, sidebar, content shell, or day pane. The runtime owns
  removal.
- Transform/opacity/filter the live shell for a brief visual gag only if the
  preview shell is inert and the CSS has a no-motion/static fallback.
- Create an `aria-hidden`, `inert` visual clone when absolutely necessary, after
  stripping duplicate `id`, `for`, and interactive semantics. Prefer drawn
  rectangles or a stage illustration; cloning the full plan duplicates a lot of
  DOM and should be rare.

Forbidden:

- Dispatching clicks, keyboard events, checkbox changes, store commands, Tauri
  commands that resize/move the window, or edits to plan data.
- Reparenting or reordering live UI nodes; writing `innerHTML` from plan content;
  changing global theme/font preference; or leaving inline styles behind.
- `pointer-events: auto` on decorative content, focusable particles, duplicate
  live regions, or a per-particle DOM node count that grows without a hard cap.
- Capturing screenshots of the app or using installed/user database content as
  texture input. Effects can react to geometry and theme variables, never inspect
  or export user data.

Real completion is not inert: the user may immediately continue navigating.
Therefore UI-transforming completion effects must remain pointer-transparent and
must cancel on date/view change just like today's implementation.

## Accessibility and sensory safety

- Keep one polite, atomic status message per run. Suggested completion label:
  `Day finished — <effect name>`. Preserve `aria-label="Day finished"` if tests or
  consumers require the stable short name; the visible text can carry flavor.
- All spectacle layers are `aria-hidden="true"`. A screen reader should hear the
  achievement, not 70 descriptions of spinning fruit.
- Evaluate `matchMedia('(prefers-reduced-motion: reduce)')` at run time, not only
  at mount. Every effect must have an explicit reduced form: a static or gently
  fading themed emblem and the success banner, with no zoom, shake, parallax,
  rapid hue cycling, strobe, or full-screen spatial displacement.
- Avoid flashes entirely. No region larger than a quarter of the viewport may
  alternate high-contrast luminance more than three times in any one-second
  period. “Psychedelic” means evolving color/geometry, not seizure bait.
- Avoid red-only/green-only meaning. Generated colors need enough separation from
  the current theme; the success message remains readable on `--paper-strong` or
  a tested opaque backing.
- Do not add sound by default. Optional platform haptics must be a single subtle
  best-effort pulse, gated by Tauri/mobile availability and disabled in reduced
  motion. A rejection or unavailable plugin is silently ignored.
- At 200% zoom and 320 CSS px, Return now and the status must remain onscreen.
  Respect safe-area insets on mobile.

## Performance budget

Budgets apply to the intentionally wild effects too:

- Run for at most 5 seconds; fail-safe dispose by 6 seconds.
- One full-screen canvas per run. Clamp device pixel ratio to 2 and cap the
  backing store to about 4 million pixels by scaling down further when needed.
- Cap particles at 400 on desktop and 180 on mobile; DOM decorations at 80.
  Prefer batched canvas paths or one SVG tree to hundreds of elements.
- Target 60 fps on desktop and 30+ fps on mobile. Delta-time animation must clamp
  large resumed frames. Never allocate large arrays, measure layout, or call
  `getComputedStyle` inside the frame loop.
- Read all geometry in one preflight pass, then write styles. Animate transforms,
  opacity, and canvas. Restrict blur/backdrop-filter to small layers; a wild
  full-screen blur can overwhelm WebKit and Android GPUs.
- Give the stage `contain: strict; isolation: isolate;` where compatible and set
  `will-change` only while a run is active.
- Stop rendering when `document.hidden`, on abort, on unmount, and once every
  particle is dead. Resize via one debounced/rAF-coalesced handler.
- Registry metadata and card art should add little startup work. No network
  fetches, autoplay video, WebGL shader compilation, or 30 eager canvases in
  Settings.

Performance tests should exercise a modest mobile viewport and 2x DPR as well as
desktop. Exact pixel timing is flaky; assert bounded node/particle counts,
cleanup, canvas backing size, and absence of uncaught errors, then use tracing
for manual frame-budget review.

## Progressive enhancement and feature detection

All effects require a baseline path using ordinary CSS transforms/opacity or 2D
canvas. Advanced APIs enhance that baseline:

- `canvas.getContext('2d')` can return null; fall back to a DOM emblem.
- Guard `Path2D`, `OffscreenCanvas`, `createImageBitmap`, and `crypto.getRandomValues`
  by checking them on `globalThis`. Do not transfer the visible canvas offscreen
  unless cleanup and WebKit support have been proven.
- Use `CSS.supports(property, value)` and CSS `@supports` for `color-mix`, masks,
  `backdrop-filter`, `mix-blend-mode`, `overflow: clip`, individual transform
  properties, and CSS trig functions. Specify a plain color/gradient/transform
  first.
- Guard `CSS.registerProperty` and registration with `try/catch`; duplicate
  registration throws. Plain custom-property animation is the fallback.
- `document.startViewTransition` is optional. If used, wrap only the preview
  surface switch, give generated transition names unique values, and fall back
  to the existing synchronous view assignment plus `tick`. Never make preview
  restoration depend on the transition promise resolving.
- Popovers and dialogs are not decorative stages: their top-layer and focus
  behavior is inappropriate here. The Return now control should remain ordinary
  app DOM.
- Tauri capability checks must start with `isTauri()` and then catch imports/
  calls. Native enhancement failure cannot fail celebration or cleanup.

For deterministic tests, allow an injected numeric seed. Production can derive a
seed from `crypto.getRandomValues` with a `Math.random` fallback. Effects should
use a small seeded generator rather than calling randomness from many frame
callbacks; this makes a failed animation reproducible without forcing every real
completion to look identical.

## Recommended component boundary

- `celebrations.ts`: ids, normalized default id, registry metadata, capabilities,
  and effect runners. Exactly 30 unique entries are the source of truth.
- `CelebrationPicker.svelte`: Settings section, grid, roving focus, selection,
  and `onPreview(id)` callback. It knows no app navigation.
- `Celebration.svelte`: one stage/canvas/live message and an abortable
  `celebrate(kind, options?)` / `dismiss()` runtime. Day effects come from the
  registry; list behavior remains the current independent implementation.
- `App.svelte`: preference wiring and preview session state machine, because it
  owns `view`, active date, compare state, inert state, scroll, and focus return.

The picker must not import the store, and effect runners must not import
`plannerStore`. This keeps visual code physically unable to write tasks.

## Verification checklist

Automated coverage should prove:

- The registry contains exactly 30 unique valid ids; every entry has a name,
  fun description, static art, full runner, and reduced fallback.
- Missing/unknown preference ids normalize to the default and selection persists
  through `patchPreferences` / state reload.
- Cards expose name/copy/selected state; roving focus, Home/End, arrows,
  Enter/Space, pointer click, and replaying the selected card work.
- Activation saves immediately, previews calendar-yesterday without creating or
  changing a plan, then restores original view/date/compare state/scroll/focus.
- Return now and Escape restore early. A stale timer cannot return a newer
  session. Destroy/navigation/visibility changes fully clean up.
- The preview app shell is inert, while its Return now control remains usable.
- Reduced-motion mode creates no animated canvas loop or intense UI transform,
  still announces success, and returns reliably.
- No-2D-context and unsupported advanced CSS/API paths show the baseline and do
  not throw.
- Each effect disposes all DOM, root tokens, inline custom properties, rAF ids,
  timeouts, and listeners. Canvas backing dimensions and effect node counts stay
  under budget.
- Existing day and list celebration tests continue to pass, including unchecking
  the final item dismissing the current celebration and list completion retaining
  its current separate visual.

All tests and fixtures must use generated synthetic plans. They must never open,
decrypt, copy, or screenshot the user's installed database.
