use data_encoding::BASE32_NOPAD;
use hkdf::Hkdf;
use rand::{rngs::OsRng, RngCore};
use sha2::Sha256;
use zeroize::{Zeroize, Zeroizing};

pub const RAW_KEY_FORMAT: &str = "raw-hkdf-sha256-v1";
const RAW_KEY_CONTEXT: &[u8] = b"app.balance.local/sqlcipher/raw-key/v1";
const CURRENT_RECOVERY_KEY_BYTES: usize = 32;

/// Secret recovery material accepted by Balance.
///
/// Raw SQLCipher keys are safe only because this parser accepts CSPRNG output
/// of an exact supported length; never relax it to accept passwords or
/// arbitrary text.
pub struct RecoveryKey {
    canonical: Zeroizing<String>,
    bytes: Zeroizing<Vec<u8>>,
}

impl RecoveryKey {
    pub fn parse(input: &str) -> Result<Self, String> {
        let compact = input
            .chars()
            .filter(|character| !character.is_whitespace() && *character != '-')
            .collect::<String>()
            .to_ascii_uppercase();
        let bytes = BASE32_NOPAD
            .decode(compact.as_bytes())
            .map_err(|_| "Recovery key is not valid Base32.".to_string())?;
        if bytes.len() != CURRENT_RECOVERY_KEY_BYTES {
            return Err("Recovery key must contain exactly 256 random bits.".to_string());
        }
        let canonical = compact
            .as_bytes()
            .chunks(4)
            .map(|chunk| std::str::from_utf8(chunk).expect("Base32 is ASCII"))
            .collect::<Vec<_>>()
            .join("-");
        Ok(Self {
            canonical: Zeroizing::new(canonical),
            bytes: Zeroizing::new(bytes),
        })
    }

    pub fn generate() -> Self {
        let mut bytes = [0_u8; CURRENT_RECOVERY_KEY_BYTES];
        OsRng.fill_bytes(&mut bytes);
        let encoded = BASE32_NOPAD.encode(&bytes);
        let canonical = encoded
            .as_bytes()
            .chunks(4)
            .map(|chunk| std::str::from_utf8(chunk).expect("Base32 is ASCII"))
            .collect::<Vec<_>>()
            .join("-");
        let result = Self {
            canonical: Zeroizing::new(canonical),
            bytes: Zeroizing::new(bytes.to_vec()),
        };
        bytes.zeroize();
        result
    }

    pub fn canonical(&self) -> &str {
        self.canonical.as_str()
    }

    /// Return SQLCipher's exact 32-byte raw-key literal.
    ///
    /// RAW_KEY_CONTEXT is permanent on-disk format data. Editing it would make
    /// every raw-v1 database unreadable; introduce a new format variant instead.
    pub fn raw_sqlcipher_key(&self) -> Result<Zeroizing<String>, String> {
        let hkdf = Hkdf::<Sha256>::new(None, self.bytes.as_slice());
        let mut output = [0_u8; 32];
        hkdf.expand(RAW_KEY_CONTEXT, &mut output)
            .map_err(|_| "Could not derive the database key.".to_string())?;
        let mut hex = String::with_capacity(67);
        hex.push_str("x'");
        for byte in output {
            use std::fmt::Write;
            write!(&mut hex, "{byte:02x}").expect("writing to a string cannot fail");
        }
        hex.push('\'');
        output.zeroize();
        Ok(Zeroizing::new(hex))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_key_is_256_bits_and_grouped() {
        let key = RecoveryKey::generate();
        assert_eq!(key.bytes.len(), 32);
        assert_eq!(key.canonical().split('-').count(), 13);
        assert!(key.canonical().split('-').all(|group| group.len() == 4));
    }

    #[test]
    fn parser_normalizes_current_keys_and_rejects_other_lengths() {
        let generated = RecoveryKey::generate();
        let normalized = RecoveryKey::parse(&generated.canonical().to_ascii_lowercase()).unwrap();
        assert_eq!(normalized.canonical(), generated.canonical());
        assert!(RecoveryKey::parse("correct horse battery staple").is_err());
        assert!(RecoveryKey::parse(&BASE32_NOPAD.encode(&[7_u8; 20])).is_err());
    }

    #[test]
    fn raw_derivation_is_stable_and_domain_separated() {
        let input = BASE32_NOPAD.encode(&[0_u8; 32]);
        let key = RecoveryKey::parse(&input).unwrap();
        assert_eq!(
            key.raw_sqlcipher_key().unwrap().as_str(),
            "x'b2a44020ad6b238ba4b307fff3cc7f43835e2972070ace5f22be6da7e237f70e'"
        );
    }
}
