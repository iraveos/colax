//! Health analysis — Task 1.4: the cases from `test/health.test.ts`,
//! pinned against the Rust port of `src/vault/types.ts` L297-360.

use colax_core::{
    empty_item, find_weak_items, is_stale, is_weak_password, pattern_stem, stale_days_for,
    util::now_ms, VaultItem,
};

/// The TS fixtures never go stale: 36500 days is `findWeakItems`' second
/// argument in every "is this weak on its own" case.
const NO_STALE: f64 = 36_500.0;

/// The default fixture — unique, fresh, long enough to be strong on its
/// own, so anything that flags it must have a real reason.
fn login(id: &str) -> VaultItem {
    let mut item = empty_item(id, 1_000);
    item.password = "correct horse battery staple extra words here".into();
    item.password_updated_at = now_ms();
    item
}

fn weak_ids(items: &[VaultItem], stale_after_days: f64) -> Vec<String> {
    find_weak_items(items, stale_after_days, now_ms())
        .into_iter()
        .map(|item| item.id.clone())
        .collect()
}

#[test]
fn a_low_strength_password_is_weak_even_when_unique_and_fresh() {
    let mut weak = login("weak-1");
    weak.password = "password1".into();
    assert!(is_weak_password(&weak.password));
    assert_eq!(weak_ids(std::slice::from_ref(&weak), NO_STALE), ["weak-1"]);
}

#[test]
fn a_strong_unique_fresh_password_is_not_weak() {
    let strong = login("strong-1");
    assert!(!is_weak_password(&strong.password));
    assert!(weak_ids(std::slice::from_ref(&strong), NO_STALE).is_empty());
}

#[test]
fn an_empty_password_is_never_weak() {
    // Otherwise every login-in-progress would flash warnings while typed.
    assert!(!is_weak_password(""));
    let mut blank = login("blank");
    blank.password = String::new();
    assert!(weak_ids(std::slice::from_ref(&blank), NO_STALE).is_empty());
}

#[test]
fn same_pattern_passwords_group_together() {
    let mut a = login("a");
    a.password = "Summer2023!".into();
    let mut b = login("b");
    b.password = "summer2024!".into();
    let ids = weak_ids(&[a, b], NO_STALE);
    assert_eq!(
        ids.len(),
        2,
        "rotations that only bump a number group up: {ids:?}"
    );
}

#[test]
fn short_shared_stems_do_not_group() {
    // Both reduce to the stem "ab", too short to mean a pattern — and both
    // must be individually strong, so neither the pattern nor the strength
    // path may flag them.
    let mut a = login("a");
    a.password = format!("ab{}", "1".repeat(30));
    let mut b = login("b");
    b.password = format!("ab{}", "2".repeat(30));
    assert!(
        !is_weak_password(&a.password) && !is_weak_password(&b.password),
        "fixtures must be individually strong"
    );
    assert!(weak_ids(&[a, b], NO_STALE).is_empty());
}

#[test]
fn a_per_login_reminder_overrides_the_global_stale_threshold() {
    let mut item = login("x");
    assert_eq!(stale_days_for(&item, 180.0), 180.0);
    item.reminder_days = 30.0;
    assert_eq!(stale_days_for(&item, 180.0), 30.0);
    // Fractional days carry minutes and hours: 15 minutes survives.
    item.reminder_days = 15.0 / 1440.0;
    assert_eq!(stale_days_for(&item, 180.0), 15.0 / 1440.0);
}

#[test]
fn a_minutes_scale_reminder_flags_within_the_hour() {
    let old = now_ms() - 20 * 60_000;
    let mut quick = login("quick");
    quick.password_updated_at = old;
    quick.reminder_days = 15.0 / 1440.0;
    let mut slow = login("slow");
    slow.password_updated_at = old;

    assert!(is_stale(&quick, 180.0, now_ms()));
    assert!(!is_stale(&slow, 180.0, now_ms()));
    // Strong fixtures: only age can flag either of them.
    assert_eq!(weak_ids(&[quick], 180.0), ["quick"], "15-minute reminder flags a 20-minute password");
    assert!(weak_ids(&[slow], 180.0).is_empty(), "global 180 days spares it");
}

#[test]
fn stale_flagging_follows_the_login_reminder_not_just_the_global() {
    let old = now_ms() - 40 * 86_400_000;
    let mut strict = login("strict");
    strict.password_updated_at = old;
    strict.reminder_days = 30.0;
    let mut lax = login("lax");
    lax.password_updated_at = old;
    // Strong unique passwords: only age can flag them.
    assert_eq!(weak_ids(&[strict], 180.0), ["strict"], "30-day reminder flags a 40-day password");
    assert!(weak_ids(&[lax], 180.0).is_empty(), "global 180 days spares it");
}

#[test]
fn pattern_stem_strips_case_and_digits_and_counts_characters() {
    assert_eq!(pattern_stem("Summer2023!"), "summer!");
    assert_eq!(pattern_stem("summer2024!"), "summer!");
    assert_eq!(pattern_stem("ab123"), "", "two characters after stripping: too short");
    assert_eq!(pattern_stem("a1"), "");
    // Two multi-byte characters are still two characters — JS `.length`
    // never counted bytes, and a two-glyph stem says nothing either way.
    assert_eq!(pattern_stem("日本2024"), "");
}
