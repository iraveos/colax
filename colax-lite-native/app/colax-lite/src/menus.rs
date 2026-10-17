//! Context menus (Task 8.1).
//!
//! Port of `E:\acc2\src\ui\context-menu.tsx` plus the menu trees built in
//! `E:\acc2\src\ui\App.tsx`. The renderer (`ui/menus.slint`) draws one layer
//! -- the root, or a submenu anchored to its owning row -- from a rows model
//! this module builds; the overlay in `ui/main.slint` owns the placement
//! maths because they read the window size; everything here is the trees,
//! the cascade bookkeeping, the keyboard walk and the actions.
//!
//! Rows are `MenuRow` (`ui/models.slint`): a selectable item (`kind 0`),
//! a separator (`1`) or a non-interactive heading inside a submenu (`2`),
//! carrying `id` for dispatch, the right-aligned `shortcut` hint and the
//! TS's four flags (`sub`, `checked`, `danger`, `disabled`). Heights are
//! constants both languages share -- 34px item, 26px heading, 9px separator,
//! 16px of menu padding, 232px root / 224px submenu wide (the TS's
//! MENU_WIDTH, SUBMENU_WIDTH, ROW_HEIGHT, HEADING_HEIGHT plus the separator
//! strip) -- so placement never has to measure.
//!
//! Slice 1 covers the two trees reachable outside the sidebar: the app menu
//! (`appMenu`, App.tsx L1944) on empty-space right-click, and the item menu
//! (`itemMenu`, L1828) on a card. Deferred to their own passes, each at its
//! genuine home: the channel/folder/separator menus and `newChannelMenu`
//! (with the sidebar's right-click wiring), `bulkMenu`/`bulkChannelMenu`
//! (multi-select, 3.5/3.6), `dockMenu`/`dockSlotMenu` (8.3), the Appearance
//! tuner's `Card size` entries (8.4), the `hideEntry` prefix (its Hide flows
//! ride the Hidden tab already covered), and the per-row icons -- the
//! renderer has no icon column, and unicode stand-ins for the TS's SVG set
//! would misread worse than no icons at all.
//!
//! Deviation worth repeating: `requestDelete` (App.tsx L1931) shows its own
//! confirm modal over the list; the port's confirm lives on the editor, so
//! "Delete login" with `confirmDeletes` on opens the editor with the confirm
//! bar raised -- same question, same undo afterwards, one confirm in the app
//! instead of two.

use slint::{Model, ModelRc, VecModel};

use crate::{
    copy_item_password, copy_to_clipboard, items, lock_vault, open_editor, record_history,
    record_use, toggle_favorite, MenuRow, MainWindow, Shared,
};
use crate::settings_ops as ops;

const ITEM_H: f32 = 34.0;
const HEADING_H: f32 = 26.0;
const SEP_H: f32 = 9.0;
const PAD_H: f32 = 16.0;
/// The arrow/escape codes winit delivers in `KeyEvent.text` (macOS-style
/// virtual-key codes, which Slint maps on every platform): the keyboard walk
/// matches on plain strings like context-menu.tsx matches `event.key`.
const UP: &str = "\u{F700}";
const DOWN: &str = "\u{F701}";
const LEFT: &str = "\u{F702}";
const RIGHT: &str = "\u{F703}";
const ESC: &str = "\u{1b}";

// ---- Row builders --------------------------------------------------------

/// `kind 0`: a selectable item.
fn item(id: &str, label: &str, shortcut: &str, checked: bool, disabled: bool, danger: bool) -> MenuRow {
    MenuRow {
        id: id.into(),
        label: label.into(),
        shortcut: shortcut.into(),
        kind: 0,
        sub: false,
        disabled,
        danger,
        checked,
    }
}

/// `kind 0` with the arrow: a row whose press opens a submenu.
fn sub(id: &str, label: &str, disabled: bool) -> MenuRow {
    MenuRow {
        id: id.into(),
        label: label.into(),
        shortcut: "".into(),
        kind: 0,
        sub: true,
        disabled,
        danger: false,
        checked: false,
    }
}

fn sep() -> MenuRow {
    MenuRow {
        id: "".into(),
        label: "".into(),
        shortcut: "".into(),
        kind: 1,
        sub: false,
        disabled: false,
        danger: false,
        checked: false,
    }
}

fn heading(label: &str) -> MenuRow {
    MenuRow {
        id: "".into(),
        label: label.into(),
        shortcut: "".into(),
        kind: 2,
        sub: false,
        disabled: false,
        danger: false,
        checked: false,
    }
}

/// The layer's own height: padding plus each row's fixed share. Both the
/// renderer and the placement maths read this number, so a drift between
/// them shows up as a misplaced submenu in the shot, not as a layout
/// surprise.
fn rows_height(rows: &[MenuRow]) -> f32 {
    PAD_H
        + rows
            .iter()
            .map(|row| match row.kind {
                1 => SEP_H,
                2 => HEADING_H,
                _ => ITEM_H,
            })
            .sum::<f32>()
}

/// The y offset of row `index` inside its layer -- the submenu's anchor
/// (`placeSubmenu`'s anchor.top, App.tsx's counterpart at L95).
fn row_offset(rows: &[MenuRow], index: usize) -> f32 {
    let mut y = 8.0;
    for (i, row) in rows.iter().enumerate() {
        if i == index {
            break;
        }
        y += match row.kind {
            1 => SEP_H,
            2 => HEADING_H,
            _ => ITEM_H,
        };
    }
    y
}

fn sort_label(mode: &str) -> &'static str {
    match mode {
        "title" => "Name",
        "recent" => "Recently updated",
        "oldest" => "Least recently updated",
        "strength" => "Weakest first",
        "username" => "Username",
        "manual" => "Custom order",
        _ => "Name",
    }
}

fn first_upper(text: &str) -> String {
    let mut chars = text.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// `formatLoginCompact` (login-format.ts L507-520): single-line title, then
/// the labeled fields -- a friend with Colax pastes it straight back into a
/// login. Bulk Share's full labelled block is a later pass.
fn share_login(title: &str, username: &str, password: &str, totp: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    let title = title.trim();
    if !title.is_empty() {
        // Single line only: a multi-line title would read as extra fields.
        let first = title.split('\n').next().unwrap_or("");
        lines.push(first.trim().to_string());
    }
    let username = username.trim();
    if !username.is_empty() {
        lines.push(format!("email: {username}"));
    }
    let seed = totp.trim();
    if !seed.is_empty() {
        lines.push(format!("authenticator key: {seed}"));
    }
    if !password.is_empty() {
        lines.push(format!("password: {password}"));
    }
    lines.join("\n")
}

// ---- Opening -------------------------------------------------------------
// One push per layer; the model is rebuilt from scratch every time.

fn set_root(ui: &MainWindow, rows: Vec<MenuRow>, x: f32, y: f32) {
    ui.set_menu_open(true);
    ui.set_menu_x(x);
    ui.set_menu_y(y);
    ui.set_menu_root_h(rows_height(&rows));
    ui.set_menu_root_rows(ModelRc::new(VecModel::from(rows)));
    ui.set_menu_sub_open(false);
    ui.set_menu_active_root(-1);
}

fn set_sub(ui: &MainWindow, rows: Vec<MenuRow>, owner_y: f32, heading: bool) {
    ui.set_menu_sub_open(true);
    ui.set_menu_sub_y(owner_y);
    ui.set_menu_sub_heading(heading);
    ui.set_menu_sub_h(rows_height(&rows));
    ui.set_menu_sub_rows(ModelRc::new(VecModel::from(rows)));
}

// ---- The app menu (App.tsx L1944-2052) -----------------------------------

pub fn open_app_menu(ui: &MainWindow, state: &Shared, x: f32, y: f32) {
    let prefs = items::prefs_from(state.borrow().engine.preferences());
    let mut rows = Vec::new();

    rows.push(item("app.new", "New login", "N", false, false, false));
    // The only way back when the rail is hidden by request: the pill is
    // gone, so empty-space right-click carries the recovery (L1954-1963).
    if !prefs.show_sidebar {
        rows.push(item("app.show-sidebar", "Show sidebar", "", false, false, false));
    }
    rows.push(sub("app.view", "Switch view", false));
    rows.push(sub("app.sort", "Sort by", false));
    rows.push(sub("app.appearance", "Appearance", false));
    rows.push(sub("app.cardSize", "Card size", false));
    rows.push(sep());
    rows.push(item("app.settings", "Settings", "", false, false, false));
    rows.push(item("app.hidden", "Show hidden items\u{2026}", "", false, false, false));
    rows.push(item("app.shortcuts", "Keyboard shortcuts", "?", false, false, false));
    rows.push(item("app.lock", "Lock vault", "L", false, false, false));

    set_root(ui, rows, x, y);
}

// ---- The item menu (App.tsx L1828-1935) ----------------------------------
// Everything it reads comes from the live record each time the menu opens
// -- favourite, attention, reuse -- because the record can change while the
// menu sits open.

pub fn open_item_menu(ui: &MainWindow, state: &Shared, id: &str, x: f32, y: f32) {
    let (found, reused) = {
        let guard = state.borrow();
        let stored: Option<colax_core::VaultItem> = guard
            .engine
            .items()
            .and_then(|items| items.iter().find(|entry| entry.id == id).cloned());
        // `duplicateIds` (App.tsx L1831): a password another login holds too,
        // with an empty password never counting as shared.
        let reused = stored
            .as_ref()
            .map(|own| {
                !own.password.is_empty()
                    && guard
                        .engine
                        .items()
                        .map(|items| {
                            items
                                .iter()
                                .filter(|entry| entry.password == own.password)
                                .count()
                                > 1
                        })
                        .unwrap_or(false)
            })
            .unwrap_or(false);
        (stored, reused)
    };
    let Some(one) = found else { return };

    let has = |value: &str| !value.is_empty();

    let mut rows = Vec::new();
    rows.push(item(
        "item.copy-pw",
        "Copy password",
        "click",
        false,
        one.password.is_empty(),
        false,
    ));
    rows.push(item(
        "item.copy-user",
        "Copy username",
        "",
        false,
        !has(&one.username),
        false,
    ));
    rows.push(item(
        "item.copy-url",
        "Copy URL",
        "",
        false,
        !has(&one.url),
        false,
    ));
    rows.push(item(
        "item.share",
        "Share login",
        "",
        false,
        !has(&one.password) && !has(&one.username),
        false,
    ));
    rows.push(sep());
    rows.push(item(
        "item.fav",
        if one.favorite { "Remove from favorites" } else { "Add to favorites" },
        "",
        false,
        false,
        false,
    ));
    rows.push(item(
        "item.flag",
        if one.needs_attention {
            "Clear needs attention"
        } else {
            "Flag as needing attention"
        },
        "",
        false,
        false,
        false,
    ));
    rows.push(item("item.edit", "Edit login", "", false, false, false));
    rows.push(sub("item.open", "Open", !has(&one.url)));
    rows.push(sep());
    // The per-view "Card size" submenu (`cardSizeMenu`), the same one the
    // background menu carries: it opens the Appearance tuner on a chosen view.
    rows.push(sub("item.cardSize", "Card size", false));
    rows.push(sep());
    rows.push(item("item.delete", "Delete login", "", false, false, true));

    ui.set_menu_item_target(id.into());
    ui.set_menu_item_note(reused);
    set_root(ui, rows, x, y);
}

// ---- Submenus ------------------------------------------------------------
// Rebuilt fresh at every arm (the TS builds `items` at open): the ticks
// follow the prefs the menu's own actions change. The bool carried back is
// whether the submenu's first row is a heading -- the placement maths needs
// to know, so its first selectable row can line up with the owner.

// ---- The dock menus (Task 8.3) ------------------------------------------
// `dockMenu` (App.tsx L2766-2847) and `dockSlotMenu` (L2674-2764): the bar's
// own menu -- position, configure, new, duplicate, hide, add a slot -- and one
// slot's menu, which edits whatever the slot jumps to without a detour through
// Settings.

/// The resolved `kind:ref` id a stored slot answers to, the same string the
/// bar's model carries (`buildDockSlots` L2510).
fn slot_id_of(slot: &colax_core::DockSlotConfig) -> String {
    let kind = crate::dock::kind_name_of(slot.kind);
    format!(
        "{}:{}",
        kind,
        if slot.target.is_empty() { kind } else { slot.target.as_str() }
    )
}

/// The index of a slot named by its resolved id, for the bar's right-click.
fn slot_index_by_id(state: &Shared, dock_id: &str, slot_id: &str) -> Option<usize> {
    let prefs = items::prefs_from(state.borrow().engine.preferences());
    prefs
        .docks
        .iter()
        .find(|dock| dock.id == dock_id)
        .and_then(|dock| {
            dock.slots
                .iter()
                .position(|slot| slot_id_of(slot) == slot_id)
        })
}

/// The `ref` a stored slot points at, for the "Edit …" rows.
fn slot_target(state: &Shared, dock_id: &str, slot: i32) -> Option<String> {
    let prefs = items::prefs_from(state.borrow().engine.preferences());
    prefs
        .docks
        .iter()
        .find(|dock| dock.id == dock_id)
        .and_then(|dock| dock.slots.get(slot.max(0) as usize))
        .map(|slot| slot.target.clone())
}

/// The bar's own menu.
pub fn open_dock_menu(ui: &MainWindow, state: &Shared, dock_id: &str, x: f32, y: f32) {
    let prefs = items::prefs_from(state.borrow().engine.preferences());
    if !prefs.docks.iter().any(|dock| dock.id == dock_id) {
        return;
    }
    let mut rows = Vec::new();
    rows.push(sub(format!("dock.pos:{dock_id}").as_str(), "Dock position", false));
    rows.push(item(
        format!("dock.configure:{dock_id}").as_str(),
        "Configure dock\u{2026}",
        "",
        false,
        false,
        false,
    ));
    if prefs.docks.len() < colax_core::MAX_DOCKS {
        rows.push(item(
            format!("dock.new:{dock_id}").as_str(),
            "New dock",
            "",
            false,
            false,
            false,
        ));
        rows.push(item(
            format!("dock.duplicate:{dock_id}").as_str(),
            "Duplicate this dock",
            "",
            false,
            false,
            false,
        ));
    }
    rows.push(item(
        format!("dock.add-slot:{dock_id}").as_str(),
        "Add a slot\u{2026}",
        "",
        false,
        false,
        false,
    ));
    rows.push(sep());
    rows.push(item(
        format!("dock.hide:{dock_id}").as_str(),
        "Hide this dock",
        "",
        false,
        false,
        false,
    ));
    set_root(ui, rows, x, y);
}

/// The slot picker (`DockSettings.tsx`'s add rows, gathered): the four views,
/// the inbox, then every channel, folder, login and mailbox the document holds.
pub fn open_dock_add_menu(ui: &MainWindow, state: &Shared, dock_id: &str, x: f32, y: f32) {
    let (prefs, items) = {
        let guard = state.borrow();
        (
            items::prefs_from(guard.engine.preferences()),
            guard.engine.items().map(|items| items.to_vec()).unwrap_or_default(),
        )
    };
    let mut rows = Vec::new();
    rows.push(heading("Views"));
    for (id, label, _) in [
        ("animated", "Flow", ""),
        ("carousel", "Orbit", ""),
        ("basic", "List", ""),
        ("grid", "Grid", ""),
    ] {
        rows.push(item(
            format!("dockAdd:{dock_id}:view:{id}").as_str(),
            label,
            "",
            false,
            false,
            false,
        ));
    }
    rows.push(item(
        format!("dockAdd:{dock_id}:inbox:").as_str(),
        "Inbox",
        "",
        false,
        false,
        false,
    ));
    if !prefs.channels.is_empty() {
        rows.push(heading("Channels"));
        for channel in prefs.channels.iter().take(24) {
            rows.push(item(
                format!("dockAdd:{dock_id}:channel:{}", channel.id).as_str(),
                channel.name.as_str(),
                "",
                false,
                false,
                false,
            ));
        }
    }
    let folders = crate::dock::folder_list(&prefs);
    if !folders.is_empty() {
        rows.push(heading("Folders"));
        for folder in folders.iter().take(24) {
            rows.push(item(
                format!("dockAdd:{dock_id}:folder:{}", folder.0).as_str(),
                folder.1.as_str(),
                "",
                false,
                false,
                false,
            ));
        }
    }
    if !items.is_empty() {
        rows.push(heading("Logins"));
        for one in items.iter().take(24) {
            let label = if !one.title.is_empty() {
                one.title.clone()
            } else if !one.username.is_empty() {
                one.username.clone()
            } else {
                "Login".to_string()
            };
            rows.push(item(
                format!("dockAdd:{dock_id}:login:{}", one.id).as_str(),
                label.as_str(),
                "",
                false,
                false,
                false,
            ));
        }
    }
    let mailboxes = crate::channels_ops::mail_accounts(&prefs);
    if !mailboxes.is_empty() {
        rows.push(heading("Mailboxes"));
        for (id, address) in mailboxes.iter().take(24) {
            rows.push(item(
                format!("dockAdd:{dock_id}:mailbox:{id}").as_str(),
                if address.is_empty() { "Mailbox" } else { address.as_str() },
                "",
                false,
                false,
                false,
            ));
        }
    }
    set_root(ui, rows, x, y);
}

/// Right-click on a slot, named by its resolved id.
pub fn open_dock_slot_menu(ui: &MainWindow, state: &Shared, dock_id: &str, slot_id: &str, x: f32, y: f32) {
    if let Some(index) = slot_index_by_id(state, dock_id, slot_id) {
        open_dock_slot_menu_at(ui, state, dock_id, index, x, y);
    }
}

/// Right-click on a slot, named by index (the manager's own affordance).
pub fn open_dock_slot_menu_at(
    ui: &MainWindow,
    state: &Shared,
    dock_id: &str,
    slot_index: usize,
    x: f32,
    y: f32,
) {
    let (prefs, items) = {
        let guard = state.borrow();
        (
            items::prefs_from(guard.engine.preferences()),
            guard.engine.items().map(|items| items.to_vec()).unwrap_or_default(),
        )
    };
    let Some(slot) = prefs
        .docks
        .iter()
        .find(|dock| dock.id == dock_id)
        .and_then(|dock| dock.slots.get(slot_index))
        .cloned()
    else {
        return;
    };

    let mut rows = Vec::new();
    match slot.kind {
        colax_core::DockSlotKind::Login => {
            let found = items.iter().find(|item| item.id == slot.target);
            match found {
                Some(login) => {
                    let label = if !login.title.is_empty() {
                        login.title.clone()
                    } else if !login.username.is_empty() {
                        login.username.clone()
                    } else {
                        "login".to_string()
                    };
                    rows.push(item(
                        format!("dockSlot.edit-login:{dock_id}:{slot_index}").as_str(),
                        format!("Edit {label}").as_str(),
                        "",
                        false,
                        false,
                        false,
                    ));
                }
                None => rows.push(item("", "Login deleted", "", false, true, false)),
            }
            rows.push(sep());
            rows.push(sub(
                format!("dockSlot.action:{dock_id}:{slot_index}").as_str(),
                "Login action",
                false,
            ));
        }
        colax_core::DockSlotKind::Channel => {
            let found = prefs.channels.iter().find(|channel| channel.id == slot.target);
            match found {
                Some(channel) => rows.push(item(
                    format!("dockSlot.edit-channel:{dock_id}:{slot_index}").as_str(),
                    format!("Edit {}", channel.name).as_str(),
                    "",
                    false,
                    false,
                    false,
                )),
                None => rows.push(item("", "Channel deleted", "", false, true, false)),
            }
        }
        colax_core::DockSlotKind::Folder => {
            let found = crate::dock::folder_list(&prefs)
                .into_iter()
                .find(|(id, _)| *id == slot.target);
            match found {
                Some((_, name)) => rows.push(item(
                    format!("dockSlot.edit-folder:{dock_id}:{slot_index}").as_str(),
                    format!("Edit {name}").as_str(),
                    "",
                    false,
                    false,
                    false,
                )),
                None => rows.push(item("", "Folder deleted", "", false, true, false)),
            }
        }
        colax_core::DockSlotKind::Mailbox => {
            let address = crate::channels_ops::mail_accounts(&prefs)
                .into_iter()
                .find(|(id, _)| *id == slot.target)
                .map(|(_, address)| address);
            match address {
                Some(address) => rows.push(item(
                    format!("dockSlot.open-mailbox:{dock_id}:{slot_index}").as_str(),
                    format!("Open {}", if address.is_empty() { "mailbox".to_string() } else { address }).as_str(),
                    "",
                    false,
                    false,
                    false,
                )),
                None => rows.push(item("", "Mailbox disconnected", "", false, true, false)),
            }
        }
        _ => {}
    }

    rows.push(item(
        format!("dockSlot.key:{dock_id}:{slot_index}").as_str(),
        "Set key\u{2026}",
        "",
        false,
        false,
        false,
    ));
    rows.push(item(
        format!("dockSlot.left:{dock_id}:{slot_index}").as_str(),
        "Move left",
        "",
        false,
        slot_index == 0,
        false,
    ));
    let last = prefs
        .docks
        .iter()
        .find(|dock| dock.id == dock_id)
        .map(|dock| dock.slots.len())
        .unwrap_or(0);
    rows.push(item(
        format!("dockSlot.right:{dock_id}:{slot_index}").as_str(),
        "Move right",
        "",
        false,
        slot_index + 1 >= last,
        false,
    ));
    rows.push(item(
        format!("dockSlot.remove:{dock_id}:{slot_index}").as_str(),
        "Remove slot",
        "",
        false,
        false,
        true,
    ));
    rows.push(sep());
    rows.push(item(
        format!("dock.configure:{dock_id}").as_str(),
        "Customize this bar\u{2026}",
        "",
        false,
        false,
        false,
    ));
    rows.push(item(
        format!("dock.hidden:{dock_id}").as_str(),
        "Show hidden items\u{2026}",
        "",
        false,
        false,
        false,
    ));

    set_root(ui, rows, x, y);
}

fn sub_rows(ui: &MainWindow, state: &Shared, key: &str) -> Option<(Vec<MenuRow>, bool)> {
    let prefs = items::prefs_from(state.borrow().engine.preferences());
    let mut rows: Vec<MenuRow> = Vec::new();
    let head;
    match key {
        // One list with the topbar's (VIEW_OPTIONS, ViewMenu.tsx), so the
        // dropdown, the panel and this menu cannot drift.
        "app.view" => {
            head = true;
            rows.push(heading("View"));
            for (id, label, shortcut) in [
                ("animated", "Flow", "1"),
                ("carousel", "Orbit", "2"),
                ("basic", "List", "3"),
                ("grid", "Grid", "4"),
            ] {
                rows.push(item(
                    format!("app.view:{id}").as_str(),
                    label,
                    shortcut,
                    prefs.view == id,
                    false,
                    false,
                ));
            }
        }
        "app.sort" => {
            head = true;
            rows.push(heading("Sort order"));
            for (id, _) in [
                ("title", ""),
                ("recent", ""),
                ("oldest", ""),
                ("strength", ""),
                ("username", ""),
                ("manual", ""),
            ] {
                rows.push(item(
                    format!("app.sort:{id}").as_str(),
                    sort_label(id),
                    "",
                    prefs.sort == id,
                    false,
                    false,
                ));
            }
        }
        // The per-view card geometry (Task 8.4): the row the TS's
        // `cardSizeMenu` draws. Picking a view opens the Appearance tuner
        // already scoped to it, and the active view carries the tick -- the
        // tuner edits whichever view is on screen.
        "app.cardSize" | "item.cardSize" => {
            head = true;
            rows.push(heading("Card size"));
            let owner = if key.starts_with("item") { "item" } else { "app" };
            for (id, label) in [
                ("animated", "Flow"),
                ("carousel", "Orbit"),
                ("basic", "List"),
                ("grid", "Grid"),
            ] {
                rows.push(item(
                    format!("{owner}.cardSize:{id}").as_str(),
                    label,
                    "",
                    prefs.view == id,
                    false,
                    false,
                ));
            }
        }
        "app.appearance" => {
            head = false;
            // The accents in the fixed order the Appearance row shows them.
            for accent in ["slate", "sage", "dusk", "clay"] {
                rows.push(item(
                    format!("app.accent:{accent}").as_str(),
                    first_upper(accent).as_str(),
                    "",
                    prefs.accent == accent,
                    false,
                    false,
                ));
            }
            rows.push(sep());
            for theme in ["light", "dark", "system"] {
                rows.push(item(
                    format!("app.theme:{theme}").as_str(),
                    first_upper(theme).as_str(),
                    "",
                    prefs.theme == theme,
                    false,
                    false,
                ));
            }
            rows.push(sep());
            rows.push(item(
                "app.motion",
                if prefs.motion > 0.0 { "Reduce animation" } else { "Enable animation" },
                "",
                prefs.motion == 0.0,
                false,
                false,
            ));
        }
        "item.open" => {
            head = false;
            let target = ui.get_menu_item_target().to_string();
            let guard = state.borrow();
            let stored = guard
                .engine
                .items()
                .and_then(|items| items.iter().find(|entry| entry.id == target).cloned());
            let Some(one) = stored else { return None };
            let reused = !one.password.is_empty()
                && guard
                    .engine
                    .items()
                    .map(|items| {
                        items
                            .iter()
                            .filter(|entry| entry.password == one.password)
                            .count()
                            > 1
                    })
                    .unwrap_or(false);
            rows.push(item(
                "item.open-url",
                items::hostname_of(&one.url)
                    .unwrap_or_else(|| "Website".to_string())
                    .as_str(),
                "",
                false,
                false,
                false,
            ));
            if reused {
                rows.push(item(
                    "item.open-note",
                    "Note: password is reused",
                    "",
                    false,
                    true,
                    false,
                ));
            }
        }
        // `Dock position ▸` (Task 8.3): the four canonical spots, with the
        // bar's current edge ticked (`dockMenu`, App.tsx L2770-2787).
        key if key.starts_with("dock.pos:") => {
            let dock_id = &key["dock.pos:".len()..];
            head = true;
            rows.push(heading("Dock position"));
            let current = prefs
                .docks
                .iter()
                .find(|dock| dock.id == dock_id)
                .map(|dock| crate::dock::edge_name(dock.pos.edge))
                .unwrap_or("bottom");
            for edge in ["bottom", "top", "left", "right"] {
                rows.push(item(
                    format!("dockPos:{dock_id}:{edge}").as_str(),
                    crate::dock::edge_label(crate::dock::parse_edge(edge)),
                    "",
                    current == edge,
                    false,
                    false,
                ));
            }
        }
        // `Login action ▸`: what pressing a login slot does (DockSettings.tsx
        // `DOCK_LOGIN_ACTIONS`, L119).
        key if key.starts_with("dockSlot.action:") => {
            let rest = &key["dockSlot.action:".len()..];
            let (dock_id, slot) = rest.rsplit_once(':').unwrap_or((rest, "0"));
            head = true;
            rows.push(heading("Login action"));
            let current = prefs
                .docks
                .iter()
                .find(|dock| dock.id == dock_id)
                .and_then(|dock| dock.slots.get(slot.parse::<usize>().unwrap_or(0)))
                .and_then(|slot| slot.action)
                .unwrap_or(colax_core::DockLoginAction::Both);
            for (id, label) in [
                ("password", "Copy password"),
                ("email", "Copy email"),
                ("both", "Copy login"),
                ("edit", "Edit login"),
                ("messages", "Show messages"),
            ] {
                rows.push(item(
                    format!("dockAction:{dock_id}:{slot}:{id}").as_str(),
                    label,
                    "",
                    crate::dock::action_matches(current, id),
                    false,
                    false,
                ));
            }
        }
        _ => return None,
    }
    Some((rows, head))
}

// ---- The keyboard (context-menu.tsx's MenuLayer keyboard) ----------------
// Arrows move over selectable rows (skipping separators, headings, disabled
// rows), right opens the active row's submenu, left closes it, Enter/Space
// select, Escape closes one level and then all, and letter keys type-ahead
// to the next row whose label begins with them.

fn model_rows(model: &ModelRc<MenuRow>) -> Vec<MenuRow> {
    (0..model.row_count())
        .filter_map(|i| model.row_data(i))
        .collect()
}

fn selectable(rows: &[MenuRow], index: usize) -> bool {
    rows.get(index)
        .map(|row| row.kind == 0 && !row.disabled)
        .unwrap_or(false)
}

fn step(rows: &[MenuRow], from: i32, dir: i32) -> i32 {
    let last = rows.len() as i32 - 1;
    let mut candidate = from;
    for _ in 0..rows.len() {
        candidate += dir;
        let candidate = if candidate < 0 {
            last
        } else if candidate > last {
            0
        } else {
            candidate
        };
        if selectable(rows, candidate as usize) {
            return candidate;
        }
    }
    -1
}

fn typeahead(rows: &[MenuRow], from: i32, typed: &str) -> i32 {
    let typed = typed.to_lowercase();
    let len = rows.len() as i32;
    for ahead in 1..=len {
        let candidate = ((from + ahead) % len + len) % len;
        if let Some(row) = rows.get(candidate as usize) {
            if row.kind == 0 && !row.disabled && row.label.to_lowercase().starts_with(&typed) {
                return candidate;
            }
        }
    }
    -1
}

pub fn menu_key(ui: &MainWindow, state: &Shared, text: &str) {
    if !ui.get_menu_open() {
        return;
    }
    let sub_open = ui.get_menu_sub_open();
    let rows: Vec<MenuRow> = if sub_open {
        model_rows(&ui.get_menu_sub_rows())
    } else {
        model_rows(&ui.get_menu_root_rows())
    };
    if rows.is_empty() {
        close(ui);
        return;
    }

    match text {
        ESC | "Escape" => {
            if sub_open {
                ui.set_menu_sub_open(false);
                ui.set_menu_active_sub(-1);
            } else {
                close(ui);
            }
        }
        UP | DOWN => {
            let dir = if text == UP { -1 } else { 1 };
            let from = if sub_open { ui.get_menu_active_sub() } else { ui.get_menu_active_root() };
            let next = step(&rows, from, dir);
            if sub_open {
                ui.set_menu_active_sub(next);
            } else {
                ui.set_menu_active_root(next);
            }
        }
        LEFT => {
            if sub_open {
                ui.set_menu_sub_open(false);
                ui.set_menu_active_sub(-1);
            }
        }
        RIGHT => {
            if !sub_open {
                arm(ui, state, ui.get_menu_active_root());
            }
        }
        "\r" | "\n" | "\u{2028}" | "\u{2029}" | " " => {
            let index = if sub_open { ui.get_menu_active_sub() } else { ui.get_menu_active_root() };
            if index >= 0 {
                if let Some(row) = rows.get(index as usize) {
                    if row.sub {
                        if !sub_open {
                            arm(ui, state, index);
                        }
                    } else {
                        let id = row.id.to_string();
                        close(ui);
                        picked(ui, state, &id);
                    }
                }
            }
        }
        other => {
            if let Some(c) = other.chars().next() {
                if c.is_alphanumeric() {
                    let from = if sub_open { ui.get_menu_active_sub() } else { ui.get_menu_active_root() };
                    let next = typeahead(&rows, from, other);
                    if next >= 0 {
                        if sub_open {
                            ui.set_menu_active_sub(next);
                        } else {
                            ui.set_menu_active_root(next);
                        }
                    }
                }
            }
        }
    }
}

// ---- Arms, hovers, picks -------------------------------------------------

/// The pointer's row: the mark follows it, and a row that owns a submenu
/// arms it while any other closes whatever was open -- hovering "Copy URL"
/// must not leave "Open" stuck open beneath it.
pub fn menu_hover(ui: &MainWindow, state: &Shared, index: i32) {
    let root_rows = model_rows(&ui.get_menu_root_rows());
    if !selectable(&root_rows, index.max(0) as usize) {
        return;
    }
    ui.set_menu_active_root(index);
    let is_sub = root_rows
        .get(index.max(0) as usize)
        .map(|row| row.sub)
        .unwrap_or(false);
    if is_sub {
        arm(ui, state, index);
    } else if ui.get_menu_sub_open() {
        ui.set_menu_sub_open(false);
        ui.set_menu_active_sub(-1);
    }
}

pub fn menu_picked(ui: &MainWindow, state: &Shared, id: &str) {
    // A submenu row's press only arms it (the click opens the layer rather
    // than running an action).
    let root_rows = model_rows(&ui.get_menu_root_rows());
    if let Some(row) = root_rows.iter().find(|row| row.id == id) {
        if row.sub {
            arm(ui, state, ui.get_menu_active_root());
            return;
        }
    }
    close(ui);
    picked(ui, state, id);
}

/// Arms (or re-arms) the submenu owned by the active root row, rebuilt
/// fresh so its ticks follow the prefs its actions change.
fn arm(ui: &MainWindow, state: &Shared, index: i32) {
    if index < 0 {
        return;
    }
    let root_rows = model_rows(&ui.get_menu_root_rows());
    let Some(row) = root_rows.get(index as usize) else {
        return;
    };
    if !row.sub || row.disabled {
        if ui.get_menu_sub_open() {
            ui.set_menu_sub_open(false);
        }
        return;
    }
    let owner_y = row_offset(&root_rows, index as usize);
    match sub_rows(ui, state, &row.id.clone().to_string()) {
        Some((rows, head)) => {
            // The first selectable row opens highlighted.
            let first = rows.iter().position(|row| row.kind == 0 && !row.disabled);
            set_sub(ui, rows, owner_y, head);
            ui.set_menu_active_sub(first.map(|i| i as i32).unwrap_or(-1));
        }
        None => {
            ui.set_menu_sub_open(false);
        }
    }
}

pub fn close(ui: &MainWindow) {
    ui.set_menu_open(false);
    ui.set_menu_sub_open(false);
    ui.set_menu_root_rows(ModelRc::new(VecModel::from(Vec::<MenuRow>::new())));
    ui.set_menu_sub_rows(ModelRc::new(VecModel::from(Vec::<MenuRow>::new())));
    ui.set_menu_active_root(-1);
    ui.set_menu_active_sub(-1);
    ui.set_menu_item_target("".into());
    ui.set_menu_item_note(false);
}

// ---- The actions (the TS's onSelect bodies) ------------------------------

fn picked(ui: &MainWindow, state: &Shared, id: &str) {
    // `Card size ▸ <view>` (Task 8.4) is the one row both menus carry under
    // two owners, and it opens the Appearance tuner scoped to the view rather
    // than writing a preference itself.
    for owner in ["app.", "item."] {
        if let Some(view) = id
            .strip_prefix(owner)
            .and_then(|rest| rest.strip_prefix("cardSize:"))
        {
            crate::tuner::open(ui, state, Some(view));
            return;
        }
    }
    // The dock menus (Task 8.3). One prefix for the bar, one for its slots,
    // one for the slot picker; each parses `id:index` suffixes rather than
    // trusting a row's label back.
    if let Some(rest) = id.strip_prefix("dockPos:") {
        if let Some((dock_id, edge)) = rest.rsplit_once(':') {
            crate::dock::set_pos(ui, state, dock_id, edge);
        }
        return;
    }
    if let Some(rest) = id.strip_prefix("dock.configure:") {
        let _ = rest;
        ui.invoke_open_settings("layout".into());
        return;
    }
    if let Some(rest) = id.strip_prefix("dock.hidden:") {
        let _ = rest;
        ui.invoke_open_settings("hidden".into());
        return;
    }
    if let Some(rest) = id.strip_prefix("dock.new:") {
        let _ = rest;
        crate::dock::add_dock(ui, state);
        return;
    }
    if let Some(rest) = id.strip_prefix("dock.duplicate:") {
        crate::dock::duplicate_dock(ui, state, rest);
        return;
    }
    if let Some(rest) = id.strip_prefix("dock.hide:") {
        crate::dock::hide(ui, state, rest);
        return;
    }
    if let Some(rest) = id.strip_prefix("dock.add-slot:") {
        // A second root menu replaces this one, anchored where it was.
        open_dock_add_menu(ui, state, rest, ui.get_menu_x(), ui.get_menu_y());
        return;
    }
    if let Some(rest) = id.strip_prefix("dockAdd:") {
        let parts: Vec<&str> = rest.splitn(3, ':').collect();
        if let [dock_id, kind, target] = parts.as_slice() {
            if let Some(kind) = crate::dock::slot_kind_of(&format!("{kind}:")) {
                crate::dock::add_slot(ui, state, dock_id, kind, target);
            }
        }
        return;
    }
    if let Some(rest) = id.strip_prefix("dockSlot.") {
        let (what, tail) = rest.split_once(':').unwrap_or((rest, ""));
        let (dock_id, slot) = tail.rsplit_once(':').unwrap_or((tail, "0"));
        let slot: i32 = slot.parse().unwrap_or(0);
        match what {
            "edit-login" => {
                if let Some(target) = slot_target(state, dock_id, slot) {
                    open_editor(ui, state, target.as_str());
                }
            }
            "edit-channel" => {
                if let Some(target) = slot_target(state, dock_id, slot) {
                    crate::channels_ops::open(ui, state, target.as_str());
                }
            }
            "edit-folder" => {
                // Folder editing belongs to the rail's own tree, which is not
                // built yet; send the user where it will live rather than
                // leaving a dead row.
                ui.invoke_open_settings("layout".into());
            }
            "open-mailbox" => {
                crate::notice(ui, "Mailbox windows arrive with the mail engine.");
            }
            "key" => {
                crate::dock::arm_key(ui, state, dock_id, slot.max(0) as usize);
                crate::notice(ui, "Press the key you want this slot to answer to\u{2026}");
            }
            "left" => crate::dock::move_slot(ui, state, dock_id, slot.max(0) as usize, -1),
            "right" => crate::dock::move_slot(ui, state, dock_id, slot.max(0) as usize, 1),
            "remove" => crate::dock::remove_slot(ui, state, dock_id, slot.max(0) as usize),
            _ => {}
        }
        return;
    }
    if let Some(rest) = id.strip_prefix("dockAction:") {
        let parts: Vec<&str> = rest.splitn(3, ':').collect();
        if let [dock_id, slot, action] = parts.as_slice() {
            crate::dock::set_slot_action(ui, state, dock_id, slot.parse().unwrap_or(0), action);
        }
        return;
    }

    if let Some(tail) = id.strip_prefix("app.") {
        if let Some(view) = tail.strip_prefix("view:") {
            ops::pref_string(ui, state, "view", view);
            return;
        }
        if let Some(sort) = tail.strip_prefix("sort:") {
            ops::pref_string(ui, state, "sort", sort);
            return;
        }
        if let Some(accent) = tail.strip_prefix("accent:") {
            ops::pref_string(ui, state, "accent", accent);
            return;
        }
        if let Some(theme) = tail.strip_prefix("theme:") {
            ops::pref_string(ui, state, "theme", theme);
            return;
        }
        match tail {
            "new" => open_editor(ui, state, ""),
            // One write through the write path: rail, label and shortcut all
            // re-derive on the refresh this triggers.
            "show-sidebar" => {
                ops::pref_bool(ui, state, "showSidebar", true);
            }
            "settings" => {
                ui.invoke_open_settings("".into());
            }
            "hidden" => {
                ui.invoke_open_settings("hidden".into());
            }
            "shortcuts" => {
                crate::shortcuts::open_sheet(ui);
            }
            "lock" => {
                lock_vault(ui, state);
            }
            "motion" => {
                let prefs = items::prefs_from(state.borrow().engine.preferences());
                ops::pref_float(ui, state, "motion", if prefs.motion > 0.0 { 0.0 } else { 1.0 });
            }
            other => {
                eprintln!("context menu dispatched an app id nobody built: {other}");
            }
        }
        return;
    }
    let Some(tail) = id.strip_prefix("item.") else {
        eprintln!("context menu dispatched an id nobody built: {id}");
        return;
    };
    match tail {
        "copy-pw" => {
            let target = ui.get_menu_item_target().to_string();
            if !target.is_empty() {
                // `copy_item_password` records the use and raises the toast.
                copy_item_password(ui, state, &target);
            }
        }
        "copy-user" | "copy-url" => {
            let target = ui.get_menu_item_target().to_string();
            let (value, label) = {
                let guard = state.borrow();
                guard
                    .engine
                    .items()
                    .and_then(|items| items.iter().find(|entry| entry.id == target).cloned())
                    .map(|entry| {
                        if tail == "copy-user" {
                            (entry.username, "Username".to_string())
                        } else {
                            (entry.url, "URL".to_string())
                        }
                    })
                    .unwrap_or_default()
            };
            if !value.is_empty() {
                // A copy counts as a use, like every other copy (`onCopy`
                // carries the live one through the same two calls).
                record_use(ui, state, &target);
                copy_to_clipboard(ui, state, &value, &label);
            }
        }
        "share" => {
            let target = ui.get_menu_item_target().to_string();
            let text = {
                let guard = state.borrow();
                guard
                    .engine
                    .items()
                    .and_then(|items| items.iter().find(|entry| entry.id == target).cloned())
                    .map(|entry| {
                        share_login(
                            &entry.title,
                            &entry.username,
                            &entry.password,
                            &entry.totp_secret,
                        )
                    })
                    .unwrap_or_default()
            };
            if !text.is_empty() {
                record_use(ui, state, &target);
                copy_to_clipboard(ui, state, &text, "Login shared");
            }
        }
        "fav" => {
            let target = ui.get_menu_item_target().to_string();
            toggle_favorite(ui, state, &target);
        }
        "flag" => {
            let target = ui.get_menu_item_target().to_string();
            flag_login(ui, state, &target);
        }
        "edit" => {
            let target = ui.get_menu_item_target().to_string();
            open_editor(ui, state, &target);
        }
        "open-url" => {
            let target = ui.get_menu_item_target().to_string();
            open_login_url(ui, state, &target);
        }
        "delete" => {
            let target = ui.get_menu_item_target().to_string();
            delete_login(ui, state, &target);
        }
        other => {
            eprintln!("context menu dispatched an item id nobody built: {other}");
        }
    }
}

/// `openUrl` (App.tsx L1898-1908): through the platform seam, notify the
/// host, and say so out loud when the password this login carries is also
/// carried by another one and `warnOnReuse` is on (the TS colours that toast
/// red; the port's notice is one tone, so the warning is in the words).
fn open_login_url(ui: &MainWindow, state: &Shared, id: &str) {
    let url = {
        let guard = state.borrow();
        guard
            .engine
            .items()
            .and_then(|items| items.iter().find(|entry| entry.id == id).cloned())
            .map(|entry| entry.url)
            .unwrap_or_default()
    };
    if url.is_empty() {
        return;
    }
    let reused = {
        let guard = state.borrow();
        items::prefs_from(guard.engine.preferences()).warn_on_reuse
            && guard
                .engine
                .items()
                .and_then(|items| items.iter().find(|entry| entry.id == id).cloned())
                .map(|own| {
                    !own.password.is_empty()
                        && guard
                            .engine
                            .items()
                            .map(|items| {
                                items
                                    .iter()
                                    .filter(|entry| entry.password == own.password)
                                    .count()
                                    > 1
                            })
                            .unwrap_or(false)
                })
                .unwrap_or(false)
    };
    if crate::platform::open_url(&url) {
        let host = items::hostname_of(&url).unwrap_or_else(|| "site".to_string());
        let message = if reused {
            format!("Opening {host} \u{2014} password is reused")
        } else {
            format!("Opening {host}")
        };
        crate::notice(ui, &message);
    } else {
        crate::notice(ui, "Windows did not open that address.");
    }
}

/// The attention flag flips out of band (the TS `toggleAttention` calls
/// `setAttention`, which preserves `updatedAt`), so this is an `updateItem`
/// write, not a draft through the editor -- the same shape the
/// untouched-login scan already uses.
fn flag_login(ui: &MainWindow, state: &Shared, id: &str) {
    let current = {
        let guard = state.borrow();
        guard
            .engine
            .items()
            .and_then(|items| items.iter().find(|entry| entry.id == id))
            .map(|entry| entry.needs_attention)
            .unwrap_or(false)
    };
    let result = state
        .borrow_mut()
        .engine
        .update_item(&id, &serde_json::json!({ "needsAttention": !current }));
    match result {
        Ok(_) => {
            crate::refresh_items(ui, state);
        }
        Err(err) => {
            crate::notice(ui, &err.to_string());
        }
    }
}

/// Delete straight from the list (`requestDelete`): the confirm bar when the
/// pref asks (see the module's deviation note), the immediate delete -- with
/// history, the undo strip and the whole row, not a re-typed copy -- when it
/// does not.
fn delete_login(ui: &MainWindow, state: &Shared, id: &str) {
    let confirm = {
        let guard = state.borrow();
        items::prefs_from(guard.engine.preferences()).confirm_deletes
    };
    if confirm {
        open_editor(ui, state, id);
        ui.set_editor_confirm_delete(true);
        return;
    }
    let (result, before) = {
        let mut guard = state.borrow_mut();
        let before: Vec<colax_core::VaultItem> = guard
            .engine
            .items()
            .map(|items| items.to_vec())
            .unwrap_or_default();
        let result = guard.engine.delete_item(id);
        (result, before)
    };
    match result {
        Ok(()) => {
            let deleted = before.iter().find(|entry| entry.id == id).cloned();
            let title = deleted
                .as_ref()
                .map(|one| one.title.clone())
                .unwrap_or_default();
            state.borrow_mut().last_deleted = deleted;
            record_history(ui, state, &before);
            crate::refresh_items(ui, state);
            ui.set_undo_text(format!("Deleted \u{201c}{title}\u{201d}.").as_str().into());
        }
        Err(err) => {
            crate::notice(ui, &err.to_string());
        }
    }
}
