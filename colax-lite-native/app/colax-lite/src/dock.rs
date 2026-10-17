//! Quick-launch docks (Task 8.3).
//!
//! Port of the dock half of `src/ui/App.tsx`: `buildDockSlots` (L2505-2620),
//! `patchDock` (L2632), `dockMenu` (L2766) and `dockSlotMenu` (L2674) — plus
//! the storage layer already in `colax-core::dock`. The bar and its drag live
//! in `ui/screens/dock.slint`; this module is the model it draws and the
//! actions its callbacks run.
//!
//! A bar resolves every slot against the *live* document, so a slot whose
//! channel or login is gone simply renders nothing rather than a dead button
//! (normalisation cannot see the channel list, so the filter belongs here,
//! where it can). The inbox slot selects the dashboard channel, which is where
//! connected-mail messages already render — the dock never fetches mail.

use slint::{Color, Image, ModelRc, VecModel};

use colax_core::{
    free_dock_spot, new_dock_id, DockLoginAction, DockPlacement, DockPosition, DockSlotConfig,
    DockSlotKind, DockState, VaultItem, VaultPreferences, MAX_DOCKS,
};

use crate::items;
use crate::{notice, DockBarRow, DockManagerRow, DockSlotRow, MainWindow, Shared};

/// The four views: id, the name the bar and manager show, and the port's glyph
/// for each — the same four glyphs the Layout tab's "Default view" row uses, so
/// the two pickers cannot drift.
const VIEWS: [(&str, &str, &str); 4] = [
    ("animated", "Flow", "≈"),
    ("carousel", "Orbit", "●"),
    ("basic", "List", "☰"),
    ("grid", "Grid", "▦"),
];

/// The glyph a view, inbox or login slot draws when it has no icon of its own.
const INBOX_GLYPH: &str = "✉";
const LOGIN_GLYPH: &str = "⚿";

fn kind_name(kind: DockSlotKind) -> &'static str {
    match kind {
        DockSlotKind::View => "view",
        DockSlotKind::Channel => "channel",
        DockSlotKind::Folder => "folder",
        DockSlotKind::Login => "login",
        DockSlotKind::Inbox => "inbox",
        DockSlotKind::Mailbox => "mailbox",
    }
}

fn parse_kind(text: &str) -> Option<DockSlotKind> {
    match text {
        "view" => Some(DockSlotKind::View),
        "channel" => Some(DockSlotKind::Channel),
        "folder" => Some(DockSlotKind::Folder),
        "login" => Some(DockSlotKind::Login),
        "inbox" => Some(DockSlotKind::Inbox),
        "mailbox" => Some(DockSlotKind::Mailbox),
        _ => None,
    }
}

/// Which family a slot belongs to; a family boundary draws the bar's divider
/// (`slotFamily`, Dock.tsx L39-45).
fn family_of(kind: DockSlotKind) -> &'static str {
    match kind {
        DockSlotKind::View => "views",
        DockSlotKind::Login => "logins",
        DockSlotKind::Mailbox => "mail",
        _ => "go",
    }
}

pub(crate) fn edge_name(edge: DockPosition) -> &'static str {
    match edge {
        DockPosition::Bottom => "bottom",
        DockPosition::Top => "top",
        DockPosition::Left => "left",
        DockPosition::Right => "right",
    }
}

pub(crate) fn parse_edge(text: &str) -> DockPosition {
    match text {
        "top" => DockPosition::Top,
        "left" => DockPosition::Left,
        "right" => DockPosition::Right,
        _ => DockPosition::Bottom,
    }
}

/// The label the manager and the dock-position submenu show for an edge.
pub(crate) fn edge_label(edge: DockPosition) -> &'static str {
    match edge {
        DockPosition::Bottom => "Bottom",
        DockPosition::Top => "Top",
        DockPosition::Left => "Left",
        DockPosition::Right => "Right",
    }
}

/// One folder of the rail, read out of the preferences' untyped `folders`
/// pocket — the rail's own tree (folders, separators, drag order) is not
/// modelled yet, so the dock reads just enough to name and colour a slot.
struct FolderInfo {
    id: String,
    name: String,
    icon: String,
    hue: i32,
}

fn folder_infos(prefs: &VaultPreferences) -> Vec<FolderInfo> {
    prefs
        .extra
        .get("folders")
        .and_then(|value| value.as_array())
        .map(|folders| {
            folders
                .iter()
                .filter_map(|folder| {
                    let object = folder.as_object()?;
                    let id = object.get("id").and_then(|value| value.as_str())?;
                    if id.is_empty() {
                        return None;
                    }
                    Some(FolderInfo {
                        id: id.to_string(),
                        name: object
                            .get("name")
                            .and_then(|value| value.as_str())
                            .unwrap_or("")
                            .to_string(),
                        icon: object
                            .get("icon")
                            .and_then(|value| value.as_str())
                            .unwrap_or("")
                            .to_string(),
                        hue: object
                            .get("hue")
                            .and_then(|value| value.as_i64())
                            .unwrap_or(0) as i32,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The dashboard channel's id, if the catalogue still holds one.
fn dashboard_id(prefs: &VaultPreferences) -> Option<String> {
    prefs
        .channels
        .iter()
        .find(|channel| channel.kind == colax_core::ChannelKind::Dashboard)
        .map(|channel| channel.id.clone())
}

/// The `hint` for a login slot's configured action (`buildDockSlots` L2557-2562).
fn action_hint(action: DockLoginAction) -> &'static str {
    match action {
        DockLoginAction::Password => "Copy password",
        DockLoginAction::Email => "Copy email",
        DockLoginAction::Edit => "Edit login",
        DockLoginAction::Messages => "Show messages",
        DockLoginAction::Both => "Copy login",
    }
}

/// One stored slot resolved against the live document, or nothing when its
/// target no longer exists (`buildDockSlots` L2505-2620).
fn resolve_slot(
    config: &DockSlotConfig,
    prefs: &VaultPreferences,
    active_channel: &str,
    items: &[VaultItem],
    folders: &[FolderInfo],
    mailboxes: &[(String, String)],
) -> Option<DockSlotRow> {
    let key = &config.kind;
    let id = format!(
        "{}:{}",
        kind_name(*key),
        if config.target.is_empty() { kind_name(*key) } else { config.target.as_str() }
    );
    let plain = |label: String, hint: String, glyph: &str, active: bool| DockSlotRow {
        id: id.clone().into(),
        kind: kind_name(*key).into(),
        label: label.into(),
        hint: hint.into(),
        glyph: glyph.into(),
        dot: Color::default(),
        has_dot: false,
        key: config.key.clone().into(),
        active,
        family: family_of(*key).into(),
        divider: false,
        has_image: false,
        image: Image::default(),
    };

    match key {
        DockSlotKind::View => {
            let (view_id, view_label, glyph) = VIEWS
                .iter()
                .find(|(view_id, _, _)| *view_id == config.target)?;
            Some(plain(
                config.label.clone().unwrap_or_else(|| (*view_label).to_string()),
                (*view_label).to_string(),
                glyph,
                prefs.view == *view_id,
            ))
        }
        DockSlotKind::Inbox => Some(plain(
            config.label.clone().unwrap_or_else(|| "Inbox".to_string()),
            "Dashboard and recent mail".to_string(),
            INBOX_GLYPH,
            prefs
                .channels
                .iter()
                .find(|channel| channel.id == active_channel)
                .map(|channel| channel.kind == colax_core::ChannelKind::Dashboard)
                .unwrap_or(false),
        )),
        DockSlotKind::Folder => {
            let folder = folders.iter().find(|folder| folder.id == config.target)?;
            let mut row = plain(
                config
                    .label
                    .clone()
                    .unwrap_or_else(|| folder.name.clone()),
                format!("Folder: {}", folder.name),
                crate::channels_ops::glyph_for(&folder.icon),
                active_channel == format!("folder:{}", folder.id),
            );
            row.dot = items::hue_color(folder.hue);
            row.has_dot = true;
            Some(row)
        }
        DockSlotKind::Login => {
            let item = items.iter().find(|item| item.id == config.target)?;
            let action = config.action.unwrap_or(DockLoginAction::Both);
            let label = config.label.clone().unwrap_or_else(|| {
                if !item.title.is_empty() {
                    item.title.clone()
                } else if !item.username.is_empty() {
                    item.username.clone()
                } else {
                    "Login".to_string()
                }
            });
            let hint = if !item.username.is_empty() {
                item.username.clone()
            } else if !item.url.is_empty() {
                item.url.clone()
            } else {
                action_hint(action).to_string()
            };
            Some(plain(label, hint, LOGIN_GLYPH, false))
        }
        DockSlotKind::Mailbox => {
            let (_, address) = mailboxes.iter().find(|(id, _)| *id == config.target)?;
            let label = config.label.clone().unwrap_or_else(|| {
                if address.is_empty() {
                    "Mailbox".to_string()
                } else {
                    address.clone()
                }
            });
            let hint = if address.is_empty() {
                "Mailbox messages".to_string()
            } else {
                format!("Messages for {address}")
            };
            Some(plain(label, hint, INBOX_GLYPH, false))
        }
        DockSlotKind::Channel => {
            let channel = prefs.channels.iter().find(|channel| channel.id == config.target)?;
            let mut row = plain(
                config
                    .label
                    .clone()
                    .unwrap_or_else(|| channel.name.clone()),
                format!("Channel: {}", channel.name),
                crate::channels_ops::glyph_for(&channel.icon),
                active_channel == channel.id,
            );
            row.dot = items::hue_color(channel.hue);
            row.has_dot = true;
            Some(row)
        }
    }
}

/// Every enabled bar with its slots resolved and its family dividers placed.
fn build_bars(
    prefs: &VaultPreferences,
    active_channel: &str,
    items: &[VaultItem],
) -> Vec<DockBarRow> {
    let folders = folder_infos(prefs);
    let mailboxes = crate::channels_ops::mail_accounts(prefs);
    let mut bars = Vec::new();
    for dock in prefs.docks.iter().filter(|dock| dock.enabled) {
        let mut slots: Vec<DockSlotRow> = Vec::new();
        let mut previous: Option<&str> = None;
        for config in &dock.slots {
            let Some(mut row) = resolve_slot(config, prefs, active_channel, items, &folders, &mailboxes)
            else {
                continue;
            };
            let family = family_of(config.kind);
            row.divider = previous.map(|before| before != family).unwrap_or(false);
            previous = Some(family);
            slots.push(row);
        }
        bars.push(DockBarRow {
            id: dock.id.clone().into(),
            edge: edge_name(dock.pos.edge).into(),
            fx: dock.pos.fx as f32,
            fy: dock.pos.fy as f32,
            slots: ModelRc::new(VecModel::from(slots)),
        });
    }
    bars
}

/// The Layout tab's manager: one header row per bar, then one row per slot
/// (DockSettings.tsx L770-810). A slot whose target is gone is marked
/// `missing` and offers only Remove, so a deleted channel cannot leave a
/// silent gap nobody can find.
fn manager_rows(prefs: &VaultPreferences, active_channel: &str, items: &[VaultItem]) -> Vec<DockManagerRow> {
    let folders = folder_infos(prefs);
    let mailboxes = crate::channels_ops::mail_accounts(prefs);
    let mut rows = Vec::new();
    for (dock_index, dock) in prefs.docks.iter().enumerate() {
        rows.push(DockManagerRow {
            kind: "dock".into(),
            dock: dock_index as i32,
            slot: -1,
            id: dock.id.clone().into(),
            title: format!("Dock {}", dock_index + 1).into(),
            hint: format!("{} · {} slots", edge_label(dock.pos.edge), dock.slots.len()).into(),
            glyph: "▭".into(),
            dot: Color::default(),
            has_dot: false,
            key: "".into(),
            enabled: dock.enabled,
            missing: false,
        });
        for (slot_index, config) in dock.slots.iter().enumerate() {
            let resolved = resolve_slot(config, prefs, active_channel, items, &folders, &mailboxes);
            let (title, hint, glyph, dot, has_dot, missing) = match resolved {
                Some(row) => (
                    row.label.to_string(),
                    row.hint.to_string(),
                    row.glyph.to_string(),
                    row.dot,
                    row.has_dot,
                    false,
                ),
                None => (
                    "(missing)".to_string(),
                    format!("{} is gone", kind_name(config.kind)),
                    "⚠".to_string(),
                    Color::default(),
                    false,
                    true,
                ),
            };
            rows.push(DockManagerRow {
                kind: "slot".into(),
                dock: dock_index as i32,
                slot: slot_index as i32,
                id: format!("{}:{}", kind_name(config.kind), config.target).into(),
                title: title.into(),
                hint: hint.into(),
                glyph: glyph.into(),
                dot,
                has_dot,
                key: config.key.clone().into(),
                enabled: dock.enabled,
                missing,
            });
        }
    }
    rows
}

/// Rebuilds the bar layer and the Layout tab's manager. Called from
/// `refresh_items`, so a view switch, a key write and a channel rename all land
/// here in the same tick (the TS `dockModels` memo, App.tsx L2626).
pub fn push(ui: &MainWindow, state: &Shared) {
    let (prefs, items, active_channel) = {
        let guard = state.borrow();
        let prefs = items::prefs_from(guard.engine.preferences());
        let items = guard.engine.items().map(|items| items.to_vec()).unwrap_or_default();
        let active_channel = ui.get_active_channel().to_string();
        (prefs, items, active_channel)
    };
    let bars = build_bars(&prefs, &active_channel, &items);
    let rows = manager_rows(&prefs, &active_channel, &items);
    ui.set_dock_bars(ModelRc::new(VecModel::from(bars)));
    ui.set_dock_rows(ModelRc::new(VecModel::from(rows)));
    // A recording in flight outlives a refresh (the manager re-pushes on every
    // write), so the flag is read back from the same state that owns it.
    ui.set_dock_recording(capturing(state));
}

// ---- Writes --------------------------------------------------------------

/// Patches one bar, leaving the others alone (`patchDock`, App.tsx L2632).
pub(crate) fn patch_dock<F>(ui: &MainWindow, state: &Shared, dock_id: &str, apply: F) -> bool
where
    F: FnOnce(&mut DockState),
{
    let dock_id = dock_id.to_string();
    crate::settings_ops::write(ui, state, |prefs| {
        match prefs.docks.iter_mut().find(|dock| dock.id == dock_id) {
            Some(dock) => {
                apply(dock);
                true
            }
            None => false,
        }
    })
}

/// The one write of a drag gesture: the drop point becomes the stored
/// placement, and the snapped edge decides its orientation (`onPointerUp`,
/// Dock.tsx L167-179).
pub fn pos_committed(ui: &MainWindow, state: &Shared, dock_id: &str, edge: &str, fx: f32, fy: f32) {
    let edge = parse_edge(edge);
    patch_dock(ui, state, dock_id, |dock| {
        dock.pos = DockPlacement {
            edge,
            fx: (fx as f64).clamp(0.06, 0.94),
            fy: (fy as f64).clamp(0.06, 0.94),
        };
    });
}

/// The canonical spot for an edge, from the dock-position submenu.
pub fn set_pos(ui: &MainWindow, state: &Shared, dock_id: &str, edge: &str) {
    let edge = parse_edge(edge);
    let (fx, fy) = match edge {
        DockPosition::Bottom => (0.5, 0.94),
        DockPosition::Top => (0.5, 0.06),
        DockPosition::Left => (0.06, 0.5),
        DockPosition::Right => (0.94, 0.5),
    };
    patch_dock(ui, state, dock_id, |dock| dock.pos = DockPlacement { edge, fx, fy });
}

pub fn set_enabled(ui: &MainWindow, state: &Shared, dock_id: &str, enabled: bool) {
    patch_dock(ui, state, dock_id, |dock| dock.enabled = enabled);
}

/// Hides a bar and says where it went, because a bar that vanishes with no word
/// is indistinguishable from a bug (`dockMenu`, App.tsx L2830-2836).
pub fn hide(ui: &MainWindow, state: &Shared, dock_id: &str) {
    if patch_dock(ui, state, dock_id, |dock| dock.enabled = false) {
        notice(ui, "Hidden — bring it back in Settings › Hidden");
    }
}

/// A fresh bar in the emptiest lane (`dockMenu`, App.tsx L2794-2811). It starts
/// with no slots and fills out with the shipped five on the next load, exactly
/// as the TS `slots: []` does.
pub fn add_dock(ui: &MainWindow, state: &Shared) {
    let added = crate::settings_ops::write(ui, state, |prefs| {
        if prefs.docks.len() >= MAX_DOCKS {
            return false;
        }
        let pos = free_dock_spot(&prefs.docks);
        prefs.docks.push(DockState {
            id: new_dock_id(),
            slots: Vec::new(),
            pos,
            enabled: true,
        });
        true
    });
    if added {
        notice(ui, "New dock added — fill it in Settings › Layout");
    }
}

pub fn duplicate_dock(ui: &MainWindow, state: &Shared, dock_id: &str) {
    let duplicated = crate::settings_ops::write(ui, state, |prefs| {
        if prefs.docks.len() >= MAX_DOCKS {
            return false;
        }
        let Some(source) = prefs.docks.iter().find(|dock| dock.id == dock_id).cloned() else {
            return false;
        };
        let mut pos = free_dock_spot(&prefs.docks);
        pos.edge = source.pos.edge;
        prefs.docks.push(DockState {
            id: new_dock_id(),
            slots: source.slots,
            pos,
            enabled: true,
        });
        true
    });
    if duplicated {
        notice(ui, "Dock duplicated");
    }
}

/// Removes a bar. The normaliser restores the default bar when none is left, so
/// the last removal still lands somewhere (`normaliseDocks`, storage.ts L1436).
pub fn remove_dock(ui: &MainWindow, state: &Shared, dock_id: &str) {
    crate::settings_ops::write(ui, state, |prefs| {
        let before = prefs.docks.len();
        prefs.docks.retain(|dock| dock.id != dock_id);
        prefs.docks.len() != before
    });
}

/// Removes one slot by index.
pub fn remove_slot(ui: &MainWindow, state: &Shared, dock_id: &str, index: usize) {
    patch_dock(ui, state, dock_id, |dock| {
        if index < dock.slots.len() {
            dock.slots.remove(index);
        }
    });
}

/// Moves a slot one place, which is what the manager's reorder affordance does
/// (`DockSettings.tsx` reorders by index swap, L5-7).
pub fn move_slot(ui: &MainWindow, state: &Shared, dock_id: &str, index: usize, delta: i32) {
    patch_dock(ui, state, dock_id, |dock| {
        let Some(target) = index.checked_add_signed(delta as isize) else {
            return;
        };
        if target < dock.slots.len() && index < dock.slots.len() {
            dock.slots.swap(index, target);
        }
    });
}

/// Appends a slot, refusing kinds that need a target but have none.
pub fn add_slot(ui: &MainWindow, state: &Shared, dock_id: &str, kind: DockSlotKind, target: &str) {
    patch_dock(ui, state, dock_id, |dock| {
        if matches!(kind, DockSlotKind::Inbox) {
            if dock.slots.iter().any(|slot| slot.kind == DockSlotKind::Inbox) {
                return;
            }
        } else if target.is_empty() {
            return;
        }
        if dock
            .slots
            .iter()
            .any(|slot| slot.kind == kind && slot.target == target)
        {
            return;
        }
        // A free key, from the same pool the normaliser uses.
        let pool: Vec<char> = "123456789abcdefghijklmnopqrstuvwxyz".chars().take(24).collect();
        let taken: Vec<String> = dock.slots.iter().map(|slot| slot.key.to_lowercase()).collect();
        let key = pool
            .iter()
            .find(|candidate| !taken.contains(&candidate.to_string()))
            .map(|candidate| candidate.to_string())
            .unwrap_or_default();
        dock.slots.push(DockSlotConfig {
            kind,
            target: target.to_string(),
            label: None,
            key,
            icon: None,
            action: None,
        });
    });
}

pub fn set_slot_action(ui: &MainWindow, state: &Shared, dock_id: &str, index: usize, action: &str) {
    let action = match action {
        "password" => DockLoginAction::Password,
        "email" => DockLoginAction::Email,
        "both" => DockLoginAction::Both,
        "edit" => DockLoginAction::Edit,
        "messages" => DockLoginAction::Messages,
        _ => return,
    };
    patch_dock(ui, state, dock_id, |dock| {
        if let Some(slot) = dock.slots.get_mut(index) {
            slot.action = Some(action);
        }
    });
}

// ---- Key recording -------------------------------------------------------
// `KeyRecorder` (Dock.tsx L239-283): click, then press the key. The window's
// key scope forwards every key here while a recording is armed, so a bare key
// is captured before any other shortcut can claim it.

fn slot_label(state: &Shared, dock_id: &str, index: usize) -> Option<String> {
    let prefs = items::prefs_from(state.borrow().engine.preferences());
    prefs
        .docks
        .iter()
        .find(|dock| dock.id == dock_id)
        .and_then(|dock| dock.slots.get(index))
        .map(|slot| format!("{}:{}", kind_name(slot.kind), slot.target))
}

pub fn arm_key(ui: &MainWindow, state: &Shared, dock_id: &str, index: usize) {
    if slot_label(state, dock_id, index).is_some() {
        state.borrow_mut().dock_key_target = Some((dock_id.to_string(), index));
        // The window flag is what lets the Settings modal's own scope hand
        // the next key over instead of treating it as a tab jump.
        ui.set_dock_recording(true);
    }
}

pub fn capturing(state: &Shared) -> bool {
    state.borrow().dock_key_target.is_some()
}

/// Consumes the next key while a recording is armed. Escape cancels; a
/// modifier, a function key or a multi-character key is refused rather than
/// stored (it could never fire); a key another slot in the same bar already
/// answers to is refused rather than stolen.
pub fn capture(ui: &MainWindow, state: &Shared, text: &str) -> bool {
    let Some((dock_id, index)) = state.borrow_mut().dock_key_target.take() else {
        return false;
    };
    ui.set_dock_recording(false);
    if text == "\u{1b}" {
        notice(ui, "Key recording cancelled.");
        return true;
    }
    let mut chars = text.chars();
    let (Some(first), None) = (chars.next(), chars.next()) else {
        notice(ui, "Press a single letter, digit or symbol — not a modifier or function key.");
        state.borrow_mut().dock_key_target = Some((dock_id, index));
        ui.set_dock_recording(true);
        return true;
    };

    let key = first.to_string();
    let taken = {
        let prefs = items::prefs_from(state.borrow().engine.preferences());
        prefs
            .docks
            .iter()
            .find(|dock| dock.id == dock_id)
            .map(|dock| {
                dock.slots
                    .iter()
                    .enumerate()
                    .any(|(other, slot)| other != index && slot.key.eq_ignore_ascii_case(&key))
            })
            .unwrap_or(false)
    };
    if taken {
        notice(ui, &format!("“{key}” already jumps somewhere else."));
        state.borrow_mut().dock_key_target = Some((dock_id, index));
        ui.set_dock_recording(true);
        return true;
    }
    patch_dock(ui, state, &dock_id, |dock| {
        if let Some(slot) = dock.slots.get_mut(index) {
            slot.key = key.clone();
        }
    });
    notice(ui, &format!("Dock key set to “{key}”."));
    true
}

// ---- Actions -------------------------------------------------------------

/// A slot press (`slot.onJump`, App.tsx L2522-2617).
pub fn slot_pressed(ui: &MainWindow, state: &Shared, dock_id: &str, slot_id: &str) {
    let config = {
        let prefs = items::prefs_from(state.borrow().engine.preferences());
        prefs
            .docks
            .iter()
            .find(|dock| dock.id == dock_id)
            .and_then(|dock| {
                dock.slots
                    .iter()
                    .find(|slot| {
                        let id = format!(
                            "{}:{}",
                            kind_name(slot.kind),
                            if slot.target.is_empty() { kind_name(slot.kind) } else { slot.target.as_str() }
                        );
                        id == slot_id
                    })
                    .cloned()
            })
    };
    let Some(config) = config else {
        return;
    };

    match config.kind {
        DockSlotKind::View => crate::view_picked(ui, state, &config.target),
        DockSlotKind::Inbox => {
            let prefs = items::prefs_from(state.borrow().engine.preferences());
            if let Some(id) = dashboard_id(&prefs) {
                ui.set_active_channel(id.into());
                crate::refresh_items(ui, state);
            }
        }
        DockSlotKind::Channel => {
            ui.set_active_channel(config.target.as_str().into());
            crate::refresh_items(ui, state);
        }
        DockSlotKind::Folder => {
            ui.set_active_channel(format!("folder:{}", config.target).as_str().into());
            crate::refresh_items(ui, state);
        }
        DockSlotKind::Mailbox => {
            notice(ui, "Mailbox windows arrive with the mail engine.");
        }
        DockSlotKind::Login => match config.action.unwrap_or(DockLoginAction::Both) {
            DockLoginAction::Edit => crate::open_editor(ui, state, &config.target),
            DockLoginAction::Messages => {
                notice(ui, "Message views arrive with the mail engine.");
            }
            action => {
                let (password, username) = {
                    let guard = state.borrow();
                    guard
                        .engine
                        .items()
                        .and_then(|items| items.iter().find(|item| item.id == config.target))
                        .map(|item| (item.password.clone(), item.username.clone()))
                        .unwrap_or_default()
                };
                match action {
                    DockLoginAction::Password => {
                        if !password.is_empty() && crate::platform::copy_text(&password) {
                            notice(ui, "Password copied");
                        }
                    }
                    DockLoginAction::Email => {
                        if !username.is_empty() && crate::platform::copy_text(&username) {
                            notice(ui, "Email copied");
                        }
                    }
                    // The historic one line, "email password", ready to paste
                    // into a form (App.tsx L2584).
                    _ => {
                        let line = [username.trim(), password.as_str()]
                            .iter()
                            .filter(|part| !part.is_empty())
                            .cloned()
                            .collect::<Vec<&str>>()
                            .join(" ");
                        if !line.is_empty() && crate::platform::copy_text(&line) {
                            notice(ui, "Login copied");
                        }
                    }
                }
            }
        },
    }
}

pub(crate) fn slot_kind_of(id: &str) -> Option<DockSlotKind> {
    parse_kind(id.split(':').next().unwrap_or(""))
}

/// A kind's own name, for the menus' slot-id arithmetic.
pub(crate) fn kind_name_of(kind: DockSlotKind) -> &'static str {
    kind_name(kind)
}

/// `(id, name)` for every folder the rail's own tree holds, for the slot
/// picker and the "Edit …" rows.
pub(crate) fn folder_list(prefs: &VaultPreferences) -> Vec<(String, String)> {
    folder_infos(prefs)
        .into_iter()
        .map(|folder| (folder.id, folder.name))
        .collect()
}

/// Whether a stored login action is the one a menu row names.
pub(crate) fn action_matches(action: DockLoginAction, name: &str) -> bool {
    matches!(
        (action, name),
        (DockLoginAction::Password, "password")
            | (DockLoginAction::Email, "email")
            | (DockLoginAction::Both, "both")
            | (DockLoginAction::Edit, "edit")
            | (DockLoginAction::Messages, "messages")
    )
}

/// The bar id at a manager index, so a row's click can name the bar it edits.
pub(crate) fn dock_id_at(state: &Shared, index: usize) -> Option<String> {
    let prefs = items::prefs_from(state.borrow().engine.preferences());
    prefs.docks.get(index).map(|dock| dock.id.clone())
}

/// Where a bar sits, as viewport fractions, so a menu opened from the Layout
/// tab can appear beside the bar it edits rather than at the window's corner.
pub(crate) fn bar_anchor(state: &Shared, dock_id: &str) -> (f32, f32) {
    let prefs = items::prefs_from(state.borrow().engine.preferences());
    prefs
        .docks
        .iter()
        .find(|dock| dock.id == dock_id)
        .map(|dock| (dock.pos.fx as f32, dock.pos.fy as f32))
        .unwrap_or((0.5, 0.94))
}

/// The resolved `kind:ref` id a stored slot answers to, the same string the
/// bar's model carries.
pub(crate) fn config_id(slot: &DockSlotConfig) -> String {
    let kind = kind_name(slot.kind);
    format!(
        "{}:{}",
        kind,
        if slot.target.is_empty() { kind } else { slot.target.as_str() }
    )
}

/// The slot a bare key jumps to, across every enabled bar in bar then slot
/// order (`useDockShortcuts`, Dock.tsx L293-310). Case-insensitive, so Caps
/// Lock cannot silently disable a bar.
pub(crate) fn key_target(state: &Shared, text: &str) -> Option<(String, String)> {
    let prefs = items::prefs_from(state.borrow().engine.preferences());
    for dock in prefs.docks.iter().filter(|dock| dock.enabled) {
        for slot in &dock.slots {
            if !slot.key.is_empty() && slot.key.eq_ignore_ascii_case(text) {
                return Some((dock.id.clone(), config_id(slot)));
            }
        }
    }
    None
}
