use chrono::{Local, Timelike};
use rusqlite::Connection;
use std::ffi::CString;

use crate::widget::{
    snapshot_from_plan, theme_id_from_device_appearance, theme_id_from_preferences,
};

const SNAPSHOT_EXIT_GRACE_PERIOD_SECONDS: f64 = 15.0 * 60.0;
const DAY_ROLLOVER_HOUR: u32 = 3;

extern "C" {
    fn balance_publish_encrypted_widget_snapshot(snapshot: *const std::ffi::c_char) -> bool;
    fn balance_schedule_widget_snapshot_expiration(delay_seconds: f64) -> bool;
    fn balance_widget_hides_content_after_close() -> bool;
    fn balance_set_widget_hides_content_after_close(enabled: bool) -> bool;
}

pub(crate) fn hides_content_after_close() -> bool {
    unsafe { balance_widget_hides_content_after_close() }
}

pub(crate) fn set_hides_content_after_close(enabled: bool) -> Result<(), String> {
    if unsafe { balance_set_widget_hides_content_after_close(enabled) } {
        Ok(())
    } else {
        Err("Could not save the macOS widget privacy setting".to_string())
    }
}

pub(crate) fn schedule_snapshot_expiration() -> Result<(), String> {
    if unsafe { balance_schedule_widget_snapshot_expiration(SNAPSHOT_EXIT_GRACE_PERIOD_SECONDS) } {
        Ok(())
    } else {
        Err("Could not schedule the macOS widget snapshot expiration".to_string())
    }
}

pub(crate) fn publish_snapshot(connection: &Connection) -> Result<(), String> {
    let now = Local::now();
    let mut current_day = now.date_naive();
    if now.hour() < DAY_ROLLOVER_HOUR {
        current_day = current_day.pred_opt().unwrap_or(current_day);
    }
    let date = current_day.format("%Y-%m-%d").to_string();
    let plan = super::read_plan_by_date(connection, &date)?;
    let theme_id = if let Some(appearance) = super::read_device_appearance(connection)? {
        theme_id_from_device_appearance(&appearance, &date)
    } else {
        // One-launch compatibility fallback before the frontend migrates this
        // device from the former replicated appearance fields.
        let preferences = super::read_replicated_preferences(connection)?;
        theme_id_from_preferences(&preferences).to_string()
    };
    let snapshot = snapshot_from_plan(&date, plan.as_ref(), &theme_id);
    let json = serde_json::to_string(&snapshot).map_err(|error| error.to_string())?;
    let json = CString::new(json).map_err(|error| error.to_string())?;

    if unsafe { balance_publish_encrypted_widget_snapshot(json.as_ptr()) } {
        Ok(())
    } else {
        Err("The macOS widget has not prepared its protected cache key yet".to_string())
    }
}
