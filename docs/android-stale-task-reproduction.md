# Android task loss during stale-day catch-up

Run the opt-in diagnostic against a pushed branch:

```sh
gh workflow run android.yml --ref <branch> -f run_stale_task_repro=true
```

The `emulator-logcat` artifact contains `android-stale-task-repro.json`, the
synthetic relay log, and Android logcat. No installed database or personal
account is used. The workflow builds and runs the actual Android debug APK;
Android setup and execution remain CI-only.

The current diagnostic keeps every day ID unchanged and performs no day
regeneration. A baseline contains 600 tasks, followed by 66 separate encrypted
completion edits. Later batches move the previous bottom task to another day, delete it, and
restore it. A newer checkpoint is then built by the real native snapshot
builder, preserving the day IDs. The move and deletion scenarios stop at earlier
relay cursors and never receive that checkpoint.

Each scenario resets the joining installation, syncs only the baseline, and
loads the stale day in the real WebView. Input uses **Add item** or a real Enter
key followed by DevTools text input. Cases cover:

- Add and Enter before ordinary incremental catch-up.
- Add and Enter before an incoming checkpoint.
- Add and Enter while a real relay download is held in flight.
- Active Android IME composition while the checkpoint arrives.
- Add and Enter before real WorkManager background catch-up and app resume.
- Add and Enter when catch-up moves the previous bottom task to another day.
- Enter when catch-up deletes that previous task.

The proxy controls when encrypted batches become visible and when downloads
finish. The app's production scheduler performs reconciliation and UI refresh.
A follow-up native sync must pull zero remaining operations. Every remote
completion is checked by task ID, including tasks moved to a different day.

The report records creation method, timing, whether the typed task was already
durable, its actual persisted creation operation, database and UI presence,
and presence after a cold restart. `reproduced: true` means the new task is absent
from every plan and the UI after catch-up; `textLost` separately captures a row
that remains but loses the entered text. Diagnostic success means the experiment
completed, not that losing a task is acceptable. Each before/after result is
written immediately so later harness failures do not erase earlier evidence.

These controlled scenarios do not establish which edits or timing occurred in
a particular user incident. The original regeneration experiment below is a
separate confirmed defect and does not explain a report that rules out
regeneration.

## Ordinary catch-up result

[Android run 34316856550](https://github.com/jonahclarsen/Balance/actions/runs/34316856550)
passed on harness commit `c589413`. All 12 scenarios completed with unchanged
application code, and the report confirms zero regenerations:

| Cases | Count | Result after catch-up and cold restart |
| --- | --- | --- |
| Add / Enter, ordinary completion backlog | 2 | Task and text preserved |
| Add / Enter, incoming checkpoint | 2 | Task and text preserved |
| Add / Enter, typing during download | 2 | Task and text preserved |
| Enter, active IME composition during checkpoint download | 1 | Task and text preserved |
| Add / Enter, real WorkManager pass followed by resume | 2 | Task and text preserved |
| Add, preceding task moved to another day | 1 | Task and text preserved |
| Enter, preceding task moved to another day | 1 | New task disappeared |
| Enter, preceding task moved and deleted | 1 | New task disappeared |

The two failing scenarios receive no newer checkpoint. Both verify the new task
was visible and durable before catch-up, retain the exact same day ID, and find
the new task absent from every plan afterward. Its `split_plan_item` creation
operation is still present with the same ID and sequence. A follow-up sync
pulls zero operations, and a cold restart does not restore the task.

The native `split_plan_item_row` handler returns success immediately when its
source task is missing or belongs to another day. Pressing Enter stores the new
task inside that split operation. Ordinary catch-up replays the remote move or
deletion before the local split, so the guard also skips inserting the new task.
Subsequent text patches target an item that no longer exists. The matching
**Add item** control survives the same move because its `add_plan_item`
operation depends only on the unchanged day.

This establishes a non-regeneration failure path; it does not establish that
the user used Enter or that the preceding task was moved/deleted in their
incident. No production fix is included.

The earlier expanded run
[34316143220](https://github.com/jonahclarsen/Balance/actions/runs/34316143220)
completed the same 12 cases with the same two losses, then failed during logcat
collection because Node's default output buffer was exceeded. The final harness
raises that collection limit and still cleans up if collection fails. That
first run also passed the existing 600-task WorkManager catch-up profile.

## Earlier regeneration result

[Android run 34301740059](https://github.com/jonahclarsen/Balance/actions/runs/34301740059)
completed successfully on harness commit `653f84c`, with unchanged application
code from `f69b4ac`:

| Scenario | Before catch-up | After catch-up | After app restart |
| --- | --- | --- | --- |
| 66 ordinary edit batches | Task visible and durable | Task visible and durable | Task visible and durable |
| Same backlog plus day regeneration | Task visible and durable | Task absent from planner state and UI | Task still absent |

The report records `reproduced: true` for `regenerated-day`. The follow-up native
sync pulled zero operations in both cases, confirming that the foreground
scheduler had already completed catch-up before the verification call.

The existing WorkManager profile also passed in
[run 34300998216](https://github.com/jonahclarsen/Balance/actions/runs/34300998216),
verifying all 600 seeded tasks, all 66 completion changes, and its joiner-local
edit. That run's new diagnostic subsequently timed out because its original
observation hook tried to replace Tauri's immutable `invoke` property. The final
harness observes persisted state and scheduler UI instead.

The native `generate_plan` handler deletes the previous plan for the date and
inserts the replacement under its new ID. The later Android `add_plan_item`
operation still targets the original ID. `insert_plan_item` returns success
without inserting when that plan no longer exists. Canonical replay therefore
loses the new task from the materialized planner, even though Android had saved
it locally before catch-up. This change adds the reproduction only; it does not
change those application behaviors.
