use std::path::{Path, PathBuf};
use std::sync::Mutex;
use zeroize::Zeroizing;

/// Keep successful credential reads in this process only. Startup, maintenance,
/// and ordinary commands open separate connections, but should share one
/// Keychain authorization. Never persist this cache or cache access failures.
#[derive(Default)]
pub(crate) struct RecoveryKeyCache {
    key: Mutex<Option<(PathBuf, Zeroizing<String>)>>,
}

impl RecoveryKeyCache {
    pub(crate) const fn new() -> Self {
        Self {
            key: Mutex::new(None),
        }
    }

    pub(crate) fn get_or_load(
        &self,
        database_path: &Path,
        load: impl FnOnce() -> Result<String, String>,
    ) -> Result<String, String> {
        // Hold the lock through the credential read so concurrent callers do
        // not each display their own authorization dialog.
        let mut cached = self
            .key
            .lock()
            .map_err(|_| "Database recovery key cache is poisoned".to_string())?;
        if let Some((path, key)) = cached.as_ref() {
            if path == database_path {
                return Ok(key.to_string());
            }
        }
        let key = load()?;
        *cached = Some((database_path.to_path_buf(), Zeroizing::new(key.clone())));
        Ok(key)
    }

    /// Clear before rotation begins, including when rotation later fails and
    /// leaves credentials that must be reconciled by interrupted recovery.
    pub(crate) fn clear(&self) -> Result<(), String> {
        self.key
            .lock()
            .map_err(|_| "Database recovery key cache is poisoned".to_string())?
            .take();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn concurrent_startup_and_later_commands_authorize_only_once() {
        let cache = RecoveryKeyCache::new();
        let reads = AtomicUsize::new(0);
        let path = Path::new("synthetic/balance.sqlite3");
        std::thread::scope(|scope| {
            for _ in 0..7 {
                scope.spawn(|| {
                    let key = cache
                        .get_or_load(path, || {
                            reads.fetch_add(1, Ordering::SeqCst);
                            Ok("synthetic-session-key".to_string())
                        })
                        .unwrap();
                    assert_eq!(key, "synthetic-session-key");
                });
            }
        });
        assert_eq!(reads.load(Ordering::SeqCst), 1);
        assert_eq!(
            cache
                .get_or_load(path, || panic!("unexpected Keychain read"))
                .unwrap(),
            "synthetic-session-key"
        );
    }

    #[test]
    fn denied_access_can_be_retried() {
        let cache = RecoveryKeyCache::new();
        let path = Path::new("synthetic/balance.sqlite3");
        assert_eq!(
            cache.get_or_load(path, || Err("cancelled".into())),
            Err("cancelled".into())
        );
        assert_eq!(
            cache
                .get_or_load(path, || Ok("synthetic-key".into()))
                .unwrap(),
            "synthetic-key"
        );
    }

    #[test]
    fn rotation_invalidation_reloads_even_after_a_failed_recovery() {
        let cache = RecoveryKeyCache::new();
        let path = Path::new("synthetic/balance.sqlite3");
        cache
            .get_or_load(path, || Ok("synthetic-old-key".into()))
            .unwrap();
        cache.clear().unwrap();
        assert!(cache
            .get_or_load(path, || Err("rotation needs recovery".into()))
            .is_err());
        assert_eq!(
            cache
                .get_or_load(path, || Ok("synthetic-recovered-key".into()))
                .unwrap(),
            "synthetic-recovered-key"
        );
    }

    #[test]
    fn different_databases_do_not_reuse_each_others_keys() {
        let cache = RecoveryKeyCache::new();
        cache
            .get_or_load(Path::new("synthetic/first.sqlite3"), || {
                Ok("synthetic-first-key".into())
            })
            .unwrap();
        assert_eq!(
            cache
                .get_or_load(Path::new("synthetic/second.sqlite3"), || Ok(
                    "synthetic-second-key".into()
                ))
                .unwrap(),
            "synthetic-second-key"
        );
    }
}
