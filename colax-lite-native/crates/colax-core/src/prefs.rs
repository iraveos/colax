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
            sidebar_position: "left".into(),
            sidebar_labels: "both".into(),
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
    if obj.is_none() { return out; }
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
    out.sidebar_position = one_of(o.get("sidebarPosition").unwrap_or(&Value::Null), &["left","right","top","bottom"], "left");
    out.sidebar_labels = one_of(o.get("sidebarLabels").unwrap_or(&Value::Null), &["icon","name","both"], "both");

    // absorb everything we didn't model
    let mut extra = serde_json::Map::new();
    let known = ["theme","accent","textScale","motion","motionSpeed","ambient","density","roundness",
        "cardDepth","reduceTransparency","highContrast","backgroundImage","backgroundOpacity",
        "backgroundBlur","backgroundDim","view","sort","showUrls","sidebarPosition","sidebarLabels"];
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
    }

    #[test]
    fn known_enums_are_accepted() {
        let p = normalise_preferences(&json!({
            "theme": "dark", "accent": "sage", "density": "spacious",
            "view": "grid", "sort": "recent", "sidebarPosition": "right",
            "sidebarLabels": "icon",
        }));
        assert_eq!(p.theme, "dark");
        assert_eq!(p.accent, "sage");
        assert_eq!(p.density, "spacious");
        assert_eq!(p.view, "grid");
        assert_eq!(p.sort, "recent");
        assert_eq!(p.sidebar_position, "right");
        assert_eq!(p.sidebar_labels, "icon");
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
        assert_eq!(back["clearClipboardSeconds"], 30);
        assert_eq!(back["mailAccount"], "primary");
        assert_eq!(back["passwordGenerator"]["length"], 20);
        // and the typed keys are present too
        assert_eq!(back["accent"], "slate");
    }

    #[test]
    fn non_object_documents_read_as_defaults() {
        assert_eq!(normalise_preferences(&json!(null)), VaultPreferences::default());
        assert_eq!(normalise_preferences(&json!("dark")), VaultPreferences::default());
        assert_eq!(normalise_preferences(&json!([1, 2])), VaultPreferences::default());
    }
}