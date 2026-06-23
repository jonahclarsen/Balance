use std::env;
use std::path::PathBuf;

fn main() {
    // On Android we statically link the cr-sqlite engine (runtime extension
    // loading is fragile there). The per-ABI archives are produced by
    // scripts/build-crsqlite.sh into resources/android/<abi>/. Desktop builds
    // load the extension at runtime instead and need none of this.
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os == "android" {
        let arch = env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
        let abi = match arch.as_str() {
            "aarch64" => "arm64-v8a",
            "x86_64" => "x86_64",
            "arm" => "armeabi-v7a",
            "x86" => "x86",
            other => other,
        };
        let lib_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("android")
            .join(abi);
        println!("cargo:rustc-link-search=native={}", lib_dir.display());
        println!("cargo:rustc-link-lib=static=crsql_bundle_static");
        println!("cargo:rerun-if-changed={}", lib_dir.display());
    }

    tauri_build::build()
}
