# Situate

Situate adds device-local app boundaries to Balance on macOS and Android.
Enable it in **Situate**, review the preset targets, then grant the device permissions.
Settings and passes are local to each device; turning a mode off on one device does
not turn it off on another. Planner data is never shared with integrations.

## Defaults

- **Dolo:** social apps, messaging (Google Messages, WhatsApp, Messenger, Instagram,
  Feurstagram, Signal), and entertainment. Resets at 7 a.m. and evening. Its
  off quiz asks whether you got up and thrust your chosen object in and out of
  your bag.
- **Touch grass:** AI chats and entertainment. A daytime pass requires planning
  tomorrow and ends at evening. At night, confirm that you just peed and spent
  a minute in bed with the lights off and Herdr muted. Passes last 60 minutes,
  shortened to 30 minutes for passes started after the late-night boundary.
- **Discord:** Android only, manually enabled. Add more modes and choose which
  devices they apply to.

Evening is the later of 9:30 p.m. and sunset + 4 hours. The late-night boundary is
sunset + 8 hours, rounded to the nearest half hour. Enter an approximate latitude
and longitude in **Schedule**; calculation is offline. Without coordinates, or
when there is no sunset, the fallback times are 9:30 p.m. and 2:30 a.m.
The 7 a.m. Situate reset does not change the planner's day boundary.

Entertainment has a separate 15-minute pass. Answer no to “Is this visual
entertainment?” for work use. Answering yes requires confirming a meal, dishes,
bath, or toothbrushing. A pass applies to one target in one mode; overlapping modes
must each permit access. Mode quizzes, required yes/no answers, and conditions
on earlier answers can be edited independently.

## Mac and Chrome

Keep Balance running. Closing its main window while Situate is enabled leaves
it running in the background. App activation monitoring hides blocked apps; it
does not kill processes or discard work. Quitting Balance stops native app
monitoring. Add Balance to macOS Login Items if it should start after login.
Activation notices use macOS notification permission and obey system Focus settings.
They announce scheduled changes and expired passes, not modes you switch by hand.

1. Download the `situate-chrome` artifact from the Situate workflow, or use
   `integrations/situate/chrome` in this repository.
2. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.
3. Select the `chrome` directory. Its public manifest key keeps the ID stable.
4. Run `python3 integrations/situate/install-chrome.py`.
5. Open the extension popup to verify its connection to Balance.

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
`frank-threads.json` contract. Exact channel/thread IDs can also be added manually
as **Discord thread/channel** targets; unrelated Discord conversations remain usable.

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
