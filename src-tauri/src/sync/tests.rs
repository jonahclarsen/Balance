//! Integration tests for op-log sync against the **real** Balance database
//! layer: the app's own `open_database_at` (SQLCipher), `replace_app_state`, and
//! `persist_operation_to_database`. These prove that two devices converge by
//! replicating the operation log and rebuilding state through the existing
//! materializer — without ever restructuring the user's real data tables, and
//! without any native extension.

use std::io::{BufRead, BufReader};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::Connection;
use serde_json::{json, Value};

use super::crypto::SyncKey;
use super::transport::{self, TIMEOUT_MESSAGE};
use super::*;
use crate::{
    open_database_at, persist_operation_to_database, read_app_state_from_database,
    replace_app_state,
};

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

struct ReferenceRelay {
    child: Child,
    url: String,
}

impl ReferenceRelay {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let project = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf();
        let secret = "balance_rust_client_test_1234";
        let mut child = Command::new("node")
            .arg(project.join("scripts/relay-server.mjs"))
            .arg(port.to_string())
            .env("BALANCE_RELAY_SECRET", secret)
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("start the Node reference relay");
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .expect("wait for relay startup");
        assert!(line.contains("Balance relay listening"), "{line}");
        Self {
            child,
            url: format!("http://127.0.0.1:{port}/{secret}"),
        }
    }
}

impl Drop for ReferenceRelay {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
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
        "notes": [],
        "operations": [],
    })
}

fn large_workspace_state(device_id: &str) -> Value {
    const FIXTURE_PLANS: usize = 365;
    const ITEMS_PER_PLAN: usize = 20;
    let plans = (0..FIXTURE_PLANS)
        .map(|plan_index| {
            let items = (0..ITEMS_PER_PLAN)
                .map(|item_index| {
                    json!({
                        "id": format!("relay-fixture-item-{plan_index}-{item_index}"),
                        "text": format!("Synthetic existing task {plan_index}-{item_index}"),
                        "html": format!("Synthetic existing task {plan_index}-{item_index}"),
                        "done": item_index % 3 == 0,
                        "startMinutes": Value::Null,
                        "endMinutes": Value::Null,
                        "children": [],
                    })
                })
                .collect::<Vec<_>>();
            let year = 2025 + plan_index / (12 * 28);
            let day_of_year = plan_index % (12 * 28);
            json!({
                "id": format!("relay-fixture-plan-{plan_index}"),
                "date": format!("{year}-{:02}-{:02}", day_of_year / 28 + 1, day_of_year % 28 + 1),
                "title": format!("Synthetic day {plan_index}"),
                "dailyReminder": "Synthetic fixture",
                "createdAt": "2025-01-01T00:00:00.000Z",
                "items": items,
            })
        })
        .collect::<Vec<_>>();
    let mut fixture = state(device_id, json!([]));
    fixture["plans"] = Value::Array(plans);
    fixture
}

/// Open a real encrypted DB seeded with `initial`.
fn open_seeded(path: &std::path::Path, key: &str, initial: &Value) -> Connection {
    let key = test_database_key(key);
    let mut conn = open_database_at(path, &key).expect("open encrypted real schema");
    replace_app_state(&mut conn, initial).expect("seed state");
    conn
}

fn test_database_key(label: &str) -> String {
    use sha2::{Digest, Sha256};
    let encoded = data_encoding::BASE32_NOPAD.encode(&Sha256::digest(label.as_bytes()));
    crate::database_keys::RecoveryKey::parse(&encoded)
        .unwrap()
        .canonical()
        .to_string()
}

/// Just the user-visible domain (excludes device-local fields like deviceId).
fn domain(state: &Value) -> Value {
    json!({
        "preferences": state["preferences"],
        "templates": state["templates"],
        "plans": state["plans"],
        "goals": state["goals"],
        "goalCompletions": state["goalCompletions"],
        "listTemplates": state["listTemplates"],
        "lists": state["lists"],
        "metrics": state["metrics"],
        "metricEntries": state["metricEntries"],
        "notes": state["notes"],
        "activePlanDate": state["activePlanDate"],
    })
}

/// The tables whose materialized contents must match once two devices converge.
const MATERIALIZED_TABLES: [&str; 6] = [
    "templates",
    "template_items",
    "template_options",
    "plans",
    "plan_items",
    "state_entities",
];

/// A [`SyncStore`] shaped exactly like the app's `p2p::AppStore`: one shared
/// connection behind a lock that is taken *per call* and released before the
/// transport touches the socket again. Also counts merged ops, so tests can
/// assert that a redundant sync inserts nothing.
#[derive(Clone)]
struct TestStore {
    connection: Arc<Mutex<Connection>>,
    merged: Arc<AtomicUsize>,
}

impl TestStore {
    fn new(connection: Connection) -> Self {
        TestStore {
            connection: Arc::new(Mutex::new(connection)),
            merged: Arc::new(AtomicUsize::new(0)),
        }
    }

    /// Ops merged into this device since the last [`TestStore::reset_merged`].
    fn merged(&self) -> usize {
        self.merged.load(Ordering::SeqCst)
    }

    fn reset_merged(&self) {
        self.merged.store(0, Ordering::SeqCst);
    }

    fn read<T>(&self, task: impl FnOnce(&Connection) -> T) -> T {
        task(&self.connection.lock().unwrap())
    }

    fn write<T>(&self, task: impl FnOnce(&mut Connection) -> T) -> T {
        task(&mut self.connection.lock().unwrap())
    }

    fn state(&self) -> Value {
        self.read(|conn| read_app_state_from_database(conn).unwrap().unwrap())
    }

    fn operation_ids(&self) -> Vec<String> {
        self.read(|conn| local_op_ids(conn).unwrap())
    }
}

impl SyncStore for TestStore {
    fn inventory(&self) -> Result<SyncInventory> {
        self.read(sync_inventory)
    }

    fn diff(&self, peer: &SyncInventory) -> Result<(Vec<Op>, Vec<String>)> {
        self.read(|conn| diff_against(conn, peer))
    }

    fn ops_by_id(&self, ids: &[String]) -> Result<Vec<Op>> {
        self.read(|conn| ops_by_id(conn, ids))
    }

    fn merge(&self, ops: Vec<Op>) -> Result<usize> {
        let inserted = self.read(|conn| merge_and_rematerialize(conn, ops))?;
        self.merged.fetch_add(inserted, Ordering::SeqCst);
        Ok(inserted)
    }
}

/// Run one complete bidirectional exchange over a real loopback socket.
fn exchange(initiator: &TestStore, responder: &TestStore, key: &SyncKey) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap().to_string();
    let responder_key = key.clone();
    let responder = responder.clone();
    let accepted =
        std::thread::spawn(move || transport::sync_accept(&listener, &responder_key, &responder));
    transport::sync_connect(&address, key, initiator).expect("initiator sync");
    accepted.join().unwrap().expect("responder sync");
}

fn set_active_plan_date_op(
    id: &str,
    device_id: &str,
    sequence: i64,
    at: &str,
    date: &str,
) -> Value {
    json!({
        "id": id,
        "deviceId": device_id,
        "sequence": sequence,
        "timestamp": at,
        "type": "set_active_plan_date",
        "payload": { "date": date },
    })
}

fn patch_preferences_op(id: &str, device_id: &str, sequence: i64, at: &str, patch: Value) -> Value {
    json!({
        "id": id,
        "deviceId": device_id,
        "sequence": sequence,
        "type": "patch_preferences",
        "timestamp": at,
        "payload": { "patch": patch },
    })
}

#[test]
fn the_v3_http_client_bootstraps_then_sends_only_incremental_operations() {
    let relay = ReferenceRelay::start();
    let sa = Scratch::new("http-a");
    let sb = Scratch::new("http-b");
    let mut a = open_seeded(&sa.path, "key-a", &state("device-A", json!([])));
    let b = open_seeded(&sb.path, "key-b", &state("device-B", json!([])));
    enable_primary(&a).unwrap();
    enable_joiner(&b).unwrap();
    let key = SyncKey::generate();

    let bootstrap = relay_client::sync_once(
        &a,
        &relay.url,
        &key,
        relay_client::SyncOptions::foreground(true),
    )
    .unwrap();
    assert!(bootstrap.checkpoint_committed);
    let joined = relay_client::sync_once(
        &b,
        &relay.url,
        &key,
        relay_client::SyncOptions::foreground(true),
    )
    .unwrap();
    assert!(joined.state_changed);
    assert_eq!(
        domain(&read_app_state_from_database(&a).unwrap().unwrap()),
        domain(&read_app_state_from_database(&b).unwrap().unwrap())
    );

    persist_operation_to_database(
        &mut a,
        &set_active_plan_date_op(
            "http-increment",
            "device-A",
            1,
            "2026-08-01T12:00:00Z",
            "2027-08-01",
        ),
    )
    .unwrap();
    let pushed = relay_client::sync_once(
        &a,
        &relay.url,
        &key,
        relay_client::SyncOptions::foreground(true),
    )
    .unwrap();
    assert_eq!(pushed.pushed_operations, 1);
    assert!(!pushed.checkpoint_committed);

    let pulled = relay_client::sync_once(
        &b,
        &relay.url,
        &key,
        relay_client::SyncOptions::foreground(true),
    )
    .unwrap();
    assert_eq!(pulled.pulled_operations, 1);
    assert_eq!(
        read_app_state_from_database(&b).unwrap().unwrap()["activePlanDate"],
        "2027-08-01",
    );
    let redundant = relay_client::sync_once(
        &b,
        &relay.url,
        &key,
        relay_client::SyncOptions::foreground(true),
    )
    .unwrap();
    assert_eq!(redundant.pulled_operations, 0);
    assert_eq!(redundant.pushed_operations, 0);
}

#[test]
#[ignore = "large synthetic relay performance profile run explicitly in CI"]
fn a_large_workspace_receives_two_long_duration_tasks_over_the_relay() {
    let relay = ReferenceRelay::start();
    let desktop_scratch = Scratch::new("large-relay-desktop");
    let android_scratch = Scratch::new("large-relay-android");
    let total_started = std::time::Instant::now();
    let desktop = open_seeded(
        &desktop_scratch.path,
        "large-relay-desktop-key",
        &large_workspace_state("desktop-device"),
    );
    let mut android = open_seeded(
        &android_scratch.path,
        "large-relay-android-key",
        &state("android-device", json!([])),
    );
    enable_primary(&desktop).unwrap();
    enable_joiner(&android).unwrap();
    let seeded_ms = total_started.elapsed().as_millis();
    let key = SyncKey::generate();

    let bootstrap_started = std::time::Instant::now();
    let desktop_bootstrap = relay_client::sync_once(
        &desktop,
        &relay.url,
        &key,
        relay_client::SyncOptions::foreground(true),
    )
    .unwrap();
    assert!(desktop_bootstrap.checkpoint_committed);
    let android_bootstrap = relay_client::sync_once(
        &android,
        &relay.url,
        &key,
        relay_client::SyncOptions::foreground(true),
    )
    .unwrap();
    assert!(android_bootstrap.state_changed);
    let bootstrap_ms = bootstrap_started.elapsed().as_millis();

    for (sequence, (id, text, start_minutes, end_minutes)) in [
        (
            "relay-long-task-1",
            "Synthetic twelve-hour task",
            0,
            12 * 60,
        ),
        (
            "relay-long-task-2",
            "Synthetic almost-all-day task",
            12 * 60,
            36 * 60 - 1,
        ),
    ]
    .into_iter()
    .enumerate()
    {
        persist_operation_to_database(
            &mut android,
            &json!({
                "id": format!("relay-long-task-op-{sequence}"),
                "deviceId": "android-device",
                "sequence": sequence + 1,
                "timestamp": format!("2026-08-15T12:00:0{sequence}.000Z"),
                "type": "add_plan_item",
                "payload": {
                    "planId": "relay-fixture-plan-0",
                    "parentId": Value::Null,
                    "item": {
                        "id": id,
                        "text": text,
                        "html": text,
                        "done": false,
                        "startMinutes": start_minutes,
                        "endMinutes": end_minutes,
                        "children": [],
                    }
                }
            }),
        )
        .unwrap();
    }

    let push_started = std::time::Instant::now();
    let pushed = relay_client::sync_once(
        &android,
        &relay.url,
        &key,
        relay_client::SyncOptions::foreground(true),
    )
    .unwrap();
    let android_push_ms = push_started.elapsed().as_millis();
    assert_eq!(pushed.pushed_operations, 2);

    let pull_started = std::time::Instant::now();
    let pulled = relay_client::sync_once(
        &desktop,
        &relay.url,
        &key,
        relay_client::SyncOptions::foreground(true),
    )
    .unwrap();
    let desktop_pull_ms = pull_started.elapsed().as_millis();
    assert_eq!(pulled.pulled_operations, 2);
    assert!(pulled.state_changed);

    let desktop_state = read_app_state_from_database(&desktop).unwrap().unwrap();
    let target_items = desktop_state["plans"]
        .as_array()
        .and_then(|plans| {
            plans
                .iter()
                .find(|plan| plan["id"] == "relay-fixture-plan-0")
        })
        .and_then(|plan| plan["items"].as_array())
        .unwrap();
    assert!(target_items
        .iter()
        .any(|item| item["id"] == "relay-long-task-1"));
    assert!(target_items
        .iter()
        .any(|item| item["id"] == "relay-long-task-2"));
    assert!(
        desktop_pull_ms.saturating_mul(10) < bootstrap_ms,
        "two appended relay tasks took {desktop_pull_ms} ms after a {bootstrap_ms} ms full bootstrap"
    );

    eprintln!(
        "BALANCE_RELAY_LARGE_TASK_PROFILE: {}",
        json!({
            "fixturePlans": 365,
            "fixturePlanItems": 7300,
            "seedAndCheckpointMs": seeded_ms,
            "bootstrapMs": bootstrap_ms,
            "androidPushMs": android_push_ms,
            "desktopPullMs": desktop_pull_ms,
            "totalMs": total_started.elapsed().as_millis(),
        })
    );
}

#[test]
fn a_large_relay_bootstrap_finishes_for_a_foreground_joiner() {
    let relay = ReferenceRelay::start();
    let sa = Scratch::new("large-http-a");
    let sb = Scratch::new("large-http-b");

    // Synthetic, high-entropy text keeps the encrypted checkpoint above the
    // Android background budget after compression without touching user data.
    let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut random_state = 0x1234_5678_9abc_def0_u64;
    let large_title = (0..10 * 1024 * 1024)
        .map(|_| {
            random_state ^= random_state << 13;
            random_state ^= random_state >> 7;
            random_state ^= random_state << 17;
            alphabet[(random_state as usize) & 63] as char
        })
        .collect::<String>();
    let mut primary_state = state("device-A", json!([]));
    primary_state["notes"] = json!([{
        "id": "large-note",
        "title": large_title,
        "items": [],
        "createdAt": "created",
        "updatedAt": "updated"
    }]);

    let a = open_seeded(&sa.path, "key-a", &primary_state);
    let b = open_seeded(&sb.path, "key-b", &state("device-B", json!([])));
    enable_primary(&a).unwrap();
    enable_joiner(&b).unwrap();
    let key = SyncKey::generate();

    let uploaded = relay_client::sync_once(
        &a,
        &relay.url,
        &key,
        relay_client::SyncOptions::foreground(true),
    )
    .unwrap();
    assert!(uploaded.checkpoint_committed);

    let deferred = relay_client::sync_once(
        &b,
        &relay.url,
        &key,
        relay_client::SyncOptions::background(),
    )
    .unwrap_err();
    assert!(deferred
        .to_string()
        .contains("the pending sync is large and will finish next time Balance is open"));

    // Foreground status permits both large downloads and safe compare-and-swap
    // relay compaction, regardless of which device originally created the room.
    let joined = relay_client::sync_once(
        &b,
        &relay.url,
        &key,
        relay_client::SyncOptions::foreground(true),
    )
    .unwrap();
    assert!(joined.state_changed);
    assert_eq!(
        domain(&read_app_state_from_database(&a).unwrap().unwrap()),
        domain(&read_app_state_from_database(&b).unwrap().unwrap())
    );
}

#[test]
fn a_foreground_joiner_can_promote_one_oversized_operation() {
    let relay = ReferenceRelay::start();
    let sa = Scratch::new("large-joiner-a");
    let sb = Scratch::new("large-joiner-b");
    let a = open_seeded(&sa.path, "key-a", &state("device-A", json!([])));
    let mut b = open_seeded(&sb.path, "key-b", &state("device-B", json!([])));
    enable_primary(&a).unwrap();
    enable_joiner(&b).unwrap();
    let key = SyncKey::generate();

    relay_client::sync_once(
        &a,
        &relay.url,
        &key,
        relay_client::SyncOptions::foreground(true),
    )
    .unwrap();
    relay_client::sync_once(
        &b,
        &relay.url,
        &key,
        relay_client::SyncOptions::foreground(true),
    )
    .unwrap();

    let mut random = vec![0_u8; 800 * 1024];
    rand::rngs::OsRng.fill_bytes(&mut random);
    let large_value = hex(&random);
    persist_operation_to_database(
        &mut b,
        &set_active_plan_date_op(
            "large-joiner-operation",
            "device-B",
            1,
            "2026-08-14T12:00:00Z",
            &large_value,
        ),
    )
    .unwrap();

    let compacted = relay_client::sync_once(
        &b,
        &relay.url,
        &key,
        relay_client::SyncOptions::foreground(true),
    )
    .unwrap();
    assert!(compacted.checkpoint_committed);

    let received = relay_client::sync_once(
        &a,
        &relay.url,
        &key,
        relay_client::SyncOptions::foreground(true),
    )
    .unwrap();
    assert!(received.state_changed);
    assert_eq!(
        read_app_state_from_database(&a).unwrap().unwrap()["activePlanDate"],
        large_value,
    );
}

#[test]
fn a_foreground_joiner_compacts_an_accumulated_generation() {
    let relay = ReferenceRelay::start();
    let sa = Scratch::new("generation-uploader");
    let sb = Scratch::new("generation-compactor");
    let mut a = open_seeded(&sa.path, "key-a", &state("device-A", json!([])));
    let b = open_seeded(&sb.path, "key-b", &state("device-B", json!([])));
    enable_primary(&a).unwrap();
    enable_joiner(&b).unwrap();
    let key = SyncKey::generate();

    relay_client::sync_once(
        &a,
        &relay.url,
        &key,
        relay_client::SyncOptions::foreground(true),
    )
    .unwrap();
    relay_client::sync_once(
        &b,
        &relay.url,
        &key,
        relay_client::SyncOptions::foreground(true),
    )
    .unwrap();

    // Model the original coordinator being unavailable for compaction while
    // another device steadily fills the relay generation with valid deltas.
    // The relay begins recommending compaction at 128 batches.
    for sequence in 1..=128 {
        let date = format!("generation-value-{sequence}");
        persist_operation_to_database(
            &mut a,
            &set_active_plan_date_op(
                &format!("generation-op-{sequence}"),
                "device-A",
                sequence,
                "2026-08-14T12:00:00Z",
                &date,
            ),
        )
        .unwrap();
        relay_client::sync_once(
            &a,
            &relay.url,
            &key,
            relay_client::SyncOptions::foreground(false),
        )
        .unwrap();
    }

    let compacted = relay_client::sync_once(
        &b,
        &relay.url,
        &key,
        relay_client::SyncOptions::foreground(true),
    )
    .unwrap();
    assert!(compacted.checkpoint_committed);
    assert_eq!(compacted.pulled_operations, 128);
    assert_eq!(
        read_app_state_from_database(&b).unwrap().unwrap()["activePlanDate"],
        "generation-value-128",
    );
}

// ---------------------------------------------------------------------------
// 1. First sync over a real socket
// ---------------------------------------------------------------------------

#[test]
fn first_sync_converges_and_the_joiner_keeps_its_own_device_id() {
    let sa = Scratch::new("prim");
    let sb = Scratch::new("join");

    // Primary (Mac) has real data; joiner (phone) has its own different data.
    let a = open_seeded(
        &sa.path,
        "key-a",
        &state("device-A", json!([{ "id": "g1", "name": "Read" }])),
    );
    let b = open_seeded(
        &sb.path,
        "key-b",
        &state("device-B", json!([{ "id": "gx", "name": "PhoneJunk" }])),
    );
    enable_primary(&a).expect("enable primary");
    enable_joiner(&b).expect("enable joiner");

    let a = TestStore::new(a);
    let b = TestStore::new(b);

    // The joiner's local data is cleared, ready to adopt the primary's.
    assert_eq!(b.state()["goals"], json!([]), "joiner cleared its own data");

    exchange(&b, &a, &SyncKey::generate());

    assert_eq!(
        domain(&a.state()),
        domain(&b.state()),
        "joiner adopted the primary's state"
    );
    assert_eq!(b.state()["goals"], json!([{ "id": "g1", "name": "Read" }]));
    assert_eq!(
        a.read(|conn| state_hash(conn, &MATERIALIZED_TABLES).unwrap()),
        b.read(|conn| state_hash(conn, &MATERIALIZED_TABLES).unwrap()),
        "materialized tables are byte-identical"
    );
    // Device identity stays local — the joiner keeps its own deviceId.
    assert_eq!(b.state()["deviceId"], "device-B");
    assert_eq!(a.operation_ids(), b.operation_ids());

    // The real tables were never restructured: plan_items still has the integer
    // `position` column (no `position_key`), proving the app schema is intact.
    let columns: Vec<String> = b.read(|conn| {
        let mut stmt = conn.prepare("PRAGMA table_info(plan_items)").unwrap();
        let names = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        names
    });
    assert!(
        columns.iter().any(|column| column == "position"),
        "integer position column preserved"
    );
    assert!(
        !columns.iter().any(|column| column == "position_key"),
        "no destructive migration happened"
    );
}

#[test]
fn v4_entity_delta_converges_without_replicating_unrelated_entities() {
    let sa = Scratch::new("entity-delta-a");
    let sb = Scratch::new("entity-delta-b");
    let sentinel = "UNRELATED-SYNC-SENTINEL-".repeat(4_000);
    let mut primary_state = state("device-A", json!([]));
    primary_state["notes"] = json!([
        { "id": "edited", "title": "Before", "items": [], "createdAt": "c", "updatedAt": "u" },
        { "id": "unrelated", "title": sentinel, "items": [], "createdAt": "c", "updatedAt": "u" }
    ]);
    let a = open_seeded(&sa.path, "key-a", &primary_state);
    let b = open_seeded(&sb.path, "key-b", &state("device-B", json!([])));
    enable_primary(&a).unwrap();
    enable_joiner(&b).unwrap();
    let mut operation_connection = open_database_at(&sa.path, &test_database_key("key-a")).unwrap();
    persist_operation_to_database(
        &mut operation_connection,
        &json!({
            "id": "v4-note-delta", "deviceId": "device-A", "sequence": 1,
            "type": "rename_note", "timestamp": "2026-08-12T12:00:00Z",
            "payload": {
                "noteId": "edited", "title": "After",
                "entityChanges": {
                    "version": 1,
                    "upserts": [{
                        "collection": "notes", "key": "edited", "position": 0,
                        "value": { "id": "edited", "title": "After", "items": [], "createdAt": "c", "updatedAt": "v" }
                    }],
                    "deletes": []
                }
            }
        }),
    )
    .unwrap();
    let payload: String = operation_connection
        .query_row(
            "select payload_json from operations where id = 'v4-note-delta'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!payload.contains("UNRELATED-SYNC-SENTINEL"));
    drop(operation_connection);

    let a = TestStore::new(open_database_at(&sa.path, &test_database_key("key-a")).unwrap());
    let b = TestStore::new(b);
    exchange(&b, &a, &SyncKey::generate());
    assert_eq!(domain(&a.state()), domain(&b.state()));
    assert_eq!(b.state()["notes"][0]["title"], "After");
    assert_eq!(b.state()["notes"][1]["title"], sentinel);
}

// ---------------------------------------------------------------------------
// 2. Re-sync is a no-op
// ---------------------------------------------------------------------------

#[test]
fn a_second_sync_with_no_new_operations_merges_nothing() {
    let sa = Scratch::new("idem-a");
    let sb = Scratch::new("idem-b");
    let a = open_seeded(&sa.path, "key-a", &state("device-A", json!([])));
    let b = open_seeded(&sb.path, "key-b", &state("device-B", json!([])));
    enable_primary(&a).unwrap();
    enable_joiner(&b).unwrap();
    let a = TestStore::new(a);
    let b = TestStore::new(b);
    let key = SyncKey::generate();

    exchange(&b, &a, &key);
    assert_eq!(b.merged(), 1, "joiner adopts the primary's baseline op");
    assert_eq!(a.merged(), 0);

    a.reset_merged();
    b.reset_merged();
    exchange(&b, &a, &key);
    assert_eq!(a.merged(), 0, "nothing new to insert");
    assert_eq!(b.merged(), 0, "nothing new to insert");
    assert_eq!(a.operation_ids(), b.operation_ids());
}

// ---------------------------------------------------------------------------
// 3. Edits made on both sides between syncs
// ---------------------------------------------------------------------------

#[test]
fn operations_created_on_both_devices_between_syncs_all_propagate() {
    let sa = Scratch::new("both-a");
    let sb = Scratch::new("both-b");
    let a = open_seeded(&sa.path, "key-a", &state("device-A", json!([])));
    let b = open_seeded(&sb.path, "key-b", &state("device-B", json!([])));
    enable_primary(&a).unwrap();
    enable_joiner(&b).unwrap();
    let a = TestStore::new(a);
    let b = TestStore::new(b);
    let key = SyncKey::generate();

    exchange(&b, &a, &key);

    // Each device edits independently while offline from the other.
    a.write(|conn| {
        persist_operation_to_database(
            conn,
            &set_active_plan_date_op(
                "op-a-1",
                "device-A",
                1,
                "2026-06-23T12:00:00.000Z",
                "2027-01-01",
            ),
        )
        .unwrap()
    });
    b.write(|conn| {
        persist_operation_to_database(
            conn,
            &set_active_plan_date_op(
                "op-b-1",
                "device-B",
                1,
                "2026-06-23T13:00:00.000Z",
                "2028-02-02",
            ),
        )
        .unwrap()
    });

    a.reset_merged();
    b.reset_merged();
    exchange(&a, &b, &key);

    assert_eq!(a.merged(), 1, "A receives B's op");
    assert_eq!(b.merged(), 1, "B receives A's op");
    assert_eq!(a.operation_ids(), b.operation_ids());
    // Both converge on the later edit — canonical order is by timestamp.
    assert_eq!(a.state()["activePlanDate"], "2028-02-02");
    assert_eq!(domain(&a.state()), domain(&b.state()));

    // A third sync changes nothing.
    a.reset_merged();
    b.reset_merged();
    exchange(&b, &a, &key);
    assert_eq!((a.merged(), b.merged()), (0, 0));
}

#[test]
fn replicated_preferences_converge_and_survive_a_checkpoint() {
    let sa = Scratch::new("preferences-a");
    let sb = Scratch::new("preferences-b");
    let a = open_seeded(&sa.path, "key-a", &state("device-A", json!([])));
    let b = open_seeded(&sb.path, "key-b", &state("device-B", json!([])));
    enable_primary(&a).unwrap();
    enable_joiner(&b).unwrap();
    let a = TestStore::new(a);
    let b = TestStore::new(b);
    let key = SyncKey::generate();

    exchange(&b, &a, &key);
    a.write(|connection| {
        persist_operation_to_database(
            connection,
            &patch_preferences_op(
                "preferences-a-1",
                "device-A",
                1,
                "2026-08-15T12:00:00.000Z",
                json!({
                    "themeId": "midnight",
                    "interfaceFontId": "bookish",
                    "doneTintColor": "#123456",
                    "checkboxColor": "#abcdef",
                    "databaseLoadingMessages": ["One", "Two"],
                    "futurePreference": { "enabled": true }
                }),
            ),
        )
        .unwrap()
    });
    exchange(&b, &a, &key);

    let expected = json!({
        "themeId": "midnight",
        "interfaceFontId": "bookish",
        "doneTintColor": "#123456",
        "checkboxColor": "#abcdef",
        "databaseLoadingMessages": ["One", "Two"],
        "futurePreference": { "enabled": true }
    });
    assert_eq!(a.state()["preferences"], expected);
    assert_eq!(b.state()["preferences"], expected);

    a.read(|connection| checkpoint_operation_log(connection).unwrap());
    exchange(&b, &a, &key);
    assert_eq!(b.state()["preferences"], expected);
}

// ---------------------------------------------------------------------------
// 4. Checkpoint propagation
// ---------------------------------------------------------------------------

#[test]
fn a_checkpoint_replaces_the_peers_old_operations_with_a_compact_frontier() {
    let sa = Scratch::new("ckpt-a");
    let sb = Scratch::new("ckpt-b");
    let a = open_seeded(&sa.path, "key-a", &state("device-A", json!([])));
    let b = open_seeded(&sb.path, "key-b", &state("device-B", json!([])));
    enable_primary(&a).unwrap();
    enable_joiner(&b).unwrap();
    let a = TestStore::new(a);
    let b = TestStore::new(b);
    let key = SyncKey::generate();

    exchange(&b, &a, &key);
    a.write(|conn| {
        persist_operation_to_database(
            conn,
            &set_active_plan_date_op(
                "op-a-1",
                "device-A",
                1,
                "2026-06-23T12:00:00.000Z",
                "2027-01-01",
            ),
        )
        .unwrap()
    });
    exchange(&b, &a, &key);
    let shared_ids = a.operation_ids();
    assert_eq!(shared_ids.len(), 2);
    assert_eq!(shared_ids, b.operation_ids());

    // The coordinator compacts: the whole log collapses into one checkpoint.
    let expected_state = a.state();
    a.read(|conn| checkpoint_operation_log(conn).unwrap());
    let checkpoint_ids = a.operation_ids();
    assert_eq!(checkpoint_ids.len(), 1, "log is now one baseline op");
    assert_eq!(a.state(), expected_state, "compaction preserves state");

    let checkpoint = a.read(|conn| ops_by_id(conn, &checkpoint_ids).unwrap())[0].clone();
    let payload = serde_json::from_str::<Value>(&checkpoint.payload_json).unwrap();
    assert_eq!(payload["frontiers"]["device-A"], 1);
    assert!(payload.get("legacyReplaces").is_none());
    assert!(payload.get("replaces").is_none());

    // The peer still holds the pre-checkpoint log; syncing must collapse it.
    a.reset_merged();
    b.reset_merged();
    exchange(&b, &a, &key);

    assert_eq!(
        a.merged(),
        0,
        "the stale ops are covered by the checkpoint, never re-added"
    );
    assert_eq!(b.merged(), 1, "the peer accepts only the checkpoint");
    assert_eq!(b.operation_ids(), checkpoint_ids);
    assert_eq!(domain(&a.state()), domain(&b.state()));
    assert_eq!(b.state()["activePlanDate"], "2027-01-01");

    // A third sync must not resurrect anything.
    a.reset_merged();
    b.reset_merged();
    exchange(&a, &b, &key);
    assert_eq!((a.merged(), b.merged()), (0, 0));
    assert_eq!(a.operation_ids(), checkpoint_ids);
    assert_eq!(b.operation_ids(), checkpoint_ids);
}

#[test]
fn an_incoming_checkpoint_prunes_only_the_local_history_it_covers() {
    let sa = Scratch::new("checkpoint-history-a");
    let sb = Scratch::new("checkpoint-history-b");
    let a = open_seeded(&sa.path, "key-a", &state("device-A", json!([])));
    let mut b = open_seeded(&sb.path, "key-b", &state("device-B", json!([])));
    enable_primary(&a).unwrap();
    enable_joiner(&b).unwrap();
    merge_and_rematerialize(&b, all_ops(&a).unwrap()).unwrap();

    persist_operation_to_database(
        &mut b,
        &set_active_plan_date_op(
            "op-b-1",
            "device-B",
            1,
            "2026-06-23T12:00:00.000Z",
            "2027-01-01",
        ),
    )
    .unwrap();
    merge_and_rematerialize(&a, all_ops(&b).unwrap()).unwrap();
    checkpoint_operation_log(&a).unwrap();
    let checkpoint = all_ops(&a).unwrap().into_iter().next().unwrap();

    // This edit was made after the coordinator's snapshot and must retain both
    // its replicated operation and its local undo entry.
    persist_operation_to_database(
        &mut b,
        &set_active_plan_date_op(
            "op-b-2",
            "device-B",
            2,
            "2026-06-23T12:01:00.000Z",
            "2027-01-02",
        ),
    )
    .unwrap();
    assert_eq!(merge_and_rematerialize(&b, vec![checkpoint]).unwrap(), 1);

    let operation_ids = local_op_ids(&b).unwrap();
    assert!(!operation_ids.contains(&"op-b-1".to_string()));
    assert!(operation_ids.contains(&"op-b-2".to_string()));
    let history: Vec<(String, i64)> = b
        .prepare("SELECT operation_id, sequence FROM history_entries ORDER BY sequence")
        .unwrap()
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<std::result::Result<_, _>>()
        .unwrap();
    assert_eq!(history, vec![("op-b-2".to_string(), 2)]);
    assert_eq!(
        read_app_state_from_database(&b).unwrap().unwrap()["activePlanDate"],
        "2027-01-02"
    );
}

// ---------------------------------------------------------------------------
// 5. Stale peer re-offering frontier-covered operations
// ---------------------------------------------------------------------------

#[test]
fn frontier_covered_operations_are_neither_wanted_nor_re_accepted() {
    let scratch = Scratch::new("stale");
    let mut conn = open_seeded(&scratch.path, "key", &state("device-A", json!([])));
    enable_primary(&conn).unwrap();
    persist_operation_to_database(
        &mut conn,
        &set_active_plan_date_op(
            "op-doomed",
            "device-A",
            1,
            "2026-06-23T12:00:00.000Z",
            "2027-01-01",
        ),
    )
    .unwrap();

    let stale_ops = all_ops(&conn).unwrap();
    let stale_inventory = SyncInventory {
        items: stale_ops
            .iter()
            .map(|op| InventoryItem {
                id: op.id.clone(),
                device_id: op.device_id.clone(),
                sequence: op.sequence,
                checkpoint: op.op_type == "replace_full_state",
            })
            .collect(),
        frontiers: HashMap::new(),
    };
    let expected_state = read_app_state_from_database(&conn).unwrap().unwrap();

    checkpoint_operation_log(&conn).unwrap();

    // A peer that missed the checkpoint offers the compacted ids back.
    let (ops, want) = diff_against(&conn, &stale_inventory).unwrap();
    assert_eq!(
        want,
        stale_ops
            .iter()
            .filter(|op| op.op_type == "replace_full_state")
            .map(|op| op.id.clone())
            .collect::<Vec<_>>(),
        "covered ordinary ops are never requested; an older checkpoint may be requested and deterministically rejected",
    );
    assert_eq!(ops.len(), 1, "the peer is offered the checkpoint instead");

    // Even if handed the raw rows, the merge refuses them.
    assert_eq!(merge_ops(&conn, &stale_ops).unwrap(), 0);
    assert_eq!(local_op_ids(&conn).unwrap().len(), 1);
    rematerialize(&conn).unwrap();
    assert_eq!(
        read_app_state_from_database(&conn).unwrap().unwrap(),
        expected_state,
        "compacted history cannot be resurrected"
    );
}

#[test]
fn a_checkpoint_refuses_to_compact_across_a_sequence_gap() {
    let scratch = Scratch::new("frontier-gap");
    let connection = open_seeded(&scratch.path, "key", &state("device-A", json!([])));
    enable_primary(&connection).unwrap();
    let sparse = Op {
        id: "device-b-sequence-2".into(),
        device_id: "device-B".into(),
        sequence: 2,
        op_type: "set_active_plan_date".into(),
        timestamp: "2026-08-01T12:00:00Z".into(),
        payload_json: json!({ "date": "2028-01-01" }).to_string(),
    };
    assert_eq!(
        merge_and_rematerialize(&connection, vec![sparse.clone()]).unwrap(),
        1
    );

    let state_before = read_app_state_from_database(&connection).unwrap().unwrap();
    let ids_before = local_op_ids(&connection).unwrap();
    let error = checkpoint_operation_log(&connection).unwrap_err();
    assert!(error.to_string().contains("sequence gaps"));
    assert_eq!(local_op_ids(&connection).unwrap(), ids_before);
    assert_eq!(
        read_app_state_from_database(&connection).unwrap().unwrap(),
        state_before
    );
}

#[test]
fn retired_checkpoint_and_snapshot_payloads_fail_closed() {
    let scratch = Scratch::new("retired-payloads");
    let connection = open_seeded(&scratch.path, "key", &state("device-A", json!([])));
    enable_primary(&connection).unwrap();
    let state_before = read_app_state_from_database(&connection).unwrap().unwrap();
    let ids_before = local_op_ids(&connection).unwrap();

    let retired_checkpoint = Op {
        id: "retired-checkpoint".into(),
        device_id: "device-B".into(),
        sequence: 0,
        op_type: "replace_full_state".into(),
        timestamp: "0000-00-00T00:00:00.000Z".into(),
        payload_json: json!({
            "state": state("device-B", json!([])),
            "replaces": ["old-operation"]
        })
        .to_string(),
    };
    assert!(merge_and_rematerialize(&connection, vec![retired_checkpoint]).is_err());

    let retired_snapshot = Op {
        id: "retired-snapshot".into(),
        device_id: "device-B".into(),
        sequence: 1,
        op_type: "replace_goal_data".into(),
        timestamp: "2026-08-16T00:00:00.000Z".into(),
        payload_json: json!({
            "goalData": { "goals": [], "goalCompletions": [] }
        })
        .to_string(),
    };
    assert!(merge_and_rematerialize(&connection, vec![retired_snapshot]).is_err());

    assert_eq!(local_op_ids(&connection).unwrap(), ids_before);
    assert_eq!(
        read_app_state_from_database(&connection).unwrap().unwrap(),
        state_before
    );
}

// ---------------------------------------------------------------------------
// 6. Timeouts surface a human message
// ---------------------------------------------------------------------------

#[test]
fn a_peer_that_never_speaks_produces_a_readable_timeout() {
    let scratch = Scratch::new("timeout");
    let conn = open_seeded(&scratch.path, "key", &state("device-A", json!([])));
    let store = TestStore::new(conn);

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    // Connect but never send an Offer, exactly like a device that went to sleep.
    let silent = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
    let (mut stream, _) = listener.accept().unwrap();
    stream
        .set_read_timeout(Some(Duration::from_millis(50)))
        .unwrap();

    let error = transport::run_responder(&mut stream, &SyncKey::generate(), &store).unwrap_err();
    assert_eq!(error.to_string(), format!("codec: {TIMEOUT_MESSAGE}"));
    assert!(
        !error.to_string().contains("os error"),
        "raw errno must not reach the user: {error}"
    );
    drop(silent);
}

// ---------------------------------------------------------------------------
// 7. Simultaneous mutual sync
// ---------------------------------------------------------------------------

#[test]
fn two_devices_syncing_at_each_other_at_once_converge_without_deadlock() {
    let sa = Scratch::new("mutual-a");
    let sb = Scratch::new("mutual-b");
    let a = open_seeded(&sa.path, "key-a", &state("device-A", json!([])));
    let b = open_seeded(&sb.path, "key-b", &state("device-B", json!([])));
    enable_primary(&a).unwrap();
    enable_joiner(&b).unwrap();
    let a = TestStore::new(a);
    let b = TestStore::new(b);
    let key = SyncKey::generate();

    exchange(&b, &a, &key);
    a.write(|conn| {
        persist_operation_to_database(
            conn,
            &set_active_plan_date_op(
                "op-a-1",
                "device-A",
                1,
                "2026-06-23T12:00:00.000Z",
                "2027-01-01",
            ),
        )
        .unwrap()
    });
    b.write(|conn| {
        persist_operation_to_database(
            conn,
            &set_active_plan_date_op(
                "op-b-1",
                "device-B",
                1,
                "2026-06-23T13:00:00.000Z",
                "2028-02-02",
            ),
        )
        .unwrap()
    });

    // Both devices listen and both dial the other at the same moment. Under the
    // old design each side held the global database lock across the whole
    // exchange, so this pair deadlocked until the 60s read timeout fired.
    let listener_a = TcpListener::bind("127.0.0.1:0").unwrap();
    let listener_b = TcpListener::bind("127.0.0.1:0").unwrap();
    let address_a = listener_a.local_addr().unwrap().to_string();
    let address_b = listener_b.local_addr().unwrap().to_string();

    let threads = [
        {
            let (store, key) = (a.clone(), key.clone());
            std::thread::spawn(move || transport::sync_accept(&listener_a, &key, &store))
        },
        {
            let (store, key) = (b.clone(), key.clone());
            std::thread::spawn(move || transport::sync_accept(&listener_b, &key, &store))
        },
        {
            let (store, key) = (a.clone(), key.clone());
            std::thread::spawn(move || transport::sync_connect(&address_b, &key, &store))
        },
        {
            let (store, key) = (b.clone(), key.clone());
            std::thread::spawn(move || transport::sync_connect(&address_a, &key, &store))
        },
    ];
    for thread in threads {
        thread.join().unwrap().expect("simultaneous sync");
    }

    assert_eq!(a.operation_ids(), b.operation_ids());
    assert_eq!(domain(&a.state()), domain(&b.state()));
    assert_eq!(a.state()["activePlanDate"], "2028-02-02");
}

// ---------------------------------------------------------------------------
// Checkpoint mechanics (independent of the wire protocol)
// ---------------------------------------------------------------------------

#[test]
fn checkpoint_replays_exact_state_and_clears_accumulated_history() {
    let scratch = Scratch::new("checkpoint-state");
    let initial = json!({
        "schemaVersion": 1,
        "deviceId": "device-A",
        "localSequence": 0,
        "historyRevision": 0,
        "activePlanDate": "2026-07-29",
        "templates": [{
            "id": "template-1",
            "name": "Morning",
            "createdAt": "2026-07-29T08:00:00Z",
            "updatedAt": "2026-07-29T08:00:00Z",
            "items": [{
                "id": "template-item-1",
                "startMinutes": 480,
                "endMinutes": 510,
                "options": [{
                    "id": "template-option-1",
                    "text": "Breakfast",
                    "html": "<strong>Breakfast</strong>",
                    "probability": 100
                }],
                "children": []
            }]
        }],
        "plans": [{
            "id": "plan-1",
            "date": "2026-07-29",
            "title": "Tuesday",
            "dailyReminder": "Be kind",
            "generatedFromTemplateId": "template-1",
            "createdAt": "2026-07-29T08:00:00Z",
            "items": [{
                "id": "plan-item-1",
                "text": "Breakfast",
                "html": "<strong>Breakfast</strong>",
                "done": false,
                "startMinutes": 480,
                "endMinutes": 510,
                "children": []
            }]
        }],
        "goals": [{ "id": "goal-1", "name": "Eat well" }],
        "goalCompletions": [{ "goalId": "goal-1", "date": "2026-07-29", "completed": true }],
        "listTemplates": [{
            "id": "list-template-1",
            "name": "Groceries",
            "createdAt": "2026-07-29T08:00:00Z",
            "updatedAt": "2026-07-29T08:00:00Z",
            "items": []
        }],
        "lists": [{
            "id": "list-1",
            "listTemplateId": "list-template-1",
            "date": "2026-07-29",
            "title": "Groceries",
            "createdAt": "2026-07-29T08:00:00Z",
            "updatedAt": "2026-07-29T08:00:00Z",
            "items": []
        }],
        "metrics": [{
            "id": "metric-1",
            "name": "Energy",
            "createdAt": "2026-07-29T08:00:00Z",
            "updatedAt": "2026-07-29T08:00:00Z",
            "questions": []
        }],
        "metricEntries": [{
            "id": "metric-entry-1",
            "metricId": "metric-1",
            "date": "2026-07-29",
            "createdAt": "2026-07-29T08:00:00Z",
            "updatedAt": "2026-07-29T08:00:00Z",
            "answers": []
        }],
        "operations": [],
    });
    let mut connection = open_seeded(&scratch.path, "key", &initial);
    enable_primary(&connection).unwrap();

    persist_operation_to_database(
        &mut connection,
        &json!({
            "id": "op-a-1",
            "deviceId": "device-A",
            "sequence": 1,
            "timestamp": "2026-07-29T09:00:00Z",
            "type": "patch_plan_item",
            "payload": {
                "planId": "plan-1",
                "itemId": "plan-item-1",
                "patch": { "done": true }
            }
        }),
    )
    .unwrap();
    persist_operation_to_database(
        &mut connection,
        &set_active_plan_date_op(
            "op-a-2",
            "device-A",
            2,
            "2026-07-29T09:01:00Z",
            "2026-07-30",
        ),
    )
    .unwrap();

    let before = read_app_state_from_database(&connection).unwrap().unwrap();
    let operations_before: i64 = connection
        .query_row("SELECT count(*) FROM operations", [], |row| row.get(0))
        .unwrap();
    let history_before: i64 = connection
        .query_row("SELECT count(*) FROM history_entries", [], |row| row.get(0))
        .unwrap();
    assert_eq!(operations_before, 3);
    assert_eq!(history_before, 2);

    let stats = checkpoint_operation_log(&connection).unwrap();
    assert_eq!(
        stats,
        CheckpointStats {
            operations_removed: 2,
            history_entries_removed: 2,
        }
    );
    assert_eq!(
        read_app_state_from_database(&connection).unwrap().unwrap(),
        before,
        "checkpoint replay must preserve every app-state field"
    );
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM operations", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        connection
            .query_row("SELECT type FROM operations", [], |row| row
                .get::<_, String>(0))
            .unwrap(),
        "replace_full_state"
    );
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM history_entries", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );

    rematerialize(&connection).unwrap();
    assert_eq!(
        read_app_state_from_database(&connection).unwrap().unwrap(),
        before,
        "a later sync replay must also reconstruct the same state"
    );
}

#[test]
fn relay_generation_checkpoint_preserves_local_undo_history() {
    let scratch = Scratch::new("relay-checkpoint-history");
    let mut connection = open_seeded(&scratch.path, "key", &state("device-A", json!([])));
    enable_primary(&connection).unwrap();
    persist_operation_to_database(
        &mut connection,
        &set_active_plan_date_op(
            "op-with-undo",
            "device-A",
            1,
            "2026-08-01T12:00:00Z",
            "2028-08-01",
        ),
    )
    .unwrap();
    let history_before: i64 = connection
        .query_row("SELECT count(*) FROM history_entries", [], |row| row.get(0))
        .unwrap();
    assert_eq!(history_before, 1);

    let stats = checkpoint_operation_log_preserving_history(&connection).unwrap();
    assert_eq!(stats.history_entries_removed, 0);
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM history_entries", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        history_before,
    );
}

#[test]
fn checkpoint_mismatch_rolls_back_log_history_and_state() {
    let scratch = Scratch::new("checkpoint-rollback");
    let mut connection = open_seeded(
        &scratch.path,
        "key",
        &state("device-A", json!([{ "id": "goal-1", "name": "Keep me" }])),
    );
    enable_primary(&connection).unwrap();
    persist_operation_to_database(
        &mut connection,
        &set_active_plan_date_op(
            "op-a-1",
            "device-A",
            1,
            "2026-07-29T09:00:00Z",
            "2026-08-01",
        ),
    )
    .unwrap();

    let before_state = read_app_state_from_database(&connection).unwrap().unwrap();
    let before_operations: Vec<(String, String)> = {
        let mut statement = connection
            .prepare("SELECT id, payload_json FROM operations ORDER BY id")
            .unwrap();
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<std::result::Result<_, _>>()
            .unwrap();
        rows
    };
    let before_history: i64 = connection
        .query_row("SELECT count(*) FROM history_entries", [], |row| row.get(0))
        .unwrap();

    let mut invalid_snapshot = snapshot_state_op(&connection, &before_state).unwrap();
    invalid_snapshot["payload"]["state"]["activePlanDate"] = json!("2099-01-01");
    let error = install_checkpoint(&connection, &before_state, &invalid_snapshot).unwrap_err();
    assert!(error
        .to_string()
        .contains("did not exactly reproduce the current app state"));

    assert_eq!(
        read_app_state_from_database(&connection).unwrap().unwrap(),
        before_state
    );
    let after_operations: Vec<(String, String)> = {
        let mut statement = connection
            .prepare("SELECT id, payload_json FROM operations ORDER BY id")
            .unwrap();
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<std::result::Result<_, _>>()
            .unwrap();
        rows
    };
    assert_eq!(after_operations, before_operations);
    assert_eq!(
        connection
            .query_row("SELECT count(*) FROM history_entries", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        before_history
    );
}

#[test]
fn a_malformed_incoming_batch_rolls_back_both_log_and_materialized_state() {
    let scratch = Scratch::new("atomic-merge");
    let connection = open_seeded(&scratch.path, "key", &state("device-A", json!([])));
    enable_primary(&connection).unwrap();
    let before_state = read_app_state_from_database(&connection).unwrap().unwrap();
    let before_ids = local_op_ids(&connection).unwrap();

    let malformed = Op {
        id: "malformed-op".into(),
        device_id: "device-B".into(),
        sequence: 1,
        op_type: "set_active_plan_date".into(),
        timestamp: "2026-08-01T12:00:00Z".into(),
        payload_json: "{not valid json".into(),
    };
    assert!(merge_and_rematerialize(&connection, vec![malformed]).is_err());

    assert_eq!(local_op_ids(&connection).unwrap(), before_ids);
    assert_eq!(
        read_app_state_from_database(&connection).unwrap().unwrap(),
        before_state,
        "a failed materialization must not leave a partially inserted op",
    );
}

// ---------------------------------------------------------------------------
// Crypto + relay + the on-device self-test
// ---------------------------------------------------------------------------

#[test]
fn selftest_round_trips_two_real_databases() {
    // The same routine the Android debug build runs on-device.
    let profile = selftest(&std::env::temp_dir()).expect("sync self-test must converge");
    eprintln!("large-workspace long-task sync profile: {profile:?}");
}

#[test]
fn pairing_code_round_trips_and_rejects_corruption() {
    let key = SyncKey::generate();
    let code = key.to_pairing_code();
    assert!(code.starts_with("BALSYNC1:"));

    let restored = SyncKey::from_pairing_code(&code).unwrap();
    assert_eq!(key.as_bytes(), restored.as_bytes());

    let sealed = key.seal(b"{\"v\":2,\"ops\":[]}").unwrap();
    assert_eq!(restored.open(&sealed).unwrap(), b"{\"v\":2,\"ops\":[]}");
    assert!(SyncKey::generate().open(&sealed).is_err());

    let mut corrupt: Vec<char> = code.chars().collect();
    let last = corrupt.len() - 1;
    corrupt[last] = if corrupt[last] == 'A' { 'B' } else { 'A' };
    let corrupt: String = corrupt.into_iter().collect();
    assert!(SyncKey::from_pairing_code(&corrupt).is_err());
    assert!(SyncKey::from_pairing_code("not-a-code").is_err());
}

#[test]
fn a_relay_only_ever_holds_ciphertext_and_never_echoes_a_device_its_own_push() {
    let key = SyncKey::generate();
    let relay = relay::Relay::new();
    let plaintext = br#"{"v":2,"ops":[]}"#;
    relay.push("device-A", key.seal(plaintext).unwrap());

    assert!(relay.pull_for("device-A").is_empty());
    let pulled = relay.pull_for("device-B");
    assert_eq!(pulled.len(), 1);
    assert_eq!(key.open(&pulled[0].ciphertext).unwrap(), plaintext);

    for blob in relay.stored_blobs() {
        assert!(
            !blob.windows(4).any(|window| window == b"\"ops"),
            "the relay must never see plaintext"
        );
    }
}
