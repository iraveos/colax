//! Channels: the sidebar's saved filters, and the rule that turns one into a
//! list of logins.
//!
//! Port of `E:\acc2\src\vault\channels.ts` — `Channel` L56-96,
//! `CHANNEL_KIND_LABELS` L44-54, `BUILTIN_CHANNELS` L488-499,
//! `applyChannel` L551-605 — plus `findReusedPasswords` from `types.ts` L343.

use serde::{Deserialize, Serialize};

use crate::health::find_weak_items;
use crate::model::VaultItem;

/// The base filter a channel applies. `'tags'` behaves like `'all'`; the
/// channel's `tag_ids` then narrow it, so tags work on any channel rather
/// than only on purpose-built tag channels.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChannelKind {
    All,
    Favorites,
    Attention,
    Tags,
    Weak,
    Dashboard,
    Mail,
    Unassigned,
    History,
}

/// Human names for the built-in kinds. The TS file spells this out because
/// two screens used to render `channel.kind` verbatim and users saw
/// "favorites" where every other label was a proper name.
impl ChannelKind {
    pub fn label(&self) -> &'static str {
        match self {
            ChannelKind::All => "Everything",
            ChannelKind::Favorites => "Favorites",
            ChannelKind::Attention => "Needs attention",
            ChannelKind::Tags => "Tagged",
            ChannelKind::Weak => "Weak or reused",
            ChannelKind::Dashboard => "Dashboard",
            ChannelKind::Mail => "Mail",
            ChannelKind::Unassigned => "Unassigned",
            ChannelKind::History => "History",
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            ChannelKind::All => "all",
            ChannelKind::Favorites => "favorites",
            ChannelKind::Attention => "attention",
            ChannelKind::Tags => "tags",
            ChannelKind::Weak => "weak",
            ChannelKind::Dashboard => "dashboard",
            ChannelKind::Mail => "mail",
            ChannelKind::Unassigned => "unassigned",
            ChannelKind::History => "history",
        }
    }
}

/// The four calm accent names channels may carry.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChannelAccent {
    Slate,
    Sage,
    Dusk,
    Clay,
}

impl ChannelAccent {
    /// The four names the editor's Theme row offers, and the only four a
    /// stored channel may carry — `CHANNEL_ACCENTS.includes(accent)`.
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "slate" => Some(ChannelAccent::Slate),
            "sage" => Some(ChannelAccent::Sage),
            "dusk" => Some(ChannelAccent::Dusk),
            "clay" => Some(ChannelAccent::Clay),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            ChannelAccent::Slate => "slate",
            ChannelAccent::Sage => "sage",
            ChannelAccent::Dusk => "dusk",
            ChannelAccent::Clay => "clay",
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Channel {
    pub id: String,
    pub name: String,
    pub kind: ChannelKind,
    /// Tag ids that narrow this channel. Empty means "no tag filter".
    pub tag_ids: Vec<String>,
    /// Icon key, resolved in the UI.
    pub icon: String,
    /// Hue in degrees for the channel's dot and highlight.
    pub hue: i32,
    pub accent: ChannelAccent,
    /// https URL or uploaded data URL.
    pub background_image: String,
    pub background_opacity: f64,
    pub background_blur: f64,
    pub background_dim: f64,
    /// One of the shipped channels.
    pub builtin: bool,
    /// Cannot be deleted or reordered away — there must always be one view.
    pub locked: bool,
    /// Whether logins show their message expander while this channel is
    /// active.
    pub show_mail: bool,
    /// Which account's mail the expander reads: `'all'` or an account id.
    pub mail_account: String,
}

impl Default for Channel {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            kind: ChannelKind::All,
            tag_ids: Vec::new(),
            icon: "inbox".into(),
            hue: 212,
            accent: ChannelAccent::Slate,
            background_image: String::new(),
            background_opacity: 0.35,
            background_blur: 0.0,
            background_dim: 0.25,
            builtin: false,
            locked: false,
            show_mail: true,
            mail_account: "all".into(),
        }
    }
}

/// Hue used by channels that have not been recoloured.
const DEFAULT_CHANNEL_HUE: i32 = 212;

fn builtin(id: &str, name: &str, kind: ChannelKind, icon: &str, hue: i32, accent: ChannelAccent, locked: bool, show_mail: bool) -> Channel {
    Channel {
        id: id.into(),
        name: name.into(),
        kind,
        icon: icon.into(),
        hue,
        accent,
        builtin: true,
        locked,
        show_mail,
        ..Channel::default()
    }
}

/// The shipped rail. Seven rows, three of which are summary screens rather
/// than filtered lists — that distinction is what `apply_channel` encodes.
pub fn builtin_channels() -> Vec<Channel> {
    vec![
        builtin("all", "All logins", ChannelKind::All, "inbox", DEFAULT_CHANNEL_HUE, ChannelAccent::Slate, true, true),
        builtin("favorites", "Favorites", ChannelKind::Favorites, "star", 44, ChannelAccent::Slate, false, true),
        builtin("attention", "Needs attention", ChannelKind::Attention, "flag", 8, ChannelAccent::Clay, false, true),
        builtin("weak", "Weak or reused", ChannelKind::Weak, "shield", 152, ChannelAccent::Sage, false, true),
        builtin("dashboard", "Dashboard", ChannelKind::Dashboard, "grid", 268, ChannelAccent::Dusk, true, true),
        // Mail and History are structural like Dashboard: exactly one of each,
        // undeletable, but renameable/recolourable/movable like any other row.
        builtin("mail", "Mail", ChannelKind::Mail, "inbox", 205, ChannelAccent::Slate, true, false),
        builtin("history", "History", ChannelKind::History, "clock", 28, ChannelAccent::Clay, true, false),
    ]
}

/// Icon keys the sidebar knows how to draw.
pub const CHANNEL_ICONS: &[&str] = &[
    "inbox", "star", "flag", "shield", "layers", "key", "lock", "cloud", "grid", "clock",
];

/// `newChannelId` (channels.ts L518): `ch_` plus the first eight hex
/// characters of a random UUID, the same shape as `new_alarm_id`.
pub fn new_channel_id() -> String {
    let uuid = uuid::Uuid::new_v4().simple().to_string();
    format!("ch_{}", &uuid[..8])
}

/// `createChannel(name)` (channels.ts L755): the draft a new channel starts
/// from. The TS calls it with `''`, so the name lands on the literal
/// "New channel" — which is why its "Work logins" placeholder is never seen
/// — and everything else is the shipped default. The hue is random, so two
/// new channels do not look alike; `builtin` and `locked` are false whatever
/// the caller passed, because the TS strips both from the patch it accepts.
pub fn create_channel(name: &str) -> Channel {
    let trimmed = name.trim();
    Channel {
        id: new_channel_id(),
        name: if trimmed.is_empty() {
            "New channel".into()
        } else {
            trimmed.into()
        },
        kind: ChannelKind::All,
        tag_ids: Vec::new(),
        icon: "layers".into(),
        hue: (rand::random::<u32>() % 360) as i32,
        accent: ChannelAccent::Slate,
        builtin: false,
        locked: false,
        ..Channel::default()
    }
}

/// `normaliseBackgroundLook` (channels.ts L104): the three dials clamped to
/// the range their own sliders offer, so a hand-edited file cannot paint a
/// picture at 400% or blur it past the slider's top. A missing or
/// non-finite value falls back to the shipped look.
fn normalise_look(raw: &serde_json::Map<String, serde_json::Value>) -> (f64, f64, f64) {
    let number = |key: &str, dflt: f64| -> f64 {
        raw.get(key)
            .and_then(serde_json::Value::as_f64)
            .filter(|n| n.is_finite())
            .unwrap_or(dflt)
    };
    let default = Channel::default();
    (
        number("backgroundOpacity", default.background_opacity).clamp(0.0, 1.0),
        number("backgroundBlur", default.background_blur).clamp(0.0, 40.0),
        number("backgroundDim", default.background_dim).clamp(0.0, 0.9),
    )
}

/// `normaliseChannels` (channels.ts L648-752): the stored catalogue, cleaned,
/// with the shipped rows that are missing appended and `all` guaranteed — so
/// the shell always has a real view to fall back to.
///
/// The TS's three *adoption* passes (L698-737) are deliberately not ported:
/// they rewrite a custom channel somebody had named "Dashboard"/"Mail"/
/// "History" into the structural kind, which only matters for a document
/// written before those kinds existed. The append loop below already
/// guarantees exactly one row per kind, which is what the passes protect.
pub fn normalise_channels(stored: Option<&serde_json::Value>) -> Vec<Channel> {
    let Some(list) = stored.and_then(serde_json::Value::as_array) else {
        return builtin_channels();
    };
    let presets = builtin_channels();
    let mut out: Vec<Channel> = Vec::new();
    let mut seen: Vec<String> = Vec::new();

    for raw in list {
        let Some(obj) = raw.as_object() else { continue };
        let id = obj
            .get("id")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        if id.is_empty() || seen.iter().any(|known| known == id) {
            continue;
        }
        seen.push(id.to_string());
        let preset = presets.iter().find(|channel| channel.id == id);
        let kind = obj
            .get("kind")
            .and_then(|value| serde_json::from_value::<ChannelKind>(value.clone()).ok())
            .or_else(|| preset.map(|channel| channel.kind.clone()))
            .unwrap_or(ChannelKind::All);
        let name = obj
            .get("name")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_string)
            .or_else(|| preset.map(|channel| channel.name.clone()))
            .unwrap_or_else(|| "Channel".into());
        let icon = obj
            .get("icon")
            .and_then(serde_json::Value::as_str)
            .filter(|icon| !icon.is_empty())
            .map(str::to_string)
            .or_else(|| preset.map(|channel| channel.icon.clone()))
            .unwrap_or_else(|| "layers".into());
        let hue = obj
            .get("hue")
            .and_then(serde_json::Value::as_f64)
            .filter(|hue| hue.is_finite())
            .map(|hue| ((hue % 360.0) + 360.0) % 360.0)
            .unwrap_or(DEFAULT_CHANNEL_HUE as f64) as i32;
        let accent = obj
            .get("accent")
            .and_then(|value| serde_json::from_value::<ChannelAccent>(value.clone()).ok())
            .or_else(|| preset.map(|channel| channel.accent.clone()))
            .unwrap_or(ChannelAccent::Slate);
        let mut tag_ids: Vec<String> = Vec::new();
        if let Some(list) = obj.get("tagIds").and_then(serde_json::Value::as_array) {
            for value in list {
                if let Some(tag) = value.as_str() {
                    if !tag_ids.iter().any(|known| known == tag) {
                        tag_ids.push(tag.to_string());
                    }
                }
            }
        }
        let background_image = obj
            .get("backgroundImage")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_string();
        let (background_opacity, background_blur, background_dim) = normalise_look(obj);
        let mail_account = obj
            .get("mailAccount")
            .and_then(serde_json::Value::as_str)
            .filter(|account| !account.is_empty())
            .unwrap_or("all")
            .to_string();
        out.push(Channel {
            id: id.to_string(),
            name,
            kind: kind.clone(),
            tag_ids,
            icon,
            hue,
            accent,
            background_image,
            background_opacity,
            background_blur,
            background_dim,
            // Fixed by id, so a hand-edited file cannot promote a channel.
            builtin: preset.is_some(),
            // The fallback view and the three summary screens are structural:
            // there must always be one of each, so none can be deleted. They
            // can still be renamed, recoloured, hidden and moved.
            locked: id == "all"
                || matches!(
                    kind,
                    ChannelKind::Dashboard | ChannelKind::Mail | ChannelKind::History
                ),
            show_mail: obj.get("showMail").and_then(serde_json::Value::as_bool) != Some(false),
            mail_account,
        });
    }

    for preset in &presets {
        // A preset is only appended when nothing already plays its role.
        if !seen.iter().any(|known| known == &preset.id)
            && !out.iter().any(|channel| channel.kind == preset.kind)
        {
            out.push(Channel {
                tag_ids: Vec::new(),
                ..preset.clone()
            });
        }
    }
    if !out.iter().any(|channel| channel.kind == ChannelKind::All) {
        out.insert(
            0,
            Channel {
                tag_ids: Vec::new(),
                ..presets[0].clone()
            },
        );
    }
    out
}

/// Passwords used by more than one login, keyed by password so callers can
/// match on `item.password`.
pub fn find_reused_passwords(items: &[VaultItem]) -> std::collections::HashSet<String> {
    let mut usage: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
    for item in items {
        if item.password.is_empty() {
            continue;
        }
        *usage.entry(item.password.as_str()).or_insert(0) += 1;
    }
    usage
        .into_iter()
        .filter(|(_, count)| *count > 1)
        .map(|(password, _)| password.to_string())
        .collect()
}

/// Applies a channel to the vault.
///
/// The `kind` picks the base set; `tag_ids` then narrows it. `weak` is
/// derived rather than stored: reused, stale, guessable on its own, or
/// following the same pattern as another login.
///
/// `stale_after_days` is the global reminder, 180 by default.
pub fn apply_channel(
    channel: &Channel,
    items: &[VaultItem],
    stale_after_days: f64,
) -> Vec<VaultItem> {
    let list: Vec<VaultItem> = match channel.kind {
        ChannelKind::Favorites => items.iter().filter(|i| i.favorite).cloned().collect(),
        ChannelKind::Attention => items
            .iter()
            .filter(|i| i.needs_attention)
            .cloned()
            .collect(),
        ChannelKind::Unassigned => items
            .iter()
            .filter(|i| i.tags.is_empty())
            .cloned()
            .collect(),
        // The three summary screens are treated as "everything" so any tag
        // narrowing still behaves predictably.
        ChannelKind::Dashboard | ChannelKind::Mail | ChannelKind::History => items.to_vec(),
        // One analysis, one place (Task 1.4): the dashboard's buckets and
        // this channel must never disagree, so the rules live in `health`
        // and both call in.
        ChannelKind::Weak => find_weak_items(items, stale_after_days, now_ms() as i64)
            .into_iter()
            .cloned()
            .collect(),
        // 'all' and 'tags' both start from everything; 'tags' narrows below.
        ChannelKind::All | ChannelKind::Tags => items.to_vec(),
    };

    if channel.tag_ids.is_empty() {
        return list;
    }
    let wanted: std::collections::HashSet<&str> =
        channel.tag_ids.iter().map(String::as_str).collect();
    list.into_iter()
        .filter(|item| item.tags.iter().any(|tag| wanted.contains(tag.as_str())))
        .collect()
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::empty_item;
    use crate::strength::estimate_strength;

    fn item(id: &str, title: &str) -> VaultItem {
        let mut it = empty_item(id, 1_700_000_000_000);
        it.title = title.to_string();
        it
    }

    #[test]
    fn the_shipped_rail_is_seven_rows_and_three_are_screens() {
        let channels = builtin_channels();
        assert_eq!(channels.len(), 7);
        let screens = channels
            .iter()
            .filter(|c| {
                matches!(
                    c.kind,
                    ChannelKind::Dashboard | ChannelKind::Mail | ChannelKind::History
                )
            })
            .count();
        assert_eq!(screens, 3);
        // Three of the seven cannot be deleted, and 'all' is among them:
        // there must always be one view.
        let locked = channels.iter().filter(|c| c.locked).count();
        assert_eq!(locked, 4);
        assert!(channels.iter().find(|c| c.id == "all").unwrap().locked);
    }

    #[test]
    fn labels_are_proper_names_not_identifiers() {
        assert_eq!(ChannelKind::Favorites.label(), "Favorites");
        assert_eq!(ChannelKind::Attention.label(), "Needs attention");
        assert_eq!(ChannelKind::Weak.label(), "Weak or reused");
        assert_eq!(ChannelKind::All.as_str(), "all");
    }

    #[test]
    fn kind_and_tags_narrow_in_that_order() {
        let mut favorites = item("1", "Bank");
        favorites.favorite = true;
        let plain = item("2", "Mail");
        let mut tagged = item("3", "Work");
        tagged.tags = vec!["tg_work".into()];
        let items = vec![favorites.clone(), plain.clone(), tagged.clone()];

        let fav_channel = Channel {
            kind: ChannelKind::Favorites,
            ..Channel::default()
        };
        let got = apply_channel(&fav_channel, &items, 180.0);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].id, "1");

        // A tag filter narrows the *base* set: 'all' + the work tag.
        let tag_channel = Channel {
            kind: ChannelKind::All,
            tag_ids: vec!["tg_work".into()],
            ..Channel::default()
        };
        let got = apply_channel(&tag_channel, &items, 180.0);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].id, "3");

        // favorites + a tag the favorite does not carry -> nothing.
        let both = Channel {
            kind: ChannelKind::Favorites,
            tag_ids: vec!["tg_work".into()],
            ..Channel::default()
        };
        assert!(apply_channel(&both, &items, 180.0).is_empty());
    }

    #[test]
    fn summary_screens_list_everything() {
        let items = vec![item("1", "a"), item("2", "b")];
        for kind in [ChannelKind::Dashboard, ChannelKind::Mail, ChannelKind::History] {
            let channel = Channel {
                kind: kind.clone(),
                ..Channel::default()
            };
            assert_eq!(apply_channel(&channel, &items, 180.0).len(), 2);
        }
    }

    #[test]
    fn the_weak_channel_catches_reused_stale_and_guessable() {
        let mut a = item("1", "a");
        a.password = "same-password-1".into();
        let mut b = item("2", "b");
        b.password = "same-password-1".into(); // reused
        let mut c = item("3", "c");
        c.password = "correct-horse-battery-staple".into();
        c.password_updated_at = 1_000_000_000_000; // ancient -> stale
        let mut d = item("4", "d");
        d.password = "password123".into(); // common -> score 0
        let mut e = item("5", "e");
        e.password = String::new(); // never weak by emptiness
        let items = vec![a, b, c, d, e];

        let channel = Channel {
            kind: ChannelKind::Weak,
            ..Channel::default()
        };
        let mut got: Vec<String> = apply_channel(&channel, &items, 180.0)
            .into_iter()
            .map(|i| i.id)
            .collect();
        got.sort();
        assert_eq!(got, vec!["1", "2", "3", "4"]);
    }

    #[test]
    fn shared_patterns_are_weak_even_when_each_password_is_distinct() {
        let mut a = item("1", "a");
        a.password = "summer2023".into();
        let mut b = item("2", "b");
        b.password = "summer2024".into();
        let items = vec![a, b];
        let channel = Channel {
            kind: ChannelKind::Weak,
            ..Channel::default()
        };
        let got = apply_channel(&channel, &items, 180.0);
        assert_eq!(got.len(), 2, "both share the stem 'summer'");
    }

    #[test]
    fn a_per_login_reminder_overrides_the_global_one() {
        let mut fresh = item("1", "a");
        // A password that scores 3 on its own: the only way it reaches the
        // Weak channel is through its own 1-day reminder.
        fresh.password = "q7#vLm2$wR!pZx9K".into();
        assert!(estimate_strength(&fresh.password).score >= 3);
        // Recently changed, and asking for a 1-day reminder -> not stale yet.
        fresh.password_updated_at = now_ms() as i64;
        fresh.reminder_days = 1.0;
        let channel = Channel {
            kind: ChannelKind::Weak,
            ..Channel::default()
        };
        let got = apply_channel(&channel, &[fresh.clone()], 180.0);
        assert!(got.is_empty(), "a fresh password under its own reminder is not weak");

        // Past that reminder, the *personal* threshold wins over the global
        // 180 days: it is flagged at 1 day, not at 180.
        fresh.password_updated_at = (now_ms() - 3.0 * 86_400_000.0) as i64;
        assert_eq!(apply_channel(&channel, &[fresh], 180.0).len(), 1);
    }

    #[test]
    fn empty_passwords_never_count_as_weak() {
        let blank = item("1", "a");
        let channel = Channel {
            kind: ChannelKind::Weak,
            ..Channel::default()
        };
        assert!(apply_channel(&channel, &[blank], 180.0).is_empty());
    }

    /// `createChannel('')`: the literal name, the random hue, and the four
    /// fields a caller may not promote.
    #[test]
    fn a_new_channel_is_the_ts_draft() {
        let channel = create_channel("");
        assert_eq!(channel.name, "New channel");
        assert_eq!(channel.kind, ChannelKind::All);
        assert_eq!(channel.icon, "layers");
        assert_eq!(channel.accent, ChannelAccent::Slate);
        assert!(channel.tag_ids.is_empty());
        assert!((0..=359).contains(&channel.hue));
        assert!(!channel.builtin && !channel.locked);
        assert!(channel.background_image.is_empty());
        assert_eq!(channel.background_opacity, 0.35);
        assert_eq!(channel.background_blur, 0.0);
        assert_eq!(channel.background_dim, 0.25);
        assert!(channel.show_mail);
        assert_eq!(channel.mail_account, "all");
        // The id is `ch_` plus eight hex characters, and no two agree.
        assert!(channel.id.starts_with("ch_"));
        assert_eq!(channel.id.len(), 11);
        assert!(channel.id[3..].chars().all(|c| c.is_ascii_hexdigit()));
        let named = create_channel("  Work  ");
        assert_eq!(named.name, "Work");
        assert_ne!(named.id, channel.id);
    }

    /// A stored catalogue is cleaned, never trusted: an unknown kind reads as
    /// the preset's (or `all`), a 400° hue wraps, a hostile `builtin` is
    /// ignored, and the ids repeat only once.
    #[test]
    fn a_stored_catalogue_is_cleaned_and_completed() {
        let stored = serde_json::json!([
            { "id": "mine", "name": "  Work  ", "kind": "tags", "hue": 400,
              "accent": "neon", "tagIds": ["a", "a", 7], "icon": "",
              "backgroundOpacity": 9, "backgroundBlur": -4, "backgroundDim": "x",
              "builtin": true, "showMail": false, "mailAccount": "" },
            { "id": "mine", "name": "Second" },
            { "id": "favorites", "name": "Stars", "kind": "favorites" },
            { "id": "", "name": "Nameless" },
        ]);
        let channels = normalise_channels(Some(&stored));

        let mine = channels.iter().find(|c| c.id == "mine").expect("kept");
        assert_eq!(mine.name, "Work");
        assert_eq!(mine.kind, ChannelKind::Tags);
        assert_eq!(mine.hue, 40, "400 wraps into the circle");
        assert_eq!(mine.accent, ChannelAccent::Slate);
        assert_eq!(mine.tag_ids, vec!["a".to_string()]);
        assert_eq!(mine.icon, "layers");
        assert_eq!(mine.background_opacity, 1.0, "clamped to the slider");
        assert_eq!(mine.background_blur, 0.0);
        assert_eq!(mine.background_dim, 0.25, "a non-number falls back");
        assert!(!mine.builtin, "a hand-edited flag cannot promote a channel");
        assert!(!mine.show_mail);
        assert_eq!(mine.mail_account, "all");
        assert_eq!(
            channels.iter().filter(|c| c.id == "mine").count(),
            1,
            "an id appears once"
        );

        // The stored row kept its name and its kind, and is still builtin.
        let favorites = channels.iter().find(|c| c.id == "favorites").unwrap();
        assert_eq!(favorites.name, "Stars");
        assert!(favorites.builtin && !favorites.locked);

        // Every shipped row is present, in its canonical order, and the
        // structural three are locked.
        for preset in builtin_channels() {
            let got = channels
                .iter()
                .find(|c| c.id == preset.id)
                .unwrap_or_else(|| panic!("{} is missing", preset.id));
            assert_eq!(got.kind, preset.kind);
        }
        assert_eq!(channels[0].id, "mine", "the stored order is authoritative");
        assert!(channels.iter().find(|c| c.id == "dashboard").unwrap().locked);
        assert!(channels.iter().find(|c| c.id == "mail").unwrap().locked);
        assert!(channels.iter().find(|c| c.id == "history").unwrap().locked);

        // Nothing stored at all: exactly the shipped seven.
        assert_eq!(normalise_channels(None), builtin_channels());
        assert_eq!(normalise_channels(Some(&serde_json::json!("x"))).len(), 7);

        // A document whose `all` row was somehow dropped gets one back.
        let without_all = normalise_channels(Some(&serde_json::json!([
            { "id": "mine", "name": "Work", "kind": "favorites" },
        ])));
        assert!(without_all.iter().any(|c| c.id == "all"));
        assert_eq!(without_all[0].id, "mine");
    }

    /// A kind this build does not know reads as `all` — and a row that
    /// already plays the fallback's role means no second `all` row.
    #[test]
    fn an_unknown_kind_falls_back_to_all() {
        let channels = normalise_channels(Some(&serde_json::json!([
            { "id": "mine", "name": "Work", "kind": "nonsense" },
        ])));
        assert_eq!(channels[0].kind, ChannelKind::All);
        assert_eq!(
            channels
                .iter()
                .filter(|c| c.kind == ChannelKind::All)
                .count(),
            1,
            "the fallback view exists exactly once"
        );
    }

    /// A custom channel may play the role of a structural screen only by
    /// being the kind it is; the append loop must not add a second row that
    /// shows the same thing.
    #[test]
    fn a_custom_channel_that_plays_a_role_is_not_duplicated() {
        let stored = serde_json::json!([
            { "id": "mine", "name": "Work", "kind": "dashboard" },
        ]);
        let channels = normalise_channels(Some(&stored));
        assert_eq!(
            channels.iter().filter(|c| c.kind == ChannelKind::Dashboard).count(),
            1,
            "no second Dashboard beside the user's"
        );
        // It is not *builtin* (that is fixed by id) but it is locked, because
        // the role is what deletion is gated on.
        let mine = channels.iter().find(|c| c.id == "mine").unwrap();
        assert!(!mine.builtin && mine.locked);
    }
}
