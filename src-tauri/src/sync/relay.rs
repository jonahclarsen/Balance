//! Server-mediated transport: a *dumb* relay that stores opaque encrypted
//! changeset envelopes keyed by origin site + version. It never holds the sync
//! key, so it cannot read what it stores — E2EE at the transport layer.
//!
//! In production this is a network service (HTTP/WebSocket); the contract here
//! (push/pull of sealed envelopes) is identical.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub struct StoredEnvelope {
    pub origin_site_hex: String,
    pub max_db_version: i64,
    pub ciphertext: Vec<u8>,
}

#[derive(Clone, Default)]
pub struct Relay {
    inner: Arc<Mutex<Vec<StoredEnvelope>>>,
}

impl Relay {
    pub fn new() -> Self {
        Relay::default()
    }

    pub fn push(&self, env: StoredEnvelope) {
        self.inner.lock().unwrap().push(env);
    }

    pub fn pull_for(
        &self,
        my_site_hex: &str,
        cursors: &HashMap<String, i64>,
    ) -> Vec<StoredEnvelope> {
        self.inner
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e.origin_site_hex != my_site_hex)
            .filter(|e| {
                cursors
                    .get(&e.origin_site_hex)
                    .map(|seen| e.max_db_version > *seen)
                    .unwrap_or(true)
            })
            .cloned()
            .collect()
    }

    pub fn stored_blobs(&self) -> Vec<Vec<u8>> {
        self.inner
            .lock()
            .unwrap()
            .iter()
            .map(|e| e.ciphertext.clone())
            .collect()
    }
}
