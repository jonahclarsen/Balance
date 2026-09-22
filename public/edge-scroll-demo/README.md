# Edge scroll playground

Run `pnpm demo:edge-scroll`, then open http://localhost:63653/edge-scroll-demo/index.html.
For a phone on the same Wi-Fi, use the Network URL printed by Vite with
`/edge-scroll-demo/index.html` appended. Port 63653 was randomly selected and is fixed.

This standalone page uses synthetic tasks and never loads Balance or its data.
Drag a task by its handle into the shaded top or bottom zone to scroll and
release to reorder. Save named favorites in this browser, or copy a link to
share the currently selected settings across devices. Saved favorites stay local.

The Current app preset reproduces TreeItemRow.svelte's 44px edge, 2px/frame
maximum, and integer-rounded linear ramp. Its speed depends on refresh rate.
The adjustable mode uses elapsed time (px/second), a power curve for edge
penetration, and optional exponential smoothing of velocity. Leaving the edge
or releasing stops immediately. The demo changes no production drag behavior.
