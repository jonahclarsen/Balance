---
name: balance-operations
description: Design or change Balance persisted actions, replicated record collections, record fields, undo, or checkpoint schemas. Use when adding features that write planner data so newer actions remain compatible with older sync clients. Does not apply to presentation-only UI changes.
---

# Balance operations and compatibility

Read the repository AGENTS.md. Use generated databases and test-only keys;
Android builds and emulator verification run only in CI. See
[balance-sync](../balance-sync/SKILL.md) for relay and scheduling work.

## Choose a storage contract, then an action name

Feature names are not executable protocol primitives. For features stored in
`state_entities`, use `commitEntities(action, payload, mutate, options)` in
`src/lib/store.ts`. It persists `type: "apply_entity_changes"`; `payload.action`
is history/diagnostic metadata. No native action-name case or substring matcher
is needed. The helper checks that the mutation does not also change relational
plans/templates, preferences, or active date.

`entityChangesBetween` and `composeEntityChanges` generate version-2 changes.
`src/lib/entityPatch.ts` defines the wire patch vocabulary;
`src-tauri/src/sync/entities.rs` applies it and creates undo patches.
Use these implementations; do not hand-build whole-state snapshots or introduce
feature-specific replicated commands.

Existing relational planner commands remain supported primitives. A new UI
interaction can compose existing primitives through the existing `batch` handler
or use a separate generic entity collection keyed to a plan/task ID. Do not
silently turn a new relational algorithm into a new wire operation type. New
storage primitives or changed conflict rules require an explicit protocol rollout.

## Records and fields

- Register a collection in the frontend's `ENTITY_COLLECTIONS` and its AppState
  model so its changes are tracked. Add its native UI read/normalization path as
  needed. Native v2 storage accepts unfamiliar collections independently of these
  UI lists; never add a storage collection allowlist for new features.
- Use stable record IDs. Collection names contain only ASCII letters, digits,
  `_`, or `-`, and are at most 128 bytes. Keep identifiers and existing meanings
  stable; additive optional fields should have sensible absent-value behavior.
- Mutators must use immutable updates; unchanged references avoid unnecessary
  scans. Change only intended fields. Never normalize an entire record by
  rebuilding known fields during an edit: omissions of previously visible fields
  mean explicit removal.
- Object patches preserve fields absent from the author's view. Arrays of
  objects with unique string `id` fields use ID-addressed patches and explicit
  order/removal. Metric answers use their stable `questionId` through the same
  primitive’s `keyField` parameter. Keep IDs stable. Primitive arrays and arrays without unique IDs
  are atomic replacement values; do not put extensible records in them.
- `position: null` means preserve the stored position. A numeric position means
  an intentional insertion/reorder. Upsert `value` is a fallback for a missing
  record; `patches` are applied to an existing record. Do not use an empty patch
  list to edit an existing record.
- Domain deletion deliberately removes a complete record, including unknown
  fields. Undo of a field edit reverses only that edit and must preserve fields
  added later. Exercise delete/recreate and undo/redo in mixed-version tests.

## Snapshots, incompatible changes, and upgrades

Native checkpoints carry `payload.replicatedEntities`, an exact snapshot of all
stored entity rows, including unfamiliar collections, keys and positions. The
UI's AppState is a partial view and is not a replacement for that snapshot.
Preserve this payload through replay and checkpoint installation. Installation
verifies the raw rows as well as the visible state inside its transaction.
Database backups copy the encrypted database; do not replace them with exports
of the frontend view. Image retention scans opaque records as well as known UI
state; use the established image-reference encoding in new features.

Version-1 entity changes and old checkpoint payloads remain readable for
existing databases. Do not rewrite immutable historical operations during an
upgrade. Version 6 relay envelopes prevent pre-foundation clients from writing
checkpoints that discard generic state; all devices need the foundation update
once. Future additive fields/collections using v2 patches need no protocol bump.

Unknown patch primitives or change versions fail the entire incoming transaction
with an update-required error. Never catch that error and mark the batch known,
advance its cursor, or compact away its operations. If a new feature cannot be
expressed using the existing vocabulary, ship readers before enabling writers,
or deliberately require an update by changing the protocol. Keeping old readers
working is a release contract, not something compaction repairs.

## Required verification for storage changes

- Run frontend checks and relevant operation/patch behavior tests.
- Run encrypted native persistence, sync, undo and checkpoint tests in CI.
- Run `.github/workflows/sync-compatibility.yml`: it builds real released engines
  with the same synthetic fixture driver and opens their generated encrypted
  databases with the new engine. Keep old-version fixtures independent of new
  initialization code. Once a foundation release exists, the workflow also
  automatically includes its oldest tagged reader as the feature-blind peer;
  preserve this baseline when later releases add features.
- Extend the future-schema fixture when introducing a new data shape: an older
  foundation client must receive it, edit supported fields, undo/redo, compact,
  reopen, and send it back without losing unknown collections or nested fields.
  Test an unsupported primitive separately and require rollback without cursor
  advancement. Do not make both peers know the new schema to get a passing test.
- For Android, dispatch `.github/workflows/android.yml` on the tested commit and
  wait for the APK/emulator checks. A release tag follows passing verification;
  creating a tag does not itself authorize skipping failed compatibility checks.
