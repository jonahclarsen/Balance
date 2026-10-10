//! Read-only accounting: only byte lengths and fixed codec headers are read.
//! These are payload savings, not a counterfactual SQLite file size or a codec
//! integrity check. No list text or dictionary contents leave this module.
use super::*;

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub total_records: u64,
    pub pending_records: u64,
    pub compressed_records: u64,
    pub dictionary_records: u64,
    pub original_bytes: u64,
    pub stored_bytes: u64,
    pub dictionary_bytes: u64,
    pub dictionary_count: u64,
    pub active_dictionaries: u64,
    pub last_check_at_ms: Option<i64>,
    pub next_check_at_ms: Option<i64>,
}

pub fn read(conn: &Connection) -> Result<Status, String> {
    atomic(conn, "list_storage_diagnostics", || {
        let mut status = Status::default();
        let mut stmt = conn
            .prepare(
                "SELECT typeof(e.value_json), length(CAST(e.value_json AS BLOB)),
            CASE WHEN typeof(e.value_json)='blob' THEN substr(e.value_json,1,20) ELSE NULL END,
            r.entity_key IS NULL
            FROM state_entities e LEFT JOIN list_storage_records r
            ON r.collection=e.collection AND r.entity_key=e.entity_key WHERE e.collection='lists'",
            )
            .map_err(error)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, u64>(1)?,
                    r.get::<_, Option<Vec<u8>>>(2)?,
                    r.get::<_, bool>(3)?,
                ))
            })
            .map_err(error)?;
        for row in rows {
            let (kind, bytes, prefix, pending) = row.map_err(error)?;
            let original = match kind.as_str() {
                "text" => bytes,
                "blob" => {
                    let (id, size) = header(prefix.as_deref().unwrap_or_default(), bytes as usize)?;
                    status.compressed_records += 1;
                    status.dictionary_records += u64::from(id != 0);
                    size as u64
                }
                _ => return Err(error("Invalid stored entity type")),
            };
            status.total_records += 1;
            status.pending_records += u64::from(pending);
            status.original_bytes += original;
            status.stored_bytes += bytes;
        }
        (status.dictionary_count, status.dictionary_bytes) = conn
            .query_row(
                "SELECT count(*), coalesce(sum(length(bytes)),0) FROM list_storage_dictionaries",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(error)?;
        (
            status.active_dictionaries,
            status.last_check_at_ms,
            status.next_check_at_ms,
        ) = conn
            .query_row(
                "SELECT count(DISTINCT active_dictionary), max(checked_at_ms), min(checked_at_ms)
             FROM list_storage_policies",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(error)?;
        status.next_check_at_ms = status
            .next_check_at_ms
            .map(|time| time.saturating_add(CHECK_INTERVAL));
        Ok(status)
    })
}
