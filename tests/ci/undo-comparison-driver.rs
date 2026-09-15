// CI includes this file inside each revision's existing `tests` module so both
// versions use their own real SQLCipher, persistence and UI history functions.
#[test]
#[ignore]
fn undo_comparison_driver() {
    let request_path = std::env::var("BALANCE_UNDO_REQUEST").unwrap();
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
            let plans = request["args"]["plans"].as_u64().unwrap() as usize;
            let entries = request["args"]["entries"].as_u64().unwrap() as usize;
            let mut state = undo_performance_state(plans, 60, 100);
            state["plans"][plans - 1]["items"][0]["startMinutes"] = json!(600);
            state["plans"][plans - 1]["items"][0]["endMinutes"] = json!(630);
            state["metrics"] = json!([{"id": "metric_ci", "name": "Synthetic metric", "questions": [
                {"id": "question_ci", "prompt": "Value", "html": "Value", "type": "text"}],
                "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z"}]);
            state["metricEntries"] = json!((0..entries).map(|i| json!({"id": format!("entry_{i}"),
                "metricId": "metric_ci", "date": undo_performance_date(i),
                "answers": [{"questionId": "question_ci", "value": "original"}],
                "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z"})).collect::<Vec<_>>());
            state["notes"] = json!([{"id": "note_ci", "title": "Synthetic note",
                "createdAt": "2026-09-01T00:00:00Z", "updatedAt": "2026-09-01T00:00:00Z",
                "items": [{"id": "item_ci", "kind": "paragraph", "text": "", "html": "", "done": false, "children": []}]}]);
            replace_app_state(&mut connection, &state).unwrap();
            Value::Null
        }
        "read_app_state" => json!(read_app_state_from_database(&connection).unwrap().map(|v| v.to_string())),
        "persist_operation" => {
            let operation = serde_json::from_str(request["args"]["operationJson"].as_str().unwrap()).unwrap();
            { persist_operation_to_database(&mut connection, &operation).unwrap(); json!(true) }
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
