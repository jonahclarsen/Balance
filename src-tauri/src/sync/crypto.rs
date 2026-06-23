//! End-to-end encryption for changeset blobs.
//!
//! The *sync key* is a 32-byte symmetric secret shared across a user's devices
//! (transferred device-to-device at pairing, e.g. via QR). It is distinct from
//! each device's local SQLCipher at-rest key. Every changeset is sealed with
//! XChaCha20-Poly1305 (24-byte random nonce) before it touches any transport,
//! so relays and sockets only ever see ciphertext.

use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use data_encoding::BASE32_NOPAD;
use rand::RngCore;
use sha2::{Digest, Sha256};

use super::{ChangeSet, Error, Result};

/// Prefix identifying a Balance v1 pairing payload (the string a QR encodes).
const PAIRING_PREFIX: &str = "BALSYNC1:";

#[derive(Clone)]
pub struct SyncKey([u8; 32]);

impl SyncKey {
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        SyncKey(bytes)
    }

    pub fn generate() -> Self {
        let mut k = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut k);
        SyncKey(k)
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    /// Encode this key as a compact, QR-friendly pairing string: a version
    /// prefix followed by Base32(key ‖ 4-byte SHA-256 checksum). The existing
    /// device shows this (as text or a QR); the new device scans/pastes it. The
    /// checksum catches transcription/scan errors before a bad key is accepted.
    pub fn to_pairing_code(&self) -> String {
        let mut payload = self.0.to_vec();
        payload.extend_from_slice(&checksum(&self.0));
        format!("{PAIRING_PREFIX}{}", BASE32_NOPAD.encode(&payload))
    }

    /// Parse a pairing string back into a key, verifying the prefix and checksum.
    pub fn from_pairing_code(code: &str) -> Result<Self> {
        let body = code
            .strip_prefix(PAIRING_PREFIX)
            .ok_or_else(|| Error::Crypto("not a Balance pairing code".into()))?;
        let decoded = BASE32_NOPAD
            .decode(body.as_bytes())
            .map_err(|e| Error::Crypto(format!("bad pairing code: {e}")))?;
        if decoded.len() != 36 {
            return Err(Error::Crypto("pairing code wrong length".into()));
        }
        let (key_bytes, given_checksum) = decoded.split_at(32);
        let mut key = [0u8; 32];
        key.copy_from_slice(key_bytes);
        if checksum(&key) != given_checksum {
            return Err(Error::Crypto("pairing code checksum mismatch".into()));
        }
        Ok(SyncKey(key))
    }

    pub fn seal(&self, set: &ChangeSet) -> Result<Vec<u8>> {
        let plaintext = serde_json::to_vec(set).map_err(|e| Error::Codec(e.to_string()))?;
        let cipher = XChaCha20Poly1305::new(self.0.as_ref().into());
        let mut nonce_bytes = [0u8; 24];
        rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
        let nonce = XNonce::from_slice(&nonce_bytes);
        let ct = cipher
            .encrypt(nonce, plaintext.as_ref())
            .map_err(|e| Error::Crypto(e.to_string()))?;
        let mut out = Vec::with_capacity(24 + ct.len());
        out.extend_from_slice(&nonce_bytes);
        out.extend_from_slice(&ct);
        Ok(out)
    }

    pub fn open(&self, envelope: &[u8]) -> Result<ChangeSet> {
        if envelope.len() < 24 {
            return Err(Error::Crypto("envelope too short".into()));
        }
        let (nonce_bytes, ct) = envelope.split_at(24);
        let cipher = XChaCha20Poly1305::new(self.0.as_ref().into());
        let nonce = XNonce::from_slice(nonce_bytes);
        let pt = cipher
            .decrypt(nonce, ct)
            .map_err(|e| Error::Crypto(e.to_string()))?;
        serde_json::from_slice(&pt).map_err(|e| Error::Codec(e.to_string()))
    }
}

/// First 4 bytes of SHA-256(key) — a short integrity check for pairing codes.
fn checksum(key: &[u8; 32]) -> [u8; 4] {
    let digest = Sha256::digest(key);
    [digest[0], digest[1], digest[2], digest[3]]
}
