//! Error type for the vault engine.
//!
//! Messages match the TypeScript originals in `lite version/src/` wherever the
//! UI is allowed to surface them, so a native build reads the same as the app
//! it is replacing.

use std::fmt;

#[derive(Debug)]
pub enum VaultError {
    /// A password failed to unwrap the vault key (`VaultAuthError` in TS).
    /// Only this variant means "wrong password"; the engine turns it into a
    /// quiet `false` from `unlock` rather than an error.
    Auth,
    /// The header exists but cannot produce a vault key.
    DamagedHeader(String),
    /// The vault file references a vault key that is not 256 bits, or item
    /// bytes that are not UTF-8/JSON — structural, never "wrong password".
    Corrupt(String),
    /// No vault on this device: "No vault found on this device."
    NoVault,
    /// create() on a device that already has one.
    Exists,
    /// Operation attempted while the key handle is absent.
    Locked,
    /// Item id not found in the plaintext set.
    MissingItem,
    /// change_master_password() on a device (passwordless) vault.
    NoPassword,
    /// disable_password() on a vault that has no password.
    HasNoPassword,
    /// A backup marker other than `aegis-vault-backup`.
    NotABackup,
    /// parse_backup() failures; text mirrors backup.ts.
    Backup(String),
    /// JSON could not be produced or consumed for an item/patch.
    Json(String),
    /// Filesystem failures around the vault document.
    Storage(String),
}

impl fmt::Display for VaultError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            VaultError::Auth => write!(f, "Incorrect master password."),
            VaultError::DamagedHeader(msg) => write!(f, "The vault header is damaged: {msg}"),
            VaultError::Corrupt(msg) => write!(f, "{msg}"),
            VaultError::NoVault => write!(f, "No vault found on this device."),
            VaultError::Exists => write!(f, "A vault already exists on this device."),
            VaultError::Locked => write!(f, "The vault is locked."),
            VaultError::MissingItem => write!(f, "That item no longer exists."),
            VaultError::NoPassword => write!(f, "This vault has no password. Enable one first."),
            VaultError::HasNoPassword => write!(f, "This vault already has no password."),
            VaultError::NotABackup => write!(f, "That is not an Aegis backup file."),
            VaultError::Backup(msg) => write!(f, "{msg}"),
            VaultError::Json(msg) => write!(f, "{msg}"),
            VaultError::Storage(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for VaultError {}
