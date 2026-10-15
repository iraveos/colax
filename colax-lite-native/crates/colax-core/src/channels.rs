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
}
