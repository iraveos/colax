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
pub mod engine;
pub mod error;
pub mod model;
pub mod prefs;
pub mod storage;
pub mod strength;
pub mod util;

pub use channels::{apply_channel, builtin_channels, find_reused_passwords, Channel, ChannelAccent, ChannelKind};
pub use crypto::{
    create_device_header, create_password_header, open_item, open_vault_key, resolve_header,
    rewrap_vault_key, seal_item, SealedBlob, VaultHeader, VaultKeyHandle, VaultProtection,
    PBKDF2_ITERATIONS, VAULT_FORMAT_VERSION,
};
pub use engine::{new_item_id, verify_backup_password, VaultEngine};
pub use error::VaultError;
pub use model::{
    empty_item, is_secured, is_weak_password, normalise_item, normalise_security, normalize_url,
    security_level, stale_days_for, LoginSecurity, StoredItem, VaultItem,
};
pub use prefs::{normalise_preferences, VaultPreferences};
pub use storage::{parse_backup, serialize_backup, BackupFile, VaultStorage, BACKUP_FORMAT};
pub use strength::{
    estimate_strength, generate_passphrase, generate_password, passphrase_word_count,
    suggest_master_password, GeneratorOptions, Strength,
};
