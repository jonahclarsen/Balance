//! The application Context, for framework calls made from Rust worker threads.
//! Calls through it never wait on Android's UI thread, which may be busy.
use jni::objects::{GlobalRef, JObject};
use jni::{JNIEnv, JavaVM};
use std::sync::OnceLock;

struct Application {
    vm: JavaVM,
    context: GlobalRef,
}

static APPLICATION: OnceLock<Application> = OnceLock::new();

/// Called with the application Context by a startup or worker entry point.
pub(crate) fn remember(env: &JNIEnv, context: &JObject) {
    if APPLICATION.get().is_some() {
        return;
    }
    if let (Ok(vm), Ok(context)) = (env.get_java_vm(), env.new_global_ref(context)) {
        let _ = APPLICATION.set(Application { vm, context });
    }
}

/// None before the Context is known, or when the call fails or throws.
pub(crate) fn with<T>(
    call: impl FnOnce(&mut JNIEnv, &JObject) -> jni::errors::Result<T>,
) -> Option<T> {
    let application = APPLICATION.get()?;
    let mut env = application.vm.attach_current_thread().ok()?;
    let result = call(&mut *env, application.context.as_obj());
    if env.exception_check().unwrap_or(true) {
        let _ = env.exception_clear();
        return None;
    }
    result.ok()
}
