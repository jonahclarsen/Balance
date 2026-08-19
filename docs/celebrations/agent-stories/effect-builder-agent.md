# Effect-builder agent: thirty tiny victory machines

I inherited the visual half of this wonderfully unreasonable request: turn one
confetti burst into thirty selectable endings without turning the planner into a
GPU benchmark or letting a joke animation touch anyone's tasks. I started by
reading the architecture, concept-research, and runtime/UX briefs. My first
command guessed the documents had generic names such as `ideas.md`; it failed
harmlessly, and `rg --files` led me to the actual three documents. That was the
only paperwork the Department of Done rejected.

The player became one re-entrant little theatre. A request now says whether this
is a day or list celebration and, for a day, supplies the exact catalog id and
whether it is a preview. Starting anything synchronously tears down the previous
show: it aborts the run, cancels animation frames, timers and Web Animations,
removes resize/visibility listeners and the root data token, clears the bounded
canvas, and empties only its own decorative stage. A monotonically increasing
token keeps old callbacks from wandering back onstage. I kept a compatibility
`celebrate()` bridge so older callers do not explode during integration, but the
new `play({ kind, ... })` API is the real contract.

The thirty effects share a few practical engines rather than thirty unrelated
programs. Canvas draws constellations, bioluminescent water, layered woodblock
waves, a twelve-wedge kaleidoscope, organic reaction rings, a neon feedback
tunnel, and an orbital event horizon. Bounded DOM/CSS scenes handle seeds,
fireflies, stained-glass polygons, cut-paper flags, tessellated stars, the goose,
janitor, toaster, Roomba, chorus, Dada receipt, zipper, curtains, chrome blobs,
UI mitosis, and the app's applause demand. A small set of guarded Web Animations
lets real UI surfaces bow, breathe, drift, echo RGB, or tip like dominoes without
reparenting them, reading task text, dispatching events, or modifying data.
Everything decorative is pointer-transparent and hidden from assistive tech;
one stable polite status reports the win.

The funniest engineering constraint was making every preset immediately
recognizable while refusing to capture personal content. The feedback cathedral
therefore tunnels through abstract neon panel rectangles, not screenshots. The
baby interfaces contain invented lines and checks, not miniature copies of the
day. The toaster eats generic victory toast. This costs some literalism, but it
is a good compromise: no database access, no screenshotting, no text clones, and
no risk that a task titled something private becomes confetti.

I also resisted the research concept's desktop dock/taskbar attention request.
That enhancement is capability- and platform-sensitive and would need native
state restoration and new permissions; a webview marquee and panel bow make the
joke portable. The applause recipe does get one guarded, best-effort 42 ms
mobile haptic through Balance's already-installed Tauri plugin, with browser
vibration as a caught fallback. Reduced-motion mode skips all loops, UI
transforms, and haptics and shows a static themed emblem instead.

Performance has hard walls: a single canvas, DPR capped at 2 and scaled further
to roughly four million backing pixels, at most 220 generated canvas points,
at most 48 decorative DOM pieces for any recipe, and a six-second cleanup
ceiling. Newer CSS such as `color-mix`, `mask-image`, `clip-path`, blend modes,
and `backdrop-filter` adds shine, but plain-color/gradient fallbacks keep the
show alive in older WebViews. The list-completion card and its orbit of checks
remain a distinct animation, as requested.

There was one real compiler stumble: Svelte does not allow an exported TypeScript
type in an instance script. I moved `CelebrationPlayRequest` into a module script,
then briefly imported its id type in both script scopes and earned a duplicate
identifier error. Removing the duplicate fixed it. The final full `pnpm check`
completed with zero errors and zero warnings.

The first picker test run happened while the shared worktree's App/Settings
integration was still landing and saw zero cards. Once those concurrent edits
were present, I reran the two focused desktop celebration tests against the
worktree's Vite server: both passed, including the complete preview/return trip
and keyboard roving. I also ran the existing final-item regressions. The list
celebration and nested-completion cases passed; the day case stopped before
triggering any celebration because its pre-existing checkbox-color assertion
did not see the exact expected computed green. I left that unrelated styling
assertion alone rather than contorting the effect player around it.

My favorite is **Infinite Feedback Cathedral**. It suggests something enormous
and slightly illicit using only a loop of rotating rectangles and a bright check
at the vanishing point. Deadline Goose is a close second because it spends its
entire 3.8-second career committing deadline theft, yelling once, and fleeing
the jurisdiction. That is a clean lifecycle.
