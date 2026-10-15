//! The Settings window's operations (Phase 5): opening it, moving between
//! its thirteen tabs, and every preference write its dials make. The chrome
//! is `ui/screens/settings.slint` — this is the half that validates a key
//! against its whitelist, snaps a float onto the slider's own step, writes
//! through `save_prefs`, and pushes the saved values back so the widget
//! that asked sees the answer (a refused or re-rounded value included).
//!
//! One generic write path for all three types, because that is what the TS
//! has: `set(partial)` merges keys into the stored document and lets the
//! normaliser judge them (Settings.tsx, every `set({...})` call).

use crate::appearance;
use crate::items;
use crate::{save_prefs, AccentChip, HiddenRow, MainWindow, Shared};
use colax_core::VaultPreferences;
use slint::ComponentHandle;

/// The tab ids in rail order — must match `tabs` in `settings.slint`, whose
/// Ctrl+number indices, lit row and dashboard deep links ("channels",
/// "security") all resolve through this table. Unknown sections keep the
/// tab the window is on, the guard `SettingsWindow.tsx` L53 applies.
pub const SETTINGS_TABS: [&str; 13] = [
    "appearance",
    "layout",
    "hidden",
    "background",
    "channels",
    "generator",
    "security",
    "alarms",
    "data",
    "backup",
    "desktop",
    "optimize",
    "about",
];

/// The accent grid, in `ACCENT_PRESETS` order (storage.ts L44): id, label.
/// The hues behind each id come from `appearance::accent_chip`.
const ACCENTS: [(&str, &str); 4] = [
    ("slate", "Slate"),
    ("sage", "Sage"),
    ("dusk", "Dusk"),
    ("clay", "Clay"),
];

/// The six card buttons a login card can hide, as the Hidden tab names them
/// (`HIDDEN_BUTTON_LABELS`, App.tsx L290). An id that is not in the table is
/// shown as itself, exactly as `HIDDEN_BUTTON_LABELS[id] ?? id` does.
const HIDDEN_BUTTON_LABELS: [(&str, &str); 6] = [
    ("card-copy", "Copy button"),
    ("card-edit", "Edit button"),
    ("card-reveal", "Reveal button"),
    ("card-menu", "More-actions button"),
    ("card-copy-user", "Copy-username button"),
    ("card-copy-pass", "Copy-password button"),
];

/// The Hidden tab's rows, in the TS's group order (Settings.tsx L979-1103):
/// everything the Layout tab can switch off, then the three hidden lists.
/// Each row carries the heading it sits under — and the count the TS puts in
/// that heading — because Slint cannot group a model after the fact; a row
/// with an empty heading belongs to the group above it.
///
/// Two of the TS's groups are not built yet and say so by being absent: the
/// quick-launch docks (their runtime has not landed) and the channel and
/// folder names, which in the TS come from the channel catalogue — a hidden
/// id still gets its row, under the same fallback name the TS uses when its
/// own catalogue misses (`channel?.name || 'Channel'`).
pub fn hidden_rows(prefs: &VaultPreferences) -> Vec<HiddenRow> {
    // (key, id, group, label, detail) — an empty id marks a switch.
    let mut rows: Vec<(String, String, &'static str, String, String)> = Vec::new();
    let mut push = |key: &str, id: &str, group: &'static str, label: String, detail: String| {
        rows.push((key.to_string(), id.to_string(), group, label, detail));
    };

    if !prefs.show_new_login_button {
        push("showNewLoginButton", "", "Topbar", "New login button".into(), "Topbar shortcut".into());
    }
    if !prefs.show_bulk_add_button {
        push("showBulkAddButton", "", "Topbar", "Bulk add button".into(), "Topbar shortcut".into());
    }
    if !prefs.show_new_channel_button {
        push("showNewChannelButton", "", "Sidebar", "New channel button".into(), "Rail shortcut".into());
    }
    if !prefs.show_settings_button {
        push("showSettingsButton", "", "Sidebar", "Settings button".into(), "Rail footer".into());
    }
    if !prefs.show_lock_button {
        push("showLockButton", "", "Sidebar", "Lock button".into(), "Rail footer".into());
    }
    if !prefs.show_shortcuts {
        push("showShortcuts", "", "Sidebar", "Shortcuts button".into(), "Rail footer".into());
    }
    if !prefs.show_compact_button {
        push("showCompactButton", "", "Sidebar", "Compact button".into(), "Rail footer".into());
    }
    if !prefs.show_hide_sidebar_button {
        push("showHideSidebarButton", "", "Sidebar", "Hide-sidebar button".into(), "Rail footer".into());
    }
    if !prefs.show_sidebar {
        push("showSidebar", "", "Sidebar", "Sidebar".into(), "Whole channel rail".into());
    }
    for id in &prefs.hidden_channels {
        push("channel", id, "Sidebar", "Channel".into(), "Hidden from the sidebar".into());
    }
    for id in &prefs.hidden_folders {
        push("folder", id, "Sidebar", "Folder".into(), "Hidden from the sidebar".into());
    }
    for id in &prefs.hidden_buttons {
        let label = HIDDEN_BUTTON_LABELS
            .iter()
            .find(|(known, _)| known == id)
            .map(|(_, label)| (*label).to_string())
            .unwrap_or_else(|| id.clone());
        push("button", id, "Login cards", label, "Hidden on every card".into());
    }

    let mut out = Vec::with_capacity(rows.len());
    let mut start = 0;
    while start < rows.len() {
        let group = rows[start].2;
        let count = rows[start..].iter().take_while(|row| row.2 == group).count();
        for (offset, (key, id, _, label, detail)) in rows[start..start + count].iter().enumerate() {
            out.push(HiddenRow {
                heading: if offset == 0 {
                    format!("{group} ({count})").into()
                } else {
                    "".into()
                },
                label: label.as_str().into(),
                detail: detail.as_str().into(),
                key: key.as_str().into(),
                id: id.as_str().into(),
            });
        }
        start += count;
    }
    out
}

/// Mount the window. An empty section is the sidebar's footer button, which
/// in TS sends no tab at all (App.tsx L235) and so keeps the last one; a
/// known id is a dashboard deep link and jumps to it. The values are pushed
/// before the mount so the two-way chains are already true on first frame.
pub fn open(ui: &MainWindow, state: &Shared, section: &str) {
    follow_window(ui);
    if !section.is_empty() {
        if let Some(index) = SETTINGS_TABS.iter().position(|tab| *tab == section) {
            ui.set_settings_tab_index(index as i32);
        }
    }
    refresh(ui, state);
    ui.set_settings_open(true);
}

/// Unmount — Escape, the header's ✕, the overlay's own click (the TS's
/// `e.target === e.currentTarget`, which in Slint is every click the window
/// below did not swallow).
pub fn close(ui: &MainWindow) {
    ui.set_settings_open(false);
}

/// Keep the sheet in step with the window. Slint cannot work this out for
/// itself — a `min(1080px, parent.width - 60px)` inside the modal binds the
/// modal's own layout info to the window's (see settings.slint) — so it
/// arrives from here instead, the way the popover heights arrive in
/// dashboard.rs: 30px of margin a side, never wider than the design's
/// 1080px and never taller than 760, with the panel's inner width falling
/// out of the frame (248px rail, 32px padding a side).
///
/// A minimised window reports a size that is not a window (zero, on this
/// platform); that keeps the last good frame rather than shrinking the sheet
/// to its floor, because the poll would otherwise re-size it on every
/// restore. The window's own minimum is 880x560, so a real one always
/// passes the test.
pub fn follow_window(ui: &MainWindow) {
    let scale = ui.window().scale_factor();
    let size = ui.window().size();
    let width = size.width as f32 / scale;
    let height = size.height as f32 / scale;
    if width < 700.0 || height < 500.0 {
        return;
    }
    let frame_w = (width - 60.0).clamp(880.0, 1080.0);
    let frame_h = (height - 60.0).clamp(420.0, 760.0);
    ui.set_settings_w(frame_w);
    ui.set_settings_h(frame_h);
    ui.set_settings_panel_w(frame_w - 248.0 - 64.0);
}

/// A rail row or a Ctrl+number. The index arrives from Slint, so bounds are
/// checked here rather than trusted to the table above.
pub fn tab_picked(ui: &MainWindow, index: i32) {
    if index < 0 || index as usize >= SETTINGS_TABS.len() {
        return;
    }
    ui.set_settings_tab_index(index);
}

/// Read every value the window shows back off the stored prefs and push
/// them in. Called on open and after every successful write, so a snap
/// (117 -> 115) or a refusal settles on the widget that asked.
pub fn refresh(ui: &MainWindow, state: &Shared) {
    let prefs = {
        let guard = state.borrow();
        items::prefs_from(guard.engine.preferences())
    };
    ui.set_settings_ap_theme(prefs.theme.as_str().into());
    ui.set_settings_ap_accent(prefs.accent.as_str().into());
    ui.set_settings_ap_motion(prefs.motion as f32);
    ui.set_settings_ap_motion_speed(prefs.motion_speed as f32);
    ui.set_settings_ap_ambient(prefs.ambient as f32);
    ui.set_settings_ap_text_scale(prefs.text_scale as f32);
    ui.set_settings_ap_roundness(prefs.roundness as f32);
    ui.set_settings_ap_card_depth(prefs.card_depth as f32);
    ui.set_settings_ap_density(prefs.density.as_str().into());
    ui.set_settings_ap_reduce_transparency(prefs.reduce_transparency);
    ui.set_settings_ap_high_contrast(prefs.high_contrast);
    ui.set_settings_accent_chips(slint::ModelRc::new(slint::VecModel::from(
        ACCENTS
            .iter()
            .map(|(id, label)| {
                let (from, to) = appearance::accent_chip(id);
                AccentChip {
                    id: (*id).into(),
                    label: (*label).into(),
                    from,
                    to,
                }
            })
            .collect::<Vec<_>>(),
    )));
    // The Layout tab's own dials: the four pickers and the eighteen chrome
    // switches, each read back out of the stored document so a refused or
    // re-read value settles on the widget that asked.
    ui.set_settings_lay_view(prefs.view.as_str().into());
    ui.set_settings_lay_sort(prefs.sort.as_str().into());
    ui.set_settings_lay_sidebar_labels(prefs.sidebar_labels.as_str().into());
    ui.set_settings_lay_rail_position(prefs.sidebar_position.as_str().into());
    ui.set_settings_lay_letter_groups(prefs.show_letter_groups);
    ui.set_settings_lay_auto_tag_domain(prefs.auto_tag_domain);
    ui.set_settings_lay_unassigned_channel(prefs.show_unassigned_channel);
    ui.set_settings_lay_auto_tag_channel(prefs.auto_tag_channel);
    ui.set_settings_lay_orbit_labels(prefs.show_orbit_labels);
    ui.set_settings_lay_health_badges(prefs.show_health_badges);
    ui.set_settings_lay_shortcuts(prefs.show_shortcuts);
    ui.set_settings_lay_lock_button(prefs.show_lock_button);
    ui.set_settings_lay_new_channel_button(prefs.show_new_channel_button);
    ui.set_settings_lay_compact_button(prefs.show_compact_button);
    ui.set_settings_lay_new_login_button(prefs.show_new_login_button);
    ui.set_settings_lay_bulk_add_button(prefs.show_bulk_add_button);
    ui.set_settings_lay_settings_button(prefs.show_settings_button);
    ui.set_settings_lay_hide_sidebar_button(prefs.show_hide_sidebar_button);
    ui.set_settings_lay_show_sidebar(prefs.show_sidebar);
    ui.set_settings_lay_floating_chrome(prefs.floating_chrome);
    ui.set_settings_lay_hide_dividers(prefs.hide_dividers);
    // The Hidden tab is derived, not stored: the rows are rebuilt from the
    // switches above on every push, so the two tabs cannot disagree.
    ui.set_settings_hidden_rows(slint::ModelRc::new(slint::VecModel::from(hidden_rows(
        &prefs,
    ))));
}

/// One settings write, whichever dial made it. The closure owns the
/// whitelist — it mutates the pref or declines the key, and a decline
/// writes nothing, the same refusal TS gets from its normaliser for a key
/// it does not know. A successful save pushes the values back.
///
/// The shell is refreshed too: the Layout tab writes the very preferences
/// the rail and the view picker read (`showSidebar`, the rail's position and
/// labels, the view and the sort), and the TS has the same effect — a
/// `set(partial)` re-renders the whole app, not just the window that made
/// the edit.
fn write<F>(ui: &MainWindow, state: &Shared, apply: F) -> bool
where
    F: FnOnce(&mut VaultPreferences) -> bool,
{
    let mut prefs = {
        let guard = state.borrow();
        items::prefs_from(guard.engine.preferences())
    };
    if !apply(&mut prefs) {
        return false;
    }
    if !save_prefs(ui, state, &prefs) {
        ui.set_error_text("That setting could not be saved.".into());
        return false;
    }
    crate::refresh_items(ui, state);
    refresh(ui, state);
    true
}

/// A slider write: clamp to the control's own bounds and land on its step
/// — the same `min`/`max`/`step` Settings.tsx hands each `<Slider>`, so a
/// drag can never store an in-between value. The final round trip kills
/// the float dust `0.85 / 0.05` leaves behind.
fn snap(value: f64, min: f64, max: f64, step: f64) -> f64 {
    let clamped = value.clamp(min, max);
    (((clamped / step).round() * step) * 1000.0).round() / 1000.0
}

/// A string dial: theme cards, the accent grid, the density pills — and the
/// four pickers the Layout tab shares with the sidebar's own menus, which
/// validate against the same whitelists those menus do
/// (`view_picked`/`sort_picked`/`rail_picked`/`labels_picked` in main.rs).
pub fn pref_string(ui: &MainWindow, state: &Shared, key: &str, value: &str) {
    write(ui, state, |prefs| string_key(prefs, key, value));
}

/// The whitelist behind `pref_string`, split out so it can be exercised
/// without a window (the keys the panel sends are a promise the tests keep).
fn string_key(prefs: &mut VaultPreferences, key: &str, value: &str) -> bool {
    match key {
        "theme" => {
            if !matches!(value, "light" | "dark" | "system") {
                return false;
            }
            prefs.theme = value.to_string();
            true
        }
        "accent" => {
            if !ACCENTS.iter().any(|(id, _)| *id == value) {
                return false;
            }
            prefs.accent = value.to_string();
            true
        }
        "density" => {
            if !matches!(value, "compact" | "comfortable" | "spacious") {
                return false;
            }
            prefs.density = value.to_string();
            true
        }
        "view" => {
            if !matches!(value, "animated" | "carousel" | "basic" | "grid") {
                return false;
            }
            prefs.view = value.to_string();
            true
        }
        "sort" => {
            if !matches!(value, "title" | "recent" | "oldest" | "strength" | "username" | "manual") {
                return false;
            }
            prefs.sort = value.to_string();
            true
        }
        "sidebar-labels" => {
            if !matches!(value, "icon" | "name" | "both") {
                return false;
            }
            prefs.sidebar_labels = value.to_string();
            true
        }
        "sidebar-position" => {
            if !matches!(value, "left" | "right" | "top" | "bottom") {
                return false;
            }
            prefs.sidebar_position = value.to_string();
            true
        }
        _ => false,
    }
}

/// A slider drag: the bounds and steps are Settings.tsx L551-L613.
pub fn pref_float(ui: &MainWindow, state: &Shared, key: &str, value: f64) {
    write(ui, state, |prefs| match key {
        "motion" => {
            prefs.motion = snap(value, 0.0, 1.0, 0.25);
            true
        }
        "motion-speed" => {
            prefs.motion_speed = snap(value, 1.0, 2.0, 0.25);
            true
        }
        "ambient" => {
            prefs.ambient = snap(value, 0.0, 1.0, 0.25);
            true
        }
        "text-scale" => {
            prefs.text_scale = snap(value, 85.0, 130.0, 5.0);
            true
        }
        "roundness" => {
            prefs.roundness = snap(value, 0.6, 1.4, 0.1);
            true
        }
        "card-depth" => {
            prefs.card_depth = snap(value, 0.0, 1.0, 0.05);
            true
        }
        _ => false,
    });
}

/// A switch. Key names are the stored pref's camelCase, same as the TS's
/// `set({ reduceTransparency })` — so the Layout tab's eighteen chrome
/// switches and the Appearance panel's two share this one table, and the
/// Hidden tab's Show button writes through the same door (`restore`).
pub fn pref_bool(ui: &MainWindow, state: &Shared, key: &str, value: bool) {
    write(ui, state, |prefs| bool_key(prefs, key, value));
}

/// The whitelist behind `pref_bool`. Every key is a stored pref's camelCase
/// and nothing else: a near-miss (`showSidebarButton` for
/// `showHideSidebarButton`) is refused, not guessed at.
fn bool_key(prefs: &mut VaultPreferences, key: &str, value: bool) -> bool {
    let slot = match key {
        "reduceTransparency" => &mut prefs.reduce_transparency,
        "highContrast" => &mut prefs.high_contrast,
        "showLetterGroups" => &mut prefs.show_letter_groups,
        "autoTagDomain" => &mut prefs.auto_tag_domain,
        "showUnassignedChannel" => &mut prefs.show_unassigned_channel,
        "autoTagChannel" => &mut prefs.auto_tag_channel,
        "showOrbitLabels" => &mut prefs.show_orbit_labels,
        "showHealthBadges" => &mut prefs.show_health_badges,
        "showShortcuts" => &mut prefs.show_shortcuts,
        "showLockButton" => &mut prefs.show_lock_button,
        "showNewChannelButton" => &mut prefs.show_new_channel_button,
        "showCompactButton" => &mut prefs.show_compact_button,
        "showNewLoginButton" => &mut prefs.show_new_login_button,
        "showBulkAddButton" => &mut prefs.show_bulk_add_button,
        "showSettingsButton" => &mut prefs.show_settings_button,
        "showHideSidebarButton" => &mut prefs.show_hide_sidebar_button,
        "showSidebar" => &mut prefs.show_sidebar,
        "showUrls" => &mut prefs.show_urls,
        "pinFavorites" => &mut prefs.pin_favorites,
        "floatingChrome" => &mut prefs.floating_chrome,
        "hideDividers" => &mut prefs.hide_dividers,
        _ => return false,
    };
    *slot = value;
    true
}

/// The Hidden tab's per-row Show button. A switch row sends its pref key and
/// an empty id and is the same write the Layout toggle makes; a hidden-list
/// row sends the list in `key` and the id to drop — `filter(entry => entry
/// !== id)` (Settings.tsx L1092) and nothing else, because hiding never
/// touched the catalogue.
pub fn restore(ui: &MainWindow, state: &Shared, key: &str, id: &str) {
    if id.is_empty() {
        pref_bool(ui, state, key, true);
        return;
    }
    write(ui, state, |prefs| {
        let list = match key {
            "button" => &mut prefs.hidden_buttons,
            "channel" => &mut prefs.hidden_channels,
            "folder" => &mut prefs.hidden_folders,
            _ => return false,
        };
        list.retain(|entry| entry != id);
        true
    });
}

/// "Show all N": one write, every switch back on and the three lists empty
/// — the single `set({...})` at Settings.tsx L1118. The docks' `enabled`
/// flags join it when the docks runtime lands; there are none to name yet.
pub fn restore_all(ui: &MainWindow, state: &Shared) {
    write(ui, state, |prefs| {
        prefs.show_new_login_button = true;
        prefs.show_bulk_add_button = true;
        prefs.show_new_channel_button = true;
        prefs.show_settings_button = true;
        prefs.show_lock_button = true;
        prefs.show_shortcuts = true;
        prefs.show_compact_button = true;
        prefs.show_hide_sidebar_button = true;
        prefs.show_sidebar = true;
        prefs.hidden_channels.clear();
        prefs.hidden_folders.clear();
        prefs.hidden_buttons.clear();
        true
    });
}

/// The settings walk — `COLAX_DEV_SCREEN=settings`. Opens the window the
/// way the sidebar does (no tab), jumps the way Ctrl+number does, follows
/// a dashboard deep link, then drives four dials through the same handlers
/// the UI uses — one of each type, and an off-step float to prove the snap
/// (117 lands on 115). Each dump carries both the window's own values and
/// what reached the engine, so the write is checked without looking at it.
#[cfg(debug_assertions)]
pub fn dev(ui: &MainWindow, state: &Shared) {
    open(ui, state, "");
    dump(ui, state, "settings1.open");

    tab_picked(ui, 6); // Ctrl+7 -> security
    dump(ui, state, "settings2.tab");

    open(ui, state, "channels"); // the dashboard card's deep link
    dump(ui, state, "settings3.deep");

    pref_float(ui, state, "text-scale", 117.0);
    pref_string(ui, state, "theme", "dark");
    pref_string(ui, state, "accent", "clay");
    pref_bool(ui, state, "highContrast", true);
    dump(ui, state, "settings4.dials");

    // The Layout tab: a chrome switch and the three pickers the shell itself
    // reads — the rail's labels and dock, the view. Rust pushes the shell's
    // copies of these in the refresh, so the dump shows both the window's
    // dial and what the shell was told.
    tab_picked(ui, 1); // Ctrl+2 -> layout
    pref_bool(ui, state, "showNewLoginButton", false);
    pref_string(ui, state, "sidebar-labels", "icon");
    pref_string(ui, state, "sidebar-position", "right");
    pref_string(ui, state, "view", "grid");
    dump(ui, state, "settings5.layout");

    // The Hidden tab is derived: the switch just thrown off must be listed
    // there, and one press must put everything back.
    tab_picked(ui, 2); // Ctrl+3 -> hidden
    dump(ui, state, "settings6.hidden");
    restore_all(ui, state);
    dump(ui, state, "settings7.restored");

    // An unknown key and an out-of-range jump must write nothing at all.
    pref_string(ui, state, "not-a-dial", "x");
    tab_picked(ui, 99);
    dump(ui, state, "settings8.refused");

    close(ui);
    dump(ui, state, "settings9.closed");
}

/// The settings half of a dump: the mount, the lit tab and the dials *as the
/// window holds them*, plus what the walk just wrote *as the engine stored
/// it* — screen and storage on one line. The Layout tab's pickers come with
/// the shell's own copies (`rail-position`, `labels`, `view`) so a write
/// that failed to reach the shell is visible here rather than in a
/// screenshot, and the Hidden tab is its row count, since every row is a
/// derivation of the switches beside it.
#[cfg(debug_assertions)]
fn dump(ui: &MainWindow, state: &Shared, tag: &str) {
    let prefs = {
        let guard = state.borrow();
        items::prefs_from(guard.engine.preferences())
    };
    let index = ui.get_settings_tab_index();
    let tab = SETTINGS_TABS
        .get(index.max(0) as usize)
        .map(|id| *id)
        .unwrap_or("?");
    let line = format!(
        "{tag}: open={} tab={}({}) frame={}x{} panel={} theme=[{}] accent=[{}] density=[{}] motion={} speed={} ambient={} scale={} round={} depth={} reduce={} contrast={} chips={} lay=[{} {} {} {}] chrome={}{}{}{}{}{}{}{}{} hidden={} shell=[{} {} {}] persisted=[{},{},{},{}] store=[{},{},{},{},{},{}]\n",
        ui.get_settings_open(),
        index,
        tab,
        ui.get_settings_w(),
        ui.get_settings_h(),
        ui.get_settings_panel_w(),
        ui.get_settings_ap_theme(),
        ui.get_settings_ap_accent(),
        ui.get_settings_ap_density(),
        ui.get_settings_ap_motion(),
        ui.get_settings_ap_motion_speed(),
        ui.get_settings_ap_ambient(),
        ui.get_settings_ap_text_scale(),
        ui.get_settings_ap_roundness(),
        ui.get_settings_ap_card_depth(),
        ui.get_settings_ap_reduce_transparency(),
        ui.get_settings_ap_high_contrast(),
        slint::Model::row_count(&ui.get_settings_accent_chips()),
        ui.get_settings_lay_view(),
        ui.get_settings_lay_sort(),
        ui.get_settings_lay_sidebar_labels(),
        ui.get_settings_lay_rail_position(),
        ui.get_settings_lay_new_login_button() as i32,
        ui.get_settings_lay_bulk_add_button() as i32,
        ui.get_settings_lay_new_channel_button() as i32,
        ui.get_settings_lay_settings_button() as i32,
        ui.get_settings_lay_lock_button() as i32,
        ui.get_settings_lay_shortcuts() as i32,
        ui.get_settings_lay_compact_button() as i32,
        ui.get_settings_lay_hide_sidebar_button() as i32,
        ui.get_settings_lay_show_sidebar() as i32,
        slint::Model::row_count(&ui.get_settings_hidden_rows()),
        ui.get_rail_position(),
        ui.get_labels_mode(),
        ui.get_vault_view(),
        prefs.theme,
        prefs.text_scale,
        prefs.accent,
        prefs.high_contrast,
        prefs.view,
        prefs.sort,
        prefs.sidebar_labels,
        prefs.sidebar_position,
        prefs.show_new_login_button as i32,
        prefs.show_sidebar as i32,
    );
    let path = crate::app_dir().join("dev-dump.txt");
    let mut existing = std::fs::read_to_string(&path).unwrap_or_default();
    existing.push_str(&line);
    let _ = std::fs::write(path, existing);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snap_lands_on_the_step() {
        // An off-step drag arrives from the track and must store the value
        // the slider's own step describes — 117 is not a text size.
        assert_eq!(snap(117.0, 85.0, 130.0, 5.0), 115.0);
        assert_eq!(snap(0.4, 0.0, 1.0, 0.25), 0.5);
        // Clamped at both ends before the step is taken.
        assert_eq!(snap(2.4, 1.0, 2.0, 0.25), 2.0);
        assert_eq!(snap(0.55, 0.6, 1.4, 0.1), 0.6);
        // No float dust: 0.85 / 0.05 is 16.999999999999996.
        assert_eq!(snap(0.87, 0.0, 1.0, 0.05), 0.85);
    }

    #[test]
    fn snap_keeps_the_rounding_the_format_shows() {
        // The header formats these as whole percents; a stored 0.89999… would
        // print 90% and still be a different number in the document.
        assert_eq!(snap(1.004, 0.6, 1.4, 0.1), 1.0);
        assert_eq!(snap(113.0, 85.0, 130.0, 5.0), 115.0);
    }

    #[test]
    fn the_hidden_tab_is_derived_from_the_switches() {
        // The shipped defaults already hide one thing: `showShortcuts` is off
        // out of the box, so the sidebar's shortcut sheet is the one row a
        // fresh vault lists (Settings.tsx L1030 does the same with `!`).
        let mut prefs = colax_core::normalise_preferences(&serde_json::json!({}));
        let rows = hidden_rows(&prefs);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].label, "Shortcuts button");
        assert_eq!(rows[0].heading, "Sidebar (1)");
        assert_eq!(rows[0].key, "showShortcuts");
        assert!(rows[0].id.is_empty());

        // A chrome switch and the whole rail off, plus two card buttons —
        // one the label table knows and one it does not.
        prefs.show_new_login_button = false;
        prefs.show_sidebar = false;
        prefs.hidden_buttons = vec!["card-copy".into(), "mystery".into()];
        let rows = hidden_rows(&prefs);

        let labels: Vec<&str> = rows.iter().map(|row| row.label.as_str()).collect();
        assert_eq!(
            labels,
            ["New login button", "Shortcuts button", "Sidebar", "Copy button", "mystery"]
        );

        // The heading rides the first row of its group and counts that group,
        // the way `{group} ({list.length})` does (Settings.tsx L1142).
        assert_eq!(rows[0].heading, "Topbar (1)");
        assert_eq!(rows[1].heading, "Sidebar (2)");
        assert_eq!(rows[2].heading, "");
        assert_eq!(rows[3].heading, "Login cards (2)");
        assert_eq!(rows[4].heading, "");

        // A switch row carries a pref key and no id; a list row the reverse.
        assert_eq!(rows[0].key, "showNewLoginButton");
        assert!(rows[0].id.is_empty());
        assert_eq!(rows[3].key, "button");
        assert_eq!(rows[3].id, "card-copy");
    }

    #[test]
    fn the_layout_panel_keys_reach_their_fields() {
        // The panel and the handler are two files, and a typo between them
        // would be a switch that looks alive and writes nothing. Each key
        // below is one settings.slint sends, in panel order.
        let mut prefs = VaultPreferences::default();
        for key in [
            "showLetterGroups",
            "autoTagDomain",
            "showUnassignedChannel",
            "autoTagChannel",
            "showOrbitLabels",
            "showHealthBadges",
            "showShortcuts",
            "showLockButton",
            "showNewChannelButton",
            "showCompactButton",
            "showNewLoginButton",
            "showBulkAddButton",
            "showSettingsButton",
            "showHideSidebarButton",
            "showSidebar",
            "showUrls",
            "pinFavorites",
            "floatingChrome",
            "hideDividers",
        ] {
            assert!(bool_key(&mut prefs, key, false), "{key} is not a switch");
        }
        assert!(!prefs.show_new_login_button);
        assert!(bool_key(&mut prefs, "showNewLoginButton", true));
        assert!(prefs.show_new_login_button);
        // A near-miss is refused rather than guessed at: nothing else in the
        // document may move because of a key no panel sends.
        assert!(!bool_key(&mut prefs, "showSidebarButton", false));
        assert!(!bool_key(&mut prefs, "hide-dividers", false));

        // The four pickers, each with a value outside its whitelist.
        assert!(string_key(&mut prefs, "view", "grid"));
        assert_eq!(prefs.view, "grid");
        assert!(!string_key(&mut prefs, "view", "carousel3d"));
        assert_eq!(prefs.view, "grid");
        assert!(string_key(&mut prefs, "sort", "strength"));
        assert!(!string_key(&mut prefs, "sort", "random"));
        assert_eq!(prefs.sort, "strength");
        assert!(string_key(&mut prefs, "sidebar-labels", "icon"));
        assert!(!string_key(&mut prefs, "sidebar-labels", "icons"));
        assert_eq!(prefs.sidebar_labels, "icon");
        assert!(string_key(&mut prefs, "sidebar-position", "top"));
        assert!(!string_key(&mut prefs, "sidebar-position", "middle"));
        assert_eq!(prefs.sidebar_position, "top");
    }

    #[test]
    fn every_tab_id_is_in_the_rail_order() {
        // The rail in settings.slint and this table are two lists that must
        // not drift: a deep link resolves through here, an index display
        // through there.
        assert_eq!(SETTINGS_TABS.len(), 13);
        assert_eq!(
            SETTINGS_TABS,
            [
                "appearance",
                "layout",
                "hidden",
                "background",
                "channels",
                "generator",
                "security",
                "alarms",
                "data",
                "backup",
                "desktop",
                "optimize",
                "about",
            ]
        );
    }

    #[test]
    fn the_four_accent_presets_exist() {
        // storage.ts L44: the grid shows four, and `pref_string` refuses
        // anything else — including legacy stored names, which the hue
        // table still resolves for paint but no longer offers.
        assert_eq!(ACCENTS.len(), 4);
        for (id, label) in ACCENTS {
            let (from, to) = appearance::accent_chip(id);
            assert_ne!(from, to, "{id} chip gradient must move");
            assert!(!label.is_empty());
        }
    }
}
