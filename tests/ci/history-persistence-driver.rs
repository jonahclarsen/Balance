// Runs only on generated fixtures supplied by history-persistence.spec.ts.
#[test]
#[ignore]
fn history_persistence_driver() {
    let request_path = std::env::var("BALANCE_HISTORY_REQUEST").unwrap();
    let request: Value = serde_json::from_str(&std::fs::read_to_string(&request_path).unwrap()).unwrap();
    let root = std::path::Path::new(&request_path).parent().unwrap();
    assert!(root.join("SYNTHETIC_FIXTURES_ONLY").exists());
    let key = data_encoding::BASE32_NOPAD.encode(&[43u8; 32]);
    let mut connection = open_database_at(&root.join("fixture.sqlite3"), &key).unwrap();
    let args = &request["args"];
    let result: std::result::Result<Value, String> = (|| {
        match request["command"].as_str().unwrap() {
            "seed" => {
                replace_app_state(&mut connection, &args["state"])?;
                enable_primary(&connection).map_err(Error::into_string)?;
                Ok(Value::Null)
            }
            "read_app_state" => Ok(json!(read_app_state_from_database(&connection)?.map(|v| v.to_string()))),
            "persist_operation" => {
                let operation = serde_json::from_str(args["operationJson"].as_str().unwrap()).unwrap();
                crate::persist_operation_once(&mut connection, &operation).map(|v| json!(v))
            }
            "undo_last_operation" | "redo_last_operation" => {
                let expected = args["expectedOperationId"].as_str();
                let result = if request["command"] == "undo_last_operation" {
                    crate::undo_last_operation_for_ui(&mut connection, expected)
                } else {
                    crate::redo_last_operation_for_ui(&mut connection, expected)
                }?;
                Ok(json!(result.map(|v| v.to_string())))
            }
            "replay" => {
                rematerialize(&connection).map_err(Error::into_string)?;
                Ok(json!(read_app_state_from_database(&connection)?.map(|v| v.to_string())))
            }
            command => panic!("Unexpected fixture command: {command}"),
        }
    })();
    let response = match result {
        Ok(value) => json!({ "result": value }),
        Err(error) => json!({ "error": error }),
    };
    std::fs::write(root.join("response.json"), response.to_string()).unwrap();
}
