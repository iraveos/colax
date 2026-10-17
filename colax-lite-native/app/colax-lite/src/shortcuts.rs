//! Global keyboard shortcuts (Task 8.2).
//!
//! Port of the window-level key handling in `src/ui/App.tsx`: the `useHotkeys`
//! map (L389-408), the Ctrl+Z/Ctrl+Shift+Z effect (L412-434), the Alt+1..9
//! channel jump (L2879-2909) and the view shortcuts Ctrl+1..4
//! (`ViewMenu.tsx` `useViewShortcuts`, L317-330). The sheet the `?` key opens
//! draws its rows from `rows()` here, so the table can never promise a key
//! the dispatcher below does not answer.
//!
//! In the web build every one of these is a `window` listener, so each carries
//! its own guard against text fields and modals. In Slint there is one
//! `FocusScope` wrapping the screens (`shortcut-scope`, `ui/main.slint`), and
//! a key reaches it only when the focused widget did not take it -- which is
//! already the "a text field is typing" rule, since a `TextInput` consumes the
//! characters (and Ctrl+Z, through its own undo) it is given. What Slint cannot
//! express that way is the app's own dialogs, which are siblings of that scope:
//! those are checked explicitly in `live()` below, mirroring the TS guard's
//! `!editing && !confirmDelete && !showShortcuts && !showSettings && !menu`.

use slint::{ModelRc, SharedString, VecModel};

use crate::items;
use crate::{MainWindow, Screen, Shared, ShortcutRow};

/// The arrow/escape codes winit hands Slint in `KeyEvent.text` -- the same
/// spelling `menus.rs` matches on.
const ESC: &str = "\u{1b}";

/// The four card layouts in the order `VIEW_OPTIONS` (ViewMenu.tsx) lists
/// them: what `V` cycles through and what Ctrl+1..4 pick.
const VIEWS: [&str; 4] = ["animated", "carousel", "basic", "grid"];

/// The sheet's ten rows, verbatim from `App.tsx` L3736-3746.
fn rows() -> Vec<ShortcutRow> {
    let chip = |keys: &[&str]| -> ModelRc<SharedString> {
        ModelRc::new(VecModel::from(
            keys.iter()
                .map(|key| SharedString::from(*key))
                .collect::<Vec<_>>(),
        ))
    };
    let row = |label: &str, keys: &[&str]| ShortcutRow {
        label: label.into(),
        keys: chip(keys),
    };
    vec![
        row("Focus search", &["/"]),
        row("New login", &["N"]),
        row("Switch channel", &["Alt", "1\u{2013}9"]),
        row("Lock vault", &["L"]),
        row("Cycle view", &["V"]),
        row("Undo", &["Ctrl", "Z"]),
        row("Redo", &["Ctrl", "Shift", "Z"]),
        row("This dialog", &["?"]),
        row("Right-click menu", &["right click"]),
        row("Close / cancel", &["Esc"]),
    ]
}

/// The one entry point: the window's `FocusScope` hands every key it is left
/// with here, and the answer says whether it was used (`accept` stops it,
/// `reject` lets Slint's own Tab handling and the like still run).
///
/// Escape is answered first and outside the vault guard, because its two jobs
/// -- closing this sheet and cancelling the editor -- are the TS `escape`
/// entry, which is reachable from more than the vault screen.
pub fn key(ui: &MainWindow, state: &Shared, text: &str, ctrl: bool, shift: bool, alt: bool) -> bool {
    // A dock key recording (Task 8.3) is armed from a menu, which then closes,
    // so the next key arrives here. It is answered before everything else --
    // including Escape and the vault guard -- because while a recording is
    // armed *every* key is the answer, and letting a stray `v` switch a view
    // mid-recording is exactly the accident the guard exists to prevent.
    if crate::dock::capturing(state) {
        return crate::dock::capture(ui, state, text);
    }

    if text == ESC || text == "Escape" {
        if ui.get_show_shortcuts() {
            close_sheet(ui);
            return true;
        }
        // The appearance tuner (Task 8.4) is a slide-over, not a modal, so
        // Escape dismissing it is the native courtesy the TS achieves only
        // with an outside click; leaving it open with no key to close it
        // would be a native trap.
        if ui.get_show_tuner() {
            crate::tuner::close(ui);
            return true;
        }
        if ui.get_screen() == Screen::Editor {
            crate::editor_cancel(ui, state);
            return true;
        }
        return false;
    }

    // Undo/redo answer under the looser guard their own TS effect keeps
    // (L413: only `unlocked`), so a Ctrl+Z on the editor screen still works
    // when nothing editable has the focus. A text field keeps its own undo
    // anyway -- the TextInput consumes Ctrl+Z before it ever gets here -- so
    // this can never steal one.
    if ctrl && !alt {
        if state.borrow().engine.is_unlocked()
            && matches!(ui.get_screen(), Screen::Vault | Screen::Editor)
        {
            match text.to_ascii_lowercase().as_str() {
                "z" => return if shift { crate::redo(ui, state) } else { crate::undo(ui, state) },
                "y" => return crate::redo(ui, state),
                _ => {}
            }
        }
    }

    // A locked vault, the gate, a dialog or the editor's own confirm bar all
    // mean "not now" -- the guard of `useHotkeys`.
    if !live(ui, state) {
        return false;
    }

    if alt && !ctrl {
        // Alt+1..9 jumps to the first nine visible rail channels (App.tsx
        // L2879-2909); bare digits belong to the dock, which Alt keeps clear
        // of. The TS handler does not test Shift, so neither does this.
        //
        // The tuner is the one thing that blocks this jump and not the bare
        // keys: `openTuner` leaves `useHotkeys` live but the Alt effect
        // tests `.tuner` (App.tsx L2842), the same split this mirrors.
        if ui.get_show_tuner() {
            return false;
        }
        if let Some(n) = digit(text) {
            let target = rail_ids(ui, state);
            if let Some(id) = target.get(n as usize - 1) {
                let id = id.clone();
                ui.set_active_channel(id.into());
                crate::refresh_items(ui, state);
                return true;
            }
        }
        return false;
    }

    if ctrl {
        // Ctrl+1..4 pick a view (useViewShortcuts). Ctrl+9..5 have no meaning
        // over here; the Settings window consumes its own Ctrl+1..9 before any
        // key reaches this scope.
        if !alt {
            if let Some(n) = digit(text) {
                if (1..=4).contains(&n) {
                    crate::view_picked(ui, state, VIEWS[n as usize - 1]);
                    return true;
                }
            }
            match text.to_ascii_lowercase().as_str() {
                // Undo/redo were already answered above, under their own
                // guard; nothing more to do with z/y here.
                "z" | "y" => return false,
                // Ctrl+A select-all is not ported: the views have no
                // multi-select and no bulk actions yet (a later pass), so
                // there is nothing for it to select. Left unclaimed on
                // purpose rather than offered dead.
                _ => return false,
            }
        }
        return false;
    }

    // Bare keys: the `useHotkeys` map. Shift is allowed only so `?` (which is
    // shift+/ on a US layout) still resolves.
    match text {
        "/" => {
            focus_search(ui);
            true
        }
        "n" | "N" if !shift => {
            crate::open_editor(ui, state, "");
            true
        }
        "l" | "L" if !shift => {
            crate::lock_vault(ui, state);
            true
        }
        "v" | "V" if !shift => {
            let current = ui.get_vault_view().to_string();
            let next = VIEWS
                .iter()
                .position(|view| *view == current)
                .map(|index| VIEWS[(index + 1) % VIEWS.len()])
                .unwrap_or(VIEWS[0]);
            crate::view_picked(ui, state, next);
            true
        }
        "?" => {
            open_sheet(ui);
            true
        }
        // Bare dock keys (Task 8.3) come last, so a built-in key wins a
        // collision exactly as `useHotkeys` (registered first) wins over the
        // dock's own listener. Modifiers are excluded outright: a chord belongs
        // to the global hotkeys, and mixing the two systems on one key is how a
        // shortcut gets claimed twice (`useDockShortcuts`, Dock.tsx L293-310).
        _ => {
            if ctrl || alt || text.chars().count() != 1 {
                return false;
            }
            match crate::dock::key_target(state, text) {
                Some((dock_id, slot_id)) => {
                    crate::dock::slot_pressed(ui, state, &dock_id, &slot_id);
                    true
                }
                None => false,
            }
        }
    }
}

/// Whether the vault is showing without a dialog on top of it -- the guard
/// `useHotkeys` spells `editing === null && !confirmDelete && !showShortcuts
/// && !showSettings && !menu`. `Screen.Vault` is only ever reached unlocked;
/// the gate is the port's `pendingItem`/`confirmDelete` equivalent.
fn live(ui: &MainWindow, state: &Shared) -> bool {
    ui.get_screen() == Screen::Vault
        && state.borrow().engine.is_unlocked()
        && !ui.get_settings_open()
        && !ui.get_gate_open()
        && !ui.get_menu_open()
        && !ui.get_channel_ed_open()
        && !ui.get_show_shortcuts()
}

/// The first nine visible channel ids in rail order, exactly as the TS walks
/// `sidebarBase` and skips hidden channels.
fn rail_ids(ui: &MainWindow, state: &Shared) -> Vec<String> {
    let guard = state.borrow();
    let prefs = items::prefs_from(guard.engine.preferences());
    let Some(items) = guard.engine.items() else {
        return Vec::new();
    };
    items::build_sidebar(items, &ui.get_active_channel(), &prefs)
        .into_iter()
        .filter(|row| row.kind == 0 && !row.hidden)
        .map(|row| row.id.to_string())
        .take(9)
        .collect()
}

/// A single digit `1`..`9`, or nothing.
fn digit(text: &str) -> Option<u32> {
    let mut chars = text.chars();
    let first = chars.next()?;
    if chars.next().is_some() {
        return None;
    }
    match first {
        '1'..='9' => first.to_digit(10),
        _ => None,
    }
}

/// `/`: bumps the search field's own tick, which is its only way to be
/// focused from outside (a Field is a Rectangle, with no `focus()` of its
/// own to call).
fn focus_search(ui: &MainWindow) {
    ui.set_search_focus_tick(ui.get_search_focus_tick() + 1);
}

pub(crate) fn open_sheet(ui: &MainWindow) {
    ui.set_shortcut_rows(ModelRc::new(VecModel::from(rows())));
    ui.set_show_shortcuts(true);
}

fn close_sheet(ui: &MainWindow) {
    ui.set_show_shortcuts(false);
}
