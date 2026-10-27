//! Voice ideas are transcribed on macOS by `balance-transcriber`, which runs
//! Parakeet through FluidAudio. FluidAudio keeps its models in
//! ~/Library/Application Support/FluidAudio/Models, the directory VoiceInk also
//! uses, so a model either app downloaded serves both.
use serde_json::Value;

/// `clips` are base64 16 kHz mono little-endian i16 samples. Download progress
/// and each clip's result stream through `on_event` as the helper reports them.
#[tauri::command]
pub async fn transcribe_voice_clips(
    clips: Vec<String>,
    on_event: tauri::ipc::Channel<Value>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(move || macos::transcribe(&clips, &on_event))
            .await
            .map_err(|error| error.to_string())?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (clips, on_event);
        Err("Transcription is only available on macOS".to_string())
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use serde_json::Value;
    use std::io::{BufRead, BufReader};
    use std::path::PathBuf;
    use std::process::{Command, Stdio};

    const HELPER: &str = "balance-transcriber";

    fn helper_path() -> Result<PathBuf, String> {
        let executable = std::env::current_exe().map_err(|error| error.to_string())?;
        let bundled = executable.with_file_name(HELPER);
        if bundled.exists() {
            return Ok(bundled);
        }
        // `tauri dev` runs the bare binary; scripts/build-macos-transcriber.mjs builds here.
        #[cfg(debug_assertions)]
        {
            let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/macos-transcriber").join(HELPER);
            if development.exists() {
                return Ok(development);
            }
        }
        Err("The transcriber is missing from this build".to_string())
    }

    // Float32 files are what the helper reads; i16 halves the IPC payload.
    fn write_samples(path: &std::path::Path, encoded: &str) -> Result<(), String> {
        let bytes = data_encoding::BASE64.decode(encoded.as_bytes()).map_err(|_| "Invalid audio samples")?;
        let samples: Vec<u8> = bytes
            .chunks_exact(2)
            .flat_map(|pair| (i16::from_le_bytes([pair[0], pair[1]]) as f32 / 32768.0).to_le_bytes())
            .collect();
        std::fs::write(path, samples).map_err(|error| error.to_string())
    }

    struct TemporaryDirectory(PathBuf);

    impl Drop for TemporaryDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    pub(super) fn transcribe(clips: &[String], on_event: &tauri::ipc::Channel<Value>) -> Result<(), String> {
        if clips.is_empty() {
            return Ok(());
        }
        let helper = helper_path()?;
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |elapsed| elapsed.as_nanos());
        let directory = TemporaryDirectory(std::env::temp_dir().join(format!("balance-voice-{}-{nanos}", std::process::id())));
        std::fs::create_dir_all(&directory.0).map_err(|error| error.to_string())?;
        let mut paths = Vec::with_capacity(clips.len());
        for (index, clip) in clips.iter().enumerate() {
            let path = directory.0.join(format!("{index}.pcm"));
            write_samples(&path, clip)?;
            paths.push(path);
        }
        let mut child = Command::new(helper)
            .args(&paths)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("Could not start the transcriber: {error}"))?;
        let stdout = child.stdout.take().ok_or("The transcriber has no output")?;
        let mut failure = None;
        for line in BufReader::new(stdout).lines() {
            let line = line.map_err(|error| error.to_string())?;
            let Ok(event) = serde_json::from_str::<Value>(&line) else { continue };
            if event["event"] == "error" {
                failure = event["message"].as_str().map(str::to_owned);
            }
            on_event.send(event).map_err(|error| error.to_string())?;
        }
        let status = child.wait().map_err(|error| error.to_string())?;
        match failure {
            Some(message) => Err(message),
            None if !status.success() => Err("The transcriber stopped unexpectedly".to_string()),
            None => Ok(()),
        }
    }
}
