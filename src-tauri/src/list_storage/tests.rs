use super::*;
use rand::{Rng, SeedableRng};
use serde_json::json;
use std::{fs, path::PathBuf, time::Instant};

struct Scratch {
    root: PathBuf,
}
impl Scratch {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "balance-synthetic-list-storage-{:016x}",
            rand::random::<u64>()
        ));
        fs::create_dir(&root).unwrap();
        Self { root }
    }
    fn path(&self) -> PathBuf {
        self.root.join("test.db")
    }
    fn key(&self) -> String {
        data_encoding::BASE32_NOPAD.encode(&[42; 32])
    }
    fn open(&self) -> Connection {
        crate::open_database_at(&self.path(), &self.key()).unwrap()
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn template(seed: u64, rows: usize) -> Value {
    let mut rng = rand::rngs::StdRng::seed_from_u64(seed);
    let items: Vec<Value> = (0..rows).map(|i| {
        let text = (0..20).map(|_| format!("word{:08x}", rng.gen::<u32>())).collect::<Vec<_>>().join(" ");
        json!({"id":format!("item-{i}"),"text":text,"html":format!("<p><strong>{text}</strong> café 🌱 東京</p>"),"probability":100,"children":[]})
    }).collect();
    json!({"id":"template","name":"Synthetic only","items":items,"archivedItems":[],"maxExpectedWords":0})
}

fn daily(template: &Value, day: usize) -> Value {
    let date =
        chrono::NaiveDate::from_ymd_opt(2020, 1, 1).unwrap() + chrono::Duration::days(day as i64);
    let items = template["items"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .map(|(i, row)| {
            json!({"id":format!("item-{i}.{day:08x}"),"text":row["text"],"html":row["html"],
            "done":true,"doneAt":i*25+day%17,"startMinutes":null,"endMinutes":null,"children":[],
            "futureUnknown":{"preserve":true}})
        })
        .collect::<Vec<_>>();
    json!({"id":format!("list-{day}"),"date":date.to_string(),"createdAt":format!("{date}T12:00:00Z"),
        "listTemplateId":"template","items":items,"futureExtension":[null,true,"é"]})
}

fn state() -> Value {
    json!({"schemaVersion":1,"deviceId":"synthetic-device","localSequence":0,"historyRevision":0,
        "activePlanDate":"2020-01-01","templates":[],"plans":[],"preferences":crate::default_replicated_preferences(),
        "listTemplates":[],"lists":[],"goals":[],"goalCompletions":[],"operations":[]})
}

fn now(day: i64) -> i64 {
    1_577_836_800_000 + day * DAY + 12 * 3_600_000
}
fn date(day: i64) -> chrono::NaiveDate {
    chrono::NaiveDate::from_ymd_opt(2020, 1, 1).unwrap() + chrono::Duration::days(day)
}
fn seed(conn: &Connection, template: &Value) {
    write_at(conn, "listTemplates", "template", 0, template, now(0)).unwrap();
}
fn put(conn: &Connection, template: &Value, day: usize) {
    write_at(
        conn,
        "lists",
        &format!("list-{day}"),
        day as i64,
        &daily(template, day),
        now(day as i64),
    )
    .unwrap();
}
fn get(conn: &Connection, day: usize) -> Value {
    crate::current_entity(conn, "lists", &format!("list-{day}"))
        .unwrap()
        .unwrap()
        .1
}
fn count(conn: &Connection, table: &str) -> i64 {
    conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
        .unwrap()
}
fn active(conn: &Connection) -> i64 {
    conn.query_row(
        "SELECT active_dictionary FROM list_storage_policies WHERE template_id='template'",
        [],
        |r| r.get(0),
    )
    .unwrap()
}

#[test]
fn diagnostics_account_for_mixed_records_dictionaries_and_migration_without_writes() {
    let scratch = Scratch::new();
    let conn = scratch.open();
    let empty = diagnostics::read(&conn).unwrap();
    assert_eq!(empty.total_records, 0);
    assert_eq!(empty.dictionary_bytes, 0);
    assert_eq!(empty.next_check_at_ms, None);
    let source = template(7, 45);
    seed(&conn, &source);
    put(&conn, &source, 0);
    let mut independent = daily(&source, 1);
    independent
        .as_object_mut()
        .unwrap()
        .remove("listTemplateId");
    write_at(&conn, "lists", "independent", 1, &independent, now(0)).unwrap();
    let tiny = json!({"text":"café 🌱 東京"});
    write_at(&conn, "lists", "tiny", 2, &tiny, now(0)).unwrap();
    conn.execute(
        "INSERT INTO state_entities VALUES('lists','legacy',3,?1)",
        [tiny.to_string()],
    )
    .unwrap();
    // Two policies sharing one active dictionary must count that dictionary once.
    conn.execute("INSERT INTO list_storage_policies SELECT 'second',active_dictionary,active_source_hash,checked_at_ms FROM list_storage_policies LIMIT 1", []).unwrap();
    install_dictionary(&conn, b"synthetic retained dictionary", now(0)).unwrap();
    let before: i64 = conn
        .query_row("SELECT total_changes()", [], |r| r.get(0))
        .unwrap();
    let status = diagnostics::read(&conn).unwrap();
    let after: i64 = conn
        .query_row("SELECT total_changes()", [], |r| r.get(0))
        .unwrap();
    assert_eq!(before, after);
    assert_eq!(status.total_records, 4);
    assert_eq!(status.pending_records, 1);
    assert_eq!(status.compressed_records, 2);
    assert_eq!(status.dictionary_records, 1);
    assert_eq!(status.dictionary_count, 2);
    assert_eq!(status.active_dictionaries, 1);
    assert_eq!(status.last_check_at_ms, Some(now(0)));
    assert_eq!(status.next_check_at_ms, Some(now(90)));
    assert_eq!(
        status.original_bytes as usize,
        daily(&source, 0).to_string().len()
            + independent.to_string().len()
            + 2 * tiny.to_string().len()
    );
    let actual: u64 = conn.query_row("SELECT sum(length(CAST(value_json AS BLOB))) FROM state_entities WHERE collection='lists'", [], |r| r.get(0)).unwrap();
    assert_eq!(status.stored_bytes, actual);
    assert_eq!(
        status.dictionary_bytes as usize,
        dictionary_bytes(&super::source(&conn, "template").unwrap().unwrap()).len()
            + b"synthetic retained dictionary".len()
    );
    maintain(&conn, now(1), date(1)).unwrap();
    let done = diagnostics::read(&conn).unwrap();
    assert_eq!(done.pending_records, 0);
    assert_eq!(done.original_bytes, status.original_bytes);
    assert_eq!(done.dictionary_count, 1);
}

#[test]
fn diagnostics_reject_unknown_or_damaged_headers_instead_of_reporting_fake_savings() {
    let scratch = Scratch::new();
    let conn = scratch.open();
    for bytes in [vec![0; 21], MAGIC.to_vec(), {
        let mut bytes = MAGIC.to_vec();
        bytes.extend_from_slice(&0_i64.to_le_bytes());
        bytes.extend_from_slice(&((MAX_RECORD + 1) as u32).to_le_bytes());
        bytes.push(0);
        bytes
    }] {
        conn.execute(
            "INSERT OR REPLACE INTO state_entities VALUES('lists','invalid',0,?1)",
            [bytes],
        )
        .unwrap();
        assert!(diagnostics::read(&conn).is_err());
    }
}

#[test]
fn legacy_plaintext_rows_migrate_in_bounded_atomic_batches_and_reopen() {
    let scratch = Scratch::new();
    let conn = Connection::open(scratch.path()).unwrap();
    crate::apply_raw_database_key(&conn, &scratch.key()).unwrap();
    conn.execute_batch("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE state_entities(collection TEXT NOT NULL,entity_key TEXT NOT NULL,position INTEGER NOT NULL,
        value_json TEXT NOT NULL,PRIMARY KEY(collection,entity_key));").unwrap();
    let source = template(17, 45);
    conn.execute(
        "INSERT INTO state_entities VALUES('listTemplates','template',0,?1)",
        [source.to_string()],
    )
    .unwrap();
    for day in 0..61 {
        conn.execute(
            "INSERT INTO state_entities VALUES('lists',?1,?2,?3)",
            params![format!("list-{day}"), day, daily(&source, day).to_string()],
        )
        .unwrap();
    }
    drop(conn);
    let conn = scratch.open();
    let before = crate::sync::entities::snapshot(&conn).unwrap();
    conn.execute_batch(
        "CREATE TRIGGER interrupt_migration BEFORE UPDATE ON state_entities
        WHEN NEW.collection='lists' AND NEW.entity_key='list-1'
        BEGIN SELECT RAISE(ABORT,'synthetic interrupted migration'); END;",
    )
    .unwrap();
    assert!(maintain(&conn, now(100), date(100)).is_err());
    assert_eq!(count(&conn, "list_storage_records"), 0);
    assert_eq!(count(&conn, "list_storage_dictionaries"), 0);
    assert_eq!(crate::sync::entities::snapshot(&conn).unwrap(), before);
    conn.execute_batch("DROP TRIGGER interrupt_migration")
        .unwrap();
    let first = maintain(&conn, now(100), date(100)).unwrap();
    assert_eq!(first.converted, 24);
    assert!(first.more);
    assert_eq!(get(&conn, 60), daily(&source, 60)); // Still plaintext.
    while maintain(&conn, now(100), date(100)).unwrap().more {}
    assert_eq!(count(&conn, "list_storage_records"), 61);
    assert_eq!(crate::sync::entities::snapshot(&conn).unwrap(), before);
    assert_eq!(count(&conn, "operations"), 0);
    conn.execute_batch("VACUUM").unwrap();
    drop(conn);
    assert_ne!(
        &fs::read(scratch.path()).unwrap()[..16],
        b"SQLite format 3\0"
    );
    let conn = scratch.open();
    assert_eq!(crate::sync::entities::snapshot(&conn).unwrap(), before);
    assert_eq!(get(&conn, 0), daily(&source, 0));
    assert_eq!(
        conn.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    assert_eq!(count(&conn, "list_storage_dictionaries"), 1);
}

#[test]
fn codec_rejects_damage_unknown_versions_and_excessive_sizes() {
    let scratch = Scratch::new();
    let conn = scratch.open();
    let source = template(3, 45);
    seed(&conn, &source);
    put(&conn, &source, 0);
    let bytes: Vec<u8> = conn
        .query_row(
            "SELECT value_json FROM state_entities WHERE collection='lists'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    for damage in 0..5 {
        let mut broken = bytes.clone();
        match damage {
            0 => {
                broken.truncate(broken.len() - 8);
            }
            1 => {
                *broken.last_mut().unwrap() ^= 1;
            }
            2 => {
                broken[0] ^= 1;
            }
            3 => {
                broken[16..20].copy_from_slice(&u32::MAX.to_le_bytes());
            }
            _ => {
                broken[8..16].copy_from_slice(&i64::MAX.to_le_bytes());
            }
        }
        assert!(Reader::new(&conn).read(SqlValue::Blob(broken)).is_err());
    }
    assert!(
        conn.execute("DELETE FROM list_storage_dictionaries", [])
            .is_err(),
        "foreign keys retain live dictionaries"
    );
    assert!(conn
        .execute("UPDATE list_storage_dictionaries SET bytes=x'00'", [])
        .is_err());
    conn.execute_batch("PRAGMA foreign_keys=OFF; DELETE FROM list_storage_dictionaries;")
        .unwrap();
    assert!(Reader::new(&conn)
        .read(SqlValue::Blob(bytes))
        .unwrap_err()
        .contains("Missing dictionary"));
}

#[test]
fn unknown_schema_version_is_rejected_without_changing_entities() {
    let scratch = Scratch::new();
    let conn = scratch.open();
    let source = template(3, 45);
    seed(&conn, &source);
    put(&conn, &source, 0);
    let before = crate::sync::entities::snapshot(&conn).unwrap();
    crate::set_metadata(&conn, "list_storage_version", "999").unwrap();
    assert!(initialize(&conn).unwrap_err().contains("Update required"));
    assert_eq!(crate::sync::entities::snapshot(&conn).unwrap(), before);
    assert_eq!(
        crate::metadata_value(&conn, "list_storage_version")
            .unwrap()
            .as_deref(),
        Some("999")
    );
}

#[test]
fn small_values_and_empty_future_shapes_remain_lossless_without_a_dictionary() {
    let scratch = Scratch::new();
    let conn = scratch.open();
    for value in [
        json!({"id":"empty","items":[],"unknown":{"a":null}}),
        json!({"id":"empty","text":"","html":"<p>🌱</p>"}),
    ] {
        write(&conn, "lists", "empty", 3, &value).unwrap();
        assert_eq!(
            crate::current_entity(&conn, "lists", "empty")
                .unwrap()
                .unwrap(),
            (3, value)
        );
    }
    assert_eq!(count(&conn, "list_storage_dictionaries"), 0);
    assert_eq!(count(&conn, "list_storage_records"), 1);
    assert!(!maintain(&conn, now(200), date(200)).unwrap().more);
}

#[test]
fn storage_upgrade_and_failed_writes_roll_back_without_partial_records() {
    let scratch = Scratch::new();
    let conn = scratch.open();
    let source = template(6, 45);
    seed(&conn, &source);
    conn.execute_batch("CREATE TRIGGER reject_synthetic_list BEFORE INSERT ON state_entities WHEN NEW.collection='lists'
        BEGIN SELECT RAISE(ABORT,'synthetic disk write failure'); END;").unwrap();
    assert!(write_at(&conn, "lists", "list-0", 0, &daily(&source, 0), now(0)).is_err());
    assert_eq!(count(&conn, "list_storage_dictionaries"), 0);
    assert_eq!(count(&conn, "list_storage_policies"), 0);
    assert_eq!(count(&conn, "list_storage_records"), 0);
    conn.execute_batch("DROP TRIGGER reject_synthetic_list")
        .unwrap();
    put(&conn, &source, 0);
    conn.execute_batch("BEGIN").unwrap();
    put(&conn, &source, 1);
    conn.execute_batch("ROLLBACK").unwrap();
    assert_eq!(count(&conn, "list_storage_records"), 1);
    assert!(crate::current_entity(&conn, "lists", "list-1")
        .unwrap()
        .is_none());
}

#[test]
fn old_connections_cannot_write_and_old_or_new_backups_are_read_only() {
    let scratch = Scratch::new();
    let mut conn = scratch.open();
    crate::replace_app_state(&mut conn, &state()).unwrap();
    let source = template(9, 45);
    seed(&conn, &source);
    put(&conn, &source, 0);
    let backup =
        crate::create_daily_database_backup_if_due(&conn, &scratch.path(), &scratch.key(), now(1))
            .unwrap()
            .unwrap();
    let before = fs::read(&backup).unwrap();
    let view = crate::backup_browser::read_at(
        &scratch.path(),
        backup.file_name().unwrap().to_str().unwrap(),
        &scratch.key(),
    )
    .unwrap();
    assert_eq!(view["lists"][0], daily(&source, 0));
    assert_eq!(fs::read(&backup).unwrap(), before);
    let old = Connection::open(scratch.path()).unwrap();
    crate::apply_raw_database_key(&old, &scratch.key()).unwrap();
    let failure = old
        .execute("INSERT INTO metadata VALUES('old-writer','unsafe')", [])
        .unwrap_err()
        .to_string();
    assert!(
        failure.contains("balance_list_storage_v1_required"),
        "{failure}"
    );
    assert!(old.execute("DELETE FROM state_entities", []).is_err());
    assert_eq!(get(&conn, 0), daily(&source, 0));
}

#[test]
fn native_undo_redo_checkpoints_and_peers_preserve_logical_records() {
    let scratch = Scratch::new();
    let peer_scratch = Scratch::new();
    let mut conn = scratch.open();
    let mut peer = peer_scratch.open();
    crate::replace_app_state(&mut conn, &state()).unwrap();
    crate::replace_app_state(&mut peer, &state()).unwrap();
    let source = template(12, 45);
    seed(&conn, &source);
    put(&conn, &source, 0);
    // The peer starts with a completely different dictionary, then receives the
    // same logical state. Dictionary IDs and physical bytes are device-local.
    let stale = template(87, 45);
    seed(&peer, &stale);
    put(&peer, &stale, 0);
    crate::sync::entities::restore(&peer, &crate::sync::entities::snapshot(&conn).unwrap())
        .unwrap();
    assert_eq!(
        crate::sync::state_hash(&conn, &["state_entities"]).unwrap(),
        crate::sync::state_hash(&peer, &["state_entities"]).unwrap()
    );
    let before = get(&conn, 0);
    let mut after = before.clone();
    after["items"][0]["text"] = json!("One changed word café 🌱");
    let changes = json!({"version":2,"upserts":[{"collection":"lists","key":"list-0","position":null,
        "value":after,"patches":[crate::sync::entities::diff(&before,&after)]}],"deletes":[]});
    let operation = json!({"id":"synthetic-edit","deviceId":"synthetic-device","sequence":1,
        "type":"apply_entity_changes","timestamp":"2020-01-01T12:00:00Z","payload":{"action":"patch_list_item","entityChanges":changes}});
    crate::persist_operation_to_database(&mut conn, &operation).unwrap();
    assert_eq!(get(&conn, 0), after);
    crate::undo_last_operation_in_database(&mut conn).unwrap();
    assert_eq!(get(&conn, 0), before);
    crate::redo_last_operation_in_database(&mut conn).unwrap();
    assert_eq!(get(&conn, 0), after);
    crate::sync::enable_primary(&conn).unwrap();
    crate::sync::checkpoint_operation_log_preserving_history(&conn).unwrap();
    assert_eq!(get(&conn, 0), after);
    let snapshot = crate::sync::entities::snapshot(&conn).unwrap();
    crate::sync::entities::restore(&peer, &snapshot).unwrap();
    assert_eq!(get(&peer, 0), after);
    assert_eq!(crate::sync::entities::snapshot(&peer).unwrap(), snapshot);
}

#[test]
fn policy_waits_90_days_skips_unchanged_and_adopts_only_useful_candidates() {
    let scratch = Scratch::new();
    let conn = scratch.open();
    let original = template(20, 45);
    seed(&conn, &original);
    for day in 0..180 {
        put(&conn, &original, day);
    }
    let first = active(&conn);
    assert!(!maintain(&conn, now(89), date(89)).unwrap().evaluated);
    let unchanged = maintain(&conn, now(90), date(90)).unwrap();
    assert!(unchanged.evaluated && !unchanged.adopted);
    assert_eq!(count(&conn, "list_storage_dictionaries"), 1);
    // A one-word edit should not create a dictionary just because time passed.
    let mut minor = original.clone();
    minor["items"][0]["text"] = json!("minor change");
    seed(&conn, &minor);
    for day in 180..210 {
        put(&conn, &minor, day);
    }
    assert!(!maintain(&conn, now(210), date(210)).unwrap().adopted);
    assert_eq!(active(&conn), first);
    let changed = template(902, 45);
    seed(&conn, &changed);
    for day in 211..391 {
        put(&conn, &changed, day);
    }
    assert!(!maintain(&conn, now(299), date(299)).unwrap().evaluated);
    let decision = maintain(&conn, now(391), date(391)).unwrap();
    assert!(decision.evaluated && decision.adopted);
    assert_ne!(active(&conn), first);
    assert_eq!(get(&conn, 0), daily(&original, 0));
    assert_eq!(get(&conn, 390), daily(&changed, 390));
    assert_eq!(count(&conn, "list_storage_dictionaries"), 2);
    put(&conn, &changed, 391);
    // No rewriting of historical records during dictionary rotation.
    let old_id: i64 = conn
        .query_row(
            "SELECT dictionary_id FROM list_storage_records WHERE entity_key='list-390'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(old_id, first);
    conn.execute(
        "DELETE FROM state_entities WHERE collection='lists' AND entity_key != 'list-391'",
        [],
    )
    .unwrap();
    maintain(&conn, now(392), date(392)).unwrap();
    assert_eq!(count(&conn, "list_storage_dictionaries"), 1);
    assert_eq!(get(&conn, 391), daily(&changed, 391));
}

#[test]
fn rare_usage_does_not_pay_for_a_large_new_dictionary() {
    let scratch = Scratch::new();
    let conn = scratch.open();
    let original = template(1, 45);
    seed(&conn, &original);
    put(&conn, &original, 0);
    let first = active(&conn);
    let changed = template(2, 45);
    seed(&conn, &changed);
    // Thirty recent-ish samples, but only one use in the preceding six months.
    for day in 1..30 {
        put(&conn, &changed, day);
    }
    put(&conn, &changed, 700);
    assert!(!maintain(&conn, now(700), date(700)).unwrap().adopted);
    assert_eq!(active(&conn), first);
}

#[test]
fn rejected_candidate_is_reconsidered_after_usage_increases() {
    let scratch = Scratch::new();
    let conn = scratch.open();
    let original = template(1, 45);
    seed(&conn, &original);
    put(&conn, &original, 0);
    let first = active(&conn);
    let changed = template(2, 45);
    seed(&conn, &changed);
    for day in 1..30 {
        put(&conn, &changed, day);
    }
    put(&conn, &changed, 700);
    assert!(!maintain(&conn, now(700), date(700)).unwrap().adopted);
    for day in 701..791 {
        put(&conn, &changed, day);
    }
    assert!(maintain(&conn, now(790), date(790)).unwrap().adopted);
    assert_ne!(active(&conn), first);
}

#[test]
fn compressed_unknown_image_references_and_rekeyed_copies_remain_readable() {
    let scratch = Scratch::new();
    let conn = scratch.open();
    let source = template(7, 45);
    seed(&conn, &source);
    let mut value = daily(&source, 0);
    let image_id = "a".repeat(64);
    value["futureImageField"] = json!(format!("<img data-balance-image=\"{image_id}\">"));
    write(&conn, "lists", "list-0", 0, &value).unwrap();
    let mut snapshot = json!({"images":[{"id":image_id},{"id":"b".repeat(64)}]});
    crate::images::collect_for_checkpoint(&conn, &mut snapshot, false).unwrap();
    assert_eq!(snapshot["images"], json!([{"id":image_id}]));
    let other_key = data_encoding::BASE32_NOPAD.encode(&[91; 32]);
    let copy = scratch.root.join("rekeyed.db");
    crate::copy_database_snapshot(&conn, &copy, &other_key).unwrap();
    let rotated = crate::open_database_at(&copy, &other_key).unwrap();
    assert_eq!(get(&rotated, 0), value);
    assert_eq!(
        crate::sync::entities::snapshot(&rotated).unwrap(),
        crate::sync::entities::snapshot(&conn).unwrap()
    );
    assert!(crate::open_database_at(&copy, &scratch.key()).is_err());
}

#[test]
fn damaged_record_rolls_back_incoming_operations_and_their_log() {
    let scratch = Scratch::new();
    let mut conn = scratch.open();
    crate::replace_app_state(&mut conn, &state()).unwrap();
    let source = template(11, 45);
    seed(&conn, &source);
    put(&conn, &source, 0);
    conn.execute(
        "UPDATE state_entities SET value_json=x'000102' WHERE collection='lists'",
        [],
    )
    .unwrap();
    let operation = json!({"id":"synthetic-corrupt-edit","deviceId":"synthetic-device","sequence":1,
        "type":"apply_entity_changes","timestamp":"2020-01-01T12:00:00Z","payload":{"entityChanges":{
            "version":2,"upserts":[{"collection":"lists","key":"list-0","position":null,"value":daily(&source,0),
                "patches":[{"kind":"object","fields":{"futureExtension":{"kind":"replace","value":null}},"remove":[]}]}],"deletes":[]}}});
    let before = crate::sync::all_ops(&conn).unwrap();
    assert!(crate::persist_operation_to_database(&mut conn, &operation).is_err());
    assert_eq!(crate::sync::all_ops(&conn).unwrap(), before);
    assert_eq!(count(&conn, "history_entries"), 0);
    assert!(get_corrupt(&conn).is_err());
    fn get_corrupt(conn: &Connection) -> Result<Option<(i64, Value)>, String> {
        crate::current_entity(conn, "lists", "list-0")
    }
}

/// CI only: real native SQLCipher storage, including dictionary lifecycle and
/// daily edits. Compare fixed, annual and the automatic policy on identical
/// seeded histories. Does not include operations/history in the size claim.
#[test]
#[ignore]
fn native_dictionary_policy_profile() {
    assert_eq!(std::env::var("GITHUB_ACTIONS").as_deref(), Ok("true"));
    for template_rows in [135, 68, 27] {
        for churn in [false, true] {
            for policy in ["fixed", "annual", "adaptive"] {
                let scratch = Scratch::new();
                let conn = scratch.open();
                let mut source = template(17, template_rows);
                seed(&conn, &source);
                let started = Instant::now();
                let mut raw_bytes = 0_usize;
                let mut rotations = 0;
                let mut write_us = Vec::new();
                let mut read_us = Vec::new();
                let mut maintenance_us = Vec::new();
                conn.execute_batch("BEGIN").unwrap();
                for day in 0..3650 {
                    if day > 0 && day % (if churn { 1 } else { 7 }) == 0 {
                        let index = (day * 19) % template_rows;
                        source["items"][index]["text"] = json!(format!(
                            "{} revised-{day}",
                            source["items"][index]["text"]
                                .as_str()
                                .unwrap()
                                .split_whitespace()
                                .take(19)
                                .collect::<Vec<_>>()
                                .join(" ")
                        ));
                        source["items"][index]["html"] = json!(format!(
                            "<p>{}</p>",
                            source["items"][index]["text"].as_str().unwrap()
                        ));
                        seed(&conn, &source);
                    }
                    if churn && day > 0 && day % 365 == 0 {
                        source = template(17 + day as u64, template_rows);
                        seed(&conn, &source);
                    }
                    if policy == "annual" && day > 0 && day % 365 == 0 {
                        let bytes = super::source(&conn, "template").unwrap().unwrap();
                        let id =
                            install_dictionary(&conn, dictionary_bytes(&bytes), now(day as i64))
                                .unwrap();
                        conn.execute(
                            "UPDATE list_storage_policies SET active_dictionary=?1",
                            [id],
                        )
                        .unwrap();
                        rotations += 1;
                    }
                    let mut value = daily(&source, day);
                    // Around 900 expected words from 2700 template words.
                    value["items"] = Value::Array(
                        value["items"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .enumerate()
                            .filter(|(index, _)| (index + day) % 3 == 0)
                            .map(|(_, value)| value.clone())
                            .collect(),
                    );
                    raw_bytes += value.to_string().len();
                    let tick = Instant::now();
                    write_at(
                        &conn,
                        "lists",
                        &format!("list-{day}"),
                        day as i64,
                        &value,
                        now(day as i64),
                    )
                    .unwrap();
                    write_us.push(tick.elapsed().as_micros());
                    let tick = Instant::now();
                    assert_eq!(get(&conn, day), value);
                    read_us.push(tick.elapsed().as_micros());
                    if policy == "adaptive" && day % 90 == 0 {
                        let tick = Instant::now();
                        rotations += usize::from(
                            maintain(&conn, now(day as i64), date(day as i64))
                                .unwrap()
                                .adopted,
                        );
                        maintenance_us.push(tick.elapsed().as_micros());
                    }
                }
                conn.execute_batch("COMMIT; VACUUM").unwrap();
                let milliseconds = started.elapsed().as_millis();
                let dictionaries = count(&conn, "list_storage_dictionaries");
                let before = crate::sync::entities::snapshot(&conn).unwrap();
                drop(conn);
                let bytes = fs::metadata(scratch.path()).unwrap().len();
                let reopened = scratch.open();
                assert_eq!(crate::sync::entities::snapshot(&reopened).unwrap(), before);
                write_us.sort_unstable();
                read_us.sort_unstable();
                maintenance_us.sort_unstable();
                println!(
                    "BALANCE_DICTIONARY_PROFILE: {}",
                    json!({"churn":churn,"policy":policy,"days":3650,"templateWords":template_rows*20,
                "writeP95Us":write_us[write_us.len()*95/100],"readP95Us":read_us[read_us.len()*95/100],
                "maintenanceMaxUs":maintenance_us.last().copied().unwrap_or(0),
                "databaseBytes":bytes,"logicalListBytes":raw_bytes,"dictionaries":dictionaries,"rotations":rotations,"buildAndVerifyMs":milliseconds})
                );
            }
        }
    }
}

/// Include actual operation history and a logical checkpoint in the size/read
/// comparison. The baseline expands only the materialized list records back to
/// JSON, preserving every operation and history entry byte for byte.
#[test]
#[ignore]
fn native_complete_database_profile() {
    assert_eq!(std::env::var("GITHUB_ACTIONS").as_deref(), Ok("true"));
    let scratch = Scratch::new();
    let mut conn = scratch.open();
    crate::replace_app_state(&mut conn, &state()).unwrap();
    conn.execute_batch("BEGIN").unwrap();
    for (index, rows) in [135, 68, 27].into_iter().enumerate() {
        let mut source = template(17 + index as u64, rows);
        let template_id = format!("template-{index}");
        source["id"] = json!(template_id);
        write_at(
            &conn,
            "listTemplates",
            &template_id,
            index as i64,
            &source,
            now(0),
        )
        .unwrap();
        for day in 0..1095 {
            if day > 0 && day % 7 == 0 {
                source["items"][day % rows]["text"] = json!(format!(
                    "{} revised-{day}",
                    source["items"][day % rows]["text"]
                        .as_str()
                        .unwrap()
                        .split_whitespace()
                        .take(19)
                        .collect::<Vec<_>>()
                        .join(" ")
                ));
                write_at(
                    &conn,
                    "listTemplates",
                    &template_id,
                    index as i64,
                    &source,
                    now(day as i64),
                )
                .unwrap();
            }
            let mut value = daily(&source, day);
            let id = format!("list-{index}-{day}");
            value["id"] = json!(id);
            value["listTemplateId"] = json!(template_id);
            value["items"] = Value::Array(
                value["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .enumerate()
                    .filter(|(i, _)| (i + day) % 3 == 0)
                    .map(|(_, v)| v.clone())
                    .collect(),
            );
            write_at(
                &conn,
                "lists",
                &id,
                (day * 3 + index) as i64,
                &value,
                now(day as i64),
            )
            .unwrap();
        }
    }
    conn.execute_batch("COMMIT").unwrap();
    for sequence in 1..=12 {
        let key = format!("list-{}-1094", sequence % 3);
        let before = crate::current_entity(&conn, "lists", &key)
            .unwrap()
            .unwrap()
            .1;
        let mut after = before.clone();
        after["items"][0]["text"] = json!(format!("Synthetic edited word {sequence}"));
        let operation = json!({"id":format!("complete-profile-{sequence}"),"deviceId":"synthetic-device","sequence":sequence,
            "type":"apply_entity_changes","timestamp":format!("2023-01-01T12:00:{sequence:02}Z"),
            "payload":{"action":"patch_list_item","entityChanges":{"version":2,"deletes":[],"upserts":[{
                "collection":"lists","key":key,"position":null,"value":after,"patches":[crate::sync::entities::diff(&before,&after)]}]}}});
        crate::persist_operation_to_database(&mut conn, &operation).unwrap();
    }
    crate::sync::enable_primary(&conn).unwrap();
    crate::sync::checkpoint_operation_log_preserving_history(&conn).unwrap();
    conn.execute_batch("VACUUM").unwrap();
    let compressed_bytes = fs::metadata(scratch.path()).unwrap().len();
    drop(conn);
    let conn = scratch.open();
    let tick = Instant::now();
    let compressed_state = crate::read_app_state_from_database(&conn).unwrap().unwrap();
    let compressed_read_ms = tick.elapsed().as_millis();
    let operations = crate::sync::all_ops(&conn).unwrap();
    let history_count = count(&conn, "history_entries");
    let retained_json_bytes: i64 = conn
        .query_row(
            "SELECT coalesce(sum(length(payload_json)),0) FROM operations",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let rows = conn
        .prepare("SELECT entity_key,value_json FROM state_entities WHERE collection='lists'")
        .unwrap()
        .query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, SqlValue>(1)?))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    conn.execute_batch("BEGIN").unwrap();
    let mut reader = Reader::new(&conn);
    for (key, raw) in rows {
        let logical = reader.read(raw).unwrap();
        conn.execute(
            "UPDATE state_entities SET value_json=?1 WHERE collection='lists' AND entity_key=?2",
            params![logical.to_string(), key],
        )
        .unwrap();
    }
    drop(reader);
    conn.execute_batch(
        "UPDATE list_storage_records SET dictionary_id=NULL;
        DELETE FROM list_storage_policies; DELETE FROM list_storage_dictionaries; COMMIT; VACUUM;",
    )
    .unwrap();
    let plain_bytes = fs::metadata(scratch.path()).unwrap().len();
    drop(conn);
    let conn = scratch.open();
    let tick = Instant::now();
    let plain_state = crate::read_app_state_from_database(&conn).unwrap().unwrap();
    let plain_read_ms = tick.elapsed().as_millis();
    assert_eq!(plain_state, compressed_state);
    assert_eq!(crate::sync::all_ops(&conn).unwrap(), operations);
    assert_eq!(count(&conn, "history_entries"), history_count);
    assert!(compressed_bytes < plain_bytes);
    println!(
        "BALANCE_COMPLETE_DATABASE_PROFILE: {}",
        json!({"days":1095,"lists":3285,
        "compressedDatabaseBytes":compressed_bytes,"plainDatabaseBytes":plain_bytes,
        "compressedFullStateReadMs":compressed_read_ms,"plainFullStateReadMs":plain_read_ms,
        "operationPayloadBytes":retained_json_bytes,"historyEntries":history_count,
        "operations":operations.len()})
    );
}
