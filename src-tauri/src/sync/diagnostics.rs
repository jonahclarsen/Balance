//! Privacy-preserving sync diagnostics.
//!
//! The trace deliberately contains no raw database strings. Every string value
//! and every dynamic object key is replaced with an HMAC token keyed by the
//! account sync key. Paired devices therefore emit the same token for the same
//! operation/entity/content while someone holding only the export cannot test
//! guesses or recover the original value.

use std::collections::BTreeMap;

use data_encoding::BASE32_NOPAD;
use hmac::{Hmac, Mac};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use sha2::Sha256;

use super::crypto::SyncKey;
use super::{all_ops, ensure_sync_tables, sync_frontiers, Error, Result};

const TRACE_FORMAT: &str = "balance-anonymous-sync-trace-v1";
const TOKEN_BYTES: usize = 20;

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

fn operation_trace(connection: &Connection, tokenizer: &Tokenizer<'_>) -> Result<Vec<Value>> {
    let operations = all_ops(connection)?;
    let earliest = connection
        .query_row(
            "SELECT min(julianday(timestamp)) FROM operations",
            [],
            |row| row.get::<_, Option<f64>>(0),
        )?
        .unwrap_or(0.0);
    let mut previous_elapsed = None;
    operations
        .into_iter()
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
                "payload": anonymize_json(&payload, tokenizer),
            }))
        })
        .collect()
}

fn relay_trace(connection: &Connection, tokenizer: &Tokenizer<'_>, now_ms: i64) -> Result<Value> {
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

    let known_operations = {
        let mut statement =
            connection.prepare("SELECT op_id FROM sync_relay_known_ops ORDER BY op_id")?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|id| tokenizer.id_token(&id))
            .collect::<Vec<_>>()
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
            .map(|(batch_id, epoch, ids_json)| {
                let operation_ids = serde_json::from_str::<Vec<String>>(&ids_json)
                    .unwrap_or_default()
                    .into_iter()
                    .map(|id| tokenizer.id_token(&id))
                    .collect::<Vec<_>>();
                json!({
                    "batch": tokenizer.opaque_token("batch", &batch_id),
                    "epoch": tokenizer.opaque_token("epoch", &epoch),
                    "operationIds": operation_ids,
                })
            })
            .collect::<Vec<_>>()
    };

    let quarantine = {
        let mut statement = connection.prepare(
            "SELECT blob_id, error, recorded_at_ms FROM sync_relay_quarantine ORDER BY recorded_at_ms, blob_id",
        )?;
        let rows = statement
            .query_map([], |row| {
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
        "knownOperationIds": known_operations,
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
            "state": anonymize_json(frontend, &tokenizer),
        })
    });
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
            "warning": "This reveals operation types, counts, ordering, relative timing, numeric task fields, and equality relationships.",
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
        "relay": relay_trace(connection, &tokenizer, now_ms)?,
        "operations": operation_trace(connection, &tokenizer)?,
        "materializedStateToken": tokenizer.opaque_token("state", &domain_json),
        "materializedState": anonymize_json(&domain, &tokenizer),
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
}
