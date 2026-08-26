---
name: balance-siri
description: Develop, debug, test, or document Balance voice capture through macOS Siri, Shortcuts, App Intents, and balance:// deep links. Use for intent discovery, spoken task fidelity, Siri reminder placement, request deduplication, or signed intent-extension installation. Do not use for unrelated widgets or ordinary planner editing.
---

# Balance Siri

Build and diagnose Balance's voice-capture path without claiming platform
capabilities that macOS does not provide.

## Start with the macOS boundary

Apple's current platform guidance says App Shortcuts are not supported on
macOS. App Intent actions are supported, so a person can build a custom shortcut
in the Shortcuts app and invoke that shortcut by name with Siri. Do not promise
that an `AppShortcutsProvider` phrase such as “Add to Balance [task]” will bind
directly on Mac merely because the metadata compiler accepts it. Confirm this
boundary against Apple's current [App Shortcuts platform
guidance](https://developer.apple.com/design/human-interface-guidelines/app-shortcuts)
if the OS or deployment target changes.

For the supported macOS Siri flow, keep the Balance action easy to compose in
Shortcuts with a normal `String` input. A custom shortcut named “Add to Balance”
can ask or dictate the task, then pass that text to the Balance action. Siri can
run the custom shortcut by name, but macOS does not pass an arbitrary spoken
suffix into an app-provided phrase.

Set the text parameter's `inputConnectionBehavior` to
`.connectToPreviousIntentResult`, but do not expect a graph socket or a different
control: macOS Shortcuts still renders a connectable `String` parameter as a
text box. To connect an earlier action, Control-click inside that field, choose
**Insert Variable > Select Variable**, then click the earlier action's blue Magic
Variable token. Verify the extracted metadata reports the nondefault connection
behavior and the editor displays the chosen variable as a blue token in the
text field.

If App Shortcut phrases are later added for a platform that supports them, the
metadata compiler only permits `AppEntity` and `AppEnum` phrase slots, not a raw
`String`. A transient text entity resolved with `EntityStringQuery` can preserve
the recognized text, but test the behavior on that supported platform.

## Know the capture path

- `src-tauri/macos/BalanceWidget/BalanceWidget.swift` exposes the App Intent. It
  must not read or decrypt Balance's database.
- The intent creates a one-time `balance://add?text=...&request=...` URL. On
  macOS, submit that custom scheme through `NSWorkspace`; `OpenURLIntent` only
  supports universal links and rejects `balance://`. The request identifier
  prevents the debug notification and normal URL activation from inserting the
  same task twice.
- `src/lib/deepLinks.ts` validates the URL. Reject blank or oversized input, but
  do not trim or otherwise rewrite accepted task text.
- `src/App.svelte` receives the deep link and calls the planner store.
- `src/lib/planner.ts` owns completion detection and Siri-heading placement.
- `src/lib/store.ts` selects the target Balance day and records the operation.
- `src-tauri/src/lib.rs` persists, syncs, undoes, and redoes the exact tree
  mutation using synthetic databases in tests.

The target is Balance's rollover-aware current day while it has any incomplete
task. Otherwise it is the following calendar day. Reuse the exact heading
`reminders from siri:`. On first creation, find the first incomplete root task,
then repeatedly descend through its first incomplete child; insert the heading
as the sibling immediately before the deepest task found. Put captured tasks
under that heading. If an existing heading or one of its ancestors is complete,
reactivate it when appending a new task.

## Preserve privacy and fidelity

- Never retrieve a database key or open, decrypt, export, or inspect the user's
  database. Use generated test databases and synthetic task trees.
- Never log task text, URL query contents, decrypted widget snapshots, or keys
  while diagnosing Siri or App Intents lifecycle events.
- Treat the recognized action input as verbatim. Trimming is allowed only for
  deciding whether it is blank; store the original accepted string.
- Keep the scalar-length limit aligned between Swift and TypeScript.
- Do not persist spoken text in preferences or a plaintext queue.

## Diagnose discovery with evidence

An extracted `Metadata.appintents/extract.actionsdata` file proves that the
compiler found the intent; it does not prove that macOS supports an App Shortcut
phrase. Likewise, `pluginkit` proves extension registration, not Siri phrase
availability.

For the supported action, verify:

1. The signed app and extension are valid and use the same team.
2. `/Applications/Balance.app` is the installed container and exactly one
   `app.balance.local.widget` extension is enabled from that path.
3. Extracted metadata contains `AddToBalanceIntent` with a discoverable task
   input.
4. The Balance action appears in the Shortcuts app and accepts text supplied by
   the shortcut.
5. A synthetic deep link inserts exactly once, preserves text, chooses the
   expected day, and survives persistence plus undo/redo.

Stale Launch Services registrations from build-tree apps and Trash backups can
confuse app and URL discovery. Inspect them before changing registration state;
unregister only resolved stale Balance bundle paths, keep
`/Applications/Balance.app`, and do not delete the underlying backups as part of
that cleanup.

Swift intent changes require a signed production rebuild, nested-signature
verification, installation under `/Applications`, extension re-registration,
WidgetKit process restart, and installed-versus-built executable hash
comparison. Follow the repository's worktree and commit/push rules. Do not
launch the production host for verification when no debug host is available,
because that would open the user's database.
