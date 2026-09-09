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
