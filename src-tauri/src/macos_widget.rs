use chrono::{Local, Timelike};
use rusqlite::Connection;
use std::ffi::CString;

use crate::widget::snapshot_from_plan;

extern "C" {
    fn balance_publish_encrypted_widget_snapshot(snapshot: *const std::ffi::c_char) -> bool;
}

pub(crate) fn publish_snapshot(connection: &Connection) -> Result<(), String> {
    let now = Local::now();
    let mut current_day = now.date_naive();
    if now.hour() < 3 {
        current_day = current_day.pred_opt().unwrap_or(current_day);
    }
    let date = current_day.format("%Y-%m-%d").to_string();
    let plan = super::read_plan_by_date(connection, &date)?;
    let preferences = super::read_replicated_preferences(connection)?;
    let theme_id = preferences
        .get("themeId")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("violet");
    let snapshot = snapshot_from_plan(&date, plan.as_ref(), theme_id);
    let json = serde_json::to_string(&snapshot).map_err(|error| error.to_string())?;
    let json = CString::new(json).map_err(|error| error.to_string())?;

    if unsafe { balance_publish_encrypted_widget_snapshot(json.as_ptr()) } {
        Ok(())
    } else {
        Err("The macOS widget has not prepared its protected cache key yet".to_string())
    }
}
