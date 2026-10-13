//! Preferences persistence: save -> reopen -> identical struct.
//! Task 2.2 of docs/plans/2026-10-13-colax-lite-native-full-ui.md.

use colax_core::{normalise_preferences, VaultEngine, VaultPreferences, VaultStorage};
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

#[test]
fn save_preferences_survives_a_reopen() {
    let (storage, path) = temp_storage("reopen");
    let mut engine = VaultEngine::open(storage.clone()).unwrap();
    engine.create(None).unwrap();

    let mut prefs = VaultPreferences::default();
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

    let mut prefs = VaultPreferences::default();
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
