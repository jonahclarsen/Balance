use chrono::Local;
use rusqlite::Connection;
use std::ffi::CString;

use crate::widget::snapshot_from_plan;

extern "C" {
    fn balance_publish_encrypted_widget_snapshot(snapshot: *const std::ffi::c_char) -> bool;
}

pub(crate) fn publish_snapshot(connection: &Connection) -> Result<(), String> {
    let date = Local::now().format("%Y-%m-%d").to_string();
    let plan = super::read_plan_by_date(connection, &date)?;
    let snapshot = snapshot_from_plan(&date, plan.as_ref());
    let json = serde_json::to_string(&snapshot).map_err(|error| error.to_string())?;
    let json = CString::new(json).map_err(|error| error.to_string())?;

    if unsafe { balance_publish_encrypted_widget_snapshot(json.as_ptr()) } {
        Ok(())
    } else {
        Err("The macOS widget has not prepared its protected cache key yet".to_string())
    }
}
