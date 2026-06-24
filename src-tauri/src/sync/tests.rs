//! Integration tests for op-log sync against the **real** Balance database
//! layer: the app's own `open_database_at` (SQLCipher), `replace_app_state`, and
//! `persist_operation_to_database`. These prove that two devices converge by
//! replicating the operation log and rebuilding state through the existing
//! materializer — without ever restructuring the user's real data tables.

use std::path::PathBuf;

use serde_json::{json, Value};

use super::crypto::SyncKey;
use super::*;
use crate::{open_database_at, persist_operation_to_database, read_app_state_from_database, replace_app_state};

fn ext_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("crsqlite.dylib")
}

/// A unique scratch DB path that cleans up on drop.
struct Scratch {
    path: PathBuf,
}
impl Scratch {
    fn new(tag: &str) -> Self {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "balance-sync-{tag}-{}-{}.sqlite3",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        Scratch { path }
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// A minimal but complete app state (the shape `read_app_state_from_database`
/// produces and `replace_app_state` consumes).
fn state(device_id: &str, goals: Value) -> Value {
    json!({
        "schemaVersion": 1,
        "deviceId": device_id,
        "localSequence": 0,
        "historyRevision": 0,
        "activePlanDate": "2026-06-23",
        "templates": [],
        "plans": [],
        "goals": goals,
        "goalCompletions": [],
        "listTemplates": [],
        "lists": [],
        "metrics": [],
        "metricEntries": [],
        "operations": [],
    })
}

/// Open a real encrypted DB seeded with `initial`, then load cr-sqlite.
fn open_seeded(path: &std::path::Path, key: &str, initial: &Value) -> rusqlite::Connection {
    let mut conn = open_database_at(path, key).expect("open encrypted real schema");
    replace_app_state(&mut conn, initial).expect("seed state");
    load_extension(&conn, ext_path()).expect("load cr-sqlite");
    conn
}

/// Just the user-visible domain (excludes device-local fields like deviceId).
fn domain(state: &Value) -> Value {
    json!({
        "templates": state["templates"],
        "plans": state["plans"],
        "goals": state["goals"],
        "goalCompletions": state["goalCompletions"],
        "activePlanDate": state["activePlanDate"],
    })
}

#[test]
fn joiner_bootstraps_primary_data_without_touching_real_tables() {
    let sa = Scratch::new("prim");
    let sb = Scratch::new("join");

    // Primary (Mac) has real data; joiner (phone) has its own different data.
    let a = open_seeded(&sa.path, "key-a", &state("device-A", json!([{ "id": "g1", "name": "Read" }])));
    let b = open_seeded(&sb.path, "key-b", &state("device-B", json!([{ "id": "gx", "name": "PhoneJunk" }])));

    enable_primary(&a).expect("enable primary");
    enable_joiner(&b).expect("enable joiner");

    // The joiner's local data is cleared, ready to adopt the primary's.
    let b_before = read_app_state_from_database(&b).unwrap().unwrap();
    assert_eq!(b_before["goals"], json!([]), "joiner cleared its own data");

    // Sync primary -> joiner: ship ops, apply, replay.
    let changes = pull(&a, 0, None).unwrap();
    apply(&b, &changes).unwrap();
    rematerialize(&b).unwrap();

    let a_state = read_app_state_from_database(&a).unwrap().unwrap();
    let b_state = read_app_state_from_database(&b).unwrap().unwrap();
    assert_eq!(domain(&a_state), domain(&b_state), "joiner adopted the primary's state");
    assert_eq!(b_state["goals"], json!([{ "id": "g1", "name": "Read" }]));
    // Device identity stays local — the joiner keeps its own deviceId.
    assert_eq!(b_state["deviceId"], "device-B");

    // The real tables were never restructured: plan_items still has the integer
    // `position` column (no `position_key`), proving the app schema is intact.
    let cols: Vec<String> = {
        let mut stmt = b.prepare("PRAGMA table_info(plan_items)").unwrap();
        stmt.query_map([], |r| r.get::<_, String>(1)).unwrap().map(|r| r.unwrap()).collect()
    };
    assert!(cols.iter().any(|c| c == "position"), "integer position column preserved");
    assert!(!cols.iter().any(|c| c == "position_key"), "no destructive migration happened");

    finalize(&a).unwrap();
    finalize(&b).unwrap();
}

#[test]
fn incremental_edits_propagate_both_directions() {
    let sa = Scratch::new("inc-a");
    let sb = Scratch::new("inc-b");
    let mut a = open_seeded(&sa.path, "key-a", &state("device-A", json!([])));
    let mut b = open_seeded(&sb.path, "key-b", &state("device-B", json!([])));

    enable_primary(&a).unwrap();
    enable_joiner(&b).unwrap();
    // Initial bootstrap so both start converged.
    apply(&b, &pull(&a, 0, None).unwrap()).unwrap();
    rematerialize(&b).unwrap();

    // Device A makes an edit (changes the active plan date) through the real
    // op path, which logs it to `operations`.
    let op_a = json!({
        "id": "op-a-1", "deviceId": "device-A", "sequence": 1,
        "timestamp": "2026-06-23T12:00:00.000Z",
        "type": "set_active_plan_date", "payload": { "date": "2027-01-01" }
    });
    persist_operation_to_database(&mut a, &op_a).unwrap();

    // Sync A -> B.
    apply(&b, &pull(&a, 0, None).unwrap()).unwrap();
    rematerialize(&b).unwrap();
    assert_eq!(
        read_app_state_from_database(&b).unwrap().unwrap()["activePlanDate"],
        "2027-01-01",
        "A's edit reached B"
    );

    // Device B makes its own edit; sync back to A.
    let op_b = json!({
        "id": "op-b-1", "deviceId": "device-B", "sequence": 1,
        "timestamp": "2026-06-23T13:00:00.000Z",
        "type": "set_active_plan_date", "payload": { "date": "2028-02-02" }
    });
    persist_operation_to_database(&mut b, &op_b).unwrap();
    apply(&a, &pull(&b, 0, None).unwrap()).unwrap();
    rematerialize(&a).unwrap();

    // Both converge to the later edit (canonical order by timestamp).
    let a_date = read_app_state_from_database(&a).unwrap().unwrap()["activePlanDate"].clone();
    let b_date = read_app_state_from_database(&b).unwrap().unwrap()["activePlanDate"].clone();
    assert_eq!(a_date, b_date, "devices converge");
    assert_eq!(a_date, "2028-02-02");

    finalize(&a).unwrap();
    finalize(&b).unwrap();
}

/// Regression: once sync is enabled the `operations` log is a CRR whose triggers
/// call `crsql_internal_sync_bit()`. A later write on a *fresh* connection that
/// did not load cr-sqlite (the normal app open path) fails with "no such
/// function" — which is exactly what broke real data. The fix is that every
/// writer loads the extension when sync is on; this test pins both halves.
#[test]
fn writes_after_sync_enabled_require_the_extension_loaded() {
    let s = Scratch::new("crr-write");
    let key = "key-crr";

    // Enable sync on this device, then finalize + drop the connection, mirroring
    // the app closing the connection after the sync_enable command returns.
    {
        let mut conn = open_seeded(&s.path, key, &state("device-A", json!([])));
        enable_primary(&conn).unwrap();
        finalize(&conn).unwrap();
        // (conn dropped here)
        let _ = &mut conn;
    }

    let op = json!({
        "id": "op-x", "deviceId": "device-A", "sequence": 1,
        "timestamp": "2026-06-23T12:00:00.000Z",
        "type": "set_active_plan_date", "payload": { "date": "2027-03-03" }
    });

    // Reproduce the failure: a plain reopen (no extension) cannot write the CRR.
    {
        let mut bare = open_database_at(&s.path, key).unwrap();
        let err = persist_operation_to_database(&mut bare, &op).unwrap_err();
        assert!(
            err.contains("crsql_internal_sync_bit"),
            "expected the CRR-trigger failure, got: {err}"
        );
    }

    // The fix: load the extension first (what `with_database` does in the app),
    // and the same write succeeds and is captured for replication.
    {
        let mut conn = open_database_at(&s.path, key).unwrap();
        load_extension(&conn, ext_path()).unwrap();
        persist_operation_to_database(&mut conn, &op).unwrap();
        assert_eq!(
            read_app_state_from_database(&conn).unwrap().unwrap()["activePlanDate"],
            "2027-03-03"
        );
        // The write landed in the replication log.
        assert!(!pull(&conn, 0, None).unwrap().rows.is_empty(), "write captured for sync");
        finalize(&conn).unwrap();
    }
}

#[test]
fn p2p_socket_sync_bootstraps_over_the_network() {
    use super::transport::{sync_accept, sync_connect, Cursors};
    use std::net::TcpListener;

    let sa = Scratch::new("p2p-a");
    let sb = Scratch::new("p2p-b");
    let a = open_seeded(&sa.path, "ka", &state("device-A", json!([{ "id": "g1", "name": "Read" }])));
    let b = open_seeded(&sb.path, "kb", &state("device-B", json!([])));
    enable_primary(&a).unwrap();
    enable_joiner(&b).unwrap();

    let key = SyncKey::generate();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap().to_string();

    // B (joiner) listens; A (primary) connects and pushes its data.
    let key_b = key.clone();
    let handle = std::thread::spawn(move || {
        let mut cursors = Cursors::new();
        sync_accept(&listener, &b, &key_b, &mut cursors).unwrap();
        let goals = read_app_state_from_database(&b).unwrap().unwrap()["goals"].clone();
        finalize(&b).unwrap();
        goals
    });

    let mut cursors = Cursors::new();
    sync_connect(&addr, &a, &key, &mut cursors).unwrap();
    let b_goals = handle.join().unwrap();

    // The joiner adopted the primary's data, peer-to-peer, no server involved.
    assert_eq!(b_goals, json!([{ "id": "g1", "name": "Read" }]));
    finalize(&a).unwrap();
}

#[test]
fn selftest_round_trips_against_real_extension() {
    // The same routine the Android debug build runs on-device, exercised here
    // with the desktop extension so the logic is covered locally.
    selftest(&ext_path(), &std::env::temp_dir()).expect("sync self-test must converge");
}

#[test]
fn pairing_code_round_trips_and_rejects_corruption() {
    let key = SyncKey::generate();
    let code = key.to_pairing_code();
    assert!(code.starts_with("BALSYNC1:"));

    let restored = SyncKey::from_pairing_code(&code).unwrap();
    assert_eq!(key.as_bytes(), restored.as_bytes());

    let cs = ChangeSet { origin_site_hex: "abcd".into(), rows: vec![] };
    let sealed = key.seal(&cs).unwrap();
    assert!(restored.open(&sealed).is_ok());

    let mut corrupt: Vec<char> = code.chars().collect();
    let last = corrupt.len() - 1;
    corrupt[last] = if corrupt[last] == 'A' { 'B' } else { 'A' };
    let corrupt: String = corrupt.into_iter().collect();
    assert!(SyncKey::from_pairing_code(&corrupt).is_err());
    assert!(SyncKey::from_pairing_code("not-a-code").is_err());
}
