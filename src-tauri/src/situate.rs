//! Situate never opens the planner database. Only rules and temporary grants live here.
use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
use tauri::{Emitter, Manager};
static LOCK: Mutex<()> = Mutex::new(());
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
static DIRECTORY: OnceLock<PathBuf> = OnceLock::new();
fn path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("situate/rules.json"))
}
fn read(path: &Path) -> Result<Option<Value>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > 2_000_000 {
        return Err("Invalid Situate rules file".into());
    }
    serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map(Some)
        .map_err(|e| e.to_string())
}
fn write(path: &Path, value: &Value) -> Result<(), String> {
    let parent = path.parent().ok_or("Missing Situate directory")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    let temporary = parent.join(format!(".situate-{}.tmp", rand::random::<u64>()));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(|e| e.to_string())?;
        file.write_all(&serde_json::to_vec(value).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        fs::rename(&temporary, path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}
fn number(v: &Value) -> i64 {
    v.as_i64()
        .or_else(|| v.as_f64().map(|v| v as i64))
        .unwrap_or(0)
}
fn public_target(target: &Value) -> Value {
    json!({"id":target["id"],"kind":target["kind"],"value":target["value"],"category":target["category"]})
}
pub(crate) fn status(doc: &Value, platform: &str, now: i64) -> Value {
    let epochs = doc["epochs"].as_array();
    let epoch = epochs.and_then(|es| {
        es.iter()
            .find(|e| number(&e["at"]) <= now && now < number(&e["end"]))
    });
    let at = epoch
        .map(|e| number(&e["at"]))
        .unwrap_or(number(&doc["generatedAt"]));
    let end = epoch.map(|e| number(&e["end"])).unwrap_or(now + 60_000);
    let grants = doc["grants"].as_array().cloned().unwrap_or_default();
    let mut refresh = end;
    let mut modes = Vec::new();
    let mut ai_blocked = false;
    let mut countdown = Value::Null;
    for mode in doc["modes"].as_array().into_iter().flatten() {
        if !mode["platforms"]
            .as_array()
            .is_some_and(|ps| ps.iter().any(|p| p == platform))
        {
            continue;
        }
        let id = mode["id"].as_str().unwrap_or("");
        let activation =
            if mode["scheduled"] == true { at } else { 0 }.max(number(&doc["manual"][id]));
        let enabled = doc["enabled"] == true && activation > 0;
        let allowed = |target: &str| {
            grants.iter().find(|g| {
                g["mode"] == id
                    && (g["target"] == "" || g["target"] == target)
                    && number(&g["epoch"]) >= activation
                    && number(&g["until"]) > now
            })
        };
        for grant in &grants {
            let until = number(&grant["until"]);
            if until > now {
                refresh = refresh.min(until);
            }
        }
        let active = enabled && allowed("").is_none();
        let mut targets = Vec::new();
        for target in mode["targets"].as_array().into_iter().flatten() {
            if enabled && allowed(target["id"].as_str().unwrap_or("")).is_none() {
                targets.push(public_target(target));
            }
        }
        if id == "touch-grass" {
            ai_blocked = active;
            if enabled && epoch.is_some_and(|e| e["phase"] == "night") {
                if let Some(g) = allowed("") {
                    countdown = g["until"].clone();
                }
            }
        }
        modes.push(json!({"id":id,"name":mode["name"],"active":active,"targets":targets,"allTargets":mode["targets"].as_array().into_iter().flatten().map(public_target).collect::<Vec<_>>()}));
    }
    json!({"version":1,"modes":modes,"aiBlocked":ai_blocked,"countdownUntil":countdown,"refreshAt":refresh,"enabled":doc["enabled"],"quizUrl":"balance://situate?mode=touch-grass"})
}
#[tauri::command]
pub(crate) fn situate_load(app: tauri::AppHandle) -> Result<Option<Value>, String> {
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    read(&path(&app)?)
}
#[tauri::command]
pub(crate) fn situate_save(
    app: tauri::AppHandle,
    document: Value,
    expected_revision: i64,
) -> Result<(), String> {
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    let path = path(&app)?;
    let old = read(&path)?;
    if old.as_ref().map(|d| number(&d["revision"])).unwrap_or(0) != expected_revision {
        return Err("Situate changed in another window. Reopen Balance before editing.".into());
    }
    if document["version"] != 1
        || number(&document["revision"]) != expected_revision + 1
        || serde_json::to_vec(&document)
            .map_err(|e| e.to_string())?
            .len()
            > 2_000_000
    {
        return Err("Invalid Situate rules".into());
    }
    write(&path, &document)?;
    let _ = app.emit("situate-rules-changed", document["revision"].clone());
    #[cfg(target_os = "android")]
    android::call("refresh", &json!({"document": document}).to_string())?;
    Ok(())
}
#[tauri::command]
pub(crate) fn situate_permissions(action: String) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        return android::call("permissions", &action);
    }
    #[cfg(not(target_os = "android"))]
    {
        if action != "status" {
            return Err("Unsupported setup action".into());
        }
        Ok("App blocking runs while Balance is open. Websites require the Situate Chrome extension. Integrations read ~/.local/share/balance-situate/status.json; this contains only Situate rules/status.".into())
    }
}
#[tauri::command]
pub(crate) async fn situate_notifications(action: String, query: Value) -> Result<Value, String> {
    #[cfg(target_os = "android")]
    {
        return tauri::async_runtime::spawn_blocking(move || {
            serde_json::from_str(&android::call(&action, &query.to_string())?)
                .map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (action, query);
        Err("Notification history is Android-only".into())
    }
}
pub(crate) fn open_widget(app: &tauri::AppHandle, raw: &str) -> bool {
    #[cfg(not(target_os = "android"))]
    {
        let Ok(url) = tauri::Url::parse(raw) else {
            return false;
        };
        if url.host_str() != Some("situate")
            || !url.query_pairs().any(|(k, v)| k == "widget" && v == "1")
        {
            return false;
        }
        if let Some(window) = app.get_webview_window("situate") {
            let _ = window.emit("situate-widget", raw);
            let _ = window.show();
            let _ = window.set_focus();
        } else {
            let query: String = url.query().unwrap_or("").into();
            let _ = tauri::WebviewWindowBuilder::new(
                app,
                "situate",
                tauri::WebviewUrl::App(format!("situate.html?{query}").into()),
            )
            .title("Situate")
            .inner_size(440.0, 540.0)
            .min_inner_size(320.0, 400.0)
            .build();
        }
        return true;
    }
    #[cfg(target_os = "android")]
    {
        let _ = (app, raw);
        false
    }
}
pub(crate) fn start(app: tauri::AppHandle) {
    let _ = APP.set(app.clone());
    let Ok(path) = path(&app) else {
        return;
    };
    let _ = DIRECTORY.set(path.clone());
    #[cfg(not(target_os = "android"))]
    std::thread::spawn(move || {
        let mut last = Value::Null;
        loop {
            let current = (|| {
                let _guard = LOCK.lock().ok()?;
                read(&path).ok().flatten()
            })();
            if let Some(doc) = current {
                let current = status(
                    &doc,
                    if cfg!(target_os = "macos") {
                        "mac"
                    } else {
                        "windows"
                    },
                    crate::current_timestamp_ms(),
                );
                if current != last {
                    if let Ok(home) = app.path().home_dir() {
                        let _ = write(
                            &home.join(".local/share/balance-situate/status.json"),
                            &current,
                        );
                    }
                    #[cfg(target_os = "macos")]
                    {
                        publish_mac(&current);
                        if crate::macos_widget::published_snapshot_is_current() {
                            if let Ok(_guard) = crate::database_access_guard() {
                                let _ = crate::with_database(&app, |connection| {
                                    crate::macos_widget::publish_snapshot(connection)
                                });
                            }
                        }
                    }
                    let _ = app.emit("situate-status", &current);
                    last = current;
                }
            }
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
    });
    #[cfg(target_os = "android")]
    let _ = app;
}
pub(crate) fn widget_modes() -> Vec<Value> {
    DIRECTORY
        .get()
        .and_then(|p| read(p).ok().flatten())
        .map(|doc| {
            let current = status(
                &doc,
                if cfg!(target_os = "android") {
                    "android"
                } else {
                    "mac"
                },
                crate::current_timestamp_ms(),
            );
            current["modes"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|m| json!({"id":m["id"],"name":m["name"],"active":m["active"]}))
                .collect()
        })
        .unwrap_or_default()
}
pub(crate) fn active() -> bool {
    DIRECTORY
        .get()
        .and_then(|p| read(p).ok().flatten())
        .is_some_and(|d| d["enabled"] == true)
}
#[cfg(target_os = "macos")]
fn publish_mac(value: &Value) {
    extern "C" {
        fn balance_situate_update(raw: *const std::ffi::c_char);
    }
    if let Ok(raw) = std::ffi::CString::new(value.to_string()) {
        unsafe {
            balance_situate_update(raw.as_ptr());
        }
    }
}
#[cfg(target_os = "android")]
mod android {
    use jni::{
        objects::{GlobalRef, JClass, JObject, JString},
        JNIEnv, JavaVM,
    };
    use std::sync::OnceLock;
    struct Bridge {
        vm: JavaVM,
        class: GlobalRef,
        context: GlobalRef,
    }
    static BRIDGE: OnceLock<Bridge> = OnceLock::new();
    #[no_mangle]
    pub extern "system" fn Java_app_balance_local_BalanceSituate_nativeInitialize(
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
        if let Ok(b) = bridge {
            let _ = BRIDGE.set(b);
        }
    }
    #[no_mangle]
    pub extern "system" fn Java_app_balance_local_BalanceSituate_nativeStatus(
        mut env: JNIEnv,
        _class: JClass,
        document: JString,
        now: jni::sys::jlong,
    ) -> jni::sys::jstring {
        let result = (|| -> Result<String, String> {
            let raw: String = env.get_string(&document).map_err(|e| e.to_string())?.into();
            let value: serde_json::Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
            Ok(super::status(&value, "android", now).to_string())
        })()
        .unwrap_or_else(|_| "{}".into());
        env.new_string(result)
            .map(|s| s.into_raw())
            .unwrap_or(std::ptr::null_mut())
    }
    #[no_mangle]
    pub extern "system" fn Java_app_balance_local_BalanceSituate_nativeDeepLink(
        mut env: JNIEnv,
        _class: JClass,
        url: JString,
    ) {
        if let Ok(url) = env.get_string(&url) {
            let raw: String = url.into();
            if raw.len() <= 4096 && raw.starts_with("balance://") {
                if let Some(app) = super::APP.get() {
                    crate::deliver_balance_deep_link(app, raw);
                } else if let Ok(mut links) = crate::PENDING_DEEP_LINKS.lock() {
                    if links.len() < 32 && !links.contains(&raw) {
                        links.push(raw);
                    }
                }
            }
        }
    }
    pub(super) fn call(action: &str, query: &str) -> Result<String, String> {
        let b = BRIDGE
            .get()
            .ok_or("Situate Android bridge is unavailable")?;
        let mut env = b.vm.attach_current_thread().map_err(|e| e.to_string())?;
        let result = (|| -> jni::errors::Result<String> {
            let action = env.new_string(action)?;
            let query = env.new_string(query)?;
            let class = JClass::from(env.new_local_ref(b.class.as_obj())?);
            let value = env.call_static_method(class,"call","(Landroid/content/Context;Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;", &[b.context.as_obj().into(),(&action).into(),(&query).into()])?.l()?;
            Ok(env.get_string(&JString::from(value))?.into())
        })();
        if env.exception_check().unwrap_or(true) {
            let _ = env.exception_clear();
        }
        result.map_err(|e| e.to_string())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_policy_matches_frontend_fixtures() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/situate-policy.json")).unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let actual = status(
                &fixture["documents"][case["document"].as_u64().unwrap() as usize],
                case["platform"].as_str().unwrap(),
                number(&case["now"]),
            );
            let modes: Vec<Value> = actual["modes"].as_array().unwrap().iter().map(|m| json!({"id":m["id"],"active":m["active"],"targets":m["targets"].as_array().unwrap().iter().map(|t|t["id"].clone()).collect::<Vec<_>>()})).collect();
            assert_eq!(json!(modes), case["expected"]);
        }
    }
    fn fixture() -> Value {
        json!({"enabled":true,"generatedAt":1,"epochs":[{"at":100,"end":1000,"phase":"night"}],"modes":[{"id":"touch-grass","name":"Touch grass","platforms":["mac"],"scheduled":true,"targets":[{"id":"yt","kind":"domain","value":"youtube.com"}]}],"manual":{},"grants":[]})
    }
    #[test]
    fn grants_expire_and_never_expose_private_fields() {
        let mut d = fixture();
        d["secretPlanner"] = json!("not public");
        d["settings"] = json!({"latitude":1});
        assert_eq!(status(&d, "mac", 200)["aiBlocked"], true);
        d["grants"] = json!([{"mode":"touch-grass","target":"","epoch":100,"until":500}]);
        let s = status(&d, "mac", 200);
        assert_eq!(s["aiBlocked"], false);
        assert_eq!(s["countdownUntil"], 500);
        assert!(s.get("secretPlanner").is_none());
        assert!(s.get("settings").is_none());
        assert_eq!(status(&d, "mac", 500)["aiBlocked"], true);
        assert_eq!(status(&d, "android", 200)["modes"], json!([]));
    }
    #[test]
    fn target_grant_never_unlocks_mode_and_manual_reactivation_revokes_pass() {
        let mut d = fixture();
        d["grants"] = json!([{"mode":"touch-grass","target":"yt","epoch":100,"until":500}]);
        let s = status(&d, "mac", 200);
        assert_eq!(s["aiBlocked"], true);
        assert_eq!(s["modes"][0]["targets"], json!([]));
        d["manual"] = json!({"touch-grass":201});
        assert_eq!(
            status(&d, "mac", 202)["modes"][0]["targets"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
}
