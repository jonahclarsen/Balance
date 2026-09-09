// CI includes this file inside each revision's existing `tests` module so both
// versions use their own real SQLCipher, persistence and UI history functions.
#[test]
#[ignore]
fn note_undo_ci_driver() {
    let request_path = std::env::var("BALANCE_NOTE_UNDO_REQUEST").unwrap();
    let request: Value = serde_json::from_str(&fs::read_to_string(request_path).unwrap()).unwrap();
    let root = Path::new(request["root"].as_str().unwrap());
    assert!(root.join("SYNTHETIC_FIXTURES_ONLY").exists());
    let key = data_encoding::BASE32_NOPAD.encode(&[42u8; 32]);
    let started = std::time::Instant::now();
    let mut connection = open_database_at(&root.join("fixture.sqlite3"), &key).unwrap();
    let open_ms = started.elapsed().as_secs_f64() * 1000.0;
    let started = std::time::Instant::now();
    let command = request["command"].as_str().unwrap();
    let result = match command {
        "seed" => {
            let mut state = undo_performance_state(1500, 60, 0);
            state["notes"] = json!([{"id": "note_ci", "title": "Synthetic note",
                "createdAt": "2026-09-01T00:00:00Z", "updatedAt": "2026-09-01T00:00:00Z",
                "items": [{"id": "item_ci", "kind": "paragraph", "text": "", "html": "", "done": false, "children": []}]}]);
            replace_app_state(&mut connection, &state).unwrap();
            Value::Null
        }
        "read_app_state" => json!(read_app_state_from_database(&connection).unwrap().map(|v| v.to_string())),
        "persist_operation" => {
            let operation = serde_json::from_str(request["args"]["operationJson"].as_str().unwrap()).unwrap();
            json!(persist_operation_once(&mut connection, &operation).unwrap())
        }
        "undo_last_operation" | "redo_last_operation" => {
            let expected = request["args"]["expectedOperationId"].as_str();
            let result = if command == "undo_last_operation" {
                undo_last_operation_for_ui(&mut connection, expected)
            } else {
                redo_last_operation_for_ui(&mut connection, expected)
            }.unwrap();
            json!(result.map(|v| v.to_string()))
        }
        "inspect" => Value::Null,
        _ => panic!("Unexpected database command: {command}"),
    };
    let command_ms = started.elapsed().as_secs_f64() * 1000.0;
    let text = current_entity(&connection, "notes", "note_ci").unwrap().unwrap().1["items"][0]["text"].clone();
    let history_count: i64 = connection.query_row("select count(*) from history_entries", [], |row| row.get(0)).unwrap();
    fs::write(root.join("response.json"), serde_json::to_vec(&json!({
        "result": result, "text": text, "historyCount": history_count,
        "openMs": open_ms, "commandMs": command_ms,
    })).unwrap()).unwrap();
}
