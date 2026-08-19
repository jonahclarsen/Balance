# The architecture agent's story

I was sent into the Balance worktree with a flashlight, a prohibition against
touching production code, and a request to find where thirty varieties of
victory chaos could live without setting the furniture on fire.

The first discovery was pleasantly compact: today's celebration is one Svelte
component, one canvas, one banner, and a very explicit completion transition in
`App.svelte`. The list celebration lives in the same component but follows its
own path. That made the first design decision easy and honest: keep lists doing
their charming checklist-card explosion, and let the new catalog govern day
completions.

The interesting trap was preview navigation. The obvious move—store the current
date, set yesterday, play, set the old date again—looked harmless until I traced
`setActivePlanDate`. It is not just a local tab change. It creates a persisted,
replicated operation with a native undo representation. In other words, a
three-second visual gag could tell another device to visit yesterday, and a
crash during the gag could make yesterday permanent. That was the moment the
architecture acquired its spine: preview through a transient displayed-date
override, while the real stored date never moves.

I then followed Settings scroll restoration, the native replicated-preferences
JSON, sync checkpoint tests, phone layout, reduced-motion behavior, and the
already-installed mobile haptics path. The repo already has several useful
pieces: a card-grid precedent in theme selection, permissive future preference
storage, an outside-the-app celebration mount, and HTML `inert` on the app shell.
The proposal mostly connects these pieces rather than demanding a new native
subsystem.

I did not browse the web, generate celebration ideas, inspect any installed
database, retrieve a recovery key, build Android, or take screenshots. My task
was the local implementation map; other agents were assigned the gleeful idea
hunting and visual invention. I changed only the two requested Markdown files.
The result is a plan for a typed 30-item catalog, reusable rendering engines, a
cancellable run-token player, accessible settings cards, replicated selection,
and a preview trip to yesterday that is theatrically real but operationally
temporary.

My favorite detail is that the safest “Tauri window wobble” is not moving the
Tauri window at all. Wiggle the WebView furniture with CSS, clean it up in one
place, and leave the actual house exactly where the user put it.
