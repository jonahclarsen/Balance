# Settings-builder agent story: the extremely responsible party portal

I inherited the least glamorous-sounding part of this spectacle—“Settings and
App integration”—and it quickly became the part most likely to accidentally
turn a joke into a synced navigation bug. The visual-effects agent could make a
goose steal a deadline; my job was to ensure the goose could not also steal the
user's active date, scroll position, keyboard focus, or ability to escape.

I first read all three celebration design documents end to end, then built
`CelebrationSettings.svelte` directly from the 30-entry registry. Each entry is
an honest button inside the requested div, with its own name, fun explanation,
emoji icon, CSS-generated little poster, selected text/checkmark, and a
“Visually intense” warning where the catalog says intensity is 4 or 5. The cards
use roving focus: arrows, Home, and End move around without launching anything;
Enter, Space, or a click actually picks and previews. The giant all-caps
reminder is a real heading and the final child of the section, copied exactly
instead of “helpfully” proofreading the user's voice out of it.

The preview journey is where the careful machinery lives. I added a transient
`displayedPlanDate` that becomes calendar-yesterday only while the preview is
active. It never calls `plannerStore.setActivePlanDate`, so the temporary trip
cannot sync to another device, enter history, or survive a crash as the user's
new date. Existing comparison state remains untouched but is presentation-only
suppressed so yesterday gets one clean stage. I also skip persisting the
temporary Today view to local workspace state.

Before the jump, the code commits the selected celebration preference and
captures the Settings scroll position and originating card. It then makes the
whole live app shell inert and hidden from assistive technology, while mounting
an independent “Return now” control outside that shell. That button gets focus;
Escape is intercepted at the window level; hiding the document also ends the
preview. Returning dismisses the effect, restores Settings, waits for rendering,
puts the workspace at the exact old scroll offset, and returns focus to the card
without scrolling it again. A monotonically increasing token makes late timers
powerless to yank a newer session around. The stored comparison and active-date
values are captured for the return snapshot but intentionally never mutated—the
safest restoration is having nothing to undo.

The main day-completion observer now asks the player for the saved celebration
ID, while list completion still sends its own list request. That preserved the
important semantic split: finishing a checklist remains the existing little
list victory rather than inheriting whichever reality tunnel was chosen for a
whole day.

For the cards, I deliberately used original procedural CSS art and emoji rather
than 30 raster files. Three palette colors from each registry definition feed
different atmospheric, funny, culture, UI, trippy, and maximum-setting tile
motifs. It is lightweight, offline, readable at zoom, responsive down to one
column, and no miniature effects run while Settings is open. The compromise is
that these are expressive posters rather than bespoke hand illustrations for
every effect; the actual playback is where each concept gets its full identity.

Testing produced one funny false alarm. My first Playwright run reused port
5123, where the user's main checkout was already serving the old app—as the
project instructions warned it often would. Naturally, that version contained
zero celebration cards. I reran on isolated port 5124 and the mystery vanished.
The focused tests now verify all 30 cards and art tiles, the exact reminder,
preference persistence, yesterday preview, unchanged persisted active date,
inertness, early return, restored focus/scroll, and arrow navigation that does
not trigger a preview. They pass in desktop and Pixel 7 projects. `pnpm check`
also finishes with zero errors and zero warnings.

No database, recovery key, personal task data, native Android build, or real-data
screenshot was touched. The whole exercise used the browser's synthetic empty
state. In short: I built a velvet rope around the party, taught it where
yesterday is without writing that fact down, and made sure the emergency exit
works even when the kaleidoscope is being unreasonable.
