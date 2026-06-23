//! Integration tests that exercise the sync engine against the **real** Balance
//! database layer: the app's own `open_database_at` (SQLCipher) and
//! `initialize_database` (the production schema). This proves the migration and
//! E2EE convergence work on the actual schema, not a toy one.

use std::path::PathBuf;

use rusqlite::params;

use super::crypto::SyncKey;
use super::*;
use crate::open_database_at;

/// Locate the cr-sqlite extension shipped alongside the crate.
fn ext_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("crsqlite.dylib")
}

/// A unique scratch database path that cleans up on drop.
struct Scratch {
    path: PathBuf,
}
impl Scratch {
    fn new(tag: &str) -> Self {
        let mut path = std::env::temp_dir();
        let unique = format!(
            "balance-sync-{tag}-{}-{}.sqlite3",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        path.push(unique);
        Scratch { path }
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Open a real encrypted DB (real schema), load cr-sqlite, run the migration,
/// and enable CRRs — the full production open path a synced device would use.
fn open_synced(path: &std::path::Path, key: &str) -> rusqlite::Connection {
    let conn = open_database_at(path, key).expect("open encrypted real schema");
    load_extension(&conn, ext_path()).expect("load cr-sqlite");
    migrate_to_crr(&conn).expect("migrate");
    enable_crrs(&conn, SYNCED_TABLES).expect("enable crrs");
    conn
}

fn seed_real_data(conn: &rusqlite::Connection) {
    conn.execute(
        "INSERT INTO plans (id, date, title, daily_reminder, created_at) \
         VALUES ('p1', '2026-06-22', 'Sunday', 'be real', '2026-06-22T08:00:00Z')",
        [],
    )
    .unwrap();
    let items = [
        ("a", None, 0, "Wake up", 1),
        ("b", None, 1, "Deep work", 0),
        ("b1", Some("b"), 0, "Write report", 0),
        ("b2", Some("b"), 1, "Review PRs", 0),
        ("c", None, 2, "Walk", 0),
    ];
    for (id, parent, pos, text, done) in items {
        conn.execute(
            "INSERT INTO plan_items (id, plan_id, parent_id, position, text, html, done) \
             VALUES (?1,'p1',?2,?3,?4,?4,?5)",
            params![id, parent, pos, text, done],
        )
        .unwrap();
    }
    // A template with two items, the first carrying two ordered options.
    conn.execute(
        "INSERT INTO templates (id, name, created_at, updated_at, position) \
         VALUES ('t1', 'Morning', '2026-06-01', '2026-06-02', 0)",
        [],
    )
    .unwrap();
    for (id, pos) in [("ti1", 0), ("ti2", 1)] {
        conn.execute(
            "INSERT INTO template_items (id, template_id, parent_id, position) VALUES (?1,'t1',NULL,?2)",
            params![id, pos],
        )
        .unwrap();
    }
    for (id, text, prob, pos) in [("to1", "Coffee", 0.5, 0), ("to2", "Tea", 0.5, 1)] {
        conn.execute(
            "INSERT INTO template_options (id, item_id, text, html, probability, position) \
             VALUES (?1,'ti1',?2,?2,?3,?4)",
            params![id, text, prob, pos],
        )
        .unwrap();
    }

    // Goals as the real opaque blob in metadata.
    conn.execute(
        "INSERT INTO metadata (key, value) VALUES ('goal_data', ?1)",
        params![
            r#"{"goals":[{"id":"g1","name":"Read","target":30},{"id":"g2","name":"Run","target":5}],"goalCompletions":[{"id":"gc1","goalId":"g1","date":"2026-06-21"}]}"#
        ],
    )
    .unwrap();
    // Lists/metrics as the real opaque blob in metadata.
    conn.execute(
        "INSERT INTO metadata (key, value) VALUES ('lists_metrics_data', ?1)",
        params![
            r#"{"listTemplates":[{"id":"lt1","name":"Groceries"}],"lists":[{"id":"l1","title":"Today"}],"metrics":[{"id":"m1","name":"Weight"}],"metricEntries":[{"id":"me1","value":80}]}"#
        ],
    )
    .unwrap();
}

#[test]
fn real_schema_migration_preserves_data_and_enables_crrs() {
    let scratch = Scratch::new("migrate");
    // Seed under the *legacy* schema first (open without migrating), then close.
    {
        let key = "device-key";
        let conn = open_database_at(&scratch.path, key).unwrap();
        seed_real_data(&conn);
    }

    // Re-open with the full synced path (loads ext + migrates + CRRs).
    let conn = open_synced(&scratch.path, "device-key");

    // plan_items now has fractional keys and preserves order.
    let ordered: Vec<String> = {
        let mut stmt = conn
            .prepare(
                "SELECT text FROM plan_items WHERE plan_id='p1' AND parent_id IS NULL \
                 ORDER BY position_key",
            )
            .unwrap();
        stmt.query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    };
    assert_eq!(ordered, vec!["Wake up", "Deep work", "Walk"], "order preserved");

    // Goals blob exploded into rows, all fields preserved.
    let goal_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM goals", [], |r| r.get(0))
        .unwrap();
    assert_eq!(goal_count, 2);
    let gc_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM goal_completions", [], |r| r.get(0))
        .unwrap();
    assert_eq!(gc_count, 1);
    let g1: String = conn
        .query_row(
            "SELECT json_extract(data,'$.name') FROM goals WHERE id='g1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(g1, "Read");

    // Template options preserve their order under fractional keys.
    let options: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT text FROM template_options WHERE item_id='ti1' ORDER BY position_key")
            .unwrap();
        stmt.query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    };
    assert_eq!(options, vec!["Coffee", "Tea"], "template option order preserved");
    let template_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM templates", [], |r| r.get(0))
        .unwrap();
    assert_eq!(template_count, 1);

    // Lists/metrics blob exploded into its four tables.
    for (table, expected) in [("list_templates", 1), ("lists", 1), ("metrics", 1), ("metric_entries", 1)] {
        let n: i64 = conn
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, expected, "{table} row count");
    }
    let metric_name: String = conn
        .query_row(
            "SELECT json_extract(data,'$.name') FROM metrics WHERE id='m1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(metric_name, "Weight");

    // Both blobs are consumed.
    for key in ["goal_data", "lists_metrics_data"] {
        let leftover: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM metadata WHERE key=?1",
                params![key],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(leftover, 0, "{key} blob consumed");
    }

    // Migration is idempotent.
    migrate_to_crr(&conn).unwrap();

    finalize(&conn).unwrap();
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

    // A scanned/typed code reconstructs the exact same key.
    let restored = SyncKey::from_pairing_code(&code).unwrap();
    assert_eq!(key.as_bytes(), restored.as_bytes());

    // The restored key actually decrypts what the original sealed (proves it's
    // the same secret, not just equal bytes by luck).
    let cs = ChangeSet {
        origin_site_hex: "abcd".into(),
        rows: vec![],
    };
    let sealed = key.seal(&cs).unwrap();
    assert!(restored.open(&sealed).is_ok());

    // A single mangled character fails the checksum instead of yielding a bad key.
    let mut corrupt: Vec<char> = code.chars().collect();
    let last = corrupt.len() - 1;
    corrupt[last] = if corrupt[last] == 'A' { 'B' } else { 'A' };
    let corrupt: String = corrupt.into_iter().collect();
    assert!(SyncKey::from_pairing_code(&corrupt).is_err());

    // Garbage / wrong-app codes are rejected.
    assert!(SyncKey::from_pairing_code("not-a-code").is_err());
}

#[test]
fn two_real_devices_sync_e2ee_over_relay_and_converge() {
    let sa = Scratch::new("relay-a");
    let sb = Scratch::new("relay-b");

    // Device A: seed legacy, then open synced.
    {
        let conn = open_database_at(&sa.path, "key-a").unwrap();
        seed_real_data(&conn);
    }
    let a = open_synced(&sa.path, "key-a");

    // Device B: fresh synced DB, no data yet.
    let b = open_synced(&sb.path, "key-b");

    // Initial full sync A -> B via sealed envelope (E2EE).
    let key = SyncKey::generate();
    let initial = key.seal(&pull(&a, 0, None).unwrap()).unwrap();
    apply(&b, &key.open(&initial).unwrap()).unwrap();
    assert_eq!(
        state_hash(&a, SYNCED_TABLES).unwrap(),
        state_hash(&b, SYNCED_TABLES).unwrap(),
        "after initial sync the devices match"
    );

    // Concurrent edits: A reorders "Walk" to the top (fractional key before
    // the current first); B edits a goal and a plan item's text.
    let first_key: String = a
        .query_row(
            "SELECT position_key FROM plan_items WHERE plan_id='p1' AND parent_id IS NULL \
             ORDER BY position_key LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let new_key: String = a
        .query_row(
            "SELECT crsql_fract_key_between(NULL, ?1)",
            params![first_key],
            |r| r.get(0),
        )
        .unwrap();
    a.execute(
        "UPDATE plan_items SET position_key=?1 WHERE id='c'",
        params![new_key],
    )
    .unwrap();
    b.execute(
        "UPDATE plan_items SET text='Deep work (focused)' WHERE id='b'",
        [],
    )
    .unwrap();
    b.execute(
        "UPDATE goals SET data=json_set(data,'$.target',45) WHERE id='g1'",
        [],
    )
    .unwrap();

    // Exchange deltas both ways, sealed.
    let a_delta = key.seal(&pull(&a, 0, None).unwrap()).unwrap();
    let b_delta = key.seal(&pull(&b, 0, None).unwrap()).unwrap();
    apply(&a, &key.open(&b_delta).unwrap()).unwrap();
    apply(&b, &key.open(&a_delta).unwrap()).unwrap();

    // Converged.
    assert_eq!(
        state_hash(&a, SYNCED_TABLES).unwrap(),
        state_hash(&b, SYNCED_TABLES).unwrap(),
        "devices converge after concurrent edits"
    );

    // All three concurrent edits survived on both sides.
    let top: String = b
        .query_row(
            "SELECT text FROM plan_items WHERE plan_id='p1' AND parent_id IS NULL \
             ORDER BY position_key LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(top, "Walk", "A's reorder reached B");
    let btext: String = a
        .query_row("SELECT text FROM plan_items WHERE id='b'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(btext, "Deep work (focused)", "B's edit reached A");
    let target: i64 = a
        .query_row(
            "SELECT json_extract(data,'$.target') FROM goals WHERE id='g1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(target, 45, "B's goal edit reached A");

    finalize(&a).unwrap();
    finalize(&b).unwrap();
}
