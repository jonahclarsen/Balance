//! Stable record mutations. Feature action names are metadata, never dispatch.
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", deny_unknown_fields)]
pub enum Patch {
    Replace {
        value: Value,
    },
    Object {
        fields: BTreeMap<String, Patch>,
        remove: Vec<String>,
    },
    Records {
        entries: BTreeMap<String, Patch>,
        remove: Vec<String>,
        order: Option<Vec<String>>,
    },
}

fn records(value: &Value) -> Option<Vec<(String, Value)>> {
    let array = value.as_array()?;
    let mut ids = HashSet::new();
    array
        .iter()
        .map(|item| {
            let id = item.get("id")?.as_str()?.to_string();
            if !ids.insert(id.clone()) {
                return None;
            }
            Some((id, item.clone()))
        })
        .collect()
}

impl Patch {
    pub fn apply(&self, current: &Value) -> Result<Value, String> {
        match self {
            Self::Replace { value } => Ok(value.clone()),
            Self::Object { fields, remove } => {
                let mut result = current.as_object().cloned().unwrap_or_default();
                for key in remove {
                    result.remove(key);
                }
                for (key, patch) in fields {
                    let value = patch.apply(result.get(key).unwrap_or(&Value::Null))?;
                    result.insert(key.clone(), value);
                }
                Ok(Value::Object(result))
            }
            Self::Records {
                entries,
                remove,
                order,
            } => {
                let mut values = if current.is_null() {
                    Vec::new()
                } else {
                    records(current)
                        .ok_or("Update required: record patches require unique string IDs")?
                };
                values.retain(|(id, _)| !remove.contains(id));
                for (id, patch) in entries {
                    if let Some((_, value)) = values.iter_mut().find(|(key, _)| key == id) {
                        *value = patch.apply(value)?;
                    } else if matches!(patch, Self::Replace { .. }) {
                        values.push((id.clone(), patch.apply(&Value::Null)?));
                    }
                    // A field edit cannot resurrect an already-deleted nested
                    // record. Explicit insertions carry a complete replace value.
                }
                for (id, value) in &values {
                    if value.get("id").and_then(Value::as_str) != Some(id) {
                        return Err(
                            "Invalid record patch: an element's ID must remain stable".into()
                        );
                    }
                }
                if let Some(order) = order {
                    if order.iter().collect::<HashSet<_>>().len() != order.len() {
                        return Err("Invalid record patch: duplicate order IDs".into());
                    }
                    // Retain concurrent records absent from the author's view.
                    values.sort_by_key(|(id, _)| {
                        order.iter().position(|key| key == id).unwrap_or(usize::MAX)
                    });
                }
                Ok(Value::Array(
                    values.into_iter().map(|(_, value)| value).collect(),
                ))
            }
        }
    }
}

pub fn diff(before: &Value, after: &Value) -> Patch {
    if let (Some(before), Some(after)) = (before.as_object(), after.as_object()) {
        return Patch::Object {
            fields: after
                .iter()
                .filter(|(key, value)| before.get(*key) != Some(*value))
                .map(|(key, value)| {
                    (
                        key.clone(),
                        diff(before.get(key).unwrap_or(&Value::Null), value),
                    )
                })
                .collect(),
            remove: before
                .keys()
                .filter(|key| !after.contains_key(*key))
                .cloned()
                .collect(),
        };
    }
    if let (Some(before), Some(after)) = (records(before), records(after)) {
        let before_ids: Vec<_> = before.iter().map(|(id, _)| id.clone()).collect();
        let after_ids: Vec<_> = after.iter().map(|(id, _)| id.clone()).collect();
        return Patch::Records {
            entries: after
                .iter()
                .filter_map(|(id, value)| {
                    let old = before
                        .iter()
                        .find(|(key, _)| key == id)
                        .map(|(_, value)| value)
                        .unwrap_or(&Value::Null);
                    (old != value).then(|| (id.clone(), diff(old, value)))
                })
                .collect(),
            remove: before_ids
                .iter()
                .filter(|id| !after_ids.contains(id))
                .cloned()
                .collect(),
            order: (before_ids != after_ids).then_some(after_ids),
        };
    }
    Patch::Replace {
        value: after.clone(),
    }
}

pub fn valid_collection(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Upsert {
    collection: String,
    key: String,
    position: Option<i64>,
    value: Value,
    patches: Vec<Patch>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Delete {
    collection: String,
    key: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Changes {
    version: i64,
    upserts: Vec<Upsert>,
    deletes: Vec<Delete>,
}

fn decode(changes: &Value) -> Result<Changes, String> {
    let changes: Changes = serde_json::from_value(changes.clone())
        .map_err(|e| format!("Update required or invalid replicated record change: {e}"))?;
    if changes.version != 2 {
        return Err("Update required: unsupported replicated record format".into());
    }
    let mut addresses = HashSet::new();
    for (collection, key) in changes
        .upserts
        .iter()
        .map(|x| (&x.collection, &x.key))
        .chain(changes.deletes.iter().map(|x| (&x.collection, &x.key)))
    {
        if !addresses.insert((collection, key)) || !valid_collection(collection) || key.is_empty() {
            return Err("Invalid replicated record address".into());
        }
    }
    Ok(changes)
}

pub fn validate(changes: &Value) -> Result<(), String> {
    decode(changes).map(|_| ())
}

pub fn apply(conn: &Connection, changes: &Value) -> Result<(), String> {
    let changes = decode(changes)?;
    for item in changes.upserts {
        let existing = crate::current_entity(conn, &item.collection, &item.key)?;
        let (position, mut value) =
            existing.unwrap_or((item.position.unwrap_or(0), item.value.clone()));
        for patch in &item.patches {
            value = patch.apply(&value)?;
        }
        if item.collection == "images" {
            crate::images::validate(&value, &item.key)?;
        }
        conn.execute("INSERT INTO state_entities (collection, entity_key, position, value_json) VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(collection, entity_key) DO UPDATE SET position = excluded.position, value_json = excluded.value_json",
            params![item.collection, item.key, item.position.unwrap_or(position), value.to_string()]).map_err(|e| e.to_string())?;
    }
    for item in changes.deletes {
        conn.execute(
            "DELETE FROM state_entities WHERE collection = ?1 AND entity_key = ?2",
            params![item.collection, item.key],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn inverse(conn: &Connection, changes: &Value) -> Result<Value, String> {
    let changes = decode(changes)?;
    let mut upserts = Vec::new();
    let mut deletes = Vec::new();
    for item in changes.upserts {
        if item.collection == "images" {
            continue;
        }
        if let Some((position, before)) = crate::current_entity(conn, &item.collection, &item.key)?
        {
            let mut after = before.clone();
            for patch in &item.patches {
                after = patch.apply(&after)?;
            }
            upserts.push(json!({"collection": item.collection, "key": item.key, "position": item.position.map(|_| position), "value": before, "patches": [diff(&after, &before)]}));
        } else {
            deletes.push(json!({"collection": item.collection, "key": item.key}));
        }
    }
    for item in changes.deletes {
        if item.collection == "images" {
            continue;
        }
        if let Some((position, before)) = crate::current_entity(conn, &item.collection, &item.key)?
        {
            upserts.push(json!({"collection": item.collection, "key": item.key, "position": position, "value": before, "patches": []}));
        }
    }
    Ok(json!({"version": 2, "upserts": upserts, "deletes": deletes}))
}

/// Checkpoints keep exact keys/positions and every collection, including ones
/// absent from this executable's UI schema. Never reconstruct these from AppState.
pub fn snapshot(conn: &Connection) -> Result<Value, String> {
    let mut stmt = conn.prepare("SELECT collection, entity_key, position, value_json FROM state_entities ORDER BY collection, position, entity_key").map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut entities = Vec::new();
    for row in rows {
        let (collection, key, position, raw) = row.map_err(|e| e.to_string())?;
        let value: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        entities.push(json!({"collection": collection, "key": key, "position": position, "value": value, "patches": []}));
    }
    Ok(json!({"version": 2, "upserts": entities, "deletes": []}))
}

pub fn restore(conn: &Connection, snapshot: &Value) -> Result<(), String> {
    decode(snapshot)?;
    conn.execute("DELETE FROM state_entities", [])
        .map_err(|e| e.to_string())?;
    apply(conn, snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patches_preserve_unknown_fields_and_concurrent_records() {
        let old_view = json!({"id": "note", "items": [{"id": "a", "done": false}, {"id": "b", "done": false}]});
        let edited =
            json!({"id": "note", "items": [{"id": "b", "done": true}, {"id": "a", "done": false}]});
        let current = json!({"id": "note", "future": {"color": "blue"}, "items": [{"id": "a", "done": false, "projectId": "p"}, {"id": "b", "done": false}, {"id": "c", "done": false}]});
        let patched = diff(&old_view, &edited).apply(&current).unwrap();
        assert_eq!(patched["future"], current["future"]);
        assert_eq!(patched["items"][0]["id"], "b");
        assert_eq!(patched["items"][0]["done"], true);
        assert_eq!(patched["items"][1]["projectId"], "p");
        assert_eq!(patched["items"][2]["id"], "c");
        let undo = diff(&patched, &current);
        let mut later = patched.clone();
        later["anotherFutureField"] = json!(42);
        let restored = undo.apply(&later).unwrap();
        assert_eq!(restored["items"], current["items"]);
        assert_eq!(restored["anotherFutureField"], 42);
    }

    #[test]
    fn future_primitives_and_duplicate_addresses_fail_instead_of_dropping_data() {
        assert!(
            serde_json::from_value::<Patch>(json!({"kind": "future_increment", "amount": 1}))
                .is_err()
        );
        assert!(decode(&json!({"version": 3, "upserts": [], "deletes": []})).is_err());
        assert!(decode(&json!({"version": 2, "upserts": [], "deletes": [{"collection": "future", "key": "x"}, {"collection": "future", "key": "x"}]})).is_err());
    }
}

/// Translate an old undo/redo entry at the moment it is invoked. Historical log
/// rows remain immutable. Comparing the saved opposite state identifies exactly
/// which fields the old action owned, preserving newer fields added since then.
pub fn history_replay(operation: &Value, opposite: &Value) -> Result<Value, String> {
    fn find_value<'a>(operation: &'a Value, collection: &Value, key: &Value) -> Option<&'a Value> {
        let payload = operation.get("payload")?;
        if let Some(upserts) = payload
            .get("entityChanges")
            .and_then(|c| c.get("upserts"))
            .and_then(Value::as_array)
        {
            if let Some(item) = upserts
                .iter()
                .find(|item| &item["collection"] == collection && &item["key"] == key)
            {
                return item.get("value");
            }
        }
        if let Some(nested) = payload.get("operations").and_then(Value::as_array) {
            for item in nested {
                if let Some(value) = find_value(item, collection, key) {
                    return Some(value);
                }
            }
        }
        None
    }
    let mut replay = operation.clone();
    if let Some(payload) = replay.get_mut("payload").and_then(Value::as_object_mut) {
        if let Some(changes) = payload.get_mut("entityChanges") {
            if changes["version"] == 1 {
                let upserts = changes
                    .get_mut("upserts")
                    .and_then(Value::as_array_mut)
                    .ok_or("Invalid legacy history upserts")?;
                for item in upserts {
                    let target = item
                        .get("value")
                        .ok_or("Invalid legacy history record")?
                        .clone();
                    let patch = match find_value(opposite, &item["collection"], &item["key"]) {
                        Some(previous) => diff(previous, &target),
                        None => Patch::Replace { value: target },
                    };
                    item["patches"] = json!([patch]);
                }
                changes["version"] = json!(2);
            }
        }
        if let Some(operations) = payload.get_mut("operations").and_then(Value::as_array_mut) {
            for nested in operations {
                *nested = history_replay(nested, opposite)?;
            }
        }
    }
    Ok(replay)
}
