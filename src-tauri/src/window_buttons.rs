//! The macOS traffic lights. Retro themes draw their own caption buttons, so
//! the page asks for the native ones to be hidden while its caption shows.

#[cfg(target_os = "macos")]
pub(crate) fn set_hidden(window: &tauri::WebviewWindow, hidden: bool) {
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
            button.setHidden(hidden);
        }
    }
}

#[tauri::command]
pub(crate) fn set_native_window_buttons_hidden(window: tauri::WebviewWindow, hidden: bool) {
    #[cfg(target_os = "macos")]
    {
        let target = window.clone();
        let _ = window.run_on_main_thread(move || set_hidden(&target, hidden));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (window, hidden);
}
