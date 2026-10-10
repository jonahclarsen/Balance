//! Device-local list compression. Logical JSON, operations and checkpoints never
//! contain codec bytes or dictionary IDs. SQLCipher encrypts these tables too.
use rusqlite::{params, types::Value as SqlValue, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;

const MAGIC: &[u8; 8] = b"BLZSTD01";
const HEADER: usize = 20;
const MAX_RECORD: usize = 16 * 1024 * 1024;
const MAX_DICTIONARY: usize = 64 * 1024;
const DAY: i64 = 86_400_000;
const CHECK_INTERVAL: i64 = 90 * DAY;
const BATCH: usize = 24;
const BATCH_BYTES: usize = 2 * 1024 * 1024;

fn error(e: impl std::fmt::Display) -> String {
    format!("List storage: {e}")
}

fn hash(bytes: &[u8]) -> String {
    data_encoding::HEXLOWER.encode(&Sha256::digest(bytes))
}

// Savepoints compose with operation/checkpoint transactions. A failed write must
// never leave half an entity, a dictionary reference, or a policy change behind.
fn atomic<T>(conn: &Connection, name: &str, body: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    conn.execute_batch(&format!("SAVEPOINT {name}")).map_err(error)?;
    match body() {
        Ok(value) => {
            conn.execute_batch(&format!("RELEASE {name}")).map_err(error)?;
            Ok(value)
        }
        Err(failure) => {
            conn.execute_batch(&format!("ROLLBACK TO {name}; RELEASE {name}")).map_err(error)?;
            Err(failure)
        }
    }
}

pub fn register(conn: &Connection) -> Result<(), String> {
    conn.create_scalar_function(
        "balance_list_storage_v1_required", 0,
        rusqlite::functions::FunctionFlags::SQLITE_UTF8
            | rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC
            | rusqlite::functions::FunctionFlags::SQLITE_INNOCUOUS,
        |_| Ok(1_i64),
    ).map_err(error)
}

/// Additive, atomic schema migration; converting old list payloads is deferred
/// to bounded idle batches. Old plaintext backups remain readable without DDL.
pub fn initialize(conn: &Connection) -> Result<(), String> {
    if let Some(version) = crate::metadata_value(conn, "list_storage_version")? {
        return if version == "1" { Ok(()) } else { Err(error("Update required: newer list storage format")) };
    }
    atomic(conn, "list_storage_schema", || {
        conn.execute_batch("
            CREATE TABLE list_storage_dictionaries (
                id INTEGER PRIMARY KEY, hash TEXT NOT NULL UNIQUE,
                bytes BLOB NOT NULL CHECK(length(bytes) <= 65536), created_at_ms INTEGER NOT NULL);
            CREATE TABLE list_storage_policies (
                template_id TEXT PRIMARY KEY,
                active_dictionary INTEGER NOT NULL REFERENCES list_storage_dictionaries(id),
                checked_source_hash TEXT NOT NULL, checked_at_ms INTEGER NOT NULL);
            CREATE INDEX idx_list_storage_policy_due ON list_storage_policies(checked_at_ms);
            CREATE TABLE list_storage_records (
                collection TEXT NOT NULL CHECK(collection = 'lists'), entity_key TEXT NOT NULL,
                template_id TEXT, date TEXT,
                dictionary_id INTEGER REFERENCES list_storage_dictionaries(id),
                PRIMARY KEY(collection, entity_key),
                FOREIGN KEY(collection, entity_key) REFERENCES state_entities(collection, entity_key) ON DELETE CASCADE);
            CREATE INDEX idx_list_storage_samples ON list_storage_records(template_id, date DESC);
            CREATE INDEX idx_list_storage_dictionary ON list_storage_records(dictionary_id);
            CREATE TRIGGER list_storage_immutable BEFORE UPDATE ON list_storage_dictionaries
                BEGIN SELECT RAISE(ABORT, 'List storage dictionaries are immutable'); END;
        ").map_err(error)?;
        // Prior binaries always write metadata when opening a database. They
        // cannot silently overwrite compressed lists: the unavailable function
        // stops their open/write transaction with an update-required name.
        for table in ["metadata", "state_entities"] {
            for action in ["INSERT", "UPDATE", "DELETE"] {
                conn.execute_batch(&format!("CREATE TRIGGER list_storage_guard_{table}_{action}
                    BEFORE {action} ON {table} BEGIN SELECT balance_list_storage_v1_required(); END;"))
                    .map_err(error)?;
            }
        }
        crate::set_metadata(conn, "list_storage_version", "1")
    })
}

fn dictionary(conn: &Connection, id: i64) -> Result<Vec<u8>, String> {
    let (digest, bytes): (String, Vec<u8>) = conn.query_row(
        "SELECT hash, bytes FROM list_storage_dictionaries WHERE id=?1", [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ).map_err(|_| error("Missing dictionary; restore a complete backup or update Balance"))?;
    if bytes.len() > MAX_DICTIONARY || hash(&bytes) != digest {
        return Err(error("Dictionary integrity check failed"));
    }
    Ok(bytes)
}

pub struct Reader<'a> {
    conn: &'a Connection,
    decoders: HashMap<i64, zstd::bulk::Decompressor<'static>>,
}

impl<'a> Reader<'a> {
    pub fn new(conn: &'a Connection) -> Self { Self { conn, decoders: HashMap::new() } }

    pub fn read(&mut self, stored: SqlValue) -> Result<Value, String> {
        match stored {
            SqlValue::Text(raw) => serde_json::from_str(&raw).map_err(error),
            SqlValue::Blob(bytes) => {
                if bytes.len() <= HEADER || &bytes[..8] != MAGIC {
                    return Err(error("Update required or damaged compressed record"));
                }
                let id = i64::from_le_bytes(bytes[8..16].try_into().unwrap());
                let size = u32::from_le_bytes(bytes[16..20].try_into().unwrap()) as usize;
                if id < 0 || size == 0 || size > MAX_RECORD || bytes.len() > MAX_RECORD + HEADER {
                    return Err(error("Invalid compressed record bounds"));
                }
                if !self.decoders.contains_key(&id) {
                    // Bound per-scan dictionary contexts too; very long-lived
                    // databases can contain many immutable dictionary versions.
                    if self.decoders.len() >= 16 { self.decoders.clear(); }
                    let dict = if id == 0 { Vec::new() } else { dictionary(self.conn, id)? };
                    let mut decoder = zstd::bulk::Decompressor::with_dictionary(&dict).map_err(error)?;
                    decoder.window_log_max(24).map_err(error)?;
                    self.decoders.insert(id, decoder);
                }
                let decoded = self.decoders.get_mut(&id).unwrap()
                    .decompress(&bytes[HEADER..], size).map_err(error)?;
                if decoded.len() != size { return Err(error("Compressed record length mismatch")); }
                serde_json::from_slice(&decoded).map_err(error)
            }
            _ => Err(error("Invalid stored entity type")),
        }
    }
}

fn compress(raw: &[u8], dict: &[u8]) -> Result<Vec<u8>, String> {
    let mut compressor = zstd::bulk::Compressor::with_dictionary(3, dict).map_err(error)?;
    compressor.include_checksum(true).map_err(error)?;
    compressor.compress(raw).map_err(error)
}

fn source(conn: &Connection, template_id: &str) -> Result<Option<Vec<u8>>, String> {
    let raw = conn.query_row("SELECT value_json FROM state_entities WHERE collection='listTemplates' AND entity_key=?1",
                             [template_id], |r| r.get::<_, SqlValue>(0)).optional().map_err(error)?;
    raw.map(|raw| Reader::new(conn).read(raw).and_then(|value| {
        // Only source content matters; names and updatedAt must not trigger work.
        serde_json::to_vec(value.get("items").unwrap_or(&Value::Null)).map_err(error)
    })).transpose()
}

fn dictionary_bytes(source: &[u8]) -> &[u8] {
    &source[source.len().saturating_sub(MAX_DICTIONARY)..]
}

fn install_dictionary(conn: &Connection, bytes: &[u8], now: i64) -> Result<i64, String> {
    let digest = hash(bytes);
    conn.execute("INSERT OR IGNORE INTO list_storage_dictionaries(hash,bytes,created_at_ms) VALUES(?1,?2,?3)",
                 params![digest, bytes, now]).map_err(error)?;
    conn.query_row("SELECT id FROM list_storage_dictionaries WHERE hash=?1", [digest], |r| r.get(0)).map_err(error)
}

fn active_dictionary(conn: &Connection, template_id: &str, now: i64) -> Result<Option<i64>, String> {
    let existing = conn.query_row("SELECT active_dictionary FROM list_storage_policies WHERE template_id=?1",
                                 [template_id], |r| r.get(0)).optional().map_err(error)?;
    if existing.is_some() { return Ok(existing); }
    let Some(source) = source(conn, template_id)? else { return Ok(None); };
    if source.len() < 512 { return Ok(None); }
    let id = install_dictionary(conn, dictionary_bytes(&source), now)?;
    conn.execute("INSERT INTO list_storage_policies VALUES(?1,?2,?3,?4)",
                 params![template_id, id, hash(&source), now]).map_err(error)?;
    Ok(Some(id))
}

/// All generic entity writers use this function, including old operation
/// versions, replay, undo and restore. Other collections retain ordinary JSON.
pub fn write(conn: &Connection, collection: &str, key: &str, position: i64, value: &Value) -> Result<(), String> {
    write_at(conn, collection, key, position, value, crate::current_timestamp_ms())
}

fn write_at(conn: &Connection, collection: &str, key: &str, position: i64, value: &Value, now: i64) -> Result<(), String> {
    atomic(conn, "list_storage_write", || {
        let raw = value.to_string();
        let mut stored = SqlValue::Text(raw.clone());
        let mut used_dictionary = None;
        let template = value.get("listTemplateId").and_then(Value::as_str);
        if collection == "lists" && (512..=MAX_RECORD).contains(&raw.len()) {
            let id = template.map(|id| active_dictionary(conn, id, now)).transpose()?.flatten();
            let dict = id.map(|id| dictionary(conn, id)).transpose()?.unwrap_or_default();
            let encoded = compress(raw.as_bytes(), &dict)?;
            // Tiny/incompressible records stay text. This also prevents codec
            // overhead from growing the database for small future data shapes.
            if encoded.len() + HEADER + 32 < raw.len() {
                let mut bytes = MAGIC.to_vec();
                bytes.extend_from_slice(&id.unwrap_or(0).to_le_bytes());
                bytes.extend_from_slice(&(raw.len() as u32).to_le_bytes());
                bytes.extend_from_slice(&encoded);
                stored = SqlValue::Blob(bytes);
                used_dictionary = id;
            }
        }
        conn.execute("INSERT INTO state_entities(collection,entity_key,position,value_json) VALUES(?1,?2,?3,?4)
            ON CONFLICT(collection,entity_key) DO UPDATE SET position=excluded.position,value_json=excluded.value_json",
            params![collection, key, position, stored]).map_err(error)?;
        if collection == "lists" {
            let date = value.get("date").and_then(Value::as_str)
                .filter(|s| s.len() == 10 && chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok());
            conn.execute("INSERT INTO list_storage_records VALUES('lists',?1,?2,?3,?4)
                ON CONFLICT(collection,entity_key) DO UPDATE SET template_id=excluded.template_id,date=excluded.date,dictionary_id=excluded.dictionary_id",
                params![key, template, date, used_dictionary]).map_err(error)?;
        }
        Ok(())
    })
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Maintenance {
    pub converted: usize,
    pub evaluated: bool,
    pub adopted: bool,
    pub more: bool,
}

fn pending(conn: &Connection) -> Result<bool, String> {
    conn.query_row("SELECT EXISTS(SELECT 1 FROM state_entities e WHERE collection='lists'
        AND NOT EXISTS(SELECT 1 FROM list_storage_records r WHERE r.collection=e.collection AND r.entity_key=e.entity_key))",
        [], |r| r.get(0)).map_err(error)
}

/// Runs only during foreground idle time. A bounded batch makes progress through
/// old records, followed by at most one due dictionary evaluation per call.
pub fn maintain(conn: &Connection, now: i64, today: chrono::NaiveDate) -> Result<Maintenance, String> {
    atomic(conn, "list_storage_maintenance", || {
        let mut outcome = Maintenance::default();
        let mut stmt = conn.prepare("SELECT entity_key,position,value_json FROM state_entities e WHERE collection='lists'
            AND NOT EXISTS(SELECT 1 FROM list_storage_records r WHERE r.collection=e.collection AND r.entity_key=e.entity_key)
            ORDER BY position LIMIT ?1").map_err(error)?;
        let rows = stmt.query_map([BATCH as i64], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, SqlValue>(2)?)))
            .map_err(error)?.collect::<Result<Vec<_>, _>>().map_err(error)?;
        drop(stmt);
        let mut bytes = 0;
        let mut reader = Reader::new(conn);
        for (key, position, raw) in rows {
            let value = reader.read(raw)?;
            bytes += value.to_string().len();
            write_at(conn, "lists", &key, position, &value, now)?;
            outcome.converted += 1;
            if bytes >= BATCH_BYTES { break; }
        }
        outcome.more = pending(conn)?;
        if !outcome.more {
            if let Some(template) = conn.query_row("SELECT template_id FROM list_storage_policies WHERE checked_at_ms <= ?1 ORDER BY checked_at_ms LIMIT 1",
                [now.saturating_sub(CHECK_INTERVAL)], |r| r.get::<_, String>(0)).optional().map_err(error)? {
                outcome.evaluated = true;
                outcome.adopted = evaluate(conn, &template, now, today)?;
            }
            outcome.more = conn.query_row("SELECT EXISTS(SELECT 1 FROM list_storage_policies WHERE checked_at_ms <= ?1)",
                [now.saturating_sub(CHECK_INTERVAL)], |r| r.get(0)).map_err(error)?;
        }
        // Collection is cheap and indexed, and never removes an active or used
        // dictionary. Backup copies carry their own complete dictionary tables.
        conn.execute("DELETE FROM list_storage_policies WHERE NOT EXISTS(SELECT 1 FROM state_entities WHERE collection='listTemplates' AND entity_key=template_id)
            AND NOT EXISTS(SELECT 1 FROM list_storage_records WHERE list_storage_records.template_id=list_storage_policies.template_id)", []).map_err(error)?;
        conn.execute("DELETE FROM list_storage_dictionaries WHERE NOT EXISTS(SELECT 1 FROM list_storage_records WHERE dictionary_id=list_storage_dictionaries.id)
            AND NOT EXISTS(SELECT 1 FROM list_storage_policies WHERE active_dictionary=list_storage_dictionaries.id)", []).map_err(error)?;
        Ok(outcome)
    })
}

fn evaluate(conn: &Connection, template: &str, now: i64, today: chrono::NaiveDate) -> Result<bool, String> {
    let (active, checked_hash): (i64, String) = conn.query_row(
        "SELECT active_dictionary,checked_source_hash FROM list_storage_policies WHERE template_id=?1", [template],
        |r| Ok((r.get(0)?, r.get(1)?))).map_err(error)?;
    // Even insufficient samples or an unchanged template wait another 90 days.
    conn.execute("UPDATE list_storage_policies SET checked_at_ms=?1 WHERE template_id=?2", params![now, template]).map_err(error)?;
    let Some(source) = source(conn, template)? else { return Ok(false); };
    let source_hash = hash(&source);
    if source_hash == checked_hash { return Ok(false); }
    conn.execute("UPDATE list_storage_policies SET checked_source_hash=?1 WHERE template_id=?2", params![source_hash, template]).map_err(error)?;
    let candidate = dictionary_bytes(&source);
    let incumbent = dictionary(conn, active)?;
    if candidate == incumbent { return Ok(false); }
    let mut stmt = conn.prepare("SELECT e.value_json FROM list_storage_records r JOIN state_entities e
        ON e.collection=r.collection AND e.entity_key=r.entity_key
        WHERE r.template_id=?1 AND r.date<=?2 ORDER BY r.date DESC,r.entity_key LIMIT 30").map_err(error)?;
    let stored = stmt.query_map(params![template, today.to_string()], |r| r.get::<_, SqlValue>(0))
        .map_err(error)?.collect::<Result<Vec<_>, _>>().map_err(error)?;
    if stored.len() < 30 { return Ok(false); }
    let mut reader = Reader::new(conn);
    let (mut old_size, mut new_size) = (0_u64, 0_u64);
    for row in stored {
        let raw = reader.read(row)?.to_string();
        // Keep evaluation work bounded even for unusually huge imported lists.
        if raw.len() > 256 * 1024 { return Ok(false); }
        old_size += (compress(raw.as_bytes(), &incumbent)?.len() + HEADER).min(raw.len()) as u64;
        new_size += (compress(raw.as_bytes(), candidate)?.len() + HEADER).min(raw.len()) as u64;
    }
    let recent_days: u64 = conn.query_row("SELECT count(DISTINCT date) FROM list_storage_records
        WHERE template_id=?1 AND date>?2 AND date<=?3", params![template, (today - chrono::Duration::days(180)).to_string(), today.to_string()], |r| r.get(0)).map_err(error)?;
    // Conservative full cost even if identical bytes already exist. Include one
    // SQLite page for dictionary/row/index overhead. Recent use estimates future
    // use; inactive/rarely-used templates must not generate needless versions.
    let cost = candidate.len() as u64 + 4096;
    if new_size * 100 > old_size * 80 || (old_size - new_size) * recent_days <= cost * 30 {
        return Ok(false);
    }
    let id = install_dictionary(conn, candidate, now)?;
    conn.execute("UPDATE list_storage_policies SET active_dictionary=?1 WHERE template_id=?2", params![id, template]).map_err(error)?;
    Ok(true)
}

#[cfg(test)]
mod tests;
