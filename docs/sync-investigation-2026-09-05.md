# Sync divergence investigation — 2026-09-05

The investigation reproduced both actual database divergence and stale visible
state after successful sync. All fixtures were generated for testing, with
test-only keys and isolated relays. No installed database, personal recovery key,
or live relay was accessed.

## Confirmed failures and changes

| Failure | Reproduction | Change |
| --- | --- | --- |
| Local application order disagreed with canonical replay | Desktop unchecks a task; phone observes that operation and checks it using the same timestamp. Phone's device ID sorts earlier. Both hold the same operation IDs but disagree about `done`, and repeated empty reconciliation cannot heal it. Clock skew also triggers this. | Assign new local operations a timestamp after the latest observed operation. Apply the same rule to native undo/redo. Index timestamps to keep issuance cheap as logs grow. |
| Persisted operation contents could change under an existing ID | Type again while a native persistence acknowledgement is blocked. The old merge window reused the submitted ID even though its earlier payload could already be durable and uploaded. ID-only reconciliation cannot discover the changed contents. | End text coalescing when an operation is staged for persistence. Native synced operations reject changed-content reuse; equal retries are no-ops, including retries after newer edits or compaction. |
| Background/direct sync updated the database without refreshing the WebView | Apply a synthetic task completion outside the foreground scheduler, then return a no-change relay result for resume, focus, or manual sync. The checkbox remained stale. | Explicit refresh requests reload through the existing edit-safe backend reload mechanism, even after no-change relay passes. |
| Partial success was hidden by a later error | A real native relay pass applies a task completion, then a later batch returns HTTP 503. A retry consumes an empty batch and reports zero operations and `state_changed=false`. | Refresh after failed native passes; retain a refresh latch if the database read fails too. Ordinary successful empty polls still perform no backend reload. |
| Manual sync completed before its requested pass | Block an upload, request manual sync, and allow the old pass to finish. The manual promise previously resolved while its queued pass was still blocked, even when that pass later failed. | Manual callers await the queued pass and observe its actual result or failure. Explicit refresh intent survives coalescing with edit triggers. |
| Outgoing edits depended on a timer after upload had started | Persist a task completion during an active upload and freeze the two-second timer, modeling WebView suspension. The current upload had already captured its operations. | Queue the follow-up immediately when persistence completes during a native pass. |
| Direct TCP success does not acknowledge receiver application | Across four merge-delay schedules and three retries each, the receiver rejects an operation while the sender returns success. Both directions exchange real encrypted TCP frames. | Characterized in a passing test; remains unresolved. Adding a durable receiver acknowledgement requires a compatible protocol change. |

## Division of review and testing

- Engine subagent: native ordering, replay, checkpoints, causal edits, undo/redo,
  duplicate persistence, and immutable operation IDs.
- Frontend subagent: scheduler promises, refresh behavior, save acknowledgements,
  text coalescing, suspension, and edit/reload races.
- Relay subagent: HTTP cursor advancement, partial commits, quarantine recovery,
  Worker checkpoint/upload concurrency, lost acknowledgements, and independent
  review of the engine changes.
- Primary agent: integration review, timestamp indexing, local verification,
  before/after CI runs, Android catch-up assertions, and final integration.

## Coverage

- 32 completion-order cases: equal timestamps, 1 ms skew, and seeded skew up to
  ten minutes; shuffled delivery, duplicate writes, repeated reconciliation.
- 16 seeded native schedules: 768 edits across two replicas with partitions,
  delayed subsets, duplicate delivery, and 64 convergence/replay/checkpoint
  boundaries. Assertions compare domain state against full replay.
- Additional native tests cover future observed clocks in undo/redo, legacy
  timestamp precision and offsets, retries after newer edits and compaction,
  and rejection of changed-content operation IDs.
- 51 native HTTP fault/recovery schedules across 17 batch positions, including
  the boundaries of eight-way parallel downloads: HTTP 503, corrupt ciphertext,
  and wrong epochs. Cursors must stop before the failed batch and recovery must
  clear quarantine.
- 12 real encrypted direct-TCP exchanges characterize sender success while a
  receiver transaction fails and its inventory remains incomplete.
- 16 Worker seeds, 64 checkpoint/upload races, and 512 eventual records, with
  asynchronous storage delays, copied storage values, acknowledgement loss,
  duplicate retries, and epoch conflicts. No lost acknowledged Worker data was
  reproduced in these schedules.
- 48 desktop/mobile browser cases, repeated three times in CI. The seeded case
  exercises 24 edit/upload/manual schedules per viewport and repetition;
  deterministic gates cover the specific failures above. The native bridge is
  synthetic; these browser tests do not substitute for Android runtime tests.
- Android catch-up uses the existing real debug APK/WorkManager profiler, now
  flipping 66 task completions in separate encrypted batches. It verifies all
  600 seeded tasks' fields and preservation of a separate joiner-local edit.
  The CI invocation also enables the existing resume-stress option, which
  measures three startup database reads while relay responses are delayed.

## Evidence and limits

The [test-only CI run](https://github.com/jonahclarsen/Balance/actions/runs/33983260107)
at `6f86108` failed as expected: 153 native tests passed and the new causal
completion test failed at case 0, skew 0 ms, with equal inventories. Browser
coverage produced 36 expected failures across both viewports and three repeats
(the five deterministic cases plus the seeded scheduling case).

Local fixed-code verification passed 161 native tests (three opt-in profiles
ignored by the ordinary command), 48 browser cases, all 18 relay contract tests,
23 frontend unit tests, and frontend type checking. The subsequently added
direct-TCP characterization also passed. A normal host `cargo check --locked`
passed after promoting the causal clock's existing date dependency from
macOS-only to shared dependencies; Android CI caught that build configuration
issue before integration.

The [fixed-code CI run](https://github.com/jonahclarsen/Balance/actions/runs/33983510845)
at `ceb48fd` passed all three jobs: 161 native tests, 144 browser executions,
18 relay contract tests, and the opt-in 7,300-task relay profile. That profile
measured 66 ms for the simulated phone's incremental push and 58 ms for the
desktop pull after setup (host Rust fixtures, not emulator latency).

The [final isolated sync CI run](https://github.com/jonahclarsen/Balance/actions/runs/33983753388)
at `fd1c730` also passed, including the direct-TCP characterization: 162 native
tests, 144 browser executions, 18 relay tests, and the large-workspace profile.
After merging concurrent planner and undo/navigation changes in the isolated
checkout, local integration checks passed 163 native tests, 39 unit tests,
63 browser tests (sync freshness plus undo/navigation; one desktop/mobile
inapplicable case skipped), and frontend type checking.

The [Android CI run](https://github.com/jonahclarsen/Balance/actions/runs/33983754604)
at `fd1c730` passed the x86_64 debug build and real emulator pairing/sync suite.
Its downloaded `emulator-logcat` artifact reports:

- Background progress: true; 64 batches consumed by the forced WorkManager pass.
- Remaining foreground operations: 3; foreground catch-up: 275 ms.
- Verified completion changes: 66; verified synthetic task records: 600.
- Joiner-local edit preserved: true.
- With relay responses delayed 3,000 ms, the three startup reads took 7, 7,
  and 6 ms; zero reads exceeded the 2,000 ms stall threshold.

Android was built and executed only in CI. No release APK was installed on a
personal device. After the final concurrent presentation-only undo change was
merged, the affected browser suite passed again (13 passed, one inapplicable
case skipped).

The fixes do not prove which failure affected a particular personal database.
Both devices need updated code to prevent old writers from producing these
ordering and immutable-ID failures. The wire format is unchanged. Already
diverged materialized state with identical inventories is not automatically
repaired by the causal timestamp change; no startup replay or personal-data
repair was added. Canonical replay can restore consistency but cannot infer a
user's intended winner from an already misordered historical log.

Seeded schedules provide repeatable counterexamples and regression coverage,
not exhaustive exploration of every possible interleaving. A forced Android
job proves background progress, not an exact five-minute scheduling guarantee.
