//! Vault cryptography — a byte-compatible port of
//! `lite version/src/crypto/vault-crypto.ts`.
//!
//! Zero-knowledge design: the master password never leaves this module, and no
//! verifier derived from it is ever stored. Unlocking works purely by proving
//! you can decrypt the vault key.
//!
//!   master password --PBKDF2--> KEK --unwraps--> VEK --AES-GCM--> items
//!
//! The split matters. The VEK (vault encryption key) is a random 256-bit key
//! that does all the real work, so changing the master password only re-wraps
//! 32 bytes instead of re-encrypting every item in the vault.

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use pbkdf2::pbkdf2_hmac;
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::bytes::{from_base64_url, random_bytes, to_base64_url};
use crate::error::VaultError;

pub const VAULT_FORMAT_VERSION: u32 = 1;

/// NIST SP 800-63B (2024) floor for PBKDF2-HMAC-SHA256. Stored per-vault so
/// it can be raised later.
pub const PBKDF2_ITERATIONS: u32 = 600_000;

const KEY_BYTES: usize = 32;
const SALT_BYTES: usize = 16;
const IV_BYTES: usize = 12; // 96-bit nonce, the size AES-GCM is specified for.

/// Domain separation: a wrapped key can never be replayed as an item, or vice versa.
const AAD_WRAP: &[u8] = b"aegis.vault.v1.wrap";
const AAD_ITEM: &[u8] = b"aegis.vault.v1.item";

/// Per-item associated data binds a ciphertext to its own id, so a record
/// cannot be silently moved to another row and decrypted there.
fn item_aad(id: &str) -> Vec<u8> {
    let mut aad = Vec::with_capacity(AAD_ITEM.len() + 1 + id.len());
    aad.extend_from_slice(AAD_ITEM);
    aad.push(b':');
    aad.extend_from_slice(id.as_bytes());
    aad
}

/// What actually sits on disk for one record: id in the clear, the rest as
/// ciphertext.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct SealedBlob {
    /// base64url 96-bit nonce
    pub iv: String,
    /// base64url ciphertext with the appended GCM tag
    pub ct: String,
}

/// How the vault key is protected.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum VaultProtection {
    /// The key is wrapped with a KEK derived from the master password.
    Password,
    /// The key is stored as-is; the vault opens without typing anything.
    Device,
}

/// The vault header as stored in the backup/vault document.
///
/// Field presence and JSON shape match `VaultHeader` in TS exactly, including
/// `deviceKey` and `wrapped: null` on passwordless vaults. Optional fields
/// exist because legacy headers predate them.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VaultHeader {
    #[serde(default = "default_format_version")]
    pub v: u32,
    /// Absent on vaults written before protection was optional; treated as
    /// `password`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protection: Option<VaultProtection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kdf: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iterations: Option<u32>,
    /// base64url 16-byte salt
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub salt: Option<String>,
    /// The vault key, encrypted under a key derived from the master password.
    /// Serialized as `null` (never skipped) on device vaults, as in TS.
    #[serde(default)]
    pub wrapped: Option<SealedBlob>,
    /// Present when protection is `device`. base64url raw vault key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_key: Option<String>,
}

fn default_format_version() -> u32 {
    VAULT_FORMAT_VERSION
}

/// Header shape after normalisation, with legacy defaults filled in.
#[derive(Debug)]
pub struct ResolvedVaultHeader {
    pub v: u32,
    pub protection: VaultProtection,
    pub iterations: u32,
    pub salt: String,
    pub wrapped: Option<SealedBlob>,
    pub device_key: Option<String>,
}

/// Fills in defaults and upgrades legacy headers.
///
/// A header with no `protection` field predates optional passwords and always
/// had a wrapped key, so it resolves to `password`. Throws on a header that is
/// genuinely unreadable rather than silently treating it as passwordless.
pub fn resolve_header(header: &VaultHeader) -> Result<ResolvedVaultHeader, VaultError> {
    let protection = header.protection.unwrap_or(VaultProtection::Password);
    let resolved = ResolvedVaultHeader {
        v: header.v,
        protection,
        iterations: header.iterations.unwrap_or(PBKDF2_ITERATIONS),
        salt: header.salt.clone().unwrap_or_default(),
        wrapped: header.wrapped.clone(),
        device_key: header.device_key.clone(),
    };

    if protection == VaultProtection::Password
        && (resolved.wrapped.is_none() || resolved.salt.is_empty())
    {
        return Err(VaultError::DamagedHeader(
            "the wrapped vault key is missing.".into(),
        ));
    }
    if protection == VaultProtection::Device && resolved.device_key.is_none() {
        return Err(VaultError::DamagedHeader(
            "the device key is missing.".into(),
        ));
    }
    Ok(resolved)
}

/// Raw 256-bit vault key, held only in memory while the vault is unlocked.
///
/// The buffer is zeroized on drop, and `destroy` scrubs it early, mirroring
/// `destroyVaultKey` in TS.
pub struct VaultKeyHandle {
    raw: Zeroizing<Vec<u8>>,
}

impl VaultKeyHandle {
    /// A fresh random vault key.
    pub fn generate() -> Self {
        Self {
            raw: Zeroizing::new(random_bytes(KEY_BYTES)),
        }
    }

    pub(crate) fn from_raw(raw: Vec<u8>) -> Self {
        Self {
            raw: Zeroizing::new(raw),
        }
    }

    pub fn raw(&self) -> &[u8] {
        &self.raw
    }

    /// Best-effort scrub of the raw vault key on lock. Drop zeroizes too, but
    /// an explicit call lets tests (and callers) observe it.
    pub fn destroy(&mut self) {
        self.raw.fill(0);
    }
}

impl std::fmt::Debug for VaultKeyHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("VaultKeyHandle(<redacted>)")
    }
}

fn aes_key(raw: &[u8]) -> Result<Aes256Gcm, VaultError> {
    if raw.len() != KEY_BYTES {
        return Err(VaultError::Corrupt(
            "A vault key has the wrong length.".into(),
        ));
    }
    Aes256Gcm::new_from_slice(raw)
        .map_err(|_| VaultError::Corrupt("A vault key has the wrong length.".into()))
}

fn seal_with_nonce(
    key: &[u8],
    nonce: &[u8; IV_BYTES],
    plaintext: &[u8],
    aad: &[u8],
) -> Result<SealedBlob, VaultError> {
    let cipher = aes_key(key)?;
    let ct = cipher
        .encrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| VaultError::Corrupt("Encryption failed.".into()))?;
    Ok(SealedBlob {
        iv: to_base64_url(nonce),
        ct: to_base64_url(&ct),
    })
}

fn seal(key: &[u8], plaintext: &[u8], aad: &[u8]) -> Result<SealedBlob, VaultError> {
    let mut nonce = [0u8; IV_BYTES];
    OsRng.fill_bytes(&mut nonce);
    seal_with_nonce(key, &nonce, plaintext, aad)
}

/// Decrypts a sealed blob. Every failure — bad base64, wrong key, tampered
/// ciphertext, short tag — collapses into `VaultAuthError` exactly as the
/// try/catch around WebCrypto's `decrypt` did in TS.
fn open(key: &[u8], blob: &SealedBlob, aad: &[u8]) -> Result<Vec<u8>, VaultError> {
    let iv = from_base64_url(&blob.iv).map_err(|_| VaultError::Auth)?;
    let ct = from_base64_url(&blob.ct).map_err(|_| VaultError::Auth)?;
    let nonce: [u8; IV_BYTES] = match iv.as_slice().try_into() {
        Ok(nonce) => nonce,
        Err(_) => return Err(VaultError::Auth),
    };
    let cipher = aes_key(key).map_err(|_| VaultError::Auth)?;
    cipher
        .decrypt(Nonce::from_slice(&nonce), Payload { msg: &ct, aad })
        .map_err(|_| VaultError::Auth)
}

/// PBKDF2-HMAC-SHA256, the only place a password touches a KDF.
fn derive_kek(master_password: &str, salt: &[u8], iterations: u32) -> Zeroizing<[u8; KEY_BYTES]> {
    let mut kek = [0u8; KEY_BYTES];
    pbkdf2_hmac::<Sha256>(master_password.as_bytes(), salt, iterations, &mut kek);
    Zeroizing::new(kek)
}

/// Builds a password-protected header. The caller keeps `handle` and must
/// persist the header.
pub fn create_password_header(
    master_password: &str,
    handle: &VaultKeyHandle,
    iterations: u32,
) -> Result<VaultHeader, VaultError> {
    let salt = random_bytes(SALT_BYTES);
    let kek = derive_kek(master_password, &salt, iterations);
    let wrapped = seal(&kek[..], handle.raw(), AAD_WRAP)?;
    Ok(VaultHeader {
        v: VAULT_FORMAT_VERSION,
        protection: Some(VaultProtection::Password),
        kdf: Some("PBKDF2-SHA256".into()),
        iterations: Some(iterations),
        salt: Some(to_base64_url(&salt)),
        wrapped: Some(wrapped),
        device_key: None,
    })
}

/// Builds a header that stores the vault key directly, so no password is
/// needed to open it.
pub fn create_device_header(handle: &VaultKeyHandle) -> VaultHeader {
    VaultHeader {
        v: VAULT_FORMAT_VERSION,
        protection: Some(VaultProtection::Device),
        kdf: Some("PBKDF2-SHA256".into()),
        iterations: Some(PBKDF2_ITERATIONS),
        salt: Some(String::new()),
        wrapped: None,
        device_key: Some(to_base64_url(handle.raw())),
    }
}

/// Opens a vault key from any header shape.
///
/// For a password vault this is also the password check: unwrapping either
/// succeeds or fails the GCM tag. For a device vault the key is read directly
/// and the password argument is ignored.
pub fn open_vault_key(
    header: &VaultHeader,
    master_password: &str,
) -> Result<VaultKeyHandle, VaultError> {
    let resolved = resolve_header(header)?;
    if resolved.protection == VaultProtection::Device {
        let device_key = resolved.device_key.unwrap_or_default();
        let raw = from_base64_url(&device_key)
            .map_err(|_| VaultError::DamagedHeader("the device key is not valid base64.".into()))?;
        if raw.len() != KEY_BYTES {
            return Err(VaultError::DamagedHeader(
                "the device key must be 256 bits.".into(),
            ));
        }
        return Ok(VaultKeyHandle::from_raw(raw));
    }

    let salt = from_base64_url(&resolved.salt)
        .map_err(|_| VaultError::DamagedHeader("the salt is not valid base64.".into()))?;
    let kek = derive_kek(master_password, &salt, resolved.iterations);
    let wrapped = resolved
        .wrapped
        .ok_or_else(|| VaultError::DamagedHeader("the wrapped vault key is missing.".into()))?;
    let raw = open(&kek[..], &wrapped, AAD_WRAP)?;
    if raw.len() != KEY_BYTES {
        return Err(VaultError::Corrupt(
            "The wrapped vault key has the wrong length.".into(),
        ));
    }
    Ok(VaultKeyHandle::from_raw(raw))
}

/// Re-wraps an already-unwrapped vault key under a new master password. Item
/// ciphertexts are untouched, so this is O(1) regardless of vault size.
pub fn rewrap_vault_key(
    handle: &VaultKeyHandle,
    new_master_password: &str,
    iterations: u32,
) -> Result<VaultHeader, VaultError> {
    create_password_header(new_master_password, handle, iterations)
}

/// Seals any serializable value as an item blob — `JSON.stringify` then
/// AES-GCM, with the item id bound in as associated data.
pub fn seal_item(
    handle: &VaultKeyHandle,
    item_id: &str,
    value: &impl Serialize,
) -> Result<SealedBlob, VaultError> {
    let plaintext = serde_json::to_string(value)
        .map_err(|e| VaultError::Json(format!("Could not encode the item: {e}")))?;
    seal(handle.raw(), plaintext.as_bytes(), &item_aad(item_id))
}

/// Opens an item blob produced by `seal_item` (or the TS original).
pub fn open_item<T: serde::de::DeserializeOwned>(
    handle: &VaultKeyHandle,
    item_id: &str,
    blob: &SealedBlob,
) -> Result<T, VaultError> {
    let plaintext = open(handle.raw(), blob, &item_aad(item_id))?;
    let text = String::from_utf8(plaintext)
        .map_err(|_| VaultError::Corrupt("An item's plaintext is not valid UTF-8.".into()))?;
    serde_json::from_str(&text)
        .map_err(|e| VaultError::Json(format!("Could not decode the item: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Fixture key, not a credential. Test vectors need *a* string and this is
    /// deliberately a build label rather than a passphrase anyone would use,
    /// so nothing in this repository reads as a password that has to be
    /// rotated. Regenerate it, the vector below and the TS fixture together
    /// with `scripts/make-ts-fixture.mjs`.
    const MASTER: &str = "colax-lite-fixture-key-v1";
    const KAT_ITERATIONS: u32 = 1000;

    /// Known-answer vector generated with Node's WebCrypto + `node:crypto` —
    /// the exact implementation the TS app used — by
    /// `scripts/make-ts-fixture.mjs`. Proves byte compatibility of PBKDF2,
    /// the wrap/item AADs, and AES-GCM in both directions.
    ///
    /// Fixed inputs:
    ///   password  = MASTER
    ///   iterations = 1000
    ///   salt      = 00112233445566778899aabbccddeeff
    ///   vek       = 0f0e0d0c0b0a09080706050403020100ffeeddccbbaa99887766554433221100
    ///   iv_wrap   = 0102030405060708090a0b0c
    ///   iv_item   = 0c0a0e0d0b09080706050403
    ///   item      = id "item-a", plaintext {"id":"item-a","title":"GitHub","secret":"alpha"}
    const KAT_KEK_HEX: &str = "ad9fd955a0db9f4ec1b1a95feb4efea016c6678f4860ae957e42cd489fcfafd5";
    const KAT_SALT_B64: &str = "ABEiM0RVZneImaq7zN3u_w";
    const KAT_VEK_B64: &str = "Dw4NDAsKCQgHBgUEAwIBAP_u3cy7qpmId2ZVRDMiEQA";
    const KAT_ITEM_IV: &str = "DAoODQsJCAcGBQQD";
    const KAT_ITEM_CT: &str =
        "mHmHHC8XJhLlExk0vdujq_LPkkZzlN7UEqX47K2N2XkBZ-VD1zqu-v-G63whk61ZaT625_sRXCLzX3uKWxLr7PU";
    const KAT_ITEM_PLAIN: &str = r#"{"id":"item-a","title":"GitHub","secret":"alpha"}"#;
    const KAT_HEADER_JSON: &str = r#"{
      "v": 1,
      "protection": "password",
      "kdf": "PBKDF2-SHA256",
      "iterations": 1000,
      "salt": "ABEiM0RVZneImaq7zN3u_w",
      "wrapped": {
        "iv": "AQIDBAUGBwgJCgsM",
        "ct": "oj8Ho2it_6pOdVs7JpScUm8AZZD4tbtykw6QGMEo7JyeFhfsDLIwaE9q73WNnqJk"
      }
    }"#;

    fn hex_to_bytes(hex: &str) -> Vec<u8> {
        (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect()
    }

    fn kat_header() -> VaultHeader {
        serde_json::from_str(KAT_HEADER_JSON).expect("vector header must parse")
    }

    fn kat_vek() -> Vec<u8> {
        from_base64_url(KAT_VEK_B64).unwrap()
    }

    #[test]
    fn pbkdf2_matches_node_webcrypto() {
        let salt = from_base64_url(KAT_SALT_B64).unwrap();
        let kek = derive_kek(MASTER, &salt, KAT_ITERATIONS);
        assert_eq!(hex_to_bytes(KAT_KEK_HEX), kek.as_slice());
    }

    #[test]
    fn header_from_node_opens_and_yields_the_vek() {
        let handle = open_vault_key(&kat_header(), MASTER).expect("vector header opens");
        assert_eq!(handle.raw(), kat_vek());
    }

    #[test]
    fn item_from_node_decrypts() {
        let handle = open_vault_key(&kat_header(), MASTER).unwrap();
        let blob = SealedBlob {
            iv: KAT_ITEM_IV.into(),
            ct: KAT_ITEM_CT.into(),
        };
        let value: serde_json::Value = open_item(&handle, "item-a", &blob).unwrap();
        assert_eq!(
            value,
            serde_json::from_str::<serde_json::Value>(KAT_ITEM_PLAIN).unwrap()
        );
    }

    #[test]
    fn encryption_is_byte_identical_to_node_for_a_fixed_nonce() {
        let nonce = {
            let iv = from_base64_url(KAT_ITEM_IV).unwrap();
            <[u8; IV_BYTES]>::try_from(iv.as_slice()).unwrap()
        };
        let blob = seal_with_nonce(
            &kat_vek(),
            &nonce,
            KAT_ITEM_PLAIN.as_bytes(),
            &item_aad("item-a"),
        )
        .unwrap();
        assert_eq!(blob.iv, KAT_ITEM_IV);
        assert_eq!(blob.ct, KAT_ITEM_CT);
    }

    #[test]
    fn wrong_password_is_rejected() {
        let err = open_vault_key(&kat_header(), &format!("{MASTER}x")).unwrap_err();
        assert!(matches!(err, VaultError::Auth), "got {err:?}");
    }

    #[test]
    fn the_master_password_is_never_stored_in_the_header() {
        let handle = VaultKeyHandle::generate();
        let header = create_password_header(MASTER, &handle, KAT_ITERATIONS).unwrap();
        let serialized = serde_json::to_string(&header).unwrap();
        assert!(
            !serialized.contains(MASTER),
            "header must not contain the master password"
        );
        assert_eq!(
            header.salt.as_deref().unwrap().len(),
            22,
            "16-byte salt in base64url"
        );
    }

    #[test]
    fn each_encryption_uses_a_fresh_nonce() {
        let handle = VaultKeyHandle::generate();
        let first = seal_item(&handle, "a", &json!({ "title": "same" })).unwrap();
        let second = seal_item(&handle, "a", &json!({ "title": "same" })).unwrap();
        assert_ne!(first.iv, second.iv);
        assert_ne!(first.ct, second.ct);
    }

    #[test]
    fn a_ciphertext_cannot_be_moved_to_another_item_id() {
        let handle = VaultKeyHandle::generate();
        let blob = seal_item(&handle, "item-a", &json!({ "secret": "alpha" })).unwrap();
        let err = open_item::<serde_json::Value>(&handle, "item-b", &blob).unwrap_err();
        assert!(matches!(err, VaultError::Auth), "got {err:?}");
    }

    #[test]
    fn tampered_ciphertext_fails_authentication() {
        let handle = VaultKeyHandle::generate();
        let mut blob = seal_item(&handle, "a", &json!({ "secret": "alpha" })).unwrap();
        let mut ct = from_base64_url(&blob.ct).unwrap();
        ct[0] ^= 0x01;
        blob.ct = crate::bytes::to_base64_url(&ct);
        let err = open_item::<serde_json::Value>(&handle, "a", &blob).unwrap_err();
        assert!(matches!(err, VaultError::Auth), "got {err:?}");
    }

    #[test]
    fn rewrapping_keeps_existing_item_ciphertext_valid() {
        let handle = VaultKeyHandle::generate();
        let blob = seal_item(&handle, "a", &json!({ "title": "GitHub" })).unwrap();

        let rewrapped =
            rewrap_vault_key(&handle, "a brand new master password", KAT_ITERATIONS).unwrap();
        let reopened = open_vault_key(&rewrapped, "a brand new master password").unwrap();
        let value: serde_json::Value = open_item(&reopened, "a", &blob).unwrap();
        assert_eq!(value, json!({ "title": "GitHub" }));

        let err = open_vault_key(&rewrapped, MASTER).unwrap_err();
        assert!(matches!(err, VaultError::Auth), "got {err:?}");
    }

    #[test]
    fn destroying_the_key_scrubs_the_raw_bytes() {
        let mut handle = VaultKeyHandle::generate();
        assert!(handle.raw().iter().any(|&b| b != 0));
        handle.destroy();
        assert!(handle.raw().iter().all(|&b| b == 0));
    }

    #[test]
    fn a_passwordless_header_stores_the_key_directly() {
        let handle = VaultKeyHandle::generate();
        let header = create_device_header(&handle);
        assert_eq!(header.protection, Some(VaultProtection::Device));
        assert_eq!(
            header.device_key.as_deref(),
            Some(to_base64_url(handle.raw()).as_str())
        );
        assert!(header.wrapped.is_none());
        let serialized = serde_json::to_string(&header).unwrap();
        assert!(
            serialized.contains("\"wrapped\":null"),
            "TS writes wrapped: null, got {serialized}"
        );
    }

    #[test]
    fn a_passwordless_vault_opens_with_any_or_no_password() {
        let handle = VaultKeyHandle::generate();
        let header = create_device_header(&handle);
        assert_eq!(
            resolve_header(&header).unwrap().protection,
            VaultProtection::Device
        );
        assert_eq!(open_vault_key(&header, "").unwrap().raw(), handle.raw());
        assert_eq!(
            open_vault_key(&header, "anything at all").unwrap().raw(),
            handle.raw()
        );
    }

    #[test]
    fn legacy_headers_with_no_protection_field_are_password_vaults() {
        let handle = VaultKeyHandle::generate();
        let modern = create_password_header(MASTER, &handle, KAT_ITERATIONS).unwrap();
        let mut legacy = serde_json::to_value(&modern).unwrap();
        legacy.as_object_mut().unwrap().remove("protection");
        let legacy: VaultHeader = serde_json::from_value(legacy).unwrap();

        assert_eq!(
            resolve_header(&legacy).unwrap().protection,
            VaultProtection::Password
        );
        assert_eq!(open_vault_key(&legacy, MASTER).unwrap().raw(), handle.raw());
        let err = open_vault_key(&legacy, "wrong").unwrap_err();
        assert!(matches!(err, VaultError::Auth), "got {err:?}");
    }

    #[test]
    fn a_damaged_header_is_rejected_rather_than_treated_as_passwordless() {
        let no_wrapped = VaultHeader {
            v: 1,
            protection: Some(VaultProtection::Password),
            kdf: Some("PBKDF2-SHA256".into()),
            iterations: Some(1),
            salt: Some("x".into()),
            wrapped: None,
            device_key: None,
        };
        assert!(matches!(
            resolve_header(&no_wrapped),
            Err(VaultError::DamagedHeader(_))
        ));

        let no_device_key = VaultHeader {
            v: 1,
            protection: Some(VaultProtection::Device),
            kdf: None,
            iterations: None,
            salt: None,
            wrapped: None,
            device_key: None,
        };
        assert!(matches!(
            resolve_header(&no_device_key),
            Err(VaultError::DamagedHeader(_))
        ));
    }
}
