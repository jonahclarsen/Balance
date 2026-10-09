# CI-only synthetic storage study

Run the **Synthetic storage compression study** GitHub Actions workflow. The
script refuses to run outside GitHub Actions. It only creates temporary synthetic
databases, never opens an existing input database, and never reads app data or
keys. Dependencies are isolated to CI; the app's dependencies do not change.

## What is measured

Eight storage prototypes use SQLCipher with the same raw test key, default page
size and synchronous settings. Compression happens **before** encryption. The
baseline uses the `state_entities` schema and ordering index from
`src-tauri/src/lib.rs` (BLOB versus TEXT affinity makes no difference to these
UTF-8 bytes). Two empty support tables add the same small overhead to all cases.
Each independent record keeps a real UUID key. Compressed formats are experiments,
not readable by existing Balance clients.

| Method | Representation |
|---|---|
| raw | Full JSON per daily list |
| zlib-1 / zlib-6 | DEFLATE, as used by ZIP, per JSON record |
| zstd-1 / zstd-3 | Zstandard per JSON record |
| dictionary-3 | Zstandard with one immutable initial-template dictionary per list; all dictionary bytes are stored and counted |
| dedup-3 | Immutable SHA-256-addressed text/HTML pairs, stored once; compressed per-day records retain IDs, hierarchy, completion and timing; content table and indexes are counted |
| block30-3 | Up to 30 days of records compressed together; random reads decode the block and single-record edits rewrite the block |

The dictionary is built from initial template content, never future data. It is
deliberately not refreshed, testing degradation as wording changes. This exploits
similarity without an ever-growing chain of previous-day dependencies. The
deduplication prototype also has no dependency chain; a one-word edit adds a new
text/HTML pair while old days retain the old pair. The block method exposes the
tradeoff of compressing across days without semantic deduplication.

Three seeded histories per scenario randomize method order. Histories contain
daily generated IDs, per-list suffixes matching the current planner pattern,
different probabilistic row selections, nested items, 90% checkoffs with varying
`doneAt`, occasional daily-only changes, formatted text and Unicode. Words come
from a small authored vocabulary: this models repeated prose but is not a
representative sample of arbitrary human writing. Compression ratios depend on
real prose entropy, average row length and markup; do not extrapolate a precise
personal database size from them.

The main interpretation is templates of 2,700 / 1,350 / 540 words with independent
one-third daily inclusion (approximately 900 / 450 / 180 words), and a one-word
template edit every seven days per list. The word counts precede daily-only edits.
We test one and ten years. Sensitivity cases use all words every day, or daily
word edits plus monthly row replacement/reordering. A diverse-vocabulary case
mixes common words with 4,096 invented tokens to stress higher text entropy. This
is a sensitivity bound, not an assertion that invented words model normal prose.
The smaller day-plan proxy
has 300 words per day over ten years.

**Scope:** these databases measure retained daily **materialized records** only.
They exclude operations, undo, checkpoints, images, other collections and backup
copies. They are not full Balance databases and cannot be opened in Balance.
Day plans currently use relational `plans` / `plan_items` tables, so the plan JSON
scenario is a content-compressibility proxy, not a measurement of current plan
table savings. List templates themselves are only a few live records; repeated
generated days are the scaling issue.

## Measurements and correctness

Results include physical closed-database bytes (not just compressed payload
sizes), bytes after small edits and after VACUUM, build wall/CPU seconds, 150
random read samples, 50 small edit samples including commits, and a full verified
scan. Summary values are medians of three histories, including medians of the
per-history p95s. Raw JSON is already serialized canonically; this study does
not include the app's existing JSON serialization cost. Build timing does include
prototype JSON encoding, hashing and compression. Edit CPU time excludes fixture
generation and includes reading, changing, encoding and committing one row.

Reads reopen connections first and do not use a decoded content cache. OS caches
are not flushed: these are warm-file-cache measurements, not cold disk latency.
Deduplication deliberately uses indexed SQL lookups without an application cache.
Thirty-day blocks commit per block; other formats commit per day. Build wall time
therefore also reflects different transaction counts; compare CPU time for
codec overhead. File size is captured after closing the database; there is no
unaccounted WAL. No databases are uploaded as artifacts.

Every reconstructed record is compared with the source after reopening and again
after edits/VACUUM. Separate lifecycle tests cover unknown fields, Unicode, rich
HTML, empty strings and items, historical-day independence, replacement undo/redo,
transaction rollback, SQLCipher integrity, truncation detection and missing content.
Replacement undo/redo here is a prototype storage test, **not** validation of the
app's operation engine, mixed-version sync, crash recovery or a production migration.
Deduplication has no garbage collector; new content from benchmark edits remains
counted after undo/VACUUM, a conservative limitation of this prototype.

Timings are Python calling native codecs and SQLCipher on shared Linux CI hosts.
They compare designs but do not predict Rust, macOS or Android app latency or
battery usage. A production candidate still needs native engine measurements,
bounded decompression, dictionary/content lifecycle handling, atomic migration,
backup/undo/checkpoint and mixed-version tests. Keeping compression entirely
inside local storage can preserve the existing uncompressed logical sync records,
but existing local JSON SQL queries/readers must be adapted explicitly.

## Related code and existing optimizations

- `src/lib/planner.ts`: `generateListFromTemplate` copies selected text/HTML into
  each day's list with fresh row suffixes.
- `src/lib/store.ts`: `commitEntities` and `entityChangesBetween` generate v2
  patches; upserts also carry fallback values. The operation log is a separate
  source of possible duplication that this experiment does not measure.
- `src-tauri/src/sync/relay_client.rs`: relay envelopes already use Zstandard
  level 3 before encryption. These results are not additional network savings.
- `src-tauri/src/lib.rs`: database maintenance vacuums a replacement database
  while explicitly preserving operation/history counts. It reclaims free pages,
  not retained list content. Separate sync checkpointing in `sync/mod.rs` can
  replace covered operations, but still retains the full current daily records.

The baseline also streams the encrypted file through zlib to demonstrate why
zipping an already encrypted database does not exploit repeated list text.
See [Zstandard's dictionary overview](https://facebook.github.io/zstd/) for the
codec's small-data dictionary support. SQLite's
[compression/encryption notes](https://sqlite.org/zipvfs/doc/trunk/www/see.wiki)
also distinguish compression-before-encryption from compressing ciphertext;
ZIPVFS/SEE are not proposed as drop-in replacements for Balance's SQLCipher.
