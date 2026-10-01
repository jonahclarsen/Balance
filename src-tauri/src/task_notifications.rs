//! OS schedules are a projection of durable generic records, never a wire action.
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskNotification {
    id: String,
    source_kind: String,
    source_id: String,
    item_id: String,
    at: i64,
    text: String,
}

pub(crate) fn pending(connection: &Connection, now: i64) -> Result<Vec<TaskNotification>, String> {
    let records = crate::read_entity_collection(connection, "taskNotifications")?;
    let candidates: Vec<TaskNotification> = records
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|record| serde_json::from_value::<TaskNotification>(record.clone()).ok())
        .filter(|record| record.at > now && !record.id.is_empty())
        .collect();
    if candidates.is_empty() {
        return Ok(Vec::new());
    }
    let mut live = HashSet::new();
    let mut statement = connection
        .prepare("select exists(select 1 from plan_items where plan_id = ?1 and id = ?2)")
        .map_err(|e| e.to_string())?;
    for record in &candidates {
        if record.source_kind == "plan"
            && statement
                .query_row(rusqlite::params![record.source_id, record.item_id], |row| {
                    row.get::<_, bool>(0)
                })
                .map_err(|e| e.to_string())?
        {
            live.insert((
                record.source_kind.clone(),
                record.source_id.clone(),
                record.item_id.clone(),
            ));
        }
    }
    fn visit(
        live: &mut HashSet<(String, String, String)>,
        source: &str,
        items: &serde_json::Value,
    ) {
        if let Some(items) = items.as_array() {
            for item in items {
                if let Some(id) = item["id"].as_str() {
                    live.insert(("list".to_string(), source.to_string(), id.to_string()));
                    visit(live, source, &item["children"]);
                }
            }
        }
    }
    if candidates.iter().any(|record| record.source_kind == "list") {
        for list in crate::read_entity_collection(connection, "lists")?
            .as_array()
            .into_iter()
            .flatten()
        {
            if let Some(id) = list["id"].as_str() {
                visit(&mut live, id, &list["items"]);
            }
        }
    }
    let mut pending: Vec<TaskNotification> = candidates
        .into_iter()
        .filter(|record| {
            live.contains(&(
                record.source_kind.clone(),
                record.source_id.clone(),
                record.item_id.clone(),
            ))
        })
        .collect();
    pending.sort_by(|a, b| a.at.cmp(&b.at).then(a.id.cmp(&b.id)));
    Ok(pending)
}

pub(crate) fn publish(connection: &Connection) -> Result<(), String> {
    #[cfg(any(target_os = "macos", target_os = "android"))]
    {
        let records = pending(connection, crate::current_timestamp_ms())?;
        let json = serde_json::to_string(&records).map_err(|e| e.to_string())?;
        platform::publish(&json)
    }
    #[cfg(not(any(target_os = "macos", target_os = "android")))]
    {
        let _ = connection;
        Ok(())
    }
}

#[cfg(target_os = "macos")]
mod platform {
    extern "C" {
        fn balance_replace_task_notifications(json: *const std::ffi::c_char) -> i32;
    }
    pub(super) fn publish(json: &str) -> Result<(), String> {
        let json = std::ffi::CString::new(json).map_err(|e| e.to_string())?;
        match unsafe { balance_replace_task_notifications(json.as_ptr()) } {
            0 => Ok(()),
            2 => Err(
                "Allow Balance notifications in macOS System Settings to receive sunset reminders"
                    .into(),
            ),
            _ => Err("macOS could not register task notifications".into()),
        }
    }
}

#[cfg(target_os = "android")]
mod platform {
    use jni::objects::{GlobalRef, JClass, JObject, JString};
    use jni::{JNIEnv, JavaVM};
    use std::sync::OnceLock;
    struct Bridge {
        vm: JavaVM,
        class: GlobalRef,
        context: GlobalRef,
    }
    static BRIDGE: OnceLock<Bridge> = OnceLock::new();

    #[no_mangle]
    pub extern "system" fn Java_app_balance_local_BalanceTaskNotifications_nativeInitialize(
        env: JNIEnv,
        class: JClass,
        context: JObject,
    ) {
        let bridge = (|| -> jni::errors::Result<Bridge> {
            Ok(Bridge {
                vm: env.get_java_vm()?,
                class: env.new_global_ref(class)?,
                context: env.new_global_ref(context)?,
            })
        })();
        if let Ok(bridge) = bridge {
            let _ = BRIDGE.set(bridge);
        }
    }

    pub(super) fn publish(json: &str) -> Result<(), String> {
        let Some(bridge) = BRIDGE.get() else {
            return Ok(());
        };
        let mut env = bridge
            .vm
            .attach_current_thread()
            .map_err(|e| e.to_string())?;
        let result = (|| -> jni::errors::Result<()> {
            let json = env.new_string(json)?;
            let class = JClass::from(env.new_local_ref(bridge.class.as_obj())?);
            env.call_static_method(
                class,
                "replace",
                "(Landroid/content/Context;Ljava/lang/String;)V",
                &[bridge.context.as_obj().into(), (&json).into()],
            )?;
            Ok(())
        })();
        if env.exception_check().unwrap_or(true) {
            let _ = env.exception_clear();
        }
        result.map_err(|e| e.to_string())
    }

    #[no_mangle]
    pub extern "system" fn Java_app_balance_local_BalanceTaskNotifications_nativeRefresh(
        mut env: JNIEnv,
        _class: JClass,
        path: JString,
    ) -> jni::sys::jboolean {
        let result =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> Result<(), String> {
                let path: String = env.get_string(&path).map_err(|e| e.to_string())?.into();
                let _guard = crate::database_access_guard()?;
                let database = crate::app_database_path_from_data_dir(std::path::Path::new(&path));
                if !database.exists() {
                    return Ok(());
                }
                let key = zeroize::Zeroizing::new(crate::database_recovery_key(&database)?);
                let connection = crate::open_database_at(&database, key.as_str())?;
                super::publish(&connection)
            }));
        u8::from(matches!(result, Ok(Ok(()))))
    }
}
