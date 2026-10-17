//! Colax Lite's vault engine.
//!
//! Everything the app knows how to do that is not a pixel: the key hierarchy
//! (PBKDF2 -> AES-256-GCM), the item/preference normalisers, storage, and the
//! backup format. Deliberately free of any UI dependency so the same crate can
//! back a native window today and a CLI importer later.
//!
//! Phase 1: the crypto, model, storage and engine are a byte-compatible port
//! of the TypeScript in `lite version/src/{crypto,vault}/`, proven by
//! known-answer vectors generated from Node's WebCrypto
//! (`scripts/make-ts-fixture.mjs`) and by the ported cases from
//! `lite version/test/crypto.test.ts`.

pub mod bytes;
pub mod channels;
pub mod crypto;
pub mod dock;
pub mod engine;
pub mod error;
pub mod health;
pub mod history;
pub mod model;
pub mod optimize;
pub mod prefs;
pub mod security;
pub mod storage;
pub mod strength;
pub mod text;
pub mod totp;
pub mod util;

pub use channels::{apply_channel, builtin_channels, find_reused_passwords, Channel, ChannelAccent, ChannelKind};
pub use crypto::{
    create_device_header, create_password_header, open_item, open_vault_key, resolve_header,
    rewrap_vault_key, seal_item, SealedBlob, VaultHeader, VaultKeyHandle, VaultProtection,
    PBKDF2_ITERATIONS, VAULT_FORMAT_VERSION,
};
pub use engine::{new_item_id, verify_backup_password, VaultEngine};
pub use dock::{
    default_dock_slots, default_docks, free_dock_spot, new_dock_id, normalise_dock_pos,
    normalise_dock_slots, normalise_docks, DockLoginAction, DockPlacement, DockPosition,
    DockSlotConfig, DockSlotKind, DockState, DOCK_LOGIN_ACTIONS, MAX_DOCKS, MAX_DOCK_SLOTS,
};
pub use error::VaultError;
pub use health::{find_weak_items, is_stale, pattern_stem};
pub use history::{
    append_history, history_events_for, new_history_event_id, normalise_history, HistoryAction,
    HistoryEvent, MAX_HISTORY_CHARS, MAX_HISTORY_EVENTS,
};
pub use model::{
    empty_item, is_secured, is_weak_password, normalise_item, normalise_security, normalize_url,
    security_level, stale_days_for, LoginSecurity, StoredItem, VaultItem,
};
pub use optimize::{
    apply_style, clean_profile_name, new_optimize_profile_id, normalise_optimize_profiles,
    optimisations_on, read_style, same_style, snapshot_style, style_from_prefs, OptimizeProfile,
    OptimizeStyle, BALANCED_STYLE, FULL_DETAIL_STYLE, MAX_OPTIMIZE_PROFILES, MAX_SAVINGS_STYLE,
    OPTIMISATIONS, OPTIMISATION_COUNT, SLOW_MAIL_SECONDS,
};
pub use prefs::{
    create_tag, default_card_size, ensure_default_tags, new_alarm_id, new_tag_id,
    normalise_alarms, normalise_generator, normalise_preferences, normalise_tags,
    sounds_muted_from, Alarm, AlarmSound, CardSize, PasswordGenerator, Tag, UsageEntry,
    VaultPreferences,
};
pub use security::{
    answer_too_weak, hash_answer, hash_passcode, normalise_answer, passcode_too_weak,
    verify_answer, verify_passcode,
};
pub use storage::{parse_backup, serialize_backup, BackupFile, VaultStorage, BACKUP_FORMAT};
pub use strength::{
    estimate_strength, generate_passphrase, generate_password, passphrase_word_count,
    suggest_master_password, GeneratorOptions, Strength,
};
pub use text::{from_date_input, relative_time, to_date_input};
