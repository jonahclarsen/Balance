//! Incremental HTTP relay client shared by the foreground app and Android's
//! background worker. The relay sees only stable opaque routing tokens and
//! compressed XChaCha20-Poly1305 ciphertext.

use std::collections::HashSet;
use std::io::Cursor;
use std::time::Duration;

use hmac::{Hmac, Mac};
use rand::RngCore;
use reqwest::blocking::{Client, Response};
use reqwest::StatusCode;
use rusqlite::{params, Connection};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::Sha256;

use super::crypto::SyncKey;
use super::{
    all_ops, checkpoint_operation_log_preserving_history, merge_and_rematerialize, Error, Op,
    Result, PROTOCOL_VERSION,
};

const MAX_BATCH_CIPHERTEXT: usize = 512 * 1024;
const TARGET_BATCH_PLAINTEXT: usize = 256 * 1024;
const CHECKPOINT_CHUNK_BYTES: usize = 96 * 1024;
const BACKGROUND_MAX_DOWNLOAD_CHUNKS: usize = 64;
const PARALLEL_BATCH_DOWNLOADS: usize = 8;
const RELAY_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const FOREGROUND_REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const BACKGROUND_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// Foreground app sync temporarily gives up the process-wide database mutex
/// while it waits on HTTP. Database work on the relay connection remains
/// serialized before and after each wait, so local edits and history commands
/// are never parked behind an unreachable relay.
pub(crate) trait NetworkDatabaseGate {
    fn without_database_lock<T>(&mut self, task: impl FnOnce() -> Result<T>) -> Result<T>;
}

struct ContinuousDatabaseAccess;

impl NetworkDatabaseGate for ContinuousDatabaseAccess {
    fn without_database_lock<T>(&mut self, task: impl FnOnce() -> Result<T>) -> Result<T> {
        task()
    }
}

#[derive(Debug, Clone, Copy)]
pub struct SyncOptions {
    /// Foreground passes may finish large downloads while the app is open.
    pub foreground: bool,
    /// This pass may replace relay history with a compare-and-swap checkpoint.
    pub allow_checkpoint: bool,
}

impl SyncOptions {
    pub const fn background() -> Self {
        Self {
            foreground: false,
            allow_checkpoint: false,
        }
    }

    pub const fn foreground(allow_checkpoint: bool) -> Self {
        Self {
            foreground: true,
            allow_checkpoint,
        }
    }
}

fn relay_http_client(options: SyncOptions) -> Result<Client> {
    let request_timeout = if options.foreground {
        FOREGROUND_REQUEST_TIMEOUT
    } else {
        BACKGROUND_REQUEST_TIMEOUT
    };
    relay_http_client_with_timeouts(RELAY_CONNECT_TIMEOUT, request_timeout)
}

fn relay_http_client_with_timeouts(
    connect_timeout: Duration,
    request_timeout: Duration,
) -> Result<Client> {
    Client::builder()
        .connect_timeout(connect_timeout)
        .timeout(request_timeout)
        .build()
        .map_err(|error| Error::Codec(error.to_string()))
}

fn random_token() -> String {
    let mut bytes = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    super::hex(&bytes)
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncPassResult {
    pub pulled_operations: usize,
    pub pushed_operations: usize,
    pub state_changed: bool,
    pub checkpoint_committed: bool,
    pub epoch: String,
    pub latest_sequence: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    epoch: String,
    latest_sequence: i64,
    checkpoint: Option<BlobDescriptor>,
    batches: Vec<BatchDescriptor>,
    compact_recommended: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BlobDescriptor {
    id: String,
    chunks: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BatchDescriptor {
    id: String,
    sequence: i64,
    chunks: usize,
}

#[derive(Debug, Serialize, Deserialize)]
struct RelayEnvelope {
    v: u32,
    epoch: String,
    ops: Vec<Op>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CheckpointStart<'a> {
    upload_id: &'a str,
    expected_epoch: &'a str,
    expected_latest_sequence: i64,
    new_epoch: &'a str,
    chunks: usize,
    byte_length: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CheckpointCommit<'a> {
    upload_id: &'a str,
    expected_epoch: &'a str,
    expected_latest_sequence: i64,
    new_epoch: &'a str,
}

pub fn ensure_relay_tables(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS sync_relay_state (
           singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
           epoch TEXT NOT NULL DEFAULT '',
           cursor INTEGER NOT NULL DEFAULT 0,
           last_success_ms INTEGER,
           last_error TEXT
         );
         INSERT OR IGNORE INTO sync_relay_state (singleton) VALUES (1);
         CREATE TABLE IF NOT EXISTS sync_relay_known_ops (
           op_id TEXT PRIMARY KEY
         );
         CREATE TABLE IF NOT EXISTS sync_relay_outbox (
           batch_id TEXT PRIMARY KEY,
           epoch TEXT NOT NULL,
           ciphertext BLOB NOT NULL,
           op_ids_json TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS sync_relay_quarantine (
           blob_id TEXT PRIMARY KEY,
           error TEXT NOT NULL,
           recorded_at_ms INTEGER NOT NULL
         );",
    )?;
    Ok(())
}

/// Remove relay delivery bookkeeping for operations that a checkpoint has
/// already replaced. Known ids matter only while the corresponding local
/// operation can be offered. A queued batch with no remaining live operation
/// can likewise be discarded because the checkpoint carries its resulting
/// state.
pub(crate) fn prune_obsolete_relay_rows(conn: &Connection) -> Result<(usize, usize)> {
    let has_tables: bool = conn.query_row(
        "SELECT count(*) = 2 FROM sqlite_master
         WHERE type = 'table' AND name IN ('sync_relay_known_ops', 'sync_relay_outbox')",
        [],
        |row| row.get(0),
    )?;
    if !has_tables {
        return Ok((0, 0));
    }

    let known_removed = conn.execute(
        "DELETE FROM sync_relay_known_ops
         WHERE NOT EXISTS (
           SELECT 1 FROM operations WHERE operations.id = sync_relay_known_ops.op_id
         )",
        [],
    )?;
    let live_ids = super::local_op_ids(conn)?
        .into_iter()
        .collect::<HashSet<_>>();
    let stale_batches = {
        let mut statement = conn.prepare("SELECT batch_id, op_ids_json FROM sync_relay_outbox")?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows.into_iter()
            .filter_map(|(batch_id, ids_json)| {
                let ids = serde_json::from_str::<Vec<String>>(&ids_json).ok()?;
                ids.iter()
                    .all(|id| !live_ids.contains(id))
                    .then_some(batch_id)
            })
            .collect::<Vec<_>>()
    };
    let mut outbox_removed = 0;
    for batch_id in stale_batches {
        outbox_removed += conn.execute(
            "DELETE FROM sync_relay_outbox WHERE batch_id = ?1",
            params![batch_id],
        )?;
    }
    Ok((known_removed, outbox_removed))
}

pub fn device_token(key: &SyncKey, device_id: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(key.as_bytes()).expect("HMAC accepts any key");
    mac.update(b"balance-relay-device-v3\0");
    mac.update(device_id.as_bytes());
    super::hex(&mac.finalize().into_bytes()[..16])
}

fn seal<T: Serialize>(key: &SyncKey, payload: &T) -> Result<Vec<u8>> {
    let json = serde_json::to_vec(payload).map_err(|error| Error::Codec(error.to_string()))?;
    let compressed = zstd::stream::encode_all(Cursor::new(json), 3)
        .map_err(|error| Error::Codec(format!("compression: {error}")))?;
    key.seal(&compressed)
}

fn open<T: DeserializeOwned>(key: &SyncKey, ciphertext: &[u8]) -> Result<T> {
    let compressed = key.open(ciphertext)?;
    let json = zstd::stream::decode_all(Cursor::new(compressed))
        .map_err(|error| Error::Codec(format!("decompression: {error}")))?;
    serde_json::from_slice(&json).map_err(|error| Error::Codec(error.to_string()))
}

fn response_error(response: Response) -> Error {
    let status = response.status();
    let body = response.text().unwrap_or_default();
    Error::Codec(format!("relay {status}: {body}"))
}

fn get_json<T: DeserializeOwned>(
    client: &Client,
    url: &str,
    gate: &mut impl NetworkDatabaseGate,
) -> Result<T> {
    gate.without_database_lock(|| {
        let response = client
            .get(url)
            .send()
            .map_err(|error| Error::Codec(format!("relay request: {error}")))?;
        if !response.status().is_success() {
            return Err(response_error(response));
        }
        response
            .json()
            .map_err(|error| Error::Codec(format!("relay response: {error}")))
    })
}

fn manifest(
    client: &Client,
    base: &str,
    epoch: &str,
    after: i64,
    gate: &mut impl NetworkDatabaseGate,
) -> Result<Manifest> {
    get_json(
        client,
        &format!("{base}/v3/manifest?epoch={epoch}&after={after}"),
        gate,
    )
}

#[derive(Debug)]
struct DownloadBudget {
    remaining_chunks: Option<usize>,
}

impl DownloadBudget {
    fn for_options(options: SyncOptions) -> Self {
        Self {
            remaining_chunks: (!options.foreground).then_some(BACKGROUND_MAX_DOWNLOAD_CHUNKS),
        }
    }

    fn reserve(&mut self, chunks: usize) -> bool {
        let Some(remaining) = self.remaining_chunks.as_mut() else {
            return true;
        };
        if chunks > *remaining {
            return false;
        }
        *remaining -= chunks;
        true
    }
}

fn fetch_blob(client: &Client, base: &str, id: &str, chunks: usize) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    for index in 0..chunks {
        let response = client
            .get(format!("{base}/v3/blobs/{id}/{index}"))
            .send()
            .map_err(|error| Error::Codec(format!("relay download: {error}")))?;
        if !response.status().is_success() {
            return Err(response_error(response));
        }
        bytes.extend_from_slice(
            &response
                .bytes()
                .map_err(|error| Error::Codec(format!("relay download: {error}")))?,
        );
    }
    Ok(bytes)
}

fn relay_state(conn: &Connection) -> Result<(String, i64)> {
    ensure_relay_tables(conn)?;
    Ok(conn.query_row(
        "SELECT epoch, cursor FROM sync_relay_state WHERE singleton = 1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?)
}

fn set_relay_state(conn: &Connection, epoch: &str, cursor: i64) -> Result<()> {
    conn.execute(
        "UPDATE sync_relay_state SET epoch = ?1, cursor = ?2, last_error = NULL WHERE singleton = 1",
        params![epoch, cursor],
    )?;
    Ok(())
}

fn mark_known(conn: &Connection, ops: &[Op]) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    {
        let mut stmt =
            tx.prepare("INSERT OR IGNORE INTO sync_relay_known_ops (op_id) VALUES (?1)")?;
        for op in ops {
            stmt.execute(params![op.id])?;
        }
    }
    tx.commit()?;
    Ok(())
}

fn quarantine(conn: &Connection, id: &str, error: &Error) -> Result<()> {
    conn.execute(
        "INSERT INTO sync_relay_quarantine (blob_id, error, recorded_at_ms)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(blob_id) DO UPDATE SET error = excluded.error, recorded_at_ms = excluded.recorded_at_ms",
        params![id, error.to_string(), crate::current_timestamp_ms()],
    )?;
    Ok(())
}

fn checkpoint_safe(conn: &Connection) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT count(*) = 0 FROM sync_relay_quarantine",
        [],
        |row| row.get(0),
    )?)
}

fn apply_descriptor_with_gate(
    conn: &Connection,
    client: &Client,
    base: &str,
    key: &SyncKey,
    epoch: &str,
    id: &str,
    chunks: usize,
    gate: &mut impl NetworkDatabaseGate,
) -> Result<(usize, bool)> {
    let ciphertext = gate.without_database_lock(|| fetch_blob(client, base, id, chunks))?;
    apply_ciphertext(conn, key, epoch, &ciphertext)
}

fn apply_ciphertext(
    conn: &Connection,
    key: &SyncKey,
    epoch: &str,
    ciphertext: &[u8],
) -> Result<(usize, bool)> {
    let ops = decode_ciphertext(key, epoch, ciphertext)?;
    apply_decoded_ops(conn, ops)
}

fn decode_ciphertext(key: &SyncKey, epoch: &str, ciphertext: &[u8]) -> Result<Vec<Op>> {
    let envelope: RelayEnvelope = open(key, ciphertext)?;
    if envelope.v != PROTOCOL_VERSION || envelope.epoch != epoch {
        return Err(Error::Codec(
            "relay blob has incompatible protocol metadata".into(),
        ));
    }
    Ok(envelope.ops)
}

fn apply_decoded_ops(conn: &Connection, ops: Vec<Op>) -> Result<(usize, bool)> {
    let inserted = merge_and_rematerialize(conn, ops.clone())?;
    mark_known(conn, &ops)?;
    Ok((inserted, inserted > 0))
}

fn apply_decoded_batches(
    conn: &Connection,
    ops: Vec<Op>,
    batches: &[&BatchDescriptor],
    epoch: &str,
) -> Result<(usize, bool)> {
    let applied = if ops.is_empty() {
        (0, false)
    } else {
        apply_decoded_ops(conn, ops)?
    };
    for batch in batches {
        conn.execute(
            "DELETE FROM sync_relay_quarantine WHERE blob_id = ?1",
            params![batch.id],
        )?;
    }
    if let Some(batch) = batches.last() {
        set_relay_state(conn, epoch, batch.sequence)?;
    }
    Ok(applied)
}

fn apply_manifest(
    conn: &Connection,
    client: &Client,
    base: &str,
    key: &SyncKey,
    manifest: &Manifest,
    local_epoch: &str,
) -> Result<(usize, bool)> {
    let mut budget = DownloadBudget {
        remaining_chunks: None,
    };
    let mut gate = ContinuousDatabaseAccess;
    apply_manifest_with_budget_and_gate(
        conn,
        client,
        base,
        key,
        manifest,
        local_epoch,
        &mut budget,
        &mut gate,
    )
}

fn apply_manifest_with_budget(
    conn: &Connection,
    client: &Client,
    base: &str,
    key: &SyncKey,
    manifest: &Manifest,
    local_epoch: &str,
    budget: &mut DownloadBudget,
) -> Result<(usize, bool)> {
    let mut gate = ContinuousDatabaseAccess;
    apply_manifest_with_budget_and_gate(
        conn,
        client,
        base,
        key,
        manifest,
        local_epoch,
        budget,
        &mut gate,
    )
}

fn apply_manifest_with_budget_and_gate(
    conn: &Connection,
    client: &Client,
    base: &str,
    key: &SyncKey,
    manifest: &Manifest,
    local_epoch: &str,
    budget: &mut DownloadBudget,
    gate: &mut impl NetworkDatabaseGate,
) -> Result<(usize, bool)> {
    let mut pulled = 0;
    let mut changed = false;
    let cursor = if local_epoch == manifest.epoch {
        relay_state(conn)?.1
    } else {
        if let Some(checkpoint) = &manifest.checkpoint {
            if !budget.reserve(checkpoint.chunks) {
                return Err(Error::Codec(
                    "the pending sync is large and will finish next time Balance is open".into(),
                ));
            }
        }
        conn.execute("DELETE FROM sync_relay_known_ops", [])?;
        conn.execute("DELETE FROM sync_relay_outbox", [])?;
        if let Some(checkpoint) = &manifest.checkpoint {
            match apply_descriptor_with_gate(
                conn,
                client,
                base,
                key,
                &manifest.epoch,
                &checkpoint.id,
                checkpoint.chunks,
                gate,
            ) {
                Ok((count, did_change)) => {
                    pulled += count;
                    changed |= did_change;
                }
                Err(error) => {
                    quarantine(conn, &checkpoint.id, &error)?;
                    return Err(error);
                }
            }
        }
        conn.execute("DELETE FROM sync_relay_quarantine", [])?;
        set_relay_state(conn, &manifest.epoch, 0)?;
        0
    };

    let pending_batches = manifest
        .batches
        .iter()
        .filter(|batch| batch.sequence > cursor)
        .take_while(|batch| budget.reserve(batch.chunks))
        .collect::<Vec<_>>();
    let mut decoded_ops = Vec::new();
    let mut decoded_batches = Vec::new();
    for group in pending_batches.chunks(PARALLEL_BATCH_DOWNLOADS) {
        let downloads = gate.without_database_lock(|| {
            Ok(std::thread::scope(|scope| {
                group
                    .iter()
                    .map(|batch| {
                        scope.spawn(move || fetch_blob(client, base, &batch.id, batch.chunks))
                    })
                    .collect::<Vec<_>>()
                    .into_iter()
                    .map(|download| {
                        download.join().unwrap_or_else(|_| {
                            Err(Error::Codec("relay download worker panicked".into()))
                        })
                    })
                    .collect::<Vec<_>>()
            }))
        })?;

        for (batch, download) in group.iter().zip(downloads) {
            match download
                .and_then(|ciphertext| decode_ciphertext(key, &manifest.epoch, &ciphertext))
            {
                Ok(ops) => {
                    decoded_ops.extend(ops);
                    decoded_batches.push(*batch);
                }
                Err(error) => {
                    if !decoded_batches.is_empty() {
                        apply_decoded_batches(
                            conn,
                            std::mem::take(&mut decoded_ops),
                            &decoded_batches,
                            &manifest.epoch,
                        )?;
                    }
                    quarantine(conn, &batch.id, &error)?;
                    // Never acknowledge past a missing or unreadable batch. Doing
                    // so permanently skipped its operations while later batches
                    // continued to apply, leaving apparently random holes in a
                    // delayed device's state. The next pass must retry this exact
                    // sequence before its cursor can move forward.
                    return Err(error);
                }
            }
        }
    }
    if !decoded_batches.is_empty() {
        let (count, did_change) =
            apply_decoded_batches(conn, decoded_ops, &decoded_batches, &manifest.epoch)?;
        pulled += count;
        changed |= did_change;
    }
    Ok((pulled, changed))
}

fn stage_outbox(conn: &Connection, key: &SyncKey, epoch: &str) -> Result<bool> {
    let mut known: HashSet<String> = {
        let mut stmt = conn.prepare("SELECT op_id FROM sync_relay_known_ops")?;
        let rows = stmt
            .query_map([], |row| row.get(0))?
            .collect::<std::result::Result<_, _>>()?;
        rows
    };
    {
        let mut stmt =
            conn.prepare("SELECT op_ids_json FROM sync_relay_outbox WHERE epoch = ?1")?;
        let rows = stmt
            .query_map(params![epoch], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for ids_json in rows {
            let ids: Vec<String> =
                serde_json::from_str(&ids_json).map_err(|error| Error::Codec(error.to_string()))?;
            known.extend(ids);
        }
    }
    let pending = all_ops(conn)?
        .into_iter()
        .filter(|op| !known.contains(&op.id))
        .collect::<Vec<_>>();
    if pending.is_empty() {
        return Ok(false);
    }

    let mut batches: Vec<Vec<Op>> = Vec::new();
    let mut current = Vec::new();
    let mut estimated = 0usize;
    for op in pending {
        let size = op.payload_json.len() + op.id.len() + op.device_id.len() + 128;
        if !current.is_empty() && estimated + size > TARGET_BATCH_PLAINTEXT {
            batches.push(std::mem::take(&mut current));
            estimated = 0;
        }
        estimated += size;
        current.push(op);
    }
    if !current.is_empty() {
        batches.push(current);
    }

    for ops in batches {
        let batch_id = random_token();
        let ciphertext = seal(
            key,
            &RelayEnvelope {
                v: PROTOCOL_VERSION,
                epoch: epoch.to_string(),
                ops: ops.clone(),
            },
        )?;
        if ciphertext.len() > MAX_BATCH_CIPHERTEXT {
            // A single large operation cannot be split. Promote the complete
            // local state through the chunked checkpoint endpoint instead.
            return Ok(true);
        }
        let ids = serde_json::to_string(&ops.iter().map(|op| &op.id).collect::<Vec<_>>())
            .map_err(|error| Error::Codec(error.to_string()))?;
        conn.execute(
            "INSERT INTO sync_relay_outbox (batch_id, epoch, ciphertext, op_ids_json) VALUES (?1, ?2, ?3, ?4)",
            params![batch_id, epoch, ciphertext, ids],
        )?;
    }
    Ok(false)
}

/// Give the Android debug profile one ordinary encrypted relay batch per
/// synthetic operation without changing production batching thresholds.
#[cfg(all(target_os = "android", debug_assertions))]
pub(crate) fn stage_android_ci_outbox_batches(
    conn: &Connection,
    key: &SyncKey,
    ops: &[Op],
) -> Result<()> {
    ensure_relay_tables(conn)?;
    let epoch = relay_state(conn)?.0;
    for op in ops {
        let batch_id = random_token();
        let ciphertext = seal(
            key,
            &RelayEnvelope {
                v: PROTOCOL_VERSION,
                epoch: epoch.clone(),
                ops: vec![op.clone()],
            },
        )?;
        let ids =
            serde_json::to_string(&[&op.id]).map_err(|error| Error::Codec(error.to_string()))?;
        conn.execute(
            "INSERT INTO sync_relay_outbox (batch_id, epoch, ciphertext, op_ids_json)
             VALUES (?1, ?2, ?3, ?4)",
            params![batch_id, epoch, ciphertext, ids],
        )?;
    }
    Ok(())
}

fn upload_outbox(
    conn: &Connection,
    client: &Client,
    base: &str,
    device: &str,
    epoch: &str,
    gate: &mut impl NetworkDatabaseGate,
) -> Result<usize> {
    let rows = {
        let mut stmt = conn.prepare(
            "SELECT batch_id, ciphertext, op_ids_json FROM sync_relay_outbox WHERE epoch = ?1 ORDER BY rowid",
        )?;
        let rows = stmt
            .query_map(params![epoch], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Vec<u8>>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows
    };
    let mut pushed = 0;
    for (batch_id, ciphertext, ids_json) in rows {
        gate.without_database_lock(|| {
            let response = client
                .post(format!("{base}/v3/batches"))
                .header("content-type", "application/octet-stream")
                .header("x-balance-epoch", epoch)
                .header("x-balance-device", device)
                .header("x-balance-batch", &batch_id)
                .body(ciphertext)
                .send()
                .map_err(|error| Error::Codec(format!("relay upload: {error}")))?;
            if response.status() == StatusCode::CONFLICT {
                return Err(Error::Codec("relay epoch changed during upload".into()));
            }
            if !response.status().is_success() {
                return Err(response_error(response));
            }
            Ok(())
        })?;
        let ids: Vec<String> =
            serde_json::from_str(&ids_json).map_err(|error| Error::Codec(error.to_string()))?;
        let tx = conn.unchecked_transaction()?;
        {
            let mut mark =
                tx.prepare("INSERT OR IGNORE INTO sync_relay_known_ops (op_id) VALUES (?1)")?;
            for id in &ids {
                mark.execute(params![id])?;
            }
        }
        tx.execute(
            "DELETE FROM sync_relay_outbox WHERE batch_id = ?1",
            params![batch_id],
        )?;
        tx.commit()?;
        pushed += ids.len();
    }
    Ok(pushed)
}

fn commit_checkpoint(
    conn: &Connection,
    client: &Client,
    base: &str,
    key: &SyncKey,
    epoch: &str,
    latest_sequence: i64,
    gate: &mut impl NetworkDatabaseGate,
) -> Result<bool> {
    checkpoint_operation_log_preserving_history(conn)?;
    upload_current_checkpoint(conn, client, base, key, epoch, latest_sequence, gate)
}

fn upload_current_checkpoint(
    conn: &Connection,
    client: &Client,
    base: &str,
    key: &SyncKey,
    epoch: &str,
    latest_sequence: i64,
    gate: &mut impl NetworkDatabaseGate,
) -> Result<bool> {
    let new_epoch = random_token();
    let upload_id = random_token();
    let checkpoint_ops = all_ops(conn)?;
    let ciphertext = seal(
        key,
        &RelayEnvelope {
            v: PROTOCOL_VERSION,
            epoch: new_epoch.clone(),
            ops: checkpoint_ops.clone(),
        },
    )?;
    let chunks = ciphertext.len().div_ceil(CHECKPOINT_CHUNK_BYTES);
    let start = CheckpointStart {
        upload_id: &upload_id,
        expected_epoch: epoch,
        expected_latest_sequence: latest_sequence,
        new_epoch: &new_epoch,
        chunks,
        byte_length: ciphertext.len(),
    };
    let started = gate.without_database_lock(|| {
        let response = client
            .post(format!("{base}/v3/checkpoints/start"))
            .json(&start)
            .send()
            .map_err(|error| Error::Codec(format!("checkpoint start: {error}")))?;
        if response.status() == StatusCode::CONFLICT {
            return Ok(false);
        }
        if !response.status().is_success() {
            return Err(response_error(response));
        }
        Ok(true)
    })?;
    if !started {
        return Ok(false);
    }
    for (index, chunk) in ciphertext.chunks(CHECKPOINT_CHUNK_BYTES).enumerate() {
        gate.without_database_lock(|| {
            let response = client
                .put(format!("{base}/v3/checkpoints/{upload_id}/{index}"))
                .header("content-type", "application/octet-stream")
                .body(chunk.to_vec())
                .send()
                .map_err(|error| Error::Codec(format!("checkpoint upload: {error}")))?;
            if !response.status().is_success() {
                return Err(response_error(response));
            }
            Ok(())
        })?;
    }
    let commit = CheckpointCommit {
        upload_id: &upload_id,
        expected_epoch: epoch,
        expected_latest_sequence: latest_sequence,
        new_epoch: &new_epoch,
    };
    let committed = gate.without_database_lock(|| {
        let response = client
            .post(format!("{base}/v3/checkpoints/commit"))
            .json(&commit)
            .send()
            .map_err(|error| Error::Codec(format!("checkpoint commit: {error}")))?;
        if response.status() == StatusCode::CONFLICT {
            return Ok(false);
        }
        if !response.status().is_success() {
            return Err(response_error(response));
        }
        Ok(true)
    })?;
    if !committed {
        return Ok(false);
    }
    conn.execute("DELETE FROM sync_relay_known_ops", [])?;
    conn.execute("DELETE FROM sync_relay_outbox", [])?;
    set_relay_state(conn, &new_epoch, 0)?;
    // Local edits can be persisted while checkpoint chunks are in flight. Only
    // operations actually present in the uploaded checkpoint are known; newer
    // ones must remain eligible for the next incremental outbox.
    mark_known(conn, &checkpoint_ops)?;
    Ok(true)
}

pub fn sync_once(
    conn: &Connection,
    relay_url: &str,
    key: &SyncKey,
    options: SyncOptions,
) -> Result<SyncPassResult> {
    let mut gate = ContinuousDatabaseAccess;
    sync_once_with_network_gate(conn, relay_url, key, options, &mut gate)
}

pub(crate) fn sync_once_with_network_gate(
    conn: &Connection,
    relay_url: &str,
    key: &SyncKey,
    options: SyncOptions,
    gate: &mut impl NetworkDatabaseGate,
) -> Result<SyncPassResult> {
    ensure_relay_tables(conn)?;
    prune_obsolete_relay_rows(conn)?;
    let result = sync_once_inner(conn, relay_url, key, options, gate);
    if let Err(error) = &result {
        let _ = conn.execute(
            "UPDATE sync_relay_state SET last_error = ?1 WHERE singleton = 1",
            params![error.to_string()],
        );
    }
    result
}

fn sync_once_inner(
    conn: &Connection,
    relay_url: &str,
    key: &SyncKey,
    options: SyncOptions,
    gate: &mut impl NetworkDatabaseGate,
) -> Result<SyncPassResult> {
    ensure_relay_tables(conn)?;
    let client = relay_http_client(options)?;
    let base = relay_url.trim_end_matches('/');
    let device_id = crate::metadata_value(conn, "device_id")
        .map_err(Error::Codec)?
        .unwrap_or_default();
    let device = device_token(key, &device_id);
    let (local_epoch, cursor) = relay_state(conn)?;
    let mut download_budget = DownloadBudget::for_options(options);
    let first = manifest(&client, base, &local_epoch, cursor, gate)?;
    let (first_pulled, first_changed) = apply_manifest_with_budget_and_gate(
        conn,
        &client,
        base,
        key,
        &first,
        &local_epoch,
        &mut download_budget,
        gate,
    )?;
    let mut pulled = first_pulled;
    let mut changed = first_changed;

    // A hard generation limit can reject further deltas. Compact immediately
    // after pulling when the manifest asks, before attempting an upload; the
    // checkpoint already includes every local pending operation.
    if options.allow_checkpoint
        && checkpoint_safe(conn)?
        && first.compact_recommended
        && commit_checkpoint(
            conn,
            &client,
            base,
            key,
            &first.epoch,
            first.latest_sequence,
            gate,
        )?
    {
        let (epoch, latest_sequence) = relay_state(conn)?;
        conn.execute(
            "UPDATE sync_relay_state SET last_success_ms = ?1, last_error = NULL WHERE singleton = 1",
            params![crate::current_timestamp_ms()],
        )?;
        return Ok(SyncPassResult {
            pulled_operations: pulled,
            pushed_operations: 0,
            state_changed: changed,
            checkpoint_committed: true,
            epoch,
            latest_sequence,
        });
    }

    let active_epoch = relay_state(conn)?.0;
    if stage_outbox(conn, key, &active_epoch)? {
        let latest_sequence = relay_state(conn)?.1;
        if !options.allow_checkpoint {
            return Err(Error::Codec(
                "one incremental operation is too large and checkpoint promotion is disabled"
                    .into(),
            ));
        }
        if !checkpoint_safe(conn)? {
            return Err(Error::Codec(
                "a quarantined relay batch prevents safe checkpoint promotion; sync another device to compact it".into(),
            ));
        }
        if commit_checkpoint(
            conn,
            &client,
            base,
            key,
            &active_epoch,
            latest_sequence,
            gate,
        )? {
            let (epoch, latest_sequence) = relay_state(conn)?;
            conn.execute(
                "UPDATE sync_relay_state SET last_success_ms = ?1, last_error = NULL WHERE singleton = 1",
                params![crate::current_timestamp_ms()],
            )?;
            return Ok(SyncPassResult {
                pulled_operations: pulled,
                pushed_operations: 0,
                state_changed: changed,
                checkpoint_committed: true,
                epoch,
                latest_sequence,
            });
        }
        return Err(Error::Codec(
            "relay changed while uploading a large checkpoint; retry sync".into(),
        ));
    }
    let pushed = upload_outbox(conn, &client, base, &device, &active_epoch, gate)?;

    let cursor = relay_state(conn)?.1;
    let second = manifest(&client, base, &active_epoch, cursor, gate)?;
    let (second_pulled, second_changed) = apply_manifest_with_budget_and_gate(
        conn,
        &client,
        base,
        key,
        &second,
        &active_epoch,
        &mut download_budget,
        gate,
    )?;
    pulled += second_pulled;
    changed |= second_changed;

    let checkpoint_committed = options.allow_checkpoint
        && checkpoint_safe(conn)?
        && second.compact_recommended
        && commit_checkpoint(
            conn,
            &client,
            base,
            key,
            &second.epoch,
            second.latest_sequence,
            gate,
        )?;
    let (epoch, latest_sequence) = relay_state(conn)?;
    conn.execute(
        "UPDATE sync_relay_state SET last_success_ms = ?1, last_error = NULL WHERE singleton = 1",
        params![crate::current_timestamp_ms()],
    )?;
    Ok(SyncPassResult {
        pulled_operations: pulled,
        pushed_operations: pushed,
        state_changed: changed,
        checkpoint_committed,
        epoch,
        latest_sequence,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::RngCore;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn relay_database() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE operations (
                   id TEXT PRIMARY KEY,
                   device_id TEXT NOT NULL,
                   sequence INTEGER NOT NULL,
                   type TEXT NOT NULL,
                   timestamp TEXT NOT NULL,
                   payload_json TEXT NOT NULL
                 );
                 CREATE TABLE history_entries (
                   id TEXT PRIMARY KEY,
                   operation_id TEXT NOT NULL UNIQUE,
                   device_id TEXT NOT NULL,
                   sequence INTEGER NOT NULL,
                   undo_operation_json TEXT NOT NULL,
                   redo_operation_json TEXT NOT NULL,
                   undone INTEGER NOT NULL DEFAULT 0,
                   created_at_ms INTEGER NOT NULL,
                   updated_at_ms INTEGER NOT NULL
                 );",
            )
            .unwrap();
        ensure_relay_tables(&connection).unwrap();
        connection
    }

    fn insert_op(connection: &Connection, id: &str, payload: &str) {
        connection
            .execute(
                "INSERT INTO operations (id, device_id, sequence, type, timestamp, payload_json)
                 VALUES (?1, 'device-A', 1, 'test', '2026-08-01T00:00:00Z', ?2)",
                params![id, payload],
            )
            .unwrap();
    }

    #[test]
    fn relay_rejects_retired_envelope_protocols() {
        let connection = relay_database();
        let key = SyncKey::generate();
        let ciphertext = seal(
            &key,
            &RelayEnvelope {
                v: PROTOCOL_VERSION - 1,
                epoch: "epoch-1".into(),
                ops: Vec::new(),
            },
        )
        .unwrap();

        let error = apply_ciphertext(&connection, &key, "epoch-1", &ciphertext).unwrap_err();
        assert!(error.to_string().contains("incompatible protocol metadata"));
    }

    #[test]
    fn foreground_joiner_has_an_unlimited_download_budget() {
        let foreground_joiner = SyncOptions::foreground(false);
        let mut budget = DownloadBudget::for_options(foreground_joiner);

        assert!(!foreground_joiner.allow_checkpoint);
        assert!(budget.reserve(BACKGROUND_MAX_DOWNLOAD_CHUNKS + 1));
    }

    #[test]
    fn background_poll_does_not_budget_an_already_applied_checkpoint() {
        let connection = relay_database();
        connection
            .execute(
                "UPDATE sync_relay_state SET epoch = 'epoch-1', cursor = 4 WHERE singleton = 1",
                [],
            )
            .unwrap();
        let manifest = Manifest {
            epoch: "epoch-1".into(),
            latest_sequence: 4,
            checkpoint: Some(BlobDescriptor {
                id: "already-applied-large-checkpoint".into(),
                chunks: BACKGROUND_MAX_DOWNLOAD_CHUNKS + 1,
            }),
            batches: Vec::new(),
            compact_recommended: false,
        };
        let mut budget = DownloadBudget::for_options(SyncOptions::background());

        assert_eq!(
            apply_manifest_with_budget(
                &connection,
                &Client::new(),
                "http://127.0.0.1:1",
                &SyncKey::generate(),
                &manifest,
                "epoch-1",
                &mut budget,
            )
            .unwrap(),
            (0, false)
        );
        assert_eq!(
            budget.remaining_chunks,
            Some(BACKGROUND_MAX_DOWNLOAD_CHUNKS)
        );
    }

    #[test]
    fn foreground_relay_requests_time_out_without_waiting_for_a_stalled_server() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 2048];
            let _ = stream.read(&mut request).unwrap();
            std::thread::sleep(Duration::from_millis(250));
        });
        let timeout = Duration::from_millis(40);
        let client = relay_http_client_with_timeouts(timeout, timeout).unwrap();
        let started = std::time::Instant::now();

        let error = client
            .get(format!("http://{address}/stalled"))
            .send()
            .unwrap_err();
        let elapsed = started.elapsed();
        server.join().unwrap();

        assert!(error.is_timeout(), "expected a timeout, got {error}");
        assert!(
            elapsed < Duration::from_millis(200),
            "stalled request exceeded its timeout budget: {elapsed:?}"
        );
        assert!(FOREGROUND_REQUEST_TIMEOUT < BACKGROUND_REQUEST_TIMEOUT);
    }

    #[test]
    fn obsolete_relay_rows_are_pruned_after_operation_compaction() {
        let connection = relay_database();
        insert_op(&connection, "live-op", "{}");
        for id in ["live-op", "compacted-op"] {
            connection
                .execute(
                    "INSERT INTO sync_relay_known_ops (op_id) VALUES (?1)",
                    params![id],
                )
                .unwrap();
        }
        connection
            .execute(
                "INSERT INTO sync_relay_outbox (batch_id, epoch, ciphertext, op_ids_json)
                 VALUES ('live-batch', 'epoch-1', x'01', '[\"live-op\"]'),
                        ('stale-batch', 'epoch-1', x'02', '[\"compacted-op\"]')",
                [],
            )
            .unwrap();

        assert_eq!(prune_obsolete_relay_rows(&connection).unwrap(), (1, 1));
        assert_eq!(
            connection
                .query_row("SELECT op_id FROM sync_relay_known_ops", [], |row| {
                    row.get::<_, String>(0)
                })
                .unwrap(),
            "live-op"
        );
        assert_eq!(
            connection
                .query_row("SELECT batch_id FROM sync_relay_outbox", [], |row| {
                    row.get::<_, String>(0)
                })
                .unwrap(),
            "live-batch"
        );
    }

    #[test]
    fn a_failed_batch_is_not_acknowledged_past_the_cursor() {
        let connection = relay_database();
        connection
            .execute(
                "UPDATE sync_relay_state SET epoch = 'epoch-1', cursor = 0 WHERE singleton = 1",
                [],
            )
            .unwrap();

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 2048];
            let length = stream.read(&mut request).unwrap();
            assert!(
                String::from_utf8_lossy(&request[..length])
                    .starts_with("GET /v3/blobs/missing-batch/0 "),
                "client requested the expected missing batch"
            );
            let body = br#"{"error":"temporarily unavailable"}"#;
            write!(
                stream,
                "HTTP/1.1 503 Service Unavailable\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            stream.write_all(body).unwrap();
        });

        let manifest = Manifest {
            epoch: "epoch-1".into(),
            latest_sequence: 1,
            checkpoint: None,
            batches: vec![BatchDescriptor {
                id: "missing-batch".into(),
                sequence: 1,
                chunks: 1,
            }],
            compact_recommended: false,
        };
        let client = Client::builder().build().unwrap();
        let key = SyncKey::generate();

        let error = apply_manifest(
            &connection,
            &client,
            &format!("http://{address}"),
            &key,
            &manifest,
            "epoch-1",
        )
        .unwrap_err();
        server.join().unwrap();

        assert!(error.to_string().contains("503 Service Unavailable"));
        assert_eq!(
            relay_state(&connection).unwrap(),
            ("epoch-1".into(), 0),
            "a failed batch must remain behind the cursor so the next sync retries it"
        );
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM sync_relay_quarantine", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            1
        );

        let ciphertext = seal(
            &key,
            &RelayEnvelope {
                v: PROTOCOL_VERSION,
                epoch: "epoch-1".into(),
                ops: Vec::new(),
            },
        )
        .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let retry_address = listener.local_addr().unwrap();
        let retry_server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0_u8; 2048];
            let length = stream.read(&mut request).unwrap();
            assert!(
                String::from_utf8_lossy(&request[..length])
                    .starts_with("GET /v3/blobs/missing-batch/0 "),
                "the next pass retries the same batch"
            );
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                ciphertext.len()
            )
            .unwrap();
            stream.write_all(&ciphertext).unwrap();
        });

        assert_eq!(
            apply_manifest(
                &connection,
                &client,
                &format!("http://{retry_address}"),
                &key,
                &manifest,
                "epoch-1",
            )
            .unwrap(),
            (0, false)
        );
        retry_server.join().unwrap();
        assert_eq!(
            relay_state(&connection).unwrap(),
            ("epoch-1".into(), 1),
            "the cursor advances after the retried batch succeeds"
        );
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM sync_relay_quarantine", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0,
            "a successful retry clears its quarantine record"
        );
    }

    #[test]
    fn durable_outbox_does_not_restage_operations_while_an_ack_is_pending() {
        let connection = relay_database();
        insert_op(&connection, "op-1", "{}");
        let key = SyncKey::generate();

        assert!(!stage_outbox(&connection, &key, "epoch-1").unwrap());
        assert!(!stage_outbox(&connection, &key, "epoch-1").unwrap());
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM sync_relay_outbox", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            1,
        );
    }

    #[test]
    fn a_single_large_operation_requests_chunked_checkpoint_promotion() {
        let connection = relay_database();
        let mut random = vec![0u8; 800 * 1024];
        rand::rngs::OsRng.fill_bytes(&mut random);
        insert_op(&connection, "large-op", &super::super::hex(&random));

        assert!(stage_outbox(&connection, &SyncKey::generate(), "epoch-1").unwrap());
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM sync_relay_outbox", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0,
        );
    }

    #[test]
    fn delayed_parallel_download_failures_never_skip_a_cursor_sequence() {
        const BATCHES: usize = PARALLEL_BATCH_DOWNLOADS * 2 + 1;
        for seed in [1_u64, 17, 991] {
            for failed_sequence in 1..=BATCHES {
                let connection = relay_database();
                set_relay_state(&connection, "epoch-1", 0).unwrap();
                let key = SyncKey::generate();
                let ciphertext = seal(&key, &RelayEnvelope {
                    v: PROTOCOL_VERSION,
                    epoch: "epoch-1".into(),
                    ops: Vec::new(),
                }).unwrap();
                let wrong_epoch = seal(&key, &RelayEnvelope {
                    v: PROTOCOL_VERSION,
                    epoch: "stale-epoch".into(),
                    ops: Vec::new(),
                }).unwrap();
                let manifest = Manifest {
                    epoch: "epoch-1".into(),
                    latest_sequence: BATCHES as i64,
                    checkpoint: None,
                    batches: (1..=BATCHES).map(|sequence| BatchDescriptor {
                        id: format!("batch-{sequence}"),
                        sequence: sequence as i64,
                        chunks: 1,
                    }).collect(),
                    compact_recommended: false,
                };
                for retry in [false, true] {
                    let cursor = relay_state(&connection).unwrap().1 as usize;
                    let requests = if retry { BATCHES - cursor } else {
                        failed_sequence.div_ceil(PARALLEL_BATCH_DOWNLOADS)
                            .saturating_mul(PARALLEL_BATCH_DOWNLOADS).min(BATCHES)
                    };
                    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
                    let address = listener.local_addr().unwrap();
                    let ciphertext = ciphertext.clone();
                    let wrong_epoch = wrong_epoch.clone();
                    let server = std::thread::spawn(move || {
                        std::thread::scope(|scope| {
                            for _ in 0..requests {
                                let (mut stream, _) = listener.accept().unwrap();
                                let ciphertext = &ciphertext;
                                let wrong_epoch = &wrong_epoch;
                                scope.spawn(move || {
                                    let mut request = [0_u8; 2048];
                                    let length = stream.read(&mut request).unwrap();
                                    let request = String::from_utf8_lossy(&request[..length]);
                                    let sequence: usize = request.split("/batch-").nth(1)
                                        .unwrap().split('/').next().unwrap().parse().unwrap();
                                    // A deterministic seeded delay makes HTTP completion order
                                    // differ from manifest order, including across group edges.
                                    let delay = (sequence as u64).wrapping_mul(6364136223846793005)
                                        .wrapping_add(seed) % 5;
                                    std::thread::sleep(Duration::from_millis(delay));
                                    let failed = !retry && sequence == failed_sequence;
                                    let status = if failed && seed == 1 { "503 Service Unavailable" } else { "200 OK" };
                                    let bytes = if failed {
                                        match seed {
                                            991 => wrong_epoch.as_slice(),
                                            _ => b"unavailable or corrupted ciphertext".as_slice(),
                                        }
                                    } else { ciphertext.as_slice() };
                                    write!(stream, "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", bytes.len()).unwrap();
                                    stream.write_all(bytes).unwrap();
                                });
                            }
                        });
                    });
                    let result = apply_manifest(&connection, &Client::new(),
                        &format!("http://{address}"), &key, &manifest, "epoch-1");
                    server.join().unwrap();
                    if retry {
                        result.unwrap();
                        assert_eq!(relay_state(&connection).unwrap().1, BATCHES as i64);
                        assert!(checkpoint_safe(&connection).unwrap());
                    } else {
                        assert!(result.is_err(), "seed {seed}, failed sequence {failed_sequence}");
                        assert_eq!(relay_state(&connection).unwrap().1, failed_sequence as i64 - 1,
                            "seed {seed}: later successful parallel downloads must not hide a hole");
                        assert!(!checkpoint_safe(&connection).unwrap());
                    }
                }
            }
        }
    }

}
