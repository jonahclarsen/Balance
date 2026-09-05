//! Read-only access to finalized, app-managed encrypted snapshots.
use super::*;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseBackup {
    filename: String,
    created_at_ms: i64,
    bytes: u64,
}

fn backup_timestamp(filename: &str) -> Option<i64> {
    let stem = filename.strip_suffix(".sqlite3")?;
    if ![
        "balance-daily-",
        "balance-pre-compact-",
        "balance-post-compact-",
    ]
    .iter()
    .any(|prefix| stem.starts_with(prefix))
    {
        return None;
    }
    stem.rsplit('-')
        .next()?
        .parse::<i64>()
        .ok()
        .filter(|ms| *ms > 0)
}

fn backup_directory(database_path: &Path) -> Result<PathBuf, String> {
    let directory = database_path
        .parent()
        .ok_or("Missing database directory")?
        .join("backups");
    match fs::symlink_metadata(&directory) {
        Ok(metadata) if !metadata.file_type().is_dir() => {
            Err("The backup directory must not be a symlink".into())
        }
        Ok(_) => Ok(directory),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(directory),
        Err(_) => Err("Could not access the backup directory".into()),
    }
}

fn backup_path(database_path: &Path, filename: &str) -> Result<PathBuf, String> {
    if Path::new(filename)
        .file_name()
        .and_then(|name| name.to_str())
        != Some(filename)
        || filename.contains(['/', '\\'])
        || backup_timestamp(filename).is_none()
    {
        return Err("Invalid backup filename".into());
    }
    let path = backup_directory(database_path)?.join(filename);
    let metadata = fs::symlink_metadata(&path)
        .map_err(|_| "This backup is no longer available. Refresh the backup list.")?;
    if !metadata.file_type().is_file() {
        return Err("Backups must be regular files, not symlinks".into());
    }
    Ok(path)
}

pub(super) fn list_at(database_path: &Path) -> Result<Vec<DatabaseBackup>, String> {
    let directory = backup_directory(database_path)?;
    let entries = match fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err("Could not list database backups".into()),
    };
    let mut backups = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|_| "Could not list database backups")?;
        let filename = entry.file_name().to_string_lossy().into_owned();
        let Some(created_at_ms) = backup_timestamp(&filename) else {
            continue;
        };
        if !entry
            .file_type()
            .map_err(|_| "Could not inspect backup file")?
            .is_file()
        {
            continue;
        }
        backups.push(DatabaseBackup {
            filename,
            created_at_ms,
            bytes: entry
                .metadata()
                .map_err(|_| "Could not inspect backup file")?
                .len(),
        });
    }
    backups.sort_by(|a, b| {
        b.created_at_ms
            .cmp(&a.created_at_ms)
            .then(a.filename.cmp(&b.filename))
    });
    Ok(backups)
}

pub(super) fn read_at(
    database_path: &Path,
    filename: &str,
    recovery_key: &str,
) -> Result<Value, String> {
    let path = backup_path(database_path, filename)?
        .canonicalize()
        .map_err(|_| "Could not locate backup")?;
    // Finalized backups never change. immutable + READ_ONLY avoids journal/SHM
    // creation; no schema initialization, migration, or decrypted temp copy.
    // https://www.sqlite.org/uri.html
    let mut uri = reqwest::Url::from_file_path(path).map_err(|_| "Invalid backup location")?;
    uri.set_query(Some("immutable=1"));
    let connection = Connection::open_with_flags(
        uri.as_str(),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|_| "Could not open backup read-only")?;
    apply_raw_database_key(&connection, recovery_key)?;
    connection
        .execute_batch(
            "pragma query_only = on; pragma temp_store = memory; pragma trusted_schema = off;",
        )
        .map_err(|_| "Could not configure secure backup reading")?;
    connection.query_row("select count(*) from sqlite_schema", [], |row| row.get::<_, i64>(0))
        .map_err(|_| "This backup could not be unlocked. If it predates a key rotation, enter its original recovery key. A damaged or unsupported backup also cannot be opened.")?;

    // Return only browsable content, never key metadata, sync credentials,
    // operation payloads, or image blobs. Each reader only executes SELECTs.
    let content = (|| -> Result<Value, String> {
        let mut content = read_lists_metrics_data(&connection)?;
        content["plans"] = json!(read_plans(&connection)?);
        content["templates"] = json!(read_templates(&connection)?);
        content["goals"] = read_entity_collection(&connection, "goals")?;
        Ok(content)
    })();
    content.map_err(|_| "This backup's content could not be read. It may be damaged or use an unsupported schema.".into())
}

#[tauri::command]
pub async fn list_database_backups(app: tauri::AppHandle) -> Result<Vec<DatabaseBackup>, String> {
    run_database_task(move || list_at(&app_database_path(&app)?)).await
}

#[tauri::command]
pub async fn read_database_backup(
    app: tauri::AppHandle,
    filename: String,
    recovery_key: Option<String>,
) -> Result<Value, String> {
    let supplied_key = recovery_key.map(zeroize::Zeroizing::new);
    run_database_task(move || {
        let database_path = app_database_path(&app)?;
        // Validate before accessing the credential store. An entered old key
        // stays confined to this read and never replaces the live database key.
        backup_path(&database_path, &filename)?;
        let key = match supplied_key {
            Some(key) => key,
            None => zeroize::Zeroizing::new(database_recovery_key(&database_path)?),
        };
        read_at(&database_path, &filename, &key)
    })
    .await
}
