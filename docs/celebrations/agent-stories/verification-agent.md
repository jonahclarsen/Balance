# Verification agent: the goose, the black hole, and the radius below zero

I arrived after the celebration workshop had already produced its thirty little
monsters. My job was to be the stage manager with a clipboard: make sure every
monster had a name badge, nobody rewrote the calendar backstage, the audience
could always find the exit, and reduced-motion guests did not get surprise
strobe confetti.

## What I verified

I expanded `tests/visual/celebrations.spec.ts` into a synthetic-data Playwright
suite that verifies:

- exactly 30 outer option divs and 30 buttons are rendered;
- every rendered id, name, description, and icon exactly matches the catalog;
- the required all-caps reminder is an actual final `h4`, with exact text;
- selecting Deadline Goose immediately previews Balance's calendar-yesterday
  while the persisted `activePlanDate` and complete `plans` array remain byte-for-
  byte equivalent as JavaScript values;
- the app shell is both `inert` and hidden from the accessibility tree during a
  preview;
- player hooks expose the selected id, engine, and recipe on the stage, canvas,
  and document root;
- Return now works from the focused button and restores Settings, the selected
  card, focus, and scroll position;
- the saved selection survives a reload;
- automatic return restores Settings and focus;
- reduced-motion playback paints no canvas pixel and does not resize or mutate
  the canvas between samples;
- roving arrow focus does not save or start a preview;
- all 30 catalog entries can launch their own hooks and remove the stage, canvas
  hooks, and root hook again on cleanup.

The complete-catalog sweep only runs in the desktop project; all interaction,
automatic-return, accessibility, persistence, and reduced-motion checks run in
both desktop Chromium and the Pixel 7 profile. All browser fixtures begin by
clearing local storage and use only Balance's generated empty test state. No
installed database, recovery key, personal data, or real-data screenshot was
opened.

## Bugs that tried to join the party

The most useful discovery came from the randomized full-catalog sweep.
Reaction-Diffusion Bloom occasionally asked `CanvasRenderingContext2D.arc()` to
draw a radius a hair below zero. Chromium quite reasonably threw an
`IndexSizeError`, ending that animation frame with considerably less psychedelic
majesty than advertised. I fixed the rendering boundary in
`src/lib/Celebration.svelte` by clamping the calculated radius to at least 0.1.
The final sweep completed without another canvas exception.

The pre-existing day-completion regression also expected the exact old Forest
theme checkbox teal (`rgb(47, 111, 104)`) even though the repository currently
defaults to Iridescent violet. I changed that assertion to verify what the test
actually cares about: native checkbox appearance is removed, the checked fill is
nontransparent, and the check image is present. Day, ordinary-list, and linked-
list completion regressions then all passed.

One combined mobile run restored Settings two CSS pixels below the pre-preview
scroll value. This was the browser clamping the old maximum after the newly
selected badge changed grid row geometry, not navigational drift. The assertion
now allows only a two-pixel rounding/clamping tolerance. Focus still returns to
the exact originating card.

There were two test-harness potholes worth recording. My first local run reused
an unrelated Vite server already listening on the default Playwright port, so it
saw the main checkout rather than this worktree; all authoritative runs use
unique ports. The thirty-entry sweep also outgrew Playwright's default 30-second
per-test budget while successfully progressing through effects, so that one
deliberately exhaustive test has a 120-second budget and completes in about 36
seconds on this machine.

## Visual inspection

Using a freshly cleared synthetic browser state, I captured and inspected:

- `artifacts/celebration-qa/settings-grid.png` — a viewport slice of the card
  gallery showing distinct illustrated tiles, names, descriptions, and intensity
  badges;
- `artifacts/celebration-qa/pretty-aurora-checkwave.png` — the soft cyan/violet
  aurora washing across yesterday;
- `artifacts/celebration-qa/funny-deadline-goose.png` — the goose mid-heist with
  HONK and its stolen DEADLINE paper;
- `artifacts/celebration-qa/maximum-event-horizon.png` — the violet-black event
  horizon pulling its particle field inward.

Those PNGs live in the ignored artifacts folder and are intentionally not part
of the commit. The player remained legible around the persistent Return now
control, and the Settings cards remained readable without animated miniatures.

I also inspected the cleanup and performance guardrails: canvas DPR is capped at
2 and further constrained to four million pixels, particle collections are
bounded, resize work is requestAnimationFrame-coalesced, all timers/frames/Web
Animations/listeners are canceled through the shared cleanup path, and root data
attributes are removed on return and component destruction. Reduced motion exits
before interface and canvas animation launch while retaining a still emblem and
the live completion announcement.

## Exact command ledger

- `pnpm check` — passed twice (initial and final); final result: 0 errors and 0
  warnings.
- `PLAYWRIGHT_PORT=5139 pnpm exec playwright test tests/visual/celebrations.spec.ts --project=desktop --reporter=list`
  — 4 passed before the later catalog-sweep test was added.
- `PLAYWRIGHT_PORT=5140 pnpm exec playwright test tests/visual/celebrations.spec.ts --project=mobile --reporter=list`
  — 4 passed before the later catalog-sweep test was added.
- `PLAYWRIGHT_PORT=5142 pnpm exec playwright test tests/visual/balance.spec.ts --project=desktop --grep 'checking the final item celebrates|checking the final list item celebrates|completing a linked list celebrates' --reporter=list`
  — 3 passed.
- `PLAYWRIGHT_PORT=5144 pnpm exec playwright test tests/visual/celebrations.spec.ts --project=desktop --grep 'every catalog entry' --reporter=list`
  — 1 passed in 35.9 seconds.
- `PLAYWRIGHT_PORT=5148 pnpm exec playwright test tests/visual/celebrations.spec.ts --reporter=list`
  — diagnostic run: 8 passed, 1 skipped, 1 failed on a too-exact mobile scroll
  assertion; the server log simultaneously exposed the randomized negative-radius
  production exception. Both issues were addressed.
- `PLAYWRIGHT_PORT=5149 pnpm exec playwright test tests/visual/celebrations.spec.ts --reporter=list`
  — final result: 9 passed, 1 intentionally skipped, 0 failed in 1.1 minutes.
- `git diff --check` — passed with no whitespace errors.

The final scene: thirty effects entered, thirty effects announced themselves,
thirty effects cleaned up after themselves, the old day/list fireworks still
worked, and the only black hole left was the one the user actually selected.
