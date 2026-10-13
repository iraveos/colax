//! Binary <-> text helpers. Base64url everywhere so values are URL- and
//! filename-safe, matching `lite version/src/crypto/bytes.ts`.

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use rand::rngs::OsRng;
use rand::RngCore;

use crate::error::VaultError;

/// Unpadded base64url, the encoding every binary value uses on disk.
pub fn to_base64_url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Decodes base64 of either alphabet, padded or not.
///
/// Mirrors `fromBase64Url`: dashes/underscores become plus/slash, the string
/// is re-padded to a multiple of four, then decoded. Accepting both alphabets
/// is deliberate — the TS helper never rejected standard base64 input either.
pub fn from_base64_url(value: &str) -> Result<Vec<u8>, VaultError> {
    let normalized = value.replace('-', "+").replace('_', "/");
    let mut padded = normalized;
    while !padded.len().is_multiple_of(4) {
        padded.push('=');
    }
    STANDARD
        .decode(padded)
        .map_err(|_| VaultError::Corrupt("A base64 value in the vault is not valid.".into()))
}

/// Cryptographically random bytes (OsRng, like `crypto.getRandomValues`).
pub fn random_bytes(length: usize) -> Vec<u8> {
    let mut bytes = vec![0u8; length];
    OsRng.fill_bytes(&mut bytes);
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64url_round_trips_arbitrary_bytes() {
        for length in 0..40 {
            let bytes = random_bytes(length);
            let encoded = to_base64_url(&bytes);
            assert!(!encoded.contains('+') && !encoded.contains('/') && !encoded.contains('='));
            assert_eq!(from_base64_url(&encoded).unwrap(), bytes, "length {length}");
        }
    }

    #[test]
    fn decoding_accepts_both_base64_alphabets() {
        // 0xfb 0xff 0xbf -> "+/+/" in the standard alphabet, "-_-_" in URL-safe.
        let expected = vec![0xfb, 0xff, 0xbf];
        assert_eq!(from_base64_url("+/+/").unwrap(), expected);
        assert_eq!(from_base64_url("-_-_").unwrap(), expected);
        // Already a multiple of four, so no re-padding happens.
        assert_eq!(from_base64_url("YQ==").unwrap(), b"a");
        // Over-padded input is rejected — atob("YW55==") threw in TS too,
        // because fromBase64Url pads by length, not by stripping.
        assert!(from_base64_url("YW55==").is_err());
    }

    #[test]
    fn garbage_is_rejected() {
        assert!(from_base64_url("!!!!").is_err());
    }
}
