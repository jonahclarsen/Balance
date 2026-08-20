use std::collections::HashMap;
use std::fs;
#[cfg(target_os = "android")]
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
#[cfg(any(test, target_os = "android"))]
use std::sync::TryLockError;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[cfg(not(target_os = "android"))]
use keyring::{Entry, Error as KeyringError};
use rand::{rngs::OsRng, RngCore};
use rusqlite::{backup::Backup, params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
#[cfg(target_os = "macos")]
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

#[cfg(target_os = "android")]
mod android_widget;
mod database_keys;
#[cfg(target_os = "macos")]
mod macos_widget;
mod sync;
#[cfg(any(test, target_os = "android", target_os = "macos"))]
mod widget;

const APP_DATABASE_FILE: &str = "balance.sqlite3";
const APP_DATA_DIR: &str = "Balance";
#[cfg(not(target_os = "android"))]
const KEYCHAIN_SERVICE: &str = "app.balance.local";
#[cfg(not(target_os = "android"))]
const KEYCHAIN_RAW_ACCOUNT: &str = "database-recovery-key-raw-v1";
#[cfg(not(target_os = "android"))]
const KEYCHAIN_RAW_ROTATION_PENDING_ACCOUNT: &str = "database-recovery-key-raw-v1-rotation-pending";
#[cfg(not(target_os = "android"))]
const KEYCHAIN_ARCHIVED_ACCOUNT_PREFIX: &str = "database-recovery-key-archived";
const RECOVERY_KEY_CONFIRMED: &str = "recovery_key_confirmed";
const DATABASE_KEY_FORMAT: &str = "database_key_format";
const EXPORT_DIRECTORY: &str = "export_directory";
const SYNC_PAIRING_CODE: &str = "sync_pairing_code";
const SYNC_RELAY_URL: &str = "sync_relay_url";
const SYNC_COMPACTION_COORDINATOR: &str = "sync_compaction_coordinator";
const DATABASE_MAINTENANCE_LAST_AT: &str = "database_maintenance_last_at";
const DATABASE_MAINTENANCE_LATEST_BACKUP: &str = "database_maintenance_latest_backup";
const DATABASE_MAINTENANCE_PREVIOUS_BACKUP: &str = "database_maintenance_previous_backup";
const DATABASE_DAILY_BACKUP_LAST_DAY: &str = "database_daily_backup_last_day";
const DATABASE_DAILY_BACKUP_LATEST: &str = "database_daily_backup_latest";
const DATABASE_DAILY_BACKUP_RETENTION: usize = 7;
const DATABASE_RECLAIM_MIN_BYTES: u64 = 16 * 1024 * 1024;
const DATABASE_RECLAIM_MIN_PERCENT: u64 = 25;
const HISTORY_RECENT_LIMIT: usize = 200;
const HISTORY_DESTRUCTIVE_RETENTION_MS: i64 = 90 * 24 * 60 * 60 * 1_000;
const HISTORY_RECOVERY_EXTENSION_BYTES: usize = 25 * 1024 * 1024;
const SYNC_CHECKPOINT_OPERATION_LIMIT: i64 = 1_000;
const SYNC_CHECKPOINT_PAYLOAD_BYTES: i64 = 8 * 1024 * 1024;
const SYNC_CHECKPOINT_MAX_AGE_MS: i64 = 30 * 24 * 60 * 60 * 1_000;
const SYNC_LOG_DIRTY_SINCE_MS: &str = "sync_log_dirty_since_ms";
const REPLICATED_PREFERENCES: &str = "replicated_preferences";
const ENTITY_COLLECTIONS: [&str; 7] = [
    "goals",
    "goalCompletions",
    "listTemplates",
    "lists",
    "metrics",
    "metricEntries",
    "notes",
];
const DEFAULT_DAILY_REMINDER: &str = "This shouldn't be aspirational";
const GITHUB_LATEST_RELEASE_API: &str =
    "https://api.github.com/repos/jonahclarsen/Balance/releases/latest";
const GITHUB_LATEST_RELEASE_URL: &str = "https://github.com/jonahclarsen/Balance/releases/latest";

#[derive(Clone, Copy)]
enum StartupDatabaseRead {
    RecoveryStatus,
    AppState,
    ExportSettings,
    SyncSettings,
    RelaySync,
}

struct StartupDatabaseConnection {
    database_path: PathBuf,
    recovery_key: String,
    connection: Connection,
    recovery_status_read: bool,
    app_state_read: bool,
    export_settings_read: bool,
    sync_settings_read: bool,
    relay_sync_required: Option<bool>,
    relay_sync_finished: bool,
}

static DATABASE_ACCESS_LOCK: Mutex<()> = Mutex::new(());
static STARTUP_DATABASE_ACCESS_LOCK: Mutex<()> = Mutex::new(());

#[cfg(all(target_os = "macos", not(debug_assertions)))]
pub fn redirect_to_development_app() -> bool {
    unsafe extern "C" {
        fn balance_activate_running_development_app() -> i32;
    }

    // This runs before Tauri or database initialization. The installed app is
    // only a Launch Services handoff when a `tauri dev` process is present.
    unsafe { balance_activate_running_development_app() == 1 }
}

#[cfg(not(all(target_os = "macos", not(debug_assertions))))]
pub fn redirect_to_development_app() -> bool {
    false
}
static STARTUP_DATABASE_CONNECTION: Mutex<Option<StartupDatabaseConnection>> = Mutex::new(None);
#[cfg(target_os = "android")]
static ANDROID_DATABASE_RECOVERY_KEY: Mutex<Option<String>> = Mutex::new(None);
#[cfg(target_os = "android")]
fn cache_android_recovery_key(recovery_key: String) {
    if let Ok(mut cached) = ANDROID_DATABASE_RECOVERY_KEY.lock() {
        *cached = Some(recovery_key);
    }
}
#[cfg(target_os = "macos")]
const BALANCE_PLAN_ITEMS_PASTEBOARD_TYPE: &str = "com.balance.plan-items+json";
#[cfg(target_os = "android")]
const BALANCE_PLAN_ITEMS_CLIPBOARD_ACTION: &str = "app.balance.local.PLAN_ITEMS";
#[cfg(target_os = "android")]
const BALANCE_PLAN_ITEMS_CLIPBOARD_EXTRA: &str = "app.balance.local.PLAN_ITEMS_JSON";
#[cfg(target_os = "android")]
const BALANCE_PLAN_ITEMS_CLIPBOARD_MIME: &str = "application/vnd.app.balance.plan-items+json";
#[cfg(target_os = "macos")]
const PASTE_MATCH_STYLE_MENU_ID: &str = "balance-paste-match-style";
#[cfg(target_os = "macos")]
const PASTE_MATCH_STYLE_EVENT: &str = "balance-paste-match-style";
#[cfg(target_os = "macos")]
const MAIN_WINDOW_FRAME_DEFAULTS_KEY: &str = "BalanceMainWindowFrameV1";
#[cfg(target_os = "macos")]
static MAIN_WINDOW_FRAME_RESTORED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[cfg(target_os = "macos")]
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MacosWindowPlacement {
    frame: MacosRect,
    screen: MacosRect,
    screen_name: String,
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Deserialize, Serialize)]
struct MacosRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[cfg(target_os = "macos")]
impl MacosRect {
    fn from_ns_rect(rect: objc2_foundation::NSRect) -> Self {
        Self {
            x: rect.origin.x,
            y: rect.origin.y,
            width: rect.size.width,
            height: rect.size.height,
        }
    }

    fn is_valid(self) -> bool {
        self.x.is_finite()
            && self.y.is_finite()
            && self.width.is_finite()
            && self.height.is_finite()
            && self.width > 0.0
            && self.height > 0.0
    }

    fn approximately_matches(self, other: objc2_foundation::NSRect) -> bool {
        const TOLERANCE: f64 = 1.0;
        (self.x - other.origin.x).abs() <= TOLERANCE
            && (self.y - other.origin.y).abs() <= TOLERANCE
            && (self.width - other.size.width).abs() <= TOLERANCE
            && (self.height - other.size.height).abs() <= TOLERANCE
    }
}

#[cfg(target_os = "macos")]
fn disable_automatic_text_substitutions() {
    use objc2_foundation::{NSString, NSUserDefaults};

    // WebKit gives this app-specific preference precedence over the system-wide
    // NSSpellChecker settings. Set them before the webview is created so text
    // replacements and smart quotes never become enabled in editable elements.
    let defaults = NSUserDefaults::standardUserDefaults();
    for key in [
        "WebAutomaticTextReplacementEnabled",
        "WebAutomaticQuoteSubstitutionEnabled",
    ] {
        defaults.setBool_forKey(false, &NSString::from_str(key));
    }
}

#[cfg(not(target_os = "macos"))]
fn disable_automatic_text_substitutions() {}

#[cfg(target_os = "macos")]
fn restore_macos_main_window_frame(app: &tauri::App) -> tauri::Result<()> {
    use objc2::MainThreadOnly;
    use objc2_app_kit::{NSScreen, NSWindow};
    use objc2_foundation::{NSPoint, NSRect, NSSize, NSString, NSUserDefaults};

    let window = app
        .get_webview_window("main")
        .ok_or(tauri::Error::WebviewNotFound)?;
    let ns_window = window.ns_window()?.cast::<NSWindow>();

    // Tauri can emit creation-time move/resize events before this setup hook,
    // so keep them from replacing the previous session's placement. AppKit's
    // frame-descriptor restore remaps secondary-display frames onto the main
    // screen; apply the stored native coordinates to the matching NSScreen
    // directly instead.
    unsafe {
        let defaults_key = NSString::from_str(MAIN_WINDOW_FRAME_DEFAULTS_KEY);
        let saved = NSUserDefaults::standardUserDefaults()
            .stringForKey(&defaults_key)
            .and_then(|value| serde_json::from_str::<MacosWindowPlacement>(&value.to_string()).ok())
            .filter(|placement| placement.frame.is_valid() && placement.screen.is_valid());
        if let Some(saved) = saved {
            let ns_window = &*ns_window;
            let screens = NSScreen::screens(ns_window.mtm());
            let target_screen = screens
                .iter()
                .find(|screen| {
                    screen.localizedName().to_string() == saved.screen_name
                        && saved.screen.approximately_matches(screen.frame())
                })
                .or_else(|| {
                    screens
                        .iter()
                        .find(|screen| screen.localizedName().to_string() == saved.screen_name)
                })
                .or_else(|| {
                    screens
                        .iter()
                        .find(|screen| saved.screen.approximately_matches(screen.frame()))
                });

            if let Some(screen) = target_screen {
                let screen_frame = screen.frame();
                let visible_frame = screen.visibleFrame();
                let width = saved.frame.width.min(visible_frame.size.width);
                let height = saved.frame.height.min(visible_frame.size.height);
                let relative_x = saved.frame.x - saved.screen.x;
                let relative_y = saved.frame.y - saved.screen.y;
                let x = (screen_frame.origin.x + relative_x).clamp(
                    visible_frame.origin.x,
                    visible_frame.origin.x + visible_frame.size.width - width,
                );
                let y = (screen_frame.origin.y + relative_y).clamp(
                    visible_frame.origin.y,
                    visible_frame.origin.y + visible_frame.size.height - height,
                );
                ns_window.setFrame_display(
                    NSRect::new(NSPoint::new(x, y), NSSize::new(width, height)),
                    false,
                );
            }
        }
    }
    MAIN_WINDOW_FRAME_RESTORED.store(true, std::sync::atomic::Ordering::Release);
    window.show()
}

#[cfg(target_os = "macos")]
fn save_macos_main_window_frame(window: &tauri::Window) {
    use objc2_app_kit::NSWindow;
    use objc2_foundation::{NSString, NSUserDefaults};

    if window.label() != "main"
        || !MAIN_WINDOW_FRAME_RESTORED.load(std::sync::atomic::Ordering::Acquire)
    {
        return;
    }
    let Ok(ns_window) = window.ns_window() else {
        return;
    };

    unsafe {
        let ns_window = &*ns_window.cast::<NSWindow>();
        let Some(screen) = ns_window.screen() else {
            return;
        };
        let placement = MacosWindowPlacement {
            frame: MacosRect::from_ns_rect(ns_window.frame()),
            screen: MacosRect::from_ns_rect(screen.frame()),
            screen_name: screen.localizedName().to_string(),
        };
        let Ok(placement) = serde_json::to_string(&placement) else {
            return;
        };
        let placement = NSString::from_str(&placement);
        let defaults_key = NSString::from_str(MAIN_WINDOW_FRAME_DEFAULTS_KEY);
        NSUserDefaults::standardUserDefaults()
            .setObject_forKey(Some(placement.as_ref()), &defaults_key);
    }
}

#[cfg(target_os = "macos")]
fn install_paste_and_match_style_menu(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::MenuItem;

    let Some(menu) = app.menu() else {
        return Ok(());
    };
    let edit_menu = menu.items()?.into_iter().find_map(|item| {
        let submenu = item.as_submenu()?;
        (submenu.text().ok().as_deref() == Some("Edit")).then(|| submenu.clone())
    });
    let Some(edit_menu) = edit_menu else {
        return Ok(());
    };

    let paste_match_style = MenuItem::with_id(
        app,
        PASTE_MATCH_STYLE_MENU_ID,
        "Paste and Match Style",
        true,
        Some("Cmd+Alt+Shift+V"),
    )?;
    // Default Edit menu: Undo, Redo, separator, Cut, Copy, Paste, Select All.
    edit_menu.insert(&paste_match_style, 6)?;
    app.on_menu_event(|app, event| {
        if event.id() == PASTE_MATCH_STYLE_MENU_ID {
            let _ = app.emit(PASTE_MATCH_STYLE_EVENT, ());
        }
    });

    Ok(())
}

#[cfg(all(target_os = "android", debug_assertions))]
fn is_android_owner_user() -> bool {
    // Android assigns app UIDs as user_id * 100_000 + app_id. Run the embedded
    // database self-test once for the owner installation; CI launches another
    // copy in a managed profile for the real camera pairing test, and repeating
    // the SQLCipher/cr-sqlite self-test there can interfere with its first DB
    // initialization.
    fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|status| {
            status
                .lines()
                .find_map(|line| line.strip_prefix("Uid:"))
                .and_then(|uids| uids.split_whitespace().next())
                .and_then(|uid| uid.parse::<u32>().ok())
        })
        .is_some_and(|uid| uid < 100_000)
}

#[cfg(all(target_os = "android", debug_assertions))]
fn android_startup_profile_state() -> Value {
    let templates = (0..8)
        .map(|template_index| {
            let items = (0..12)
                .map(|item_index| {
                    json!({
                        "id": format!("profile-template-{template_index}-item-{item_index}"),
                        "startMinutes": item_index * 30,
                        "endMinutes": item_index * 30 + 25,
                        "timeHidden": false,
                        "options": [{
                            "id": format!("profile-option-{template_index}-{item_index}"),
                            "text": format!("Template option {template_index}-{item_index}"),
                            "html": format!("Template option {template_index}-{item_index}"),
                            "probability": 1.0
                        }],
                        "children": []
                    })
                })
                .collect::<Vec<_>>();
            json!({
                "id": format!("profile-template-{template_index}"),
                "name": format!("Profile template {template_index}"),
                "items": items,
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-01T00:00:00.000Z"
            })
        })
        .collect::<Vec<_>>();
    let plans = (0..45)
        .map(|plan_index| {
            let items = (0..24)
                .map(|item_index| {
                    json!({
                        "id": format!("profile-plan-{plan_index}-item-{item_index}"),
                        "text": format!("Profile task {plan_index}-{item_index}"),
                        "html": format!("Profile task {plan_index}-{item_index}"),
                        "done": item_index % 3 == 0,
                        "startMinutes": item_index * 30,
                        "endMinutes": item_index * 30 + 25,
                        "timeHidden": false,
                        "children": []
                    })
                })
                .collect::<Vec<_>>();
            json!({
                "id": format!("profile-plan-{plan_index}"),
                "date": format!("2026-{:02}-{:02}", 1 + plan_index / 28, 1 + plan_index % 28),
                "title": format!("Profile day {plan_index}"),
                "dailyReminder": "Synthetic profile data only",
                "generatedFromTemplateId": "profile-template-0",
                "createdAt": "2026-01-01T00:00:00.000Z",
                "items": items
            })
        })
        .collect::<Vec<_>>();
    let notes = (0..120)
        .map(|index| {
            json!({
                "id": format!("profile-note-{index}"),
                "title": format!("Profile note {index}"),
                "text": "Synthetic startup profile note content",
                "html": "Synthetic startup profile note content",
                "createdAt": "2026-01-01T00:00:00.000Z",
                "updatedAt": "2026-01-01T00:00:00.000Z"
            })
        })
        .collect::<Vec<_>>();

    json!({
        "schemaVersion": 1,
        "deviceId": "android-startup-profile",
        "localSequence": 0,
        "historyRevision": 0,
        "activePlanDate": "2026-01-01",
        "templates": templates,
        "plans": plans,
        "goals": [],
        "goalCompletions": [],
        "listTemplates": [],
        "lists": [],
        "metrics": [],
        "metricEntries": [],
        "notes": notes,
        "operations": []
    })
}

#[cfg(all(target_os = "android", debug_assertions))]
fn profile_android_database_startup(scratch_dir: &Path) -> Result<String, String> {
    const ITERATIONS: usize = 7;
    let database_path = scratch_dir.join("balance-android-startup-profile.sqlite3");
    let _ = fs::remove_file(&database_path);
    let recovery_key = generate_recovery_key();

    let result = (|| {
        let mut connection = open_database_at(&database_path, &recovery_key)?;
        replace_app_state(&mut connection, &android_startup_profile_state())?;
        let expected_state = read_app_state_from_database(&connection)?
            .ok_or_else(|| "Android startup profile fixture has no app state".to_string())?;
        drop(connection);

        let mut separate_connections_ms = Vec::with_capacity(ITERATIONS);
        let mut shared_connection_ms = Vec::with_capacity(ITERATIONS);
        let mut state_read_ms = Vec::with_capacity(ITERATIONS);
        let mut current_launch_sequence_ms = Vec::with_capacity(ITERATIONS);
        let mut shared_launch_sequence_ms = Vec::with_capacity(ITERATIONS);

        for iteration in 0..ITERATIONS {
            let measure_separate = || -> Result<u64, String> {
                let started = std::time::Instant::now();
                let connection = open_database_at(&database_path, &recovery_key)?;
                let status = recovery_key_status(&connection, &database_path, None)?;
                if status.database_path != database_path.display().to_string() {
                    return Err(
                        "Android profile recovery status returned the wrong path".to_string()
                    );
                }
                drop(connection);
                let connection = open_database_at(&database_path, &recovery_key)?;
                let state = read_app_state_from_database(&connection)?
                    .ok_or_else(|| "Android profile database lost its app state".to_string())?;
                if state != expected_state {
                    return Err("Separate startup connections changed profile state".to_string());
                }
                Ok(started.elapsed().as_millis() as u64)
            };
            let measure_shared = || -> Result<u64, String> {
                let started = std::time::Instant::now();
                let connection = open_database_at(&database_path, &recovery_key)?;
                let status = recovery_key_status(&connection, &database_path, None)?;
                if status.database_path != database_path.display().to_string() {
                    return Err(
                        "Android profile recovery status returned the wrong path".to_string()
                    );
                }
                let state = read_app_state_from_database(&connection)?
                    .ok_or_else(|| "Android profile database lost its app state".to_string())?;
                if state != expected_state {
                    return Err("Shared startup connection changed profile state".to_string());
                }
                Ok(started.elapsed().as_millis() as u64)
            };

            if iteration % 2 == 0 {
                separate_connections_ms.push(measure_separate()?);
                shared_connection_ms.push(measure_shared()?);
            } else {
                shared_connection_ms.push(measure_shared()?);
                separate_connections_ms.push(measure_separate()?);
            }

            let measure_launch_sequence = |shared: bool| -> Result<u64, String> {
                let started = std::time::Instant::now();
                let connection = open_database_at(&database_path, &recovery_key)?;
                let _ = recovery_key_status(&connection, &database_path, None)?;
                let state = read_app_state_from_database(&connection)?
                    .ok_or_else(|| "Android profile database lost its app state".to_string())?;
                if state != expected_state {
                    return Err("Launch sequence changed profile state".to_string());
                }
                let read_settings = |connection: &Connection| -> Result<(), String> {
                    let _ = metadata_value(connection, EXPORT_DIRECTORY)?;
                    let _ = sync_settings_from_database(connection)?;
                    let _ = sync::is_sync_enabled(connection).map_err(sync::Error::into_string)?;
                    Ok(())
                };
                if shared {
                    read_settings(&connection)?;
                } else {
                    drop(connection);
                    let connection = open_database_at(&database_path, &recovery_key)?;
                    let _ = metadata_value(&connection, EXPORT_DIRECTORY)?;
                    drop(connection);
                    let connection = open_database_at(&database_path, &recovery_key)?;
                    let _ = sync_settings_from_database(&connection)?;
                    drop(connection);
                    let connection = open_database_at(&database_path, &recovery_key)?;
                    let _ = sync::is_sync_enabled(&connection).map_err(sync::Error::into_string)?;
                }
                Ok(started.elapsed().as_millis() as u64)
            };
            if iteration % 2 == 0 {
                current_launch_sequence_ms.push(measure_launch_sequence(false)?);
                shared_launch_sequence_ms.push(measure_launch_sequence(true)?);
            } else {
                shared_launch_sequence_ms.push(measure_launch_sequence(true)?);
                current_launch_sequence_ms.push(measure_launch_sequence(false)?);
            }

            let connection = open_database_at(&database_path, &recovery_key)?;
            let read_started = std::time::Instant::now();
            let state = read_app_state_from_database(&connection)?
                .ok_or_else(|| "Android profile database lost its app state".to_string())?;
            state_read_ms.push(read_started.elapsed().as_millis() as u64);
            if state != expected_state {
                return Err("Profile state-only read changed profile state".to_string());
            }
        }

        let median = |values: &mut Vec<u64>| {
            values.sort_unstable();
            values[values.len() / 2]
        };
        let separate_median = median(&mut separate_connections_ms);
        let shared_median = median(&mut shared_connection_ms);
        let current_launch_median = median(&mut current_launch_sequence_ms);
        let shared_launch_median = median(&mut shared_launch_sequence_ms);
        Ok(json!({
            "fixture": {
                "plans": 45,
                "planItems": 1080,
                "templates": 8,
                "templateItems": 96,
                "notes": 120
            },
            "iterations": ITERATIONS,
            "samplesMs": {
                "currentSeparateConnections": separate_connections_ms,
                "candidateSharedConnection": shared_connection_ms,
                "stateReadOnly": state_read_ms
                ,"candidate1LaunchSequence": current_launch_sequence_ms
                ,"candidate2SharedLaunchSequence": shared_launch_sequence_ms
            },
            "medianMs": {
                "currentSeparateConnections": separate_median,
                "candidateSharedConnection": shared_median,
                "stateReadOnly": median(&mut state_read_ms)
                ,"candidate1LaunchSequence": current_launch_median
                ,"candidate2SharedLaunchSequence": shared_launch_median
            },
            "sharedConnectionImprovementPercent": if separate_median == 0 {
                0.0
            } else {
                100.0 * (separate_median.saturating_sub(shared_median)) as f64
                    / separate_median as f64
            },
            "sharedLaunchSequenceImprovementPercent": if current_launch_median == 0 {
                0.0
            } else {
                100.0 * (current_launch_median.saturating_sub(shared_launch_median)) as f64
                    / current_launch_median as f64
            }
        })
        .to_string())
    })();

    let _ = fs::remove_file(&database_path);
    result
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClipboardContents {
    structured_payload: Option<String>,
    plain_text: Option<String>,
    html: Option<String>,
}

#[tauri::command]
fn perform_alignment_haptic() -> bool {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{
            NSHapticFeedbackManager, NSHapticFeedbackPattern, NSHapticFeedbackPerformanceTime,
            NSHapticFeedbackPerformer,
        };

        // Alignment is AppKit's feedback for dragging to preferred positions,
        // which matches each 15-minute boundary crossed by a time value.
        NSHapticFeedbackManager::defaultPerformer().performFeedbackPattern_performanceTime(
            NSHapticFeedbackPattern::Alignment,
            NSHapticFeedbackPerformanceTime::Now,
        );
        true
    }

    #[cfg(not(target_os = "macos"))]
    false
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn write_balance_clipboard(plain_text: String, structured_payload: String) -> Result<(), String> {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
    use objc2_foundation::NSString;

    let pasteboard = NSPasteboard::generalPasteboard();
    let plain_text = NSString::from_str(&plain_text);
    let payload = NSString::from_str(&structured_payload);
    let payload_type = NSString::from_str(BALANCE_PLAN_ITEMS_PASTEBOARD_TYPE);

    pasteboard.clearContents();
    if !pasteboard.setString_forType(&plain_text, unsafe { NSPasteboardTypeString })
        || !pasteboard.setString_forType(&payload, &payload_type)
    {
        return Err("Could not write task items to the system pasteboard".to_string());
    }
    Ok(())
}

#[cfg(target_os = "android")]
#[tauri::command]
fn write_balance_clipboard(
    app: tauri::AppHandle,
    plain_text: String,
    structured_payload: String,
) -> Result<(), String> {
    android_clipboard::write(&app, plain_text, structured_payload)
}

#[cfg(all(not(target_os = "macos"), not(target_os = "android")))]
#[tauri::command]
fn write_balance_clipboard(_plain_text: String, _structured_payload: String) -> Result<(), String> {
    Err("Structured system clipboard is currently supported on macOS".to_string())
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn write_note_clipboard(plain_text: String, html: String) -> Result<(), String> {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeHTML, NSPasteboardTypeString};
    use objc2_foundation::NSString;

    let pasteboard = NSPasteboard::generalPasteboard();
    let plain_text = NSString::from_str(&plain_text);
    let html = NSString::from_str(&html);

    pasteboard.clearContents();
    if !pasteboard.setString_forType(&plain_text, unsafe { NSPasteboardTypeString })
        || !pasteboard.setString_forType(&html, unsafe { NSPasteboardTypeHTML })
    {
        return Err("Could not write note contents to the system pasteboard".to_string());
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn write_note_clipboard(_plain_text: String, _html: String) -> Result<(), String> {
    Err("Rich note clipboard writing is currently supported on macOS".to_string())
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn read_balance_clipboard() -> ClipboardContents {
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeHTML, NSPasteboardTypeString};
    use objc2_foundation::NSString;

    let pasteboard = NSPasteboard::generalPasteboard();
    let payload_type = NSString::from_str(BALANCE_PLAN_ITEMS_PASTEBOARD_TYPE);
    ClipboardContents {
        structured_payload: pasteboard
            .stringForType(&payload_type)
            .map(|value| value.to_string()),
        plain_text: pasteboard
            .stringForType(unsafe { NSPasteboardTypeString })
            .map(|value| value.to_string()),
        html: pasteboard
            .stringForType(unsafe { NSPasteboardTypeHTML })
            .map(|value| value.to_string()),
    }
}

#[cfg(target_os = "android")]
#[tauri::command]
fn read_balance_clipboard(app: tauri::AppHandle) -> ClipboardContents {
    android_clipboard::read(&app).unwrap_or_else(|error| {
        log::warn!("Could not read the Android clipboard: {error}");
        ClipboardContents {
            structured_payload: None,
            plain_text: None,
            html: None,
        }
    })
}

#[cfg(all(not(target_os = "macos"), not(target_os = "android")))]
#[tauri::command]
fn read_balance_clipboard() -> ClipboardContents {
    ClipboardContents {
        structured_payload: None,
        plain_text: None,
        html: None,
    }
}

#[cfg(target_os = "android")]
mod android_clipboard {
    use std::sync::mpsc;

    use jni::objects::{JObject, JString};
    use jni::JNIEnv;
    use tauri::Manager;

    use super::{
        ClipboardContents, BALANCE_PLAN_ITEMS_CLIPBOARD_ACTION, BALANCE_PLAN_ITEMS_CLIPBOARD_EXTRA,
        BALANCE_PLAN_ITEMS_CLIPBOARD_MIME,
    };

    const CLIPBOARD_SERVICE: &str = "clipboard";
    const TEXT_PLAIN_MIME: &str = "text/plain";

    pub fn write(
        app: &tauri::AppHandle,
        plain_text: String,
        structured_payload: String,
    ) -> Result<(), String> {
        with_activity(app, move |env, activity| {
            let clipboard = clipboard_manager(env, activity)?;
            let label = env.new_string("Balance task").map_err(jni_error)?;
            let text = env.new_string(plain_text).map_err(jni_error)?;
            let intent = env
                .new_object("android/content/Intent", "()V", &[])
                .map_err(jni_error)?;
            let action = env
                .new_string(BALANCE_PLAN_ITEMS_CLIPBOARD_ACTION)
                .map_err(jni_error)?;
            env.call_method(
                &intent,
                "setAction",
                "(Ljava/lang/String;)Landroid/content/Intent;",
                &[(&action).into()],
            )
            .map_err(jni_error)?;
            let balance_mime = env
                .new_string(BALANCE_PLAN_ITEMS_CLIPBOARD_MIME)
                .map_err(jni_error)?;
            env.call_method(
                &intent,
                "setType",
                "(Ljava/lang/String;)Landroid/content/Intent;",
                &[(&balance_mime).into()],
            )
            .map_err(jni_error)?;

            let payload_key = env
                .new_string(BALANCE_PLAN_ITEMS_CLIPBOARD_EXTRA)
                .map_err(jni_error)?;
            let payload = env.new_string(structured_payload).map_err(jni_error)?;
            env.call_method(
                &intent,
                "putExtra",
                "(Ljava/lang/String;Ljava/lang/String;)Landroid/content/Intent;",
                &[(&payload_key).into(), (&payload).into()],
            )
            .map_err(jni_error)?;

            // Android ClipData.Item supports alternate representations on one item.
            // Other apps see normal text, while Balance can recover the full tree
            // from the Intent without exposing JSON as a second pasted item.
            let item = env
                .new_object(
                    "android/content/ClipData$Item",
                    "(Ljava/lang/CharSequence;Landroid/content/Intent;Landroid/net/Uri;)V",
                    &[(&text).into(), (&intent).into(), (&JObject::null()).into()],
                )
                .map_err(jni_error)?;
            let empty_mime = env.new_string("").map_err(jni_error)?;
            let mime_types = env
                .new_object_array(2, "java/lang/String", &empty_mime)
                .map_err(jni_error)?;
            let plain_mime = env.new_string(TEXT_PLAIN_MIME).map_err(jni_error)?;
            env.set_object_array_element(&mime_types, 0, &plain_mime)
                .map_err(jni_error)?;
            env.set_object_array_element(&mime_types, 1, &balance_mime)
                .map_err(jni_error)?;

            let clip = env
                .new_object(
                    "android/content/ClipData",
                    "(Ljava/lang/CharSequence;[Ljava/lang/String;Landroid/content/ClipData$Item;)V",
                    &[(&label).into(), (&mime_types).into(), (&item).into()],
                )
                .map_err(jni_error)?;
            env.call_method(
                &clipboard,
                "setPrimaryClip",
                "(Landroid/content/ClipData;)V",
                &[(&clip).into()],
            )
            .map_err(jni_error)?;
            Ok(())
        })
    }

    pub fn read(app: &tauri::AppHandle) -> Result<ClipboardContents, String> {
        with_activity(app, |env, activity| {
            let clipboard = clipboard_manager(env, activity)?;
            let clip = env
                .call_method(
                    &clipboard,
                    "getPrimaryClip",
                    "()Landroid/content/ClipData;",
                    &[],
                )
                .and_then(|value| value.l())
                .map_err(jni_error)?;
            if clip.is_null() {
                return Ok(empty_contents());
            }

            let count = env
                .call_method(&clip, "getItemCount", "()I", &[])
                .and_then(|value| value.i())
                .map_err(jni_error)?;
            if count == 0 {
                return Ok(empty_contents());
            }

            let item = env
                .call_method(
                    &clip,
                    "getItemAt",
                    "(I)Landroid/content/ClipData$Item;",
                    &[0.into()],
                )
                .and_then(|value| value.l())
                .map_err(jni_error)?;
            let plain_text = env
                .call_method(&item, "getText", "()Ljava/lang/CharSequence;", &[])
                .and_then(|value| value.l())
                .map_err(jni_error)
                .and_then(|value| object_to_string(env, value))?;
            let html = env
                .call_method(&item, "getHtmlText", "()Ljava/lang/String;", &[])
                .and_then(|value| value.l())
                .map_err(jni_error)
                .and_then(|value| java_string(env, value))?;
            let structured_payload = structured_payload(env, &item)?;

            Ok(ClipboardContents {
                structured_payload,
                plain_text,
                html,
            })
        })
    }

    fn structured_payload(env: &mut JNIEnv, item: &JObject) -> Result<Option<String>, String> {
        let intent = env
            .call_method(item, "getIntent", "()Landroid/content/Intent;", &[])
            .and_then(|value| value.l())
            .map_err(jni_error)?;
        if intent.is_null() {
            return Ok(None);
        }

        let action = env
            .call_method(&intent, "getAction", "()Ljava/lang/String;", &[])
            .and_then(|value| value.l())
            .map_err(jni_error)
            .and_then(|value| java_string(env, value))?;
        if action.as_deref() != Some(BALANCE_PLAN_ITEMS_CLIPBOARD_ACTION) {
            return Ok(None);
        }

        let payload_key = env
            .new_string(BALANCE_PLAN_ITEMS_CLIPBOARD_EXTRA)
            .map_err(jni_error)?;
        let payload = env
            .call_method(
                &intent,
                "getStringExtra",
                "(Ljava/lang/String;)Ljava/lang/String;",
                &[(&payload_key).into()],
            )
            .and_then(|value| value.l())
            .map_err(jni_error)?;
        java_string(env, payload)
    }

    fn clipboard_manager<'local>(
        env: &mut JNIEnv<'local>,
        activity: &JObject,
    ) -> Result<JObject<'local>, String> {
        let service = env.new_string(CLIPBOARD_SERVICE).map_err(jni_error)?;
        env.call_method(
            activity,
            "getSystemService",
            "(Ljava/lang/String;)Ljava/lang/Object;",
            &[(&service).into()],
        )
        .and_then(|value| value.l())
        .map_err(jni_error)
    }

    fn java_string(env: &mut JNIEnv, value: JObject) -> Result<Option<String>, String> {
        if value.is_null() {
            return Ok(None);
        }
        env.get_string(&JString::from(value))
            .map(|value| Some(value.into()))
            .map_err(jni_error)
    }

    fn object_to_string(env: &mut JNIEnv, value: JObject) -> Result<Option<String>, String> {
        if value.is_null() {
            return Ok(None);
        }
        let text = env
            .call_method(&value, "toString", "()Ljava/lang/String;", &[])
            .and_then(|value| value.l())
            .map_err(jni_error)?;
        java_string(env, text)
    }

    fn empty_contents() -> ClipboardContents {
        ClipboardContents {
            structured_payload: None,
            plain_text: None,
            html: None,
        }
    }

    fn with_activity<T: Send + 'static>(
        app: &tauri::AppHandle,
        operation: impl FnOnce(&mut JNIEnv, &JObject) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        let webview = app
            .get_webview_window("main")
            .ok_or_else(|| "The main Android webview is unavailable.".to_string())?;
        let (sender, receiver) = mpsc::sync_channel(1);

        webview
            .with_webview(move |webview| {
                webview.jni_handle().exec(move |env, activity, _webview| {
                    let mut result = operation(env, activity);
                    if env.exception_check().unwrap_or(false) {
                        let _ = env.exception_describe();
                        let _ = env.exception_clear();
                        if result.is_ok() {
                            result =
                                Err("Android clipboard access raised an exception.".to_string());
                        }
                    }
                    let _ = sender.send(result);
                });
            })
            .map_err(|error| format!("Could not access the Android activity: {error}"))?;

        receiver
            .recv()
            .map_err(|_| "Android clipboard access was interrupted.".to_string())?
    }

    fn jni_error(error: jni::errors::Error) -> String {
        error.to_string()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryKeyStatus {
    confirmed: bool,
    recovery_key: Option<String>,
    database_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryKeyRotationResult {
    recovery_key_status: RecoveryKeyStatus,
    archived_key_account: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportSettings {
    export_directory: String,
    default_export_directory: String,
    uses_default_export_directory: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncSettings {
    enabled: bool,
    pairing_code: Option<String>,
    relay_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MacosWidgetSettings {
    hide_content_after_close: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DatabaseCompactionResult {
    before_bytes: u64,
    after_bytes: u64,
    reclaimed_bytes: u64,
    operations_removed: i64,
    history_entries_removed: i64,
    backup_path: Option<String>,
    checkpoint_created: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DatabaseMaintenanceStatus {
    due: bool,
    last_completed_at: Option<String>,
    checkpoint_coordinator: bool,
    database_bytes: u64,
    reclaimable_bytes: u64,
    reclaimable_percent: u64,
    operation_count: i64,
    operation_bytes: i64,
    checkpoint_recommended: bool,
}

#[tauri::command]
async fn read_app_state(app: tauri::AppHandle) -> Result<Option<String>, String> {
    run_startup_database_task(move || {
        let startup = take_startup_database_connection(&app, StartupDatabaseRead::AppState)?;
        let result = read_app_state_from_database(&startup.connection)
            .map(|state| state.map(|value| value.to_string()));
        if result.is_ok() {
            #[cfg(target_os = "macos")]
            if let Err(error) = macos_widget::publish_snapshot(&startup.connection) {
                eprintln!("Could not refresh the macOS widget: {error}");
            }
            finish_startup_database_read(startup, StartupDatabaseRead::AppState, None);
        }
        result
    })
    .await
}

#[tauri::command]
async fn initialize_app_state(app: tauri::AppHandle, state_json: String) -> Result<(), String> {
    run_database_task(move || {
        with_database(&app, |connection| {
            let state = parse_json(&state_json)?;
            replace_app_state(connection, &state)?;
            #[cfg(target_os = "macos")]
            if let Err(error) = macos_widget::publish_snapshot(connection) {
                eprintln!("Could not refresh the macOS widget: {error}");
            }
            Ok(())
        })
    })
    .await
}

#[tauri::command]
async fn persist_operation(app: tauri::AppHandle, operation_json: String) -> Result<(), String> {
    run_database_task(move || {
        let database_path = app_database_path(&app)?;
        let recovery_key = database_recovery_key(&database_path)?;
        let mut connection = open_database_at(&database_path, &recovery_key)?;
        let operation = parse_json(&operation_json)?;
        persist_operation_to_database(&mut connection, &operation)?;
        finish_meaningful_database_write(&connection, &database_path, &recovery_key);
        Ok(())
    })
    .await
}

/// CI-only bulk fixture setup for the Android emulator profile. Production
/// builds reject the command, and the profile supplies only generated data.
#[tauri::command]
async fn persist_operations_for_android_ci(
    app: tauri::AppHandle,
    operations_json: String,
) -> Result<(), String> {
    if !cfg!(all(target_os = "android", debug_assertions)) {
        return Err("Android CI fixture setup is unavailable in this build.".to_string());
    }
    run_database_task(move || {
        let database_path = app_database_path(&app)?;
        let recovery_key = database_recovery_key(&database_path)?;
        let mut connection = open_database_at(&database_path, &recovery_key)?;
        let operations = parse_json(&operations_json)?;
        let operations = operations
            .as_array()
            .ok_or_else(|| "Android CI operations must be an array.".to_string())?;
        // Keep fixture preparation independent from ordinary local checkpoint
        // maintenance until the profile has uploaded its separate batches.
        set_metadata(&connection, SYNC_COMPACTION_COORDINATOR, "false")?;
        operations
            .iter()
            .try_for_each(|operation| persist_operation_to_database(&mut connection, operation))?;
        #[cfg(all(target_os = "android", debug_assertions))]
        {
            let operation_ids = operations
                .iter()
                .map(|operation| required_string(operation, "id").map(str::to_string))
                .collect::<Result<Vec<_>, _>>()?;
            let pairing_code = sync::read_pairing_code(&connection)
                .map_err(sync::Error::into_string)?
                .ok_or_else(|| "Android CI sync key is missing.".to_string())?;
            let key = sync::crypto::SyncKey::from_pairing_code(&pairing_code)
                .map_err(sync::Error::into_string)?;
            let operations =
                sync::ops_by_id(&connection, &operation_ids).map_err(sync::Error::into_string)?;
            sync::relay_client::stage_android_ci_outbox_batches(&connection, &key, &operations)
                .map_err(sync::Error::into_string)?;
        }
        Ok(())
    })
    .await
}

#[tauri::command]
async fn undo_last_operation(
    app: tauri::AppHandle,
    expected_operation_id: Option<String>,
) -> Result<Option<String>, String> {
    run_database_task(move || {
        let database_path = app_database_path(&app)?;
        let recovery_key = database_recovery_key(&database_path)?;
        let mut connection = open_database_at(&database_path, &recovery_key)?;
        let result = undo_last_operation_for_ui(&mut connection, expected_operation_id.as_deref())?;
        if result.is_some() {
            finish_meaningful_database_write(&connection, &database_path, &recovery_key);
        }
        Ok(result.map(|value| value.to_string()))
    })
    .await
}

#[tauri::command]
async fn redo_last_operation(
    app: tauri::AppHandle,
    expected_operation_id: Option<String>,
) -> Result<Option<String>, String> {
    run_database_task(move || {
        let database_path = app_database_path(&app)?;
        let recovery_key = database_recovery_key(&database_path)?;
        let mut connection = open_database_at(&database_path, &recovery_key)?;
        let result = redo_last_operation_for_ui(&mut connection, expected_operation_id.as_deref())?;
        if result.is_some() {
            finish_meaningful_database_write(&connection, &database_path, &recovery_key);
        }
        Ok(result.map(|value| value.to_string()))
    })
    .await
}

#[tauri::command]
async fn list_recovery_entries(app: tauri::AppHandle) -> Result<String, String> {
    run_database_task(move || {
        let connection = open_database(&app)?;
        list_recovery_entries_from_database(&connection).map(|value| value.to_string())
    })
    .await
}

#[tauri::command]
async fn list_metadata(app: tauri::AppHandle) -> Result<String, String> {
    run_database_task(move || {
        let connection = open_database(&app)?;
        list_metadata_from_database(&connection).map(|value| value.to_string())
    })
    .await
}

#[tauri::command]
async fn inspect_database(app: tauri::AppHandle) -> Result<String, String> {
    run_database_task(move || {
        let connection = open_database(&app)?;
        inspect_database_from_database(&connection).map(|value| value.to_string())
    })
    .await
}

#[tauri::command]
async fn compact_database(app: tauri::AppHandle) -> Result<DatabaseCompactionResult, String> {
    run_database_task(move || {
        let database_path = app_database_path(&app)?;
        let recovery_key = database_recovery_key(&database_path)?;
        maintain_database_at(&database_path, &recovery_key)
    })
    .await
}

#[tauri::command]
async fn get_database_maintenance_status(
    app: tauri::AppHandle,
) -> Result<DatabaseMaintenanceStatus, String> {
    run_database_task(move || {
        let connection = open_database(&app)?;
        database_maintenance_status_from_database(&connection, current_timestamp_ms())
    })
    .await
}

#[tauri::command]
async fn run_database_maintenance_if_needed(
    app: tauri::AppHandle,
) -> Result<Option<DatabaseCompactionResult>, String> {
    run_database_task(move || {
        let database_path = app_database_path(&app)?;
        let recovery_key = database_recovery_key(&database_path)?;
        let connection = open_database_at(&database_path, &recovery_key)?;
        let status =
            database_maintenance_status_from_database(&connection, current_timestamp_ms())?;
        drop(connection);
        if !status.due {
            return Ok(None);
        }

        maintain_database_at(&database_path, &recovery_key).map(Some)
    })
    .await
}

#[tauri::command]
async fn complete_database_maintenance_startup(app: tauri::AppHandle) -> Result<(), String> {
    run_database_task(move || {
        let database_path = app_database_path(&app)?;
        let connection = open_database(&app)?;
        complete_database_maintenance_startup_at(&connection, &database_path)
    })
    .await
}

#[tauri::command]
async fn restore_recovery_entry(
    app: tauri::AppHandle,
    history_id: String,
) -> Result<Option<String>, String> {
    run_database_task(move || {
        let database_path = app_database_path(&app)?;
        let recovery_key = database_recovery_key(&database_path)?;
        let mut connection = open_database_at(&database_path, &recovery_key)?;
        let state = restore_recovery_entry_in_database(&mut connection, &history_id)?;
        if state.is_some() {
            finish_meaningful_database_write(&connection, &database_path, &recovery_key);
        }
        Ok(state.map(|value| value.to_string()))
    })
    .await
}

#[tauri::command]
async fn get_recovery_key_status(app: tauri::AppHandle) -> Result<RecoveryKeyStatus, String> {
    run_startup_database_task(move || {
        let startup = take_startup_database_connection(&app, StartupDatabaseRead::RecoveryStatus)?;
        let result = recovery_key_status(
            &startup.connection,
            &startup.database_path,
            Some(startup.recovery_key.clone()),
        );
        if result.is_ok() {
            finish_startup_database_read(startup, StartupDatabaseRead::RecoveryStatus, None);
        }
        result
    })
    .await
}

#[tauri::command]
async fn confirm_recovery_key(app: tauri::AppHandle, recovery_key: String) -> Result<(), String> {
    run_database_task(move || {
        let database_path = app_database_path(&app)?;
        let recovery_key = zeroize::Zeroizing::new(recovery_key);
        let parsed = database_keys::RecoveryKey::parse(&recovery_key)
            .map_err(|_| "Re-enter the complete 256-bit recovery key.".to_string())?;
        let connection = open_database_at(&database_path, parsed.canonical())
            .map_err(|_| "That key does not unlock the live encrypted database.".to_string())?;
        if read_app_state_from_database(&connection)?.is_none() {
            return Err("The database opened but contains no Balance app state.".to_string());
        }
        confirm_recovery_key_in_database(&connection)
    })
    .await
}

#[tauri::command]
async fn rotate_database_recovery_key(
    app: tauri::AppHandle,
) -> Result<RecoveryKeyRotationResult, String> {
    #[cfg(target_os = "android")]
    {
        let _ = app;
        return Err("Recovery-key rotation is currently available on desktop only.".to_string());
    }

    #[cfg(not(target_os = "android"))]
    run_database_task(move || {
        let database_path = app_database_path(&app)?;
        if !database_path.exists() {
            return Err("The encrypted Balance database does not exist yet.".to_string());
        }

        let old_key = database_recovery_key(&database_path)?;
        let mut new_key = generate_recovery_key();
        while new_key == old_key {
            new_key = generate_recovery_key();
        }
        let archived_key_account = archived_recovery_key_account();
        let mut key_store = KeychainRecoveryKeyRotationStore;
        rotate_database_key_at(
            &database_path,
            &old_key,
            &new_key,
            &archived_key_account,
            &mut key_store,
        )?;

        let connection = open_database_at(&database_path, &new_key)?;
        let recovery_key_status = recovery_key_status(&connection, &database_path, Some(new_key))?;
        if recovery_key_status.confirmed || recovery_key_status.recovery_key.is_none() {
            return Err("The rotated recovery key was not prepared for confirmation.".to_string());
        }

        Ok(RecoveryKeyRotationResult {
            recovery_key_status,
            archived_key_account,
        })
    })
    .await
}

/// Re-wrap an existing Android database key after the OS Keystore alias became
/// unavailable. The candidate must first decrypt and verify the intact SQLCipher
/// database; a wrong value never touches the stored wrapped-key file.
#[tauri::command]
async fn recover_database_with_key(
    app: tauri::AppHandle,
    recovery_key: String,
) -> Result<(), String> {
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, recovery_key);
        return Err("Recovery-key rewrapping is only needed on Android.".to_string());
    }

    #[cfg(target_os = "android")]
    run_database_task(move || {
        let database_path = app_database_path(&app)?;
        if !database_path.exists() {
            return Err(
                "The encrypted Balance database is missing from this installation.".to_string(),
            );
        }
        let recovery_key = zeroize::Zeroizing::new(recovery_key);
        let recovery_key = database_keys::RecoveryKey::parse(&recovery_key)
            .map_err(|_| "Enter the complete 256-bit Balance recovery key.".to_string())?;
        let recovery_key = recovery_key.canonical().to_string();

        let connection = open_database_at(&database_path, &recovery_key)
            .map_err(|_| "That recovery key does not unlock this database.".to_string())?;
        if read_app_state_from_database(&connection)?.is_none() {
            return Err("The database opened but contains no Balance app state.".to_string());
        }
        drop(connection);

        let key_path = raw_recovery_key_path(&database_path);
        let backup_path = key_path.with_extension("enc.previous");
        if key_path.exists() {
            fs::copy(&key_path, &backup_path)
                .map_err(|error| format!("Could not preserve the previous wrapped key: {error}"))?;
        }
        write_wrapped_android_recovery_key(&key_path, &recovery_key)?;
        cache_android_recovery_key(recovery_key);
        Ok(())
    })
    .await
}

#[tauri::command]
async fn save_export_file(
    app: tauri::AppHandle,
    filename: String,
    content: String,
) -> Result<String, String> {
    run_database_task(move || {
        let filename = Path::new(&filename)
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .ok_or_else(|| "Invalid export filename".to_string())?;
        let connection = open_database(&app)?;
        let export_directory = configured_export_directory(&app, &connection)?;
        fs::create_dir_all(&export_directory).map_err(|error| error.to_string())?;

        let export_path = export_directory.join(filename);

        fs::write(&export_path, content).map_err(|error| error.to_string())?;
        Ok(export_path.display().to_string())
    })
    .await
}

#[derive(Serialize)]
struct BuildInfo {
    version: String,
    commit: String,
}

#[tauri::command]
fn build_info(app: tauri::AppHandle) -> BuildInfo {
    BuildInfo {
        version: app.package_info().version.to_string(),
        commit: env!("GIT_COMMIT").to_string(),
    }
}

#[derive(Deserialize)]
struct GitHubRelease {
    tag_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AvailableUpdate {
    version: String,
    url: String,
}

fn available_update(
    current_version: &semver::Version,
    release: GitHubRelease,
) -> Result<Option<AvailableUpdate>, String> {
    let version_text = release
        .tag_name
        .strip_prefix('v')
        .unwrap_or(&release.tag_name);
    let version = semver::Version::parse(version_text)
        .map_err(|error| format!("GitHub's latest release tag is not a valid version: {error}"))?;

    if version <= *current_version {
        return Ok(None);
    }

    Ok(Some(AvailableUpdate {
        version: version.to_string(),
        url: GITHUB_LATEST_RELEASE_URL.to_string(),
    }))
}

#[tauri::command]
fn exit_after_inactivity(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn get_macos_widget_settings() -> Result<MacosWidgetSettings, String> {
    #[cfg(target_os = "macos")]
    {
        Ok(MacosWidgetSettings {
            hide_content_after_close: macos_widget::hides_content_after_close(),
        })
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err("The macOS widget is only available on macOS".to_string())
    }
}

#[tauri::command]
fn set_macos_widget_hide_content_after_close(enabled: bool) -> Result<MacosWidgetSettings, String> {
    #[cfg(target_os = "macos")]
    {
        macos_widget::set_hides_content_after_close(enabled)?;
        Ok(MacosWidgetSettings {
            hide_content_after_close: macos_widget::hides_content_after_close(),
        })
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = enabled;
        Err("The macOS widget is only available on macOS".to_string())
    }
}

#[tauri::command]
async fn check_for_update(app: tauri::AppHandle) -> Result<Option<AvailableUpdate>, String> {
    if cfg!(debug_assertions) {
        return Ok(None);
    }

    let current_version = app.package_info().version.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(10))
            .user_agent(format!("Balance/{current_version}"))
            .build()
            .map_err(|error| error.to_string())?;
        let release = client
            .get(GITHUB_LATEST_RELEASE_API)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .send()
            .and_then(reqwest::blocking::Response::error_for_status)
            .map_err(|error| format!("Could not check GitHub Releases: {error}"))?
            .json::<GitHubRelease>()
            .map_err(|error| format!("Could not read GitHub's latest release: {error}"))?;

        available_update(&current_version, release)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn get_export_settings(app: tauri::AppHandle) -> Result<ExportSettings, String> {
    run_database_task(move || {
        let startup = take_startup_database_connection(&app, StartupDatabaseRead::ExportSettings)?;
        let result = export_settings(&app, &startup.connection);
        if result.is_ok() {
            finish_startup_database_read(startup, StartupDatabaseRead::ExportSettings, None);
        }
        result
    })
    .await
}

#[tauri::command]
async fn set_export_directory(
    app: tauri::AppHandle,
    directory: String,
) -> Result<ExportSettings, String> {
    run_database_task(move || {
        let connection = open_database(&app)?;
        let directory = validate_export_directory(&directory)?;
        set_metadata(
            &connection,
            EXPORT_DIRECTORY,
            directory.to_string_lossy().as_ref(),
        )?;
        export_settings(&app, &connection)
    })
    .await
}

#[tauri::command]
async fn reset_export_directory(app: tauri::AppHandle) -> Result<ExportSettings, String> {
    run_database_task(move || {
        let connection = open_database(&app)?;
        delete_metadata(&connection, EXPORT_DIRECTORY)?;
        export_settings(&app, &connection)
    })
    .await
}

#[tauri::command]
async fn reveal_path_in_file_manager(path: String) -> Result<(), String> {
    run_database_task(move || reveal_path(PathBuf::from(path))).await
}

#[tauri::command]
fn open_external_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let url = validate_external_url(&url)?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| error.to_string())
}

async fn run_database_task<T, F>(task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = database_access_guard()?;
        task()
    })
    .await
    .map_err(|error| error.to_string())?
}

struct ForegroundRelayDatabaseGate {
    guard: Option<MutexGuard<'static, ()>>,
}

impl ForegroundRelayDatabaseGate {
    fn acquire() -> Result<Self, String> {
        Ok(Self {
            guard: Some(database_access_guard()?),
        })
    }
}

impl sync::relay_client::NetworkDatabaseGate for ForegroundRelayDatabaseGate {
    fn without_database_lock<T>(
        &mut self,
        task: impl FnOnce() -> sync::Result<T>,
    ) -> sync::Result<T> {
        drop(self.guard.take());
        let result = task();
        self.guard = Some(database_access_guard().map_err(sync::Error::Codec)?);
        result
    }
}

/// Relay HTTP can spend its entire timeout waiting for an offline network.
/// Keep one database connection for the pass, but cooperatively release the
/// process mutex around transport-only work so saves and undo/redo stay local.
async fn run_foreground_relay_task<T, F>(task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&mut ForegroundRelayDatabaseGate) -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let mut gate = ForegroundRelayDatabaseGate::acquire()?;
        task(&mut gate)
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Android can start an overdue WorkManager relay pass before its activity.
/// That pass holds the ordinary database mutex across network I/O, but SQLite
/// itself still permits the launch path's read-only connection while the relay
/// is waiting. Let only the two startup-gating reads bypass a busy in-process
/// mutex so a slow or unreachable relay cannot strand the loading screen.
async fn run_startup_database_task<T, F>(task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        // Recovery status and state hydration begin from separate frontend
        // entry points. They may bypass a background relay owner on Android,
        // but must still remain ordered relative to each other so they can
        // safely hand off the cached startup connection.
        let _startup_guard = STARTUP_DATABASE_ACCESS_LOCK
            .lock()
            .map_err(|_| "Startup database access lock is poisoned".to_string())?;
        #[cfg(target_os = "android")]
        let _guard = optional_database_access_guard(&DATABASE_ACCESS_LOCK)?;
        #[cfg(not(target_os = "android"))]
        let _guard = Some(database_access_guard()?);
        task()
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(any(test, target_os = "android"))]
fn optional_database_access_guard(lock: &Mutex<()>) -> Result<Option<MutexGuard<'_, ()>>, String> {
    match lock.try_lock() {
        Ok(guard) => Ok(Some(guard)),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Poisoned(_)) => Err("Database access lock is poisoned".to_string()),
    }
}

fn database_access_guard() -> Result<MutexGuard<'static, ()>, String> {
    DATABASE_ACCESS_LOCK
        .lock()
        .map_err(|_| "Database access lock is poisoned".to_string())
}

fn apply_raw_database_key(connection: &Connection, recovery_key: &str) -> Result<(), String> {
    let parsed = database_keys::RecoveryKey::parse(recovery_key)?;
    let raw_key = parsed.raw_sqlcipher_key()?;
    connection
        .pragma_update(None, "key", raw_key.as_str())
        .map_err(|error| error.to_string())
}

fn copy_database_snapshot(
    source: &Connection,
    destination_path: &Path,
    recovery_key: &str,
) -> Result<(), String> {
    if destination_path.exists() {
        fs::remove_file(destination_path).map_err(|error| {
            format!(
                "Could not remove stale compaction file {}: {error}",
                destination_path.display()
            )
        })?;
    }

    let mut destination = Connection::open(destination_path).map_err(|error| error.to_string())?;
    apply_raw_database_key(&destination, recovery_key)?;
    destination
        .query_row("pragma cipher_version", [], |row| row.get::<_, String>(0))
        .map_err(|error| format!("SQLCipher is not available for compaction: {error}"))?;

    let backup = Backup::new(source, &mut destination).map_err(|error| error.to_string())?;
    backup
        .run_to_completion(256, Duration::from_millis(10), None)
        .map_err(|error| error.to_string())?;
    drop(backup);
    set_metadata(
        &destination,
        DATABASE_KEY_FORMAT,
        database_keys::RAW_KEY_FORMAT,
    )?;
    drop(destination);
    Ok(())
}

fn hash_database_field(hasher: &mut Sha256, bytes: &[u8]) {
    hasher.update((bytes.len() as u64).to_le_bytes());
    hasher.update(bytes);
}

fn quoted_sql_identifier(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

/// Hash every schema object and every value in every application table. The
/// physical SQLCipher pages necessarily change when the key changes, so this
/// logical digest is the integrity boundary used to prove a rotated copy still
/// contains all metadata, sync state, undo history, and user data.
fn database_logical_digest(connection: &Connection) -> Result<[u8; 32], String> {
    let schema = connection
        .prepare(
            "select type, name, tbl_name, coalesce(sql, '')
             from sqlite_schema
             where name not like 'sqlite_%'
             order by type, name, tbl_name, sql",
        )
        .and_then(|mut statement| {
            statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|error| error.to_string())?;

    let mut hasher = Sha256::new();
    for (object_type, name, table_name, sql) in &schema {
        hash_database_field(&mut hasher, object_type.as_bytes());
        hash_database_field(&mut hasher, name.as_bytes());
        hash_database_field(&mut hasher, table_name.as_bytes());
        hash_database_field(&mut hasher, sql.as_bytes());
    }

    for (_, table_name, _, _) in schema.iter().filter(|row| row.0 == "table") {
        let columns = connection
            .prepare("select name from pragma_table_info(?1) order by cid")
            .and_then(|mut statement| {
                statement
                    .query_map(params![table_name], |row| row.get::<_, String>(0))?
                    .collect::<Result<Vec<_>, _>>()
            })
            .map_err(|error| error.to_string())?;
        if columns.is_empty() {
            continue;
        }

        hash_database_field(&mut hasher, table_name.as_bytes());
        for column in &columns {
            hash_database_field(&mut hasher, column.as_bytes());
        }
        let order_by = columns
            .iter()
            .map(|column| quoted_sql_identifier(column))
            .collect::<Vec<_>>()
            .join(", ");
        let query = format!(
            "select * from {} order by {order_by}",
            quoted_sql_identifier(table_name)
        );
        let mut statement = connection
            .prepare(&query)
            .map_err(|error| error.to_string())?;
        let column_count = statement.column_count();
        let mut rows = statement.query([]).map_err(|error| error.to_string())?;
        while let Some(row) = rows.next().map_err(|error| error.to_string())? {
            hasher.update([0xff]);
            for index in 0..column_count {
                use rusqlite::types::ValueRef;
                match row.get_ref(index).map_err(|error| error.to_string())? {
                    ValueRef::Null => hasher.update([0]),
                    ValueRef::Integer(value) => {
                        hasher.update([1]);
                        hasher.update(value.to_le_bytes());
                    }
                    ValueRef::Real(value) => {
                        hasher.update([2]);
                        hasher.update(value.to_bits().to_le_bytes());
                    }
                    ValueRef::Text(value) => {
                        hasher.update([3]);
                        hash_database_field(&mut hasher, value);
                    }
                    ValueRef::Blob(value) => {
                        hasher.update([4]);
                        hash_database_field(&mut hasher, value);
                    }
                }
            }
        }
    }

    Ok(hasher.finalize().into())
}

fn database_key_matches(database_path: &Path, recovery_key: &str) -> bool {
    database_path.exists() && open_database_at(database_path, recovery_key).is_ok()
}

fn key_rotation_paths(database_path: &Path) -> Result<(PathBuf, PathBuf), String> {
    let parent = database_path
        .parent()
        .ok_or_else(|| "Could not resolve database directory".to_string())?;
    Ok((
        parent.join(".balance-key-rotation.sqlite3"),
        parent.join(".balance-key-rotation-original.sqlite3"),
    ))
}

fn sync_file(path: &Path) -> Result<(), String> {
    fs::OpenOptions::new()
        .read(true)
        .open(path)
        .and_then(|file| file.sync_all())
        .map_err(|error| format!("Could not make {} durable: {error}", path.display()))
}

#[cfg(unix)]
fn sync_parent_directory(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Could not resolve database directory".to_string())?;
    fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| format!("Could not make {} durable: {error}", parent.display()))
}

#[cfg(not(unix))]
fn sync_parent_directory(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn install_rotated_database(working_path: &Path, database_path: &Path) -> Result<(), String> {
    // POSIX rename replaces the destination atomically, so there is never a
    // moment when the live database path is absent.
    fs::rename(working_path, database_path)
        .map_err(|error| format!("Could not install rotated database: {error}"))?;
    sync_parent_directory(database_path)
}

#[cfg(not(unix))]
fn install_rotated_database(working_path: &Path, database_path: &Path) -> Result<(), String> {
    fs::remove_file(database_path)
        .map_err(|error| format!("Could not stage database for key rotation: {error}"))?;
    fs::rename(working_path, database_path)
        .map_err(|error| format!("Could not install rotated database: {error}"))?;
    sync_parent_directory(database_path)
}

fn restore_database_after_failed_rotation(
    rollback_path: &Path,
    database_path: &Path,
) -> Result<(), String> {
    #[cfg(not(unix))]
    if database_path.exists() {
        fs::remove_file(database_path)
            .map_err(|error| format!("Could not remove rejected rotated database: {error}"))?;
    }
    fs::rename(rollback_path, database_path)
        .map_err(|error| format!("Could not restore the original encrypted database: {error}"))?;
    sync_parent_directory(database_path)
}

trait RecoveryKeyRotationStore {
    fn stage(&mut self, old_key: &str, new_key: &str, archive_account: &str) -> Result<(), String>;
    fn commit(&mut self, new_key: &str) -> Result<(), String>;
    fn finish(&mut self) -> Result<(), String>;
    fn abort(&mut self, old_key: &str, archive_account: &str) -> Result<(), String>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum KeyRotationCheckpoint {
    CandidateCopied,
    CredentialsStaged,
    DatabaseInstalled,
}

fn rotate_database_key_at(
    database_path: &Path,
    old_key: &str,
    new_key: &str,
    archive_account: &str,
    key_store: &mut impl RecoveryKeyRotationStore,
) -> Result<(), String> {
    rotate_database_key_at_with_checkpoint(
        database_path,
        old_key,
        new_key,
        archive_account,
        key_store,
        |_, _| Ok(()),
    )
}

fn rotate_database_key_at_with_checkpoint(
    database_path: &Path,
    old_key: &str,
    new_key: &str,
    archive_account: &str,
    key_store: &mut impl RecoveryKeyRotationStore,
    mut checkpoint: impl FnMut(KeyRotationCheckpoint, &Path) -> Result<(), String>,
) -> Result<(), String> {
    if old_key == new_key {
        return Err("The replacement database key must be different.".to_string());
    }
    let (working_path, rollback_path) = key_rotation_paths(database_path)?;
    if working_path.exists() || rollback_path.exists() {
        return Err(
            "An interrupted database-key rotation must be recovered before starting another."
                .to_string(),
        );
    }

    let mut staged = false;
    let mut installed = false;
    let result = (|| {
        let source = open_database_at(database_path, old_key)?;
        copy_database_snapshot(&source, &working_path, new_key)?;
        checkpoint(KeyRotationCheckpoint::CandidateCopied, &working_path)?;

        source
            .execute_batch("begin immediate")
            .map_err(|error| format!("Could not lock database for key rotation: {error}"))?;
        let expected_state = read_app_state_from_database(&source)?
            .ok_or_else(|| "Database contains no app state to rotate".to_string())?;
        let expected_digest = database_logical_digest(&source)?;

        let candidate = open_database_at(&working_path, new_key)?;
        verify_database_state(&candidate, &expected_state)?;
        if database_logical_digest(&candidate)? != expected_digest {
            return Err("Rotated database copy changed stored data or schema.".to_string());
        }
        set_metadata(&candidate, RECOVERY_KEY_CONFIRMED, "false")?;
        let installed_digest = database_logical_digest(&candidate)?;
        drop(candidate);
        sync_file(&working_path)?;

        source
            .execute_batch("rollback")
            .map_err(|error| format!("Could not release database rotation lock: {error}"))?;
        drop(source);

        key_store.stage(old_key, new_key, archive_account)?;
        staged = true;
        checkpoint(KeyRotationCheckpoint::CredentialsStaged, &working_path)?;

        fs::copy(database_path, &rollback_path).map_err(|error| {
            format!("Could not preserve the original encrypted database for rollback: {error}")
        })?;
        sync_file(&rollback_path)?;
        install_rotated_database(&working_path, database_path)?;
        installed = true;
        checkpoint(KeyRotationCheckpoint::DatabaseInstalled, database_path)?;

        let installed_connection = open_database_at(database_path, new_key)?;
        verify_database_state(&installed_connection, &expected_state)?;
        if database_logical_digest(&installed_connection)? != installed_digest {
            return Err("Installed rotated database changed stored data or schema.".to_string());
        }
        drop(installed_connection);
        if database_key_matches(database_path, old_key) {
            return Err("The previous key still unlocks the rotated database.".to_string());
        }

        key_store.commit(new_key)?;
        if let Err(error) = key_store.finish() {
            eprintln!(
                "Rotated key is active, but its pending credential could not be removed: {error}"
            );
        }
        if rollback_path.exists() {
            fs::remove_file(&rollback_path).map_err(|error| {
                format!("Database key rotated, but rollback cleanup failed: {error}")
            })?;
        }
        Ok(())
    })();

    if let Err(error) = result {
        if installed && rollback_path.exists() {
            if let Err(restore_error) =
                restore_database_after_failed_rotation(&rollback_path, database_path)
            {
                return Err(format!(
                    "{error} The original database remains at {} because automatic restoration failed: {restore_error}",
                    rollback_path.display()
                ));
            }
        }
        if staged {
            if let Err(key_error) = key_store.abort(old_key, archive_account) {
                return Err(format!(
                    "{error} The original database was restored, but credential rollback failed: {key_error}"
                ));
            }
        }
        if working_path.exists() {
            let _ = fs::remove_file(&working_path);
        }
        if rollback_path.exists() {
            let _ = fs::remove_file(&rollback_path);
        }
        return Err(error);
    }

    Ok(())
}

fn finish_meaningful_database_write(
    connection: &Connection,
    database_path: &Path,
    recovery_key: &str,
) {
    if metadata_value(connection, SYNC_LOG_DIRTY_SINCE_MS)
        .ok()
        .flatten()
        .is_none()
    {
        let _ = set_metadata(
            connection,
            SYNC_LOG_DIRTY_SINCE_MS,
            &current_timestamp_ms().to_string(),
        );
    }
    // The state change is already durable. Housekeeping is retried on the next
    // write or foreground sync and must not cause the UI to replay the change.
    let _ = maybe_checkpoint_operation_log(connection);
    if let Err(error) = create_daily_database_backup_if_due(
        connection,
        database_path,
        recovery_key,
        current_timestamp_ms(),
    ) {
        eprintln!("Daily database backup failed; it will be retried: {error}");
    }
    #[cfg(target_os = "macos")]
    if let Err(error) = macos_widget::publish_snapshot(connection) {
        eprintln!("Could not refresh the macOS widget: {error}");
    }
}

fn create_daily_database_backup_if_due(
    source: &Connection,
    database_path: &Path,
    recovery_key: &str,
    now_ms: i64,
) -> Result<Option<PathBuf>, String> {
    const DAY_MS: i64 = 24 * 60 * 60 * 1_000;
    let day = now_ms.div_euclid(DAY_MS);
    let day_string = day.to_string();
    if metadata_value(source, DATABASE_DAILY_BACKUP_LAST_DAY)?.as_deref()
        == Some(day_string.as_str())
    {
        if let Some(path) = metadata_value(source, DATABASE_DAILY_BACKUP_LATEST)? {
            let path = PathBuf::from(path);
            if path.exists() {
                return Ok(Some(path));
            }
        }
    }

    let expected_state = read_app_state_from_database(source)?;
    if expected_state.is_none() {
        return Ok(None);
    }
    let expected_state = expected_state.expect("checked above");
    let expected_operation_count: i64 = source
        .query_row("select count(*) from operations", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    let expected_history_count: i64 = source
        .query_row("select count(*) from history_entries", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    let backup_dir = database_path
        .parent()
        .ok_or_else(|| "Could not resolve database directory".to_string())?
        .join("backups");
    fs::create_dir_all(&backup_dir).map_err(|error| error.to_string())?;
    let final_path = backup_dir.join(format!("balance-daily-{day}-{now_ms}.sqlite3"));
    let temporary_path = backup_dir.join(format!(".balance-daily-{day}-{now_ms}.tmp.sqlite3"));

    let result = (|| {
        copy_database_snapshot(source, &temporary_path, recovery_key)?;
        let backup = open_database_at(&temporary_path, recovery_key)?;
        verify_database_state(&backup, &expected_state)?;
        let operation_count: i64 = backup
            .query_row("select count(*) from operations", [], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        let history_count: i64 = backup
            .query_row("select count(*) from history_entries", [], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        if operation_count != expected_operation_count || history_count != expected_history_count {
            return Err("Daily backup changed operation or recovery history".to_string());
        }
        drop(backup);
        fs::rename(&temporary_path, &final_path).map_err(|error| error.to_string())?;
        set_metadata(source, DATABASE_DAILY_BACKUP_LAST_DAY, &day_string)?;
        set_metadata(
            source,
            DATABASE_DAILY_BACKUP_LATEST,
            &final_path.display().to_string(),
        )?;
        // Keep the old diagnostics field useful while backups transition away
        // from physical compaction.
        set_metadata(
            source,
            DATABASE_MAINTENANCE_LATEST_BACKUP,
            &final_path.display().to_string(),
        )?;

        let mut daily_paths = fs::read_dir(&backup_dir)
            .map_err(|error| error.to_string())?
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| {
                        name.starts_with("balance-daily-") && name.ends_with(".sqlite3")
                    })
            })
            .collect::<Vec<_>>();
        daily_paths.sort();
        let remove_count = daily_paths
            .len()
            .saturating_sub(DATABASE_DAILY_BACKUP_RETENTION);
        for path in daily_paths.into_iter().take(remove_count) {
            if path != final_path {
                fs::remove_file(path).map_err(|error| error.to_string())?;
            }
        }
        Ok(Some(final_path.clone()))
    })();
    if result.is_err() && temporary_path.exists() {
        let _ = fs::remove_file(&temporary_path);
    }
    result
}

fn verify_database_state(connection: &Connection, expected_state: &Value) -> Result<(), String> {
    let integrity_rows = connection
        .prepare("pragma integrity_check")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|error| error.to_string())?;
    if integrity_rows.as_slice() != ["ok"] {
        return Err(format!(
            "Database failed integrity check: {}",
            integrity_rows.join("; ")
        ));
    }

    let actual_state = read_app_state_from_database(connection)?
        .ok_or_else(|| "Compacted database contains no app state".to_string())?;
    if actual_state != *expected_state {
        return Err("Database state differs from the expected state".to_string());
    }
    Ok(())
}

fn database_checkpoint_coordinator(connection: &Connection) -> Result<bool, String> {
    if !sync::is_sync_enabled(connection).map_err(sync::Error::into_string)? {
        return Ok(true);
    }

    if let Some(value) = metadata_value(connection, SYNC_COMPACTION_COORDINATOR)? {
        return match value.as_str() {
            "true" => Ok(true),
            "false" => Ok(false),
            _ => Err("Invalid sync compaction coordinator metadata".to_string()),
        };
    }

    // Older synced databases predate the explicit role flag. The device that
    // authored the existing full-state baseline is the original sync primary;
    // joining devices retain their own device_id, so this inference is local
    // and deterministic. Persist it before any future checkpoint replaces the
    // baseline author.
    let local_device_id = metadata_value(connection, "device_id")?.unwrap_or_default();
    let baseline_device_id = connection
        .query_row(
            "select device_id
             from operations
             where type = 'replace_full_state'
             order by timestamp, device_id, sequence, id
             limit 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let coordinator = baseline_device_id.as_deref() == Some(local_device_id.as_str());
    set_metadata(
        connection,
        SYNC_COMPACTION_COORDINATOR,
        if coordinator { "true" } else { "false" },
    )?;
    Ok(coordinator)
}

fn database_maintenance_status_from_database(
    connection: &Connection,
    now_ms: i64,
) -> Result<DatabaseMaintenanceStatus, String> {
    let last_completed_at = metadata_value(connection, DATABASE_MAINTENANCE_LAST_AT)?;
    let page_count = pragma_u64(connection, "page_count")?;
    let freelist_count = pragma_u64(connection, "freelist_count")?;
    let page_size = pragma_u64(connection, "page_size")?;
    let database_bytes = page_count.saturating_mul(page_size);
    let reclaimable_bytes = freelist_count.saturating_mul(page_size);
    let reclaimable_percent = if page_count == 0 {
        0
    } else {
        freelist_count.saturating_mul(100) / page_count
    };
    let due = reclaimable_bytes >= DATABASE_RECLAIM_MIN_BYTES
        && reclaimable_percent >= DATABASE_RECLAIM_MIN_PERCENT;
    let (operation_count, operation_bytes) = operation_log_stats(connection)?;
    let dirty_since = metadata_value(connection, SYNC_LOG_DIRTY_SINCE_MS)?
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(now_ms);
    let checkpoint_recommended = database_checkpoint_coordinator(connection)?
        && (operation_count >= SYNC_CHECKPOINT_OPERATION_LIMIT
            || operation_bytes >= SYNC_CHECKPOINT_PAYLOAD_BYTES
            || (operation_count > 0
                && now_ms.saturating_sub(dirty_since) >= SYNC_CHECKPOINT_MAX_AGE_MS));

    Ok(DatabaseMaintenanceStatus {
        due,
        last_completed_at,
        checkpoint_coordinator: database_checkpoint_coordinator(connection)?,
        database_bytes,
        reclaimable_bytes,
        reclaimable_percent,
        operation_count,
        operation_bytes,
        checkpoint_recommended,
    })
}

fn pragma_u64(connection: &Connection, pragma: &str) -> Result<u64, String> {
    let value: rusqlite::types::Value = connection
        .query_row(&format!("pragma {pragma}"), [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    match value {
        rusqlite::types::Value::Integer(value) => {
            u64::try_from(value).map_err(|error| error.to_string())
        }
        rusqlite::types::Value::Real(value) if value >= 0.0 => Ok(value as u64),
        rusqlite::types::Value::Text(value) => {
            value.parse::<u64>().map_err(|error| error.to_string())
        }
        other => Err(format!("Unexpected value for pragma {pragma}: {other:?}")),
    }
}

fn managed_database_backup_path(database_path: &Path, candidate: &str) -> Option<PathBuf> {
    let backup_path = PathBuf::from(candidate);
    let expected_parent = database_path.parent()?.join("backups");
    let filename = backup_path.file_name()?.to_str()?;
    (backup_path.parent() == Some(expected_parent.as_path())
        && (filename.starts_with("balance-pre-compact-")
            || filename.starts_with("balance-post-compact-")
            || filename.starts_with("balance-daily-"))
        && filename.ends_with(".sqlite3"))
    .then_some(backup_path)
}

fn complete_database_maintenance_startup_at(
    connection: &Connection,
    database_path: &Path,
) -> Result<(), String> {
    let previous = metadata_value(connection, DATABASE_MAINTENANCE_PREVIOUS_BACKUP)?;
    let latest = metadata_value(connection, DATABASE_MAINTENANCE_LATEST_BACKUP)?;
    if let Some(previous) = previous {
        let previous_path = managed_database_backup_path(database_path, &previous)
            .ok_or_else(|| "Refusing to remove an invalid database backup path".to_string())?;
        let latest_path = latest
            .as_deref()
            .map(|path| {
                managed_database_backup_path(database_path, path).ok_or_else(|| {
                    "Refusing to trust an invalid latest database backup path".to_string()
                })
            })
            .transpose()?;

        if latest.as_deref() != Some(previous.as_str())
            && latest_path.as_ref().is_some_and(|path| path.exists())
        {
            if previous_path.exists() {
                fs::remove_file(&previous_path).map_err(|error| {
                    format!(
                        "Could not remove superseded database backup {}: {error}",
                        previous_path.display()
                    )
                })?;
            }
        } else if previous_path.exists() {
            // If the newest backup was manually removed or never landed, retain
            // and promote the older known-good backup instead of deleting the
            // last recovery copy.
            set_metadata(connection, DATABASE_MAINTENANCE_LATEST_BACKUP, &previous)?;
        } else if let Some(path) = latest_path.filter(|path| path.exists()) {
            set_metadata(
                connection,
                DATABASE_MAINTENANCE_LATEST_BACKUP,
                &path.display().to_string(),
            )?;
        } else {
            delete_metadata(connection, DATABASE_MAINTENANCE_LATEST_BACKUP)?;
        }
        delete_metadata(connection, DATABASE_MAINTENANCE_PREVIOUS_BACKUP)?;
    }
    Ok(())
}

fn compaction_paths(database_path: &Path) -> Result<(PathBuf, PathBuf), String> {
    let parent = database_path
        .parent()
        .ok_or_else(|| "Could not resolve database directory".to_string())?;
    let mut random = [0_u8; 4];
    OsRng.fill_bytes(&mut random);
    let nonce = format!(
        "{}-{}-{}",
        std::process::id(),
        current_timestamp_ms(),
        random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    );
    let working_path = parent.join(format!(".balance-compacting-{nonce}.sqlite3"));
    let rollback_path = parent.join(format!(".balance-original-{nonce}.sqlite3"));
    Ok((working_path, rollback_path))
}

#[cfg(test)]
fn compact_database_at(
    database_path: &Path,
    recovery_key: &str,
) -> Result<DatabaseCompactionResult, String> {
    maintain_database_at(database_path, recovery_key)
}

#[cfg(test)]
fn vacuum_database_at(
    database_path: &Path,
    recovery_key: &str,
) -> Result<DatabaseCompactionResult, String> {
    maintain_database_at(database_path, recovery_key)
}

fn maintain_database_at(
    database_path: &Path,
    recovery_key: &str,
) -> Result<DatabaseCompactionResult, String> {
    let before_bytes = fs::metadata(database_path)
        .map_err(|error| error.to_string())?
        .len();
    let (working_path, rollback_path) = compaction_paths(database_path)?;

    let result = (|| {
        let source = open_database_at(database_path, recovery_key)?;
        let expected_operation_count: i64 = source
            .query_row("select count(*) from operations", [], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        let expected_history_count: i64 = source
            .query_row("select count(*) from history_entries", [], |row| row.get(0))
            .map_err(|error| error.to_string())?;

        copy_database_snapshot(&source, &working_path, recovery_key)?;
        source
            .execute_batch("begin immediate")
            .map_err(|error| format!("Could not lock database for compaction: {error}"))?;
        let expected_state = read_app_state_from_database(&source)?
            .ok_or_else(|| "Database contains no app state to compact".to_string())?;

        let working = open_database_at(&working_path, recovery_key)?;
        let copied_state = read_app_state_from_database(&working)?
            .ok_or_else(|| "Compaction copy contains no app state".to_string())?;
        if copied_state != expected_state {
            return Err(
                "Database changed while its compaction copy was being made; try again".to_string(),
            );
        }
        drop(working);

        let compacted = open_database_at(&working_path, recovery_key)?;
        set_metadata(
            &compacted,
            DATABASE_MAINTENANCE_LAST_AT,
            &current_timestamp(),
        )?;
        compacted
            .execute_batch("vacuum")
            .map_err(|error| format!("Could not vacuum compacted database: {error}"))?;
        verify_database_state(&compacted, &expected_state)?;
        let operation_count: i64 = compacted
            .query_row("select count(*) from operations", [], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        let history_count: i64 = compacted
            .query_row("select count(*) from history_entries", [], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        if operation_count != expected_operation_count || history_count != expected_history_count {
            return Err(format!(
                "Vacuumed database changed logical history: {operation_count} operations, {history_count} history entries"
            ));
        }
        drop(compacted);

        // Re-read while the source write lock is still held. This catches any
        // accidental source-state drift before replacing the live file.
        let locked_state = read_app_state_from_database(&source)?
            .ok_or_else(|| "Live database lost its app state during compaction".to_string())?;
        if locked_state != expected_state {
            return Err("Live database changed during compaction".to_string());
        }
        source
            .execute_batch("rollback")
            .map_err(|error| format!("Could not release compaction lock: {error}"))?;
        drop(source);

        fs::rename(database_path, &rollback_path).map_err(|error| {
            format!(
                "Could not stage original database for rollback at {}: {error}",
                rollback_path.display()
            )
        })?;
        if let Err(error) = fs::rename(&working_path, database_path) {
            let restore = fs::rename(&rollback_path, database_path);
            return Err(match restore {
                Ok(()) => format!(
                    "Could not install compacted database; original was restored: {error}"
                ),
                Err(restore_error) => format!(
                    "Could not install compacted database ({error}) or restore original ({restore_error}). Original remains at {}",
                    rollback_path.display()
                ),
            });
        }

        let installed_check = (|| {
            let installed = open_database_at(database_path, recovery_key)?;
            verify_database_state(&installed, &expected_state)?;
            let operation_count: i64 = installed
                .query_row("select count(*) from operations", [], |row| row.get(0))
                .map_err(|error| error.to_string())?;
            let history_count: i64 = installed
                .query_row("select count(*) from history_entries", [], |row| row.get(0))
                .map_err(|error| error.to_string())?;
            if operation_count != expected_operation_count
                || history_count != expected_history_count
            {
                return Err(format!(
                    "Installed database has unexpected log counts: {operation_count} operations, {history_count} history entries"
                ));
            }
            metadata_value(&installed, DATABASE_MAINTENANCE_LATEST_BACKUP)
        })();
        let latest_backup = match installed_check {
            Ok(path) => path,
            Err(error) => {
                let rejected_path = working_path.with_extension("rejected.sqlite3");
                fs::rename(database_path, &rejected_path).map_err(|reject_error| {
                format!(
                    "{error}; optimized database could not be set aside ({reject_error}). Original remains at {}",
                    rollback_path.display()
                )
            })?;
                fs::rename(&rollback_path, database_path).map_err(|restore_error| {
                    format!(
                        "{error}; original database could not be restored from {}: {restore_error}",
                        rollback_path.display()
                    )
                })?;
                return Err(format!("{error}; original database was restored"));
            }
        };
        let _ = fs::remove_file(&rollback_path);

        let after_bytes = fs::metadata(database_path)
            .map_err(|error| error.to_string())?
            .len();
        Ok(DatabaseCompactionResult {
            before_bytes,
            after_bytes,
            reclaimed_bytes: before_bytes.saturating_sub(after_bytes),
            operations_removed: 0,
            history_entries_removed: 0,
            backup_path: latest_backup,
            checkpoint_created: false,
        })
    })();

    if result.is_err() && working_path.exists() {
        let _ = fs::remove_file(&working_path);
    }
    result
}

fn read_app_state_from_database(connection: &Connection) -> Result<Option<Value>, String> {
    read_app_state_from_database_with_progress(connection, |_, _| {})
}

fn read_app_state_from_database_with_progress(
    connection: &Connection,
    mut progress: impl FnMut(u8, &'static str),
) -> Result<Option<Value>, String> {
    progress(25, "Reading workspace settings");
    let device_id = match metadata_value(connection, "device_id")? {
        Some(value) => value,
        None => return Ok(None),
    };
    let local_sequence = metadata_value(connection, "local_sequence")?
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);
    let active_plan_date = metadata_value(connection, "active_plan_date")?.unwrap_or_default();
    let preferences = read_replicated_preferences(connection)?;

    progress(35, "Loading goals");
    let goal_data = read_goal_data(connection)?;

    progress(45, "Loading lists, metrics, and notes");
    let lists_metrics_data = read_lists_metrics_data(connection)?;

    progress(60, "Loading templates");
    let templates = read_templates(connection)?;

    progress(75, "Loading plans");
    let plans = read_plans(connection)?;

    progress(90, "Preparing workspace");

    Ok(Some(json!({
        "schemaVersion": 1,
        "deviceId": device_id,
        "localSequence": local_sequence,
        "historyRevision": 0,
        "activePlanDate": active_plan_date,
        "preferences": preferences,
        "templates": templates,
        "plans": plans,
        "listTemplates": lists_metrics_data["listTemplates"].clone(),
        "lists": lists_metrics_data["lists"].clone(),
        "metrics": lists_metrics_data["metrics"].clone(),
        "metricEntries": lists_metrics_data["metricEntries"].clone(),
        "notes": lists_metrics_data["notes"].clone(),
        "goals": goal_data["goals"].clone(),
        "goalCompletions": goal_data["goalCompletions"].clone(),
        "operations": [],
    })))
}

fn recovery_key_status(
    connection: &Connection,
    database_path: &Path,
    recovery_key: Option<String>,
) -> Result<RecoveryKeyStatus, String> {
    let confirmed = metadata_value(&connection, RECOVERY_KEY_CONFIRMED)?.as_deref() == Some("true");
    let recovery_key = if confirmed { None } else { recovery_key };

    Ok(RecoveryKeyStatus {
        confirmed,
        recovery_key,
        database_path: database_path.display().to_string(),
    })
}

fn confirm_recovery_key_in_database(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            "
        insert into metadata (key, value)
        values (?1, 'true')
        on conflict(key) do update set value = excluded.value
      ",
            params![RECOVERY_KEY_CONFIRMED],
        )
        .map_err(|error| error.to_string())?;

    Ok(())
}

fn open_database(app: &tauri::AppHandle) -> Result<Connection, String> {
    let database_path = app_database_path(app)?;
    let parent = database_path
        .parent()
        .ok_or_else(|| "Could not resolve app data directory".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let recovery_key = database_recovery_key(&database_path)?;
    let connection = open_database_at(&database_path, &recovery_key)?;
    // Only cache a key after SQLCipher has proved that it opens the live DB.
    // This keeps Android recovery usable if a wrapped key is stale or corrupt.
    #[cfg(target_os = "android")]
    cache_android_recovery_key(recovery_key);
    Ok(connection)
}

fn take_startup_database_connection(
    app: &tauri::AppHandle,
    read: StartupDatabaseRead,
) -> Result<StartupDatabaseConnection, String> {
    let database_path = app_database_path(app)?;
    let mut cached = STARTUP_DATABASE_CONNECTION
        .lock()
        .map_err(|_| "Startup database connection is poisoned".to_string())?;
    if let Some(startup) = cached.take() {
        let already_read = match read {
            StartupDatabaseRead::RecoveryStatus => startup.recovery_status_read,
            StartupDatabaseRead::AppState => startup.app_state_read,
            StartupDatabaseRead::ExportSettings => startup.export_settings_read,
            StartupDatabaseRead::SyncSettings => startup.sync_settings_read,
            StartupDatabaseRead::RelaySync => startup.relay_sync_finished,
        };
        if startup.database_path == database_path && !already_read {
            return Ok(startup);
        }
        *cached = Some(startup);
    }
    drop(cached);

    let parent = database_path
        .parent()
        .ok_or_else(|| "Could not resolve app data directory".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let recovery_key = database_recovery_key(&database_path)?;
    let connection = open_database_at(&database_path, &recovery_key)?;
    // Cache only after SQLCipher has proved this key opens the live DB.
    #[cfg(target_os = "android")]
    cache_android_recovery_key(recovery_key.clone());
    Ok(StartupDatabaseConnection {
        database_path,
        recovery_key,
        connection,
        recovery_status_read: false,
        app_state_read: false,
        export_settings_read: false,
        sync_settings_read: false,
        relay_sync_required: None,
        relay_sync_finished: false,
    })
}

fn finish_startup_database_read(
    mut startup: StartupDatabaseConnection,
    read: StartupDatabaseRead,
    relay_sync_required: Option<bool>,
) {
    match read {
        StartupDatabaseRead::RecoveryStatus => startup.recovery_status_read = true,
        StartupDatabaseRead::AppState => startup.app_state_read = true,
        StartupDatabaseRead::ExportSettings => startup.export_settings_read = true,
        StartupDatabaseRead::SyncSettings => {
            startup.sync_settings_read = true;
            startup.relay_sync_required = relay_sync_required;
        }
        StartupDatabaseRead::RelaySync => startup.relay_sync_finished = true,
    }
    let relay_finished =
        matches!(startup.relay_sync_required, Some(false)) || startup.relay_sync_finished;
    if startup.recovery_status_read
        && startup.app_state_read
        && startup.export_settings_read
        && startup.sync_settings_read
        && relay_finished
    {
        return;
    }
    if let Ok(mut cached) = STARTUP_DATABASE_CONNECTION.lock() {
        *cached = Some(startup);
    }
}

fn open_database_at(database_path: &Path, recovery_key: &str) -> Result<Connection, String> {
    let connection = Connection::open(database_path).map_err(|error| error.to_string())?;
    apply_raw_database_key(&connection, recovery_key)?;
    connection
        .query_row("pragma cipher_version", [], |row| row.get::<_, String>(0))
        .map_err(|error| format!("SQLCipher is not available: {error}"))?;

    // PRAGMA key is lazy. This encrypted-page read must happen before schema
    // initialization so a wrong key can never turn an existing database into
    // an apparently empty workspace.
    connection
        .query_row("select count(*) from sqlite_schema", [], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(|error| {
            format!("The recovery key did not unlock the encrypted database: {error}")
        })?;
    initialize_database(&connection)?;
    set_metadata(
        &connection,
        DATABASE_KEY_FORMAT,
        database_keys::RAW_KEY_FORMAT,
    )?;
    Ok(connection)
}

/// Create the canonical schema for a new database and ensure current tables
/// exist. This intentionally contains no historical ALTER/backfill routines.
/// Future schema changes need a separately named, fail-closed migration plus a
/// documented fleet-readiness condition for deleting that migration again.
fn initialize_database(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "
        pragma foreign_keys = on;

        create table if not exists metadata (
          key text primary key,
          value text not null
        );

        create table if not exists templates (
          id text primary key,
          name text not null,
          created_at text not null,
          updated_at text not null,
          position integer not null
        );

        create table if not exists template_items (
          id text primary key,
          template_id text not null references templates(id) on delete cascade,
          parent_id text references template_items(id) on delete cascade,
          start_minutes integer,
          end_minutes integer,
          time_hidden integer,
          position integer not null
        );

        create table if not exists template_options (
          id text primary key,
          item_id text not null references template_items(id) on delete cascade,
          text text not null,
          html text not null,
          probability real not null,
          position integer not null
        );

        create table if not exists plans (
          id text primary key,
          date text not null unique,
          title text not null,
          daily_reminder text not null default 'This shouldn''t be aspirational',
          generated_from_template_id text,
          created_at text not null
        );

        create table if not exists plan_items (
          id text primary key,
          plan_id text not null references plans(id) on delete cascade,
          parent_id text references plan_items(id) on delete cascade,
          position integer not null,
          text text not null,
          html text not null,
          done integer not null,
          start_minutes integer,
          end_minutes integer,
          time_hidden integer
        );

        create table if not exists operations (
          id text primary key,
          device_id text not null,
          sequence integer not null,
          type text not null,
          timestamp text not null,
          payload_json text not null
        );

        create table if not exists history_entries (
          id text primary key,
          operation_id text not null unique,
          device_id text not null,
          sequence integer not null,
          undo_operation_json text not null,
          redo_operation_json text not null,
          undone integer not null default 0,
          created_at_ms integer not null,
          updated_at_ms integer not null
        );

        create table if not exists state_entities (
          collection text not null,
          entity_key text not null,
          position integer not null,
          value_json text not null,
          primary key (collection, entity_key)
        );

        create table if not exists sync_frontiers (
          device_id text primary key,
          sequence integer not null
        );

        create index if not exists idx_template_items_parent on template_items(template_id, parent_id, position);
        create index if not exists idx_template_options_item on template_options(item_id, position);
        create index if not exists idx_plan_items_parent on plan_items(plan_id, parent_id, position);
        create index if not exists idx_operations_sequence on operations(sequence);
        create index if not exists idx_history_entries_undo on history_entries(undone, sequence, updated_at_ms);
        create index if not exists idx_state_entities_order on state_entities(collection, position, entity_key);
      ",
        )
        .map_err(|error| error.to_string())?;

    sync::relay_client::ensure_relay_tables(connection).map_err(sync::Error::into_string)?;

    Ok(())
}

fn metadata_value(connection: &Connection, key: &str) -> Result<Option<String>, String> {
    connection
        .query_row(
            "select value from metadata where key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn default_replicated_preferences() -> Value {
    json!({
        "themeId": "violet",
        "completionCelebrationId": "aurora-checkwave",
        "doneTintColor": "",
        "checkboxColor": "",
        "databaseLoadingMessages": [
            "Good things come to those who briefly wait.",
            "Pretend this is an intentional mindfulness exercise.",
            "Fun fact: this message has no fun fact."
        ]
    })
}

fn validate_replicated_preferences(value: &Value) -> Result<Value, String> {
    let mut preferences = value
        .as_object()
        .cloned()
        .ok_or_else(|| "Replicated preferences must be an object".to_string())?;

    let theme_id = required_string(value, "themeId")?;
    let completion_celebration_id = value
        .get("completionCelebrationId")
        .and_then(Value::as_str)
        .unwrap_or("aurora-checkwave");
    let done_tint_color = required_string(value, "doneTintColor")?;
    let checkbox_color = required_string(value, "checkboxColor")?;
    for (name, color) in [
        ("doneTintColor", done_tint_color),
        ("checkboxColor", checkbox_color),
    ] {
        if !color.is_empty()
            && !(color.len() == 7
                && color.starts_with('#')
                && color[1..].bytes().all(|byte| byte.is_ascii_hexdigit()))
        {
            return Err(format!("{name} must be empty or a six-digit hex color"));
        }
    }
    let messages = required_array(value, "databaseLoadingMessages")?;
    if !messages.iter().all(Value::is_string) {
        return Err("databaseLoadingMessages must contain only strings".to_string());
    }

    preferences.insert("themeId".into(), json!(theme_id));
    preferences.insert(
        "completionCelebrationId".into(),
        json!(completion_celebration_id),
    );
    preferences.insert("doneTintColor".into(), json!(done_tint_color));
    preferences.insert("checkboxColor".into(), json!(checkbox_color));
    preferences.insert("databaseLoadingMessages".into(), json!(messages));
    Ok(Value::Object(preferences))
}

fn replicated_preferences_from_state(state: &Value) -> Result<Value, String> {
    match state.get("preferences") {
        Some(preferences) => validate_replicated_preferences(preferences),
        None => Ok(default_replicated_preferences()),
    }
}

fn read_replicated_preferences(connection: &Connection) -> Result<Value, String> {
    let Some(raw) = metadata_value(connection, REPLICATED_PREFERENCES)? else {
        return Ok(default_replicated_preferences());
    };
    let preferences = serde_json::from_str::<Value>(&raw)
        .map_err(|error| format!("Could not parse replicated preferences: {error}"))?;
    validate_replicated_preferences(&preferences)
}

fn patch_replicated_preferences(connection: &Connection, patch: &Value) -> Result<(), String> {
    let patch = patch
        .as_object()
        .ok_or_else(|| "Replicated preference patch must be an object".to_string())?;
    let mut preferences = read_replicated_preferences(connection)?;
    let object = preferences
        .as_object_mut()
        .ok_or_else(|| "Replicated preferences must be an object".to_string())?;
    for (key, value) in patch {
        object.insert(key.clone(), value.clone());
    }
    let preferences = validate_replicated_preferences(&preferences)?;
    set_metadata(connection, REPLICATED_PREFERENCES, &preferences.to_string())
}
const LISTS_METRICS_KEYS: [&str; 5] = [
    "listTemplates",
    "lists",
    "metrics",
    "metricEntries",
    "notes",
];

fn entity_key(collection: &str, value: &Value, index: usize, occurrence: usize) -> String {
    if collection == "goalCompletions" {
        return format!(
            "{}\u{1f}{}\u{1f}{occurrence}",
            value
                .get("goalId")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            value
                .get("date")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        );
    }
    value
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("missing-id-{index}"))
}

fn replace_entity_collection(
    connection: &Connection,
    collection: &str,
    values: &[Value],
) -> Result<(), String> {
    connection
        .execute(
            "delete from state_entities where collection = ?1",
            params![collection],
        )
        .map_err(|error| error.to_string())?;
    let mut insert = connection
        .prepare(
            "insert into state_entities (collection, entity_key, position, value_json)
             values (?1, ?2, ?3, ?4)",
        )
        .map_err(|error| error.to_string())?;
    let mut occurrences = HashMap::<String, usize>::new();
    for (index, value) in values.iter().enumerate() {
        let occurrence = if collection == "goalCompletions" {
            let base = format!(
                "{}\u{1f}{}",
                value
                    .get("goalId")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                value
                    .get("date")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            );
            let occurrence = occurrences.entry(base).or_default();
            let current = *occurrence;
            *occurrence += 1;
            current
        } else {
            0
        };
        insert
            .execute(params![
                collection,
                entity_key(collection, value, index, occurrence),
                index as i64,
                value.to_string(),
            ])
            .map_err(|error| format!("Could not store {collection} entity {index}: {error}"))?;
    }
    Ok(())
}

fn read_entity_collection(connection: &Connection, collection: &str) -> Result<Value, String> {
    let mut statement = connection
        .prepare(
            "select value_json from state_entities
             where collection = ?1 order by position, entity_key",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![collection], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    let mut values = Vec::new();
    for row in rows {
        let raw = row.map_err(|error| error.to_string())?;
        values.push(
            serde_json::from_str(&raw)
                .map_err(|error| format!("Could not read {collection} entity: {error}"))?,
        );
    }
    Ok(Value::Array(values))
}

fn replace_state_entities_from_state(connection: &Connection, state: &Value) -> Result<(), String> {
    for collection in ENTITY_COLLECTIONS {
        let values = state
            .get(collection)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        replace_entity_collection(connection, collection, &values)?;
    }
    Ok(())
}

fn read_goal_data(connection: &Connection) -> Result<Value, String> {
    Ok(json!({
        "goals": read_entity_collection(connection, "goals")?,
        "goalCompletions": read_entity_collection(connection, "goalCompletions")?,
    }))
}

fn read_lists_metrics_data(connection: &Connection) -> Result<Value, String> {
    let mut result = serde_json::Map::new();
    for key in LISTS_METRICS_KEYS {
        result.insert(key.to_string(), read_entity_collection(connection, key)?);
    }
    Ok(Value::Object(result))
}

fn is_lists_metrics_operation(operation_type: &str) -> bool {
    // All Lists/Metrics/Notes operation types contain "list", "metric", or "note"; no existing
    // plan/template/goal operation type does.
    operation_type.contains("list")
        || operation_type.contains("metric")
        || operation_type.contains("note")
}

fn valid_entity_collection(collection: &str) -> bool {
    ENTITY_COLLECTIONS.contains(&collection)
}

fn apply_entity_changes(connection: &Connection, changes: &Value) -> Result<(), String> {
    if required_i64(changes, "version")? != 1 {
        return Err("Unsupported entity change version".to_string());
    }
    let mut upsert = connection
        .prepare(
            "insert into state_entities (collection, entity_key, position, value_json)
             values (?1, ?2, ?3, ?4)
             on conflict(collection, entity_key) do update set
               position = excluded.position,
               value_json = excluded.value_json",
        )
        .map_err(|error| error.to_string())?;
    for item in required_array(changes, "upserts")? {
        let collection = required_string(item, "collection")?;
        if !valid_entity_collection(collection) {
            return Err(format!("Unsupported entity collection: {collection}"));
        }
        upsert
            .execute(params![
                collection,
                required_string(item, "key")?,
                required_i64(item, "position")?,
                required_value(item, "value")?.to_string(),
            ])
            .map_err(|error| error.to_string())?;
    }
    drop(upsert);
    let mut delete = connection
        .prepare("delete from state_entities where collection = ?1 and entity_key = ?2")
        .map_err(|error| error.to_string())?;
    for item in required_array(changes, "deletes")? {
        let collection = required_string(item, "collection")?;
        if !valid_entity_collection(collection) {
            return Err(format!("Unsupported entity collection: {collection}"));
        }
        delete
            .execute(params![collection, required_string(item, "key")?])
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn export_settings(
    app: &tauri::AppHandle,
    connection: &Connection,
) -> Result<ExportSettings, String> {
    let default_export_directory = default_export_directory(app)?;
    let configured_export_directory =
        metadata_value(connection, EXPORT_DIRECTORY)?.filter(|directory| !directory.is_empty());
    let export_directory = configured_export_directory
        .as_deref()
        .map(PathBuf::from)
        .unwrap_or_else(|| default_export_directory.clone());

    Ok(ExportSettings {
        export_directory: export_directory.display().to_string(),
        default_export_directory: default_export_directory.display().to_string(),
        uses_default_export_directory: configured_export_directory.is_none(),
    })
}

fn configured_export_directory(
    app: &tauri::AppHandle,
    connection: &Connection,
) -> Result<PathBuf, String> {
    let default_export_directory = default_export_directory(app)?;
    let directory = metadata_value(connection, EXPORT_DIRECTORY)?
        .filter(|directory| !directory.is_empty())
        .map(PathBuf::from)
        .unwrap_or(default_export_directory);

    if directory.exists() && !directory.is_dir() {
        return Err(format!(
            "Export destination is not a folder: {}",
            directory.display()
        ));
    }

    Ok(directory)
}

fn default_export_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().download_dir().map_err(|error| error.to_string())
}

fn validate_export_directory(directory: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(directory);

    if !path.is_absolute() {
        return Err("Choose an absolute folder path for exports".to_string());
    }

    let metadata =
        fs::metadata(&path).map_err(|error| format!("Could not read export folder: {error}"))?;
    if !metadata.is_dir() {
        return Err("Export destination must be a folder".to_string());
    }

    Ok(path)
}

fn normalize_sync_relay_url(relay_url: &str) -> Result<String, String> {
    let relay_url = relay_url.trim();
    if relay_url.is_empty() {
        return Ok(String::new());
    }
    if relay_url.chars().any(char::is_whitespace) {
        return Err("Relay URL cannot contain whitespace".to_string());
    }

    let remainder = relay_url
        .strip_prefix("https://")
        .or_else(|| relay_url.strip_prefix("http://"))
        .ok_or_else(|| "Relay URL must start with http:// or https://".to_string())?;
    let remainder = remainder.trim_end_matches('/');
    if remainder.is_empty() {
        return Err("Relay URL must include a host".to_string());
    }

    let scheme = if relay_url.starts_with("https://") {
        "https://"
    } else {
        "http://"
    };
    Ok(format!("{scheme}{remainder}"))
}

fn reveal_path(path: PathBuf) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("Could not find saved export: {}", path.display()));
    }

    #[cfg(target_os = "macos")]
    let status = Command::new("open")
        .arg("-R")
        .arg(&path)
        .status()
        .map_err(|error| error.to_string())?;

    #[cfg(target_os = "windows")]
    let status = Command::new("explorer")
        .arg(format!("/select,{}", path.display()))
        .status()
        .map_err(|error| error.to_string())?;

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let status = {
        let target = if path.is_dir() {
            path
        } else {
            path.parent()
                .map(Path::to_path_buf)
                .ok_or_else(|| "Could not resolve export folder".to_string())?
        };

        Command::new("xdg-open")
            .arg(target)
            .status()
            .map_err(|error| error.to_string())?
    };

    if status.success() {
        Ok(())
    } else {
        Err("Could not open the saved export location".to_string())
    }
}

fn validate_external_url(url: &str) -> Result<&str, String> {
    let url = url.trim();
    let lower = url.to_ascii_lowercase();
    if (lower.starts_with("http://") || lower.starts_with("https://"))
        && !url.chars().any(char::is_control)
    {
        return Ok(url);
    }

    Err("Only http and https links can be opened".to_string())
}

fn replace_app_state(connection: &mut Connection, state: &Value) -> Result<(), String> {
    let tx = connection
        .transaction()
        .map_err(|error| error.to_string())?;

    replace_domain_state(&tx, state)?;
    tx.execute("delete from history_entries", [])
        .map_err(|error| error.to_string())?;
    tx.execute("delete from operations", [])
        .map_err(|error| error.to_string())?;

    set_metadata(&tx, "device_id", required_string(state, "deviceId")?)?;
    set_metadata(
        &tx,
        "local_sequence",
        &required_i64(state, "localSequence")?.to_string(),
    )?;
    set_metadata(
        &tx,
        "active_plan_date",
        required_string(state, "activePlanDate")?,
    )?;

    for operation in required_array(state, "operations")? {
        upsert_operation(&tx, operation)?;
    }

    tx.commit().map_err(|error| error.to_string())
}

fn replace_domain_state(connection: &Connection, state: &Value) -> Result<(), String> {
    connection
        .execute_batch(
            "
        delete from plan_items;
        delete from plans;
        delete from template_options;
        delete from template_items;
        delete from templates;
      ",
        )
        .map_err(|error| error.to_string())?;

    for (position, template) in required_array(state, "templates")?.iter().enumerate() {
        insert_template(connection, template, position as i64)?;
    }

    for plan in required_array(state, "plans")? {
        insert_plan(connection, plan)?;
    }

    set_metadata(
        connection,
        REPLICATED_PREFERENCES,
        &replicated_preferences_from_state(state)?.to_string(),
    )?;
    replace_state_entities_from_state(connection, state)?;

    if let Some(active_plan_date) = optional_string(state, "activePlanDate")? {
        set_metadata(connection, "active_plan_date", &active_plan_date)?;
    }

    Ok(())
}

fn persist_operation_to_database(
    connection: &mut Connection,
    operation: &Value,
) -> Result<(), String> {
    let tx = connection
        .transaction()
        .map_err(|error| error.to_string())?;

    let operation_id = required_string(operation, "id")?;
    let operation_type = required_string(operation, "type")?;
    let existing_history = history_entry_for_operation(&tx, operation_id)?;
    let undo_operation = if is_history_operation(operation_type) {
        None
    } else if let Some(existing) = existing_history.as_ref() {
        Some(existing.undo_operation.clone())
    } else {
        build_undo_operation(&tx, operation)?
    };

    if undo_operation.is_some() && existing_history.is_none() {
        tx.execute("delete from history_entries where undone != 0", [])
            .map_err(|error| error.to_string())?;
    }

    upsert_operation(&tx, operation)?;
    apply_operation(&tx, operation)?;
    set_metadata(&tx, "device_id", required_string(operation, "deviceId")?)?;
    set_metadata(
        &tx,
        "local_sequence",
        &required_i64(operation, "sequence")?.to_string(),
    )?;

    if let Some(undo_operation) = undo_operation {
        upsert_history_entry(&tx, operation, &undo_operation)?;
    }
    prune_history_entries(&tx, current_timestamp_ms())?;

    tx.commit().map_err(|error| error.to_string())?;
    if metadata_value(connection, SYNC_LOG_DIRTY_SINCE_MS)?.is_none() {
        set_metadata(
            connection,
            SYNC_LOG_DIRTY_SINCE_MS,
            &current_timestamp_ms().to_string(),
        )?;
    }
    // The user edit is already durable. Housekeeping must never turn that
    // successful write into a retry that could reinsert a covered operation.
    let _ = maybe_checkpoint_operation_log(connection);
    Ok(())
}

fn operation_log_stats(connection: &Connection) -> Result<(i64, i64), String> {
    connection
        .query_row(
            "select count(*), coalesce(sum(length(payload_json)), 0)
             from operations where type != 'replace_full_state'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| error.to_string())
}

fn maybe_checkpoint_operation_log(connection: &Connection) -> Result<bool, String> {
    if !database_checkpoint_coordinator(connection)? {
        return Ok(false);
    }
    let (operation_count, payload_bytes) = operation_log_stats(connection)?;
    if operation_count == 0 {
        delete_metadata(connection, SYNC_LOG_DIRTY_SINCE_MS)?;
        return Ok(false);
    }
    let now_ms = current_timestamp_ms();
    let dirty_since = metadata_value(connection, SYNC_LOG_DIRTY_SINCE_MS)?
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(now_ms);
    let due = operation_count >= SYNC_CHECKPOINT_OPERATION_LIMIT
        || payload_bytes >= SYNC_CHECKPOINT_PAYLOAD_BYTES
        || now_ms.saturating_sub(dirty_since) >= SYNC_CHECKPOINT_MAX_AGE_MS;
    if !due {
        return Ok(false);
    }

    sync::checkpoint_operation_log_preserving_history(connection)
        .map_err(sync::Error::into_string)?;
    sync::relay_client::prune_obsolete_relay_rows(connection).map_err(sync::Error::into_string)?;
    delete_metadata(connection, SYNC_LOG_DIRTY_SINCE_MS)?;
    Ok(true)
}

#[cfg(test)]
fn undo_last_operation_in_database(connection: &mut Connection) -> Result<Option<Value>, String> {
    let Some(_) = apply_latest_history_entry(connection, HistoryDirection::Undo)? else {
        return Ok(None);
    };
    read_app_state_from_database(connection)
}

#[cfg(test)]
fn redo_last_operation_in_database(connection: &mut Connection) -> Result<Option<Value>, String> {
    let Some(_) = apply_latest_history_entry(connection, HistoryDirection::Redo)? else {
        return Ok(None);
    };
    read_app_state_from_database(connection)
}

#[derive(Clone, Copy)]
enum HistoryDirection {
    Undo,
    Redo,
}

fn apply_latest_history_entry(
    connection: &mut Connection,
    direction: HistoryDirection,
) -> Result<Option<HistoryEntry>, String> {
    let tx = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    let history = match direction {
        HistoryDirection::Undo => latest_undoable_history_entry(&tx)?,
        HistoryDirection::Redo => latest_redoable_history_entry(&tx)?,
    };
    let Some(history) = history else {
        return Ok(None);
    };
    let (operation_type, operation, undone) = match direction {
        HistoryDirection::Undo => ("history_undo", &history.undo_operation, true),
        HistoryDirection::Redo => ("history_redo", &history.redo_operation, false),
    };

    append_history_action_operation(&tx, operation_type, &history.id, operation)?;
    apply_operation(&tx, operation)?;
    set_history_undone(&tx, &history.id, undone)?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(Some(history))
}

fn history_result_for_ui(
    connection: &Connection,
    history: &HistoryEntry,
    expected_operation_id: Option<&str>,
) -> Result<Value, String> {
    let state = if expected_operation_id == Some(history.operation_id.as_str()) {
        Value::Null
    } else {
        read_app_state_from_database(connection)?.unwrap_or(Value::Null)
    };
    let local_sequence = metadata_value(connection, "local_sequence")?
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);
    Ok(json!({
        "operationId": history.operation_id,
        "localSequence": local_sequence,
        "state": state,
    }))
}

fn undo_last_operation_for_ui(
    connection: &mut Connection,
    expected_operation_id: Option<&str>,
) -> Result<Option<Value>, String> {
    let Some(history) = apply_latest_history_entry(connection, HistoryDirection::Undo)? else {
        return Ok(None);
    };
    history_result_for_ui(connection, &history, expected_operation_id).map(Some)
}

fn redo_last_operation_for_ui(
    connection: &mut Connection,
    expected_operation_id: Option<&str>,
) -> Result<Option<Value>, String> {
    let Some(history) = apply_latest_history_entry(connection, HistoryDirection::Redo)? else {
        return Ok(None);
    };
    history_result_for_ui(connection, &history, expected_operation_id).map(Some)
}

/// Reverses a specific history entry by id (not just the most recent one), so the
/// Recovery panel can resurrect data from an undo record that was never successfully
/// undone in the UI. Mirrors `undo_last_operation_in_database`.
fn restore_recovery_entry_in_database(
    connection: &mut Connection,
    history_id: &str,
) -> Result<Option<Value>, String> {
    let changed = {
        let tx = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        let Some(history) = read_history_entry(
            &tx,
            "
              select id, operation_id, undo_operation_json, redo_operation_json
              from history_entries
              where id = ?1
            ",
            params![history_id],
        )?
        else {
            return Ok(None);
        };

        append_history_action_operation(&tx, "history_undo", &history.id, &history.undo_operation)?;
        apply_operation(&tx, &history.undo_operation)?;
        set_history_undone(&tx, &history.id, true)?;
        tx.commit().map_err(|error| error.to_string())?;
        true
    };

    if changed {
        read_app_state_from_database(connection)
    } else {
        Ok(None)
    }
}

/// Returns every metadata key/value, sorted, so the diagnostics view can surface
/// device, session, sync, and maintenance state.
fn list_metadata_from_database(connection: &Connection) -> Result<Value, String> {
    let mut statement = connection
        .prepare("select key, value from metadata order by key")
        .map_err(|error| error.to_string())?;

    let rows = statement
        .query_map([], |row| {
            let key = row.get::<_, String>(0)?;
            let value = if key == SYNC_PAIRING_CODE {
                "[redacted]".to_string()
            } else {
                row.get::<_, String>(1)?
            };
            Ok(json!({
                "key": key,
                "value": value,
            }))
        })
        .map_err(|error| error.to_string())?;

    let mut entries = Vec::new();
    for row in rows {
        entries.push(row.map_err(|error| error.to_string())?);
    }

    Ok(json!({ "entries": entries }))
}

fn inspect_database_from_database(connection: &Connection) -> Result<Value, String> {
    Ok(json!({
        "operations": inspect_operations_from_database(connection, 500)?,
        "historyEntries": inspect_history_entries_from_database(connection, 500)?,
        "plans": read_plans(connection)?,
    }))
}

fn inspect_operations_from_database(connection: &Connection, limit: i64) -> Result<Value, String> {
    let mut statement = connection
        .prepare(
            "
          select id, device_id, sequence, type, timestamp, payload_json
          from operations
          order by sequence desc, id desc
          limit ?1
        ",
        )
        .map_err(|error| error.to_string())?;

    let rows = statement
        .query_map(params![limit.clamp(1, 1_000)], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "deviceId": row.get::<_, String>(1)?,
                "sequence": row.get::<_, i64>(2)?,
                "type": row.get::<_, String>(3)?,
                "timestamp": row.get::<_, String>(4)?,
                "payloadJson": row.get::<_, String>(5)?,
            }))
        })
        .map_err(|error| error.to_string())?;

    let mut entries = Vec::new();
    for row in rows {
        entries.push(row.map_err(|error| error.to_string())?);
    }

    Ok(json!(entries))
}

fn inspect_history_entries_from_database(
    connection: &Connection,
    limit: i64,
) -> Result<Value, String> {
    let mut statement = connection
        .prepare(
            "
          select h.id, h.operation_id, h.sequence, h.undone, h.created_at_ms,
                 h.updated_at_ms, h.undo_operation_json, h.redo_operation_json,
                 o.type, o.timestamp
          from history_entries h
          left join operations o on o.id = h.operation_id
          order by h.sequence desc, h.updated_at_ms desc, h.id desc
          limit ?1
        ",
        )
        .map_err(|error| error.to_string())?;

    let rows = statement
        .query_map(params![limit.clamp(1, 1_000)], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "operationId": row.get::<_, String>(1)?,
                "sequence": row.get::<_, i64>(2)?,
                "undone": row.get::<_, i64>(3)? != 0,
                "createdAtMs": row.get::<_, i64>(4)?,
                "updatedAtMs": row.get::<_, i64>(5)?,
                "undoJson": row.get::<_, String>(6)?,
                "redoJson": row.get::<_, String>(7)?,
                "operationType": row.get::<_, Option<String>>(8)?,
                "timestamp": row.get::<_, Option<String>>(9)?,
            }))
        })
        .map_err(|error| error.to_string())?;

    let mut entries = Vec::new();
    for row in rows {
        entries.push(row.map_err(|error| error.to_string())?);
    }

    Ok(json!(entries))
}

/// Lists every saved undo record with a human summary, newest first, so a deleted
/// task (and its children, captured in the undo snapshot) can be found and restored.
fn list_recovery_entries_from_database(connection: &Connection) -> Result<Value, String> {
    let mut statement = connection
        .prepare(
            "
          select h.id, h.operation_id, h.sequence, h.undone, h.created_at_ms,
                 h.undo_operation_json, h.redo_operation_json, o.type, o.timestamp
          from history_entries h
          left join operations o on o.id = h.operation_id
          order by h.created_at_ms desc, h.sequence desc
        ",
        )
        .map_err(|error| error.to_string())?;

    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, Option<String>>(8)?,
            ))
        })
        .map_err(|error| error.to_string())?;

    let mut entries = Vec::new();
    for row in rows {
        let (
            id,
            operation_id,
            sequence,
            undone,
            created_at_ms,
            undo_json,
            redo_json,
            mut op_type,
            mut timestamp,
        ) = row.map_err(|error| error.to_string())?;
        let undo_operation = serde_json::from_str::<Value>(&undo_json).unwrap_or(Value::Null);
        if op_type.is_none() || timestamp.is_none() {
            if let Ok(redo_operation) = serde_json::from_str::<Value>(&redo_json) {
                op_type = op_type.or_else(|| {
                    redo_operation
                        .get("type")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                });
                timestamp = timestamp.or_else(|| {
                    redo_operation
                        .get("timestamp")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                });
            }
        }
        let (restored_item_count, preview) = summarize_undo_operation(&undo_operation);

        entries.push(json!({
            "historyId": id,
            "operationId": operation_id,
            "operationType": op_type,
            "sequence": sequence,
            "undone": undone != 0,
            "createdAtMs": created_at_ms,
            "timestamp": timestamp,
            "restoredItemCount": restored_item_count,
            "preview": preview,
            "undoJson": undo_json,
        }));
    }

    Ok(json!({ "entries": entries }))
}

/// Walks an undo operation to estimate how many plan items it would re-insert and to
/// grab a short preview of their text, so the Recovery list is identifiable at a glance.
fn summarize_undo_operation(operation: &Value) -> (i64, String) {
    let mut count = 0;
    let mut preview = String::new();
    collect_undo_summary(operation, &mut count, &mut preview);
    (count, preview)
}

fn collect_undo_summary(operation: &Value, count: &mut i64, preview: &mut String) {
    let operation_type = operation.get("type").and_then(Value::as_str).unwrap_or("");
    let payload = operation.get("payload").unwrap_or(&Value::Null);

    match operation_type {
        "batch" => {
            if let Some(operations) = payload.get("operations").and_then(Value::as_array) {
                for nested in operations {
                    collect_undo_summary(nested, count, preview);
                }
            }
        }
        "insert_plan_item_at" => {
            if let Some(item) = payload.get("item") {
                count_plan_item_subtree(item, count, preview);
            }
        }
        "insert_plan" => {
            if let Some(items) = payload.get("plan").and_then(|plan| plan.get("items")) {
                if let Some(items) = items.as_array() {
                    for item in items {
                        count_plan_item_subtree(item, count, preview);
                    }
                }
            }
        }
        _ => {}
    }
}

fn count_plan_item_subtree(item: &Value, count: &mut i64, preview: &mut String) {
    *count += 1;
    if preview.is_empty() {
        if let Some(text) = item.get("text").and_then(Value::as_str) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                *preview = trimmed.chars().take(80).collect();
            }
        }
    }
    if let Some(children) = item.get("children").and_then(Value::as_array) {
        for child in children {
            count_plan_item_subtree(child, count, preview);
        }
    }
}

fn apply_operation(tx: &Transaction<'_>, operation: &Value) -> Result<(), String> {
    let operation_type = required_string(operation, "type")?;
    let payload = required_value(operation, "payload")?;

    let result = match operation_type {
        "batch" => {
            for (index, nested_operation) in
                required_array(payload, "operations")?.iter().enumerate()
            {
                apply_operation(tx, nested_operation).map_err(|error| {
                    let ty = nested_operation
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown");
                    format!("batch operation {} ({ty}) failed: {error}", index + 1)
                })?;
            }
            Ok(())
        }
        "set_active_plan_date" => {
            set_metadata(tx, "active_plan_date", required_string(payload, "date")?)
        }
        "patch_preferences" => patch_replicated_preferences(tx, required_value(payload, "patch")?),
        "insert_plan" => insert_plan(tx, required_value(payload, "plan")?),
        "delete_plan" => {
            tx.execute(
                "delete from plans where id = ?1",
                params![required_string(payload, "planId")?],
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        }
        "generate_plan" => {
            if bool_value(payload, "replaceExisting")? {
                tx.execute(
                    "delete from plans where date = ?1",
                    params![required_string(payload, "date")?],
                )
                .map_err(|error| error.to_string())?;
            }
            let plan = required_value(payload, "generatedPlan")?;
            insert_plan(tx, plan)?;
            // Generating from the side-by-side comparison fills the second pane
            // without moving the app off the day it is on; older operations have
            // no `activePlanDate` and still land on the generated day.
            let active_plan_date = match optional_string(payload, "activePlanDate")? {
                Some(date) => date,
                None => required_string(payload, "date")?.to_string(),
            };
            set_metadata(tx, "active_plan_date", &active_plan_date)
        }
        "add_plan_item" => insert_plan_item(
            tx,
            required_string(payload, "planId")?,
            optional_string(payload, "parentId")?.as_deref(),
            required_value(payload, "item")?,
            next_plan_item_position(
                tx,
                required_string(payload, "planId")?,
                optional_string(payload, "parentId")?.as_deref(),
            )?,
        ),
        "patch_plan_item" => patch_plan_item(tx, payload),
        "patch_plan_items_done" => {
            for item_id in required_array(payload, "itemIds")? {
                tx.execute(
                    "update plan_items set done = ?1 where id = ?2",
                    params![
                        if bool_value(payload, "done")? { 1 } else { 0 },
                        item_id
                            .as_str()
                            .ok_or_else(|| "Expected string item id".to_string())?
                    ],
                )
                .map_err(|error| error.to_string())?;
            }
            complete_plan_item_descendants(tx, payload)?;
            complete_plan_item_parents(tx, payload)
        }
        "patch_plan_daily_reminder" => {
            tx.execute(
                "update plans set daily_reminder = ?1 where id = ?2",
                params![
                    required_string(payload, "dailyReminder")?,
                    required_string(payload, "planId")?,
                ],
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        }
        "split_plan_item" => split_plan_item_row(tx, payload),
        "backspace_plan_item_at_start" => backspace_plan_item_at_start_row(tx, payload),
        "delete_plan_item_preserving_children" => {
            delete_plan_item_preserving_children_row(tx, required_string(payload, "itemId")?)
        }
        "delete_plan_item" => {
            tx.execute(
                "delete from plan_items where id = ?1",
                params![required_string(payload, "itemId")?],
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        }
        "delete_plan_items" => {
            for item_id in required_array(payload, "itemIds")? {
                tx.execute(
                    "delete from plan_items where id = ?1",
                    params![item_id
                        .as_str()
                        .ok_or_else(|| "Expected string item id".to_string())?],
                )
                .map_err(|error| error.to_string())?;
            }
            Ok(())
        }
        "paste_plan_items" => paste_plan_items_row(
            tx,
            required_string(payload, "planId")?,
            optional_string(payload, "targetId")?.as_deref(),
            required_string(payload, "placement")?,
            required_array(payload, "items")?,
        ),
        "insert_plan_item_at" => insert_plan_item(
            tx,
            required_string(payload, "planId")?,
            optional_string(payload, "parentId")?.as_deref(),
            required_value(payload, "item")?,
            required_i64(payload, "position")?,
        ),
        "move_plan_item" => move_plan_item_row(
            tx,
            required_string(payload, "sourceId")?,
            required_string(payload, "targetId")?,
            required_string(payload, "placement")?,
        ),
        "move_plan_item_to_plan" => move_plan_item_to_plan_row(
            tx,
            required_string(payload, "targetPlanId")?,
            required_string(payload, "itemId")?,
            optional_string(payload, "targetId")?.as_deref(),
            required_string(payload, "placement")?,
            required_value(payload, "item")?,
        ),
        "move_plan_item_within_level" => move_plan_item_within_level_row(
            tx,
            required_string(payload, "itemId")?,
            required_string(payload, "direction")?,
        ),
        "move_plan_items_within_level" => move_plan_items_within_level_row(
            tx,
            required_string(payload, "planId")?,
            required_array(payload, "itemIds")?,
            required_string(payload, "direction")?,
        ),
        "indent_plan_items" => indent_plan_items_row(
            tx,
            required_string(payload, "planId")?,
            required_array(payload, "itemIds")?,
        ),
        "outdent_plan_item" => outdent_plan_item_row(tx, required_string(payload, "itemId")?),
        "outdent_plan_items" => outdent_plan_items_row(
            tx,
            required_string(payload, "planId")?,
            required_array(payload, "itemIds")?,
        ),
        "move_plan_item_to_position" => move_plan_item_to_position_row(
            tx,
            required_string(payload, "itemId")?,
            required_string(payload, "planId")?,
            optional_string(payload, "parentId")?.as_deref(),
            required_i64(payload, "position")?,
        ),
        "add_template" => {
            let position = tx
                .query_row(
                    "select coalesce(max(position), -1) + 1 from templates",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(|error| error.to_string())?;
            insert_template(tx, required_value(payload, "template")?, position)
        }
        "insert_template_at" => insert_template(
            tx,
            required_value(payload, "template")?,
            required_i64(payload, "position")?,
        ),
        "delete_template" => {
            tx.execute(
                "delete from templates where id = ?1",
                params![required_string(payload, "templateId")?],
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        }
        "rename_template" => {
            tx.execute(
                "update templates set name = ?1, updated_at = ?2 where id = ?3",
                params![
                    required_string(payload, "name")?,
                    required_string(operation, "timestamp")?,
                    required_string(payload, "templateId")?
                ],
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        }
        "move_template" => move_template_row(
            tx,
            required_string(payload, "sourceId")?,
            required_string(payload, "targetId")?,
            required_string(payload, "placement")?,
        ),
        "move_template_to_position" => move_template_to_position_row(
            tx,
            required_string(payload, "templateId")?,
            required_i64(payload, "position")?,
        ),
        "add_template_item" => insert_template_item(
            tx,
            required_string(payload, "templateId")?,
            optional_string(payload, "parentId")?.as_deref(),
            required_value(payload, "item")?,
            next_template_item_position(
                tx,
                required_string(payload, "templateId")?,
                optional_string(payload, "parentId")?.as_deref(),
            )?,
        ),
        "patch_template_item" => patch_template_item(tx, payload),
        "delete_template_item_preserving_children" => {
            delete_template_item_preserving_children_row(tx, required_string(payload, "itemId")?)
        }
        "delete_template_item" => {
            tx.execute(
                "delete from template_items where id = ?1",
                params![required_string(payload, "itemId")?],
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        }
        "delete_template_items" => {
            for item_id in required_array(payload, "itemIds")? {
                tx.execute(
                    "delete from template_items where id = ?1",
                    params![item_id
                        .as_str()
                        .ok_or_else(|| "Expected string item id".to_string())?],
                )
                .map_err(|error| error.to_string())?;
            }
            Ok(())
        }
        "paste_template_items" => paste_template_items_row(
            tx,
            required_string(payload, "templateId")?,
            optional_string(payload, "targetId")?.as_deref(),
            required_string(payload, "placement")?,
            required_array(payload, "items")?,
        ),
        "insert_template_item_at" => insert_template_item(
            tx,
            required_string(payload, "templateId")?,
            optional_string(payload, "parentId")?.as_deref(),
            required_value(payload, "item")?,
            required_i64(payload, "position")?,
        ),
        "move_template_item" => move_template_item_row(
            tx,
            required_string(payload, "sourceId")?,
            required_string(payload, "targetId")?,
            required_string(payload, "placement")?,
        ),
        "move_template_item_within_level" => move_template_item_within_level_row(
            tx,
            required_string(payload, "itemId")?,
            required_string(payload, "direction")?,
        ),
        "move_template_items_within_level" => move_template_items_within_level_row(
            tx,
            required_string(payload, "templateId")?,
            required_array(payload, "itemIds")?,
            required_string(payload, "direction")?,
        ),
        "indent_template_items" => indent_template_items_row(
            tx,
            required_string(payload, "templateId")?,
            required_array(payload, "itemIds")?,
        ),
        "outdent_template_item" => {
            outdent_template_item_row(tx, required_string(payload, "itemId")?)
        }
        "outdent_template_items" => outdent_template_items_row(
            tx,
            required_string(payload, "templateId")?,
            required_array(payload, "itemIds")?,
        ),
        "move_template_item_to_position" => move_template_item_to_position_row(
            tx,
            required_string(payload, "itemId")?,
            required_string(payload, "templateId")?,
            optional_string(payload, "parentId")?.as_deref(),
            required_i64(payload, "position")?,
        ),
        "add_template_option" => insert_template_option(
            tx,
            required_string(payload, "itemId")?,
            required_value(payload, "option")?,
            next_template_option_position(tx, required_string(payload, "itemId")?)?,
        ),
        "patch_template_option" => patch_template_option(tx, payload),
        "split_template_item" => split_template_item_row(tx, payload),
        "backspace_template_option_at_start" => backspace_template_option_at_start_row(tx, payload),
        "delete_template_option" => {
            tx.execute(
                "delete from template_options where id = ?1",
                params![required_string(payload, "optionId")?],
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        }
        "replace_goal_data" => Ok(()),
        // A full-state snapshot, used by multi-device sync to bootstrap a fresh
        // device (and as the replay baseline). Restores the entire domain state
        // from the payload via the same path as a wholesale state replace, but
        // leaves device-local metadata (device_id, local_sequence) untouched.
        "replace_full_state" => replace_domain_state(tx, required_value(payload, "state")?),
        "insert_template_option_at" => insert_template_option(
            tx,
            required_string(payload, "itemId")?,
            required_value(payload, "option")?,
            required_i64(payload, "position")?,
        ),
        "history_undo" | "history_redo" => {
            let nested_operation = required_value(payload, "operation")?;
            apply_operation(tx, nested_operation).map_err(|error| {
                let ty = nested_operation
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                format!("history operation ({ty}) failed: {error}")
            })
        }
        "apply_entity_changes" => Ok(()),
        other if is_lists_metrics_operation(other) => Ok(()),
        other => Err(format!("Unsupported operation type: {other}")),
    };

    result?;
    if let Some(changes) = payload.get("entityChanges") {
        apply_entity_changes(tx, changes)?;
    }
    Ok(())
}

#[derive(Clone)]
struct HistoryEntry {
    id: String,
    operation_id: String,
    undo_operation: Value,
    redo_operation: Value,
}

struct PlanItemSnapshot {
    plan_id: String,
    parent_id: Option<String>,
    position: i64,
    item: Value,
}

struct TemplateItemSnapshot {
    template_id: String,
    parent_id: Option<String>,
    position: i64,
    item: Value,
}

struct TemplateOptionSnapshot {
    item_id: String,
    position: i64,
    option: Value,
}

fn is_history_operation(operation_type: &str) -> bool {
    operation_type == "history_undo" || operation_type == "history_redo"
}

fn current_entity(
    connection: &Connection,
    collection: &str,
    key: &str,
) -> Result<Option<(i64, Value)>, String> {
    connection
        .query_row(
            "select position, value_json from state_entities
             where collection = ?1 and entity_key = ?2",
            params![collection, key],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .map(|(position, raw)| {
            serde_json::from_str(&raw)
                .map(|value| (position, value))
                .map_err(|error| error.to_string())
        })
        .transpose()
}

fn inverse_entity_changes(connection: &Connection, changes: &Value) -> Result<Value, String> {
    if required_i64(changes, "version")? != 1 {
        return Err("Unsupported entity change version".to_string());
    }
    let mut upserts = Vec::new();
    let mut deletes = Vec::new();
    for item in required_array(changes, "upserts")? {
        let collection = required_string(item, "collection")?;
        let key = required_string(item, "key")?;
        if !valid_entity_collection(collection) {
            return Err(format!("Unsupported entity collection: {collection}"));
        }
        match current_entity(connection, collection, key)? {
            Some((position, value)) => upserts.push(json!({
                "collection": collection,
                "key": key,
                "position": position,
                "value": value,
            })),
            None => deletes.push(json!({ "collection": collection, "key": key })),
        }
    }
    for item in required_array(changes, "deletes")? {
        let collection = required_string(item, "collection")?;
        let key = required_string(item, "key")?;
        if !valid_entity_collection(collection) {
            return Err(format!("Unsupported entity collection: {collection}"));
        }
        if let Some((position, value)) = current_entity(connection, collection, key)? {
            upserts.push(json!({
                "collection": collection,
                "key": key,
                "position": position,
                "value": value,
            }));
        }
    }
    Ok(json!({ "version": 1, "upserts": upserts, "deletes": deletes }))
}

fn build_undo_operation(
    connection: &Connection,
    operation: &Value,
) -> Result<Option<Value>, String> {
    let domain_undo = build_domain_undo_operation(connection, operation)?;
    let payload = required_value(operation, "payload")?;

    let Some(changes) = payload.get("entityChanges") else {
        return Ok(domain_undo);
    };
    let entity_undo = storage_operation(
        "apply_entity_changes",
        json!({ "entityChanges": inverse_entity_changes(connection, changes)? }),
    );

    if let Some(operation) = domain_undo {
        Ok(Some(storage_operation(
            "batch",
            json!({ "operations": [operation, entity_undo] }),
        )))
    } else {
        Ok(Some(entity_undo))
    }
}

fn build_domain_undo_operation(
    connection: &Connection,
    operation: &Value,
) -> Result<Option<Value>, String> {
    let operation_type = required_string(operation, "type")?;
    let payload = required_value(operation, "payload")?;

    match operation_type {
        "patch_preferences" => Ok(None),
        "set_active_plan_date" => Ok(Some(storage_operation(
            "set_active_plan_date",
            json!({ "date": metadata_value(connection, "active_plan_date")?.unwrap_or_default() }),
        ))),
        "generate_plan" => {
            let previous_active_date =
                metadata_value(connection, "active_plan_date")?.unwrap_or_default();
            let generated_plan = required_value(payload, "generatedPlan")?;
            let mut operations = vec![storage_operation(
                "delete_plan",
                json!({ "planId": required_string(generated_plan, "id")? }),
            )];

            if bool_value(payload, "replaceExisting")? {
                if let Some(previous_plan) =
                    read_plan_by_date(connection, required_string(payload, "date")?)?
                {
                    operations.push(storage_operation(
                        "insert_plan",
                        json!({ "plan": previous_plan }),
                    ));
                }
            }

            operations.push(storage_operation(
                "set_active_plan_date",
                json!({ "date": previous_active_date }),
            ));

            Ok(Some(storage_operation(
                "batch",
                json!({ "operations": operations }),
            )))
        }
        "add_plan_item" => Ok(Some(storage_operation(
            "delete_plan_item",
            json!({ "itemId": required_string(required_value(payload, "item")?, "id")? }),
        ))),
        "patch_plan_item" => build_plan_item_patch_undo(connection, payload),
        "patch_plan_items_done" => build_patch_plan_items_done_undo(connection, payload),
        "patch_plan_daily_reminder" => {
            let plan_id = required_string(payload, "planId")?;
            let Some(daily_reminder) = read_plan_daily_reminder(connection, plan_id)? else {
                return Ok(None);
            };

            Ok(Some(storage_operation(
                "patch_plan_daily_reminder",
                json!({ "planId": plan_id, "dailyReminder": daily_reminder }),
            )))
        }
        "split_plan_item" => build_split_plan_item_undo(connection, payload),
        "backspace_plan_item_at_start" => {
            build_backspace_plan_item_at_start_undo(connection, payload)
        }
        "delete_plan_item_preserving_children" => {
            let Some(snapshot) =
                read_plan_item_snapshot(connection, required_string(payload, "itemId")?)?
            else {
                return Ok(None);
            };

            let mut operations = snapshot.item["children"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|child| {
                    Ok(storage_operation(
                        "delete_plan_item",
                        json!({ "itemId": required_string(child, "id")? }),
                    ))
                })
                .collect::<Result<Vec<Value>, String>>()?;
            operations.push(storage_operation(
                "insert_plan_item_at",
                json!({
                    "planId": snapshot.plan_id,
                    "parentId": snapshot.parent_id,
                    "position": snapshot.position,
                    "item": snapshot.item,
                }),
            ));

            Ok(Some(storage_operation(
                "batch",
                json!({ "operations": operations }),
            )))
        }
        "delete_plan_item" => {
            let Some(snapshot) =
                read_plan_item_snapshot(connection, required_string(payload, "itemId")?)?
            else {
                return Ok(None);
            };

            Ok(Some(storage_operation(
                "insert_plan_item_at",
                json!({
                    "planId": snapshot.plan_id,
                    "parentId": snapshot.parent_id,
                    "position": snapshot.position,
                    "item": snapshot.item,
                }),
            )))
        }
        "delete_plan_items" => build_delete_plan_items_undo(connection, payload),
        "paste_plan_items" => {
            let mut operations = required_array(payload, "items")?
                .iter()
                .map(|item| {
                    Ok(storage_operation(
                        "delete_plan_item",
                        json!({ "itemId": required_string(item, "id")? }),
                    ))
                })
                .collect::<Result<Vec<Value>, String>>()?;

            if required_string(payload, "placement")? == "replace" {
                if let Some(target_id) = optional_string(payload, "targetId")? {
                    if let Some(snapshot) = read_plan_item_snapshot(connection, &target_id)? {
                        operations.push(storage_operation(
                            "insert_plan_item_at",
                            json!({
                                "planId": snapshot.plan_id,
                                "parentId": snapshot.parent_id,
                                "position": snapshot.position,
                                "item": snapshot.item,
                            }),
                        ));
                    }
                }
            }

            Ok(Some(storage_operation(
                "batch",
                json!({ "operations": operations }),
            )))
        }
        "move_plan_item" => {
            let Some(snapshot) =
                read_plan_item_snapshot(connection, required_string(payload, "sourceId")?)?
            else {
                return Ok(None);
            };

            Ok(Some(storage_operation(
                "move_plan_item_to_position",
                json!({
                    "itemId": required_string(payload, "sourceId")?,
                    "planId": snapshot.plan_id,
                    "parentId": snapshot.parent_id,
                    "position": snapshot.position,
                }),
            )))
        }
        "move_plan_item_to_plan" => {
            let item_id = required_string(payload, "itemId")?;
            let Some(snapshot) = read_plan_item_snapshot(connection, item_id)? else {
                return Ok(None);
            };

            // The item is re-created in the target plan, so undo removes it there
            // and re-inserts the pre-move subtree at its old slot in the old day.
            Ok(Some(storage_operation(
                "batch",
                json!({
                    "operations": [
                        storage_operation("delete_plan_item", json!({ "itemId": item_id })),
                        storage_operation(
                            "insert_plan_item_at",
                            json!({
                                "planId": snapshot.plan_id,
                                "parentId": snapshot.parent_id,
                                "position": snapshot.position,
                                "item": snapshot.item,
                            }),
                        ),
                    ]
                }),
            )))
        }
        "move_plan_item_within_level" => {
            let Some(snapshot) =
                read_plan_item_snapshot(connection, required_string(payload, "itemId")?)?
            else {
                return Ok(None);
            };

            Ok(Some(storage_operation(
                "move_plan_item_to_position",
                json!({
                    "itemId": required_string(payload, "itemId")?,
                    "planId": snapshot.plan_id,
                    "parentId": snapshot.parent_id,
                    "position": snapshot.position,
                }),
            )))
        }
        "move_plan_items_within_level" => {
            build_move_plan_items_within_level_undo(connection, payload)
        }
        "indent_plan_items" => build_move_plan_items_within_level_undo(connection, payload),
        "outdent_plan_item" => build_outdent_plan_item_undo(connection, payload),
        "outdent_plan_items" => build_outdent_plan_items_undo(connection, payload),
        "add_template" => Ok(Some(storage_operation(
            "delete_template",
            json!({
                "templateId": required_string(required_value(payload, "template")?, "id")?
            }),
        ))),
        "delete_template" => {
            let Some((position, template)) =
                read_template_snapshot(connection, required_string(payload, "templateId")?)?
            else {
                return Ok(None);
            };

            Ok(Some(storage_operation(
                "insert_template_at",
                json!({ "position": position, "template": template }),
            )))
        }
        "rename_template" => {
            let template_id = required_string(payload, "templateId")?;
            let previous = read_template_name_and_updated_at(connection, template_id)?;
            let Some((name, updated_at)) = previous else {
                return Ok(None);
            };

            Ok(Some(storage_operation_with_timestamp(
                "rename_template",
                json!({ "templateId": template_id, "name": name }),
                &updated_at,
            )))
        }
        "move_template" => {
            build_move_template_undo(connection, required_string(payload, "sourceId")?)
        }
        "move_template_to_position" => {
            build_move_template_undo(connection, required_string(payload, "templateId")?)
        }
        "add_template_item" => Ok(Some(storage_operation(
            "delete_template_item",
            json!({ "itemId": required_string(required_value(payload, "item")?, "id")? }),
        ))),
        "patch_template_item" => build_template_item_patch_undo(connection, payload),
        "delete_template_item_preserving_children" => {
            let Some(snapshot) =
                read_template_item_snapshot(connection, required_string(payload, "itemId")?)?
            else {
                return Ok(None);
            };

            let mut operations = snapshot.item["children"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|child| {
                    Ok(storage_operation(
                        "delete_template_item",
                        json!({ "itemId": required_string(child, "id")? }),
                    ))
                })
                .collect::<Result<Vec<Value>, String>>()?;
            operations.push(storage_operation(
                "insert_template_item_at",
                json!({
                    "templateId": snapshot.template_id,
                    "parentId": snapshot.parent_id,
                    "position": snapshot.position,
                    "item": snapshot.item,
                }),
            ));

            Ok(Some(storage_operation(
                "batch",
                json!({ "operations": operations }),
            )))
        }
        "delete_template_item" => {
            let Some(snapshot) =
                read_template_item_snapshot(connection, required_string(payload, "itemId")?)?
            else {
                return Ok(None);
            };

            Ok(Some(storage_operation(
                "insert_template_item_at",
                json!({
                    "templateId": snapshot.template_id,
                    "parentId": snapshot.parent_id,
                    "position": snapshot.position,
                    "item": snapshot.item,
                }),
            )))
        }
        "delete_template_items" => build_delete_template_items_undo(connection, payload),
        "paste_template_items" => {
            let mut operations = required_array(payload, "items")?
                .iter()
                .map(|item| {
                    Ok(storage_operation(
                        "delete_template_item",
                        json!({ "itemId": required_string(item, "id")? }),
                    ))
                })
                .collect::<Result<Vec<Value>, String>>()?;

            if required_string(payload, "placement")? == "replace" {
                if let Some(target_id) = optional_string(payload, "targetId")? {
                    if let Some(snapshot) = read_template_item_snapshot(connection, &target_id)? {
                        operations.push(storage_operation(
                            "insert_template_item_at",
                            json!({
                                "templateId": snapshot.template_id,
                                "parentId": snapshot.parent_id,
                                "position": snapshot.position,
                                "item": snapshot.item,
                            }),
                        ));
                    }
                }
            }

            Ok(Some(storage_operation(
                "batch",
                json!({ "operations": operations }),
            )))
        }
        "move_template_item" => {
            let Some(snapshot) =
                read_template_item_snapshot(connection, required_string(payload, "sourceId")?)?
            else {
                return Ok(None);
            };

            Ok(Some(storage_operation(
                "move_template_item_to_position",
                json!({
                    "itemId": required_string(payload, "sourceId")?,
                    "templateId": snapshot.template_id,
                    "parentId": snapshot.parent_id,
                    "position": snapshot.position,
                }),
            )))
        }
        "move_template_item_within_level" => {
            let Some(snapshot) =
                read_template_item_snapshot(connection, required_string(payload, "itemId")?)?
            else {
                return Ok(None);
            };

            Ok(Some(storage_operation(
                "move_template_item_to_position",
                json!({
                    "itemId": required_string(payload, "itemId")?,
                    "templateId": snapshot.template_id,
                    "parentId": snapshot.parent_id,
                    "position": snapshot.position,
                }),
            )))
        }
        "move_template_items_within_level" => {
            build_move_template_items_within_level_undo(connection, payload)
        }
        "indent_template_items" => build_move_template_items_within_level_undo(connection, payload),
        "outdent_template_item" => build_outdent_template_item_undo(connection, payload),
        "outdent_template_items" => build_outdent_template_items_undo(connection, payload),
        "add_template_option" => Ok(Some(storage_operation(
            "delete_template_option",
            json!({ "optionId": required_string(required_value(payload, "option")?, "id")? }),
        ))),
        "patch_template_option" => build_template_option_patch_undo(connection, payload),
        "split_template_item" => build_split_template_item_undo(connection, payload),
        "backspace_template_option_at_start" => {
            build_backspace_template_option_at_start_undo(connection, payload)
        }
        "delete_template_option" => {
            let Some(snapshot) =
                read_template_option_snapshot(connection, required_string(payload, "optionId")?)?
            else {
                return Ok(None);
            };

            Ok(Some(storage_operation(
                "insert_template_option_at",
                json!({
                    "itemId": snapshot.item_id,
                    "position": snapshot.position,
                    "option": snapshot.option,
                }),
            )))
        }
        _ => Ok(None),
    }
}

fn build_plan_item_patch_undo(
    connection: &Connection,
    payload: &Value,
) -> Result<Option<Value>, String> {
    let item_id = required_string(payload, "itemId")?;
    let patch = required_value(payload, "patch")?;
    let Some((text, html, done, start_minutes, end_minutes, time_hidden)) =
        read_plan_item_fields(connection, item_id)?
    else {
        return Ok(None);
    };

    let mut inverse_patch = Map::new();
    if patch_has_key(patch, "text") {
        inverse_patch.insert("text".into(), json!(text));
    }
    if patch_has_key(patch, "html") {
        inverse_patch.insert("html".into(), json!(html));
    }
    if patch_has_key(patch, "done") {
        inverse_patch.insert("done".into(), json!(done));
    }
    if patch_has_key(patch, "startMinutes") {
        inverse_patch.insert("startMinutes".into(), json!(start_minutes));
    }
    if patch_has_key(patch, "endMinutes") {
        inverse_patch.insert("endMinutes".into(), json!(end_minutes));
    }
    if patch_has_key(patch, "timeHidden") {
        inverse_patch.insert("timeHidden".into(), json!(time_hidden));
    }

    let mut operations = Vec::new();
    if !inverse_patch.is_empty() {
        operations.push(storage_operation(
            "patch_plan_item",
            json!({
                "planId": required_string(payload, "planId")?,
                "itemId": item_id,
                "patch": Value::Object(inverse_patch),
            }),
        ));
    }

    if let Some(descendant_ids) = payload.get("completedDescendantIds") {
        for descendant_id in descendant_ids
            .as_array()
            .ok_or_else(|| "Expected completedDescendantIds array".to_string())?
        {
            let descendant_id = descendant_id
                .as_str()
                .ok_or_else(|| "Expected completed descendant item id".to_string())?;
            let Some((_, _, done, _, _, _)) = read_plan_item_fields(connection, descendant_id)?
            else {
                continue;
            };
            operations.push(storage_operation(
                "patch_plan_item",
                json!({
                    "planId": required_string(payload, "planId")?,
                    "itemId": descendant_id,
                    "patch": { "done": done },
                }),
            ));
        }
    }

    if let Some(parent_ids) = payload.get("completedParentIds") {
        for parent_id in parent_ids
            .as_array()
            .ok_or_else(|| "Expected completedParentIds array".to_string())?
        {
            let parent_id = parent_id
                .as_str()
                .ok_or_else(|| "Expected completed parent item id".to_string())?;
            let Some((_, _, done, _, _, _)) = read_plan_item_fields(connection, parent_id)? else {
                continue;
            };
            operations.push(storage_operation(
                "patch_plan_item",
                json!({
                    "planId": required_string(payload, "planId")?,
                    "itemId": parent_id,
                    "patch": { "done": done },
                }),
            ));
        }
    }

    match operations.len() {
        0 => Ok(None),
        1 => Ok(operations.pop()),
        _ => Ok(Some(storage_operation(
            "batch",
            json!({ "operations": operations }),
        ))),
    }
}

fn build_patch_plan_items_done_undo(
    connection: &Connection,
    payload: &Value,
) -> Result<Option<Value>, String> {
    let mut item_ids = required_array(payload, "itemIds")?.to_vec();
    if let Some(descendant_ids) = payload.get("completedDescendantIds") {
        item_ids.extend(
            descendant_ids
                .as_array()
                .ok_or_else(|| "Expected completedDescendantIds array".to_string())?
                .iter()
                .cloned(),
        );
    }
    if let Some(parent_ids) = payload.get("completedParentIds") {
        item_ids.extend(
            parent_ids
                .as_array()
                .ok_or_else(|| "Expected completedParentIds array".to_string())?
                .iter()
                .cloned(),
        );
    }

    let operations = item_ids
        .iter()
        .filter_map(|item_id| item_id.as_str())
        .map(|item_id| {
            let Some((_, _, done, _, _, _)) = read_plan_item_fields(connection, item_id)? else {
                return Ok(None);
            };

            Ok(Some(storage_operation(
                "patch_plan_item",
                json!({
                    "planId": required_string(payload, "planId")?,
                    "itemId": item_id,
                    "patch": { "done": done },
                }),
            )))
        })
        .collect::<Result<Vec<Option<Value>>, String>>()?
        .into_iter()
        .flatten()
        .collect::<Vec<Value>>();

    if operations.is_empty() {
        return Ok(None);
    }

    Ok(Some(storage_operation(
        "batch",
        json!({ "operations": operations }),
    )))
}

fn build_split_plan_item_undo(
    connection: &Connection,
    payload: &Value,
) -> Result<Option<Value>, String> {
    let source_id = required_string(payload, "itemId")?;
    let source_snapshot = if optional_bool(payload, "moveChildrenToNewItem")?.unwrap_or(false) {
        read_plan_item_snapshot(connection, source_id)?
    } else {
        None
    };
    let new_item_id = required_string(required_value(payload, "newItem")?, "id")?;
    let mut operations = vec![storage_operation(
        "delete_plan_item",
        json!({ "itemId": new_item_id }),
    )];

    if let Some(patch_undo) = build_plan_item_patch_undo(connection, payload)? {
        operations.push(patch_undo);
    }

    if let Some(snapshot) = source_snapshot {
        if let Some(children) = snapshot.item["children"].as_array() {
            for (position, child) in children.iter().enumerate() {
                operations.push(storage_operation(
                    "insert_plan_item_at",
                    json!({
                        "planId": snapshot.plan_id,
                        "parentId": source_id,
                        "position": position,
                        "item": child,
                    }),
                ));
            }
        }
    }

    Ok(Some(storage_operation(
        "batch",
        json!({ "operations": operations }),
    )))
}

fn build_backspace_plan_item_at_start_undo(
    connection: &Connection,
    payload: &Value,
) -> Result<Option<Value>, String> {
    match required_string(payload, "action")? {
        "delete_previous" => {
            let Some(snapshot) =
                read_plan_item_snapshot(connection, required_string(payload, "previousId")?)?
            else {
                return Ok(None);
            };

            Ok(Some(storage_operation(
                "insert_plan_item_at",
                json!({
                    "planId": snapshot.plan_id,
                    "parentId": snapshot.parent_id,
                    "position": snapshot.position,
                    "item": snapshot.item,
                }),
            )))
        }
        "merge" => {
            let Some(current_snapshot) =
                read_plan_item_snapshot(connection, required_string(payload, "itemId")?)?
            else {
                return Ok(None);
            };
            let patch_payload = json!({
                "planId": required_string(payload, "planId")?,
                "itemId": required_string(payload, "previousId")?,
                "patch": required_value(payload, "patch")?,
            });
            let mut operations = vec![storage_operation(
                "insert_plan_item_at",
                json!({
                    "planId": current_snapshot.plan_id,
                    "parentId": current_snapshot.parent_id,
                    "position": current_snapshot.position,
                    "item": current_snapshot.item,
                }),
            )];

            if let Some(patch_undo) = build_plan_item_patch_undo(connection, &patch_payload)? {
                operations.push(patch_undo);
            }

            Ok(Some(storage_operation(
                "batch",
                json!({ "operations": operations }),
            )))
        }
        other => Err(format!("Unsupported backspace action: {other}")),
    }
}

fn build_delete_plan_items_undo(
    connection: &Connection,
    payload: &Value,
) -> Result<Option<Value>, String> {
    let mut operations = Vec::new();

    for item_id in required_array(payload, "itemIds")? {
        let Some(item_id) = item_id.as_str() else {
            return Err("Expected string item id".to_string());
        };
        let Some(snapshot) = read_plan_item_snapshot(connection, item_id)? else {
            continue;
        };

        operations.push(storage_operation(
            "insert_plan_item_at",
            json!({
                "planId": snapshot.plan_id,
                "parentId": snapshot.parent_id,
                "position": snapshot.position,
                "item": snapshot.item,
            }),
        ));
    }

    if operations.is_empty() {
        return Ok(None);
    }

    Ok(Some(storage_operation(
        "batch",
        json!({ "operations": operations }),
    )))
}

fn build_outdent_plan_item_undo(
    connection: &Connection,
    payload: &Value,
) -> Result<Option<Value>, String> {
    let item_id = required_string(payload, "itemId")?;
    let Some(snapshot) = read_plan_item_snapshot(connection, item_id)? else {
        return Ok(None);
    };
    let Some(parent_id) = snapshot.parent_id.clone() else {
        return Ok(None);
    };

    let siblings = plan_item_sibling_ids(connection, &snapshot.plan_id, Some(&parent_id))?;
    let Some(source_index) = siblings.iter().position(|id| id == item_id) else {
        return Ok(None);
    };

    let mut operations = vec![storage_operation(
        "move_plan_item_to_position",
        json!({
            "itemId": item_id,
            "planId": snapshot.plan_id,
            "parentId": snapshot.parent_id,
            "position": snapshot.position,
        }),
    )];

    for (offset, sibling_id) in siblings[source_index + 1..].iter().enumerate() {
        operations.push(storage_operation(
            "move_plan_item_to_position",
            json!({
                "itemId": sibling_id,
                "planId": required_string(payload, "planId")?,
                "parentId": parent_id,
                "position": snapshot.position + 1 + offset as i64,
            }),
        ));
    }

    Ok(Some(storage_operation(
        "batch",
        json!({ "operations": operations }),
    )))
}

fn build_outdent_plan_items_undo(
    connection: &Connection,
    payload: &Value,
) -> Result<Option<Value>, String> {
    let plan_id = required_string(payload, "planId")?;
    let mut seen: Vec<String> = Vec::new();
    let mut snapshots: Vec<PlanItemSnapshot> = Vec::new();

    // Each outdent promotes a selected root and absorbs the siblings that follow
    // it, so restoring every selected root together with its following siblings
    // back to their original parent and position rebuilds the pre-outdent tree.
    for item_id in required_array(payload, "itemIds")? {
        let Some(item_id) = item_id.as_str() else {
            return Err("Expected string item id".to_string());
        };
        let Some(snapshot) = read_plan_item_snapshot(connection, item_id)? else {
            continue;
        };
        if snapshot.plan_id != plan_id {
            continue;
        }
        let Some(parent_id) = snapshot.parent_id.clone() else {
            continue;
        };

        let siblings = plan_item_sibling_ids(connection, &snapshot.plan_id, Some(&parent_id))?;
        let Some(source_index) = siblings.iter().position(|id| id == item_id) else {
            continue;
        };

        for sibling_id in &siblings[source_index..] {
            if seen.iter().any(|id| id == sibling_id) {
                continue;
            }
            seen.push(sibling_id.clone());

            if let Some(sibling_snapshot) = read_plan_item_snapshot(connection, sibling_id)? {
                snapshots.push(sibling_snapshot);
            }
        }
    }

    if snapshots.is_empty() {
        return Ok(None);
    }

    // Restore parent by parent in ascending position so each sibling lands at its
    // original index as the list is rebuilt.
    snapshots.sort_by(|a, b| {
        a.plan_id
            .cmp(&b.plan_id)
            .then(a.parent_id.cmp(&b.parent_id))
            .then(a.position.cmp(&b.position))
    });

    let operations = snapshots
        .into_iter()
        .map(|snapshot| {
            Ok(storage_operation(
                "move_plan_item_to_position",
                json!({
                    "itemId": required_string(&snapshot.item, "id")?,
                    "planId": snapshot.plan_id,
                    "parentId": snapshot.parent_id,
                    "position": snapshot.position,
                }),
            ))
        })
        .collect::<Result<Vec<Value>, String>>()?;

    Ok(Some(storage_operation(
        "batch",
        json!({ "operations": operations }),
    )))
}

fn build_move_plan_items_within_level_undo(
    connection: &Connection,
    payload: &Value,
) -> Result<Option<Value>, String> {
    let mut snapshots = Vec::new();
    let restore_from_end = optional_string(payload, "direction")?.as_deref() == Some("up");

    for item_id in required_array(payload, "itemIds")? {
        let Some(item_id) = item_id.as_str() else {
            return Err("Expected string item id".to_string());
        };
        let Some(snapshot) = read_plan_item_snapshot(connection, item_id)? else {
            continue;
        };

        snapshots.push(snapshot);
    }

    snapshots.sort_by(|a, b| {
        a.plan_id
            .cmp(&b.plan_id)
            .then(a.parent_id.cmp(&b.parent_id))
            .then_with(|| {
                if restore_from_end {
                    b.position.cmp(&a.position)
                } else {
                    a.position.cmp(&b.position)
                }
            })
    });

    if snapshots.is_empty() {
        return Ok(None);
    }

    let operations = snapshots
        .into_iter()
        .map(|snapshot| {
            Ok(storage_operation(
                "move_plan_item_to_position",
                json!({
                    "itemId": required_string(&snapshot.item, "id")?,
                    "planId": snapshot.plan_id,
                    "parentId": snapshot.parent_id,
                    "position": snapshot.position,
                }),
            ))
        })
        .collect::<Result<Vec<Value>, String>>()?;

    Ok(Some(storage_operation(
        "batch",
        json!({ "operations": operations }),
    )))
}

fn build_delete_template_items_undo(
    connection: &Connection,
    payload: &Value,
) -> Result<Option<Value>, String> {
    let mut operations = Vec::new();

    for item_id in required_array(payload, "itemIds")? {
        let Some(item_id) = item_id.as_str() else {
            return Err("Expected string item id".to_string());
        };
        let Some(snapshot) = read_template_item_snapshot(connection, item_id)? else {
            continue;
        };

        operations.push(storage_operation(
            "insert_template_item_at",
            json!({
                "templateId": snapshot.template_id,
                "parentId": snapshot.parent_id,
                "position": snapshot.position,
                "item": snapshot.item,
            }),
        ));
    }

    if operations.is_empty() {
        return Ok(None);
    }

    Ok(Some(storage_operation(
        "batch",
        json!({ "operations": operations }),
    )))
}

fn build_template_item_patch_undo(
    connection: &Connection,
    payload: &Value,
) -> Result<Option<Value>, String> {
    let item_id = required_string(payload, "itemId")?;
    let patch = required_value(payload, "patch")?;
    let Some((start_minutes, end_minutes, time_hidden)) =
        read_template_item_fields(connection, item_id)?
    else {
        return Ok(None);
    };

    let mut inverse_patch = Map::new();
    if patch_has_key(patch, "startMinutes") {
        inverse_patch.insert("startMinutes".into(), json!(start_minutes));
    }
    if patch_has_key(patch, "endMinutes") {
        inverse_patch.insert("endMinutes".into(), json!(end_minutes));
    }
    if patch_has_key(patch, "timeHidden") {
        inverse_patch.insert("timeHidden".into(), json!(time_hidden));
    }

    if inverse_patch.is_empty() {
        return Ok(None);
    }

    Ok(Some(storage_operation(
        "patch_template_item",
        json!({
            "templateId": required_string(payload, "templateId")?,
            "itemId": item_id,
            "patch": Value::Object(inverse_patch),
        }),
    )))
}

fn build_move_template_items_within_level_undo(
    connection: &Connection,
    payload: &Value,
) -> Result<Option<Value>, String> {
    let mut snapshots = Vec::new();
    let restore_from_end = optional_string(payload, "direction")?.as_deref() == Some("up");

    for item_id in required_array(payload, "itemIds")? {
        let Some(item_id) = item_id.as_str() else {
            return Err("Expected string item id".to_string());
        };
        let Some(snapshot) = read_template_item_snapshot(connection, item_id)? else {
            continue;
        };

        snapshots.push(snapshot);
    }

    snapshots.sort_by(|a, b| {
        a.template_id
            .cmp(&b.template_id)
            .then(a.parent_id.cmp(&b.parent_id))
            .then_with(|| {
                if restore_from_end {
                    b.position.cmp(&a.position)
                } else {
                    a.position.cmp(&b.position)
                }
            })
    });

    if snapshots.is_empty() {
        return Ok(None);
    }

    let operations = snapshots
        .into_iter()
        .map(|snapshot| {
            Ok(storage_operation(
                "move_template_item_to_position",
                json!({
                    "itemId": required_string(&snapshot.item, "id")?,
                    "templateId": snapshot.template_id,
                    "parentId": snapshot.parent_id,
                    "position": snapshot.position,
                }),
            ))
        })
        .collect::<Result<Vec<Value>, String>>()?;

    Ok(Some(storage_operation(
        "batch",
        json!({ "operations": operations }),
    )))
}

fn build_template_option_patch_undo(
    connection: &Connection,
    payload: &Value,
) -> Result<Option<Value>, String> {
    let option_id = required_string(payload, "optionId")?;
    let patch = required_value(payload, "patch")?;
    let Some((text, html, probability)) = read_template_option_fields(connection, option_id)?
    else {
        return Ok(None);
    };

    let mut inverse_patch = Map::new();
    if patch_has_key(patch, "text") {
        inverse_patch.insert("text".into(), json!(text));
    }
    if patch_has_key(patch, "html") {
        inverse_patch.insert("html".into(), json!(html));
    }
    if patch_has_key(patch, "probability") {
        inverse_patch.insert("probability".into(), json!(probability));
    }

    if inverse_patch.is_empty() {
        return Ok(None);
    }

    Ok(Some(storage_operation(
        "patch_template_option",
        json!({
            "templateId": required_string(payload, "templateId")?,
            "itemId": required_string(payload, "itemId")?,
            "optionId": option_id,
            "patch": Value::Object(inverse_patch),
        }),
    )))
}

fn build_split_template_item_undo(
    connection: &Connection,
    payload: &Value,
) -> Result<Option<Value>, String> {
    let new_item_id = required_string(required_value(payload, "newItem")?, "id")?;
    let mut operations = vec![storage_operation(
        "delete_template_item",
        json!({ "itemId": new_item_id }),
    )];

    if let Some(patch_undo) = build_template_option_patch_undo(connection, payload)? {
        operations.push(patch_undo);
    }

    Ok(Some(storage_operation(
        "batch",
        json!({ "operations": operations }),
    )))
}

fn build_backspace_template_option_at_start_undo(
    connection: &Connection,
    payload: &Value,
) -> Result<Option<Value>, String> {
    match required_string(payload, "action")? {
        "delete_previous_item" => {
            let Some(snapshot) = read_template_item_snapshot(
                connection,
                required_string(payload, "previousItemId")?,
            )?
            else {
                return Ok(None);
            };

            Ok(Some(storage_operation(
                "insert_template_item_at",
                json!({
                    "templateId": snapshot.template_id,
                    "parentId": snapshot.parent_id,
                    "position": snapshot.position,
                    "item": snapshot.item,
                }),
            )))
        }
        "delete_previous_option" => {
            let Some(snapshot) = read_template_option_snapshot(
                connection,
                required_string(payload, "previousOptionId")?,
            )?
            else {
                return Ok(None);
            };

            Ok(Some(storage_operation(
                "insert_template_option_at",
                json!({
                    "itemId": snapshot.item_id,
                    "position": snapshot.position,
                    "option": snapshot.option,
                }),
            )))
        }
        "merge" => {
            let current_item_id = required_string(payload, "itemId")?;
            let current_option_id = required_string(payload, "optionId")?;
            let previous_item_id = required_string(payload, "previousItemId")?;
            let patch_payload = json!({
                "templateId": required_string(payload, "templateId")?,
                "itemId": previous_item_id,
                "optionId": required_string(payload, "previousOptionId")?,
                "patch": required_value(payload, "patch")?,
            });
            let mut operations = Vec::new();

            if current_item_id == previous_item_id {
                let Some(snapshot) = read_template_option_snapshot(connection, current_option_id)?
                else {
                    return Ok(None);
                };
                operations.push(storage_operation(
                    "insert_template_option_at",
                    json!({
                        "itemId": snapshot.item_id,
                        "position": snapshot.position,
                        "option": snapshot.option,
                    }),
                ));
            } else {
                let Some(snapshot) = read_template_item_snapshot(connection, current_item_id)?
                else {
                    return Ok(None);
                };
                operations.push(storage_operation(
                    "insert_template_item_at",
                    json!({
                        "templateId": snapshot.template_id,
                        "parentId": snapshot.parent_id,
                        "position": snapshot.position,
                        "item": snapshot.item,
                    }),
                ));
            }

            if let Some(patch_undo) = build_template_option_patch_undo(connection, &patch_payload)?
            {
                operations.push(patch_undo);
            }

            Ok(Some(storage_operation(
                "batch",
                json!({ "operations": operations }),
            )))
        }
        other => Err(format!("Unsupported template backspace action: {other}")),
    }
}

fn build_outdent_template_item_undo(
    connection: &Connection,
    payload: &Value,
) -> Result<Option<Value>, String> {
    let item_id = required_string(payload, "itemId")?;
    let Some(snapshot) = read_template_item_snapshot(connection, item_id)? else {
        return Ok(None);
    };
    let Some(parent_id) = snapshot.parent_id.clone() else {
        return Ok(None);
    };

    let siblings = template_item_sibling_ids(connection, &snapshot.template_id, Some(&parent_id))?;
    let Some(source_index) = siblings.iter().position(|id| id == item_id) else {
        return Ok(None);
    };

    let mut operations = vec![storage_operation(
        "move_template_item_to_position",
        json!({
            "itemId": item_id,
            "templateId": snapshot.template_id,
            "parentId": snapshot.parent_id,
            "position": snapshot.position,
        }),
    )];

    for (offset, sibling_id) in siblings[source_index + 1..].iter().enumerate() {
        operations.push(storage_operation(
            "move_template_item_to_position",
            json!({
                "itemId": sibling_id,
                "templateId": required_string(payload, "templateId")?,
                "parentId": parent_id,
                "position": snapshot.position + 1 + offset as i64,
            }),
        ));
    }

    Ok(Some(storage_operation(
        "batch",
        json!({ "operations": operations }),
    )))
}

fn build_outdent_template_items_undo(
    connection: &Connection,
    payload: &Value,
) -> Result<Option<Value>, String> {
    let template_id = required_string(payload, "templateId")?;
    let mut seen: Vec<String> = Vec::new();
    let mut snapshots: Vec<TemplateItemSnapshot> = Vec::new();

    for item_id in required_array(payload, "itemIds")? {
        let Some(item_id) = item_id.as_str() else {
            return Err("Expected string item id".to_string());
        };
        let Some(snapshot) = read_template_item_snapshot(connection, item_id)? else {
            continue;
        };
        if snapshot.template_id != template_id {
            continue;
        }
        let Some(parent_id) = snapshot.parent_id.clone() else {
            continue;
        };

        let siblings =
            template_item_sibling_ids(connection, &snapshot.template_id, Some(&parent_id))?;
        let Some(source_index) = siblings.iter().position(|id| id == item_id) else {
            continue;
        };

        for sibling_id in &siblings[source_index..] {
            if seen.iter().any(|id| id == sibling_id) {
                continue;
            }
            seen.push(sibling_id.clone());

            if let Some(sibling_snapshot) = read_template_item_snapshot(connection, sibling_id)? {
                snapshots.push(sibling_snapshot);
            }
        }
    }

    if snapshots.is_empty() {
        return Ok(None);
    }

    snapshots.sort_by(|a, b| {
        a.template_id
            .cmp(&b.template_id)
            .then(a.parent_id.cmp(&b.parent_id))
            .then(a.position.cmp(&b.position))
    });

    let operations = snapshots
        .into_iter()
        .map(|snapshot| {
            Ok(storage_operation(
                "move_template_item_to_position",
                json!({
                    "itemId": required_string(&snapshot.item, "id")?,
                    "templateId": snapshot.template_id,
                    "parentId": snapshot.parent_id,
                    "position": snapshot.position,
                }),
            ))
        })
        .collect::<Result<Vec<Value>, String>>()?;

    Ok(Some(storage_operation(
        "batch",
        json!({ "operations": operations }),
    )))
}

fn storage_operation(operation_type: &str, payload: Value) -> Value {
    storage_operation_with_timestamp(operation_type, payload, &current_timestamp())
}

fn storage_operation_with_timestamp(
    operation_type: &str,
    payload: Value,
    timestamp: &str,
) -> Value {
    json!({
        "id": format!("storage_{}_{}", operation_type, current_timestamp_ms()),
        "deviceId": "storage",
        "sequence": 0,
        "type": operation_type,
        "timestamp": timestamp,
        "payload": payload,
    })
}

fn history_entry_for_operation(
    connection: &Connection,
    operation_id: &str,
) -> Result<Option<HistoryEntry>, String> {
    read_history_entry(
        connection,
        "
          select id, operation_id, undo_operation_json, redo_operation_json
          from history_entries
          where operation_id = ?1
        ",
        params![operation_id],
    )
}

fn latest_undoable_history_entry(connection: &Connection) -> Result<Option<HistoryEntry>, String> {
    read_history_entry(
        connection,
        "
          select id, operation_id, undo_operation_json, redo_operation_json
          from history_entries
          where undone = 0
          order by sequence desc, updated_at_ms desc, id desc
          limit 1
        ",
        [],
    )
}

fn latest_redoable_history_entry(connection: &Connection) -> Result<Option<HistoryEntry>, String> {
    read_history_entry(
        connection,
        "
          select id, operation_id, undo_operation_json, redo_operation_json
          from history_entries
          where undone != 0
          order by updated_at_ms desc, sequence desc, id desc
          limit 1
        ",
        [],
    )
}

fn read_history_entry<P: rusqlite::Params>(
    connection: &Connection,
    sql: &str,
    params: P,
) -> Result<Option<HistoryEntry>, String> {
    connection
        .query_row(sql, params, |row| {
            let undo_json: String = row.get(2)?;
            let redo_json: String = row.get(3)?;
            let undo_operation = serde_json::from_str::<Value>(&undo_json).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    2,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            let redo_operation = serde_json::from_str::<Value>(&redo_json).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    3,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;

            Ok(HistoryEntry {
                id: row.get(0)?,
                operation_id: row.get(1)?,
                undo_operation,
                redo_operation,
            })
        })
        .optional()
        .map_err(|error| error.to_string())
}

fn upsert_history_entry(
    connection: &Connection,
    operation: &Value,
    undo_operation: &Value,
) -> Result<(), String> {
    let now = current_timestamp_ms();
    connection
        .execute(
            "
        insert into history_entries (
          id, operation_id, device_id, sequence, undo_operation_json, redo_operation_json,
          undone, created_at_ms, updated_at_ms
        )
        values (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?7)
        on conflict(operation_id) do update set
          redo_operation_json = excluded.redo_operation_json,
          undone = 0,
          updated_at_ms = excluded.updated_at_ms
      ",
            params![
                format!("hist_{}", required_string(operation, "id")?),
                required_string(operation, "id")?,
                required_string(operation, "deviceId")?,
                required_i64(operation, "sequence")?,
                undo_operation.to_string(),
                operation.to_string(),
                now,
            ],
        )
        .map_err(|error| error.to_string())?;

    Ok(())
}

fn destructive_history_operation(operation: &Value) -> bool {
    let operation_type = operation
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    operation_type.starts_with("delete_")
        || operation_type.starts_with("backspace_")
        || operation_type.starts_with("paste_")
        || matches!(operation_type, "generate_plan" | "generate_list")
}

fn prune_history_entries(connection: &Connection, now_ms: i64) -> Result<i64, String> {
    let mut statement = connection
        .prepare(
            "select id, undo_operation_json, redo_operation_json, created_at_ms
             from history_entries
             order by updated_at_ms desc, sequence desc, id desc",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);

    let mut extension_bytes = 0usize;
    let mut remove = Vec::new();
    for (index, (id, undo_json, redo_json, created_at_ms)) in rows.into_iter().enumerate() {
        if index < HISTORY_RECENT_LIMIT {
            continue;
        }
        let operation = serde_json::from_str::<Value>(&redo_json).unwrap_or(Value::Null);
        let bytes = undo_json.len().saturating_add(redo_json.len());
        let within_retention =
            now_ms.saturating_sub(created_at_ms) <= HISTORY_DESTRUCTIVE_RETENTION_MS;
        let fits_extension =
            extension_bytes.saturating_add(bytes) <= HISTORY_RECOVERY_EXTENSION_BYTES;
        if destructive_history_operation(&operation) && within_retention && fits_extension {
            extension_bytes = extension_bytes.saturating_add(bytes);
        } else {
            remove.push(id);
        }
    }

    let mut deleted = 0i64;
    let mut delete = connection
        .prepare("delete from history_entries where id = ?1")
        .map_err(|error| error.to_string())?;
    for id in remove {
        deleted += delete
            .execute(params![id])
            .map_err(|error| error.to_string())? as i64;
    }
    Ok(deleted)
}

fn append_history_action_operation(
    connection: &Connection,
    operation_type: &str,
    history_entry_id: &str,
    nested_operation: &Value,
) -> Result<(), String> {
    let device_id =
        metadata_value(connection, "device_id")?.unwrap_or_else(|| "device_local".into());
    let sequence = metadata_value(connection, "local_sequence")?
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0)
        + 1;
    let timestamp = current_timestamp();
    let operation = json!({
        "id": format!("op_{}_{}", device_id, sequence),
        "deviceId": device_id,
        "sequence": sequence,
        "type": operation_type,
        "timestamp": timestamp,
        "payload": {
            "historyEntryId": history_entry_id,
            "operation": nested_operation,
        },
    });

    upsert_operation(connection, &operation)?;
    set_metadata(
        connection,
        "device_id",
        required_string(&operation, "deviceId")?,
    )?;
    set_metadata(connection, "local_sequence", &sequence.to_string())
}

fn set_history_undone(
    connection: &Connection,
    history_entry_id: &str,
    undone: bool,
) -> Result<(), String> {
    connection
        .execute(
            "
        update history_entries
        set undone = ?1, updated_at_ms = ?2
        where id = ?3
      ",
            params![
                if undone { 1 } else { 0 },
                current_timestamp_ms(),
                history_entry_id
            ],
        )
        .map_err(|error| error.to_string())?;

    Ok(())
}

fn set_metadata(connection: &Connection, key: &str, value: &str) -> Result<(), String> {
    connection
        .execute(
            "
        insert into metadata (key, value)
        values (?1, ?2)
        on conflict(key) do update set value = excluded.value
      ",
            params![key, value],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn delete_metadata(connection: &Connection, key: &str) -> Result<(), String> {
    connection
        .execute("delete from metadata where key = ?1", params![key])
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn upsert_operation(connection: &Connection, operation: &Value) -> Result<(), String> {
    connection
        .execute(
            "
        insert into operations (id, device_id, sequence, type, timestamp, payload_json)
        values (?1, ?2, ?3, ?4, ?5, ?6)
        on conflict(id) do update set
          device_id = excluded.device_id,
          sequence = excluded.sequence,
          type = excluded.type,
          timestamp = excluded.timestamp,
          payload_json = excluded.payload_json
      ",
            params![
                required_string(operation, "id")?,
                required_string(operation, "deviceId")?,
                required_i64(operation, "sequence")?,
                required_string(operation, "type")?,
                required_string(operation, "timestamp")?,
                required_value(operation, "payload")?.to_string()
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn insert_template(connection: &Connection, template: &Value, position: i64) -> Result<(), String> {
    let template_id = required_string(template, "id")?;
    connection
        .execute(
            "
        insert into templates (id, name, created_at, updated_at, position)
        values (?1, ?2, ?3, ?4, ?5)
        on conflict(id) do update set
          name = excluded.name,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          position = excluded.position
      ",
            params![
                template_id,
                required_string(template, "name")?,
                required_string(template, "createdAt")?,
                required_string(template, "updatedAt")?,
                position
            ],
        )
        .map_err(|error| error.to_string())?;

    for (item_position, item) in required_array(template, "items")?.iter().enumerate() {
        insert_template_item(connection, template_id, None, item, item_position as i64)?;
    }

    Ok(())
}

fn move_template_row(
    connection: &Connection,
    source_id: &str,
    target_id: &str,
    placement: &str,
) -> Result<(), String> {
    if source_id == target_id {
        return Ok(());
    }

    let mut ids = template_ids(connection)?;
    let Some(source_index) = ids.iter().position(|id| id == source_id) else {
        return Ok(());
    };
    if !ids.iter().any(|id| id == target_id) {
        return Ok(());
    }

    let source = ids.remove(source_index);
    let target_index = ids
        .iter()
        .position(|id| id == target_id)
        .expect("target checked before source removal");
    let insertion_index = match placement {
        "before" => target_index,
        "after" => target_index + 1,
        _ => return Err(format!("Unsupported template placement: {placement}")),
    };
    ids.insert(insertion_index, source);
    rewrite_template_positions(connection, &ids)
}

fn move_template_to_position_row(
    connection: &Connection,
    template_id: &str,
    position: i64,
) -> Result<(), String> {
    let mut ids = template_ids(connection)?;
    let Some(source_index) = ids.iter().position(|id| id == template_id) else {
        return Ok(());
    };

    let source = ids.remove(source_index);
    let insertion_index = usize::try_from(position).unwrap_or(0).min(ids.len());
    ids.insert(insertion_index, source);
    rewrite_template_positions(connection, &ids)
}

fn template_ids(connection: &Connection) -> Result<Vec<String>, String> {
    let mut statement = connection
        .prepare("select id from templates order by position, id")
        .map_err(|error| error.to_string())?;
    let ids = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(ids)
}

fn insert_template_item(
    connection: &Connection,
    template_id: &str,
    parent_id: Option<&str>,
    item: &Value,
    position: i64,
) -> Result<(), String> {
    let template_exists = connection
        .query_row(
            "select 1 from templates where id = ?1",
            params![template_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .is_some();
    if !template_exists {
        return Ok(());
    }
    if let Some(parent_id) = parent_id {
        if template_item_template_id_if_exists(connection, parent_id)?.as_deref()
            != Some(template_id)
        {
            return Ok(());
        }
    }

    let item_id = required_string(item, "id")?;
    connection
        .execute(
            "
        insert into template_items (id, template_id, parent_id, start_minutes, end_minutes, time_hidden, position)
        values (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        on conflict(id) do update set
          template_id = excluded.template_id,
          parent_id = excluded.parent_id,
          start_minutes = excluded.start_minutes,
          end_minutes = excluded.end_minutes,
          time_hidden = excluded.time_hidden,
          position = excluded.position
      ",
            params![
                item_id,
                template_id,
                parent_id,
                optional_i64(item, "startMinutes")?,
                optional_i64(item, "endMinutes")?,
                optional_bool(item, "timeHidden")?.map(|value| if value { 1 } else { 0 }),
                position
            ],
        )
        .map_err(|error| error.to_string())?;

    for (option_position, option) in required_array(item, "options")?.iter().enumerate() {
        insert_template_option(connection, item_id, option, option_position as i64)?;
    }

    for (child_position, child) in required_array(item, "children")?.iter().enumerate() {
        insert_template_item(
            connection,
            template_id,
            Some(item_id),
            child,
            child_position as i64,
        )?;
    }

    Ok(())
}

fn insert_template_option(
    connection: &Connection,
    item_id: &str,
    option: &Value,
    position: i64,
) -> Result<(), String> {
    if template_item_template_id_if_exists(connection, item_id)?.is_none() {
        return Ok(());
    }

    let text = required_string(option, "text")?;
    let html = optional_string(option, "html")?.unwrap_or_else(|| text.to_string());

    connection
        .execute(
            "
        insert into template_options (id, item_id, text, html, probability, position)
        values (?1, ?2, ?3, ?4, ?5, ?6)
        on conflict(id) do update set
          item_id = excluded.item_id,
          text = excluded.text,
          html = excluded.html,
          probability = excluded.probability,
          position = excluded.position
      ",
            params![
                required_string(option, "id")?,
                item_id,
                text,
                html,
                number_value(option, "probability")?,
                position
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn insert_plan(connection: &Connection, plan: &Value) -> Result<(), String> {
    let plan_id = required_string(plan, "id")?;
    let daily_reminder = optional_string(plan, "dailyReminder")?
        .unwrap_or_else(|| DEFAULT_DAILY_REMINDER.to_string());
    connection
        .execute(
            "
        insert into plans (id, date, title, daily_reminder, generated_from_template_id, created_at)
        values (?1, ?2, ?3, ?4, ?5, ?6)
        on conflict(id) do update set
          date = excluded.date,
          title = excluded.title,
          daily_reminder = excluded.daily_reminder,
          generated_from_template_id = excluded.generated_from_template_id,
          created_at = excluded.created_at
      ",
            params![
                plan_id,
                required_string(plan, "date")?,
                required_string(plan, "title")?,
                daily_reminder,
                optional_string(plan, "generatedFromTemplateId")?,
                required_string(plan, "createdAt")?,
            ],
        )
        .map_err(|error| error.to_string())?;

    for (position, item) in required_array(plan, "items")?.iter().enumerate() {
        insert_plan_item(connection, plan_id, None, item, position as i64)?;
    }

    Ok(())
}

fn insert_plan_item(
    connection: &Connection,
    plan_id: &str,
    parent_id: Option<&str>,
    item: &Value,
    position: i64,
) -> Result<(), String> {
    let plan_exists = connection
        .query_row(
            "select 1 from plans where id = ?1",
            params![plan_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .is_some();
    if !plan_exists {
        return Ok(());
    }
    if let Some(parent_id) = parent_id {
        if plan_item_plan_id_if_exists(connection, parent_id)?.as_deref() != Some(plan_id) {
            return Ok(());
        }
    }

    let item_id = required_string(item, "id")?;
    connection
        .execute(
            "
        insert into plan_items (
          id, plan_id, parent_id, position, text, html, done, start_minutes, end_minutes, time_hidden
        )
        values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
        on conflict(id) do update set
          plan_id = excluded.plan_id,
          parent_id = excluded.parent_id,
          position = excluded.position,
          text = excluded.text,
          html = excluded.html,
          done = excluded.done,
          start_minutes = excluded.start_minutes,
          end_minutes = excluded.end_minutes,
          time_hidden = excluded.time_hidden
      ",
            params![
                item_id,
                plan_id,
                parent_id,
                position,
                required_string(item, "text")?,
                required_string(item, "html")?,
                if bool_value(item, "done")? { 1 } else { 0 },
                optional_i64(item, "startMinutes")?,
                optional_i64(item, "endMinutes")?,
                optional_bool(item, "timeHidden")?.map(|value| if value { 1 } else { 0 }),
            ],
        )
        .map_err(|error| error.to_string())?;

    for (child_position, child) in required_array(item, "children")?.iter().enumerate() {
        insert_plan_item(
            connection,
            plan_id,
            Some(item_id),
            child,
            child_position as i64,
        )?;
    }

    Ok(())
}

fn patch_plan_item(connection: &Connection, payload: &Value) -> Result<(), String> {
    let item_id = required_string(payload, "itemId")?;
    let patch = required_value(payload, "patch")?;

    if let Some(text) = optional_string(patch, "text")? {
        connection
            .execute(
                "update plan_items set text = ?1 where id = ?2",
                params![text, item_id],
            )
            .map_err(|error| error.to_string())?;
    }
    if let Some(html) = optional_string(patch, "html")? {
        connection
            .execute(
                "update plan_items set html = ?1 where id = ?2",
                params![html, item_id],
            )
            .map_err(|error| error.to_string())?;
    }
    if let Some(done) = optional_bool(patch, "done")? {
        connection
            .execute(
                "update plan_items set done = ?1 where id = ?2",
                params![if done { 1 } else { 0 }, item_id],
            )
            .map_err(|error| error.to_string())?;
    }
    if patch_has_key(patch, "startMinutes") {
        connection
            .execute(
                "update plan_items set start_minutes = ?1 where id = ?2",
                params![optional_i64(patch, "startMinutes")?, item_id],
            )
            .map_err(|error| error.to_string())?;
    }
    if patch_has_key(patch, "endMinutes") {
        connection
            .execute(
                "update plan_items set end_minutes = ?1 where id = ?2",
                params![optional_i64(patch, "endMinutes")?, item_id],
            )
            .map_err(|error| error.to_string())?;
    }
    if patch_has_key(patch, "timeHidden") {
        connection
            .execute(
                "update plan_items set time_hidden = ?1 where id = ?2",
                params![
                    optional_bool(patch, "timeHidden")?.map(|value| if value { 1 } else { 0 }),
                    item_id
                ],
            )
            .map_err(|error| error.to_string())?;
    }

    complete_plan_item_descendants(connection, payload)?;
    complete_plan_item_parents(connection, payload)
}

fn complete_plan_item_descendants(connection: &Connection, payload: &Value) -> Result<(), String> {
    let Some(descendant_ids) = payload.get("completedDescendantIds") else {
        return Ok(());
    };

    for descendant_id in descendant_ids
        .as_array()
        .ok_or_else(|| "Expected completedDescendantIds array".to_string())?
    {
        connection
            .execute(
                "update plan_items set done = 1 where id = ?1",
                params![descendant_id
                    .as_str()
                    .ok_or_else(|| "Expected completed descendant item id".to_string())?],
            )
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

fn complete_plan_item_parents(connection: &Connection, payload: &Value) -> Result<(), String> {
    let Some(parent_ids) = payload.get("completedParentIds") else {
        return Ok(());
    };

    for parent_id in parent_ids
        .as_array()
        .ok_or_else(|| "Expected completedParentIds array".to_string())?
    {
        connection
            .execute(
                "update plan_items set done = 1 where id = ?1",
                params![parent_id
                    .as_str()
                    .ok_or_else(|| "Expected completed parent item id".to_string())?],
            )
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

fn split_plan_item_row(connection: &Connection, payload: &Value) -> Result<(), String> {
    let plan_id = required_string(payload, "planId")?;
    let source_id = required_string(payload, "itemId")?;
    if plan_item_plan_id_if_exists(connection, source_id)?.as_deref() != Some(plan_id) {
        return Ok(());
    }
    let move_children_to_new_item =
        optional_bool(payload, "moveChildrenToNewItem")?.unwrap_or(false);
    let child_ids = if move_children_to_new_item {
        plan_item_sibling_ids(connection, plan_id, Some(source_id))?
    } else {
        Vec::new()
    };

    patch_plan_item(connection, payload)?;

    let new_item = required_value(payload, "newItem")?;
    let new_item_id = required_string(new_item, "id")?;
    let placement = optional_string(payload, "placement")?.unwrap_or_else(|| "after".to_string());

    if placement == "firstChild" {
        let mut children = plan_item_sibling_ids(connection, plan_id, Some(source_id))?;
        children.retain(|id| id != new_item_id);
        children.insert(0, new_item_id.to_string());
        insert_plan_item(connection, plan_id, Some(source_id), new_item, 0)?;
        return rewrite_plan_item_positions(connection, &children);
    }

    let insert_offset = match placement.as_str() {
        "before" => 0,
        "after" => 1,
        other => return Err(format!("Unsupported split placement: {other}")),
    };
    let parent_id = plan_item_parent_id(connection, source_id)?;
    let mut siblings = plan_item_sibling_ids(connection, plan_id, parent_id.as_deref())?;
    let source_index = siblings
        .iter()
        .position(|id| id == source_id)
        .ok_or_else(|| "Split source is not in its sibling list".to_string())?;
    let insert_index = source_index + insert_offset;

    siblings.retain(|id| id != new_item_id);
    siblings.insert(insert_index, new_item_id.to_string());
    insert_plan_item(
        connection,
        plan_id,
        parent_id.as_deref(),
        new_item,
        insert_index as i64,
    )?;

    if move_children_to_new_item {
        for (position, child_id) in child_ids.iter().enumerate() {
            connection
                .execute(
                    "
                    update plan_items
                    set parent_id = ?1, position = ?2
                    where id = ?3
                    ",
                    params![new_item_id, position as i64, child_id],
                )
                .map_err(|error| error.to_string())?;
        }
    }

    rewrite_plan_item_positions(connection, &siblings)
}

fn backspace_plan_item_at_start_row(
    connection: &Connection,
    payload: &Value,
) -> Result<(), String> {
    match required_string(payload, "action")? {
        "delete_previous" => {
            connection
                .execute(
                    "delete from plan_items where id = ?1",
                    params![required_string(payload, "previousId")?],
                )
                .map_err(|error| error.to_string())?;
            Ok(())
        }
        "merge" => {
            let plan_id = required_string(payload, "planId")?;
            let item_id = required_string(payload, "itemId")?;
            let previous_id = required_string(payload, "previousId")?;
            patch_plan_item(
                connection,
                &json!({
                    "planId": plan_id,
                    "itemId": previous_id,
                    "patch": required_value(payload, "patch")?,
                }),
            )?;

            let child_ids = plan_item_sibling_ids(connection, plan_id, Some(item_id))?;
            let next_position = next_plan_item_position(connection, plan_id, Some(previous_id))?;

            for (index, child_id) in child_ids.iter().enumerate() {
                connection
                    .execute(
                        "
                        update plan_items
                        set parent_id = ?1, position = ?2
                        where id = ?3
                        ",
                        params![previous_id, next_position + index as i64, child_id],
                    )
                    .map_err(|error| error.to_string())?;
            }

            connection
                .execute("delete from plan_items where id = ?1", params![item_id])
                .map_err(|error| error.to_string())?;
            Ok(())
        }
        other => Err(format!("Unsupported backspace action: {other}")),
    }
}

fn delete_plan_item_preserving_children_row(
    connection: &Connection,
    item_id: &str,
) -> Result<(), String> {
    let Some(plan_id) = plan_item_plan_id_if_exists(connection, item_id)? else {
        return Ok(());
    };
    let parent_id = plan_item_parent_id(connection, item_id)?;
    let siblings = plan_item_sibling_ids(connection, &plan_id, parent_id.as_deref())?;
    let Some(index) = siblings.iter().position(|id| id == item_id) else {
        return Ok(());
    };
    let child_ids = plan_item_sibling_ids(connection, &plan_id, Some(item_id))?;

    if index > 0 {
        let previous_id = &siblings[index - 1];
        let mut previous_children = plan_item_sibling_ids(connection, &plan_id, Some(previous_id))?;
        let next_position = previous_children.len();

        for (offset, child_id) in child_ids.iter().enumerate() {
            connection
                .execute(
                    "update plan_items set parent_id = ?1, position = ?2 where id = ?3",
                    params![previous_id, (next_position + offset) as i64, child_id],
                )
                .map_err(|error| error.to_string())?;
        }
        previous_children.extend(child_ids);
        rewrite_plan_item_positions(connection, &previous_children)?;

        connection
            .execute("delete from plan_items where id = ?1", params![item_id])
            .map_err(|error| error.to_string())?;
        let remaining_siblings = siblings
            .into_iter()
            .filter(|id| id != item_id)
            .collect::<Vec<_>>();
        return rewrite_plan_item_positions(connection, &remaining_siblings);
    }

    for (position, child_id) in child_ids.iter().enumerate() {
        connection
            .execute(
                "update plan_items set parent_id = ?1, position = ?2 where id = ?3",
                params![parent_id, position as i64, child_id],
            )
            .map_err(|error| error.to_string())?;
    }
    connection
        .execute("delete from plan_items where id = ?1", params![item_id])
        .map_err(|error| error.to_string())?;

    let remaining_siblings = child_ids
        .into_iter()
        .chain(siblings.into_iter().skip(1))
        .collect::<Vec<_>>();
    rewrite_plan_item_positions(connection, &remaining_siblings)
}

fn delete_template_item_preserving_children_row(
    connection: &Connection,
    item_id: &str,
) -> Result<(), String> {
    let Some(template_id) = template_item_template_id_if_exists(connection, item_id)? else {
        return Ok(());
    };
    let parent_id = template_item_parent_id(connection, item_id)?;
    let siblings = template_item_sibling_ids(connection, &template_id, parent_id.as_deref())?;
    let Some(index) = siblings.iter().position(|id| id == item_id) else {
        return Ok(());
    };
    let child_ids = template_item_sibling_ids(connection, &template_id, Some(item_id))?;

    if index > 0 {
        let previous_id = &siblings[index - 1];
        let mut previous_children =
            template_item_sibling_ids(connection, &template_id, Some(previous_id))?;
        let next_position = previous_children.len();

        for (offset, child_id) in child_ids.iter().enumerate() {
            connection
                .execute(
                    "update template_items set parent_id = ?1, position = ?2 where id = ?3",
                    params![previous_id, (next_position + offset) as i64, child_id],
                )
                .map_err(|error| error.to_string())?;
        }
        previous_children.extend(child_ids);
        rewrite_template_item_positions(connection, &previous_children)?;

        connection
            .execute("delete from template_items where id = ?1", params![item_id])
            .map_err(|error| error.to_string())?;
        let remaining_siblings = siblings
            .into_iter()
            .filter(|id| id != item_id)
            .collect::<Vec<_>>();
        return rewrite_template_item_positions(connection, &remaining_siblings);
    }

    for (position, child_id) in child_ids.iter().enumerate() {
        connection
            .execute(
                "update template_items set parent_id = ?1, position = ?2 where id = ?3",
                params![parent_id, position as i64, child_id],
            )
            .map_err(|error| error.to_string())?;
    }
    connection
        .execute("delete from template_items where id = ?1", params![item_id])
        .map_err(|error| error.to_string())?;

    let remaining_siblings = child_ids
        .into_iter()
        .chain(siblings.into_iter().skip(1))
        .collect::<Vec<_>>();
    rewrite_template_item_positions(connection, &remaining_siblings)
}

fn paste_plan_items_row(
    connection: &Connection,
    plan_id: &str,
    target_id: Option<&str>,
    placement: &str,
    items: &[Value],
) -> Result<(), String> {
    if items.is_empty() {
        return Ok(());
    }
    if let Some(target_id) = target_id {
        if plan_item_plan_id_if_exists(connection, target_id)?.as_deref() != Some(plan_id) {
            return Ok(());
        }
    }

    let parent_id = if placement == "inside" {
        target_id.map(|id| id.to_string())
    } else if let Some(target_id) = target_id {
        plan_item_parent_id(connection, target_id)?
    } else {
        None
    };
    let mut siblings = plan_item_sibling_ids(connection, plan_id, parent_id.as_deref())?;
    let insert_index = if placement == "inside" || target_id.is_none() {
        siblings.len()
    } else {
        let target_id = target_id.unwrap_or_default();
        let target_index = siblings
            .iter()
            .position(|id| id == target_id)
            .ok_or_else(|| "Paste target is not in its sibling list".to_string())?;

        if placement == "before" || placement == "replace" {
            target_index
        } else {
            target_index + 1
        }
    };
    let item_ids = items
        .iter()
        .map(|item| required_string(item, "id").map(|id| id.to_string()))
        .collect::<Result<Vec<String>, String>>()?;

    for item_id in &item_ids {
        siblings.retain(|id| id != item_id);
    }
    if placement == "replace" {
        if let Some(target_id) = target_id {
            siblings.retain(|id| id != target_id);
        }
    }

    for (offset, item_id) in item_ids.iter().enumerate() {
        siblings.insert(insert_index + offset, item_id.clone());
    }

    if placement == "replace" {
        if let Some(target_id) = target_id {
            connection
                .execute("delete from plan_items where id = ?1", params![target_id])
                .map_err(|error| error.to_string())?;
        }
    }

    for (offset, item) in items.iter().enumerate() {
        insert_plan_item(
            connection,
            plan_id,
            parent_id.as_deref(),
            item,
            (insert_index + offset) as i64,
        )?;
    }

    rewrite_plan_item_positions(connection, &siblings)
}

fn paste_template_items_row(
    connection: &Connection,
    template_id: &str,
    target_id: Option<&str>,
    placement: &str,
    items: &[Value],
) -> Result<(), String> {
    if items.is_empty() {
        return Ok(());
    }
    if let Some(target_id) = target_id {
        if template_item_template_id_if_exists(connection, target_id)?.as_deref()
            != Some(template_id)
        {
            return Ok(());
        }
    }

    let parent_id = if placement == "inside" {
        target_id.map(str::to_string)
    } else if let Some(target_id) = target_id {
        template_item_parent_id(connection, target_id)?
    } else {
        None
    };
    let mut siblings = template_item_sibling_ids(connection, template_id, parent_id.as_deref())?;
    let insert_index = if placement == "inside" || target_id.is_none() {
        siblings.len()
    } else {
        let target_id = target_id.unwrap_or_default();
        let target_index = siblings
            .iter()
            .position(|id| id == target_id)
            .ok_or_else(|| "Template paste target is not in its sibling list".to_string())?;

        if placement == "before" || placement == "replace" {
            target_index
        } else {
            target_index + 1
        }
    };
    let item_ids = items
        .iter()
        .map(|item| required_string(item, "id").map(str::to_string))
        .collect::<Result<Vec<String>, String>>()?;

    for item_id in &item_ids {
        siblings.retain(|id| id != item_id);
    }
    if placement == "replace" {
        if let Some(target_id) = target_id {
            siblings.retain(|id| id != target_id);
        }
    }

    for (offset, item_id) in item_ids.iter().enumerate() {
        siblings.insert(insert_index + offset, item_id.clone());
    }

    if placement == "replace" {
        if let Some(target_id) = target_id {
            connection
                .execute(
                    "delete from template_items where id = ?1",
                    params![target_id],
                )
                .map_err(|error| error.to_string())?;
        }
    }

    for (offset, item) in items.iter().enumerate() {
        insert_template_item(
            connection,
            template_id,
            parent_id.as_deref(),
            item,
            (insert_index + offset) as i64,
        )?;
    }

    rewrite_template_item_positions(connection, &siblings)
}

fn patch_template_item(connection: &Connection, payload: &Value) -> Result<(), String> {
    let item_id = required_string(payload, "itemId")?;
    let patch = required_value(payload, "patch")?;

    if patch_has_key(patch, "startMinutes") {
        connection
            .execute(
                "update template_items set start_minutes = ?1 where id = ?2",
                params![optional_i64(patch, "startMinutes")?, item_id],
            )
            .map_err(|error| error.to_string())?;
    }
    if patch_has_key(patch, "endMinutes") {
        connection
            .execute(
                "update template_items set end_minutes = ?1 where id = ?2",
                params![optional_i64(patch, "endMinutes")?, item_id],
            )
            .map_err(|error| error.to_string())?;
    }
    if patch_has_key(patch, "timeHidden") {
        connection
            .execute(
                "update template_items set time_hidden = ?1 where id = ?2",
                params![
                    optional_bool(patch, "timeHidden")?.map(|value| if value { 1 } else { 0 }),
                    item_id
                ],
            )
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

fn patch_template_option(connection: &Connection, payload: &Value) -> Result<(), String> {
    let option_id = required_string(payload, "optionId")?;
    let patch = required_value(payload, "patch")?;

    if let Some(text) = optional_string(patch, "text")? {
        connection
            .execute(
                "update template_options set text = ?1 where id = ?2",
                params![text, option_id],
            )
            .map_err(|error| error.to_string())?;
    }
    if let Some(html) = optional_string(patch, "html")? {
        connection
            .execute(
                "update template_options set html = ?1 where id = ?2",
                params![html, option_id],
            )
            .map_err(|error| error.to_string())?;
    }
    if patch_has_key(patch, "probability") {
        connection
            .execute(
                "update template_options set probability = ?1 where id = ?2",
                params![number_value(patch, "probability")?, option_id],
            )
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

fn backspace_template_option_at_start_row(
    connection: &Connection,
    payload: &Value,
) -> Result<(), String> {
    match required_string(payload, "action")? {
        "delete_previous_item" => {
            connection
                .execute(
                    "delete from template_items where id = ?1",
                    params![required_string(payload, "previousItemId")?],
                )
                .map_err(|error| error.to_string())?;
            Ok(())
        }
        "delete_previous_option" => {
            connection
                .execute(
                    "delete from template_options where id = ?1",
                    params![required_string(payload, "previousOptionId")?],
                )
                .map_err(|error| error.to_string())?;
            Ok(())
        }
        "merge" => {
            let template_id = required_string(payload, "templateId")?;
            let item_id = required_string(payload, "itemId")?;
            let option_id = required_string(payload, "optionId")?;
            let previous_item_id = required_string(payload, "previousItemId")?;
            patch_template_option(
                connection,
                &json!({
                    "templateId": template_id,
                    "itemId": previous_item_id,
                    "optionId": required_string(payload, "previousOptionId")?,
                    "patch": required_value(payload, "patch")?,
                }),
            )?;

            if item_id == previous_item_id {
                connection
                    .execute(
                        "delete from template_options where id = ?1",
                        params![option_id],
                    )
                    .map_err(|error| error.to_string())?;
                return Ok(());
            }

            let child_ids = template_item_sibling_ids(connection, template_id, Some(item_id))?;
            let next_position =
                next_template_item_position(connection, template_id, Some(previous_item_id))?;

            for (index, child_id) in child_ids.iter().enumerate() {
                connection
                    .execute(
                        "
                        update template_items
                        set parent_id = ?1, position = ?2
                        where id = ?3
                        ",
                        params![previous_item_id, next_position + index as i64, child_id],
                    )
                    .map_err(|error| error.to_string())?;
            }

            connection
                .execute("delete from template_items where id = ?1", params![item_id])
                .map_err(|error| error.to_string())?;
            Ok(())
        }
        other => Err(format!("Unsupported template backspace action: {other}")),
    }
}

fn split_template_item_row(connection: &Connection, payload: &Value) -> Result<(), String> {
    let template_id = required_string(payload, "templateId")?;
    let source_id = required_string(payload, "itemId")?;
    if template_item_template_id_if_exists(connection, source_id)?.as_deref() != Some(template_id) {
        return Ok(());
    }
    patch_template_option(connection, payload)?;

    let new_item = required_value(payload, "newItem")?;
    let new_item_id = required_string(new_item, "id")?;
    let placement = optional_string(payload, "placement")?.unwrap_or_else(|| "after".to_string());
    let insert_offset = match placement.as_str() {
        "before" => 0,
        "after" => 1,
        other => return Err(format!("Unsupported split placement: {other}")),
    };
    let parent_id = template_item_parent_id(connection, source_id)?;
    let mut siblings = template_item_sibling_ids(connection, template_id, parent_id.as_deref())?;
    let source_index = siblings
        .iter()
        .position(|id| id == source_id)
        .ok_or_else(|| "Split source is not in its sibling list".to_string())?;
    let insert_index = source_index + insert_offset;

    siblings.retain(|id| id != new_item_id);
    siblings.insert(insert_index, new_item_id.to_string());
    insert_template_item(
        connection,
        template_id,
        parent_id.as_deref(),
        new_item,
        insert_index as i64,
    )?;
    rewrite_template_item_positions(connection, &siblings)
}

fn move_plan_item_row(
    connection: &Connection,
    source_id: &str,
    target_id: &str,
    placement: &str,
) -> Result<(), String> {
    let Some(source_plan_id) = plan_item_plan_id_if_exists(connection, source_id)? else {
        return Ok(());
    };
    if plan_item_plan_id_if_exists(connection, target_id)?.as_deref() != Some(&source_plan_id) {
        return Ok(());
    }

    if placement == "inside" {
        let position = next_plan_item_position(connection, &source_plan_id, Some(target_id))?;
        connection
            .execute(
                "update plan_items set parent_id = ?1, position = ?2 where id = ?3",
                params![target_id, position, source_id],
            )
            .map_err(|error| error.to_string())?;
        return Ok(());
    }

    let target_parent_id = plan_item_parent_id(connection, target_id)?;
    let mut siblings =
        plan_item_sibling_ids(connection, &source_plan_id, target_parent_id.as_deref())?;
    siblings.retain(|id| id != source_id);
    let target_index = siblings
        .iter()
        .position(|id| id == target_id)
        .ok_or_else(|| "Move target is not in its sibling list".to_string())?;
    let insert_index = if placement == "after" {
        target_index + 1
    } else {
        target_index
    };
    siblings.insert(insert_index, source_id.to_string());

    connection
        .execute(
            "update plan_items set parent_id = ?1 where id = ?2",
            params![target_parent_id, source_id],
        )
        .map_err(|error| error.to_string())?;
    rewrite_plan_item_positions(connection, &siblings)
}

/// Moves an item (and everything under it) into a different day's plan.
///
/// Every descendant row carries its own `plan_id`, so re-parenting the top row
/// alone would strand the subtree in the old plan. Instead the subtree is deleted
/// (children cascade) and re-inserted into the target plan from the payload copy,
/// which is exactly what `paste_plan_items_row` already does.
fn move_plan_item_to_plan_row(
    connection: &Connection,
    target_plan_id: &str,
    item_id: &str,
    target_id: Option<&str>,
    placement: &str,
    item: &Value,
) -> Result<(), String> {
    if plan_item_plan_id_if_exists(connection, item_id)?.is_none() {
        return Ok(());
    }
    if let Some(target_id) = target_id {
        if plan_item_plan_id_if_exists(connection, target_id)?.as_deref() != Some(target_plan_id) {
            return Ok(());
        }
    }

    connection
        .execute("delete from plan_items where id = ?1", params![item_id])
        .map_err(|error| error.to_string())?;

    paste_plan_items_row(
        connection,
        target_plan_id,
        target_id,
        placement,
        std::slice::from_ref(item),
    )
}

fn move_plan_item_within_level_row(
    connection: &Connection,
    item_id: &str,
    direction: &str,
) -> Result<(), String> {
    let Some(plan_id) = plan_item_plan_id_if_exists(connection, item_id)? else {
        return Ok(());
    };
    let parent_id = plan_item_parent_id(connection, item_id)?;
    let mut siblings = plan_item_sibling_ids(connection, &plan_id, parent_id.as_deref())?;
    let index = siblings
        .iter()
        .position(|id| id == item_id)
        .ok_or_else(|| "Move source is not in its sibling list".to_string())?;
    let target_index = match direction {
        "up" if index > 0 => index - 1,
        "down" if index + 1 < siblings.len() => index + 1,
        _ => return Ok(()),
    };

    siblings.swap(index, target_index);
    rewrite_plan_item_positions(connection, &siblings)
}

fn move_plan_items_within_level_row(
    connection: &Connection,
    plan_id: &str,
    item_ids: &[Value],
    direction: &str,
) -> Result<(), String> {
    let mut selected_by_parent: HashMap<Option<String>, Vec<String>> = HashMap::new();

    for item_id in item_ids {
        let item_id = item_id
            .as_str()
            .ok_or_else(|| "Expected string item id".to_string())?;
        let Some(item_plan_id) = plan_item_plan_id_if_exists(connection, item_id)? else {
            continue;
        };
        if item_plan_id != plan_id {
            continue;
        }

        let parent_id = plan_item_parent_id(connection, item_id)?;
        selected_by_parent
            .entry(parent_id)
            .or_default()
            .push(item_id.to_string());
    }

    for (parent_id, selected_ids) in selected_by_parent {
        let mut siblings = plan_item_sibling_ids(connection, plan_id, parent_id.as_deref())?;
        let mut changed = false;

        if direction == "up" {
            for index in 1..siblings.len() {
                if selected_ids.contains(&siblings[index])
                    && !selected_ids.contains(&siblings[index - 1])
                {
                    siblings.swap(index - 1, index);
                    changed = true;
                }
            }
        } else {
            for index in (0..siblings.len().saturating_sub(1)).rev() {
                if selected_ids.contains(&siblings[index])
                    && !selected_ids.contains(&siblings[index + 1])
                {
                    siblings.swap(index, index + 1);
                    changed = true;
                }
            }
        }

        if changed {
            rewrite_plan_item_positions(connection, &siblings)?;
        }
    }

    Ok(())
}

fn indent_plan_items_row(
    connection: &Connection,
    plan_id: &str,
    item_ids: &[Value],
) -> Result<(), String> {
    let selected_ids = item_ids
        .iter()
        .map(|item_id| {
            item_id
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| "Expected string item id".to_string())
        })
        .collect::<Result<Vec<String>, String>>()?;
    let mut selected_by_parent: HashMap<Option<String>, Vec<String>> = HashMap::new();

    for item_id in &selected_ids {
        let Some(item_plan_id) = plan_item_plan_id_if_exists(connection, item_id)? else {
            continue;
        };
        if item_plan_id != plan_id {
            continue;
        }

        selected_by_parent
            .entry(plan_item_parent_id(connection, item_id)?)
            .or_default()
            .push(item_id.clone());
    }

    for (parent_id, selected_at_level) in selected_by_parent {
        let siblings = plan_item_sibling_ids(connection, plan_id, parent_id.as_deref())?;
        let mut remaining_siblings = Vec::new();
        let mut target_id: Option<String> = None;
        let mut selected_by_target: HashMap<String, Vec<String>> = HashMap::new();

        for sibling_id in siblings {
            if selected_at_level.contains(&sibling_id) {
                if let Some(target_id) = target_id.as_ref() {
                    selected_by_target
                        .entry(target_id.clone())
                        .or_default()
                        .push(sibling_id);
                } else {
                    remaining_siblings.push(sibling_id);
                }
            } else {
                target_id = Some(sibling_id.clone());
                remaining_siblings.push(sibling_id);
            }
        }

        for (target_id, selected) in selected_by_target {
            let mut children = plan_item_sibling_ids(connection, plan_id, Some(&target_id))?;
            for item_id in selected {
                connection
                    .execute(
                        "update plan_items set parent_id = ?1 where id = ?2",
                        params![target_id, item_id],
                    )
                    .map_err(|error| error.to_string())?;
                children.push(item_id);
            }
            rewrite_plan_item_positions(connection, &children)?;
        }

        rewrite_plan_item_positions(connection, &remaining_siblings)?;
    }

    Ok(())
}

fn outdent_plan_item_row(connection: &Connection, item_id: &str) -> Result<(), String> {
    let Some(plan_id) = plan_item_plan_id_if_exists(connection, item_id)? else {
        return Ok(());
    };
    let Some(parent_id) = plan_item_parent_id(connection, item_id)? else {
        return Ok(());
    };
    let grandparent_id = plan_item_parent_id(connection, &parent_id)?;

    let child_siblings = plan_item_sibling_ids(connection, &plan_id, Some(&parent_id))?;
    let source_index = child_siblings
        .iter()
        .position(|id| id == item_id)
        .ok_or_else(|| "Outdent source is not in its sibling list".to_string())?;
    let remaining_child_siblings = child_siblings[..source_index].to_vec();
    let following_siblings = child_siblings[source_index + 1..].to_vec();

    let mut promoted_child_siblings = plan_item_sibling_ids(connection, &plan_id, Some(item_id))?;
    promoted_child_siblings.extend(following_siblings.iter().cloned());

    let mut grandparent_siblings =
        plan_item_sibling_ids(connection, &plan_id, grandparent_id.as_deref())?;
    grandparent_siblings.retain(|id| id != item_id);
    let parent_index = grandparent_siblings
        .iter()
        .position(|id| id == &parent_id)
        .ok_or_else(|| "Outdent parent is not in its sibling list".to_string())?;
    grandparent_siblings.insert(parent_index + 1, item_id.to_string());

    connection
        .execute(
            "update plan_items set parent_id = ?1 where id = ?2",
            params![grandparent_id, item_id],
        )
        .map_err(|error| error.to_string())?;

    for following_id in following_siblings {
        connection
            .execute(
                "update plan_items set parent_id = ?1 where id = ?2",
                params![item_id, following_id],
            )
            .map_err(|error| error.to_string())?;
    }

    rewrite_plan_item_positions(connection, &remaining_child_siblings)?;
    rewrite_plan_item_positions(connection, &promoted_child_siblings)?;
    rewrite_plan_item_positions(connection, &grandparent_siblings)
}

fn outdent_plan_items_row(
    connection: &Connection,
    plan_id: &str,
    item_ids: &[Value],
) -> Result<(), String> {
    // Mirror the front-end `outdentPlanItems`: the ids arrive in document order,
    // so outdenting each selected root individually from last to first keeps
    // sibling ordering and reuses the same following-sibling absorption that a
    // single outdent applies.
    for item_id in item_ids.iter().rev() {
        let item_id = item_id
            .as_str()
            .ok_or_else(|| "Expected string item id".to_string())?;
        let Some(item_plan_id) = plan_item_plan_id_if_exists(connection, item_id)? else {
            continue;
        };
        if item_plan_id != plan_id {
            continue;
        }

        outdent_plan_item_row(connection, item_id)?;
    }

    Ok(())
}

fn move_plan_item_to_position_row(
    connection: &Connection,
    item_id: &str,
    plan_id: &str,
    parent_id: Option<&str>,
    position: i64,
) -> Result<(), String> {
    let Some(current_plan_id) = plan_item_plan_id_if_exists(connection, item_id)? else {
        return Ok(());
    };
    let target_plan_exists = connection
        .query_row(
            "select 1 from plans where id = ?1",
            params![plan_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .is_some();
    if !target_plan_exists {
        return Ok(());
    }
    if let Some(parent_id) = parent_id {
        if plan_item_plan_id_if_exists(connection, parent_id)?.as_deref() != Some(plan_id) {
            return Ok(());
        }
    }
    let current_parent_id = plan_item_parent_id(connection, item_id)?;
    let mut current_siblings =
        plan_item_sibling_ids(connection, &current_plan_id, current_parent_id.as_deref())?;
    current_siblings.retain(|id| id != item_id);
    rewrite_plan_item_positions(connection, &current_siblings)?;

    let mut target_siblings = plan_item_sibling_ids(connection, plan_id, parent_id)?;
    target_siblings.retain(|id| id != item_id);
    let insert_index = usize::try_from(position)
        .unwrap_or(0)
        .min(target_siblings.len());
    target_siblings.insert(insert_index, item_id.to_string());

    connection
        .execute(
            "update plan_items set plan_id = ?1, parent_id = ?2 where id = ?3",
            params![plan_id, parent_id, item_id],
        )
        .map_err(|error| error.to_string())?;

    rewrite_plan_item_positions(connection, &target_siblings)
}

fn move_template_item_row(
    connection: &Connection,
    source_id: &str,
    target_id: &str,
    placement: &str,
) -> Result<(), String> {
    let Some(source_template_id) = template_item_template_id_if_exists(connection, source_id)?
    else {
        return Ok(());
    };
    if template_item_template_id_if_exists(connection, target_id)?.as_deref()
        != Some(&source_template_id)
    {
        return Ok(());
    }
    if source_id == target_id || template_item_contains(connection, source_id, target_id)? {
        return Ok(());
    }

    if placement == "inside" {
        let position =
            next_template_item_position(connection, &source_template_id, Some(target_id))?;
        connection
            .execute(
                "update template_items set parent_id = ?1, position = ?2 where id = ?3",
                params![target_id, position, source_id],
            )
            .map_err(|error| error.to_string())?;
        return Ok(());
    }

    let target_parent_id = template_item_parent_id(connection, target_id)?;
    let mut siblings =
        template_item_sibling_ids(connection, &source_template_id, target_parent_id.as_deref())?;
    siblings.retain(|id| id != source_id);
    let target_index = siblings
        .iter()
        .position(|id| id == target_id)
        .ok_or_else(|| "Template move target is not in its sibling list".to_string())?;
    let insert_index = if placement == "after" {
        target_index + 1
    } else {
        target_index
    };
    siblings.insert(insert_index, source_id.to_string());

    connection
        .execute(
            "update template_items set parent_id = ?1 where id = ?2",
            params![target_parent_id, source_id],
        )
        .map_err(|error| error.to_string())?;
    rewrite_template_item_positions(connection, &siblings)
}

fn move_template_item_within_level_row(
    connection: &Connection,
    item_id: &str,
    direction: &str,
) -> Result<(), String> {
    let Some(template_id) = template_item_template_id_if_exists(connection, item_id)? else {
        return Ok(());
    };
    let parent_id = template_item_parent_id(connection, item_id)?;
    let mut siblings = template_item_sibling_ids(connection, &template_id, parent_id.as_deref())?;
    let index = siblings
        .iter()
        .position(|id| id == item_id)
        .ok_or_else(|| "Template move source is not in its sibling list".to_string())?;
    let target_index = match direction {
        "up" if index > 0 => index - 1,
        "down" if index + 1 < siblings.len() => index + 1,
        _ => return Ok(()),
    };

    siblings.swap(index, target_index);
    rewrite_template_item_positions(connection, &siblings)
}

fn move_template_items_within_level_row(
    connection: &Connection,
    template_id: &str,
    item_ids: &[Value],
    direction: &str,
) -> Result<(), String> {
    let mut selected_by_parent: HashMap<Option<String>, Vec<String>> = HashMap::new();

    for item_id in item_ids {
        let item_id = item_id
            .as_str()
            .ok_or_else(|| "Expected string item id".to_string())?;
        let Some(item_template_id) = template_item_template_id_if_exists(connection, item_id)?
        else {
            continue;
        };
        if item_template_id != template_id {
            continue;
        }

        let parent_id = template_item_parent_id(connection, item_id)?;
        selected_by_parent
            .entry(parent_id)
            .or_default()
            .push(item_id.to_string());
    }

    for (parent_id, selected_ids) in selected_by_parent {
        let mut siblings =
            template_item_sibling_ids(connection, template_id, parent_id.as_deref())?;
        let mut changed = false;

        if direction == "up" {
            for index in 1..siblings.len() {
                if selected_ids.contains(&siblings[index])
                    && !selected_ids.contains(&siblings[index - 1])
                {
                    siblings.swap(index - 1, index);
                    changed = true;
                }
            }
        } else {
            for index in (0..siblings.len().saturating_sub(1)).rev() {
                if selected_ids.contains(&siblings[index])
                    && !selected_ids.contains(&siblings[index + 1])
                {
                    siblings.swap(index, index + 1);
                    changed = true;
                }
            }
        }

        if changed {
            rewrite_template_item_positions(connection, &siblings)?;
        }
    }

    Ok(())
}

fn indent_template_items_row(
    connection: &Connection,
    template_id: &str,
    item_ids: &[Value],
) -> Result<(), String> {
    let selected_ids = item_ids
        .iter()
        .map(|item_id| {
            item_id
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| "Expected string item id".to_string())
        })
        .collect::<Result<Vec<String>, String>>()?;
    let mut selected_by_parent: HashMap<Option<String>, Vec<String>> = HashMap::new();

    for item_id in &selected_ids {
        let Some(item_template_id) = template_item_template_id_if_exists(connection, item_id)?
        else {
            continue;
        };
        if item_template_id != template_id {
            continue;
        }

        selected_by_parent
            .entry(template_item_parent_id(connection, item_id)?)
            .or_default()
            .push(item_id.clone());
    }

    for (parent_id, selected_at_level) in selected_by_parent {
        let siblings = template_item_sibling_ids(connection, template_id, parent_id.as_deref())?;
        let mut remaining_siblings = Vec::new();
        let mut target_id: Option<String> = None;
        let mut selected_by_target: HashMap<String, Vec<String>> = HashMap::new();

        for sibling_id in siblings {
            if selected_at_level.contains(&sibling_id) {
                if let Some(target_id) = target_id.as_ref() {
                    selected_by_target
                        .entry(target_id.clone())
                        .or_default()
                        .push(sibling_id);
                } else {
                    remaining_siblings.push(sibling_id);
                }
            } else {
                target_id = Some(sibling_id.clone());
                remaining_siblings.push(sibling_id);
            }
        }

        for (target_id, selected) in selected_by_target {
            let mut children =
                template_item_sibling_ids(connection, template_id, Some(&target_id))?;
            for item_id in selected {
                connection
                    .execute(
                        "update template_items set parent_id = ?1 where id = ?2",
                        params![target_id, item_id],
                    )
                    .map_err(|error| error.to_string())?;
                children.push(item_id);
            }
            rewrite_template_item_positions(connection, &children)?;
        }

        rewrite_template_item_positions(connection, &remaining_siblings)?;
    }

    Ok(())
}

fn outdent_template_item_row(connection: &Connection, item_id: &str) -> Result<(), String> {
    let Some(template_id) = template_item_template_id_if_exists(connection, item_id)? else {
        return Ok(());
    };
    let Some(parent_id) = template_item_parent_id(connection, item_id)? else {
        return Ok(());
    };
    let grandparent_id = template_item_parent_id(connection, &parent_id)?;

    let child_siblings = template_item_sibling_ids(connection, &template_id, Some(&parent_id))?;
    let source_index = child_siblings
        .iter()
        .position(|id| id == item_id)
        .ok_or_else(|| "Template outdent source is not in its sibling list".to_string())?;
    let remaining_child_siblings = child_siblings[..source_index].to_vec();
    let following_siblings = child_siblings[source_index + 1..].to_vec();

    let mut promoted_child_siblings =
        template_item_sibling_ids(connection, &template_id, Some(item_id))?;
    promoted_child_siblings.extend(following_siblings.iter().cloned());

    let mut grandparent_siblings =
        template_item_sibling_ids(connection, &template_id, grandparent_id.as_deref())?;
    grandparent_siblings.retain(|id| id != item_id);
    let parent_index = grandparent_siblings
        .iter()
        .position(|id| id == &parent_id)
        .ok_or_else(|| "Template outdent parent is not in its sibling list".to_string())?;
    grandparent_siblings.insert(parent_index + 1, item_id.to_string());

    connection
        .execute(
            "update template_items set parent_id = ?1 where id = ?2",
            params![grandparent_id, item_id],
        )
        .map_err(|error| error.to_string())?;

    for following_id in following_siblings {
        connection
            .execute(
                "update template_items set parent_id = ?1 where id = ?2",
                params![item_id, following_id],
            )
            .map_err(|error| error.to_string())?;
    }

    rewrite_template_item_positions(connection, &remaining_child_siblings)?;
    rewrite_template_item_positions(connection, &promoted_child_siblings)?;
    rewrite_template_item_positions(connection, &grandparent_siblings)
}

fn outdent_template_items_row(
    connection: &Connection,
    template_id: &str,
    item_ids: &[Value],
) -> Result<(), String> {
    // Mirror the front-end `outdentTemplateItems`: process selected roots from
    // last to first so their document order and following siblings are kept.
    for item_id in item_ids.iter().rev() {
        let item_id = item_id
            .as_str()
            .ok_or_else(|| "Expected string item id".to_string())?;
        let Some(item_template_id) = template_item_template_id_if_exists(connection, item_id)?
        else {
            continue;
        };
        if item_template_id != template_id {
            continue;
        }

        outdent_template_item_row(connection, item_id)?;
    }

    Ok(())
}

fn move_template_item_to_position_row(
    connection: &Connection,
    item_id: &str,
    template_id: &str,
    parent_id: Option<&str>,
    position: i64,
) -> Result<(), String> {
    let Some(current_template_id) = template_item_template_id_if_exists(connection, item_id)?
    else {
        return Ok(());
    };
    let target_template_exists = connection
        .query_row(
            "select 1 from templates where id = ?1",
            params![template_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .is_some();
    if !target_template_exists {
        return Ok(());
    }
    if let Some(parent_id) = parent_id {
        if template_item_template_id_if_exists(connection, parent_id)?.as_deref()
            != Some(template_id)
        {
            return Ok(());
        }
    }
    let current_parent_id = template_item_parent_id(connection, item_id)?;
    let mut current_siblings = template_item_sibling_ids(
        connection,
        &current_template_id,
        current_parent_id.as_deref(),
    )?;
    current_siblings.retain(|id| id != item_id);
    rewrite_template_item_positions(connection, &current_siblings)?;

    let mut target_siblings = template_item_sibling_ids(connection, template_id, parent_id)?;
    target_siblings.retain(|id| id != item_id);
    let insert_index = usize::try_from(position)
        .unwrap_or(0)
        .min(target_siblings.len());
    target_siblings.insert(insert_index, item_id.to_string());

    connection
        .execute(
            "update template_items set template_id = ?1, parent_id = ?2 where id = ?3",
            params![template_id, parent_id, item_id],
        )
        .map_err(|error| error.to_string())?;

    rewrite_template_item_positions(connection, &target_siblings)
}

fn next_plan_item_position(
    connection: &Connection,
    plan_id: &str,
    parent_id: Option<&str>,
) -> Result<i64, String> {
    let mut statement = if parent_id.is_some() {
        connection
            .prepare("select coalesce(max(position), -1) + 1 from plan_items where plan_id = ?1 and parent_id = ?2")
    } else {
        connection.prepare(
            "select coalesce(max(position), -1) + 1 from plan_items where plan_id = ?1 and parent_id is null",
        )
    }
    .map_err(|error| error.to_string())?;

    if let Some(parent_id) = parent_id {
        statement
            .query_row(params![plan_id, parent_id], |row| row.get(0))
            .map_err(|error| error.to_string())
    } else {
        statement
            .query_row(params![plan_id], |row| row.get(0))
            .map_err(|error| error.to_string())
    }
}

fn next_template_item_position(
    connection: &Connection,
    template_id: &str,
    parent_id: Option<&str>,
) -> Result<i64, String> {
    let mut statement = if parent_id.is_some() {
        connection
            .prepare("select coalesce(max(position), -1) + 1 from template_items where template_id = ?1 and parent_id = ?2")
    } else {
        connection.prepare(
            "select coalesce(max(position), -1) + 1 from template_items where template_id = ?1 and parent_id is null",
        )
    }
    .map_err(|error| error.to_string())?;

    if let Some(parent_id) = parent_id {
        statement
            .query_row(params![template_id, parent_id], |row| row.get(0))
            .map_err(|error| error.to_string())
    } else {
        statement
            .query_row(params![template_id], |row| row.get(0))
            .map_err(|error| error.to_string())
    }
}

fn next_template_option_position(connection: &Connection, item_id: &str) -> Result<i64, String> {
    connection
        .query_row(
            "select coalesce(max(position), -1) + 1 from template_options where item_id = ?1",
            params![item_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())
}

fn plan_item_plan_id_if_exists(
    connection: &Connection,
    item_id: &str,
) -> Result<Option<String>, String> {
    connection
        .query_row(
            "select plan_id from plan_items where id = ?1",
            params![item_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn plan_item_parent_id(connection: &Connection, item_id: &str) -> Result<Option<String>, String> {
    connection
        .query_row(
            "select parent_id from plan_items where id = ?1",
            params![item_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())
}

fn plan_item_sibling_ids(
    connection: &Connection,
    plan_id: &str,
    parent_id: Option<&str>,
) -> Result<Vec<String>, String> {
    let mut statement = if parent_id.is_some() {
        connection.prepare(
            "select id from plan_items where plan_id = ?1 and parent_id = ?2 order by position, id",
        )
    } else {
        connection.prepare(
            "select id from plan_items where plan_id = ?1 and parent_id is null order by position, id",
        )
    }
    .map_err(|error| error.to_string())?;

    if let Some(parent_id) = parent_id {
        statement
            .query_map(params![plan_id, parent_id], |row| row.get(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<String>, _>>()
            .map_err(|error| error.to_string())
    } else {
        statement
            .query_map(params![plan_id], |row| row.get(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<String>, _>>()
            .map_err(|error| error.to_string())
    }
}

fn template_item_template_id_if_exists(
    connection: &Connection,
    item_id: &str,
) -> Result<Option<String>, String> {
    connection
        .query_row(
            "select template_id from template_items where id = ?1",
            params![item_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn template_item_parent_id(
    connection: &Connection,
    item_id: &str,
) -> Result<Option<String>, String> {
    connection
        .query_row(
            "select parent_id from template_items where id = ?1",
            params![item_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())
}

fn template_item_sibling_ids(
    connection: &Connection,
    template_id: &str,
    parent_id: Option<&str>,
) -> Result<Vec<String>, String> {
    let mut statement = if parent_id.is_some() {
        connection.prepare(
            "select id from template_items where template_id = ?1 and parent_id = ?2 order by position, id",
        )
    } else {
        connection.prepare(
            "select id from template_items where template_id = ?1 and parent_id is null order by position, id",
        )
    }
    .map_err(|error| error.to_string())?;

    if let Some(parent_id) = parent_id {
        statement
            .query_map(params![template_id, parent_id], |row| row.get(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<String>, _>>()
            .map_err(|error| error.to_string())
    } else {
        statement
            .query_map(params![template_id], |row| row.get(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<String>, _>>()
            .map_err(|error| error.to_string())
    }
}

fn template_item_contains(
    connection: &Connection,
    ancestor_id: &str,
    candidate_id: &str,
) -> Result<bool, String> {
    let mut descendants = connection
        .prepare(
            "
          with recursive descendants(id) as (
            select id from template_items where parent_id = ?1
            union all
            select template_items.id
            from template_items
            join descendants on template_items.parent_id = descendants.id
          )
          select 1 from descendants where id = ?2 limit 1
        ",
        )
        .map_err(|error| error.to_string())?;

    descendants
        .query_row(params![ancestor_id, candidate_id], |_| Ok(true))
        .optional()
        .map(|result| result.unwrap_or(false))
        .map_err(|error| error.to_string())
}

fn rewrite_plan_item_positions(connection: &Connection, ids: &[String]) -> Result<(), String> {
    for (position, id) in ids.iter().enumerate() {
        connection
            .execute(
                "update plan_items set position = ?1 where id = ?2",
                params![position as i64, id],
            )
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

fn rewrite_template_positions(connection: &Connection, ids: &[String]) -> Result<(), String> {
    for (position, id) in ids.iter().enumerate() {
        connection
            .execute(
                "update templates set position = ?1 where id = ?2",
                params![position as i64, id],
            )
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

fn rewrite_template_item_positions(connection: &Connection, ids: &[String]) -> Result<(), String> {
    for (position, id) in ids.iter().enumerate() {
        connection
            .execute(
                "update template_items set position = ?1 where id = ?2",
                params![position as i64, id],
            )
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

fn read_plan_by_date(connection: &Connection, date: &str) -> Result<Option<Value>, String> {
    let plan_id = connection
        .query_row(
            "select id from plans where date = ?1",
            params![date],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;

    match plan_id {
        Some(plan_id) => read_plan_by_id(connection, &plan_id),
        None => Ok(None),
    }
}

fn read_plan_by_id(connection: &Connection, plan_id: &str) -> Result<Option<Value>, String> {
    let row = connection
        .query_row(
            "
          select id, date, title, daily_reminder, generated_from_template_id, created_at
          from plans
          where id = ?1
        ",
            params![plan_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, String>(5)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;

    let Some((id, date, title, daily_reminder, generated_from_template_id, created_at)) = row
    else {
        return Ok(None);
    };

    Ok(Some(json!({
        "id": id,
        "date": date,
        "title": title,
        "dailyReminder": daily_reminder,
        "generatedFromTemplateId": generated_from_template_id,
        "createdAt": created_at,
        "items": read_plan_items(connection, plan_id, None)?,
    })))
}

fn read_plan_daily_reminder(
    connection: &Connection,
    plan_id: &str,
) -> Result<Option<String>, String> {
    connection
        .query_row(
            "select daily_reminder from plans where id = ?1",
            params![plan_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn read_plan_item_snapshot(
    connection: &Connection,
    item_id: &str,
) -> Result<Option<PlanItemSnapshot>, String> {
    let row = connection
        .query_row(
            "
          select plan_id, parent_id, position, text, html, done, start_minutes, end_minutes, time_hidden
          from plan_items
          where id = ?1
        ",
            params![item_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, Option<i64>>(6)?,
                    row.get::<_, Option<i64>>(7)?,
                    row.get::<_, Option<i64>>(8)?.map(|value| value != 0),
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;

    let Some((
        plan_id,
        parent_id,
        position,
        text,
        html,
        done,
        start_minutes,
        end_minutes,
        time_hidden,
    )) = row
    else {
        return Ok(None);
    };

    Ok(Some(PlanItemSnapshot {
        plan_id: plan_id.clone(),
        parent_id,
        position,
        item: json!({
            "id": item_id,
            "text": text,
            "html": html,
            "done": done != 0,
            "startMinutes": start_minutes,
            "endMinutes": end_minutes,
            "timeHidden": time_hidden,
            "children": read_plan_items(connection, &plan_id, Some(item_id))?,
        }),
    }))
}

fn read_plan_item_fields(
    connection: &Connection,
    item_id: &str,
) -> Result<Option<(String, String, bool, Option<i64>, Option<i64>, Option<bool>)>, String> {
    connection
        .query_row(
            "
          select text, html, done, start_minutes, end_minutes, time_hidden
          from plan_items
          where id = ?1
        ",
            params![item_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)? != 0,
                    row.get::<_, Option<i64>>(3)?,
                    row.get::<_, Option<i64>>(4)?,
                    row.get::<_, Option<i64>>(5)?.map(|value| value != 0),
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn read_template_name_and_updated_at(
    connection: &Connection,
    template_id: &str,
) -> Result<Option<(String, String)>, String> {
    connection
        .query_row(
            "select name, updated_at from templates where id = ?1",
            params![template_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn read_template_snapshot(
    connection: &Connection,
    template_id: &str,
) -> Result<Option<(i64, Value)>, String> {
    let row = connection
        .query_row(
            "select name, created_at, updated_at, position from templates where id = ?1",
            params![template_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;

    let Some((name, created_at, updated_at, position)) = row else {
        return Ok(None);
    };

    Ok(Some((
        position,
        json!({
            "id": template_id,
            "name": name,
            "createdAt": created_at,
            "updatedAt": updated_at,
            "items": read_template_items(connection, template_id, None)?,
        }),
    )))
}

fn build_move_template_undo(
    connection: &Connection,
    template_id: &str,
) -> Result<Option<Value>, String> {
    let position = connection
        .query_row(
            "select position from templates where id = ?1",
            params![template_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;

    Ok(position.map(|position| {
        storage_operation(
            "move_template_to_position",
            json!({ "templateId": template_id, "position": position }),
        )
    }))
}

fn read_template_item_snapshot(
    connection: &Connection,
    item_id: &str,
) -> Result<Option<TemplateItemSnapshot>, String> {
    let row = connection
        .query_row(
            "
          select template_id, parent_id, position, start_minutes, end_minutes, time_hidden
          from template_items
          where id = ?1
        ",
            params![item_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                    row.get::<_, Option<i64>>(4)?,
                    row.get::<_, Option<i64>>(5)?.map(|value| value != 0),
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;

    let Some((template_id, parent_id, position, start_minutes, end_minutes, time_hidden)) = row
    else {
        return Ok(None);
    };

    Ok(Some(TemplateItemSnapshot {
        template_id: template_id.clone(),
        parent_id,
        position,
        item: json!({
            "id": item_id,
            "startMinutes": start_minutes,
            "endMinutes": end_minutes,
            "timeHidden": time_hidden,
            "options": read_template_options(connection, item_id)?,
            "children": read_template_items(connection, &template_id, Some(item_id))?,
        }),
    }))
}

fn read_template_item_fields(
    connection: &Connection,
    item_id: &str,
) -> Result<Option<(Option<i64>, Option<i64>, Option<bool>)>, String> {
    connection
        .query_row(
            "select start_minutes, end_minutes, time_hidden from template_items where id = ?1",
            params![item_id],
            |row| {
                Ok((
                    row.get::<_, Option<i64>>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, Option<i64>>(2)?.map(|value| value != 0),
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn read_template_option_snapshot(
    connection: &Connection,
    option_id: &str,
) -> Result<Option<TemplateOptionSnapshot>, String> {
    let row = connection
        .query_row(
            "
          select item_id, text, html, probability, position
          from template_options
          where id = ?1
        ",
            params![option_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, f64>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;

    let Some((item_id, text, html, probability, position)) = row else {
        return Ok(None);
    };

    Ok(Some(TemplateOptionSnapshot {
        item_id,
        position,
        option: json!({
            "id": option_id,
            "text": text,
            "html": html,
            "probability": probability,
        }),
    }))
}

fn read_template_option_fields(
    connection: &Connection,
    option_id: &str,
) -> Result<Option<(String, String, f64)>, String> {
    connection
        .query_row(
            "select text, html, probability from template_options where id = ?1",
            params![option_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, f64>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())
}

fn current_timestamp_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn current_timestamp() -> String {
    format!("unix-ms-{}", current_timestamp_ms())
}

fn read_templates(connection: &Connection) -> Result<Vec<Value>, String> {
    let mut statement = connection
        .prepare("select id, name, created_at, updated_at from templates order by position, id")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|error| error.to_string())?;

    rows.map(|row| {
        let (id, name, created_at, updated_at) = row.map_err(|error| error.to_string())?;
        Ok(json!({
            "id": id,
            "name": name,
            "items": read_template_items(connection, &id, None)?,
            "createdAt": created_at,
            "updatedAt": updated_at,
        }))
    })
    .collect()
}

fn read_template_items(
    connection: &Connection,
    template_id: &str,
    parent_id: Option<&str>,
) -> Result<Vec<Value>, String> {
    let mut statement = if parent_id.is_some() {
        connection.prepare(
            "
          select id, start_minutes, end_minutes, time_hidden
          from template_items
          where template_id = ?1 and parent_id = ?2
          order by position, id
        ",
        )
    } else {
        connection.prepare(
            "
          select id, start_minutes, end_minutes, time_hidden
          from template_items
          where template_id = ?1 and parent_id is null
          order by position, id
        ",
        )
    }
    .map_err(|error| error.to_string())?;

    let ids = if let Some(parent_id) = parent_id {
        statement
            .query_map(params![template_id, parent_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, Option<i64>>(3)?.map(|value| value != 0),
                ))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    } else {
        statement
            .query_map(params![template_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, Option<i64>>(3)?.map(|value| value != 0),
                ))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    };

    ids.into_iter()
        .map(|(id, start_minutes, end_minutes, time_hidden)| {
            Ok(json!({
                "id": id,
                "startMinutes": start_minutes,
                "endMinutes": end_minutes,
                "timeHidden": time_hidden,
                "options": read_template_options(connection, &id)?,
                "children": read_template_items(connection, template_id, Some(&id))?,
            }))
        })
        .collect()
}

fn read_template_options(connection: &Connection, item_id: &str) -> Result<Vec<Value>, String> {
    let mut statement = connection
        .prepare(
            "select id, text, html, probability from template_options where item_id = ?1 order by position, id",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![item_id], |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "text": row.get::<_, String>(1)?,
                "html": row.get::<_, String>(2)?,
                "probability": row.get::<_, f64>(3)?,
            }))
        })
        .map_err(|error| error.to_string())?;

    rows.collect::<Result<Vec<Value>, _>>()
        .map_err(|error| error.to_string())
}

fn read_plans(connection: &Connection) -> Result<Vec<Value>, String> {
    let mut statement = connection
        .prepare(
            "select id, date, title, daily_reminder, generated_from_template_id, created_at from plans order by date desc, id",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, String>(5)?,
            ))
        })
        .map_err(|error| error.to_string())?;

    let plans = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);

    // Loading each item's children recursively used to issue one indexed query
    // for every item, including leaves. Undo reads the complete app state, so the
    // query count grew with all historical items. Fetch all rows once, preserve
    // sibling order inside parent buckets, then assemble each plan in memory.
    let mut item_buckets_by_plan = read_plan_item_buckets_by_plan(connection)?;

    plans
        .into_iter()
        .map(
            |(id, date, title, daily_reminder, generated_from_template_id, created_at)| {
                let items = item_buckets_by_plan
                    .remove(&id)
                    .map(|mut buckets| build_plan_item_tree(&mut buckets, None))
                    .unwrap_or_default();
                Ok(json!({
                    "id": id,
                    "date": date,
                    "title": title,
                    "dailyReminder": daily_reminder,
                    "generatedFromTemplateId": generated_from_template_id,
                    "createdAt": created_at,
                    "items": items,
                }))
            },
        )
        .collect()
}

struct StoredPlanItem {
    id: String,
    text: String,
    html: String,
    done: bool,
    start_minutes: Option<i64>,
    end_minutes: Option<i64>,
    time_hidden: Option<bool>,
}

type PlanItemBuckets = HashMap<Option<String>, Vec<StoredPlanItem>>;

fn read_plan_item_buckets_by_plan(
    connection: &Connection,
) -> Result<HashMap<String, PlanItemBuckets>, String> {
    let mut statement = connection
        .prepare(
            "
          select plan_id, parent_id, id, text, html, done, start_minutes, end_minutes, time_hidden
          from plan_items
          order by plan_id, parent_id, position, id
        ",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                StoredPlanItem {
                    id: row.get::<_, String>(2)?,
                    text: row.get::<_, String>(3)?,
                    html: row.get::<_, String>(4)?,
                    done: row.get::<_, i64>(5)? != 0,
                    start_minutes: row.get::<_, Option<i64>>(6)?,
                    end_minutes: row.get::<_, Option<i64>>(7)?,
                    time_hidden: row.get::<_, Option<i64>>(8)?.map(|value| value != 0),
                },
            ))
        })
        .map_err(|error| error.to_string())?;

    let mut item_buckets_by_plan = HashMap::<String, PlanItemBuckets>::new();
    for row in rows {
        let (plan_id, parent_id, item) = row.map_err(|error| error.to_string())?;
        item_buckets_by_plan
            .entry(plan_id)
            .or_default()
            .entry(parent_id)
            .or_default()
            .push(item);
    }
    Ok(item_buckets_by_plan)
}

fn build_plan_item_tree(item_buckets: &mut PlanItemBuckets, parent_id: Option<&str>) -> Vec<Value> {
    let items = item_buckets
        .remove(&parent_id.map(str::to_owned))
        .unwrap_or_default();

    items
        .into_iter()
        .map(|item| {
            let children = build_plan_item_tree(item_buckets, Some(&item.id));
            json!({
                "id": item.id,
                "text": item.text,
                "html": item.html,
                "done": item.done,
                "startMinutes": item.start_minutes,
                "endMinutes": item.end_minutes,
                "timeHidden": item.time_hidden,
                "children": children,
            })
        })
        .collect()
}

fn read_plan_items(
    connection: &Connection,
    plan_id: &str,
    parent_id: Option<&str>,
) -> Result<Vec<Value>, String> {
    let mut statement = if parent_id.is_some() {
        connection.prepare(
            "
          select id, text, html, done, start_minutes, end_minutes, time_hidden
          from plan_items
          where plan_id = ?1 and parent_id = ?2
          order by position, id
        ",
        )
    } else {
        connection.prepare(
            "
          select id, text, html, done, start_minutes, end_minutes, time_hidden
          from plan_items
          where plan_id = ?1 and parent_id is null
          order by position, id
        ",
        )
    }
    .map_err(|error| error.to_string())?;

    let rows = if let Some(parent_id) = parent_id {
        statement.query_map(params![plan_id, parent_id], plan_item_from_row)
    } else {
        statement.query_map(params![plan_id], plan_item_from_row)
    }
    .map_err(|error| error.to_string())?;

    rows.map(|row| {
        let mut item = row.map_err(|error| error.to_string())?;
        let item_id = item["id"].as_str().unwrap_or_default().to_string();
        item["children"] = json!(read_plan_items(connection, plan_id, Some(&item_id))?);
        Ok(item)
    })
    .collect()
}

fn plan_item_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": row.get::<_, String>(0)?,
        "text": row.get::<_, String>(1)?,
        "html": row.get::<_, String>(2)?,
        "done": row.get::<_, i64>(3)? != 0,
        "startMinutes": row.get::<_, Option<i64>>(4)?,
        "endMinutes": row.get::<_, Option<i64>>(5)?,
        "timeHidden": row.get::<_, Option<i64>>(6)?.map(|value| value != 0),
        "children": [],
    }))
}

#[cfg(test)]
fn read_operations(connection: &Connection) -> Result<Vec<Value>, String> {
    let mut statement = connection
        .prepare(
            "
          select id, device_id, sequence, type, timestamp, payload_json
          from operations
          order by sequence, id
        ",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            let payload_json: String = row.get(5)?;
            let payload = serde_json::from_str::<Value>(&payload_json).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    5,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;

            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "deviceId": row.get::<_, String>(1)?,
                "sequence": row.get::<_, i64>(2)?,
                "type": row.get::<_, String>(3)?,
                "timestamp": row.get::<_, String>(4)?,
                "payload": payload,
            }))
        })
        .map_err(|error| error.to_string())?;

    rows.collect::<Result<Vec<Value>, _>>()
        .map_err(|error| error.to_string())
}

fn parse_json(raw: &str) -> Result<Value, String> {
    serde_json::from_str(raw).map_err(|error| error.to_string())
}

fn required_value<'a>(value: &'a Value, key: &str) -> Result<&'a Value, String> {
    value
        .get(key)
        .ok_or_else(|| format!("Missing required field: {key}"))
}

fn required_array<'a>(value: &'a Value, key: &str) -> Result<&'a Vec<Value>, String> {
    required_value(value, key)?
        .as_array()
        .ok_or_else(|| format!("Expected array field: {key}"))
}

fn required_string<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    required_value(value, key)?
        .as_str()
        .ok_or_else(|| format!("Expected string field: {key}"))
}

fn optional_string(value: &Value, key: &str) -> Result<Option<String>, String> {
    match value.get(key) {
        Some(Value::Null) | None => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.clone())),
        _ => Err(format!("Expected nullable string field: {key}")),
    }
}

fn required_i64(value: &Value, key: &str) -> Result<i64, String> {
    required_value(value, key)?
        .as_i64()
        .ok_or_else(|| format!("Expected integer field: {key}"))
}

fn optional_i64(value: &Value, key: &str) -> Result<Option<i64>, String> {
    match value.get(key) {
        Some(Value::Null) | None => Ok(None),
        Some(number) => number
            .as_i64()
            .map(Some)
            .ok_or_else(|| format!("Expected nullable integer field: {key}")),
    }
}

fn number_value(value: &Value, key: &str) -> Result<f64, String> {
    required_value(value, key)?
        .as_f64()
        .ok_or_else(|| format!("Expected number field: {key}"))
}

fn bool_value(value: &Value, key: &str) -> Result<bool, String> {
    required_value(value, key)?
        .as_bool()
        .ok_or_else(|| format!("Expected boolean field: {key}"))
}

fn optional_bool(value: &Value, key: &str) -> Result<Option<bool>, String> {
    match value.get(key) {
        Some(Value::Null) | None => Ok(None),
        Some(boolean) => boolean
            .as_bool()
            .map(Some)
            .ok_or_else(|| format!("Expected nullable boolean field: {key}")),
    }
}

fn patch_has_key(value: &Value, key: &str) -> bool {
    value.get(key).is_some()
}

#[cfg(not(target_os = "android"))]
fn keychain_entry(account: &str) -> Result<Entry, String> {
    Entry::new(KEYCHAIN_SERVICE, account).map_err(|error| error.to_string())
}

#[cfg(not(target_os = "android"))]
fn optional_keychain_password(account: &str) -> Result<Option<String>, String> {
    match keychain_entry(account)?.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(not(target_os = "android"))]
fn set_verified_keychain_password(account: &str, password: &str) -> Result<(), String> {
    let entry = keychain_entry(account)?;
    entry
        .set_password(password)
        .map_err(|error| error.to_string())?;
    let stored = entry.get_password().map_err(|error| error.to_string())?;
    if stored != password {
        return Err(format!(
            "The system credential store did not verify {account}."
        ));
    }
    Ok(())
}

#[cfg(not(target_os = "android"))]
fn delete_keychain_password_if_present(account: &str) -> Result<(), String> {
    match keychain_entry(account)?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(not(target_os = "android"))]
fn archived_recovery_key_account() -> String {
    let mut random = [0_u8; 3];
    OsRng.fill_bytes(&mut random);
    format!(
        "{KEYCHAIN_ARCHIVED_ACCOUNT_PREFIX}-{}-{}",
        current_timestamp_ms(),
        random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

#[cfg(not(target_os = "android"))]
struct KeychainRecoveryKeyRotationStore;

#[cfg(not(target_os = "android"))]
impl RecoveryKeyRotationStore for KeychainRecoveryKeyRotationStore {
    fn stage(&mut self, old_key: &str, new_key: &str, archive_account: &str) -> Result<(), String> {
        set_verified_keychain_password(archive_account, old_key)?;
        if let Err(error) =
            set_verified_keychain_password(KEYCHAIN_RAW_ROTATION_PENDING_ACCOUNT, new_key)
        {
            let _ = delete_keychain_password_if_present(archive_account);
            return Err(format!(
                "Could not stage the replacement recovery key: {error}"
            ));
        }
        Ok(())
    }

    fn commit(&mut self, new_key: &str) -> Result<(), String> {
        set_verified_keychain_password(KEYCHAIN_RAW_ACCOUNT, new_key)
            .map_err(|error| format!("Could not activate the replacement recovery key: {error}"))
    }

    fn finish(&mut self) -> Result<(), String> {
        delete_keychain_password_if_present(KEYCHAIN_RAW_ROTATION_PENDING_ACCOUNT)
    }

    fn abort(&mut self, old_key: &str, archive_account: &str) -> Result<(), String> {
        set_verified_keychain_password(KEYCHAIN_RAW_ACCOUNT, old_key)?;
        delete_keychain_password_if_present(KEYCHAIN_RAW_ROTATION_PENDING_ACCOUNT)?;
        delete_keychain_password_if_present(archive_account)
    }
}

#[cfg(not(target_os = "android"))]
#[derive(Debug, Eq, PartialEq)]
enum InterruptedKeyRotationAction {
    NoDatabaseOrRotation,
    KeepActive,
    ActivatePending,
    RestoreActiveRollback,
    InstallPendingWorking,
}

#[cfg(not(target_os = "android"))]
fn interrupted_key_rotation_action(
    database_path: &Path,
    working_path: &Path,
    rollback_path: &Path,
    active_key: Option<&str>,
    pending_key: Option<&str>,
) -> Result<InterruptedKeyRotationAction, String> {
    if let Some(pending_key) = pending_key {
        if database_key_matches(database_path, pending_key) {
            return Ok(InterruptedKeyRotationAction::ActivatePending);
        }
        if active_key.is_some_and(|key| database_key_matches(database_path, key)) {
            return Ok(InterruptedKeyRotationAction::KeepActive);
        }
        if active_key.is_some_and(|key| database_key_matches(rollback_path, key)) {
            return Ok(InterruptedKeyRotationAction::RestoreActiveRollback);
        }
        if !database_path.exists() && database_key_matches(working_path, pending_key) {
            return Ok(InterruptedKeyRotationAction::InstallPendingWorking);
        }
        return Err(
            "An interrupted database-key rotation could not match the database to either retained key. No files or credentials were removed."
                .to_string(),
        );
    }

    if active_key.is_some_and(|key| database_key_matches(database_path, key)) {
        return Ok(InterruptedKeyRotationAction::KeepActive);
    }
    if active_key.is_some_and(|key| database_key_matches(rollback_path, key)) {
        return Ok(InterruptedKeyRotationAction::RestoreActiveRollback);
    }
    if !database_path.exists()
        && active_key.is_none()
        && !working_path.exists()
        && !rollback_path.exists()
    {
        return Ok(InterruptedKeyRotationAction::NoDatabaseOrRotation);
    }
    Err(
        "The active database key does not match the database or its retained rotation copy. No files or credentials were removed."
            .to_string(),
    )
}

#[cfg(not(target_os = "android"))]
fn recover_interrupted_key_rotation(
    database_path: &Path,
    active_key: Option<String>,
) -> Result<Option<String>, String> {
    let pending_key = optional_keychain_password(KEYCHAIN_RAW_ROTATION_PENDING_ACCOUNT)?;
    let (working_path, rollback_path) = key_rotation_paths(database_path)?;
    let action = interrupted_key_rotation_action(
        database_path,
        &working_path,
        &rollback_path,
        active_key.as_deref(),
        pending_key.as_deref(),
    )?;

    let selected_key = match action {
        InterruptedKeyRotationAction::NoDatabaseOrRotation => return Ok(None),
        InterruptedKeyRotationAction::KeepActive => {
            if pending_key.is_some() {
                delete_keychain_password_if_present(KEYCHAIN_RAW_ROTATION_PENDING_ACCOUNT)?;
            }
            active_key
        }
        InterruptedKeyRotationAction::ActivatePending => {
            let pending_key = pending_key.expect("action requires pending key");
            set_verified_keychain_password(KEYCHAIN_RAW_ACCOUNT, &pending_key)?;
            delete_keychain_password_if_present(KEYCHAIN_RAW_ROTATION_PENDING_ACCOUNT)?;
            Some(pending_key)
        }
        InterruptedKeyRotationAction::RestoreActiveRollback => {
            restore_database_after_failed_rotation(&rollback_path, database_path)?;
            if pending_key.is_some() {
                delete_keychain_password_if_present(KEYCHAIN_RAW_ROTATION_PENDING_ACCOUNT)?;
            }
            active_key
        }
        InterruptedKeyRotationAction::InstallPendingWorking => {
            install_rotated_database(&working_path, database_path)?;
            let pending_key = pending_key.expect("action requires pending key");
            set_verified_keychain_password(KEYCHAIN_RAW_ACCOUNT, &pending_key)?;
            delete_keychain_password_if_present(KEYCHAIN_RAW_ROTATION_PENDING_ACCOUNT)?;
            Some(pending_key)
        }
    };

    if working_path.exists() {
        let _ = fs::remove_file(&working_path);
    }
    if rollback_path.exists() {
        let _ = fs::remove_file(&rollback_path);
    }
    Ok(selected_key)
}

#[cfg(not(target_os = "android"))]
fn database_recovery_key(database_path: &PathBuf) -> Result<String, String> {
    let active_key = optional_keychain_password(KEYCHAIN_RAW_ACCOUNT)?;
    let (working_path, rollback_path) = key_rotation_paths(database_path)?;
    let has_raw_rotation_state = optional_keychain_password(KEYCHAIN_RAW_ROTATION_PENDING_ACCOUNT)?
        .is_some()
        || working_path.exists()
        || rollback_path.exists();
    if has_raw_rotation_state {
        return recover_interrupted_key_rotation(database_path, active_key)?.ok_or_else(|| {
            "Raw-key rotation state exists without a recoverable credential.".to_string()
        });
    }
    if let Some(active_key) = active_key {
        return Ok(active_key);
    }

    if !database_path.exists() {
        let recovery_key = generate_recovery_key();
        set_verified_keychain_password(KEYCHAIN_RAW_ACCOUNT, &recovery_key)?;
        Ok(recovery_key)
    } else {
        Err(missing_recovery_key_error())
    }
}

// Android has no OS keychain that the `keyring` crate supports. The SQLCipher
// recovery key is generated once, then encrypted with a non-exportable,
// hardware-backed AES-GCM key from the Android Keystore; only the ciphertext is
// written to a file in the app's private internal storage. The plaintext key
// therefore never touches disk.
#[cfg(target_os = "android")]
fn database_recovery_key(database_path: &PathBuf) -> Result<String, String> {
    // Android Keystore access can occasionally take many seconds while the OS
    // is finishing an unlock or restarting its provider. Once it has unlocked
    // this process's database, reuse the plaintext key in memory instead of
    // making every serialized database command repeat that hardware-backed IPC.
    if let Ok(cached) = ANDROID_DATABASE_RECOVERY_KEY.lock() {
        if let Some(recovery_key) = cached.as_ref() {
            return Ok(recovery_key.clone());
        }
    }

    let raw_path = raw_recovery_key_path(database_path);
    if raw_path.exists() {
        return read_android_recovery_key(&raw_path);
    }
    if database_path.exists() {
        return Err(missing_recovery_key_error());
    }

    let recovery_key = generate_recovery_key();
    write_wrapped_android_recovery_key(&raw_path, &recovery_key)?;
    Ok(recovery_key)
}

#[cfg(target_os = "android")]
fn read_android_recovery_key(key_path: &Path) -> Result<String, String> {
    match fs::read(key_path) {
        Ok(blob) => {
            // Android Keystore can briefly be unavailable while the device is
            // finishing an unlock or the provider process is restarting. A
            // transient failure must not make the intact database look empty.
            let mut last_error = None;
            let mut plaintext = None;
            for attempt in 0..3 {
                match android_keystore::unwrap_key(&blob) {
                    Ok(value) => {
                        plaintext = Some(value);
                        break;
                    }
                    Err(error) => {
                        last_error = Some(error);
                        if attempt < 2 {
                            std::thread::sleep(Duration::from_millis(75 * (attempt + 1)));
                        }
                    }
                }
            }
            let plaintext = plaintext.ok_or_else(|| {
                last_error
                    .unwrap_or_else(|| "Android Keystore did not return a recovery key".into())
            })?;
            let recovery_key = String::from_utf8(plaintext)
                .map_err(|error| error.to_string())?
                .trim()
                .to_string();
            if recovery_key.is_empty() {
                Err(missing_recovery_key_error())
            } else {
                Ok(recovery_key)
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Err(missing_recovery_key_error())
        }
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(target_os = "android")]
fn write_wrapped_android_recovery_key(key_path: &Path, recovery_key: &str) -> Result<(), String> {
    let blob = android_keystore::wrap_key(recovery_key.as_bytes())?;
    let verified = android_keystore::unwrap_key(&blob)?;
    if verified != recovery_key.as_bytes() {
        return Err("Android Keystore could not verify the wrapped recovery key.".to_string());
    }
    if let Some(parent) = key_path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    write_android_recovery_key(key_path, &blob)
}

#[cfg(target_os = "android")]
fn write_android_recovery_key(key_path: &Path, blob: &[u8]) -> Result<(), String> {
    let mut nonce = [0_u8; 4];
    OsRng.fill_bytes(&mut nonce);
    let temp_path = key_path.with_extension(format!(
        "enc.tmp-{}-{}",
        current_timestamp_ms(),
        nonce
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ));

    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp_path)
            .map_err(|error| error.to_string())?;
        file.write_all(blob).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        drop(file);
        fs::rename(&temp_path, key_path).map_err(|error| error.to_string())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

#[cfg(target_os = "android")]
fn raw_recovery_key_path(database_path: &PathBuf) -> PathBuf {
    database_path.with_file_name("balance-recovery-raw-v1.key.enc")
}

// Wraps/unwraps a secret with a hardware-backed AES-256-GCM key stored in the
// Android Keystore. The Keystore key is non-exportable; this code only ever
// hands it plaintext to encrypt or ciphertext to decrypt, over JNI.
#[cfg(target_os = "android")]
mod android_keystore {
    use std::ffi::c_void;
    use std::path::Path;
    use std::sync::OnceLock;

    use jni::objects::{GlobalRef, JByteArray, JClass, JObject, JString, JValue};
    use jni::{JNIEnv, JavaVM};
    use tauri::Manager;

    // Tauri/tao keep the JavaVM in their own private Android glue and don't
    // initialize the `ndk-context` crate, so we capture it ourselves when the
    // JVM loads this library. Keystore calls need only this VM; direct-sync
    // locks obtain the Activity through Tauri's supported JNI handle.
    static JAVA_VM: OnceLock<JavaVM> = OnceLock::new();

    #[no_mangle]
    pub extern "system" fn JNI_OnLoad(
        vm: *mut jni::sys::JavaVM,
        _reserved: *mut c_void,
    ) -> jni::sys::jint {
        if let Ok(vm) = unsafe { JavaVM::from_raw(vm) } {
            let _ = JAVA_VM.set(vm);
        }
        jni::sys::JNI_VERSION_1_6
    }

    const KEYSTORE_PROVIDER: &str = "AndroidKeyStore";
    const KEYSTORE_ALIAS: &str = "balance-db-recovery-key";
    const ENCRYPT_MODE: i32 = 1;
    const DECRYPT_MODE: i32 = 2;
    // KeyProperties.PURPOSE_ENCRYPT | PURPOSE_DECRYPT
    const PURPOSE_ENCRYPT_DECRYPT: i32 = 1 | 2;
    const GCM_TAG_BITS: i32 = 128;
    const AES_KEY_BITS: i32 = 256;
    const SYNC_WAKE_LOCK_TIMEOUT_MS: i64 = 10 * 60 * 1000;

    pub fn wrap_key(plaintext: &[u8]) -> Result<Vec<u8>, String> {
        with_env(|env| {
            encrypt(env, plaintext).map_err(|error| format!("Keystore wrap failed: {error}"))
        })
    }

    pub fn unwrap_key(blob: &[u8]) -> Result<Vec<u8>, String> {
        let (iv, ciphertext) = split_blob(blob)?;
        with_env(|env| {
            decrypt(env, iv, ciphertext).map_err(|error| format!("Keystore unwrap failed: {error}"))
        })
    }

    /// Keep the CPU and Wi-Fi radio awake only while an active direct sync is
    /// running. Android may otherwise suspend either one when the display goes
    /// dark, aborting an in-flight TCP connection.
    pub(crate) fn with_sync_wake_locks<T>(
        app: &tauri::AppHandle,
        work: impl FnOnce() -> T,
    ) -> Result<T, String> {
        let webview = app
            .get_webview_window("main")
            .ok_or_else(|| "The main Android webview is unavailable.".to_string())?;
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);

        webview
            .with_webview(move |webview| {
                webview.jni_handle().exec(move |env, activity, _webview| {
                    let result = acquire_sync_wake_locks(env, activity);
                    if result.is_err() && env.exception_check().unwrap_or(false) {
                        let _ = env.exception_describe();
                        let _ = env.exception_clear();
                    }
                    let _ = sender.send(result);
                });
            })
            .map_err(|error| format!("Could not access the Android activity: {error}"))?;

        let locks = receiver
            .recv()
            .map_err(|_| "Android wake-lock setup was interrupted.".to_string())??;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(work));
        release_sync_wake_locks(&locks);

        match result {
            Ok(value) => Ok(value),
            Err(payload) => std::panic::resume_unwind(payload),
        }
    }

    #[no_mangle]
    pub extern "system" fn Java_app_balance_local_BalanceSyncWorker_runNativeSync(
        mut env: JNIEnv,
        _class: JClass,
        app_data_path: JString,
    ) -> jni::sys::jint {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let path: String = env
                .get_string(&app_data_path)
                .map_err(|error| error.to_string())?
                .into();
            super::run_android_background_sync_at(Path::new(&path))
        }));
        match result {
            Ok(Ok(())) => 0,
            Ok(Err(error)) => {
                log::warn!("Android background relay sync will retry: {error}");
                1
            }
            Err(_) => {
                log::warn!("Android background relay sync panicked and will retry");
                1
            }
        }
    }

    struct SyncWakeLocks {
        cpu: GlobalRef,
        wifi: GlobalRef,
    }

    fn acquire_sync_wake_locks(
        env: &mut JNIEnv,
        activity: &JObject,
    ) -> Result<SyncWakeLocks, String> {
        let tag = env
            .new_string("Balance:directSync")
            .map_err(|error| error.to_string())?;
        let power_service = env.new_string("power").map_err(|error| error.to_string())?;
        let power_manager = env
            .call_method(
                activity,
                "getSystemService",
                "(Ljava/lang/String;)Ljava/lang/Object;",
                &[(&power_service).into()],
            )
            .and_then(|value| value.l())
            .map_err(|error| format!("Could not get Android PowerManager: {error}"))?;
        let cpu_lock = env
            .call_method(
                &power_manager,
                "newWakeLock",
                "(ILjava/lang/String;)Landroid/os/PowerManager$WakeLock;",
                &[1.into(), (&tag).into()], // PowerManager.PARTIAL_WAKE_LOCK
            )
            .and_then(|value| value.l())
            .map_err(|error| format!("Could not create Android wake lock: {error}"))?;

        let wifi_service = env.new_string("wifi").map_err(|error| error.to_string())?;
        let wifi_manager = env
            .call_method(
                activity,
                "getSystemService",
                "(Ljava/lang/String;)Ljava/lang/Object;",
                &[(&wifi_service).into()],
            )
            .and_then(|value| value.l())
            .map_err(|error| format!("Could not get Android WifiManager: {error}"))?;
        let wifi_lock = env
            .call_method(
                &wifi_manager,
                "createWifiLock",
                "(ILjava/lang/String;)Landroid/net/wifi/WifiManager$WifiLock;",
                &[3.into(), (&tag).into()], // WifiManager.WIFI_MODE_FULL_HIGH_PERF
            )
            .and_then(|value| value.l())
            .map_err(|error| format!("Could not create Android Wi-Fi lock: {error}"))?;

        env.call_method(&cpu_lock, "setReferenceCounted", "(Z)V", &[JValue::Bool(0)])
            .map_err(|error| format!("Could not configure Android wake lock: {error}"))?;
        env.call_method(
            &wifi_lock,
            "setReferenceCounted",
            "(Z)V",
            &[JValue::Bool(0)],
        )
        .map_err(|error| format!("Could not configure Android Wi-Fi lock: {error}"))?;

        // The timeout is a last-resort safeguard; both locks are explicitly
        // released as soon as this sync pass succeeds or fails.
        env.call_method(
            &cpu_lock,
            "acquire",
            "(J)V",
            &[JValue::Long(SYNC_WAKE_LOCK_TIMEOUT_MS)],
        )
        .map_err(|error| format!("Could not acquire Android wake lock: {error}"))?;
        if let Err(error) = env.call_method(&wifi_lock, "acquire", "()V", &[]) {
            let _ = env.call_method(&cpu_lock, "release", "()V", &[]);
            return Err(format!("Could not acquire Android Wi-Fi lock: {error}"));
        }

        let cpu = env.new_global_ref(&cpu_lock).map_err(|error| {
            let _ = env.call_method(&wifi_lock, "release", "()V", &[]);
            let _ = env.call_method(&cpu_lock, "release", "()V", &[]);
            format!("Could not retain Android wake lock: {error}")
        })?;
        let wifi = env.new_global_ref(&wifi_lock).map_err(|error| {
            let _ = env.call_method(&wifi_lock, "release", "()V", &[]);
            let _ = env.call_method(&cpu_lock, "release", "()V", &[]);
            format!("Could not retain Android Wi-Fi lock: {error}")
        })?;

        Ok(SyncWakeLocks { cpu, wifi })
    }

    fn release_sync_wake_locks(locks: &SyncWakeLocks) {
        if let Err(error) = with_env(|env| {
            if let Err(error) = env.call_method(locks.wifi.as_obj(), "release", "()V", &[]) {
                log::warn!("Could not release Android direct-sync Wi-Fi lock: {error}");
            }
            if let Err(error) = env.call_method(locks.cpu.as_obj(), "release", "()V", &[]) {
                log::warn!("Could not release Android direct-sync wake lock: {error}");
            }
            Ok(())
        }) {
            log::warn!("Could not attach to Android to release direct-sync locks: {error}");
        }
    }

    // Stored layout: [iv_len: u8][iv][ciphertext+tag].
    fn split_blob(blob: &[u8]) -> Result<(&[u8], &[u8]), String> {
        let (&iv_len, rest) = blob
            .split_first()
            .ok_or_else(|| "The recovery key file is empty.".to_string())?;
        if rest.len() < iv_len as usize {
            return Err("The recovery key file is corrupt.".to_string());
        }
        Ok(rest.split_at(iv_len as usize))
    }

    fn with_env<T>(f: impl FnOnce(&mut JNIEnv) -> Result<T, String>) -> Result<T, String> {
        let vm = JAVA_VM
            .get()
            .ok_or_else(|| "The Java VM was not captured when the library loaded.".to_string())?;
        let mut guard = vm
            .attach_current_thread()
            .map_err(|error| error.to_string())?;
        let result = f(&mut guard);
        let exception = take_pending_exception(&mut guard);
        match (result, exception) {
            (Err(error), Some(exception)) => Err(format!("{error}: {exception}")),
            (Ok(_), Some(exception)) => Err(format!("Android Keystore exception: {exception}")),
            (result, None) => result,
        }
    }

    fn take_pending_exception(env: &mut JNIEnv) -> Option<String> {
        if !env.exception_check().ok()? {
            return None;
        }
        let throwable = env.exception_occurred().ok()?;
        let _ = env.exception_clear();
        let text = env
            .call_method(&throwable, "toString", "()Ljava/lang/String;", &[])
            .and_then(|value| value.l())
            .ok()
            .and_then(|value| env.get_string(&JString::from(value)).ok().map(Into::into));
        if env.exception_check().unwrap_or(false) {
            let _ = env.exception_clear();
        }
        text
    }

    fn encrypt(env: &mut JNIEnv, plaintext: &[u8]) -> Result<Vec<u8>, jni::errors::Error> {
        let key = get_or_create_key(env)?;
        let cipher = new_cipher(env)?;
        env.call_method(
            &cipher,
            "init",
            "(ILjava/security/Key;)V",
            &[ENCRYPT_MODE.into(), (&key).into()],
        )?;

        let iv_obj = env.call_method(&cipher, "getIV", "()[B", &[])?.l()?;
        let iv = env.convert_byte_array(JByteArray::from(iv_obj))?;
        let input = env.byte_array_from_slice(plaintext)?;
        let ciphertext_obj = env
            .call_method(&cipher, "doFinal", "([B)[B", &[(&input).into()])?
            .l()?;
        let ciphertext = env.convert_byte_array(JByteArray::from(ciphertext_obj))?;

        let mut blob = Vec::with_capacity(1 + iv.len() + ciphertext.len());
        blob.push(iv.len() as u8);
        blob.extend_from_slice(&iv);
        blob.extend_from_slice(&ciphertext);
        Ok(blob)
    }

    fn decrypt(
        env: &mut JNIEnv,
        iv: &[u8],
        ciphertext: &[u8],
    ) -> Result<Vec<u8>, jni::errors::Error> {
        // Decryption must never create a replacement alias. A newly generated
        // key cannot open the existing blob and hides the real recovery issue.
        let key = get_existing_key(env)?;
        let cipher = new_cipher(env)?;

        let iv_arr = env.byte_array_from_slice(iv)?;
        let gcm_spec = env.new_object(
            "javax/crypto/spec/GCMParameterSpec",
            "(I[B)V",
            &[GCM_TAG_BITS.into(), (&iv_arr).into()],
        )?;
        env.call_method(
            &cipher,
            "init",
            "(ILjava/security/Key;Ljava/security/spec/AlgorithmParameterSpec;)V",
            &[DECRYPT_MODE.into(), (&key).into(), (&gcm_spec).into()],
        )?;

        let input = env.byte_array_from_slice(ciphertext)?;
        let plaintext_obj = env
            .call_method(&cipher, "doFinal", "([B)[B", &[(&input).into()])?
            .l()?;
        env.convert_byte_array(JByteArray::from(plaintext_obj))
    }

    fn new_cipher<'local>(env: &mut JNIEnv<'local>) -> Result<JObject<'local>, jni::errors::Error> {
        let transformation = env.new_string("AES/GCM/NoPadding")?;
        env.call_static_method(
            "javax/crypto/Cipher",
            "getInstance",
            "(Ljava/lang/String;)Ljavax/crypto/Cipher;",
            &[(&transformation).into()],
        )?
        .l()
    }

    fn get_or_create_key<'local>(
        env: &mut JNIEnv<'local>,
    ) -> Result<JObject<'local>, jni::errors::Error> {
        let alias = env.new_string(KEYSTORE_ALIAS)?;
        let provider = env.new_string(KEYSTORE_PROVIDER)?;

        let key_store = env
            .call_static_method(
                "java/security/KeyStore",
                "getInstance",
                "(Ljava/lang/String;)Ljava/security/KeyStore;",
                &[(&provider).into()],
            )?
            .l()?;
        env.call_method(
            &key_store,
            "load",
            "(Ljava/security/KeyStore$LoadStoreParameter;)V",
            &[(&JObject::null()).into()],
        )?;

        let exists = env
            .call_method(
                &key_store,
                "containsAlias",
                "(Ljava/lang/String;)Z",
                &[(&alias).into()],
            )?
            .z()?;
        if exists {
            return env
                .call_method(
                    &key_store,
                    "getKey",
                    "(Ljava/lang/String;[C)Ljava/security/Key;",
                    &[(&alias).into(), (&JObject::null()).into()],
                )?
                .l();
        }

        let generator = env
            .call_static_method(
                "javax/crypto/KeyGenerator",
                "getInstance",
                "(Ljava/lang/String;Ljava/lang/String;)Ljavax/crypto/KeyGenerator;",
                &[(&env.new_string("AES")?).into(), (&provider).into()],
            )?
            .l()?;

        let builder = env.new_object(
            "android/security/keystore/KeyGenParameterSpec$Builder",
            "(Ljava/lang/String;I)V",
            &[(&alias).into(), PURPOSE_ENCRYPT_DECRYPT.into()],
        )?;
        let block_modes = string_array(env, "GCM")?;
        env.call_method(
            &builder,
            "setBlockModes",
            "([Ljava/lang/String;)Landroid/security/keystore/KeyGenParameterSpec$Builder;",
            &[(&block_modes).into()],
        )?;
        let paddings = string_array(env, "NoPadding")?;
        env.call_method(
            &builder,
            "setEncryptionPaddings",
            "([Ljava/lang/String;)Landroid/security/keystore/KeyGenParameterSpec$Builder;",
            &[(&paddings).into()],
        )?;
        env.call_method(
            &builder,
            "setKeySize",
            "(I)Landroid/security/keystore/KeyGenParameterSpec$Builder;",
            &[AES_KEY_BITS.into()],
        )?;
        let spec = env
            .call_method(
                &builder,
                "build",
                "()Landroid/security/keystore/KeyGenParameterSpec;",
                &[],
            )?
            .l()?;

        env.call_method(
            &generator,
            "init",
            "(Ljava/security/spec/AlgorithmParameterSpec;)V",
            &[(&spec).into()],
        )?;
        env.call_method(&generator, "generateKey", "()Ljavax/crypto/SecretKey;", &[])?
            .l()
    }

    fn get_existing_key<'local>(
        env: &mut JNIEnv<'local>,
    ) -> Result<JObject<'local>, jni::errors::Error> {
        let alias = env.new_string(KEYSTORE_ALIAS)?;
        let provider = env.new_string(KEYSTORE_PROVIDER)?;
        let key_store = env
            .call_static_method(
                "java/security/KeyStore",
                "getInstance",
                "(Ljava/lang/String;)Ljava/security/KeyStore;",
                &[(&provider).into()],
            )?
            .l()?;
        env.call_method(
            &key_store,
            "load",
            "(Ljava/security/KeyStore$LoadStoreParameter;)V",
            &[(&JObject::null()).into()],
        )?;
        env.call_method(
            &key_store,
            "getKey",
            "(Ljava/lang/String;[C)Ljava/security/Key;",
            &[(&alias).into(), (&JObject::null()).into()],
        )?
        .l()
    }

    fn string_array<'local>(
        env: &mut JNIEnv<'local>,
        value: &str,
    ) -> Result<JObject<'local>, jni::errors::Error> {
        let element = env.new_string(value)?;
        let array = env.new_object_array(1, "java/lang/String", &element)?;
        Ok(array.into())
    }
}

#[cfg(target_os = "android")]
fn run_android_background_sync_at(data_dir: &Path) -> Result<(), String> {
    let _guard = database_access_guard()?;
    let database_path = app_database_path_from_data_dir(data_dir);
    if !database_path.exists() {
        return Ok(());
    }
    let recovery_key = database_recovery_key(&database_path)?;
    let connection = open_database_at(&database_path, &recovery_key)?;
    cache_android_recovery_key(recovery_key.clone());
    if !sync::is_sync_enabled(&connection).map_err(sync::Error::into_string)? {
        return Ok(());
    }
    let Some(relay_url) =
        metadata_value(&connection, SYNC_RELAY_URL)?.filter(|value| !value.is_empty())
    else {
        return Ok(());
    };
    let Some(pairing_code) =
        sync::read_pairing_code(&connection).map_err(sync::Error::into_string)?
    else {
        return Ok(());
    };
    let key = sync::crypto::SyncKey::from_pairing_code(&pairing_code)
        .map_err(sync::Error::into_string)?;
    // Background work is capped by Android. Apply ordinary incremental batches
    // here; potentially large checkpoint promotion waits for the foreground.
    sync::relay_client::sync_once(
        &connection,
        &relay_url,
        &key,
        sync::relay_client::SyncOptions::background(),
    )
    .map(|_| ())
    .map_err(sync::Error::into_string)
}

fn missing_recovery_key_error() -> String {
    "The encrypted Balance database exists, but its recovery key is not in this keychain."
        .to_string()
}

fn generate_recovery_key() -> String {
    database_keys::RecoveryKey::generate()
        .canonical()
        .to_string()
}

fn app_database_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .data_dir()
        .map(|directory| directory.join(APP_DATA_DIR).join(APP_DATABASE_FILE))
        .map_err(|error| error.to_string())
}

#[cfg(any(test, target_os = "android"))]
fn app_database_path_from_data_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(APP_DATA_DIR).join(APP_DATABASE_FILE)
}

// ---------------------------------------------------------------------------
// Multi-device sync command surface (see src/sync).
// ---------------------------------------------------------------------------

/// Open the encrypted DB and run `task`. Sync replicates the `operations` log
/// as ordinary rows, so a writing connection needs nothing beyond the normal
/// open path whether or not sync is enabled.
fn with_database<T>(
    app: &tauri::AppHandle,
    task: impl FnOnce(&mut Connection) -> Result<T, String>,
) -> Result<T, String> {
    let mut connection = open_database(app)?;
    task(&mut connection)
}

/// Write a timestamped JSON backup of the current state into the app data dir,
/// so enabling sync (which rewrites the operation log) can never lose data.
fn backup_state_before_sync(app: &tauri::AppHandle, connection: &Connection) -> Result<(), String> {
    let Some(state) = read_app_state_from_database(connection)? else {
        return Ok(()); // nothing to back up yet
    };
    let dir = app_database_path(app)?
        .parent()
        .ok_or_else(|| "no data dir".to_string())?
        .join("backups");
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let stamp = current_timestamp().replace([':', '.'], "-");
    let path = dir.join(format!("pre-sync-{stamp}.json"));
    fs::write(
        &path,
        serde_json::to_vec_pretty(&state).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn sync_settings_from_database(connection: &Connection) -> Result<SyncSettings, String> {
    Ok(SyncSettings {
        enabled: sync::is_sync_enabled(connection).map_err(sync::Error::into_string)?,
        pairing_code: sync::read_pairing_code(connection).map_err(sync::Error::into_string)?,
        relay_url: metadata_value(connection, SYNC_RELAY_URL)?.unwrap_or_default(),
    })
}

/// Device-local sync configuration. This metadata lives in the encrypted DB but
/// is not part of the replicated `operations` CRR, so dev and production share
/// it on one device without sending it to peers.
#[tauri::command]
async fn get_sync_settings(app: tauri::AppHandle) -> Result<SyncSettings, String> {
    run_database_task(move || {
        let startup = take_startup_database_connection(&app, StartupDatabaseRead::SyncSettings)?;
        let result = sync_settings_from_database(&startup.connection);
        if let Ok(settings) = &result {
            let relay_required = settings.enabled
                && settings.pairing_code.is_some()
                && !settings.relay_url.is_empty();
            finish_startup_database_read(
                startup,
                StartupDatabaseRead::SyncSettings,
                Some(relay_required),
            );
        }
        result
    })
    .await
}

#[tauri::command]
async fn set_sync_relay_url(
    app: tauri::AppHandle,
    relay_url: String,
) -> Result<SyncSettings, String> {
    run_database_task(move || {
        let connection = open_database(&app)?;
        let relay_url = normalize_sync_relay_url(&relay_url)?;
        if relay_url.is_empty() {
            delete_metadata(&connection, SYNC_RELAY_URL)?;
        } else {
            set_metadata(&connection, SYNC_RELAY_URL, &relay_url)?;
        }
        sync_settings_from_database(&connection)
    })
    .await
}

/// Generate a fresh account sync key and return its QR/pairing code. The new
/// device scans this; both devices then share the same end-to-end key.
#[tauri::command]
async fn sync_new_pairing_code() -> Result<String, String> {
    Ok(sync::crypto::SyncKey::generate().to_pairing_code())
}

/// Trim and fully validate a pairing code before sync setup touches the
/// database. Checking only the prefix is unsafe: enabling a joiner clears its
/// local materialized state in preparation for bootstrap, so a malformed key
/// must be rejected before that work begins.
fn normalize_sync_pairing_code(pairing_code: &str) -> Result<String, String> {
    let pairing_code = pairing_code.trim();
    sync::crypto::SyncKey::from_pairing_code(pairing_code).map_err(sync::Error::into_string)?;
    Ok(pairing_code.to_string())
}

/// Enable sync as the **primary** device: keep this device's data as the shared
/// baseline (snapshots it into the synced operation log). Backs up first. The
/// pairing code is stored (in the encrypted DB) so the P2P listener can use it.
#[tauri::command]
async fn sync_enable_primary(app: tauri::AppHandle, pairing_code: String) -> Result<(), String> {
    let pairing_code = normalize_sync_pairing_code(&pairing_code)?;
    run_database_task(move || {
        let connection = open_database(&app)?;
        backup_state_before_sync(&app, &connection)?;
        sync::enable_primary(&connection).map_err(sync::Error::into_string)?;
        sync::store_pairing_code(&connection, &pairing_code).map_err(sync::Error::into_string)?;
        set_metadata(&connection, SYNC_COMPACTION_COORDINATOR, "true")
    })
    .await
}

/// Enable sync as a **joining** device: adopt the primary's data, clearing this
/// device's local data (which is backed up first).
#[tauri::command]
async fn sync_enable_joiner(app: tauri::AppHandle, pairing_code: String) -> Result<(), String> {
    let pairing_code = normalize_sync_pairing_code(&pairing_code)?;
    run_database_task(move || {
        let connection = open_database(&app)?;
        backup_state_before_sync(&app, &connection)?;
        sync::enable_joiner(&connection).map_err(sync::Error::into_string)?;
        sync::store_pairing_code(&connection, &pairing_code).map_err(sync::Error::into_string)?;
        set_metadata(&connection, SYNC_COMPACTION_COORDINATOR, "false")
    })
    .await
}

/// Perform one complete incremental relay pass. All automatic and manual
/// triggers share this command so retries, cursors, outbox durability, and
/// checkpoint races have exactly one implementation.
#[tauri::command]
async fn sync_relay_once(
    app: tauri::AppHandle,
    reason: String,
) -> Result<sync::relay_client::SyncPassResult, String> {
    let _ = reason;
    run_foreground_relay_task(move |gate| {
        let startup = take_startup_database_connection(&app, StartupDatabaseRead::RelaySync)?;
        let result = (|| {
            let connection = &startup.connection;
            if !sync::is_sync_enabled(connection).map_err(sync::Error::into_string)? {
                return Err("Sync is not enabled on this device.".to_string());
            }
            let relay_url = metadata_value(connection, SYNC_RELAY_URL)?
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "Set a relay server URL first.".to_string())?;
            let pairing_code = sync::read_pairing_code(connection)
                .map_err(sync::Error::into_string)?
                .ok_or_else(|| "This device's sync key is missing.".to_string())?;
            let key = sync::crypto::SyncKey::from_pairing_code(&pairing_code)
                .map_err(sync::Error::into_string)?;
            let checkpoint_coordinator = database_checkpoint_coordinator(connection)?;
            if checkpoint_coordinator {
                maybe_checkpoint_operation_log(connection)?;
            }
            sync::relay_client::sync_once_with_network_gate(
                connection,
                &relay_url,
                &key,
                // Relay checkpoint commits use the generation epoch/sequence as
                // a compare-and-swap guard, so any foreground device that has
                // pulled the complete manifest can compact safely. Keeping this
                // restricted to the original database coordinator allowed an
                // offline Mac to strand active phones at the generation limit.
                sync::relay_client::SyncOptions::foreground(true),
                gate,
            )
            .map_err(sync::Error::into_string)
        })();
        #[cfg(target_os = "macos")]
        if result.is_ok() {
            if let Err(error) = macos_widget::publish_snapshot(&startup.connection) {
                eprintln!("Could not refresh the macOS widget: {error}");
            }
        }
        finish_startup_database_read(startup, StartupDatabaseRead::RelaySync, None);
        result
    })
    .await
}

/// Read the stored pairing code (the E2E key) from the encrypted DB.
fn stored_sync_key(app: &tauri::AppHandle) -> Result<Option<sync::crypto::SyncKey>, String> {
    let connection = open_database(app)?;
    let Some(code) = sync::read_pairing_code(&connection).map_err(sync::Error::into_string)? else {
        return Ok(None);
    };
    sync::crypto::SyncKey::from_pairing_code(&code)
        .map(Some)
        .map_err(sync::Error::into_string)
}

/// Start (idempotently) the P2P listener + mDNS discovery, returning the LAN
/// address other devices can connect to.
#[tauri::command]
async fn sync_p2p_serve(app: tauri::AppHandle) -> Result<Option<String>, String> {
    run_database_task(move || {
        let Some(key) = stored_sync_key(&app)? else {
            return Ok(None); // sync not enabled yet
        };
        sync::p2p::ensure_serving(app.clone(), key).map_err(sync::Error::into_string)?;
        Ok(sync::p2p::local_address())
    })
    .await
}

/// Other Balance devices discovered on the LAN.
#[tauri::command]
async fn sync_p2p_peers() -> Result<Vec<sync::p2p::Peer>, String> {
    Ok(sync::p2p::peers())
}

/// Sync directly with a peer at `address` (host:port), then return the rebuilt
/// app state so the UI can refresh.
///
/// Deliberately *not* wrapped in `run_database_task`: that would hold
/// `DATABASE_ACCESS_LOCK` for the entire network exchange, so two devices
/// syncing at each other would each wait on a socket while owning the lock the
/// other's responder needs — a distributed deadlock until both time out.
/// Instead each phase takes the guard on its own and releases it before any
/// socket I/O (see `sync::p2p::AppStore`).
#[tauri::command]
async fn sync_p2p_sync(app: tauri::AppHandle, address: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let key = {
            let _guard = database_access_guard()?;
            let connection = open_database(&app)?;
            maybe_checkpoint_operation_log(&connection)?;
            stored_sync_key(&app)?
        }
        .ok_or_else(|| "Sync is not enabled on this device.".to_string())?;

        // No guard held here; the exchange takes it per database phase.
        sync::p2p::sync_with(&app, &key, &address).map_err(sync::Error::into_string)?;

        let _guard = database_access_guard()?;
        let connection = open_database(&app)?;
        maybe_checkpoint_operation_log(&connection)?;
        #[cfg(target_os = "macos")]
        if let Err(error) = macos_widget::publish_snapshot(&connection) {
            eprintln!("Could not refresh the macOS widget: {error}");
        }
        read_app_state_from_database(&connection).map(|state| state.map(|value| value.to_string()))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    disable_automatic_text_substitutions();

    let app = tauri::Builder::default()
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                restore_macos_main_window_frame(app)?;
                install_paste_and_match_style_menu(app)?;
            }

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            app.handle().plugin(tauri_plugin_dialog::init())?;
            app.handle().plugin(
                tauri_plugin_opener::Builder::new()
                    .open_js_links_on_click(false)
                    .build(),
            )?;

            // Mobile-native camera and haptic integrations.
            #[cfg(mobile)]
            app.handle().plugin(tauri_plugin_barcode_scanner::init())?;
            #[cfg(mobile)]
            app.handle().plugin(tauri_plugin_haptics::init())?;

            // On Android debug builds, run the real two-database pairing and
            // transport flow on-device. CI greps logcat for the marker below.
            // Complete it during setup so its independent SQLCipher connections
            // cannot race the frontend's first open of the real app database.
            #[cfg(all(target_os = "android", debug_assertions))]
            {
                if is_android_owner_user() {
                    let handle = app.handle();
                    let outcome = (|| -> Result<Option<sync::SyncSelftestProfile>, String> {
                        let scratch = app_database_path(handle)?
                            .parent()
                            .ok_or("no data dir")?
                            .to_path_buf();
                        let profile_marker = scratch.join("large-sync-profile-complete");
                        if profile_marker.exists() {
                            return Ok(None);
                        }
                        let profile = sync::selftest(&scratch).map_err(sync::Error::into_string)?;
                        fs::write(&profile_marker, b"complete")
                            .map_err(|error| error.to_string())?;
                        Ok(Some(profile))
                    })();
                    match outcome {
                        Ok(Some(profile)) => {
                            let profile = serde_json::to_string(&profile)
                                .unwrap_or_else(|error| format!("{{\"error\":\"{error}\"}}"));
                            log::info!("BALANCE_SYNC_E2E_PROFILE: {profile}");
                            eprintln!("BALANCE_SYNC_E2E_PROFILE: {profile}");
                            log::info!("BALANCE_SYNC_E2E: OK");
                            eprintln!("BALANCE_SYNC_E2E: OK");
                        }
                        Ok(None) => {}
                        Err(e) => {
                            log::error!("BALANCE_SYNC_E2E: FAIL {e}");
                            eprintln!("BALANCE_SYNC_E2E: FAIL {e}");
                        }
                    }

                    let profile = (|| -> Result<Option<String>, String> {
                        let scratch = app_database_path(handle)?
                            .parent()
                            .ok_or("no data dir")?
                            .to_path_buf();
                        let profile_marker = scratch.join("android-startup-profile-complete");
                        if profile_marker.exists() {
                            return Ok(None);
                        }
                        let profile = profile_android_database_startup(&scratch)?;
                        fs::write(&profile_marker, profile.as_bytes())
                            .map_err(|error| error.to_string())?;
                        Ok(Some(profile))
                    })();
                    match profile {
                        Ok(Some(profile)) => {
                            log::info!("BALANCE_ANDROID_STARTUP_PROFILE: {profile}");
                            eprintln!("BALANCE_ANDROID_STARTUP_PROFILE: {profile}");
                        }
                        Ok(None) => {}
                        Err(error) => {
                            log::error!("BALANCE_ANDROID_STARTUP_PROFILE_FAIL: {error}");
                            eprintln!("BALANCE_ANDROID_STARTUP_PROFILE_FAIL: {error}");
                        }
                    }
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(target_os = "macos")]
            if matches!(
                event,
                tauri::WindowEvent::Moved(_)
                    | tauri::WindowEvent::Resized(_)
                    | tauri::WindowEvent::ScaleFactorChanged { .. }
            ) {
                save_macos_main_window_frame(window);
            }

            #[cfg(not(target_os = "macos"))]
            let _ = (window, event);
        })
        .invoke_handler(tauri::generate_handler![
            read_app_state,
            initialize_app_state,
            persist_operation,
            persist_operations_for_android_ci,
            undo_last_operation,
            redo_last_operation,
            list_recovery_entries,
            list_metadata,
            inspect_database,
            compact_database,
            get_database_maintenance_status,
            run_database_maintenance_if_needed,
            complete_database_maintenance_startup,
            restore_recovery_entry,
            get_recovery_key_status,
            confirm_recovery_key,
            rotate_database_recovery_key,
            recover_database_with_key,
            build_info,
            exit_after_inactivity,
            get_macos_widget_settings,
            set_macos_widget_hide_content_after_close,
            check_for_update,
            save_export_file,
            get_export_settings,
            set_export_directory,
            reset_export_directory,
            reveal_path_in_file_manager,
            open_external_url,
            perform_alignment_haptic,
            write_balance_clipboard,
            write_note_clipboard,
            read_balance_clipboard,
            get_sync_settings,
            set_sync_relay_url,
            sync_new_pairing_code,
            sync_enable_primary,
            sync_enable_joiner,
            sync_relay_once,
            sync_p2p_serve,
            sync_p2p_peers,
            sync_p2p_sync
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app_handle, event| {
        #[cfg(target_os = "macos")]
        if matches!(event, tauri::RunEvent::Exit) && macos_widget::hides_content_after_close() {
            if let Err(error) = macos_widget::schedule_snapshot_expiration() {
                eprintln!("Could not expire macOS widget content after shutdown: {error}");
            }
        }

        #[cfg(not(target_os = "macos"))]
        let _ = event;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct TestRecoveryKeyStore {
        active: Option<String>,
        pending: Option<String>,
        archived: HashMap<String, String>,
        fail_commit: bool,
    }

    impl TestRecoveryKeyStore {
        fn with_active(active: &str) -> Self {
            Self {
                active: Some(active.to_string()),
                ..Self::default()
            }
        }
    }

    impl RecoveryKeyRotationStore for TestRecoveryKeyStore {
        fn stage(
            &mut self,
            old_key: &str,
            new_key: &str,
            archive_account: &str,
        ) -> Result<(), String> {
            self.archived
                .insert(archive_account.to_string(), old_key.to_string());
            self.pending = Some(new_key.to_string());
            Ok(())
        }

        fn commit(&mut self, new_key: &str) -> Result<(), String> {
            if self.fail_commit {
                return Err("simulated active credential failure".to_string());
            }
            self.active = Some(new_key.to_string());
            Ok(())
        }

        fn finish(&mut self) -> Result<(), String> {
            self.pending = None;
            Ok(())
        }

        fn abort(&mut self, old_key: &str, archive_account: &str) -> Result<(), String> {
            self.active = Some(old_key.to_string());
            self.pending = None;
            self.archived.remove(archive_account);
            Ok(())
        }
    }

    #[test]
    fn release_check_only_returns_strictly_newer_versions() {
        let current = semver::Version::parse("0.4.4").unwrap();

        let newer = available_update(
            &current,
            GitHubRelease {
                tag_name: "v0.5.0".to_string(),
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(newer.version, "0.5.0");
        assert_eq!(newer.url, GITHUB_LATEST_RELEASE_URL);

        for tag_name in ["v0.4.4", "v0.4.3"] {
            assert!(available_update(
                &current,
                GitHubRelease {
                    tag_name: tag_name.to_string(),
                },
            )
            .unwrap()
            .is_none());
        }
    }

    #[test]
    fn release_check_rejects_non_version_tags() {
        let current = semver::Version::parse("0.4.4").unwrap();
        let result = available_update(
            &current,
            GitHubRelease {
                tag_name: "latest".to_string(),
            },
        );

        assert!(result.is_err());
    }

    #[test]
    fn every_frontend_operation_has_persistence_and_undo_support() {
        let frontend_source = include_str!("../../src/lib/store.ts");
        let mut operation_types = std::collections::BTreeSet::new();
        let mut remaining = frontend_source;

        while let Some(commit_index) = remaining.find("commit(") {
            remaining = &remaining[commit_index + "commit(".len()..];
            let argument = remaining.trim_start();
            let Some(quoted) = argument.strip_prefix('\'') else {
                continue;
            };
            let Some(quote_index) = quoted.find('\'') else {
                continue;
            };
            operation_types.insert(&quoted[..quote_index]);
            remaining = &quoted[quote_index + 1..];
        }

        assert!(!operation_types.is_empty());

        let backend_source = include_str!("lib.rs");
        let apply_source = backend_source
            .split_once("fn apply_operation(")
            .expect("apply_operation must exist")
            .1
            .split_once("\n#[derive(Clone)]")
            .expect("apply_operation end marker must exist")
            .0;
        let undo_source = backend_source
            .split_once("fn build_domain_undo_operation(")
            .expect("build_domain_undo_operation must exist")
            .1
            .split_once("\nfn build_plan_item_patch_undo(")
            .expect("build_domain_undo_operation end marker must exist")
            .0;

        for operation_type in operation_types {
            if is_lists_metrics_operation(operation_type) {
                continue;
            }

            let match_arm = format!("\"{operation_type}\" =>");
            assert!(
                apply_source.contains(&match_arm),
                "Frontend operation {operation_type:?} has no apply_operation handler"
            );
            if operation_type != "replace_goal_data" {
                assert!(
                    undo_source.contains(&match_arm),
                    "Frontend operation {operation_type:?} has no undo handler"
                );
            }
        }
    }

    #[test]
    fn encrypted_database_round_trips_state_after_reopen() {
        let database = TestDatabase::new("round-trip");
        let recovery_key = generate_recovery_key();
        let state = test_state("Private day");

        {
            let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
            replace_app_state(&mut connection, &state).unwrap();
        }

        let connection = open_database_at(&database.path, &recovery_key).unwrap();
        let saved = read_app_state_from_database(&connection).unwrap().unwrap();
        assert_eq!(saved["plans"][0]["title"], "Private day");
        assert_eq!(
            saved["plans"][0]["dailyReminder"],
            "This shouldn't be aspirational"
        );
        assert_eq!(
            saved["templates"][0]["items"][0]["options"][0]["text"],
            "Wake up"
        );
    }

    #[test]
    fn finalized_sync_artifacts_are_inert_after_upgrade() {
        let database = TestDatabase::new("finalized-sync-upgrade");
        let recovery_key = generate_recovery_key();
        let initial = test_state("Finalized sync upgrade");
        let expected = {
            let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
            replace_app_state(&mut connection, &initial).unwrap();
            sync::enable_primary(&connection).unwrap();
            let expected = read_app_state_from_database(&connection).unwrap().unwrap();
            connection
                .execute_batch(
                    "create table sync_tombstones (id text primary key);
                     create table sync_legacy_cleanup_guard (id text primary key);
                     insert into metadata (key, value)
                     values ('legacy_sync_cleanup_finalized', 'true');",
                )
                .unwrap();
            expected
        };

        let connection = open_database_at(&database.path, &recovery_key).unwrap();
        assert_eq!(
            read_app_state_from_database(&connection).unwrap().unwrap(),
            expected
        );
        sync::checkpoint_operation_log_preserving_history(&connection).unwrap();
        assert_eq!(sync::local_op_ids(&connection).unwrap().len(), 1);
        assert_eq!(
            connection
                .query_row("select count(*) from sync_tombstones", [], |row| row
                    .get::<_, i64>(0),)
                .unwrap(),
            0
        );
        assert_eq!(
            connection
                .query_row(
                    "select count(*) from sync_legacy_cleanup_guard",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );
    }

    #[test]
    fn new_databases_do_not_create_retired_sync_storage() {
        let database = TestDatabase::new("current-sync-schema");
        let recovery_key = generate_recovery_key();
        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
        replace_app_state(&mut connection, &test_state("Current schema")).unwrap();
        sync::enable_primary(&connection).unwrap();

        let retired_tables: i64 = connection
            .query_row(
                "select count(*) from sqlite_master
                 where type = 'table'
                   and name in ('sync_tombstones', 'sync_legacy_cleanup_guard')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let retired_metadata: i64 = connection
            .query_row(
                "select count(*) from metadata
                 where key in ('goal_data', 'lists_metrics_data',
                               'legacy_sync_cleanup_staged', 'legacy_sync_cleanup_finalized')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(retired_tables, 0);
        assert_eq!(retired_metadata, 0);
    }

    #[test]
    fn optional_database_guard_yields_to_an_active_owner() {
        let lock = Mutex::new(());
        let active = lock.lock().unwrap();
        assert!(optional_database_access_guard(&lock).unwrap().is_none());
        drop(active);
        assert!(optional_database_access_guard(&lock).unwrap().is_some());
    }

    #[test]
    fn startup_connection_is_dropped_after_launch_reads_finish() {
        let database = TestDatabase::new("startup-connection-lifetime");
        let recovery_key = generate_recovery_key();
        let connection = open_database_at(&database.path, &recovery_key).unwrap();
        let startup = StartupDatabaseConnection {
            database_path: database.path.clone(),
            recovery_key,
            connection,
            recovery_status_read: false,
            app_state_read: false,
            export_settings_read: false,
            sync_settings_read: false,
            relay_sync_required: None,
            relay_sync_finished: false,
        };

        finish_startup_database_read(startup, StartupDatabaseRead::AppState, None);
        let startup = STARTUP_DATABASE_CONNECTION.lock().unwrap().take().unwrap();
        assert!(startup.app_state_read);
        assert!(!startup.recovery_status_read);

        finish_startup_database_read(startup, StartupDatabaseRead::RecoveryStatus, None);
        let startup = STARTUP_DATABASE_CONNECTION.lock().unwrap().take().unwrap();
        finish_startup_database_read(startup, StartupDatabaseRead::ExportSettings, None);
        let startup = STARTUP_DATABASE_CONNECTION.lock().unwrap().take().unwrap();
        finish_startup_database_read(startup, StartupDatabaseRead::SyncSettings, Some(false));
        assert!(STARTUP_DATABASE_CONNECTION.lock().unwrap().is_none());
    }

    fn generated_rotation_database(name: &str) -> (TestDatabaseAt, String, Value) {
        let database = TestDatabaseAt::new(name);
        let recovery_key = generate_recovery_key();
        let mut state = test_state("Rotation preserves every field 🛡️");
        state["notes"] = json!([{
            "id": "rotation-note",
            "title": "Binary-safe values",
            "createdAt": "created",
            "updatedAt": "updated",
            "items": [{
                "id": "rotation-note-item",
                "text": "Unicode, commas, and null-like text: null",
                "html": "<strong>Unicode 🛡️</strong>",
                "done": false,
                "startMinutes": null,
                "endMinutes": null,
                "kind": "text",
                "children": []
            }]
        }]);
        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
        replace_app_state(&mut connection, &state).unwrap();
        persist_operation_to_database(
            &mut connection,
            &json!({
                "id": "rotation-operation",
                "deviceId": "rotation-device",
                "sequence": 41,
                "type": "set_active_plan_date",
                "timestamp": "2026-08-12T12:00:00Z",
                "payload": { "date": "2026-08-11" }
            }),
        )
        .unwrap();
        set_metadata(
            &connection,
            "rotation-extra-metadata",
            "Preserve values outside the rendered app state",
        )
        .unwrap();
        let expected = read_app_state_from_database(&connection).unwrap().unwrap();
        drop(connection);
        (database, recovery_key, expected)
    }

    fn assert_no_key_rotation_files(database_path: &Path) {
        let (working_path, rollback_path) = key_rotation_paths(database_path).unwrap();
        assert!(!working_path.exists());
        assert!(!rollback_path.exists());
    }

    #[test]
    fn key_rotation_preserves_all_data_and_archives_the_old_key() {
        let (database, old_key, expected_state) =
            generated_rotation_database("key-rotation-success");
        let backup_path = database.directory.join("old-key-backup.sqlite3");
        let source = open_database_at(&database.path, &old_key).unwrap();
        copy_database_snapshot(&source, &backup_path, &old_key).unwrap();
        let expected_operation_count: i64 = source
            .query_row("select count(*) from operations", [], |row| row.get(0))
            .unwrap();
        let expected_history_count: i64 = source
            .query_row("select count(*) from history_entries", [], |row| row.get(0))
            .unwrap();
        drop(source);

        let new_key = generate_recovery_key();
        let archive_account = "database-recovery-key-archived-test";
        let mut key_store = TestRecoveryKeyStore::with_active(&old_key);
        rotate_database_key_at(
            &database.path,
            &old_key,
            &new_key,
            archive_account,
            &mut key_store,
        )
        .unwrap();

        assert_eq!(key_store.active.as_deref(), Some(new_key.as_str()));
        assert_eq!(key_store.pending, None);
        assert_eq!(
            key_store.archived.get(archive_account),
            Some(&old_key),
            "the old key must remain available for pre-rotation backups"
        );
        assert!(!database_key_matches(&database.path, &old_key));
        assert!(database_key_matches(&database.path, &new_key));

        let rotated = open_database_at(&database.path, &new_key).unwrap();
        assert_eq!(
            read_app_state_from_database(&rotated).unwrap().unwrap(),
            expected_state
        );
        assert_eq!(
            rotated
                .query_row::<i64, _, _>("select count(*) from operations", [], |row| row.get(0))
                .unwrap(),
            expected_operation_count
        );
        assert_eq!(
            rotated
                .query_row::<i64, _, _>("select count(*) from history_entries", [], |row| {
                    row.get(0)
                })
                .unwrap(),
            expected_history_count
        );
        assert_eq!(
            metadata_value(&rotated, RECOVERY_KEY_CONFIRMED).unwrap(),
            Some("false".to_string())
        );
        drop(rotated);

        let old_backup = open_database_at(&backup_path, &old_key).unwrap();
        assert_eq!(
            read_app_state_from_database(&old_backup).unwrap().unwrap(),
            expected_state
        );
        assert_no_key_rotation_files(&database.path);
    }

    #[test]
    fn key_rotation_rejects_a_corrupted_candidate_before_touching_credentials() {
        let (database, old_key, expected_state) =
            generated_rotation_database("key-rotation-corrupt-candidate");
        let new_key = generate_recovery_key();
        let archive_account = "database-recovery-key-archived-corrupt";
        let mut key_store = TestRecoveryKeyStore::with_active(&old_key);

        let error = rotate_database_key_at_with_checkpoint(
            &database.path,
            &old_key,
            &new_key,
            archive_account,
            &mut key_store,
            |checkpoint, path| {
                if checkpoint == KeyRotationCheckpoint::CandidateCopied {
                    let candidate = open_database_at(path, &new_key)?;
                    candidate
                        .execute(
                            "update metadata set value = 'corrupted' where key = 'rotation-extra-metadata'",
                            [],
                        )
                        .map_err(|error| error.to_string())?;
                }
                Ok(())
            },
        )
        .unwrap_err();

        assert!(error.contains("changed stored data"));
        assert_eq!(key_store.active.as_deref(), Some(old_key.as_str()));
        assert_eq!(key_store.pending, None);
        assert!(key_store.archived.is_empty());
        let original = open_database_at(&database.path, &old_key).unwrap();
        assert_eq!(
            read_app_state_from_database(&original).unwrap().unwrap(),
            expected_state
        );
        assert_no_key_rotation_files(&database.path);
    }

    #[test]
    fn key_rotation_rolls_back_database_and_credentials_after_install_failure() {
        let (database, old_key, expected_state) =
            generated_rotation_database("key-rotation-install-rollback");
        let new_key = generate_recovery_key();
        let archive_account = "database-recovery-key-archived-rollback";
        let mut key_store = TestRecoveryKeyStore::with_active(&old_key);

        let error = rotate_database_key_at_with_checkpoint(
            &database.path,
            &old_key,
            &new_key,
            archive_account,
            &mut key_store,
            |checkpoint, _| {
                if checkpoint == KeyRotationCheckpoint::DatabaseInstalled {
                    return Err("simulated interruption after database installation".to_string());
                }
                Ok(())
            },
        )
        .unwrap_err();

        assert!(error.contains("simulated interruption"));
        assert_eq!(key_store.active.as_deref(), Some(old_key.as_str()));
        assert_eq!(key_store.pending, None);
        assert!(key_store.archived.is_empty());
        assert!(database_key_matches(&database.path, &old_key));
        assert!(!database_key_matches(&database.path, &new_key));
        let restored = open_database_at(&database.path, &old_key).unwrap();
        assert_eq!(
            read_app_state_from_database(&restored).unwrap().unwrap(),
            expected_state
        );
        assert_no_key_rotation_files(&database.path);
    }

    #[test]
    fn key_rotation_restores_original_when_active_credential_update_fails() {
        let (database, old_key, expected_state) =
            generated_rotation_database("key-rotation-credential-rollback");
        let new_key = generate_recovery_key();
        let archive_account = "database-recovery-key-archived-credential-failure";
        let mut key_store = TestRecoveryKeyStore {
            fail_commit: true,
            ..TestRecoveryKeyStore::with_active(&old_key)
        };

        let error = rotate_database_key_at(
            &database.path,
            &old_key,
            &new_key,
            archive_account,
            &mut key_store,
        )
        .unwrap_err();

        assert!(error.contains("simulated active credential failure"));
        assert_eq!(key_store.active.as_deref(), Some(old_key.as_str()));
        assert_eq!(key_store.pending, None);
        assert!(key_store.archived.is_empty());
        assert!(database_key_matches(&database.path, &old_key));
        assert!(!database_key_matches(&database.path, &new_key));
        let restored = open_database_at(&database.path, &old_key).unwrap();
        assert_eq!(
            read_app_state_from_database(&restored).unwrap().unwrap(),
            expected_state
        );
        assert_no_key_rotation_files(&database.path);
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn interrupted_rotation_selects_pending_key_for_an_installed_rotated_database() {
        let (database, old_key, _) = generated_rotation_database("key-rotation-crash-commit");
        let new_key = generate_recovery_key();
        let (working_path, rollback_path) = key_rotation_paths(&database.path).unwrap();
        let source = open_database_at(&database.path, &old_key).unwrap();
        copy_database_snapshot(&source, &working_path, &new_key).unwrap();
        copy_database_snapshot(&source, &rollback_path, &old_key).unwrap();
        drop(source);
        install_rotated_database(&working_path, &database.path).unwrap();

        assert_eq!(
            interrupted_key_rotation_action(
                &database.path,
                &working_path,
                &rollback_path,
                Some(&old_key),
                Some(&new_key),
            )
            .unwrap(),
            InterruptedKeyRotationAction::ActivatePending
        );
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn interrupted_rotation_prefers_intact_active_database_before_install() {
        let (database, old_key, _) = generated_rotation_database("key-rotation-crash-stage");
        let new_key = generate_recovery_key();
        let (working_path, rollback_path) = key_rotation_paths(&database.path).unwrap();
        let source = open_database_at(&database.path, &old_key).unwrap();
        copy_database_snapshot(&source, &working_path, &new_key).unwrap();
        copy_database_snapshot(&source, &rollback_path, &old_key).unwrap();
        drop(source);

        assert_eq!(
            interrupted_key_rotation_action(
                &database.path,
                &working_path,
                &rollback_path,
                Some(&old_key),
                Some(&new_key),
            )
            .unwrap(),
            InterruptedKeyRotationAction::KeepActive
        );
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn interrupted_rotation_restores_only_a_rollback_matching_the_active_key() {
        let (database, old_key, _) = generated_rotation_database("key-rotation-crash-restore");
        let wrong_key = generate_recovery_key();
        let (working_path, rollback_path) = key_rotation_paths(&database.path).unwrap();
        let source = open_database_at(&database.path, &old_key).unwrap();
        copy_database_snapshot(&source, &rollback_path, &old_key).unwrap();
        drop(source);
        fs::remove_file(&database.path).unwrap();

        assert_eq!(
            interrupted_key_rotation_action(
                &database.path,
                &working_path,
                &rollback_path,
                Some(&old_key),
                None,
            )
            .unwrap(),
            InterruptedKeyRotationAction::RestoreActiveRollback
        );
        assert!(interrupted_key_rotation_action(
            &database.path,
            &working_path,
            &rollback_path,
            Some(&wrong_key),
            None,
        )
        .is_err());
        assert!(
            rollback_path.exists(),
            "an unmatched rollback is never deleted"
        );
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn interrupted_rotation_can_finish_installing_a_verified_pending_copy() {
        let (database, old_key, _) = generated_rotation_database("key-rotation-crash-rename");
        let new_key = generate_recovery_key();
        let (working_path, rollback_path) = key_rotation_paths(&database.path).unwrap();
        let source = open_database_at(&database.path, &old_key).unwrap();
        copy_database_snapshot(&source, &working_path, &new_key).unwrap();
        drop(source);
        fs::remove_file(&database.path).unwrap();

        assert_eq!(
            interrupted_key_rotation_action(
                &database.path,
                &working_path,
                &rollback_path,
                Some(&old_key),
                Some(&new_key),
            )
            .unwrap(),
            InterruptedKeyRotationAction::InstallPendingWorking
        );
    }

    #[test]
    fn database_load_progress_reports_ordered_workspace_stages() {
        let database = TestDatabase::new("load-progress");
        let recovery_key = generate_recovery_key();
        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
        replace_app_state(&mut connection, &test_state("Progress day")).unwrap();

        let mut reported = Vec::new();
        let loaded = read_app_state_from_database_with_progress(&connection, |percent, stage| {
            reported.push((percent, stage))
        })
        .unwrap()
        .unwrap();

        assert_eq!(loaded["plans"][0]["title"], "Progress day");
        assert_eq!(
            reported,
            [
                (25, "Reading workspace settings"),
                (35, "Loading goals"),
                (45, "Loading lists, metrics, and notes"),
                (60, "Loading templates"),
                (75, "Loading plans"),
                (90, "Preparing workspace"),
            ]
        );
        assert!(reported.windows(2).all(|pair| pair[0].0 < pair[1].0));
    }

    #[test]
    fn entity_delta_is_small_replayable_and_round_trips_undo_redo() {
        let database = TestDatabase::new("entity-delta-undo");
        let recovery_key = generate_recovery_key();
        let mut state = test_state("Entity delta");
        let untouched = "UNTOUCHED-SENTINEL-".repeat(20_000);
        state["notes"] = json!([
            { "id": "note-edited", "title": "Before", "items": [], "createdAt": "c", "updatedAt": "u" },
            { "id": "note-untouched", "title": untouched, "items": [], "createdAt": "c", "updatedAt": "u" }
        ]);
        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
        replace_app_state(&mut connection, &state).unwrap();
        let operation = json!({
            "id": "entity-delta-op", "deviceId": "device_test", "sequence": 2,
            "type": "rename_note", "timestamp": "2026-08-12T12:00:00Z",
            "payload": {
                "noteId": "note-edited", "title": "After",
                "entityChanges": {
                    "version": 1,
                    "upserts": [{
                        "collection": "notes", "key": "note-edited", "position": 0,
                        "value": { "id": "note-edited", "title": "After", "items": [], "createdAt": "c", "updatedAt": "v" }
                    }],
                    "deletes": []
                }
            }
        });
        persist_operation_to_database(&mut connection, &operation).unwrap();
        let payload: String = connection
            .query_row(
                "select payload_json from operations where id = 'entity-delta-op'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!payload.contains("listsMetricsData"));
        assert!(!payload.contains("UNTOUCHED-SENTINEL"));
        assert!(payload.len() < 1_000);
        assert_eq!(
            read_app_state_from_database(&connection).unwrap().unwrap()["notes"][0]["title"],
            "After"
        );

        let history: (String, String) = connection
            .query_row("select undo_operation_json, redo_operation_json from history_entries where operation_id = 'entity-delta-op'", [], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap();
        assert!(!history.0.contains("UNTOUCHED-SENTINEL"));
        assert!(!history.1.contains("UNTOUCHED-SENTINEL"));
        let undone = undo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(undone["notes"][0]["title"], "Before");
        assert_eq!(undone["notes"][1]["title"], untouched);
        let redone = redo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(redone["notes"][0]["title"], "After");
        assert_eq!(redone["notes"][1]["title"], untouched);
    }

    #[test]
    fn history_keeps_two_hundred_recent_actions_and_extended_destructive_recovery() {
        let database = TestDatabase::new("bounded-history");
        let recovery_key = generate_recovery_key();
        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
        replace_app_state(&mut connection, &test_state("Bound history")).unwrap();
        persist_operation_to_database(
            &mut connection,
            &json!({
                "id": "old-destructive", "deviceId": "device_test", "sequence": 2,
                "type": "delete_plan_item", "timestamp": "2026-08-12T00:00:00Z",
                "payload": { "planId": "plan_today", "itemId": "plan_item_wake" }
            }),
        )
        .unwrap();
        for sequence in 3..=207 {
            persist_operation_to_database(
                &mut connection,
                &json!({
                    "id": format!("recent-{sequence}"), "deviceId": "device_test", "sequence": sequence,
                    "type": "set_active_plan_date", "timestamp": "2026-08-12T00:01:00Z",
                    "payload": { "date": format!("2026-08-{:02}", sequence % 28 + 1) }
                }),
            )
            .unwrap();
        }
        let count: i64 = connection
            .query_row("select count(*) from history_entries", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, HISTORY_RECENT_LIMIT as i64 + 1);
        assert_eq!(
            connection
                .query_row(
                    "select count(*) from history_entries where operation_id = 'old-destructive'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );

        connection
            .execute(
                "update history_entries set created_at_ms = ?1 where operation_id = 'old-destructive'",
                params![current_timestamp_ms() - HISTORY_DESTRUCTIVE_RETENTION_MS - 1],
            )
            .unwrap();
        prune_history_entries(&connection, current_timestamp_ms()).unwrap();
        assert_eq!(
            connection
                .query_row("select count(*) from history_entries", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            HISTORY_RECENT_LIMIT as i64
        );
    }

    #[test]
    fn vacuum_atomically_replaces_database_without_changing_log_or_history() {
        let database = TestDatabase::new("compact-atomic");
        let recovery_key = generate_recovery_key();
        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
        replace_app_state(&mut connection, &test_state("Compact me")).unwrap();
        set_metadata(&connection, EXPORT_DIRECTORY, "/tmp/balance-exports").unwrap();
        set_metadata(&connection, RECOVERY_KEY_CONFIRMED, "true").unwrap();

        let large_text = "repeated-list-state-".repeat(2_000);
        for sequence in 2..=32 {
            persist_operation_to_database(
                &mut connection,
                &json!({
                    "id": format!("op_compact_{sequence}"),
                    "deviceId": "device_test",
                    "sequence": sequence,
                    "type": "set_active_plan_date",
                    "timestamp": format!("2026-07-29T10:{:02}:00Z", sequence - 2),
                    "payload": {
                        "date": "2026-07-30",
                        "padding": format!("{large_text}{sequence}")
                    }
                }),
            )
            .unwrap();
        }
        let before_state = read_app_state_from_database(&connection).unwrap().unwrap();
        let before_operations: i64 = connection
            .query_row("select count(*) from operations", [], |row| row.get(0))
            .unwrap();
        let before_history: i64 = connection
            .query_row("select count(*) from history_entries", [], |row| row.get(0))
            .unwrap();
        set_metadata(&connection, "vacuum-test-padding", &"x".repeat(2_000_000)).unwrap();
        delete_metadata(&connection, "vacuum-test-padding").unwrap();
        drop(connection);

        let result = compact_database_at(&database.path, &recovery_key).unwrap();
        assert!(!result.checkpoint_created);
        assert_eq!(result.operations_removed, 0);
        assert_eq!(result.history_entries_removed, 0);
        assert_eq!(result.backup_path, None);
        assert!(result.after_bytes < result.before_bytes);
        assert!(result.reclaimed_bytes > 1_000_000);
        assert_eq!(
            result.reclaimed_bytes,
            result.before_bytes - result.after_bytes
        );
        let compacted = open_database_at(&database.path, &recovery_key).unwrap();
        verify_database_state(&compacted, &before_state).unwrap();
        assert_eq!(
            compacted
                .query_row("select count(*) from operations", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            before_operations
        );
        assert_eq!(
            compacted
                .query_row("select count(*) from history_entries", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            before_history
        );
        assert_eq!(
            metadata_value(&compacted, EXPORT_DIRECTORY)
                .unwrap()
                .as_deref(),
            Some("/tmp/balance-exports")
        );
        assert_eq!(
            metadata_value(&compacted, RECOVERY_KEY_CONFIRMED)
                .unwrap()
                .as_deref(),
            Some("true")
        );
        drop(compacted);
    }

    #[test]
    fn operation_threshold_checkpoints_log_and_preserves_undo_history() {
        let database = TestDatabase::new("compact-synced");
        let recovery_key = generate_recovery_key();
        let pairing_code = sync::crypto::SyncKey::generate().to_pairing_code();
        let expected_state = {
            let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
            replace_app_state(&mut connection, &test_state("Synced compact")).unwrap();
            sync::enable_primary(&connection).unwrap();
            sync::store_pairing_code(&connection, &pairing_code).unwrap();
            set_metadata(&connection, SYNC_RELAY_URL, "https://relay.example.com").unwrap();
            persist_operation_to_database(
                &mut connection,
                &json!({
                    "id": "op_synced_before_compact",
                    "deviceId": "device_test",
                    "sequence": 2,
                    "type": "set_active_plan_date",
                    "timestamp": "2026-07-29T11:00:00Z",
                    "payload": { "date": "2026-07-30" }
                }),
            )
            .unwrap();
            let state = read_app_state_from_database(&connection).unwrap().unwrap();
            let ids = sync::local_op_ids(&connection).unwrap();
            assert_eq!(ids.len(), 2);
            state
        };

        let mut compacted = open_database_at(&database.path, &recovery_key).unwrap();
        for sequence in std::iter::once(1).chain(3..=1_000) {
            upsert_operation(
                &compacted,
                &json!({
                    "id": format!("op_threshold_{sequence}"),
                    "deviceId": "device_test",
                    "sequence": sequence,
                    "type": "set_active_plan_date",
                    "timestamp": format!("2026-07-29T12:{:02}:00Z", sequence % 60),
                    "payload": { "date": "2026-07-30" }
                }),
            )
            .unwrap();
        }
        assert!(maybe_checkpoint_operation_log(&compacted).unwrap());
        assert!(sync::is_sync_enabled(&compacted).unwrap());
        assert_eq!(
            sync::read_pairing_code(&compacted).unwrap().as_deref(),
            Some(pairing_code.as_str())
        );
        assert_eq!(
            metadata_value(&compacted, SYNC_RELAY_URL)
                .unwrap()
                .as_deref(),
            Some("https://relay.example.com")
        );
        assert_eq!(
            read_app_state_from_database(&compacted).unwrap().unwrap(),
            expected_state
        );

        // The compacted log is one checkpoint with a per-device frontier, so a
        // peer holding old history collapses without an ever-growing id list.
        let checkpoint_ids = sync::local_op_ids(&compacted).unwrap();
        assert_eq!(checkpoint_ids.len(), 1);
        let checkpoint = sync::ops_by_id(&compacted, &checkpoint_ids).unwrap()[0].clone();
        let payload: Value = serde_json::from_str(&checkpoint.payload_json).unwrap();
        assert_eq!(payload["frontiers"]["device_test"], 1_000);
        assert!(payload.get("legacyReplaces").is_none());
        assert!(payload.get("replaces").is_none());
        assert_eq!(
            compacted
                .query_row("select count(*) from history_entries", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1,
            "checkpointing is independent from undo retention"
        );
        assert_eq!(
            sync::merge_ops(&compacted, std::slice::from_ref(&checkpoint)).unwrap(),
            0,
            "the checkpoint is already present"
        );

        // Writes made after compaction still replicate normally.
        persist_operation_to_database(
            &mut compacted,
            &json!({
                "id": "op_synced_after_compact",
                "deviceId": "device_test",
                "sequence": 1001,
                "type": "set_active_plan_date",
                "timestamp": "2026-07-29T11:01:00Z",
                "payload": { "date": "2026-07-31" }
            }),
        )
        .unwrap();
        assert_eq!(
            read_app_state_from_database(&compacted).unwrap().unwrap()["activePlanDate"],
            "2026-07-31"
        );
        let after = sync::local_op_ids(&compacted).unwrap();
        assert!(
            after.contains(&"op_synced_after_compact".to_string()),
            "post-compaction writes are offered to peers"
        );
        // A peer that already holds the checkpoint is offered only the new op.
        let peer_inventory = sync::SyncInventory {
            items: vec![sync::InventoryItem {
                id: checkpoint_ids[0].clone(),
                device_id: checkpoint.device_id.clone(),
                sequence: checkpoint.sequence,
                checkpoint: true,
            }],
            frontiers: sync::sync_frontiers(&compacted).unwrap(),
        };
        let (ops, want) = sync::diff_against(&compacted, &peer_inventory).unwrap();
        assert!(want.is_empty());
        assert_eq!(
            ops.iter().map(|op| op.id.as_str()).collect::<Vec<_>>(),
            ["op_synced_after_compact"]
        );
        drop(compacted);
    }

    #[test]
    fn daily_backup_failure_leaves_synced_database_byte_for_byte_unchanged() {
        let directory = std::env::temp_dir().join(format!(
            "balance-compact-failure-{}-{}",
            std::process::id(),
            generate_recovery_key().replace('-', "")
        ));
        fs::create_dir_all(&directory).unwrap();
        let database = TestDatabaseAt {
            path: directory.join("balance.sqlite3"),
            directory,
        };
        let recovery_key = generate_recovery_key();
        {
            let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
            replace_app_state(&mut connection, &test_state("Do not change")).unwrap();
            sync::enable_primary(&connection).unwrap();
            persist_operation_to_database(
                &mut connection,
                &json!({
                    "id": "op_keep",
                    "deviceId": "device_test",
                    "sequence": 2,
                    "type": "set_active_plan_date",
                    "timestamp": "2026-07-29T12:00:00Z",
                    "payload": { "date": "2026-08-01" }
                }),
            )
            .unwrap();
        }
        let bytes_before = fs::read(&database.path).unwrap();
        let state_before = {
            let connection = open_database_at(&database.path, &recovery_key).unwrap();
            read_app_state_from_database(&connection).unwrap().unwrap()
        };

        fs::write(database.directory.join("backups"), b"not a directory").unwrap();

        let connection = open_database_at(&database.path, &recovery_key).unwrap();
        let error = create_daily_database_backup_if_due(
            &connection,
            &database.path,
            &recovery_key,
            2_000_000_000_000,
        )
        .unwrap_err();
        assert!(!error.is_empty());
        assert_eq!(fs::read(&database.path).unwrap(), bytes_before);
        assert_eq!(
            read_app_state_from_database(&connection).unwrap().unwrap(),
            state_before
        );
        assert_eq!(
            connection
                .query_row("select count(*) from operations", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            2
        );
    }

    #[test]
    fn physical_maintenance_is_due_only_for_material_reclaimable_space() {
        let database = TestDatabase::new("maintenance-schedule");
        let recovery_key = generate_recovery_key();
        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
        replace_app_state(&mut connection, &test_state("Threshold maintenance")).unwrap();
        let now = 2_000_000_000_000_i64;

        let first = database_maintenance_status_from_database(&connection, now).unwrap();
        assert!(!first.due);
        assert!(first.checkpoint_coordinator);
        assert_eq!(first.last_completed_at, None);

        set_metadata(
            &connection,
            "reclaim-threshold-padding",
            &"x".repeat(20 * 1024 * 1024),
        )
        .unwrap();
        delete_metadata(&connection, "reclaim-threshold-padding").unwrap();
        let reclaimable = database_maintenance_status_from_database(&connection, now).unwrap();
        assert!(reclaimable.due);
        assert!(reclaimable.reclaimable_bytes >= DATABASE_RECLAIM_MIN_BYTES);
        assert!(reclaimable.reclaimable_percent >= DATABASE_RECLAIM_MIN_PERCENT);
    }

    #[test]
    fn synced_joiner_vacuum_preserves_history_without_creating_a_competing_checkpoint() {
        let primary_database = TestDatabase::new("maintenance-primary");
        let joiner_database = TestDatabase::new("maintenance-joiner");
        let primary_key = generate_recovery_key();
        let joiner_key = generate_recovery_key();

        let mut primary_state = test_state("Shared state");
        primary_state["deviceId"] = json!("device-primary");
        let mut joiner_state = test_state("Will be replaced");
        joiner_state["deviceId"] = json!("device-joiner");

        let primary = {
            let mut connection = open_database_at(&primary_database.path, &primary_key).unwrap();
            replace_app_state(&mut connection, &primary_state).unwrap();
            sync::enable_primary(&connection).unwrap();
            connection
        };
        let mut joiner = {
            let mut connection = open_database_at(&joiner_database.path, &joiner_key).unwrap();
            replace_app_state(&mut connection, &joiner_state).unwrap();
            sync::enable_joiner(&connection).unwrap();
            sync::merge_and_rematerialize(&connection, sync::all_ops(&primary).unwrap()).unwrap();
            connection
        };

        assert!(database_checkpoint_coordinator(&primary).unwrap());
        assert!(!database_checkpoint_coordinator(&joiner).unwrap());
        persist_operation_to_database(
            &mut joiner,
            &json!({
                "id": "joiner-operation-before-vacuum",
                "deviceId": "device-joiner",
                "sequence": 2,
                "type": "set_active_plan_date",
                "timestamp": "2026-07-29T15:00:00Z",
                "payload": { "date": "2026-07-30" }
            }),
        )
        .unwrap();
        let state_before = read_app_state_from_database(&joiner).unwrap().unwrap();
        let operation_rows_before = {
            let mut statement = joiner
                .prepare(
                    "select id, device_id, sequence, type, timestamp, payload_json
                     from operations order by id",
                )
                .unwrap();
            statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        let history_count_before: i64 = joiner
            .query_row("select count(*) from history_entries", [], |row| row.get(0))
            .unwrap();
        assert_eq!(history_count_before, 1);

        // Create free pages so the test proves a physical vacuum can reclaim
        // space without modifying the replicated operation log.
        set_metadata(&joiner, "maintenance-test-padding", &"x".repeat(500_000)).unwrap();
        delete_metadata(&joiner, "maintenance-test-padding").unwrap();
        drop(primary);
        drop(joiner);

        let result = vacuum_database_at(&joiner_database.path, &joiner_key).unwrap();
        assert!(!result.checkpoint_created);
        assert_eq!(result.operations_removed, 0);
        assert_eq!(result.history_entries_removed, 0);
        assert!(result.after_bytes < result.before_bytes);

        let maintained = open_database_at(&joiner_database.path, &joiner_key).unwrap();
        assert_eq!(
            read_app_state_from_database(&maintained).unwrap().unwrap(),
            state_before
        );
        let operation_rows_after = {
            let mut statement = maintained
                .prepare(
                    "select id, device_id, sequence, type, timestamp, payload_json
                     from operations order by id",
                )
                .unwrap();
            statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                    ))
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        assert_eq!(operation_rows_after, operation_rows_before);
        assert_eq!(
            maintained
                .query_row("select count(*) from history_entries", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            history_count_before
        );
        assert!(!database_checkpoint_coordinator(&maintained).unwrap());
        drop(maintained);
    }

    #[test]
    fn daily_backup_runs_once_per_day_and_is_independent_from_vacuum() {
        let database = TestDatabaseAt::new("daily-backup-schedule");
        let recovery_key = generate_recovery_key();
        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
        replace_app_state(&mut connection, &test_state("Daily backup")).unwrap();
        let day_ms = 24 * 60 * 60 * 1_000_i64;

        let first = create_daily_database_backup_if_due(
            &connection,
            &database.path,
            &recovery_key,
            100 * day_ms,
        )
        .unwrap()
        .unwrap();
        let same_day = create_daily_database_backup_if_due(
            &connection,
            &database.path,
            &recovery_key,
            100 * day_ms + 1,
        )
        .unwrap()
        .unwrap();
        assert_eq!(same_day, first);

        persist_operation_to_database(
            &mut connection,
            &json!({
                "id": "daily-backup-change",
                "deviceId": "device_test",
                "sequence": 2,
                "type": "set_active_plan_date",
                "timestamp": "2026-08-01T00:00:00Z",
                "payload": { "date": "2026-08-01" }
            }),
        )
        .unwrap();
        let expected = read_app_state_from_database(&connection).unwrap().unwrap();
        let second = create_daily_database_backup_if_due(
            &connection,
            &database.path,
            &recovery_key,
            101 * day_ms,
        )
        .unwrap()
        .unwrap();
        assert_ne!(second, first);
        assert!(first.exists() && second.exists());
        assert_eq!(
            metadata_value(&connection, DATABASE_DAILY_BACKUP_LATEST).unwrap(),
            Some(second.display().to_string())
        );
        let backup = open_database_at(&second, &recovery_key).unwrap();
        verify_database_state(&backup, &expected).unwrap();
    }

    #[test]
    fn daily_backup_retains_the_latest_seven_verified_copies() {
        let database = TestDatabaseAt::new("daily-backup-retention");
        let recovery_key = generate_recovery_key();
        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
        replace_app_state(&mut connection, &test_state("Backup retention")).unwrap();
        let day_ms = 24 * 60 * 60 * 1_000_i64;
        let mut latest = PathBuf::new();
        for day in 100..109 {
            set_metadata(
                &connection,
                "active_plan_date",
                &format!("2026-08-{:02}", day - 99),
            )
            .unwrap();
            latest = create_daily_database_backup_if_due(
                &connection,
                &database.path,
                &recovery_key,
                day * day_ms,
            )
            .unwrap()
            .unwrap();
        }
        let backups = fs::read_dir(database.path.parent().unwrap().join("backups"))
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("balance-daily-"))
            })
            .collect::<Vec<_>>();
        assert_eq!(backups.len(), DATABASE_DAILY_BACKUP_RETENTION);
        assert!(latest.exists());
        let expected = read_app_state_from_database(&connection).unwrap().unwrap();
        let backup = open_database_at(&latest, &recovery_key).unwrap();
        verify_database_state(&backup, &expected).unwrap();
    }

    #[test]
    fn day_templates_can_be_added_deleted_and_undone() {
        let database = TestDatabase::new("day-template-lifecycle");
        let recovery_key = generate_recovery_key();
        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
        replace_app_state(&mut connection, &test_state("Template lifecycle")).unwrap();

        persist_operation_to_database(
            &mut connection,
            &json!({
                "id": "op_device_test_2",
                "deviceId": "device_test",
                "sequence": 2,
                "type": "add_template",
                "timestamp": "2026-05-21T00:01:00Z",
                "payload": {
                    "template": {
                        "id": "template_weekend",
                        "name": "Weekend",
                        "createdAt": "2026-05-21T00:01:00Z",
                        "updatedAt": "2026-05-21T00:01:00Z",
                        "items": []
                    }
                }
            }),
        )
        .unwrap();

        let added = read_app_state_from_database(&connection).unwrap().unwrap();
        assert_eq!(added["templates"].as_array().unwrap().len(), 2);
        assert_eq!(added["templates"][1]["name"], "Weekend");

        let undone_add = undo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(undone_add["templates"].as_array().unwrap().len(), 1);

        let redone_add = redo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(redone_add["templates"][1]["name"], "Weekend");

        persist_operation_to_database(
            &mut connection,
            &json!({
                "id": "op_device_test_5",
                "deviceId": "device_test",
                "sequence": 5,
                "type": "delete_template",
                "timestamp": "2026-05-21T00:02:00Z",
                "payload": { "templateId": "template_default" }
            }),
        )
        .unwrap();

        let deleted = read_app_state_from_database(&connection).unwrap().unwrap();
        assert_eq!(deleted["templates"].as_array().unwrap().len(), 1);
        assert_eq!(deleted["templates"][0]["id"], "template_weekend");

        let undone_delete = undo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(undone_delete["templates"].as_array().unwrap().len(), 2);
        assert_eq!(undone_delete["templates"][0]["id"], "template_default");
        assert_eq!(undone_delete["templates"][1]["id"], "template_weekend");
    }

    #[test]
    fn day_templates_can_be_reordered_and_undone() {
        let database = TestDatabase::new("day-template-reorder");
        let recovery_key = generate_recovery_key();
        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
        let mut state = test_state("Template reorder");
        state["templates"].as_array_mut().unwrap().extend([
            json!({
                "id": "template_weekday",
                "name": "Weekday",
                "createdAt": "2026-05-21T00:01:00Z",
                "updatedAt": "2026-05-21T00:01:00Z",
                "items": []
            }),
            json!({
                "id": "template_weekend",
                "name": "Weekend",
                "createdAt": "2026-05-21T00:02:00Z",
                "updatedAt": "2026-05-21T00:02:00Z",
                "items": []
            }),
        ]);
        replace_app_state(&mut connection, &state).unwrap();

        persist_operation_to_database(
            &mut connection,
            &json!({
                "id": "op_device_test_2",
                "deviceId": "device_test",
                "sequence": 2,
                "type": "move_template",
                "timestamp": "2026-05-21T00:03:00Z",
                "payload": {
                    "sourceId": "template_default",
                    "targetId": "template_weekend",
                    "placement": "after"
                }
            }),
        )
        .unwrap();

        let reordered = read_app_state_from_database(&connection).unwrap().unwrap();
        let reordered_ids = reordered["templates"]
            .as_array()
            .unwrap()
            .iter()
            .map(|template| template["id"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            reordered_ids,
            ["template_weekday", "template_weekend", "template_default"]
        );

        let undone = undo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        let undone_ids = undone["templates"]
            .as_array()
            .unwrap()
            .iter()
            .map(|template| template["id"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            undone_ids,
            ["template_default", "template_weekday", "template_weekend"]
        );

        let redone = redo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        let redone_ids = redone["templates"]
            .as_array()
            .unwrap()
            .iter()
            .map(|template| template["id"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            redone_ids,
            ["template_weekday", "template_weekend", "template_default"]
        );
    }

    #[test]
    fn encrypted_database_does_not_store_state_as_plaintext() {
        let database = TestDatabase::new("encrypted-bytes");
        let recovery_key = generate_recovery_key();
        let state = test_state("therapy appointment");
        let plaintext = b"therapy appointment";

        {
            let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
            replace_app_state(&mut connection, &state).unwrap();
        }

        let database_bytes = fs::read(&database.path).unwrap();
        assert!(!database_bytes
            .windows(plaintext.len())
            .any(|window| window == plaintext));
    }

    #[test]
    fn encrypted_database_rejects_wrong_key() {
        let database = TestDatabase::new("wrong-key");
        let recovery_key = generate_recovery_key();
        let wrong_key = generate_recovery_key();

        {
            let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
            replace_app_state(&mut connection, &test_state("Wrong key check")).unwrap();
        }

        let error = open_database_at(&database.path, &wrong_key).unwrap_err();
        assert!(
            error.contains("file is not a database") || error.contains("SQL logic error"),
            "{error}"
        );
    }

    #[test]
    fn operation_persistence_updates_only_targeted_rows_and_operation_log() {
        let database = TestDatabase::new("operation-persistence");
        let recovery_key = generate_recovery_key();
        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
        replace_app_state(&mut connection, &test_state("Operation test")).unwrap();

        persist_operation_to_database(
            &mut connection,
            &json!({
                "id": "op_device_test_2",
                "deviceId": "device_test",
                "sequence": 2,
                "type": "patch_plan_item",
                "timestamp": "2026-05-21T00:01:00Z",
                "payload": {
                    "planId": "plan_today",
                    "itemId": "plan_item_wake",
                    "patch": {
                        "text": "Wake up slowly",
                        "html": "<strong>Wake up slowly</strong>"
                    }
                }
            }),
        )
        .unwrap();

        let saved = read_app_state_from_database(&connection).unwrap().unwrap();
        assert_eq!(saved["plans"][0]["items"][0]["text"], "Wake up slowly");
        assert_eq!(
            saved["plans"][0]["items"][0]["html"],
            "<strong>Wake up slowly</strong>"
        );
        assert_eq!(saved["operations"].as_array().unwrap().len(), 0);
        assert_eq!(read_operations(&connection).unwrap().len(), 2);
        assert_eq!(history_entry_count(&connection), 1);
        assert_eq!(saved["localSequence"], 2);
    }

    #[test]
    fn completing_a_child_persists_and_undoes_completed_parents() {
        let database = TestDatabase::new("complete-plan-item-parents");
        let recovery_key = generate_recovery_key();
        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
        let mut state = test_state("Parent completion test");
        state["plans"][0]["items"] = json!([{
            "id": "grandparent",
            "text": "Grandparent",
            "html": "Grandparent",
            "done": false,
            "startMinutes": null,
            "endMinutes": null,
            "children": [{
                "id": "parent",
                "text": "Parent",
                "html": "Parent",
                "done": false,
                "startMinutes": null,
                "endMinutes": null,
                "children": [
                    {
                        "id": "finished_child",
                        "text": "Finished child",
                        "html": "Finished child",
                        "done": true,
                        "startMinutes": null,
                        "endMinutes": null,
                        "children": []
                    },
                    {
                        "id": "final_child",
                        "text": "Final child",
                        "html": "Final child",
                        "done": false,
                        "startMinutes": null,
                        "endMinutes": null,
                        "children": []
                    }
                ]
            }]
        }]);
        replace_app_state(&mut connection, &state).unwrap();

        persist_operation_to_database(
            &mut connection,
            &json!({
                "id": "op_device_test_2",
                "deviceId": "device_test",
                "sequence": 2,
                "type": "patch_plan_item",
                "timestamp": "2026-05-21T00:01:00Z",
                "payload": {
                    "planId": "plan_today",
                    "itemId": "final_child",
                    "patch": { "done": true },
                    "completedParentIds": ["parent", "grandparent"]
                }
            }),
        )
        .unwrap();

        let saved = read_app_state_from_database(&connection).unwrap().unwrap();
        let grandparent = &saved["plans"][0]["items"][0];
        assert_eq!(grandparent["done"], true);
        assert_eq!(grandparent["children"][0]["done"], true);
        assert_eq!(grandparent["children"][0]["children"][1]["done"], true);

        let undone = undo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        let grandparent = &undone["plans"][0]["items"][0];
        assert_eq!(grandparent["done"], false);
        assert_eq!(grandparent["children"][0]["done"], false);
        assert_eq!(grandparent["children"][0]["children"][1]["done"], false);

        let redone = redo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        let grandparent = &redone["plans"][0]["items"][0];
        assert_eq!(grandparent["done"], true);
        assert_eq!(grandparent["children"][0]["done"], true);
        assert_eq!(grandparent["children"][0]["children"][1]["done"], true);
    }

    #[test]
    fn completing_a_parent_persists_and_undoes_completed_descendants() {
        let database = TestDatabase::new("complete-plan-item-descendants");
        let recovery_key = generate_recovery_key();
        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
        let mut state = test_state("Descendant completion test");
        state["plans"][0]["items"] = json!([{
            "id": "parent",
            "text": "Parent",
            "html": "Parent",
            "done": false,
            "startMinutes": null,
            "endMinutes": null,
            "children": [{
                "id": "child",
                "text": "Child",
                "html": "Child",
                "done": false,
                "startMinutes": null,
                "endMinutes": null,
                "children": [{
                    "id": "grandchild",
                    "text": "Grandchild",
                    "html": "Grandchild",
                    "done": false,
                    "startMinutes": null,
                    "endMinutes": null,
                    "children": []
                }]
            }]
        }]);
        replace_app_state(&mut connection, &state).unwrap();

        persist_operation_to_database(
            &mut connection,
            &json!({
                "id": "op_device_test_2",
                "deviceId": "device_test",
                "sequence": 2,
                "type": "patch_plan_item",
                "timestamp": "2026-05-21T00:01:00Z",
                "payload": {
                    "planId": "plan_today",
                    "itemId": "parent",
                    "patch": { "done": true },
                    "completedParentIds": [],
                    "completedDescendantIds": ["child", "grandchild"]
                }
            }),
        )
        .unwrap();

        let saved = read_app_state_from_database(&connection).unwrap().unwrap();
        let parent = &saved["plans"][0]["items"][0];
        assert_eq!(parent["done"], true);
        assert_eq!(parent["children"][0]["done"], true);
        assert_eq!(parent["children"][0]["children"][0]["done"], true);

        let undone = undo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        let parent = &undone["plans"][0]["items"][0];
        assert_eq!(parent["done"], false);
        assert_eq!(parent["children"][0]["done"], false);
        assert_eq!(parent["children"][0]["children"][0]["done"], false);

        let redone = redo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        let parent = &redone["plans"][0]["items"][0];
        assert_eq!(parent["done"], true);
        assert_eq!(parent["children"][0]["done"], true);
        assert_eq!(parent["children"][0]["children"][0]["done"], true);
    }

    #[test]
    fn plan_daily_reminder_persists_and_undoes() {
        let database = TestDatabase::new("plan-daily-reminder");
        let recovery_key = generate_recovery_key();
        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
        replace_app_state(&mut connection, &test_state("Reminder test")).unwrap();

        persist_operation_to_database(
            &mut connection,
            &json!({
                "id": "op_device_test_2",
                "deviceId": "device_test",
                "sequence": 2,
                "type": "patch_plan_daily_reminder",
                "timestamp": "2026-05-21T00:01:00Z",
                "payload": {
                    "planId": "plan_today",
                    "dailyReminder": "Keep this concrete"
                }
            }),
        )
        .unwrap();

        let saved = read_app_state_from_database(&connection).unwrap().unwrap();
        assert_eq!(saved["plans"][0]["dailyReminder"], "Keep this concrete");

        let undone = undo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(
            undone["plans"][0]["dailyReminder"],
            "This shouldn't be aspirational"
        );

        let redone = redo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(redone["plans"][0]["dailyReminder"], "Keep this concrete");
    }

    #[test]
    fn operation_persistence_can_upsert_merged_text_operations() {
        let database = TestDatabase::new("operation-upsert");
        let recovery_key = generate_recovery_key();
        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
        replace_app_state(&mut connection, &test_state("Operation test")).unwrap();

        for text in ["Draft", "Draft final"] {
            persist_operation_to_database(
                &mut connection,
                &json!({
                    "id": "op_device_test_2",
                    "deviceId": "device_test",
                    "sequence": 2,
                    "type": "patch_plan_item",
                    "timestamp": "2026-05-21T00:01:00Z",
                    "payload": {
                        "planId": "plan_today",
                        "itemId": "plan_item_wake",
                        "patch": {
                            "text": text,
                            "html": text
                        }
                    }
                }),
            )
            .unwrap();
        }

        let saved = read_app_state_from_database(&connection).unwrap().unwrap();
        assert_eq!(saved["plans"][0]["items"][0]["text"], "Draft final");
        assert_eq!(saved["operations"].as_array().unwrap().len(), 0);
        assert_eq!(read_operations(&connection).unwrap().len(), 2);
        assert_eq!(history_entry_count(&connection), 1);
    }

    #[test]
    fn split_plan_item_persists_and_undoes_as_one_operation() {
        let database = TestDatabase::new("split-plan-item");
        let recovery_key = generate_recovery_key();
        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
        replace_app_state(&mut connection, &test_state("Split test")).unwrap();

        persist_operation_to_database(
            &mut connection,
            &json!({
                "id": "op_device_test_2",
                "deviceId": "device_test",
                "sequence": 2,
                "type": "split_plan_item",
                "timestamp": "2026-05-21T00:01:00Z",
                "payload": {
                    "planId": "plan_today",
                    "itemId": "plan_item_wake",
                    "patch": {
                        "text": "Wake",
                        "html": "Wake"
                    },
                    "newItem": {
                        "id": "plan_item_split",
                        "text": " up",
                        "html": " up",
                        "done": false,
                        "startMinutes": null,
                        "endMinutes": null,
                        "children": []
                    }
                }
            }),
        )
        .unwrap();

        let saved = read_app_state_from_database(&connection).unwrap().unwrap();
        assert_eq!(
            top_plan_item_ids(&saved),
            ["plan_item_wake", "plan_item_split"]
        );
        assert_eq!(saved["plans"][0]["items"][0]["text"], "Wake");
        assert_eq!(saved["plans"][0]["items"][1]["text"], " up");
        assert_eq!(history_entry_count(&connection), 1);

        let undone = undo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(top_plan_item_ids(&undone), ["plan_item_wake"]);
        assert_eq!(undone["plans"][0]["items"][0]["text"], "Wake up");

        let redone = redo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(
            top_plan_item_ids(&redone),
            ["plan_item_wake", "plan_item_split"]
        );
        assert_eq!(redone["plans"][0]["items"][0]["text"], "Wake");
        assert_eq!(redone["plans"][0]["items"][1]["text"], " up");
    }

    #[test]
    fn delete_plan_item_preserving_children_reparents_to_previous_sibling_and_undoes() {
        let database = TestDatabase::new("delete-plan-item-preserve-depth");
        let recovery_key = generate_recovery_key();
        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
        let mut state = test_state("Preserve children test");
        state["plans"][0]["items"][0]["children"] = json!([
            {
                "id": "plan_item_previous",
                "text": "Previous",
                "html": "Previous",
                "done": false,
                "startMinutes": null,
                "endMinutes": null,
                "children": []
            },
            {
                "id": "plan_item_deleted",
                "text": "Delete me",
                "html": "Delete me",
                "done": false,
                "startMinutes": null,
                "endMinutes": null,
                "children": [{
                    "id": "plan_item_preserved",
                    "text": "Preserved",
                    "html": "Preserved",
                    "done": false,
                    "startMinutes": null,
                    "endMinutes": null,
                    "children": []
                }]
            }
        ]);
        replace_app_state(&mut connection, &state).unwrap();

        persist_operation_to_database(
            &mut connection,
            &json!({
                "id": "op_device_test_2",
                "deviceId": "device_test",
                "sequence": 2,
                "type": "delete_plan_item_preserving_children",
                "timestamp": "2026-05-21T00:01:00Z",
                "payload": { "planId": "plan_today", "itemId": "plan_item_deleted" }
            }),
        )
        .unwrap();

        let saved = read_app_state_from_database(&connection).unwrap().unwrap();
        let root_children = saved["plans"][0]["items"][0]["children"]
            .as_array()
            .unwrap();
        assert_eq!(root_children.len(), 1);
        assert_eq!(root_children[0]["id"], "plan_item_previous");
        assert_eq!(root_children[0]["children"][0]["id"], "plan_item_preserved");

        let undone = undo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        let root_children = undone["plans"][0]["items"][0]["children"]
            .as_array()
            .unwrap();
        assert_eq!(root_children.len(), 2);
        assert_eq!(root_children[0]["id"], "plan_item_previous");
        assert_eq!(root_children[1]["id"], "plan_item_deleted");
        assert_eq!(root_children[1]["children"][0]["id"], "plan_item_preserved");

        let redone = redo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(
            redone["plans"][0]["items"][0]["children"][0]["children"][0]["id"],
            "plan_item_preserved"
        );
    }

    #[test]
    fn delete_first_plan_item_preserving_children_promotes_them_one_level() {
        let database = TestDatabase::new("delete-plan-item-clamp-depth");
        let recovery_key = generate_recovery_key();
        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
        let mut state = test_state("Clamp child depth test");
        state["plans"][0]["items"][0]["children"] = json!([
            {
                "id": "plan_item_deleted",
                "text": "Delete me",
                "html": "Delete me",
                "done": false,
                "startMinutes": null,
                "endMinutes": null,
                "children": [{
                    "id": "plan_item_preserved",
                    "text": "Preserved",
                    "html": "Preserved",
                    "done": false,
                    "startMinutes": null,
                    "endMinutes": null,
                    "children": []
                }]
            },
            {
                "id": "plan_item_later",
                "text": "Later",
                "html": "Later",
                "done": false,
                "startMinutes": null,
                "endMinutes": null,
                "children": []
            }
        ]);
        replace_app_state(&mut connection, &state).unwrap();

        persist_operation_to_database(
            &mut connection,
            &json!({
                "id": "op_device_test_2",
                "deviceId": "device_test",
                "sequence": 2,
                "type": "delete_plan_item_preserving_children",
                "timestamp": "2026-05-21T00:01:00Z",
                "payload": { "planId": "plan_today", "itemId": "plan_item_deleted" }
            }),
        )
        .unwrap();

        let saved = read_app_state_from_database(&connection).unwrap().unwrap();
        let root_children = saved["plans"][0]["items"][0]["children"]
            .as_array()
            .unwrap();
        assert_eq!(root_children.len(), 2);
        assert_eq!(root_children[0]["id"], "plan_item_preserved");
        assert_eq!(root_children[1]["id"], "plan_item_later");
    }

    #[test]
    fn split_plan_item_can_insert_blank_item_before_source() {
        let database = TestDatabase::new("split-plan-item-before");
        let recovery_key = generate_recovery_key();
        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
        replace_app_state(&mut connection, &test_state("Split before test")).unwrap();

        persist_operation_to_database(
            &mut connection,
            &json!({
                "id": "op_device_test_2",
                "deviceId": "device_test",
                "sequence": 2,
                "type": "split_plan_item",
                "timestamp": "2026-05-21T00:01:00Z",
                "payload": {
                    "planId": "plan_today",
                    "itemId": "plan_item_wake",
                    "patch": {
                        "text": "Wake up",
                        "html": "Wake up"
                    },
                    "newItem": {
                        "id": "plan_item_blank",
                        "text": "",
                        "html": "",
                        "done": false,
                        "startMinutes": null,
                        "endMinutes": null,
                        "children": []
                    },
                    "placement": "before"
                }
            }),
        )
        .unwrap();

        let saved = read_app_state_from_database(&connection).unwrap().unwrap();
        assert_eq!(
            top_plan_item_ids(&saved),
            ["plan_item_blank", "plan_item_wake"]
        );
        assert_eq!(saved["plans"][0]["items"][0]["text"], "");
        assert_eq!(saved["plans"][0]["items"][1]["text"], "Wake up");

        let undone = undo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(top_plan_item_ids(&undone), ["plan_item_wake"]);

        let redone = redo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(
            top_plan_item_ids(&redone),
            ["plan_item_blank", "plan_item_wake"]
        );
        assert_eq!(redone["plans"][0]["items"][1]["text"], "Wake up");
    }

    #[test]
    fn split_plan_item_can_move_children_to_new_item() {
        let database = TestDatabase::new("split-plan-item-move-children");
        let recovery_key = generate_recovery_key();
        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
        let mut state = test_state("Split children test");
        state["plans"][0]["items"][0]["children"] = json!([
            {
                "id": "plan_item_child",
                "text": "Stretch",
                "html": "Stretch",
                "done": false,
                "startMinutes": null,
                "endMinutes": null,
                "children": []
            }
        ]);
        replace_app_state(&mut connection, &state).unwrap();

        persist_operation_to_database(
            &mut connection,
            &json!({
                "id": "op_device_test_2",
                "deviceId": "device_test",
                "sequence": 2,
                "type": "split_plan_item",
                "timestamp": "2026-05-21T00:01:00Z",
                "payload": {
                    "planId": "plan_today",
                    "itemId": "plan_item_wake",
                    "patch": {
                        "text": "Wake",
                        "html": "Wake"
                    },
                    "newItem": {
                        "id": "plan_item_split",
                        "text": " up",
                        "html": " up",
                        "done": false,
                        "startMinutes": null,
                        "endMinutes": null,
                        "children": []
                    },
                    "moveChildrenToNewItem": true
                }
            }),
        )
        .unwrap();

        let saved = read_app_state_from_database(&connection).unwrap().unwrap();
        assert_eq!(
            top_plan_item_ids(&saved),
            ["plan_item_wake", "plan_item_split"]
        );
        assert_eq!(saved["plans"][0]["items"][0]["children"], json!([]));
        assert_eq!(
            saved["plans"][0]["items"][1]["children"][0]["id"],
            "plan_item_child"
        );

        let undone = undo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(top_plan_item_ids(&undone), ["plan_item_wake"]);
        assert_eq!(undone["plans"][0]["items"][0]["text"], "Wake up");
        assert_eq!(
            undone["plans"][0]["items"][0]["children"][0]["id"],
            "plan_item_child"
        );

        let redone = redo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(
            top_plan_item_ids(&redone),
            ["plan_item_wake", "plan_item_split"]
        );
        assert_eq!(
            redone["plans"][0]["items"][1]["children"][0]["id"],
            "plan_item_child"
        );
    }

    #[test]
    fn backspace_plan_item_at_start_deletes_empty_previous_item() {
        let database = TestDatabase::new("backspace-delete-previous");
        let recovery_key = generate_recovery_key();
        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
        let mut state = test_state("Backspace delete test");
        state["plans"][0]["items"] = json!([
            {
                "id": "plan_item_blank",
                "text": "",
                "html": "",
                "done": false,
                "startMinutes": null,
                "endMinutes": null,
                "children": []
            },
            {
                "id": "plan_item_wake",
                "text": "Wake up",
                "html": "Wake up",
                "done": false,
                "startMinutes": null,
                "endMinutes": null,
                "children": []
            }
        ]);
        replace_app_state(&mut connection, &state).unwrap();

        persist_operation_to_database(
            &mut connection,
            &json!({
                "id": "op_device_test_2",
                "deviceId": "device_test",
                "sequence": 2,
                "type": "backspace_plan_item_at_start",
                "timestamp": "2026-05-21T00:01:00Z",
                "payload": {
                    "planId": "plan_today",
                    "itemId": "plan_item_wake",
                    "previousId": "plan_item_blank",
                    "action": "delete_previous"
                }
            }),
        )
        .unwrap();

        let saved = read_app_state_from_database(&connection).unwrap().unwrap();
        assert_eq!(top_plan_item_ids(&saved), ["plan_item_wake"]);

        let undone = undo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(
            top_plan_item_ids(&undone),
            ["plan_item_blank", "plan_item_wake"]
        );

        let redone = redo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(top_plan_item_ids(&redone), ["plan_item_wake"]);
    }

    #[test]
    fn backspace_plan_item_at_start_merges_current_item_into_previous_item() {
        let database = TestDatabase::new("backspace-merge-current");
        let recovery_key = generate_recovery_key();
        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
        let mut state = test_state("Backspace merge test");
        state["plans"][0]["items"] = json!([
            {
                "id": "plan_item_wake",
                "text": "Wake up",
                "html": "Wake up",
                "done": false,
                "startMinutes": null,
                "endMinutes": null,
                "children": []
            },
            {
                "id": "plan_item_move",
                "text": "Move",
                "html": "Move",
                "done": false,
                "startMinutes": null,
                "endMinutes": null,
                "children": [
                    {
                        "id": "plan_item_child",
                        "text": "Stretch",
                        "html": "Stretch",
                        "done": false,
                        "startMinutes": null,
                        "endMinutes": null,
                        "children": []
                    }
                ]
            }
        ]);
        replace_app_state(&mut connection, &state).unwrap();

        persist_operation_to_database(
            &mut connection,
            &json!({
                "id": "op_device_test_2",
                "deviceId": "device_test",
                "sequence": 2,
                "type": "backspace_plan_item_at_start",
                "timestamp": "2026-05-21T00:01:00Z",
                "payload": {
                    "planId": "plan_today",
                    "itemId": "plan_item_move",
                    "previousId": "plan_item_wake",
                    "action": "merge",
                    "patch": {
                        "text": "Wake upMove",
                        "html": "Wake upMove"
                    }
                }
            }),
        )
        .unwrap();

        let saved = read_app_state_from_database(&connection).unwrap().unwrap();
        assert_eq!(top_plan_item_ids(&saved), ["plan_item_wake"]);
        assert_eq!(saved["plans"][0]["items"][0]["text"], "Wake upMove");
        assert_eq!(
            saved["plans"][0]["items"][0]["children"][0]["id"],
            "plan_item_child"
        );

        let undone = undo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(
            top_plan_item_ids(&undone),
            ["plan_item_wake", "plan_item_move"]
        );
        assert_eq!(undone["plans"][0]["items"][0]["text"], "Wake up");
        assert_eq!(
            undone["plans"][0]["items"][1]["children"][0]["id"],
            "plan_item_child"
        );

        let redone = redo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(top_plan_item_ids(&redone), ["plan_item_wake"]);
        assert_eq!(redone["plans"][0]["items"][0]["text"], "Wake upMove");
        assert_eq!(
            redone["plans"][0]["items"][0]["children"][0]["id"],
            "plan_item_child"
        );
    }

    #[test]
    fn paste_plan_items_can_replace_target_item() {
        let database = TestDatabase::new("paste-replace-target");
        let recovery_key = generate_recovery_key();
        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
        let mut state = test_state("Paste replace test");
        state["plans"][0]["items"] = json!([
            {
                "id": "plan_item_blank",
                "text": "",
                "html": "",
                "done": false,
                "startMinutes": null,
                "endMinutes": null,
                "children": []
            },
            {
                "id": "plan_item_wake",
                "text": "Wake up",
                "html": "Wake up",
                "done": false,
                "startMinutes": null,
                "endMinutes": null,
                "children": []
            }
        ]);
        replace_app_state(&mut connection, &state).unwrap();

        persist_operation_to_database(
            &mut connection,
            &json!({
                "id": "op_device_test_2",
                "deviceId": "device_test",
                "sequence": 2,
                "type": "paste_plan_items",
                "timestamp": "2026-05-21T00:01:00Z",
                "payload": {
                    "planId": "plan_today",
                    "targetId": "plan_item_blank",
                    "placement": "replace",
                    "items": [
                        {
                            "id": "plan_item_pasted_one",
                            "text": "Pasted one",
                            "html": "Pasted one",
                            "done": false,
                            "startMinutes": null,
                            "endMinutes": null,
                            "children": []
                        },
                        {
                            "id": "plan_item_pasted_two",
                            "text": "Pasted two",
                            "html": "Pasted two",
                            "done": false,
                            "startMinutes": null,
                            "endMinutes": null,
                            "children": []
                        }
                    ]
                }
            }),
        )
        .unwrap();

        let saved = read_app_state_from_database(&connection).unwrap().unwrap();
        assert_eq!(
            top_plan_item_ids(&saved),
            [
                "plan_item_pasted_one",
                "plan_item_pasted_two",
                "plan_item_wake"
            ]
        );

        let undone = undo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(
            top_plan_item_ids(&undone),
            ["plan_item_blank", "plan_item_wake"]
        );

        let redone = redo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(
            top_plan_item_ids(&redone),
            [
                "plan_item_pasted_one",
                "plan_item_pasted_two",
                "plan_item_wake"
            ]
        );
    }

    #[test]
    fn move_plan_item_to_plan_carries_the_subtree_across_days() {
        let database = TestDatabase::new("move-plan-item-across-days");
        let recovery_key = generate_recovery_key();
        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
        let mut state = test_state("Cross-day move test");
        state["plans"][0]["items"] = json!([
            {
                "id": "plan_item_wake",
                "text": "Wake up",
                "html": "Wake up",
                "done": false,
                "startMinutes": null,
                "endMinutes": null,
                "children": []
            },
            {
                "id": "plan_item_errands",
                "text": "Errands",
                "html": "Errands",
                "done": false,
                "startMinutes": null,
                "endMinutes": null,
                "children": [
                    {
                        "id": "plan_item_groceries",
                        "text": "Groceries",
                        "html": "Groceries",
                        "done": false,
                        "startMinutes": null,
                        "endMinutes": null,
                        "children": []
                    }
                ]
            }
        ]);
        state["plans"].as_array_mut().unwrap().push(json!({
            "id": "plan_tomorrow",
            "date": "2026-05-22",
            "title": "Tomorrow",
            "dailyReminder": "This shouldn't be aspirational",
            "generatedFromTemplateId": "template_default",
            "createdAt": "2026-05-21T00:00:00Z",
            "items": [
                {
                    "id": "plan_item_rest",
                    "text": "Rest",
                    "html": "Rest",
                    "done": false,
                    "startMinutes": null,
                    "endMinutes": null,
                    "children": []
                }
            ]
        }));
        replace_app_state(&mut connection, &state).unwrap();

        let move_operation = json!({
            "id": "op_device_test_2",
            "deviceId": "device_test",
            "sequence": 2,
            "type": "move_plan_item_to_plan",
            "timestamp": "2026-05-21T00:01:00Z",
            "payload": {
                "sourcePlanId": "plan_today",
                "targetPlanId": "plan_tomorrow",
                "itemId": "plan_item_errands",
                "targetId": "plan_item_rest",
                "placement": "before",
                "item": {
                    "id": "plan_item_errands",
                    "text": "Errands",
                    "html": "Errands",
                    "done": false,
                    "startMinutes": null,
                    "endMinutes": null,
                    "children": [
                        {
                            "id": "plan_item_groceries",
                            "text": "Groceries",
                            "html": "Groceries",
                            "done": false,
                            "startMinutes": null,
                            "endMinutes": null,
                            "children": []
                        }
                    ]
                }
            }
        });
        persist_operation_to_database(&mut connection, &move_operation).unwrap();

        let saved = read_app_state_from_database(&connection).unwrap().unwrap();
        assert_eq!(
            plan_item_ids_for_plan(&saved, "plan_today"),
            ["plan_item_wake"]
        );
        assert_eq!(
            plan_item_ids_for_plan(&saved, "plan_tomorrow"),
            ["plan_item_errands", "plan_item_rest"]
        );
        // The child must travel with its parent: a descendant left behind in the
        // old plan would silently vanish from both days.
        assert_eq!(
            plan_by_id(&saved, "plan_tomorrow")["items"][0]["children"][0]["id"],
            "plan_item_groceries"
        );

        let undone = undo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(
            plan_item_ids_for_plan(&undone, "plan_today"),
            ["plan_item_wake", "plan_item_errands"]
        );
        assert_eq!(
            plan_by_id(&undone, "plan_today")["items"][1]["children"][0]["id"],
            "plan_item_groceries"
        );
        assert_eq!(
            plan_item_ids_for_plan(&undone, "plan_tomorrow"),
            ["plan_item_rest"]
        );

        let redone = redo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(
            plan_item_ids_for_plan(&redone, "plan_today"),
            ["plan_item_wake"]
        );
        assert_eq!(
            plan_item_ids_for_plan(&redone, "plan_tomorrow"),
            ["plan_item_errands", "plan_item_rest"]
        );
    }

    #[test]
    fn undo_and_redo_use_inverse_operations_not_full_state_snapshots() {
        let database = TestDatabase::new("operation-history");
        let recovery_key = generate_recovery_key();
        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
        replace_app_state(&mut connection, &test_state("History test")).unwrap();

        persist_operation_to_database(
            &mut connection,
            &json!({
                "id": "op_device_test_2",
                "deviceId": "device_test",
                "sequence": 2,
                "type": "patch_plan_item",
                "timestamp": "2026-05-21T00:01:00Z",
                "payload": {
                    "planId": "plan_today",
                    "itemId": "plan_item_wake",
                    "patch": {
                        "text": "Draft final",
                        "html": "<em>Draft final</em>"
                    }
                }
            }),
        )
        .unwrap();

        let undo_json: String = connection
            .query_row(
                "select undo_operation_json from history_entries where operation_id = ?1",
                params!["op_device_test_2"],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!undo_json.contains("\"plans\""));
        assert!(!undo_json.contains("\"templates\""));
        assert!(!undo_json.contains("\"schemaVersion\""));

        let undone = undo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(undone["plans"][0]["items"][0]["text"], "Wake up");
        assert_eq!(undone["operations"].as_array().unwrap().len(), 0);
        assert_eq!(undone["localSequence"], 3);

        let redone = redo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(redone["plans"][0]["items"][0]["text"], "Draft final");
        assert_eq!(
            redone["plans"][0]["items"][0]["html"],
            "<em>Draft final</em>"
        );
        assert_eq!(redone["operations"].as_array().unwrap().len(), 0);
        assert_eq!(redone["localSequence"], 4);
        assert_eq!(read_operations(&connection).unwrap().len(), 4);
    }

    #[test]
    fn native_history_snapshots_match_existing_encrypted_database_state() {
        let database = TestDatabase::new("native-history-snapshot");
        let recovery_key = generate_recovery_key();
        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
        replace_app_state(&mut connection, &test_state("Snapshot history")).unwrap();

        let first_operation = json!({
            "id": "op_device_test_2",
            "deviceId": "device_test",
            "sequence": 2,
            "type": "patch_plan_item",
            "timestamp": "2026-05-21T00:01:00Z",
            "payload": {
                "planId": "plan_today",
                "itemId": "plan_item_wake",
                "patch": { "text": "Changed once", "html": "Changed once" }
            }
        });
        persist_operation_to_database(&mut connection, &first_operation).unwrap();

        let undo = undo_last_operation_for_ui(&mut connection, Some("op_device_test_2"))
            .unwrap()
            .unwrap();
        assert_eq!(undo["operationId"], "op_device_test_2");
        assert_eq!(undo["localSequence"], 3);
        assert!(undo["state"].is_null());
        let stored = read_app_state_from_database(&connection).unwrap().unwrap();
        assert_eq!(stored["plans"][0]["items"][0]["text"], "Wake up");

        let redo = redo_last_operation_for_ui(&mut connection, Some("op_device_test_2"))
            .unwrap()
            .unwrap();
        assert_eq!(redo["operationId"], "op_device_test_2");
        assert_eq!(redo["localSequence"], 4);
        assert!(redo["state"].is_null());
        let stored = read_app_state_from_database(&connection).unwrap().unwrap();
        assert_eq!(stored["plans"][0]["items"][0]["text"], "Changed once");

        let second_operation = json!({
            "id": "op_device_test_5",
            "deviceId": "device_test",
            "sequence": 5,
            "type": "patch_plan_item",
            "timestamp": "2026-05-21T00:02:00Z",
            "payload": {
                "planId": "plan_today",
                "itemId": "plan_item_wake",
                "patch": { "text": "Changed twice", "html": "Changed twice" }
            }
        });
        persist_operation_to_database(&mut connection, &second_operation).unwrap();

        // A stale in-memory entry must never be trusted. The database still
        // performs the correct undo and returns its complete authoritative state.
        let fallback = undo_last_operation_for_ui(&mut connection, Some("stale-operation"))
            .unwrap()
            .unwrap();
        assert_eq!(fallback["operationId"], "op_device_test_5");
        assert_eq!(fallback["localSequence"], 6);
        assert_eq!(
            fallback["state"]["plans"][0]["items"][0]["text"],
            "Changed once"
        );

        let integrity: String = connection
            .query_row("pragma integrity_check", [], |row| row.get(0))
            .unwrap();
        assert_eq!(integrity, "ok");
        let mut foreign_key_check = connection.prepare("pragma foreign_key_check").unwrap();
        let foreign_key_errors = foreign_key_check
            .query_map([], |_| Ok(()))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
            .len();
        drop(foreign_key_check);
        assert_eq!(foreign_key_errors, 0);
        assert_eq!(history_entry_count(&connection), 2);
        drop(connection);

        let reopened = open_database_at(&database.path, &recovery_key).unwrap();
        let reopened_state = read_app_state_from_database(&reopened).unwrap().unwrap();
        assert_eq!(reopened_state, fallback["state"]);
        assert_eq!(history_entry_count(&reopened), 2);
        assert_eq!(read_operations(&reopened).unwrap().len(), 6);
    }

    #[test]
    fn undo_and_redo_restore_item_movement_positions() {
        let database = TestDatabase::new("movement-history");
        let recovery_key = generate_recovery_key();
        let mut state = test_state("Move test");
        state["plans"][0]["items"]
            .as_array_mut()
            .unwrap()
            .push(json!({
                "id": "plan_item_second",
                "text": "Second item",
                "html": "Second item",
                "done": false,
                "startMinutes": null,
                "endMinutes": null,
                "children": []
            }));

        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
        replace_app_state(&mut connection, &state).unwrap();

        persist_operation_to_database(
            &mut connection,
            &json!({
                "id": "op_device_test_2",
                "deviceId": "device_test",
                "sequence": 2,
                "type": "move_plan_item_within_level",
                "timestamp": "2026-05-21T00:01:00Z",
                "payload": {
                    "planId": "plan_today",
                    "itemId": "plan_item_wake",
                    "direction": "down"
                }
            }),
        )
        .unwrap();

        let moved = read_app_state_from_database(&connection).unwrap().unwrap();
        assert_eq!(
            top_plan_item_ids(&moved),
            ["plan_item_second", "plan_item_wake"]
        );

        let undone = undo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(
            top_plan_item_ids(&undone),
            ["plan_item_wake", "plan_item_second"]
        );

        let redone = redo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(
            top_plan_item_ids(&redone),
            ["plan_item_second", "plan_item_wake"]
        );
    }

    #[test]
    fn indent_plan_items_persists_and_undoes() {
        let database = TestDatabase::new("plan-indent");
        let recovery_key = generate_recovery_key();
        let mut state = test_state("Plan indent test");
        state["plans"][0]["items"].as_array_mut().unwrap().extend([
            json!({
                "id": "plan_item_second",
                "text": "Second item",
                "html": "Second item",
                "done": false,
                "startMinutes": null,
                "endMinutes": null,
                "children": []
            }),
            json!({
                "id": "plan_item_third",
                "text": "Third item",
                "html": "Third item",
                "done": false,
                "startMinutes": null,
                "endMinutes": null,
                "children": []
            }),
        ]);

        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
        replace_app_state(&mut connection, &state).unwrap();

        persist_operation_to_database(
            &mut connection,
            &json!({
                "id": "op_device_test_2",
                "deviceId": "device_test",
                "sequence": 2,
                "type": "indent_plan_items",
                "timestamp": "2026-05-21T00:01:00Z",
                "payload": {
                    "planId": "plan_today",
                    "itemIds": ["plan_item_second", "plan_item_third"]
                }
            }),
        )
        .unwrap();

        let indented = read_app_state_from_database(&connection).unwrap().unwrap();
        assert_eq!(top_plan_item_ids(&indented), ["plan_item_wake"]);
        assert_eq!(
            indented["plans"][0]["items"][0]["children"][0]["id"],
            "plan_item_second"
        );
        assert_eq!(
            indented["plans"][0]["items"][0]["children"][1]["id"],
            "plan_item_third"
        );

        let undone = undo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(
            top_plan_item_ids(&undone),
            ["plan_item_wake", "plan_item_second", "plan_item_third"]
        );

        let redone = redo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(top_plan_item_ids(&redone), ["plan_item_wake"]);
        assert_eq!(
            redone["plans"][0]["items"][0]["children"][0]["id"],
            "plan_item_second"
        );
        assert_eq!(
            redone["plans"][0]["items"][0]["children"][1]["id"],
            "plan_item_third"
        );
    }

    #[test]
    fn outdent_plan_item_promotes_following_siblings_under_it() {
        let database = TestDatabase::new("plan-outdent");
        let recovery_key = generate_recovery_key();
        let mut state = test_state("Plan outdent test");
        state["plans"][0]["items"][0]["children"] = json!([
            {
                "id": "plan_item_first",
                "text": "First child",
                "html": "First child",
                "done": false,
                "startMinutes": null,
                "endMinutes": null,
                "children": []
            },
            {
                "id": "plan_item_second",
                "text": "Second child",
                "html": "Second child",
                "done": false,
                "startMinutes": null,
                "endMinutes": null,
                "children": []
            }
        ]);

        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
        replace_app_state(&mut connection, &state).unwrap();

        persist_operation_to_database(
            &mut connection,
            &json!({
                "id": "op_device_test_2",
                "deviceId": "device_test",
                "sequence": 2,
                "type": "outdent_plan_item",
                "timestamp": "2026-05-21T00:01:00Z",
                "payload": {
                    "planId": "plan_today",
                    "itemId": "plan_item_first"
                }
            }),
        )
        .unwrap();

        let moved = read_app_state_from_database(&connection).unwrap().unwrap();
        assert_eq!(
            top_plan_item_ids(&moved),
            ["plan_item_wake", "plan_item_first"]
        );
        assert_eq!(
            moved["plans"][0]["items"][0]["children"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        assert_eq!(
            moved["plans"][0]["items"][1]["children"][0]["id"],
            "plan_item_second"
        );

        let undone = undo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(top_plan_item_ids(&undone), ["plan_item_wake"]);
        assert_eq!(
            undone["plans"][0]["items"][0]["children"][0]["id"],
            "plan_item_first"
        );
        assert_eq!(
            undone["plans"][0]["items"][0]["children"][1]["id"],
            "plan_item_second"
        );

        let redone = redo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(
            top_plan_item_ids(&redone),
            ["plan_item_wake", "plan_item_first"]
        );
        assert_eq!(
            redone["plans"][0]["items"][1]["children"][0]["id"],
            "plan_item_second"
        );
    }

    #[test]
    fn outdent_plan_items_persists_and_undoes() {
        let database = TestDatabase::new("plan-outdent-multi");
        let recovery_key = generate_recovery_key();
        let mut state = test_state("Plan multi outdent test");
        // Wake has two selected children (each with their own child) plus an
        // unselected trailing sibling.
        state["plans"][0]["items"][0]["children"] = json!([
            {
                "id": "plan_item_alpha",
                "text": "Alpha",
                "html": "Alpha",
                "done": false,
                "startMinutes": null,
                "endMinutes": null,
                "children": [
                    {
                        "id": "plan_item_a1",
                        "text": "A1",
                        "html": "A1",
                        "done": false,
                        "startMinutes": null,
                        "endMinutes": null,
                        "children": []
                    }
                ]
            },
            {
                "id": "plan_item_beta",
                "text": "Beta",
                "html": "Beta",
                "done": false,
                "startMinutes": null,
                "endMinutes": null,
                "children": [
                    {
                        "id": "plan_item_b1",
                        "text": "B1",
                        "html": "B1",
                        "done": false,
                        "startMinutes": null,
                        "endMinutes": null,
                        "children": []
                    }
                ]
            },
            {
                "id": "plan_item_gamma",
                "text": "Gamma",
                "html": "Gamma",
                "done": false,
                "startMinutes": null,
                "endMinutes": null,
                "children": []
            }
        ]);

        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
        replace_app_state(&mut connection, &state).unwrap();

        // This previously failed with "Unsupported operation type: outdent_plan_items".
        persist_operation_to_database(
            &mut connection,
            &json!({
                "id": "op_device_test_2",
                "deviceId": "device_test",
                "sequence": 2,
                "type": "outdent_plan_items",
                "timestamp": "2026-05-21T00:01:00Z",
                "payload": {
                    "planId": "plan_today",
                    "itemIds": ["plan_item_alpha", "plan_item_beta"]
                }
            }),
        )
        .unwrap();

        let moved = read_app_state_from_database(&connection).unwrap().unwrap();
        assert_eq!(
            top_plan_item_ids(&moved),
            ["plan_item_wake", "plan_item_alpha", "plan_item_beta"]
        );
        // Both selected items are promoted; like a single outdent, Gamma is
        // absorbed under the trailing promoted sibling (Beta) rather than dropped
        // or duplicated, matching the front-end tree.
        assert_eq!(
            moved["plans"][0]["items"][0]["children"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        assert_eq!(
            moved["plans"][0]["items"][1]["children"][0]["id"],
            "plan_item_a1"
        );
        let beta_children = moved["plans"][0]["items"][2]["children"]
            .as_array()
            .unwrap();
        assert_eq!(beta_children.len(), 2);
        assert_eq!(beta_children[0]["id"], "plan_item_b1");
        assert_eq!(beta_children[1]["id"], "plan_item_gamma");

        let undone = undo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(top_plan_item_ids(&undone), ["plan_item_wake"]);
        let restored_children = undone["plans"][0]["items"][0]["children"]
            .as_array()
            .unwrap();
        assert_eq!(restored_children.len(), 3);
        assert_eq!(restored_children[0]["id"], "plan_item_alpha");
        assert_eq!(restored_children[1]["id"], "plan_item_beta");
        assert_eq!(restored_children[2]["id"], "plan_item_gamma");
        assert_eq!(restored_children[0]["children"][0]["id"], "plan_item_a1");
        assert_eq!(restored_children[1]["children"][0]["id"], "plan_item_b1");

        let redone = redo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(
            top_plan_item_ids(&redone),
            ["plan_item_wake", "plan_item_alpha", "plan_item_beta"]
        );
        assert_eq!(
            redone["plans"][0]["items"][0]["children"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        assert_eq!(
            redone["plans"][0]["items"][2]["children"][1]["id"],
            "plan_item_gamma"
        );
    }

    #[test]
    fn template_option_html_persists_and_undoes() {
        let database = TestDatabase::new("template-option-html");
        let recovery_key = generate_recovery_key();
        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
        replace_app_state(&mut connection, &test_state("Template HTML test")).unwrap();

        persist_operation_to_database(
            &mut connection,
            &json!({
                "id": "op_device_test_2",
                "deviceId": "device_test",
                "sequence": 2,
                "type": "patch_template_option",
                "timestamp": "2026-05-21T00:01:00Z",
                "payload": {
                    "templateId": "template_default",
                    "itemId": "template_item_wake",
                    "optionId": "template_option_wake",
                    "patch": {
                        "text": "Wake up formatted",
                        "html": "<strong>Wake up formatted</strong>"
                    }
                }
            }),
        )
        .unwrap();

        let saved = read_app_state_from_database(&connection).unwrap().unwrap();
        assert_eq!(
            saved["templates"][0]["items"][0]["options"][0]["html"],
            "<strong>Wake up formatted</strong>"
        );

        let undone = undo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(
            undone["templates"][0]["items"][0]["options"][0]["html"],
            "Wake up"
        );

        let redone = redo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(
            redone["templates"][0]["items"][0]["options"][0]["html"],
            "<strong>Wake up formatted</strong>"
        );
    }

    #[test]
    fn backspace_template_option_merge_persists_children_and_undoes() {
        let database = TestDatabase::new("backspace-template-option-merge");
        let recovery_key = generate_recovery_key();
        let mut state = test_state("Template backspace test");
        state["templates"][0]["items"] = json!([
            {
                "id": "template_item_first",
                "options": [{
                    "id": "template_option_first",
                    "text": "First",
                    "html": "<strong>First</strong>",
                    "probability": 100
                }],
                "children": []
            },
            {
                "id": "template_item_second",
                "options": [{
                    "id": "template_option_second",
                    "text": "Second",
                    "html": "<em>Second</em>",
                    "probability": 100
                }],
                "children": [{
                    "id": "template_item_child",
                    "options": [{
                        "id": "template_option_child",
                        "text": "Child",
                        "html": "Child",
                        "probability": 100
                    }],
                    "children": []
                }]
            }
        ]);
        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
        replace_app_state(&mut connection, &state).unwrap();

        persist_operation_to_database(
            &mut connection,
            &json!({
                "id": "op_device_test_2",
                "deviceId": "device_test",
                "sequence": 2,
                "type": "backspace_template_option_at_start",
                "timestamp": "2026-05-21T00:01:00Z",
                "payload": {
                    "templateId": "template_default",
                    "itemId": "template_item_second",
                    "optionId": "template_option_second",
                    "action": "merge",
                    "previousItemId": "template_item_first",
                    "previousOptionId": "template_option_first",
                    "patch": {
                        "text": "FirstSecond",
                        "html": "<strong>First</strong><em>Second</em>"
                    }
                }
            }),
        )
        .unwrap();

        let saved = read_app_state_from_database(&connection).unwrap().unwrap();
        let saved_items = saved["templates"][0]["items"].as_array().unwrap();
        assert_eq!(saved_items.len(), 1);
        assert_eq!(saved_items[0]["options"][0]["text"], "FirstSecond");
        assert_eq!(saved_items[0]["children"][0]["id"], "template_item_child");

        let undone = undo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        let undone_items = undone["templates"][0]["items"].as_array().unwrap();
        assert_eq!(undone_items.len(), 2);
        assert_eq!(undone_items[0]["options"][0]["text"], "First");
        assert_eq!(undone_items[1]["options"][0]["text"], "Second");
        assert_eq!(undone_items[1]["children"][0]["id"], "template_item_child");

        let redone = redo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        let redone_items = redone["templates"][0]["items"].as_array().unwrap();
        assert_eq!(redone_items.len(), 1);
        assert_eq!(redone_items[0]["options"][0]["text"], "FirstSecond");
        assert_eq!(redone_items[0]["children"][0]["id"], "template_item_child");
    }

    #[test]
    fn template_item_time_persists_and_undoes() {
        let database = TestDatabase::new("template-item-time");
        let recovery_key = generate_recovery_key();
        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
        replace_app_state(&mut connection, &test_state("Template time test")).unwrap();

        persist_operation_to_database(
            &mut connection,
            &json!({
                "id": "op_device_test_2",
                "deviceId": "device_test",
                "sequence": 2,
                "type": "patch_template_item",
                "timestamp": "2026-05-21T00:01:00Z",
                "payload": {
                    "templateId": "template_default",
                    "itemId": "template_item_wake",
                    "patch": {
                        "startMinutes": 540,
                        "endMinutes": 600
                    }
                }
            }),
        )
        .unwrap();

        let saved = read_app_state_from_database(&connection).unwrap().unwrap();
        assert_eq!(saved["templates"][0]["items"][0]["startMinutes"], 540);
        assert_eq!(saved["templates"][0]["items"][0]["endMinutes"], 600);

        let undone = undo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(
            undone["templates"][0]["items"][0]["startMinutes"],
            Value::Null
        );
        assert_eq!(
            undone["templates"][0]["items"][0]["endMinutes"],
            Value::Null
        );

        let redone = redo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(redone["templates"][0]["items"][0]["startMinutes"], 540);
        assert_eq!(redone["templates"][0]["items"][0]["endMinutes"], 600);

        persist_operation_to_database(
            &mut connection,
            &json!({
                "id": "op_device_test_3",
                "deviceId": "device_test",
                "sequence": 3,
                "type": "patch_template_item",
                "timestamp": "2026-05-21T00:02:00Z",
                "payload": {
                    "templateId": "template_default",
                    "itemId": "template_item_wake",
                    "patch": { "timeHidden": true }
                }
            }),
        )
        .unwrap();

        let hidden = read_app_state_from_database(&connection).unwrap().unwrap();
        assert_eq!(hidden["templates"][0]["items"][0]["startMinutes"], 540);
        assert_eq!(hidden["templates"][0]["items"][0]["endMinutes"], 600);
        assert_eq!(hidden["templates"][0]["items"][0]["timeHidden"], true);

        let visible_again = undo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(
            visible_again["templates"][0]["items"][0]["timeHidden"],
            Value::Null
        );
        assert_eq!(
            visible_again["templates"][0]["items"][0]["startMinutes"],
            540
        );
        assert_eq!(visible_again["templates"][0]["items"][0]["endMinutes"], 600);

        let hidden_again = redo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(hidden_again["templates"][0]["items"][0]["timeHidden"], true);
        assert_eq!(
            hidden_again["templates"][0]["items"][0]["startMinutes"],
            540
        );
        assert_eq!(hidden_again["templates"][0]["items"][0]["endMinutes"], 600);
    }

    #[test]
    fn split_template_item_persists_and_undoes_as_one_operation() {
        let database = TestDatabase::new("split-template-item");
        let recovery_key = generate_recovery_key();
        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
        replace_app_state(&mut connection, &test_state("Template split test")).unwrap();

        persist_operation_to_database(
            &mut connection,
            &json!({
                "id": "op_device_test_2",
                "deviceId": "device_test",
                "sequence": 2,
                "type": "split_template_item",
                "timestamp": "2026-05-21T00:01:00Z",
                "payload": {
                    "templateId": "template_default",
                    "itemId": "template_item_wake",
                    "optionId": "template_option_wake",
                    "patch": {
                        "text": "Wake",
                        "html": "Wake"
                    },
                    "newItem": {
                        "id": "template_item_split",
                        "startMinutes": null,
                        "endMinutes": null,
                        "options": [
                            {
                                "id": "template_option_split",
                                "text": " up",
                                "html": " up",
                                "probability": 100
                            }
                        ],
                        "children": []
                    }
                }
            }),
        )
        .unwrap();

        let saved = read_app_state_from_database(&connection).unwrap().unwrap();
        assert_eq!(
            top_template_item_ids(&saved),
            ["template_item_wake", "template_item_split"]
        );
        assert_eq!(
            saved["templates"][0]["items"][0]["options"][0]["text"],
            "Wake"
        );
        assert_eq!(
            saved["templates"][0]["items"][1]["options"][0]["text"],
            " up"
        );

        let undone = undo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(top_template_item_ids(&undone), ["template_item_wake"]);
        assert_eq!(
            undone["templates"][0]["items"][0]["options"][0]["text"],
            "Wake up"
        );

        let redone = redo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(
            top_template_item_ids(&redone),
            ["template_item_wake", "template_item_split"]
        );
        assert_eq!(
            redone["templates"][0]["items"][0]["options"][0]["text"],
            "Wake"
        );
    }

    #[test]
    fn split_template_item_can_insert_blank_item_before_source() {
        let database = TestDatabase::new("split-template-item-before");
        let recovery_key = generate_recovery_key();
        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
        replace_app_state(&mut connection, &test_state("Template split before test")).unwrap();

        persist_operation_to_database(
            &mut connection,
            &json!({
                "id": "op_device_test_2",
                "deviceId": "device_test",
                "sequence": 2,
                "type": "split_template_item",
                "timestamp": "2026-05-21T00:01:00Z",
                "payload": {
                    "templateId": "template_default",
                    "itemId": "template_item_wake",
                    "optionId": "template_option_wake",
                    "patch": {
                        "text": "Wake up",
                        "html": "Wake up"
                    },
                    "newItem": {
                        "id": "template_item_blank",
                        "startMinutes": null,
                        "endMinutes": null,
                        "options": [
                            {
                                "id": "template_option_blank",
                                "text": "",
                                "html": "",
                                "probability": 100
                            }
                        ],
                        "children": []
                    },
                    "placement": "before"
                }
            }),
        )
        .unwrap();

        let saved = read_app_state_from_database(&connection).unwrap().unwrap();
        assert_eq!(
            top_template_item_ids(&saved),
            ["template_item_blank", "template_item_wake"]
        );
        assert_eq!(saved["templates"][0]["items"][0]["options"][0]["text"], "");
        assert_eq!(
            saved["templates"][0]["items"][1]["options"][0]["text"],
            "Wake up"
        );

        let undone = undo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(top_template_item_ids(&undone), ["template_item_wake"]);

        let redone = redo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(
            top_template_item_ids(&redone),
            ["template_item_blank", "template_item_wake"]
        );
        assert_eq!(
            redone["templates"][0]["items"][1]["options"][0]["text"],
            "Wake up"
        );
    }

    #[test]
    fn template_item_movement_persists_and_undoes() {
        let database = TestDatabase::new("template-movement");
        let recovery_key = generate_recovery_key();
        let mut state = test_state("Template movement test");
        state["templates"][0]["items"]
            .as_array_mut()
            .unwrap()
            .push(json!({
                "id": "template_item_second",
                "options": [
                    {
                        "id": "template_option_second",
                        "text": "Second template item",
                        "html": "Second template item",
                        "probability": 100
                    }
                ],
                "children": []
            }));

        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
        replace_app_state(&mut connection, &state).unwrap();

        persist_operation_to_database(
            &mut connection,
            &json!({
                "id": "op_device_test_2",
                "deviceId": "device_test",
                "sequence": 2,
                "type": "move_template_item",
                "timestamp": "2026-05-21T00:01:00Z",
                "payload": {
                    "templateId": "template_default",
                    "sourceId": "template_item_wake",
                    "targetId": "template_item_second",
                    "placement": "after"
                }
            }),
        )
        .unwrap();

        let moved = read_app_state_from_database(&connection).unwrap().unwrap();
        assert_eq!(
            top_template_item_ids(&moved),
            ["template_item_second", "template_item_wake"]
        );

        let undone = undo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(
            top_template_item_ids(&undone),
            ["template_item_wake", "template_item_second"]
        );

        let redone = redo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(
            top_template_item_ids(&redone),
            ["template_item_second", "template_item_wake"]
        );
    }

    #[test]
    fn indent_template_items_persists_and_undoes() {
        let database = TestDatabase::new("template-indent-multi");
        let recovery_key = generate_recovery_key();
        let mut state = test_state("Template multi indent test");
        state["templates"][0]["items"]
            .as_array_mut()
            .unwrap()
            .extend([
                json!({
                    "id": "template_item_second",
                    "startMinutes": null,
                    "endMinutes": null,
                    "options": [{
                        "id": "template_option_second",
                        "text": "Second item",
                        "html": "Second item",
                        "probability": 100
                    }],
                    "children": []
                }),
                json!({
                    "id": "template_item_third",
                    "startMinutes": null,
                    "endMinutes": null,
                    "options": [{
                        "id": "template_option_third",
                        "text": "Third item",
                        "html": "Third item",
                        "probability": 100
                    }],
                    "children": []
                }),
            ]);

        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
        replace_app_state(&mut connection, &state).unwrap();

        persist_operation_to_database(
            &mut connection,
            &json!({
                "id": "op_device_test_2",
                "deviceId": "device_test",
                "sequence": 2,
                "type": "indent_template_items",
                "timestamp": "2026-05-21T00:01:00Z",
                "payload": {
                    "templateId": "template_default",
                    "itemIds": ["template_item_second", "template_item_third"]
                }
            }),
        )
        .unwrap();

        let indented = read_app_state_from_database(&connection).unwrap().unwrap();
        assert_eq!(top_template_item_ids(&indented), ["template_item_wake"]);
        assert_eq!(
            indented["templates"][0]["items"][0]["children"][0]["id"],
            "template_item_second"
        );
        assert_eq!(
            indented["templates"][0]["items"][0]["children"][1]["id"],
            "template_item_third"
        );

        let undone = undo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(
            top_template_item_ids(&undone),
            [
                "template_item_wake",
                "template_item_second",
                "template_item_third"
            ]
        );

        let redone = redo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(top_template_item_ids(&redone), ["template_item_wake"]);
        assert_eq!(
            redone["templates"][0]["items"][0]["children"][0]["id"],
            "template_item_second"
        );
        assert_eq!(
            redone["templates"][0]["items"][0]["children"][1]["id"],
            "template_item_third"
        );
    }

    #[test]
    fn outdent_template_item_promotes_following_siblings_under_it() {
        let database = TestDatabase::new("template-outdent");
        let recovery_key = generate_recovery_key();
        let mut state = test_state("Template outdent test");
        state["templates"][0]["items"][0]["children"] = json!([
            {
                "id": "template_item_first",
                "startMinutes": null,
                "endMinutes": null,
                "options": [
                    {
                        "id": "template_option_first",
                        "text": "First child",
                        "html": "First child",
                        "probability": 100
                    }
                ],
                "children": []
            },
            {
                "id": "template_item_second",
                "startMinutes": null,
                "endMinutes": null,
                "options": [
                    {
                        "id": "template_option_second",
                        "text": "Second child",
                        "html": "Second child",
                        "probability": 100
                    }
                ],
                "children": []
            }
        ]);

        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
        replace_app_state(&mut connection, &state).unwrap();

        persist_operation_to_database(
            &mut connection,
            &json!({
                "id": "op_device_test_2",
                "deviceId": "device_test",
                "sequence": 2,
                "type": "outdent_template_item",
                "timestamp": "2026-05-21T00:01:00Z",
                "payload": {
                    "templateId": "template_default",
                    "itemId": "template_item_first"
                }
            }),
        )
        .unwrap();

        let moved = read_app_state_from_database(&connection).unwrap().unwrap();
        assert_eq!(
            top_template_item_ids(&moved),
            ["template_item_wake", "template_item_first"]
        );
        assert_eq!(
            moved["templates"][0]["items"][0]["children"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        assert_eq!(
            moved["templates"][0]["items"][1]["children"][0]["id"],
            "template_item_second"
        );

        let undone = undo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(top_template_item_ids(&undone), ["template_item_wake"]);
        assert_eq!(
            undone["templates"][0]["items"][0]["children"][0]["id"],
            "template_item_first"
        );
        assert_eq!(
            undone["templates"][0]["items"][0]["children"][1]["id"],
            "template_item_second"
        );

        let redone = redo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(
            top_template_item_ids(&redone),
            ["template_item_wake", "template_item_first"]
        );
        assert_eq!(
            redone["templates"][0]["items"][1]["children"][0]["id"],
            "template_item_second"
        );
    }

    #[test]
    fn outdent_template_items_persists_and_undoes() {
        let database = TestDatabase::new("template-outdent-multi");
        let recovery_key = generate_recovery_key();
        let mut state = test_state("Template multi outdent test");
        state["templates"][0]["items"][0]["children"] = json!([
            {
                "id": "template_item_alpha",
                "startMinutes": null,
                "endMinutes": null,
                "options": [{
                    "id": "template_option_alpha",
                    "text": "Alpha",
                    "html": "Alpha",
                    "probability": 100
                }],
                "children": [{
                    "id": "template_item_a1",
                    "startMinutes": null,
                    "endMinutes": null,
                    "options": [{
                        "id": "template_option_a1",
                        "text": "A1",
                        "html": "A1",
                        "probability": 100
                    }],
                    "children": []
                }]
            },
            {
                "id": "template_item_beta",
                "startMinutes": null,
                "endMinutes": null,
                "options": [{
                    "id": "template_option_beta",
                    "text": "Beta",
                    "html": "Beta",
                    "probability": 100
                }],
                "children": [{
                    "id": "template_item_b1",
                    "startMinutes": null,
                    "endMinutes": null,
                    "options": [{
                        "id": "template_option_b1",
                        "text": "B1",
                        "html": "B1",
                        "probability": 100
                    }],
                    "children": []
                }]
            },
            {
                "id": "template_item_gamma",
                "startMinutes": null,
                "endMinutes": null,
                "options": [{
                    "id": "template_option_gamma",
                    "text": "Gamma",
                    "html": "Gamma",
                    "probability": 100
                }],
                "children": []
            }
        ]);

        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
        replace_app_state(&mut connection, &state).unwrap();

        persist_operation_to_database(
            &mut connection,
            &json!({
                "id": "op_device_test_2",
                "deviceId": "device_test",
                "sequence": 2,
                "type": "outdent_template_items",
                "timestamp": "2026-05-21T00:01:00Z",
                "payload": {
                    "templateId": "template_default",
                    "itemIds": ["template_item_alpha", "template_item_beta"]
                }
            }),
        )
        .unwrap();

        let moved = read_app_state_from_database(&connection).unwrap().unwrap();
        assert_eq!(
            top_template_item_ids(&moved),
            [
                "template_item_wake",
                "template_item_alpha",
                "template_item_beta"
            ]
        );
        assert_eq!(
            moved["templates"][0]["items"][0]["children"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
        assert_eq!(
            moved["templates"][0]["items"][1]["children"][0]["id"],
            "template_item_a1"
        );
        let beta_children = moved["templates"][0]["items"][2]["children"]
            .as_array()
            .unwrap();
        assert_eq!(beta_children.len(), 2);
        assert_eq!(beta_children[0]["id"], "template_item_b1");
        assert_eq!(beta_children[1]["id"], "template_item_gamma");

        let undone = undo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(top_template_item_ids(&undone), ["template_item_wake"]);
        let restored_children = undone["templates"][0]["items"][0]["children"]
            .as_array()
            .unwrap();
        assert_eq!(restored_children.len(), 3);
        assert_eq!(restored_children[0]["id"], "template_item_alpha");
        assert_eq!(restored_children[1]["id"], "template_item_beta");
        assert_eq!(restored_children[2]["id"], "template_item_gamma");

        let redone = redo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(
            top_template_item_ids(&redone),
            [
                "template_item_wake",
                "template_item_alpha",
                "template_item_beta"
            ]
        );
        assert_eq!(
            redone["templates"][0]["items"][2]["children"][1]["id"],
            "template_item_gamma"
        );
    }

    #[test]
    fn template_item_within_level_movement_persists_and_undoes() {
        let database = TestDatabase::new("template-within-level-movement");
        let recovery_key = generate_recovery_key();
        let mut state = test_state("Template within level movement test");
        state["templates"][0]["items"]
            .as_array_mut()
            .unwrap()
            .push(json!({
                "id": "template_item_second",
                "options": [
                    {
                        "id": "template_option_second",
                        "text": "Second template item",
                        "html": "Second template item",
                        "probability": 100
                    }
                ],
                "children": []
            }));

        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
        replace_app_state(&mut connection, &state).unwrap();

        persist_operation_to_database(
            &mut connection,
            &json!({
                "id": "op_device_test_2",
                "deviceId": "device_test",
                "sequence": 2,
                "type": "move_template_item_within_level",
                "timestamp": "2026-05-21T00:01:00Z",
                "payload": {
                    "templateId": "template_default",
                    "itemId": "template_item_wake",
                    "direction": "down"
                }
            }),
        )
        .unwrap();

        let moved = read_app_state_from_database(&connection).unwrap().unwrap();
        assert_eq!(
            top_template_item_ids(&moved),
            ["template_item_second", "template_item_wake"]
        );

        let undone = undo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(
            top_template_item_ids(&undone),
            ["template_item_wake", "template_item_second"]
        );

        let redone = redo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(
            top_template_item_ids(&redone),
            ["template_item_second", "template_item_wake"]
        );
    }

    #[test]
    fn delete_template_items_persists_and_undoes() {
        let database = TestDatabase::new("delete-template-items");
        let recovery_key = generate_recovery_key();
        let mut state = test_state("Delete template items test");
        state["templates"][0]["items"]
            .as_array_mut()
            .unwrap()
            .extend([
                test_template_item("template_item_second", "Second"),
                test_template_item("template_item_third", "Third"),
            ]);

        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
        replace_app_state(&mut connection, &state).unwrap();

        persist_operation_to_database(
            &mut connection,
            &json!({
                "id": "op_device_test_2",
                "deviceId": "device_test",
                "sequence": 2,
                "type": "delete_template_items",
                "timestamp": "2026-05-21T00:01:00Z",
                "payload": {
                    "templateId": "template_default",
                    "itemIds": ["template_item_wake", "template_item_second"]
                }
            }),
        )
        .unwrap();

        let deleted = read_app_state_from_database(&connection).unwrap().unwrap();
        assert_eq!(top_template_item_ids(&deleted), ["template_item_third"]);

        let undone = undo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(
            top_template_item_ids(&undone),
            [
                "template_item_wake",
                "template_item_second",
                "template_item_third"
            ]
        );

        let redone = redo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(top_template_item_ids(&redone), ["template_item_third"]);
    }

    #[test]
    fn paste_template_items_persists_and_undoes() {
        let database = TestDatabase::new("paste-template-items");
        let recovery_key = generate_recovery_key();
        let mut state = test_state("Paste template items test");
        state["templates"][0]["items"]
            .as_array_mut()
            .unwrap()
            .push(test_template_item("template_item_second", "Second"));

        let mut pasted_item = test_template_item("template_item_pasted", "Pasted");
        pasted_item["children"] = json!([test_template_item(
            "template_item_pasted_child",
            "Pasted child"
        )]);

        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
        replace_app_state(&mut connection, &state).unwrap();

        persist_operation_to_database(
            &mut connection,
            &json!({
                "id": "op_device_test_2",
                "deviceId": "device_test",
                "sequence": 2,
                "type": "paste_template_items",
                "timestamp": "2026-05-21T00:01:00Z",
                "payload": {
                    "templateId": "template_default",
                    "targetId": "template_item_wake",
                    "placement": "after",
                    "items": [pasted_item]
                }
            }),
        )
        .unwrap();

        let pasted = read_app_state_from_database(&connection).unwrap().unwrap();
        assert_eq!(
            top_template_item_ids(&pasted),
            [
                "template_item_wake",
                "template_item_pasted",
                "template_item_second"
            ]
        );
        assert_eq!(
            pasted["templates"][0]["items"][1]["children"][0]["id"],
            "template_item_pasted_child"
        );

        let undone = undo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(
            top_template_item_ids(&undone),
            ["template_item_wake", "template_item_second"]
        );

        let redone = redo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(
            top_template_item_ids(&redone),
            [
                "template_item_wake",
                "template_item_pasted",
                "template_item_second"
            ]
        );
    }

    #[test]
    fn move_template_items_within_level_persists_and_undoes() {
        let database = TestDatabase::new("move-template-items-within-level");
        let recovery_key = generate_recovery_key();
        let mut state = test_state("Move template items test");
        state["templates"][0]["items"]
            .as_array_mut()
            .unwrap()
            .extend([
                test_template_item("template_item_second", "Second"),
                test_template_item("template_item_third", "Third"),
                test_template_item("template_item_fourth", "Fourth"),
            ]);

        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
        replace_app_state(&mut connection, &state).unwrap();

        persist_operation_to_database(
            &mut connection,
            &json!({
                "id": "op_device_test_2",
                "deviceId": "device_test",
                "sequence": 2,
                "type": "move_template_items_within_level",
                "timestamp": "2026-05-21T00:01:00Z",
                "payload": {
                    "templateId": "template_default",
                    "itemIds": ["template_item_second", "template_item_third"],
                    "direction": "up"
                }
            }),
        )
        .unwrap();

        let moved = read_app_state_from_database(&connection).unwrap().unwrap();
        assert_eq!(
            top_template_item_ids(&moved),
            [
                "template_item_second",
                "template_item_third",
                "template_item_wake",
                "template_item_fourth"
            ]
        );

        let undone = undo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(
            top_template_item_ids(&undone),
            [
                "template_item_wake",
                "template_item_second",
                "template_item_third",
                "template_item_fourth"
            ]
        );

        let redone = redo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(
            top_template_item_ids(&redone),
            [
                "template_item_second",
                "template_item_third",
                "template_item_wake",
                "template_item_fourth"
            ]
        );

        persist_operation_to_database(
            &mut connection,
            &json!({
                "id": "op_device_test_3",
                "deviceId": "device_test",
                "sequence": 3,
                "type": "move_template_items_within_level",
                "timestamp": "2026-05-21T00:02:00Z",
                "payload": {
                    "templateId": "template_default",
                    "itemIds": ["template_item_second", "template_item_third"],
                    "direction": "down"
                }
            }),
        )
        .unwrap();

        let moved_down = read_app_state_from_database(&connection).unwrap().unwrap();
        assert_eq!(
            top_template_item_ids(&moved_down),
            [
                "template_item_wake",
                "template_item_second",
                "template_item_third",
                "template_item_fourth"
            ]
        );

        let down_undone = undo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(
            top_template_item_ids(&down_undone),
            [
                "template_item_second",
                "template_item_third",
                "template_item_wake",
                "template_item_fourth"
            ]
        );
    }

    #[test]
    fn generated_recovery_key_uses_grouped_base32_format() {
        let recovery_key = generate_recovery_key();
        let groups = recovery_key.split('-').collect::<Vec<_>>();

        assert_eq!(groups.len(), 13);
        assert!(groups.iter().all(|group| group.len() == 4));
        assert!(recovery_key
            .chars()
            .all(|character| character == '-' || matches!(character, 'A'..='Z' | '2'..='7')));
    }
    #[test]
    fn external_url_validation_allows_only_http_and_https() {
        assert_eq!(
            validate_external_url(" https://example.com/path ").unwrap(),
            "https://example.com/path"
        );
        assert_eq!(
            validate_external_url("http://example.com").unwrap(),
            "http://example.com"
        );
        assert!(validate_external_url("ftp://example.com").is_err());
        assert!(validate_external_url("javascript:alert(1)").is_err());
        assert!(validate_external_url("https://example.com\nopen").is_err());
    }

    #[test]
    fn database_access_lock_serializes_atomic_maintenance_and_sync() {
        let guard = database_access_guard().unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        let waiter = std::thread::spawn(move || {
            let _guard = database_access_guard().unwrap();
            sender.send(()).unwrap();
        });

        assert!(
            receiver.recv_timeout(Duration::from_millis(50)).is_err(),
            "second database task must wait while maintenance owns the lock"
        );
        drop(guard);
        receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("waiting database task should continue after maintenance");
        waiter.join().unwrap();
    }

    #[test]
    fn foreground_relay_network_wait_yields_database_access() {
        let mut relay_gate = ForegroundRelayDatabaseGate::acquire().unwrap();
        let (sender, receiver) = std::sync::mpsc::channel();
        let waiter = std::thread::spawn(move || {
            let _guard = database_access_guard().unwrap();
            sender.send(()).unwrap();
        });

        <ForegroundRelayDatabaseGate as sync::relay_client::NetworkDatabaseGate>::without_database_lock(
            &mut relay_gate,
            || {
                receiver
                    .recv_timeout(Duration::from_secs(1))
                    .expect("local database work should continue during relay network waits");
                Ok(())
            },
        )
        .unwrap();
        waiter.join().unwrap();
        assert!(relay_gate.guard.is_some());
    }

    #[test]
    fn sync_relay_url_validation_normalizes_safe_urls() {
        assert_eq!(
            normalize_sync_relay_url(" https://relay.example.com/ ").unwrap(),
            "https://relay.example.com"
        );
        assert_eq!(
            normalize_sync_relay_url("http://127.0.0.1:8787///").unwrap(),
            "http://127.0.0.1:8787"
        );
        assert_eq!(normalize_sync_relay_url("  ").unwrap(), "");
        assert!(normalize_sync_relay_url("relay.example.com").is_err());
        assert!(normalize_sync_relay_url("https://").is_err());
        assert!(normalize_sync_relay_url("https://relay.example.com/path with space").is_err());
    }

    #[test]
    fn pairing_code_is_fully_validated_before_sync_setup() {
        let code = sync::crypto::SyncKey::generate().to_pairing_code();
        assert_eq!(
            normalize_sync_pairing_code(&format!("  {code}\n")).unwrap(),
            code
        );
        assert!(normalize_sync_pairing_code("BALSYNC1:not-a-real-key").is_err());
        assert!(normalize_sync_pairing_code("not-a-code").is_err());
    }

    #[test]
    fn metadata_diagnostics_redact_the_sync_pairing_secret() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 INSERT INTO metadata VALUES ('sync_pairing_code', 'BALSYNC1:secret');
                 INSERT INTO metadata VALUES ('sync_relay_url', 'https://relay.example.com');",
            )
            .unwrap();

        let listed = list_metadata_from_database(&connection).unwrap();
        assert_eq!(listed["entries"][0]["key"], SYNC_PAIRING_CODE);
        assert_eq!(listed["entries"][0]["value"], "[redacted]");
        assert_eq!(listed["entries"][1]["value"], "https://relay.example.com");
    }

    #[test]
    fn recovery_confirmation_hides_key_from_status() {
        let database = TestDatabase::new("recovery-confirmed");
        let recovery_key = generate_recovery_key();
        let connection = open_database_at(&database.path, &recovery_key).unwrap();

        let status =
            recovery_key_status(&connection, &database.path, Some(recovery_key.clone())).unwrap();
        assert!(!status.confirmed);
        assert_eq!(status.recovery_key, Some(recovery_key));

        confirm_recovery_key_in_database(&connection).unwrap();

        let status =
            recovery_key_status(&connection, &database.path, Some("hidden".into())).unwrap();
        assert!(status.confirmed);
        assert_eq!(status.recovery_key, None);
    }

    #[test]
    fn missing_key_for_existing_database_uses_clear_error() {
        assert_eq!(
            missing_recovery_key_error(),
            "The encrypted Balance database exists, but its recovery key is not in this keychain."
        );
    }

    #[test]
    fn database_path_uses_human_readable_application_support_folder() {
        assert_eq!(
            app_database_path_from_data_dir(Path::new(
                "/Users/example/Library/Application Support"
            )),
            PathBuf::from("/Users/example/Library/Application Support/Balance/balance.sqlite3")
        );
    }

    #[test]
    fn stale_plan_tree_operations_are_noops_during_sync_replay() {
        let database = TestDatabase::new("stale-sync-operations");
        let recovery_key = generate_recovery_key();
        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
        replace_app_state(&mut connection, &test_state("Stale sync operations")).unwrap();
        let before = read_app_state_from_database(&connection).unwrap();

        let stale_item = json!({
            "id": "stale_new_item",
            "text": "Stale",
            "html": "Stale",
            "done": false,
            "startMinutes": null,
            "endMinutes": null,
            "children": []
        });
        let operations = [
            json!({
                "type": "outdent_plan_items",
                "payload": { "planId": "plan_today", "itemIds": ["missing_item"] }
            }),
            json!({
                "type": "split_plan_item",
                "payload": {
                    "planId": "plan_today",
                    "itemId": "missing_item",
                    "patch": { "text": "Ignored" },
                    "newItem": stale_item,
                    "placement": "after"
                }
            }),
            json!({
                "type": "move_plan_item",
                "payload": {
                    "sourceId": "missing_item",
                    "targetId": "plan_item_wake",
                    "placement": "after"
                }
            }),
            json!({
                "type": "paste_plan_items",
                "payload": {
                    "planId": "plan_today",
                    "targetId": "missing_item",
                    "placement": "after",
                    "items": [stale_item]
                }
            }),
            json!({
                "type": "history_undo",
                "payload": {
                    "operation": {
                        "type": "batch",
                        "payload": {
                            "operations": [{
                                "type": "insert_plan_item_at",
                                "payload": {
                                    "planId": "plan_today",
                                    "parentId": "missing_parent",
                                    "position": 0,
                                    "item": stale_item
                                }
                            }, {
                                "type": "move_plan_item_to_position",
                                "payload": {
                                    "itemId": "missing_item",
                                    "planId": "plan_today",
                                    "parentId": null,
                                    "position": 0
                                }
                            }]
                        }
                    }
                }
            }),
        ];

        let tx = connection.transaction().unwrap();
        for operation in &operations {
            apply_operation(&tx, operation).unwrap();
        }
        tx.commit().unwrap();

        assert_eq!(read_app_state_from_database(&connection).unwrap(), before);
    }

    #[test]
    fn stale_template_tree_operations_are_noops_during_sync_replay() {
        let database = TestDatabase::new("stale-template-sync-operations");
        let recovery_key = generate_recovery_key();
        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
        replace_app_state(
            &mut connection,
            &test_state("Stale template sync operations"),
        )
        .unwrap();
        let before = read_app_state_from_database(&connection).unwrap();

        let stale_item = json!({
            "id": "stale_template_item",
            "startMinutes": null,
            "endMinutes": null,
            "options": [{
                "id": "stale_template_option",
                "text": "Stale",
                "html": "Stale",
                "probability": 1.0
            }],
            "children": []
        });
        let operations = [
            json!({
                "type": "outdent_template_items",
                "payload": {
                    "templateId": "template_default",
                    "itemIds": ["missing_template_item"]
                }
            }),
            json!({
                "type": "split_template_item",
                "payload": {
                    "templateId": "template_default",
                    "itemId": "missing_template_item",
                    "optionId": "missing_template_option",
                    "patch": { "text": "Ignored" },
                    "newItem": stale_item,
                    "placement": "after"
                }
            }),
            json!({
                "type": "move_template_item",
                "payload": {
                    "sourceId": "missing_template_item",
                    "targetId": "template_item_wake",
                    "placement": "after"
                }
            }),
            json!({
                "type": "paste_template_items",
                "payload": {
                    "templateId": "template_default",
                    "targetId": "missing_template_item",
                    "placement": "after",
                    "items": [stale_item]
                }
            }),
            json!({
                "type": "history_undo",
                "payload": {
                    "operation": {
                        "type": "batch",
                        "payload": {
                            "operations": [{
                                "type": "insert_template_item_at",
                                "payload": {
                                    "templateId": "template_default",
                                    "parentId": "missing_template_parent",
                                    "position": 0,
                                    "item": stale_item
                                }
                            }, {
                                "type": "insert_template_option_at",
                                "payload": {
                                    "itemId": "missing_template_item",
                                    "position": 0,
                                    "option": stale_item["options"][0]
                                }
                            }, {
                                "type": "move_template_item_to_position",
                                "payload": {
                                    "itemId": "missing_template_item",
                                    "templateId": "template_default",
                                    "parentId": null,
                                    "position": 0
                                }
                            }]
                        }
                    }
                }
            }),
        ];

        let tx = connection.transaction().unwrap();
        for operation in &operations {
            apply_operation(&tx, operation).unwrap();
        }
        tx.commit().unwrap();

        assert_eq!(read_app_state_from_database(&connection).unwrap(), before);
    }

    fn history_entry_count(connection: &Connection) -> i64 {
        connection
            .query_row("select count(*) from history_entries", [], |row| row.get(0))
            .unwrap()
    }

    fn top_plan_item_ids(state: &Value) -> Vec<String> {
        state["plans"][0]["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["id"].as_str().unwrap().to_string())
            .collect()
    }

    fn plan_by_id<'a>(state: &'a Value, plan_id: &str) -> &'a Value {
        state["plans"]
            .as_array()
            .unwrap()
            .iter()
            .find(|plan| plan["id"] == plan_id)
            .unwrap_or_else(|| panic!("plan {plan_id} should exist"))
    }

    fn plan_item_ids_for_plan(state: &Value, plan_id: &str) -> Vec<String> {
        plan_by_id(state, plan_id)["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["id"].as_str().unwrap().to_string())
            .collect()
    }

    fn top_template_item_ids(state: &Value) -> Vec<String> {
        state["templates"][0]["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| item["id"].as_str().unwrap().to_string())
            .collect()
    }

    fn test_template_item(id: &str, text: &str) -> Value {
        json!({
            "id": id,
            "startMinutes": null,
            "endMinutes": null,
            "options": [{
                "id": format!("option_{id}"),
                "text": text,
                "html": text,
                "probability": 100
            }],
            "children": []
        })
    }

    struct TestDatabase {
        path: PathBuf,
    }

    impl TestDatabase {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "balance-{name}-{}-{}.sqlite3",
                std::process::id(),
                generate_recovery_key().replace('-', "")
            ));

            let _ = fs::remove_file(&path);
            Self { path }
        }
    }

    impl Drop for TestDatabase {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.path);
        }
    }

    #[test]
    fn bulk_plan_reader_matches_recursive_tree_loading() {
        let database = TestDatabase::new("bulk-plan-reader");
        let recovery_key = generate_recovery_key();
        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
        let mut state = test_state("Bulk plan reader");
        state["plans"] = json!([
            {
                "id": "plan_today",
                "date": "2026-05-21",
                "title": "Today",
                "dailyReminder": "",
                "generatedFromTemplateId": null,
                "createdAt": "2026-05-21T00:00:00Z",
                "items": [
                    {
                        "id": "today_root_a",
                        "text": "Root A",
                        "html": "Root A",
                        "done": false,
                        "startMinutes": null,
                        "endMinutes": null,
                        "children": [
                            {
                                "id": "today_child_a",
                                "text": "Child A",
                                "html": "Child A",
                                "done": true,
                                "startMinutes": 540,
                                "endMinutes": 600,
                                "children": [{
                                    "id": "today_grandchild",
                                    "text": "Grandchild",
                                    "html": "<strong>Grandchild</strong>",
                                    "done": false,
                                    "startMinutes": null,
                                    "endMinutes": null,
                                    "children": []
                                }]
                            },
                            {
                                "id": "today_child_b",
                                "text": "Child B",
                                "html": "Child B",
                                "done": false,
                                "startMinutes": null,
                                "endMinutes": null,
                                "children": []
                            }
                        ]
                    },
                    {
                        "id": "today_root_b",
                        "text": "Root B",
                        "html": "Root B",
                        "done": false,
                        "startMinutes": null,
                        "endMinutes": null,
                        "children": []
                    }
                ]
            },
            {
                "id": "plan_yesterday",
                "date": "2026-05-20",
                "title": "Yesterday",
                "dailyReminder": "",
                "generatedFromTemplateId": null,
                "createdAt": "2026-05-20T00:00:00Z",
                "items": [{
                    "id": "yesterday_root",
                    "text": "Yesterday root",
                    "html": "Yesterday root",
                    "done": true,
                    "startMinutes": null,
                    "endMinutes": null,
                    "children": []
                }]
            }
        ]);
        replace_app_state(&mut connection, &state).unwrap();

        // These references satisfy SQLite's foreign keys but are corrupt at the
        // domain level. Match the recursive reader: do not cross plan boundaries
        // and do not make parent cycles reachable from a plan root.
        connection
            .execute(
                "insert into plan_items (
                    id, plan_id, parent_id, position, text, html, done, start_minutes, end_minutes
                 ) values (?1, ?2, ?3, 0, ?4, ?4, 0, null, null)",
                params![
                    "cross_plan_item",
                    "plan_yesterday",
                    "today_root_a",
                    "Cross-plan item"
                ],
            )
            .unwrap();
        connection
            .execute(
                "insert into plan_items (
                    id, plan_id, parent_id, position, text, html, done, start_minutes, end_minutes
                 ) values ('cycle_a', 'plan_yesterday', null, 1, 'Cycle A', 'Cycle A', 0, null, null)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "insert into plan_items (
                    id, plan_id, parent_id, position, text, html, done, start_minutes, end_minutes
                 ) values ('cycle_b', 'plan_yesterday', 'cycle_a', 0, 'Cycle B', 'Cycle B', 0, null, null)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "update plan_items set parent_id = 'cycle_b' where id = 'cycle_a'",
                [],
            )
            .unwrap();

        let expected_today = read_plan_items(&connection, "plan_today", None).unwrap();
        let expected_yesterday = read_plan_items(&connection, "plan_yesterday", None).unwrap();
        let loaded = read_plans(&connection).unwrap();
        let today = loaded
            .iter()
            .find(|plan| plan["id"] == "plan_today")
            .unwrap();
        let yesterday = loaded
            .iter()
            .find(|plan| plan["id"] == "plan_yesterday")
            .unwrap();

        assert_eq!(today["items"], json!(expected_today));
        assert_eq!(yesterday["items"], json!(expected_yesterday));
        assert_eq!(today["items"][0]["children"][0]["id"], "today_child_a");
        assert_eq!(today["items"][0]["children"][1]["id"], "today_child_b");
        let loaded_json = Value::Array(loaded).to_string();
        assert!(!loaded_json.contains("cross_plan_item"));
        assert!(!loaded_json.contains("cycle_a"));
        assert!(!loaded_json.contains("cycle_b"));
    }

    /// A test database that owns its whole directory, for tests that need to
    /// manipulate the sibling `backups/` path without affecting other tests.
    struct TestDatabaseAt {
        path: PathBuf,
        directory: PathBuf,
    }

    impl TestDatabaseAt {
        fn new(name: &str) -> Self {
            let directory = std::env::temp_dir().join(format!(
                "balance-{name}-{}-{}",
                std::process::id(),
                generate_recovery_key().replace('-', "")
            ));
            fs::create_dir_all(&directory).unwrap();
            Self {
                path: directory.join("balance.sqlite3"),
                directory,
            }
        }
    }

    impl Drop for TestDatabaseAt {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.directory);
        }
    }

    /// Opt-in profile for the complete native undo path. This deliberately uses a
    /// disk-backed encrypted database and a few thousand historical plan items so
    /// it measures the same open -> persist -> open -> undo -> full-state-read work
    /// performed by the Tauri commands, without touching the user's real database.
    ///
    /// Run with:
    ///   pnpm test:undo-performance
    #[test]
    #[ignore = "performance profile; run explicitly with --ignored --nocapture"]
    fn undo_performance_profile() {
        let plan_count = undo_performance_size("BALANCE_UNDO_PERF_PLANS", 180);
        let items_per_plan = undo_performance_size("BALANCE_UNDO_PERF_ITEMS_PER_PLAN", 25);
        let goal_count = undo_performance_size("BALANCE_UNDO_PERF_GOALS", 80);
        let target_plan_index = plan_count - 1;
        let target_item_index = items_per_plan - 1;
        let original_target_text = format!("Plan {target_plan_index} item {target_item_index}");

        let database = TestDatabase::new("undo-performance");
        let recovery_key = generate_recovery_key();
        let state = undo_performance_state(plan_count, items_per_plan, goal_count);

        let setup_started = std::time::Instant::now();
        {
            let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
            replace_app_state(&mut connection, &state).unwrap();
        }
        let setup_ms = setup_started.elapsed().as_secs_f64() * 1_000.0;

        let read_open_started = std::time::Instant::now();
        let read_connection = open_database_at(&database.path, &recovery_key).unwrap();
        let read_open_ms = read_open_started.elapsed().as_secs_f64() * 1_000.0;
        let read_started = std::time::Instant::now();
        let loaded = read_app_state_from_database(&read_connection)
            .unwrap()
            .unwrap();
        let read_ms = read_started.elapsed().as_secs_f64() * 1_000.0;
        let state_bytes = loaded.to_string().len();
        drop(read_connection);

        let plan_operation = json!({
            "id": "op_device_perf_2",
            "deviceId": "device_perf",
            "sequence": 2,
            "type": "patch_plan_item",
            "timestamp": "2026-07-30T12:00:00Z",
            "payload": {
                "planId": format!("plan_{target_plan_index}"),
                "itemId": format!("plan_{target_plan_index}_item_{target_item_index}"),
                "patch": {
                    "text": "Linked task",
                    "html": "<a href=\"https://example.com\" target=\"_blank\" rel=\"noreferrer\">Linked task</a>"
                }
            }
        });
        let plan_profile =
            profile_native_undo(&database.path, &recovery_key, &plan_operation, |undone| {
                assert_eq!(
                    undone["plans"][0]["items"][target_item_index]["text"],
                    original_target_text
                );
            });
        let mut plan_snapshot_operation = plan_operation.clone();
        plan_snapshot_operation["id"] = json!("op_device_perf_4");
        plan_snapshot_operation["sequence"] = json!(4);
        let plan_snapshot_profile = profile_native_snapshot_undo(
            &database.path,
            &recovery_key,
            &plan_snapshot_operation,
            |undone| {
                assert_eq!(
                    undone["plans"][0]["items"][target_item_index]["text"],
                    original_target_text
                );
            },
        );

        let mut changed_goal = loaded["goals"][0].clone();
        changed_goal["name"] = json!("Linked goal");
        changed_goal["nameHtml"] = json!(
            "<a href=\"https://example.com\" target=\"_blank\" rel=\"noreferrer\">Linked goal</a>"
        );
        let goal_operation = json!({
            "id": "op_device_perf_6",
            "deviceId": "device_perf",
            "sequence": 6,
            "type": "replace_goal_data",
            "timestamp": "2026-07-30T12:01:00Z",
            "payload": {
                "action": "patch_goal",
                "goalId": "goal_0",
                "entityChanges": {
                    "version": 1,
                    "upserts": [{
                        "collection": "goals",
                        "key": "goal_0",
                        "position": 0,
                        "value": changed_goal
                    }],
                    "deletes": []
                }
            }
        });
        let goal_profile =
            profile_native_undo(&database.path, &recovery_key, &goal_operation, |undone| {
                assert_eq!(undone["goals"][0]["name"], "Goal 0");
            });
        let mut goal_snapshot_operation = goal_operation.clone();
        goal_snapshot_operation["id"] = json!("op_device_perf_8");
        goal_snapshot_operation["sequence"] = json!(8);
        let goal_snapshot_profile = profile_native_snapshot_undo(
            &database.path,
            &recovery_key,
            &goal_snapshot_operation,
            |undone| {
                assert_eq!(undone["goals"][0]["name"], "Goal 0");
            },
        );

        let database_bytes = fs::metadata(&database.path).unwrap().len();
        eprintln!(
            "UNDO_PERF backend {}",
            json!({
                "plans": plan_count,
                "items": plan_count * items_per_plan,
                "goals": goal_count,
                "stateBytes": state_bytes,
                "databaseBytes": database_bytes,
                "setupMs": setup_ms,
                "baselineOpenMs": read_open_ms,
                "baselineFullStateReadMs": read_ms,
                "planText": plan_profile,
                "planTextSnapshot": plan_snapshot_profile,
                "goalTitle": goal_profile,
                "goalTitleSnapshot": goal_snapshot_profile,
            })
        );
    }

    fn undo_performance_size(variable: &str, default: usize) -> usize {
        std::env::var(variable)
            .ok()
            .and_then(|value| value.parse().ok())
            .filter(|value| *value > 0)
            .unwrap_or(default)
    }

    fn profile_native_undo(
        database_path: &Path,
        recovery_key: &str,
        operation: &Value,
        assert_undone: impl FnOnce(&Value),
    ) -> Value {
        let persist_open_started = std::time::Instant::now();
        let mut persist_connection = open_database_at(database_path, recovery_key).unwrap();
        let persist_open_ms = persist_open_started.elapsed().as_secs_f64() * 1_000.0;
        let persist_started = std::time::Instant::now();
        persist_operation_to_database(&mut persist_connection, operation).unwrap();
        let persist_ms = persist_started.elapsed().as_secs_f64() * 1_000.0;
        drop(persist_connection);

        let undo_open_started = std::time::Instant::now();
        let mut undo_connection = open_database_at(database_path, recovery_key).unwrap();
        let undo_open_ms = undo_open_started.elapsed().as_secs_f64() * 1_000.0;
        let undo_started = std::time::Instant::now();
        let undone = undo_last_operation_in_database(&mut undo_connection)
            .unwrap()
            .unwrap();
        let undo_ms = undo_started.elapsed().as_secs_f64() * 1_000.0;
        assert_undone(&undone);

        json!({
            "persistOpenMs": persist_open_ms,
            "persistMs": persist_ms,
            "undoOpenMs": undo_open_ms,
            "undoAndFullStateReadMs": undo_ms,
        })
    }

    fn profile_native_snapshot_undo(
        database_path: &Path,
        recovery_key: &str,
        operation: &Value,
        assert_undone: impl FnOnce(&Value),
    ) -> Value {
        let persist_open_started = std::time::Instant::now();
        let mut persist_connection = open_database_at(database_path, recovery_key).unwrap();
        let persist_open_ms = persist_open_started.elapsed().as_secs_f64() * 1_000.0;
        let persist_started = std::time::Instant::now();
        persist_operation_to_database(&mut persist_connection, operation).unwrap();
        let persist_ms = persist_started.elapsed().as_secs_f64() * 1_000.0;
        drop(persist_connection);

        let undo_open_started = std::time::Instant::now();
        let mut undo_connection = open_database_at(database_path, recovery_key).unwrap();
        let undo_open_ms = undo_open_started.elapsed().as_secs_f64() * 1_000.0;
        let undo_started = std::time::Instant::now();
        let result = undo_last_operation_for_ui(&mut undo_connection, operation["id"].as_str())
            .unwrap()
            .unwrap();
        let undo_ms = undo_started.elapsed().as_secs_f64() * 1_000.0;
        assert!(result["state"].is_null());
        assert_eq!(result["operationId"], operation["id"]);
        let result_bytes = result.to_string().len();

        // The response deliberately omits the full workspace, but the encrypted
        // database remains authoritative. Verify the complete materialized state
        // after timing so a fast response cannot hide an incorrect undo.
        let undone = read_app_state_from_database(&undo_connection)
            .unwrap()
            .unwrap();
        assert_undone(&undone);

        json!({
            "persistOpenMs": persist_open_ms,
            "persistMs": persist_ms,
            "undoOpenMs": undo_open_ms,
            "undoSnapshotResponseMs": undo_ms,
            "responseBytes": result_bytes,
        })
    }

    fn undo_performance_state(
        plan_count: usize,
        items_per_plan: usize,
        goal_count: usize,
    ) -> Value {
        let plans = (0..plan_count)
            .map(|plan_index| {
                let date = undo_performance_date(plan_index);
                let items = (0..items_per_plan)
                    .map(|item_index| {
                        let text = format!("Plan {plan_index} item {item_index}");
                        json!({
                            "id": format!("plan_{plan_index}_item_{item_index}"),
                            "text": text,
                            "html": text,
                            "done": item_index % 3 == 0,
                            "startMinutes": null,
                            "endMinutes": null,
                            "children": []
                        })
                    })
                    .collect::<Vec<_>>();
                json!({
                    "id": format!("plan_{plan_index}"),
                    "date": date,
                    "title": format!("Plan {plan_index}"),
                    "dailyReminder": "",
                    "generatedFromTemplateId": null,
                    "createdAt": "2026-01-01T00:00:00Z",
                    "items": items
                })
            })
            .collect::<Vec<_>>();
        let goals = (0..goal_count)
            .map(|goal_index| {
                json!({
                    "id": format!("goal_{goal_index}"),
                    "name": format!("Goal {goal_index}"),
                    "nameHtml": format!("Goal {goal_index}"),
                    "cadenceDays": 3,
                    "matchTerms": [format!("term-{goal_index}")],
                    "matchTermsHtml": format!("term-{goal_index}"),
                    "hue": goal_index * 360 / goal_count,
                    "lightness": 50,
                    "activityPeriods": [{
                        "startDate": "2026-01-01",
                        "endDate": null
                    }],
                    "createdAt": "2026-01-01T00:00:00Z",
                    "updatedAt": "2026-01-01T00:00:00Z"
                })
            })
            .collect::<Vec<_>>();

        json!({
            "schemaVersion": 1,
            "deviceId": "device_perf",
            "localSequence": 1,
            "historyRevision": 0,
            "activePlanDate": "2026-06-12",
            "templates": [],
            "plans": plans,
            "listTemplates": [],
            "lists": [],
            "metrics": [],
            "metricEntries": [],
            "goals": goals,
            "goalCompletions": [],
            "operations": []
        })
    }

    fn undo_performance_date(index: usize) -> String {
        const DAYS_PER_TEST_YEAR: usize = 12 * 28;
        let year = 2020 + index / DAYS_PER_TEST_YEAR;
        let day_of_year = index % DAYS_PER_TEST_YEAR;
        let month = day_of_year / 28 + 1;
        let day = day_of_year % 28 + 1;
        format!("{year}-{month:02}-{day:02}")
    }

    /// Reproduces the reported data loss: pasting onto an empty-titled parent that still
    /// has children sends `placement: "replace"`, which deletes the parent and cascade-deletes
    /// its children. Verifies the recovery panel can find and fully restore the subtree.
    #[test]
    fn recovery_entry_restores_paste_replaced_parent_with_children() {
        let database = TestDatabase::new("recovery-paste-replace");
        let recovery_key = generate_recovery_key();
        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();

        let mut state = test_state("Recovery test");
        // An empty-titled parent carrying important children.
        state["plans"][0]["items"] = json!([
            {
                "id": "plan_item_parent",
                "text": "",
                "html": "",
                "done": false,
                "startMinutes": null,
                "endMinutes": null,
                "children": [
                    {
                        "id": "plan_item_child_a",
                        "text": "Important child A",
                        "html": "Important child A",
                        "done": false,
                        "startMinutes": null,
                        "endMinutes": null,
                        "children": []
                    },
                    {
                        "id": "plan_item_child_b",
                        "text": "Important child B",
                        "html": "Important child B",
                        "done": false,
                        "startMinutes": null,
                        "endMinutes": null,
                        "children": []
                    }
                ]
            }
        ]);
        replace_app_state(&mut connection, &state).unwrap();

        // The buggy paste: replace the empty-titled parent with a pasted item.
        persist_operation_to_database(
            &mut connection,
            &json!({
                "id": "op_device_test_2",
                "deviceId": "device_test",
                "sequence": 2,
                "type": "paste_plan_items",
                "timestamp": "2026-05-21T00:01:00Z",
                "payload": {
                    "planId": "plan_today",
                    "targetId": "plan_item_parent",
                    "placement": "replace",
                    "items": [
                        {
                            "id": "plan_item_pasted",
                            "text": "Pasted task",
                            "html": "Pasted task",
                            "done": false,
                            "startMinutes": null,
                            "endMinutes": null,
                            "children": []
                        }
                    ]
                }
            }),
        )
        .unwrap();

        // The parent and both children are gone; only the pasted item remains.
        let after_paste = read_app_state_from_database(&connection).unwrap().unwrap();
        assert_eq!(top_plan_item_ids(&after_paste), ["plan_item_pasted"]);

        // The recovery list surfaces the undo snapshot with the full subtree (3 items).
        let listed = list_recovery_entries_from_database(&connection).unwrap();
        let entries = listed["entries"].as_array().unwrap();
        let entry = entries
            .iter()
            .find(|entry| entry["operationType"] == "paste_plan_items")
            .expect("paste entry should be recoverable");
        assert_eq!(entry["restoredItemCount"], 3);
        assert_eq!(entry["preview"], "Important child A");
        let history_id = entry["historyId"].as_str().unwrap().to_string();

        // Restoring reverses the paste: parent and children come back, pasted item removed.
        let restored = restore_recovery_entry_in_database(&mut connection, &history_id)
            .unwrap()
            .unwrap();
        assert_eq!(top_plan_item_ids(&restored), ["plan_item_parent"]);
        let children = restored["plans"][0]["items"][0]["children"]
            .as_array()
            .unwrap();
        assert_eq!(children.len(), 2);
        assert_eq!(children[0]["text"], "Important child A");
        assert_eq!(children[1]["text"], "Important child B");
    }

    fn test_state(plan_title: &str) -> Value {
        json!({
            "schemaVersion": 1,
            "deviceId": "device_test",
            "localSequence": 1,
            "historyRevision": 0,
            "activePlanDate": "2026-05-21",
            "templates": [
                {
                    "id": "template_default",
                    "name": "Default day",
                    "createdAt": "2026-05-21T00:00:00Z",
                    "updatedAt": "2026-05-21T00:00:00Z",
                    "items": [
                        {
                            "id": "template_item_wake",
                            "options": [
                                {
                                    "id": "template_option_wake",
                                    "text": "Wake up",
                                    "html": "Wake up",
                                    "probability": 100
                                }
                            ],
                            "children": []
                        }
                    ]
                }
            ],
            "plans": [
                {
                    "id": "plan_today",
                    "date": "2026-05-21",
                    "title": plan_title,
                    "dailyReminder": "This shouldn't be aspirational",
                    "generatedFromTemplateId": "template_default",
                    "createdAt": "2026-05-21T00:00:00Z",
                    "items": [
                        {
                            "id": "plan_item_wake",
                            "text": "Wake up",
                            "html": "Wake up",
                            "done": false,
                            "startMinutes": null,
                            "endMinutes": null,
                            "children": []
                        }
                    ]
                }
            ],
            "operations": [
                {
                    "id": "op_device_test_1",
                    "deviceId": "device_test",
                    "sequence": 1,
                    "type": "generate_plan",
                    "timestamp": "2026-05-21T00:00:00Z",
                    "payload": {}
                }
            ]
        })
    }
}
