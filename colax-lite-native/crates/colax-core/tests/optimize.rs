//! Optimize suite: the cases from `test/optimize.test.ts` ported to Rust,
//! plus the one preference-record repair test that lives in the TS's
//! storage suite but belongs to this module's normaliser.
//!
//! The connected mailboxes are untyped until Task 9.1 models the account
//! records, so the tests write them the way the document stores them: an
//! array in the record, read back through `extra`.

use colax_core::{
    apply_style, clean_profile_name, new_optimize_profile_id, normalise_optimize_profiles,
    normalise_preferences, optimisations_on, read_style, same_style, snapshot_style,
    style_from_prefs, OptimizeStyle, MAX_OPTIMIZE_PROFILES, OPTIMISATION_COUNT,
};
use serde_json::{json, Value};

fn prefs(raw: Value) -> colax_core::VaultPreferences {
    normalise_preferences(&raw)
}

fn default_prefs() -> colax_core::VaultPreferences {
    prefs(json!({}))
}

fn account(id: &str, address: &str, refresh_seconds: f64) -> Value {
    json!({ "id": id, "address": address, "appPassword": "x", "refreshSeconds": refresh_seconds })
}

#[test]
fn the_counter_can_reach_its_own_total_and_shipped_defaults_score_honest() {
    // Ten since inline-image fetching joined the list: reading a message's
    // text without its images is a real, countable saving, and a profile
    // called "maximum savings" has to be able to turn it off and count it.
    assert_eq!(OPTIMISATION_COUNT, 10, "ten switches, ten countable savings");
    let base = default_prefs();
    // Shipped defaults score exactly two, and both are facts the panel shows
    // as locked switches: no full-bleed photo is being repainted, and no
    // mailbox is connected so nothing polls in the background.
    assert_eq!(
        optimisations_on(&base),
        2,
        "no picture to repaint, no mailbox polling"
    );
    let mut saved = base.clone();
    apply_style(&mut saved, &colax_core::MAX_SAVINGS_STYLE);
    assert_eq!(
        optimisations_on(&saved),
        OPTIMISATION_COUNT,
        "maximum savings reaches the total"
    );
    let mut full = base.clone();
    apply_style(&mut full, &colax_core::FULL_DETAIL_STYLE);
    assert_eq!(optimisations_on(&full), 2);
    let mut balanced = base.clone();
    apply_style(&mut balanced, &colax_core::BALANCED_STYLE);
    assert!(optimisations_on(&balanced) > 2);
}

#[test]
fn a_style_round_trips_through_the_preferences_it_describes() {
    let base = default_prefs();
    let mut max = base.clone();
    apply_style(&mut max, &colax_core::MAX_SAVINGS_STYLE);
    let snapshot = style_from_prefs(&max);
    assert_eq!(snapshot.motion, colax_core::MAX_SAVINGS_STYLE.motion);
    assert_eq!(snapshot.motion_speed, colax_core::MAX_SAVINGS_STYLE.motion_speed);
    assert_eq!(snapshot.micro_motion, colax_core::MAX_SAVINGS_STYLE.micro_motion);
    assert_eq!(snapshot.ambient, colax_core::MAX_SAVINGS_STYLE.ambient);
    assert_eq!(
        snapshot.reduce_transparency,
        colax_core::MAX_SAVINGS_STYLE.reduce_transparency
    );
    assert_eq!(snapshot.density, colax_core::MAX_SAVINGS_STYLE.density);
    assert_eq!(snapshot.card_depth, colax_core::MAX_SAVINGS_STYLE.card_depth);
    assert_eq!(
        snapshot.mail_inline_images,
        colax_core::MAX_SAVINGS_STYLE.mail_inline_images
    );
    assert_eq!(
        snapshot.disable_spellcheck,
        colax_core::MAX_SAVINGS_STYLE.disable_spellcheck
    );
    assert_eq!(
        snapshot.mail_refresh_seconds, None,
        "a plain snapshot never claims a mail cadence"
    );
}

#[test]
fn a_profile_never_rewrites_the_mail_cadence_it_did_not_measure() {
    // "Off" (`refreshSeconds: 0`) is a deliberate choice; a profile carrying
    // null must leave it alone, which the old panel got wrong by always
    // writing a number back.
    let base = prefs(json!({ "gmailAccounts": [account("g1", "me@gmail.com", 0.0)] }));
    let mut patched = base.clone();
    apply_style(&mut patched, &colax_core::FULL_DETAIL_STYLE);
    assert_eq!(
        patched
            .extra
            .get("gmailAccounts")
            .and_then(|accounts| accounts[0].get("refreshSeconds"))
            .and_then(Value::as_f64),
        Some(0.0),
        "a null cadence leaves the account's own"
    );
    assert_eq!(
        optimisations_on(&base),
        1,
        "an account set to Off is a real, deliberate saving"
    );
    let mut stretched = base.clone();
    apply_style(&mut stretched, &colax_core::MAX_SAVINGS_STYLE);
    assert_eq!(
        stretched
            .extra
            .get("gmailAccounts")
            .and_then(|accounts| accounts[0].get("refreshSeconds"))
            .and_then(Value::as_f64),
        Some(900.0)
    );
}

#[test]
fn the_snapshot_captures_a_shared_mail_cadence_and_refuses_a_mixed_one() {
    let one = prefs(json!({ "gmailAccounts": [account("g1", "me@gmail.com", 60.0)] }));
    let two = prefs(json!({ "gmailAccounts": [
        account("g1", "me@gmail.com", 60.0),
        account("g2", "you@gmail.com", 60.0),
    ]}));
    assert_eq!(snapshot_style(&one).mail_refresh_seconds, Some(60));
    assert_eq!(snapshot_style(&two).mail_refresh_seconds, Some(60));
    // Mixed cadences are the user's own arrangement; guessing one would
    // flatten it.
    let mixed = prefs(json!({ "gmailAccounts": [
        account("g1", "me@gmail.com", 60.0),
        account("g2", "you@gmail.com", 900.0),
    ]}));
    assert_eq!(snapshot_style(&mixed).mail_refresh_seconds, None);
    assert_eq!(snapshot_style(&default_prefs()).mail_refresh_seconds, None);
}

#[test]
fn a_stored_style_is_clamped_field_by_field_never_trusted() {
    let hostile = read_style(&json!({
        "motion": -5,
        "motionSpeed": 99,
        "ambient": 42,
        "reduceTransparency": "yes",
        "density": "enormous",
        "cardDepth": -1,
        "backgroundImage": "javascript:alert(1)",
        "backgroundOpacity": 9,
        "backgroundBlur": 1000,
        "backgroundDim": 5,
        "mailRefreshSeconds": 99999,
        "disableSpellcheck": "true",
    }))
    .expect("an object of wrong values still reads");
    assert_eq!(hostile.motion, 0.0);
    assert_eq!(hostile.motion_speed, 2.0, "the top of the animation-speed slider");
    assert_eq!(
        colax_core::FULL_DETAIL_STYLE.motion_speed,
        default_prefs().motion_speed,
        "restoring the look restores the speed the app ships with"
    );
    assert_eq!(hostile.ambient, 1.0);
    assert_eq!(hostile.reduce_transparency, false, "only a real boolean counts");
    assert_eq!(hostile.density, "comfortable");
    assert_eq!(hostile.card_depth, 0.0);
    assert_eq!(
        hostile.background_image, "",
        "a script URL can never become a background"
    );
    assert_eq!(hostile.background_opacity, 1.0);
    assert_eq!(hostile.background_blur, 40.0);
    assert_eq!(hostile.background_dim, 0.9);
    assert_eq!(hostile.mail_refresh_seconds, Some(3600));
    assert_eq!(hostile.disable_spellcheck, false);
    assert!(read_style(&Value::Null).is_none());
    assert!(read_style(&json!("nonsense")).is_none());
    // Data URLs and https URLs are the two forms the appearance settings
    // accept.
    assert_eq!(
        read_style(&json!({ "backgroundImage": "data:image/png;base64,AAAA" }))
            .unwrap()
            .background_image,
        "data:image/png;base64,AAAA"
    );
    assert_eq!(
        read_style(&json!({ "backgroundImage": "https://x.test/a.png" }))
            .unwrap()
            .background_image,
        "https://x.test/a.png"
    );
}

#[test]
fn profiles_are_deduplicated_by_name_newest_first_and_bounded() {
    let make = |name: &str, created_at: i64| {
        json!({
            "id": new_optimize_profile_id(),
            "name": name,
            "createdAt": created_at,
            "style": *colax_core::MAX_SAVINGS_STYLE,
        })
    };
    let cleaned = normalise_optimize_profiles(&json!([
        make("Night", 1),
        make("night", 5),
        make("Day", 3),
        Value::Null,
        json!(7),
        { "name": "broken" },
    ]));
    assert_eq!(cleaned.len(), 2, "the unreadable record is dropped, not guessed at");
    assert_eq!(cleaned[0].name, "night", "the newer of two names wins, keeping the user its spelling");
    assert_eq!(cleaned[1].name, "Day");
    let many: Vec<Value> = (0..MAX_OPTIMIZE_PROFILES + 6)
        .map(|i| make(&format!("p{i}"), i as i64))
        .collect();
    let bounded = normalise_optimize_profiles(&Value::Array(many));
    assert_eq!(bounded.len(), MAX_OPTIMIZE_PROFILES);
    assert_eq!(
        bounded[0].name,
        format!("p{}", MAX_OPTIMIZE_PROFILES + 5),
        "the most recent survive"
    );
    assert!(normalise_optimize_profiles(&Value::Null).is_empty());
    assert!(normalise_optimize_profiles(&json!("nope")).is_empty());
}

#[test]
fn profile_names_are_trimmed_collapsed_and_never_empty() {
    assert_eq!(clean_profile_name("  Evening   focus  ", "Untitled look"), "Evening focus");
    assert_eq!(clean_profile_name("", "Untitled look"), "Untitled look");
    assert_eq!(clean_profile_name("   ", "Fallback"), "Fallback");
    assert_eq!(clean_profile_name(&"x".repeat(80), "Untitled look").chars().count(), 40);
}

#[test]
fn a_preference_record_repairs_its_profiles_snapshot_and_active_name() {
    let stored = prefs(json!({
        "optimizeProfiles": [
            { "id": "a", "name": "Night", "createdAt": 2, "style": *colax_core::MAX_SAVINGS_STYLE },
            { "id": "b", "name": "Broken", "createdAt": 3, "style": { "motion": 1 } },
        ],
        "optimizeSnapshot": {
            "motion": 0.4,
            "density": "spacious",
            "backgroundImage": "https://x.test/a.png",
        },
        "activeOptimizeProfile": "Night",
        "disableSpellcheck": true,
    }));
    assert_eq!(
        stored.optimize_profiles.len(),
        2,
        "a partial style still loads; missing fields fall back"
    );
    let partial = stored
        .optimize_profiles
        .iter()
        .find(|profile| profile.name == "Broken")
        .expect("both names survived");
    assert_eq!(partial.style.reduce_transparency, false);
    assert_eq!(partial.style.motion, 1.0, "the one field it did carry is kept");
    assert_eq!(stored.optimize_profiles[0].name, "Broken", "newest first");
    assert_eq!(stored.optimize_snapshot.as_ref().unwrap().density, "spacious");
    assert_eq!(
        stored.optimize_snapshot.as_ref().unwrap().background_image,
        "https://x.test/a.png"
    );
    assert_eq!(stored.active_optimize_profile, "Night");
    assert_eq!(stored.disable_spellcheck, true);
    // The active name must point at a profile that exists, or the tick lies.
    assert_eq!(
        prefs(json!({ "activeOptimizeProfile": "Gone" })).active_optimize_profile,
        ""
    );
    assert_eq!(
        prefs(json!({ "activeOptimizeProfile": 42 })).active_optimize_profile,
        ""
    );
    assert!(default_prefs().optimize_profiles.is_empty());
    assert!(default_prefs().optimize_snapshot.is_none());
    assert_eq!(default_prefs().disable_spellcheck, false);
}

#[test]
fn same_style_compares_every_field_a_profile_owns() {
    assert!(same_style(
        &colax_core::FULL_DETAIL_STYLE,
        &(*colax_core::FULL_DETAIL_STYLE).clone()
    ));
    assert!(!same_style(
        &colax_core::MAX_SAVINGS_STYLE,
        &colax_core::FULL_DETAIL_STYLE
    ));
    let with_cadence = OptimizeStyle {
        mail_refresh_seconds: Some(60),
        ..(*colax_core::FULL_DETAIL_STYLE).clone()
    };
    assert!(!same_style(&colax_core::FULL_DETAIL_STYLE, &with_cadence));
}
