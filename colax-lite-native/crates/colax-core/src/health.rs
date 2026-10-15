//! Weak, stale and reused password analysis — Task 1.4 of the plan.
//!
//! Port of `findWeakItems` / `isWeakPassword` / `staleDaysFor` /
//! `patternStem` from `src/vault/types.ts` L297-360, pinned by the cases in
//! `test/health.test.ts` (`tests/health.rs` here).
//!
//! The Weak channel and the dashboard's "needs attention" buckets must not
//! each hold a copy of these rules: `apply_channel`'s Weak arm is a call
//! into `find_weak_items`, so a rule that changes changes once. The reuse
//! set itself (`find_reused_passwords`) predates this module and stays in
//! `channels.rs`, beside the channel that also consumes it.
//!
//! `is_weak_password` and `stale_days_for` are the model's own —
//! re-exported here so the whole analysis reads from one place instead of
//! two definitions drifting apart.

pub use crate::model::{is_weak_password, stale_days_for};

use std::collections::HashMap;

use crate::model::VaultItem;
use crate::strength::estimate_strength;

/// Lowercased, digits-stripped stem, or empty when too short to mean
/// anything: `Summer2023!` and `summer2024!` both reduce to `summer!`, so a
/// rotation that only bumped a number groups as one family, while `a1`/`a2`
/// (stem `a`) must not make every short password look related.
///
/// Counted in characters, the way JS measures `.length` on the lowered
/// string (`types.ts` L321): a two-glyph stem is too short here even
/// though its bytes may clear four.
pub fn pattern_stem(password: &str) -> String {
    let stem: String = password
        .to_lowercase()
        .chars()
        .filter(|c| !c.is_ascii_digit())
        .collect();
    if stem.chars().count() >= 4 {
        stem
    } else {
        String::new()
    }
}

/// This login's password is past its own rotation window *right now* — its
/// own reminder when set, else the global one (`staleDaysFor`), 0 disabling
/// the check. `now_ms` is a parameter rather than a wall-clock read so one
/// instant serves every bucket a screen computes, and tests can pin exact
/// ages.
pub fn is_stale(item: &VaultItem, stale_after_days: f64, now_ms: i64) -> bool {
    let threshold = stale_days_for(item, stale_after_days);
    threshold > 0.0
        && (item.password_updated_at as f64) < now_ms as f64 - threshold * 86_400_000.0
}

/// `findWeakItems` (types.ts L297): reused, stale, guessable on its own, or
/// following the same pattern as another login — a union, so a login bad in
/// two ways still appears once. Empty passwords never qualify: a login
/// being typed is not yet a weak one.
///
/// Returns the items themselves, as TS does — the plan's id-list sketch
/// would only make every caller map straight back, and the id is one field
/// away.
pub fn find_weak_items<'a>(
    items: &'a [VaultItem],
    stale_after_days: f64,
    now_ms: i64,
) -> Vec<&'a VaultItem> {
    let mut usage: HashMap<&str, usize> = HashMap::new();
    let mut patterns: HashMap<String, usize> = HashMap::new();
    for item in items {
        if item.password.is_empty() {
            continue;
        }
        *usage.entry(item.password.as_str()).or_insert(0) += 1;
        let stem = pattern_stem(&item.password);
        if !stem.is_empty() {
            *patterns.entry(stem).or_insert(0) += 1;
        }
    }
    items
        .iter()
        .filter(|item| {
            if item.password.is_empty() {
                return false;
            }
            if usage.get(item.password.as_str()).copied().unwrap_or(0) > 1 {
                return true;
            }
            if is_stale(item, stale_after_days, now_ms) {
                return true;
            }
            if estimate_strength(&item.password).score <= 1 {
                return true;
            }
            let stem = pattern_stem(&item.password);
            !stem.is_empty() && patterns.get(&stem).copied().unwrap_or(0) > 1
        })
        .collect()
}
