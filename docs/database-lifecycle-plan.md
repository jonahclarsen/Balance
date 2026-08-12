# Database lifecycle redesign

## Required outcome

Balance must preserve the complete user-visible state of every existing encrypted database while moving routine housekeeping out of the user's way. The migration is one-time, transactional, idempotent, and verified by reading the migrated state back before it commits.

## Storage and operation format

1. Replace the combined goals and lists/metrics/notes metadata snapshots with ordered `state_entities` rows for `goals`, `goalCompletions`, `listTemplates`, `lists`, `metrics`, `metricEntries`, and `notes`.
2. On first open, copy every legacy array into the new rows in one transaction. Keep legacy metadata readable for old operation replay, but make entity rows authoritative after migration.
3. Persist only changed entities and ordering positions in operation payloads. Continue accepting legacy operations containing `goalData` or `listsMetricsData` so existing logs and relay generations replay losslessly.
4. Bump direct and relay operation semantics to protocol v4. A v4 client may ingest v3 relay envelopes, but an old client must reject v4 rather than silently ignoring entity deltas.

## Continuous logical housekeeping

1. Preserve at least the latest 200 undo actions.
2. Preserve destructive recovery entries for 90 days, subject to a 25 MiB extension budget beyond the guaranteed recent actions.
3. Prune incrementally after writes instead of deleting all history during physical maintenance.
4. Create a verified full-state sync checkpoint when the coordinator log reaches 1,000 operations or 8 MiB. Keep undo/recovery history independent from checkpoints.

## Physical storage and backups

1. Measure `page_count`, `freelist_count`, and `page_size`.
2. Recommend/run physical compaction only when at least 16 MiB and 25% of the database are reclaimable.
3. Never delete undo history or force a sync checkpoint merely to vacuum.
4. Create a verified encrypted backup after the first meaningful persisted change each day, independently of checkpointing and vacuuming, and retain seven daily backups.
5. Keep manual optimization as a diagnostic action; remove weekly blocking maintenance UI.

## Verification gates

1. Migration fixture containing every collection and nested field compares equal before and after migration, including array ordering, settings, sync metadata, operations, and undo/recovery records.
2. Migration is idempotent and rolls back on malformed/incomplete transfer.
3. New operations do not embed full combined state and replay/undo/redo correctly.
4. Two databases converge across legacy v3 snapshots and v4 deltas.
5. History retention, checkpoint thresholds, reclaim thresholds, daily backup verification/rotation, and bounded growth have direct tests.
6. Run formatting, TypeScript/Svelte checks, frontend build, relay tests, all Rust tests, targeted performance/growth tests, and repository diff/secret audits. Android is verified only through CI after push.
