use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use data_encoding::BASE32_NOPAD;
#[cfg(not(target_os = "android"))]
use keyring::{Entry, Error as KeyringError};
use rand::{rngs::OsRng, RngCore};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::Manager;

mod sync;

const APP_DATABASE_FILE: &str = "balance.sqlite3";
const APP_DATA_DIR: &str = "Balance";
#[cfg(not(target_os = "android"))]
const KEYCHAIN_SERVICE: &str = "app.balance.local";
#[cfg(not(target_os = "android"))]
const KEYCHAIN_ACCOUNT: &str = "database-recovery-key";
const RECOVERY_KEY_CONFIRMED: &str = "recovery_key_confirmed";
const EXPORT_DIRECTORY: &str = "export_directory";
const AUTO_JSON_EXPORT_ENABLED: &str = "auto_json_export_enabled";
const AUTO_JSON_EXPORT_TIME: &str = "auto_json_export_time";
const AUTO_JSON_EXPORT_LAST_DATE: &str = "auto_json_export_last_date";
const AUTO_JSON_EXPORT_LAST_PATH: &str = "auto_json_export_last_path";
const AUTO_JSON_EXPORT_LAST_ERROR: &str = "auto_json_export_last_error";
const AUTO_JSON_EXPORT_LAST_ERROR_AT: &str = "auto_json_export_last_error_at";
const AUTO_JSON_EXPORT_ERROR_ACK_AT: &str = "auto_json_export_error_ack_at";
const SYNC_PAIRING_CODE: &str = "sync_pairing_code";
const SYNC_RELAY_URL: &str = "sync_relay_url";
const GOAL_DATA: &str = "goal_data";
// Lists + Metrics state is stored as a single JSON metadata blob (like GOAL_DATA)
// rather than materialized into per-row tables.
const LISTS_METRICS_DATA: &str = "lists_metrics_data";
const DEFAULT_AUTO_JSON_EXPORT_TIME: &str = "23:55";
const DEFAULT_DAILY_REMINDER: &str = "This shouldn't be aspirational";
#[cfg(target_os = "macos")]
const BALANCE_PLAN_ITEMS_PASTEBOARD_TYPE: &str = "com.balance.plan-items+json";

#[cfg(target_os = "macos")]
fn disable_automatic_text_replacement() {
    use objc2_foundation::{NSString, NSUserDefaults};

    // WebKit gives this app-specific preference precedence over the system-wide
    // NSSpellChecker setting. Set it before the webview is created so text
    // replacements such as "omw" never become enabled in editable elements.
    NSUserDefaults::standardUserDefaults().setBool_forKey(
        false,
        &NSString::from_str("WebAutomaticTextReplacementEnabled"),
    );
}

#[cfg(not(target_os = "macos"))]
fn disable_automatic_text_replacement() {}

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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClipboardContents {
    structured_payload: Option<String>,
    plain_text: Option<String>,
    html: Option<String>,
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

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn write_balance_clipboard(_plain_text: String, _structured_payload: String) -> Result<(), String> {
    Err("Structured system clipboard is currently supported on macOS".to_string())
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

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn read_balance_clipboard() -> ClipboardContents {
    ClipboardContents {
        structured_payload: None,
        plain_text: None,
        html: None,
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
struct ExportSettings {
    export_directory: String,
    default_export_directory: String,
    uses_default_export_directory: bool,
    auto_json_export_enabled: bool,
    auto_json_export_time: String,
    last_auto_json_export_date: Option<String>,
    last_auto_json_export_path: Option<String>,
    last_auto_json_export_error: Option<String>,
    // Timestamp the current error was recorded, and the timestamp the user last acknowledged.
    // The UI surfaces the error only while these differ, so a dismissed error stays quiet until
    // a genuinely new failure (new timestamp) occurs.
    last_auto_json_export_error_at: Option<String>,
    auto_json_export_error_ack_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncSettings {
    enabled: bool,
    pairing_code: Option<String>,
    relay_url: String,
}

#[tauri::command]
async fn read_app_state(app: tauri::AppHandle) -> Result<Option<String>, String> {
    run_database_task(move || {
        let connection = open_database(&app)?;
        read_app_state_from_database(&connection).map(|state| state.map(|value| value.to_string()))
    })
    .await
}

#[tauri::command]
async fn initialize_app_state(app: tauri::AppHandle, state_json: String) -> Result<(), String> {
    run_database_task(move || {
        with_database(&app, |connection| {
            let state = parse_json(&state_json)?;
            replace_app_state(connection, &state)
        })
    })
    .await
}

#[tauri::command]
async fn persist_operation(app: tauri::AppHandle, operation_json: String) -> Result<(), String> {
    run_database_task(move || {
        with_database(&app, |connection| {
            let operation = parse_json(&operation_json)?;
            persist_operation_to_database(connection, &operation)
        })
    })
    .await
}

#[tauri::command]
async fn undo_last_operation(app: tauri::AppHandle) -> Result<Option<String>, String> {
    run_database_task(move || {
        with_database(&app, |connection| {
            undo_last_operation_in_database(connection)
                .map(|state| state.map(|value| value.to_string()))
        })
    })
    .await
}

#[tauri::command]
async fn redo_last_operation(app: tauri::AppHandle) -> Result<Option<String>, String> {
    run_database_task(move || {
        with_database(&app, |connection| {
            redo_last_operation_in_database(connection)
                .map(|state| state.map(|value| value.to_string()))
        })
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
async fn restore_recovery_entry(
    app: tauri::AppHandle,
    history_id: String,
) -> Result<Option<String>, String> {
    run_database_task(move || {
        with_database(&app, |connection| {
            restore_recovery_entry_in_database(connection, &history_id)
                .map(|state| state.map(|value| value.to_string()))
        })
    })
    .await
}

#[tauri::command]
async fn get_recovery_key_status(app: tauri::AppHandle) -> Result<RecoveryKeyStatus, String> {
    run_database_task(move || {
        let database_path = app_database_path(&app)?;
        let connection = open_database(&app)?;
        let recovery_key = database_recovery_key(&database_path)?;

        recovery_key_status(&connection, &database_path, Some(recovery_key))
    })
    .await
}

#[tauri::command]
async fn confirm_recovery_key(app: tauri::AppHandle) -> Result<(), String> {
    run_database_task(move || {
        let connection = open_database(&app)?;
        confirm_recovery_key_in_database(&connection)
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

#[derive(serde::Serialize)]
struct BuildInfo {
    version: String,
    commit: String,
}

#[tauri::command]
fn build_info() -> BuildInfo {
    BuildInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        commit: env!("GIT_COMMIT").to_string(),
    }
}

#[tauri::command]
async fn get_export_settings(app: tauri::AppHandle) -> Result<ExportSettings, String> {
    run_database_task(move || {
        let connection = open_database(&app)?;
        export_settings(&app, &connection)
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
async fn set_auto_json_export_settings(
    app: tauri::AppHandle,
    enabled: bool,
    time: String,
) -> Result<ExportSettings, String> {
    run_database_task(move || {
        let connection = open_database(&app)?;
        let time = validate_auto_json_export_time(&time)?;
        set_metadata(
            &connection,
            AUTO_JSON_EXPORT_ENABLED,
            if enabled { "true" } else { "false" },
        )?;
        set_metadata(&connection, AUTO_JSON_EXPORT_TIME, &time)?;
        export_settings(&app, &connection)
    })
    .await
}

#[tauri::command]
async fn record_auto_json_export_success(
    app: tauri::AppHandle,
    date: String,
    path: String,
) -> Result<ExportSettings, String> {
    run_database_task(move || {
        let connection = open_database(&app)?;
        let date = validate_export_date(&date)?;
        let path = validate_export_result_path(&path)?;
        set_metadata(&connection, AUTO_JSON_EXPORT_LAST_DATE, &date)?;
        set_metadata(&connection, AUTO_JSON_EXPORT_LAST_PATH, &path)?;
        delete_metadata(&connection, AUTO_JSON_EXPORT_LAST_ERROR)?;
        delete_metadata(&connection, AUTO_JSON_EXPORT_LAST_ERROR_AT)?;
        export_settings(&app, &connection)
    })
    .await
}

#[tauri::command]
async fn record_auto_json_export_error(
    app: tauri::AppHandle,
    error: String,
) -> Result<ExportSettings, String> {
    run_database_task(move || {
        let connection = open_database(&app)?;
        set_metadata(&connection, AUTO_JSON_EXPORT_LAST_ERROR, error.trim())?;
        set_metadata(
            &connection,
            AUTO_JSON_EXPORT_LAST_ERROR_AT,
            &current_timestamp(),
        )?;
        export_settings(&app, &connection)
    })
    .await
}

#[tauri::command]
async fn acknowledge_auto_json_export_error(
    app: tauri::AppHandle,
) -> Result<ExportSettings, String> {
    run_database_task(move || {
        let connection = open_database(&app)?;
        // Mark the current error event as seen so the UI stops surfacing it. A later failure
        // records a new timestamp, which won't match this ack, so it surfaces again.
        match metadata_value(&connection, AUTO_JSON_EXPORT_LAST_ERROR_AT)? {
            Some(error_at) => set_metadata(&connection, AUTO_JSON_EXPORT_ERROR_ACK_AT, &error_at)?,
            None => delete_metadata(&connection, AUTO_JSON_EXPORT_ERROR_ACK_AT)?,
        }
        export_settings(&app, &connection)
    })
    .await
}

#[tauri::command]
async fn reveal_path_in_file_manager(path: String) -> Result<(), String> {
    run_database_task(move || reveal_path(PathBuf::from(path))).await
}

#[tauri::command]
async fn open_external_url(url: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || open_url(&url))
        .await
        .map_err(|error| error.to_string())?
}

async fn run_database_task<T, F>(task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| error.to_string())?
}

fn read_app_state_from_database(connection: &Connection) -> Result<Option<Value>, String> {
    let device_id = match metadata_value(connection, "device_id")? {
        Some(value) => value,
        None => return Ok(None),
    };
    let local_sequence = metadata_value(connection, "local_sequence")?
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);
    let active_plan_date = metadata_value(connection, "active_plan_date")?.unwrap_or_default();
    let goal_data = read_goal_data(connection)?;
    let lists_metrics_data = read_lists_metrics_data(connection)?;

    Ok(Some(json!({
        "schemaVersion": 1,
        "deviceId": device_id,
        "localSequence": local_sequence,
        "historyRevision": 0,
        "activePlanDate": active_plan_date,
        "templates": read_templates(connection)?,
        "plans": read_plans(connection)?,
        "listTemplates": lists_metrics_data["listTemplates"].clone(),
        "lists": lists_metrics_data["lists"].clone(),
        "metrics": lists_metrics_data["metrics"].clone(),
        "metricEntries": lists_metrics_data["metricEntries"].clone(),
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
    open_database_at(&database_path, &recovery_key)
}

fn open_database_at(database_path: &Path, recovery_key: &str) -> Result<Connection, String> {
    let connection = Connection::open(database_path).map_err(|error| error.to_string())?;
    connection
        .pragma_update(None, "key", recovery_key)
        .map_err(|error| error.to_string())?;
    connection
        .query_row("pragma cipher_version", [], |row| row.get::<_, String>(0))
        .map_err(|error| format!("SQLCipher is not available: {error}"))?;

    initialize_database(&connection)?;
    Ok(connection)
}

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
          end_minutes integer
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

        create index if not exists idx_template_items_parent on template_items(template_id, parent_id, position);
        create index if not exists idx_template_options_item on template_options(item_id, position);
        create index if not exists idx_plan_items_parent on plan_items(plan_id, parent_id, position);
        create index if not exists idx_operations_sequence on operations(sequence);
        create index if not exists idx_history_entries_undo on history_entries(undone, sequence, updated_at_ms);
      ",
        )
        .map_err(|error| error.to_string())?;

    add_missing_column(
        connection,
        "template_options",
        "html",
        "text not null default ''",
    )?;
    add_missing_column(connection, "template_items", "start_minutes", "integer")?;
    add_missing_column(connection, "template_items", "end_minutes", "integer")?;
    add_missing_column(
        connection,
        "plans",
        "daily_reminder",
        "text not null default 'This shouldn''t be aspirational'",
    )?;
    connection
        .execute(
            "update template_options set html = text where html = ''",
            [],
        )
        .map_err(|error| error.to_string())?;

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

fn read_goal_data(connection: &Connection) -> Result<Value, String> {
    let Some(raw) = metadata_value(connection, GOAL_DATA)? else {
        return Ok(json!({ "goals": [], "goalCompletions": [] }));
    };

    let parsed = serde_json::from_str::<Value>(&raw).unwrap_or_else(|_| json!({}));
    Ok(json!({
        "goals": parsed.get("goals").and_then(Value::as_array).cloned().unwrap_or_default(),
        "goalCompletions": parsed
            .get("goalCompletions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
    }))
}

fn goal_data_from_state(state: &Value) -> Value {
    json!({
        "goals": state.get("goals").and_then(Value::as_array).cloned().unwrap_or_default(),
        "goalCompletions": state
            .get("goalCompletions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
    })
}

const LISTS_METRICS_KEYS: [&str; 4] = ["listTemplates", "lists", "metrics", "metricEntries"];

fn read_lists_metrics_data(connection: &Connection) -> Result<Value, String> {
    let parsed = match metadata_value(connection, LISTS_METRICS_DATA)? {
        Some(raw) => serde_json::from_str::<Value>(&raw).unwrap_or_else(|_| json!({})),
        None => json!({}),
    };

    let mut result = serde_json::Map::new();
    for key in LISTS_METRICS_KEYS {
        let value = parsed
            .get(key)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        result.insert(key.to_string(), Value::Array(value));
    }
    Ok(Value::Object(result))
}

fn lists_metrics_data_from_state(state: &Value) -> Value {
    let mut result = serde_json::Map::new();
    for key in LISTS_METRICS_KEYS {
        let value = state
            .get(key)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        result.insert(key.to_string(), Value::Array(value));
    }
    Value::Object(result)
}

fn is_lists_metrics_operation(operation_type: &str) -> bool {
    // All Lists/Metrics operation types contain "list" or "metric"; no existing
    // plan/template/goal operation type does.
    operation_type.contains("list") || operation_type.contains("metric")
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
        auto_json_export_enabled: metadata_value(connection, AUTO_JSON_EXPORT_ENABLED)?
            .as_deref()
            .unwrap_or("true")
            == "true",
        auto_json_export_time: metadata_value(connection, AUTO_JSON_EXPORT_TIME)?
            .filter(|time| validate_auto_json_export_time(time).is_ok())
            .unwrap_or_else(|| DEFAULT_AUTO_JSON_EXPORT_TIME.to_string()),
        last_auto_json_export_date: metadata_value(connection, AUTO_JSON_EXPORT_LAST_DATE)?,
        last_auto_json_export_path: metadata_value(connection, AUTO_JSON_EXPORT_LAST_PATH)?,
        last_auto_json_export_error: metadata_value(connection, AUTO_JSON_EXPORT_LAST_ERROR)?,
        last_auto_json_export_error_at: metadata_value(connection, AUTO_JSON_EXPORT_LAST_ERROR_AT)?,
        auto_json_export_error_ack_at: metadata_value(connection, AUTO_JSON_EXPORT_ERROR_ACK_AT)?,
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

fn validate_auto_json_export_time(time: &str) -> Result<String, String> {
    let mut parts = time.split(':');
    let hour = parts
        .next()
        .and_then(|part| part.parse::<u8>().ok())
        .ok_or_else(|| "Auto-export time must use HH:MM format".to_string())?;
    let minute = parts
        .next()
        .and_then(|part| part.parse::<u8>().ok())
        .ok_or_else(|| "Auto-export time must use HH:MM format".to_string())?;

    if parts.next().is_some() || hour > 23 || minute > 59 {
        return Err("Auto-export time must use HH:MM format".to_string());
    }

    Ok(format!("{hour:02}:{minute:02}"))
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

fn validate_export_date(date: &str) -> Result<String, String> {
    let parts = date.split('-').collect::<Vec<_>>();
    if parts.len() == 3
        && parts[0].len() == 4
        && parts[1].len() == 2
        && parts[2].len() == 2
        && parts
            .iter()
            .all(|part| part.chars().all(|character| character.is_ascii_digit()))
    {
        return Ok(date.to_string());
    }

    Err("Auto-export date must use YYYY-MM-DD format".to_string())
}

fn validate_export_result_path(path: &str) -> Result<String, String> {
    let path = path.trim();
    if path.is_empty() || path.chars().any(char::is_control) {
        return Err("Auto-export path is invalid".to_string());
    }

    Ok(path.to_string())
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

fn open_url(url: &str) -> Result<(), String> {
    let url = validate_external_url(url)?;

    #[cfg(target_os = "macos")]
    let status = Command::new("open")
        .arg(url)
        .status()
        .map_err(|error| error.to_string())?;

    #[cfg(target_os = "windows")]
    let status = Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", url])
        .status()
        .map_err(|error| error.to_string())?;

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let status = Command::new("xdg-open")
        .arg(url)
        .status()
        .map_err(|error| error.to_string())?;

    if status.success() {
        Ok(())
    } else {
        Err("Could not open the link".to_string())
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

fn add_missing_column(
    connection: &Connection,
    table: &str,
    column: &str,
    column_definition: &str,
) -> Result<(), String> {
    let mut statement = connection
        .prepare(&format!("pragma table_info({table})"))
        .map_err(|error| error.to_string())?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;

    if columns.iter().any(|candidate| candidate == column) {
        return Ok(());
    }

    connection
        .execute(
            &format!("alter table {table} add column {column} {column_definition}"),
            [],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
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
        GOAL_DATA,
        &goal_data_from_state(state).to_string(),
    )?;

    set_metadata(
        connection,
        LISTS_METRICS_DATA,
        &lists_metrics_data_from_state(state).to_string(),
    )?;

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

    tx.commit().map_err(|error| error.to_string())
}

fn undo_last_operation_in_database(connection: &mut Connection) -> Result<Option<Value>, String> {
    let changed = {
        let tx = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        let Some(history) = latest_undoable_history_entry(&tx)? else {
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

fn redo_last_operation_in_database(connection: &mut Connection) -> Result<Option<Value>, String> {
    let changed = {
        let tx = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        let Some(history) = latest_redoable_history_entry(&tx)? else {
            return Ok(None);
        };

        append_history_action_operation(&tx, "history_redo", &history.id, &history.redo_operation)?;
        apply_operation(&tx, &history.redo_operation)?;
        set_history_undone(&tx, &history.id, false)?;
        tx.commit().map_err(|error| error.to_string())?;
        true
    };

    if changed {
        read_app_state_from_database(connection)
    } else {
        Ok(None)
    }
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
              select id, undo_operation_json, redo_operation_json
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
/// device/session state and auto-export status (including any recorded export error).
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
                 h.undo_operation_json, o.type, o.timestamp
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
                row.get::<_, Option<String>>(6)?,
                row.get::<_, Option<String>>(7)?,
            ))
        })
        .map_err(|error| error.to_string())?;

    let mut entries = Vec::new();
    for row in rows {
        let (id, operation_id, sequence, undone, created_at_ms, undo_json, op_type, timestamp) =
            row.map_err(|error| error.to_string())?;
        let undo_operation = serde_json::from_str::<Value>(&undo_json).unwrap_or(Value::Null);
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
            set_metadata(tx, "active_plan_date", required_string(payload, "date")?)
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
            Ok(())
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
        // Lists/Metrics state lives in the LISTS_METRICS_DATA blob below, so these
        // operations need no per-row table mutation.
        "replace_lists_metrics_data" => Ok(()),
        other if is_lists_metrics_operation(other) => Ok(()),
        other => Err(format!("Unsupported operation type: {other}")),
    };

    result?;
    if let Some(goal_data) = payload.get("goalData") {
        set_metadata(tx, GOAL_DATA, &goal_data.to_string())?;
    }
    if let Some(lists_metrics_data) = payload.get("listsMetricsData") {
        set_metadata(tx, LISTS_METRICS_DATA, &lists_metrics_data.to_string())?;
    }
    Ok(())
}

#[derive(Clone)]
struct HistoryEntry {
    id: String,
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

fn build_undo_operation(
    connection: &Connection,
    operation: &Value,
) -> Result<Option<Value>, String> {
    let domain_undo = build_domain_undo_operation(connection, operation)?;
    let payload = required_value(operation, "payload")?;

    // Capture pre-apply snapshots of any embedded blob so undo restores them.
    let mut snapshot_undos: Vec<Value> = Vec::new();
    if payload.get("goalData").is_some() {
        snapshot_undos.push(storage_operation(
            "replace_goal_data",
            json!({ "goalData": read_goal_data(connection)? }),
        ));
    }
    if payload.get("listsMetricsData").is_some() {
        snapshot_undos.push(storage_operation(
            "replace_lists_metrics_data",
            json!({ "listsMetricsData": read_lists_metrics_data(connection)? }),
        ));
    }

    if snapshot_undos.is_empty() {
        return Ok(domain_undo);
    }

    let mut operations: Vec<Value> = Vec::new();
    if let Some(operation) = domain_undo {
        operations.push(operation);
    }
    operations.extend(snapshot_undos);

    Ok(Some(if operations.len() == 1 {
        operations.into_iter().next().expect("one operation")
    } else {
        storage_operation("batch", json!({ "operations": operations }))
    }))
}

fn build_domain_undo_operation(
    connection: &Connection,
    operation: &Value,
) -> Result<Option<Value>, String> {
    let operation_type = required_string(operation, "type")?;
    let payload = required_value(operation, "payload")?;

    match operation_type {
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
        "add_template_item" => Ok(Some(storage_operation(
            "delete_template_item",
            json!({ "itemId": required_string(required_value(payload, "item")?, "id")? }),
        ))),
        "patch_template_item" => build_template_item_patch_undo(connection, payload),
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
    let Some((text, html, done, start_minutes, end_minutes)) =
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

    if inverse_patch.is_empty() {
        return Ok(None);
    }

    Ok(Some(storage_operation(
        "patch_plan_item",
        json!({
            "planId": required_string(payload, "planId")?,
            "itemId": item_id,
            "patch": Value::Object(inverse_patch),
        }),
    )))
}

fn build_patch_plan_items_done_undo(
    connection: &Connection,
    payload: &Value,
) -> Result<Option<Value>, String> {
    let operations = required_array(payload, "itemIds")?
        .iter()
        .filter_map(|item_id| item_id.as_str())
        .map(|item_id| {
            let Some((_, _, done, _, _)) = read_plan_item_fields(connection, item_id)? else {
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
    let Some((start_minutes, end_minutes)) = read_template_item_fields(connection, item_id)? else {
        return Ok(None);
    };

    let mut inverse_patch = Map::new();
    if patch_has_key(patch, "startMinutes") {
        inverse_patch.insert("startMinutes".into(), json!(start_minutes));
    }
    if patch_has_key(patch, "endMinutes") {
        inverse_patch.insert("endMinutes".into(), json!(end_minutes));
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
          select id, undo_operation_json, redo_operation_json
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
          select id, undo_operation_json, redo_operation_json
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
          select id, undo_operation_json, redo_operation_json
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
            let undo_json: String = row.get(1)?;
            let redo_json: String = row.get(2)?;
            let undo_operation = serde_json::from_str::<Value>(&undo_json).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    1,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            let redo_operation = serde_json::from_str::<Value>(&redo_json).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    2,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;

            Ok(HistoryEntry {
                id: row.get(0)?,
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
        insert into template_items (id, template_id, parent_id, start_minutes, end_minutes, position)
        values (?1, ?2, ?3, ?4, ?5, ?6)
        on conflict(id) do update set
          template_id = excluded.template_id,
          parent_id = excluded.parent_id,
          start_minutes = excluded.start_minutes,
          end_minutes = excluded.end_minutes,
          position = excluded.position
      ",
            params![
                item_id,
                template_id,
                parent_id,
                optional_i64(item, "startMinutes")?,
                optional_i64(item, "endMinutes")?,
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
          id, plan_id, parent_id, position, text, html, done, start_minutes, end_minutes
        )
        values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        on conflict(id) do update set
          plan_id = excluded.plan_id,
          parent_id = excluded.parent_id,
          position = excluded.position,
          text = excluded.text,
          html = excluded.html,
          done = excluded.done,
          start_minutes = excluded.start_minutes,
          end_minutes = excluded.end_minutes
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
          select plan_id, parent_id, position, text, html, done, start_minutes, end_minutes
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
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;

    let Some((plan_id, parent_id, position, text, html, done, start_minutes, end_minutes)) = row
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
            "children": read_plan_items(connection, &plan_id, Some(item_id))?,
        }),
    }))
}

fn read_plan_item_fields(
    connection: &Connection,
    item_id: &str,
) -> Result<Option<(String, String, bool, Option<i64>, Option<i64>)>, String> {
    connection
        .query_row(
            "
          select text, html, done, start_minutes, end_minutes
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

fn read_template_item_snapshot(
    connection: &Connection,
    item_id: &str,
) -> Result<Option<TemplateItemSnapshot>, String> {
    let row = connection
        .query_row(
            "
          select template_id, parent_id, position, start_minutes, end_minutes
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
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;

    let Some((template_id, parent_id, position, start_minutes, end_minutes)) = row else {
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
            "options": read_template_options(connection, item_id)?,
            "children": read_template_items(connection, &template_id, Some(item_id))?,
        }),
    }))
}

fn read_template_item_fields(
    connection: &Connection,
    item_id: &str,
) -> Result<Option<(Option<i64>, Option<i64>)>, String> {
    connection
        .query_row(
            "select start_minutes, end_minutes from template_items where id = ?1",
            params![item_id],
            |row| Ok((row.get::<_, Option<i64>>(0)?, row.get::<_, Option<i64>>(1)?)),
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
          select id, start_minutes, end_minutes
          from template_items
          where template_id = ?1 and parent_id = ?2
          order by position, id
        ",
        )
    } else {
        connection.prepare(
            "
          select id, start_minutes, end_minutes
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
                ))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    };

    ids.into_iter()
        .map(|(id, start_minutes, end_minutes)| {
            Ok(json!({
                "id": id,
                "startMinutes": start_minutes,
                "endMinutes": end_minutes,
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

    rows.map(|row| {
        let (id, date, title, daily_reminder, generated_from_template_id, created_at) =
            row.map_err(|error| error.to_string())?;
        Ok(json!({
            "id": id,
            "date": date,
            "title": title,
            "dailyReminder": daily_reminder,
            "generatedFromTemplateId": generated_from_template_id,
            "createdAt": created_at,
            "items": read_plan_items(connection, &id, None)?,
        }))
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
          select id, text, html, done, start_minutes, end_minutes
          from plan_items
          where plan_id = ?1 and parent_id = ?2
          order by position, id
        ",
        )
    } else {
        connection.prepare(
            "
          select id, text, html, done, start_minutes, end_minutes
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
fn database_recovery_key(database_path: &PathBuf) -> Result<String, String> {
    let entry =
        Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).map_err(|error| error.to_string())?;

    match entry.get_password() {
        Ok(password) => Ok(password),
        Err(KeyringError::NoEntry) if !database_path.exists() => {
            let recovery_key = generate_recovery_key();
            entry
                .set_password(&recovery_key)
                .map_err(|error| error.to_string())?;
            Ok(recovery_key)
        }
        Err(KeyringError::NoEntry) => Err(missing_recovery_key_error()),
        Err(error) => Err(error.to_string()),
    }
}

// Android has no OS keychain that the `keyring` crate supports. The SQLCipher
// recovery key is generated once, then encrypted with a non-exportable,
// hardware-backed AES-GCM key from the Android Keystore; only the ciphertext is
// written to a file in the app's private internal storage. The plaintext key
// therefore never touches disk.
#[cfg(target_os = "android")]
fn database_recovery_key(database_path: &PathBuf) -> Result<String, String> {
    let key_path = recovery_key_path(database_path);

    match fs::read(&key_path) {
        Ok(blob) => {
            let plaintext = android_keystore::unwrap_key(&blob)?;
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
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && !database_path.exists() => {
            let recovery_key = generate_recovery_key();
            let blob = android_keystore::wrap_key(recovery_key.as_bytes())?;
            if let Some(parent) = key_path.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            fs::write(&key_path, &blob).map_err(|error| error.to_string())?;
            Ok(recovery_key)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Err(missing_recovery_key_error())
        }
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(target_os = "android")]
fn recovery_key_path(database_path: &PathBuf) -> PathBuf {
    database_path.with_file_name("balance-recovery.key.enc")
}

// Wraps/unwraps a secret with a hardware-backed AES-256-GCM key stored in the
// Android Keystore. The Keystore key is non-exportable; this code only ever
// hands it plaintext to encrypt or ciphertext to decrypt, over JNI.
#[cfg(target_os = "android")]
mod android_keystore {
    use std::ffi::c_void;
    use std::sync::OnceLock;

    use jni::objects::{JByteArray, JObject};
    use jni::{JNIEnv, JavaVM};

    // Tauri/tao keep the JavaVM in their own private android glue and don't
    // initialize the `ndk-context` crate, so we capture it ourselves when the
    // JVM loads this library. The Keystore APIs need only a JNIEnv (no Activity
    // Context), so the VM alone is enough.
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
        // Leave no pending Java exception behind when we bail out.
        if result.is_err() && guard.exception_check().unwrap_or(false) {
            let _ = guard.exception_describe();
            let _ = guard.exception_clear();
        }
        result
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
        let key = get_or_create_key(env)?;
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

    fn new_cipher<'local>(
        env: &mut JNIEnv<'local>,
    ) -> Result<JObject<'local>, jni::errors::Error> {
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

    fn string_array<'local>(
        env: &mut JNIEnv<'local>,
        value: &str,
    ) -> Result<JObject<'local>, jni::errors::Error> {
        let element = env.new_string(value)?;
        let array = env.new_object_array(1, "java/lang/String", &element)?;
        Ok(array.into())
    }
}

fn missing_recovery_key_error() -> String {
    "The encrypted Balance database exists, but its recovery key is not in this keychain."
        .to_string()
}

fn generate_recovery_key() -> String {
    let mut bytes = [0_u8; 20];
    OsRng.fill_bytes(&mut bytes);

    BASE32_NOPAD
        .encode(&bytes)
        .as_bytes()
        .chunks(4)
        .map(|chunk| std::str::from_utf8(chunk).expect("base32 output is utf-8"))
        .collect::<Vec<_>>()
        .join("-")
}

fn app_database_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .data_dir()
        .map(|directory| directory.join(APP_DATA_DIR).join(APP_DATABASE_FILE))
        .map_err(|error| error.to_string())
}

#[cfg(test)]
fn app_database_path_from_data_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(APP_DATA_DIR).join(APP_DATABASE_FILE)
}

// ---------------------------------------------------------------------------
// Multi-device sync command surface (see src/sync).
// ---------------------------------------------------------------------------

/// Resolve the bundled cr-sqlite loadable extension for this platform. In a
/// packaged app it's a Tauri resource; in dev it sits beside the crate.
fn crsqlite_extension_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    // On Android the extension ships as a jniLib (libcrsqlite.so). The OS
    // extracts jniLibs into the app's nativeLibraryDir, which is on the dynamic
    // linker's search path, so dlopen resolves it by soname alone.
    #[cfg(target_os = "android")]
    {
        let _ = app;
        return Ok(PathBuf::from("libcrsqlite.so"));
    }
    #[cfg(not(target_os = "android"))]
    {
    let file = if cfg!(target_os = "windows") {
        "crsqlite.dll"
    } else if cfg!(target_os = "macos") {
        "crsqlite.dylib"
    } else {
        "crsqlite.so"
    };
    if let Ok(dir) = app.path().resource_dir() {
        for candidate in [dir.join("resources").join(file), dir.join(file)] {
            if candidate.exists() {
                return Ok(candidate);
            }
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join(file);
    if dev.exists() {
        return Ok(dev);
    }
    Err(format!("cr-sqlite extension not found ({file})"))
    }
}

/// Open the encrypted DB, load cr-sqlite, run `task`, then finalize cr-sqlite
/// before the connection closes. Sync must already be enabled (see
/// `sync_enable_*`) for the operation log to be a CRR.
fn with_synced_connection<T>(
    app: &tauri::AppHandle,
    task: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    let connection = open_database(app)?;
    let extension = crsqlite_extension_path(app)?;
    sync::activate(&connection, &extension).map_err(sync::Error::into_string)?;
    let result = task(&connection);
    // Finalize regardless of task outcome so cr-sqlite releases cleanly.
    let _ = sync::finalize(&connection);
    result
}

/// Open the DB and run `task`, transparently loading + finalizing cr-sqlite when
/// sync is enabled. Once sync is on, the `operations` log is a CRR whose triggers
/// call cr-sqlite functions (`crsql_internal_sync_bit`); any connection that
/// writes the log must have the extension loaded or the write fails with
/// "no such function". Loading it here also captures the local write into
/// `crsql_changes` so it can replicate. When sync is off this is just
/// `open_database` + `task`, with no extension cost.
fn with_database<T>(
    app: &tauri::AppHandle,
    task: impl FnOnce(&mut Connection) -> Result<T, String>,
) -> Result<T, String> {
    let mut connection = open_database(app)?;
    let synced = sync::is_sync_enabled(&connection).map_err(sync::Error::into_string)?;
    if synced {
        let extension = crsqlite_extension_path(app)?;
        sync::activate(&connection, &extension).map_err(sync::Error::into_string)?;
    }
    let result = task(&mut connection);
    // Finalize regardless of task outcome so cr-sqlite releases cleanly.
    if synced {
        let _ = sync::finalize(&connection);
    }
    result
}

/// Write a timestamped JSON backup of the current state into the app data dir,
/// so enabling sync (which rewrites the operation log) can never lose data.
fn backup_state_before_sync(
    app: &tauri::AppHandle,
    connection: &Connection,
) -> Result<(), String> {
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
        let connection = open_database(&app)?;
        sync_settings_from_database(&connection)
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

/// Move settings written by older builds from origin-scoped webview storage
/// into encrypted device-local metadata. Existing database values always win.
#[tauri::command]
async fn migrate_legacy_sync_settings(
    app: tauri::AppHandle,
    pairing_code: Option<String>,
    relay_url: Option<String>,
) -> Result<SyncSettings, String> {
    run_database_task(move || {
        let connection = open_database(&app)?;
        let enabled = sync::is_sync_enabled(&connection).map_err(sync::Error::into_string)?;

        if enabled
            && sync::read_pairing_code(&connection)
                .map_err(sync::Error::into_string)?
                .is_none()
        {
            if let Some(pairing_code) = pairing_code.filter(|value| !value.trim().is_empty()) {
                sync::crypto::SyncKey::from_pairing_code(pairing_code.trim())
                    .map_err(sync::Error::into_string)?;
                sync::store_pairing_code(&connection, pairing_code.trim())
                    .map_err(sync::Error::into_string)?;
            }
        }

        if metadata_value(&connection, SYNC_RELAY_URL)?
            .filter(|value| !value.is_empty())
            .is_none()
        {
            if let Some(relay_url) = relay_url.filter(|value| !value.trim().is_empty()) {
                // Old builds accepted arbitrary text here. Invalid legacy values
                // are safer to drop than to make pairing-key migration fail.
                if let Ok(relay_url) = normalize_sync_relay_url(&relay_url) {
                    set_metadata(&connection, SYNC_RELAY_URL, &relay_url)?;
                }
            }
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

/// Trim and fully validate a pairing code before any sync migration touches the
/// database. Checking only the prefix is unsafe: enabling a joiner clears its
/// local materialized state in preparation for bootstrap, so a malformed key
/// must be rejected before that work begins.
fn normalize_sync_pairing_code(pairing_code: &str) -> Result<String, String> {
    let pairing_code = pairing_code.trim();
    sync::crypto::SyncKey::from_pairing_code(pairing_code)
        .map_err(sync::Error::into_string)?;
    Ok(pairing_code.to_string())
}

/// Enable sync as the **primary** device: keep this device's data as the shared
/// baseline (snapshots it into the synced operation log). Backs up first. The
/// pairing code is stored (in the encrypted DB) so the P2P listener can use it.
#[tauri::command]
async fn sync_enable_primary(app: tauri::AppHandle, pairing_code: String) -> Result<(), String> {
    let pairing_code = normalize_sync_pairing_code(&pairing_code)?;
    run_database_task(move || {
        with_synced_connection(&app, |connection| {
            backup_state_before_sync(&app, connection)?;
            sync::enable_primary(connection).map_err(sync::Error::into_string)?;
            sync::store_pairing_code(connection, &pairing_code).map_err(sync::Error::into_string)
        })
    })
    .await
}

/// Enable sync as a **joining** device: adopt the primary's data, clearing this
/// device's local data (which is backed up first).
#[tauri::command]
async fn sync_enable_joiner(app: tauri::AppHandle, pairing_code: String) -> Result<(), String> {
    let pairing_code = normalize_sync_pairing_code(&pairing_code)?;
    run_database_task(move || {
        with_synced_connection(&app, |connection| {
            backup_state_before_sync(&app, connection)?;
            sync::enable_joiner(connection).map_err(sync::Error::into_string)?;
            sync::store_pairing_code(connection, &pairing_code).map_err(sync::Error::into_string)
        })
    })
    .await
}

/// Pull this device's changes (sealed with the pairing key) since `since`, ready
/// to hand to any transport (P2P socket or relay server).
#[tauri::command]
async fn sync_pull_sealed(app: tauri::AppHandle, since: i64) -> Result<Vec<u8>, String> {
    run_database_task(move || {
        let key = stored_sync_key(&app)?
            .ok_or_else(|| "This device's sync key is missing.".to_string())?;
        with_synced_connection(&app, |connection| {
            if !sync::is_sync_enabled(connection).map_err(sync::Error::into_string)? {
                return Err("Sync is not enabled on this device.".to_string());
            }
            let changes = sync::pull(connection, since, None).map_err(sync::Error::into_string)?;
            key.seal(&changes).map_err(sync::Error::into_string)
        })
    })
    .await
}

/// Apply a peer's sealed changeset, rebuild materialized state, and return the
/// new state JSON so the UI can refresh.
#[tauri::command]
async fn sync_apply_sealed(
    app: tauri::AppHandle,
    envelope: Vec<u8>,
) -> Result<Option<String>, String> {
    run_database_task(move || {
        let key = stored_sync_key(&app)?
            .ok_or_else(|| "This device's sync key is missing.".to_string())?;
        let changes = key.open(&envelope).map_err(sync::Error::into_string)?;
        with_synced_connection(&app, |connection| {
            if !sync::is_sync_enabled(connection).map_err(sync::Error::into_string)? {
                return Err("Sync is not enabled on this device.".to_string());
            }
            sync::apply(connection, &changes).map_err(sync::Error::into_string)?;
            sync::rematerialize(connection).map_err(sync::Error::into_string)?;
            read_app_state_from_database(connection).map(|state| state.map(|value| value.to_string()))
        })
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
#[tauri::command]
async fn sync_p2p_sync(app: tauri::AppHandle, address: String) -> Result<Option<String>, String> {
    run_database_task(move || {
        let Some(key) = stored_sync_key(&app)? else {
            return Err("Sync is not enabled on this device.".to_string());
        };
        sync::p2p::sync_with(&app, &key, &address).map_err(sync::Error::into_string)?;
        let connection = open_database(&app)?;
        read_app_state_from_database(&connection).map(|state| state.map(|value| value.to_string()))
    })
    .await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    disable_automatic_text_replacement();

    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            app.handle().plugin(tauri_plugin_dialog::init())?;

            // Camera QR-code scanning for sync pairing (mobile only).
            #[cfg(mobile)]
            app.handle().plugin(tauri_plugin_barcode_scanner::init())?;

            // On Android debug builds, run the real two-database pairing and
            // transport flow on-device. CI greps logcat for the marker below.
            // Complete it during setup so its independent SQLCipher connections
            // cannot race the frontend's first open of the real app database.
            #[cfg(all(target_os = "android", debug_assertions))]
            {
                if is_android_owner_user() {
                    let handle = app.handle();
                    let outcome = (|| -> Result<(), String> {
                        let ext = crsqlite_extension_path(handle)?;
                        let scratch = app_database_path(handle)?
                            .parent()
                            .ok_or("no data dir")?
                            .to_path_buf();
                        sync::selftest(&ext, &scratch).map_err(sync::Error::into_string)
                    })();
                    match outcome {
                        Ok(()) => {
                            log::info!("BALANCE_SYNC_E2E: OK");
                            eprintln!("BALANCE_SYNC_E2E: OK");
                        }
                        Err(e) => {
                            log::error!("BALANCE_SYNC_E2E: FAIL {e}");
                            eprintln!("BALANCE_SYNC_E2E: FAIL {e}");
                        }
                    }
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_app_state,
            initialize_app_state,
            persist_operation,
            undo_last_operation,
            redo_last_operation,
            list_recovery_entries,
            list_metadata,
            inspect_database,
            restore_recovery_entry,
            get_recovery_key_status,
            confirm_recovery_key,
            build_info,
            save_export_file,
            get_export_settings,
            set_export_directory,
            reset_export_directory,
            set_auto_json_export_settings,
            record_auto_json_export_success,
            record_auto_json_export_error,
            acknowledge_auto_json_export_error,
            reveal_path_in_file_manager,
            open_external_url,
            write_balance_clipboard,
            read_balance_clipboard,
            get_sync_settings,
            set_sync_relay_url,
            migrate_legacy_sync_settings,
            sync_new_pairing_code,
            sync_enable_primary,
            sync_enable_joiner,
            sync_pull_sealed,
            sync_apply_sealed,
            sync_p2p_serve,
            sync_p2p_peers,
            sync_p2p_sync
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn goal_data_persists_and_undoes_with_operations() {
        let database = TestDatabase::new("goal-data");
        let recovery_key = generate_recovery_key();
        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
        let mut state = test_state("Goal test");
        state["goals"] = json!([{
            "id": "goal_exercise",
            "name": "Exercise",
            "cadenceDays": 1,
            "matchTerms": ["lift"],
            "hue": 165,
            "activityPeriods": [{ "startDate": "2026-05-21", "endDate": null }],
            "createdAt": "2026-05-21T00:00:00Z",
            "updatedAt": "2026-05-21T00:00:00Z"
        }]);
        state["goalCompletions"] = json!([]);
        replace_app_state(&mut connection, &state).unwrap();

        persist_operation_to_database(
            &mut connection,
            &json!({
                "id": "op_device_test_2",
                "deviceId": "device_test",
                "sequence": 2,
                "type": "replace_goal_data",
                "timestamp": "2026-05-21T00:01:00Z",
                "payload": {
                    "action": "complete_goal",
                    "goalData": {
                        "goals": state["goals"].clone(),
                        "goalCompletions": [{
                            "goalId": "goal_exercise",
                            "date": "2026-05-21",
                            "itemIds": ["plan_item_wake"],
                            "matchedTerms": ["lift"],
                            "computedAt": "2026-05-21T00:01:00Z"
                        }]
                    }
                }
            }),
        )
        .unwrap();

        let completed = read_app_state_from_database(&connection).unwrap().unwrap();
        assert_eq!(completed["goals"][0]["name"], "Exercise");
        assert_eq!(completed["goalCompletions"][0]["goalId"], "goal_exercise");

        let undone = undo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(undone["goals"][0]["name"], "Exercise");
        assert_eq!(undone["goalCompletions"], json!([]));
    }

    #[test]
    fn lists_metrics_data_persists_and_undoes_with_operations() {
        let database = TestDatabase::new("lists-metrics-data");
        let recovery_key = generate_recovery_key();
        let mut connection = open_database_at(&database.path, &recovery_key).unwrap();
        let state = test_state("Lists test");
        replace_app_state(&mut connection, &state).unwrap();

        let initial = read_app_state_from_database(&connection).unwrap().unwrap();
        assert_eq!(initial["listTemplates"], json!([]));
        assert_eq!(initial["metrics"], json!([]));

        // A previously unsupported operation type must now persist via the blob.
        persist_operation_to_database(
            &mut connection,
            &json!({
                "id": "op_device_test_2",
                "deviceId": "device_test",
                "sequence": 2,
                "type": "add_list_template",
                "timestamp": "2026-05-21T00:01:00Z",
                "payload": {
                    "templateId": "list_template_1",
                    "listsMetricsData": {
                        "listTemplates": [{
                            "id": "list_template_1",
                            "name": "Groceries",
                            "maxExpectedWords": 0,
                            "items": [],
                            "createdAt": "2026-05-21T00:01:00Z",
                            "updatedAt": "2026-05-21T00:01:00Z"
                        }],
                        "lists": [],
                        "metrics": [],
                        "metricEntries": []
                    }
                }
            }),
        )
        .unwrap();

        let after = read_app_state_from_database(&connection).unwrap().unwrap();
        assert_eq!(after["listTemplates"][0]["name"], "Groceries");

        let undone = undo_last_operation_in_database(&mut connection)
            .unwrap()
            .unwrap();
        assert_eq!(undone["listTemplates"], json!([]));
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

        assert_eq!(groups.len(), 8);
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
    fn auto_json_export_time_validation_normalizes_valid_times() {
        assert_eq!(validate_auto_json_export_time("23:55").unwrap(), "23:55");
        assert_eq!(validate_auto_json_export_time("7:05").unwrap(), "07:05");
        assert!(validate_auto_json_export_time("24:00").is_err());
        assert!(validate_auto_json_export_time("12:60").is_err());
        assert!(validate_auto_json_export_time("noon").is_err());
    }

    #[test]
    fn auto_json_export_result_validation_rejects_invalid_metadata() {
        assert_eq!(validate_export_date("2026-05-31").unwrap(), "2026-05-31");
        assert!(validate_export_date("2026-5-31").is_err());
        assert!(validate_export_date("2026-05-31.json").is_err());
        assert_eq!(
            validate_export_result_path(" /tmp/balance-auto-export.json ").unwrap(),
            "/tmp/balance-auto-export.json"
        );
        assert!(validate_export_result_path("").is_err());
        assert!(validate_export_result_path("/tmp/export.json\nopen").is_err());
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
    fn pairing_code_is_fully_validated_before_sync_migration() {
        let code = sync::crypto::SyncKey::generate().to_pairing_code();
        assert_eq!(normalize_sync_pairing_code(&format!("  {code}\n")).unwrap(), code);
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
        replace_app_state(&mut connection, &test_state("Stale template sync operations")).unwrap();
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
