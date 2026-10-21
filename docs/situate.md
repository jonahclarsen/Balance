# Situate

Situate adds device-local app boundaries to Balance on macOS and Android.
Review the modes in **Situate**, then grant the device permissions.
Settings and passes are local to each device; turning a mode off on one device does
not turn it off on another. Planner data is never shared with integrations.

## Defaults

- **Dolo:** social apps, messaging (Google Messages, WhatsApp, Messenger, Instagram,
  Feurstagram, Signal), and entertainment. Resets at 7 a.m. and evening. Its
  off quiz asks whether you got up and thrust your chosen object in and out of
  your bag.
- **Touch grass:** AI chats and entertainment. A daytime pass requires planning
  tomorrow and ends at evening; an emergency instead grants 5 minutes. At night, confirm that you just peed and spent
  a minute in bed with the lights off and Herdr muted. Passes last 60 minutes,
  shortened to 30 minutes for passes started after the late-night boundary.
- **Discord:** mobile only, manually enabled.
- **Active Projects** (7 a.m.–8 p.m.) and **No Active Project** (9 p.m.–7 a.m.):
  reminder modes. They block nothing, have no quiz and can't be turned off; they
  appear in the sidebar only while on, and clicking one shows its description.

Each mode has a description, shown on its card and in the notification when it
turns on, a color used across Balance while it is on, and a device list (desktop, mobile, or
both). A mode appears only on the devices it covers, and edits save as you make them.

Evening is the later of 9:30 p.m. and sunset + 4 hours. The late-night boundary is
sunset + 8 hours, rounded to the nearest half hour. Sunset is calculated offline for
the largest Canadian city sharing the device's time zone (Vancouver for Pacific time,
Toronto for Eastern, and so on). Outside those time zones, or when there is no sunset,
the fallback times are 9:30 p.m. and 2:30 a.m.
The 7 a.m. Situate reset does not change the planner's day boundary.

Scheduled modes turn on at morning and evening; passing a mode's quiz turns it
off until the next one. There is no global switch: set a mode to **Only by hand**
to keep it off until you turn it on. Overlapping modes must each be passed.

Entertainment has a separate 15-minute pass for one site, offered from a blocked
site's gate or the Mac app prompt. Answer no to “Is this visual entertainment?” for
work use. Answering yes requires confirming a meal, dishes, bath, or toothbrushing.
Day, night and entertainment quizzes, required answers, and conditions on earlier
answers can be edited independently.

## Mac and Chrome

Keep Balance running. Closing its main window while Situate has rules leaves
it running in the background. App activation monitoring hides blocked apps; it
does not kill processes or discard work. Quitting Balance stops native app
monitoring. Add Balance to macOS Login Items if it should start after login.
Activation notices use macOS notification permission and obey system Focus settings.
They announce scheduled changes and expired passes, not modes you switch by hand.

Balance checks Chrome and Brave for the extension (reading only its entry in each
profile's preferences) and shows a warning until every installed browser has it.
**Set up** copies the extension to `~/.local/share/balance-situate/extension`,
installs the native messaging host for each browser, and lists the steps:
open the extensions page, enable Developer mode, then **Load unpacked** that folder.
Its public manifest key keeps the ID stable.

The extension reads only a small local Situate status file through Chrome native
messaging. No web server, Discord token, message content, browsing-history log,
or planner database is involved. Website permissions cover custom domains and
embedded media. It checks pages and single-page navigation once per second.
A stale connected feed restores the configured boundaries until Balance refreshes
it. Before the first successful connection, the popup reports setup is incomplete.

For Frank, the companion can refresh all thread IDs from its existing session index.
No Frank code changes or Discord token are needed. Run:

```sh
python3 integrations/situate/sync-frank.py --host oracle-arm \
  --sessions /absolute/Frank/state/sessions.json --watch
```

Use the instance's actual `FRANK_STATE_DIR/sessions.json` path. The fixed remote
reader outputs **only numeric Discord thread IDs**; session data and messages stay
on Frank's host. Keep this optional helper running (or add the command to your
login automation). It atomically updates a private local file every 30 seconds;
known IDs remain blocked during SSH outages. Newly created threads become known
on the next successful refresh. The Chrome host adds these IDs only to Touch grass.
For multiple instances on one host, repeat `--sessions` for each index. The SSH
account needs read access to those indexes; the helper never elevates privileges.
If an instance is unavailable, it retains the previous combined list. Different
hosts can instead export a combined ID list into the same private
`frank-threads.json` contract. A channel ID can also be added as a **Discord**
target; that blocks only threads opened inside the channel, not the channel itself.
For a thread opened on its own page, the extension reads the thread's parent channel
from the element IDs in Discord's channel list; a thread missing from that list is
not recognized unless it is a Frank thread.

## Herdr and Cactus

The optional adapters read `~/.local/share/balance-situate/status.json` (directory
0700, file 0600). Its allowlisted contract contains mode IDs/names, app/domain
rules, active state, expiry, and the quiz link. It contains no coordinates, quiz
answers, tasks, notes, recovery keys, or notification text. Readers cannot write
grants or run shell commands through the feed.

The local `herdr-broken` patch hides Codex/Claude tab content while Touch grass is
on, mutes sounds, and opens the Balance quiz with Enter. Other tabs work. Rebuild
and install that helper normally; attached clients must reattach to load the new
renderer, preserving their running terminal sessions.

The Cactus adapter shows an active night-pass countdown in its window and menu
bar. Its own timer continues underneath. Cactus cannot extend a Situate pass.
The Mac widget opens a compact Situate window, without loading the planner.
Android's widget can resize vertically and includes active mode controls.

## Android notification history

Grant notification access for logging/silencing and accessibility access for app
blocking. Enable **Mode notifications** so activation notices can appear. The accessibility service requests window-change identities only; it
cannot retrieve screen content or perform gestures. Grant exact-alarm permission
for schedule changes during idle; without it Android may delay alarms.

History is separate from the planner, in Android's no-backup directory. Payloads
use AES-GCM with fresh nonces and a separate Android Keystore key. App identities
and word-search terms use keyed HMAC indexes. No keys or plaintext notification
bodies are written to SQLite, synced, backed up, or sent to integrations. Receipt
and local-open timestamps and blocked flags are unencrypted indexes. OS-delivered
notification text may already be redacted, and Android may not let a listener
cancel every persistent/system notification.

Search whole words, filter by app or mode, show blocked entries, or sort by when
received or opened from this archive. “Opened here” is not a claim that Balance
knows when a notification was read elsewhere. Original notification actions are
kept in memory (up to 500); after process restart or expiry, tapping opens the
originating app instead. Export streams newline-delimited JSON to an Android
file-picker destination; it creates readable text only at the chosen destination.
A cloud-backed destination uploads that export. Delete history from the archive
controls when no longer needed.

These are voluntary friction controls. OS permissions, disabled extensions,
other browsers, direct terminal clients, or quitting the app can bypass them.
They are not a parental-control or hostile-user security boundary.

## Verification

`pnpm test:unit`, focused Situate browser tests, extension policy tests, native
Rust parity fixtures, Swift bridge checks, and Android generator checks cover the
rules and interfaces. CI runs the full browser suite and native tests. Android's
emulator smoke test explicitly opts into a separate synthetic archive fixture
with test-only keys, verifying encrypted persistence, search, filtering, updates,
reopening, export, and deletion. No installed personal database is a test fixture.
