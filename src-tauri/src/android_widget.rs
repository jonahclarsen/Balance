use std::path::Path;

use jni::objects::{JClass, JString};
use jni::JNIEnv;

use crate::widget::{snapshot_from_plan, WidgetSnapshot};

fn load_snapshot(app_data_path: &Path, date: &str) -> Result<WidgetSnapshot, String> {
    let database_path = super::app_database_path_from_data_dir(app_data_path);
    if !database_path.exists() {
        return Ok(WidgetSnapshot::empty(date));
    }

    let _guard = super::database_access_guard()?;
    let recovery_key = super::database_recovery_key(&database_path)?;
    let connection = super::open_database_at(&database_path, &recovery_key)?;
    let plan = super::read_plan_by_date(&connection, date)?;
    Ok(snapshot_from_plan(date, plan.as_ref()))
}

#[no_mangle]
pub extern "system" fn Java_app_balance_local_BalanceWidgets_nativeSnapshot(
    mut env: JNIEnv,
    _class: JClass,
    app_data_path: JString,
    date: JString,
) -> jni::sys::jstring {
    let requested_date = env
        .get_string(&date)
        .map(|value| String::from(value))
        .unwrap_or_default();

    let snapshot = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let path = env
            .get_string(&app_data_path)
            .map(|value| String::from(value))
            .map_err(|error| error.to_string())?;
        load_snapshot(Path::new(&path), &requested_date)
    }))
    .ok()
    .and_then(Result::ok)
    .unwrap_or_else(|| WidgetSnapshot::unavailable(&requested_date));

    let json = serde_json::to_string(&snapshot).unwrap_or_else(|_| {
        format!(
            r#"{{"date":"{}","hasPlan":false,"unavailable":true,"title":"Today","reminder":"","done":0,"total":0,"items":[]}}"#,
            requested_date
        )
    });

    env.new_string(json)
        .map(|value| value.into_raw())
        .unwrap_or(std::ptr::null_mut())
}
