//! Multi-device sync for Balance.
//!
//! The database stays a normal SQLCipher-encrypted file (see `open_database_at`
//! in the crate root). The only replicated table is `operations`: an append-only
//! log of immutable rows with globally-unique TEXT ids, a canonical total order
//! of `(timestamp, device_id, sequence)`, and a deterministic materializer
//! (`apply_operation`, driven by [`rematerialize`]).
//!
//! Between checkpoints, globally unique ids make reconciliation an id-set diff.
//! A checkpoint adds a compact per-device sequence frontier so an offline peer
//! cannot resurrect removed history. No native SQLite extension is involved.
//!
//! Compaction (checkpointing) is the one operation that *removes* ops. The
//! resulting `replace_full_state` baseline carries the highest sequence covered
//! for each device. Legacy v2 tombstones remain readable for migration, but do
//! not grow as new checkpoints are created.
//!
//! These are free functions over `&Connection` so they compose with the app's
//! existing connection lifecycle rather than owning their own.
#![allow(dead_code)]

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::path::Path;

use rand::RngCore;
use rusqlite::types::Value;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use sha2::{Digest, Sha256};

pub mod crypto;
pub mod p2p;
pub mod relay;
pub mod relay_client;
pub mod transport;

/// Wire-protocol version. Bump only for incompatible framing/semantics changes.
pub const PROTOCOL_VERSION: u32 = 4;

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

/// One row of the replicated `operations` log, exactly as it is stored.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Op {
    pub id: String,
    pub device_id: String,
    pub sequence: i64,
    #[serde(rename = "type")]
    pub op_type: String,
    pub timestamp: String,
    pub payload_json: String,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LegacyOperationAudit {
    pub records_checked: usize,
    pub legacy_checkpoint_records: usize,
    pub legacy_entity_snapshot_records: usize,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LocalLegacyAudit {
    pub operations: LegacyOperationAudit,
    pub history_entries_checked: usize,
    pub legacy_history_entries: usize,
    pub tombstone_count: usize,
    pub cleanup_guard_count: usize,
    pub cleanup_staged: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LegacyCleanupStageResult {
    pub guarded_ids: usize,
    pub checkpoint_records_cleaned: usize,
}

const LEGACY_CLEANUP_STAGED: &str = "legacy_sync_cleanup_staged";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InventoryItem {
    pub id: String,
    pub device_id: String,
    pub sequence: i64,
    pub checkpoint: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct SyncInventory {
    pub items: Vec<InventoryItem>,
    pub frontiers: HashMap<String, i64>,
}

/// The database side of a sync exchange. The transport calls these between
/// socket reads and writes; each implementation decides how it gets a
/// connection (a borrowed one in tests, a freshly opened + globally guarded one
/// in the app) so that **no lock and no connection is held across socket I/O**.
pub trait SyncStore {
    /// Current post-checkpoint operations plus compact covered frontiers.
    fn inventory(&self) -> Result<SyncInventory>;
    /// `(ops the peer is missing, ids this device wants from the peer)`.
    fn diff(&self, peer: &SyncInventory) -> Result<(Vec<Op>, Vec<String>)>;
    /// Full rows for the requested ids (ids this device does not have are
    /// silently skipped).
    fn ops_by_id(&self, ids: &[String]) -> Result<Vec<Op>>;
    /// Merge received ops, rematerializing state if anything was inserted.
    /// Returns the number of ops actually inserted.
    fn merge(&self, ops: Vec<Op>) -> Result<usize>;
}

/// [`SyncStore`] over an already-open connection (tests and [`selftest`]).
pub struct ConnectionStore<'a>(pub &'a Connection);

impl SyncStore for ConnectionStore<'_> {
    fn inventory(&self) -> Result<SyncInventory> {
        sync_inventory(self.0)
    }

    fn diff(&self, peer: &SyncInventory) -> Result<(Vec<Op>, Vec<String>)> {
        diff_against(self.0, peer)
    }

    fn ops_by_id(&self, ids: &[String]) -> Result<Vec<Op>> {
        ops_by_id(self.0, ids)
    }

    fn merge(&self, ops: Vec<Op>) -> Result<usize> {
        merge_and_rematerialize(self.0, ops)
    }
}

// ---------------------------------------------------------------------------
// Op-log reads
// ---------------------------------------------------------------------------

/// `sync_tombstones` holds ids of ops that a checkpoint permanently replaced.
/// They must never be re-accepted from a peer that still has the old history.
pub fn ensure_tombstones_table(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "create table if not exists sync_tombstones (id text primary key);
         create table if not exists sync_legacy_cleanup_guard (id text primary key);
         create table if not exists sync_frontiers (
           device_id text primary key,
           sequence integer not null
         );",
    )?;
    Ok(())
}

pub fn sync_frontiers(conn: &Connection) -> Result<std::collections::HashMap<String, i64>> {
    ensure_tombstones_table(conn)?;
    let mut stmt = conn.prepare("SELECT device_id, sequence FROM sync_frontiers")?;
    let frontiers = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?
        .collect::<std::result::Result<_, _>>()?;
    Ok(frontiers)
}

fn tombstone_ids(conn: &Connection) -> Result<HashSet<String>> {
    let mut stmt = conn.prepare("SELECT id FROM sync_tombstones")?;
    let ids = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<HashSet<_>, _>>()?;
    Ok(ids)
}

fn cleanup_guard_ids(conn: &Connection) -> Result<HashSet<String>> {
    let mut stmt = conn.prepare("SELECT id FROM sync_legacy_cleanup_guard")?;
    let ids = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<HashSet<_>, _>>()?;
    Ok(ids)
}

pub fn legacy_cleanup_guard_count(conn: &Connection) -> Result<usize> {
    ensure_tombstones_table(conn)?;
    Ok(conn.query_row(
        "SELECT count(*) FROM sync_legacy_cleanup_guard",
        [],
        |row| row.get(0),
    )?)
}

pub fn legacy_cleanup_is_staged(conn: &Connection) -> Result<bool> {
    ensure_tombstones_table(conn)?;
    let marker = conn
        .query_row(
            "SELECT value FROM metadata WHERE key = ?1",
            params![LEGACY_CLEANUP_STAGED],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    Ok(marker.as_deref() == Some("true"))
}

fn retired_ids(conn: &Connection) -> Result<HashSet<String>> {
    let mut ids = tombstone_ids(conn)?;
    ids.extend(cleanup_guard_ids(conn)?);
    Ok(ids)
}

fn row_to_op(row: &rusqlite::Row<'_>) -> rusqlite::Result<Op> {
    Ok(Op {
        id: row.get(0)?,
        device_id: row.get(1)?,
        sequence: row.get(2)?,
        op_type: row.get(3)?,
        timestamp: row.get(4)?,
        payload_json: row.get(5)?,
    })
}

const SELECT_OPS: &str = "SELECT id, device_id, sequence, type, timestamp, payload_json \
     FROM operations ORDER BY timestamp, device_id, sequence, id";

/// Ids of every op held locally (tombstoned ids can never be present, but the
/// filter keeps a hand-edited database from re-offering them).
pub fn local_op_ids(conn: &Connection) -> Result<Vec<String>> {
    ensure_tombstones_table(conn)?;
    let mut stmt = conn.prepare(
        "SELECT id FROM operations
         WHERE id NOT IN (SELECT id FROM sync_tombstones)
           AND id NOT IN (SELECT id FROM sync_legacy_cleanup_guard) \
         ORDER BY timestamp, device_id, sequence, id",
    )?;
    let ids = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(ids)
}

/// Every op held locally, in canonical order.
pub fn all_ops(conn: &Connection) -> Result<Vec<Op>> {
    ensure_tombstones_table(conn)?;
    let retired = retired_ids(conn)?;
    let mut stmt = conn.prepare(SELECT_OPS)?;
    let ops = stmt
        .query_map([], row_to_op)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(ops
        .into_iter()
        .filter(|op| !retired.contains(&op.id))
        .collect())
}

fn uses_legacy_entity_snapshot(value: &JsonValue) -> bool {
    match value {
        JsonValue::Object(object) => {
            object.contains_key("goalData")
                || object.contains_key("listsMetricsData")
                || object
                    .get("type")
                    .and_then(JsonValue::as_str)
                    .is_some_and(|kind| {
                        kind == "replace_goal_data" || kind == "replace_lists_metrics_data"
                    })
                || object.values().any(uses_legacy_entity_snapshot)
        }
        JsonValue::Array(values) => values.iter().any(uses_legacy_entity_snapshot),
        _ => false,
    }
}

fn checkpoint_requires_legacy_compatibility(op: &Op, payload: &JsonValue) -> bool {
    if op.op_type != "replace_full_state" {
        return false;
    }
    let current_generation = payload
        .get("generation")
        .and_then(JsonValue::as_i64)
        .is_some_and(|generation| generation >= 1);
    let has_frontiers = payload.get("frontiers").is_some_and(JsonValue::is_object);
    let has_v2_replaces = payload.get("replaces").is_some();
    let has_legacy_ids = match payload.get("legacyReplaces") {
        None => false,
        Some(JsonValue::Array(ids)) => !ids.is_empty(),
        Some(_) => true,
    };
    !current_generation || !has_frontiers || has_v2_replaces || has_legacy_ids
}

pub(crate) fn audit_operations_for_legacy_compatibility(
    operations: &[Op],
) -> Result<LegacyOperationAudit> {
    let mut audit = LegacyOperationAudit {
        records_checked: operations.len(),
        ..Default::default()
    };
    for operation in operations {
        let payload: JsonValue = serde_json::from_str(&operation.payload_json)
            .map_err(|error| Error::Codec(format!("invalid operation payload: {error}")))?;
        if checkpoint_requires_legacy_compatibility(operation, &payload) {
            audit.legacy_checkpoint_records += 1;
        }
        if uses_legacy_entity_snapshot(&payload) {
            audit.legacy_entity_snapshot_records += 1;
        }
    }
    Ok(audit)
}

pub fn audit_local_legacy_compatibility(conn: &Connection) -> Result<LocalLegacyAudit> {
    let mut operation_statement = conn.prepare(SELECT_OPS)?;
    let operations = operation_statement
        .query_map([], row_to_op)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let operation_audit = audit_operations_for_legacy_compatibility(&operations)?;
    let mut history_statement = conn.prepare(
        "SELECT undo_operation_json, redo_operation_json FROM history_entries ORDER BY id",
    )?;
    let histories = history_statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut legacy_history_entries = 0;
    for (undo, redo) in &histories {
        let undo: JsonValue = serde_json::from_str(undo)
            .map_err(|error| Error::Codec(format!("invalid undo history payload: {error}")))?;
        let redo: JsonValue = serde_json::from_str(redo)
            .map_err(|error| Error::Codec(format!("invalid redo history payload: {error}")))?;
        if uses_legacy_entity_snapshot(&undo) || uses_legacy_entity_snapshot(&redo) {
            legacy_history_entries += 1;
        }
    }
    let tombstone_count = conn.query_row("SELECT count(*) FROM sync_tombstones", [], |row| {
        row.get::<_, usize>(0)
    })?;
    let cleanup_guard_count = legacy_cleanup_guard_count(conn)?;
    Ok(LocalLegacyAudit {
        operations: operation_audit,
        history_entries_checked: histories.len(),
        legacy_history_entries,
        tombstone_count,
        cleanup_guard_count,
        cleanup_staged: legacy_cleanup_is_staged(conn)?,
    })
}

/// Stage this installation for removal of legacy sync compatibility without
/// weakening its rejection of operations retired by an older checkpoint.
/// The legacy ids move into a temporary guard table while checkpoint payloads
/// become current-format. Relay promotion remains blocked until every active
/// installation has completed this same step.
pub fn stage_legacy_cleanup(conn: &Connection) -> Result<LegacyCleanupStageResult> {
    ensure_tombstones_table(conn)?;
    let state_before = crate::read_app_state_from_database(conn)
        .map_err(Error::Codec)?
        .ok_or_else(|| Error::Codec("database has no app state to verify".into()))?;
    let history_before = {
        let mut statement = conn.prepare(
            "SELECT id, operation_id, device_id, sequence, undo_operation_json,
                    redo_operation_json, undone, created_at_ms, updated_at_ms
             FROM history_entries ORDER BY id",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, i64>(8)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    };
    let operations = all_ops(conn)?;
    let operation_audit = audit_operations_for_legacy_compatibility(&operations)?;
    if operation_audit.legacy_entity_snapshot_records != 0 {
        return Err(Error::Codec(
            "legacy entity snapshots must be compacted before cleanup".into(),
        ));
    }

    let mut checkpoint_updates = Vec::new();
    let mut guarded = tombstone_ids(conn)?;
    for operation in operations
        .iter()
        .filter(|operation| operation.op_type == "replace_full_state")
    {
        let mut payload: JsonValue = serde_json::from_str(&operation.payload_json)
            .map_err(|error| Error::Codec(format!("invalid checkpoint payload: {error}")))?;
        if payload
            .get("generation")
            .and_then(JsonValue::as_i64)
            .is_none_or(|generation| generation < 1)
            || !payload.get("frontiers").is_some_and(JsonValue::is_object)
            || payload.get("replaces").is_some()
        {
            return Err(Error::Codec(
                "a pre-frontier checkpoint must be migrated by normal sync before cleanup".into(),
            ));
        }
        guarded.extend(replaced_ids(operation));
        let object = payload
            .as_object_mut()
            .ok_or_else(|| Error::Codec("checkpoint payload is not an object".into()))?;
        object.remove("legacyReplaces");
        checkpoint_updates.push((operation.id.clone(), payload.to_string()));
    }
    if checkpoint_updates.is_empty() {
        return Err(Error::Codec(
            "no current checkpoint is available to clean".into(),
        ));
    }

    let tx = conn.unchecked_transaction()?;
    {
        let mut insert_guard =
            tx.prepare("INSERT OR IGNORE INTO sync_legacy_cleanup_guard (id) VALUES (?1)")?;
        for id in &guarded {
            insert_guard.execute(params![id])?;
        }
        let mut update_checkpoint =
            tx.prepare("UPDATE operations SET payload_json = ?2 WHERE id = ?1")?;
        for (id, payload) in &checkpoint_updates {
            if update_checkpoint.execute(params![id, payload])? != 1 {
                return Err(Error::Codec(
                    "checkpoint changed while cleanup was being staged".into(),
                ));
            }
        }
    }
    tx.execute("DELETE FROM sync_tombstones", [])?;
    tx.execute(
        "INSERT INTO metadata (key, value) VALUES (?1, 'true')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![LEGACY_CLEANUP_STAGED],
    )?;

    let state_after = crate::read_app_state_from_database(&tx)
        .map_err(Error::Codec)?
        .ok_or_else(|| Error::Codec("cleanup verification found no app state".into()))?;
    if state_after != state_before {
        return Err(Error::Codec(
            "cleanup changed application state; every change was rolled back".into(),
        ));
    }
    let history_after = {
        let mut statement = tx.prepare(
            "SELECT id, operation_id, device_id, sequence, undo_operation_json,
                    redo_operation_json, undone, created_at_ms, updated_at_ms
             FROM history_entries ORDER BY id",
        )?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, i64>(8)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    };
    if history_after != history_before {
        return Err(Error::Codec(
            "cleanup changed undo history; every change was rolled back".into(),
        ));
    }
    tx.commit()?;
    Ok(LegacyCleanupStageResult {
        guarded_ids: guarded.len(),
        checkpoint_records_cleaned: checkpoint_updates.len(),
    })
}

/// Replace the staged local log with one verified current-format checkpoint.
/// The temporary guard intentionally remains in force until every installation
/// has staged and the relay rollback generation has expired.
pub(crate) fn prepare_staged_cleanup_checkpoint(conn: &Connection) -> Result<CheckpointStats> {
    if !legacy_cleanup_is_staged(conn)? || legacy_cleanup_guard_count(conn)? == 0 {
        return Err(Error::Codec(
            "this installation has not staged legacy cleanup".into(),
        ));
    }
    let state = crate::read_app_state_from_database(conn)
        .map_err(Error::Codec)?
        .ok_or_else(|| Error::Codec("database has no app state to checkpoint".into()))?;
    let mut snapshot = snapshot_state_op(conn, &state)?;
    let payload = snapshot
        .get_mut("payload")
        .and_then(JsonValue::as_object_mut)
        .ok_or_else(|| Error::Codec("generated checkpoint payload is invalid".into()))?;
    let uncovered = payload
        .get("legacyReplaces")
        .and_then(JsonValue::as_array)
        .map_or(0, Vec::len);
    if uncovered != 0 {
        return Err(Error::Codec(format!(
            "{uncovered} live operation(s) are not covered by current frontiers; sync again before relay cleanup"
        )));
    }
    payload.remove("legacyReplaces");
    install_checkpoint_with_history_policy(conn, &state, &snapshot, false)
}

pub fn sync_inventory(conn: &Connection) -> Result<SyncInventory> {
    Ok(SyncInventory {
        items: all_ops(conn)?
            .into_iter()
            .map(|op| InventoryItem {
                id: op.id,
                device_id: op.device_id,
                sequence: op.sequence,
                checkpoint: op.op_type == "replace_full_state",
            })
            .collect(),
        frontiers: sync_frontiers(conn)?,
    })
}

/// Full rows for `ids`; unknown ids are skipped.
pub fn ops_by_id(conn: &Connection, ids: &[String]) -> Result<Vec<Op>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let wanted: HashSet<&str> = ids.iter().map(String::as_str).collect();
    let mut stmt = conn.prepare(SELECT_OPS)?;
    let ops = stmt
        .query_map([], row_to_op)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(ops
        .into_iter()
        .filter(|op| wanted.contains(op.id.as_str()))
        .collect())
}

/// The responder's half of reconciliation: what the peer is missing, and what
/// this device wants back. Tombstoned ids are never wanted — they were
/// deliberately compacted away.
pub fn diff_against(conn: &Connection, peer: &SyncInventory) -> Result<(Vec<Op>, Vec<String>)> {
    ensure_tombstones_table(conn)?;
    let tombstones = tombstone_ids(conn)?;
    let mine = local_op_ids(conn)?;
    let mine_set: HashSet<&str> = mine.iter().map(String::as_str).collect();
    let peer_set: HashSet<&str> = peer.items.iter().map(|item| item.id.as_str()).collect();
    let local_frontiers = sync_frontiers(conn)?;

    let want = peer
        .items
        .iter()
        .filter(|item| {
            !mine_set.contains(item.id.as_str())
                && !tombstones.contains(&item.id)
                && (item.checkpoint
                    || !local_frontiers
                        .get(&item.device_id)
                        .is_some_and(|covered| item.sequence <= *covered))
        })
        .map(|item| item.id.clone())
        .collect::<Vec<_>>();

    let ops = all_ops(conn)?
        .into_iter()
        .filter(|op| {
            !peer_set.contains(op.id.as_str())
                && (op.op_type == "replace_full_state"
                    || !peer
                        .frontiers
                        .get(&op.device_id)
                        .is_some_and(|covered| op.sequence <= *covered))
        })
        .collect::<Vec<_>>();

    Ok((ops, want))
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/// Ids a `replace_full_state` checkpoint declares it permanently replaced.
fn replaced_ids(op: &Op) -> Vec<String> {
    if op.op_type != "replace_full_state" {
        return Vec::new();
    }
    let Ok(payload) = serde_json::from_str::<JsonValue>(&op.payload_json) else {
        return Vec::new();
    };
    payload
        .get("legacyReplaces")
        .or_else(|| payload.get("replaces"))
        .and_then(JsonValue::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(JsonValue::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn checkpoint_frontiers(op: &Op) -> std::collections::HashMap<String, i64> {
    if op.op_type != "replace_full_state" {
        return Default::default();
    }
    serde_json::from_str::<JsonValue>(&op.payload_json)
        .ok()
        .and_then(|payload| payload.get("frontiers").cloned())
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default()
}

fn checkpoint_generation(op: &Op) -> i64 {
    if op.op_type != "replace_full_state" {
        return -1;
    }
    serde_json::from_str::<JsonValue>(&op.payload_json)
        .ok()
        .and_then(|payload| payload.get("generation").and_then(JsonValue::as_i64))
        .unwrap_or(0)
}

fn current_checkpoint(conn: &Connection) -> Result<Option<(i64, String)>> {
    let mut stmt = conn.prepare(
        "SELECT id, payload_json FROM operations WHERE type = 'replace_full_state' ORDER BY id",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows
        .into_iter()
        .map(|(id, payload)| {
            let generation = serde_json::from_str::<JsonValue>(&payload)
                .ok()
                .and_then(|value| value.get("generation").and_then(JsonValue::as_i64))
                .unwrap_or(0);
            (generation, id)
        })
        .max())
}

/// Insert every op this device does not already have (and has not tombstoned),
/// honouring checkpoint frontiers and legacy `replaces` lists in one transaction.
/// Returns how many ops were inserted; the caller rematerializes iff `> 0`.
pub fn merge_ops(conn: &Connection, ops: &[Op]) -> Result<usize> {
    ensure_tombstones_table(conn)?;
    let tx = conn.unchecked_transaction()?;
    let inserted = merge_ops_uncommitted(&tx, ops)?;
    tx.commit()?;
    Ok(inserted.len())
}

fn merge_ops_uncommitted(conn: &Connection, ops: &[Op]) -> Result<Vec<Op>> {
    let mut inserted = Vec::new();
    {
        let mut existing: HashSet<String> = {
            let mut stmt = conn.prepare("SELECT id FROM operations")?;
            let ids = stmt
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<std::result::Result<_, _>>()?;
            ids
        };
        let tombstones = retired_ids(conn)?;
        let mut frontiers: std::collections::HashMap<String, i64> = {
            let mut stmt = conn.prepare("SELECT device_id, sequence FROM sync_frontiers")?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                })?
                .collect::<std::result::Result<_, _>>()?;
            rows
        };
        let active_checkpoint = current_checkpoint(conn)?;

        let mut insert = conn.prepare(
            "INSERT INTO operations (id, device_id, sequence, type, timestamp, payload_json) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )?;
        let mut delete_replaced = conn.prepare("DELETE FROM operations WHERE id = ?1")?;
        let mut delete_replaced_history =
            conn.prepare("DELETE FROM history_entries WHERE operation_id = ?1")?;
        let mut delete_frontier_history =
            conn.prepare("DELETE FROM history_entries WHERE device_id = ?1 AND sequence <= ?2")?;
        let mut tombstone =
            conn.prepare("INSERT OR IGNORE INTO sync_tombstones (id) VALUES (?1)")?;
        let mut upsert_frontier = conn.prepare(
            "INSERT INTO sync_frontiers (device_id, sequence) VALUES (?1, ?2)
             ON CONFLICT(device_id) DO UPDATE SET sequence = max(sequence, excluded.sequence)",
        )?;

        // Select exactly one checkpoint before considering ordinary ops. This
        // prevents a losing checkpoint in the same batch from contributing a
        // frontier and makes the result independent of wire order.
        let incoming_checkpoint = ops
            .iter()
            .filter(|op| {
                op.op_type == "replace_full_state"
                    && !existing.contains(&op.id)
                    && !tombstones.contains(&op.id)
            })
            .max_by_key(|op| (checkpoint_generation(op), op.id.clone()))
            .filter(|op| {
                let candidate = (checkpoint_generation(op), op.id.clone());
                active_checkpoint
                    .as_ref()
                    .map_or(true, |current| candidate > *current)
            });

        if let Some(checkpoint) = incoming_checkpoint {
            conn.execute(
                "DELETE FROM operations WHERE type = 'replace_full_state'",
                [],
            )?;
            insert.execute(params![
                checkpoint.id,
                checkpoint.device_id,
                checkpoint.sequence,
                checkpoint.op_type,
                checkpoint.timestamp,
                checkpoint.payload_json,
            ])?;
            existing.insert(checkpoint.id.clone());
            inserted.push(checkpoint.clone());

            for replaced in replaced_ids(checkpoint) {
                if replaced != checkpoint.id {
                    delete_replaced.execute(params![replaced])?;
                    delete_replaced_history.execute(params![replaced])?;
                    tombstone.execute(params![replaced])?;
                }
            }
            for (device_id, sequence) in checkpoint_frontiers(checkpoint) {
                upsert_frontier.execute(params![device_id, sequence])?;
                frontiers
                    .entry(device_id)
                    .and_modify(|current| *current = (*current).max(sequence))
                    .or_insert(sequence);
            }
        }

        for op in ops.iter().filter(|op| op.op_type != "replace_full_state") {
            if existing.contains(&op.id) || tombstones.contains(&op.id) {
                continue;
            }
            if frontiers
                .get(&op.device_id)
                .is_some_and(|covered| op.sequence <= *covered)
            {
                continue;
            }
            insert.execute(params![
                op.id,
                op.device_id,
                op.sequence,
                op.op_type,
                op.timestamp,
                op.payload_json,
            ])?;
            existing.insert(op.id.clone());
            inserted.push(op.clone());
        }
        for (device_id, sequence) in &frontiers {
            // Undo/recovery rows are device-local, but they can otherwise
            // survive forever after their replicated operations have been
            // replaced. Persisted frontiers prove these sequences are already
            // represented by an accepted full-state baseline. Consulting the
            // merged frontiers also heals history left by older app versions.
            delete_frontier_history.execute(params![device_id, sequence])?;
            conn.execute(
                "DELETE FROM operations WHERE type != 'replace_full_state' AND device_id = ?1 AND sequence <= ?2",
                params![device_id, sequence],
            )?;
        }
    }
    Ok(inserted)
}

/// [`merge_ops`] plus the state rebuild every caller needs when anything landed.
pub fn merge_and_rematerialize(conn: &Connection, ops: Vec<Op>) -> Result<usize> {
    ensure_tombstones_table(conn)?;
    let tx = conn.unchecked_transaction()?;
    let last_existing = last_operation_canonical(&tx)?;
    let mut inserted = merge_ops_uncommitted(&tx, &ops)?;
    let inserted_count = inserted.len();
    if inserted_count > 0
        && inserted.iter().all(|op| op.op_type != "replace_full_state")
        && last_existing.as_ref().map_or(true, |last| {
            inserted
                .iter()
                .all(|op| compare_canonical(op, last) == Ordering::Greater)
        })
    {
        // Ordinary operations created after everything already materialized can
        // be applied directly in canonical order. Rebuilding a large checkpoint
        // for every tiny relay batch made two remote task edits repeatedly erase
        // and reinsert the entire workspace. Checkpoints and out-of-order history
        // still take the full replay path below.
        inserted.sort_by(compare_canonical);
        for op in &inserted {
            let operation = op_value(op)?;
            crate::apply_operation(&tx, &operation).map_err(|error| {
                Error::Codec(format!(
                    "could not apply appended synced operation {} ({}, {}): {error}",
                    op.sequence, op.op_type, op.id
                ))
            })?;
        }
    } else if inserted_count > 0 {
        rematerialize_uncommitted(&tx)?;
    }
    tx.commit()?;
    Ok(inserted_count)
}

fn compare_canonical(left: &Op, right: &Op) -> Ordering {
    left.timestamp
        .cmp(&right.timestamp)
        .then_with(|| left.device_id.cmp(&right.device_id))
        .then_with(|| left.sequence.cmp(&right.sequence))
        .then_with(|| left.id.cmp(&right.id))
}

fn last_operation_canonical(conn: &Connection) -> Result<Option<Op>> {
    conn.query_row(
        "SELECT id, device_id, sequence, type, timestamp, payload_json
         FROM operations
         ORDER BY timestamp DESC, device_id DESC, sequence DESC, id DESC
         LIMIT 1",
        [],
        row_to_op,
    )
    .optional()
    .map_err(Error::from)
}

fn escape(identifier: &str) -> String {
    identifier.replace('"', "\"\"")
}

// ---------------------------------------------------------------------------
// Enable / pairing metadata
// ---------------------------------------------------------------------------

/// Whether sync has been enabled on this database.
pub fn is_sync_enabled(conn: &Connection) -> Result<bool> {
    let enabled: Option<String> = conn
        .query_row(
            "SELECT value FROM metadata WHERE key = 'sync_enabled'",
            [],
            |r| r.get(0),
        )
        .ok();
    Ok(enabled.as_deref() == Some("true"))
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
/// P2P listener can decrypt incoming frames without UI involvement.
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

/// Enable sync on the device that holds the canonical data ("Create sync key").
/// Snapshot the current state into a single baseline op and reset the log to
/// just that snapshot. The real data tables are not touched.
pub fn enable_primary(conn: &Connection) -> Result<()> {
    ensure_tombstones_table(conn)?;
    // A fresh pairing starts a fresh replication history: nothing from before is
    // reachable, so old tombstones would only bloat future checkpoints.
    conn.execute("DELETE FROM sync_tombstones", [])?;
    conn.execute("DELETE FROM sync_legacy_cleanup_guard", [])?;
    conn.execute(
        "DELETE FROM metadata WHERE key = ?1",
        params![LEGACY_CLEANUP_STAGED],
    )?;
    conn.execute("DELETE FROM sync_frontiers", [])?;
    checkpoint_operation_log_preserving_history(conn)?;
    mark_enabled(conn)?;
    Ok(())
}

/// Enable sync on a device that will adopt another's data ("Pair with another
/// device"). Clear local domain state and the op log (the caller takes a backup
/// first), then wait to receive the primary's baseline via sync + merge.
pub fn enable_joiner(conn: &Connection) -> Result<()> {
    ensure_tombstones_table(conn)?;
    {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(
            "DELETE FROM operations; DELETE FROM history_entries;
             DELETE FROM sync_tombstones;
             DELETE FROM sync_legacy_cleanup_guard;
             DELETE FROM sync_frontiers;
             DELETE FROM plan_items; DELETE FROM plans;
             DELETE FROM template_options; DELETE FROM template_items; DELETE FROM templates;
             DELETE FROM state_entities;
             DELETE FROM metadata WHERE key IN ('goal_data','lists_metrics_data');",
        )?;
        tx.execute(
            "DELETE FROM metadata WHERE key = ?1",
            params![LEGACY_CLEANUP_STAGED],
        )?;
        tx.commit()?;
    }
    mark_enabled(conn)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Checkpoints (threshold-driven, coordinator device only)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CheckpointStats {
    pub operations_removed: i64,
    pub history_entries_removed: i64,
}

fn random_id() -> String {
    let mut b = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut b);
    hex(&b)
}

/// Build a `replace_full_state` baseline op from an already-read state,
/// timestamped so it always sorts first in a canonical replay.
///
/// Version frontiers compact the known log in O(device-count) metadata. The
/// frozen legacy id set exists only to migrate v2 tombstones and never grows.
fn snapshot_state_op(conn: &Connection, state: &JsonValue) -> Result<JsonValue> {
    let device_id = crate::metadata_value(conn, "device_id")
        .map_err(Error::Codec)?
        .unwrap_or_default();
    ensure_tombstones_table(conn)?;
    let mut frontiers = sync_frontiers(conn)?;
    let current_ops = all_ops(conn)?;
    let legacy_checkpoint = current_ops
        .iter()
        .find(|op| op.op_type == "replace_full_state")
        .is_some_and(|op| checkpoint_generation(&op) == 0 && checkpoint_frontiers(&op).is_empty());
    let mut sequences_by_device: HashMap<String, Vec<i64>> = HashMap::new();
    for op in current_ops
        .iter()
        .filter(|op| op.op_type != "replace_full_state")
    {
        sequences_by_device
            .entry(op.device_id.clone())
            .or_default()
            .push(op.sequence);
    }
    for values in sequences_by_device.values_mut() {
        values.sort_unstable();
    }
    for (device_id, values) in sequences_by_device {
        let Some(first) = values.first().copied() else {
            continue;
        };
        let prior = frontiers.get(&device_id).copied();
        // V2 checkpoints had no frontier but did have complete state. On the
        // first v3 checkpoint, the first retained post-checkpoint sequence is
        // therefore a safe starting point even when its numeric value is high.
        let mut contiguous = prior.unwrap_or_else(|| {
            if legacy_checkpoint {
                first.saturating_sub(1)
            } else if first == 0 {
                -1
            } else {
                0
            }
        });
        for sequence in values {
            if sequence <= contiguous {
                continue;
            }
            if sequence != contiguous + 1 {
                break;
            }
            contiguous = sequence;
        }
        if prior.is_some() || contiguous >= first {
            frontiers.insert(device_id, contiguous);
        }
    }
    let mut legacy_replaces = tombstone_ids(conn)?.into_iter().collect::<Vec<_>>();
    legacy_replaces.extend(
        current_ops
            .iter()
            .filter(|op| {
                op.op_type != "replace_full_state"
                    && !frontiers
                        .get(&op.device_id)
                        .is_some_and(|covered| op.sequence <= *covered)
            })
            .map(|op| op.id.clone()),
    );
    legacy_replaces.sort();
    legacy_replaces.dedup();
    let generation = current_checkpoint(conn)?
        .map(|value| value.0 + 1)
        .unwrap_or(1);
    Ok(json!({
        "id": random_id(),
        "deviceId": device_id,
        "sequence": 0,
        // Sorts before any real ISO-8601 timestamp, so it's the replay baseline.
        "timestamp": "0000-00-00T00:00:00.000Z",
        "type": "replace_full_state",
        // `apply_operation` reads only `payload.state`; frontier metadata is
        // inert during replay and consulted only by reconciliation.
        "payload": {
            "state": state.clone(),
            "generation": generation,
            "frontiers": frontiers,
            "legacyReplaces": legacy_replaces
        },
    }))
}

/// Replace the operation log with one full-state checkpoint and prove, inside
/// the same transaction, that replaying only that checkpoint reconstructs the
/// exact app state that existed before compaction. Any mismatch rolls back the
/// log, history, tombstones, and materialized tables together.
fn install_checkpoint(
    conn: &Connection,
    expected_state: &JsonValue,
    snapshot: &JsonValue,
) -> Result<CheckpointStats> {
    install_checkpoint_with_history_policy(conn, expected_state, snapshot, true)
}

fn install_checkpoint_with_history_policy(
    conn: &Connection,
    expected_state: &JsonValue,
    snapshot: &JsonValue,
    clear_history: bool,
) -> Result<CheckpointStats> {
    ensure_tombstones_table(conn)?;
    let operation_count: i64 =
        conn.query_row("SELECT count(*) FROM operations", [], |row| row.get(0))?;
    let history_count: i64 =
        conn.query_row("SELECT count(*) FROM history_entries", [], |row| row.get(0))?;
    let snapshot_id = snapshot
        .get("id")
        .and_then(JsonValue::as_str)
        .unwrap_or_default()
        .to_string();
    let replaces = snapshot
        .get("payload")
        .and_then(|payload| {
            payload
                .get("legacyReplaces")
                .or_else(|| payload.get("replaces"))
        })
        .and_then(JsonValue::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(JsonValue::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let frontiers: std::collections::HashMap<String, i64> = snapshot
        .get("payload")
        .and_then(|payload| payload.get("frontiers"))
        .cloned()
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default();

    let tx = conn.unchecked_transaction()?;
    if clear_history {
        tx.execute("DELETE FROM history_entries", [])?;
    }
    tx.execute("DELETE FROM operations", [])?;
    crate::upsert_operation(&tx, snapshot).map_err(Error::Codec)?;
    crate::apply_operation(&tx, snapshot).map_err(Error::Codec)?;
    {
        let mut tombstone = tx.prepare("INSERT OR IGNORE INTO sync_tombstones (id) VALUES (?1)")?;
        for id in &replaces {
            if *id == snapshot_id {
                continue;
            }
            tombstone.execute(params![id])?;
        }
        let mut upsert = tx.prepare(
            "INSERT INTO sync_frontiers (device_id, sequence) VALUES (?1, ?2)
             ON CONFLICT(device_id) DO UPDATE SET sequence = max(sequence, excluded.sequence)",
        )?;
        for (device_id, sequence) in frontiers {
            upsert.execute(params![device_id, sequence])?;
        }
    }

    let replayed_state = crate::read_app_state_from_database(&tx)
        .map_err(Error::Codec)?
        .ok_or_else(|| Error::Codec("checkpoint replay produced no app state".into()))?;
    if replayed_state != *expected_state {
        return Err(Error::Codec(
            "checkpoint replay did not exactly reproduce the current app state".into(),
        ));
    }

    tx.commit()?;
    Ok(CheckpointStats {
        operations_removed: operation_count.saturating_sub(1),
        history_entries_removed: if clear_history { history_count } else { 0 },
    })
}

/// Collapse all replay history into one verified `replace_full_state` baseline.
pub fn checkpoint_operation_log(conn: &Connection) -> Result<CheckpointStats> {
    let state = crate::read_app_state_from_database(conn)
        .map_err(Error::Codec)?
        .ok_or_else(|| Error::Codec("database has no app state to checkpoint".into()))?;
    let snapshot = snapshot_state_op(conn, &state)?;
    install_checkpoint(conn, &state, &snapshot)
}

/// Compact replicated operations for a relay generation without silently
/// discarding the user's local undo/recovery history. Physical database
/// maintenance is intentionally independent from this logical compaction.
pub(crate) fn checkpoint_operation_log_preserving_history(
    conn: &Connection,
) -> Result<CheckpointStats> {
    let state = crate::read_app_state_from_database(conn)
        .map_err(Error::Codec)?
        .ok_or_else(|| Error::Codec("database has no app state to checkpoint".into()))?;
    let snapshot = snapshot_state_op(conn, &state)?;
    install_checkpoint_with_history_policy(conn, &state, &snapshot, false)
}

// ---------------------------------------------------------------------------
// Rematerialization
// ---------------------------------------------------------------------------

/// Reconstruct the op `Value`s from the `operations` rows in canonical order
/// (timestamp, device_id, sequence) — the deterministic total order every device
/// agrees on.
fn read_operations_canonical(conn: &Connection) -> Result<Vec<JsonValue>> {
    let mut stmt = conn.prepare(
        "SELECT id, device_id, sequence, type, timestamp, payload_json FROM operations \
         ORDER BY timestamp, device_id, sequence, id",
    )?;
    let rows = stmt
        .query_map([], row_to_op)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let mut ops = Vec::with_capacity(rows.len());
    for op in rows {
        ops.push(op_value(&op)?);
    }
    Ok(ops)
}

fn op_value(op: &Op) -> Result<JsonValue> {
    let payload: JsonValue =
        serde_json::from_str(&op.payload_json).map_err(|e| Error::Codec(e.to_string()))?;
    Ok(json!({
        "id": op.id,
        "deviceId": op.device_id,
        "sequence": op.sequence,
        "type": op.op_type,
        "timestamp": op.timestamp,
        "payload": payload,
    }))
}

/// Rebuild the materialized domain tables by replaying every operation in
/// canonical order through the app's existing `apply_operation`. Called after a
/// sync merge so all devices converge to identical state.
pub fn rematerialize(conn: &Connection) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    rematerialize_uncommitted(&tx)?;
    tx.commit()?;
    Ok(())
}

fn rematerialize_uncommitted(tx: &rusqlite::Transaction<'_>) -> Result<()> {
    let ops = read_operations_canonical(tx)?;
    tx.execute_batch(
        "DELETE FROM plan_items; DELETE FROM plans;
         DELETE FROM template_options; DELETE FROM template_items; DELETE FROM templates;
         DELETE FROM state_entities;",
    )?;
    for (index, op) in ops.iter().enumerate() {
        crate::apply_operation(tx, op).map_err(|error| {
            let id = op
                .get("id")
                .and_then(JsonValue::as_str)
                .unwrap_or("unknown");
            let ty = op
                .get("type")
                .and_then(JsonValue::as_str)
                .unwrap_or("unknown");
            Error::Codec(format!(
                "could not replay synced operation {} ({ty}, {id}): {error}",
                index + 1
            ))
        })?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Convergence hashing (test/diagnostic helper)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Self-test (also runs on-device in the Android debug APK)
// ---------------------------------------------------------------------------

/// Exercise the real app sync path against two throwaway encrypted Balance
/// databases. This is intentionally broader than an engine smoke test: it uses
/// the production schema and materializer, creates and parses the pairing code,
/// enables a primary and joiner, persists the key on both sides, exchanges the
/// encrypted operation log over a real TCP socket, and verifies that user data
/// appears on the joining device. CI runs this inside the Android APK so
/// SQLCipher, pairing, transport, and the bootstrap path are covered together.
/// Cleans up after itself.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSelftestProfile {
    fixture_plans: usize,
    fixture_plan_items: usize,
    seed_and_checkpoint_ms: u128,
    bootstrap_ms: u128,
    long_task_persist_ms: u128,
    long_task_incremental_sync_ms: u128,
}

pub fn selftest(scratch_dir: &Path) -> Result<SyncSelftestProfile> {
    // The self-test may run before the main database has created this directory.
    std::fs::create_dir_all(scratch_dir).map_err(|e| Error::Codec(e.to_string()))?;
    let run_id = random_id();
    let a_path = scratch_dir.join(format!("balance-sync-selftest-{run_id}-a.sqlite3"));
    let b_path = scratch_dir.join(format!("balance-sync-selftest-{run_id}-b.sqlite3"));
    let _ = std::fs::remove_file(&a_path);
    let _ = std::fs::remove_file(&b_path);

    let result = (|| -> Result<SyncSelftestProfile> {
        const FIXTURE_PLANS: usize = 365;
        const ITEMS_PER_PLAN: usize = 20;
        let fixture_plan_items = FIXTURE_PLANS * ITEMS_PER_PLAN;
        let plans = (0..FIXTURE_PLANS)
            .map(|plan_index| {
                let items = (0..ITEMS_PER_PLAN)
                    .map(|item_index| {
                        json!({
                            "id": format!("fixture-item-{plan_index}-{item_index}"),
                            "text": format!("Synthetic existing task {plan_index}-{item_index}"),
                            "html": format!("Synthetic existing task {plan_index}-{item_index}"),
                            "done": item_index % 3 == 0,
                            "startMinutes": JsonValue::Null,
                            "endMinutes": JsonValue::Null,
                            "children": [],
                        })
            })
            .collect::<Vec<_>>();
                let year = 2025 + plan_index / (12 * 28);
                let day_of_year = plan_index % (12 * 28);
                json!({
                    "id": format!("fixture-plan-{plan_index}"),
                    "date": format!("{year}-{:02}-{:02}", day_of_year / 28 + 1, day_of_year % 28 + 1),
                    "title": format!("Synthetic day {plan_index}"),
                    "dailyReminder": "Synthetic fixture",
                    "createdAt": "2025-01-01T00:00:00.000Z",
                    "items": items,
                })
            })
            .collect::<Vec<_>>();
        let target_plan_id = "fixture-plan-0";
        let app_state = |device_id: &str, goals: JsonValue, plans: JsonValue| {
            json!({
                "schemaVersion": 1,
                "deviceId": device_id,
                "localSequence": 0,
                "historyRevision": 0,
                "activePlanDate": "2026-07-14",
                "templates": [],
                "plans": plans,
                "goals": goals,
                "goalCompletions": [],
                "listTemplates": [],
                "lists": [],
                "metrics": [],
                "metricEntries": [],
                "notes": [],
                "operations": [],
            })
        };

        let seed_started = std::time::Instant::now();
        let primary_recovery_key = crate::generate_recovery_key();
        let joiner_recovery_key = crate::generate_recovery_key();
        let mut primary =
            crate::open_database_at(&a_path, &primary_recovery_key).map_err(Error::Codec)?;
        let mut joiner =
            crate::open_database_at(&b_path, &joiner_recovery_key).map_err(Error::Codec)?;
        crate::replace_app_state(
            &mut primary,
            &app_state(
                "selftest-primary",
                json!([{ "id": "ci-sync-goal", "name": "Android E2E sync reached the joiner" }]),
                JsonValue::Array(plans),
            ),
        )
        .map_err(Error::Codec)?;
        crate::replace_app_state(
            &mut joiner,
            &app_state(
                "selftest-joiner",
                json!([{ "id": "joiner-only", "name": "Must be replaced" }]),
                json!([]),
            ),
        )
        .map_err(Error::Codec)?;

        let generated_key = crypto::SyncKey::generate();
        let pairing_code = generated_key.to_pairing_code();
        let primary_sync_key = crypto::SyncKey::from_pairing_code(&pairing_code)?;
        let joiner_sync_key = crypto::SyncKey::from_pairing_code(&pairing_code)?;
        if primary_sync_key.as_bytes() != joiner_sync_key.as_bytes() {
            return Err(Error::Crypto("pairing code produced different keys".into()));
        }

        enable_primary(&primary)?;
        store_pairing_code(&primary, &pairing_code)?;
        enable_joiner(&joiner)?;
        store_pairing_code(&joiner, &pairing_code)?;
        let seed_and_checkpoint_ms = seed_started.elapsed().as_millis();

        let cleared = crate::read_app_state_from_database(&joiner)
            .map_err(Error::Codec)?
            .ok_or_else(|| Error::Codec("joiner state missing after pairing".into()))?;
        if cleared["goals"] != json!([]) {
            return Err(Error::Codec(
                "joiner was not cleared before bootstrap".into(),
            ));
        }

        // Mirror the app's manual-address flow: the primary listens and the
        // joining device initiates a bidirectional, E2EE P2P sync.
        let bootstrap_started = std::time::Instant::now();
        let listener =
            std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| Error::Codec(e.to_string()))?;
        let address = listener
            .local_addr()
            .map_err(|e| Error::Codec(e.to_string()))?
            .to_string();
        let primary_thread = std::thread::spawn(move || -> Result<()> {
            transport::sync_accept(&listener, &primary_sync_key, &ConnectionStore(&primary))
        });

        transport::sync_connect(&address, &joiner_sync_key, &ConnectionStore(&joiner))?;
        primary_thread
            .join()
            .map_err(|_| Error::Codec("primary sync thread panicked".into()))??;
        let bootstrap_ms = bootstrap_started.elapsed().as_millis();

        let joined_state = crate::read_app_state_from_database(&joiner)
            .map_err(Error::Codec)?
            .ok_or_else(|| Error::Codec("joiner state missing after sync".into()))?;
        if joined_state["goals"]
            != json!([{ "id": "ci-sync-goal", "name": "Android E2E sync reached the joiner" }])
        {
            return Err(Error::Codec(
                "paired joiner did not receive the primary's user data".into(),
            ));
        }
        if joined_state["deviceId"] != "selftest-joiner" {
            return Err(Error::Codec(
                "sync overwrote the joiner's device identity".into(),
            ));
        }
        if read_pairing_code(&joiner)?.as_deref() != Some(pairing_code.as_str()) {
            return Err(Error::Crypto(
                "joiner did not persist its pairing key".into(),
            ));
        }

        // Reproduce the reported direction after bootstrap: the joining
        // (Android-like) database adds two long-duration tasks, then the
        // existing primary (desktop-like) database receives them while already
        // holding a realistically large workspace checkpoint.
        let persist_started = std::time::Instant::now();
        for (sequence, (id, text, start_minutes, end_minutes)) in [
            ("ci-long-task-1", "Synthetic twelve-hour task", 0, 12 * 60),
            (
                "ci-long-task-2",
                "Synthetic almost-all-day task",
                12 * 60,
                36 * 60 - 1,
            ),
        ]
        .into_iter()
        .enumerate()
        {
            crate::persist_operation_to_database(
                &mut joiner,
                &json!({
                    "id": format!("ci-long-task-op-{sequence}"),
                    "deviceId": "selftest-joiner",
                    "sequence": sequence + 1,
                    "timestamp": format!("2026-07-14T12:00:0{sequence}.000Z"),
                    "type": "add_plan_item",
                    "payload": {
                        "planId": target_plan_id,
                        "parentId": JsonValue::Null,
                        "item": {
                            "id": id,
                            "text": text,
                            "html": text,
                            "done": false,
                            "startMinutes": start_minutes,
                            "endMinutes": end_minutes,
                            "children": [],
                        }
                    }
                }),
            )
            .map_err(Error::Codec)?;
        }
        let long_task_persist_ms = persist_started.elapsed().as_millis();

        let incremental_started = std::time::Instant::now();
        let primary =
            crate::open_database_at(&a_path, &primary_recovery_key).map_err(Error::Codec)?;
        let listener =
            std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| Error::Codec(e.to_string()))?;
        let address = listener
            .local_addr()
            .map_err(|e| Error::Codec(e.to_string()))?
            .to_string();
        let incremental_sync_key = joiner_sync_key.clone();
        let primary_thread = std::thread::spawn(move || -> Result<()> {
            transport::sync_accept(&listener, &incremental_sync_key, &ConnectionStore(&primary))
        });
        transport::sync_connect(&address, &joiner_sync_key, &ConnectionStore(&joiner))?;
        primary_thread
            .join()
            .map_err(|_| Error::Codec("primary incremental sync thread panicked".into()))??;
        let long_task_incremental_sync_ms = incremental_started.elapsed().as_millis();

        let primary =
            crate::open_database_at(&a_path, &primary_recovery_key).map_err(Error::Codec)?;
        let primary_state = crate::read_app_state_from_database(&primary)
            .map_err(Error::Codec)?
            .ok_or_else(|| Error::Codec("primary state missing after incremental sync".into()))?;
        let synced_items = primary_state["plans"]
            .as_array()
            .and_then(|plans| plans.iter().find(|plan| plan["id"] == target_plan_id))
            .and_then(|plan| plan["items"].as_array())
            .ok_or_else(|| Error::Codec("target plan missing after incremental sync".into()))?;
        for id in ["ci-long-task-1", "ci-long-task-2"] {
            if !synced_items.iter().any(|item| item["id"] == id) {
                return Err(Error::Codec(format!(
                    "primary did not receive long-duration task {id}"
                )));
            }
        }
        if long_task_incremental_sync_ms.saturating_mul(10) >= seed_and_checkpoint_ms {
            return Err(Error::Codec(format!(
                "two appended tasks took {long_task_incremental_sync_ms} ms to sync after a {seed_and_checkpoint_ms} ms fixture setup; the incremental path rebuilt too much state"
            )));
        }

        Ok(SyncSelftestProfile {
            fixture_plans: FIXTURE_PLANS,
            fixture_plan_items,
            seed_and_checkpoint_ms,
            bootstrap_ms,
            long_task_persist_ms,
            long_task_incremental_sync_ms,
        })
    })();

    let _ = std::fs::remove_file(&a_path);
    let _ = std::fs::remove_file(&b_path);
    result
}

#[cfg(test)]
mod tests;
