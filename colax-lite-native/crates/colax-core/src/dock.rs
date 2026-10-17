//! Quick-launch dock bars: the typed shape, the defaults, and the normaliser.
//!
//! Port of `src/vault/storage.ts` L104-192 (the types and defaults),
//! L985-1075 (`normaliseDockPos`, `restoreOrbitSlot`, `normaliseDockSlots`)
//! and L1391-1436 (the preference-level `docks` migration in
//! `normalisePreferences`).
//!
//! The bars are deliberately *not* four fixed slots: up to four bars exist,
//! each dragged anywhere in the window, and the nearest edge on drop decides
//! whether it reflows to a row or a column. A bar's spot is stored as viewport
//! fractions, so it survives a resize without being pinned to pixels.
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// What a slot stands for. The renderer skips a slot whose target no longer
/// exists, so deleting a channel cannot break the bar (storage.ts L110-114).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DockSlotKind {
    View,
    Channel,
    Folder,
    Login,
    Inbox,
    Mailbox,
}

/// What pressing a login slot does ('both' is the historic behaviour).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DockLoginAction {
    Password,
    Email,
    Both,
    Edit,
    Messages,
}

/// Which edge the bar snaps its orientation to.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DockPosition {
    Bottom,
    Top,
    Left,
    Right,
}

/// Where a bar sits: viewport fractions (0-1) plus the snapped edge.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct DockPlacement {
    pub edge: DockPosition,
    /// 0-1 across the viewport width.
    pub fx: f64,
    /// 0-1 down the viewport height.
    pub fy: f64,
}

impl Default for DockPlacement {
    /// The shipped bar's spot (`DEFAULT_PREFERENCES.docks[0].pos`,
    /// storage.ts L898).
    fn default() -> Self {
        Self { edge: DockPosition::Bottom, fx: 0.5, fy: 0.94 }
    }
}

/// One slot's configuration. `label`, `icon` and `action` are absent rather
/// than empty in the TS record, and the `skip_serializing_if` keeps the JSON
/// the web build writes byte-compatible.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct DockSlotConfig {
    pub kind: DockSlotKind,
    /// The view id, channel id, folder tag, login id or mailbox account id.
    #[serde(rename = "ref")]
    pub target: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// The single-character jump key.
    pub key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// Login slots only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<DockLoginAction>,
}

impl Default for DockSlotKind {
    fn default() -> Self {
        DockSlotKind::View
    }
}

/// One quick-launch bar (storage.ts L163-168).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct DockState {
    pub id: String,
    pub slots: Vec<DockSlotConfig>,
    pub pos: DockPlacement,
    pub enabled: bool,
}

impl Default for DockState {
    fn default() -> Self {
        Self { id: String::new(), slots: Vec::new(), pos: DockPlacement::default(), enabled: true }
    }
}

/// How many jump slots a bar holds. Generous on purpose: the bar scrolls
/// rather than refusing a ninth slot, and bare-key shortcuts come from 1-9
/// then a-z, so the cap matches that pool (storage.ts L149-153).
pub const MAX_DOCK_SLOTS: usize = 24;

/// How many bars may exist at once (storage.ts L156).
pub const MAX_DOCKS: usize = 4;

/// The five login actions, in menu order (storage.ts L119).
pub const DOCK_LOGIN_ACTIONS: [DockLoginAction; 5] = [
    DockLoginAction::Password,
    DockLoginAction::Email,
    DockLoginAction::Both,
    DockLoginAction::Edit,
    DockLoginAction::Messages,
];

/// A fresh bar id, the same shape `newDockId` mints (storage.ts L170-172).
pub fn new_dock_id() -> String {
    let uuid = uuid::Uuid::new_v4().simple().to_string();
    format!("dock_{}", &uuid[..8])
}

/// The shipped slot set: the four views and the inbox (storage.ts L186-192).
pub fn default_dock_slots() -> Vec<DockSlotConfig> {
    let slot = |kind: DockSlotKind, target: &str, key: &str| DockSlotConfig {
        kind,
        target: target.to_string(),
        label: None,
        key: key.to_string(),
        icon: None,
        action: None,
    };
    vec![
        slot(DockSlotKind::View, "animated", "1"),
        slot(DockSlotKind::View, "carousel", "2"),
        slot(DockSlotKind::View, "basic", "3"),
        slot(DockSlotKind::View, "grid", "4"),
        slot(DockSlotKind::Inbox, "", "5"),
    ]
}

/// The one bar a fresh vault ships (`DEFAULT_PREFERENCES.docks`,
/// storage.ts L894-901).
pub fn default_docks() -> Vec<DockState> {
    vec![DockState {
        id: "main".to_string(),
        slots: default_dock_slots(),
        pos: DockPlacement { edge: DockPosition::Bottom, fx: 0.5, fy: 0.94 },
        enabled: true,
    }]
}

/// Where a fresh bar spawns: the middle, unless a bar already sits there, in
/// which case the emptiest lane wins (storage.ts L179-184).
pub fn free_dock_spot(docks: &[DockState]) -> DockPlacement {
    let taken: Vec<f64> = docks
        .iter()
        .filter(|dock| dock.pos.edge == DockPosition::Bottom)
        .map(|dock| dock.pos.fx)
        .collect();
    let lanes = [0.5, 0.3, 0.7, 0.15, 0.85];
    let fx = lanes
        .iter()
        .copied()
        .find(|lane| taken.iter().all(|t| (t - lane).abs() > 0.12))
        .unwrap_or(0.5);
    DockPlacement { edge: DockPosition::Bottom, fx, fy: 0.78 }
}

/// One bar's placement as clamped fractions (storage.ts L990-996). Anything
/// outside 0-1 is pulled back on screen rather than stranding the bar where no
/// pointer can reach it.
pub fn normalise_dock_pos(raw: Option<&Value>) -> DockPlacement {
    let record = raw.and_then(Value::as_object);
    let edge = match record.and_then(|m| m.get("edge")).and_then(Value::as_str) {
        Some("top") => DockPosition::Top,
        Some("left") => DockPosition::Left,
        Some("right") => DockPosition::Right,
        _ => DockPosition::Bottom,
    };
    let clamp = |key: &str, fallback: f64| match record
        .and_then(|m| m.get(key))
        .and_then(Value::as_f64)
    {
        Some(value) if value.is_finite() => value.clamp(0.06, 0.94),
        _ => fallback,
    };
    DockPlacement {
        edge,
        fx: clamp("fx", 0.5),
        fy: clamp("fy", if edge == DockPosition::Top { 0.06 } else { 0.94 }),
    }
}

/// Puts the Orbit view back into a bar saved while Orbit was away from the
/// app (storage.ts L1013-1026).
///
/// Deliberately narrow: only a bar still holding *exactly* the three views
/// the Orbit-less build shipped -- Flow, List, Grid, in that order -- is
/// touched. A bar the user has since trimmed or rearranged is theirs.
fn restore_orbit_slot(raw: Option<&Value>) -> Option<Value> {
    let entries = raw.and_then(Value::as_array)?;
    if entries.len() >= MAX_DOCK_SLOTS {
        return raw.cloned();
    }
    let views: Vec<&Value> = entries
        .iter()
        .filter(|entry| entry.get("kind").and_then(Value::as_str) == Some("view"))
        .collect();
    let shipped = ["animated", "basic", "grid"];
    if views.len() != shipped.len() {
        return raw.cloned();
    }
    if !shipped
        .iter()
        .zip(&views)
        .all(|(want, view)| view.get("ref").and_then(Value::as_str) == Some(*want))
    {
        return raw.cloned();
    }
    let after = entries
        .iter()
        .position(|entry| entry.get("kind").and_then(Value::as_str) == Some("view"))
        .unwrap_or(0);
    let mut next = entries.clone();
    next.insert(
        after + 1,
        serde_json::json!({ "kind": "view", "ref": "carousel", "key": "" }),
    );
    Some(Value::Array(next))
}

/// One bar's slots: at most `MAX_DOCK_SLOTS`, each with a valid kind, a valid
/// view ref, a unique single-character key, a short label and a safe icon
/// (storage.ts L1035-1075). Anything else falls back slot by slot, so a
/// hand-edited record cannot leave a slot unreachable, two slots fighting
/// over one key, or a `javascript:` URL smuggled in as an icon.
pub fn normalise_dock_slots(raw: Option<&Value>) -> Vec<DockSlotConfig> {
    let empty: Vec<Value> = Vec::new();
    let list = raw.and_then(Value::as_array).unwrap_or(&empty);
    // Single-character jump keys: digits first, then letters.
    let fallback_keys: Vec<char> = "123456789abcdefghijklmnopqrstuvwxyz"
        .chars()
        .take(MAX_DOCK_SLOTS)
        .collect();
    let mut seen: Vec<String> = Vec::new();
    let mut clean: Vec<DockSlotConfig> = Vec::new();

    for entry in list.iter().take(MAX_DOCK_SLOTS) {
        let Some(record) = entry.as_object() else { continue };
        let kind = match record.get("kind").and_then(Value::as_str) {
            Some("view") => DockSlotKind::View,
            Some("channel") => DockSlotKind::Channel,
            Some("folder") => DockSlotKind::Folder,
            Some("login") => DockSlotKind::Login,
            Some("inbox") => DockSlotKind::Inbox,
            Some("mailbox") => DockSlotKind::Mailbox,
            _ => continue,
        };
        let target = record
            .get("ref")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if kind == DockSlotKind::View
            && !["animated", "carousel", "basic", "grid"].contains(&target.as_str())
        {
            continue;
        }
        if matches!(
            kind,
            DockSlotKind::Channel
                | DockSlotKind::Folder
                | DockSlotKind::Login
                | DockSlotKind::Mailbox
        ) && target.is_empty()
        {
            continue;
        }
        if kind == DockSlotKind::Inbox
            && clean.iter().any(|slot| slot.kind == DockSlotKind::Inbox)
        {
            continue;
        }
        if clean
            .iter()
            .any(|slot| slot.kind == kind && slot.target == target)
        {
            continue;
        }

        let action = if kind == DockSlotKind::Login {
            match record.get("action").and_then(Value::as_str) {
                Some("password") => Some(DockLoginAction::Password),
                Some("email") => Some(DockLoginAction::Email),
                Some("both") => Some(DockLoginAction::Both),
                Some("edit") => Some(DockLoginAction::Edit),
                Some("messages") => Some(DockLoginAction::Messages),
                _ => None,
            }
        } else {
            None
        };

        let raw_key = record
            .get("key")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        let mut key = if raw_key.chars().count() == 1 && !seen.contains(&raw_key.to_lowercase())
        {
            raw_key
        } else {
            String::new()
        };
        if key.is_empty() {
            match fallback_keys
                .iter()
                .find(|candidate| !seen.contains(&candidate.to_string()))
            {
                Some(free) => key = free.to_string(),
                None => continue,
            }
        }
        seen.push(key.to_lowercase());

        let raw_label = record
            .get("label")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let label = if raw_label.is_empty() {
            None
        } else {
            Some(raw_label.chars().take(24).collect())
        };
        let raw_icon = record
            .get("icon")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let icon = if raw_icon.starts_with("data:image/") || raw_icon.starts_with("https://") {
            Some(raw_icon.to_string())
        } else {
            None
        };

        clean.push(DockSlotConfig { kind, target, label, key, icon, action });
    }

    if clean.is_empty() {
        default_dock_slots()
    } else {
        clean
    }
}

/// The preference-level `docks` migration (storage.ts L1391-1436).
///
/// Stored docks win; otherwise the pre-multi-dock single bar (`dockEnabled` /
/// `dockSlots` / `dockPos`) migrates into the first dock, so nothing is lost in
/// the upgrade. At least one bar always survives: an empty list restores the
/// default bar.
pub fn normalise_docks(stored: Option<&Value>) -> Vec<DockState> {
    let root = stored.and_then(Value::as_object);
    let already_checked = root
        .and_then(|m| m.get("orbitDockRestored"))
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let mut clean: Vec<DockState> = Vec::new();
    if let Some(list) = root.and_then(|m| m.get("docks")).and_then(Value::as_array) {
        for entry in list.iter().take(MAX_DOCKS) {
            let Some(record) = entry.as_object() else { continue };
            let id = record
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .map(str::to_string)
                .unwrap_or_else(new_dock_id);
            let slots = if already_checked {
                normalise_dock_slots(record.get("slots"))
            } else {
                let repaired = restore_orbit_slot(record.get("slots"));
                normalise_dock_slots(repaired.as_ref())
            };
            if slots.is_empty() {
                continue;
            }
            clean.push(DockState {
                id,
                slots,
                pos: normalise_dock_pos(record.get("pos")),
                enabled: record.get("enabled").and_then(Value::as_bool) != Some(false),
            });
        }
    }

    if clean.is_empty() {
        clean.push(DockState {
            id: "main".to_string(),
            slots: normalise_dock_slots(root.and_then(|m| m.get("dockSlots"))),
            pos: normalise_dock_pos(root.and_then(|m| m.get("dockPos"))),
            // `dockEnabled !== false`: absent means on (storage.ts L1428).
            enabled: root
                .and_then(|m| m.get("dockEnabled"))
                .and_then(Value::as_bool)
                != Some(false),
        });
    }
    clean
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn defaults_match_the_typescript_defaults() {
        let docks = normalise_docks(None);
        assert_eq!(docks.len(), 1);
        assert_eq!(docks[0].id, "main");
        assert!(docks[0].enabled);
        assert_eq!(docks[0].pos, DockPlacement { edge: DockPosition::Bottom, fx: 0.5, fy: 0.94 });
        let kinds: Vec<DockSlotKind> = docks[0].slots.iter().map(|slot| slot.kind).collect();
        assert_eq!(
            kinds,
            vec![
                DockSlotKind::View,
                DockSlotKind::View,
                DockSlotKind::View,
                DockSlotKind::View,
                DockSlotKind::Inbox,
            ]
        );
        assert_eq!(docks[0].slots[0].target, "animated");
        assert_eq!(docks[0].slots[0].key, "1");
        assert_eq!(docks[0].slots[4].key, "5");
    }

    #[test]
    fn placement_clamps_and_defaults_per_edge() {
        let pos = normalise_dock_pos(Some(&json!({ "edge": "top", "fx": 5.0, "fy": -3.0 })));
        assert_eq!(pos.edge, DockPosition::Top);
        assert_eq!(pos.fx, 0.94);
        assert_eq!(pos.fy, 0.06);
        // A bad edge falls back to the bottom lane.
        let pos = normalise_dock_pos(Some(&json!({ "edge": "middle" })));
        assert_eq!(pos.edge, DockPosition::Bottom);
        assert_eq!(pos.fx, 0.5);
        assert_eq!(pos.fy, 0.94);
    }

    #[test]
    fn slots_drop_junk_and_hand_out_free_keys() {
        let slots = normalise_dock_slots(Some(&json!([
            { "kind": "view", "ref": "orbit", "key": "9" },
            { "kind": "nonsense", "ref": "x", "key": "8" },
            { "kind": "channel", "ref": "", "key": "7" },
            { "kind": "channel", "ref": "work", "key": "1" },
            { "kind": "channel", "ref": "work", "key": "2" },
            { "kind": "login", "ref": "abc", "key": "1", "action": "messages" },
            { "kind": "login", "ref": "def", "key": "z", "action": "nope" },
            { "kind": "inbox", "ref": "", "key": "6" },
            { "kind": "inbox", "ref": "", "key": "8" },
        ])));
        // view "orbit" is not a real view; the bad kind and the empty channel
        // are dropped; the duplicate channel and second inbox are dropped.
        let refs: Vec<(DockSlotKind, &str)> = slots
            .iter()
            .map(|slot| (slot.kind, slot.target.as_str()))
            .collect();
        assert_eq!(
            refs,
            vec![
                (DockSlotKind::Channel, "work"),
                (DockSlotKind::Login, "abc"),
                (DockSlotKind::Login, "def"),
                (DockSlotKind::Inbox, ""),
            ]
        );
        // "work" kept its key "1"; the login collided and got the first free
        // key ("2"); "def" kept "z".
        assert_eq!(slots[0].key, "1");
        assert_eq!(slots[1].key, "2");
        assert_eq!(slots[2].key, "z");
        // The invalid action is dropped, not kept as a mystery.
        assert_eq!(slots[1].action, Some(DockLoginAction::Messages));
        assert_eq!(slots[2].action, None);
    }

    #[test]
    fn slots_refuse_a_javascript_icon_and_cap_the_label() {
        let long = "x".repeat(40);
        let slots = normalise_dock_slots(Some(&json!([
            { "kind": "login", "ref": "a", "key": "a", "label": long, "icon": "javascript:alert(1)" },
            { "kind": "login", "ref": "b", "key": "b", "icon": "https://example.com/i.png" },
        ])));
        assert_eq!(slots[0].label.as_deref(), Some("x".repeat(24).as_str()));
        assert_eq!(slots[0].icon, None);
        assert_eq!(slots[1].icon.as_deref(), Some("https://example.com/i.png"));
    }

    #[test]
    fn empty_in_defaults_out() {
        assert_eq!(normalise_dock_slots(Some(&json!([]))), default_dock_slots());
        assert!(normalise_dock_slots(Some(&json!("nope"))).len() == MAX_DOCK_SLOTS.min(5));
    }

    #[test]
    fn the_legacy_single_bar_migrates() {
        // A vault written before multi-dock: one bar, no `docks` array.
        let docks = normalise_docks(Some(&json!({
            "dockEnabled": false,
            "dockSlots": [{ "kind": "view", "ref": "basic", "key": "3" }],
            "dockPos": { "edge": "right", "fx": 0.1, "fy": 0.2 },
        })));
        assert_eq!(docks.len(), 1);
        assert_eq!(docks[0].id, "main");
        assert!(!docks[0].enabled);
        assert_eq!(docks[0].slots.len(), 1);
        assert_eq!(docks[0].slots[0].target, "basic");
        assert_eq!(docks[0].pos.edge, DockPosition::Right);
        assert_eq!(docks[0].pos.fx, 0.1);
    }

    #[test]
    fn stored_docks_win_and_are_capped_at_four() {
        let docks = normalise_docks(Some(&json!({
            "docks": [
                { "id": "a", "slots": [{ "kind": "view", "ref": "grid", "key": "1" }], "pos": { "edge": "left" } },
                { "id": "b", "slots": [{ "kind": "view", "ref": "basic", "key": "1" }], "enabled": false },
                { "slots": [{ "kind": "view", "ref": "animated", "key": "1" }] },
                { "id": "d", "slots": [{ "kind": "view", "ref": "carousel", "key": "1" }] },
                { "id": "e", "slots": [{ "kind": "view", "ref": "animated", "key": "1" }] },
            ]
        })));
        assert_eq!(docks.len(), MAX_DOCKS);
        assert_eq!(docks[0].id, "a");
        assert_eq!(docks[0].pos.edge, DockPosition::Left);
        assert!(!docks[1].enabled);
        // A missing id is minted, not left blank.
        assert!(docks[2].id.starts_with("dock_"));
    }

    #[test]
    fn the_orbit_repair_is_narrow() {
        // Exactly the three Orbit-less views: repaired.
        let repaired = normalise_docks(Some(&json!({
            "docks": [{ "id": "main", "slots": [
                { "kind": "view", "ref": "animated", "key": "1" },
                { "kind": "view", "ref": "basic", "key": "2" },
                { "kind": "view", "ref": "grid", "key": "3" },
            ] }],
        })));
        let refs: Vec<&str> = repaired[0].slots.iter().map(|s| s.target.as_str()).collect();
        assert_eq!(refs, vec!["animated", "carousel", "basic", "grid"]);

        // A bar the user trimmed is left alone, and one already carrying
        // Orbit is not doubled up.
        let trimmed = normalise_docks(Some(&json!({
            "docks": [{ "id": "main", "slots": [
                { "kind": "view", "ref": "animated", "key": "1" },
                { "kind": "view", "ref": "grid", "key": "2" },
            ] }],
        })));
        let refs: Vec<&str> = trimmed[0].slots.iter().map(|s| s.target.as_str()).collect();
        assert_eq!(refs, vec!["animated", "grid"]);

        // `orbitDockRestored` short-circuits the repair even for the exact
        // legacy shape.
        let checked = normalise_docks(Some(&json!({
            "orbitDockRestored": true,
            "docks": [{ "id": "main", "slots": [
                { "kind": "view", "ref": "animated", "key": "1" },
                { "kind": "view", "ref": "basic", "key": "2" },
                { "kind": "view", "ref": "grid", "key": "3" },
            ] }],
        })));
        let refs: Vec<&str> = checked[0].slots.iter().map(|s| s.target.as_str()).collect();
        assert_eq!(refs, vec!["animated", "basic", "grid"]);
    }

    #[test]
    fn free_spot_avoids_occupied_lanes() {
        let mut docks = default_docks();
        // The default bar sits at 0.5; the next free lane is 0.3.
        assert_eq!(free_dock_spot(&docks).fx, 0.3);
        docks.push(DockState { id: "b".into(), ..DockState::default() });
        docks[1].pos.fx = 0.3;
        assert_eq!(free_dock_spot(&docks).fx, 0.7);
    }

    #[test]
    fn a_stored_dock_json_round_trips() {
        let docks = normalise_docks(None);
        let text = serde_json::to_string(&docks).unwrap();
        // `ref` keeps its TS name and absent optionals stay absent.
        assert!(text.contains("\"ref\":\"animated\""));
        assert!(!text.contains("\"label\":null"));
        let back: Vec<DockState> = serde_json::from_str(&text).unwrap();
        assert_eq!(back, docks);
    }
}
