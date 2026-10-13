//! The item model: what a login looks like in memory, and how older or
//! slightly-off records are coerced into the current shape.
//!
//! Port of `lite version/src/vault/types.ts` plus the `LoginSecurity` types
//! and `normaliseSecurity` from `lite version/src/crypto/security.ts`.

use rand::distributions::Alphanumeric;
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::crypto::SealedBlob;
use crate::util::{js_string, js_truthy, now_ms};

/// What actually sits in storage: the id in the clear, everything else as
/// ciphertext.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoredItem {
    pub id: String,
    pub blob: SealedBlob,
    pub updated_at: i64,
}

/// A TOTP seed, stored encrypted like any other field.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct TotpSecret {
    /// base32 seed, as an authenticator app expects it.
    pub seed: String,
}

/// A recovery question. The answer itself is never stored — only a PBKDF2
/// hash with its own salt.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SecurityQuestion {
    pub id: String,
    pub prompt: String,
    pub hash: String,
    pub salt: String,
}

/// An optional extra password gating one login, stored as a PBKDF2 hash so
/// the plaintext never reaches disk.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct SecurityPasscode {
    pub hash: String,
    pub salt: String,
}

/// Optional second factor for one credential. Lives inside the encrypted
/// blob, so it is as protected as the password itself.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct LoginSecurity {
    pub totp: Option<TotpSecret>,
    /// Serialized in this order to match `normaliseSecurity`'s output in TS.
    #[serde(default)]
    pub passcode: Option<SecurityPasscode>,
    #[serde(default)]
    pub questions: Vec<SecurityQuestion>,
}

/// A decrypted credential. Only ever held in memory while the vault is unlocked.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VaultItem {
    pub id: String,
    pub title: String,
    pub username: String,
    pub password: String,
    pub url: String,
    pub notes: String,
    pub totp_secret: String,
    pub favorite: bool,
    /// Marks the login as needing attention. Separate from `favorite`.
    pub needs_attention: bool,
    /// Whether this login shows its message expander. Opt-in per login: new
    /// logins start with it off (`empty_item`), while a record saved before the
    /// field existed reads as on (`normalise_item`) so the one-time
    /// linked-only pass is what switches unrelated logins off — a legacy `true`
    /// is never re-read as a choice.
    pub show_mail: bool,
    /// Which messages the expander shows: `auto`, `matched` or `recent`.
    /// Anything else coerces to `auto`.
    pub mail_filter: String,
    /// Ids from the global tag catalogue — ids rather than names so a tag can
    /// be renamed everywhere at once.
    pub tags: Vec<String>,
    pub security: LoginSecurity,
    /// Per-login accent hue; null derives one from the title.
    pub accent_hue: Option<f64>,
    /// Card background: remote https URL or a data URL, inside the ciphertext.
    pub background_image: String,
    pub background_blur: f64,
    /// Avatar image, independent of the card background.
    pub avatar_image: String,
    pub created_at: i64,
    pub updated_at: i64,
    /// When the password last changed. Drives the "old password" warning.
    pub password_updated_at: i64,
    /// When the email or username last changed.
    pub username_updated_at: i64,
    /// Per-login rotation reminder in days, fractional (15 minutes = 15/1440).
    /// 0 follows the global setting.
    pub reminder_days: f64,
}

/// A brand-new, empty login.
pub fn empty_item(id: &str, now: i64) -> VaultItem {
    VaultItem {
        id: id.to_string(),
        title: String::new(),
        username: String::new(),
        password: String::new(),
        url: String::new(),
        notes: String::new(),
        totp_secret: String::new(),
        favorite: false,
        needs_attention: false,
        // Off by default, and deliberately so: mail is per login, so connecting
        // a mailbox for one login does not put a Messages button on every
        // other login.
        show_mail: false,
        mail_filter: "auto".to_string(),
        tags: Vec::new(),
        security: LoginSecurity::default(),
        accent_hue: None,
        background_image: String::new(),
        background_blur: 0.0,
        avatar_image: String::new(),
        created_at: now,
        updated_at: now,
        password_updated_at: now,
        username_updated_at: now,
        reminder_days: 0.0,
    }
}

/// Coerces a stored record from an older build into the current shape.
///
/// Divergence from TS, deliberate: where the TS spread let a wrongly-typed
/// value through (JSON has no types to check against), this falls back to the
/// empty-item default instead. Every field the lite app itself writes has the
/// right type, so the fallback never fires for records it produced.
pub fn normalise_item(raw: &Value, now: i64) -> VaultItem {
    let obj = raw.as_object();
    let get = |key: &str| obj.and_then(|o| o.get(key));

    let id = get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let created = get("createdAt")
        .and_then(Value::as_i64)
        .or_else(|| get("createdAt").and_then(Value::as_f64).map(|f| f as i64))
        .unwrap_or(now);
    let mut item = empty_item(&id, created);

    if let Some(v) = get("title").and_then(Value::as_str) {
        item.title = v.to_string();
    }
    if let Some(v) = get("username").and_then(Value::as_str) {
        item.username = v.to_string();
    }
    if let Some(v) = get("password").and_then(Value::as_str) {
        item.password = v.to_string();
    }
    if let Some(v) = get("url").and_then(Value::as_str) {
        item.url = v.to_string();
    }
    if let Some(v) = get("notes").and_then(Value::as_str) {
        item.notes = v.to_string();
    }
    if let Some(v) = get("totpSecret").and_then(Value::as_str) {
        item.totp_secret = v.to_string();
    }
    if let Some(v) = get("favorite").and_then(Value::as_bool) {
        item.favorite = v;
    }
    if let Some(v) = get("backgroundImage").and_then(Value::as_str) {
        item.background_image = v.to_string();
    }
    if let Some(v) = get("backgroundBlur").and_then(Value::as_f64) {
        item.background_blur = v;
    }
    if let Some(v) = get("avatarImage").and_then(Value::as_str) {
        item.avatar_image = v.to_string();
    }

    item.created_at = created;
    item.updated_at = get("updatedAt")
        .and_then(Value::as_i64)
        .or_else(|| get("updatedAt").and_then(Value::as_f64).map(|f| f as i64))
        .unwrap_or(created);
    item.password_updated_at = get("passwordUpdatedAt")
        .and_then(Value::as_i64)
        .or_else(|| {
            get("passwordUpdatedAt")
                .and_then(Value::as_f64)
                .map(|f| f as i64)
        })
        .unwrap_or(created);
    item.username_updated_at = get("usernameUpdatedAt")
        .and_then(Value::as_i64)
        .or_else(|| {
            get("usernameUpdatedAt")
                .and_then(Value::as_f64)
                .map(|f| f as i64)
        })
        .unwrap_or(created);
    item.tags = match get("tags") {
        Some(Value::Array(values)) => values
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect(),
        _ => Vec::new(),
    };
    item.needs_attention = get("needsAttention").is_some_and(js_truthy);
    // Off for a *new* login (`empty_item`), but a record saved before the field
    // existed reads as on: that record predates the per-login idea, and the
    // one-time linked-only pass is what switches unrelated logins off. A legacy
    // `true` is never re-read as a choice.
    item.show_mail = match get("showMail") {
        Some(Value::Bool(b)) => *b,
        _ => true,
    };
    item.mail_filter = match get("mailFilter").and_then(Value::as_str) {
        Some(v) if v == "matched" || v == "recent" => v.to_string(),
        _ => "auto".to_string(),
    };
    item.accent_hue = get("accentHue").and_then(Value::as_f64);
    item.reminder_days = match get("reminderDays").and_then(Value::as_f64) {
        Some(value) if value.is_finite() => (value * 1e6).round() / 1e6,
        _ => 0.0,
    }
    .max(0.0);
    item.security = normalise_security(get("security"));
    item
}

/// Coerces a stored security block into the current shape — one shared
/// helper so a new factor cannot be forgotten the way `passcode` once was.
pub fn normalise_security(raw: Option<&Value>) -> LoginSecurity {
    // Anything that is not a plain object behaves like a missing block.
    let obj = raw.and_then(Value::as_object);

    let totp = obj
        .and_then(|o| o.get("totp"))
        .and_then(|t| t.get("seed"))
        .filter(|seed| js_truthy(seed))
        .and_then(js_string)
        .map(|seed| TotpSecret { seed });

    let passcode = obj
        .and_then(|o| o.get("passcode"))
        .and_then(|p| p.as_object())
        .and_then(|p| p.get("hash"))
        .and_then(Value::as_str)
        .filter(|hash| !hash.is_empty())
        .map(|hash| SecurityPasscode {
            hash: hash.to_string(),
            salt: obj
                .and_then(|o| o.get("passcode"))
                .and_then(|p| p.get("salt"))
                .and_then(js_string)
                .unwrap_or_default(),
        });

    let questions = match obj.and_then(|o| o.get("questions")) {
        Some(Value::Array(values)) => values
            .iter()
            .filter(|q| js_truthy(q) && q.get("hash").is_some_and(js_truthy))
            .map(|q| SecurityQuestion {
                id: q
                    .get("id")
                    .and_then(js_string)
                    .unwrap_or_else(random_question_id),
                prompt: q.get("prompt").and_then(js_string).unwrap_or_default(),
                hash: q.get("hash").and_then(js_string).unwrap_or_default(),
                salt: q.get("salt").and_then(js_string).unwrap_or_default(),
            })
            .collect(),
        _ => Vec::new(),
    };

    LoginSecurity {
        totp,
        passcode,
        questions,
    }
}

/// `sq_` plus eight random base36 characters, the JS `Math.random` fallback
/// from `normaliseSecurity`.
fn random_question_id() -> String {
    let suffix: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .map(char::from)
        .take(8)
        .collect();
    format!("sq_{suffix}")
}

/// Only http(s) and inline images are allowed, so a login cannot smuggle in
/// markup — same rule as `isAllowedImageSrc` in TS.
pub fn is_allowed_image_src(src: &str) -> bool {
    if src.is_empty() {
        return false;
    }
    if src.starts_with("data:image/") {
        return true;
    }
    src.starts_with("https://") || src.starts_with("http://")
}

/// Adds a scheme to bare hostnames; trims.
pub fn normalize_url(url: &str) -> String {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    }
}

/// Stable hue for a label, so a login's colour never changes between loads.
/// (JS `hash = (hash * 31 + charCodeAt(i)) | 0` over UTF-16 code units, then
/// `Math.abs(hash) % 360` as a double.)
pub fn hue_for(label: &str) -> i32 {
    let mut hash: i32 = 0;
    for unit in label.encode_utf16() {
        hash = hash.wrapping_mul(31).wrapping_add(unit as i32);
    }
    ((hash as i64).abs() % 360) as i32
}

/// The accent hue to render an item with, preferring an explicit choice.
pub fn accent_of(item: &VaultItem) -> i32 {
    if let Some(hue) = item.accent_hue.filter(|h| h.is_finite()) {
        return (((hue % 360.0) + 360.0) % 360.0) as i32;
    }
    let label = if !item.title.is_empty() {
        &item.title
    } else if !item.username.is_empty() {
        &item.username
    } else if !item.url.is_empty() {
        &item.url
    } else {
        "aegis"
    };
    hue_for(label)
}

/// Convenience for building draft objects in the engine (`emptyItem` spread).
pub fn item_to_value(item: &VaultItem) -> Value {
    serde_json::to_value(item).unwrap_or_else(|_| json!({}))
}

/// Overlays a draft onto a base object, JSON-spread style.
pub fn overlay(base: &Value, patch: &Value) -> Value {
    let mut merged = base.as_object().cloned().unwrap_or_else(Map::new);
    if let Some(patch_obj) = patch.as_object() {
        for (key, value) in patch_obj {
            merged.insert(key.clone(), value.clone());
        }
    }
    Value::Object(merged)
}

/// Timestamp helper shared by the engine.
pub fn now() -> i64 {
    now_ms()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_item_matches_the_ts_shape() {
        let item = empty_item("id-1", 1_700_000_000_000);
        let value = serde_json::to_value(&item).unwrap();
        assert_eq!(value["id"], "id-1");
        assert_eq!(value["title"], "");
        assert_eq!(value["favorite"], false);
        assert_eq!(value["needsAttention"], false);
        assert_eq!(value["tags"], json!([]));
        assert_eq!(value["security"]["totp"], Value::Null);
        assert_eq!(value["security"]["passcode"], Value::Null);
        assert_eq!(value["security"]["questions"], json!([]));
        assert_eq!(value["accentHue"], Value::Null);
        assert_eq!(value["backgroundBlur"], 0.0);
        assert_eq!(value["reminderDays"], 0.0);
        assert_eq!(value["createdAt"], 1_700_000_000_000_i64);
    }

    #[test]
    fn normalise_fills_missing_fields_from_an_old_record() {
        let raw =
            json!({ "id": "legacy", "title": "Old Bank", "createdAt": 1_600_000_000_000_i64 });
        let item = normalise_item(&raw, 1_700_000_000_000);
        assert_eq!(item.id, "legacy");
        assert_eq!(item.title, "Old Bank");
        assert_eq!(item.created_at, 1_600_000_000_000);
        assert_eq!(item.updated_at, 1_600_000_000_000, "defaults to createdAt");
        assert_eq!(item.password_updated_at, 1_600_000_000_000);
        assert!(item.tags.is_empty());
        assert_eq!(item.security, LoginSecurity::default());
        assert_eq!(item.reminder_days, 0.0);
    }

    #[test]
    fn normalise_type_checks_match_the_ts_checks() {
        let raw = json!({
            "id": "x",
            "createdAt": "not a number",
            "updatedAt": 5,
            "tags": [1, "keep", null, "also-keep"],
            "needsAttention": 1,
            "accentHue": "nope",
            "reminderDays": -3.5,
            "favorite": "truthy-string",
        });
        let now = 9_999_i64;
        let item = normalise_item(&raw, now);
        assert_eq!(
            item.created_at, now,
            "non-number createdAt falls back to now"
        );
        assert_eq!(item.updated_at, 5);
        assert_eq!(
            item.tags,
            vec!["keep", "also-keep"],
            "non-string tags dropped"
        );
        assert!(item.needs_attention, "Boolean(1) is true in JS");
        assert_eq!(item.accent_hue, None, "non-number hue becomes null");
        assert_eq!(item.reminder_days, 0.0, "negative clamps to 0");
        assert!(
            !item.favorite,
            "non-boolean favourite falls back to false (documented divergence)"
        );
    }

    #[test]
    fn reminder_days_rounds_like_js_math_round() {
        // JS: Math.max(0, Math.round(x * 1e6) / 1e6)
        let raw = json!({ "id": "x", "reminderDays": 15.0 / 1440.0 });
        let item = normalise_item(&raw, 0);
        assert_eq!(item.reminder_days, 0.010417);

        let raw = json!({ "id": "x", "reminderDays": 0.0000004 });
        let item = normalise_item(&raw, 0);
        assert_eq!(item.reminder_days, 0.0, "rounds to 0 at the 1e-6 grid");
    }

    #[test]
    fn normalise_security_port_matches_the_ts_helper() {
        // Missing block -> empty shape.
        assert_eq!(normalise_security(None), LoginSecurity::default());
        // null block -> empty shape (TS accepts null).
        assert_eq!(
            normalise_security(Some(&Value::Null)),
            LoginSecurity::default()
        );
        // Garbage (a string) behaves like a missing block.
        assert_eq!(
            normalise_security(Some(&json!("boom"))),
            LoginSecurity::default()
        );

        // Empty-string seed is falsy in JS -> no TOTP.
        let security = normalise_security(Some(&json!({ "totp": { "seed": "" } })));
        assert_eq!(security.totp, None);

        let security = normalise_security(Some(&json!({
            "totp": { "seed": "GEZDGNBVGY3TQOJQ" },
            "passcode": { "hash": "abc", "salt": 42 },
            "questions": [
                { "prompt": "Pet?", "hash": "h1", "salt": "s1" },
                { "id": "q1", "prompt": "City", "hash": "", "salt": "s" },
                null,
                { "id": "q2", "prompt": 7, "hash": "h2" },
            ],
        })));
        assert_eq!(security.totp.as_ref().unwrap().seed, "GEZDGNBVGY3TQOJQ");
        assert_eq!(security.passcode.as_ref().unwrap().hash, "abc");
        assert_eq!(
            security.passcode.as_ref().unwrap().salt,
            "42",
            "String(42) in JS"
        );
        assert_eq!(
            security.questions.len(),
            2,
            "empty-hash and null questions filtered"
        );
        assert!(
            security.questions[0].id.starts_with("sq_"),
            "missing id gets the random fallback"
        );
        assert_eq!(security.questions[0].prompt, "Pet?");
        assert_eq!(security.questions[1].id, "q2");
        assert_eq!(security.questions[1].prompt, "7", "String(7) in JS");
        assert_eq!(
            security.questions[1].salt, "",
            "missing salt defaults to empty"
        );
    }

    #[test]
    fn passcode_requires_a_non_empty_string_hash() {
        let security =
            normalise_security(Some(&json!({ "passcode": { "hash": "", "salt": "s" } })));
        assert_eq!(security.passcode, None, "empty hash is not a passcode");
        let security = normalise_security(Some(&json!({ "passcode": { "hash": 42 } })));
        assert_eq!(
            security.passcode, None,
            "non-string hash is not a passcode (TS typeof check)"
        );
    }

    #[test]
    fn normalize_url_adds_a_scheme_to_bare_hostnames() {
        assert_eq!(normalize_url("github.com"), "https://github.com");
        assert_eq!(
            normalize_url("  example.com/path  "),
            "https://example.com/path"
        );
        assert_eq!(
            normalize_url("http://insecure.example"),
            "http://insecure.example"
        );
        assert_eq!(normalize_url("   "), "");
        assert_eq!(normalize_url(""), "");
    }

    #[test]
    fn hue_is_stable_and_js_identical() {
        // JS: hash = (hash * 31 + code) | 0 (int32 wrap), Math.abs % 360
        assert_eq!(hue_for("GitHub"), hue_for("GitHub"));
        assert_eq!(hue_for(""), 0);
        // Checked against the JS implementation's value for a known string.
        assert_eq!(hue_for("aegis"), {
            let mut hash: i32 = 0;
            for b in "aegis".bytes() {
                hash = hash.wrapping_mul(31).wrapping_add(b as i32);
            }
            hash.wrapping_abs() % 360
        });
    }

    #[test]
    fn accent_prefers_explicit_hue_otherwise_derives_from_title() {
        let mut item = empty_item("a", 0);
        assert_eq!(accent_of(&item), hue_for("aegis"));
        item.title = "GitHub".into();
        assert_eq!(accent_of(&item), hue_for("GitHub"));
        item.accent_hue = Some(-30.0);
        assert_eq!(accent_of(&item), 330, "negative hue wraps into 0..360");
        item.accent_hue = Some(365.0);
        assert_eq!(accent_of(&item), 5);
    }

    #[test]
    fn image_src_allowlist() {
        assert!(is_allowed_image_src("https://example.com/a.png"));
        assert!(is_allowed_image_src("http://example.com/a.png"));
        assert!(is_allowed_image_src("data:image/png;base64,AAAA"));
        assert!(!is_allowed_image_src("javascript:alert(1)"));
        assert!(!is_allowed_image_src(""));
        assert!(!is_allowed_image_src("file:///etc/passwd"));
    }
}
