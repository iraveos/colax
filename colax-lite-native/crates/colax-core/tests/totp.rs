//! TOTP suite: RFC 6238 vectors ported from `test/crypto.test.ts`, the seed
//! extraction rules from `src/crypto/security.ts`, and the QR matrix the
//! authenticator screen paints.
//!
//! Task 1.2 of docs/plans/2026-10-13-colax-lite-native-full-ui.md.

use colax_core::totp::*;

/// Base32 of the ASCII secret "12345678901234567890" — RFC 6238 Appendix B's
/// SHA-1 seed, and the same literal the TS tests use.
const RFC_SEED: &str = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

#[test]
fn rfc6238_sha1_vectors_truncate_to_six_digits() {
    // The RFC publishes 8-digit codes; the app (and the TS original) take them
    // modulo 10^6. The first, second and fourth cases are exactly the ones
    // `test/crypto.test.ts` L423-429 pins.
    let cases: [(u64, &str); 6] = [
        (59, "287082"),
        (1_111_111_109, "081804"),
        (1_111_111_111, "050471"),
        (1_234_567_890, "005924"),
        (2_000_000_000, "279037"),
        (20_000_000_000, "353130"),
    ];
    for (at, expected) in cases {
        assert_eq!(totp_code(RFC_SEED, at).unwrap(), expected, "t={at}");
    }
}

#[test]
fn seeds_tolerate_case_spacing_dashes_and_padding() {
    // Authenticator apps display seeds grouped and lowercased occasionally;
    // `base32Decode` in TS strips all of it, and so do we.
    let canonical = totp_code(RFC_SEED, 59).unwrap();
    for messy in [
        "gezdgnbvgy3tqojq gezdgnbvgy3tqojq",
        "GEZDGNBVGY3TQOJQ-GEZDGNBVGY3TQOJQ",
        "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ==",
    ] {
        assert_eq!(totp_code(messy, 59).unwrap(), canonical, "{messy}");
    }
}

#[test]
fn unusable_seeds_error_instead_of_returning_a_code() {
    // "Nothing pasted" and "rubbish pasted" are different mistakes and get
    // the TS originals' distinct messages.
    let blank = totp_code("", 59).unwrap_err();
    assert!(blank.contains("valid authenticator seed"), "{blank}");
    let rubbish = totp_code("!!!", 59).unwrap_err();
    assert!(rubbish.contains("invalid characters"), "{rubbish}");
}

#[test]
fn seconds_remaining_counts_down_inside_the_step() {
    assert_eq!(totp_seconds_remaining(59), 1);
    // A fresh step reads 30, not 0 — same as the TS original, so the UI never
    // flashes an empty ring at the rollover.
    assert_eq!(totp_seconds_remaining(0), 30);
    assert_eq!(totp_seconds_remaining(30), 30);
}

#[test]
fn a_generated_seed_round_trips_through_its_otpauth_url() {
    let seed = generate_totp_seed();
    let url = otpauth_url("My Login", &seed);
    assert_eq!(
        url,
        format!("otpauth://totp/Colax:My%20Login?secret={seed}&issuer=Colax"),
        "must match otpauthUrl in SecurityForm.tsx byte for byte"
    );
    assert_eq!(extract_totp_secret(&url).as_deref(), Some(seed.as_str()));
    // Only a truly empty label falls back to 'vault'; whitespace would be
    // percent-encoded by encodeURIComponent, so it stays as a label.
    assert!(otpauth_url("", &seed).starts_with("otpauth://totp/Colax:vault?secret="));
}

#[test]
fn extract_accepts_a_bare_seed_in_any_paste_format() {
    assert_eq!(
        extract_totp_secret("jbswy3dpehpk3pxp"),
        Some("JBSWY3DPEHPK3PXP".to_string())
    );
    // Grouped, spaced and cased the way apps display it — canonical out.
    assert_eq!(
        extract_totp_secret("  jbsw y3dp ehpk 3pxp  "),
        Some("JBSWY3DPEHPK3PXP".to_string())
    );
}

#[test]
fn extract_rejects_garbage() {
    for garbage in [
        "",
        "   ",
        "not a seed!",
        // Alphabet-valid but only 10 letters = 6 bytes: far below a plausible
        // seed, the silent-acceptance trap `extractBareSeed` documents.
        "hello world",
        // Well-formed URI, but no secret= parameter to take.
        "otpauth://totp/Colax:Me?issuer=Colax",
        "otpauth://nonsense",
    ] {
        assert_eq!(extract_totp_secret(garbage), None, "{garbage:?}");
    }
}

#[test]
fn verify_accepts_the_current_window_and_rejects_wrong_codes() {
    let seed = generate_totp_seed();
    let code = current_totp_code(&seed).unwrap();
    assert_eq!(code.len(), 6);
    assert!(code.chars().all(|c| c.is_ascii_digit()));
    // The only race this could hit — stepping over a 30s boundary between the
    // two calls — is absorbed by the ±1 window verify allows.
    assert!(verify_totp(&seed, &code));

    // A wrong code, chosen so the assertion cannot flake on a chance collision
    // with an accepted window.
    let mut wrong = "000000".to_string();
    while verify_totp(&seed, &wrong) {
        let next: u32 = wrong.parse::<u32>().unwrap() + 1;
        wrong = format!("{next:06}");
    }
    assert!(!verify_totp(&seed, &wrong));

    // Length and alphabet are ruled out before any HMAC work.
    assert!(!verify_totp(&seed, "12345"));
    assert!(!verify_totp(&seed, ""));
    assert!(!verify_totp(&seed, "abcdef"));
    // An unusable seed can never verify, not even against a lucky match.
    assert!(!verify_totp("!!!", &code));
}

#[test]
fn qr_matrix_is_square_and_paints_the_finder_patterns() {
    let url = otpauth_url("GitHub", &generate_totp_seed());
    let (side, modules) = qr_matrix(&url).expect("an otpauth URL fits in a QR symbol");
    assert!(side >= 21, "version 1 is 21 modules per side, got {side}");
    assert_eq!(modules.len(), side * side);
    assert!(modules.iter().any(|&dark| dark), "all light cannot encode");
    assert!(modules.iter().any(|&dark| !dark), "all dark cannot encode");

    let is_dark = |x: usize, y: usize| modules[y * side + x];
    // The three 7x7 finder patterns: dark border, light ring, dark 3x3 core.
    for (left, top) in [(0usize, 0usize), (side - 7, 0), (0, side - 7)] {
        for dy in 0..7 {
            for dx in 0..7 {
                let border = dx == 0 || dx == 6 || dy == 0 || dy == 6;
                let core = (2..=4).contains(&dx) && (2..=4).contains(&dy);
                assert_eq!(
                    is_dark(left + dx, top + dy),
                    border || core,
                    "finder at ({left},{top}), module ({dx},{dy})"
                );
            }
        }
    }
}

#[test]
fn qr_matrix_refuses_empty_or_oversized_data() {
    assert_eq!(qr_matrix(""), None);
    // Level M tops out at 2331 bytes in version 40; well past that the
    // encoder refuses rather than truncating.
    assert_eq!(qr_matrix(&"x".repeat(4000)), None);
}

#[test]
fn generated_seeds_are_160_bits_and_unique() {
    let a = generate_totp_seed();
    let b = generate_totp_seed();
    assert_ne!(a, b, "two seeds must differ (astronomically unlikely otherwise)");
    assert_eq!(a.len(), 32, "20 bytes encode to 32 unpadded base32 chars");
    assert!(a
        .chars()
        .all(|c| c.is_ascii_uppercase() || ('2'..='7').contains(&c)));
    // Immediately usable: extract hands back exactly what was generated.
    assert_eq!(extract_totp_secret(&a).as_deref(), Some(a.as_str()));
}
