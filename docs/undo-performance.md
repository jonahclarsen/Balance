# Undo performance comparisons

`.github/workflows/undo-comparison.yml` runs the same synthetic fixture driver and
Playwright harness against September 1, September 8, the investigation's
September 15 baseline (`255b275`), and the workflow's commit. It alternates the
revision order across two rounds on one macOS runner with four CPU load workers.

The fixtures contain 4,500 / 90,000 / 270,000 tasks, 100 goals, and respectively
300 / 10,000 / 30,000 metric entries and retained undo records. They are newly
created SQLCipher databases in temporary directories, with a test-only key. The
retained undo rows model recently deleted tasks preserved by the recovery policy
after an operation-log checkpoint. The harness checks they survive each edit.
No installed database, recovery key, widget keychain, or personal data is used.

The `undo-comparison` artifact contains `results.jsonl` and logs. Each result
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

Compare medians after excluding sample 0 (warm-up), and retain the per-round
results to spot runner noise. Native engines use Cargo's test profile; the UI
uses Vite and Chromium. The native bridge starts a test process for each command,
so store/render totals include bridge overhead and are comparative measurements,
not predictions of installed-app latency. OS Keychain access, widget publication,
network sync, and a due daily backup are outside these measurements.
