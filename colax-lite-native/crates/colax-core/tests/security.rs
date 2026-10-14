//! Second factors: recovery answers and passcodes. Ported from
//! `test/security.test.ts` and `test/security-passcode.test.ts`
//! (Task 1.3 of docs/plans/2026-10-13-colax-lite-native-full-ui.md).
//!
//! The fixed vectors pin byte-compatibility with the web app: they were
//! generated with Node's WebCrypto — the exact construction `answerHash` in
//! `lite version/src/crypto/security.ts` runs — and cross-checked against
//! Python's `hashlib.pbkdf2_hmac`. Both agreed to the byte. A backup exported
//! from the web app must still answer here, so a divergence in PBKDF2
//! parameters or base64url encoding fails these tests rather than a user's
//! restore.

use colax_core::security::{
    answer_too_weak, hash_answer, hash_passcode, normalise_answer, passcode_too_weak,
    verify_answer, verify_passcode,
};

/// 16 salt bytes `00112233445566778899aabbccddeeff`, unpadded base64url.
const KAT_SALT: &str = "ABEiM0RVZneImaq7zN3u_w";
/// PBKDF2-HMAC-SHA256("new york", KAT_SALT, 210_000) -> 256 bits, base64url.
const KAT_ANSWER_HASH: &str = "EC9uFc-W_8fhEG6aKixMUiSed7Pd_bC8LrE4Pbezuuw";
/// The same derivation over the passcode "PassWord123", hashed verbatim.
const KAT_PASSCODE_HASH: &str = "L9G3WTVbADWYZ6DNjzJDfzVvUzeawU2GbFzlA5OBbUY";
/// PBKDF2 over "rex" — what "Rex" normalises to — under the same salt. Pins
/// that the answer path normalises *before* hashing, and (being a constant)
/// lets the plaintext-leak check below run without flaking on random bytes.
const KAT_REX_HASH: &str = "zNEW41D5oxkZPFNpWOdR_vULV1TMc_55dxUDfJwLYJI";
/// PBKDF2 over "newyork" — what "new-york" normalises to, punctuation being
/// deleted rather than spaced, exactly as the TS code does.
const KAT_NEWYORK_HASH: &str = "zHFSk-xDdgVtPnYPEVx9s0SDXTD9TcMvfswQZtBo47E";

/* ---- Normalisation ------------------------------------------------------- */

#[test]
fn answers_are_normalised_before_hashing() {
    // test/security.test.ts "answers are normalised before hashing".
    assert_eq!(normalise_answer("  New   York! "), "new york");
    assert_eq!(normalise_answer("Café"), "cafe");
    assert_eq!(normalise_answer("a-b_c"), "abc");
    // Case and spacing collapse to one string...
    assert_eq!(normalise_answer("New York"), "new york");
    assert_eq!(normalise_answer("NEW  YORK"), "new york");
    assert_eq!(normalise_answer("café"), "cafe");
    // ...but punctuation is DELETED, not spaced: "new-york" becomes
    // "newyork". Verified byte-for-byte against Node, which runs the TS
    // `normaliseAnswer` itself — the TS doc comment claims "New York" and
    // "new-york" match, the code does not, and stored hashes follow the code.
    assert_eq!(normalise_answer("new-york"), "newyork");
    assert_ne!(normalise_answer("new-york"), normalise_answer("New York"));
}

/* ---- Strength ------------------------------------------------------------ */

#[test]
fn guessable_answers_are_refused() {
    for weak in [
        "", "a", "yes", "no", "test", "password", "qwerty", "unknown", "aaaa", "yes please",
        // Filler after a trivial word must not smuggle it past (L236-244).
        "no thanks",
    ] {
        assert!(answer_too_weak(weak), "should refuse: {weak:?}");
    }
}

#[test]
fn real_answers_are_accepted() {
    for ok in ["Rex", "Blue Moon 1987", "blue ridge", "pet name"] {
        assert!(!answer_too_weak(ok), "should accept: {ok:?}");
    }
}

/* ---- Fixed vector: byte-compatibility with the web app -------------------- */

#[test]
fn answer_hashes_match_the_ts_webcrypto_vector() {
    // Every spelling that normalises to "new york" derives the same bytes
    // under the fixed salt.
    for variant in ["New York", "  NEW  YORK  ", "new   york!", "NeW yOrK"] {
        assert!(
            verify_answer(variant, KAT_ANSWER_HASH, KAT_SALT),
            "{variant:?} should verify against the TS vector"
        );
    }
    // Punctuation is deleted before hashing, not turned into a space — and
    // that is what Node running the TS `normaliseAnswer` does too. So
    // "new-york" answers the "newyork" vector and never the "new york" one:
    // matching the TS *code* is what keeps stored recovery answers verifiable.
    assert!(verify_answer("new-york", KAT_NEWYORK_HASH, KAT_SALT));
    assert!(!verify_answer("new-york", KAT_ANSWER_HASH, KAT_SALT));
    // The answer is normalised before hashing: "Rex" must answer the "rex"
    // vector, never the "new york" one.
    assert!(verify_answer("Rex", KAT_REX_HASH, KAT_SALT));
    assert!(!verify_answer("Rex", KAT_ANSWER_HASH, KAT_SALT));
    // A different answer under the same salt derives different bytes.
    assert!(!verify_answer("Fido", KAT_ANSWER_HASH, KAT_SALT));
}

#[test]
fn a_tampered_hash_or_answer_never_verifies() {
    // Flip one character of the stored hash.
    let mut tampered = KAT_ANSWER_HASH.to_string();
    let first = tampered.chars().next().unwrap();
    tampered.replace_range(0..first.len_utf8(), if first == 'A' { "B" } else { "A" });
    assert!(!verify_answer("New York", &tampered, KAT_SALT));
    assert!(!verify_answer("New York", "", KAT_SALT));
}

#[test]
fn an_empty_or_undecodable_salt_never_verifies() {
    // TS turns a bad base64 salt into an empty array and refuses it
    // (security.ts L269-270); the same must hold here for answers and passcodes.
    assert!(!verify_answer("New York", KAT_ANSWER_HASH, ""));
    assert!(!verify_answer("New York", KAT_ANSWER_HASH, "!!!!"));
    assert!(!verify_passcode("PassWord123", KAT_PASSCODE_HASH, ""));
    assert!(!verify_passcode("PassWord123", KAT_PASSCODE_HASH, "!!!!"));
}

#[test]
fn passcode_hashes_match_the_ts_webcrypto_vector() {
    // Passcodes are byte-verbatim: no normalisation, or "PassWord123" would
    // collapse toward its lowercased form and answer here.
    assert!(verify_passcode("PassWord123", KAT_PASSCODE_HASH, KAT_SALT));
    assert!(!verify_passcode("password123", KAT_PASSCODE_HASH, KAT_SALT));
    assert!(!verify_passcode("PassWord124", KAT_PASSCODE_HASH, KAT_SALT));
}

/* ---- Random-salt round trips --------------------------------------------- */

#[test]
fn the_same_answer_always_verifies_and_a_different_one_never_does() {
    // test/security.test.ts "the same answer always verifies...".
    let (hash, salt) = hash_answer("Rex");
    assert!(verify_answer("Rex", &hash, &salt));
    assert!(verify_answer("rex", &hash, &salt));
    assert!(verify_answer("  REX ", &hash, &salt));
    assert!(!verify_answer("Fido", &hash, &salt));
}

#[test]
fn two_identical_answers_hash_differently_via_a_fresh_salt_each_time() {
    let (hash_a, salt_a) = hash_answer("Rex");
    let (hash_b, salt_b) = hash_answer("Rex");
    assert_ne!(salt_a, salt_b, "each record must get its own salt");
    assert_ne!(hash_a, hash_b, "different salts must give different hashes");
    assert!(verify_answer("Rex", &hash_a, &salt_a));
    assert!(verify_answer("Rex", &hash_b, &salt_b));
}

#[test]
fn stored_records_are_unpadded_base64url_of_the_expected_widths() {
    // 16-byte salt -> 22 chars, 32-byte hash -> 43 chars, and the base64url
    // alphabet carries none of "+/=" (toBase64Url strips padding).
    let (hash, salt) = hash_answer("Rex");
    assert_eq!(salt.len(), 22);
    assert_eq!(hash.len(), 43);
    assert!(hash
        .chars()
        .chain(salt.chars())
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
}

#[test]
fn the_plaintext_answer_is_never_present_in_the_stored_record() {
    // Both checks are deterministic: the quoted form can only match if a
    // field *equals* the plaintext (base64url contains no quotes), and fields
    // are 43/22 characters while the probes are shorter.
    let serialised = format!("{{\"hash\":\"{KAT_REX_HASH}\",\"salt\":\"{KAT_SALT}\"}}");
    assert!(!serialised.contains("\"Rex\""));
    assert!(!serialised.contains("\"rex\""));

    let (hash, salt) = hash_answer("Rex");
    let serialised = format!("{{\"hash\":\"{hash}\",\"salt\":\"{salt}\"}}");
    assert!(!serialised.contains("\"Rex\""));
    assert!(!serialised.contains("\"rex\""));
}

/* ---- Passcode ------------------------------------------------------------ */

#[test]
fn a_passcode_round_trips() {
    // test/security-passcode.test.ts "a passcode round-trips".
    let (hash, salt) = hash_passcode("correct horse battery");
    assert!(verify_passcode("correct horse battery", &hash, &salt));
    assert!(!verify_passcode("wrong horse battery", &hash, &salt));
}

#[test]
fn a_passcode_is_compared_verbatim_not_case_folded() {
    // Answers are normalised before hashing (case and spacing folded); a
    // passcode must NOT be, or folding case would accept a password never
    // set — verbatim in, verbatim compared.
    let (hash, salt) = hash_passcode("Secret123!");
    assert!(verify_passcode("Secret123!", &hash, &salt));
    assert!(!verify_passcode("secret123!", &hash, &salt));
    assert!(!verify_passcode("SECRET123!", &hash, &salt));

    let (hash, salt) = hash_passcode("PassWord123");
    assert!(verify_passcode("PassWord123", &hash, &salt));
    assert!(!verify_passcode("password123", &hash, &salt));
    assert!(!verify_passcode("PASSWORD123", &hash, &salt));
}

#[test]
fn passcode_whitespace_and_punctuation_are_significant() {
    let (hash, salt) = hash_passcode("  spaces matter  ");
    assert!(verify_passcode("  spaces matter  ", &hash, &salt));
    assert!(!verify_passcode("spaces matter", &hash, &salt));
    assert!(!verify_passcode("spaces  matter", &hash, &salt));
}

#[test]
fn each_stored_passcode_gets_its_own_salt() {
    let (hash_a, salt_a) = hash_passcode("same password");
    let (hash_b, salt_b) = hash_passcode("same password");
    assert_ne!(salt_a, salt_b, "identical passcodes must not share a salt");
    assert_ne!(hash_a, hash_b);
    assert!(verify_passcode("same password", &hash_a, &salt_a));
    assert!(verify_passcode("same password", &hash_b, &salt_b));
}

#[test]
fn weak_passcodes_are_refused() {
    for weak in [
        "", "short", "password", "Password1", "12345678", "aaaaaaaa", "qwertyui",
        // One character class only ("abcdefgh") — 8 characters and no
        // repetition, so the class rule is what catches it.
        "abcdefgh",
    ] {
        assert!(passcode_too_weak(weak, false), "{weak:?} should be refused");
        // Every weak passcode stays weak behind an authenticator.
        assert!(passcode_too_weak(weak, true), "{weak:?} should stay refused");
    }
}

#[test]
fn reasonable_passcodes_are_accepted() {
    for ok in ["correct horse", "Tr0ub4dor&3", "a-long-one-9x", "J8#kq2!vLz"] {
        assert!(!passcode_too_weak(ok, false), "{ok:?} should be accepted");
    }
}

#[test]
fn an_authenticator_backed_login_demands_twelve_characters() {
    // SecurityForm.tsx L155-160: with TOTP set, the passcode would otherwise
    // be the weakest factor it sits behind, so 8-11 characters is refused.
    let nine_chars = "Correct12";
    assert_eq!(nine_chars.chars().count(), 9);
    assert!(!passcode_too_weak(nine_chars, false), "8+ is enough alone");
    assert!(passcode_too_weak(nine_chars, true), "12+ needed behind TOTP");

    let twelve_chars = "Correct12345";
    assert_eq!(twelve_chars.chars().count(), 12);
    assert!(!passcode_too_weak(twelve_chars, true));
    // Length is not a substitute for the other rules behind TOTP either: 12
    // characters, but a single class.
    assert!(passcode_too_weak("abcdefghijkl", true));
    assert!(!passcode_too_weak("Abcdefgh1234", true));
}
