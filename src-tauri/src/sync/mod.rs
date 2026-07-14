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

use rand::RngCore;
use rusqlite::types::Value;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use sha2::{Digest, Sha256};

pub mod crypto;
pub mod p2p;
pub mod relay;
pub mod transport;

/// Multi-device sync replicates only the append-only operation log. It is
/// insert-only with globally-unique ids, so it converges trivially as a CRR and
/// — crucially — the app's real data tables are never restructured. Each device
/// rebuilds its materialized state from the merged log via the existing
/// `apply_operation` path (see [`rematerialize`]).
pub const SYNCED_TABLES: &[&str] = &["operations"];

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
/// at runtime. The loadable library (crsqlite.dylib/.so/.dll, including the
/// Android `.so`) is shipped as a Tauri resource. `entry_point` is
/// `sqlite3_crsqlite_init`.
pub fn load_extension(conn: &Connection, extension_path: impl AsRef<Path>) -> Result<()> {
    unsafe {
        conn.load_extension_enable()?;
        let res = conn.load_extension(extension_path.as_ref(), Some("sqlite3_crsqlite_init"));
        conn.load_extension_disable()?;
        res?;
    }
    Ok(())
}

/// Activate cr-sqlite on a connection by loading the extension at runtime
/// (same mechanism on every platform).
pub fn activate(conn: &Connection, extension_path: impl AsRef<Path>) -> Result<()> {
    load_extension(conn, extension_path)
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

/// Whether sync has been enabled on this database (the operation log is a CRR).
pub fn is_sync_enabled(conn: &Connection) -> Result<bool> {
    // cr-sqlite records each CRR in crsql_master / its clock tables; the simplest
    // durable marker is our own metadata flag set by `enable_*`.
    let enabled: Option<String> = conn
        .query_row(
            "SELECT value FROM metadata WHERE key = 'sync_enabled'",
            [],
            |r| r.get(0),
        )
        .ok();
    Ok(enabled.as_deref() == Some("true"))
}

/// Exercise the full sync stack against real, throwaway encrypted databases:
/// load the cr-sqlite extension, make two CRR databases diverge, ship the
/// changes as an end-to-end-sealed envelope, apply them, and assert the two
/// converge. Used as an on-device smoke test (Android) to confirm the bundled
/// `.so` actually loads and the engine works on the target — not just that the
/// app launches. Cleans up after itself.
pub fn selftest(extension_path: &Path, scratch_dir: &Path) -> Result<()> {
    // The self-test may run before the main database has created this directory.
    std::fs::create_dir_all(scratch_dir).map_err(|e| Error::Codec(e.to_string()))?;
    let a_path = scratch_dir.join("crsql-selftest-a.sqlite3");
    let b_path = scratch_dir.join("crsql-selftest-b.sqlite3");
    let _ = std::fs::remove_file(&a_path);
    let _ = std::fs::remove_file(&b_path);

    let open = |path: &Path, key: &str| -> Result<Connection> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "key", key)?;
        conn.query_row("pragma cipher_version", [], |r| r.get::<_, String>(0))?;
        load_extension(&conn, extension_path)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS t (id TEXT PRIMARY KEY NOT NULL, v TEXT NOT NULL DEFAULT '');",
        )?;
        as_crr(&conn, "t")?;
        Ok(conn)
    };

    let result = (|| -> Result<()> {
        let a = open(&a_path, "selftest-key-a")?;
        let b = open(&b_path, "selftest-key-b")?;

        a.execute("INSERT INTO t (id, v) VALUES ('x', 'hello')", [])?;

        // Ship A's change to B as an E2E-sealed envelope and apply it.
        let key = crypto::SyncKey::generate();
        let sealed = key.seal(&pull(&a, 0, None)?)?;
        apply(&b, &key.open(&sealed)?)?;

        let converged = state_hash(&a, &["t"])? == state_hash(&b, &["t"])?;
        let got: String = b.query_row("SELECT v FROM t WHERE id='x'", [], |r| r.get(0))?;

        finalize(&a)?;
        finalize(&b)?;

        if !converged || got != "hello" {
            return Err(Error::Crypto("selftest did not converge".into()));
        }
        Ok(())
    })();

    let _ = std::fs::remove_file(&a_path);
    let _ = std::fs::remove_file(&b_path);
    result
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

// ---------------------------------------------------------------------------
// Op-log sync. We replicate only the append-only `operations` table (a CRR),
// and rebuild materialized state from it via the app's existing materializer.
// ---------------------------------------------------------------------------

fn random_id() -> String {
    let mut b = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut b);
    hex(&b)
}

fn mark_enabled(conn: &Connection) -> Result<()> {
    conn.execute(
        "INSERT INTO metadata (key, value) VALUES ('sync_enabled','true') \
         ON CONFLICT(key) DO UPDATE SET value='true'",
        [],
    )?;
    Ok(())
}

/// Persist the pairing code (the E2E key) in the encrypted DB so the background
/// P2P listener can decrypt incoming changesets without UI involvement.
pub fn store_pairing_code(conn: &Connection, pairing_code: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO metadata (key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![crate::SYNC_PAIRING_CODE, pairing_code],
    )?;
    Ok(())
}

/// Read the stored pairing code, if sync has been enabled on this device.
pub fn read_pairing_code(conn: &Connection) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT value FROM metadata WHERE key = ?1",
            params![crate::SYNC_PAIRING_CODE],
            |r| r.get::<_, String>(0),
        )
        .ok())
}

fn operations_has_defaults(conn: &Connection) -> Result<bool> {
    let mut stmt = conn.prepare("PRAGMA table_info(operations)")?;
    let cols = stmt
        .query_map([], |r| {
            Ok((r.get::<_, String>(1)?, r.get::<_, Option<String>>(4)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(cols
        .iter()
        .any(|(name, dflt)| name == "payload_json" && dflt.is_some()))
}

/// cr-sqlite requires CRR columns to be nullable or have defaults. Rebuild the
/// `operations` table with identical columns plus defaults, preserving all rows.
/// The app always inserts explicit values, so the defaults are transparent.
/// Idempotent: a no-op once the defaults are present.
fn rebuild_operations_with_defaults(conn: &Connection) -> Result<()> {
    if operations_has_defaults(conn)? {
        return Ok(());
    }
    // Renames/drops referenced tables; do it with FK enforcement off and
    // legacy_alter_table on (pragmas are no-ops inside a transaction).
    let fk_was_on: bool = conn.query_row("PRAGMA foreign_keys", [], |r| r.get(0))?;
    conn.pragma_update(None, "foreign_keys", false)?;
    conn.pragma_update(None, "legacy_alter_table", true)?;
    {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(
            "ALTER TABLE operations RENAME TO operations_legacy;
             CREATE TABLE operations (
                id TEXT PRIMARY KEY NOT NULL,
                device_id TEXT NOT NULL DEFAULT '',
                sequence INTEGER NOT NULL DEFAULT 0,
                type TEXT NOT NULL DEFAULT '',
                timestamp TEXT NOT NULL DEFAULT '',
                payload_json TEXT NOT NULL DEFAULT '{}'
             );
             INSERT INTO operations (id, device_id, sequence, type, timestamp, payload_json)
                SELECT id, device_id, sequence, type, timestamp, payload_json FROM operations_legacy;
             DROP TABLE operations_legacy;
             CREATE INDEX IF NOT EXISTS idx_operations_sequence ON operations(sequence);",
        )?;
        tx.commit()?;
    }
    conn.pragma_update(None, "legacy_alter_table", false)?;
    conn.pragma_update(None, "foreign_keys", fk_was_on)?;
    Ok(())
}

/// Build a `replace_full_state` baseline op capturing the current domain state,
/// timestamped so it always sorts first in a canonical replay.
fn snapshot_current_state_op(conn: &Connection) -> Result<JsonValue> {
    let state = crate::read_app_state_from_database(conn)
        .map_err(Error::Codec)?
        .unwrap_or_else(|| {
            json!({
                "templates": [], "plans": [],
                "goals": [], "goalCompletions": [],
                "listTemplates": [], "lists": [], "metrics": [], "metricEntries": [],
                "activePlanDate": ""
            })
        });
    let device_id = crate::metadata_value(conn, "device_id")
        .map_err(Error::Codec)?
        .unwrap_or_default();
    Ok(json!({
        "id": random_id(),
        "deviceId": device_id,
        "sequence": 0,
        // Sorts before any real ISO-8601 timestamp, so it's the replay baseline.
        "timestamp": "0000-00-00T00:00:00.000Z",
        "type": "replace_full_state",
        "payload": { "state": state },
    }))
}

/// Enable sync on the device that holds the canonical data ("Create sync key").
/// Snapshot the current state into a single baseline op, reset the log to just
/// that snapshot, and promote the log to a CRR. The real data tables are not
/// touched.
pub fn enable_primary(conn: &Connection) -> Result<()> {
    rebuild_operations_with_defaults(conn)?;
    let snapshot = snapshot_current_state_op(conn)?;
    {
        let tx = conn.unchecked_transaction()?;
        tx.execute("DELETE FROM operations", [])?;
        tx.execute("DELETE FROM history_entries", [])?;
        crate::upsert_operation(&tx, &snapshot).map_err(Error::Codec)?;
        tx.commit()?;
    }
    as_crr(conn, "operations")?;
    mark_enabled(conn)?;
    Ok(())
}

/// Enable sync on a device that will adopt another's data ("Pair with another
/// device"). Clear local domain state and the op log (the caller takes a backup
/// first), promote the log to a CRR, then wait to receive the primary's baseline
/// via sync + [`rematerialize`].
pub fn enable_joiner(conn: &Connection) -> Result<()> {
    rebuild_operations_with_defaults(conn)?;
    {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(
            "DELETE FROM operations; DELETE FROM history_entries;
             DELETE FROM plan_items; DELETE FROM plans;
             DELETE FROM template_options; DELETE FROM template_items; DELETE FROM templates;
             DELETE FROM metadata WHERE key IN ('goal_data','lists_metrics_data');",
        )?;
        tx.commit()?;
    }
    as_crr(conn, "operations")?;
    mark_enabled(conn)?;
    Ok(())
}

/// Reconstruct the op `Value`s from the `operations` rows in canonical order
/// (timestamp, device_id, sequence) — the deterministic total order every device
/// agrees on.
fn read_operations_canonical(conn: &Connection) -> Result<Vec<JsonValue>> {
    let mut stmt = conn.prepare(
        "SELECT id, device_id, sequence, type, timestamp, payload_json FROM operations \
         ORDER BY timestamp, device_id, sequence",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut ops = Vec::with_capacity(rows.len());
    for (id, device_id, sequence, ty, timestamp, payload_json) in rows {
        let payload: JsonValue =
            serde_json::from_str(&payload_json).map_err(|e| Error::Codec(e.to_string()))?;
        ops.push(json!({
            "id": id,
            "deviceId": device_id,
            "sequence": sequence,
            "type": ty,
            "timestamp": timestamp,
            "payload": payload,
        }));
    }
    Ok(ops)
}

/// Rebuild the materialized domain tables by replaying every operation in
/// canonical order through the app's existing `apply_operation`. Called after a
/// sync merge so all devices converge to identical state.
pub fn rematerialize(conn: &Connection) -> Result<()> {
    let ops = read_operations_canonical(conn)?;
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(
        "DELETE FROM plan_items; DELETE FROM plans;
         DELETE FROM template_options; DELETE FROM template_items; DELETE FROM templates;",
    )?;
    for op in &ops {
        crate::apply_operation(&tx, op).map_err(Error::Codec)?;
    }
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests;
