//! Image bytes are immutable, shared entities inside SQLCipher. HTML stores only
//! their SHA-256 ids and per-occurrence layout. Checkpoints collect unused bytes
//! after their undo/redo references expire, and replicate that collection.
use rusqlite::Connection;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

pub(crate) fn validate(asset: &Value, key: &str) -> Result<(), String> {
    let id = crate::required_string(asset, "id")?;
    if id != key
        || id.len() != 64
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err("Invalid image identifier".into());
    }
    let url = crate::required_string(asset, "dataURL")?;
    let (header, encoded) = url.split_once(',').ok_or("Invalid image data")?;
    if !["png", "jpeg", "webp", "gif", "avif", "bmp"]
        .iter()
        .any(|format| header == format!("data:image/{format};base64"))
    {
        return Err("Unsupported image format".into());
    }
    let bytes = data_encoding::BASE64
        .decode(encoded.as_bytes())
        .map_err(|_| "Invalid image encoding")?;
    if data_encoding::HEXLOWER.encode(&Sha256::digest(&bytes)) != id
        || crate::required_i64(asset, "bytes")? != bytes.len() as i64
    {
        return Err("Image content does not match its identifier".into());
    }
    if crate::required_i64(asset, "width")? < 1 || crate::required_i64(asset, "height")? < 1 {
        return Err("Invalid image dimensions".into());
    }
    Ok(())
}

fn references(value: &Value, ids: &mut HashSet<String>) {
    match value {
        Value::String(text) => {
            for fragment in text.split("data-balance-image=\"").skip(1) {
                if let Some(id) = fragment.split('"').next() {
                    if id.len() == 64 && id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                        ids.insert(id.to_owned());
                    }
                }
            }
        }
        Value::Array(values) => {
            for value in values {
                references(value, ids);
            }
        }
        Value::Object(values) => {
            for (key, value) in values {
                if key != "images" && key != "dataURL" {
                    references(value, ids);
                }
            }
        }
        _ => {}
    }
}

fn retained_references(
    conn: &Connection,
    state: &Value,
    history: bool,
) -> Result<HashSet<String>, String> {
    let mut ids = HashSet::new();
    references(state, &mut ids);
    if history {
        let mut statement = conn
            .prepare("SELECT undo_operation_json, redo_operation_json FROM history_entries")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| error.to_string())?;
        for row in rows {
            let (undo, redo) = row.map_err(|error| error.to_string())?;
            for raw in [undo, redo] {
                let value: Value = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
                references(&value, &mut ids);
            }
        }
    }
    Ok(ids)
}

pub(crate) fn collect_for_checkpoint(
    conn: &Connection,
    state: &mut Value,
    preserve_history: bool,
) -> Result<(), String> {
    let ids = retained_references(conn, state, preserve_history)?;
    if let Some(assets) = state.get_mut("images").and_then(Value::as_array_mut) {
        assets.retain(|asset| {
            asset
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| ids.contains(id))
        });
    }
    Ok(())
}

// A device can create a new reference while offline, after another device has
// collected the old image. Preserve the bytes needed by uncovered local work
// and publish them again. A separate operation author avoids racing frontend
// sequences that may already be queued while sync runs in the background.
pub(crate) fn restore_offline_references(
    conn: &Connection,
    previous: &Value,
) -> Result<(), String> {
    let Some(state) = crate::read_app_state_from_database(conn)? else {
        return Ok(());
    };
    let ids = retained_references(conn, &state, true)?;
    let existing: HashSet<&str> = state["images"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|asset| asset["id"].as_str())
        .collect();
    let Some(assets) = previous.as_array() else {
        return Ok(());
    };
    let device = format!(
        "{}_images",
        crate::metadata_value(conn, "device_id")?.unwrap_or_else(|| "local".into())
    );
    let mut sequence: i64 = conn.query_row(
        "SELECT max(coalesce((SELECT max(sequence) FROM operations WHERE device_id = ?1), 0), coalesce((SELECT sequence FROM sync_frontiers WHERE device_id = ?1), 0))",
        [&device], |row| row.get(0),
    ).map_err(|error| error.to_string())?;
    for asset in assets {
        let Some(id) = asset["id"].as_str() else {
            continue;
        };
        if !ids.contains(id) || existing.contains(id) {
            continue;
        }
        sequence += 1;
        let operation = json!({
            "id": format!("op_{device}_{sequence}"), "deviceId": device, "sequence": sequence,
            "type": "add_image", "timestamp": crate::current_timestamp(),
            "payload": { "entityChanges": { "version": 1, "upserts": [{ "collection": "images", "key": id, "position": 0, "value": asset }], "deletes": [] } }
        });
        crate::upsert_operation(conn, &operation)?;
        crate::apply_entity_changes(conn, &operation["payload"]["entityChanges"])?;
    }
    Ok(())
}
