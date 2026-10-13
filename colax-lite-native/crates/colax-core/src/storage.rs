//! On-disk storage for the vault document.
//!
//! The TS app keeps the vault in browser IndexedDB, so the native app needs a
//! file format of its own. The document deliberately uses the *backup* shape
//! (`aegis-vault-backup`, see `lite version/src/vault/backup.ts`) plus an
//! optional `preferences` blob: a native `vault.json` therefore parses as a
//! TS backup and vice versa, with no converter in either direction.
//!
//! Writes are atomic: full document to `vault.json.tmp`, then a rename over
//! the real file, so a crash mid-write cannot corrupt the vault.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::crypto::VaultHeader;
use crate::error::VaultError;
use crate::model::StoredItem;
use crate::util::now_iso;

/// On-disk marker. Kept as `aegis-vault-backup` so backups written by earlier
/// builds still import after the rename to Colax.
pub const BACKUP_FORMAT: &str = "aegis-vault-backup";
pub const BACKUP_VERSION: u32 = 1;

/// The vault document — the on-disk file and the exportable backup are the
/// same shape. Field order matches `BackupFile` in TS.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackupFile {
    pub format: String,
    pub version: u32,
    pub exported_at: String,
    pub header: VaultHeader,
    pub items: Vec<StoredItem>,
    /// Native-only: the app's preferences ride along in the same file. TS
    /// backups lack the key entirely; TS `parseBackup` never looks at it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preferences: Option<Value>,
}

impl BackupFile {
    pub fn new(header: VaultHeader, items: Vec<StoredItem>) -> Self {
        BackupFile {
            format: BACKUP_FORMAT.into(),
            version: BACKUP_VERSION,
            exported_at: now_iso(),
            header,
            items,
            preferences: None,
        }
    }
}

/// Validates and parses a backup document, mirroring `parseBackup` in
/// `lite version/src/vault/backup.ts`, error texts included.
pub fn parse_backup(text: &str) -> Result<BackupFile, VaultError> {
    let parsed: Value = serde_json::from_str(text)
        .map_err(|_| VaultError::Backup("That file is not valid JSON.".into()))?;
    if !parsed.is_object() {
        return Err(VaultError::Backup(
            "That file is not a vault backup.".into(),
        ));
    }
    if parsed.get("format").and_then(Value::as_str) != Some(BACKUP_FORMAT) {
        return Err(VaultError::Backup(
            "That file is not a Colax vault backup.".into(),
        ));
    }
    let has_header = matches!(parsed.get("header"), Some(header) if !header.is_null());
    let items_is_array = matches!(parsed.get("items"), Some(Value::Array(_)));
    if !has_header || !items_is_array {
        return Err(VaultError::Backup("The backup file is incomplete.".into()));
    }
    serde_json::from_value(parsed)
        .map_err(|e| VaultError::Backup(format!("The backup file is incomplete. ({e})")))
}

/// Pretty-prints a backup, matching `JSON.stringify(backup, null, 2)`.
pub fn serialize_backup(backup: &BackupFile) -> Result<String, VaultError> {
    serde_json::to_string_pretty(backup)
        .map_err(|e| VaultError::Json(format!("Could not encode the backup: {e}")))
}

/// Loads, saves and clears the vault document at a fixed path.
#[derive(Debug, Clone)]
pub struct VaultStorage {
    path: PathBuf,
}

impl VaultStorage {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        VaultStorage { path: path.into() }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Reads the document, or `None` when there is no vault yet.
    pub fn load(&self) -> Result<Option<BackupFile>, VaultError> {
        let text = match fs::read_to_string(&self.path) {
            Ok(text) => text,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(err) => {
                return Err(VaultError::Storage(format!(
                    "Could not read the vault file: {err}"
                )))
            }
        };
        parse_backup(&text).map(Some).map_err(|_| {
            VaultError::Storage(format!(
                "The vault file at {} is damaged.",
                self.path.display()
            ))
        })
    }

    /// Atomically replaces the document.
    pub fn save(&self, doc: &BackupFile) -> Result<(), VaultError> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|err| {
                VaultError::Storage(format!("Could not create the vault folder: {err}"))
            })?;
        }
        let text = serialize_backup(doc)?;
        let mut tmp_name = self.path.as_os_str().to_owned();
        tmp_name.push(".tmp");
        let tmp = PathBuf::from(tmp_name);

        let mut file = fs::File::create(&tmp)
            .map_err(|err| VaultError::Storage(format!("Could not write the vault file: {err}")))?;
        file.write_all(text.as_bytes())
            .and_then(|()| file.sync_all())
            .map_err(|err| VaultError::Storage(format!("Could not write the vault file: {err}")))?;
        drop(file);
        fs::rename(&tmp, &self.path).map_err(|err| {
            let _ = fs::remove_file(&tmp);
            VaultError::Storage(format!("Could not replace the vault file: {err}"))
        })
    }

    /// Removes the document entirely ("reset vault").
    pub fn clear(&self) -> Result<(), VaultError> {
        match fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(VaultError::Storage(format!(
                "Could not reset the vault: {err}"
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::{create_device_header, VaultKeyHandle};

    fn temp_path(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("colax-core-storage-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        dir.join(format!("{tag}.json"))
    }

    #[test]
    fn missing_file_loads_as_none() {
        let storage = VaultStorage::new(temp_path("missing"));
        let _ = fs::remove_file(storage.path());
        assert!(storage.load().unwrap().is_none());
        storage.clear().unwrap(); // idempotent
    }

    #[test]
    fn round_trip_preserves_header_items_and_preferences() {
        let storage = VaultStorage::new(temp_path("round-trip"));
        let _ = fs::remove_file(storage.path());

        let handle = VaultKeyHandle::generate();
        let mut doc = BackupFile::new(create_device_header(&handle), vec![]);
        doc.items.push(StoredItem {
            id: "item-1".into(),
            blob: crate::crypto::SealedBlob {
                iv: "AQIDBAUGBwgJCgsM".into(),
                ct: "AAAA".into(),
            },
            updated_at: 1_700_000_000_000,
        });
        doc.preferences = Some(serde_json::json!({ "clearClipboardSeconds": 30 }));

        storage.save(&doc).unwrap();
        let loaded = storage.load().unwrap().expect("document exists");
        assert_eq!(loaded.format, BACKUP_FORMAT);
        assert_eq!(loaded.items.len(), 1);
        assert_eq!(loaded.items[0].id, "item-1");
        assert_eq!(loaded.preferences, doc.preferences);

        // No stray .tmp left behind.
        let mut tmp_name = storage.path().as_os_str().to_owned();
        tmp_name.push(".tmp");
        assert!(!PathBuf::from(tmp_name).exists());

        storage.clear().unwrap();
        assert!(storage.load().unwrap().is_none());
    }

    #[test]
    fn damaged_file_is_an_error_not_a_silent_vault() {
        let storage = VaultStorage::new(temp_path("damaged"));
        fs::write(storage.path(), "{ not json").unwrap();
        let err = storage.load().unwrap_err();
        assert!(matches!(err, VaultError::Storage(_)), "got {err:?}");
        fs::remove_file(storage.path()).unwrap();
    }
}
