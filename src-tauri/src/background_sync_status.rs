//! The outcome of Android's last background relay pass, kept beside the
//! database so Settings can show whether background refresh is really running.
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

const STATUS_FILE: &str = "background-sync-status.json";

#[derive(Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundSyncStatus {
    pub attempt_at: Option<i64>,
    pub success_at: Option<i64>,
    pub error: Option<String>,
}

pub fn read(directory: &Path) -> Option<BackgroundSyncStatus> {
    let text = fs::read_to_string(directory.join(STATUS_FILE)).ok()?;
    serde_json::from_str(&text).ok()
}

#[cfg_attr(not(any(test, target_os = "android")), allow(dead_code))]
pub fn record(directory: &Path, now_ms: i64, result: &Result<(), String>) {
    let mut status = read(directory).unwrap_or_default();
    status.attempt_at = Some(now_ms);
    match result {
        Ok(()) => {
            status.success_at = Some(now_ms);
            status.error = None;
        }
        Err(error) => status.error = Some(redact_urls(error)),
    }
    if let Ok(text) = serde_json::to_string(&status) {
        let _ = fs::create_dir_all(directory);
        let _ = fs::write(directory.join(STATUS_FILE), text);
    }
}

/// Relay URLs carry a secret path prefix. Keep them out of anything the UI shows.
fn redact_urls(text: &str) -> String {
    text.split(' ')
        .map(|word| if word.contains("://") { "<relay>" } else { word })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct Directory(PathBuf);

    impl Directory {
        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn keeps_the_last_success_through_later_failures() {
        let directory = std::env::temp_dir().join(format!(
            "balance-background-sync-status-{}-{}",
            std::process::id(),
            crate::current_timestamp_ms()
        ));
        let directory = Directory(directory);
        assert_eq!(read(directory.path()), None);

        record(directory.path(), 1_000, &Ok(()));
        record(
            directory.path(),
            2_000,
            &Err("error sending request for url (https://relay.example/secret/v3/manifest)".into()),
        );

        assert_eq!(
            read(directory.path()),
            Some(BackgroundSyncStatus {
                attempt_at: Some(2_000),
                success_at: Some(1_000),
                error: Some("error sending request for url <relay>".into()),
            })
        );

        record(directory.path(), 3_000, &Ok(()));
        let status = read(directory.path()).unwrap();
        assert_eq!(status.success_at, Some(3_000));
        assert_eq!(status.error, None);
    }
}
