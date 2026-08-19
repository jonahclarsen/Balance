# Day-completion celebration concept research

Research pass: 2026-08-19. This catalog is an implementation brief, not a request to reproduce any referenced artwork. Every proposed settings tile can be made with an original emoji/icon and procedural CSS/canvas graphics, so the feature does not need third-party image assets or licenses.

## Randomized research method

To keep the idea search from simply following the first things that came to mind, I made a twelve-entry rabbit-hole pool, read eight bytes from `/dev/urandom`, interpreted them as four unsigned 16-bit integers, and used each value modulo twelve. The draw was `10740, 16790, 52269, 25313`, producing indices `0, 2, 9, 5`:

0. Hokusai and printed waves
1. Paper marbling
2. Mexican papel picado
3. Kinetic typography
4. Art Nouveau ornament
5. Islamic geometric design
6. Bioluminescence
7. Glitch art
8. Dada
9. Op Art and psychedelic poster design
10. Stained glass
11. Aurorae

Those four random subjects became concepts 13–16 and 22. The rest deliberately fan out into funny characters, quiet beauty, interface choreography, and effects that are joyfully excessive without being hostile to the user.

## Compact taxonomy

| Range | Primary style | Intensity | Main surface | Typical renderer |
|---|---|---:|---|---|
| 1–6 | Pretty / restorative | 1–3 | Above the day | CSS + small DOM or Canvas 2D |
| 7–12 | Funny / characterful | 2–3 | Across task rows | DOM + CSS |
| 13–16 | Art/culture-inspired | 2–4 | Above and around the day | Canvas 2D, SVG paths, CSS |
| 17–21 | UI-playful | 2–4 | The existing day UI itself | DOM measurements + Web Animations |
| 22–26 | Trippy | 3–5 | Full-viewport visual layer | Canvas 2D + compositing / CSS filters |
| 27–30 | Maximum / reality-bending | 5 | Full viewport or native shell | Canvas feedback, UI snapshots, Tauri APIs |

Intensity 1 is a gentle flourish; 5 is intentionally ridiculous. Presets 22–30 should be labeled visually intense in Settings. None should emit sound by default.

## The 30 concepts

The **tile line** is ready-to-use copy for the fun explanatory div in Settings. The emoji is the tile's icon; an optional procedural thumbnail can animate only on hover/focus unless reduced motion is requested.

### Pretty and restorative

#### 1. Aurora Checkwave (`aurora-checkwave`) — 🌌

- **Tile line:** “Your finished day exhales a slow curtain of northern-light color.”
- **Show:** Three translucent, blurred gradient ribbons rise behind the task list while tiny check-shaped stars appear, then the color drains into the app accent.
- **Build:** CSS pseudo-elements using layered radial/conic gradients, `filter: blur()`, `mix-blend-mode: screen`, and transforms. Feasibility: **easy**; no canvas required.
- **Run:** 3.6 seconds, intensity 2/5.
- **Reduced motion:** A still aurora gradient fades in once and remains for 1.2 seconds; no ribbon movement.

#### 2. Dandelion Done (`dandelion-done`) — 🌬️

- **Tile line:** “Every checkbox becomes a seed and floats off to take tomorrow off.”
- **Show:** Checkmark seeds lift from task-row positions, follow lazy curved paths, and dissolve at the window edge. The completed rows stay put; only decorative duplicates travel.
- **Build:** Measure visible checkbox centers, create at most 28 lightweight spans, animate with `offset-path`/`offset-distance`; fall back to translated Web Animations keyframes. Feasibility: **easy-medium**.
- **Run:** 3.2 seconds, intensity 2/5.
- **Reduced motion:** A soft dandelion rosette appears beside the completion message; no particles.

#### 3. Constellation Closure (`constellation-closure`) — ✨

- **Tile line:** “Tonight's tasks connect into a tiny constellation that only exists once.”
- **Show:** Points bloom at checkbox centers and a canvas draws delicate lines between them in row order; the resulting constellation drifts upward beneath a date-shaped star label.
- **Build:** DOM measurement plus Canvas 2D. Seed jitter and extra stars from the date so a given day gets a stable constellation. Feasibility: **medium**.
- **Run:** 4 seconds, intensity 2/5.
- **Reduced motion:** Draw the final static constellation for 1.5 seconds.

#### 4. Bioluminescent Tide (`bioluminescent-tide`) — 🪼

- **Tile line:** “A midnight tide rolls in, and every completed task glows when it touches the water.”
- **Show:** A low translucent wave crosses the bottom third of the view. Cyan, violet, and teal specks flare near task rows like disturbed plankton.
- **Build:** Canvas 2D sine curves, additive compositing (`lighter`), restrained bloom via shadow blur. Cap device-pixel ratio and particle count. Feasibility: **medium**.
- **Run:** 4 seconds, intensity 3/5.
- **Reduced motion:** One static dark-blue wave with a sparse glowing edge; no flicker.

#### 5. Stained-Glass Sunrise (`stained-glass-sunrise`) — 🌅

- **Tile line:** “The day cracks into jewel-colored panes, then sunrise shines through.”
- **Show:** Original irregular polygon panes assemble from the edges, warm from indigo to gold, and become transparent to reveal the unchanged interface.
- **Build:** One SVG overlay with generated polygon paths, CSS variables, `clip-path`, and a warm radial gradient. Do not imitate a particular building or sacred iconography. Feasibility: **medium**.
- **Run:** 3.4 seconds, intensity 3/5.
- **Reduced motion:** Display the completed mosaic at low opacity, then crossfade once.

#### 6. Moonlit Fireflies (`moonlit-fireflies`) — 🌙

- **Tile line:** “Quiet little lights gather around the last checkmark, then wander home.”
- **Show:** A dozen warm lights meander near the task list and briefly form a large check before dispersing. It is the deliberately calm choice.
- **Build:** Small DOM nodes or Canvas 2D with seeded Bézier paths and opacity breathing. Feasibility: **easy**.
- **Run:** 4.5 seconds, intensity 1/5.
- **Reduced motion:** Static check-shaped points with one opacity fade.

### Funny and characterful

#### 7. Deadline Goose (`deadline-goose`) — 🪿

- **Tile line:** “A goose steals the final deadline and honks offscreen. No follow-up questions.”
- **Show:** A simple original CSS/SVG goose marches across the bottom, grabs a decorative paper labeled “DEADLINE,” and exits while loose checkmarks wobble in alarm.
- **Build:** Inline original SVG or CSS shapes, not a game asset; Web Animations for walk cycles and paper pickup. Feasibility: **medium**.
- **Run:** 3.8 seconds, intensity 3/5.
- **Reduced motion:** Goose pops up holding the paper beside “Day finished,” then disappears without walking.

#### 8. Tiny Janitor (`tiny-janitor`) — 🧹

- **Tile line:** “Management sent one extremely small employee to sweep away the remaining stress.”
- **Show:** A thumbnail-sized janitor sweeps decorative dust motes and crossed-out scraps beneath the task panel; a tiny “all clear” sign lands at the end.
- **Build:** CSS character made from basic shapes plus 12–18 debris spans. Keep all semantics hidden from assistive tech. Feasibility: **medium**.
- **Run:** 4 seconds, intensity 2/5.
- **Reduced motion:** Static janitor and “all clear” placard.

#### 9. Department of Done (`department-of-done`) — 🗃️

- **Tile line:** “Your paperwork has been reviewed by the Department of Done and found suspiciously complete.”
- **Show:** A huge red **APPROVED** stamp thumps onto a temporary snapshot of the task panel; three tiny bureaucratic seals appear with increasingly silly microcopy.
- **Build:** CSS typography, transforms, and optional `document.startViewTransition()` snapshot. Text must remain decorative; the normal completion live region announces once. Feasibility: **easy**.
- **Run:** 2.8 seconds, intensity 3/5.
- **Reduced motion:** The approval stamp simply appears with no impact shake.

#### 10. Task Toaster (`task-toaster`) — 🍞

- **Tile line:** “The plan is toast—in the positive, butter-adjacent sense.”
- **Show:** A tiny toaster rises, task slips compress into it, and two checkmark toasts pop up wearing absurdly confident expressions.
- **Build:** CSS shapes and DOM keyframes; no images required. The slips are generated labels, never copies of real task text. Feasibility: **medium**.
- **Run:** 3.5 seconds, intensity 3/5.
- **Reduced motion:** A toast icon and “perfectly done” label appear beside the banner.

#### 11. Victory Roomba (`victory-roomba`) — 🤖

- **Tile line:** “A tiny robot vacuums up the day's leftover chaos and bumps into the sidebar once.”
- **Show:** A round bot follows a deterministic wandering path, collects decorative stress-cloud blobs, bonks harmlessly against a UI edge, rotates, and leaves.
- **Build:** DOM/CSS with collision waypoints derived from the central panel bounds. Never move or cover actual controls for more than a moment. Feasibility: **medium**.
- **Run:** 4.2 seconds, intensity 2/5.
- **Reduced motion:** Bot is parked with a “clean” indicator; no travel or bump.

#### 12. Checkbox Chorus Line (`checkbox-chorus-line`) — 👯

- **Tile line:** “The checkboxes have unionized, rehearsed, and prepared a six-second finale.”
- **Show:** Decorative checkbox doubles line up at the bottom, kick in alternating rhythm, tip tiny hats, and collapse back into one master check.
- **Build:** DOM nodes with staggered CSS custom properties. Keep the rhythm comfortably below three strong contrast changes per second. Feasibility: **easy**.
- **Run:** 3.9 seconds, intensity 3/5.
- **Reduced motion:** A neat line of bowed checkmarks is shown statically.

### Art and culture-inspired

#### 13. Hokusai Task Tide (`hokusai-task-tide`) — 🌊

- **Tile line:** “Layered indigo waves curl over the day and leave every task sparkling clean.”
- **Show:** An original stylized wave sweeps horizontally in layered indigo and Prussian-blue tones; foam resolves into small checks. Use the general energy of woodblock curves and layered color, not a tracing of *The Great Wave*.
- **Build:** Canvas/SVG Bézier paths with two blue passes and paper-grain noise. The Met's technical discussion of layered indigo and Prussian blue is the useful process cue. Feasibility: **medium**.
- **Run:** 4 seconds, intensity 4/5.
- **Reduced motion:** Final original wave composition appears as a still translucent border at the bottom.

#### 14. Papel Picado Breeze (`papel-picado-breeze`) — 🎏

- **Tile line:** “A bright cut-paper banner arrives because finished days deserve decorations.”
- **Show:** A string of original perforated paper rectangles unfurls across the top and sways gently; motifs are neutral checks, flowers, suns, and Balance-like geometric shapes.
- **Build:** CSS/SVG masks generated in code. Attribute the tile's inspiration as **Mexican papel picado**, an art used for many celebrations; do not reduce it to “Day of the Dead,” borrow sacred motifs, or use skulls by default. Feasibility: **medium**.
- **Run:** 4.2 seconds, intensity 2/5.
- **Reduced motion:** The banner unfurls instantly and remains still before fading.

#### 15. Infinite Tile Garden (`infinite-tile-garden`) — ✳️

- **Tile line:** “Stars and crosses tessellate outward until the whole day finds geometric balance.”
- **Show:** An original eight-point-star/cross tessellation grows from the final checkbox, with botanical curls and a teal/cobalt/gold palette, then contracts into one rosette.
- **Build:** SVG pattern or CSS conic gradients with mathematically generated symmetry. Credit **Islamic geometric design** as the inspiration; avoid pseudo-Arabic text, Qur'anic calligraphy, mosque decoration claims, or calling all regional traditions interchangeable. Feasibility: **medium**.
- **Run:** 4.4 seconds, intensity 4/5.
- **Reduced motion:** One completed rosette is displayed, with no expansion.

#### 16. Dada Receipt Storm (`dada-receipt-storm`) — 🧾

- **Tile line:** “A receipt declares: 1 DAY, 100% DONE, LOGIC OPTIONAL.”
- **Show:** A nonsense receipt unspools, a rubber fish and a geometric bowler hat cross it, then the pieces reassemble by chance into a giant check. This nods to Dada's chance, collage, wordplay, and irreverence without pretending nonsense lacks historical context.
- **Build:** Original DOM typography and CSS collage shapes with date-seeded ordering. No archive images. Feasibility: **easy-medium**.
- **Run:** 3.7 seconds, intensity 3/5.
- **Reduced motion:** Show the absurd finished receipt as a static card.

### The interface joins the performance

#### 17. Domino Day (`domino-day`) — 🁢

- **Tile line:** “The task cards tip like dominoes, then politely stand themselves back up.”
- **Show:** Snapshot doubles of visible rows rotate in sequence around their bottom edge; each fall releases a check pulse. The real rows stay interactive underneath an inert overlay.
- **Build:** `getBoundingClientRect()` plus cloned visual shells or View Transition snapshots; Web Animations with stagger. Feasibility: **medium**.
- **Run:** 3 seconds, intensity 3/5.
- **Reduced motion:** A sequential border highlight travels down the rows without transforms.

#### 18. Gravity Is Optional (`gravity-is-optional`) — 🪐

- **Tile line:** “The interface loses gravity, floats for a moment, then remembers it has responsibilities.”
- **Show:** Decorative snapshots of headers, task rows, and small controls drift a few pixels upward with individual rotations, orbit a central check, and settle exactly into place.
- **Build:** Never move the live DOM; create `pointer-events: none` shells from element geometry. Cap displacement at 6% of viewport and cancel cleanly on navigation. Feasibility: **hard but safe if snapshot-based**.
- **Run:** 4.5 seconds, intensity 4/5.
- **Reduced motion:** Apply a soft “zero-g” shadow and single opacity pulse to the panel.

#### 19. Task Zipper (`task-zipper`) — 🤐

- **Tile line:** “The day zips itself closed and adds one extremely official check-shaped pull tab.”
- **Show:** Two decorative halves of the plan slide together along a zigzag seam from bottom to top; the pull tab arrives at the date header, then the seam opens to restore the view.
- **Build:** Overlay snapshot clipped into left/right polygons, SVG seam, `offset-path` pull tab. Feature-detect motion paths. Feasibility: **medium-hard**.
- **Run:** 3.6 seconds, intensity 3/5.
- **Reduced motion:** Show a static gold zipper line and tab briefly.

#### 20. Curtain Call (`curtain-call`) — 🎭

- **Tile line:** “Your tasks take a bow while velvet curtains insist this was all very prestigious.”
- **Show:** CSS curtains enter from both sides, completed rows bow as snapshot cards, then a spotlight check appears and the curtains reopen.
- **Build:** Gradient curtains, a radial-gradient spotlight, and row shells animated via the Web Animations API. Feasibility: **medium**.
- **Run:** 4.2 seconds, intensity 3/5.
- **Reduced motion:** Stationary side curtains frame the success banner.

#### 21. Interface Inhale (`interface-inhale`) — 🫧

- **Tile line:** “Everything breathes in, breathes out, and discovers there is nothing left to do.”
- **Show:** Panels subtly expand from their centers, border radii soften into bubbles, accent color rolls across them, and everything returns with a satisfied one-pixel settle.
- **Build:** Animate existing container CSS variables only if they have no active interaction; otherwise animate inert overlays. Use registered custom properties with `@property` where supported and plain transform fallback. Feasibility: **easy-medium**.
- **Run:** 3.5 seconds, intensity 2/5.
- **Reduced motion:** A single background-color crossfade; no scaling.

### Trippy

#### 22. Op-Art Victory Pulse (`op-art-victory-pulse`) — ◉

- **Tile line:** “Black-and-white geometry bends around one impossible, extremely colorful check.”
- **Show:** Concentric lines and offset checker rings create an apparent bulge around the final check; a saturated accent slowly rotates through the center. The pattern then flattens into the UI grid.
- **Build:** CSS repeating-radial/conic gradients or Canvas 2D. Inspired by Op Art's deliberate perceptual effects and psychedelic posters' fusion of optical geometry, Art Nouveau-like curves, and vibrating colors. Never run high-contrast reversals faster than 3 Hz. Feasibility: **easy-medium**.
- **Run:** 3.8 seconds, intensity 4/5.
- **Reduced motion:** Static, low-contrast concentric art with a solid check.

#### 23. Liquid Chrome (`liquid-chrome`) — 🫠

- **Tile line:** “A blob of impossible chrome eats the empty to-do space and reflects a tiny rainbow.”
- **Show:** Metallic blobs merge across the panel, catch shifting iridescent highlights, and pull into a polished check-shaped droplet.
- **Build:** SVG filters (`feTurbulence`, displacement, specular-light-like gradients) or Canvas metaballs. Test WebView performance and keep the filter region bounded to the day panel. Feasibility: **medium-hard**.
- **Run:** 4 seconds, intensity 4/5.
- **Reduced motion:** Static chrome-check gradient without displacement.

#### 24. Kaleidoscope Checkbox (`kaleidoscope-checkbox`) — 🔮

- **Tile line:** “One checkbox is reflected into a tiny universe with suspiciously good symmetry.”
- **Show:** The last check duplicates into 12 mirrored wedges, cycles through Balance accent-derived colors, blooms to the viewport edge, and folds back.
- **Build:** Canvas 2D wedge clipping and rotation, or six CSS mirrored segments. Seed shapes by date; use no external imagery. Feasibility: **medium**.
- **Run:** 4.4 seconds, intensity 5/5.
- **Reduced motion:** A single static, muted mandala/check rosette.

#### 25. Chromatic Echo (`chromatic-echo`) — 🫨

- **Tile line:** “The interface leaves red, green, and blue ghosts of itself, then snaps into perfect focus.”
- **Show:** Three inert panel silhouettes separate by a few pixels, ripple outward with `mix-blend-mode: screen`, hue-rotate, and reconverge sharply on the completion banner.
- **Build:** DOM snapshot shells or pseudo-elements with clipping; avoid cloning readable task text if a simple panel silhouette works. Feasibility: **easy-medium**.
- **Run:** 2.8 seconds, intensity 4/5.
- **Reduced motion:** One low-opacity colored outline with no oscillation.

#### 26. Reaction-Diffusion Bloom (`reaction-diffusion-bloom`) — 🦠

- **Tile line:** “Organic spots grow from every checkmark like the day just invented its own microscopic weather.”
- **Show:** Coral-like spots and labyrinth bands grow, merge, and are cleared by a final circular wave. It should look biological and alien, not be sold as a simulation of a drug experience.
- **Build:** Pragmatic version: date-seeded Canvas 2D cellular automaton or blurred metaballs with thresholding. Ambitious version: worker/OffscreenCanvas. Feasibility: **hard**; use a 0.5-resolution buffer and upscale.
- **Run:** 4.8 seconds, intensity 5/5.
- **Reduced motion:** Render one precomputed still frame, then fade.

### Maximum setting: lovingly unreasonable

#### 27. Infinite Feedback Cathedral (`infinite-feedback-cathedral`) — 🌀

- **Tile line:** “The day falls through an endless neon tunnel made from echoes of its own interface.”
- **Show:** A simplified panel silhouette is copied into the previous frame, scaled/rotated slightly, and color-shifted to make a deep feedback tunnel. A check flies through it and pulls the normal UI back into focus.
- **Build:** Two alternating low-resolution canvas buffers with `drawImage`, `globalCompositeOperation`, scale, and hue-shifted overlays. Use silhouettes, never captured personal text. Feasibility: **hard but bounded**.
- **Run:** 5 seconds, intensity 5/5.
- **Reduced motion:** Static low-contrast nested frames, no tunnel motion.

#### 28. Event Horizon (`event-horizon`) — 🕳️

- **Tile line:** “Every unfinished possibility collapses into a black hole; one radiant check escapes.”
- **Show:** Decorative task-row outlines bend into curved orbital paths, spiral toward a dark center, then erupt as a quiet halo and one oversized check. No strobing starburst.
- **Build:** Canvas 2D particles on logarithmic spirals, radial gradients, additive halo. A shader could improve distortion, but Canvas is more portable and sufficient. Feasibility: **medium-hard**.
- **Run:** 4.6 seconds, intensity 5/5.
- **Reduced motion:** Static black-disc/halo motif with the check outside it.

#### 29. UI Mitosis (`ui-mitosis`) — 🧬

- **Tile line:** “The interface divides into baby interfaces, each checks one microscopic task, and they merge back into the mothership.”
- **Show:** Four simplified miniature panel shells bud from the real panel, independently stamp tiny checks, orbit once, and merge into the completion banner.
- **Build:** Layout-derived vector shells, not screenshots of actual text. Web Animations with transform-only motion and strict cleanup on cancellation. Feasibility: **hard**.
- **Run:** 5 seconds, intensity 5/5.
- **Reduced motion:** Four static mini-panels flank the success message.

#### 30. The App Demands Applause (`app-demands-applause`) — 👏

- **Tile line:** “Balance informs the operating system that this achievement concerns everyone.”
- **Show:** Inside the webview, the title area gains a marquee of checks and the panel performs a tiny bow. On supported desktop platforms, Tauri's taskbar/dock progress advances rapidly to 100%, then requests user attention once; all native state is reset immediately. On mobile, optional success haptics can be considered separately, but only if the existing plugin and permissions are intentionally added and CI verifies them.
- **Build:** Tauri window APIs are platform-specific and permission-gated; wrap every call, tolerate rejection, restore progress state in `finally`, and use the pure-CSS title/panel show as the universal path. Do **not** move or resize the actual OS window. Feasibility: **medium**.
- **Run:** 3.4 seconds, intensity 5/5 conceptually, 2/5 motion.
- **Reduced motion:** No native attention request or progress animation; show a static title check and completion status only.

## Shared implementation guardrails

1. **One registry, one runner.** Define metadata (`id`, name, tile line, icon, category, intensity) separately from effect implementations. Each effect receives a root, measured safe UI landmarks, a date-seeded PRNG, an `AbortSignal`, and a reduced-motion flag; each must return/perform cleanup.
2. **The live app stays authoritative.** UI-playful effects animate inert shells, silhouettes, or View Transition snapshots. They must not temporarily uncheck tasks, change dates, mutate focus, intercept pointer input, or expose task text to canvas capture.
3. **Preview is a transaction.** Save the exact current view/date/scroll/focus/settings-panel state; navigate to the prior day; wait for its render; run the chosen preset; abort on any user navigation; return to Settings after a preset-defined duration; restore focus to the selected tile. Rapid clicking should cancel and replace the previous preview. A “Stop preview” control and Escape handling are worthwhile.
4. **The previous day may not exist or may be empty.** Use yesterday's date as requested and let the celebration use generic panel landmarks; never rewrite yesterday to make it look completed. If date navigation cannot render, preview in a non-persistent synthetic shell rather than touching stored tasks.
5. **Accessibility is behavior, not a final media query.** Read `prefers-reduced-motion` at launch, offer a Settings-level “reduce celebration motion” override, announce “Day finished” exactly once, mark all visual ornaments `aria-hidden`, preserve keyboard focus, and avoid full-screen flashes or rapid high-contrast alternation. Maximum presets should carry a “visually intense” badge.
6. **Bound performance.** Cap DPR (for example 2), use low-resolution feedback buffers, pause/cancel on `visibilitychange`, avoid per-frame layout reads, enforce a hard timeout, and clear canvases/timers/animations on every exit path. OffscreenCanvas is an optional enhancement, not a requirement.
7. **Feature detection and fallbacks.** Guard `document.startViewTransition`, `offset-path`, `@property`, blend modes, SVG filters, and any Tauri call. Advanced CSS should add polish, not become the only way to see success.
8. **Stable variety.** Use date-seeded variation inside a chosen preset so each day looks a little different but preview/test output is reproducible. Keep nondeterministic selection only for an eventual explicit “random favorites” mode.
9. **No cultural costume rack.** Name sources when inspiration is specific; use geometry, process, rhythm, and palette rather than sacred text, stereotypes, or copied artworks. The Settings explanation is enough room for a concise attribution.
10. **Testing seam.** Inject clock, PRNG, timers, reduced-motion query, and Tauri adapter. Unit-test registry completeness/unique IDs, effect cleanup, cancellation, selection persistence, and preview state restoration. Browser-level visual checks should use synthetic task data only.

## Sources and what they actually support

- The Metropolitan Museum of Art, [“The Great Wave: Anatomy of an Icon”](https://www.metmuseum.org/essays/hokusai-great-wave): Hokusai's print dates to roughly 1830–32; The Met's analysis describes layered indigo and Prussian blue contributing depth and movement. This supports the palette/process note for concept 13, not copying the composition.
- Smithsonian National Postal Museum, [“Stamp Stories: Day of the Dead”](https://postalmuseum.si.edu/stamp-stories-day-of-the-dead): describes papel picado's history in Puebla, cut-paper lineage, common bird/flower designs, banner construction, and its use across religious holidays, birthdays, weddings, and other Mexican celebrations. This is why concept 14 avoids treating the form as exclusively Día de los Muertos.
- Smithsonian Center for Folklife and Cultural Heritage, [“Altered Altars: The Changing Traditions of Día de los Muertos”](https://folklife.si.edu/magazine/altered-altars-changing-traditions-dia-de-los-muertos): emphasizes that practices vary with geography, social class, and belief. It reinforces the need to be specific and not flatten distinct traditions.
- Victoria and Albert Museum, [“Design and make your own Islamic tile and printed pattern”](https://www.vam.ac.uk/articles/design-and-make-your-own-islamic-tile-and-printed-pattern): discusses symmetry, cross-and-star tessellation, botanical detail, and examples from Iran and Syria. This supports concept 15's geometric mechanics while reminding implementation not to invent pseudo-calligraphy or universalize a diverse field.
- Museum of Modern Art, [“Dada”](https://www.moma.org/collection/terms/dada): characterizes Dada's use of chance, spontaneity, irreverence, collage, photomontage, performance, and wordplay, and grounds that humor in its World War I context. This supports concept 16's method, not a claim that Dada was merely goofy.
- Cooper Hewitt, Smithsonian Design Museum, [“Psychedlic Promotion”](https://www.cooperhewitt.org/2013/12/16/psychedlic-promotion/) and [“Remembering Wes Wilson”](https://www.cooperhewitt.org/2020/01/31/remembering-wes-wilson-1937-2020/): connect 1960s Bay Area psychedelic posters to Art Nouveau/Jugendstil organic curves, Optical Art geometry, moving lines, repeating forms, perception, and deliberately “vibrating” near-equal-value colors. These support the visual language in concept 22. They do not support claims about what taking a drug feels like, so this catalog makes none.
- MDN, [`Document.startViewTransition()`](https://developer.mozilla.org/en-US/docs/Web/API/Document/startViewTransition) and [Using the View Transition API](https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API/Using): same-document transitions capture old/new snapshots and can fall back to immediate DOM changes. MDN marks the document method newly Baseline 2025, so production must still feature-detect the embedded WebView.
- MDN, [`offset-path`](https://developer.mozilla.org/en-US/docs/Web/CSS/offset-path): elements can follow paths while `offset-distance` controls position. This supports the curved seed, zipper, and orbital routes.
- MDN, [Web Animations API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Animations_API): exposes timing and synchronization of DOM presentation changes, useful for cancellable UI choreography.
- MDN, [OffscreenCanvas](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas): permits canvas rendering away from the DOM and can run in a worker, supporting the optional worker path for heavier organic/feedback effects.
- Tauri v2, [JavaScript window API](https://v2.tauri.app/reference/javascript/api/namespacewindow/) and [core window permissions](https://v2.tauri.app/reference/acl/core-permissions/): window APIs include taskbar progress and user-attention requests and require suitable permissions. Behavior is platform-specific, so concept 30 must remain enhancement-only.
- Tauri v2, [Haptics plugin](https://v2.tauri.app/plugin/haptics/): haptics target Android/iOS, require explicit plugin setup/permissions, and can vary by Android hardware. This is why native haptics are a possible mobile follow-up rather than a hidden requirement of the main implementation.

## Shortlist recommendations if thirty is eventually too many

Keep one strong representative of each experience: **Moonlit Fireflies** (quiet), **Deadline Goose** (funny), **Hokusai Task Tide** (illustrative), **Domino Day** (UI-playful), **Reaction-Diffusion Bloom** (organic/trippy), and **Infinite Feedback Cathedral** (maximum). Keep the registry able to support all thirty, then let real use—not implementation novelty—decide favorites.
