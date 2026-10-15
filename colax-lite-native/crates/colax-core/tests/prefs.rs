//! Preferences persistence: save -> reopen -> identical struct.
//! Task 2.2 of docs/plans/2026-10-13-colax-lite-native-full-ui.md.

use colax_core::{
    normalise_preferences, Alarm, AlarmSound, VaultEngine, VaultPreferences, VaultStorage,
};
use serde_json::json;
use std::path::PathBuf;

fn temp_storage(tag: &str) -> (VaultStorage, PathBuf) {
    let mut path: PathBuf = std::env::temp_dir();
    path.push(format!("colax-prefs-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_file(&path);
    (VaultStorage::new(path.clone()), path)
}

fn cleanup(path: &PathBuf) {
    let _ = std::fs::remove_file(path);
}

/// The baseline every test here saves: the shape default, plus the three
/// shipped tags that every load seeds (`ensureDefaultTags`). The seeds carry
/// random ids, so they must be in the *saved* value too — otherwise the reload
/// gains three entries the assertion never expected.
fn baseline() -> VaultPreferences {
    let mut prefs = VaultPreferences::default();
    prefs.tags = colax_core::ensure_default_tags(Vec::new());
    prefs
}

#[test]
fn save_preferences_survives_a_reopen() {
    let (storage, path) = temp_storage("reopen");
    let mut engine = VaultEngine::open(storage.clone()).unwrap();
    engine.create(None).unwrap();

    let mut prefs = baseline();
    prefs.theme = "light".into();
    prefs.accent = "sage".into();
    prefs.text_scale = 118.0;
    prefs.density = "spacious".into();
    prefs.roundness = 1.3;
    prefs.tray_enabled = false;
    prefs.sounds_muted = true;

    engine
        .save_preferences(serde_json::to_value(&prefs).unwrap())
        .unwrap();

    // Reopen the file from disk, as a restart would.
    let reopened = VaultEngine::open(storage.clone()).unwrap();
    let read = normalise_preferences(reopened.preferences());
    assert_eq!(read, prefs);

    cleanup(&path);
}

#[test]
fn preferences_written_without_a_vault_are_held_in_memory() {
    // Before `create`, there is no document to write; the value must still be
    // retrievable rather than silently dropped.
    let (storage, path) = temp_storage("no-vault");
    let mut engine = VaultEngine::open(storage.clone()).unwrap();
    assert!(!engine.exists());

    let mut prefs = baseline();
    prefs.accent = "clay".into();
    engine
        .save_preferences(serde_json::to_value(&prefs).unwrap())
        .unwrap();
    assert_eq!(normalise_preferences(engine.preferences()), prefs);

    // And creating the vault afterwards persists them.
    engine.create(None).unwrap();
    let reopened = VaultEngine::open(storage.clone()).unwrap();
    assert_eq!(
        normalise_preferences(reopened.preferences()).accent,
        "clay"
    );

    cleanup(&path);
}

#[test]
fn shell_flags_mirror_the_shell_state_defaults() {
    let prefs = normalise_preferences(&json!({}));
    assert!(prefs.tray_enabled);
    assert!(prefs.close_to_tray);
    assert!(!prefs.launch_at_login);
    assert!(!prefs.sounds_muted);
}

#[test]
fn unknown_keys_still_round_trip_through_the_engine() {
    let (storage, path) = temp_storage("extra");
    let mut engine = VaultEngine::open(storage.clone()).unwrap();
    engine.create(None).unwrap();

    engine
        .save_preferences(json!({
            "theme": "dark",
            "clearClipboardSeconds": 45,
            "passwordGenerator": { "length": 24, "digits": true },
        }))
        .unwrap();

    let reopened = VaultEngine::open(storage.clone()).unwrap();
    let raw = reopened.preferences();
    assert_eq!(raw["clearClipboardSeconds"], 45);
    assert_eq!(raw["passwordGenerator"]["length"], 24);
    let prefs = normalise_preferences(raw);
    assert_eq!(prefs.theme, "dark");

    cleanup(&path);
}

#[test]
fn alarms_are_rebuilt_field_by_field() {
    // storage.ts L1237-1250: a row needs an `id` *string* and a `time`
    // *string* or it is dropped whole; every other field is coerced rather
    // than trusted.
    let prefs = normalise_preferences(&json!({
        "alarms": [
            { "id": "al_1", "time": "23:59", "label": "Stand up",
              "days": [1, 3, 5],
              "sound": { "name": "ping.mp3", "dataUrl": "data:audio/mpeg;base64,AAAA" },
              "enabled": true },
            // No id — dropped whole, fields and all.
            { "time": "07:00", "label": "orphan" },
            // No time — dropped whole.
            { "id": "al_2", "label": "orphan too" },
            // Non-object rows — dropped.
            "not an alarm",
            null,
            // Wrong time shape — replaced with the 08:00 fallback rather than
            // kept for a matcher that could never fire it.
            { "id": "al_3", "time": "8:00" },
            // Everything else coerces: label to "", days to whole numbers in
            // 0..=6 (3.0 is the integer 3, a string "2" is not a number),
            // sound to an object or null, enabled through Boolean().
            { "id": "al_4", "time": "99:99", "label": 5,
              "days": [7, -1, "2", 3.0, 1],
              "sound": { "name": 42, "dataUrl": 7 }, "enabled": "yes" },
            // A sound that is not an object reads as the chime.
            { "id": "al_5", "time": "12:00", "sound": "beep" }
        ]
    }));
    // Modelled — the list must not double-capture into `extra`.
    assert!(prefs.extra.get("alarms").is_none());
    assert_eq!(prefs.alarms.len(), 4);

    let kept = &prefs.alarms[0];
    assert_eq!(kept.id, "al_1");
    assert_eq!(kept.time, "23:59");
    assert_eq!(kept.label, "Stand up");
    assert_eq!(kept.days, vec![1, 3, 5]);
    let sound = kept.sound.as_ref().unwrap();
    assert_eq!(sound.name, "ping.mp3");
    assert_eq!(sound.data_url.as_deref(), Some("data:audio/mpeg;base64,AAAA"));
    assert!(kept.enabled);

    let fallback = &prefs.alarms[1];
    assert_eq!(fallback.time, "08:00");
    assert_eq!(fallback.label, "");
    assert_eq!(fallback.days, Vec::<u8>::new());
    assert!(fallback.sound.is_none());
    assert!(!fallback.enabled); // absent = Boolean(undefined) = false

    let coerced = &prefs.alarms[2];
    // `\d{2}:\d{2}` does not range-check in the TS either: 99:99 stays.
    assert_eq!(coerced.time, "99:99");
    assert_eq!(coerced.label, "");
    assert_eq!(coerced.days, vec![3, 1]);
    let sound = coerced.sound.as_ref().unwrap();
    assert_eq!(sound.name, "42");
    assert!(sound.data_url.is_none());
    assert!(coerced.enabled); // a non-empty string is truthy

    let chime = &prefs.alarms[3];
    assert!(chime.sound.is_none());
}

#[test]
fn alarm_ids_look_like_the_typescript_ones() {
    // `al_` plus the first eight characters of a random uuid — `newAlarmId`
    // (storage.ts L316): the hyphen sits at index 8 in JS, so the slice is
    // exactly eight hex characters.
    let id = colax_core::new_alarm_id();
    assert!(id.starts_with("al_"));
    assert_eq!(id.len(), 11);
    assert!(id[3..].chars().all(|c| c.is_ascii_hexdigit()));
    assert_ne!(id, colax_core::new_alarm_id());
}

#[test]
fn alarms_survive_a_preferences_round_trip() {
    let (storage, path) = temp_storage("alarms");
    let mut engine = VaultEngine::open(storage.clone()).unwrap();
    engine.create(None).unwrap();

    let mut prefs = baseline();
    prefs.alarms = vec![Alarm {
        id: "al_deadbeef".into(),
        label: "Stand up".into(),
        time: "14:30".into(),
        days: vec![1, 2],
        sound: Some(AlarmSound {
            name: "ping.mp3".into(),
            // `dataUrl` on the wire, `data_url` in Rust — the camelCase
            // rename is what keeps this a Some after a reload.
            data_url: Some("data:audio/wav;base64,AAAA".into()),
        }),
        enabled: false,
    }];

    engine
        .save_preferences(serde_json::to_value(&prefs).unwrap())
        .unwrap();

    let reopened = VaultEngine::open(storage.clone()).unwrap();
    assert_eq!(normalise_preferences(reopened.preferences()), prefs);

    cleanup(&path);
}
