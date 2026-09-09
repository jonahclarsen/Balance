# Day regeneration and offline task preservation

Protocol 8 keeps a day's existing ID when applying a template. The frontend
emits `regenerate_plan` with fresh generated items and `replaceItems`: the exact
untouched root groups it observed and intends to remove. It does not send
preserved user tasks back as replacement copies.

The native engine removes a candidate only when its stored tree still matches
that observation and remains untouched. Independent additions, edited trees,
and moved children survive. Missing insertion parents and paste/split anchors
fall back to the day's root. Undo removes only unchanged generated groups and
restores removed groups at their previous positions; independent work survives.

Native `planDateAliases` records map historical day IDs to dates. New relational
operations also include `planDate` (or source/target dates) so they can cross a
checkpoint made by an older client that did not record aliases. Legacy
`generate_plan` operations register both identities and conservatively preserve
manual or edited rows instead of deleting the day. Immutable operations are not
rewritten.

Removed untouched tasks are stored in native `regeneratedPlanItems` records.
A later saved text/formatting/time/completion edit can restore its named task.
Explicit task deletion removes its regeneration archive and descendant
archives, preventing subsequent stale edits from resurrecting that deletion.
Both native collections use the existing generic checkpoint snapshot and
survive compaction and reopen, even while a device remains offline.

## Upgrade and recovery

Desktop and Android must both receive protocol 8 before resuming normal shared
editing. Readers accept protocols 4 through 8; older clients reject protocol 8
ciphertext instead of applying different conflict rules. The existing outbox
upgrade path rebuilds cached envelopes without changing durable operations.
Do not tag a release until version compatibility and Android verification pass.

Existing loss can be repaired through Settings' Recovery history when its
creation and saved edits remain. The user selects the entry; recovery rebuilds
only that missing task with its saved text, using the current day for the known
date. It does not replace the current day or automatically restore deleted
work. Recovery can infer the old date from retained day snapshots when older
creation operations omitted it. If the creation/text or the ID-to-date evidence
has been compacted and pruned away, recovery cannot infer it safely. No personal
database inspection or key extraction is needed for implementation or testing.

## Verification

For a separate worktree server, this suite uses permanent port 49260 (chosen
once with the OS random generator):

```sh
CI=1 PLAYWRIGHT_PORT=49260 pnpm exec playwright test tests/visual/entity-storage.spec.ts --project=desktop --project=mobile --workers=2
```

- Native encrypted fixtures cover Add item, child additions, Enter/split,
  paste, and saved edits before/after new and legacy regeneration; aliases,
  repeated regeneration, undo/redo, explicit deletion, checkpoints and reopen;
  and explicit recovery of missing saved text from retained history.
- The frontend entity-storage fixture checks stable day IDs, date context,
  observed removal lists, preserved tasks, reload, and undo/redo. Compatibility
  CI replays the exported operations in the native engine.
- Version compatibility CI builds real released engines and exercises their
  replacement operations and checkpoints against an offline upgraded phone.
- The Android task-preservation gate runs sixteen real WebView scenarios,
  including Add item and Enter across regeneration and its later checkpoint.
  Android builds and emulator execution run only in CI.
