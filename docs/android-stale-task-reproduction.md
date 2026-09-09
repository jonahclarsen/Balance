# Android task loss during stale-day catch-up

Run the opt-in diagnostic against a pushed branch:

```sh
gh workflow run android.yml --ref <branch> -f run_stale_task_repro=true
```

The `emulator-logcat` artifact contains `android-stale-task-repro.json`, the
synthetic relay log, and Android logcat. No installed database or personal
account is used. The workflow builds and runs the actual Android debug APK;
Android setup and execution remain CI-only.

The fixture stages a baseline with 600 tasks, followed by 66 separate encrypted
edit batches and one day-regeneration batch. A proxy exposes only the baseline
while each fresh joining installation bootstraps, then returns HTTP 503 while
the test clicks **Add item** and enters text through WebView DevTools input.
It checks that the new bottom task is both visible and durable before
reconnecting. The normal foreground scheduler performs catch-up and refreshes
the screen.

Two independently reset joining installations exercise:

- **ordinary-backlog:** deliver all 66 ordinary edit batches. All changed task
  completions and the new Android task must survive.
- **regenerated-day:** also deliver a regeneration of that same date, with a new
  plan ID. The regeneration preserves every task known to the primary. Android
  creates its task afterward, against its still-stale original plan ID.

The report records the task and plan IDs before and after catch-up, database
and UI presence, native sync results, and presence after a cold app restart.
`reproduced: true` means a task verified durable and visible before catch-up is
absent from both afterward. Diagnostic success means the experiment completed;
it does not mean task loss is correct. A future fix can make the regeneration
case report `reproduced: false` without breaking the diagnostic.

This experiment tests incremental foreground catch-up and remote day
replacement. It does not establish that regeneration happened in a particular
user incident, nor cover every checkpoint, typing/composition, or background
scheduling race. The separate `run_sync_catchup_profile=true` option exercises
the existing real WorkManager catch-up profile.

## Confirmed CI result

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
