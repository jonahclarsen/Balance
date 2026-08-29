//! Privacy-preserving sync diagnostics.
//!
//! The trace deliberately contains no raw database strings. Every string value
//! and every dynamic object key is replaced with an HMAC token keyed by the
//! account sync key. Paired devices therefore emit the same token for the same
//! operation/entity/content while someone holding only the export cannot test
//! guesses or recover the original value.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use data_encoding::BASE32_NOPAD;
use hmac::{Hmac, Mac};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use sha2::Sha256;

use super::crypto::SyncKey;
use super::{ensure_sync_tables, sync_frontiers, Error, Op, Result};

const TRACE_FORMAT: &str = "balance-anonymous-sync-trace-v3";
const TOKEN_BYTES: usize = 20;
const MAX_TRACE_OPERATIONS: usize = 300;
const MAX_QUARANTINE_ROWS: usize = 20;
const NEARBY_DAY_RADIUS: i64 = 2;
const MAX_NEARBY_PLAN_ITEMS: usize = 50;

struct Tokenizer<'a> {
    key: &'a SyncKey,
}

impl Tokenizer<'_> {
    fn token(&self, domain: &str, value: &str) -> String {
        let mut mac = Hmac::<Sha256>::new_from_slice(self.key.as_bytes())
            .expect("HMAC accepts the 32-byte sync key");
        mac.update(TRACE_FORMAT.as_bytes());
        mac.update(&[0]);
        mac.update(domain.as_bytes());
        mac.update(&[0]);
        mac.update(value.as_bytes());
        let bytes = mac.finalize().into_bytes();
        BASE32_NOPAD.encode(&bytes[..TOKEN_BYTES])
    }

    fn value_token(&self, value: &str) -> String {
        format!("v_{}", self.token("value", value))
    }

    fn id_token(&self, value: &str) -> String {
        format!("id_{}", self.token("identifier", value))
    }

    fn opaque_token(&self, domain: &str, value: &str) -> String {
        format!("x_{}", self.token(domain, value))
    }
}

fn safe_schema_key(key: &str) -> bool {
    // This is intentionally an allowlist rather than a syntax check. Checkpoint
    // maps contain user/device-derived values as JSON keys, and a syntactically
    // ordinary id such as `device_test` must not slip through unchanged.
    matches!(
        key,
        "schemaVersion"
            | "deviceId"
            | "localSequence"
            | "historyRevision"
            | "activePlanDate"
            | "preferences"
            | "templates"
            | "plans"
            | "listTemplates"
            | "lists"
            | "metrics"
            | "metricEntries"
            | "notes"
            | "goals"
            | "goalCompletions"
            | "operations"
            | "id"
            | "type"
            | "timestamp"
            | "payload"
            | "date"
            | "title"
            | "name"
            | "text"
            | "html"
            | "done"
            | "startMinutes"
            | "endMinutes"
            | "timeHidden"
            | "children"
            | "item"
            | "items"
            | "options"
            | "probability"
            | "dailyReminder"
            | "generatedFromTemplateId"
            | "createdAt"
            | "updatedAt"
            | "deletedAt"
            | "archivedAt"
            | "archivedDate"
            | "archivedItems"
            | "listTemplateId"
            | "maxExpectedWords"
            | "questions"
            | "prompt"
            | "answers"
            | "questionId"
            | "metricId"
            | "goalId"
            | "itemIds"
            | "matchedTerms"
            | "computedAt"
            | "cadenceDays"
            | "matchTerms"
            | "matchTermsHtml"
            | "hue"
            | "lightness"
            | "activityPeriods"
            | "startDate"
            | "endDate"
            | "planId"
            | "templateId"
            | "itemId"
            | "optionId"
            | "parentId"
            | "targetId"
            | "sourceId"
            | "placement"
            | "direction"
            | "position"
            | "patch"
            | "plan"
            | "template"
            | "generatedPlan"
            | "replaceExisting"
            | "completedParentIds"
            | "before"
            | "after"
            | "value"
            | "operation"
            | "historyEntryId"
            | "entityChanges"
            | "version"
            | "upserts"
            | "deletes"
            | "collection"
            | "key"
            | "state"
            | "generation"
            | "frontiers"
            | "themeId"
            | "randomThemeId"
            | "randomThemeDate"
            | "randomThemeStartDate"
            | "completionCelebrationId"
            | "doneTintColor"
            | "checkboxColor"
            | "databaseLoadingMessages"
            | "iridescentGradient"
            | "contrast"
            | "backgroundSaturation"
            | "backgroundLightness"
            | "angle"
            | "reach"
            | "colors"
            | "strength"
    )
}

fn anonymize_json(value: &Value, tokenizer: &Tokenizer<'_>) -> Value {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => value.clone(),
        Value::String(value) => Value::String(tokenizer.value_token(value)),
        Value::Array(values) => Value::Array(
            values
                .iter()
                .map(|value| anonymize_json(value, tokenizer))
                .collect(),
        ),
        Value::Object(values) => {
            let mut anonymized = Map::new();
            for (key, value) in values {
                let key = if safe_schema_key(key) {
                    key.clone()
                } else {
                    format!("field_{}", tokenizer.token("field", key))
                };
                anonymized.insert(key, anonymize_json(value, tokenizer));
            }
            Value::Object(anonymized)
        }
    }
}

fn domain_state(mut state: Value) -> Value {
    if let Some(state) = state.as_object_mut() {
        state.remove("deviceId");
        state.remove("localSequence");
        state.remove("historyRevision");
        state.remove("operations");
    }
    state
}

fn collect_nearby_plan_items(
    items: &[Value],
    plan_id: &str,
    day_offset: i64,
    parent_id: Option<&str>,
    path: &mut Vec<usize>,
    tokenizer: &Tokenizer<'_>,
    records: &mut Vec<Value>,
    truncated: &mut bool,
) {
    for (index, item) in items.iter().enumerate() {
        if records.len() == MAX_NEARBY_PLAN_ITEMS {
            *truncated = true;
            return;
        }
        path.push(index);
        let item_id = item.get("id").and_then(Value::as_str).unwrap_or_default();
        records.push(json!({
            "planId": tokenizer.value_token(plan_id),
            "dayOffset": day_offset,
            "itemId": tokenizer.value_token(item_id),
            "parentId": parent_id.map(|id| tokenizer.value_token(id)),
            "path": path,
            "textToken": item
                .get("text")
                .and_then(Value::as_str)
                .map(|text| tokenizer.value_token(text)),
            "htmlToken": item
                .get("html")
                .and_then(Value::as_str)
                .map(|html| tokenizer.value_token(html)),
            "done": item.get("done").and_then(Value::as_bool),
            "startMinutes": item.get("startMinutes").cloned().unwrap_or(Value::Null),
            "endMinutes": item.get("endMinutes").cloned().unwrap_or(Value::Null),
            "timeHidden": item.get("timeHidden").and_then(Value::as_bool),
        }));
        if let Some(children) = item.get("children").and_then(Value::as_array) {
            collect_nearby_plan_items(
                children,
                plan_id,
                day_offset,
                Some(item_id),
                path,
                tokenizer,
                records,
                truncated,
            );
        }
        path.pop();
        if *truncated {
            return;
        }
    }
}

fn nearby_plan_inventory(
    state: &Value,
    tokenizer: &Tokenizer<'_>,
    nearby_dates: &[String],
) -> Result<Value> {
    let expected_dates = (NEARBY_DAY_RADIUS * 2 + 1) as usize;
    if nearby_dates.len() != expected_dates
        || nearby_dates.iter().collect::<HashSet<_>>().len() != expected_dates
    {
        return Err(Error::Codec(
            "nearby diagnostic dates must contain five distinct days".into(),
        ));
    }
    let date_offsets = nearby_dates
        .iter()
        .enumerate()
        .map(|(index, date)| (date.as_str(), index as i64 - NEARBY_DAY_RADIUS))
        .collect::<HashMap<_, _>>();
    let active_date = state.get("activePlanDate").and_then(Value::as_str);
    let active_day_offset = active_date.and_then(|date| date_offsets.get(date).copied());
    let mut selected_plans = state
        .get("plans")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|plan| {
            let date = plan.get("date")?.as_str()?;
            let day_offset = *date_offsets.get(date)?;
            let plan_id = plan.get("id").and_then(Value::as_str).unwrap_or_default();
            Some((day_offset, tokenizer.value_token(plan_id), plan))
        })
        .collect::<Vec<_>>();
    selected_plans.sort_by(|left, right| (left.0, &left.1).cmp(&(right.0, &right.1)));

    let plans = selected_plans
        .iter()
        .map(|(day_offset, plan_id, plan)| {
            let date = plan.get("date").and_then(Value::as_str).unwrap_or_default();
            json!({
                "dayOffset": day_offset,
                "planId": plan_id,
                "dateToken": tokenizer.value_token(date),
            })
        })
        .collect::<Vec<_>>();
    let mut items = Vec::new();
    let mut truncated = false;
    for (day_offset, _, plan) in selected_plans {
        let plan_id = plan.get("id").and_then(Value::as_str).unwrap_or_default();
        let Some(plan_items) = plan.get("items").and_then(Value::as_array) else {
            continue;
        };
        collect_nearby_plan_items(
            plan_items,
            plan_id,
            day_offset,
            None,
            &mut Vec::new(),
            tokenizer,
            &mut items,
            &mut truncated,
        );
        if truncated {
            break;
        }
    }
    Ok(json!({
        "activeDayOffset": active_day_offset,
        "activeDateToken": active_day_offset
            .and_then(|_| active_date.map(|date| tokenizer.value_token(date))),
        "plans": plans,
        "items": items,
        "includedItems": items.len(),
        "truncated": truncated,
    }))
}

fn recent_operations(operations: &[Op]) -> &[Op] {
    &operations[operations.len().saturating_sub(MAX_TRACE_OPERATIONS)..]
}

fn load_recent_operations(connection: &Connection) -> Result<(Vec<Op>, bool)> {
    let mut statement = connection.prepare(
        "SELECT id, device_id, sequence, type, timestamp, payload_json
         FROM (
           SELECT id, device_id, sequence, type, timestamp, payload_json
           FROM operations
           ORDER BY timestamp DESC, device_id DESC, sequence DESC, id DESC
           LIMIT ?1
         )
         ORDER BY timestamp, device_id, sequence, id",
    )?;
    let fetched = statement
        .query_map(params![MAX_TRACE_OPERATIONS + 1], |row| {
            Ok(Op {
                id: row.get(0)?,
                device_id: row.get(1)?,
                sequence: row.get(2)?,
                op_type: row.get(3)?,
                timestamp: row.get(4)?,
                payload_json: row.get(5)?,
            })
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let truncated = fetched.len() > MAX_TRACE_OPERATIONS;
    Ok((recent_operations(&fetched).to_vec(), truncated))
}

fn identifier_key(key: &str) -> bool {
    key == "id" || key.ends_with("Id") || key.ends_with("Ids")
}

fn collect_strings(value: &Value, identifiers: &mut BTreeSet<String>) {
    match value {
        Value::String(value) => {
            identifiers.insert(value.clone());
        }
        Value::Array(values) => {
            for value in values {
                collect_strings(value, identifiers);
            }
        }
        _ => {}
    }
}

fn collect_recent_identifiers(value: &Value, identifiers: &mut BTreeSet<String>) {
    match value {
        Value::Array(values) => {
            for value in values {
                collect_recent_identifiers(value, identifiers);
            }
        }
        Value::Object(values) => {
            for (key, value) in values {
                if identifier_key(key) {
                    collect_strings(value, identifiers);
                } else {
                    collect_recent_identifiers(value, identifiers);
                }
            }
        }
        _ => {}
    }
}

fn matching_string_occurrences(
    value: &Value,
    identifiers: &HashSet<&str>,
    occurrences: &mut HashMap<String, usize>,
) {
    match value {
        Value::String(value) if identifiers.contains(value.as_str()) => {
            *occurrences.entry(value.clone()).or_default() += 1;
        }
        Value::Array(values) => {
            for value in values {
                matching_string_occurrences(value, identifiers, occurrences);
            }
        }
        Value::Object(values) => {
            for value in values.values() {
                matching_string_occurrences(value, identifiers, occurrences);
            }
        }
        _ => {}
    }
}

fn diagnostic_payload(operation: &Op, payload: &Value, tokenizer: &Tokenizer<'_>) -> Value {
    if operation.op_type != "replace_full_state" {
        return anonymize_json(payload, tokenizer);
    }

    let state_token = payload.get("state").map(|state| {
        let serialized = serde_json::to_string(state).unwrap_or_default();
        tokenizer.opaque_token("checkpoint-state", &serialized)
    });
    json!({
        "generation": payload.get("generation"),
        "frontiers": payload.get("frontiers").map(|value| anonymize_json(value, tokenizer)),
        "stateToken": state_token,
    })
}

fn elapsed_millis(connection: &Connection, timestamp: &str, earliest: f64) -> Option<i64> {
    connection
        .query_row(
            "SELECT CAST(ROUND((julianday(?1) - ?2) * 86400000.0) AS INTEGER)",
            params![timestamp, earliest],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten()
}

fn operation_trace(
    connection: &Connection,
    tokenizer: &Tokenizer<'_>,
    operations: &[Op],
) -> Result<Vec<Value>> {
    let earliest = operations
        .first()
        .and_then(|operation| {
            connection
                .query_row(
                    "SELECT julianday(?1)",
                    params![operation.timestamp],
                    |row| row.get::<_, Option<f64>>(0),
                )
                .ok()
                .flatten()
        })
        .unwrap_or(0.0);
    let mut previous_elapsed = None;
    operations
        .iter()
        .enumerate()
        .map(|(canonical_index, operation)| {
            let payload: Value = serde_json::from_str(&operation.payload_json)
                .map_err(|error| Error::Codec(format!("invalid operation payload: {error}")))?;
            let elapsed = elapsed_millis(connection, &operation.timestamp, earliest);
            let gap = elapsed
                .zip(previous_elapsed)
                .map(|(current, previous)| current - previous);
            if elapsed.is_some() {
                previous_elapsed = elapsed;
            }
            Ok(json!({
                "canonicalIndex": canonical_index,
                "id": tokenizer.id_token(&operation.id),
                "device": tokenizer.id_token(&operation.device_id),
                "sequence": operation.sequence,
                "type": operation.op_type,
                "timestampToken": tokenizer.opaque_token("timestamp", &operation.timestamp),
                "elapsedMs": elapsed,
                "previousGapMs": gap,
                "payload": diagnostic_payload(operation, &payload, tokenizer),
            }))
        })
        .collect()
}

fn relay_trace(
    connection: &Connection,
    tokenizer: &Tokenizer<'_>,
    now_ms: i64,
    recent_operation_ids: &HashSet<&str>,
) -> Result<Value> {
    super::relay_client::ensure_relay_tables(connection)?;
    let (epoch, cursor, last_success_ms, last_error) = connection.query_row(
        "SELECT epoch, cursor, last_success_ms, last_error FROM sync_relay_state WHERE singleton = 1",
        [],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        },
    )?;

    let known_recent_operations = {
        let mut statement = connection
            .prepare("SELECT EXISTS(SELECT 1 FROM sync_relay_known_ops WHERE op_id = ?1)")?;
        let mut known = recent_operation_ids
            .iter()
            .filter_map(|id| {
                statement
                    .query_row(params![id], |row| row.get::<_, bool>(0))
                    .ok()
                    .filter(|known| *known)
                    .map(|_| tokenizer.id_token(id))
            })
            .collect::<Vec<_>>();
        known.sort();
        known
    };

    let outbox = {
        let mut statement = connection
            .prepare("SELECT batch_id, epoch, op_ids_json FROM sync_relay_outbox ORDER BY rowid")?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows.into_iter()
            .filter_map(|(batch_id, epoch, ids_json)| {
                let all_operation_ids =
                    serde_json::from_str::<Vec<String>>(&ids_json).unwrap_or_default();
                let operation_ids = all_operation_ids
                    .iter()
                    .filter(|id| recent_operation_ids.contains(id.as_str()))
                    .map(|id| tokenizer.id_token(id))
                    .collect::<Vec<_>>();
                (!operation_ids.is_empty()).then(|| {
                    json!({
                        "batch": tokenizer.opaque_token("batch", &batch_id),
                        "epoch": tokenizer.opaque_token("epoch", &epoch),
                        "operationIds": operation_ids,
                        "containsOtherOperations": all_operation_ids.len() > operation_ids.len(),
                    })
                })
            })
            .collect::<Vec<_>>()
    };

    let quarantine = {
        let mut statement = connection.prepare(
            "SELECT blob_id, error, recorded_at_ms FROM sync_relay_quarantine
             ORDER BY recorded_at_ms DESC, blob_id DESC LIMIT ?1",
        )?;
        let rows = statement
            .query_map(params![MAX_QUARANTINE_ROWS], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|(blob_id, error, recorded_at_ms)| {
                json!({
                    "blob": tokenizer.opaque_token("blob", &blob_id),
                    "errorToken": tokenizer.opaque_token("error", &error),
                    "recordedAgeMs": now_ms.saturating_sub(recorded_at_ms),
                })
            })
            .collect::<Vec<_>>()
    };

    Ok(json!({
        "epoch": (!epoch.is_empty()).then(|| tokenizer.opaque_token("epoch", &epoch)),
        "cursor": cursor,
        "lastSuccessAgeMs": last_success_ms.map(|value| now_ms.saturating_sub(value)),
        "lastErrorToken": last_error.map(|value| tokenizer.opaque_token("error", &value)),
        "knownRecentOperationIds": known_recent_operations,
        "outbox": outbox,
        "quarantine": quarantine,
    }))
}

/// Build a trace suitable for comparing two paired devices without exposing
/// any raw string from either encrypted database.
pub fn anonymous_sync_trace(
    connection: &Connection,
    key: &SyncKey,
    app_version: &str,
    platform: &str,
    frontend_state: Option<Value>,
    nearby_dates: &[String],
) -> Result<Value> {
    ensure_sync_tables(connection)?;
    let tokenizer = Tokenizer { key };
    let state = crate::read_app_state_from_database(connection)
        .map_err(Error::Codec)?
        .ok_or_else(|| Error::Codec("database has no app state".into()))?;
    let local_device = state
        .get("deviceId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let local_sequence = state
        .get("localSequence")
        .and_then(Value::as_i64)
        .unwrap_or_default();
    let domain = domain_state(state);
    let domain_json = serde_json::to_string(&domain)
        .map_err(|error| Error::Codec(format!("serialize diagnostic state: {error}")))?;
    let frontend_domain = frontend_state.map(domain_state);
    let frontend_trace = frontend_domain.as_ref().map(|frontend| {
        let serialized = serde_json::to_string(frontend).unwrap_or_default();
        json!({
            "matchesDatabase": frontend == &domain,
            "stateToken": tokenizer.opaque_token("state", &serialized),
        })
    });
    let nearby_database = nearby_plan_inventory(&domain, &tokenizer, nearby_dates)?;
    let nearby_frontend = frontend_domain
        .as_ref()
        .map(|frontend| nearby_plan_inventory(frontend, &tokenizer, nearby_dates))
        .transpose()?;
    let nearby_comparison_complete = !nearby_database["truncated"].as_bool().unwrap_or(true)
        && nearby_frontend.as_ref().map_or(true, |frontend| {
            !frontend["truncated"].as_bool().unwrap_or(true)
        });
    let nearby_matches_database = if nearby_comparison_complete {
        nearby_frontend
            .as_ref()
            .map(|frontend| frontend == &nearby_database)
    } else {
        None
    };
    let (operations, truncated) = load_recent_operations(connection)?;
    let recent_operation_ids = operations
        .iter()
        .map(|operation| operation.id.as_str())
        .collect::<HashSet<_>>();
    let mut recent_identifiers = BTreeSet::new();
    for operation in &operations {
        if operation.op_type == "replace_full_state" {
            continue;
        }
        let payload: Value = serde_json::from_str(&operation.payload_json)
            .map_err(|error| Error::Codec(format!("invalid operation payload: {error}")))?;
        collect_recent_identifiers(&payload, &mut recent_identifiers);
    }
    let identifiers = recent_identifiers
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    let mut database_occurrences = HashMap::new();
    matching_string_occurrences(&domain, &identifiers, &mut database_occurrences);
    let mut frontend_occurrences = HashMap::new();
    if let Some(frontend) = &frontend_domain {
        matching_string_occurrences(frontend, &identifiers, &mut frontend_occurrences);
    }
    let mut recent_identifier_presence = recent_identifiers
        .into_iter()
        .map(|identifier| {
            json!({
                "token": tokenizer.value_token(&identifier),
                "databaseOccurrences": database_occurrences.get(&identifier).copied().unwrap_or(0),
                "frontendOccurrences": frontend_domain
                    .as_ref()
                    .map(|_| frontend_occurrences.get(&identifier).copied().unwrap_or(0)),
            })
        })
        .collect::<Vec<_>>();
    recent_identifier_presence
        .sort_by(|left, right| left["token"].as_str().cmp(&right["token"].as_str()));
    let frontiers = sync_frontiers(connection)?
        .into_iter()
        .map(|(device, sequence)| (tokenizer.id_token(&device), sequence))
        .collect::<BTreeMap<_, _>>();
    let now_ms = crate::current_timestamp_ms();

    Ok(json!({
        "format": TRACE_FORMAT,
        "privacy": {
            "rawUserDataStringsIncluded": false,
            "tokenMethod": "HMAC-SHA256/account-sync-key",
            "warning": "This reveals recent operation types, ordering, relative timing, numeric task fields, equality relationships, occurrence counts for recent identifiers, and the structure and completion state of up to 50 tasks within two days of local today.",
        },
        "build": {
            "version": app_version,
            "platform": platform,
        },
        "accountToken": tokenizer.opaque_token("account", TRACE_FORMAT),
        "device": {
            "id": tokenizer.id_token(&local_device),
            "localSequence": local_sequence,
        },
        "frontiers": frontiers,
        "window": {
            "policy": "newest-canonical-operations",
            "maximumOperations": MAX_TRACE_OPERATIONS,
            "includedOperations": operations.len(),
            "truncated": truncated,
        },
        "relay": relay_trace(connection, &tokenizer, now_ms, &recent_operation_ids)?,
        "operations": operation_trace(connection, &tokenizer, &operations)?,
        "recentIdentifierPresence": recent_identifier_presence,
        "nearbyPlanStructure": {
            "minimumDayOffset": -NEARBY_DAY_RADIUS,
            "maximumDayOffset": NEARBY_DAY_RADIUS,
            "maximumItems": MAX_NEARBY_PLAN_ITEMS,
            "comparisonComplete": nearby_comparison_complete,
            "matchesDatabase": nearby_matches_database,
            "database": nearby_database,
            "frontend": nearby_frontend,
        },
        "materializedStateToken": tokenizer.opaque_token("state", &domain_json),
        "frontend": frontend_trace,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_keys_are_preserved_but_dynamic_keys_are_not() {
        assert!(safe_schema_key("completedParentIds"));
        assert!(!safe_schema_key("dayTheme:2026-08-27"));
        assert!(!safe_schema_key("2026-08-27"));
    }

    #[test]
    fn tokens_are_stable_for_an_account_and_separate_between_accounts() {
        let first = SyncKey::from_bytes([7; 32]);
        let second = SyncKey::from_bytes([8; 32]);
        let first = Tokenizer { key: &first };
        let second = Tokenizer { key: &second };
        assert_eq!(first.value_token("secret"), first.value_token("secret"));
        assert_ne!(first.value_token("secret"), first.value_token("other"));
        assert_ne!(first.value_token("secret"), second.value_token("secret"));
    }

    #[test]
    fn recent_window_is_bounded_and_keeps_canonical_order() {
        let operations = (0..305)
            .map(|sequence| Op {
                id: format!("operation-{sequence}"),
                device_id: "device".into(),
                sequence,
                op_type: "patch_state".into(),
                timestamp: format!("2026-08-29T00:{:02}:00Z", sequence % 60),
                payload_json: "{}".into(),
            })
            .collect::<Vec<_>>();

        let recent = recent_operations(&operations);
        assert_eq!(recent.len(), MAX_TRACE_OPERATIONS);
        assert_eq!(recent.first().unwrap().id, "operation-5");
        assert_eq!(recent.last().unwrap().id, "operation-304");
    }

    #[test]
    fn database_query_returns_only_the_newest_canonical_operations() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE operations (
                   id TEXT PRIMARY KEY,
                   device_id TEXT NOT NULL,
                   sequence INTEGER NOT NULL,
                   type TEXT NOT NULL,
                   timestamp TEXT NOT NULL,
                   payload_json TEXT NOT NULL
                 );",
            )
            .unwrap();
        for sequence in (0..305_i64).rev() {
            connection
                .execute(
                    "INSERT INTO operations
                     (id, device_id, sequence, type, timestamp, payload_json)
                     VALUES (?1, 'device', ?2, 'patch_state', '2026-08-29T00:00:00Z', '{}')",
                    params![format!("operation-{sequence:03}"), sequence],
                )
                .unwrap();
        }

        let (operations, truncated) = load_recent_operations(&connection).unwrap();
        assert!(truncated);
        assert_eq!(operations.len(), MAX_TRACE_OPERATIONS);
        assert_eq!(operations.first().unwrap().sequence, 5);
        assert_eq!(operations.last().unwrap().sequence, 304);
        assert!(operations
            .windows(2)
            .all(|window| window[0].sequence < window[1].sequence));
    }

    #[test]
    fn checkpoint_trace_uses_a_fingerprint_instead_of_snapshot_contents() {
        let key = SyncKey::from_bytes([9; 32]);
        let tokenizer = Tokenizer { key: &key };
        let operation = Op {
            id: "checkpoint".into(),
            device_id: "device".into(),
            sequence: 0,
            op_type: "replace_full_state".into(),
            timestamp: "0000-00-00T00:00:00.000Z".into(),
            payload_json: "{}".into(),
        };
        let payload = json!({
            "state": {"plans": [{"title": "private checkpoint canary"}]},
            "generation": 4,
            "frontiers": {"private-device": 12}
        });
        let trace = diagnostic_payload(&operation, &payload, &tokenizer);
        let serialized = serde_json::to_string(&trace).unwrap();

        assert!(!serialized.contains("private checkpoint canary"));
        assert!(!serialized.contains("private-device"));
        assert_eq!(trace["generation"], 4);
        assert!(trace["stateToken"].as_str().unwrap().starts_with("x_"));
        assert!(trace.get("state").is_none());
    }

    #[test]
    fn identifier_presence_counts_exact_values_only() {
        let state = json!({
            "plans": [{"id": "plan-a", "items": [{"id": "task-a"}, {"id": "task-a"}]}],
            "text": "task-a is not counted inside other text"
        });
        let identifiers = HashSet::from(["task-a", "plan-a"]);
        let mut occurrences = HashMap::new();
        matching_string_occurrences(&state, &identifiers, &mut occurrences);
        assert_eq!(occurrences["task-a"], 2);
        assert_eq!(occurrences["plan-a"], 1);
    }

    #[test]
    fn nearby_inventory_correlates_copied_content_without_exposing_text_or_dates() {
        let key = SyncKey::from_bytes([10; 32]);
        let tokenizer = Tokenizer { key: &key };
        let state = json!({
            "activePlanDate": "2026-08-29",
            "plans": [
                {
                    "id": "plan-yesterday",
                    "date": "2026-08-28",
                    "items": [{
                        "id": "old-task-id",
                        "text": "private moved task",
                        "html": "<b>private moved task</b>",
                        "done": false,
                        "startMinutes": 600,
                        "endMinutes": 630,
                        "timeHidden": false,
                        "children": [{
                            "id": "private-child-id",
                            "text": "private child task",
                            "html": "private child task",
                            "done": true,
                            "children": []
                        }]
                    }]
                },
                {
                    "id": "plan-today",
                    "date": "2026-08-29",
                    "items": [{
                        "id": "pasted-task-id",
                        "text": "private moved task",
                        "html": "<b>private moved task</b>",
                        "done": true,
                        "children": []
                    }]
                },
                {
                    "id": "plan-outside-window",
                    "date": "2026-08-20",
                    "items": [{"id": "outside-id", "text": "outside private task", "children": []}]
                }
            ]
        });
        let dates = [
            "2026-08-27",
            "2026-08-28",
            "2026-08-29",
            "2026-08-30",
            "2026-08-31",
        ]
        .map(String::from);

        let inventory = nearby_plan_inventory(&state, &tokenizer, &dates).unwrap();
        let serialized = serde_json::to_string(&inventory).unwrap();
        for secret in [
            "private moved task",
            "private child task",
            "outside private task",
            "2026-08-28",
            "2026-08-29",
            "old-task-id",
            "pasted-task-id",
        ] {
            assert!(!serialized.contains(secret), "inventory leaked {secret:?}");
        }
        assert_eq!(inventory["plans"].as_array().unwrap().len(), 2);
        assert_eq!(inventory["items"].as_array().unwrap().len(), 3);
        assert_eq!(inventory["activeDayOffset"], 0);
        let yesterday = &inventory["items"][0];
        let child = &inventory["items"][1];
        let today = &inventory["items"][2];
        assert_eq!(yesterday["dayOffset"], -1);
        assert_eq!(today["dayOffset"], 0);
        assert_ne!(yesterday["itemId"], today["itemId"]);
        assert_eq!(yesterday["textToken"], today["textToken"]);
        assert_eq!(yesterday["htmlToken"], today["htmlToken"]);
        assert_eq!(yesterday["done"], false);
        assert_eq!(today["done"], true);
        assert_eq!(child["parentId"], yesterday["itemId"]);
        assert_eq!(child["path"], json!([0, 0]));
    }

    #[test]
    fn nearby_inventory_caps_large_days() {
        let key = SyncKey::from_bytes([11; 32]);
        let tokenizer = Tokenizer { key: &key };
        let items = (0..=MAX_NEARBY_PLAN_ITEMS)
            .map(|index| {
                json!({
                    "id": format!("item-{index}"),
                    "text": format!("private item {index}"),
                    "html": format!("private item {index}"),
                    "done": false,
                    "children": []
                })
            })
            .collect::<Vec<_>>();
        let state = json!({
            "plans": [{"id": "plan", "date": "2026-08-29", "items": items}]
        });
        let dates = [
            "2026-08-27",
            "2026-08-28",
            "2026-08-29",
            "2026-08-30",
            "2026-08-31",
        ]
        .map(String::from);

        let inventory = nearby_plan_inventory(&state, &tokenizer, &dates).unwrap();
        assert_eq!(inventory["includedItems"], MAX_NEARBY_PLAN_ITEMS);
        assert_eq!(
            inventory["items"].as_array().unwrap().len(),
            MAX_NEARBY_PLAN_ITEMS
        );
        assert_eq!(inventory["truncated"], true);
    }
}
