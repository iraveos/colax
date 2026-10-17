//! The Optimize tab's vocabulary, kept out of the UI on purpose (`optimize.ts`).
//!
//! The panel, its one-click profiles, the saved profiles below and the counter
//! that reads "n of 10" all used to be three separate lists of the same thing,
//! which is how a counter ends up disagreeing with the switches it counts. Here
//! there is exactly one definition of each: [`OPTIMISATIONS`] is the single
//! source for what the rows read, [`style_from_prefs`]/[`apply_style`] convert
//! between a preference record and a profile, and the preset styles are the
//! named buttons.
//!
//! Everything a profile holds is a real, existing preference. Nothing here is a
//! parallel "performance mode" flag, so applying a profile cannot leave the app
//! in a state the rest of the app does not already understand.

use std::collections::BTreeMap;
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::prefs::VaultPreferences;

/// The shipped card depth. Mirrored from the preference defaults, which import
/// the full-detail style below for these same fields, so the two cannot drift.
const DEFAULT_CARD_DEPTH: f64 = 0.4;
/// The shipped background, as `(opacity, blur, dim)` — the same three numbers
/// the Background tab's sliders start from.
const DEFAULT_BACKGROUND: (f64, f64, f64) = (0.35, 0.0, 0.25);

/// The preference fields the Optimize tab and its profiles own
/// (`OptimizeStyle`, optimize.ts L32).
///
/// A profile stores these and nothing else: applying one can change how the
/// app looks and how often it polls mail, never a login, tag, channel or
/// mailbox.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OptimizeStyle {
    pub motion: f64,
    pub motion_speed: f64,
    /// The small transitions on buttons, chips, tabs, rows and badges.
    pub micro_motion: bool,
    pub ambient: f64,
    pub reduce_transparency: bool,
    pub density: String,
    pub card_depth: f64,
    pub background_image: String,
    pub background_opacity: f64,
    pub background_blur: f64,
    pub background_dim: f64,
    /// Seconds between automatic mail checks for every connected mailbox, or
    /// `None` to leave polling exactly as the user set it. A profile that
    /// always wrote a number would silently rewrite mailboxes the user had
    /// deliberately set to "Off".
    pub mail_refresh_seconds: Option<i64>,
    /// Whether opening an HTML message also fetches its inline images.
    ///
    /// The largest per-message memory saving available: the reader skips up to
    /// four images of 512 KB each. Counted as its own optimisation for the
    /// same reason `disable_spellcheck` is — a profile that did not carry it
    /// would leave the saving behind every time it was applied.
    pub mail_inline_images: bool,
    /// Switches the spellchecker (and its per-language dictionaries) off.
    /// Not appearance, but it is the same kind of trade, and a profile that
    /// did not carry it would leave one saving behind every time it was
    /// applied.
    pub disable_spellcheck: bool,
}

/// One saved look (`OptimizeProfile`, optimize.ts L69): a name, when it was
/// taken, and the style above.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OptimizeProfile {
    pub id: String,
    pub name: String,
    /// Milliseconds, `Date.now()` in the TS. `0` when the stored record had
    /// no readable value, which sorts it last.
    pub created_at: i64,
    pub style: OptimizeStyle,
}

/// What the app looks like with nothing traded away. Also the "restore"
/// target when there is no snapshot.
pub static FULL_DETAIL_STYLE: LazyLock<OptimizeStyle> = LazyLock::new(|| OptimizeStyle {
    motion: 1.0,
    // The shipped animation speed, at the top of its slider ("Instant"). Kept
    // in step with the preference defaults so "restore my look" restores the
    // speed the app ships with rather than half-speed.
    motion_speed: 2.0,
    micro_motion: true,
    ambient: 1.0,
    reduce_transparency: false,
    density: "comfortable".into(),
    card_depth: DEFAULT_CARD_DEPTH,
    background_image: String::new(),
    background_opacity: DEFAULT_BACKGROUND.0,
    background_blur: DEFAULT_BACKGROUND.1,
    background_dim: DEFAULT_BACKGROUND.2,
    mail_refresh_seconds: None,
    mail_inline_images: true,
    disable_spellcheck: false,
});

/// Halfway: less motion, flatter, and mail on a 5-minute cadence.
pub static BALANCED_STYLE: LazyLock<OptimizeStyle> = LazyLock::new(|| OptimizeStyle {
    motion: 0.4,
    // 1 — the app's normal pace. This used to be 0.6, which stretched every
    // transition *at the same time as* cutting animation: the profile was
    // called "Balanced" and felt like a slow-motion mode.
    motion_speed: 1.0,
    // The small transitions stay: they are what the profile is trading down
    // from, and they cost a few frames per interaction rather than per second.
    micro_motion: true,
    ambient: 0.3,
    reduce_transparency: true,
    card_depth: 0.4,
    mail_refresh_seconds: Some(300),
    ..(*FULL_DETAIL_STYLE).clone()
});

/// Everything off: no motion at all, no ambient gradient, no blur, flat
/// compact cards, 15-minute mail.
///
/// `motion_speed` is pinned at the fastest setting rather than the slowest —
/// with `motion: 0` there is nothing left to slow down, but the value is what
/// a user sees if they switch motion back on from here, and it used to be
/// 0.25 ("Languid"), so the profile could hand back a slower app than it
/// found.
pub static MAX_SAVINGS_STYLE: LazyLock<OptimizeStyle> = LazyLock::new(|| OptimizeStyle {
    motion: 0.0,
    motion_speed: 2.0,
    micro_motion: false,
    ambient: 0.0,
    reduce_transparency: true,
    density: "compact".into(),
    card_depth: 0.0,
    mail_refresh_seconds: Some(900),
    mail_inline_images: false,
    disable_spellcheck: true,
    ..(*FULL_DETAIL_STYLE).clone()
});

/// How long a mailbox may go between automatic checks and still count as
/// leaned on (`SLOW_MAIL_SECONDS`, optimize.ts L138).
pub const SLOW_MAIL_SECONDS: i64 = 300;

/// One row of the panel's switch list: an id and what "on" reads like.
pub struct Optimisation {
    pub id: &'static str,
    pub on: fn(&VaultPreferences) -> bool,
}

// The mail rows below read the connected mailboxes the way the document
// stores them until Task 9.1 models the account records: an untyped
// `gmailAccounts` array in `extra`, each record carrying `refreshSeconds`.
// A record without a readable number reads as `None` — which is exactly what
// `undefined >= 300` and `v === first` mean to the TS, so the two rows stay
// honest about a mailbox they cannot parse.

/// The connected mailboxes' cadences, in stored order. `None` where a record
/// has no readable `refreshSeconds`.
fn mail_cadences(prefs: &VaultPreferences) -> Vec<Option<i64>> {
    prefs
        .extra
        .get("gmailAccounts")
        .and_then(Value::as_array)
        .map(|accounts| {
            accounts
                .iter()
                .map(|account| {
                    account
                        .get("refreshSeconds")
                        .and_then(Value::as_f64)
                        .map(|seconds| seconds.round() as i64)
                })
                .collect()
        })
        .unwrap_or_default()
}

fn on_motion(prefs: &VaultPreferences) -> bool {
    prefs.motion <= 0.001
}

// Micro-animations are counted here as their own saving: they are the only
// animation left when `motion` is off, so a profile cannot call itself "max"
// while still painting transitions on every hover.
fn on_micro(prefs: &VaultPreferences) -> bool {
    !prefs.micro_motion
}

fn on_ambient(prefs: &VaultPreferences) -> bool {
    prefs.ambient <= 0.05
}

fn on_transparency(prefs: &VaultPreferences) -> bool {
    prefs.reduce_transparency
}

fn on_density(prefs: &VaultPreferences) -> bool {
    prefs.density == "compact"
}

fn on_cards(prefs: &VaultPreferences) -> bool {
    prefs.card_depth <= 0.05
}

// Either nothing polls (no mailbox connected), or everything polls slowly.
// Counting "no mailboxes" as *off* was the last way the total stayed out of
// reach on a fresh install: there is no background mail cost to save, so the
// saving is real and the row says so — switched on and locked.
fn on_mail(prefs: &VaultPreferences) -> bool {
    let cadences = mail_cadences(prefs);
    cadences.is_empty()
        || cadences
            .iter()
            .all(|cadence| matches!(cadence, Some(seconds) if *seconds >= SLOW_MAIL_SECONDS))
}

fn on_background(prefs: &VaultPreferences) -> bool {
    prefs.background_image.is_empty()
}

// Skipped inline images are the biggest per-message saving on offer — a
// couple of megabytes of base64 that would otherwise sit in memory for the
// rest of the session — so the switch counts like any other.
fn on_mail_images(prefs: &VaultPreferences) -> bool {
    !prefs.mail_inline_images
}

fn on_spellcheck(prefs: &VaultPreferences) -> bool {
    prefs.disable_spellcheck
}

/// The switches the panel renders, in the order it renders them
/// (`OPTIMISATIONS`, optimize.ts L149). `on` reads the preference its row
/// writes, so the readout, the toggles and the presets cannot drift apart.
pub const OPTIMISATIONS: [Optimisation; 10] = [
    Optimisation { id: "motion", on: on_motion },
    Optimisation { id: "micro", on: on_micro },
    Optimisation { id: "ambient", on: on_ambient },
    Optimisation { id: "transparency", on: on_transparency },
    Optimisation { id: "density", on: on_density },
    Optimisation { id: "cards", on: on_cards },
    Optimisation { id: "mail", on: on_mail },
    Optimisation { id: "background", on: on_background },
    Optimisation { id: "mailImages", on: on_mail_images },
    Optimisation { id: "spellcheck", on: on_spellcheck },
];

/// How many switches there are to count (`OPTIMISATION_COUNT`): the readout
/// reaches this number or it is broken, and there are ten since inline-image
/// fetching joined the list.
pub const OPTIMISATION_COUNT: usize = OPTIMISATIONS.len();

/// How many of those switches are on right now.
pub fn optimisations_on(prefs: &VaultPreferences) -> usize {
    OPTIMISATIONS
        .iter()
        .filter(|entry| (entry.on)(prefs))
        .count()
}

/// The style a preference record currently describes (`styleFromPrefs`). The
/// cadence is deliberately never claimed here: `snapshot_style` is the one
/// that reads it, so a plain profile save never pins one.
pub fn style_from_prefs(prefs: &VaultPreferences) -> OptimizeStyle {
    OptimizeStyle {
        motion: prefs.motion,
        motion_speed: prefs.motion_speed,
        micro_motion: prefs.micro_motion,
        ambient: prefs.ambient,
        reduce_transparency: prefs.reduce_transparency,
        density: prefs.density.clone(),
        card_depth: prefs.card_depth,
        background_image: prefs.background_image.clone(),
        background_opacity: prefs.background_opacity,
        background_blur: prefs.background_blur,
        background_dim: prefs.background_dim,
        mail_refresh_seconds: None,
        mail_inline_images: prefs.mail_inline_images,
        disable_spellcheck: prefs.disable_spellcheck,
    }
}

/// A style that describes the whole current look, including the mail cadence
/// when every mailbox shares one. Used to snapshot what was there *before* a
/// savings preset, so "Restore my look" puts the cadence back too instead of
/// leaving mailboxes stretched to a cadence the user never chose.
pub fn snapshot_style(prefs: &VaultPreferences) -> OptimizeStyle {
    let mut style = style_from_prefs(prefs);
    let cadences = mail_cadences(prefs);
    style.mail_refresh_seconds = match cadences.first() {
        Some(Some(first)) if cadences.iter().all(|cadence| *cadence == Some(*first)) => {
            Some(*first)
        }
        _ => None,
    };
    style
}

/// The preference patch that puts a style back (`stylePatch`), applied
/// straight to the record. The TS returns an object the caller spreads; here
/// the caller clones the current preferences, calls this on the clone to
/// measure `optimisations_on` on the "after", then saves what it wrote.
///
/// The mail cadence is applied to the accounts that exist rather than stored
/// as a number the app would have to consult on every poll, so what the
/// Optimize panel shows in the mailbox rows is what actually happens.
pub fn apply_style(prefs: &mut VaultPreferences, style: &OptimizeStyle) {
    prefs.motion = style.motion;
    prefs.motion_speed = style.motion_speed;
    prefs.micro_motion = style.micro_motion;
    prefs.ambient = style.ambient;
    prefs.reduce_transparency = style.reduce_transparency;
    prefs.density = style.density.clone();
    prefs.card_depth = style.card_depth;
    prefs.background_image = style.background_image.clone();
    prefs.background_opacity = style.background_opacity;
    prefs.background_blur = style.background_blur;
    prefs.background_dim = style.background_dim;
    prefs.mail_inline_images = style.mail_inline_images;
    prefs.disable_spellcheck = style.disable_spellcheck;
    if let Some(seconds) = style.mail_refresh_seconds {
        if let Some(accounts) = prefs
            .extra
            .get_mut("gmailAccounts")
            .and_then(Value::as_array_mut)
        {
            for account in accounts {
                if let Some(record) = account.as_object_mut() {
                    record.insert("refreshSeconds".into(), Value::from(seconds));
                }
            }
        }
    }
}

/// Two styles are the same when every field a profile owns matches.
pub fn same_style(a: &OptimizeStyle, b: &OptimizeStyle) -> bool {
    a == b
}

/// Only ever a data URL or an http(s) URL: the same rule the appearance
/// settings enforce (`is_allowed_image_src`), re-checked here because a
/// profile travels in backups — with this list's one addition, the empty
/// string, which is the "no picture" value the style carries. The TS regex
/// here reads the scheme case-insensitively and the shared helper does not,
/// so a `HTTPS://` scheme falls back to no picture, which is safe either way.
fn is_background_url(url: &str) -> bool {
    url.is_empty() || crate::model::is_allowed_image_src(url)
}

/// Reads one stored style, field by field (`readStyle`, optimize.ts L286).
///
/// Every number is clamped to the range its slider allows and every enum is
/// checked, so a hand-edited or truncated record restores a usable look
/// instead of a broken one. A style written by an older build that lacks a
/// field still loads: the missing field falls back to full detail.
pub fn read_style(raw: &Value) -> Option<OptimizeStyle> {
    let record = raw.as_object()?;
    let clamp = |key: &str, min: f64, max: f64, fallback: f64| -> f64 {
        record
            .get(key)
            .and_then(Value::as_f64)
            .filter(|value| value.is_finite())
            .map(|value| value.clamp(min, max))
            .unwrap_or(fallback)
    };
    // Only the two non-default names are accepted, and kept as written; the
    // TS's `density === 'compact' || density === 'spacious'` reads the same
    // way — anything else, including a fat-fingered word, is full detail.
    let density = match record.get("density").and_then(Value::as_str) {
        Some(density @ ("compact" | "spacious")) => density.to_string(),
        _ => "comfortable".to_string(),
    };
    let background_image = match record.get("backgroundImage").and_then(Value::as_str) {
        Some(url) if is_background_url(url) => url.to_string(),
        _ => String::new(),
    };
    let mail_refresh_seconds = record
        .get("mailRefreshSeconds")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0)
        .map(|value| value.round().min(3600.0) as i64);
    Some(OptimizeStyle {
        motion: clamp("motion", 0.0, 1.0, 1.0),
        // The top of the animation-speed slider.
        motion_speed: clamp("motionSpeed", 1.0, 2.0, 2.0),
        // A profile saved before this switch existed has no field; it restores
        // the full-detail behaviour (on) rather than silently turning
        // animations off.
        micro_motion: record.get("microMotion").and_then(Value::as_bool) != Some(false),
        ambient: clamp("ambient", 0.0, 1.0, 1.0),
        reduce_transparency: record.get("reduceTransparency").and_then(Value::as_bool)
            == Some(true),
        density,
        card_depth: clamp("cardDepth", 0.0, 1.0, DEFAULT_CARD_DEPTH),
        background_image,
        background_opacity: clamp("backgroundOpacity", 0.0, 1.0, 0.35),
        background_blur: clamp("backgroundBlur", 0.0, 40.0, 0.0),
        background_dim: clamp("backgroundDim", 0.0, 0.9, 0.25),
        mail_refresh_seconds,
        // The same "before this switch existed" reading as microMotion above.
        mail_inline_images: record.get("mailInlineImages").and_then(Value::as_bool)
            != Some(false),
        disable_spellcheck: record.get("disableSpellcheck").and_then(Value::as_bool)
            == Some(true),
    })
}

/// Up to this many profiles; the list is a menu, not an archive
/// (`MAX_OPTIMIZE_PROFILES`).
pub const MAX_OPTIMIZE_PROFILES: usize = 12;
/// The longest a profile name may be (`MAX_PROFILE_NAME`).
const MAX_PROFILE_NAME: usize = 40;

/// `newOptimizeProfileId` (optimize.ts L330): `opt_` plus a short random
/// tail. The TS draws base-36 from `Math.random` plus the clock; this is the
/// first eight hex characters of a random UUID, the same shape
/// `new_channel_id` uses — the ids only need to be unique.
pub fn new_optimize_profile_id() -> String {
    let uuid = uuid::Uuid::new_v4().simple().to_string();
    format!("opt_{}", &uuid[..8])
}

/// Trims and bounds a profile name, refusing to return an empty one
/// (`cleanProfileName`, optimize.ts L335). Its default fallback is
/// "Untitled look", which the two call sites spell out here.
pub fn clean_profile_name(name: &str, fallback: &str) -> String {
    let collapsed = name.split_whitespace().collect::<Vec<_>>().join(" ");
    // The TS slices code units; this slices chars, which only differs for a
    // name built from surrogate pairs — and never truncates one in half.
    let trimmed: String = collapsed.chars().take(MAX_PROFILE_NAME).collect();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed
    }
}

/// Every stored profile, cleaned and deduplicated by name (newest wins)
/// (`normaliseOptimizeProfiles`, optimize.ts L345). A profile whose style
/// cannot be read at all is dropped rather than restored as a mystery.
pub fn normalise_optimize_profiles(raw: &Value) -> Vec<OptimizeProfile> {
    let Some(entries) = raw.as_array() else {
        return Vec::new();
    };
    // `raw.slice(-MAX_OPTIMIZE_PROFILES * 2)`: only the last 24 entries are
    // even considered, so a document padded with stale rows cannot cost
    // anything to load.
    let start = entries.len().saturating_sub(MAX_OPTIMIZE_PROFILES * 2);
    let mut by_name: BTreeMap<String, OptimizeProfile> = BTreeMap::new();
    for entry in &entries[start..] {
        let Some(record) = entry.as_object() else { continue };
        let Some(style) = read_style(record.get("style").unwrap_or(&Value::Null)) else {
            continue;
        };
        let name =
            clean_profile_name(record.get("name").and_then(Value::as_str).unwrap_or(""), "Untitled look");
        let profile = OptimizeProfile {
            id: match record.get("id").and_then(Value::as_str) {
                Some(id) if !id.is_empty() => id.to_string(),
                _ => new_optimize_profile_id(),
            },
            created_at: record
                .get("createdAt")
                .and_then(Value::as_f64)
                .filter(|value| value.is_finite())
                .map(|value| value as i64)
                .unwrap_or(0),
            name: name.clone(),
            style,
        };
        let key = name.to_lowercase();
        let wins = match by_name.get(&key) {
            None => true,
            // `existing.createdAt <= profile.createdAt`: on a tie the one
            // later in the array wins, which is also the newer of two equal
            // stamps.
            Some(existing) => existing.created_at <= profile.created_at,
        };
        if wins {
            by_name.insert(key, profile);
        }
    }
    let mut out: Vec<OptimizeProfile> = by_name.into_values().collect();
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    out.truncate(MAX_OPTIMIZE_PROFILES);
    out
}
