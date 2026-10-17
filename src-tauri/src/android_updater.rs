//! One-tap Android updates: Kotlin streams the release APK into PackageInstaller.
use std::sync::OnceLock;

use jni::objects::{GlobalRef, JClass, JString};
use jni::JNIEnv;

static UPDATER_CLASS: OnceLock<GlobalRef> = OnceLock::new();

#[no_mangle]
pub extern "system" fn Java_app_balance_local_BalanceUpdater_nativeRegister(
    env: JNIEnv,
    class: JClass,
) {
    // Keep the class Java handed us; an attached Rust thread cannot find app
    // classes through the system class loader.
    if UPDATER_CLASS.get().is_none() {
        if let Ok(class) = env.new_global_ref(class) {
            let _ = UPDATER_CLASS.set(class);
        }
    }
}

/// Blocks while the APK downloads, then returns once Android's installer has it.
pub fn install(tag: &str) -> Result<(), String> {
    let class = UPDATER_CLASS
        .get()
        .ok_or_else(|| "Balance is still starting. Try again in a moment.".to_string())?;
    let message = super::android_keystore::with_env(|env| {
        let class = JClass::from(env.new_local_ref(class.as_obj()).map_err(|error| error.to_string())?);
        let tag = env.new_string(tag).map_err(|error| error.to_string())?;
        let result = env
            .call_static_method(class, "install", "(Ljava/lang/String;)Ljava/lang/String;", &[(&tag).into()])
            .and_then(|value| value.l())
            .map_err(|error| error.to_string())?;
        env.get_string(&JString::from(result))
            .map(String::from)
            .map_err(|error| error.to_string())
    })?;
    if message.is_empty() {
        Ok(())
    } else {
        Err(message)
    }
}
