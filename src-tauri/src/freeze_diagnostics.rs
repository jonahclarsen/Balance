//! Content-free, bounded diagnostics. Never opens the planner DB or writes on the UI thread.
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        mpsc::{sync_channel, SyncSender},
        Mutex, OnceLock,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const MAX_BYTES: u64 = 128 * 1024;
const STALL_MS: u64 = 15_000;
static RECORDER: OnceLock<Recorder> = OnceLock::new();
static FILE_ACCESS: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case", deny_unknown_fields)]
pub enum Event {
    SessionStart {
        version: String,
        commit: String,
        os: String,
        arch: String,
    },
    AndroidDevice {
        manufacturer: String,
        model: String,
        sdk: i32,
        webview_version: String,
    },
    ActivityResumed,
    ActivityPaused,
    MainThreadPulse,
    WebviewPulse {
        visible: bool,
        editor_focused: bool,
        composing: bool,
    },
    WindowFocus {
        focused: bool,
    },
    JavascriptError,
    ReportShareFailed,
    UnhandledRejection,
    OperationStarted {
        operation: Operation,
    },
    OperationFinished {
        operation: Operation,
        elapsed_ms: u64,
    },
    Health {
        main_thread_age_ms: u64,
        webview_age_ms: u64,
        editor_focused: bool,
        composing: bool,
        database_tasks: u32,
        relay_tasks: u32,
    },
    MainThreadStall {
        age_ms: u64,
    },
    WebviewStall {
        age_ms: u64,
    },
    MainThreadRecovered {
        age_ms: u64,
    },
    WebviewRecovered {
        age_ms: u64,
    },
}

#[derive(Deserialize)]
#[serde(tag = "event", rename_all = "snake_case", deny_unknown_fields)]
pub enum WebEvent {
    WebviewPulse {
        visible: bool,
        editor_focused: bool,
        composing: bool,
    },
    WindowFocus {
        focused: bool,
    },
    JavascriptError {},
    UnhandledRejection {},
}
impl From<WebEvent> for Event {
    fn from(event: WebEvent) -> Self {
        match event {
            WebEvent::WebviewPulse {
                visible,
                editor_focused,
                composing,
            } => Event::WebviewPulse {
                visible,
                editor_focused,
                composing,
            },
            WebEvent::WindowFocus { focused } => Event::WindowFocus { focused },
            WebEvent::JavascriptError {} => Event::JavascriptError,
            WebEvent::UnhandledRejection {} => Event::UnhandledRejection,
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    Database,
    ForegroundRelay,
    BackgroundRelay,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    time_ms: u64,
    session_ms: u64,
    pid: u32,
    details: Event,
}

struct Recorder {
    sender: SyncSender<Event>,
    directory: PathBuf,
}

pub fn start(directory: PathBuf, version: String, commit: String) {
    RECORDER.get_or_init(|| {
        let (sender, receiver) = sync_channel(128);
        let worker_directory = directory.clone();
        let _ = std::thread::Builder::new()
            .name("balance-freeze-recorder".into())
            .spawn(move || {
                let session = now_ms();
                let mut monitor = Monitor::new(Instant::now());
                let mut writer = Writer {
                    directory: worker_directory,
                    session,
                };
                let _ = writer.append(Event::SessionStart {
                    version,
                    commit,
                    os: std::env::consts::OS.into(),
                    arch: std::env::consts::ARCH.into(),
                });
                loop {
                    match receiver.recv_timeout(Duration::from_secs(5)) {
                        Ok(event) => {
                            for record in monitor.accept(event, Instant::now()) {
                                let _ = writer.append(record);
                            }
                        }
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                    #[cfg(target_os = "android")]
                    {
                        let active = ANDROID_ACTIVE.load(std::sync::atomic::Ordering::Relaxed);
                        if active != monitor.active {
                            for event in monitor.accept(
                                if active {
                                    Event::ActivityResumed
                                } else {
                                    Event::ActivityPaused
                                },
                                Instant::now(),
                            ) {
                                let _ = writer.append(event);
                            }
                        }
                    }
                    for record in monitor.check(Instant::now()) {
                        let _ = writer.append(record);
                    }
                }
            });
        Recorder { sender, directory }
    });
}

/// Best effort, bounded and nonblocking, including while a DB worker is stuck.
pub fn record(event: Event) -> bool {
    RECORDER
        .get()
        .map(|recorder| recorder.sender.try_send(event).is_ok())
        .unwrap_or(false)
}

pub struct Span {
    operation: Operation,
    started: Instant,
}
impl Span {
    pub fn new(operation: Operation) -> Self {
        record(Event::OperationStarted { operation });
        Self {
            operation,
            started: Instant::now(),
        }
    }
}
impl Drop for Span {
    fn drop(&mut self) {
        record(Event::OperationFinished {
            operation: self.operation,
            elapsed_ms: self.started.elapsed().as_millis() as u64,
        });
    }
}

pub fn export() -> Result<String, String> {
    let directory = &RECORDER
        .get()
        .ok_or("Freeze diagnostics are unavailable.")?
        .directory;
    read_report(directory)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

struct Writer {
    directory: PathBuf,
    session: u64,
}
impl Writer {
    fn append(&mut self, event: Event) -> std::io::Result<()> {
        let important = matches!(
            event,
            Event::SessionStart { .. }
                | Event::ActivityResumed
                | Event::ActivityPaused
                | Event::MainThreadStall { .. }
                | Event::WebviewStall { .. }
        );
        let session_start = matches!(event, Event::SessionStart { .. });
        let mut bytes = serde_json::to_vec(&Record {
            time_ms: now_ms(),
            session_ms: self.session,
            pid: std::process::id(),
            details: event,
        })?;
        bytes.push(b'\n');
        if session_start {
            bytes.insert(0, b'\n');
        }

        let _guard = FILE_ACCESS.lock().unwrap_or_else(|e| e.into_inner());
        fs::create_dir_all(&self.directory)?;
        let current = self.directory.join("freeze-current.jsonl");
        let previous = self.directory.join("freeze-previous.jsonl");
        if fs::metadata(&current).map(|m| m.len()).unwrap_or(0) + bytes.len() as u64 > MAX_BYTES {
            if previous.exists() {
                fs::remove_file(&previous)?;
            }
            fs::rename(&current, &previous)?;
        }
        let mut file = OpenOptions::new().create(true).append(true).open(current)?;
        file.write_all(&bytes)?;
        // Force quit does not discard completed OS writes. Sync incident/lifecycle
        // records as well, without forcing storage flushes for every keystroke.
        if important {
            file.sync_data()?;
        }
        Ok(())
    }
}

fn read_report(directory: &Path) -> Result<String, String> {
    let _guard = FILE_ACCESS.lock().unwrap_or_else(|e| e.into_inner());
    let mut records = Vec::new();
    let mut incomplete = 0;
    for name in ["freeze-previous.jsonl", "freeze-current.jsonl"] {
        let path = directory.join(name);
        let file = match fs::File::open(path) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err("Could not read freeze diagnostics.".into()),
        };
        let mut bytes = Vec::new();
        file.take(MAX_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Could not read freeze diagnostics.")?;
        if bytes.len() as u64 > MAX_BYTES {
            return Err("Freeze diagnostics exceeded their storage limit.".into());
        }
        for line in bytes.split(|b| *b == b'\n').filter(|line| !line.is_empty()) {
            match serde_json::from_slice::<Record>(line) {
                Ok(record) => records.push(record),
                Err(_) => incomplete += 1,
            }
        }
    }
    serde_json::to_string_pretty(&serde_json::json!({ "format": "balance-freeze-report-v1", "stallThresholdMs": STALL_MS, "retainedBytesLimit": MAX_BYTES * 2, "incompleteRecordsSkipped": incomplete, "records": records }))
        .map_err(|_| "Could not prepare freeze diagnostics.".into())
}

struct Monitor {
    active: bool,
    visible: bool,
    native_ui: bool,
    ui: Instant,
    js: Instant,
    health: Instant,
    ui_stalled: bool,
    js_stalled: bool,
    focused: bool,
    composing: bool,
    database: u32,
    relay: u32,
}
impl Monitor {
    fn new(now: Instant) -> Self {
        Self {
            active: false,
            visible: false,
            native_ui: cfg!(target_os = "android"),
            ui: now,
            js: now,
            health: now,
            ui_stalled: false,
            js_stalled: false,
            focused: false,
            composing: false,
            database: 0,
            relay: 0,
        }
    }
    fn accept(&mut self, event: Event, now: Instant) -> Vec<Event> {
        let mut records = Vec::new();
        match event {
            Event::ActivityResumed => {
                self.active = true;
                self.visible = true;
                self.ui = now;
                self.js = now;
                self.ui_stalled = false;
                self.js_stalled = false;
                records.push(event);
            }
            Event::ActivityPaused => {
                self.active = false;
                records.push(event);
            }
            Event::MainThreadPulse => {
                if self.ui_stalled {
                    records.push(Event::MainThreadRecovered {
                        age_ms: now.duration_since(self.ui).as_millis() as u64,
                    });
                }
                self.ui = now;
                self.ui_stalled = false;
            }
            Event::WebviewPulse {
                visible,
                editor_focused,
                composing,
            } => {
                if self.js_stalled {
                    records.push(Event::WebviewRecovered {
                        age_ms: now.duration_since(self.js).as_millis() as u64,
                    });
                }
                if visible != self.visible
                    || editor_focused != self.focused
                    || composing != self.composing
                {
                    records.push(event);
                }
                if !self.native_ui {
                    self.active = visible;
                }
                self.visible = visible;
                self.focused = editor_focused;
                self.composing = composing;
                self.js = now;
                self.js_stalled = false;
            }
            Event::OperationStarted { operation } => {
                match operation {
                    Operation::Database => self.database = self.database.saturating_add(1),
                    _ => self.relay = self.relay.saturating_add(1),
                };
            }
            Event::OperationFinished {
                operation,
                elapsed_ms,
            } => {
                match operation {
                    Operation::Database => self.database = self.database.saturating_sub(1),
                    _ => self.relay = self.relay.saturating_sub(1),
                };
                if elapsed_ms >= 2_000 {
                    records.push(event);
                }
            }
            _ => records.push(event),
        }
        records
    }
    fn check(&mut self, now: Instant) -> Vec<Event> {
        if !self.active {
            return Vec::new();
        }
        let ui_age = now.duration_since(self.ui).as_millis() as u64;
        let js_age = now.duration_since(self.js).as_millis() as u64;
        let mut records = Vec::new();
        if self.native_ui && !self.ui_stalled && ui_age >= STALL_MS {
            self.ui_stalled = true;
            records.push(Event::MainThreadStall { age_ms: ui_age });
        }
        if self.visible && !self.js_stalled && js_age >= STALL_MS {
            self.js_stalled = true;
            records.push(Event::WebviewStall { age_ms: js_age });
        }
        if !records.is_empty() || now.duration_since(self.health) >= Duration::from_secs(30) {
            self.health = now;
            records.push(Event::Health {
                main_thread_age_ms: ui_age,
                webview_age_ms: js_age,
                editor_focused: self.focused,
                composing: self.composing,
                database_tasks: self.database,
                relay_tasks: self.relay,
            });
        }
        records
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stall_survives_restart_and_truncated_tail() {
        let dir = std::env::temp_dir().join(format!(
            "balance-freeze-test-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let mut first = Writer {
            directory: dir.clone(),
            session: 1,
        };
        first
            .append(Event::WebviewStall { age_ms: 20_000 })
            .unwrap();
        OpenOptions::new()
            .append(true)
            .open(dir.join("freeze-current.jsonl"))
            .unwrap()
            .write_all(b"{\"partial\":")
            .unwrap();
        // A torn last line is ignored rather than exposing arbitrary raw bytes.
        let report: serde_json::Value = serde_json::from_str(&read_report(&dir).unwrap()).unwrap();
        assert_eq!(report["records"][0]["details"]["event"], "webview_stall");
        assert_eq!(report["incompleteRecordsSkipped"], 1);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn rotation_is_bounded_and_keeps_previous_incident() {
        let dir = std::env::temp_dir().join(format!(
            "balance-freeze-rotation-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let mut writer = Writer {
            directory: dir.clone(),
            session: 1,
        };
        for _ in 0..2200 {
            writer.append(Event::WindowFocus { focused: true }).unwrap();
        }
        let current = fs::metadata(dir.join("freeze-current.jsonl"))
            .unwrap()
            .len();
        let previous = fs::metadata(dir.join("freeze-previous.jsonl"))
            .unwrap()
            .len();
        assert!(current <= MAX_BYTES && previous <= MAX_BYTES);
        let report: serde_json::Value = serde_json::from_str(&read_report(&dir).unwrap()).unwrap();
        assert!(!report["records"].as_array().unwrap().is_empty());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn background_time_is_not_a_stall_and_resuming_resets_the_deadline() {
        let now = Instant::now();
        let mut m = Monitor::new(now);
        m.native_ui = true;
        m.accept(Event::ActivityResumed, now);
        m.accept(Event::ActivityPaused, now);
        assert!(m.check(now + Duration::from_secs(3600)).is_empty());
        m.accept(Event::ActivityResumed, now + Duration::from_secs(3600));
        assert!(m
            .check(now + Duration::from_secs(3605))
            .iter()
            .all(|e| !matches!(
                e,
                Event::MainThreadStall { .. } | Event::WebviewStall { .. }
            )));
    }
    #[test]
    fn independent_monitor_detects_missing_pulses_and_records_recovery_once() {
        let now = Instant::now();
        let mut m = Monitor::new(now);
        m.native_ui = true;
        m.accept(Event::ActivityResumed, now);
        m.accept(
            Event::WebviewPulse {
                visible: true,
                editor_focused: true,
                composing: true,
            },
            now,
        );
        m.accept(
            Event::OperationStarted {
                operation: Operation::Database,
            },
            now,
        );
        let stalled = m.check(now + Duration::from_secs(20));
        assert!(stalled
            .iter()
            .any(|e| matches!(e, Event::MainThreadStall { .. })));
        assert!(stalled
            .iter()
            .any(|e| matches!(e, Event::WebviewStall { .. })));
        assert!(stalled.iter().any(|e| matches!(
            e,
            Event::Health {
                database_tasks: 1,
                editor_focused: true,
                composing: true,
                ..
            }
        )));
        assert!(m.check(now + Duration::from_secs(21)).is_empty());
        assert!(m
            .accept(Event::MainThreadPulse, now + Duration::from_secs(22))
            .iter()
            .any(|e| matches!(e, Event::MainThreadRecovered { .. })));
    }
    #[test]
    fn frontend_cannot_supply_task_text_or_error_messages() {
        for raw in [
            r#"{"event":"javascript_error","message":"synthetic secret"}"#,
            r#"{"event":"webview_pulse","visible":true,"editor_focused":true,"composing":false,"text":"synthetic task"}"#,
        ] {
            assert!(serde_json::from_str::<WebEvent>(raw).is_err());
        }
    }
}

#[cfg(target_os = "android")]
static ANDROID_CLASS: OnceLock<jni::objects::GlobalRef> = OnceLock::new();
#[cfg(target_os = "android")]
static ANDROID_ACTIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(target_os = "android")]
pub fn share_android(env: &mut jni::JNIEnv, report: &str) -> Result<bool, jni::errors::Error> {
    let cached = ANDROID_CLASS
        .get()
        .ok_or(jni::errors::Error::NullPtr("freeze diagnostics class"))?;
    let class = jni::objects::JClass::from(env.new_local_ref(cached.as_obj())?);
    let text = env.new_string(report)?;
    env.call_static_method(class, "share", "(Ljava/lang/String;)Z", &[(&text).into()])?
        .z()
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_app_balance_local_BalanceFreezeDiagnostics_signal(
    env: jni::JNIEnv,
    class: jni::objects::JClass,
    kind: jni::sys::jint,
) {
    // Retain the class delivered by Java, avoiding hidden Android APIs or
    // class-loader lookup from an attached Rust thread.
    if ANDROID_CLASS.get().is_none() {
        if let Ok(class) = env.new_global_ref(class) {
            let _ = ANDROID_CLASS.set(class);
        }
    }
    match kind {
        0 => {
            ANDROID_ACTIVE.store(true, std::sync::atomic::Ordering::Relaxed);
            record(Event::ActivityResumed);
        }
        1 => {
            ANDROID_ACTIVE.store(false, std::sync::atomic::Ordering::Relaxed);
            record(Event::ActivityPaused);
        }
        2 => {
            record(Event::MainThreadPulse);
        }
        3 => {
            record(Event::ReportShareFailed);
        }
        _ => {}
    }
}

#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_app_balance_local_BalanceFreezeDiagnostics_device(
    mut env: jni::JNIEnv,
    _class: jni::objects::JClass,
    manufacturer: jni::objects::JString,
    model: jni::objects::JString,
    sdk: jni::sys::jint,
    webview_version: jni::objects::JString,
) -> jni::sys::jboolean {
    let mut read = |value: &jni::objects::JString| -> String {
        env.get_string(value)
            .map(|s| {
                String::from(s)
                    .chars()
                    .filter(|c| c.is_ascii_alphanumeric() || " ._-".contains(*c))
                    .take(80)
                    .collect()
            })
            .unwrap_or_default()
    };
    let accepted = record(Event::AndroidDevice {
        manufacturer: read(&manufacturer),
        model: read(&model),
        sdk,
        webview_version: read(&webview_version),
    });
    if accepted {
        jni::sys::JNI_TRUE
    } else {
        jni::sys::JNI_FALSE
    }
}
