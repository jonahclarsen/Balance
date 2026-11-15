//! Full screen for the main window. On macOS it fills the whole display,
//! including the strips beside the camera notch: native full screen always
//! stops below the notch, so the main window uses simple full screen instead
//! (borderless, sized to the screen frame, menu bar and Dock auto-hidden).
//! The green button, the View menu and ⌃⌘F all send `toggleFullScreen:`, so
//! that selector is redirected for the main window.

#[cfg(target_os = "macos")]
static ACTIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Whether the main window is in (simple) full screen, so its frame isn't
/// saved as the window's placement.
#[cfg(target_os = "macos")]
pub(crate) fn active() -> bool {
    ACTIVE.load(std::sync::atomic::Ordering::Acquire)
}

fn is_fullscreen(window: &tauri::WebviewWindow) -> bool {
    #[cfg(target_os = "macos")]
    {
        let _ = window;
        active()
    }
    #[cfg(not(target_os = "macos"))]
    window.is_fullscreen().unwrap_or(false)
}

fn toggle(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    let enable = !is_fullscreen(window);
    #[cfg(target_os = "macos")]
    {
        // Set before the frame changes, so the resize it causes reads the new state.
        ACTIVE.store(enable, std::sync::atomic::Ordering::Release);
        window.set_simple_fullscreen(enable)
    }
    #[cfg(not(target_os = "macos"))]
    window.set_fullscreen(enable)
}

#[tauri::command]
pub(crate) async fn toggle_window_fullscreen(window: tauri::WebviewWindow) -> Result<(), String> {
    toggle(&window).map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) async fn window_fullscreen(window: tauri::WebviewWindow) -> bool {
    is_fullscreen(&window)
}

#[cfg(target_os = "macos")]
mod macos {
    use objc2::ffi::class_replaceMethod;
    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::{class, sel};
    use std::sync::OnceLock;
    use tauri::Manager;

    static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
    static NSWINDOW_TOGGLE: OnceLock<Imp> = OnceLock::new();

    type Toggle = unsafe extern "C-unwind" fn(&AnyObject, Sel, *mut AnyObject);

    unsafe extern "C-unwind" fn toggle_full_screen(this: &AnyObject, cmd: Sel, sender: *mut AnyObject) {
        let main = APP
            .get()
            .and_then(|app| app.get_webview_window("main"))
            .filter(|window| window.ns_window().is_ok_and(|ns| std::ptr::eq(ns.cast_const(), (this as *const AnyObject).cast())));
        if let Some(window) = main {
            // Leave the AppKit action before Tauri touches the window.
            tauri::async_runtime::spawn(async move {
                let _ = super::toggle(&window);
            });
            return;
        }
        // Other windows (Situate) keep native full screen.
        if let Some(original) = NSWINDOW_TOGGLE.get() {
            let original: Toggle = std::mem::transmute(*original);
            original(this, cmd, sender);
        }
    }

    pub(crate) fn install(app: &tauri::App) -> tauri::Result<()> {
        let window = app
            .get_webview_window("main")
            .ok_or(tauri::Error::WebviewNotFound)?;
        let ns_window = window.ns_window()?.cast::<AnyObject>();
        let _ = APP.set(app.handle().clone());
        unsafe {
            let selector = sel!(toggleFullScreen:);
            if let Some(original) = class!(NSWindow).instance_method(selector) {
                let _ = NSWINDOW_TOGGLE.set(original.implementation());
            }
            let class: *const AnyClass = (*ns_window).class();
            let toggle: Toggle = toggle_full_screen;
            class_replaceMethod(class.cast_mut(), selector, std::mem::transmute::<Toggle, Imp>(toggle), c"v@:@".as_ptr());
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
pub(crate) use macos::install;
