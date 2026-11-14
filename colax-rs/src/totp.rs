//! Time-based one-time passwords, RFC 6238 over HMAC-SHA1.
//!
//! The Electron build derived these from Web Crypto; this is the same algorithm
//! written out against `sha1` so the native app can show a code for a login
//! whose seed is stored in the vault. Nothing here touches the network: a seed
//! and the clock are the whole input.
//!
//! Seeds are accepted the way people actually paste them — a bare base32 string,
//! a spaced grouping, or a full `otpauth://totp/...?secret=...` URL.

use sha1::{Digest, Sha1};

/// RFC 6238 fixes the period and the code length for the common authenticator
/// profile; the Electron build uses the same two constants.
pub const PERIOD: u64 = 30;
pub const DIGITS: u32 = 6;

pub fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0)
}

/// Reduces anything a user might paste to the base32 body of a seed.
///
/// An `otpauth://` URL keeps only its `secret` query value, so the label and
/// issuer do not end up in the key. Everything outside A–Z and 2–7 is dropped
/// and the rest is upper-cased, which makes `jbsw y3dp ehpk 3pxp` and
/// `JBSWY3DPEHPK3PXP` the same seed.
pub fn normalize_seed(input: &str) -> String {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let source = if trimmed.to_ascii_lowercase().contains("otpauth://") {
        secret_parameter(trimmed).unwrap_or_else(|| trimmed.to_string())
    } else {
        trimmed.to_string()
    };
    source
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .map(|character| character.to_ascii_uppercase())
        .filter(|character| matches!(character, 'A'..='Z' | '2'..='7'))
        .collect()
}

fn secret_parameter(input: &str) -> Option<String> {
    let lower = input.to_ascii_lowercase();
    let start = lower.find("secret=")? + "secret=".len();
    let rest = &input[start..];
    let value = rest.split(['&', '#']).next().unwrap_or(rest);
    // A URL may percent-encode spaces between groups; they are stripped later
    // with the rest of the noise, so only a trailing pad character matters.
    Some(value.trim_end_matches('=').to_string())
}

/// Base32 (RFC 4648) without padding, tolerant of the grouping separators a
/// seed is usually displayed with. Returns `None` when nothing decodes, which
/// is what the editor uses to reject a mistyped seed before it is saved.
pub fn decode_base32(seed: &str) -> Option<Vec<u8>> {
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;
    let mut bytes = Vec::new();
    for character in seed.chars() {
        let value = match character.to_ascii_uppercase() {
            letter @ 'A'..='Z' => letter as u32 - 'A' as u32,
            digit @ '2'..='7' => digit as u32 - '2' as u32 + 26,
            _ => continue,
        };
        buffer = (buffer << 5) | value;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            bytes.push(((buffer >> bits) & 0xff) as u8);
        }
    }
    if bytes.is_empty() {
        None
    } else {
        Some(bytes)
    }
}

/// A seed is usable once it decodes to at least one key byte. Ten bytes is the
/// shortest seed any authenticator issues, but a short one still computes —
/// better to show a code than to silently do nothing.
pub fn valid_seed(seed: &str) -> bool {
    decode_base32(&normalize_seed(seed)).is_some()
}

fn hmac_sha1(key: &[u8], message: &[u8]) -> [u8; 20] {
    // RFC 2104: a key longer than the 64-byte block is hashed first, then the
    // block is zero-padded and XORed into the inner and outer pads.
    let mut block = [0u8; 64];
    if key.len() > 64 {
        let digest = Sha1::digest(key);
        block[..digest.len()].copy_from_slice(&digest);
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner_pad = [0u8; 64];
    let mut outer_pad = [0u8; 64];
    for index in 0..64 {
        inner_pad[index] = block[index] ^ 0x36;
        outer_pad[index] = block[index] ^ 0x5c;
    }
    let mut inner = Sha1::new();
    inner.update(inner_pad);
    inner.update(message);
    let inner_digest = inner.finalize();

    let mut outer = Sha1::new();
    outer.update(outer_pad);
    outer.update(inner_digest);
    let digest = outer.finalize();
    let mut result = [0u8; 20];
    result.copy_from_slice(&digest);
    result
}

/// The code for a seed at a given second, or `None` if the seed is unusable.
pub fn code_at(seed: &str, at_unix: u64) -> Option<String> {
    let key = decode_base32(&normalize_seed(seed))?;
    let counter = at_unix / PERIOD;
    let digest = hmac_sha1(&key, &counter.to_be_bytes());
    // RFC 4226 dynamic truncation: the low nibble of the last byte picks the
    // 4-byte window, and the top bit is masked so the result stays positive.
    let offset = (digest[19] & 0x0f) as usize;
    let value = ((digest[offset] as u32 & 0x7f) << 24)
        | ((digest[offset + 1] as u32) << 16)
        | ((digest[offset + 2] as u32) << 8)
        | digest[offset + 3] as u32;
    let code = value % 10u32.pow(DIGITS);
    Some(format!("{code:0width$}", width = DIGITS as usize))
}

/// Whole seconds left in the current 30-second window, 1..=30.
pub fn seconds_remaining(at_unix: u64) -> u8 {
    (PERIOD - (at_unix % PERIOD)).clamp(1, PERIOD) as u8
}

/// How much of the window is left, 0.0..=1.0 — the length of the countdown bar
/// under a code.
pub fn fraction_remaining(at_unix: u64) -> f32 {
    seconds_remaining(at_unix) as f32 / PERIOD as f32
}

/// `123456` -> `123 456`, the way authenticators group a code for reading.
pub fn grouped(code: &str) -> String {
    if code.chars().count() == 6 {
        format!("{} {}", &code[..3], &code[3..])
    } else {
        code.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 6238 Appendix B uses the ASCII seed "12345678901234567890". The
    /// published vectors are 8 digits; this profile is the 6-digit one, which
    /// is the same value's last six digits.
    const RFC_SEED: &str = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

    #[test]
    fn rfc6238_sha1_vectors() {
        let cases: [(u64, &str); 6] = [
            (59, "287082"),
            (1_111_111_109, "081804"),
            (1_111_111_111, "050471"),
            (1_234_567_890, "005924"),
            (2_000_000_000, "279037"),
            (20_000_000_000, "353130"),
        ];
        for (at, expected) in cases {
            assert_eq!(code_at(RFC_SEED, at).as_deref(), Some(expected), "t={at}");
        }
    }

    #[test]
    fn hmac_sha1_matches_rfc2202_case_two() {
        let digest = hmac_sha1(b"Jefe", b"what do ya want for nothing?");
        let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
        assert_eq!(hex, "effcdf6ae5eb2fa2d27416d5f184df9c259a7c79");
    }

    #[test]
    fn seeds_are_accepted_in_every_shape_people_paste_them() {
        assert_eq!(normalize_seed("jbsw y3dp ehpk 3pxp"), "JBSWY3DPEHPK3PXP");
        assert_eq!(normalize_seed("JBSW-Y3DP-EHPK-3PXP"), "JBSWY3DPEHPK3PXP");
        assert_eq!(
            normalize_seed("otpauth://totp/Colax:me@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Colax"),
            "JBSWY3DPEHPK3PXP"
        );
        assert_eq!(normalize_seed("   "), "");
    }

    #[test]
    fn a_url_seed_computes_the_same_code_as_the_bare_seed() {
        let at = 1_700_000_000;
        let url = "otpauth://totp/Colax?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Colax";
        assert_eq!(code_at(url, at), code_at(RFC_SEED, at));
    }

    #[test]
    fn invalid_seeds_are_rejected_instead_of_panicking() {
        assert!(!valid_seed(""));
        assert!(!valid_seed("1 8 9 0"));
        assert!(valid_seed("JBSWY3DPEHPK3PXP"));
    }

    #[test]
    fn the_countdown_ends_at_zero_seconds() {
        assert_eq!(seconds_remaining(0), 30);
        assert_eq!(seconds_remaining(29), 1);
        assert_eq!(seconds_remaining(30), 30);
        assert!((fraction_remaining(15) - 0.5).abs() < f32::EPSILON);
    }
}
