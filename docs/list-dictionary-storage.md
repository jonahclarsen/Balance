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

## Measured results (2026-10-10)

[Native CI](https://github.com/jonahclarsen/Balance/actions/runs/38033120184)
passed 219 tests and all 18 ten-year profiles. The following totals sum the three
independently generated databases (including three copies of fixed schema
overhead); they are not measurements of one combined three-list database.

| Ten-year workload | Raw list JSON | Fixed dictionary | Annual replacement | Adaptive policy |
| --- | ---: | ---: | ---: | ---: |
| Weekly word edits | 184.43 MiB | 21.35 MiB | 15.64 MiB | 21.35 MiB |
| Daily edits + yearly template replacement | 184.84 MiB | 42.91 MiB | 22.51 MiB | 25.66 MiB |

Adaptive used one dictionary per template in the weekly-edit workload and ten
per template in the high-churn workload. Annual replacement was smaller for the
largest steady-use fixture, but slightly larger for the two smaller steady-use
fixtures. The adaptive policy deliberately requires measured per-record benefit
and six-month payback; it does not always produce the smallest eventual SQLite
file. SQLite page packing also makes file savings differ from encoded-byte
savings. These conservative thresholds preserve the agreed 90-day policy.

In that run, adaptive p95 reads were 0.75–2.78 ms, p95 writes 1.48–6.04 ms,
and the slowest quarterly check took 232 ms. An earlier identical production
implementation measured up to 2.53 / 4.87 / 183 ms respectively; hosted-runner
variation and debug builds limit how precisely these numbers predict devices.
All reads reconstructed the original logical record, and every database was
reopened and compared in full. See [per-case measurements](list-dictionary-results.json).

[Released-version compatibility](https://github.com/jonahclarsen/Balance/actions/runs/38033129626)
passed against v0.6.7, v0.6.8 and the first foundation reader, v0.6.9. The native
history acknowledgement/browser checks passed too.
[Android CI](https://github.com/jonahclarsen/Balance/actions/runs/38032975284)
passed debug x86_64 and signed arm64 builds plus emulator pairing/sync.

The [complete-database run](https://github.com/jonahclarsen/Balance/actions/runs/38033766261)
generated 3,285 daily lists across three years, performed twelve real persisted
edits, and created a real checkpoint while retaining undo history. Expanding
materialized lists back to JSON produced an otherwise logically identical
baseline, retaining the same operation and history bytes:

| Measurement | Compressed lists | JSON lists |
| --- | ---: | ---: |
| Complete encrypted file after VACUUM | 65.18 MiB | 120.65 MiB |
| Native full-state read after reopening | 1,165 ms | 1,304 ms |

That is a **46% complete-file reduction in this fixture**, lower than the
list-only percentage because the checkpoint alone retained 57.6 MiB of logical
operation payload. It is not a prediction for a personal database. The test
verified identical full state, operation log and twelve retained undo entries.
Reads exclude opening/unlocking and frontend rendering; OS caches were not
flushed. This measures the native startup read path, not an end-to-end app launch.

Frontend checks, unit tests, relay tests and the generic-record browser tests
passed on Linux. The [full macOS browser run](https://github.com/jonahclarsen/Balance/actions/runs/38033889886)
completed all three shards, including desktop, mobile and WebKit coverage.
Shards 1 and 3 passed; shard 2 had one Notes quote fixture failure and 326 passing
tests. The fixture now types through the editor and waits for persisted text
before exercising format undo/redo, rather than relying on a DOM fill. That
fixed regression [passed ten consecutive CI repetitions](https://github.com/jonahclarsen/Balance/actions/runs/38036365378)
on Linux. This is combined suite and targeted-retest evidence, not an all-green
full workflow. An [additional full macOS rerun](https://github.com/jonahclarsen/Balance/actions/runs/38036278440)
was still underway at integration and is not counted as passing verification.
