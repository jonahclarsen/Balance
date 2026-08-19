# How Balance acquired thirty ways to celebrate a finished day

This feature started with a fair complaint: confetti had become office
wallpaper. It ended with a deadline-stealing goose, a tiny janitor, layered
woodblock waves, a bureaucratic approval stamp, a task toaster, reaction-
diffusion weather, UI mitosis, and a black hole that emits one victorious check.

The finished implementation is deliberately both exuberant and boring in the
right places. The spectacle is varied; the state management is not. All thirty
effects live in one typed catalog, play through one bounded and cancellable
runner, respect reduced motion, and can be selected from one accessible Settings
gallery. Clicking a card briefly renders calendar-yesterday, plays the effect,
and returns to the exact Settings position and card—without ever persisting the
temporary date or touching a task.

## The cast and their own stories

These are the agents' first-person accounts, preserved as they wrote them:

- [Research agent: the day the goose met Hokusai](agent-stories/research-agent.md)
- [Architecture agent: victory chaos without setting the furniture on fire](agent-stories/architecture-agent.md)
- [Interaction agent: the tiny theatre with a fire exit](agent-stories/interaction-agent.md)
- [Effect builder: thirty tiny victory machines](agent-stories/effect-builder-agent.md)
- [Settings builder: the extremely responsible party portal](agent-stories/settings-builder-agent.md)
- [Verification agent: the goose, the black hole, and the radius below zero](agent-stories/verification-agent.md)
- [Root agent: ringmaster's log](agent-stories/root-agent.md)

Their working documents are also part of the record:

- [The exact thirty-concept research catalog](CONCEPT_RESEARCH.md)
- [The implementation architecture](ARCHITECTURE.md)
- [The interaction, accessibility, and runtime contract](UX_AND_RUNTIME.md)

## Act I: letting chance choose the rabbit holes

The research agent did not merely type “cool animation ideas” into a search box.
It made a twelve-topic pool, read eight bytes from `/dev/urandom`, and rolled
`10740, 16790, 52269, 25313`. Modulo twelve, that chose Hokusai and printed
waves, Mexican papel picado, Op Art/psychedelic poster design, and Islamic
geometric design.

Museum and primary documentation made the resulting ideas better and less
costume-like. The Hokusai effect borrows a process—layered indigo and Prussian-
blue movement—not a traced famous wave. Papel Picado Breeze uses original
neutral cut-paper motifs and does not flatten a broad Mexican celebratory form
into a single holiday stereotype. Infinite Tile Garden uses symmetry and
cross-and-star tessellation, with no invented calligraphy or generic “mystical”
dressing. Drug-adjacent research stayed in the reliable territory of perceptual
art and psychedelic-poster history; the project makes no pharmacological claims
and does not try to tell anyone what an intoxicated state “really” looks like.

The list was forced back down to exactly thirty. Generic particle variations
lost their seats to specific little performances: Deadline Goose, Tiny Janitor,
Task Toaster, Department of Done, Dada Receipt Storm, Task Zipper, UI Mitosis,
Reaction-Diffusion Bloom, and Infinite Feedback Cathedral.

## Act II: discovering that yesterday is replicated

The most important finding was not visual. Balance's active date is persisted
and synchronized. A naïve preview that called `setActivePlanDate(yesterday)` and
then restored it would create two replicated operations. Another device could
briefly follow the preview to yesterday, and a crash between those operations
could strand the saved navigation state there.

The architecture therefore introduced a transient `displayedPlanDate`. During
a preview, the normal Today surface genuinely renders yesterday, but the stored
active date never changes. Compare-day presentation is temporarily suppressed
without changing its saved state. The app shell becomes `inert` and leaves the
accessibility tree, while a focused **Return now** control remains outside the
shell. A monotonically increasing token makes stale timers harmless. On return,
Settings scroll and the originating card regain their exact places.

This is the core trick that makes the feature feel like navigation while keeping
it presentation-only.

## Act III: building thirty shows inside one theatre

The catalog is the single source of truth for each ID, name, icon, joke,
category, engine, recipe, duration, intensity, and palette. Settings renders its
cards directly from that catalog, so the gallery and player cannot drift into
two lists. Every card contains a CSS illustration, icon, visible name and full
description, selected state, and a “Visually intense” badge where appropriate.
Arrow keys rove through the gallery without launching anything; activation
saves and previews. The requested all-caps reminder is an actual final `h4`,
copied exactly.

The player uses reusable engines but thirty distinct recipes. Canvas handles
constellations, bioluminescent water, layered waves, kaleidoscope wedges,
reaction blooms, feedback tunnels, and the event horizon. DOM/CSS scenes handle
the characters, stained glass, flags, tessellation, Dada paperwork, zipper,
curtains, chrome, chorus, and baby interfaces. Guarded Web Animations let rows
bow, tip, drift, breathe, or leave RGB echoes without reparenting the live UI or
reading task text. The applause effect adds one optional, caught 42 ms native
mobile haptic through Balance's existing Tauri plugin.

Every run starts by cleaning the previous one. Timers, animation frames, Web
Animations, listeners, canvas pixels, root attributes, and stage nodes all have
one teardown path. Canvas DPR is capped at two and scaled down again beyond
roughly four million pixels; generated points and DOM pieces have hard ceilings.
Reduced motion skips loops, UI transforms, and haptics, and shows a calm themed
still instead of simply deleting the delight.

Nothing captures screenshots or readable task content. Feedback Cathedral is
made from abstract panel rectangles; UI Mitosis contains invented lines and
checks. The effects know geometry and theme colors, never the user's words.

## Act IV: what actually went wrong

There were several useful mishaps.

The first offline dependency install accidentally ran in the original checkout:
`git worktree add` creates a directory but does not move the shell into it. The
missing `svelte-check` binary exposed that immediately, and the install was
rerun correctly inside the isolated worktree.

Two early Playwright attempts landed on unrelated development servers already
using the default ports. Unique ports fixed the mystery of the suddenly missing
gallery. The in-app browser connection itself was unavailable because its
session metadata was incomplete, so visual QA used the repository's local
Playwright installation and synthetic empty state instead.

The existing day-completion regression failed before reaching a celebration: it
hardcoded the old Forest-theme teal checkbox, while this checkout defaults to
Iridescent violet. The assertion now tests its real contract—a nontransparent
checked fill and a check image—so it follows any selected theme.

The most valuable failure came from sweeping all thirty effects. Depending on
the random phase, Reaction-Diffusion Bloom could calculate a radius just below
zero and pass it to `CanvasRenderingContext2D.arc()`, which throws an
`IndexSizeError`. The renderer now clamps the radius to at least `0.1`.

One mobile restoration landed two CSS pixels below the old maximum scroll
position because the selected badge changed the gallery's final layout and the
browser clamped the scroll range. Focus still returned to the exact card; the
test now allows only that two-pixel layout tolerance.

A native test command also used `--exact` with an incomplete Rust test path and
honestly ran zero tests after a long cold compile. It was rerun with the correct
filter and passed the actual replicated-preference checkpoint test.

## Curtain call

The final focused browser suite reports **9 passed, 1 intentionally skipped, 0
failed**. The complete catalog sweep runs once on desktop; interaction,
persistence, accessibility, automatic return, reduced motion, and cleanup run
on desktop and the Pixel 7 profile. The three existing day/list/link
celebration regressions pass. Type/Svelte checks, Rust formatting, the production
Vite build, the native sync checkpoint test, and whitespace checks pass.

The screenshots used for review were synthetic and ignored: the gallery, Aurora
Checkwave, Deadline Goose mid-heist, and Event Horizon. No installed database,
recovery key, personal plan, Android build, or real-data screenshot was touched.

The goose stole only a fake deadline. Yesterday remained unsynced. The black
hole cleaned up after itself.
