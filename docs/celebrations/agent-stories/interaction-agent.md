# Interaction agent story: the tiny theatre with a fire exit

I was assigned the less glamorous but delightfully important part of the circus:
work out how 30 celebrations can kick furniture around *visually* without ever
being allowed to touch the user's actual furniture.

I began by reading the current `Celebration.svelte`, the completion observers in
`App.svelte`, the Settings markup and CSS, the replicated-preference normalizer,
and the existing Playwright checks. The current setup is pleasantly small: a day
gets a canvas burst, a list gets a checklist burst, one polite banner announces
the win, and moving away dismisses the show. I also found that the active date is
real persisted state and that Settings/Today scroll positions are remembered
separately. Those details turned the user's apparently simple “open the prior
day, play it, go back” into the interesting part of the job.

The main design idea arrived as “tiny theatre.” When someone chooses a card,
Balance saves the choice, puts yesterday onstage, and temporarily makes the real
app inert. The spectacle may bend the walls, tint the sidebar, or draw a fake
wormhole through the plan, but it gets only an isolated stage, read-only element
geometry, and one namespaced CSS token. A persistent Return now button is the fire
exit. After about four seconds, an abortable session restores the exact date,
comparison state, Settings scroll, and originating card focus. A monotonically
increasing session number prevents an elderly timeout from shambling back later
and kidnapping the user into Settings.

I spent an unreasonable but productive amount of thought on the 30-card keyboard
experience. Thirty tab stops would make the fun picker feel like filing taxes, so
the contract uses roving focus: arrows explore, Enter/Space performs, and simply
looking at another name does not launch a psychedelic field trip. Clicking the
already-selected card deliberately replays it. Each card carries a static little
poster rather than running 30 miniature particle engines in Settings.

The other hard line is sensory safety. “Really insane psychedelic” can mean
beautifully evolving geometry and color; it need not mean flashes, nausea, or a
GPU begging for parole. I gave every effect a reduced-motion fallback, banned
strobe-like high-contrast flashing, kept one calm screen-reader announcement,
and wrote explicit canvas, particle, DOM-node, DPR, duration, and cleanup budgets.
New CSS, view transitions, OffscreenCanvas, and Tauri haptics are all allowed as
best-effort enhancements, but every one has an ordinary CSS/2D-canvas exit ramp.

I did not change production code, run the app, inspect a database, or take a
screenshot. I also did not do external cultural/drug research; other agents were
assigned the effect ideation, while my assignment was grounded in this repository's
actual interaction conventions. My artifact is `UX_AND_RUNTIME.md`: a contract
for the implementers, including the user's exact all-caps reminder, preview state
machine, accessible picker behavior, cancellation rules, safe UI-play boundary,
feature detection, performance budget, component split, and verification list.

In short: I built no fireworks. I drew the fire code, marked the emergency exit,
and made sure the kaleidoscope cannot check a task by accident.
