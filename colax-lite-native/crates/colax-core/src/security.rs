//! Second factors — recovery questions and the passcode, a port of
//! `lite version/src/crypto/security.ts` L193-317 (identical copy at
//! `E:\acc2\src\crypto\security.ts`).
//!
//! Both secrets are gated by PBKDF2-HMAC-SHA256 at 210k iterations under a
//! fresh 16-byte salt, base64url without padding — byte-identical to what the
//! web app writes, so a backup exported there still answers correctly here
//! (and vice versa).
//!
//! The two secrets diverge on purpose:
//!
//!   * An answer is normalised before hashing, so "New York" and "NEW  YORK"
//!     unlock the same question. Punctuation is deleted rather than replaced
//!     by a space ("new-york" hashes as "newyork") — that is what
//!     `normaliseAnswer` in TS actually does, whatever its doc comment says,
//!     and hashing anything else would break every stored recovery answer.
//!   * A passcode is hashed verbatim. It is typed exactly, so folding case or
//!     stripping punctuation would quietly accept a password the user never
//!     set.

use subtle::ConstantTimeEq;
use unicode_normalization::UnicodeNormalization;

use crate::bytes::{from_base64_url, random_bytes, to_base64_url};
use crate::crypto::pbkdf2_sha256;

/// Long enough that PBKDF2 is meaningful, cheap enough to run per
/// keystroke-ish — the comment TS puts on `QUESTION_ITERATIONS`, L194-195.
const QUESTION_ITERATIONS: u32 = 210_000;

const SALT_BYTES: usize = 16; // `randomBytes(16)` in TS — 128 bits of salt.

/// security.ts L220-232: answers that would make the question worthless.
const TRIVIAL_ANSWERS: &[&str] = &[
    "yes", "no", "none", "test", "password", "qwerty", "asdfgh", "unknown", "nothing", "same",
    "other",
];

/// security.ts L241: filler words dropped before re-checking the trivial set,
/// so "yes please" cannot smuggle "yes" past the check by padding it.
const ANSWER_FILLER: &[&str] = &["a", "an", "the", "my", "please", "thanks", "and"];

/// security.ts L300-311: the passcodes everyone tries first. Checked
/// case-insensitively, which is why "Password1" is refused too.
const TRIVIAL_PASSCODES: &[&str] = &[
    "password",
    "password1",
    "passw0rd",
    "12345678",
    "123456789",
    "qwertyui",
    "iloveyou",
    "letmein1",
    "welcome1",
    "administrator",
];

/// Normalises an answer before hashing (security.ts L203-211, ported in the
/// same order).
///
/// Case, accents, punctuation and spacing all go: "  New   York! " and
/// "NEW  YORK" become "new york". Punctuation is *deleted*, not turned into
/// a space — "new-york" becomes "newyork". The doc comment in TS claims
/// "New York" and "new-york" match, but the code says otherwise (verified
/// against Node), and the code is what a stored hash was built from: hashing
/// anything else here would fail every recovery answer exported by the web
/// app.
///
/// Accent stripping is NFKD plus a range filter rather than a lookup table —
/// the same decomposition `.normalize('NFKD')` performs.
///
/// Lowercasing happens *before* the `[a-z0-9\s]` filter: the filter keeps only
/// lowercase ASCII, so an uppercase letter folded after it would be dropped
/// instead of kept ("É" would lose its "e" as well as its accent).
///
/// JS `\s` and Rust's `is_whitespace` differ only for U+FEFF (a BOM, which JS
/// counts as whitespace) and U+0085 (which Rust does). Both are untypeable in
/// an answer; U+FEFF is folded into the whitespace class below so even that
/// case collapses identically.
pub fn normalise_answer(answer: &str) -> String {
    let decomposed: String = answer
        .nfkd()
        .filter(|c| !('\u{0300}'..='\u{036F}').contains(c))
        .collect();
    let folded: String = decomposed
        .to_lowercase()
        .chars()
        .filter(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || c.is_whitespace() || *c == '\u{FEFF}'
        })
        .map(|c| if c == '\u{FEFF}' { ' ' } else { c })
        .collect();
    // `\s+` -> ' ' then trim (L209-210): splitting on whitespace and joining
    // with single spaces does both at once.
    folded.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// True when `value` is one character repeated `min_len` times or more —
/// JS `^(.)\1{n,}$` (4+ for answers, 2+ for passcodes). A run like "aaaa"
/// carries almost no entropy either way.
fn repeated_char_run(value: &str, min_len: usize) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else { return false };
    value.chars().count() >= min_len && chars.all(|c| c == first)
}

/// Rejects answers that would make the question worthless (security.ts L214-246).
pub fn answer_too_weak(answer: &str) -> bool {
    let normalised = normalise_answer(answer);
    // Three characters is short but legitimate — plenty of pet names and
    // surnames are that long. The trivial-word list is what catches the
    // guesses that actually matter, so length only has to rule out single
    // characters (L216-219).
    if normalised.chars().count() < 3 {
        return true;
    }
    if TRIVIAL_ANSWERS.contains(&normalised.as_str()) {
        return true;
    }
    if repeated_char_run(&normalised, 4) {
        return true;
    }
    // A trivial word followed by filler is still a trivial word: "yes
    // please", "no thanks" (L236-244). Checked against the trivial set after
    // dropping filler words, so a user cannot smuggle one past by padding it.
    let meaningful: Vec<&str> = normalised
        .split(' ')
        .filter(|word| !ANSWER_FILLER.contains(word))
        .collect();
    if meaningful.len() == 1 && TRIVIAL_ANSWERS.contains(&meaningful[0]) {
        return true;
    }
    if !meaningful.is_empty() && meaningful.iter().all(|w| TRIVIAL_ANSWERS.contains(w)) {
        return true;
    }
    false
}

/// PBKDF2-HMAC-SHA256 over the UTF-8 bytes of `secret`, base64url without
/// padding — byte-identical to `answerHash` in security.ts L248-258.
fn derive_hash(secret: &str, salt: &[u8]) -> String {
    let derived = pbkdf2_sha256(secret.as_bytes(), salt, QUESTION_ITERATIONS);
    to_base64_url(&derived[..])
}

/// A fresh salt plus the hash under it, as TS's `hashAnswer`/`hashPasscode`
/// write them: `(hash, salt)`, both unpadded base64url.
fn hash_with_fresh_salt(secret: &str) -> (String, String) {
    let salt = random_bytes(SALT_BYTES);
    let hash = derive_hash(secret, &salt);
    (hash, to_base64_url(&salt))
}

/// Shared tail of `verify_answer`/`verify_passcode`: re-derive under the
/// stored salt and compare base64url strings the way TS compares them
/// (`bytesEqual` over the encoded forms, security.ts L272/L293).
fn verify_stored(secret: &str, hash: &str, salt: &str) -> bool {
    // An undecodable salt decodes to an empty one in TS (`base64UrlToBytes`
    // swallows atob's throw), and an empty salt never verifies (L269-270).
    let Ok(salt) = from_base64_url(salt) else {
        return false;
    };
    if salt.is_empty() {
        return false;
    }
    let computed = derive_hash(secret, &salt);
    // Constant-time: no early exit on a matching prefix. Length still leaks —
    // as it did in TS — but the hash itself never does.
    computed.as_bytes().ct_eq(hash.as_bytes()).into()
}

/// Hashes an answer. The plaintext is not retained anywhere (security.ts L261-265).
pub fn hash_answer(answer: &str) -> (String, String) {
    hash_with_fresh_salt(&normalise_answer(answer))
}

/// Checks an answer against a stored question (security.ts L268-273).
pub fn verify_answer(answer: &str, hash: &str, salt: &str) -> bool {
    verify_stored(&normalise_answer(answer), hash, salt)
}

/// Hashes a passcode. The plaintext is never retained (security.ts L283-286).
/// Unlike an answer it is NOT case-folded or stripped of punctuation.
pub fn hash_passcode(code: &str) -> (String, String) {
    hash_with_fresh_salt(code)
}

/// Checks a typed passcode against the stored hash (security.ts L289-294).
pub fn verify_passcode(code: &str, hash: &str, salt: &str) -> bool {
    verify_stored(code, hash, salt)
}

/// Refuses a passcode too short or too trivial to be worth setting.
///
/// The base rules are `passcodeTooWeak` in security.ts L297-317; the
/// `totp_set` branch folds in the gate's own check from SecurityForm.tsx
/// L155-160: with an authenticator already set, an 8-character passcode would
/// be the weakest factor protecting the login, so it needs 12.
pub fn passcode_too_weak(code: &str, totp_set: bool) -> bool {
    // TS measures UTF-16 code units (L298); char count matches it for every
    // BMP character, which covers everything a passcode can realistically be.
    let length = code.chars().count();
    if length < 8 {
        return true;
    }
    if totp_set && length < 12 {
        return true;
    }
    let lower = code.to_lowercase();
    if TRIVIAL_PASSCODES.contains(&lower.as_str()) {
        return true;
    }
    // A single repeated character, or one class only ("aaaaaaaa", "12345678").
    if repeated_char_run(code, 2) {
        return true;
    }
    let classes = [
        code.chars().any(|c| c.is_ascii_lowercase()),
        code.chars().any(|c| c.is_ascii_uppercase()),
        code.chars().any(|c| c.is_ascii_digit()),
        // `[^A-Za-z0-9]` — symbols and non-ASCII alike, as in TS (L315).
        code.chars().any(|c| !c.is_ascii_alphanumeric()),
    ];
    classes.iter().filter(|present| **present).count() < 2
}
