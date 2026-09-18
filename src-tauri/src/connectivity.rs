//! Advisory OS connectivity. Unknown always permits a connection; no external
//! probe or internet-validation service decides whether our relay is reachable.

pub const OFFLINE: &str = "sync-offline";

#[cfg(target_os = "macos")]
pub fn offline(_app: &tauri::AppHandle) -> Option<bool> {
    extern "C" {
        fn balance_network_offline() -> i32;
    }
    match unsafe { balance_network_offline() } {
        1 => Some(true),
        0 => Some(false),
        _ => None,
    }
}

#[cfg(target_os = "android")]
pub fn offline(app: &tauri::AppHandle) -> Option<bool> {
    use tauri::Manager;
    let webview = app.get_webview_window("main")?;
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    webview
        .with_webview(move |webview| {
            webview.jni_handle().exec(move |env, activity, _| {
                let result = (|| -> jni::errors::Result<Option<bool>> {
                    let service = env.new_string("connectivity")?;
                    let manager = env
                        .call_method(
                            activity,
                            "getSystemService",
                            "(Ljava/lang/String;)Ljava/lang/Object;",
                            &[(&service).into()],
                        )?
                        .l()?;
                    if manager.is_null() {
                        return Ok(None);
                    }
                    let network = env
                        .call_method(&manager, "getActiveNetwork", "()Landroid/net/Network;", &[])?
                        .l()?;
                    // A default network is sufficient. In particular, do not require
                    // NET_CAPABILITY_VALIDATED (VPNs/blocked probes can lack it).
                    Ok(Some(network.is_null()))
                })();
                let has_exception = env.exception_check().unwrap_or(true);
                if has_exception {
                    let _ = env.exception_clear();
                }
                let _ = sender.send(if has_exception {
                    None
                } else {
                    result.ok().flatten()
                });
            });
        })
        .ok()?;
    // A suspended activity or unavailable service is unknown, never offline.
    receiver
        .recv_timeout(std::time::Duration::from_secs(1))
        .ok()
        .flatten()
}

#[cfg(not(any(target_os = "macos", target_os = "android")))]
pub fn offline(_app: &tauri::AppHandle) -> Option<bool> {
    None
}

#[tauri::command]
pub async fn get_sync_network_offline(app: tauri::AppHandle) -> Option<bool> {
    tauri::async_runtime::spawn_blocking(move || offline(&app))
        .await
        .ok()
        .flatten()
}
