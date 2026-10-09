# Daily-list storage compression study — 2026-10-09

The strongest candidate is **Zstandard compression before SQLCipher encryption,
with an immutable shared dictionary for each list's repeated wording**. A simpler
first implementation can use independent Zstandard records without dictionaries.
The study changes no production database, app behavior, or sync format.

## Main result

For ten years of three daily lists, generated from templates of approximately
2,700 / 1,350 / 540 words with one-third daily inclusion and weekly single-word
edits, the synthetic daily-record database measured:

| Approach | Database MiB | Reduction | Random read p95 ms | Small edit p95 ms | Small edit median CPU ms |
|---|---:|---:|---:|---:|---:|
| Current-style full JSON records | 126.10 | — | 0.124 | 1.847 | 0.497 |
| ZIP-style DEFLATE level 6 | 31.94 | 74.7% | 0.136 | 2.417 | 0.488 |
| Zstandard level 3 | 31.56 | 75.0% | 0.108 | 1.352 | 0.399 |
| Zstandard with initial-template dictionary | 15.09 | 88.0% | 0.097 | 1.666 | 0.411 |
| Shared immutable text/HTML, plus Zstandard | 30.74 | 75.6% | 0.748 | 3.308 | 1.028 |
| Zstandard across 30-day blocks | 6.09 | 95.2% | 3.506 | 17.009 | 13.262 |

These are medians across three independently seeded histories; p95 columns are
medians of the three per-history p95s. MiB means 1,048,576 bytes. Each read/edit
targets one list, not all three. Edits include reading, modifying, encoding and
committing. The baseline and dictionary builds consumed 2.73 and 2.68 CPU seconds
respectively for 10,950 daily records. This is evidence of low overhead in the
prototype, not evidence that compression is inherently free or faster on every
device. Smaller encrypted reads/writes can offset compression work.

For one year, the same approaches occupied 12.73 MiB uncompressed, 3.22 MiB with
ordinary Zstandard, and 1.20 MiB with the shared dictionary. The dictionary was
never refreshed: its reduction declined from 90.6% to 88.0% across the longer
history, rather than requiring a chain of previous-day deltas to retain savings.

## Sensitivity to usage and wording

| Workload | Raw MiB | Zstandard MiB | Dictionary MiB | Dictionary reduction |
|---|---:|---:|---:|---:|
| One year, expected daily word counts | 12.73 | 3.22 | 1.20 | 90.6% |
| Ten years, expected daily word counts | 126.10 | 31.56 | 15.09 | 88.0% |
| Ten years, all template words every day | 357.79 | 82.86 | 38.57 | 89.2% |
| Ten years, daily edits and monthly row changes | 128.94 | 32.00 | 27.20 | 78.9% |
| Ten years, larger vocabulary | 143.18 | 48.36 | 17.58 | 87.7% |
| Ten years, smaller day-plan JSON proxy | 28.98 | 7.58 | 4.35 | 85.0% |

The high-churn case shows why a fixed initial dictionary eventually becomes less
useful: ordinary Zstandard still saved 75.2%, while the dictionary saved 78.9%.
The larger-vocabulary case is more difficult for independent compression (66.2%
saved), but shared wording still lets the dictionary save 87.7%. Thus the strong
dictionary result is not limited to the small main-fixture vocabulary.

In the largest full-length workload, dictionary edits used 1.02 ms median CPU
versus 1.44 ms uncompressed; 30-day block edits used 71.62 ms. The larger-vocabulary
runner also showed substantial wall-time tails for some methods, without matching
CPU increases. Shared-runner/filesystem variation affects these small timing
samples; the block method's consistently larger CPU cost is stronger evidence
than any single wall-time p95 difference.

## Interpretation

**Independent Zstandard records are the simplest useful improvement.** Balance
already depends on Zstandard and uses level 3 for encrypted relay envelopes.
Using it at the local storage boundary can preserve random access, historical
snapshots and logical sync records. Compression should happen before encryption;
zipping the encrypted database cannot see its repeated words.
The measured zlib archive of each raw encrypted database was approximately 0.03%
larger than the database file, across all six workloads.

**A dictionary is the best next candidate for this usage pattern.** It gives the
compressor a reusable reference containing the initial template wording. Each day
remains independently decodable using that one dictionary; it does not require
reconstructing yesterday, last month, and every earlier edit. Dictionary bytes
and their database overhead are included in the measurements. A production
design must keep dictionaries immutable and retain old dictionary versions as
long as any stored record needs them. Periodic replacement might improve savings,
but that lifecycle was not implemented or measured here.

**The text-sharing prototype does not justify its extra machinery yet.** Storing
each text/HTML pair once avoids duplicate prose, but daily references, hashes and
indexes consume space, and reconstruction needs additional lookups. It produced
little extra saving over ordinary Zstandard and substantially higher CPU/read
cost in this implementation. Integer references, batching and caching could
improve it; this experiment does not rule out all deduplication designs.

**Thirty-day blocks trade interaction cost for maximum compression.** Their 95%
reduction is attractive for immutable archives, but even a small edit rewrites a
block and random navigation decodes other days. The measured edit overhead makes
them a weaker first choice for actively editable history. Incremental compression
against a fixed dictionary avoids that particular tradeoff.

## Smaller day templates

A 300-word-per-day, ten-year JSON proxy shrank from 28.98 MiB to 7.58 MiB with
ordinary Zstandard, or 4.35 MiB with a dictionary. This supports the same general
idea for repeated plan text, but **does not measure savings in Balance's actual
relational `plans` and `plan_items` tables**. Live template definitions themselves
are only a few records; generated historical plans are the repeated part. Lists
are the clearer first implementation target. A plan-specific follow-up should
compare actual relational text/HTML columns against immutable shared text before
changing that schema.

## What these numbers establish, and what they do not

All experiments ran on GitHub Actions using newly generated encrypted databases
and a public test-only key. No installed database, personal data, recovery key,
keychain entry or app screenshot was accessed. No tests or benchmarks ran locally.
The script refuses to run outside GitHub Actions.

The baseline approximates the materialized `state_entities` list records and
their ordering index. **It excludes operation history, undo, checkpoints, images,
other collections and backup copies. It is not a prediction of the user's total
database size or the percentage reduction of that entire database.** Current
entity operations carry fallback record values as well as patches; checkpoints
also retain a logical copy of the daily records. Their physical storage should
be measured in a native follow-up rather than multiplying these estimates.

The generator models probabilistic selection, fresh daily IDs, nested rows,
checkoffs with varying timing, occasional day-only edits, lasting word changes,
formatted text and Unicode. Its main vocabulary is intentionally small. The
larger-vocabulary sensitivity case checks whether that makes the result too
optimistic, but neither corpus predicts arbitrary personal prose exactly.

Random reads have no decoded-object cache, but OS caches were not flushed.
Timings come from Python calling native codecs and SQLCipher on shared Linux CI
hosts; they are not native Rust, macOS, Android or battery measurements. Compare
methods within a scenario rather than timings across separate runners.

All stored records are reconstructed and compared with the source after reopen
and again after edits and VACUUM. Lifecycle checks also exercise empty content,
Unicode/HTML, unknown fields, independence of old days, replacement undo/redo,
rollback, encryption/integrity, truncated payloads and missing shared content.
These validate the prototypes, not a production migration or Balance's sync
engine. The deduplication prototype deliberately keeps unused content created by
benchmark edits, so its post-edit/VACUUM sizes include that overhead.

## Implementation recommendation

1. Prototype a versioned, bounded native storage codec for full JSON records with
   Zstandard level 3 and an uncompressed fallback for small/incompressible values.
   Benchmark actual operation/history/checkpoint storage alongside daily records.
2. Add immutable dictionaries if the native comparison preserves the measured
   benefit. Keep logical entity records and sync payloads unchanged, decoding at
   the local storage boundary. Missing dictionaries must fail explicitly.
3. Test generated old-format databases through atomic migration, reopen, backups,
   recovery, undo/redo, checkpointing and mixed-version sync. Existing readers
   expect TEXT JSON, so compressed blobs cannot simply be put in those columns
   without adapting all readers and explicitly handling downgrade compatibility.
4. Measure full-state startup and day navigation in the actual app on CI before
   shipping. Disk compression does not reduce the decoded JavaScript state held
   in memory and does not by itself solve frontend rendering work.

Existing database maintenance only VACUUMs a verified replacement while
preserving operation/history counts. Separate sync checkpointing can remove
covered operations, but neither removes the repeated text inside retained daily
records. Relay payloads already use Zstandard, so this study does not establish
additional network savings.

## Reproduction and evidence

Both benchmark runs completed successfully: eight methods × six workloads ×
three histories = **144 measured databases**. Full scans checked 1,165,080 logical
records per verification pass, both after reopen and after edits/VACUUM, in
addition to the separate lifecycle fixtures.

- [Main five-workload CI run](https://github.com/jonahclarsen/Balance/actions/runs/37906758154), benchmark commit `7495505`.
- [Larger-vocabulary sensitivity run](https://github.com/jonahclarsen/Balance/actions/runs/37906983582), benchmark commit `58cfe68`.
- [Baseline frontend CI](https://github.com/jonahclarsen/Balance/actions/runs/37906783176).
- [Workflow](../.github/workflows/storage-compression-study.yml): dispatch all workloads or select one.
- [Methodology, limitations and codec definitions](../scripts/storage-study/README.md).
- [Permanent per-seed measurements](storage-compression-results.json), including
  CPU/wall timings, file sizes before/after edits and VACUUM, and codec versions.
- [Zstandard dictionary overview](https://facebook.github.io/zstd/).
- [SQLite compression/encryption ordering](https://sqlite.org/zipvfs/doc/trunk/www/see.wiki).

CI artifacts contain the per-seed JSON measurements and summary tables; database
files are deliberately not uploaded. The workflow retains artifacts for 30 days.
The separate frontend baseline was still queued on GitHub's macOS runners when
this report was recorded; it is not counted as a passing check. Application code,
frontend dependencies and existing tests were unchanged by this study.
