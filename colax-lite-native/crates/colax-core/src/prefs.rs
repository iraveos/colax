// Vault preferences: the typed shape, the defaults, and the normaliser.
//
// Port of E:\acc2\src\vault\storage.ts (VaultPreferences L473-839,
// DEFAULT_PREFERENCES L841-969, normalisePreferences L1069-1454).
//
// This crate ports the shape that the *appearance* layer needs first; the
// full ~90-field schema lands as the remaining settings tabs need them, and
// normalise_preferences is forward-compatible: unknown keys are ignored and
// missing keys fall back to defaults, so a web-build vault.json with the
// complete schema round-trips without data loss.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

use crate::model::{normalise_security, LoginSecurity};

/// One entry of the global tag catalogue: logins reference these by id rather
/// than by name, so renaming or recolouring one here changes every login that
/// carries it -- and a tag a login no longer references can be spotted by
/// comparing ids, without reading any of their text.
///
/// Port of `Tag` in `E:\acc2\src\vault\channels.ts:98`. The catalogue lives in
/// preferences, not on the item, because it is shared by every login.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Tag {
    pub id: String,
    pub name: String,
    /// Hue in degrees, drives the chip colour. Kept inside 0..360 by
    /// `normalise_tags`; the three shipped tags sit at 8, 36 and 268 so they
    /// stay apart at a glance.
    pub hue: f64,
}

/// One login's use record: how often it was copied or edited, and when last
/// (`{ count, at }`, storage.ts L613). The dashboard's "most used" and
/// "recent account activity" read these; entries are pruned of deleted
/// logins by the writer, and validated here.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct UsageEntry {
    pub count: i64,
    pub at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct VaultPreferences {
    pub theme: String,
    pub accent: String,
    pub text_scale: f64,
    pub motion: f64,
    pub motion_speed: f64,
    pub ambient: f64,
    pub density: String,
    pub roundness: f64,
    pub card_depth: f64,
    pub reduce_transparency: bool,
    pub high_contrast: bool,
    pub background_image: String,
    pub background_opacity: f64,
    pub background_blur: f64,
    pub background_dim: f64,
    pub view: String,
    pub sort: String,
    pub show_urls: bool,
    pub sidebar_position: String,
    pub sidebar_labels: String,
    /// `data-compact-sidebar` in the TS shell (App.tsx L2897): the rail
    /// narrows to its dot column. Set by Settings there; here it also
    /// answers to icon-only labels, which is the other half of the same
    /// expression.
    pub compact_sidebar: bool,
    /// `showSidebar`: the rail is off the window entirely (the pref is read
    /// before unlock too, so the tray can show it -- but the geometry is the
    /// shell's job).
    pub show_sidebar: bool,
    /// `prefs.vaultSecurity`: a second factor over the whole vault. TS gates
    /// the shell itself on it (App.tsx L2830, "Vault verification"), and the
    /// native gate verifies against this same stored factor.
    pub vault_security: LoginSecurity,
    // Sort and delete behaviour (Task 3.5 / 3.6).
    /// Favourites float to the top of every sort mode.
    pub pin_favorites: bool,
    /// Drag order for `sort == "manual"`. Ids not listed sort after the
    /// placed ones, in title order, so a new login needs no bookkeeping.
    pub manual_order: Vec<String>,
    /// Days before a password counts as stale. 0 disables the check.
    pub password_age_days: i64,
    /// Days before a login's *username* counts as due for review
    /// (`emailCheckDays`, storage.ts L645 — default 90, whitelist
    /// [0, 30, 60, 90, 180, 365] at L1414). 0 disables that check too.
    pub email_check_days: i64,
    /// Ask before deleting, rather than deleting straight to undo.
    pub confirm_deletes: bool,
    // Activity (Task 7.1).
    /// Copy/edit counts per login id (`usage`, storage.ts L613): the
    /// dashboard's "most used" and "recent account activity" read this.
    /// Pruning entries for deleted logins is the writer's job — a load only
    /// sees shapes, the writer sees the items.
    pub usage: BTreeMap<String, UsageEntry>,
    /// Minutes without activity before the vault seals itself. 0 disables
    /// the timer (`AUTO_LOCK_CHOICES` in Settings.tsx L1266).
    pub auto_lock_minutes: i64,
    /// Seconds after a copy before the clipboard is wiped; 0 keeps it
    /// (`clearClipboardSeconds`, storage.ts L803, `clampRange` 0..=300 in
    /// L1433). The same Security group as the lock above in Settings.
    pub clear_clipboard_seconds: f64,
    /// Also wipe the clipboard when the vault locks (`clearClipboardOnLock`,
    /// storage.ts L805 — shipped on).
    pub clear_clipboard_on_lock: bool,
    /// Toast on a successful copy (`copyToasts`, storage.ts L836). The
    /// *failure* notice is not a toast and shows either way — TS notifies
    /// it before the toast flag is ever consulted (hooks.ts L580).
    pub copy_toasts: bool,
    /// The global tag catalogue; logins carry ids from it (`Tag` above).
    /// Seeded with the three shipped tags on every load — `ensureDefaultTags`
    /// in storage.ts L1076 — so a vault opened here shows the same tags the
    /// web build would, without the user having created any.
    pub tags: Vec<Tag>,
    // Shell switches. They live in `shell.json` too so the tray (which exists
    // before unlock) can read them, and the two are written together — see
    // `mirror_shell_flags` in the app.
    pub tray_enabled: bool,
    pub close_to_tray: bool,
    pub launch_at_login: bool,
    pub sounds_muted: bool,
    // retained as an opaque pocket for keys we do not model yet, so nothing
    // is dropped on a round trip through this build. The TS build writes
    // many more fields here; we keep the ones we understand typed and let
    // the rest live in `extra`.
    #[serde(flatten)]
    pub extra: Value,
}

impl Default for VaultPreferences {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            accent: "slate".into(),
            text_scale: 100.0,
            motion: 1.0,
            motion_speed: 2.0,
            ambient: 1.0,
            density: "comfortable".into(),
            roundness: 1.0,
            card_depth: 0.4,
            reduce_transparency: false,
            high_contrast: true,
            background_image: String::new(),
            background_opacity: 0.35,
            background_blur: 0.0,
            background_dim: 0.25,
            view: "animated".into(),
            sort: "title".into(),
            show_urls: true,
            pin_favorites: true,
            manual_order: Vec::new(),
            password_age_days: 180,
            email_check_days: 90,
            confirm_deletes: true,
            usage: BTreeMap::new(),
            auto_lock_minutes: 5,
            clear_clipboard_seconds: 30.0,
            clear_clipboard_on_lock: true,
            copy_toasts: true,
            tags: Vec::new(),
            sidebar_position: "left".into(),
            sidebar_labels: "both".into(),
            compact_sidebar: false,
            show_sidebar: true,
            vault_security: LoginSecurity::default(),
            tray_enabled: true,
            close_to_tray: true,
            launch_at_login: false,
            sounds_muted: false,
            extra: Value::Object(serde_json::Map::new()),
        }
    }
}

fn one_of(value: &Value, allowed: &[&str], dflt: &str) -> String {
    let s = value.as_str().unwrap_or(dflt);
    if allowed.contains(&s) { s.to_string() } else { dflt.to_string() }
}

pub fn normalise_preferences(raw: &Value) -> VaultPreferences {
    let mut out = VaultPreferences::default();
    let obj = raw.as_object();
    if obj.is_none() {
        // TS spreads a non-object into `{}` and runs the whole normaliser on
        // the result rather than short-circuiting, so even a corrupt document
        // gains the three shipped tags (storage.ts L1076).
        out.tags = ensure_default_tags(Vec::new());
        return out;
    }
    let o = obj.unwrap();
    macro_rules! get_f64 { ($k:literal, $d:literal) => {
        o.get($k).and_then(|v| v.as_f64()).unwrap_or($d)
    } }
    macro_rules! get_bool { ($k:literal, $d:literal) => {
        o.get($k).and_then(|v| v.as_bool()).unwrap_or($d)
    } }

    if let Some(v) = o.get("theme") { if v.is_string() {
        out.theme = one_of(v, &["light","dark","system"], "system");
    } }

    if let Some(v) = o.get("accent") {
        let a = v.as_str().unwrap_or("slate");
        let allowed = ["slate","sage","dusk","clay"];
        out.accent = if allowed.contains(&a) { a.to_string() } else { "slate".to_string() };
    }
    // Clamps are the same ones `normalisePreferences` applies (L1286-1433):
    // a value outside the range falls back rather than being silently kept.
    out.text_scale  = clamp(get_f64!("textScale", 100.0), 85.0, 130.0);
    out.motion      = clamp(get_f64!("motion", 1.0), 0.0, 1.0);
    out.motion_speed= clamp(get_f64!("motionSpeed", 2.0), 1.0, 2.0);
    out.ambient     = clamp(get_f64!("ambient", 1.0), 0.0, 1.0);
    out.density     = one_of(o.get("density").unwrap_or(&Value::Null), &["compact","comfortable","spacious"], "comfortable");
    out.roundness   = clamp(get_f64!("roundness", 1.0), 0.6, 1.4);
    out.card_depth  = clamp(get_f64!("cardDepth", 0.4), 0.0, 1.0);
    out.reduce_transparency = get_bool!("reduceTransparency", false);
    out.high_contrast       = get_bool!("highContrast", true);
    if let Some(v) = o.get("backgroundImage") { out.background_image = v.as_str().unwrap_or("").to_string(); }
    out.background_opacity = num(o.get("backgroundOpacity"), 0.35);
    out.background_blur    = num(o.get("backgroundBlur"), 0.0);
    out.background_dim     = num(o.get("backgroundDim"), 0.25);
    out.view = one_of(o.get("view").unwrap_or(&Value::Null), &["animated","carousel","basic","grid"], "animated");
    out.sort = one_of(o.get("sort").unwrap_or(&Value::Null), &["title","recent","oldest","strength","username","manual"], "title");
    out.show_urls = get_bool!("showUrls", true);
    // JS Boolean(...) again: a stored string still reads as a choice.
    out.pin_favorites = truthy(o.get("pinFavorites"), true);
    out.confirm_deletes = truthy(o.get("confirmDeletes"), true);
    // The list is deduplicated and emptied of anything that is not a non-empty
    // id, so a hand-edited record cannot put nulls in the drag order.
    out.manual_order = match o.get("manualOrder") {
        Some(Value::Array(ids)) => {
            let mut seen = std::collections::HashSet::new();
            let mut out: Vec<String> = Vec::new();
            for id in ids.iter().filter_map(Value::as_str) {
                if !id.is_empty() && seen.insert(id) {
                    out.push(id.to_string());
                }
            }
            out
        }
        _ => Vec::new(),
    };
    // The shipped set is 0/30/60/90/180/365/730; anything else falls back
    // rather than being kept (storage.ts L1408).
    out.password_age_days = match o.get("passwordAgeDays").and_then(Value::as_i64) {
        Some(d) if [0, 30, 60, 90, 180, 365, 730].contains(&d) => d,
        _ => 180,
    };
    // The shipped set is 0/1/5/15/30/60 (`AUTO_LOCK_CHOICES` in
    // Settings.tsx L1266); anything else falls back, as storage.ts L1438
    // does. 0 is a real choice -- never -- and not a missing value.
    out.auto_lock_minutes = match o.get("autoLockMinutes").and_then(Value::as_i64) {
        Some(m) if [0, 1, 5, 15, 30, 60].contains(&m) => m,
        _ => 5,
    };
    // The address-review window is a whitelist the same way (L1414), and a
    // stored string is not a choice — `includes` is strict in JS too.
    out.email_check_days = match o.get("emailCheckDays").and_then(Value::as_i64) {
        Some(d) if [0, 30, 60, 90, 180, 365].contains(&d) => d,
        _ => 90,
    };
    // `clampRange(..., 0, 300, 30)` in storage.ts L1433: a stored number is
    // clamped into the range -- 0 included, which is the real "never wipe"
    // choice -- and anything that is not a number falls back to the shipped
    // thirty rather than to the nearest bound.
    out.clear_clipboard_seconds = clamp(num(o.get("clearClipboardSeconds"), 30.0), 0.0, 300.0);
    // Switches over their defaults, as above: absent keeps the default, and
    // a stored value reads by JS `Boolean` (the `Boolean(...)` family that
    // normalisePreferences runs the on/off flags through).
    out.clear_clipboard_on_lock = truthy(o.get("clearClipboardOnLock"), true);
    out.copy_toasts = truthy(o.get("copyToasts"), true);
    // Use counts (`storage.ts` L1341-1355): `{ count, at }` objects only —
    // a malformed field falls back to 0, an entry with neither a count nor
    // a date drops out, and the newest 200 survive the cap. Load validates
    // shape; pruning by deleted id belongs to the writer.
    {
        let mut entries: Vec<(String, UsageEntry)> = Vec::new();
        if let Some(map) = o.get("usage").and_then(Value::as_object) {
            for (id, value) in map {
                let Some(record) = value.as_object() else { continue };
                let count = record
                    .get("count")
                    .and_then(Value::as_f64)
                    .filter(|n| n.is_finite())
                    .map(|n| n.floor().max(0.0) as i64)
                    .unwrap_or(0);
                let at = record
                    .get("at")
                    .and_then(Value::as_f64)
                    .filter(|n| n.is_finite())
                    .map(|n| n as i64)
                    .unwrap_or(0);
                if !id.is_empty() && (count > 0 || at > 0) {
                    entries.push((id.clone(), UsageEntry { count, at }));
                }
            }
        }
        // Newest first, then the cap — and the id tiebreak keeps the order
        // (and the saved document) deterministic between loads.
        entries.sort_by(|a, b| b.1.at.cmp(&a.1.at).then(a.0.cmp(&b.0)));
        out.usage = entries.into_iter().take(200).collect();
    }
    out.sidebar_position = one_of(o.get("sidebarPosition").unwrap_or(&Value::Null), &["left","right","top","bottom"], "left");
    out.sidebar_labels = one_of(o.get("sidebarLabels").unwrap_or(&Value::Null), &["icon","name","both"], "both");
    // `Boolean(...)` over the defaults, the way normalisePreferences treats
    // every switch: absent keeps the default the struct starts with, and a
    // stored vault from the web build brings its own.
    out.compact_sidebar = truthy(o.get("compactSidebar"), false);
    out.show_sidebar = truthy(o.get("showSidebar"), true);
    // The vault's own second factor, through the same helper the items use:
    // a stored vault.json from the web build verifies exactly the same way.
    out.vault_security = normalise_security(o.get("vaultSecurity"));
    // Boolean(...) in JS: anything truthy reads as true, so a legacy string
    // here is still honoured rather than reset.
    out.tray_enabled = truthy(o.get("trayEnabled"), true);
    out.close_to_tray = truthy(o.get("closeToTray"), true);
    out.launch_at_login = truthy(o.get("launchAtLogin"), false);
    out.sounds_muted = truthy(o.get("soundsMuted"), false);

    // The tag catalogue: clean what is stored, then make sure the three
    // shipped tags exist — `ensureDefaultTags(normaliseTags(...))` in
    // storage.ts L1076, in that order so a stored entry always wins over a
    // seed of the same name.
    out.tags = ensure_default_tags(normalise_tags(o.get("tags")));

    // absorb everything we didn't model
    let mut extra = serde_json::Map::new();
    let known = ["theme","accent","textScale","motion","motionSpeed","ambient","density","roundness",
        "cardDepth","reduceTransparency","highContrast","backgroundImage","backgroundOpacity",
        "backgroundBlur","backgroundDim","view","sort","showUrls","sidebarPosition","sidebarLabels",
        "compactSidebar","showSidebar","vaultSecurity",
        "trayEnabled","closeToTray","launchAtLogin","soundsMuted",
        "pinFavorites","manualOrder","passwordAgeDays","emailCheckDays","confirmDeletes","tags","autoLockMinutes",
        "clearClipboardSeconds","clearClipboardOnLock","copyToasts","usage"];
    for (k,v) in o.iter() {
        if !known.contains(&k.as_str()) { extra.insert(k.clone(), v.clone()); }
    }
    out.extra = Value::Object(extra);
    out
}

fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    if v.is_nan() { return lo; }
    if v < lo { lo } else if v > hi { hi } else { v }
}

/// A finite number, or the fallback. Mirrors `num()` in the TS normaliser.
fn num(v: Option<&Value>, dflt: f64) -> f64 {
    match v.and_then(Value::as_f64) {
        Some(n) if n.is_finite() => n,
        _ => dflt,
    }
}

/// JS `Boolean(v)`: a JSON `true`/`false` as itself, a non-empty string or
/// non-zero number as true, absent as the default.
fn truthy(v: Option<&Value>, dflt: bool) -> bool {
    match v {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0).unwrap_or(dflt),
        Some(Value::Array(a)) => !a.is_empty(),
        _ => dflt,
    }
}

/// The three tags every vault starts with (`DEFAULT_TAG_SEEDS` in
/// channels.ts L793). They are ordinary tags — rename, recolour or delete them
/// like any other — but they exist so "weak", "needs attention" and "reused"
/// are something you can put on a login instead of only badge text the app
/// decides for you. Hues are spread around the wheel so the three stay
/// distinguishable at a glance.
pub const DEFAULT_TAG_SEEDS: [(&str, f64); 3] = [("weak", 8.0), ("needs attention", 36.0), ("reused", 268.0)];

/// `newTagId` in channels.ts:522 — `tg_` plus the first eight characters of a
/// fresh uuid. Eight is plenty for a catalogue of tens of tags, and the prefix
/// keeps tag ids from reading as item ids in a shared log.
pub fn new_tag_id() -> String {
    let uuid = crate::engine::new_item_id().replace('-', "");
    format!("tg_{}", &uuid[..8])
}

/// Creates a tag, nudging the hue away from the ones already in the catalogue
/// (`createTag`, channels.ts L527). An empty or whitespace-only name becomes
/// "Tag" rather than a chip nobody can tell apart from another blank one.
pub fn create_tag(name: &str, existing: &[Tag]) -> Tag {
    let trimmed = name.trim();
    Tag {
        id: new_tag_id(),
        name: if trimmed.is_empty() { "Tag".to_string() } else { trimmed.to_string() },
        hue: pick_free_hue(existing),
    }
}

/// Evenly spreads hues around the wheel so adjacent tags stay distinguishable:
/// buckets of 24° (a sixth of the wheel per candidate, giving 15 to try), each
/// one claimed if any stored hue rounds into it. The final line mirrors TS's
/// `(existing.length * 47) % 360` — a deterministic scatter for the degenerate
/// case of a catalogue that has already occupied every bucket.
fn pick_free_hue(existing: &[Tag]) -> f64 {
    if existing.is_empty() {
        return 210.0;
    }
    let used: std::collections::HashSet<i64> = existing
        .iter()
        .map(|tag| ((tag.hue / 24.0).round() as i64 * 24) % 360)
        .collect();
    for hue in (0i64..360).step_by(24) {
        if !used.contains(&hue) {
            return hue as f64;
        }
    }
    ((existing.len() as f64 * 47.0) % 360.0).round()
}

/// Adds any missing default tag (matched case-insensitively on the trimmed
/// name), preserving the user's order and never duplicating. Runs on load so
/// older vaults gain the defaults without losing the tags they already have
/// (`ensureDefaultTags`, channels.ts L804).
pub fn ensure_default_tags(mut tags: Vec<Tag>) -> Vec<Tag> {
    let mut have: std::collections::HashSet<String> =
        tags.iter().map(|tag| tag.name.trim().to_lowercase()).collect();
    for (name, hue) in DEFAULT_TAG_SEEDS {
        let key = name.to_lowercase();
        if have.contains(&key) {
            continue;
        }
        tags.push(Tag { id: new_tag_id(), name: name.to_string(), hue });
        have.insert(key);
    }
    tags
}

/// `normaliseTags` in channels.ts L816: one bad entry costs that entry, not
/// the catalogue, so this reads the raw JSON rather than going through `serde`
/// (which would fail the whole preferences document on a single junk row).
/// Duplicates by id keep the first spelling; names trim to a non-empty string
/// or fall back to "Tag"; hues wrap into 0..360 or fall back to 210.
pub fn normalise_tags(stored: Option<&Value>) -> Vec<Tag> {
    let Some(Value::Array(items)) = stored else { return Vec::new(); };
    let mut seen = std::collections::HashSet::new();
    let mut tags = Vec::new();
    for raw in items {
        let Some(obj) = raw.as_object() else { continue };
        let Some(id) = obj.get("id").and_then(Value::as_str) else { continue };
        if !seen.insert(id.to_string()) {
            continue;
        }
        let name = match obj.get("name").and_then(Value::as_str) {
            Some(name) if !name.trim().is_empty() => name.trim().to_string(),
            _ => "Tag".to_string(),
        };
        let hue = match obj.get("hue").and_then(Value::as_f64) {
            Some(hue) if hue.is_finite() => ((hue % 360.0) + 360.0) % 360.0,
            _ => 210.0,
        };
        tags.push(Tag { id: id.to_string(), name, hue });
    }
    tags
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn defaults_match_the_typescript_defaults() {
        let p = normalise_preferences(&json!({}));
        assert_eq!(p.theme, "system");
        assert_eq!(p.accent, "slate");
        assert_eq!(p.text_scale, 100.0);
        assert_eq!(p.motion, 1.0);
        assert_eq!(p.motion_speed, 2.0);
        assert_eq!(p.density, "comfortable");
        assert_eq!(p.roundness, 1.0);
        assert_eq!(p.card_depth, 0.4);
        assert!(!p.reduce_transparency);
        assert!(p.high_contrast);
        assert_eq!(p.view, "animated");
        assert_eq!(p.sort, "title");
        assert!(p.show_urls);
        assert_eq!(p.sidebar_position, "left");
        assert_eq!(p.sidebar_labels, "both");
        assert_eq!(p.vault_security, LoginSecurity::default());
    }

    #[test]
    fn out_of_range_values_clamp_to_the_documented_bounds() {
        let p = normalise_preferences(&json!({
            "textScale": 999, "motion": -3, "motionSpeed": 12,
            "roundness": 0, "cardDepth": 7, "ambient": 4,
        }));
        assert_eq!(p.text_scale, 130.0);
        assert_eq!(p.motion, 0.0);
        assert_eq!(p.motion_speed, 2.0);
        assert_eq!(p.roundness, 0.6);
        assert_eq!(p.card_depth, 1.0);
        assert_eq!(p.ambient, 1.0);
    }

    #[test]
    fn unknown_enums_fall_back_to_the_default() {
        let p = normalise_preferences(&json!({
            "theme": "neon", "accent": "chartreuse", "density": "tight",
            "view": "cinema", "sort": "random", "sidebarPosition": "middle",
            "sidebarLabels": "words",
        }));
        assert_eq!(p.theme, "system");
        assert_eq!(p.accent, "slate");
        assert_eq!(p.density, "comfortable");
        assert_eq!(p.view, "animated");
        assert_eq!(p.sort, "title");
        assert_eq!(p.sidebar_position, "left");
        assert_eq!(p.sidebar_labels, "both");
        assert!(!p.compact_sidebar);
        assert!(p.show_sidebar);
    }

    #[test]
    fn known_enums_are_accepted() {
        let p = normalise_preferences(&json!({
            "theme": "dark", "accent": "sage", "density": "spacious",
            "view": "grid", "sort": "recent", "sidebarPosition": "right",
            "sidebarLabels": "icon", "compactSidebar": true, "showSidebar": false,
            "vaultSecurity": { "totp": { "seed": "GEZDGNBVGY3TQOJQ" } },
        }));
        assert_eq!(p.theme, "dark");
        assert_eq!(p.accent, "sage");
        assert_eq!(p.density, "spacious");
        assert_eq!(p.view, "grid");
        assert_eq!(p.sort, "recent");
        assert_eq!(p.sidebar_position, "right");
        assert_eq!(p.sidebar_labels, "icon");
        assert!(p.compact_sidebar);
        assert!(!p.show_sidebar);
        assert_eq!(
            p.vault_security,
            normalise_security(Some(&json!({ "totp": { "seed": "GEZDGNBVGY3TQOJQ" } })))
        );
        // All three are *known* now: they must not linger in `extra` and get
        // written a second time alongside their typed fields.
        assert!(p.extra.get("compactSidebar").is_none());
        assert!(p.extra.get("showSidebar").is_none());
        assert!(p.extra.get("vaultSecurity").is_none());
    }

    #[test]
    fn non_string_values_fall_back_rather_than_panic() {
        let p = normalise_preferences(&json!({
            "theme": 42, "textScale": "big", "showUrls": "yes",
            "highContrast": null, "backgroundImage": 7,
        }));
        assert_eq!(p.theme, "system");
        assert_eq!(p.text_scale, 100.0);
        assert!(p.show_urls); // not a JSON bool, so the default stands
        assert!(p.high_contrast);
        assert_eq!(p.background_image, "");
    }

    #[test]
    fn unknown_keys_survive_a_round_trip() {
        let raw = json!({
            "theme": "dark",
            "clearClipboardSeconds": 30,
            "mailAccount": "primary",
            "passwordGenerator": { "length": 20 },
        });
        let p = normalise_preferences(&raw);
        let back = serde_json::to_value(&p).unwrap();
        assert_eq!(back["theme"], "dark");
        // Modelled since: the same number, now typed -- 30 reads back as
        // 30.0 rather than as the raw pocket's integer, which is the whole
        // point of the field being typed.
        assert_eq!(back["clearClipboardSeconds"].as_f64(), Some(30.0));
        assert_eq!(back["mailAccount"], "primary");
        assert_eq!(back["passwordGenerator"]["length"], 20);
        // and the typed keys are present too
        assert_eq!(back["accent"], "slate");
    }

    #[test]
    fn non_object_documents_read_as_defaults() {
        for raw in [json!(null), json!("dark"), json!([1, 2])] {
            let mut p = normalise_preferences(&raw);
            // The only difference from the shape default is the three shipped
            // tags every load seeds (`ensureDefaultTags`, storage.ts L1076);
            // they carry fresh ids each time, so they are compared away here.
            assert_eq!(p.tags.len(), 3);
            p.tags.clear();
            assert_eq!(p, VaultPreferences::default());
        }
    }

    #[test]
    fn sort_and_delete_preferences_follow_the_documented_rules() {
        let d = normalise_preferences(&json!({}));
        assert!(d.pin_favorites);
        assert!(d.confirm_deletes);
        assert_eq!(d.password_age_days, 180);
        assert!(d.manual_order.is_empty());

        let p = normalise_preferences(&json!({
            "pinFavorites": false,
            "confirmDeletes": false,
            // Not one of 0/30/60/90/180/365/730 -> falls back.
            "passwordAgeDays": 17,
            "manualOrder": ["a", "b", "a", "", null, 7, "c"],
        }));
        assert!(!p.pin_favorites);
        assert!(!p.confirm_deletes);
        assert_eq!(p.password_age_days, 180);
        // Deduped, non-strings dropped, empty ids dropped, order kept.
        assert_eq!(p.manual_order, vec!["a".to_string(), "b".to_string(), "c".to_string()]);

        // 0 is a legitimate value (never stale) and must survive.
        let never = normalise_preferences(&json!({"passwordAgeDays": 0}));
        assert_eq!(never.password_age_days, 0);
    }

    #[test]
    fn auto_lock_follows_the_shipped_choices() {
        // Absent keeps the default the struct starts with: five minutes.
        assert_eq!(normalise_preferences(&json!({})).auto_lock_minutes, 5);
        // Every choice in `AUTO_LOCK_CHOICES` survives, including 0 --
        // "never" is a decision the user made and must not read as missing.
        for minutes in [0, 1, 5, 15, 30, 60] {
            let p = normalise_preferences(&json!({ "autoLockMinutes": minutes }));
            assert_eq!(p.auto_lock_minutes, minutes, "{minutes} must survive");
        }
        // Anything else falls back, as storage.ts L1438 does.
        for off in [json!(7), json!(-1), json!("5"), json!(null), json!(61)] {
            let p = normalise_preferences(&json!({ "autoLockMinutes": off }));
            assert_eq!(p.auto_lock_minutes, 5, "{off} must fall back");
        }
        // A typed field, not a leftover: once modelled, the key must not
        // linger in `extra` where a later field would be shadowed by it.
        let modelled = normalise_preferences(&json!({ "autoLockMinutes": 15 }));
        assert!(modelled.extra.get("autoLockMinutes").is_none());
        assert!(modelled.extra.as_object().is_some_and(|e| e.is_empty()));
    }

    #[test]
    fn clipboard_prefs_follow_the_shipped_choices() {
        // The shipped defaults (storage.ts L928, L929, L943).
        let fresh = normalise_preferences(&json!({}));
        assert_eq!(fresh.clear_clipboard_seconds, 30.0);
        assert!(fresh.clear_clipboard_on_lock);
        assert!(fresh.copy_toasts);

        // `clampRange(0, 300, 30)` (L1433): kept in range -- 0 is the real
        // "never wipe" -- clamped at the ends, and a non-number falls back
        // to the default rather than to the nearest bound.
        let cases = [
            (json!(45), 45.0),
            (json!(0), 0.0),
            (json!(300), 300.0),
            (json!(301), 300.0),
            (json!(-5), 0.0),
            (json!("5"), 30.0),
            (json!(null), 30.0),
        ];
        for (stored, want) in cases {
            let p = normalise_preferences(&json!({ "clearClipboardSeconds": stored }));
            assert_eq!(p.clear_clipboard_seconds, want, "{stored} must read {want}");
        }

        // Switches by JS Boolean over the default: an explicit false wins,
        // and a truthy string ("false" is not "no") still reads as on.
        assert!(!normalise_preferences(&json!({ "clearClipboardOnLock": false })).clear_clipboard_on_lock);
        assert!(!normalise_preferences(&json!({ "copyToasts": false })).copy_toasts);
        assert!(normalise_preferences(&json!({ "copyToasts": "false" })).copy_toasts);

        // Typed fields, not leftovers in `extra`.
        let modelled = normalise_preferences(&json!({
            "clearClipboardSeconds": 15,
            "clearClipboardOnLock": false,
            "copyToasts": false,
        }));
        assert_eq!(modelled.clear_clipboard_seconds, 15.0);
        assert!(modelled.extra.as_object().is_some_and(|e| e.is_empty()));
    }

    #[test]
    fn email_review_days_follow_the_shipped_whitelist() {
        let fresh = normalise_preferences(&json!({}));
        assert_eq!(fresh.email_check_days, 90);
        for days in [0, 30, 60, 90, 180, 365] {
            assert_eq!(
                normalise_preferences(&json!({ "emailCheckDays": days })).email_check_days,
                days
            );
        }
        // Anything off the list — a stray number or a numeric string, which
        // JS `includes` would also reject — falls back to ninety.
        assert_eq!(
            normalise_preferences(&json!({ "emailCheckDays": 45 })).email_check_days,
            90
        );
        assert_eq!(
            normalise_preferences(&json!({ "emailCheckDays": "90" })).email_check_days,
            90
        );
    }

    #[test]
    fn usage_keeps_only_well_shaped_entries_capped_by_recency() {
        // `health.test.ts` L17: malformed fields fall back to zero, an entry
        // with neither a count nor a date drops out, and a negative count
        // clamps to zero while its date keeps the entry alive.
        let p = normalise_preferences(&json!({
            "usage": {
                "good": { "count": 3, "at": 3000 },
                "zeroed": { "count": 0, "at": 0 },
                "malformed": { "count": "many", "at": null },
                "negative": { "count": -2, "at": 1000 },
            }
        }));
        let ids: Vec<&str> = p.usage.keys().map(String::as_str).collect();
        assert_eq!(ids, ["good", "negative"]);
        assert_eq!(p.usage["good"], UsageEntry { count: 3, at: 3000 });
        assert_eq!(p.usage["negative"], UsageEntry { count: 0, at: 1000 });
        // A typed field, not a leftover in `extra`.
        assert!(p
            .extra
            .as_object()
            .is_some_and(|e| e.get("usage").is_none() && e.is_empty()));
    }

    #[test]
    fn usage_caps_at_the_two_hundred_newest() {
        // 250 ascending stamps: the oldest fifty fall off the cap, the rest
        // keep theirs (storage.ts L1354).
        let mut raw = serde_json::Map::new();
        for i in 0..250 {
            raw.insert(format!("item-{i:03}"), json!({ "count": 1, "at": i }));
        }
        let p = normalise_preferences(&json!({ "usage": Value::Object(raw) }));
        assert_eq!(p.usage.len(), 200);
        assert!(p.usage.get("item-000").is_none());
        assert!(p.usage.get("item-049").is_none());
        assert_eq!(p.usage.get("item-050"), Some(&UsageEntry { count: 1, at: 50 }));
        assert_eq!(p.usage.get("item-249"), Some(&UsageEntry { count: 1, at: 249 }));
    }

    #[test]
    fn the_three_shipped_tags_are_seeded_once_and_never_duplicated() {
        let fresh = normalise_preferences(&json!({}));
        let names: Vec<&str> = fresh.tags.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, ["weak", "needs attention", "reused"]);
        assert_eq!(
            fresh.tags.iter().map(|t| t.hue).collect::<Vec<f64>>(),
            [8.0, 36.0, 268.0]
        );

        // A stored tag that is the seed by another spelling (case-insensitive
        // on the trimmed name) blocks the seed and keeps its own everything.
        let kept = normalise_preferences(&json!({
            "tags": [{"id": "tg_mine", "name": "  Weak ", "hue": 100}],
        }));
        assert_eq!(kept.tags.len(), 3);
        assert_eq!(kept.tags[0].id, "tg_mine");
        assert_eq!(kept.tags[0].name, "Weak");
        assert_eq!(kept.tags[0].hue, 100.0);
        assert_eq!(kept.tags[1].name, "needs attention");
    }

    #[test]
    fn a_stored_catalogue_is_cleaned_entry_by_entry() {
        let p = normalise_preferences(&json!({
            "tags": [
                {"id": "a", "name": "  work  ", "hue": 400},
                {"id": "a", "name": "a duplicate id loses"},
                {"id": "b", "name": "", "hue": -20},
                {"name": "no id at all"},
                {"id": "c", "name": "ok", "hue": 12.5},
                "junk",
                {"id": "d", "name": "bad hue", "hue": "orange"},
            ],
        }));
        let named: Vec<(&str, f64)> = p.tags.iter().map(|t| (t.name.as_str(), t.hue)).collect();
        // Four usable entries — first spelling of a duplicate id wins, blank
        // names become "Tag", hues wrap (400 -> 40, -20 -> 340) or fall back
        // to 210 — then the two seeds neither of them shadows.
        assert_eq!(
            named,
            [
                ("work", 40.0),
                ("Tag", 340.0),
                ("ok", 12.5),
                ("bad hue", 210.0),
                ("weak", 8.0),
                ("needs attention", 36.0),
                ("reused", 268.0),
            ]
        );
        // Typed field, not swallowed by `extra` — and cleaning is idempotent,
        // so the same document read twice agrees with itself.
        let back = serde_json::to_value(&p).unwrap();
        assert_eq!(back["tags"].as_array().unwrap().len(), 7);
        assert_eq!(normalise_preferences(&back).tags, p.tags);
    }

    #[test]
    fn a_created_tag_has_a_name_an_id_and_a_free_hue() {
        let blank = create_tag("   ", &[]);
        assert_eq!(blank.name, "Tag");
        assert_eq!(blank.hue, 210.0); // empty wheel: TS's fixed start
        assert_eq!(&blank.id[..3], "tg_");
        assert_eq!(blank.id.len(), 11); // "tg_" plus eight uuid characters

        // The seeds occupy buckets 0 (hue 8), 48 (36) and 264 (268), so the
        // first free bucket stepping the wheel by 24 is 24.
        let seeded = ensure_default_tags(Vec::new());
        let next = create_tag("  work ", &seeded);
        assert_eq!(next.name, "work");
        assert_eq!(next.hue, 24.0);
        assert!(!seeded.iter().any(|tag| tag.id == next.id));

        // Every bucket claimed: the deterministic scatter at the foot of
        // `pickFreeHue` — TS's (length * 47) % 360 — rather than a collision.
        let full: Vec<Tag> = (0..15)
            .map(|i| Tag { id: format!("tg_{i}"), name: format!("t{i}"), hue: (i * 24) as f64 })
            .collect();
        assert_eq!(create_tag("one more", &full).hue, 345.0);
    }

    #[test]
    fn default_tags_are_never_added_twice_by_repeated_loads() {
        let once = ensure_default_tags(Vec::new());
        let twice = ensure_default_tags(ensure_default_tags(once.clone()));
        assert_eq!(twice, once);
        assert_eq!(once.len(), 3);
    }
}