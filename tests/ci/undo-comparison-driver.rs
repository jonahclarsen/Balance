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
            state["activePlanDate"] = json!(undo_performance_date(plans - 1));
            state["plans"][plans - 1]["items"][0]["startMinutes"] = json!(600);
            state["plans"][plans - 1]["items"][0]["endMinutes"] = json!(630);
            state["metrics"] = json!([{"id": "metric_ci", "name": "Synthetic metric", "questions": [
                {"id": "question_ci", "prompt": "Value", "html": "Value", "type": "text"}],
                "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z"}]);
            state["metricEntries"] = json!((0..entries).map(|i| json!({"id": format!("entry_{i}"),
                "metricId": "metric_ci", "date": undo_performance_date(i),
                "answers": [{"questionId": "question_ci", "value": "original"}],
                "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z"})).collect::<Vec<_>>());
            // A daily checklist run for every synthetic day, as List History
            // accumulates for a long-time user. Rows carry check-off stamps so
            // the Lists page computes typical run timing over the whole history.
            // The first and last days leave their first row unchecked for the
            // check-off scenarios.
            state["listTemplates"] = json!([{"id": "list_template_ci", "name": "Synthetic list",
                "maxExpectedWords": 0, "idealMinutes": 30, "archivedItems": [],
                "items": (0..30).map(|i| json!({"id": format!("lt_item_{i}"), "text": format!("List item {i}"),
                    "html": format!("List item {i}"), "probability": 1, "children": []})).collect::<Vec<_>>(),
                "createdAt": "2026-01-01T00:00:00Z", "updatedAt": "2026-01-01T00:00:00Z"}]);
            state["lists"] = json!((0..plans).map(|day| {
                let date = undo_performance_date(day);
                let unchecked_first = day == 0 || day == plans - 1;
                json!({"id": format!("list_{day}"), "date": date, "listTemplateId": "list_template_ci",
                    "createdAt": format!("{date}T12:00:00Z"),
                    "items": (0..30).map(|i| {
                        let done = !(unchecked_first && i == 0);
                        let mut item = json!({"id": format!("lt_item_{i}.{day}"), "text": format!("List item {i}"),
                            "html": format!("List item {i}"), "done": done, "startMinutes": null, "endMinutes": null, "children": []});
                        if done { item["doneAt"] = json!(600 + i * 60); }
                        item
                    }).collect::<Vec<_>>()})
            }).collect::<Vec<_>>());
            // Scheduled sunset reminders from today's day and list make every
            // write re-verify notification sources, as in a workspace that uses
            // sunset tokens. Revisions without this collection ignore it.
            let reminder_at = current_timestamp_ms() + 86_400_000;
            state["taskNotifications"] = json!((0..4).map(|i| json!({
                "id": format!("reminder_{i}"), "sourceKind": if i % 2 == 0 { "plan" } else { "list" },
                "sourceId": if i % 2 == 0 { format!("plan_{}", plans - 1) } else { format!("list_{}", plans - 1) },
                "itemId": if i % 2 == 0 { format!("plan_{}_item_{i}", plans - 1) } else { format!("lt_item_{i}.{}", plans - 1) },
                "at": reminder_at + i as i64 * 60_000, "text": "Sunset reminder"
            })).collect::<Vec<_>>());
            state["notes"] = json!([{"id": "note_ci", "title": "Synthetic note",
                "createdAt": "2026-09-01T00:00:00Z", "updatedAt": "2026-09-01T00:00:00Z",
                "items": [{"id": "item_ci", "kind": "paragraph", "text": "", "html": "", "done": false, "children": []}]}]);
            replace_app_state(&mut connection, &state).unwrap();
            // Retained undo history survives log checkpoints. Seed that shape
            // directly, with test-only task deletions and increasing sequences.
            let tx = connection.transaction().unwrap();
            let retained_at = current_timestamp_ms() - 86_400_000;
            for i in 1..=entries {
                let plan_id = format!("plan_{}", plans - 1);
                let item_id = format!("deleted_fixture_{i}");
                let redo = json!({"type": "delete_plan_item", "payload": {
                    "planId": plan_id, "itemId": item_id
                }}).to_string();
                let undo = json!({"type": "restore_plan_item", "payload": {
                    "planId": plan_id, "parentId": null, "position": 0,
                    "item": {"id": item_id, "text": "Synthetic removed task", "html": "Synthetic removed task",
                        "done": false, "startMinutes": null, "endMinutes": null, "children": []}
                }}).to_string();
                tx.execute("insert into history_entries
                    (id, operation_id, device_id, sequence, undo_operation_json, redo_operation_json, undone, created_at_ms, updated_at_ms)
                    values (?1, ?2, 'device_perf', ?3, ?4, ?5, 0, ?6, ?6)",
                    params![format!("history_fixture_{i}"), format!("fixture_op_{i}"), i as i64, undo, redo, retained_at]).unwrap();
            }
            set_metadata(&tx, "local_sequence", &(entries + 1).to_string()).unwrap();
            tx.commit().unwrap();
            // Exercise ordinary backup/checkpoint checks on later commands,
            // with the daily synthetic backup already present as in normal use.
            create_daily_database_backup_if_due(&connection, &root.join("fixture.sqlite3"), &key, current_timestamp_ms()).unwrap();
            Value::Null
        }
        "verify" => json!({
            "plan": read_plan_by_id(&connection, request["args"]["planId"].as_str().unwrap()).unwrap().unwrap(),
            "note": current_entity(&connection, "notes", "note_ci").unwrap().unwrap().1,
            "list": current_entity(&connection, "lists", request["args"]["listId"].as_str().unwrap()).unwrap().unwrap().1,
            "listTemplate": current_entity(&connection, "listTemplates", "list_template_ci").unwrap().unwrap().1,
            "entries": read_entity_collection(&connection, "metricEntries").unwrap(),
        }),
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
    let operation_ms = started.elapsed().as_secs_f64() * 1000.0;
    let housekeeping_started = std::time::Instant::now();
    if matches!(command, "persist_operation" | "undo_last_operation" | "redo_last_operation") {
        // The same post-write housekeeping the app runs before answering the
        // UI: notification re-verification, checkpoint and backup checks, and
        // the widget snapshot.
        finish_meaningful_database_write(&connection, &root.join("fixture.sqlite3"), &key);
    }
    let housekeeping_ms = housekeeping_started.elapsed().as_secs_f64() * 1000.0;
    let command_ms = started.elapsed().as_secs_f64() * 1000.0;
    let text = current_entity(&connection, "notes", "note_ci").unwrap().unwrap().1["items"][0]["text"].clone();
    let history_count: i64 = connection.query_row("select count(*) from history_entries", [], |row| row.get(0)).unwrap();
    fs::write(root.join("response.json"), serde_json::to_vec(&json!({
        "result": result, "text": text, "historyCount": history_count,
        "openMs": open_ms, "commandMs": command_ms, "operationMs": operation_ms, "housekeepingMs": housekeeping_ms,
    })).unwrap()).unwrap();
}
