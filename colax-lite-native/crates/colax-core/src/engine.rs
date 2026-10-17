//! The vault engine: create, unlock, lock, CRUD, password changes, backup
//! import/export. A framework-free port of `VaultService` from
//! `lite version/src/vault/vault-service.ts`, synchronous because there is no
//! browser API to await.
//!
//! In-memory state mirrors the TS service:
//!   - `handle`: the vault key while unlocked, `None` while locked
//!   - `items`: plaintext logins, empty unless unlocked
//!   - `header`/`stored`/`preferences`: the document as it exists on disk,
//!     so saves never have to re-read it

use serde_json::{json, Value};

use crate::crypto::{
    create_device_header, create_password_header, open_item, open_vault_key, rewrap_vault_key,
    seal_item, VaultHeader, VaultKeyHandle, VaultProtection, PBKDF2_ITERATIONS,
};
use crate::error::VaultError;
use crate::model::{
    empty_item, item_to_value, normalise_item, normalize_url, overlay, StoredItem, VaultItem,
};
use crate::storage::{parse_backup, serialize_backup, BackupFile, VaultStorage};
use crate::util::{now_iso, now_ms};

pub struct VaultEngine {
    storage: VaultStorage,
    handle: Option<VaultKeyHandle>,
    /// Plaintext items; empty unless unlocked.
    items: Vec<VaultItem>,
    /// The document header; `None` when this device has no vault yet.
    header: Option<VaultHeader>,
    /// Ciphertext records as they exist on disk.
    stored: Vec<StoredItem>,
    /// Opaque app preferences. Applied in full by the settings UI in a later
    /// phase; the engine only round-trips them (`{}` until then, since the TS
    /// defaults live in UI-only code).
    preferences: Value,
    /// PBKDF2 iterations used for headers this engine *writes*. Reads always
    /// honour the iteration count stored in the header itself. Overridable so
    /// tests are not dominated by 600k-iteration derivations.
    pub kdf_iterations: u32,
}

impl VaultEngine {
    /// Opens the engine over a storage location, loading the document once.
    pub fn open(storage: VaultStorage) -> Result<Self, VaultError> {
        let (header, stored, preferences) = match storage.load()? {
            Some(doc) => (
                Some(doc.header),
                doc.items,
                doc.preferences.unwrap_or_else(|| json!({})),
            ),
            None => (None, Vec::new(), json!({})),
        };
        Ok(VaultEngine {
            storage,
            handle: None,
            items: Vec::new(),
            header,
            stored,
            preferences,
            kdf_iterations: PBKDF2_ITERATIONS,
        })
    }

    pub fn exists(&self) -> bool {
        self.header.is_some()
    }

    /// How this vault is protected, or `None` if there is no vault yet.
    pub fn protection(&self) -> Result<Option<VaultProtection>, VaultError> {
        match &self.header {
            None => Ok(None),
            Some(header) => Ok(Some(crate::crypto::resolve_header(header)?.protection)),
        }
    }

    pub fn is_unlocked(&self) -> bool {
        self.handle.is_some()
    }

    /// Plaintext items, or `None` while locked.
    pub fn items(&self) -> Option<&[VaultItem]> {
        if self.handle.is_some() {
            Some(&self.items)
        } else {
            None
        }
    }

    pub fn preferences(&self) -> &Value {
        &self.preferences
    }

    /// Stores preferences (and persists them once a vault exists).
    pub fn save_preferences(&mut self, prefs: Value) -> Result<(), VaultError> {
        self.preferences = prefs;
        if self.header.is_some() {
            self.save_document()?;
        }
        Ok(())
    }

    /// Creates a new vault. `None` makes it passwordless, which the app
    /// offers by default; the password can be added later in settings.
    pub fn create(&mut self, master_password: Option<&str>) -> Result<(), VaultError> {
        if self.header.is_some() {
            return Err(VaultError::Exists);
        }
        let handle = VaultKeyHandle::generate();
        let header = match master_password {
            Some(password) => create_password_header(password, &handle, self.kdf_iterations)?,
            None => create_device_header(&handle),
        };
        self.header = Some(header);
        self.stored = Vec::new();
        self.items = Vec::new();
        self.save_document()?;
        self.handle = Some(handle);
        Ok(())
    }

    /// Opens the vault.
    ///
    /// For a passwordless vault any input is ignored and this succeeds. An
    /// `Err(VaultAuthError)` from the header becomes a quiet `Ok(false)` so
    /// the UI stays silent about the reason; anything else (damaged header,
    /// missing vault) propagates as an error, exactly as in TS.
    pub fn unlock(&mut self, master_password: &str) -> Result<bool, VaultError> {
        let doc = self.storage.load()?.ok_or(VaultError::NoVault)?;
        let handle = match open_vault_key(&doc.header, master_password) {
            Ok(handle) => handle,
            Err(VaultError::Auth) => return Ok(false),
            Err(err) => return Err(err),
        };
        // Commit only after the key opened, so a failed attempt leaves an
        // already-unlocked engine untouched (as in TS).
        self.header = Some(doc.header);
        self.stored = doc.items;
        if let Some(preferences) = doc.preferences {
            self.preferences = preferences;
        }
        self.items = self.decrypt_all(&handle);
        self.handle = Some(handle);
        Ok(true)
    }

    /// Locks the vault: scrubs the key and drops all plaintext.
    pub fn lock(&mut self) {
        if let Some(mut handle) = self.handle.take() {
            handle.destroy();
        }
        self.items.clear();
    }

    fn decrypt_all(&self, handle: &VaultKeyHandle) -> Vec<VaultItem> {
        let now = now_ms();
        self.stored
            .iter()
            .filter_map(|record| {
                // A record that will not decrypt is corrupt or was tampered
                // with. Skip it rather than refusing to open the whole vault.
                let value: Value = open_item(handle, &record.id, &record.blob).ok()?;
                Some(normalise_item(&value, now))
            })
            .collect()
    }

    fn require_handle(&self) -> Result<&VaultKeyHandle, VaultError> {
        self.handle.as_ref().ok_or(VaultError::Locked)
    }

    fn require_header(&self) -> Result<&VaultHeader, VaultError> {
        self.header.as_ref().ok_or(VaultError::NoVault)
    }

    fn save_document(&self) -> Result<(), VaultError> {
        let doc = BackupFile {
            format: crate::storage::BACKUP_FORMAT.into(),
            version: crate::storage::BACKUP_VERSION,
            exported_at: now_iso(),
            header: self.require_header()?.clone(),
            items: self.stored.clone(),
            preferences: match &self.preferences {
                Value::Object(map) if map.is_empty() => None,
                Value::Null => None,
                other => Some(other.clone()),
            },
        };
        self.storage.save(&doc)
    }

    /// Seals one item, writes the document, and updates the plaintext set.
    fn persist(&mut self, item: VaultItem) -> Result<VaultItem, VaultError> {
        let handle = self.require_handle()?;
        let mut updated = item;
        updated.url = normalize_url(&updated.url);
        let blob = seal_item(handle, &updated.id, &updated)?;

        let record = StoredItem {
            id: updated.id.clone(),
            blob,
            updated_at: updated.updated_at,
        };
        match self
            .stored
            .iter_mut()
            .find(|existing| existing.id == record.id)
        {
            Some(slot) => *slot = record,
            None => self.stored.push(record),
        }
        self.save_document()?;

        match self
            .items
            .iter_mut()
            .find(|existing| existing.id == updated.id)
        {
            Some(slot) => *slot = updated.clone(),
            None => self.items.push(updated.clone()),
        }
        Ok(updated)
    }

    /// Adds a login from a draft object (JSON-spread over `emptyItem`, as in TS).
    pub fn add_item(&mut self, draft: &Value) -> Result<VaultItem, VaultError> {
        let now = now_ms();
        let id = new_item_id();
        let merged = overlay(&item_to_value(&empty_item(&id, now)), draft);
        let item = normalise_item(&merged, now);
        self.persist(item)
    }

    /// Writes a login back exactly as it was, id included (History's Restore).
    pub fn restore_item(&mut self, item: &VaultItem) -> Result<VaultItem, VaultError> {
        let now = now_ms();
        let created = if item.created_at == 0 {
            now
        } else {
            item.created_at
        };
        let value = item_to_value(item);
        let item = normalise_item(&value, created);
        self.persist(item)
    }

    /// Applies a partial update (JSON-spread over the current record) and
    /// stamps `updatedAt`. Password/username change times are only moved when
    /// that field actually changed, and never backwards.
    pub fn update_item(&mut self, id: &str, patch: &Value) -> Result<VaultItem, VaultError> {
        let current = self
            .items
            .iter()
            .find(|item| item.id == id)
            .ok_or(VaultError::MissingItem)?
            .clone();

        let now = now_ms();
        let mut merged = overlay(&item_to_value(&current), patch);
        if let Some(obj) = merged.as_object_mut() {
            obj.insert("id".into(), json!(id));
        }
        let mut next = normalise_item(&merged, now);
        next.id = id.to_string();
        next.updated_at = now;

        let patch_obj = patch.as_object();
        let has = |key: &str| patch_obj.is_some_and(|p| p.contains_key(key));
        let changed = |key: &str, before: &str| {
            patch_obj
                .and_then(|p| p.get(key))
                .and_then(Value::as_str)
                .is_some_and(|after| after != before)
        };

        if has("password") && changed("password", &current.password) {
            next.password_updated_at = patch_obj
                .and_then(|p| p.get("passwordUpdatedAt"))
                .and_then(Value::as_i64)
                .unwrap_or(now);
        } else if !has("passwordUpdatedAt") {
            next.password_updated_at = current.password_updated_at;
        }

        if has("username") && changed("username", &current.username) {
            next.username_updated_at = patch_obj
                .and_then(|p| p.get("usernameUpdatedAt"))
                .and_then(Value::as_i64)
                .unwrap_or(now);
        } else if !has("usernameUpdatedAt") {
            next.username_updated_at = current.username_updated_at;
        }

        self.persist(next)
    }

    /// Flips the attention flag without touching `updatedAt`: the untouched-
    /// login scan flags by age, so stamping would reset the very clock it read.
    pub fn set_attention(&mut self, id: &str, value: bool) -> Result<(), VaultError> {
        let current = self
            .items
            .iter()
            .find(|item| item.id == id)
            .ok_or(VaultError::MissingItem)?
            .clone();
        if current.needs_attention == value {
            return Ok(());
        }
        let mut next = current;
        next.needs_attention = value;
        self.persist(next)?;
        Ok(())
    }

    pub fn delete_item(&mut self, id: &str) -> Result<(), VaultError> {
        self.require_handle()?;
        self.stored.retain(|record| record.id != id);
        self.items.retain(|item| item.id != id);
        self.save_document()
    }

    /// Replaces the whole item set in one go, for undo and redo. Ids missing
    /// from `items` are deleted.
    pub fn replace_items(&mut self, items: Vec<VaultItem>) -> Result<(), VaultError> {
        let handle = self.require_handle()?;
        let mut stored = Vec::with_capacity(items.len());
        let mut plaintext = Vec::with_capacity(items.len());
        for item in items {
            let mut normalized = item;
            normalized.url = normalize_url(&normalized.url);
            let blob = seal_item(handle, &normalized.id, &normalized)?;
            stored.push(StoredItem {
                id: normalized.id.clone(),
                blob,
                updated_at: normalized.updated_at,
            });
            plaintext.push(normalized);
        }
        self.stored = stored;
        self.items = plaintext;
        self.save_document()
    }

    /// Re-wraps the vault key under a new password. Only valid on a password
    /// vault; the current password is re-checked before anything is written.
    pub fn change_master_password(
        &mut self,
        current_password: &str,
        next_password: &str,
    ) -> Result<(), VaultError> {
        let handle = self.require_handle()?;
        let header = self.require_header()?.clone();
        if crate::crypto::resolve_header(&header)?.protection != VaultProtection::Password {
            return Err(VaultError::NoPassword);
        }
        // Re-check the current password before writing anything.
        drop(open_vault_key(&header, current_password)?);
        let next = rewrap_vault_key(handle, next_password, self.kdf_iterations)?;
        self.header = Some(next);
        self.save_document()
    }

    /// Turns a passwordless vault into a password-protected one. Only the
    /// 32-byte vault key is wrapped, so existing logins stay encrypted under
    /// the same key and nothing is re-encrypted.
    pub fn enable_password(&mut self, new_password: &str) -> Result<(), VaultError> {
        let handle = self.require_handle()?;
        let next = create_password_header(new_password, handle, self.kdf_iterations)?;
        self.header = Some(next);
        self.save_document()
    }

    /// Removes the password requirement; the vault key is then stored directly.
    pub fn disable_password(&mut self, current_password: &str) -> Result<(), VaultError> {
        let handle = self.require_handle()?;
        let header = self.require_header()?.clone();
        if crate::crypto::resolve_header(&header)?.protection != VaultProtection::Password {
            return Err(VaultError::HasNoPassword);
        }
        // Prove the current password before dropping the protection.
        drop(open_vault_key(&header, current_password)?);
        self.header = Some(create_device_header(handle));
        self.save_document()
    }

    /// Wipes the vault from this device.
    pub fn reset(&mut self) -> Result<(), VaultError> {
        self.lock();
        self.storage.clear()?;
        self.header = None;
        self.stored = Vec::new();
        self.preferences = json!({});
        Ok(())
    }

    /// Ciphertext-only snapshot for backup. Safe to write to disk as-is.
    pub fn export_backup(&self) -> Result<BackupFile, VaultError> {
        self.build_backup(true)
    }

    /// The same snapshot with the app's own settings left out: the vault and
    /// its logins only, which is the file the web build writes. `false` here
    /// is what Settings › Backup's "Include settings and layout" switch turns
    /// off; a backup without the blob restores over a device's own settings
    /// rather than replacing them (see `restore_backup`).
    pub fn build_backup(&self, include_preferences: bool) -> Result<BackupFile, VaultError> {
        Ok(BackupFile {
            format: crate::storage::BACKUP_FORMAT.into(),
            version: crate::storage::BACKUP_VERSION,
            exported_at: now_iso(),
            header: self.require_header()?.clone(),
            items: self.stored.clone(),
            // Preferences ride along in the backup: the TS build writes them,
            // and dropping them here made a restore lose the user's theme.
            preferences: include_preferences.then(|| self.preferences.clone()),
        })
    }

    /// Installs a backup on this device, replacing any existing vault and
    /// leaving the engine unlocked.
    ///
    /// `new_password` re-keys the vault; `None` preserves whatever protection
    /// the backup had, and `Some("")` restores it passwordless.
    pub fn restore_backup(
        &mut self,
        backup: &BackupFile,
        backup_password: Option<&str>,
        new_password: Option<&str>,
    ) -> Result<(), VaultError> {
        if backup.format != crate::storage::BACKUP_FORMAT {
            return Err(VaultError::NotABackup);
        }
        // Opening the backup is the password check: it either yields the
        // vault key or fails.
        let handle = open_vault_key(&backup.header, backup_password.unwrap_or(""))?;

        let header = match new_password {
            None => match crate::crypto::resolve_header(&backup.header)?.protection {
                VaultProtection::Password => {
                    rewrap_vault_key(&handle, backup_password.unwrap_or(""), self.kdf_iterations)?
                }
                VaultProtection::Device => create_device_header(&handle),
            },
            Some("") => create_device_header(&handle),
            Some(password) => rewrap_vault_key(&handle, password, self.kdf_iterations)?,
        };

        self.header = Some(header);
        self.stored = backup.items.clone();
        if let Some(prefs) = &backup.preferences {
            self.preferences = prefs.clone();
        }
        self.save_document()?;
        self.items = self.decrypt_all(&handle);
        self.handle = Some(handle);
        Ok(())
    }

    /// The document as a pretty JSON string (what the export UI writes).
    pub fn export_backup_json(&self) -> Result<String, VaultError> {
        self.export_backup_json_with(true, None)
    }

    /// The export UI's one entry point: whether the settings blob travels,
    /// and whether the file is re-wrapped under a password first.
    ///
    /// `password` re-wraps the header so the file is protected rather than
    /// relying on this device's protection. The vault key itself never
    /// changes, so every item ciphertext stays valid — the settings sheet's
    /// "Protect this backup" export.
    ///
    /// The TS export re-opens the backup's own header with an empty password
    /// first, which works for a device vault but fails once a vault password
    /// is set; the session handle does the same job in both cases.
    pub fn export_backup_json_with(
        &self,
        include_preferences: bool,
        password: Option<&str>,
    ) -> Result<String, VaultError> {
        let mut backup = self.build_backup(include_preferences)?;
        if let Some(password) = password {
            backup.header = rewrap_vault_key(self.require_handle()?, password, self.kdf_iterations)?;
        }
        serialize_backup(&backup)
    }

    /// The same document, its header re-wrapped under `password`. Kept for
    /// the callers that always want the settings to travel (the walk, the
    /// tests) and for the reading order of the two flags.
    pub fn export_backup_json_with_password(&self, password: &str) -> Result<String, VaultError> {
        self.export_backup_json_with(true, Some(password))
    }
}

/// Checks a backup can be opened, without writing anything. Passwordless
/// backups always verify.
pub fn verify_backup_password(backup: &BackupFile, password: Option<&str>) -> bool {
    open_vault_key(&backup.header, password.unwrap_or("")).is_ok()
}

/// Parses a backup from text and verifies it in one step.
pub fn load_backup(text: &str) -> Result<BackupFile, VaultError> {
    parse_backup(text)
}

/// Fresh item id — `crypto.randomUUID()` (a v4 UUID) as in TS.
pub fn new_item_id() -> String {
    uuid::Uuid::new_v4().to_string()
}
