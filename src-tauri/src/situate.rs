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
        let enabled = activation > 0;
        let target_of = |g: &Value| g["target"].as_str().unwrap_or("").to_string();
        let allowed = |target: &str| {
            grants.iter().find(|g| {
                g["mode"] == id
                    && (target_of(g).is_empty() || target_of(g) == target)
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
        modes.push(json!({"id":id,"name":mode["name"],"color":mode["color"],"active":active,"targets":targets,"allTargets":mode["targets"].as_array().into_iter().flatten().map(public_target).collect::<Vec<_>>()}));
    }
    json!({"version":1,"modes":modes,"aiBlocked":ai_blocked,"countdownUntil":countdown,"refreshAt":refresh,"enabled":true,"quizUrl":"balance://situate?mode=touch-grass"})
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
        let _ = action;
        Err("Unsupported setup action".into())
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
const EXTENSION_ID: &str = "ffookcmhbhdhicpdijnanfjifepgkkon";
const EXTENSION_FILES: [(&str, &[u8]); 10] = [
    ("manifest.json", include_bytes!("../../integrations/situate/chrome/manifest.json")),
    ("background.js", include_bytes!("../../integrations/situate/chrome/background.js")),
    ("content.js", include_bytes!("../../integrations/situate/chrome/content.js")),
    ("policy.js", include_bytes!("../../integrations/situate/chrome/policy.js")),
    ("popup.html", include_bytes!("../../integrations/situate/chrome/popup.html")),
    ("popup.js", include_bytes!("../../integrations/situate/chrome/popup.js")),
    ("icons/icon-16.png", include_bytes!("../../integrations/situate/chrome/icons/icon-16.png")),
    ("icons/icon-32.png", include_bytes!("../../integrations/situate/chrome/icons/icon-32.png")),
    ("icons/icon-48.png", include_bytes!("../../integrations/situate/chrome/icons/icon-48.png")),
    ("icons/icon-128.png", include_bytes!("../../integrations/situate/chrome/icons/icon-128.png")),
];
const NATIVE_HOST: &str = include_str!("../../integrations/situate/native-host.py");
/// Browsers that load the Situate extension, with their macOS profile roots.
fn browsers(home: &Path) -> [(&'static str, &'static str, PathBuf, &'static str); 2] {
    let support = home.join("Library/Application Support");
    [
        ("chrome", "Chrome", support.join("Google/Chrome"), "com.google.Chrome"),
        ("brave", "Brave", support.join("BraveSoftware/Brave-Browser"), "com.brave.Browser"),
    ]
}
/// Looks up only the Situate extension's entry in each profile's preferences.
fn extension_loaded(root: &Path) -> bool {
    let Ok(entries) = fs::read_dir(root) else {
        return false;
    };
    entries.flatten().any(|entry| {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        (name == "Default" || name.starts_with("Profile "))
            && ["Secure Preferences", "Preferences"].iter().any(|file| {
                fs::read(entry.path().join(file))
                    .ok()
                    .and_then(|raw| serde_json::from_slice::<Value>(&raw).ok())
                    .is_some_and(|prefs| {
                        let entry = &prefs["extensions"]["settings"][EXTENSION_ID];
                        entry.is_object()
                            && entry["disable_reasons"]
                                .as_array()
                                .is_none_or(|reasons| reasons.is_empty())
                            && entry["state"] != 0
                    })
            })
    })
}
#[tauri::command]
pub(crate) fn situate_extension(app: tauri::AppHandle, action: String) -> Result<Value, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let root = home.join(".local/share/balance-situate");
    let folder = root.join("extension");
    // Opens the browser's extensions page, which pages and links cannot do.
    #[cfg(target_os = "macos")]
    if let Some((_, _, _, bundle)) = browsers(&home)
        .into_iter()
        .find(|(id, ..)| action == format!("open-{id}"))
    {
        // Brave ignores brave:// links from other apps but maps chrome:// to its own pages.
        std::process::Command::new("open")
            .args(["-b", bundle, "chrome://extensions"])
            .status()
            .map_err(|e| e.to_string())?;
    }
    // Keep an installed copy current so a browser reload picks up new rules.
    let stale = EXTENSION_FILES
        .iter()
        .any(|(name, contents)| fs::read(folder.join(name)).ok().as_deref() != Some(*contents));
    if action == "install" || (folder.exists() && stale) {
        for (name, contents) in EXTENSION_FILES {
            write_file(&folder.join(name), contents, 0o600)?;
        }
        let host = root.join("native-host.py");
        write_file(&host, NATIVE_HOST.as_bytes(), 0o700)?;
        let manifest = json!({"name":"app.balance.situate","description":"Read-only Balance Situate status","path":host,"type":"stdio","allowed_origins":[format!("chrome-extension://{EXTENSION_ID}/")]});
        for (_, _, browser, _) in browsers(&home) {
            if browser.exists() {
                write_file(
                    &browser.join("NativeMessagingHosts/app.balance.situate.json"),
                    format!("{manifest:#}\n").as_bytes(),
                    0o600,
                )?;
            }
        }
    }
    let list: Vec<Value> = browsers(&home)
        .into_iter()
        .filter(|(_, _, browser, _)| browser.exists())
        .map(|(id, name, browser, _)| json!({"id":id,"name":name,"extension":extension_loaded(&browser),"host":browser.join("NativeMessagingHosts/app.balance.situate.json").exists()}))
        .collect();
    Ok(json!({"browsers":list,"folder":folder}))
}
fn write_file(path: &Path, contents: &[u8], mode: u32) -> Result<(), String> {
    fs::create_dir_all(path.parent().ok_or("Missing directory")?).map_err(|e| e.to_string())?;
    fs::write(path, contents).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).map_err(|e| e.to_string())?;
    }
    #[cfg(not(unix))]
    let _ = mode;
    Ok(())
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
            let builder = tauri::WebviewWindowBuilder::new(
                app,
                "situate",
                tauri::WebviewUrl::App(format!("situate.html?{query}").into()),
            )
            .title("Situate")
            .inner_size(440.0, 540.0)
            .min_inner_size(320.0, 400.0);
            // The page draws its own close button, so keep only the native frame.
            #[cfg(target_os = "macos")]
            let builder = builder
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true);
            #[cfg(target_os = "macos")]
            if let Ok(window) = builder.build() {
                let _ = window.clone().run_on_main_thread(move || hide_window_buttons(&window));
            }
            #[cfg(not(target_os = "macos"))]
            let _ = builder.decorations(false).build();
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
        #[cfg(target_os = "macos")]
        let mut revision = None;
        loop {
            let current = (|| {
                let _guard = LOCK.lock().ok()?;
                read(&path).ok().flatten()
            })();
            if let Some(doc) = current {
                #[cfg(target_os = "macos")]
                // Saves bump the revision; only schedule and pass changes announce a mode.
                let saved = revision.replace(doc["revision"].clone()).as_ref() != Some(&doc["revision"]);
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
                        publish_mac(&current, !saved);
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
                .map(|m| json!({"id":m["id"],"name":m["name"],"color":m["color"],"active":m["active"]}))
                .collect()
        })
        .unwrap_or_default()
}
/// Situate keeps Balance running in the background once it has rules.
pub(crate) fn active() -> bool {
    DIRECTORY
        .get()
        .and_then(|p| read(p).ok().flatten())
        .is_some()
}
#[cfg(target_os = "macos")]
fn hide_window_buttons(window: &tauri::WebviewWindow) {
    use objc2_app_kit::{NSWindow, NSWindowButton};
    let Ok(ns_window) = window.ns_window() else {
        return;
    };
    let ns_window = unsafe { &*ns_window.cast::<NSWindow>() };
    for kind in [
        NSWindowButton::CloseButton,
        NSWindowButton::MiniaturizeButton,
        NSWindowButton::ZoomButton,
    ] {
        if let Some(button) = ns_window.standardWindowButton(kind) {
            button.setHidden(true);
        }
    }
}
#[cfg(target_os = "macos")]
fn publish_mac(value: &Value, announce: bool) {
    extern "C" {
        fn balance_situate_update(raw: *const std::ffi::c_char, announce: bool);
    }
    if let Ok(raw) = std::ffi::CString::new(value.to_string()) {
        unsafe {
            balance_situate_update(raw.as_ptr(), announce);
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
        json!({"generatedAt":1,"epochs":[{"at":100,"end":1000,"phase":"night"}],"modes":[{"id":"touch-grass","name":"Touch grass","platforms":["mac"],"scheduled":true,"targets":[{"id":"yt","kind":"domain","value":"youtube.com"}]}],"manual":{},"grants":[]})
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
        assert_eq!(status(&d, "mac", 202)["modes"][0]["targets"].as_array().unwrap().len(), 1);
    }
}
