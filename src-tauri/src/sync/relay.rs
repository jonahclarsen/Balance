//! Server-mediated transport: a *dumb* relay that stores opaque sealed
//! envelopes, tagged only with the device that pushed them. It never holds the
//! sync key, so it cannot read what it stores — E2EE at the transport layer.
//!
//! This in-memory implementation is a test double for the reference relay in
//! `scripts/relay-server.mjs`. The contract is deliberately tiny: push a blob,
//! pull back every blob some *other* device pushed. Reconciliation itself is
//! the receiving device's job (`merge_ops`), so the relay needs no cursors,
//! versions, or knowledge of the payload format.

use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub struct StoredEnvelope {
    /// The device that pushed this blob, so a device never pulls its own.
    pub origin_device_id: String,
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

    pub fn push(&self, origin_device_id: &str, ciphertext: Vec<u8>) {
        self.inner.lock().unwrap().push(StoredEnvelope {
            origin_device_id: origin_device_id.to_string(),
            ciphertext,
        });
    }

    /// Every envelope pushed by a device other than `my_device_id`.
    pub fn pull_for(&self, my_device_id: &str) -> Vec<StoredEnvelope> {
        self.inner
            .lock()
            .unwrap()
            .iter()
            .filter(|envelope| envelope.origin_device_id != my_device_id)
            .cloned()
            .collect()
    }

    /// Exactly what the server can see: opaque ciphertext.
    pub fn stored_blobs(&self) -> Vec<Vec<u8>> {
        self.inner
            .lock()
            .unwrap()
            .iter()
            .map(|envelope| envelope.ciphertext.clone())
            .collect()
    }
}
