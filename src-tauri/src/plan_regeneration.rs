//! Protocol 8: a date has one durable identity; regeneration removes only
//! observed, unchanged template rows. Native-only records survive checkpoints
//! through the generic entity snapshot, including while a phone is offline.
use crate::*;

const ALIASES: &str = "planDateAliases";
const RETIRED: &str = "regeneratedPlanItems";

fn put(conn: &Connection, collection: &str, id: &str, value: &Value) -> Result<(), String> {
    conn.execute("insert into state_entities (collection, entity_key, position, value_json)
        values (?1, ?2, 0, ?3) on conflict(collection, entity_key) do update set value_json = json_patch(state_entities.value_json, excluded.value_json)",
        params![collection, id, value.to_string()]).map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn alias(conn: &Connection, id: &str, date: &str) -> Result<(), String> {
    put(conn, ALIASES, id, &json!({"id": id, "date": date}))
}

pub(crate) fn resolve(
    conn: &Connection,
    id: &str,
    date: Option<&str>,
) -> Result<Option<String>, String> {
    let existing = conn
        .query_row("select id from plans where id = ?1", [id], |r| {
            r.get::<_, String>(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    if existing.is_some() {
        return Ok(existing);
    }
    let record = current_entity(conn, ALIASES, id)?;
    let date = record
        .as_ref()
        .and_then(|(_, v)| v["date"].as_str())
        .or(date);
    match date {
        Some(date) => conn
            .query_row("select id from plans where date = ?1", [date], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string()),
        None => Ok(None),
    }
}

pub(crate) fn resolve_payload<'a>(
    conn: &Connection,
    payload: &'a Value,
) -> Result<std::borrow::Cow<'a, Value>, String> {
    let mut result = std::borrow::Cow::Borrowed(payload);
    for (field, date_field) in [
        ("planId", "planDate"),
        ("sourcePlanId", "sourcePlanDate"),
        ("targetPlanId", "targetPlanDate"),
    ] {
        if let Some(id) = payload.get(field).and_then(Value::as_str) {
            if let Some(resolved) =
                resolve(conn, id, payload.get(date_field).and_then(Value::as_str))?
            {
                if resolved != id {
                    result.to_mut()[field] = json!(resolved);
                }
            }
        }
    }
    Ok(result)
}

fn same_item(a: &Value, b: &Value) -> bool {
    [
        "id",
        "text",
        "html",
        "done",
        "startMinutes",
        "endMinutes",
        "timeHidden",
    ]
    .iter()
    .all(|key| a[*key] == b[*key])
        && match (a["children"].as_array(), b["children"].as_array()) {
            (Some(a), Some(b)) => {
                a.len() == b.len() && a.iter().zip(b).all(|(a, b)| same_item(a, b))
            }
            _ => false,
        }
}

fn untouched(conn: &Connection, item: &Value) -> Result<bool, String> {
    if current_entity(conn, "uneditedPlanItems", required_string(item, "id")?)?.is_none() {
        return Ok(false);
    }
    for child in required_array(item, "children")? {
        if !untouched(conn, child)? {
            return Ok(false);
        }
    }
    Ok(true)
}

fn archive(
    conn: &Connection,
    date: &str,
    parent: Option<&str>,
    item: &Value,
) -> Result<(), String> {
    let id = required_string(item, "id")?;
    let mut row = item.clone();
    row["children"] = json!([]);
    put(
        conn,
        RETIRED,
        id,
        &json!({"id": id, "date": date, "parentId": parent, "item": row}),
    )?;
    for child in required_array(item, "children")? {
        archive(conn, date, Some(id), child)?;
    }
    Ok(())
}

/// Only regeneration archives can revive an edited row. Explicit deletion
/// removes these archives (including descendants), so later stale edits lose.
pub(crate) fn forget_deleted(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("with recursive removed(id) as (
        select ?1 union select entity_key from state_entities join removed
        on json_extract(value_json, '$.parentId') = removed.id where collection = ?2
        union select plan_items.id from plan_items join removed on plan_items.parent_id = removed.id
        ) delete from state_entities where collection = ?2 and entity_key in (select id from removed)",
        params![id, RETIRED]).map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn forget_row(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute(
        "update state_entities set value_json = json_set(value_json, '$.parentId', null)
        where collection = ?1 and json_extract(value_json, '$.parentId') = ?2",
        params![RETIRED, id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "delete from state_entities where collection = ?1 and entity_key = ?2",
        params![RETIRED, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn forget_day(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute(
        "delete from state_entities where collection = ?1
        and json_extract(value_json, '$.date') = (select date from plans where id = ?2)",
        params![RETIRED, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn restore_edited(conn: &Connection, id: &str) -> Result<(), String> {
    if plan_item_plan_id_if_exists(conn, id)?.is_some() {
        return Ok(());
    }
    let Some((_, record)) = current_entity(conn, RETIRED, id)? else {
        return Ok(());
    };
    let Some(plan) = read_plan_by_date(conn, required_string(&record, "date")?)? else {
        return Ok(());
    };
    let plan_id = required_string(&plan, "id")?;
    // A removed parent is placement context, never a reason to drop the edit.
    let parent = record["parentId"].as_str();
    let parent = match parent {
        Some(parent) if plan_item_plan_id_if_exists(conn, parent)?.as_deref() == Some(plan_id) => {
            Some(parent)
        }
        _ => None,
    };
    insert_plan_item(
        conn,
        plan_id,
        parent,
        &record["item"],
        next_plan_item_position(conn, plan_id, parent)?,
    )?;
    conn.execute(
        "delete from state_entities where collection = 'uneditedPlanItems' and entity_key = ?1",
        [id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn apply(conn: &Connection, payload: &Value, legacy: bool) -> Result<(), String> {
    let generated = required_value(payload, "generatedPlan")?;
    let date = required_string(generated, "date")?;
    let incoming_id = required_string(generated, "id")?;
    let previous = read_plan_by_date(conn, date)?;
    let plan_id = previous
        .as_ref()
        .and_then(|p| p["id"].as_str())
        .unwrap_or(incoming_id);
    alias(conn, incoming_id, date)?;
    alias(conn, plan_id, date)?;
    let mut plan = generated.clone();
    plan["id"] = json!(plan_id);
    plan["items"] = json!([]);
    if let Some(previous) = &previous {
        plan["createdAt"] = previous["createdAt"].clone();
    }

    let candidates = if legacy {
        // Old payloads contain a whole snapshot and no observed removal list.
        // Conservatively preserve unmarked/manual rows and existing versions
        // of rows carried by the author instead of overwriting offline edits.
        previous
            .as_ref()
            .and_then(|p| p["items"].as_array())
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|item| {
                !generated["items"]
                    .as_array()
                    .unwrap_or(&Vec::new())
                    .iter()
                    .any(|i| i["id"] == item["id"])
            })
            .collect::<Vec<_>>()
    } else {
        required_array(payload, "replaceItems")?.clone()
    };
    for expected in candidates {
        let id = required_string(&expected, "id")?;
        if let Some(current) = read_plan_item_snapshot(conn, id)? {
            if current.plan_id == plan_id
                && current.parent_id.is_none()
                && same_item(&current.item, &expected)
                && (!(legacy
                    || payload.get("requireUntouched").and_then(Value::as_bool) == Some(true))
                    || untouched(conn, &current.item)?)
            {
                archive(conn, date, None, &current.item)?;
                conn.execute("delete from plan_items where id = ?1", [id])
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    insert_plan(conn, &plan)?;
    for item in required_array(generated, "items")? {
        let id = required_string(item, "id")?;
        if plan_item_plan_id_if_exists(conn, id)?.is_none() {
            if payload.get("restoreRetired").and_then(Value::as_bool) == Some(true)
                && current_entity(conn, RETIRED, id)?.is_none()
            {
                continue;
            }
            insert_new_tree(
                conn,
                plan_id,
                None,
                item,
                payload.get("restoreRetired").and_then(Value::as_bool) == Some(true),
            )?;
            if let Some(position) = payload
                .get("insertPositions")
                .and_then(|positions| positions.get(id))
                .and_then(Value::as_u64)
            {
                let mut siblings = plan_item_sibling_ids(conn, plan_id, None)?;
                if siblings.iter().any(|sibling| sibling == id) {
                    siblings.retain(|sibling| sibling != id);
                    siblings.insert((position as usize).min(siblings.len()), id.to_string());
                    rewrite_plan_item_positions(conn, &siblings)?;
                }
            }
        }
    }
    if payload.get("removeEmptyDay").and_then(Value::as_bool) == Some(true) {
        conn.execute("delete from plans where id = ?1 and not exists (select 1 from plan_items where plan_id = ?1)", [plan_id])
            .map_err(|e| e.to_string())?;
    }
    let active = optional_string(payload, "activePlanDate")?.unwrap_or_else(|| date.to_string());
    set_metadata(conn, "active_plan_date", &active)
}

fn insert_new_tree(
    conn: &Connection,
    plan_id: &str,
    parent: Option<&str>,
    item: &Value,
    retired_only: bool,
) -> Result<(), String> {
    let id = required_string(item, "id")?;
    if retired_only && current_entity(conn, RETIRED, id)?.is_none() {
        return Ok(());
    }
    if plan_item_plan_id_if_exists(conn, id)?.is_some() {
        return Ok(());
    }
    let mut row = item.clone();
    row["children"] = json!([]);
    insert_plan_item(
        conn,
        plan_id,
        parent,
        &row,
        next_plan_item_position(conn, plan_id, parent)?,
    )?;
    for child in required_array(item, "children")? {
        insert_new_tree(conn, plan_id, Some(id), child, retired_only)?;
    }
    Ok(())
}

pub(crate) fn undo(conn: &Connection, payload: &Value) -> Result<Value, String> {
    let generated = required_value(payload, "generatedPlan")?;
    let previous = read_plan_by_date(conn, required_string(generated, "date")?)?;
    let mut restore = previous.clone().unwrap_or_else(|| generated.clone());
    let mut removed = Vec::new();
    let mut positions = Map::new();
    for item in required_array(payload, "replaceItems")? {
        if let Some(current) = read_plan_item_snapshot(conn, required_string(item, "id")?)? {
            if same_item(&current.item, item) {
                positions.insert(
                    required_string(item, "id")?.to_string(),
                    json!(current.position),
                );
                removed.push(current.item);
            }
        }
    }
    restore["items"] = json!(removed);
    Ok(storage_operation(
        "regenerate_plan",
        json!({
            "generatedPlan": restore, "replaceItems": generated["items"], "restoreRetired": true,
            "removeEmptyDay": previous.is_none(),
            "insertPositions": positions,
            "activePlanDate": metadata_value(conn, "active_plan_date")?.unwrap_or_default(),
        }),
    ))
}

pub(crate) fn legacy_undo(conn: &Connection, payload: &Value) -> Result<Value, String> {
    let generated = required_value(payload, "generatedPlan")?;
    let previous = read_plan_by_date(conn, required_string(generated, "date")?)?;
    let mut replacements = Vec::new();
    if let Some(previous) = previous {
        for item in required_array(&previous, "items")? {
            if untouched(conn, item)?
                && !required_array(generated, "items")?
                    .iter()
                    .any(|row| row["id"] == item["id"])
            {
                replacements.push(item.clone());
            }
        }
    }
    let mut effective = payload.clone();
    effective["replaceItems"] = json!(replacements);
    let mut fresh = Vec::new();
    for item in required_array(generated, "items")? {
        if plan_item_plan_id_if_exists(conn, required_string(item, "id")?)?.is_none() {
            fresh.push(item.clone());
        }
    }
    effective["generatedPlan"]["items"] = json!(fresh);
    undo(conn, &effective)
}

/// Pre-upgrade undo records deleted and reinserted a whole day. They have no
/// observed removal list, so replay them as a conservative merge. This also
/// handles those immutable records inside a history/checkpoint wrapper.
pub(crate) fn legacy_undo_batch(
    conn: &Connection,
    payload: &Value,
) -> Result<Option<Value>, String> {
    let operations = required_array(payload, "operations")?;
    if operations.first().and_then(|op| op["type"].as_str()) != Some("delete_plan")
        || !operations.iter().skip(1).all(|op| {
            matches!(
                op["type"].as_str(),
                Some("insert_plan" | "set_active_plan_date")
            )
        })
    {
        return Ok(None);
    }
    let id = required_string(&operations[0]["payload"], "planId")?;
    let current = match resolve(conn, id, None)? {
        Some(id) => read_plan_by_id(conn, &id)?,
        None => None,
    };
    let restored = operations
        .iter()
        .find(|op| op["type"] == "insert_plan")
        .map(|op| &op["payload"]["plan"]);
    let Some(plan) = restored else {
        return Ok(None);
    };
    if let Some(current) = &current {
        if current["date"] != plan["date"] {
            return Ok(None);
        }
    }
    let active = operations
        .iter()
        .find(|op| op["type"] == "set_active_plan_date")
        .map(|op| op["payload"]["date"].clone())
        .unwrap_or(json!(""));
    Ok(Some(storage_operation(
        "regenerate_plan",
        json!({
            "generatedPlan": plan, "replaceItems": [], "activePlanDate": active,
        }),
    )))
}

/// Explicit Recovery-panel action only. Reconstruct a missing independently
/// created task from retained local history, including its subsequent saves.
/// Never guess a date or restore an entire old day over the current one.
pub(crate) fn recover_missing_task(
    conn: &Connection,
    operation: &Value,
) -> Result<Option<Value>, String> {
    let payload = &operation["payload"];
    let kind = operation["type"].as_str().unwrap_or_default();
    let creation = match kind {
        "add_plan_item" | "split_plan_item" => operation.clone(),
        "patch_plan_item" => {
            let Some(id) = payload["itemId"].as_str() else {
                return Ok(None);
            };
            if plan_item_plan_id_if_exists(conn, id)?.is_some() {
                return Ok(None);
            }
            let row = conn.query_row("select redo_operation_json from history_entries
                where json_extract(redo_operation_json, '$.type') in ('add_plan_item', 'split_plan_item')
                and (json_extract(redo_operation_json, '$.payload.item.id') = ?1
                    or json_extract(redo_operation_json, '$.payload.newItem.id') = ?1)
                order by sequence limit 1", [id], |row| row.get::<_, String>(0)).optional().map_err(|e| e.to_string())?;
            let Some(row) = row else {
                return Ok(None);
            };
            serde_json::from_str(&row).map_err(|e| e.to_string())?
        }
        _ => return Ok(None),
    };
    let source = &creation["payload"];
    let mut item = if creation["type"] == "split_plan_item" {
        source["newItem"].clone()
    } else {
        source["item"].clone()
    };
    let Some(id) = item["id"].as_str().map(str::to_string) else {
        return Ok(None);
    };
    if plan_item_plan_id_if_exists(conn, &id)?.is_some() {
        return Ok(None);
    }
    let original_id = required_string(source, "planId")?;
    let mut resolved = resolve(conn, original_id, source["planDate"].as_str())?;
    if resolved.is_none() {
        // Earlier clients omitted the date, but regeneration's undo snapshot
        // often retains the old day identity after log compaction.
        let mut statement = conn.prepare("select undo_operation_json from history_entries union all
            select redo_operation_json from history_entries union all select payload_json from operations")
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        for row in rows {
            let value: Value = serde_json::from_str(&row.map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            if let Some(date) = find_date(&value, original_id) {
                resolved = resolve(conn, original_id, Some(date))?;
                if resolved.is_some() {
                    break;
                }
            }
        }
    }
    let Some(plan_id) = resolved else {
        return Ok(None);
    };
    let mut statement = conn
        .prepare(
            "select redo_operation_json from history_entries
        where json_extract(redo_operation_json, '$.type') = 'patch_plan_item'
        and json_extract(redo_operation_json, '$.payload.itemId') = ?1 order by sequence, id",
        )
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([&id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    for row in rows {
        let saved: Value =
            serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        if let Some(patch) = saved["payload"]["patch"].as_object() {
            for field in [
                "text",
                "html",
                "done",
                "startMinutes",
                "endMinutes",
                "timeHidden",
            ] {
                if let Some(value) = patch.get(field) {
                    item[field] = value.clone();
                }
            }
        }
    }
    // Recover only the named task. Existing descendants may have been moved
    // or explicitly deleted since this snapshot was recorded.
    item["children"] = json!([]);
    Ok(Some(storage_operation(
        "insert_plan_item_at",
        json!({
            "planId": plan_id, "parentId": null, "item": item,
            "position": next_plan_item_position(conn, &plan_id, None)?,
        }),
    )))
}

fn find_date<'a>(value: &'a Value, id: &str) -> Option<&'a str> {
    match value {
        Value::Object(object) => {
            if object.get("id").and_then(Value::as_str) == Some(id) {
                if let Some(date) = object.get("date").and_then(Value::as_str) {
                    return Some(date);
                }
            }
            object.values().find_map(|value| find_date(value, id))
        }
        Value::Array(values) => values.iter().find_map(|value| find_date(value, id)),
        _ => None,
    }
}
