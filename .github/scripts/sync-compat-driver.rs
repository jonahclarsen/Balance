//! Copied into each checkout by CI. Uses that version's real SQLCipher and sync
//! engine, with exclusively generated fixtures and a public test-only key.
use serde_json::{json, Value};
use std::{env, fs, path::Path};

#[test]
#[ignore]
fn compatibility_process_driver() {
    let input = env::var("BALANCE_COMPAT_REQUEST").expect("synthetic request path");
    let request: Value = serde_json::from_str(&fs::read_to_string(input).unwrap()).unwrap();
    let root = Path::new(request["root"].as_str().unwrap());
    assert!(root.join("SYNTHETIC_FIXTURES_ONLY").exists());
    let name = request["database"].as_str().unwrap();
    assert!(name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-'));
    let key = data_encoding::BASE32_NOPAD.encode(&[42u8; 32]);
    let mut conn = crate::open_database_at(&root.join(format!("{name}.sqlite3")), &key).unwrap();
    let outcome: Result<Value, String> = (|| {
        match request["command"].as_str().unwrap() {
            "init" => {
                crate::replace_app_state(&mut conn, &request["state"])?;
                crate::sync::enable_primary(&conn).map_err(|e| e.to_string())?;
            }
            "relay" => {
                let key = crate::sync::crypto::SyncKey::from_bytes([17; 32]);
                crate::sync::relay_client::sync_once(
                    &conn,
                    request["url"].as_str().unwrap(),
                    &key,
                    crate::sync::relay_client::SyncOptions::foreground(true),
                )
                .map_err(|e| e.to_string())?;
            }
            "write" => crate::persist_operation_to_database(&mut conn, &request["operation"])?,
            "checkpoint" => {
                crate::sync::checkpoint_operation_log_preserving_history(&conn)
                    .map_err(|e| e.to_string())?;
            }
            "undo" => {
                crate::undo_last_operation_in_database(&mut conn)?;
            }
            "redo" => {
                crate::redo_last_operation_in_database(&mut conn)?;
            }
            "merge" => {
                let operations = serde_json::from_value(request["operations"].clone()).unwrap();
                crate::sync::merge_and_rematerialize(&conn, operations)
                    .map_err(|e| e.to_string())?;
            }
            "read" => (),
            other => panic!("unknown fixture command {other}"),
        }
        Ok(json!({"ok": true}))
    })();
    let mut rows = conn.prepare("SELECT collection, entity_key, position, value_json FROM state_entities ORDER BY collection, position, entity_key").unwrap();
    let entities: Vec<Value> = rows.query_map([], |row| Ok(json!({
        "collection": row.get::<_, String>(0)?, "key": row.get::<_, String>(1)?,
        "position": row.get::<_, i64>(2)?, "value": serde_json::from_str::<Value>(&row.get::<_, String>(3)?).unwrap()
    }))).unwrap().map(Result::unwrap).collect();
    let integrity: String = conn
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .unwrap();
    let result = json!({
        "protocolVersion": crate::sync::PROTOCOL_VERSION, "error": outcome.err(), "state": crate::read_app_state_from_database(&conn).unwrap(),
        "entities": entities, "operations": crate::sync::all_ops(&conn).unwrap(), "integrity": integrity,
    });
    fs::write(
        root.join("response.json"),
        serde_json::to_vec_pretty(&result).unwrap(),
    )
    .unwrap();
}
