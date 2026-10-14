//! Finish queued WorkManager handoffs before exiting a destroyed Android UI.
use std::sync::{Condvar, Mutex};
use std::time::Duration;

static PENDING_SCHEDULES: Mutex<usize> = Mutex::new(0);
static SCHEDULES_FINISHED: Condvar = Condvar::new();

#[no_mangle]
pub extern "system" fn Java_app_balance_local_BalanceSyncWorker_nativeBeginScheduling(
    _env: jni::JNIEnv,
    _class: jni::objects::JClass,
) {
    let mut pending = PENDING_SCHEDULES
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    *pending += 1;
}

#[no_mangle]
pub extern "system" fn Java_app_balance_local_BalanceSyncWorker_nativeFinishScheduling(
    _env: jni::JNIEnv,
    _class: jni::objects::JClass,
) {
    let mut pending = PENDING_SCHEDULES
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    *pending = pending.saturating_sub(1);
    SCHEDULES_FINISHED.notify_all();
}

pub(crate) fn exit_after_last_activity() -> ! {
    // This runs on Tao's native event-loop thread, not Android's UI thread.
    // onStop enqueues WorkManager work asynchronously. Wait for its durable
    // handoff so terminating the process cannot discard the next sync job.
    let pending = PENDING_SCHEDULES
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let (pending, timeout) = SCHEDULES_FINISHED
        .wait_timeout_while(pending, Duration::from_secs(2), |pending| *pending != 0)
        .unwrap_or_else(|error| error.into_inner());
    if timeout.timed_out() && *pending != 0 {
        log::warn!("Timed out finishing background scheduling during Android shutdown");
    }
    drop(pending);

    // Tao would call std::process::exit here. Its C/ELF finalizers can destroy
    // mutexes still in use by Android/WebView threads. Let the OS reclaim those
    // resources instead, preserving the existing last-window exit behavior.
    log::info!("BALANCE_NATIVE_ACTIVITY_EXIT: scheduling finished; immediate process shutdown");
    unsafe {
        extern "C" {
            fn _exit(status: i32) -> !;
        }
        _exit(0);
    }
}
