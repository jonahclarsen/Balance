//! Multi-device sync for Balance.
//!
//! The database stays a normal SQLCipher-encrypted file (see `open_database_at`
//! in the crate root). This module loads the cr-sqlite extension (Superfly
//! fork), turns selected tables into conflict-free replicated relations (CRRs),
//! and exposes the `crsql_changes` delta stream as sealed, transport-agnostic
//! envelopes. P2P and server transports both consume that one primitive.
//!
//! These are free functions over `&Connection` so they compose with the app's
//! existing connection lifecycle rather than owning their own.
//!
//! Much of the public surface (transports, relay, crypto) is the API the
//! not-yet-wired network/command layer will call, so dead-code is allowed here
//! until that layer lands.
#![allow(dead_code)]

use std::path::Path;

use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use sha2::{Digest, Sha256};

pub mod crypto;
pub mod relay;
pub mod transport;

/// Tables promoted to CRRs by [`enable_crrs`] / created by [`migrate_to_crr`].
/// Templates/options follow the identical recipe and are added here as they're
/// migrated.
pub const SYNCED_TABLES: &[&str] = &[
    "plans",
    "plan_items",
    "templates",
    "template_items",
    "template_options",
    "goals",
    "goal_completions",
    "list_templates",
    "lists",
    "metrics",
    "metric_entries",
];

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug)]
pub enum Error {
    Sqlite(rusqlite::Error),
    Crypto(String),
    Codec(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Sqlite(e) => write!(f, "sqlite: {e}"),
            Error::Crypto(e) => write!(f, "crypto: {e}"),
            Error::Codec(e) => write!(f, "codec: {e}"),
        }
    }
}
impl std::error::Error for Error {}
impl From<rusqlite::Error> for Error {
    fn from(e: rusqlite::Error) -> Self {
        Error::Sqlite(e)
    }
}
impl Error {
    pub fn into_string(self) -> String {
        self.to_string()
    }
}

/// Transport-neutral mirror of `rusqlite::types::Value`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SqlValue {
    Null,
    Integer(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

impl From<Value> for SqlValue {
    fn from(v: Value) -> Self {
        match v {
            Value::Null => SqlValue::Null,
            Value::Integer(i) => SqlValue::Integer(i),
            Value::Real(r) => SqlValue::Real(r),
            Value::Text(t) => SqlValue::Text(t),
            Value::Blob(b) => SqlValue::Blob(b),
        }
    }
}
impl From<SqlValue> for Value {
    fn from(v: SqlValue) -> Self {
        match v {
            SqlValue::Null => Value::Null,
            SqlValue::Integer(i) => Value::Integer(i),
            SqlValue::Real(r) => Value::Real(r),
            SqlValue::Text(t) => Value::Text(t),
            SqlValue::Blob(b) => Value::Blob(b),
        }
    }
}

/// One row of `crsql_changes` (Superfly fork column set; `site_id` required).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangeRow {
    pub table: String,
    pub pk: SqlValue,
    pub cid: String,
    pub val: SqlValue,
    pub col_version: i64,
    pub db_version: i64,
    pub site_id: SqlValue,
    pub cl: i64,
    pub seq: i64,
}

/// A batch of changes plus the originating site, ready to seal and ship.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangeSet {
    pub origin_site_hex: String,
    pub rows: Vec<ChangeRow>,
}

/// Load the cr-sqlite extension into an already-open (and unlocked) connection
/// at runtime. Desktop only: the dylib/.so/.dll is shipped as a Tauri resource.
/// `entry_point` is `sqlite3_crsqlite_init`.
#[cfg(not(target_os = "android"))]
pub fn load_extension(conn: &Connection, extension_path: impl AsRef<Path>) -> Result<()> {
    unsafe {
        conn.load_extension_enable()?;
        let res = conn.load_extension(extension_path.as_ref(), Some("sqlite3_crsqlite_init"));
        conn.load_extension_disable()?;
        res?;
    }
    Ok(())
}

/// Initialise the **statically-linked** cr-sqlite engine on a connection.
/// Android only: the archive is linked by build.rs, so instead of loading a
/// `.so` at runtime we call the extension's init entry point directly with the
/// raw connection handle. (Validated by the Android CI/device build, not the
/// desktop test suite.)
#[cfg(target_os = "android")]
pub fn init_static(conn: &Connection) -> Result<()> {
    use std::os::raw::{c_char, c_int, c_void};
    extern "C" {
        fn sqlite3_crsqlite_init(
            db: *mut rusqlite::ffi::sqlite3,
            pz_err_msg: *mut *mut c_char,
            p_api: *const c_void,
        ) -> c_int;
    }
    // SQLITE_OK == 0. For a statically-linked extension the api-routines pointer
    // is unused, so a null pointer is correct here.
    let rc = unsafe { sqlite3_crsqlite_init(conn.handle(), std::ptr::null_mut(), std::ptr::null()) };
    if rc != 0 {
        return Err(Error::Crypto(format!("crsqlite init failed: rc={rc}")));
    }
    Ok(())
}

/// Activate cr-sqlite on a connection, choosing runtime load (desktop) vs the
/// statically-linked init (Android). `extension_path` is only consulted on
/// desktop.
pub fn activate(conn: &Connection, extension_path: impl AsRef<Path>) -> Result<()> {
    #[cfg(not(target_os = "android"))]
    {
        load_extension(conn, extension_path)
    }
    #[cfg(target_os = "android")]
    {
        let _ = extension_path;
        init_static(conn)
    }
}

/// Promote a table to a CRR so its writes become mergeable.
pub fn as_crr(conn: &Connection, table: &str) -> Result<()> {
    conn.query_row("SELECT crsql_as_crr(?1)", params![table], |_| Ok(()))?;
    Ok(())
}

pub fn enable_crrs(conn: &Connection, tables: &[&str]) -> Result<()> {
    for t in tables {
        as_crr(conn, t)?;
    }
    Ok(())
}

/// Whether [`migrate_to_crr`] has already run on this database.
pub fn is_migrated(conn: &Connection) -> Result<bool> {
    column_exists(conn, "plan_items", "position_key")
}

pub fn site_hex(conn: &Connection) -> Result<String> {
    let blob: Vec<u8> = conn.query_row("SELECT crsql_site_id()", [], |r| r.get(0))?;
    Ok(hex(&blob))
}

pub fn db_version(conn: &Connection) -> Result<i64> {
    Ok(conn.query_row("SELECT crsql_db_version()", [], |r| r.get(0))?)
}

/// cr-sqlite must be finalized before the connection closes.
pub fn finalize(conn: &Connection) -> Result<()> {
    conn.query_row("SELECT crsql_finalize()", [], |_| Ok(()))?;
    Ok(())
}

/// Pull changes with `db_version > since`, excluding rows that originated at
/// `exclude_site_hex` (so a peer's own writes aren't echoed back to it).
pub fn pull(conn: &Connection, since: i64, exclude_site_hex: Option<&str>) -> Result<ChangeSet> {
    let exclude_blob = exclude_site_hex.map(unhex).transpose()?;
    let mut stmt = conn.prepare(
        "SELECT \"table\", pk, cid, val, col_version, db_version, site_id, cl, seq \
         FROM crsql_changes \
         WHERE db_version > ?1 AND (?2 IS NULL OR site_id IS NOT ?2) \
         ORDER BY db_version, seq",
    )?;
    let rows = stmt
        .query_map(params![since, exclude_blob], |r| {
            Ok(ChangeRow {
                table: r.get(0)?,
                pk: r.get::<_, Value>(1)?.into(),
                cid: r.get(2)?,
                val: r.get::<_, Value>(3)?.into(),
                col_version: r.get(4)?,
                db_version: r.get(5)?,
                site_id: r.get::<_, Value>(6)?.into(),
                cl: r.get(7)?,
                seq: r.get(8)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(ChangeSet {
        origin_site_hex: site_hex(conn)?,
        rows,
    })
}

/// Apply a peer's changes (column-level LWW merge; idempotent, order-independent).
pub fn apply(conn: &Connection, set: &ChangeSet) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO crsql_changes \
             (\"table\", pk, cid, val, col_version, db_version, site_id, cl, seq) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        )?;
        for c in &set.rows {
            stmt.execute(params![
                c.table,
                Value::from(c.pk.clone()),
                c.cid,
                Value::from(c.val.clone()),
                c.col_version,
                c.db_version,
                Value::from(c.site_id.clone()),
                c.cl,
                c.seq,
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Deterministic hash of the materialized contents of `tables`, for asserting
/// two devices converged (state, not history).
pub fn state_hash(conn: &Connection, tables: &[&str]) -> Result<String> {
    let mut hasher = Sha256::new();
    for table in tables {
        hasher.update(b"T:");
        hasher.update(table.as_bytes());
        let cols = column_names(conn, table)?;
        let col_list = cols
            .iter()
            .map(|c| format!("\"{c}\""))
            .collect::<Vec<_>>()
            .join(", ");
        let select = format!("SELECT {col_list} FROM \"{table}\" ORDER BY {col_list}");
        let mut stmt = conn.prepare(&select)?;
        let ncols = cols.len();
        let mut rows = stmt.query([])?;
        while let Some(row) = rows.next()? {
            hasher.update(b"R");
            for i in 0..ncols {
                hash_value(&mut hasher, &row.get::<_, Value>(i)?);
            }
        }
    }
    Ok(hex(&hasher.finalize()))
}

fn column_names(conn: &Connection, table: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info(\"{table}\")"))?;
    let names = stmt
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(names)
}

/// Migrate the live Balance schema into a sync-ready, CRR-compatible shape:
///
///  * `plan_items` gains a fractional `position_key` (backfilled from the
///    integer `position` order) and is rebuilt with CRR-legal column defaults.
///  * `plans` is rebuilt without the `UNIQUE(date)` constraint and with
///    defaults (deterministic IDs handle dedup for *new* plans).
///  * the `goal_data` metadata blob is exploded into `goals` /
///    `goal_completions` rows so concurrent edits to different entities merge.
///
/// Existing row IDs and all field values are preserved. Idempotent: a second
/// run is a no-op once `plan_items.position_key` exists.
pub fn migrate_to_crr(conn: &Connection) -> Result<()> {
    if column_exists(conn, "plan_items", "position_key")? {
        return Ok(()); // already migrated
    }

    // Rebuilding tables means renaming/dropping referenced tables. Do it with FK
    // enforcement off and legacy_alter_table on, so RENAME doesn't rewrite other
    // tables' FK references and DROP doesn't trip enforcement. These pragmas are
    // no-ops inside a transaction, so set them before opening one.
    let fk_was_on: bool = conn.query_row("PRAGMA foreign_keys", [], |r| r.get(0))?;
    conn.pragma_update(None, "foreign_keys", false)?;
    conn.pragma_update(None, "legacy_alter_table", true)?;

    let tx = conn.unchecked_transaction()?;

    // --- plans: drop UNIQUE(date), add defaults --------------------------------
    tx.execute_batch(
        "ALTER TABLE plans RENAME TO plans_legacy;
         CREATE TABLE plans (
            id TEXT PRIMARY KEY NOT NULL,
            date TEXT NOT NULL DEFAULT '',
            title TEXT NOT NULL DEFAULT '',
            daily_reminder TEXT NOT NULL DEFAULT '',
            generated_from_template_id TEXT,
            created_at TEXT NOT NULL DEFAULT ''
         );
         INSERT INTO plans (id, date, title, daily_reminder, generated_from_template_id, created_at)
            SELECT id, date, title, daily_reminder, generated_from_template_id, created_at
            FROM plans_legacy;
         DROP TABLE plans_legacy;",
    )?;

    // --- plan_items: fractional position_key per (plan_id, parent_id) ----------
    tx.execute_batch(
        "ALTER TABLE plan_items RENAME TO plan_items_legacy;
         CREATE TABLE plan_items (
            id TEXT PRIMARY KEY NOT NULL,
            plan_id TEXT NOT NULL DEFAULT '',
            parent_id TEXT,
            position_key TEXT NOT NULL DEFAULT '',
            text TEXT NOT NULL DEFAULT '',
            html TEXT NOT NULL DEFAULT '',
            done INTEGER NOT NULL DEFAULT 0,
            start_minutes INTEGER,
            end_minutes INTEGER
         );",
    )?;
    backfill_fractional(
        &tx,
        "plan_items_legacy",
        "plan_items",
        &["id", "plan_id", "parent_id", "text", "html", "done", "start_minutes", "end_minutes"],
        &["plan_id", "parent_id"],
    )?;
    tx.execute_batch("DROP TABLE plan_items_legacy;")?;

    // --- templates: a flat ordered list ----------------------------------------
    tx.execute_batch(
        "ALTER TABLE templates RENAME TO templates_legacy;
         CREATE TABLE templates (
            id TEXT PRIMARY KEY NOT NULL,
            name TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL DEFAULT '',
            position_key TEXT NOT NULL DEFAULT ''
         );",
    )?;
    backfill_fractional(
        &tx,
        "templates_legacy",
        "templates",
        &["id", "name", "created_at", "updated_at"],
        &[],
    )?;
    tx.execute_batch("DROP TABLE templates_legacy;")?;

    // --- template_items: per (template_id, parent_id) --------------------------
    tx.execute_batch(
        "ALTER TABLE template_items RENAME TO template_items_legacy;
         CREATE TABLE template_items (
            id TEXT PRIMARY KEY NOT NULL,
            template_id TEXT NOT NULL DEFAULT '',
            parent_id TEXT,
            position_key TEXT NOT NULL DEFAULT '',
            start_minutes INTEGER,
            end_minutes INTEGER
         );",
    )?;
    backfill_fractional(
        &tx,
        "template_items_legacy",
        "template_items",
        &["id", "template_id", "parent_id", "start_minutes", "end_minutes"],
        &["template_id", "parent_id"],
    )?;
    tx.execute_batch("DROP TABLE template_items_legacy;")?;

    // --- template_options: per item_id -----------------------------------------
    tx.execute_batch(
        "ALTER TABLE template_options RENAME TO template_options_legacy;
         CREATE TABLE template_options (
            id TEXT PRIMARY KEY NOT NULL,
            item_id TEXT NOT NULL DEFAULT '',
            position_key TEXT NOT NULL DEFAULT '',
            text TEXT NOT NULL DEFAULT '',
            html TEXT NOT NULL DEFAULT '',
            probability REAL NOT NULL DEFAULT 0
         );",
    )?;
    backfill_fractional(
        &tx,
        "template_options_legacy",
        "template_options",
        &["id", "item_id", "text", "html", "probability"],
        &["item_id"],
    )?;
    tx.execute_batch("DROP TABLE template_options_legacy;")?;

    // --- goals / goal_completions: blob -> rows --------------------------------
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS goals (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL DEFAULT '{}');
         CREATE TABLE IF NOT EXISTS goal_completions (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL DEFAULT '{}');",
    )?;
    if let Some(raw) = metadata_blob(&tx, "goal_data")? {
        let parsed: JsonValue = serde_json::from_str(&raw).unwrap_or_else(|_| json!({}));
        explode_entities(&tx, "goals", parsed.get("goals"))?;
        explode_entities(&tx, "goal_completions", parsed.get("goalCompletions"))?;
        tx.execute("DELETE FROM metadata WHERE key='goal_data'", [])?;
    }

    // --- lists / metrics: blob -> rows -----------------------------------------
    tx.execute_batch(
        "CREATE TABLE IF NOT EXISTS list_templates (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL DEFAULT '{}');
         CREATE TABLE IF NOT EXISTS lists (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL DEFAULT '{}');
         CREATE TABLE IF NOT EXISTS metrics (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL DEFAULT '{}');
         CREATE TABLE IF NOT EXISTS metric_entries (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL DEFAULT '{}');",
    )?;
    if let Some(raw) = metadata_blob(&tx, "lists_metrics_data")? {
        let parsed: JsonValue = serde_json::from_str(&raw).unwrap_or_else(|_| json!({}));
        explode_entities(&tx, "list_templates", parsed.get("listTemplates"))?;
        explode_entities(&tx, "lists", parsed.get("lists"))?;
        explode_entities(&tx, "metrics", parsed.get("metrics"))?;
        explode_entities(&tx, "metric_entries", parsed.get("metricEntries"))?;
        tx.execute("DELETE FROM metadata WHERE key='lists_metrics_data'", [])?;
    }

    tx.commit()?;

    // Restore enforcement to the connection's prior state.
    conn.pragma_update(None, "legacy_alter_table", false)?;
    conn.pragma_update(None, "foreign_keys", fk_was_on)?;
    Ok(())
}

/// Rebuild an ordered table from its `_legacy` copy, replacing the integer
/// `position` with a fractional `position_key`. Rows are grouped by `group_cols`
/// (the columns that define one ordered collection, e.g. `[plan_id, parent_id]`;
/// empty for a single flat list) and, within each group, assigned sequential
/// fractional keys in the original `position` order — so ordering is preserved
/// exactly. `copy_cols` are the columns carried over verbatim (everything except
/// `position`/`position_key`). Generic over column shape via dynamic SQL +
/// `params_from_iter`, so every ordered table reuses one code path.
fn backfill_fractional(
    conn: &Connection,
    legacy: &str,
    target: &str,
    copy_cols: &[&str],
    group_cols: &[&str],
) -> Result<()> {
    // The set of ordered collections to rebuild.
    let groups: Vec<Vec<Value>> = if group_cols.is_empty() {
        vec![Vec::new()]
    } else {
        let sql = format!(
            "SELECT DISTINCT {} FROM \"{legacy}\"",
            group_cols
                .iter()
                .map(|c| format!("\"{c}\""))
                .collect::<Vec<_>>()
                .join(", ")
        );
        let mut stmt = conn.prepare(&sql)?;
        let n = group_cols.len();
        let collected = stmt
            .query_map([], |r| {
                (0..n).map(|i| r.get::<_, Value>(i)).collect::<rusqlite::Result<Vec<_>>>()
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        collected
    };

    let select_list = copy_cols
        .iter()
        .map(|c| format!("\"{c}\""))
        .collect::<Vec<_>>()
        .join(", ");
    let placeholders = std::iter::repeat("?")
        .take(copy_cols.len() + 1)
        .collect::<Vec<_>>()
        .join(", ");
    let insert_sql =
        format!("INSERT INTO \"{target}\" ({select_list}, position_key) VALUES ({placeholders})");

    for group in groups {
        let where_clause = if group_cols.is_empty() {
            String::new()
        } else {
            // `IS` is null-safe, so NULL parent_id groups match correctly.
            let conds = group_cols
                .iter()
                .map(|c| format!("\"{c}\" IS ?"))
                .collect::<Vec<_>>()
                .join(" AND ");
            format!("WHERE {conds}")
        };
        let select_sql =
            format!("SELECT {select_list} FROM \"{legacy}\" {where_clause} ORDER BY position");

        let ncopy = copy_cols.len();
        let mut stmt = conn.prepare(&select_sql)?;
        let rows: Vec<Vec<Value>> = stmt
            .query_map(params_from_iter(group.iter()), |r| {
                (0..ncopy).map(|i| r.get::<_, Value>(i)).collect::<rusqlite::Result<Vec<_>>>()
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        let mut prev_key: Option<String> = None;
        for mut row in rows {
            let key: String = conn.query_row(
                "SELECT crsql_fract_key_between(?1, NULL)",
                params![prev_key],
                |r| r.get(0),
            )?;
            row.push(Value::Text(key.clone()));
            conn.execute(&insert_sql, params_from_iter(row.iter()))?;
            prev_key = Some(key);
        }
    }
    Ok(())
}

/// Insert each element of a JSON array as a row keyed by its `id`, preserving
/// the entire object (so no field is lost regardless of shape).
fn explode_entities(conn: &Connection, table: &str, arr: Option<&JsonValue>) -> Result<()> {
    let Some(items) = arr.and_then(JsonValue::as_array) else {
        return Ok(());
    };
    for (i, item) in items.iter().enumerate() {
        let id = item
            .get("id")
            .and_then(JsonValue::as_str)
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("legacy-{table}-{i}"));
        let data = serde_json::to_string(item).map_err(|e| Error::Codec(e.to_string()))?;
        conn.execute(
            &format!("INSERT OR REPLACE INTO \"{table}\" (id, data) VALUES (?1, ?2)"),
            params![id, data],
        )?;
    }
    Ok(())
}

fn metadata_blob(conn: &Connection, key: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT value FROM metadata WHERE key = ?1",
            params![key],
            |r| r.get::<_, String>(0),
        )
        .ok())
}

fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    let cols = column_names(conn, table)?;
    Ok(cols.iter().any(|c| c == column))
}

fn hash_value(hasher: &mut Sha256, v: &Value) {
    match v {
        Value::Null => hasher.update([0u8]),
        Value::Integer(i) => {
            hasher.update([1u8]);
            hasher.update(i.to_le_bytes());
        }
        Value::Real(r) => {
            hasher.update([2u8]);
            hasher.update(r.to_le_bytes());
        }
        Value::Text(t) => {
            hasher.update([3u8]);
            hasher.update((t.len() as u64).to_le_bytes());
            hasher.update(t.as_bytes());
        }
        Value::Blob(b) => {
            hasher.update([4u8]);
            hasher.update((b.len() as u64).to_le_bytes());
            hasher.update(b);
        }
    }
}

pub fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

pub fn unhex(s: &str) -> Result<Vec<u8>> {
    if s.len() % 2 != 0 {
        return Err(Error::Codec("odd-length hex".into()));
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|e| Error::Codec(e.to_string())))
        .collect()
}

#[cfg(test)]
mod tests;
