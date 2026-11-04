//! Native half of the dev-versus-release profile (`typing-profile` feature; see
//! `scripts/profile-tauri-typing.mjs`). Never compiled into shipped builds. It
//! sends real key events through AppKit so WebKit's whole input path is timed.

use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use objc2::encode::{Encode, Encoding};
use objc2::rc::autoreleasepool;
use objc2::runtime::{AnyObject, Bool};
use objc2::{class, msg_send};
use objc2_foundation::NSString;
use tauri::{Manager, Runtime};

/// Each finished save: when it ended (ms since epoch) and how long it took.
static PERSISTS: Mutex<Vec<(f64, f64)>> = Mutex::new(Vec::new());

const KEY_DOWN: usize = 10;
const KEY_UP: usize = 11;

#[repr(C)]
#[derive(Clone, Copy)]
struct Point {
    x: f64,
    y: f64,
}

unsafe impl Encode for Point {
    const ENCODING: Encoding = Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
}

pub(crate) fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("typing-profile")
        .js_init_script(include_str!("typing_profile.js"))
        .build()
}

pub(crate) fn record_persist(elapsed: Duration) {
    if let (Ok(mut samples), Ok(now)) = (PERSISTS.lock(), SystemTime::now().duration_since(UNIX_EPOCH)) {
        samples.push((now.as_secs_f64() * 1_000.0, elapsed.as_secs_f64() * 1_000.0));
    }
}

fn virtual_key(character: char) -> Option<u16> {
    Some(match character {
        'a' => 0,
        's' => 1,
        'd' => 2,
        'f' => 3,
        'h' => 4,
        'g' => 5,
        'z' => 6,
        'x' => 7,
        'c' => 8,
        'v' => 9,
        'b' => 11,
        'q' => 12,
        'w' => 13,
        'e' => 14,
        'r' => 15,
        'y' => 16,
        't' => 17,
        'o' => 31,
        'u' => 32,
        'i' => 34,
        'p' => 35,
        'l' => 37,
        'j' => 38,
        'k' => 40,
        'n' => 45,
        'm' => 46,
        ' ' => 49,
        '\r' => 36,
        _ => return None,
    })
}

unsafe fn send_key(window: *mut AnyObject, character: char, key: u16) {
    autoreleasepool(|_| {
        let number: isize = msg_send![window, windowNumber];
        let process: *mut AnyObject = msg_send![class!(NSProcessInfo), processInfo];
        let uptime: f64 = msg_send![process, systemUptime];
        let characters = NSString::from_str(&character.to_string());
        let context: *mut AnyObject = std::ptr::null_mut();
        for kind in [KEY_DOWN, KEY_UP] {
            let event: *mut AnyObject = msg_send![
                class!(NSEvent),
                keyEventWithType: kind,
                location: Point { x: 0.0, y: 0.0 },
                modifierFlags: 0_usize,
                timestamp: uptime,
                windowNumber: number,
                context: context,
                characters: &*characters,
                charactersIgnoringModifiers: &*characters,
                isARepeat: Bool::NO,
                keyCode: key
            ];
            let _: () = msg_send![window, sendEvent: event];
        }
    });
}

/// Sends keys at a fixed cadence without waiting for the page, as a person
/// does, and returns when each was handed to the main thread (ms since epoch).
#[tauri::command]
pub(crate) async fn typing_profile_type(
    app: tauri::AppHandle,
    text: String,
    interval_ms: u64,
) -> Result<Vec<f64>, String> {
    let window = app.get_webview_window("main").ok_or("No main window")?;
    window.set_focus().map_err(|error| error.to_string())?;
    let keys = text
        .chars()
        .map(|character| virtual_key(character).map(|key| (character, key)))
        .collect::<Option<Vec<_>>>()
        .ok_or("Unsupported profile character")?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut sent = Vec::with_capacity(keys.len());
        for (character, key) in keys {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|error| error.to_string())?;
            sent.push(now.as_secs_f64() * 1_000.0);
            let target = window.clone();
            window
                .run_on_main_thread(move || {
                    if let Ok(pointer) = target.ns_window() {
                        unsafe { send_key(pointer.cast(), character, key) };
                    }
                })
                .map_err(|error| error.to_string())?;
            std::thread::sleep(Duration::from_millis(interval_ms));
        }
        Ok(sent)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) fn typing_profile_take_persists() -> Vec<(f64, f64)> {
    PERSISTS
        .lock()
        .map(|mut samples| std::mem::take(&mut *samples))
        .unwrap_or_default()
}

#[tauri::command]
pub(crate) fn typing_profile_finish(app: tauri::AppHandle, report: String) -> Result<(), String> {
    let output = std::env::var("BALANCE_TYPING_PROFILE_OUTPUT").map_err(|error| error.to_string())?;
    std::fs::write(output, report).map_err(|error| error.to_string())?;
    app.exit(0);
    Ok(())
}
