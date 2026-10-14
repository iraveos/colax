//! RFC 6238 TOTP: live authenticator codes from an item's base32 seed.
//!
//! Port of `E:\acc2\src\crypto\totp.ts` (HMAC-SHA1, 30-second step, 6 digits)
//! plus the seed plumbing around it from `E:\acc2\src\crypto\security.ts`
//! (`extractTotpSeed`, `generateTotpSeed`) and the `otpauth://` URL shape the
//! authenticator screen shows (`E:\acc2\src\ui\SecurityForm.tsx:21`).
//!
//! SHA-1 is not a weakness *here*: it is what every authenticator app in
//! existence implements, so anything else would produce codes nothing can
//! verify. The seed is what actually protects the account; this only proves
//! possession of it.
//!
//! The QR matrix helper lives here too because the Slint screen paints QR
//! modules as plain rectangles — the crate needs the matrix, never an image.

use data_encoding::BASE32_NOPAD;
use hmac::{Hmac, Mac};
use sha1::Sha1;

use crate::bytes::random_bytes;
use crate::util::now_ms;

/// The step every authenticator app hard-codes: part of RFC 6238's
/// interoperability contract, not a tunable option.
const PERIOD_SECONDS: u64 = 30;

/// Six digits, for the same interoperability reason as the step.
const DIGITS: usize = 6;

/// A generated seed is 160 bits, the size RFC 6238 recommends.
const SEED_BYTES: usize = 20;

type HmacSha1 = Hmac<Sha1>;

/// Error texts kept verbatim from the TS originals, because the UI shows them.
const INVALID_CHARS: &str = "That authenticator key has invalid characters.";
const INVALID_SEED: &str = "That is not a valid authenticator seed.";

/// Decodes unpadded base32 the way the TS parsers do: case, whitespace,
/// dashes and `=` padding are all tolerated (dropped), `A-Z2-7` remains.
fn base32_decode(value: &str) -> Result<Vec<u8>, String> {
    if value.trim().is_empty() {
        // "Nothing pasted" and "rubbish pasted" are different mistakes; the
        // UI should not blame the key's characters for an empty field.
        return Err(INVALID_SEED.into());
    }
    let cleaned: String = value
        .chars()
        .map(|c| c.to_ascii_uppercase())
        .filter(|c| c.is_ascii_alphabetic() || ('2'..='7').contains(&c))
        .collect();
    if cleaned.is_empty() {
        return Err(INVALID_CHARS.into());
    }
    // Lengths base32 cannot express (1, 3 or 6 leftover symbols in a block)
    // fail here instead of decoding to a truncated key. TS silently drops the
    // leftover bits instead; only a typo can produce such lengths, and
    // rejecting a mangled key beats trusting half of it.
    BASE32_NOPAD
        .decode(cleaned.as_bytes())
        .map_err(|_| INVALID_CHARS.to_string())
}

/// Unpadded uppercase base32 — the encoding authenticator apps read, and the
/// one `toBase32` produces in TS.
fn base32_encode(bytes: &[u8]) -> String {
    BASE32_NOPAD.encode(bytes)
}

/// The 6-digit code for `at_unix`, or the reason the seed cannot produce one.
///
/// Port of `totpCode` (`totp.ts` L46-62): HMAC-SHA1 keyed by the decoded seed
/// over the big-endian step counter, then RFC 4226's dynamic truncation.
pub fn totp_code(seed_base32: &str, at_unix: u64) -> Result<String, String> {
    let key = base32_decode(seed_base32)?;
    let counter = at_unix / PERIOD_SECONDS;
    let mut mac = HmacSha1::new_from_slice(&key).map_err(|_| INVALID_CHARS.to_string())?;
    mac.update(&counter.to_be_bytes());
    let digest = mac.finalize().into_bytes();

    // RFC 4226 §5.3: the offset hides in the low nibble of the last byte, and
    // masking the window to 31 bits keeps it positive before the modulo.
    let offset = (digest[digest.len() - 1] & 0x0f) as usize;
    let binary = (u32::from(digest[offset] & 0x7f) << 24)
        | (u32::from(digest[offset + 1]) << 16)
        | (u32::from(digest[offset + 2]) << 8)
        | u32::from(digest[offset + 3]);
    // Modulo first, then zero-pad: `005924`, never `5924`.
    Ok(format!("{:0width$}", binary % 1_000_000, width = DIGITS))
}

/// Seconds until the current step rolls over: `30 - (t % 30)`.
///
/// A step boundary reports 30 rather than 0 — `totpSecondsRemaining` does the
/// same in TS, so the countdown restarts without a frame that reads "0".
pub fn totp_seconds_remaining(at_unix: u64) -> u64 {
    PERIOD_SECONDS - (at_unix % PERIOD_SECONDS)
}

/// The code for right now (`currentTotpCode` in `security.ts`).
pub fn current_totp_code(seed_base32: &str) -> Result<String, String> {
    totp_code(seed_base32, (now_ms() / 1000) as u64)
}

/// Checks a code the user typed against the current step and one either side,
/// covering clock drift between the phone and this machine without
/// meaningfully widening the attack surface (`verifyTotp`, `security.ts`
/// L175-190).
///
/// A bad seed fails outright: no window can ever match it, so there is nothing
/// left to check.
pub fn verify_totp(seed_base32: &str, code: &str) -> bool {
    // Strip formatting first — "123 456" and "12-34-56" are ways a real user
    // types a code, and TS strips non-digits the same way.
    let typed: String = code.chars().filter(|c| c.is_ascii_digit()).collect();
    if typed.len() != DIGITS {
        return false;
    }
    let step = (now_ms() / 1000) as u64 / PERIOD_SECONDS;
    let mut accepted = false;
    for delta in [-1i64, 0, 1] {
        // Step 0 has no previous window; wrapping would check the year 584
        // billion instead of skipping.
        let window = step as i64 + delta;
        if window < 0 {
            continue;
        }
        let expected = match totp_code(seed_base32, window as u64 * PERIOD_SECONDS) {
            Ok(code) => code,
            Err(_) => return false,
        };
        // Fold every window's result rather than returning on the first match
        // (the TS comment's "constant-time-ish": no early exit on a matching
        // prefix, and none here either).
        accepted |= constant_time_eq(&expected, &typed);
    }
    accepted
}

/// XOR-fold equality: every byte is compared even after a difference shows, so
/// timing does not leak how much of the code was right.
fn constant_time_eq(expected: &str, typed: &str) -> bool {
    if expected.len() != typed.len() {
        return false;
    }
    expected
        .bytes()
        .zip(typed.bytes())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

/// Accepts a bare seed or a full `otpauth://` URI and returns the canonical
/// seed, or `None` for anything that could never be one. Port of
/// `extractTotpSeed` (`security.ts` L110-139).
pub fn extract_totp_secret(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }
    if !trimmed.to_ascii_lowercase().starts_with("otpauth://") {
        return bare_seed(trimmed);
    }
    // `new URL` puts everything after `#` in the fragment, outside the query;
    // split first so a trailing hash is never mistaken for the secret.
    let without_fragment = trimmed.split('#').next().unwrap_or(trimmed);
    let query = without_fragment.split_once('?')?.1;
    let secret = query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        (key == "secret").then(|| decode_query_component(value))
    })?;
    bare_seed(&secret)
}

/// Validates a pasted bare seed.
///
/// `base32_decode` drops anything outside the alphabet, so "not a seed!" would
/// otherwise decode to "NOTASEED"-shaped bytes and be accepted as if the user
/// had pasted a real key — a silent failure that would leave the login
/// believing it had a second factor it could never use. So the input is
/// checked against the alphabet *first*, and must decode to enough bytes to be
/// a plausible seed, exactly as `extractBareSeed` does in TS.
fn bare_seed(value: &str) -> Option<String> {
    let compact: String = value
        .chars()
        .filter(|c| !c.is_whitespace())
        .map(|c| c.to_ascii_uppercase())
        .collect();
    if compact.is_empty()
        || !compact
            .chars()
            .all(|c| c.is_ascii_alphabetic() || ('2'..='7').contains(&c))
    {
        return None;
    }
    // A real 160-bit seed decodes to 20 bytes; refuse anything far below 80.
    let bytes = base32_decode(&compact).ok()?;
    if bytes.len() < 10 {
        return None;
    }
    // Re-encode so the stored form is canonical whatever the user pasted.
    Some(base32_encode(&bytes))
}

/// `URLSearchParams` semantics: `%XX` bytes decoded, `+` meaning space.
fn decode_query_component(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let hi = (bytes[i + 1] as char).to_digit(16);
                let lo = (bytes[i + 2] as char).to_digit(16);
                match (hi, lo) {
                    (Some(hi), Some(lo)) => {
                        out.push((hi * 16 + lo) as u8);
                        i += 3;
                    }
                    // Not a valid escape: keep the '%' and move on, as a URL
                    // parser would. Byte-wise, so no char-boundary panics.
                    _ => {
                        out.push(b'%');
                        i += 1;
                    }
                }
            }
            other => {
                out.push(other);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The `otpauth://` URI an authenticator app scans, matching `otpauthUrl` in
/// `E:\acc2\src\ui\SecurityForm.tsx:21` byte for byte:
/// `otpauth://totp/Colax:<encoded label>?secret=<seed>&issuer=Colax`.
pub fn otpauth_url(label: &str, seed_base32: &str) -> String {
    // TS: `encodeURIComponent(label || 'vault')` — only a truly empty label
    // falls back; a whitespace label is encoded, not replaced.
    let label = if label.is_empty() { "vault" } else { label };
    format!(
        "otpauth://totp/Colax:{}?secret={}&issuer=Colax",
        encode_component(label),
        seed_base32
    )
}

/// `encodeURIComponent`'s alphabet: everything but `A-Za-z0-9-_.!~*'()` is
/// percent-encoded, UTF-8 bytes and all.
fn encode_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*'
            | b'\'' | b'(' | b')' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// A fresh 160-bit seed as unpadded base32 — `generateTotpSeed` in TS.
pub fn generate_totp_seed() -> String {
    // `random_bytes` is OsRng, the same source as `crypto.getRandomValues`.
    base32_encode(&random_bytes(SEED_BYTES))
}

/// The QR matrix for `data`: (module count per side, row-major dark/light
/// flags), `true` meaning dark.
///
/// Level M — the `qrcode` crate's default, and what the TS QR lib used — with
/// no quiet zone, because the Slint screen paints its own margin around the
/// modules as rectangles. `None` means no symbol can hold the data (or there
/// is none), so the UI can fall back to showing the raw `otpauth://` text.
pub fn qr_matrix(data: &str) -> Option<(usize, Vec<bool>)> {
    if data.is_empty() {
        return None;
    }
    let code = qrcode::QrCode::new(data).ok()?;
    let side = code.width();
    let mut modules = Vec::with_capacity(side * side);
    // Indexing is (x, y) — column first — so walk rows to hand back row-major.
    for y in 0..side {
        for x in 0..side {
            modules.push(code[(x, y)] == qrcode::Color::Dark);
        }
    }
    Some((side, modules))
}
