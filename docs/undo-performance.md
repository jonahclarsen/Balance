# Undo performance comparisons

`.github/workflows/undo-comparison.yml` runs the same synthetic fixture driver and
Playwright harness against September 1, September 8, the investigation's
September 15 baseline (`255b275`), and the workflow's commit. For each fixture size, it alternates the revision order across two rounds on
one macOS runner with four CPU load workers. Different fixture sizes run in
parallel jobs; compare revisions within a size to hold the machine constant.

The fixtures contain 4,500 / 90,000 / 270,000 tasks, 100 goals, and respectively
300 / 10,000 / 30,000 metric entries and retained undo records. They are newly
created SQLCipher databases in temporary directories, with a test-only key. The
retained undo rows model recently deleted tasks preserved by the recovery policy
after an operation-log checkpoint. The harness checks they survive each edit.
No installed database, recovery key, widget keychain, or personal data is used.

The `undo-comparison-small`, `undo-comparison-large`, and
`undo-comparison-xlarge` artifacts contain `results.jsonl` and logs. Each result
identifies the revision, round, fixture size, scenario, sample, and direction:

- `openMs`: opening the encrypted database and checking its schema.
- `operationMs`: the native UI history function, including any full-state response.
- `housekeepingMs`: checkpoint and daily-backup checks (the day's synthetic backup
  is created during setup).
- `nativeMs`: native operation plus housekeeping.
- `storeMs`: the real frontend store awaiting the native bridge and applying undo.
- `revealMs`: locating the changed item in the actual history-navigation code.
- `totalMs`: store plus destination lookup, or keyboard-to-render time for
  `rendered-*` scenarios.
- `fullState` / `responseBytes`: whether the undo needed a complete workspace.

Task scenarios cover text changes, pending edits, clearing time, replacing a task
with a pasted tree, and undo after a backend reload. Separate scenarios cover
notes and metric answers near the beginning and end of history. Rendered task
scenarios run the app and dispatch its actual undo keyboard shortcut, then wait
for the state change and two animation frames. The isolated store scenarios
verify undo and redo contents and compare restored frontend data with the
persisted database outside the timed interval.

In the isolated `plan-pending` scenario, only sample 0 includes the initial
pending save; subsequent samples measure undo/redo of the saved edit. The
`rendered-*` scenarios create a fresh edit before every timed undo and therefore
cover pending persistence in repeated measurements.

Compare medians after excluding sample 0 (warm-up), and retain the per-round
results to spot runner noise. The after-refresh scenario uses two samples per
round with neither discarded; historical revisions reload the workspace on every
operation in that scenario. Correctness checks query the affected plan, note, and metric entries
rather than repeatedly reading unrelated task history. Native engines use Cargo's test profile; the UI
uses Vite and Chromium. The native bridge starts a test process for each command,
so store/render totals include bridge overhead and are comparative measurements,
not predictions of installed-app latency. Both undo browser configurations use
the dedicated port 55338 and refuse to reuse an existing server, so a worktree
never accidentally tests the main development checkout. OS Keychain access, widget publication,
network sync, and a due daily backup are outside these measurements.

## September 15 investigation

Measured candidate: `5e18ef45ca419d4b40df6420bb2bb51767f876b1`. All three fixture
sizes passed the full comparison, including undo/redo correctness checks.
[Matched CI run and raw artifacts](https://github.com/jonahclarsen/Balance/actions/runs/34948526777).

### 90,000 tasks, 10,000 retained undo records and metric entries

Median milliseconds across two alternating rounds; smaller is faster.
"Rendered" includes the actual undo keyboard handler, pending persistence, and
two animation frames. Other rows measure store undo and destination lookup.

| Undo case | Sept 1 | Sept 8 | Sept 15 before fixes | Fixed |
|---|---:|---:|---:|---:|
| Saved task text | 15.6 | 32.7 | 23.0 | 21.0 |
| Removed task time | 15.3 | 25.2 | 24.9 | 15.4 |
| Pasted task tree | 350.5 | 366.6 | 24.2 | 15.0 |
| After unchanged backend refresh | 7151.8 | 7243.5 | 7237.5 | 18.7 |
| Rendered task text | 111.6 | 139.5 | 119.3 | 122.5 |
| Rendered removed time | 122.1 | 130.3 | 123.2 | 107.0 |
| Rendered pasted tree | 495.1 | 503.7 | 137.7 | 117.0 |
| Last metric answer | 15.1 | 1251.5 | 1259.5 | 18.1 |

The task-text native stage increased from 1.62 ms on September 1 to 11.23 ms
on September 8, remained 10.28 ms at the investigation baseline, and fell to
2.18 ms with the fix. That improvement did not produce a measurable improvement
in the complete rendered text scenario; pending persistence and rendering still
dominate that case. Time removal and pasted-tree rendering improved modestly.

### 270,000 tasks, 30,000 retained undo records and metric entries

The same method on a separate runner, with all four revisions matched within
this size. Compare revisions within each table, not absolute timings across
the two machines.

| Undo case | Sept 1 | Sept 8 | Sept 15 before fixes | Fixed |
|---|---:|---:|---:|---:|
| Saved task text | 22.8 | 46.0 | 56.5 | 17.9 |
| Removed task time | 19.6 | 41.8 | 55.0 | 18.3 |
| Pasted task tree | 1598.4 | 1468.6 | 50.7 | 20.7 |
| After unchanged backend refresh | 31860.8 | 35519.1 | 31884.3 | 49.3 |
| Rendered task text | 407.4 | 465.1 | 555.0 | 319.0 |
| Rendered removed time | 346.8 | 464.2 | 443.3 | 326.4 |
| Rendered pasted tree | 2099.0 | 2176.7 | 429.5 | 349.2 |
| Last metric answer | 20.7 | 13573.2 | 12755.9 | 25.9 |

Native task-text undo measured 2.22 / 28.01 / 33.18 / 1.97 ms across these
revisions: the September regression grew with retained history, and the new
index removed that growth in the measured cases. Compared with the September 15
baseline, rendered text undo improved 43%, time removal 26%, and paste undo 19%.
Those rendered scenarios improved in both rounds, although rendering and
pending persistence still leave roughly 0.3 seconds of latency at this scale.

The unchanged-refresh fix also applies to redo: 32,847.1 ms fell to 26.8 ms.
At the smallest fixture (4,500 tasks), unchanged-refresh undo fell from 381.5 ms
to 26.6 ms. Ordinary edits at that small size were already quick and changed
little.

### Causes and changes

- September 4 (`5248abf`) added a redo-availability lookup to every undo response.
  Its filter and ordering could not use the existing undo index efficiently.
  A partial index over undone history rows restores cheap lookup. A generated
  encrypted-database upgrade test checks preserved history, redo ordering,
  navigation exclusion, and the query plan.
- September 5 (`451ab1c`) added contextual history navigation. Its metric-entry
  search was quadratic. ID maps make lookup linear, and unchanged collection
  references skip it entirely. The metric-navigation stage at 10,000 entries
  fell from 1236.2 ms to 2.1 ms.
- Backend refreshes discarded the frontend undo/redo cache even when persisted
  data and the local sequence were unchanged. Preserving that validated cache
  avoids a second full-workspace transfer on the next undo or redo. Actual
  changed data or sequence still invalidate it; the native expected-operation-ID
  check remains authoritative. This expensive fallback already existed on
  September 1, so it is not itself a newly introduced regression.
- September 11 (`6416b52`) had already fixed task-parent lookups. Most of the
  improvement in paste undo versus the historical revisions comes from that
  existing change, not this investigation's fixes.

The refresh itself still reads the workspace. Undo after a cold start or a
refresh containing changed backend data still uses the full-state fallback.
These measurements do not establish the cause of every slow undo in an
installed app.

### Validation

- [Encrypted undo profile and four frontend cache tests](https://github.com/jonahclarsen/Balance/actions/runs/34948526821): passed.
- [Encrypted native persistence and sync-race suites](https://github.com/jonahclarsen/Balance/actions/runs/34948526841): passed on rerun; initial failure was the existing sync timing ratio below.
- [Goal Rhythm behavior and Graphite/Iridescent interaction profiles under CPU contention](https://github.com/jonahclarsen/Balance/actions/runs/34948874683): passed.
- [Theme-state performance](https://github.com/jonahclarsen/Balance/actions/runs/34948526736): passed on rerun; the first run exceeded its single changed-theme commit timing limit.
- [Released-engine compatibility](https://github.com/jonahclarsen/Balance/actions/runs/34948547702): interoperability passed for v0.6.7, v0.6.8, and v0.6.9. The v0.6.9 job's separate current-engine sync self-test exceeded its existing timing ratio, including when run alone (142 ms incremental sync versus 1344 ms setup; limit 10%).
- [Android candidate](https://github.com/jonahclarsen/Balance/actions/runs/34948550255): debug APK built, but emulator sync self-test hit the same timing assertion (292 ms versus 2162 ms setup on retry). [Unchanged main control](https://github.com/jonahclarsen/Balance/actions/runs/34949377811) also failed that assertion (253 ms versus 1454 ms setup). No threshold was relaxed.
