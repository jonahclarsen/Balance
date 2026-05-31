use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use data_encoding::BASE32_NOPAD;
use keyring::{Entry, Error as KeyringError};
use rand::{rngs::OsRng, RngCore};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::Manager;

const APP_DATABASE_FILE: &str = "balance.sqlite3";
const APP_DATA_DIR: &str = "Balance";
const KEYCHAIN_SERVICE: &str = "app.balance.local";
const KEYCHAIN_ACCOUNT: &str = "database-recovery-key";
const RECOVERY_KEY_CONFIRMED: &str = "recovery_key_confirmed";
const EXPORT_DIRECTORY: &str = "export_directory";
const DEFAULT_DAILY_REMINDER: &str = "This shouldn't be aspirational";

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
        let mut connection = open_database(&app)?;
        let state = parse_json(&state_json)?;
        replace_app_state(&mut connection, &state)
    })
    .await
}

#[tauri::command]
async fn persist_operation(app: tauri::AppHandle, operation_json: String) -> Result<(), String> {
    run_database_task(move || {
        let mut connection = open_database(&app)?;
        let operation = parse_json(&operation_json)?;
        persist_operation_to_database(&mut connection, &operation)
    })
    .await
}

#[tauri::command]
async fn undo_last_operation(app: tauri::AppHandle) -> Result<Option<String>, String> {
    run_database_task(move || {
        let mut connection = open_database(&app)?;
        undo_last_operation_in_database(&mut connection)
            .map(|state| state.map(|value| value.to_string()))
    })
    .await
}

#[tauri::command]
async fn redo_last_operation(app: tauri::AppHandle) -> Result<Option<String>, String> {
    run_database_task(move || {
        let mut connection = open_database(&app)?;
        redo_last_operation_in_database(&mut connection)
            .map(|state| state.map(|value| value.to_string()))
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

    Ok(Some(json!({
        "schemaVersion": 1,
        "deviceId": device_id,
        "localSequence": local_sequence,
        "historyRevision": 0,
        "activePlanDate": active_plan_date,
        "templates": read_templates(connection)?,
        "plans": read_plans(connection)?,
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

fn apply_operation(tx: &Transaction<'_>, operation: &Value) -> Result<(), String> {
    let operation_type = required_string(operation, "type")?;
    let payload = required_value(operation, "payload")?;

    match operation_type {
        "batch" => {
            for nested_operation in required_array(payload, "operations")? {
                apply_operation(tx, nested_operation)?;
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
        "outdent_plan_item" => outdent_plan_item_row(tx, required_string(payload, "itemId")?),
        "move_plan_item_to_position" => move_plan_item_to_position_row(
            tx,
            required_string(payload, "itemId")?,
            required_string(payload, "planId")?,
            optional_string(payload, "parentId")?.as_deref(),
            required_i64(payload, "position")?,
        ),
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
        "outdent_template_item" => {
            outdent_template_item_row(tx, required_string(payload, "itemId")?)
        }
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
        "delete_template_option" => {
            tx.execute(
                "delete from template_options where id = ?1",
                params![required_string(payload, "optionId")?],
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        }
        "insert_template_option_at" => insert_template_option(
            tx,
            required_string(payload, "itemId")?,
            required_value(payload, "option")?,
            required_i64(payload, "position")?,
        ),
        "history_undo" | "history_redo" => {
            apply_operation(tx, required_value(payload, "operation")?)
        }
        other => Err(format!("Unsupported operation type: {other}")),
    }
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
            let operations = required_array(payload, "items")?
                .iter()
                .map(|item| {
                    Ok(storage_operation(
                        "delete_plan_item",
                        json!({ "itemId": required_string(item, "id")? }),
                    ))
                })
                .collect::<Result<Vec<Value>, String>>()?;

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
        "outdent_plan_item" => build_outdent_plan_item_undo(connection, payload),
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
        "outdent_template_item" => build_outdent_template_item_undo(connection, payload),
        "add_template_option" => Ok(Some(storage_operation(
            "delete_template_option",
            json!({ "optionId": required_string(required_value(payload, "option")?, "id")? }),
        ))),
        "patch_template_option" => build_template_option_patch_undo(connection, payload),
        "split_template_item" => build_split_template_item_undo(connection, payload),
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

fn build_move_plan_items_within_level_undo(
    connection: &Connection,
    payload: &Value,
) -> Result<Option<Value>, String> {
    let mut snapshots = Vec::new();

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
            .then(a.position.cmp(&b.position))
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

        if placement == "before" {
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

    for (offset, item_id) in item_ids.iter().enumerate() {
        siblings.insert(insert_index + offset, item_id.clone());
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

fn split_template_item_row(connection: &Connection, payload: &Value) -> Result<(), String> {
    patch_template_option(connection, payload)?;

    let template_id = required_string(payload, "templateId")?;
    let source_id = required_string(payload, "itemId")?;
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
    let source_plan_id = plan_item_plan_id(connection, source_id)?;

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
    let plan_id = plan_item_plan_id(connection, item_id)?;
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
        let item_plan_id = plan_item_plan_id(connection, item_id)?;
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

fn outdent_plan_item_row(connection: &Connection, item_id: &str) -> Result<(), String> {
    let plan_id = plan_item_plan_id(connection, item_id)?;
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

fn move_plan_item_to_position_row(
    connection: &Connection,
    item_id: &str,
    plan_id: &str,
    parent_id: Option<&str>,
    position: i64,
) -> Result<(), String> {
    let current_plan_id = plan_item_plan_id(connection, item_id)?;
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
    if source_id == target_id || template_item_contains(connection, source_id, target_id)? {
        return Ok(());
    }

    let source_template_id = template_item_template_id(connection, source_id)?;

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
    let template_id = template_item_template_id(connection, item_id)?;
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

fn outdent_template_item_row(connection: &Connection, item_id: &str) -> Result<(), String> {
    let template_id = template_item_template_id(connection, item_id)?;
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

fn move_template_item_to_position_row(
    connection: &Connection,
    item_id: &str,
    template_id: &str,
    parent_id: Option<&str>,
    position: i64,
) -> Result<(), String> {
    let current_template_id = template_item_template_id(connection, item_id)?;
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

fn plan_item_plan_id(connection: &Connection, item_id: &str) -> Result<String, String> {
    connection
        .query_row(
            "select plan_id from plan_items where id = ?1",
            params![item_id],
            |row| row.get(0),
        )
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

fn template_item_template_id(connection: &Connection, item_id: &str) -> Result<String, String> {
    connection
        .query_row(
            "select template_id from template_items where id = ?1",
            params![item_id],
            |row| row.get(0),
        )
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            read_app_state,
            initialize_app_state,
            persist_operation,
            undo_last_operation,
            redo_last_operation,
            get_recovery_key_status,
            confirm_recovery_key,
            save_export_file,
            get_export_settings,
            set_export_directory,
            reset_export_directory,
            reveal_path_in_file_manager,
            open_external_url
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

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
