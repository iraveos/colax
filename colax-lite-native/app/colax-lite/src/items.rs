//! Turning vault items into the models `main.slint` renders.
//!
//! The contract lives in `ui/models.slint`; this file is the only place that
//! fills it in. Three jobs, all pure:
//!
//!   * `build_cards` — channel filter, then sort, then text query, then one
//!     `LoginCard` per surviving login (`App.tsx:visible`, L810-886).
//!   * `build_sidebar` — the rail, with counts, from `colax_core::channels`.
//!   * `search` / `sort_items` — the two halves, separately testable.
//!
//! **No password ever crosses this boundary.** `masked_password` is dots;
//! reveal asks the engine by id, in the handler that needs it.

use colax_core::model::accent_of;
use colax_core::{
    apply_channel, builtin_channels, estimate_strength, find_reused_passwords, normalise_preferences,
    Channel, ChannelKind, VaultItem, VaultPreferences,
};
use slint::{Color, ModelRc, VecModel};

use crate::{Badge, LoginCard, OptRow, SidebarRow, TagChip};

/// Shared label so every view agrees on what a login is called:
/// `title || username || hostname || "Untitled"` (views.tsx L40).
pub fn label_of(item: &VaultItem) -> String {
    if !item.title.is_empty() {
        return item.title.clone();
    }
    if !item.username.is_empty() {
        return item.username.clone();
    }
    match hostname_of(&item.url) {
        Some(host) => host,
        None => "Untitled".to_string(),
    }
}

/// The host part of a URL, for favicon lookups and the "open site" link.
/// Accepts a bare `example.com` by assuming https (`types.ts` L270).
pub fn hostname_of(url: &str) -> Option<String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return None;
    }
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let rest = with_scheme.split_once("://").map(|(_, r)| r)?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    // Drop userinfo and port.
    let host = authority.rsplit('@').next().unwrap_or("");
    let host = host.split(':').next().unwrap_or("");
    if host.is_empty() {
        None
    } else {
        Some(host.to_string())
    }
}

/// `••••••••`, length capped like `maskOf` in views.tsx L44 — a 400 character
/// password must not draw 400 dots.
pub fn mask_of(item: &VaultItem) -> String {
    let dots = item.password.len().min(26).max(10);
    "•".repeat(dots)
}

/// The text query, matching `App.tsx` L881: title, username, url, notes.
/// The needle arrives already lowercased.
pub fn search<'a>(items: &'a [VaultItem], needle: &str) -> Vec<&'a VaultItem> {
    if needle.is_empty() {
        return items.iter().collect();
    }
    items
        .iter()
        .filter(|item| {
            [item.title.as_str(), item.username.as_str(), item.url.as_str(), item.notes.as_str()]
                .iter()
                .any(|field| field.to_lowercase().contains(needle))
        })
        .collect()
}

/// The sort comparator from `App.tsx` L855-878, with `pinFavorites` folded
/// in as the first key. `manual` falls back to title order for ids the drag
/// order has never seen, so new logins need no bookkeeping.
pub fn sort_items(items: &mut [VaultItem], prefs: &VaultPreferences) {
    let manual_index = |id: &str| {
        prefs
            .manual_order
            .iter()
            .position(|known| known == id)
    };
    items.sort_by(|a, b| {
        if prefs.pin_favorites && a.favorite != b.favorite {
            // The favourite goes first: `a` is the one being placed.
            return if a.favorite {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            };
        }
        match prefs.sort.as_str() {
            "recent" => b.updated_at.cmp(&a.updated_at),
            "oldest" => a.updated_at.cmp(&b.updated_at),
            "strength" => {
                let aa = estimate_strength(&a.password).bits;
                let bb = estimate_strength(&b.password).bits;
                aa.cmp(&bb)
            }
            "username" => a
                .username
                .to_lowercase()
                .cmp(&b.username.to_lowercase()),
            "manual" => match (manual_index(&a.id), manual_index(&b.id)) {
                (Some(x), Some(y)) => x.cmp(&y),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => title_key(a).cmp(&title_key(b)),
            },
            _ => title_key(a).cmp(&title_key(b)),
        }
    });
}

fn title_key(item: &VaultItem) -> String {
    if item.title.is_empty() {
        "~".to_string()
    } else {
        item.title.to_lowercase()
    }
}

/// `hue -> a solid colour`, the same derivation the CSS uses for a tile.
pub(crate) fn hue_color(hue: i32) -> Color {
    let h = ((hue % 360) + 360) % 360;
    let h = h as f64 / 60.0;
    let s: f64 = 0.55;
    let l: f64 = 0.58;
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let x = c * (1.0 - (h % 2.0 - 1.0).abs());
    let (r1, g1, b1) = match h as i32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let m = l - c / 2.0;
    let ch = |v: f64| ((v + m) * 255.0).round().clamp(0.0, 255.0) as u8;
    Color::from_rgb_u8(ch(r1), ch(g1), ch(b1))
}

/// The health badges on a card: 2FA, reused, weak, old, needs attention —
/// computed once here so no view re-derives them (`HealthBadges` in
/// views.tsx L566-609).
///
/// Order and exclusions are the TS ones, and each is load-bearing:
///
/// * `2FA` is `isSecured`, never inferred from password strength. It is the
///   only badge that survives `showHealthBadges` being off, because it is the
///   user's own configuration rather than a guess.
/// * `weak` is suppressed when the password is already marked `reused`: one
///   problem must not earn two chips.
/// * There is deliberately no "you're fine" badge. A login with nothing
///   wrong gets nothing, which is what the TS `return null` says.
fn badges_for(
    item: &VaultItem,
    reused: &std::collections::HashSet<String>,
    stale_days: i64,
) -> Vec<Badge> {
    let mut out = Vec::new();

    if colax_core::is_secured(&item.security) {
        out.push(Badge { label: "2FA".into(), tone: 4 });
    }

    // An empty password is not "reused": `find_reused_passwords` already
    // skips empties, so this cannot fire for a login being typed.
    let is_reused = !item.password.is_empty() && reused.contains(&item.password);
    if is_reused {
        out.push(Badge { label: "reused".into(), tone: 1 });
    }
    // `!is_reused` first: reuse is the more specific finding and repeating it
    // as "weak" too would double-count one password.
    if !is_reused && colax_core::is_weak_password(&item.password) {
        out.push(Badge { label: "weak".into(), tone: 1 });
    }
    if is_stale(item, stale_days) {
        out.push(Badge { label: "old".into(), tone: 0 });
    }
    if item.needs_attention {
        out.push(Badge { label: "needs attention".into(), tone: 2 });
    }

    out
}

/// `isStale` in views.tsx L33: past the login's own reminder when it has
/// one, otherwise past the global `passwordAgeDays`. 0 disables the check.
pub fn is_stale(item: &VaultItem, stale_days: i64) -> bool {
    let effective = colax_core::stale_days_for(item, stale_days as f64) as i64;
    if effective <= 0 {
        return false;
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    now - item.password_updated_at > effective * 86_400_000
}

/// "Created 3 days ago" — or, when the two stamps match, both halves say the
/// same thing and one line replaces them (`ModifiedNote` in views.tsx L621).
fn modified_note(item: &VaultItem) -> String {
    let same_second = item.password_updated_at / 1000 == item.username_updated_at / 1000;
    if same_second && item.password_updated_at > 0 {
        return format!("Created {}", ago(item.password_updated_at));
    }
    let parts: Vec<String> = [
        ("Password", item.password_updated_at),
        ("Username", item.username_updated_at),
    ]
    .into_iter()
    .filter(|(_, at)| *at > 0)
    .map(|(what, at)| format!("{what} {}", ago(at)))
    .collect();
    parts.join(" · ")
}

fn ago(at_ms: i64) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let secs = ((now - at_ms) / 1000).max(0);
    let (value, unit) = if secs < 60 {
        (secs, "second")
    } else if secs < 3600 {
        (secs / 60, "minute")
    } else if secs < 86_400 {
        (secs / 3600, "hour")
    } else if secs < 2_592_000 {
        (secs / 86_400, "day")
    } else if secs < 31_536_000 {
        (secs / 2_592_000, "week")
    } else {
        (secs / 31_536_000, "year")
    };
    let plural = if value == 1 { "" } else { "s" };
    // "just now" for anything inside the last minute reads better than
    // "0 seconds ago".
    if value == 0 && unit == "second" {
        "just now".to_string()
    } else {
        format!("{value} {unit}{plural} ago")
    }
}

/// One card, from one item. `reused` is computed once for the whole vault
/// rather than per card: it is a cross-item property.
pub fn card_for(
    item: &VaultItem,
    reused: &std::collections::HashSet<String>,
    stale_days: i64,
    selected: bool,
) -> LoginCard {
    let hue = accent_of(item);
    let initial = label_of(item)
        .trim()
        .chars()
        .next()
        .map(|c| c.to_uppercase().collect::<String>())
        .unwrap_or_else(|| "?".into());
    let hostname = hostname_of(&item.url).unwrap_or_default();
    let has_image = !item.avatar_image.is_empty();
    LoginCard {
        id: item.id.clone().into(),
        label: label_of(item).into(),
        title: item.title.clone().into(),
        username: item.username.clone().into(),
        hostname: hostname.clone().into(),
        url: item.url.clone().into(),
        initial: initial.into(),
        tile: hue_color(hue),
        favorite: item.favorite,
        needs_attention: item.needs_attention,
        has_totp: !item.totp_secret.is_empty(),
        // The clock is Rust's job: the UI would need a timer per card.
        totp_code: String::new().into(),
        totp_remaining: 0,
        badges: ModelRc::new(VecModel::from(
            badges_for(item, reused, stale_days)
                .into_iter()
                .collect::<Vec<_>>(),
        )),
        tags: ModelRc::new(VecModel::from(Vec::<TagChip>::new())),
        notes: item.notes.clone().into(),
        masked_password: mask_of(item).into(),
        // `disabled={!item.password}` (views.tsx L852): the mask itself never
        // runs dry, so the row needs the truth, not its dots.
        has_password: !item.password.is_empty(),
        modified_note: modified_note(item).into(),
        secured: false,
        selected,
        duplicate: reused.contains(&item.password),
        // The list view's letter header; `group_by_letter` fills it in when
        // the view and the sort call for one.
        group: String::new().into(),
        hue,
        has_image,
        image: slint::Image::default(),
    }
}

/// The visible list: channel filter, dedupe, sort, then the text query.
/// Mirrors `App.tsx:visible` step for step.
pub fn build_cards(
    items: &[VaultItem],
    channel: &Channel,
    prefs: &VaultPreferences,
    needle: &str,
) -> Vec<LoginCard> {
    let stale_days = prefs.password_age_days;
    let mut list = apply_channel(channel, items, stale_days as f64);

    // One row per login, no matter the source: a duplicated id renders the
    // same login twice, which reads as ghost duplication.
    let mut seen = std::collections::HashSet::new();
    list.retain(|item| seen.insert(item.id.clone()));

    sort_items(&mut list, prefs);
    let reused = find_reused_passwords(items);
    let needle = needle.trim().to_lowercase();
    let mut cards: Vec<LoginCard> = search(&list, &needle)
        .into_iter()
        .map(|item| card_for(item, &reused, stale_days, false))
        .collect();
    // Letter headers belong to the List view and to no other, and only where
    // they agree with the sort (see `group_by_letter`).
    if prefs.view == "basic" && prefs.sort == "title" {
        group_by_letter(&mut cards);
    }
    cards
}

/// The six sort modes, in the order the TS menu lists them, and the label
/// each wears there (`SORT_LABELS`, App.tsx L110-117). One table: the button
/// label, the dropdown rows and the handler's whitelist all read it.
pub fn sort_label(sort: &str) -> &'static str {
    match sort {
        "recent" => "Recently updated",
        "oldest" => "Least recently updated",
        "strength" => "Weakest first",
        "username" => "Username",
        "manual" => "Custom order",
        _ => "Name",
    }
}

/// The sort menu itself, as the dropdown's model. Built from the same table
/// the labels come from, so a new sort mode is one match arm and cannot be
/// offered under a name the handler then refuses.
pub fn sort_options() -> Vec<OptRow> {
    ["title", "recent", "oldest", "strength", "username", "manual"]
        .into_iter()
        .map(|id| OptRow {
            id: id.into(),
            label: sort_label(id).into(),
        })
        .collect()
}

/// The List view's letter headers: the letter above the first card of each
/// run (`groupByLetter`, views.tsx L1605), bucketed by the same `labelOf`
/// every view names its cards with.
///
/// Only called where the sort and the grouping agree. TS buckets by letter
/// whatever the sort is, which quietly throws the chosen order away for the
/// List view; here the sort stays authoritative -- headers appear when it is
/// by name, where the two orders are the same order -- and the stable sort by
/// letter keeps that order inside each bucket even when the labels disagree
/// with it in the margins (a title starting with a digit, say).
fn group_by_letter(cards: &mut [LoginCard]) {
    cards.sort_by_key(letter_of);
    let mut last = None;
    for card in cards.iter_mut() {
        let letter = letter_of(card);
        card.group = if Some(letter) != last && letter != '#' {
            letter.to_string()
        } else {
            String::new()
        }
        .into();
        last = Some(letter);
    }
}

/// Which bucket a card belongs to: the label's first letter, upper-cased.
/// Anything that is not a letter sorts together at the end under `#`, which
/// is where a "1Password" would go in TS too.
fn letter_of(card: &LoginCard) -> char {
    card.label
        .chars()
        .find(|c| c.is_alphanumeric())
        .and_then(|c| c.to_uppercase().next())
        .unwrap_or('#')
}

/// The rail: channels with their counts, plus a separator before the
/// structural screens so the three summary rows read as a group.
///
/// Counts are over the *filtered* set (a tag-narrowed channel counts what it
/// shows), computed against every item — not against the current query.
///
/// The catalogue is the document's, not the shipped seven: a channel added
/// in Settings › Channels is a real row the moment it is saved, and one
/// whose eye is off is not a row at all. The TS walks `prefs.sidebar` for
/// the order and the nesting (folders, drag order — Phase 8); until that is
/// modelled, the catalogue's own order is the rail's, which is how
/// `normaliseChannels` leaves it: stored order first, shipped rows appended.
pub fn build_sidebar(items: &[VaultItem], selected: &str, prefs: &VaultPreferences) -> Vec<SidebarRow> {
    let stale_days = prefs.password_age_days;
    let mut rows = Vec::new();
    let channels = if prefs.channels.is_empty() {
        builtin_channels()
    } else {
        prefs.channels.clone()
    };
    for channel in channels {
        if prefs.hidden_channels.iter().any(|id| id == &channel.id) {
            continue;
        }
        // A hairline before the three summary screens: they are a different
        // kind of thing from the filtered lists above them, and the rail is
        // the only place that can say so.
        if channel.kind == ChannelKind::Dashboard {
            rows.push(separator_row());
        }
        let count = apply_channel(&channel, items, stale_days as f64).len() as i32;
        rows.push(SidebarRow {
            id: channel.id.clone().into(),
            kind: 0,
            label: channel.name.clone().into(),
            icon: channel.icon.clone().into(),
            hue: hue_color(channel.hue),
            count,
            depth: 0,
            expanded: false,
            hidden: false,
            locked: channel.locked,
            selected: channel.id == selected,
            is_builtin: channel.builtin,
        });
    }
    rows
}

/// A `kind: 2` row: a hairline, not a destination. It has no id because
/// nothing can select it, and no count because there is nothing to count.
fn separator_row() -> SidebarRow {
    SidebarRow {
        id: String::new().into(),
        kind: 2,
        label: String::new().into(),
        icon: String::new().into(),
        hue: hue_color(212), // DEFAULT_CHANNEL_HUE: the rail's own neutral
        count: 0,
        depth: 0,
        expanded: false,
        hidden: false,
        locked: false,
        selected: false,
        is_builtin: false,
    }
}

/// The channel currently selected, falling back to `all` for anything that
/// is not a real channel id (a first run, or a stale stored selection) — the
/// catalogue in preferences, so a channel the user made is a real row and a
/// deleted one falls back rather than showing a blank pane.
pub fn channel_by_id(prefs: &VaultPreferences, id: &str) -> Channel {
    let catalogue = if prefs.channels.is_empty() {
        builtin_channels()
    } else {
        prefs.channels.clone()
    };
    catalogue
        .into_iter()
        .find(|c| c.id == id)
        .unwrap_or_else(|| Channel {
            id: "all".into(),
            name: "All logins".into(),
            kind: ChannelKind::All,
            icon: "inbox".into(),
            builtin: true,
            locked: true,
            ..Channel::default()
        })
}

/// Preferences from the engine's raw document, with the app's own defaults
/// for anything the normaliser does not model.
pub fn prefs_from(raw: &serde_json::Value) -> VaultPreferences {
    normalise_preferences(raw)
}

#[cfg(test)]
mod tests {
    use super::*;
    use colax_core::empty_item;

    fn item(id: &str, title: &str) -> VaultItem {
        let mut it = empty_item(id, 1_700_000_000_000);
        it.title = title.to_string();
        it
    }

    #[test]
    fn labels_follow_the_documented_fallback_chain() {
        let mut it = item("1", "");
        assert_eq!(label_of(&it), "Untitled");
        it.username = "me@example.com".into();
        assert_eq!(label_of(&it), "me@example.com");
        it.url = "https://example.com/path".into();
        it.title = "Example".into();
        assert_eq!(label_of(&it), "Example");
        // A bare hostname works too, and wins when there is no username.
        let mut bare = item("2", "");
        bare.url = "example.com".into();
        assert_eq!(label_of(&bare), "example.com");
        assert_eq!(hostname_of("example.com").as_deref(), Some("example.com"));
        assert_eq!(hostname_of("https://user@host:8080/x").as_deref(), Some("host"));
        assert_eq!(hostname_of("   "), None);
    }

    /// A card's badges, with the vault-wide reuse set built from just this
    /// one item unless the test says otherwise.
    fn badges_of(it: &VaultItem) -> Vec<(String, i32)> {
        let reused = colax_core::find_reused_passwords(std::slice::from_ref(it));
        badges_for(it, &reused, 180)
            .into_iter()
            .map(|b| (b.label.to_string(), b.tone))
            .collect()
    }

    #[test]
    fn the_mask_is_dots_and_capped() {
        let mut it = item("1", "");
        it.password = "hunter2".into();
        assert_eq!(mask_of(&it), "•".repeat(10)); // short passwords floor at 10
        it.password = "x".repeat(400);
        assert_eq!(mask_of(&it), "•".repeat(26)); // and cap at 26
        assert!(mask_of(&it).chars().all(|c| c == '•'));
    }

    #[test]
    fn search_covers_title_username_url_and_notes_only() {
        let mut it = item("1", "Bank");
        it.username = "alice".into();
        it.url = "https://bank.example".into();
        it.notes = "recovery codes live here".into();
        let items = vec![it];

        for needle in ["bank", "alice", "bank.example", "recovery"] {
            assert_eq!(search(&items, needle).len(), 1, "needle={needle}");
        }
        // A tag name is *not* searched (App.tsx L881 lists four fields).
        assert!(search(&items, "nothing-matches").is_empty());
        assert_eq!(search(&items, "").len(), 1);
    }

    #[test]
    fn sorting_matches_each_documented_mode() {
        let mut a = item("a", "Zebra");
        a.updated_at = 100;
        let mut b = item("b", "apple");
        b.updated_at = 200;
        b.username = "zed".into();

        let mut items = vec![a.clone(), b.clone()];
        let mut prefs = VaultPreferences::default();
        prefs.sort = "recent".into();
        prefs.pin_favorites = false;
        sort_items(&mut items, &prefs);
        assert_eq!(items[0].id, "b"); // newer first

        let mut items = vec![a.clone(), b.clone()];
        prefs.sort = "oldest".into();
        sort_items(&mut items, &prefs);
        assert_eq!(items[0].id, "a");

        let mut items = vec![a.clone(), b.clone()];
        prefs.sort = "title".into();
        sort_items(&mut items, &prefs);
        // Case-insensitive: "apple" < "Zebra".
        assert_eq!(items[0].id, "b");

        let mut items = vec![a.clone(), b.clone()];
        prefs.sort = "username".into();
        sort_items(&mut items, &prefs);
        assert_eq!(items[0].id, "a"); // empty username sorts first

        // pinFavorites floats favourites whatever the mode says.
        let mut fav = a.clone();
        fav.favorite = true;
        let mut items = vec![b.clone(), fav];
        prefs.sort = "title".into();
        prefs.pin_favorites = true;
        sort_items(&mut items, &prefs);
        assert_eq!(items[0].id, "a");
    }

    #[test]
    fn letter_headers_belong_to_the_list_view_and_the_by_name_sort() {
        let all = channel_by_id(&VaultPreferences::default(), "all");
        let items = vec![
            item("1", "Mango"),
            item("2", "apple"),
            item("3", "Zebra"),
            item("4", "Avocado"),
        ];

        // List + by name: one header per letter, on the first card of the
        // run, case-insensitively sorted ("apple" before "Avocado").
        let mut prefs = VaultPreferences::default();
        prefs.view = "basic".into();
        prefs.sort = "title".into();
        prefs.pin_favorites = false;
        let cards = build_cards(&items, &all, &prefs, "");
        let labels: Vec<&str> = cards.iter().map(|c| c.label.as_str()).collect();
        let groups: Vec<&str> = cards.iter().map(|c| c.group.as_str()).collect();
        assert_eq!(labels, vec!["apple", "Avocado", "Mango", "Zebra"]);
        assert_eq!(groups, vec!["A", "", "M", "Z"]);

        // Sort by recency: the sort stays authoritative and no headers
        // appear -- TS buckets by letter whatever the sort is, which throws
        // the chosen order away; here it is the order that wins.
        prefs.sort = "recent".into();
        let cards = build_cards(&items, &all, &prefs, "");
        assert!(cards.iter().all(|c| c.group.is_empty()));

        // The other three views never group, whatever the sort says.
        prefs.sort = "title".into();
        for view in ["animated", "carousel", "grid"] {
            prefs.view = view.into();
            let cards = build_cards(&items, &all, &prefs, "");
            assert!(cards.iter().all(|c| c.group.is_empty()), "{view}");
        }
    }

    #[test]
    fn manual_order_places_listed_ids_then_everything_else_by_title() {
        let mut prefs = VaultPreferences::default();
        prefs.sort = "manual".into();
        prefs.pin_favorites = false;
        prefs.manual_order = vec!["b".into(), "a".into()];

        let mut items = vec![item("a", "Zebra"), item("b", "apple"), item("c", "Mango")];
        sort_items(&mut items, &prefs);
        // b, a from the drag order; c last because it was never dragged.
        let ids: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["b", "a", "c"]);

        // Two never-dragged ids fall back to title order.
        prefs.manual_order = vec!["b".into()];
        let mut items = vec![item("a", "Zebra"), item("c", "Mango")];
        sort_items(&mut items, &prefs);
        let ids: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["c", "a"]);
    }

    #[test]
    fn strength_sorts_weakest_first() {
        let mut weak = item("weak", "W");
        weak.password = "password123".into();
        let mut strong = item("strong", "S");
        strong.password = "q7#vLm2$wR!pZx9K".into();
        let mut prefs = VaultPreferences::default();
        prefs.sort = "strength".into();
        prefs.pin_favorites = false;
        let mut items = vec![strong, weak];
        sort_items(&mut items, &prefs);
        assert_eq!(items[0].id, "weak");
    }

    #[test]
    fn cards_never_carry_a_password() {
        let mut it = item("1", "Bank");
        it.password = "super-secret-value".into();
        let reused = std::collections::HashSet::new();
        let card = card_for(&it, &reused, 180, false);
        let serialized = format!("{card:?}");
        assert!(
            !serialized.contains("super-secret-value"),
            "the card model leaked the password: {serialized}"
        );
        assert!(card.masked_password.chars().all(|c| c == '•'));
        assert_eq!(card.label, "Bank");
    }

    #[test]
    fn the_four_problems_are_named_in_the_ts_order() {
        // The labels and their order come from `HealthBadges` in views.tsx:
        // 2FA, reused, weak, old, needs attention. Lowercase, because that is
        // what the TS chips render.
        let reused: std::collections::HashSet<String> =
            ["V7#kq2Lm!zR9wXe".to_string()].into_iter().collect();
        let mut it = item("1", "Bank");
        it.password = "V7#kq2Lm!zR9wXe".into();
        // A password from before the window, on a login the user flagged.
        it.password_updated_at = 1;
        it.needs_attention = true;
        let badges = badges_for(&it, &reused, 180);
        let labels: Vec<&str> = badges.iter().map(|b| b.label.as_str()).collect();
        assert_eq!(labels, ["reused", "old", "needs attention"], "{labels:?}");

        // `reused` is tone 1 (warn) and `needs attention` tone 2 (danger):
        // the user's own flag outranks a health guess.
        assert_eq!(badges[0].tone, 1);
        assert_eq!(badges[2].tone, 2);
    }

    #[test]
    fn staleness_honours_the_per_login_reminder_and_the_off_switch() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let mut it = item("1", "Bank");
        it.password_updated_at = now - 10 * 86_400_000; // 10 days ago

        assert!(!is_stale(&it, 180), "10 days is fresh under a 180 day rule");
        assert!(is_stale(&it, 7), "and stale under a 7 day rule");
        assert!(!is_stale(&it, 0), "0 disables the check");

        it.reminder_days = 5.0;
        assert!(is_stale(&it, 180), "the per-login 5 day reminder wins");
    }

    #[test]
    fn modification_notes_are_relative_and_join_both_parts() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let mut it = item("1", "Bank");
        it.password_updated_at = now - 2 * 86_400_000;
        it.username_updated_at = now - 8 * 60 * 60 * 1000;
        let note = modified_note(&it);
        assert!(note.starts_with("Password 2 days ago"), "{note}");
        assert!(note.contains("· Username"), "{note}");
        assert!(note.contains("ago"), "{note}");
    }

    #[test]
    fn the_sidebar_shows_every_builtin_channel_with_a_count() {
        let items = vec![
            {
                let mut it = item("1", "A");
                it.favorite = true;
                it
            },
            item("2", "B"),
        ];
        let rows = build_sidebar(&items, "all", &VaultPreferences::default());
        assert_eq!(rows.len(), 5); // 4 channels + 1 separator
        let all = rows.iter().find(|r| r.id == "all").unwrap();
        assert_eq!(all.count, 2);
        assert!(all.selected);
        // Favorites, Needs attention and Weak or reused are tabs of All
        // logins now, so they are gone from the rail — no rows, no counts.
        assert!(!rows.iter().any(|r| r.id == "favorites"));
        assert!(!rows.iter().any(|r| r.id == "attention"));
        assert!(!rows.iter().any(|r| r.id == "weak"));
        // Exactly one row is selected at a time.
        assert_eq!(rows.iter().filter(|r| r.selected).count(), 1);
        // A hairline separates the filtered lists from the three summary
        // screens, and it sits immediately before Dashboard.
        let dash = rows.iter().position(|r| r.id == "dashboard").unwrap();
        assert_eq!(rows[dash - 1].kind, 2);
        assert!(rows[dash - 1].id.is_empty(), "a separator is not selectable");
        assert_eq!(rows.iter().filter(|r| r.kind == 2).count(), 1);
        // Counts still line up: 5 rows, 4 channels.
        assert_eq!(rows.iter().filter(|r| r.kind == 0).count(), 4);
    }

    #[test]
    fn an_unknown_channel_selection_falls_back_to_all() {
        let channel = channel_by_id(&VaultPreferences::default(), "does-not-exist");
        assert_eq!(channel.id, "all");
        assert_eq!(channel.kind, ChannelKind::All);
    }

    #[test]
    fn build_cards_applies_channel_then_query() {
        let mut bank = item("1", "Bank");
        bank.password = "q7#vLm2$wR!pZx9K".into();
        bank.password_updated_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        let mut mail = item("2", "Mail");
        mail.favorite = true;
        mail.password = "q7#vLm2$wR!pZx9K".into();
        mail.password_updated_at = bank.password_updated_at;
        let items = vec![bank, mail];

        let prefs = VaultPreferences::default();
        let all = channel_by_id(&prefs, "all");
        assert_eq!(build_cards(&items, &all, &prefs, "").len(), 2);
        // Query narrows the channel's output.
        assert_eq!(build_cards(&items, &all, &prefs, "bank").len(), 1);

        // Favorites is a merged tab now, so it is not a channel row with an id
        // any more; the tab view is the All-logins channel with the kind swapped.
        let favs = Channel {
            kind: ChannelKind::Favorites,
            ..Channel::default()
        };
        let cards = build_cards(&items, &favs, &prefs, "");
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].label, "Mail");
    }

    #[test]
    fn a_login_with_nothing_wrong_gets_no_badge() {
        // The deliberate absence: TS `HealthBadges` returns null rather than
        // inventing a "Secured" pill. A badge that always appears says
        // nothing, and this one would have claimed a second factor that is
        // not configured.
        let mut it = item("1", "Bank");
        // A mixed random string rather than a word passphrase: the estimator
        // deliberately reads known-word passphrases as weaker than their
        // length suggests, so only a random one is safely "not weak".
        it.password = "V7#kq2Lm!zR9wXe".into();
        // 2023's timestamp is past the 180-day window, so move every stamp to
        // now to keep the age badge out of this assertion.
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        it.created_at = now;
        it.updated_at = now;
        it.password_updated_at = now;
        it.username_updated_at = now;
        assert!(badges_of(&it).is_empty(), "got {:?}", badges_of(&it));
    }

    #[test]
    fn the_two_fa_badge_comes_from_the_security_block_only() {
        let mut it = item("1", "Bank");
        it.password = "V7#kq2Lm!zR9wXe".into();
        assert!(
            !badges_of(&it).iter().any(|(l, _)| l == "2FA"),
            "a strong password must not earn 2FA"
        );

        it.security = colax_core::normalise_security(Some(&serde_json::json!({
            "totp": { "seed": "GEZDGNBVGY3TQOJQ" }
        })));
        let badges = badges_of(&it);
        assert!(
            badges.iter().any(|(l, _)| l == "2FA"),
            "a configured second factor must show: {badges:?}"
        );
    }

    #[test]
    fn a_reused_password_is_not_called_weak_as_well() {
        // One problem, one chip: TS computes `weak = !reused && isWeak(...)`.
        let mut weak = item("1", "Bank");
        weak.password = "password".into();
        assert!(
            badges_of(&weak).iter().any(|(l, _)| l == "weak"),
            "a guessable password on its own is weak"
        );

        let mut twin = item("2", "Other");
        twin.password = "password".into();
        let both = find_reused_passwords(&[weak.clone(), twin.clone()]);
        for it in [&weak, &twin] {
            let labels: Vec<String> = badges_for(it, &both, 180)
                .into_iter()
                .map(|b| b.label.to_string())
                .collect();
            assert!(labels.contains(&"reused".to_string()), "{labels:?}");
            assert!(!labels.contains(&"weak".to_string()), "{labels:?}");
        }
    }

    #[test]
    fn an_empty_password_is_never_weak_or_reused() {
        // A login still being typed. Its age is still judged normally -- an
        // untouched old record is still old -- so the stamps go to now to
        // isolate what this is about.
        let mut it = item("1", "Draft");
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        it.password_updated_at = now;
        it.username_updated_at = now;
        let labels: Vec<String> = badges_of(&it).into_iter().map(|(l, _)| l).collect();
        assert!(!labels.iter().any(|l| l == "weak"), "{labels:?}");
        assert!(!labels.iter().any(|l| l == "reused"), "{labels:?}");
    }

    #[test]
    fn matching_stamps_read_as_created_not_twice() {
        let mut it = item("1", "Bank");
        it.password_updated_at = 1_700_000_000_000;
        it.username_updated_at = 1_700_000_000_000;
        let note = modified_note(&it);
        assert!(note.starts_with("Created "), "{note}");
        assert!(!note.contains('·'), "one fact, not two: {note}");

        // Differing stamps name each field, and the second one is the
        // username -- not "Email", which mislabels logins whose username is
        // not an address.
        it.username_updated_at = 1_700_000_000_000 + 5_000;
        let note = modified_note(&it);
        assert!(note.contains("Password "), "{note}");
        assert!(note.contains("Username "), "{note}");
    }
}
