//! Storage, encryption and CSV interchange.
//!
//! The native vault lives in its own file so installing either edition never
//! touches the other's data:
//!
//! * `%APPDATA%\Colax Native\vault.json` — passwordless vault, or shell settings
//! * `%APPDATA%\Colax Native\vault.locked.json` — AES-256-GCM wrapper
//!
//! The encrypted envelope is PBKDF2-style in spirit but uses Argon2id, which is
//! the current best practice for a password-derived key. Everything else — the
//! record shape, the CSV columns — matches the Electron edition.

use crate::model::{new_id, now_ms, VaultData, VaultItem};
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::Argon2;
use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

pub fn data_dir() -> PathBuf {
    if let Ok(appdata) = std::env::var("APPDATA") {
        return PathBuf::from(appdata).join("Colax Native");
    }
    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home).join(".local/share/colax-native");
    }
    PathBuf::from(".")
}

pub fn vault_path() -> PathBuf {
    data_dir().join("vault.json")
}

pub fn locked_path() -> PathBuf {
    data_dir().join("vault.locked.json")
}

pub enum LoadOutcome {
    Missing,
    /// The file is encrypted; the plaintext travels no further until unlocked.
    Locked { envelope: String },
    Unlocked(VaultData),
}

#[derive(Serialize, Deserialize)]
struct Envelope {
    format: String,
    encrypted: bool,
    salt: String,
    nonce: String,
    ciphertext: String,
}

pub fn load() -> Result<LoadOutcome, String> {
    if let Ok(text) = fs::read_to_string(locked_path()) {
        return Ok(LoadOutcome::Locked { envelope: text });
    }
    match fs::read_to_string(vault_path()) {
        Ok(text) => {
            let data: VaultData =
                serde_json::from_str(&text).map_err(|error| format!("vault.json is not readable: {error}"))?;
            Ok(LoadOutcome::Unlocked(data))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(LoadOutcome::Missing),
        Err(error) => Err(format!("could not read vault.json: {error}")),
    }
}

/// Writes atomically: a full temp file is renamed over the old one so a crash
/// mid-write cannot leave a half vault.
pub fn save(data: &VaultData, password: Option<&str>) -> Result<(), String> {
    let dir = data_dir();
    fs::create_dir_all(&dir).map_err(|error| format!("could not create {}: {error}", dir.display()))?;
    match password.filter(|value| !value.is_empty()) {
        Some(password) => {
            let sealed = seal(data, password)?;
            let temp = dir.join("vault.locked.json.tmp");
            fs::write(&temp, sealed).map_err(|error| format!("could not write the vault: {error}"))?;
            fs::rename(&temp, locked_path()).map_err(|error| format!("could not replace the vault: {error}"))?;
            let _ = fs::remove_file(vault_path());
        }
        None => {
            let text = serde_json::to_string_pretty(data).map_err(|error| error.to_string())?;
            let temp = dir.join("vault.json.tmp");
            fs::write(&temp, text).map_err(|error| format!("could not write the vault: {error}"))?;
            fs::rename(&temp, vault_path()).map_err(|error| format!("could not replace the vault: {error}"))?;
            let _ = fs::remove_file(locked_path());
        }
    }
    Ok(())
}

fn derive_key(password: &str, salt: &[u8]) -> Result<[u8; 32], String> {
    let mut key = [0u8; 32];
    Argon2::default()
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|error| format!("could not derive a key: {error}"))?;
    Ok(key)
}

pub fn seal(data: &VaultData, password: &str) -> Result<String, String> {
    let mut salt = [0u8; 16];
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut salt);
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let key = derive_key(password, &salt)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|error| error.to_string())?;
    let plaintext = serde_json::to_vec(data).map_err(|error| error.to_string())?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plaintext.as_ref())
        .map_err(|_| "encryption failed".to_string())?;
    let envelope = Envelope {
        format: "colax-native-vault".into(),
        encrypted: true,
        salt: STANDARD.encode(salt),
        nonce: STANDARD.encode(nonce_bytes),
        ciphertext: STANDARD.encode(ciphertext),
    };
    serde_json::to_string_pretty(&envelope).map_err(|error| error.to_string())
}

pub fn unlock(envelope: &str, password: &str) -> Result<VaultData, String> {
    let parsed: Envelope = serde_json::from_str(envelope).map_err(|_| "that file is not a Colax vault".to_string())?;
    if parsed.format != "colax-native-vault" {
        return Err("that file was written by a different app".into());
    }
    let salt = STANDARD.decode(parsed.salt).map_err(|_| "damaged salt".to_string())?;
    let nonce = STANDARD.decode(parsed.nonce).map_err(|_| "damaged nonce".to_string())?;
    let ciphertext = STANDARD.decode(parsed.ciphertext).map_err(|_| "damaged ciphertext".to_string())?;
    let key = derive_key(password, &salt)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|error| error.to_string())?;
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| "That password does not open this vault".to_string())?;
    serde_json::from_slice(&plaintext).map_err(|error| format!("the decrypted vault is not readable: {error}"))
}

/* ---- CSV ----------------------------------------------------------------- */

const CSV_HEADER: [&str; 6] = ["Title", "Url", "Username", "Password", "Notes", "Tags"];

fn quote_cell(value: &str) -> String {
    let needs_quotes = value.contains([',', '"', '\n', '\r']);
    let escaped = value.replace('"', "\"\"");
    if needs_quotes {
        format!("\"{escaped}\"")
    } else {
        escaped
    }
}

/// Text-only export: credentials, notes and tag names. Images and TOTP seeds are
/// deliberately not part of a plain-text file.
pub fn csv_export(data: &VaultData) -> String {
    let mut output = String::from("\u{feff}");
    output.push_str(&CSV_HEADER.join(","));
    output.push_str("\r\n");
    for item in &data.items {
        let tags = data.tag_names(item).join("; ");
        let cells = [
            item.title.clone(),
            item.url.clone(),
            item.username.clone(),
            item.password.clone(),
            item.notes.clone(),
            tags,
        ];
        output.push_str(
            &cells
                .iter()
                .map(|cell| quote_cell(cell))
                .collect::<Vec<_>>()
                .join(","),
        );
        output.push_str("\r\n");
    }
    output
}

/// RFC 4180 parsing: a quote only opens a field at its start, and a doubled
/// quote inside a quoted field is one literal quote. Multiline notes therefore
/// stay in one cell instead of becoming extra logins.
pub fn parse_csv(text: &str) -> Vec<Vec<String>> {
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut field_started = false;
    let mut chars = text.trim_start_matches('\u{feff}').chars().peekable();

    while let Some(character) = chars.next() {
        if quoted {
            if character == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    field.push('"');
                } else {
                    quoted = false;
                }
            } else {
                field.push(character);
            }
            continue;
        }
        match character {
            '"' if !field_started => {
                quoted = true;
                field_started = true;
            }
            ',' => {
                row.push(std::mem::take(&mut field));
                field_started = false;
            }
            '\r' => {}
            '\n' => {
                row.push(std::mem::take(&mut field));
                rows.push(std::mem::take(&mut row));
                field_started = false;
            }
            other => {
                field.push(other);
                field_started = true;
            }
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows
}

/// Imports rows that carry a title or username and a password. Existing
/// title+username pairs are skipped instead of duplicated, so importing the same
/// file twice is harmless.
pub fn csv_import(text: &str, data: &mut VaultData) -> usize {
    let rows = parse_csv(text);
    let Some(header) = rows.first() else { return 0 };
    let column = |names: &[&str]| -> Option<usize> {
        header.iter().position(|cell| {
            let cell = cell.trim().to_lowercase();
            names.iter().any(|name| cell == *name)
        })
    };
    let title_at = column(&["title", "name"]);
    let url_at = column(&["url", "website", "site"]);
    let user_at = column(&["username", "login", "email", "user"]);
    let password_at = column(&["password", "pass"]);
    let notes_at = column(&["notes", "note"]);
    let tags_at = column(&["tags", "tag", "folder"]);
    let Some(password_at) = password_at else { return 0 };
    let existing: std::collections::HashSet<String> = data
        .items
        .iter()
        .map(|item| format!("{}\u{1}{}", item.title.to_lowercase(), item.username.to_lowercase()))
        .collect();
    let mut imported = 0;
    for row in rows.iter().skip(1) {
        let get = |index: Option<usize>| index.and_then(|index| row.get(index)).cloned().unwrap_or_default();
        let title = get(title_at).trim().to_string();
        let username = get(user_at).trim().to_string();
        let password = get(Some(password_at));
        if title.is_empty() && username.is_empty() {
            continue;
        }
        let key = format!("{}\u{1}{}", title.to_lowercase(), username.to_lowercase());
        if existing.contains(&key) {
            continue;
        }
        let tags: Vec<String> = get(tags_at)
            .split([';', ','])
            .map(|tag| tag.trim())
            .filter(|tag| !tag.is_empty())
            .map(|tag| data.prefs.ensure_tag(tag))
            .collect();
        let mut item = VaultItem {
            id: new_id("login"),
            title: if title.is_empty() { username.clone() } else { title },
            url: get(url_at).trim().to_string(),
            username,
            password,
            notes: get(notes_at),
            tags,
            created_at: now_ms(),
            updated_at: now_ms(),
            ..Default::default()
        };
        if !item.url.is_empty() && !item.url.contains("://") {
            item.url = format!("https://{}", item.url);
        }
        data.items.push(item);
        imported += 1;
    }
    imported
}

/// Size of the vault file in kilobytes, for Settings › Data.
pub fn vault_kb(data: &VaultData) -> u64 {
    serde_json::to_string(data).map(|text| text.len() as u64 / 1024).unwrap_or(0)
}
