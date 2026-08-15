fn main() {
    build_macos_widget_bridge();

    let commit = std::process::Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|sha| !sha.is_empty())
        .unwrap_or_else(|| "unknown".into());
    println!("cargo:rustc-env=GIT_COMMIT={commit}");
    println!("cargo:rerun-if-changed=../.git/HEAD");

    tauri_build::build()
}

fn build_macos_widget_bridge() {
    let target = std::env::var("TARGET").unwrap_or_default();
    if !target.ends_with("-apple-darwin") {
        return;
    }

    let architecture = target
        .strip_suffix("-apple-darwin")
        .expect("macOS target architecture");
    let swift_target = format!("{architecture}-apple-macosx13.0");
    let output = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR"))
        .join("WidgetBridge.o");
    let source = std::path::Path::new("macos/WidgetBridge.swift");
    let status = std::process::Command::new("xcrun")
        .args([
            "swiftc",
            "-parse-as-library",
            "-emit-object",
            "-O",
            "-target",
            &swift_target,
            "-o",
        ])
        .arg(&output)
        .arg(source)
        .status()
        .expect("failed to run swiftc for the macOS widget bridge");
    assert!(
        status.success(),
        "failed to compile the macOS widget bridge"
    );

    println!("cargo:rerun-if-changed={}", source.display());
    println!("cargo:rustc-link-arg={}", output.display());
    println!("cargo:rustc-link-lib=framework=AppKit");
    println!("cargo:rustc-link-lib=framework=Security");
    println!("cargo:rustc-link-lib=framework=WidgetKit");
}
