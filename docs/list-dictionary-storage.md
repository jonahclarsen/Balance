# Daily list storage

Daily `lists` records use Zstandard level 3 with a device-local shared dictionary
per list template. Compression happens before SQLCipher encrypts database pages.
The native process already has the unlocked logical record when it reads or
writes it; it never tries to learn patterns from ciphertext. Dictionary bytes,
hashes and references live inside the same encrypted database. No plaintext
dictionary files, external service or recovery-key export is involved.

The initial dictionary is the last 64 KiB of the template's serialized `items`.
This is a raw-content Zstandard dictionary, avoiding training work. It is created
when a substantial daily list is first written. Missing templates fall back to
ordinary Zstandard. Records below 512 bytes, above 16 MiB, or without a useful
compression saving stay ordinary JSON. List templates and relational day plans
are unchanged. Operations, undo entries and sync checkpoints retain logical JSON;
this change does not compress the entire database or its retained history.

## Rotation and cost limits

Each template becomes eligible for a check 90 days after its previous check.
If its source content matches the active dictionary's source, the check stops.
Otherwise compare a candidate from the current template against the incumbent on
the 30 most recent dated daily lists, excluding future dates. Adopt only when:

- The combined encoded samples are at least 20% smaller.
- Six months of projected savings exceed the candidate's full size plus one
  4 KiB page of overhead. The projection uses distinct usage days in the previous
  180 days; it does not assume an infrequently used list is read daily.

Fewer than 30 samples, oversized samples (over 256 KiB each), insufficient savings
or insufficient usage mean no replacement and another 90-day wait. Rejected
candidates are reconsidered later even when the template has not changed again.
Only future writes use an adopted dictionary. Existing records keep their
original dictionary reference; no chain of deltas needs replaying. Dictionaries
are immutable and deleted only when neither an active policy nor a retained
record references them. A backup contains its own complete dictionary tables.

## Migration and compatibility

The versioned schema is added atomically at open. New writes immediately use the
codec; historical rows convert during foreground idle windows, up to 24 rows or
about 2 MiB per transaction (one oversized row can exceed the byte budget).
Conversion preserves unknown JSON fields and creates no replicated operation.
Each maintenance call evaluates at most one due template after migration.

The frontend waits ten seconds initially and five seconds after input before
running a batch. It pauses while hidden or during recovery/compaction. Further
batches are spaced five seconds apart; completed work is checked again after
six hours, errors after five minutes. Normal database locking serializes writes.
Freed SQLite pages are reusable immediately. Physical file shrinkage follows
the existing verified database-compaction policy, normally on a later launch;
conversion does not trigger a full-file VACUUM for every batch.

`state_entities.value_json` can contain either legacy JSON TEXT or an encoded
BLOB for `lists`. All generic entity reads must use `list_storage::Reader` and
all writes must use `list_storage::write`. Snapshots, state hashes, image retention,
backups, undo and restore use those same logical boundaries. The envelope has a
version magic, dictionary ID, bounded decoded length and a Zstandard checksum.
Dictionary hashes and foreign keys protect dictionary integrity and lifetime.
Decode errors fail the operation rather than silently skipping a record.

Old releases still exchange ordinary logical records through the existing sync
protocol. Opening the upgraded **same local database** in an old binary is not
supported: write-guard triggers require a function registered by current builds,
so old builds fail during open instead of overwriting compressed records. Backup
copy connections must also register that function. Old JSON-only backups remain
readable without modifying them.

## CI verification

All fixtures are fabricated and use public test-only keys. No local benchmarks
or tests, installed user databases, keys or app screenshots are needed.

- `list-storage.yml`: the full native suite, including migration/reopen, corrupt
  envelopes, rollback, backups/rekey, image retention, dictionary lifetime,
  quarterly thresholds and undo/checkpoint convergence. The ignored native
  profile compares fixed, annual and adaptive dictionaries over ten years at
  2,700 / 1,360 / 540 template words with about one third selected daily. Weekly
  edits and frequent changes with yearly template replacement cover two extremes.
  Artifacts include encrypted file sizes, dictionary counts, read/write p95
  timings and maximum maintenance duration. Timings are CI debug-build results,
  not a promise of latency on every device; writes are measured in a transaction.
- `sync-compatibility.yml`: actual released engines create encrypted list data;
  current engines upgrade, edit, undo, checkpoint and exchange logical records
  with old peers. A released executable must refuse local database downgrade.
- `frontend-tests.yml`: checks, unit/relay tests and all desktop/mobile/WebKit
  behavior tests, including the idle scheduler tests.
- `android.yml`: cross-compilation and emulator smoke checks.

See [the compression study](storage-compression-study.md) for the broader codec
comparison and its limitations. Native profile artifacts measure materialized
lists and their indexes/dictionaries, not a complete user's operation history.
