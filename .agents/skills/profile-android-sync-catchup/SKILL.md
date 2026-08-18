---
name: profile-android-sync-catchup
description: Run, interpret, debug, or modify Balance's opt-in Android background sync catch-up profiler in GitHub Actions. Use when validating WorkManager relay progress, reproducing Android devices falling more than 64 relay batches behind, comparing foreground catch-up latency, or diagnosing the android-sync-catchup CI artifacts.
---

# Profile Android sync catch-up

Use the committed profiler to exercise the real Android debug APK, WorkManager
registration, encrypted relay batches, and a synthetic SQLCipher database. Never
run or build Android locally, and never substitute an installed or personal
database, recovery key, relay credential, or application data.

## Run the profile

1. Push the commit under test to a remote branch.
2. Dispatch `.github/workflows/android.yml` with
   `run_sync_catchup_profile=true`:

   ```sh
   gh workflow run android.yml --ref <branch> -f run_sync_catchup_profile=true
   ```

3. Find the run created for that branch, then watch it to completion:

   ```sh
   gh run list --workflow android.yml --branch <branch> --limit 5
   gh run watch <run-id> --exit-status
   ```

4. Download the `emulator-logcat` artifact and inspect:
   `android-sync-catchup-profile.json`, `android-sync-catchup-relay.log`,
   `android-sync-catchup-logcat.txt`, and
   `android-sync-catchup-jobscheduler.txt`.

The profile is opt-in because emulator lifecycle timing makes it too expensive
and variable for every release gate. A normal Android run does not execute it.

## Interpret the result

The fixture uploads one baseline batch plus 66 distinct incremental batches.
The separate-batch shape is essential: 66 operations in one batch would not
cross the background download budget. The current 64-chunk background budget
should leave three operations for the measured foreground pass:

- `backgroundMadeProgress: true` proves the forced background pass consumed
  some of the backlog.
- `foregroundPulledOperations: 3` is the current expected fixed result.
- `foregroundPulledOperations: 67` means the background pass made no progress,
  matching the original regression.
- `foregroundCatchupMs` measures only the remaining foreground relay pass, not
  fixture creation, cold SQLCipher startup, or emulator boot.

Do not claim that this forced-job profile proves an exact five-minute cadence.
Android scheduling is best-effort; the profile proves that the registered
WorkManager job can run in the background and make bounded relay progress.

For performance comparisons, use matched branches with the same final harness,
fixture, workflow, runner image, and app state. Change only the production sync
implementation. Compare pulled-operation counts first and timings second;
GitHub-hosted emulator timings vary between runs.

## Preserve the fixture's semantics

- Keep all data synthetic and the relay secret randomly generated per run.
- Keep `persist_operations_for_android_ci` rejected outside Android debug
  builds. Do not expose fixture seeding in production.
- Keep the joiner local operation. It exercises replay when incoming operations
  arrive out of order relative to local work.
- Keep fixture batches uncheckpointed. A checkpoint can collapse the intended
  backlog and stop the test from covering incremental batch draining.
- Seed the fixture in one database session, but stage one encrypted relay batch
  per synthetic operation. Per-operation database reopening makes setup swamp
  the measurement.
- Keep the batch count above `MAX_BACKGROUND_DOWNLOAD_CHUNKS`. If the budget
  changes, update the fixture and expected remainder together.

## Respect Android lifecycle traps

The following details were learned through repeated CI failures and should not
be simplified without another successful profile run:

- `pm clear` kills the app, changes its PID and WebView DevTools socket, removes
  its database, and removes CI completion markers. Reconnect DevTools to the new
  PID and restore only the synthetic benchmark markers.
- Wait independently for the Tauri invoke bridge, `.app-shell`, and encrypted
  database loading to finish. Debug cold initialization can legitimately take
  well over 60 seconds on the emulator.
- WorkManager may register multiple JobScheduler entries, including widget
  work. Try every matching `SystemJobService` ID and accept a job only after the
  counting proxy observes a relay manifest request.
- AndroidX may place jobs in the `androidx.work.systemjobscheduler` namespace.
  Support both namespaced and legacy `cmd jobscheduler run` forms, and parse
  namespaced `dumpsys jobscheduler` headers.
- Do not wait on a DevTools reload across `pm clear`; the socket closes as the
  process dies. Relaunch, discover the replacement socket, and reconnect.
- Preserve the completion markers under the app's `Balance` data directory so
  the fresh joiner does not recursively run the large startup benchmarks.

## Diagnose failures

Check evidence in this order:

1. `android-sync-catchup-profile.json`: determine whether the profile completed
   and whether background progress occurred.
2. `android-sync-catchup-jobscheduler.txt`: verify WorkManager registration,
   namespace, service, constraints, and selected job ID.
3. `android-sync-catchup-relay.log`: verify manifest and batch traffic reached
   the isolated relay.
4. `android-sync-catchup-logcat.txt`: inspect process death, WorkManager, Tauri,
   WebView, SQLCipher, and Rust failures.
5. The GitHub Actions step log: distinguish emulator timeout, app readiness,
   DevTools reconnection, and assertion failures.

When changing the harness, validate JavaScript and shell syntax locally without
building Android, push the branch, and use this CI profile for actual Android
verification.
