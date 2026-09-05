//! Multi-device sync for Balance.
//!
//! The database stays a normal SQLCipher-encrypted file (see `open_database_at`
//! in the crate root). The only replicated table is `operations`: an append-only
//! log of immutable rows with globally-unique TEXT ids, a canonical total order
//! of `(timestamp, device_id, sequence)`, and a deterministic materializer
//! (`apply_operation`, driven by [`rematerialize`]).
//!
//! Globally unique operation ids make repeated relay delivery idempotent.
//! A checkpoint adds a compact per-device sequence frontier so an offline peer
//! cannot resurrect removed history. No native SQLite extension is involved.
//!
//! Compaction (checkpointing) is the one operation that *removes* ops. The
//! resulting `replace_full_state` baseline carries the highest sequence covered
//! for each device.
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
pub mod diagnostics;
#[cfg(test)]
pub mod relay;
pub mod relay_client;

/// Wire-protocol version. Bump only for incompatible framing/semantics changes.
// v5 adds shared image entities. Older writers must
// not create checkpoints that silently omit image bytes.
pub const PROTOCOL_VERSION: u32 = 5;

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

// ---------------------------------------------------------------------------
// Op-log reads
// ---------------------------------------------------------------------------

/// Ensure the compact per-device checkpoint frontiers table exists.
pub fn ensure_sync_tables(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "create table if not exists sync_frontiers (
           device_id text primary key,
           sequence integer not null
         );",
    )?;
    Ok(())
}

pub fn sync_frontiers(conn: &Connection) -> Result<HashMap<String, i64>> {
    ensure_sync_tables(conn)?;
    let mut stmt = conn.prepare("SELECT device_id, sequence FROM sync_frontiers")?;
    let frontiers = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?
        .collect::<std::result::Result<_, _>>()?;
    Ok(frontiers)
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

/// Ids of every op held locally.
pub fn local_op_ids(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt =
        conn.prepare("SELECT id FROM operations ORDER BY timestamp, device_id, sequence, id")?;
    let ids = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(ids)
}

/// Every op held locally, in canonical order.
pub fn all_ops(conn: &Connection) -> Result<Vec<Op>> {
    let mut stmt = conn.prepare(SELECT_OPS)?;
    let ops = stmt
        .query_map([], row_to_op)?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(ops)
}

fn contains_retired_snapshot_field(value: &JsonValue) -> bool {
    match value {
        JsonValue::Object(object) => {
            object.contains_key("goalData")
                || object.contains_key("listsMetricsData")
                || object.values().any(contains_retired_snapshot_field)
        }
        JsonValue::Array(values) => values.iter().any(contains_retired_snapshot_field),
        _ => false,
    }
}

fn validate_current_operation(op: &Op) -> Result<JsonValue> {
    let payload: JsonValue = serde_json::from_str(&op.payload_json)
        .map_err(|error| Error::Codec(format!("invalid operation payload: {error}")))?;
    if contains_retired_snapshot_field(&payload) {
        return Err(Error::Codec(
            "operation contains retired full-state entity fields".into(),
        ));
    }
    if op.op_type == "replace_full_state" {
        let generation = payload
            .get("generation")
            .and_then(JsonValue::as_i64)
            .ok_or_else(|| Error::Codec("checkpoint is missing its generation".into()))?;
        if generation < 1 || !payload.get("frontiers").is_some_and(JsonValue::is_object) {
            return Err(Error::Codec(
                "checkpoint does not use current frontier metadata".into(),
            ));
        }
        if payload.get("replaces").is_some() || payload.get("legacyReplaces").is_some() {
            return Err(Error::Codec(
                "checkpoint contains retired replacement-id metadata".into(),
            ));
        }
    }
    Ok(payload)
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

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

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
    let mut current = None;
    for (id, payload) in rows {
        let value: JsonValue = serde_json::from_str(&payload)
            .map_err(|error| Error::Codec(format!("invalid checkpoint payload: {error}")))?;
        let generation = value
            .get("generation")
            .and_then(JsonValue::as_i64)
            .filter(|generation| *generation >= 1)
            .ok_or_else(|| Error::Codec("checkpoint is missing its current generation".into()))?;
        let candidate = (generation, id);
        if match current.as_ref() {
            None => true,
            Some(prior) => candidate > *prior,
        } {
            current = Some(candidate);
        }
    }
    Ok(current)
}

/// Insert every op this device does not already have, honoring checkpoint
/// frontiers in one transaction.
/// Returns how many ops were inserted; the caller rematerializes iff `> 0`.
pub fn merge_ops(conn: &Connection, ops: &[Op]) -> Result<usize> {
    ensure_sync_tables(conn)?;
    let tx = conn.unchecked_transaction()?;
    let inserted = merge_ops_uncommitted(&tx, ops)?;
    tx.commit()?;
    Ok(inserted.len())
}

fn merge_ops_uncommitted(conn: &Connection, ops: &[Op]) -> Result<Vec<Op>> {
    for op in ops {
        validate_current_operation(op)?;
    }
    let mut inserted = Vec::new();
    {
        let mut existing: HashSet<String> = {
            let mut stmt = conn.prepare("SELECT id FROM operations")?;
            let ids = stmt
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<std::result::Result<_, _>>()?;
            ids
        };
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
        let mut delete_frontier_history =
            conn.prepare("DELETE FROM history_entries WHERE device_id = ?1 AND sequence <= ?2")?;
        let mut upsert_frontier = conn.prepare(
            "INSERT INTO sync_frontiers (device_id, sequence) VALUES (?1, ?2)
             ON CONFLICT(device_id) DO UPDATE SET sequence = max(sequence, excluded.sequence)",
        )?;

        // Select exactly one checkpoint before considering ordinary ops. This
        // prevents a losing checkpoint in the same batch from contributing a
        // frontier and makes the result independent of wire order.
        let incoming_checkpoint = ops
            .iter()
            .filter(|op| op.op_type == "replace_full_state" && !existing.contains(&op.id))
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

            for (device_id, sequence) in checkpoint_frontiers(checkpoint) {
                upsert_frontier.execute(params![device_id, sequence])?;
                frontiers
                    .entry(device_id)
                    .and_modify(|current| *current = (*current).max(sequence))
                    .or_insert(sequence);
            }
        }

        for op in ops.iter().filter(|op| op.op_type != "replace_full_state") {
            if existing.contains(&op.id) {
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
    ensure_sync_tables(conn)?;
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

/// An acknowledged local edit is immutable, including after checkpointing.
pub(crate) fn local_operation_is_durable_retry(
    conn: &Connection,
    operation: &JsonValue,
) -> Result<bool> {
    if !is_sync_enabled(conn)? {
        return Ok(false);
    }
    let device_id = crate::required_string(operation, "deviceId").map_err(Error::Codec)?;
    let sequence = crate::required_i64(operation, "sequence").map_err(Error::Codec)?;
    let covered: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sync_frontiers WHERE device_id = ?1 AND sequence >= ?2)",
        params![device_id, sequence],
        |row| row.get(0),
    )?;
    if covered {
        // A checkpoint can compact a durable edit before its caller retries.
        // Its frontier is the durable acknowledgement after the row is gone.
        return Ok(true);
    }
    let id = crate::required_string(operation, "id").map_err(Error::Codec)?;
    let existing = conn.query_row(
        "SELECT id, device_id, sequence, type, timestamp, payload_json FROM operations WHERE id = ?1",
        [id], row_to_op,
    ).optional()?;
    let Some(existing) = existing else {
        return Ok(false);
    };
    let durable = op_value(&existing)?;
    if ["deviceId", "sequence", "type", "payload"]
        .iter()
        .any(|field| durable[*field] != operation[*field])
    {
        return Err(Error::Codec(
            "cannot change an already persisted sync operation; use a new operation id".into(),
        ));
    }
    // The IPC timestamp can differ from the causal timestamp assigned when the
    // operation became durable. Equal content is nevertheless the same write.
    Ok(true)
}

/// Local edits are applied immediately, so their durable order must follow all
/// operations the device has already observed. Wall clocks (including equal
/// milliseconds on different devices) cannot supply that causal guarantee.
pub(crate) fn local_operation_with_causal_timestamp(
    conn: &Connection,
    operation: &JsonValue,
) -> Result<JsonValue> {
    let mut operation = operation.clone();
    if !is_sync_enabled(conn)? {
        return Ok(operation);
    }
    let id = crate::required_string(&operation, "id").map_err(Error::Codec)?;
    let prior: Option<String> = conn
        .query_row(
            "SELECT timestamp FROM operations WHERE id = ?1",
            [id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(timestamp) = prior {
        // Retrying a durable write must not move it past later operations.
        operation["timestamp"] = json!(timestamp);
        return Ok(operation);
    }
    let timestamp = crate::required_string(&operation, "timestamp").map_err(Error::Codec)?;
    let latest: Option<String> = conn.query_row(
        "SELECT max(timestamp) FROM operations WHERE type != 'replace_full_state'",
        [],
        |row| row.get(0),
    )?;
    if let Some(last) = latest {
        if timestamp <= last.as_str() {
            operation["timestamp"] = json!(timestamp_after(&last));
        }
    }
    Ok(operation)
}

/// Replay orders timestamps as opaque strings, including the `unix-ms-...`
/// format produced by native history actions. Never rewrite observed rows or
/// reject a new edit merely because older accepted text is not RFC3339.
fn timestamp_after(last: &str) -> String {
    if let Ok(observed) = chrono::DateTime::parse_from_rfc3339(last) {
        // A timestamp without fractional seconds needs the whole-second step
        // because its trailing Z sorts after a decimal point.
        for step in [
            chrono::Duration::milliseconds(1),
            chrono::Duration::seconds(1),
        ] {
            if let Some(next) = observed.checked_add_signed(step) {
                let candidate = next.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                if candidate.as_str() > last {
                    return candidate;
                }
            }
        }
    }
    if let Some(next) = last
        .strip_prefix("unix-ms-")
        .and_then(|value| value.parse::<u64>().ok())
        .and_then(|value| value.checked_add(1))
    {
        let candidate = format!("unix-ms-{next}");
        if candidate.as_str() > last {
            return candidate;
        }
    }
    // Preserve ordering even for opaque legacy values, numeric-width changes,
    // and overflow. A fixed-width suffix avoids growing the string per edit.
    if let Some((prefix, counter)) = last.rsplit_once('~') {
        if counter.len() == 16 {
            if let Some(next) = u64::from_str_radix(counter, 16)
                .ok()
                .and_then(|n| n.checked_add(1))
            {
                let candidate = format!("{prefix}~{next:016x}");
                if candidate.as_str() > last {
                    return candidate;
                }
            }
        }
    }
    format!("{last}~0000000000000000")
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

/// Persist the pairing code (the E2E key) in the encrypted DB for automatic sync.
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

/// Enable sync on the device that holds the canonical data ("Set up sync").
/// Snapshot the current state into a single baseline op and reset the log to
/// just that snapshot. The real data tables are not touched.
pub fn enable_primary(conn: &Connection) -> Result<()> {
    ensure_sync_tables(conn)?;
    conn.execute("DELETE FROM sync_frontiers", [])?;
    checkpoint_operation_log_preserving_history(conn)?;
    mark_enabled(conn)?;
    Ok(())
}

/// Enable sync on a device that will adopt another's data ("Pair with another
/// device"). Clear local domain state and the op log (the caller takes a backup
/// first), then wait to receive the primary's baseline via sync + merge.
pub fn enable_joiner(conn: &Connection) -> Result<()> {
    ensure_sync_tables(conn)?;
    {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(
            "DELETE FROM operations; DELETE FROM history_entries;
             DELETE FROM sync_frontiers;
             DELETE FROM plan_items; DELETE FROM plans;
             DELETE FROM template_options; DELETE FROM template_items; DELETE FROM templates;
             DELETE FROM state_entities;
             DELETE FROM metadata WHERE key = 'replicated_preferences';",
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
/// Version frontiers compact the known log in O(device-count) metadata.
fn snapshot_state_op(conn: &Connection, state: &JsonValue) -> Result<JsonValue> {
    let device_id = crate::metadata_value(conn, "device_id")
        .map_err(Error::Codec)?
        .unwrap_or_default();
    ensure_sync_tables(conn)?;
    let mut frontiers = sync_frontiers(conn)?;
    let current_ops = all_ops(conn)?;
    for operation in &current_ops {
        validate_current_operation(operation)?;
    }
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
        let mut contiguous = prior.unwrap_or(if first == 0 { -1 } else { 0 });
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
    let uncovered = current_ops
        .iter()
        .filter(|op| {
            op.op_type != "replace_full_state"
                && !frontiers
                    .get(&op.device_id)
                    .is_some_and(|covered| op.sequence <= *covered)
        })
        .count();
    if uncovered != 0 {
        return Err(Error::Codec(format!(
            "cannot checkpoint while {uncovered} operation(s) are separated by sequence gaps"
        )));
    }
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
            "frontiers": frontiers
        },
    }))
}

/// Replace the operation log with one full-state checkpoint and prove, inside
/// the same transaction, that replaying only that checkpoint reconstructs the
/// exact app state that existed before compaction. Any mismatch rolls back the
/// log, history, frontiers, and materialized tables together.
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
    ensure_sync_tables(conn)?;
    let operation_count: i64 =
        conn.query_row("SELECT count(*) FROM operations", [], |row| row.get(0))?;
    let history_count: i64 =
        conn.query_row("SELECT count(*) FROM history_entries", [], |row| row.get(0))?;
    let frontiers: std::collections::HashMap<String, i64> = snapshot
        .get("payload")
        .and_then(|payload| payload.get("frontiers"))
        .cloned()
        .ok_or_else(|| Error::Codec("checkpoint is missing frontiers".into()))
        .and_then(|value| {
            serde_json::from_value(value)
                .map_err(|error| Error::Codec(format!("invalid checkpoint frontiers: {error}")))
        })?;

    let tx = conn.unchecked_transaction()?;
    if clear_history {
        tx.execute("DELETE FROM history_entries", [])?;
    }
    tx.execute("DELETE FROM operations", [])?;
    crate::upsert_operation(&tx, snapshot).map_err(Error::Codec)?;
    crate::apply_operation(&tx, snapshot).map_err(Error::Codec)?;
    {
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
    let mut state = crate::read_app_state_from_database(conn)
        .map_err(Error::Codec)?
        .ok_or_else(|| Error::Codec("database has no app state to checkpoint".into()))?;
    crate::images::collect_for_checkpoint(conn, &mut state, false).map_err(Error::Codec)?;
    let snapshot = snapshot_state_op(conn, &state)?;
    install_checkpoint(conn, &state, &snapshot)
}

/// Compact replicated operations for a relay generation without silently
/// discarding the user's local undo/recovery history. Physical database
/// maintenance is intentionally independent from this logical compaction.
pub(crate) fn checkpoint_operation_log_preserving_history(
    conn: &Connection,
) -> Result<CheckpointStats> {
    let mut state = crate::read_app_state_from_database(conn)
        .map_err(Error::Codec)?
        .ok_or_else(|| Error::Codec("database has no app state to checkpoint".into()))?;
    crate::images::collect_for_checkpoint(conn, &mut state, true).map_err(Error::Codec)?;
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
    let previous_images = crate::read_entity_collection(tx, "images").map_err(Error::Codec)?;
    tx.execute_batch(
        "DELETE FROM plan_items; DELETE FROM plans;
         DELETE FROM template_options; DELETE FROM template_items; DELETE FROM templates;
         DELETE FROM state_entities;
         DELETE FROM metadata WHERE key = 'replicated_preferences';",
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
    crate::images::restore_offline_references(tx, &previous_images).map_err(Error::Codec)?;
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
/// encrypted operation log through a synthetic exchange, and verifies that data
/// appears on the joining device. CI runs this inside the Android APK so
/// SQLCipher, pairing, and the bootstrap path are covered together. HTTP relay
/// transport is exercised separately against the reference server in CI.
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

fn exchange_fixture_operations(
    a: &Connection,
    b: &Connection,
    key: &crypto::SyncKey,
) -> Result<()> {
    let encode = |conn, recipient| -> Result<Vec<u8>> {
        let known: HashSet<String> = local_op_ids(recipient)?.into_iter().collect();
        let missing: Vec<Op> = all_ops(conn)?.into_iter().filter(|op| !known.contains(&op.id)).collect();
        let bytes = serde_json::to_vec(&missing).map_err(|e| Error::Codec(e.to_string()))?;
        key.seal(&bytes)
    };
    let decode = |sealed: &[u8]| -> Result<Vec<Op>> {
        serde_json::from_slice(&key.open(sealed)?).map_err(|e| Error::Codec(e.to_string()))
    };
    let from_a = encode(a, b)?;
    let from_b = encode(b, a)?;
    merge_and_rematerialize(a, decode(&from_b)?)?;
    merge_and_rematerialize(b, decode(&from_a)?)?;
    Ok(())
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

        // A user can type while the first Android foreground sync is still
        // fetching the primary's baseline. The target plan is not materialized
        // yet, but the durable operation must replay immediately after the
        // checkpoint instead of disappearing.
        crate::persist_operation_to_database(
            &mut joiner,
            &json!({
                "id": "ci-pre-bootstrap-task-op",
                "deviceId": "selftest-joiner",
                "sequence": 1,
                "timestamp": "2026-07-14T11:59:59.000Z",
                "type": "add_plan_item",
                "payload": {
                    "planId": target_plan_id,
                    "parentId": JsonValue::Null,
                    "item": {
                        "id": "ci-pre-bootstrap-task",
                        "text": "Synthetic task typed before initial sync",
                        "html": "Synthetic task typed before initial sync",
                        "done": false,
                        "startMinutes": JsonValue::Null,
                        "endMinutes": JsonValue::Null,
                        "children": [],
                    }
                }
            }),
        )
        .map_err(Error::Codec)?;

        let bootstrap_started = std::time::Instant::now();
        exchange_fixture_operations(&primary, &joiner, &joiner_sync_key)?;
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
        let pre_bootstrap_task_survived = joined_state["plans"]
            .as_array()
            .and_then(|plans| plans.iter().find(|plan| plan["id"] == target_plan_id))
            .and_then(|plan| plan["items"].as_array())
            .is_some_and(|items| {
                items
                    .iter()
                    .any(|item| item["id"] == "ci-pre-bootstrap-task")
            });
        if !pre_bootstrap_task_survived {
            return Err(Error::Codec(
                "task typed before Android bootstrap disappeared during baseline replay".into(),
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
                    "sequence": sequence + 2,
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
        exchange_fixture_operations(&primary, &joiner, &joiner_sync_key)?;
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

        // Reproduce the reported desktop-to-Android cut/paste direction after
        // both devices were already in sync. Use separate immutable operations,
        // then restart the Android-like database and sync back to prove the old
        // task ids cannot reappear on either side.
        let mut primary = primary;
        crate::persist_operation_to_database(
            &mut primary,
            &json!({
                "id": "ci-desktop-cut-op",
                "deviceId": "selftest-primary",
                "sequence": 1,
                "timestamp": "2026-07-14T12:01:00.000Z",
                "type": "delete_plan_items",
                "payload": {
                    "planId": target_plan_id,
                    "itemIds": ["fixture-item-0-0", "fixture-item-0-1"],
                    "completedParentIds": [],
                }
            }),
        )
        .map_err(Error::Codec)?;
        crate::persist_operation_to_database(
            &mut primary,
            &json!({
                "id": "ci-desktop-paste-op",
                "deviceId": "selftest-primary",
                "sequence": 2,
                "timestamp": "2026-07-14T12:01:01.000Z",
                "type": "paste_plan_items",
                "payload": {
                    "planId": target_plan_id,
                    "targetId": "fixture-item-0-19",
                    "placement": "after",
                    "items": [{
                        "id": "ci-pasted-task-0",
                        "text": "Synthetic existing task 0-0",
                        "html": "Synthetic existing task 0-0",
                        "done": true,
                        "startMinutes": JsonValue::Null,
                        "endMinutes": JsonValue::Null,
                        "children": [],
                    }, {
                        "id": "ci-pasted-task-1",
                        "text": "Synthetic existing task 0-1",
                        "html": "Synthetic existing task 0-1",
                        "done": false,
                        "startMinutes": JsonValue::Null,
                        "endMinutes": JsonValue::Null,
                        "children": [],
                    }]
                }
            }),
        )
        .map_err(Error::Codec)?;

        exchange_fixture_operations(&primary, &joiner, &joiner_sync_key)?;

        drop(joiner);
        let joiner =
            crate::open_database_at(&b_path, &joiner_recovery_key).map_err(Error::Codec)?;
        let primary =
            crate::open_database_at(&a_path, &primary_recovery_key).map_err(Error::Codec)?;
        for (label, connection) in [("primary", &primary), ("Android joiner", &joiner)] {
            let state = crate::read_app_state_from_database(connection)
                .map_err(Error::Codec)?
                .ok_or_else(|| Error::Codec(format!("{label} state missing after cut/paste")))?;
            let items = state["plans"]
                .as_array()
                .and_then(|plans| plans.iter().find(|plan| plan["id"] == target_plan_id))
                .and_then(|plan| plan["items"].as_array())
                .ok_or_else(|| {
                    Error::Codec(format!("{label} target plan missing after cut/paste"))
                })?;
            if items.iter().any(|item| {
                matches!(
                    item["id"].as_str(),
                    Some("fixture-item-0-0" | "fixture-item-0-1")
                )
            }) || !["ci-pasted-task-0", "ci-pasted-task-1"]
                .iter()
                .all(|id| items.iter().any(|item| item["id"] == *id))
            {
                return Err(Error::Codec(format!(
                    "{label} duplicated or lost tasks after desktop cut/paste"
                )));
            }
        }

        exchange_fixture_operations(&primary, &joiner, &joiner_sync_key)?;

        drop(joiner);
        let joiner =
            crate::open_database_at(&b_path, &joiner_recovery_key).map_err(Error::Codec)?;
        let primary =
            crate::open_database_at(&a_path, &primary_recovery_key).map_err(Error::Codec)?;
        let materialized_tables = [
            "templates",
            "template_items",
            "template_options",
            "plans",
            "plan_items",
            "state_entities",
        ];
        if state_hash(&primary, &materialized_tables)? != state_hash(&joiner, &materialized_tables)?
        {
            return Err(Error::Codec(
                "Android restart uploaded stale cut/paste state back to the primary".into(),
            ));
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
