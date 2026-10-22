//! Incremental workspace reads.
//!
//! A refresh used to resend the complete workspace, and the WebView parsed
//! years of unchanged history on its main thread. The frontend now sends
//! fingerprints of the snapshot it last applied and receives only the values
//! and records that differ. Fingerprints come from the serialized native
//! snapshot itself, so writes from sync, widgets, Siri, or background work are
//! found without each writer recording what it touched.

use serde::{Deserialize, Serialize};
use serde_json::{value::RawValue, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};

/// Fingerprints of the native snapshot the frontend holds.
#[derive(Debug, Default, Deserialize)]
pub struct KnownState {
    #[serde(default)]
    values: HashMap<String, String>,
    #[serde(default)]
    collections: HashMap<String, KnownCollection>,
}

#[derive(Debug, Deserialize)]
pub struct KnownCollection {
    ids: Vec<String>,
    hashes: Vec<String>,
}

#[derive(Default, Serialize)]
struct Fingerprints {
    values: BTreeMap<String, String>,
    collections: BTreeMap<String, CollectionFingerprints>,
}

#[derive(Serialize)]
struct CollectionFingerprints {
    ids: Vec<String>,
    hashes: Vec<String>,
}

#[derive(Serialize)]
struct CollectionChanges {
    ids: Vec<String>,
    records: Vec<Box<RawValue>>,
    hashes: Vec<String>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Changes {
    values: BTreeMap<String, Box<RawValue>>,
    value_hashes: BTreeMap<String, String>,
    collections: BTreeMap<String, CollectionChanges>,
}

#[derive(Serialize)]
#[serde(untagged)]
enum Response {
    Full {
        state: Box<RawValue>,
        fingerprints: Fingerprints,
        revision: Option<i64>,
    },
    Changes {
        changes: Changes,
        revision: Option<i64>,
    },
}

enum Part {
    /// Scalars and the always-empty operation log are cheaper to send than to
    /// fingerprint, and the frontend resets its operation list on every read.
    Always(String),
    Whole { json: String, hash: String },
    Keyed { ids: Vec<String>, records: Vec<String>, hashes: Vec<String> },
}

fn fingerprint(json: &str) -> String {
    let digest = Sha256::digest(json.as_bytes());
    digest[..8].iter().map(|byte| format!("{byte:02x}")).collect()
}

/// IDs of an array whose records all carry a unique string `id`.
fn record_ids(value: &Value) -> Option<Vec<String>> {
    let records = value.as_array()?;
    let mut seen = HashSet::with_capacity(records.len());
    records
        .iter()
        .map(|record| {
            let id = record.get("id")?.as_str()?;
            seen.insert(id).then(|| id.to_string())
        })
        .collect()
}

fn split(key: &str, value: &Value) -> Result<Part, String> {
    let json = |value: &Value| serde_json::to_string(value).map_err(|error| error.to_string());
    if key == "operations" || !(value.is_array() || value.is_object()) {
        return Ok(Part::Always(json(value)?));
    }
    if let Some(ids) = record_ids(value) {
        let records = value
            .as_array()
            .into_iter()
            .flatten()
            .map(json)
            .collect::<Result<Vec<_>, _>>()?;
        let hashes = records.iter().map(|record| fingerprint(record)).collect();
        return Ok(Part::Keyed { ids, records, hashes });
    }
    let json = json(value)?;
    Ok(Part::Whole { hash: fingerprint(&json), json })
}

fn raw(json: String) -> Result<Box<RawValue>, String> {
    RawValue::from_string(json).map_err(|error| error.to_string())
}

/// Serializes a workspace snapshot for the frontend: the complete snapshot with
/// its fingerprints when `known` is absent, otherwise only what differs from it.
/// `revision` is the database revision the snapshot reflects, if known.
pub fn response(state: &Value, known: Option<&KnownState>, revision: Option<i64>) -> Result<Box<RawValue>, String> {
    let fields = state
        .as_object()
        .ok_or_else(|| "Workspace snapshot is not an object".to_string())?;
    let response = match known {
        None => {
            // Splice the record JSON already produced for fingerprints rather
            // than serializing the workspace twice. Keys keep serde_json's
            // sorted order, matching read_app_state byte for byte.
            let mut fingerprints = Fingerprints::default();
            let mut entries = Vec::with_capacity(fields.len());
            for (key, value) in fields {
                let json = match split(key, value)? {
                    Part::Always(json) => json,
                    Part::Whole { json, hash } => {
                        fingerprints.values.insert(key.clone(), hash);
                        json
                    }
                    Part::Keyed { ids, records, hashes } => {
                        fingerprints
                            .collections
                            .insert(key.clone(), CollectionFingerprints { ids, hashes });
                        format!("[{}]", records.join(","))
                    }
                };
                let key = serde_json::to_string(key).map_err(|error| error.to_string())?;
                entries.push(format!("{key}:{json}"));
            }
            Response::Full {
                state: raw(format!("{{{}}}", entries.join(",")))?,
                fingerprints,
                revision,
            }
        }
        Some(known) => {
            let mut changes = Changes::default();
            for (key, value) in fields {
                match split(key, value)? {
                    Part::Always(json) => {
                        changes.values.insert(key.clone(), raw(json)?);
                    }
                    Part::Whole { json, hash } => {
                        if known.values.get(key) != Some(&hash) {
                            changes.values.insert(key.clone(), raw(json)?);
                            changes.value_hashes.insert(key.clone(), hash);
                        }
                    }
                    Part::Keyed { ids, records, hashes } => {
                        let previous = known.collections.get(key);
                        let previous_hashes: HashMap<&str, &str> = previous
                            .map(|collection| {
                                collection
                                    .ids
                                    .iter()
                                    .map(String::as_str)
                                    .zip(collection.hashes.iter().map(String::as_str))
                                    .collect()
                            })
                            .unwrap_or_default();
                        let mut changed_records = Vec::new();
                        let mut changed_hashes = Vec::new();
                        for ((id, record), hash) in ids.iter().zip(records).zip(hashes) {
                            if previous_hashes.get(id.as_str()) != Some(&hash.as_str()) {
                                changed_records.push(raw(record)?);
                                changed_hashes.push(hash);
                            }
                        }
                        let same_order = previous.is_some_and(|collection| collection.ids == ids);
                        if changed_records.is_empty() && same_order {
                            continue;
                        }
                        changes.collections.insert(
                            key.clone(),
                            CollectionChanges { ids, records: changed_records, hashes: changed_hashes },
                        );
                    }
                }
            }
            Response::Changes { changes, revision }
        }
    };
    raw(serde_json::to_string(&response).map_err(|error| error.to_string())?)
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;

    pub fn parse(raw: &RawValue) -> Value {
        serde_json::from_str(raw.get()).unwrap()
    }

    pub fn known_from_full(full: &Value) -> KnownState {
        serde_json::from_value(full["fingerprints"].clone()).unwrap()
    }

    /// Applies a changes response the way the frontend does, so tests can
    /// check that full and incremental reads always agree.
    pub fn apply(previous: &Value, known: &KnownState, changes: &Value) -> (Value, KnownState) {
        let mut state = previous.as_object().unwrap().clone();
        let mut values = known.values.clone();
        let mut collections: HashMap<String, (Vec<String>, Vec<String>)> = known
            .collections
            .iter()
            .map(|(key, collection)| (key.clone(), (collection.ids.clone(), collection.hashes.clone())))
            .collect();
        for (key, value) in changes["values"].as_object().unwrap() {
            state.insert(key.clone(), value.clone());
            if let Some(hash) = changes["valueHashes"].get(key) {
                values.insert(key.clone(), hash.as_str().unwrap().to_string());
                collections.remove(key);
            }
        }
        for (key, change) in changes["collections"].as_object().unwrap() {
            let (old_ids, old_hashes) = collections.get(key).cloned().unwrap_or_default();
            let old: HashMap<_, _> = old_ids.iter().zip(&old_hashes).collect();
            let existing: HashMap<String, Value> = state
                .get(key)
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|record| (record["id"].as_str().unwrap().to_string(), record.clone()))
                .collect();
            let changed: HashMap<String, (Value, String)> = change["records"]
                .as_array()
                .unwrap()
                .iter()
                .zip(change["hashes"].as_array().unwrap())
                .map(|(record, hash)| {
                    (record["id"].as_str().unwrap().to_string(), (record.clone(), hash.as_str().unwrap().to_string()))
                })
                .collect();
            let ids: Vec<String> =
                change["ids"].as_array().unwrap().iter().map(|id| id.as_str().unwrap().to_string()).collect();
            let mut records = Vec::new();
            let mut hashes = Vec::new();
            for id in &ids {
                if let Some((record, hash)) = changed.get(id) {
                    records.push(record.clone());
                    hashes.push(hash.clone());
                } else {
                    records.push(existing[id].clone());
                    hashes.push((*old[id]).clone());
                }
            }
            state.insert(key.clone(), Value::Array(records));
            collections.insert(key.clone(), (ids, hashes));
            values.remove(key);
        }
        let known = KnownState {
            values,
            collections: collections
                .into_iter()
                .map(|(key, (ids, hashes))| (key, KnownCollection { ids, hashes }))
                .collect(),
        };
        (Value::Object(state), known)
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;
    use serde_json::json;

    fn workspace(days: usize) -> Value {
        json!({
            "schemaVersion": 1,
            "deviceId": "device-a",
            "localSequence": 7,
            "historyRevision": 0,
            "activePlanDate": "2026-10-21",
            "canRedo": false,
            "operations": [],
            "preferences": {"theme": "graphite", "dayTheme:2026-10-20": "iridescent"},
            "plans": (0..days).map(|day| json!({
                "id": format!("plan-{day}"),
                "date": format!("2026-{:02}-{:02}", 1 + day / 28 % 12, 1 + day % 28),
                "items": [{"id": format!("item-{day}"), "text": "Synthetic task", "html": "Synthetic <em>task</em>", "done": day % 2 == 0}],
            })).collect::<Vec<_>>(),
            "notes": [],
            "goalCompletions": [{"goalId": "goal-a", "date": "2026-10-20"}],
        })
    }

    #[test]
    fn full_response_matches_the_plain_snapshot() {
        let state = workspace(5);
        let full = parse(&response(&state, None, None).unwrap());
        assert_eq!(full["state"], state);
        assert_eq!(
            serde_json::to_string(&full["state"]).unwrap(),
            state.to_string(),
            "full reads keep read_app_state's serialization"
        );
        let known = known_from_full(&full);
        assert_eq!(known.collections["plans"].ids.len(), 5);
        assert!(known.values.contains_key("preferences"));
        assert!(known.values.contains_key("goalCompletions"), "records without ids are fingerprinted whole");
        assert!(!known.values.contains_key("localSequence"));
    }

    #[test]
    fn unchanged_snapshot_sends_only_scalars_and_operations() {
        let state = workspace(365);
        let known = known_from_full(&parse(&response(&state, None, None).unwrap()));
        let changes = parse(&response(&state, Some(&known), None).unwrap());
        let changes = &changes["changes"];
        assert_eq!(changes["collections"], json!({}));
        assert_eq!(changes["valueHashes"], json!({}));
        let mut sent: Vec<_> = changes["values"].as_object().unwrap().keys().cloned().collect();
        sent.sort();
        assert_eq!(
            sent,
            ["activePlanDate", "canRedo", "deviceId", "historyRevision", "localSequence", "operations", "schemaVersion"]
        );
    }

    #[test]
    fn one_edited_record_sends_one_record() {
        let before = workspace(365);
        let known = known_from_full(&parse(&response(&before, None, None).unwrap()));
        let mut after = before.clone();
        after["plans"][200]["items"][0]["text"] = json!("Synthetic task edited");
        after["localSequence"] = json!(8);
        let changes = parse(&response(&after, Some(&known), None).unwrap())["changes"].clone();
        let plans = &changes["collections"]["plans"];
        assert_eq!(plans["records"].as_array().unwrap().len(), 1);
        assert_eq!(plans["records"][0]["id"], "plan-200");
        assert_eq!(plans["ids"].as_array().unwrap().len(), 365);
        assert_eq!(changes["values"]["localSequence"], 8);
        assert!(changes["collections"].get("notes").is_none());
        let (merged, _) = apply(&before, &known, &changes);
        assert_eq!(merged, after);
    }

    #[test]
    fn additions_removals_reorders_and_whole_values_round_trip() {
        let before = workspace(30);
        let mut known = known_from_full(&parse(&response(&before, None, None).unwrap()));
        let mut current = before.clone();
        let edits: Vec<Box<dyn Fn(&mut Value)>> = vec![
            Box::new(|state| {
                state["plans"].as_array_mut().unwrap().remove(3);
            }),
            Box::new(|state| state["plans"].as_array_mut().unwrap().insert(0, json!({"id": "plan-new", "date": "2027-01-01", "items": []}))),
            Box::new(|state| state["plans"].as_array_mut().unwrap().swap(4, 9)),
            Box::new(|state| state["preferences"]["theme"] = json!("iridescent")),
            Box::new(|state| state["goalCompletions"].as_array_mut().unwrap().push(json!({"goalId": "goal-b"}))),
            Box::new(|state| state["notes"] = json!([{"id": "note-a", "title": "Synthetic"}])),
            // Duplicate IDs fall back to fingerprinting the whole collection.
            Box::new(|state| state["notes"].as_array_mut().unwrap().push(json!({"id": "note-a", "title": "Copy"}))),
            Box::new(|state| state["notes"] = json!([{"id": "note-b"}])),
            Box::new(|state| state["canRedo"] = json!(true)),
        ];
        for edit in edits {
            let mut next = current.clone();
            edit(&mut next);
            let changes = parse(&response(&next, Some(&known), None).unwrap())["changes"].clone();
            let (merged, merged_known) = apply(&current, &known, &changes);
            assert_eq!(merged, next);
            let full_known = known_from_full(&parse(&response(&next, None, None).unwrap()));
            assert_eq!(merged_known.values, full_known.values);
            for (key, collection) in &full_known.collections {
                assert_eq!(merged_known.collections[key].ids, collection.ids, "{key} order");
                assert_eq!(merged_known.collections[key].hashes, collection.hashes, "{key} hashes");
            }
            current = next;
            known = merged_known;
        }
    }

    /// The frontend merge test (tests/unit/native-state-changes.spec.ts) reads
    /// this fixture. Regenerate with BALANCE_UPDATE_FIXTURES=1.
    #[test]
    fn frontend_fixture_matches_native_responses() {
        let before = workspace(6);
        let mut after = before.clone();
        after["plans"][2]["items"][0]["text"] = json!("Synthetic task edited");
        after["plans"].as_array_mut().unwrap().remove(4);
        after["plans"].as_array_mut().unwrap().insert(0, json!({"id": "plan-new", "date": "2027-01-01", "items": []}));
        after["preferences"]["theme"] = json!("iridescent");
        after["notes"] = json!([{"id": "note-a"}, {"id": "note-a"}]);
        after["localSequence"] = json!(9);
        after["canRedo"] = json!(true);
        let full = parse(&response(&before, None, None).unwrap());
        let changes = parse(&response(&after, Some(&known_from_full(&full)), None).unwrap());
        let after_full = parse(&response(&after, None, None).unwrap());
        let fixture = json!({
            "before": full,
            "changes": changes,
            "after": after,
            "afterFingerprints": after_full["fingerprints"],
        });
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/native-state-changes.json");
        if std::env::var_os("BALANCE_UPDATE_FIXTURES").is_some() {
            std::fs::write(&path, format!("{}\n", serde_json::to_string_pretty(&fixture).unwrap())).unwrap();
        }
        let stored: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(stored, fixture, "regenerate tests/fixtures/native-state-changes.json");
    }

    #[test]
    fn unknown_fingerprints_resend_everything() {
        let state = workspace(10);
        let changes = parse(&response(&state, Some(&KnownState::default()), None).unwrap())["changes"].clone();
        assert_eq!(changes["collections"]["plans"]["records"].as_array().unwrap().len(), 10);
        assert!(changes["values"].get("preferences").is_some());
    }
}
