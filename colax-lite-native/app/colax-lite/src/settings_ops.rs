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
use crate::{
    save_prefs, AccentChip, AlarmRow, DayChip, HiddenRow, MainWindow, QuestionRow, QrCell, Shared,
};
use colax_core::model::{SecurityPasscode, SecurityQuestion, TotpSecret};
use colax_core::totp::{extract_totp_secret, generate_totp_seed, otpauth_url, qr_matrix, verify_totp};
use colax_core::{
    answer_too_weak, apply_channel, estimate_strength, hash_answer, hash_passcode,
    passcode_too_weak, security_level, verify_answer, verify_passcode, Alarm, AlarmSound,
    LoginSecurity, VaultItem, VaultPreferences,
};
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
/// A hidden channel is named and counted from the catalogue and the logins
/// (`channel?.name || 'Channel'`, `${count} logins inside`) — the TS's own
/// fallback when its catalogue misses. The quick-launch bars join as a "Docks"
/// group: hiding one takes away the bar you would unhide it from, so this is
/// the only door back (Settings.tsx L1001-1010).
pub fn hidden_rows(prefs: &VaultPreferences, items: &[VaultItem]) -> Vec<HiddenRow> {
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
        let channel = prefs.channels.iter().find(|entry| entry.id == *id);
        let count = channel
            .map(|channel| apply_channel(channel, items, prefs.password_age_days as f64).len())
            .unwrap_or(0);
        push(
            "channel",
            id,
            "Sidebar",
            channel
                .map(|channel| channel.name.clone())
                .unwrap_or_else(|| "Channel".into()),
            format!("{count} login{} inside", if count == 1 { "" } else { "s" }),
        );
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
    // The quick-launch bars (Task 8.3). A hidden bar is restored from here
    // because hiding takes away the bar you would otherwise unhide it from
    // (Settings.tsx L1001-1010).
    for (index, dock) in prefs.docks.iter().enumerate() {
        if !dock.enabled {
            push(
                "dock",
                dock.id.as_str(),
                "Docks",
                if prefs.docks.len() > 1 {
                    format!("Dock {}", index + 1)
                } else {
                    "Quick-launch dock".to_string()
                },
                format!(
                    "{} slot{} on the {} edge",
                    dock.slots.len(),
                    if dock.slots.len() == 1 { "" } else { "s" },
                    crate::dock::edge_name(dock.pos.edge),
                ),
            );
        }
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
    // A fresh mount of the New alarm card holds an empty label, 08:00, no
    // days and the built-in chime (AlarmsPanel.tsx L18-22). The TS's draft
    // dies with the component when the window closes; the modal opening is
    // that mount here, so the same reset belongs here.
    reset_alarm_draft(ui, state);
    // The Security tab's two fresh-mount states: the lit sub-tab starts on
    // "locking", and the vault form's own `useState`s -- the staged key, the
    // typed code, the passcode drafts -- are empty.
    ui.set_settings_sec_group(0);
    reset_vault_draft(ui, state);
    // The three confirm sheets die with the window in the TS; here their
    // flags live on the window root, so opening resets them.
    ui.set_settings_data_protect_open(false);
    ui.set_settings_data_reset_open(false);
    ui.set_settings_data_restore_name("".into());
    state.borrow_mut().settings_restore = None;
    // The Background tab's URL field is the window's own draft, seeded once
    // per open the way `BackgroundSection`'s `useState` seeds it: only a
    // stored `http(s)` URL is shown (Settings.tsx L2265), because a data URL
    // from an upload is not text anyone typed.
    {
        let image = {
            let guard = state.borrow();
            items::prefs_from(guard.engine.preferences()).background_image
        };
        ui.set_settings_bg_url(if is_http_url(&image) { image.as_str().into() } else { "".into() });
        ui.set_settings_bg_error("".into());
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
    let (prefs, logins) = {
        let guard = state.borrow();
        let prefs = items::prefs_from(guard.engine.preferences());
        // The Hidden tab names a hidden channel and counts what is inside it,
        // so it needs the logins as well as the catalogue — and only then, so
        // the common refresh (nothing hidden) does not copy the vault.
        let logins = if prefs.hidden_channels.is_empty() {
            Vec::new()
        } else {
            guard.engine.items().map(|items| items.to_vec()).unwrap_or_default()
        };
        (prefs, logins)
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
    ui.set_settings_accent_chips(slint::ModelRc::new(slint::VecModel::from(accent_chips())));
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
        &prefs, &logins,
    ))));
    // The Desktop tab. Its third row shows `closeToTray && trayEnabled`, the
    // TS's own expression (Settings.tsx L1573) -- with the tray off the row
    // reads off and a click still stores the flag, which is what the TS does
    // and the reason the mask is computed here rather than in the panel: the
    // switch has to stay a plain two-way binding to keep following the store.
    ui.set_settings_desk_launch_at_login(prefs.launch_at_login);
    ui.set_settings_desk_tray(prefs.tray_enabled);
    ui.set_settings_desk_close_to_tray(prefs.close_to_tray && prefs.tray_enabled);
    ui.set_settings_desk_mute(prefs.sounds_muted);
    // The Generator tab, whose six dials are the editor's generator as well:
    // `refresh_generator` pushes both sets of properties and re-rolls the
    // preview the editor is showing.
    refresh_generator(ui, state);
    // The Alarms tab: the stored rows, the draft's day chips and its imported
    // sound. The card's two text fields are the panel's own and are not
    // touched here — only `reset_alarm_draft` moves those.
    push_alarms(ui, state);
    // The Security tab: five pickers, nine switches and the crypto chip. The
    // picks go back as the strings the pills compare against — `String(x)`
    // in every TS `<Select>` — so a refused write settles the widget on the
    // stored value.
    ui.set_settings_sec_auto_lock(prefs.auto_lock_minutes.to_string().as_str().into());
    ui.set_settings_sec_clipboard(prefs.clear_clipboard_seconds.to_string().as_str().into());
    ui.set_settings_sec_pw_age(prefs.password_age_days.to_string().as_str().into());
    ui.set_settings_sec_email_age(prefs.email_age_days.to_string().as_str().into());
    ui.set_settings_sec_email_check(prefs.email_check_days.to_string().as_str().into());
    ui.set_settings_sec_clear_on_lock(prefs.clear_clipboard_on_lock);
    ui.set_settings_sec_clip_capture(prefs.clipboard_capture);
    ui.set_settings_sec_clip_autosave(prefs.clipboard_auto_save);
    ui.set_settings_sec_warn_reuse(prefs.warn_on_reuse);
    ui.set_settings_sec_tag_reused(prefs.auto_tag_reused);
    ui.set_settings_sec_mask_emails(prefs.mask_emails);
    ui.set_settings_sec_confirm_export(prefs.confirm_before_export);
    ui.set_settings_sec_confirm_deletes(prefs.confirm_deletes);
    ui.set_settings_sec_copy_toasts(prefs.copy_toasts);
    // The Backup tab's one switch (native-only; see `VaultPreferences`).
    ui.set_settings_backup_with_settings(prefs.backup_with_settings);
    // `PBKDF2_ITERATIONS.toLocaleString()` (Settings.tsx L1298): the commas
    // are put in here because Slint has no number formatter.
    ui.set_settings_sec_kdf(
        format!(
            "PBKDF2-SHA256 · {} rounds",
            thousands(colax_core::crypto::PBKDF2_ITERATIONS)
        )
        .as_str()
        .into(),
    );
    push_vault_security(ui, state);
    // The Data and Backup tabs: two chips, the count that gates the CSV
    // export, and the backup row's composed hint. Cheap reads, so they ride
    // every refresh the way the other tabs' dials do.
    push_data(ui, state);
    // The Background tab's three dials and its "is there a picture" flag.
    push_background_fields(ui, state);
    // The Channels tab's rows and its tag catalogue — derived, not stored:
    // both are rebuilt from the catalogue and the logins on every push, so a
    // count can never go stale behind the panel that shows it.
    crate::channels_ops::push_manager(ui, state);
    // The Optimize tab: every reading is derived from the document, so the
    // same refresh keeps the counter, the locked rows and the profiles
    // honest.
    crate::optimize_ops::push_panel(ui, state);
    // The About tab's version stamp: built every refresh, so a rebuilt exe
    // shows its own build the moment it runs (`buildStamp` + the TS's
    // `getPlatform().name`, Settings.tsx L2082).
    ui.set_settings_about_version(
        format!("{} · {}", std::env::consts::OS, env!("CARGO_PKG_VERSION")).into(),
    );
}

/// The four accent chips the Appearance grid and the channel editor's Theme
/// row both draw, in `ACCENTS` order. Built here rather than in either
/// screen because Slint has no `hsl()` builtin and the TS gradient
/// `hsl(from 40% 56%)` has to be resolved somewhere that can do the maths.
pub fn accent_chips() -> Vec<AccentChip> {
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
        .collect()
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
pub(crate) fn write<F>(ui: &MainWindow, state: &Shared, apply: F) -> bool
where
    F: FnOnce(&mut VaultPreferences) -> bool,
{    let mut prefs = {
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
pub(crate) fn snap(value: f64, min: f64, max: f64, step: f64) -> f64 {
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
        // The Security tab's five pickers (Task 5.7). Each list is the TS's
        // own choices (Settings.tsx L72-115), membership-checked here so an
        // off-list value is refused outright rather than silently replaced
        // by the normaliser's fallback while the widget that asked believes
        // it wrote something.
        "auto-lock" => {
            if !matches!(value, "1" | "5" | "15" | "30" | "60" | "0") {
                return false;
            }
            prefs.auto_lock_minutes = value.parse().unwrap_or(5);
            true
        }
        "clear-clipboard" => {
            if !matches!(value, "0" | "15" | "30" | "60" | "120") {
                return false;
            }
            prefs.clear_clipboard_seconds = value.parse().unwrap_or(30.0);
            true
        }
        "password-age" => {
            if !matches!(value, "0" | "30" | "60" | "90" | "180" | "365" | "730") {
                return false;
            }
            prefs.password_age_days = value.parse().unwrap_or(180);
            true
        }
        "email-age" => {
            if !matches!(value, "0" | "90" | "180" | "365" | "730") {
                return false;
            }
            prefs.email_age_days = value.parse().unwrap_or(365);
            true
        }
        "email-check" => {
            if !matches!(value, "0" | "30" | "60" | "90" | "180" | "365") {
                return false;
            }
            prefs.email_check_days = value.parse().unwrap_or(90);
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
        // The generator's length (Settings.tsx L1206-1218). Its five
        // neighbours are switches and go through `bool_key`; the two doors
        // meet in the same object.
        "gen-length" => {
            prefs.password_generator.length = snap(value, 8.0, 64.0, 1.0) as u32;
            true
        }
        // The Background tab's three dials (Settings.tsx L2330-2359):
        // opacity is a share of the photo, blur a pixel radius, dim a share
        // of the wash. Their bounds are `normaliseBackgroundLook`'s own.
        "bg-opacity" => {
            prefs.background_opacity = snap(value, 0.0, 1.0, 0.05);
            true
        }
        "bg-blur" => {
            prefs.background_blur = snap(value, 0.0, 40.0, 2.0);
            true
        }
        "bg-dim" => {
            prefs.background_dim = snap(value, 0.0, 0.9, 0.05);
            true
        }
        _ => false,
    });
}

/// A switch. Key names are the stored pref's camelCase, same as the TS's
/// `set({ reduceTransparency })` — so the Layout tab's eighteen chrome
/// switches, the Appearance panel's two and the Desktop tab's four share
/// this one table, and the Hidden tab's Show button writes through the same
/// door (`restore`).
///
/// The return value says whether the key was known: the Desktop tab's four
/// are also read out of `shell.json` by the tray, and main.rs mirrors a write
/// to them only when one really happened.
pub fn pref_bool(ui: &MainWindow, state: &Shared, key: &str, value: bool) -> bool {
    write(ui, state, |prefs| bool_key(prefs, key, value))
}

/// The four switches the desktop shell reads before a vault is unlocked — the
/// tray, the window's close button, the Run key and the mute flag. They are
/// stored twice, in the vault's preferences and in `shell.json`, and only
/// these four need the second write.
pub fn is_shell_flag(key: &str) -> bool {
    matches!(
        key,
        "launchAtLogin" | "trayEnabled" | "closeToTray" | "soundsMuted"
    )
}

/// The whitelist behind `pref_bool`. Every key is a stored pref's camelCase
/// and nothing else: a near-miss (`showSidebarButton` for
/// `showHideSidebarButton`) is refused, not guessed at. The five `gen-` keys
/// are the exception in spelling, not in spirit: the document has no flat key
/// for a field of `passwordGenerator`, so they are named the way the panel
/// names them and land inside the object (`gen_set`).
fn bool_key(prefs: &mut VaultPreferences, key: &str, value: bool) -> bool {
    if gen_set(prefs, key, value) {
        return true;
    }
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
        // The Desktop tab (Settings.tsx L1551-1585). These four are the shell
        // flags; `bool_key` stays their single whitelist even though the write
        // path around it is the mirroring one.
        "launchAtLogin" => &mut prefs.launch_at_login,
        "trayEnabled" => &mut prefs.tray_enabled,
        "closeToTray" => &mut prefs.close_to_tray,
        "soundsMuted" => &mut prefs.sounds_muted,
        // The Security tab's switches (Settings.tsx L1321-1432).
        "clearClipboardOnLock" => &mut prefs.clear_clipboard_on_lock,
        "clipboardCapture" => &mut prefs.clipboard_capture,
        "clipboardAutoSave" => &mut prefs.clipboard_auto_save,
        "warnOnReuse" => &mut prefs.warn_on_reuse,
        "autoTagReused" => &mut prefs.auto_tag_reused,
        "maskEmails" => &mut prefs.mask_emails,
        "confirmBeforeExport" => &mut prefs.confirm_before_export,
        // Native-only, so it is the one key here with no TS counterpart: the
        // Backup tab's "Include settings and layout" switch.
        "backupWithSettings" => &mut prefs.backup_with_settings,
        "confirmDeletes" => &mut prefs.confirm_deletes,
        "copyToasts" => &mut prefs.copy_toasts,
        // The Optimize tab's three plain switches (Settings.tsx L1852,
        // L1875, L1984); "reduceTransparency" is already above.
        "microMotion" => &mut prefs.micro_motion,
        "mailInlineImages" => &mut prefs.mail_inline_images,
        "disableSpellcheck" => &mut prefs.disable_spellcheck,
        _ => return false,
    };
    *slot = value;
    true
}

/// One of the generator's five switches, written into the object it belongs
/// to. `false` means the key was not one of them, which is how `bool_key`
/// tells a generator switch from a flat pref it does not know at all.
///
/// The write runs the object through its own normaliser before it is stored,
/// so the rule the panel's hint states ("At least one must stay on") holds
/// between loads and not only until the next one: a write that turns the last
/// set off is answered with the shipped defaults immediately, which is what
/// storage.ts does when it puts `DEFAULT_PREFERENCES.passwordGenerator` back
/// (L1449-1451).
fn gen_set(prefs: &mut VaultPreferences, key: &str, value: bool) -> bool {
    let gen = &mut prefs.password_generator;
    match key {
        "gen-lower" => gen.lower = value,
        "gen-upper" => gen.upper = value,
        "gen-digits" => gen.digits = value,
        "gen-symbols" => gen.symbols = value,
        "gen-avoid" => gen.avoid_ambiguous = value,
        _ => return false,
    }
    let raw = serde_json::to_value(*gen).unwrap_or(serde_json::Value::Null);
    prefs.password_generator = colax_core::normalise_generator(Some(&raw));
    true
}

/// The editor's generator is the other door to the same six fields: a chip or
/// the length slider there writes the preference itself, exactly as
/// `onOptionsChange` does in the TS (ItemEditor.tsx L171, App.tsx L3575),
/// rather than keeping a session copy that would disagree with Settings the
/// moment either was touched.
pub fn gen_options(ui: &MainWindow, state: &Shared) {
    let mut next = {
        let guard = state.borrow();
        items::prefs_from(guard.engine.preferences()).password_generator
    };
    next.length = snap(ui.get_gen_length() as f64, 8.0, 64.0, 1.0) as u32;
    next.lower = ui.get_gen_lower();
    next.upper = ui.get_gen_upper();
    next.digits = ui.get_gen_digits();
    next.symbols = ui.get_gen_symbols();
    next.avoid_ambiguous = ui.get_gen_avoid();
    write(ui, state, |prefs| {
        prefs.password_generator = next;
        true
    });
}

/// Pushes the stored generator into the window: the Settings panel's six
/// dials and the editor's generator read the same fields, so both are written
/// on every refresh. The preview is re-rolled afterwards for the same reason
/// the TS's `useEffect([options, mode, words])` re-runs -- the options are the
/// object it generates from, and they have just moved.
pub fn refresh_generator(ui: &MainWindow, state: &Shared) {
    let gen = {
        let guard = state.borrow();
        items::prefs_from(guard.engine.preferences()).password_generator
    };
    ui.set_settings_gen_length(gen.length as f32);
    // The panel's own read-out: `{gen.length}` and nothing else
    // (Settings.tsx L1214), the same bare number the editor shows.
    ui.set_settings_gen_length_label(format!("{}", gen.length).as_str().into());
    ui.set_settings_gen_lower(gen.lower);
    ui.set_settings_gen_upper(gen.upper);
    ui.set_settings_gen_digits(gen.digits);
    ui.set_settings_gen_symbols(gen.symbols);
    ui.set_settings_gen_avoid(gen.avoid_ambiguous);
    ui.set_gen_length(gen.length as f32);
    ui.set_gen_lower(gen.lower);
    ui.set_gen_upper(gen.upper);
    ui.set_gen_digits(gen.digits);
    ui.set_gen_symbols(gen.symbols);
    ui.set_gen_avoid(gen.avoid_ambiguous);
    crate::regenerate(ui);
}

/// The Alarms tab's day names, `Date.getDay()` order (`DAY_LABELS`,
/// AlarmsPanel.tsx L6).
const DAY_LABELS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/// The hour the New alarm card opens on (`useState('08:00')`, L19).
const ALARM_DEFAULT_TIME: &str = "08:00";

/// The ceiling the TS puts on an imported sound: over 400_000 characters of
/// data URL it is refused before it is ever stored (AlarmsPanel.tsx L33-36).
const SOUND_URL_LIMIT: usize = 400_000;

/// A row's middle cell: `alarm.label || 'No label'` (AlarmsPanel.tsx L70).
fn alarm_row_label(label: &str) -> String {
    if label.is_empty() {
        "No label".to_string()
    } else {
        label.to_string()
    }
}

/// A row's last cell: `days.length === 0 ? 'Every day' :
/// days.map((day) => DAY_LABELS[day]).join(', ')` (L71-73). The draft's own
/// click order is kept — `[...days, day]` appends — so a Sunday picked late
/// reads after the Wednesday picked first.
fn alarm_days_label(days: &[u8]) -> String {
    if days.is_empty() {
        return "Every day".to_string();
    }
    days.iter()
        .filter_map(|day| DAY_LABELS.get(*day as usize))
        .copied()
        .collect::<Vec<_>>()
        .join(", ")
}

/// The seven chips of the New alarm card, lit where the draft has picked
/// them (L122-134).
fn day_chips(days: &[u8]) -> Vec<DayChip> {
    DAY_LABELS
        .iter()
        .enumerate()
        .map(|(index, label)| DayChip {
            label: (*label).into(),
            on: days.contains(&(index as u8)),
        })
        .collect()
}

/// Pushes the Alarms tab's three halves: the stored rows in the TS's own
/// reading of them, the draft's day chips, and the draft's sound as the name
/// the chip shows ("" while the built-in chime is chosen). Called from
/// `refresh`, so a write made anywhere shows up here.
fn push_alarms(ui: &MainWindow, state: &Shared) {
    let (rows, chips, sound) = {
        let guard = state.borrow();
        let prefs = items::prefs_from(guard.engine.preferences());
        let rows: Vec<AlarmRow> = prefs
            .alarms
            .iter()
            .map(|alarm| AlarmRow {
                id: alarm.id.as_str().into(),
                time: alarm.time.as_str().into(),
                label: alarm_row_label(&alarm.label).into(),
                days: alarm_days_label(&alarm.days).into(),
                enabled: alarm.enabled,
            })
            .collect();
        let sound = guard
            .alarm_sound
            .as_ref()
            .map(|sound| sound.name.clone())
            .unwrap_or_default();
        (rows, day_chips(&guard.alarm_days), sound)
    };
    ui.set_settings_alarm_rows(slint::ModelRc::new(slint::VecModel::from(rows)));
    ui.set_settings_alarm_day_chips(slint::ModelRc::new(slint::VecModel::from(chips)));
    ui.set_settings_alarm_sound(sound.as_str().into());
}

/// The New alarm card back to its opening state — empty label, 08:00, no
/// days, the built-in chime. What a fresh mount of `AlarmsPanel` holds
/// (L18-22); the push a refresh or a write does next is what paints the
/// cleared chips.
fn reset_alarm_draft(ui: &MainWindow, state: &Shared) {
    {
        let mut guard = state.borrow_mut();
        guard.alarm_days.clear();
        guard.alarm_sound = None;
    }
    ui.set_settings_alarm_label("".into());
    ui.set_settings_alarm_time(ALARM_DEFAULT_TIME.into());
}

/// "Add alarm" (AlarmsPanel.tsx L44-58): the draft becomes a stored alarm
/// and the card starts over. The label and the time are read off the panel's
/// own fields; the days and the sound are this module's, because both arrive
/// in the panel as data rather than as editable text.
pub fn alarms_add(ui: &MainWindow, state: &Shared) {
    let (days, sound) = {
        let guard = state.borrow();
        (guard.alarm_days.clone(), guard.alarm_sound.clone())
    };
    let alarm = Alarm {
        id: colax_core::new_alarm_id(),
        label: ui.get_settings_alarm_label().trim().to_string(),
        time: ui.get_settings_alarm_time().to_string(),
        days,
        sound,
        enabled: true,
    };
    // The draft is dropped first so the write's own refresh pushes the empty
    // chips and the chime label, not a copy of the alarm just stored.
    reset_alarm_draft(ui, state);
    if write(ui, state, |prefs| {
        prefs.alarms.push(alarm);
        true
    }) {
        crate::notice(ui, "Alarm added");
    }
}

/// One of the seven day chips: a picked day comes off, an unpicked one lands
/// at the end — `on ? days.filter((day) => day !== index) : [...days, index]`
/// (AlarmsPanel.tsx L129).
pub fn alarm_day_toggled(ui: &MainWindow, state: &Shared, index: i32) {
    if !(0..7).contains(&index) {
        return;
    }
    {
        let mut guard = state.borrow_mut();
        let day = index as u8;
        match guard.alarm_days.iter().position(|picked| *picked == day) {
            Some(at) => {
                guard.alarm_days.remove(at);
            }
            None => guard.alarm_days.push(day),
        }
    }
    push_alarms(ui, state);
}

/// A row's Test button: `playAlarmSound(alarm)` (L77) — the stored sound as
/// it is, mute or not, because hearing it is what the button is for.
pub fn alarm_test(state: &Shared, id: &str) {
    let alarm = {
        let guard = state.borrow();
        items::prefs_from(guard.engine.preferences())
            .alarms
            .into_iter()
            .find(|alarm| alarm.id == id)
    };
    if let Some(alarm) = alarm {
        crate::alarms::play(&alarm);
    }
}

/// A row's dot: `{ ...entry, enabled: !entry.enabled }` (L86).
pub fn alarm_toggle(ui: &MainWindow, state: &Shared, id: &str) {
    write(ui, state, |prefs| {
        let Some(alarm) = prefs.alarms.iter_mut().find(|alarm| alarm.id == id) else {
            return false;
        };
        alarm.enabled = !alarm.enabled;
        true
    });
}

/// A row's delete: `alarms.filter((entry) => entry.id !== id)` (L94).
pub fn alarm_delete(ui: &MainWindow, state: &Shared, id: &str) {
    write(ui, state, |prefs| {
        let before = prefs.alarms.len();
        prefs.alarms.retain(|alarm| alarm.id != id);
        prefs.alarms.len() != before
    });
}

/// "Import sound" (AlarmsPanel.tsx L24-41): the device's own picker —
/// `accept="audio/*"` — the bytes base64'd behind the mime its extension
/// suggests, and the length ceiling tested before anything is stored. The
/// name is the file's own, which is what the chip beside the button shows.
pub fn alarm_import(ui: &MainWindow, state: &Shared) {
    let Some(path) = crate::platform::pick_sound_file(crate::find_main_window()) else {
        return;
    };
    let Ok(bytes) = std::fs::read(&path) else {
        ui.set_error_text("Could not read that file.".into());
        return;
    };
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| path.display().to_string());
    use base64::Engine as _;
    let data_url = format!(
        "data:{};base64,{}",
        sound_mime(&path),
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    );
    if data_url.len() > SOUND_URL_LIMIT {
        ui.set_error_text("That sound file is too large; keep it under ~300 KB.".into());
        return;
    }
    state.borrow_mut().alarm_sound = Some(AlarmSound {
        name: name.clone(),
        data_url: Some(data_url),
    });
    push_alarms(ui, state);
    crate::notice(ui, &format!("Sound \"{name}\" imported"));
}

/// "Reset to chime" (L146): the draft drops the imported sound. Nothing
/// stored moves — only the alarm made next carries it.
pub fn alarm_reset_sound(ui: &MainWindow, state: &Shared) {
    state.borrow_mut().alarm_sound = None;
    push_alarms(ui, state);
}

/// The mime a browser would write into the data URL for this file, guessed
/// from the extension the way `FileReader` guesses it; anything else is
/// `application/octet-stream`. The decoder sniffs the bytes either way, so
/// this only decides what the stored string says.
fn sound_mime(path: &std::path::Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("wav") => "audio/wav",
        Some("mp3") => "audio/mpeg",
        Some("ogg") => "audio/ogg",
        Some("flac") => "audio/flac",
        Some("m4a") => "audio/mp4",
        _ => "application/octet-stream",
    }
}

/* ==========================================================================
The Security tab -- the vault's own second factor
========================================================================== */

/// The vault form back to its opening state. Its `useState`s are the ones a
/// fresh `SecurityForm` mount holds in TS: nothing staged, no typed code, no
/// passcode drafts. The panel's own view (which tile is open) is Slint state
/// and dies with the `Settings` instance; this covers the half that lives on
/// the window root and would otherwise outlive the modal.
fn reset_vault_draft(ui: &MainWindow, state: &Shared) {
    {
        let mut guard = state.borrow_mut();
        guard.vault_staged_seed = None;
        guard.vault_prompt_index = 0;
    }
    ui.set_settings_vsec_totp_seed("".into());
    ui.set_settings_vsec_totp_code("".into());
    ui.set_settings_vsec_totp_note("".into());
    ui.set_settings_vsec_passcode_new("".into());
    ui.set_settings_vsec_passcode_confirm("".into());
    ui.set_settings_vsec_passcode_input("".into());
    ui.set_settings_vsec_passcode_error("".into());
    ui.set_settings_vsec_answer_error("".into());
    ui.set_settings_vsec_checking_id("".into());
    ui.set_settings_vsec_check_input("".into());
    ui.set_settings_vsec_new_answer("".into());
}

/// Pushes the vault's second factor into the Settings window: the same
/// read-out `push_security` gives the editor — level, the two flags, the
/// staged key, the prompts, the QR — read from `prefs.vaultSecurity` rather
/// than a draft, because there is no draft here.
pub fn push_vault_security(ui: &MainWindow, state: &Shared) {
    let (sec, staged, prompt_index) = {
        let guard = state.borrow();
        (
            items::prefs_from(guard.engine.preferences()).vault_security,
            guard.vault_staged_seed.clone(),
            guard.vault_prompt_index,
        )
    };

    ui.set_settings_vsec_level(security_level(&sec).into());
    ui.set_settings_vsec_totp(sec.totp.is_some());
    ui.set_settings_vsec_passcode(sec.passcode.is_some());
    // Staged stays its own flag: a key no phone has confirmed must not read
    // as a set factor, exactly as in the editor.
    ui.set_settings_vsec_totp_staged(staged.is_some());

    let note = match sec.questions.len() {
        0 => "Not set".to_string(),
        1 => "1 question".to_string(),
        n => format!("{n} questions"),
    };
    ui.set_settings_vsec_questions_note(note.as_str().into());

    let rows: Vec<QuestionRow> = sec
        .questions
        .iter()
        .map(|q| QuestionRow {
            id: q.id.clone().into(),
            prompt: q.prompt.clone().into(),
        })
        .collect();
    ui.set_settings_vsec_questions(slint::ModelRc::new(slint::VecModel::from(rows)));

    let prompt = crate::QUESTION_PROMPTS
        .get(prompt_index)
        .copied()
        .unwrap_or(crate::QUESTION_PROMPTS[0]);
    ui.set_settings_vsec_new_prompt(prompt.into());

    push_vault_qr(ui, &sec, staged.as_deref());
}

/// The QR half of the vault's push. Same walk as `push_security_qr`, but the
/// `otpauth://` label is the form's own `label="Colax Vault"`
/// (Settings.tsx L1280) — there is no login title to carry here.
fn push_vault_qr(ui: &MainWindow, sec: &LoginSecurity, staged: Option<&str>) {
    let seed = staged.or_else(|| sec.totp.as_ref().map(|totp| totp.seed.as_str()));
    let Some(seed) = seed else {
        ui.set_settings_vsec_qr_size(0);
        ui.set_settings_vsec_qr_cells(slint::ModelRc::new(slint::VecModel::from(Vec::<QrCell>::new())));
        ui.set_settings_vsec_otpauth("".into());
        return;
    };

    let url = otpauth_url("Colax Vault", seed);
    let symbol = qr_matrix(&url).map(|(side, bits)| {
        let cells: Vec<QrCell> = bits
            .iter()
            .enumerate()
            .filter(|(_, dark)| **dark)
            .map(|(i, _)| QrCell {
                col: (i % side) as i32,
                row: (i / side) as i32,
            })
            .collect();
        (side as i32, cells)
    });

    match symbol {
        Some((side, cells)) => {
            ui.set_settings_vsec_qr_size(side);
            ui.set_settings_vsec_qr_cells(slint::ModelRc::new(slint::VecModel::from(cells)));
            ui.set_settings_vsec_otpauth(url.as_str().into());
        }
        None => {
            // No symbol can hold this URI: "no QR", key still usable, the
            // same answer the editor's push gives.
            ui.set_settings_vsec_qr_size(0);
            ui.set_settings_vsec_qr_cells(slint::ModelRc::new(slint::VecModel::from(Vec::<QrCell>::new())));
            ui.set_settings_vsec_otpauth(url.as_str().into());
        }
    }
}

/// One proven change to the vault's factor. The TS's `set({ vaultSecurity })`
/// (Settings.tsx L1278) writes the whole document at once — there is no draft
/// and no Save — so every op below that really changes something funnels
/// through this door and lets `write` repaint the panel from the store.
fn vault_write<F>(ui: &MainWindow, state: &Shared, apply: F) -> bool
where
    F: FnOnce(&mut LoginSecurity) -> bool,
{
    write(ui, state, |prefs| apply(&mut prefs.vault_security))
}

/// These twelve ops are the editor's twelve again, over the stored record:
/// the same staging, the same refusals in the same order, the same notices.
/// The only guard that changes is the first line — the Settings window
/// answers only while it is open, where the editor's ops asked for the
/// editor screen.
pub fn vsec_totp_attach(ui: &MainWindow, state: &Shared) {
    if !ui.get_settings_open() {
        return;
    }
    let input = ui.get_settings_vsec_totp_seed().to_string();
    let Some(seed) = extract_totp_secret(&input) else {
        ui.set_settings_vsec_totp_note("That does not look like an authenticator key".into());
        return;
    };
    ui.set_settings_vsec_totp_seed("".into());
    ui.set_settings_vsec_totp_code("".into());
    ui.set_settings_vsec_totp_note("".into());
    state.borrow_mut().vault_staged_seed = Some(seed);
    push_vault_security(ui, state);
    crate::notice(ui, "Scan the code, then confirm one to keep the key");
}

/// Mint a fresh key and stage it, from a seed the app generated rather than
/// one the user pasted.
pub fn vsec_totp_generate(ui: &MainWindow, state: &Shared) {
    if !ui.get_settings_open() {
        return;
    }
    let seed = generate_totp_seed();
    ui.set_settings_vsec_totp_code("".into());
    ui.set_settings_vsec_totp_note("".into());
    state.borrow_mut().vault_staged_seed = Some(seed);
    push_vault_security(ui, state);
    crate::notice(ui, "Scan the code, then confirm one to keep the key");
}

/// Check the typed code against whichever key is live: the staged one while
/// confirming, otherwise the saved one.
pub fn vsec_totp_check(ui: &MainWindow, state: &Shared) {
    if !ui.get_settings_open() {
        return;
    }
    let code = ui.get_settings_vsec_totp_code().to_string();
    let (staged, saved) = {
        let guard = state.borrow();
        (
            guard.vault_staged_seed.clone(),
            items::prefs_from(guard.engine.preferences())
                .vault_security
                .totp
                .as_ref()
                .map(|totp| totp.seed.clone()),
        )
    };
    let Some(seed) = staged.clone().or(saved) else {
        return;
    };
    if code.chars().filter(char::is_ascii_digit).count() != 6 {
        ui.set_settings_vsec_totp_note("A code is six digits.".into());
        return;
    }
    if !verify_totp(&seed, &code) {
        ui.set_settings_vsec_totp_note(
            "That code did not match. Check the clock on this device.".into(),
        );
        return;
    }
    ui.set_settings_vsec_totp_note("".into());
    if staged.is_some() {
        // The first successful confirmation is the write. Until this runs,
        // nothing about the vault has changed.
        state.borrow_mut().vault_staged_seed = None;
        vault_write(ui, state, |sec| {
            sec.totp = Some(TotpSecret { seed });
            true
        });
        crate::notice(ui, "Authenticator key saved");
    } else {
        crate::notice(ui, "Authenticator confirmed");
    }
}

/// Drop a staged key without touching the record: walking away leaves no
/// trace.
pub fn vsec_totp_discard(ui: &MainWindow, state: &Shared) {
    if !ui.get_settings_open() {
        return;
    }
    state.borrow_mut().vault_staged_seed = None;
    ui.set_settings_vsec_totp_code("".into());
    ui.set_settings_vsec_totp_note("".into());
    push_vault_security(ui, state);
}

/// Remove the saved key.
pub fn vsec_totp_remove(ui: &MainWindow, state: &Shared) {
    if !ui.get_settings_open() {
        return;
    }
    state.borrow_mut().vault_staged_seed = None;
    ui.set_settings_vsec_totp_code("".into());
    ui.set_settings_vsec_totp_note("".into());
    vault_write(ui, state, |sec| {
        sec.totp = None;
        true
    });
    crate::notice(ui, "Authenticator removed");
}

/// Set the vault's extra passcode. The three refusals in the TS order, so
/// the first message names the user's mistake rather than the last rule the
/// string broke.
pub fn vsec_passcode_save(ui: &MainWindow, state: &Shared) {
    if !ui.get_settings_open() {
        return;
    }
    let new = ui.get_settings_vsec_passcode_new().to_string();
    let confirm = ui.get_settings_vsec_passcode_confirm().to_string();
    if passcode_too_weak(&new, false) {
        ui.set_settings_vsec_passcode_error(
            "Use at least 8 characters, and mix letters, numbers or symbols. Not \"password\"."
                .into(),
        );
        return;
    }
    if new != confirm {
        ui.set_settings_vsec_passcode_error("Those two do not match.".into());
        return;
    }
    // The gate must not become the credential: a short passcode beside an
    // authenticator would be the weakest factor guarding the vault.
    let totp_set = {
        let guard = state.borrow();
        items::prefs_from(guard.engine.preferences())
            .vault_security
            .totp
            .is_some()
    };
    if totp_set && new.chars().count() < 12 {
        ui.set_settings_vsec_passcode_error(
            "With an authenticator already set, use at least 12 characters.".into(),
        );
        return;
    }
    let (hash, salt) = hash_passcode(&new);
    ui.set_settings_vsec_passcode_new("".into());
    ui.set_settings_vsec_passcode_confirm("".into());
    ui.set_settings_vsec_passcode_error("".into());
    ui.set_settings_vsec_passcode_input("".into());
    vault_write(ui, state, |sec| {
        sec.passcode = Some(SecurityPasscode { hash, salt });
        true
    });
    crate::notice(ui, "Passcode saved");
}

/// Prove the typed passcode against the stored hash.
pub fn vsec_passcode_check(ui: &MainWindow, state: &Shared) {
    if !ui.get_settings_open() {
        return;
    }
    let input = ui.get_settings_vsec_passcode_input().to_string();
    let stored = {
        let guard = state.borrow();
        items::prefs_from(guard.engine.preferences())
            .vault_security
            .passcode
            .as_ref()
            .map(|passcode| (passcode.hash.clone(), passcode.salt.clone()))
    };
    let Some((hash, salt)) = stored else {
        return;
    };
    if verify_passcode(&input, &hash, &salt) {
        ui.set_settings_vsec_passcode_input("".into());
        ui.set_settings_vsec_passcode_error("".into());
        crate::notice(ui, "Passcode confirmed");
    } else {
        ui.set_settings_vsec_passcode_error("That does not match the stored passcode.".into());
    }
}

/// Drop the extra passcode.
pub fn vsec_passcode_remove(ui: &MainWindow, state: &Shared) {
    if !ui.get_settings_open() {
        return;
    }
    ui.set_settings_vsec_passcode_input("".into());
    ui.set_settings_vsec_passcode_error("".into());
    vault_write(ui, state, |sec| {
        sec.passcode = None;
        true
    });
    crate::notice(ui, "Passcode removed");
}

/// Add a recovery question. Only the prompt reaches the screen; the hash and
/// salt are built here and stay here.
pub fn vsec_question_add(ui: &MainWindow, state: &Shared) {
    if !ui.get_settings_open() {
        return;
    }
    let prompt = ui.get_settings_vsec_new_prompt().to_string();
    let answer = ui.get_settings_vsec_new_answer().to_string();
    if prompt.trim().is_empty() {
        return;
    }
    if answer_too_weak(&answer) {
        ui.set_settings_vsec_answer_error(
            "Use something a stranger could not guess, not a single word or \"yes\".".into(),
        );
        return;
    }
    let (hash, salt) = hash_answer(&answer);
    let id = format!("sq_{}", &colax_core::new_item_id().replace('-', "")[..8]);
    ui.set_settings_vsec_new_answer("".into());
    ui.set_settings_vsec_answer_error("".into());
    vault_write(ui, state, |sec| {
        sec.questions.push(SecurityQuestion {
            id,
            prompt: prompt.trim().to_string(),
            hash,
            salt,
        });
        true
    });
    crate::notice(ui, "Recovery question added");
}

/// Two-stage, exactly as `checkQuestion` in TS: the first press for an id
/// opens its answer box, the second verifies what is typed in it.
pub fn vsec_question_check(ui: &MainWindow, state: &Shared, id: &str) {
    if !ui.get_settings_open() {
        return;
    }
    if ui.get_settings_vsec_checking_id().to_string() != id {
        ui.set_settings_vsec_checking_id(id.into());
        ui.set_settings_vsec_check_input("".into());
        ui.set_settings_vsec_answer_error("".into());
        return;
    }
    let answer = ui.get_settings_vsec_check_input().to_string();
    let stored = {
        let guard = state.borrow();
        items::prefs_from(guard.engine.preferences())
            .vault_security
            .questions
            .iter()
            .find(|question| question.id == id)
            .map(|question| (question.hash.clone(), question.salt.clone()))
    };
    let Some((hash, salt)) = stored else {
        // Removed while its box was open: the row is gone, so the box is too.
        ui.set_settings_vsec_checking_id("".into());
        ui.set_settings_vsec_check_input("".into());
        return;
    };
    if verify_answer(&answer, &hash, &salt) {
        ui.set_settings_vsec_checking_id("".into());
        ui.set_settings_vsec_check_input("".into());
        ui.set_settings_vsec_answer_error("".into());
        crate::notice(ui, "Answer confirmed");
    } else {
        ui.set_settings_vsec_answer_error("That does not match the stored answer.".into());
    }
}

/// Remove a question, and close its box if that is the one that was open.
pub fn vsec_question_remove(ui: &MainWindow, state: &Shared, id: &str) {
    if !ui.get_settings_open() {
        return;
    }
    if ui.get_settings_vsec_checking_id().to_string() == id {
        ui.set_settings_vsec_checking_id("".into());
        ui.set_settings_vsec_check_input("".into());
    }
    vault_write(ui, state, |sec| {
        sec.questions.retain(|question| question.id != id);
        true
    });
}

/// Step the prompt the add row offers. The list is fixed, so it wraps.
pub fn vsec_prompt_step(ui: &MainWindow, state: &Shared, delta: i32) {
    if !ui.get_settings_open() {
        return;
    }
    let len = crate::QUESTION_PROMPTS.len() as i32;
    let index = {
        let mut guard = state.borrow_mut();
        guard.vault_prompt_index =
            (guard.vault_prompt_index as i32 + delta).rem_euclid(len) as usize;
        guard.vault_prompt_index
    };
    ui.set_settings_vsec_new_prompt(crate::QUESTION_PROMPTS[index].into());
}

/// The Security panel's "Lock now": seal the vault, then close the sheet —
/// `onLock(); onClose()` in the TS (Settings.tsx L1286-1289). Locking drops
/// the key and presents the unlock screen under the closing modal.
pub fn security_lock(ui: &MainWindow, state: &Shared) {
    if !ui.get_settings_open() {
        return;
    }
    crate::lock_vault(ui, state);
    close(ui);
}

/// `600000.toLocaleString()`: the en-US commas the TS's own
/// `PBKDF2_ITERATIONS.toLocaleString()` prints.
fn thousands(n: u32) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

/// The id of the nth stored vault question, read straight off the document:
/// the walk needs it because `new_item_id` is random and the row model it
/// clicks is never on screen in a dump run.
#[cfg(debug_assertions)]
pub fn stored_vault_question_id(state: &Shared, index: usize) -> String {
    let guard = state.borrow();
    items::prefs_from(guard.engine.preferences())
        .vault_security
        .questions
        .get(index)
        .map(|question| question.id.clone())
        .unwrap_or_default()
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
        if key == "dock" {
            if let Some(dock) = prefs.docks.iter_mut().find(|dock| dock.id == id) {
                dock.enabled = true;
                return true;
            }
            return false;
        }
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
/// — the single `set({...})` at Settings.tsx L1118 — plus every dock's
/// `enabled` flag, which the TS turns on in the same object.
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
        for dock in prefs.docks.iter_mut() {
            dock.enabled = true;
        }
        true
    });
}

/* ---- Data and Backup (Task 5.8) ---------------------------------------- */

/// The Data tab's chips and the Backup row's hint, pushed from the facts:
/// the stored count and the vault file's real size for the first chip, the
/// build stamp for the second, and "Downloads N login(s) as ciphertext."
/// plus the conditional password sentence for the row (Settings.tsx
/// L1460-1471, L1506).
pub fn push_data(ui: &MainWindow, state: &Shared) {
    let (count, bytes, has_password) = data_facts(state);
    let kb = bytes.div_ceil(1024).max(1);
    ui.set_settings_data_stored(format!("{count} · about {kb} KB").as_str().into());
    ui.set_settings_data_count(count as i32);
    ui.set_settings_data_version(build_stamp().as_str().into());
    let noun = if count == 1 { "login" } else { "logins" };
    let warning = if has_password {
        ""
    } else {
        " Without a vault password, anyone with the file can read it once restored."
    };
    ui.set_settings_backup_hint(
        format!("Downloads {count} {noun} as ciphertext.{warning}")
            .as_str()
            .into(),
    );
}

/// The numbers behind the Data and Backup tabs: how many logins are stored,
/// the vault file's size on disk, and whether a vault password exists at all
/// (the Backup hint's conditional sentence).
fn data_facts(state: &Shared) -> (usize, u64, bool) {
    let guard = state.borrow();
    let count = guard
        .engine
        .items()
        .map(|items| items.len())
        .unwrap_or(0);
    let bytes = std::fs::metadata(crate::vault_path())
        .map(|meta| meta.len())
        .unwrap_or(0);
    let has_password = matches!(
        guard.engine.protection(),
        Ok(Some(colax_core::VaultProtection::Password))
    );
    (count, bytes, has_password)
}

/// "windows · 1.1.0 · built 2026-10-16 10:52 UTC" — the Data tab's App
/// version chip. The TS splits the same claim in two: `getPlatform().name`
/// and a stamp vite baked in at bundle time. Here the platform is this
/// port's own word and the time is the running exe's file stamp, which is
/// the honest native reading of "the exact build running right now".
fn build_stamp() -> String {
    let version = env!("CARGO_PKG_VERSION");
    let ms = std::env::current_exe()
        .ok()
        .and_then(|path| std::fs::metadata(path).ok())
        .and_then(|meta| meta.modified().ok())
        .and_then(|stamp| stamp.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|since| since.as_millis() as i64)
        .unwrap_or_else(colax_core::util::now_ms);
    format!(
        "windows · {version} · built {}",
        colax_core::util::utc_stamp_minutes(ms)
    )
}

/// The whole vault as the TS's plaintext CSV (Settings.tsx L422-447): the
/// seven-column header, one quoted line per login, `"` doubled inside cells
/// and the item's ISO timestamp in `created`. Deliberately readable — the
/// point is to move logins into another tool.
pub fn csv_text(items: &[colax_core::VaultItem]) -> String {
    fn escape(value: &str) -> String {
        format!("\"{}\"", value.replace('"', "\"\""))
    }
    let mut out = String::from("name,url,username,password,notes,favorite,created");
    for item in items {
        out.push('\n');
        out.push_str(&format!(
            "{},{},{},{},{},{},{}",
            escape(&item.title),
            escape(&item.url),
            escape(&item.username),
            escape(&item.password),
            escape(&item.notes),
            escape(if item.favorite { "true" } else { "false" }),
            escape(&colax_core::util::iso_from_ms(item.created_at)),
        ));
    }
    out
}

/// One CSV line split the way the TS's reader does (Settings.tsx
/// L449-473): `""` inside a quoted cell is one `"`, a comma outside quotes
/// ends the cell, and unquoted text passes through untouched.
fn csv_cells(line: &str) -> Vec<String> {
    let mut cells = Vec::new();
    let mut cell = String::new();
    let mut quoted = false;
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '"' => {
                if quoted && chars.peek() == Some(&'"') {
                    cell.push('"');
                    chars.next();
                } else {
                    quoted = !quoted;
                }
            }
            ',' if !quoted => cells.push(std::mem::take(&mut cell)),
            other => cell.push(other),
        }
    }
    cells.push(cell);
    cells
}

/// Settings › Data's "Export CSV" — the save dialog in front of `csv_text`.
/// The TS hands the browser a download named `colax-vault-YYYY-MM-DD.csv`
/// (Settings.tsx L440-446); here the user picks the folder and the same name
/// is pre-filled.
pub fn data_export_csv(ui: &MainWindow, state: &Shared) {
    let (document, count) = {
        let guard = state.borrow();
        match guard.engine.items() {
            Some(items) => (csv_text(items), items.len()),
            None => (String::new(), 0),
        }
    };
    if count == 0 {
        return; // the row's button is disabled at zero; belt and braces
    }
    let day = colax_core::util::utc_stamp_minutes(colax_core::util::now_ms());
    let name = format!("colax-vault-{}.csv", &day[..10]);
    let Some(path) = crate::platform::save_csv_file(crate::find_main_window(), &name) else {
        return; // cancelled: nothing written, nothing said
    };
    if std::fs::write(&path, document).is_err() {
        ui.set_error_text("That file could not be written.".into());
        return;
    }
    crate::notice(ui, "Plaintext CSV exported — delete it once imported elsewhere");
}

/// Settings › Data's "Import CSV": open a .csv through the system dialog
/// and add every row as a login.
pub fn data_import_csv(ui: &MainWindow, state: &Shared) {
    let Some(path) = crate::platform::pick_csv_file(crate::find_main_window()) else {
        return;
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        ui.set_error_text("That file could not be read.".into());
        return;
    };
    data_import_from_text(ui, state, &text);
}

/// The half of the import a dump run can drive without a dialog: parse and
/// add, then refresh. The parse is the TS's `importCsv` (Settings.tsx
/// L449-505): blank lines dropped, the header row skipped, cells unquoted,
/// and `favorite` true only for the literal "true". Returns how many rows
/// landed.
pub fn data_import_from_text(ui: &MainWindow, state: &Shared, text: &str) -> usize {
    let lines: Vec<&str> = text
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .filter(|line| !line.is_empty())
        .collect();
    let mut imported = 0usize;
    for line in lines.iter().skip(1) {
        let cells = csv_cells(line);
        let cell = |index: usize| cells.get(index).cloned().unwrap_or_default();
        let draft = serde_json::json!({
            "title": cell(0),
            "url": cell(1),
            "username": cell(2),
            "password": cell(3),
            "notes": cell(4),
            "favorite": cell(5) == "true",
        });
        let added = state.borrow_mut().engine.add_item(&draft).is_ok();
        if !added {
            ui.set_error_text("That import could not be saved.".into());
            break;
        }
        imported += 1;
    }
    crate::refresh_items(ui, state);
    refresh(ui, state);
    crate::notice(ui, &format!("Imported {imported} logins"));
    imported
}

/// The Data tab's "Delete everything": open the confirm sheet with the
/// count baked into its message (Settings.tsx L2240-2245). The erase
/// itself is `crate::settings_data_reset` — it needs the tray and the
/// navigation, which live in main.
pub fn data_reset_open(ui: &MainWindow, state: &Shared) {
    let count = state
        .borrow()
        .engine
        .items()
        .map(|items| items.len())
        .unwrap_or(0);
    ui.set_settings_data_reset_message(
        format!(
            "All {count} logins, every tag, channel, folder, alarm, connected mailbox, setting \
             and usage record will be erased from this device, and the clipboard will be \
             cleared. The app returns to first-run setup. This cannot be undone, and nobody — \
             including whoever built this — can recover any of it."
        )
        .as_str()
        .into(),
    );
    ui.set_settings_data_reset_open(true);
}

pub fn data_reset_cancel(ui: &MainWindow) {
    ui.set_settings_data_reset_open(false);
}

/// Settings › Backup's "Export". With "ask before exporting" on, the sheet
/// comes first and its password protects the file; off, the document is
/// written as it stands (the `confirmBeforeExport` branch, Settings.tsx
/// L1507-1523).
pub fn backup_export(ui: &MainWindow, state: &Shared) {
    let confirm = items::prefs_from(state.borrow().engine.preferences()).confirm_before_export;
    if confirm {
        ui.set_settings_data_export_password("".into());
        ui.set_settings_data_export_score(0);
        ui.set_settings_data_protect_open(true);
        return;
    }
    export_backup_file(ui, state, None);
}

/// Settings › Backup's "Include settings and layout": whether an export
/// carries the app's own preferences beside the vault. The write is the
/// ordinary pref path, so the switch survives a restart and travels in the
/// very blob it governs.
pub fn backup_with_settings_toggled(ui: &MainWindow, state: &Shared) -> bool {
    pref_bool(
        ui,
        state,
        "backupWithSettings",
        ui.get_settings_backup_with_settings(),
    )
}

/// The score gate's input: every keystroke in the protect sheet rescores
/// through the same `estimate_strength` the vault's password fields use, and
/// the Export button lights at 2 (Settings.tsx L2197).
pub fn data_export_edited(ui: &MainWindow) {
    let score = estimate_strength(&ui.get_settings_data_export_password()).score as i32;
    ui.set_settings_data_export_score(score);
}

pub fn data_protect_cancel(ui: &MainWindow) {
    ui.set_settings_data_protect_open(false);
}

pub fn data_protect_confirm(ui: &MainWindow, state: &Shared) {
    let password = ui.get_settings_data_export_password().to_string();
    export_backup_file(ui, state, Some(&password));
}

/// Both exports meet here: serialize (re-wrapped when a password came from
/// the sheet), pick a path, write, and say so. The pre-filled name is the
/// TS's `backupFilename()` (src/vault/backup.ts L27).
fn export_backup_file(ui: &MainWindow, state: &Shared, password: Option<&str>) {
    let Some(document) = export_backup_text(ui, state, password) else {
        return;
    };
    let name = format!(
        "colax-vault-backup-{}.json",
        colax_core::util::utc_stamp_seconds(colax_core::util::now_ms())
    );
    let Some(path) = crate::platform::save_backup_file(crate::find_main_window(), &name) else {
        return; // cancelled: the sheet stays up, fields intact
    };
    if std::fs::write(&path, document).is_err() {
        ui.set_error_text("That file could not be written.".into());
        return;
    }
    ui.set_settings_data_protect_open(false);
    crate::notice(ui, "Encrypted backup downloaded");
}

/// The document the two export paths produce, without the save dialog, so a
/// dump run can hold the file and check what the "Include settings and
/// layout" switch did to it. `None` when the vault will not serialize, with
/// the window's error line already set.
fn export_backup_text(ui: &MainWindow, state: &Shared, password: Option<&str>) -> Option<String> {
    let document = {
        let guard = state.borrow();
        // The switch is read here rather than pushed to the window: the file
        // is the only thing it changes, and this is the one place that writes
        // one.
        let include = items::prefs_from(guard.engine.preferences()).backup_with_settings;
        guard.engine.export_backup_json_with(include, password)
    };
    match document {
        Ok(document) => Some(document),
        Err(_) => {
            ui.set_error_text("The backup could not be written.".into());
            None
        }
    }
}

/// Settings › Backup's "Restore": open a backup file and show the sheet.
/// The text is read at pick time, as `pickBackupFile` reads the File before
/// the modal mounts (src/vault/backup.ts L43); the pair then waits in
/// `AppState.settings_restore` until submit or cancel.
pub fn backup_restore_pick(ui: &MainWindow, state: &Shared) {
    let Some(path) = crate::platform::pick_backup_file(crate::find_main_window()) else {
        return;
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        ui.set_error_text("Could not read that file.".into());
        return;
    };
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| path.display().to_string());
    backup_restore_from_text(ui, state, &name, &text);
}

/// The sheet's half of the restore, dialog-free so a dump run can drive a
/// whole export → import → restore round-trip: stash the file, set the
/// sheet up (name, warning sentence, cleared fields), open it, and let
/// `crate::settings_data_restore_submit` do the rest.
pub fn backup_restore_from_text(ui: &MainWindow, state: &Shared, name: &str, text: &str) {
    ui.set_settings_data_restore_message(
        format!("{name} will replace every login currently stored in this vault.")
            .as_str()
            .into(),
    );
    ui.set_settings_data_restore_error("".into());
    ui.set_settings_data_restore_password("".into());
    ui.set_settings_data_restore_passwordless(false);
    ui.set_settings_data_restore_rekey(false);
    ui.set_settings_data_restore_next("".into());
    ui.set_settings_data_restore_busy(false);
    ui.set_settings_data_restore_ready(false);
    state.borrow_mut().settings_restore = Some((text.to_string(), name.to_string()));
    // Last, because the sheet is open exactly while the name is set.
    ui.set_settings_data_restore_name(name.into());
}

pub fn data_restore_cancel(ui: &MainWindow, state: &Shared) {
    state.borrow_mut().settings_restore = None;
    ui.set_settings_data_restore_name("".into());
    ui.set_settings_data_restore_error("".into());
}

/// The restore button's gate, rescored on every keystroke and toggle. The
/// TS computes it inline — `password.length === 0 || (rekey && next.length
/// < 10)` (Settings.tsx L2686) — and Slint has no string length, so the
/// expression lands here.
pub fn data_restore_edited(ui: &MainWindow) {
    let password_ok = !ui.get_settings_data_restore_password().is_empty();
    let next_ok = ui.get_settings_data_restore_next().chars().count() >= 10;
    let ready = password_ok && (!ui.get_settings_data_restore_rekey() || next_ok);
    ui.set_settings_data_restore_ready(ready);
}

/* ---- Background (Task 5.9) --------------------------------------------- */

/// Whether a stored string is the kind of URL this app treats as "the URL
/// field's own text": `^https?:\/\/`, case-insensitive, which is the TS's
/// `valid` test and its `startsWith('http')` initialiser test in one place.
fn is_http_url(value: &str) -> bool {
    let lower = value.trim().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// The URL field's own edit: store the trimmed text when it is a bare
/// `http(s)` URL or empty (Settings.tsx L2295). Anything else stays in the
/// box without touching the preference, which is why the field holds its own
/// draft: the web app has the same rule and the same visible result.
///
/// A URL is *stored*, not fetched. This app makes no network request for a
/// picture (`art.rs`), so a URL is a value the web app can use and this one
/// carries faithfully without pretending to load it.
pub fn background_url_edited(ui: &MainWindow, state: &Shared) {
    let trimmed = ui.get_settings_bg_url().to_string().trim().to_string();
    if !trimmed.is_empty() && !is_http_url(&trimmed) {
        return;
    }
    write(ui, state, |prefs| {
        prefs.background_image = trimmed;
        true
    });
}

/// "Upload": read a picked photo into the data URL a preference stores, the
/// way `onPick` calls `readImageFile` (Settings.tsx L2269) — the same reader,
/// so the same four sentences come back on the way out.
pub fn background_upload(ui: &MainWindow, state: &Shared) {
    let Some(path) = crate::platform::pick_image_file(crate::find_main_window()) else {
        return;
    };
    match crate::art::read_image_data_url(&path, crate::art::MAX_APP_BACKGROUND_BYTES) {
        Ok(data_url) => {
            ui.set_settings_bg_url("".into());
            ui.set_settings_bg_error("".into());
            write(ui, state, |prefs| {
                prefs.background_image = data_url;
                true
            });
            crate::notice(ui, "Background image added");
        }
        Err(message) => ui.set_settings_bg_error(message.as_str().into()),
    }
}

/// The ✕ beside the field: clear the draft and the preference
/// (Settings.tsx L2306).
pub fn background_remove(ui: &MainWindow, state: &Shared) {
    ui.set_settings_bg_url("".into());
    ui.set_settings_bg_error("".into());
    write(ui, state, |prefs| {
        prefs.background_image = String::new();
        true
    });
}

/// The Background tab's three dials and the flag behind its ✕. The URL
/// *field* is not pushed here on purpose — it is the window's draft, and a
/// push after every keystroke would fight the typing; `open` seeds it once.
pub fn push_background_fields(ui: &MainWindow, state: &Shared) {
    let prefs = {
        let guard = state.borrow();
        items::prefs_from(guard.engine.preferences())
    };
    ui.set_settings_bg_opacity(prefs.background_opacity as f32);
    ui.set_settings_bg_blur(prefs.background_blur as f32);
    ui.set_settings_bg_dim(prefs.background_dim as f32);
    ui.set_settings_bg_has_image(!prefs.background_image.is_empty());
}

/// Dev-only: store a photo straight from a path, so a walk step or a
/// screenshot can have the layer without a file dialog standing in the way.
/// It reads the file through the very reader an upload uses, which is the
/// point: the bytes on the screen are the bytes the button would store.
#[cfg(debug_assertions)]
pub fn background_set_from_file(ui: &MainWindow, state: &Shared, path: &std::path::Path) {
    match crate::art::read_image_data_url(path, crate::art::MAX_APP_BACKGROUND_BYTES) {
        Ok(data_url) => {
            ui.set_settings_bg_url("".into());
            ui.set_settings_bg_error("".into());
            write(ui, state, |prefs| {
                prefs.background_image = data_url;
                true
            });
        }
        Err(message) => ui.set_settings_bg_error(message.as_str().into()),
    }
}

/// The settings walk — `COLAX_DEV_SCREEN=settings`. Opens the window the
/// way the sidebar does (no tab), jumps the way Ctrl+number does, follows
/// a dashboard deep link, then drives four dials through the same handlers
/// the UI uses — one of each type, and an off-step float to prove the snap
/// (117 lands on 115). Each dump carries both the window's own values and
/// what reached the engine, so the write is checked without looking at it.
#[cfg(debug_assertions)]
pub fn dev(ui: &MainWindow, state: &Shared, tray: &slint::Weak<crate::AppTray>) {
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

    // The Desktop tab: four switches that live in two places at once. The
    // writes go through `crate::settings_bool`, which is the door the panel's
    // own callback uses -- a walk that called `pref_bool` here would prove the
    // vault's copy and skip `shell.json` entirely, which is the copy the tray
    // reads before any vault is unlocked.
    tab_picked(ui, 10); // Ctrl+11 -> desktop
    crate::settings_bool(ui, state, "trayEnabled", false);
    crate::settings_bool(ui, state, "closeToTray", true);
    crate::settings_bool(ui, state, "soundsMuted", true);
    dump(ui, state, "settings9.desktop");
    dump_shell(state, "settings10.shell-file");

    // The Generator tab, whose six fields are one object in the document and
    // the editor's own generator besides. The last set is switched off to show
    // the object's rule answering: the store puts the shipped defaults back
    // (length included), so the dials come up on again two lines later.
    tab_picked(ui, 5); // Ctrl+6 -> generator
    pref_float(ui, state, "gen-length", 48.0);
    pref_bool(ui, state, "gen-lower", false);
    dump(ui, state, "settings11.generator");
    pref_bool(ui, state, "gen-upper", false);
    pref_bool(ui, state, "gen-digits", false);
    pref_bool(ui, state, "gen-symbols", false);
    dump(ui, state, "settings12.generator-reset");

    // The Alarms tab: two alarms through the panel's own handlers. The first
    // carries two picked days; the second is added straight after, so it is
    // the reset draft — no label, 08:00, every day. The dot and the bin then
    // address a row by the id its model carried, which `new_alarm_id` made
    // random, so both are read back off the document first.
    tab_picked(ui, 7); // Ctrl+8 -> alarms
    ui.set_settings_alarm_label("Stand up".into());
    ui.set_settings_alarm_time("07:30".into());
    alarm_day_toggled(ui, state, 0); // Sun
    alarm_day_toggled(ui, state, 2); // Tue
    alarms_add(ui, state);
    alarms_add(ui, state);
    let first = stored_alarm_id(state, 0);
    let second = stored_alarm_id(state, 1);
    alarm_test(state, &first); // the Test button's own path
    alarm_toggle(ui, state, &first);
    alarm_delete(ui, state, &second);
    dump(ui, state, "settings13.alarms");

    // The Security tab. The second group is shown — the sub-tab is a plain
    // property write, no callback — four simple rows are written through the
    // same door the pills and switches use (one of them off the list, which
    // must be refused and leave the stored days alone), then the vault's own
    // form: a generated key staged, a wrong code refused, the right one
    // saved, a passcode and a recovery question added and checked.
    tab_picked(ui, 6); // Ctrl+7 -> security
    ui.set_settings_sec_group(1); // clipboard
    pref_string(ui, state, "clear-clipboard", "60");
    pref_bool(ui, state, "clipboardCapture", true);
    pref_string(ui, state, "password-age", "90");
    pref_string(ui, state, "email-age", "45"); // off the list: refused
    pref_bool(ui, state, "confirmDeletes", false);
    pref_bool(ui, state, "maskEmails", false);
    dump(ui, state, "settings14.security");

    ui.set_settings_sec_group(0); // back to locking, where the form lives
    vsec_totp_generate(ui, state);
    ui.set_settings_vsec_totp_code("000000".into());
    vsec_totp_check(ui, state); // wrong: the staged key must survive
    dump(ui, state, "settings15.vsec-staged");

    // Fully qualified: this walk block is `#[cfg(debug_assertions)]`, so the
    // import would read as unused in a release build.
    let code = state
        .borrow()
        .vault_staged_seed
        .clone()
        .and_then(|seed| colax_core::totp::current_totp_code(&seed).ok())
        .unwrap_or_default();
    ui.set_settings_vsec_totp_code(code.as_str().into());
    vsec_totp_check(ui, state); // the first right code is the write
    ui.set_settings_vsec_passcode_new("short".into());
    ui.set_settings_vsec_passcode_confirm("short".into());
    vsec_passcode_save(ui, state); // too weak: refused
    ui.set_settings_vsec_passcode_new("vault-gate-2026".into());
    ui.set_settings_vsec_passcode_confirm("vault-gate-2026".into());
    vsec_passcode_save(ui, state);
    ui.set_settings_vsec_new_answer("ten past four".into());
    vsec_question_add(ui, state);
    let question = stored_vault_question_id(state, 0);
    vsec_question_check(ui, state, &question); // first press opens the box
    ui.set_settings_vsec_check_input("half past nine".into());
    vsec_question_check(ui, state, &question); // wrong: refused
    ui.set_settings_vsec_check_input("ten past four".into());
    vsec_question_check(ui, state, &question); // right: box closes
    ui.set_settings_vsec_passcode_input("vault-gate-2026".into());
    vsec_passcode_check(ui, state);
    dump(ui, state, "settings16.vsec-saved");

    // The Data and Backup tabs (Task 5.8). The chips are read-outs; the
    // real flows are a CSV round-trip and a whole backup restore, and every
    // file dialog is the one thing a dump run cannot click — so the walk
    // takes the same seams the buttons take after their pickers:
    // `csv_text`, `data_import_from_text`, `backup_restore_from_text`.
    tab_picked(ui, 8); // Ctrl+9 -> data
    dump(ui, state, "settings18.data");

    // A password-protected backup of the vault *before* the import — the
    // rows as they stand. Taken here so the restore below has something the
    // import changed: the count coming back is the proof it replaced
    // everything rather than merging.
    let before = state.borrow().engine.items().map_or(0, |items| items.len());
    let backup = {
        let guard = state.borrow();
        guard
            .engine
            .export_backup_json_with_password("walk passphrase")
            .unwrap_or_default()
    };

    // The export text, re-imported — every seed row out and back in — plus
    // one hand-written line whose cells carry a comma and doubled quotes, to
    // prove the escaping in both directions. `before + 1` rows must land.
    let csv = {
        let guard = state.borrow();
        csv_text(guard.engine.items().unwrap_or_default())
    };
    let round_trip = format!(
        "{csv}\n\"Comma, \"\"quoted\"\"\",\"https://quotes.test\",\"ann\",\"pw\",\"a, b\",\"true\",\"\"\n"
    );
    let imported = data_import_from_text(ui, state, &round_trip);
    debug_assert_eq!(imported, before + 1, "the export's rows plus the crafted line");
    dump(ui, state, "settings19.csv-import");

    // The sheet: a wrong password refused with the vault untouched, the
    // right one restoring the file's rows and re-keying back to device
    // protection.
    backup_restore_from_text(ui, state, "walk-backup.json", &backup);
    dump(ui, state, "settings20.restore-open");

    ui.set_settings_data_restore_password("wrong".into());
    data_restore_edited(ui); // the Field's own callback in the real UI
    crate::settings_data_restore_submit(ui, state, tray);
    dump(ui, state, "settings21.restore-refused");

    ui.set_settings_data_restore_password("walk passphrase".into());
    ui.set_settings_data_restore_passwordless(true);
    data_restore_edited(ui); // the toggle's own callback
    crate::settings_data_restore_submit(ui, state, tray);
    let restored = state.borrow().engine.items().map_or(0, |items| items.len());
    debug_assert_eq!(restored, before, "the backup replaces everything the import added");
    dump(ui, state, "settings22.restored");

    // The protect sheet: "ask before exporting" on, Export opens it; the
    // score gate refuses "short" and lights at two for a mixed password;
    // cancel closes.
    pref_bool(ui, state, "confirmBeforeExport", true);
    backup_export(ui, state);
    dump(ui, state, "settings23.protect-open");
    ui.set_settings_data_export_password("short".into());
    data_export_edited(ui);
    debug_assert!(
        ui.get_settings_data_export_score() < 2,
        "the gate stays shut on \"short\""
    );
    dump(ui, state, "settings24.protect-weak");
    // Note the estimator's conservatism: even a four-word phrase
    // (`correct horse battery staple`) reads as 1, so the sample that has to
    // clear the gate is a mixed-character one.
    ui.set_settings_data_export_password("Tr0ub4dor&3".into());
    data_export_edited(ui);
    debug_assert!(
        ui.get_settings_data_export_score() >= 2,
        "the gate opens on a mixed password"
    );
    dump(ui, state, "settings25.protect-strong");
    data_protect_cancel(ui);
    dump(ui, state, "settings26.protect-cancelled");

    // The reset sheet: the message carries the count, and cancelling leaves
    // every login exactly where it was.
    data_reset_open(ui, state);
    dump(ui, state, "settings27.reset-open");
    data_reset_cancel(ui);
    dump(ui, state, "settings28.reset-cancelled");

    // The Background tab (Task 5.9): the field's own rule, the three dials, a
    // stored photo and the ✕. The photo is generated here and read back
    // through the same reader an upload uses, so `app=[width opacity dim]` on
    // the dump line is the proof the pixels reached Slint -- not just that a
    // preference changed.
    tab_picked(ui, 3);
    dump(ui, state, "settings29.background");
    // A scheme other than http(s) is refused: the box keeps the text and the
    // preference keeps its old value, which is the TS's `valid` test and the
    // reason the field owns a draft at all.
    ui.set_settings_bg_url("file:///C:/photo.jpg".into());
    background_url_edited(ui, state);
    debug_assert!(
        !ui.get_settings_bg_has_image(),
        "a non-http scheme is not stored"
    );
    dump(ui, state, "settings30.background-refused");
    ui.set_settings_bg_url("https://example.com/photo.jpg".into());
    background_url_edited(ui, state);
    debug_assert!(
        ui.get_settings_bg_has_image(),
        "an https URL is stored, as text"
    );
    // A URL is stored and never fetched, so it paints nothing: the layer is
    // still bare even though the preference is set. That is the honest half
    // of this tab, and the dump says so.
    debug_assert!(
        ui.get_app_bg().size().width == 0,
        "a URL paints nothing"
    );
    dump(ui, state, "settings31.background-url");
    pref_float(ui, state, "bg-opacity", 0.6);
    pref_float(ui, state, "bg-blur", 12.0);
    pref_float(ui, state, "bg-dim", 0.4);
    debug_assert!(
        (ui.get_settings_bg_opacity() - 0.6).abs() < 0.001
            && (ui.get_settings_bg_blur() - 12.0).abs() < 0.001,
        "the three dials land on their steps"
    );
    dump(ui, state, "settings32.background-dials");
    background_dev_photo(ui, state);
    debug_assert!(
        ui.get_app_bg().size().width > 0,
        "a stored photo reaches the layer"
    );
    dump(ui, state, "settings33.background-photo");
    background_remove(ui, state);
    debug_assert!(
        !ui.get_settings_bg_has_image() && ui.get_app_bg().size().width == 0,
        "the cross clears the flag and the layer together"
    );
    dump(ui, state, "settings34.background-removed");

    // The Channels tab (Task 5.10) and the shared editor. Every step drives
    // the same function the panel's callback is wired to, so what the dump
    // shows is what a click would have produced -- and each one is checked
    // against the document, because the panel is a view of it.
    tab_picked(ui, 4); // Ctrl+5 -> channels
    dump(ui, state, "settings35.channels");

    // The tag catalogue: a rename, an add, a duplicate refused, a recolour.
    // The rename is live (Slint has no blur), so by the time the box closes
    // the document already holds the new name.
    //
    // The rename lands on a *shipped* tag, which brings the catalogue's own
    // trap with it: `ensureDefaultTags` re-seeds the three defaults whenever
    // they are missing by name (storage.ts L1076), so the original comes back
    // as a fourth row. The TS does exactly this; the walk pins it rather than
    // tiptoeing around it, because a port that quietly avoided it would
    // disagree with the document the web build reads.
    let first_tag = items::prefs_from(state.borrow().engine.preferences())
        .tags
        .first()
        .map(|tag| tag.id.clone())
        .expect("the seed ships a tag catalogue");
    crate::channels_ops::tag_rename_start(ui, state, &first_tag);
    crate::channels_ops::tag_renamed(ui, state, &first_tag, "Work logins");
    crate::channels_ops::tag_rename_done(ui, state, &first_tag);
    debug_assert_eq!(
        items::prefs_from(state.borrow().engine.preferences()).tags[0].name,
        "Work logins",
        "a rename lands in the catalogue"
    );
    debug_assert_eq!(
        items::prefs_from(state.borrow().engine.preferences())
            .tags
            .len(),
        4,
        "renaming a shipped tag makes the default come back"
    );
    dump(ui, state, "settings36.tag-renamed");

    ui.set_settings_chan_tag_input("Billing".into());
    crate::channels_ops::tag_input_edited(ui);
    debug_assert!(ui.get_settings_chan_tag_can_add(), "a typed name can be added");
    crate::channels_ops::tag_add(ui, state);
    debug_assert_eq!(
        items::prefs_from(state.borrow().engine.preferences()).tags.len(),
        5,
        "the add box mints one tag"
    );
    // The same name again, cased differently, is refused: the box keeps the
    // text, the catalogue keeps five rows, and the toast says why.
    ui.set_settings_chan_tag_input("billing".into());
    crate::channels_ops::tag_add(ui, state);
    debug_assert_eq!(
        items::prefs_from(state.borrow().engine.preferences()).tags.len(),
        5,
        "a duplicate tag is refused"
    );
    dump(ui, state, "settings37.tag-added");

    // A recolour: the swatch opens that row's range, the drag stores 300.
    let billing = items::prefs_from(state.borrow().engine.preferences())
        .tags
        .iter()
        .find(|tag| tag.name == "Billing")
        .map(|tag| tag.id.clone())
        .expect("the tag just added is in the catalogue");
    crate::channels_ops::tag_hue_toggle(ui, state, &billing);
    debug_assert!(
        slint::Model::iter(&ui.get_settings_chan_tag_rows()).any(|row| row.hue_open),
        "the swatch opens the range"
    );
    crate::channels_ops::tag_hue_changed(ui, state, &billing, 300.0);
    debug_assert!(
        (items::prefs_from(state.borrow().engine.preferences())
            .tags
            .iter()
            .find(|tag| tag.id == billing)
            .map(|tag| tag.hue)
            .unwrap_or_default()
            - 300.0)
            .abs()
            < 0.001,
        "the range stores the hue"
    );
    dump(ui, state, "settings38.tag-hue");

    // The eye takes one row off the rail; Hide all takes every one; Show all
    // puts them back. The two bulk buttons are conditions, not constants:
    // after Hide all there is nothing left to hide.
    crate::channels_ops::toggle_hidden(ui, state, "mail");
    debug_assert_eq!(
        items::prefs_from(state.borrow().engine.preferences())
            .hidden_channels
            .len(),
        1,
        "the eye hides exactly one channel"
    );
    debug_assert!(ui.get_settings_chan_can_show_all());
    dump(ui, state, "settings39.hidden-one");
    crate::channels_ops::hide_all(ui, state);
    debug_assert!(
        !ui.get_settings_chan_can_hide_all(),
        "nothing is left to hide"
    );
    dump(ui, state, "settings40.hidden-all");
    crate::channels_ops::show_all(ui, state);
    debug_assert_eq!(
        items::prefs_from(state.borrow().engine.preferences())
            .hidden_channels
            .len(),
        0,
        "Show all empties the list"
    );
    debug_assert!(!ui.get_settings_chan_can_show_all());
    dump(ui, state, "settings41.shown-all");

    // The shared editor on a stored channel. `favorites` used to be a shipped
    // row this walk could lean on; the tab strip retired it (channels.ts), so
    // the walk makes one of the user's own first — through the Add flow,
    // like anything a user makes — and edits that.
    crate::channels_ops::open(ui, state, "new");
    ui.set_channel_ed_name("Stars".into());
    crate::channels_ops::name_edited(ui, state);
    crate::channels_ops::save(ui, state);
    let walked = items::prefs_from(state.borrow().engine.preferences())
        .channels
        .iter()
        .find(|channel| channel.name == "Stars")
        .map(|channel| channel.id.clone())
        .expect("the walk's channel is stored");
    crate::channels_ops::open(ui, state, &walked);
    debug_assert_eq!(ui.get_channel_ed_title().to_string(), "Edit Stars");
    debug_assert!(!ui.get_channel_ed_is_new() && ui.get_channel_ed_can_delete());
    debug_assert_eq!(ui.get_channel_ed_kind_index(), 0, "All is lit");
    debug_assert_eq!(slint::Model::row_count(&ui.get_channel_ed_icons()), 10);
    debug_assert_eq!(slint::Model::row_count(&ui.get_channel_ed_accents()), 4);
    dump(ui, state, "settings42.editor");

    // Every control, one at a time. An existing channel writes through on
    // each move -- the autosave the TS debounces, which this port does not.
    ui.set_channel_ed_name("Starred".into());
    crate::channels_ops::name_edited(ui, state);
    crate::channels_ops::kind_picked(ui, state, 2); // Needs attention
    crate::channels_ops::tag_toggled(ui, state, &billing);
    crate::channels_ops::icon_picked(ui, state, "star");
    crate::channels_ops::hue_changed(ui, state, 300.0);
    crate::channels_ops::accent_picked(ui, state, "dusk");
    ui.set_channel_ed_image_url("https://example.com/backdrop.jpg".into());
    crate::channels_ops::image_edited(ui, state);
    crate::channels_ops::image_float(ui, state, "opacity", 0.8);
    crate::channels_ops::image_float(ui, state, "blur", 7.0);
    crate::channels_ops::image_float(ui, state, "dim", 0.45);
    crate::channels_ops::show_mail_toggled(ui, state, false);
    {
        let prefs = items::prefs_from(state.borrow().engine.preferences());
        let stored = prefs
            .channels
            .iter()
            .find(|channel| channel.id == walked)
            .expect("a stored channel cannot vanish");
        debug_assert_eq!(stored.name, "Starred");
        debug_assert_eq!(stored.kind, colax_core::ChannelKind::Attention);
        debug_assert_eq!(stored.tag_ids, vec![billing.clone()]);
        debug_assert_eq!(stored.icon, "star");
        debug_assert_eq!(stored.hue, 300);
        debug_assert_eq!(stored.accent, colax_core::ChannelAccent::Dusk);
        debug_assert_eq!(stored.background_image, "https://example.com/backdrop.jpg");
        debug_assert!((stored.background_opacity - 0.8).abs() < 0.001);
        debug_assert!((stored.background_blur - 7.0).abs() < 0.001);
        debug_assert!((stored.background_dim - 0.45).abs() < 0.001);
        debug_assert!(!stored.show_mail);
    }
    dump(ui, state, "settings43.editor-edited");

    // A half-typed address never becomes the picture: the box keeps the
    // text, the channel keeps the last good value, and the field is left
    // alone rather than settled back under the user's cursor.
    ui.set_channel_ed_image_url("not a url".into());
    crate::channels_ops::image_edited(ui, state);
    debug_assert_eq!(
        items::prefs_from(state.borrow().engine.preferences())
            .channels
            .iter()
            .find(|channel| channel.id == walked)
            .map(|channel| channel.background_image.clone())
            .unwrap_or_default(),
        "https://example.com/backdrop.jpg",
        "a non-http draft is not stored"
    );
    dump(ui, state, "settings44.editor-refused");

    // Done only closes: nothing is written on the way out.
    crate::channels_ops::close(ui, state);
    debug_assert!(!ui.get_channel_ed_open());
    dump(ui, state, "settings45.editor-closed");

    // The Add flow. The draft starts on the literal "New channel" —
    // `createChannel('')` names it that, which is why the TS's own
    // placeholder is never seen — so a blank name has to be typed in before
    // its guard can be reached; then a named one is added, given a sidebar
    // entry and made the active view, and deleted again, which takes the
    // entry out with it and falls back to `all`.
    crate::channels_ops::open(ui, state, "new");
    debug_assert!(ui.get_channel_ed_is_new() && !ui.get_channel_ed_can_delete());
    debug_assert_eq!(ui.get_channel_ed_title().to_string(), "New channel");
    debug_assert!(
        ui.get_channel_ed_can_save(),
        "a fresh draft is already named"
    );
    ui.set_channel_ed_name("   ".into());
    crate::channels_ops::name_edited(ui, state);
    debug_assert!(
        !ui.get_channel_ed_can_save(),
        "a box of spaces cannot be saved"
    );
    crate::channels_ops::save(ui, state);
    debug_assert_eq!(ui.get_channel_ed_error().to_string(), "Give the channel a name.");
    debug_assert_eq!(
        items::prefs_from(state.borrow().engine.preferences())
            .channels
            .len(),
        5,
        "a nameless channel is not added"
    );
    dump(ui, state, "settings46.new-refused");

    ui.set_channel_ed_name("  Reading  ".into());
    crate::channels_ops::name_edited(ui, state);
    debug_assert!(ui.get_channel_ed_can_save());
    crate::channels_ops::save(ui, state);
    debug_assert!(!ui.get_channel_ed_open());
    let added = items::prefs_from(state.borrow().engine.preferences())
        .channels
        .iter()
        .find(|channel| channel.name == "Reading")
        .map(|channel| channel.id.clone())
        .expect("the trimmed name is stored");
    debug_assert_eq!(ui.get_active_channel().to_string(), added);
    debug_assert!(
        sidebar_lists(state, &added),
        "a new channel joins the stored sidebar tree"
    );
    dump(ui, state, "settings47.new-added");

    crate::channels_ops::open(ui, state, &added);
    debug_assert!(ui.get_channel_ed_can_delete(), "a made channel can go");
    crate::channels_ops::deleted(ui, state);
    debug_assert_eq!(
        items::prefs_from(state.borrow().engine.preferences())
            .channels
            .len(),
        5,
        "Delete takes the channel out of the catalogue"
    );
    debug_assert_eq!(ui.get_active_channel().to_string(), "all");
    debug_assert!(
        !sidebar_lists(state, &added),
        "Delete takes it out of the sidebar tree too"
    );
    dump(ui, state, "settings48.new-deleted");

    // The Backup tab's one native-only switch. This port writes its own
    // settings into the export (they live in the same file on disk); the web
    // build's backup is the vault and its logins, full stop, and its restore
    // leaves the device's settings alone. The switch is the choice, and the
    // two files below are held in memory the way `export_backup_text` hands
    // one to the save dialog -- every file picker is the one thing a dump run
    // cannot click.
    tab_picked(ui, 9); // Ctrl+10 -> backup
    debug_assert!(
        ui.get_settings_backup_with_settings(),
        "the switch ships on: a backup that dropped the look would be worse"
    );
    let with_settings = export_backup_text(ui, state, None).expect("the vault serializes");
    debug_assert!(with_settings.contains("\"preferences\""));
    debug_assert!(
        with_settings.contains("\"channels\""),
        "the rail travels with the settings"
    );

    // Off: the file the web build writes. The vault and its logins are all
    // there and the settings key is not — not null, not empty, absent, so the
    // TS parser never sees a field it does not know.
    ui.set_settings_backup_with_settings(false);
    backup_with_settings_toggled(ui, state);
    debug_assert!(!items::prefs_from(state.borrow().engine.preferences()).backup_with_settings);
    let lean = export_backup_text(ui, state, None).expect("the vault serializes");
    debug_assert!(!lean.contains("preferences"));
    let lean_items = colax_core::parse_backup(&lean)
        .expect("the lean file still parses")
        .items
        .len();
    debug_assert_eq!(
        lean_items,
        state.borrow().engine.items().map_or(0, |items| items.len()),
        "the logins are all in it"
    );
    dump(ui, state, "settings49.backup-lean");

    // One setting changed *after* the file was taken, so the two restores
    // below can be told apart by what they did to the settings rather than by
    // the logins, which both carry.
    pref_string(ui, state, "accent", "dusk");
    debug_assert_eq!(
        items::prefs_from(state.borrow().engine.preferences()).accent,
        "dusk"
    );

    backup_restore_from_text(ui, state, "walk-lean.json", &lean);
    ui.set_settings_data_restore_password("".into());
    crate::settings_data_restore_submit(ui, state, tray);
    debug_assert_eq!(
        items::prefs_from(state.borrow().engine.preferences()).accent,
        "dusk",
        "a file without the blob leaves this device's own settings alone"
    );
    dump(ui, state, "settings50.backup-lean-restored");

    backup_restore_from_text(ui, state, "walk-backup.json", &with_settings);
    ui.set_settings_data_restore_password("".into());
    crate::settings_data_restore_submit(ui, state, tray);
    debug_assert_eq!(
        items::prefs_from(state.borrow().engine.preferences()).accent,
        "clay",
        "a file with the blob puts the settings it carries back"
    );
    dump(ui, state, "settings51.backup-restored");

    // ---- Optimize (Task 5.11) --------------------------------------------
    // The tab starts on the General group: two locked savings (no picture to
    // repaint, no mailbox polling), no profiles and no snapshot, and the
    // counter reads what the switches say rather than a number of its own.
    tab_picked(ui, 11); // Ctrl+12
    {
        let prefs = items::prefs_from(state.borrow().engine.preferences());
        debug_assert!(prefs.optimize_profiles.is_empty());
        debug_assert!(prefs.optimize_snapshot.is_none());
        debug_assert_eq!(ui.get_settings_opt_count_on(), 2);
    }
    dump(ui, state, "settings52.optimize-defaults");

    // A save always takes a name from the box, and the box is seeded: the
    // empty name survives as the TS's own fallback.
    ui.set_settings_opt_name("Evening focus".into());
    crate::optimize_ops::save_profile(ui, state);
    {
        let prefs = items::prefs_from(state.borrow().engine.preferences());
        debug_assert_eq!(prefs.optimize_profiles.len(), 1);
        debug_assert_eq!(prefs.active_optimize_profile, "Evening focus");
        debug_assert!(prefs.optimize_snapshot.is_none(), "a save is not a trade-away");
    }
    dump(ui, state, "settings53.optimize-saved");

    // A duplicate name (case-insensitively, as the TS compared) is refused
    // with the box left exactly as the user typed it.
    ui.set_settings_opt_name("evening FOCUS".into());
    crate::optimize_ops::save_profile(ui, state);
    {
        let prefs = items::prefs_from(state.borrow().engine.preferences());
        debug_assert_eq!(prefs.optimize_profiles.len(), 1);
    }
    debug_assert_eq!(
        ui.get_settings_opt_name(),
        "evening FOCUS",
        "the box keeps what was typed; the toast carries the refusal"
    );
    dump(ui, state, "settings54.optimize-dup");

    // Measure again is a real read of the process, never an empty string.
    crate::optimize_ops::measure(ui);
    debug_assert!(!ui.get_settings_opt_work().is_empty());

    // Maximum savings: the counter reaches its own total, the tick is cleared
    // (a preset is not a saved profile), and the *first* trade-away records
    // what was there before it.
    crate::optimize_ops::preset_max(ui, state);
    {
        let prefs = items::prefs_from(state.borrow().engine.preferences());
        debug_assert_eq!(ui.get_settings_opt_count_on(), 10);
        debug_assert!(prefs.optimize_snapshot.is_some());
        debug_assert!(
            colax_core::same_style(
                prefs.optimize_snapshot.as_ref().expect("recorded"),
                &prefs.optimize_profiles[0].style,
            ),
            "the snapshot is the full-detail look the save stored"
        );
        debug_assert_eq!(prefs.active_optimize_profile, "");
    }
    dump(ui, state, "settings55.optimize-max");

    // Restore my look: the snapshot goes back in every field it owns and the
    // record clears; the saved profile is untouched.
    crate::optimize_ops::restore(ui, state);
    {
        let prefs = items::prefs_from(state.borrow().engine.preferences());
        debug_assert_eq!(ui.get_settings_opt_count_on(), 2);
        debug_assert!(prefs.optimize_snapshot.is_none());
        debug_assert_eq!(prefs.motion, 1.0);
        debug_assert_eq!(prefs.motion_speed, 2.0);
        debug_assert_eq!(prefs.optimize_profiles[0].name, "Evening focus");
    }
    dump(ui, state, "settings56.optimize-restored");

    // Applying the saved profile: it is already what is on screen, so no
    // trade-away, but the tick lands on it.
    let profile_id = {
        let prefs = items::prefs_from(state.borrow().engine.preferences());
        prefs.optimize_profiles[0].id.clone()
    };
    crate::optimize_ops::apply_profile(ui, state, &profile_id);
    debug_assert_eq!(
        items::prefs_from(state.borrow().engine.preferences()).active_optimize_profile,
        "Evening focus"
    );

    // Rename: a fresh name, the tick follows it, and the active record is the
    // one that moved rather than a second lookup.
    ui.set_settings_opt_rename("Late focus".into());
    crate::optimize_ops::rename_commit(ui, state, &profile_id);
    {
        let prefs = items::prefs_from(state.borrow().engine.preferences());
        debug_assert_eq!(prefs.optimize_profiles[0].name, "Late focus");
        debug_assert_eq!(prefs.active_optimize_profile, "Late focus");
    }
    dump(ui, state, "settings57.optimize-renamed");

    // Overwrite points the profile at the look on screen now (same style, new
    // stamp), and delete takes the active name with it.
    crate::optimize_ops::overwrite_profile(ui, state, &profile_id);
    crate::optimize_ops::delete_profile(ui, state, &profile_id);
    {
        let prefs = items::prefs_from(state.borrow().engine.preferences());
        debug_assert!(prefs.optimize_profiles.is_empty());
        debug_assert_eq!(prefs.active_optimize_profile, "");
    }
    dump(ui, state, "settings58.optimize-deleted");

    // The Look group's plain switch rides the generic bool key. It is counted
    // as its own saving, so the counter moves with it.
    pref_bool(ui, state, "microMotion", false);
    debug_assert_eq!(
        items::prefs_from(state.borrow().engine.preferences()).micro_motion,
        false
    );
    debug_assert_eq!(ui.get_settings_opt_count_on(), 3);
    dump(ui, state, "settings59.optimize-micro");
    pref_bool(ui, state, "microMotion", true);

    // Reduce motion is the compound row: off returns to full motion *at the
    // shipped pace* (speed 1 would hand back a slow app), and the second
    // toggle proves the pair, not just the slider.
    ui.set_settings_opt_motion_off(true);
    crate::optimize_ops::motion_toggled(ui, state);
    {
        let prefs = items::prefs_from(state.borrow().engine.preferences());
        debug_assert_eq!(prefs.motion, 0.0);
        debug_assert_eq!(prefs.motion_speed, 1.0);
    }
    ui.set_settings_opt_motion_off(false);
    crate::optimize_ops::motion_toggled(ui, state);
    {
        let prefs = items::prefs_from(state.borrow().engine.preferences());
        debug_assert_eq!(prefs.motion, 1.0);
        debug_assert_eq!(prefs.motion_speed, 2.0);
    }

    // Quiet the background and flat cards are also compounds. They are
    // plain rows, though: the TS records the look only at `applyStyle` — the
    // presets and a profile's Apply — so a row toggle records no snapshot
    // even when it lowers the counter's reading.
    ui.set_settings_opt_ambient_off(true);
    crate::optimize_ops::ambient_toggled(ui, state);
    ui.set_settings_opt_flat(true);
    crate::optimize_ops::cards_toggled(ui, state);
    {
        let prefs = items::prefs_from(state.borrow().engine.preferences());
        debug_assert_eq!(prefs.ambient, 0.0);
        debug_assert_eq!(prefs.card_depth, 0.0);
        debug_assert_eq!(ui.get_settings_opt_count_on(), 4);
        debug_assert!(
            prefs.optimize_snapshot.is_none(),
            "row toggles trade without recording"
        );
    }
    dump(ui, state, "settings60.optimize-compounds");

    // Restore clears the trade and puts back the shipped dials — from the
    // shipped full-detail look, since no snapshot was ever recorded. It is
    // the same handler the buttons under the presets use.
    crate::optimize_ops::restore(ui, state);
    {
        let prefs = items::prefs_from(state.borrow().engine.preferences());
        debug_assert!(prefs.optimize_snapshot.is_none());
        debug_assert_eq!(prefs.ambient, 1.0);
        debug_assert_eq!(prefs.card_depth, 0.4);
        debug_assert_eq!(prefs.motion, 1.0);
        debug_assert_eq!(prefs.micro_motion, true);
    }

    // The Speed group's switch is stored and counted, with the editor text
    // that would consume it still ahead.
    pref_bool(ui, state, "disableSpellcheck", true);
    debug_assert_eq!(
        items::prefs_from(state.borrow().engine.preferences()).disable_spellcheck,
        true
    );
    dump(ui, state, "settings61.optimize-spellcheck");
    pref_bool(ui, state, "disableSpellcheck", false);

    // The Messages group's two untyped dials: one of the three page sizes
    // into `extra`, and the cache clear that empties what the walk's normal
    // flow never filled.
    crate::optimize_ops::page_size_picked(ui, state, "25");
    crate::optimize_ops::cache_clear(ui, state);
    {
        let prefs = items::prefs_from(state.borrow().engine.preferences());
        debug_assert_eq!(crate::optimize_ops::page_size_of(&prefs), 25);
        debug_assert!(prefs.extra.get("mailCache").is_some_and(|c| c.is_object()));
    }
    dump(ui, state, "settings62.optimize-messages");

    // Inline images ride the plain key as well, and the count moves with
    // them; back on before the close, so the document ships at full detail.
    pref_bool(ui, state, "mailInlineImages", false);
    debug_assert_eq!(ui.get_settings_opt_count_on(), 3);
    dump(ui, state, "settings63.optimize-images");
    pref_bool(ui, state, "mailInlineImages", true);

    // ---- About (Task 5.12) ------------------------------------------------
    // The last tab: a stamp, a report, a reset. The stamp is built from the
    // running exe's own constants, so it must at least name the platform.
    tab_picked(ui, 12); // Ctrl+13
    debug_assert!(
        ui.get_settings_about_version().contains(std::env::consts::OS),
        "the stamp names the platform it was built for"
    );
    dump(ui, state, "settings64.about");

    // Copy diagnostics: the clipboard holds the report the button promises,
    // every key of it, with the counts and the protection of the vault this
    // walk has been using all along.
    about_copy_report(ui, state);
    {
        let report = crate::platform::read_text().expect("the clipboard took the report");
        debug_assert!(report.contains("\"prefs\""), "the record travels");
        debug_assert!(report.contains("\"itemCount\""));
        debug_assert!(report.contains("device"), "the walk vault is device-protected");
        debug_assert!(report.contains(std::env::consts::OS));
    }
    dump(ui, state, "settings65.about-report");

    // Reset settings: every dial back to the shipped record, logins and
    // channels untouched. The saved looks go with it — they are settings.
    about_reset(ui, state);
    {
        let prefs = items::prefs_from(state.borrow().engine.preferences());
        debug_assert_eq!(prefs.accent, "slate");
        debug_assert_eq!(prefs.text_scale, 100.0);
        debug_assert_eq!(prefs.motion, 1.0);
        debug_assert!(prefs.optimize_profiles.is_empty());
        debug_assert!(prefs.backup_with_settings, "the switch ships back on");
        debug_assert_eq!(crate::optimize_ops::page_size_of(&prefs), 50);
        debug_assert_eq!(
            state.borrow().engine.items().map_or(0, |stored| stored.len()),
            7,
            "the reset never touches the vault's records"
        );
    }
    dump(ui, state, "settings66.about-reset");

    close(ui);
    dump(ui, state, "settings17.closed");
}

/// ---- About (Task 5.12) -----------------------------------------------------

/// "Copy diagnostics" (`Settings.tsx` L2088-2107): version, the vault's
/// protection, the item count and the whole preferences record when pretty
/// printed — deliberately *not* the TS's `userAgent`, which a native build
/// has nothing true to report, and whose absence the JSON either way reads
/// as oversight rather than omission. `prefs` carries no secret: every
/// value in it is a dial the settings sheet itself shows.
pub fn about_copy_report(ui: &MainWindow, state: &Shared) {
    let (prefs, items, protection) = {
        let guard = state.borrow();
        (
            items::prefs_from(guard.engine.preferences()),
            guard.engine.items().map_or(0, |stored| stored.len()),
            guard.engine.protection().ok().flatten(),
        )
    };
    let report = serde_json::json!({
        "app": "colax-native",
        "version": env!("CARGO_PKG_VERSION"),
        "platform": std::env::consts::OS,
        "protection": match protection {
            Some(colax_core::VaultProtection::Password) => "password",
            Some(colax_core::VaultProtection::Device) => "device",
            None => "none",
        },
        "itemCount": items,
        "prefs": serde_json::to_value(&prefs).unwrap_or(serde_json::Value::Null),
    });
    let text = serde_json::to_string_pretty(&report).unwrap_or_default();
    if crate::platform::copy_text(&text) {
        crate::notice(ui, "Diagnostics copied");
    } else {
        crate::notice(ui, "The clipboard did not take the report");
    }
}

/// "Reset settings" (`Settings.tsx` L2114-2118): the shipped preferences
/// record, whole — the TS calls `set(DEFAULT_PREFERENCES)` with no confirm
/// and no toast, and so does this. Logins, channels, alarms and the protection
/// factor are all other records; only the look comes back to its defaults.
pub fn about_reset(ui: &MainWindow, state: &Shared) {
    write(ui, state, |prefs| {
        *prefs = VaultPreferences::default();
        true
    });
}

/// Whether the preferences' stored sidebar tree names a channel — the
/// untyped `sidebar` array the panel keeps in step (`stripChannel` /
/// `writeChannel` in the TS). Only the walk reads it.
#[cfg(debug_assertions)]
fn sidebar_lists(state: &Shared, id: &str) -> bool {
    let prefs = items::prefs_from(state.borrow().engine.preferences());
    prefs
        .extra
        .get("sidebar")
        .and_then(|value| value.as_array())
        .map(|entries| {
            entries
                .iter()
                .any(|entry| entry.get("id").and_then(|v| v.as_str()) == Some(id))
        })
        .unwrap_or(false)
}

/// Dev-only: the walk's photo and the screenshot target's, in one step --
/// write it, then store it through the reader an upload uses. One definition
/// of "a stored photo" for both.
#[cfg(debug_assertions)]
pub fn background_dev_photo(ui: &MainWindow, state: &Shared) {
    let path = crate::app_dir().join("dev-background.png");
    if write_dev_photo(&path).is_err() {
        ui.set_settings_bg_error("Could not write the dev photo.".into());
        return;
    }
    background_set_from_file(ui, state, &path);
}

/// The walk's photo: four flat quadrants with a corner-to-corner shade, big
/// enough to be unmistakable on a screenshot and small enough to encode in a
/// millisecond. Written where `background_set_from_file` can read it.
#[cfg(debug_assertions)]
fn write_dev_photo(path: &std::path::Path) -> Result<(), String> {
    let (width, height) = (640u32, 420u32);
    let mut image = image::RgbaImage::new(width, height);
    for (x, y, pixel) in image.enumerate_pixels_mut() {
        let (r, g, b) = match (x < width / 2, y < height / 2) {
            (true, true) => (58u8, 92u8, 160u8),
            (false, true) => (150, 78, 120),
            (true, false) => (46, 120, 110),
            (false, false) => (190, 140, 70),
        };
        let shade = ((x + y) % 32) as u8;
        *pixel = image::Rgba([
            r.saturating_add(shade),
            g.saturating_add(shade),
            b.saturating_add(shade),
            255,
        ]);
    }
    image.save(path).map_err(|error| error.to_string())
}

/// The id of the nth stored alarm, read straight off the document: the walk
/// needs it because `new_alarm_id` is random and the row model it clicks is
/// never on screen in a dump run.
#[cfg(debug_assertions)]
pub fn stored_alarm_id(state: &Shared, index: usize) -> String {
    let guard = state.borrow();
    items::prefs_from(guard.engine.preferences())
        .alarms
        .get(index)
        .map(|alarm| alarm.id.clone())
        .unwrap_or_default()
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
    // The Alarms tab in four words: how many alarms are stored, how many of
    // them ring, and the first row's time and days — "Every" or "Sun,Tue",
    // joined without the spaces the row itself prints so the dump line keeps
    // its own field boundaries.
    let (alarms_count, alarms_on, first_alarm_time, first_alarm_days) = {
        let first = prefs.alarms.first();
        (
            prefs.alarms.len(),
            prefs.alarms.iter().filter(|alarm| alarm.enabled).count(),
            first
                .map(|alarm| alarm.time.clone())
                .unwrap_or_else(|| "-".to_string()),
            first
                .map(|alarm| alarm_days_label(&alarm.days).replace(", ", ","))
                .unwrap_or_else(|| "-".to_string()),
        )
    };
    // The Security tab's stored half: what the vault's own factor actually
    // is in the document, next to the window's copy below.
    let (vsave_totp, vsave_passcode, vsave_questions) = (
        prefs.vault_security.totp.is_some(),
        prefs.vault_security.passcode.is_some(),
        prefs.vault_security.questions.len(),
    );
    // The Data and Backup tabs: the count the chip carries, the engine's own
    // count beside it, how many favorites the CSV's `true` cell would tick,
    // and the three sheets' state -- open flags, the export score, the
    // restore error.
    let (engine_items, favorites) = {
        let guard = state.borrow();
        match guard.engine.items() {
            Some(items) => (
                items.len(),
                items.iter().filter(|item| item.favorite).count(),
            ),
            None => (0, 0),
        }
    };
    let line = format!(
        "{tag}: open={} tab={}({}) frame={}x{} panel={} theme=[{}] accent=[{}] density=[{}] motion={} speed={} ambient={} scale={} round={} depth={} reduce={} contrast={} chips={} lay=[{} {} {} {}] chrome={}{}{}{}{}{}{}{}{} hidden={} shell=[{} {} {} {}{}{}] desk=[{}{}{}{}] gen=[{} {} {} {} {} {}] alarms=[{} {} {} {}] sec=[{} {} {} {} {} {} {}{}{}{}{}{}{}{}{}] kdf=[{}] vsec=[{} {} {} {} {}] vsave=[{} {} {} {}] persisted=[{},{},{},{},{}] store=[{},{},{},{},{},{}] data=[{} {} {} {} {} {} {} {}] chan=[{} {} {} {} {} {} {} {} {} {} {} {} {} {} {}] bg=[{} {} {} {}] app=[{} {} {}] opt=[{},{},{},{},{},{},{}]\n",
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
        ui.get_show_new_login() as i32,
        ui.get_show_lock() as i32,
        ui.get_show_settings_button() as i32,
        ui.get_settings_desk_launch_at_login() as i32,
        ui.get_settings_desk_tray() as i32,
        ui.get_settings_desk_close_to_tray() as i32,
        ui.get_settings_desk_mute() as i32,
        ui.get_settings_gen_length() as i32,
        ui.get_settings_gen_lower() as i32,
        ui.get_settings_gen_upper() as i32,
        ui.get_settings_gen_digits() as i32,
        ui.get_settings_gen_symbols() as i32,
        ui.get_settings_gen_avoid() as i32,
        alarms_count,
        alarms_on,
        first_alarm_time,
        first_alarm_days,
        // The Security tab: the lit group, the six picks and nine switches
        // as the window holds them, the KDF chip, the vault form's five
        // read-outs, and the stored factor beside them.
        ui.get_settings_sec_group(),
        ui.get_settings_sec_auto_lock(),
        ui.get_settings_sec_clipboard(),
        ui.get_settings_sec_pw_age(),
        ui.get_settings_sec_email_age(),
        ui.get_settings_sec_email_check(),
        ui.get_settings_sec_clear_on_lock() as i32,
        ui.get_settings_sec_clip_capture() as i32,
        ui.get_settings_sec_clip_autosave() as i32,
        ui.get_settings_sec_warn_reuse() as i32,
        ui.get_settings_sec_tag_reused() as i32,
        ui.get_settings_sec_mask_emails() as i32,
        ui.get_settings_sec_confirm_export() as i32,
        ui.get_settings_sec_confirm_deletes() as i32,
        ui.get_settings_sec_copy_toasts() as i32,
        ui.get_settings_sec_kdf(),
        ui.get_settings_vsec_level(),
        ui.get_settings_vsec_totp() as i32,
        ui.get_settings_vsec_totp_staged() as i32,
        ui.get_settings_vsec_passcode() as i32,
        slint::Model::row_count(&ui.get_settings_vsec_questions()),
        security_level(&prefs.vault_security),
        vsave_totp as i32,
        vsave_passcode as i32,
        vsave_questions,
        prefs.theme,
        prefs.text_scale,
        prefs.accent,
        prefs.high_contrast,
        // The Backup tab's switch, as the document holds it: the walk's
        // lean/full export block turns it off and on again.
        prefs.backup_with_settings as i32,
        prefs.view,
        prefs.sort,
        prefs.sidebar_labels,
        prefs.sidebar_position,
        prefs.show_new_login_button as i32,
        prefs.show_sidebar as i32,
        ui.get_settings_data_count(),
        engine_items,
        favorites,
        ui.get_settings_data_protect_open() as i32,
        ui.get_settings_data_export_score(),
        (!ui.get_settings_data_restore_name().is_empty()) as i32,
        (!ui.get_settings_data_restore_error().is_empty()) as i32,
        ui.get_settings_data_restore_ready() as i32,
        // The Channels tab (Task 5.10) and the editor: the panel's two
        // models, how many rows are off the rail, and then the open modal --
        // which flow, the draft's name, kind, selected tags, icon, hue,
        // accent, whether it has a picture and where its mail comes from.
        slint::Model::row_count(&ui.get_settings_chan_rows()),
        slint::Model::row_count(&ui.get_settings_chan_tag_rows()),
        prefs.hidden_channels.len(),
        ui.get_channel_ed_open() as i32,
        ui.get_channel_ed_is_new() as i32,
        ui.get_channel_ed_name(),
        ui.get_channel_ed_kind_index(),
        selected_tag_count(&ui.get_channel_ed_tag_rows()),
        ui.get_channel_ed_icon(),
        ui.get_channel_ed_hue(),
        ui.get_channel_ed_accent(),
        ui.get_channel_ed_has_image() as i32,
        ui.get_channel_ed_image_opacity(),
        ui.get_channel_ed_show_mail() as i32,
        slint::Model::row_count(&ui.get_channel_ed_account_ids()),
        // The Background tab as the window holds it -- the flag, the three
        // dials -- and then the app's own layer, which is the only proof
        // that a stored photo actually reached the screen: the size Slint
        // decoded it to, the opacity it is painted at, and the wash.
        ui.get_settings_bg_has_image() as i32,
        ui.get_settings_bg_opacity(),
        ui.get_settings_bg_blur(),
        ui.get_settings_bg_dim(),
        ui.get_app_bg().size().width,
        ui.get_app_bg_opacity(),
        ui.get_app_bg_dim(),
        // The Optimize tab: the counter's own reading, the saved profiles and
        // the active name, then the three store-side Optimize keys with the
        // untyped page size. A counter that disagreed with the switches it
        // counted was the trap the TS module was written to close, so the
        // number and the rows are printed side by side.
        ui.get_settings_opt_count_on(),
        prefs.optimize_profiles.len() as i32,
        prefs.active_optimize_profile.as_str(),
        prefs.micro_motion as i32,
        prefs.disable_spellcheck as i32,
        prefs.mail_inline_images as i32,
        crate::optimize_ops::page_size_of(&prefs),
    );
    let path = crate::app_dir().join("dev-dump.txt");
    let mut existing = std::fs::read_to_string(&path).unwrap_or_default();
    existing.push_str(&line);
    let _ = std::fs::write(path, existing);
}

/// How many tag chips the editor has lit, across the packed lines of its
/// cloud. A model of models cannot be counted with one `row_count`, and the
/// dump's `chan=` group wants the number rather than the shape.
#[cfg(debug_assertions)]
fn selected_tag_count(rows: &slint::ModelRc<slint::ModelRc<crate::PickTag>>) -> i32 {
    use slint::Model;
    let mut count = 0;
    for line in rows.iter() {
        for tag in line.iter() {
            if tag.selected {
                count += 1;
            }
        }
    }
    count
}

/// The other copy of the four shell flags: `shell.json` as it now stands on
/// disk, beside the vault's own four and whether they agree. A dump of the
/// vault's copy alone cannot show the mirror -- and the shell file is the one
/// the next launch reads for tray behaviour, before any password is typed.
#[cfg(debug_assertions)]
fn dump_shell(state: &Shared, tag: &str) {
    let shell = crate::read_state();
    let prefs = {
        let guard = state.borrow();
        items::prefs_from(guard.engine.preferences())
    };
    let agree = shell.tray_enabled == prefs.tray_enabled
        && shell.close_to_tray == prefs.close_to_tray
        && shell.launch_at_login == prefs.launch_at_login
        && shell.sounds_muted == prefs.sounds_muted;
    let line = format!(
        "{tag}: file=[{}{}{}{}] prefs=[{}{}{}{}] agree={}\n",
        shell.tray_enabled as i32,
        shell.close_to_tray as i32,
        shell.launch_at_login as i32,
        shell.sounds_muted as i32,
        prefs.tray_enabled as i32,
        prefs.close_to_tray as i32,
        prefs.launch_at_login as i32,
        prefs.sounds_muted as i32,
        agree,
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
        let rows = hidden_rows(&prefs, &[]);
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
        let rows = hidden_rows(&prefs, &[]);

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
    fn the_security_panel_keys_reach_their_fields() {
        // The Security panel's fourteen simple rows: five pickers through
        // `string_key`, nine switches through `bool_key`. Each key below is
        // one settings.slint sends, and the panel and the handler are two
        // files — a typo between them would be a row that looks alive and
        // writes nothing.
        let mut prefs = VaultPreferences::default();

        // The switches (Settings.tsx L1321-1432).
        for key in [
            "clearClipboardOnLock",
            "clipboardCapture",
            "clipboardAutoSave",
            "warnOnReuse",
            "autoTagReused",
            "maskEmails",
            "confirmBeforeExport",
            "confirmDeletes",
            "copyToasts",
        ] {
            assert!(bool_key(&mut prefs, key, false), "{key} is not a switch");
        }
        assert!(!prefs.clear_clipboard_on_lock && !prefs.confirm_deletes);
        assert!(bool_key(&mut prefs, "clearClipboardOnLock", true));
        assert!(prefs.clear_clipboard_on_lock);
        // A near-miss is refused rather than guessed at.
        assert!(!bool_key(&mut prefs, "clipboardDetection", true));

        // The pickers, each with a value outside its whitelist left alone.
        // The values are the `<Select>` strings, so they parse into the
        // typed fields.
        assert!(string_key(&mut prefs, "auto-lock", "30"));
        assert_eq!(prefs.auto_lock_minutes, 30);
        assert!(!string_key(&mut prefs, "auto-lock", "45"));
        assert_eq!(prefs.auto_lock_minutes, 30);

        assert!(string_key(&mut prefs, "clear-clipboard", "120"));
        assert_eq!(prefs.clear_clipboard_seconds, 120.0);
        assert!(!string_key(&mut prefs, "clear-clipboard", "20"));
        assert_eq!(prefs.clear_clipboard_seconds, 120.0);

        assert!(string_key(&mut prefs, "password-age", "730"));
        assert_eq!(prefs.password_age_days, 730);
        assert!(!string_key(&mut prefs, "password-age", "3650"));
        assert_eq!(prefs.password_age_days, 730);

        // The two email lists are their own whitelists: 365 is a
        // password-age choice and 45 is nobody's.
        assert!(string_key(&mut prefs, "email-age", "365"));
        assert_eq!(prefs.email_age_days, 365);
        assert!(!string_key(&mut prefs, "email-age", "30"));
        assert_eq!(prefs.email_age_days, 365);

        assert!(string_key(&mut prefs, "email-check", "180"));
        assert_eq!(prefs.email_check_days, 180);
        assert!(!string_key(&mut prefs, "email-check", "45"));
        assert_eq!(prefs.email_check_days, 180);
    }

    #[test]
    fn the_kdf_chip_reads_like_to_locale_string() {
        // `PBKDF2_ITERATIONS.toLocaleString()` -> "600,000" (Settings.tsx
        // L1298). Slint has no number formatter, so the commas are put in
        // here; the groups have to sit where the TS's own print puts them.
        assert_eq!(thousands(600_000), "600,000");
        assert_eq!(thousands(1_000), "1,000");
        assert_eq!(thousands(999), "999");
        assert_eq!(thousands(1_234_567), "1,234,567");
    }

    #[test]
    fn the_desktop_panel_keys_are_the_shell_flags() {
        // The Desktop tab's four switches are the only preferences the tray
        // reads before a vault is unlocked, which makes them the only four
        // main.rs mirrors into shell.json after a write. A fifth key here, or
        // one missing there, would be a switch that looks alive in Settings
        // and a tray that disagrees with it on the next launch.
        let mut prefs = VaultPreferences::default();
        for key in [
            "launchAtLogin",
            "trayEnabled",
            "closeToTray",
            "soundsMuted",
        ] {
            assert!(is_shell_flag(key), "{key} is a shell flag");
            assert!(bool_key(&mut prefs, key, true), "{key} is not a switch");
        }
        assert!(prefs.launch_at_login && prefs.tray_enabled);
        assert!(prefs.close_to_tray && prefs.sounds_muted);

        // A near miss is refused rather than guessed at, so nothing can be
        // half-mirrored: the vault write and the shell file share this table.
        assert!(!is_shell_flag("trayenabled"));
        assert!(!bool_key(&mut prefs, "trayenabled", false));

        // Every other switch is a vault matter only.
        assert!(!is_shell_flag("showSidebar"));
        assert!(!is_shell_flag("highContrast"));
    }

    #[test]
    fn the_generator_panel_keys_reach_the_object() {
        // The five `gen-` keys settings.slint sends, in panel order. They are
        // the one set of boolean keys that is not a flat field: each lands in
        // `passwordGenerator`, and the object's own rule runs on the way in.
        let mut prefs = VaultPreferences::default();
        prefs.password_generator.length = 48;

        assert!(bool_key(&mut prefs, "gen-lower", false));
        assert!(!prefs.password_generator.lower);
        assert!(bool_key(&mut prefs, "gen-avoid", false));
        assert!(!prefs.password_generator.avoid_ambiguous);
        // The length is not a character set: three sets off still leaves the
        // user's own object, length included.
        assert!(bool_key(&mut prefs, "gen-upper", false));
        assert!(bool_key(&mut prefs, "gen-digits", false));
        assert_eq!(prefs.password_generator.length, 48);
        assert!(prefs.password_generator.symbols);

        // The fourth set: nothing can generate, so the store answers with the
        // shipped defaults -- and takes the length with them, the way
        // storage.ts L1449-1451 puts the whole object back.
        assert!(bool_key(&mut prefs, "gen-symbols", false));
        assert_eq!(
            prefs.password_generator,
            colax_core::PasswordGenerator::default()
        );

        // From the defaults one switch still moves on its own.
        assert!(bool_key(&mut prefs, "gen-lower", false));
        assert!(!prefs.password_generator.lower);
        assert!(prefs.password_generator.upper);

        // A near miss is refused rather than guessed at, so a panel typo
        // cannot quietly change the generator.
        assert!(!bool_key(&mut prefs, "gen-lookalikes", false));
        assert!(!bool_key(&mut prefs, "generator.lower", false));
        assert!(!prefs.password_generator.lower);
    }

    #[test]
    fn an_alarm_row_reads_the_way_the_ts_reads_it() {
        // A row's three cells: `alarm.label || 'No label'`, the time as
        // stored, and `days.length === 0 ? 'Every day' : DAY_LABELS.join(', ')`
        // (AlarmsPanel.tsx L70-73).
        assert_eq!(alarm_row_label("Gym"), "Gym");
        assert_eq!(alarm_row_label(""), "No label");
        assert_eq!(alarm_days_label(&[]), "Every day");
        assert_eq!(alarm_days_label(&[0]), "Sun");
        // Click order is display order -- `[...days, day]` appends -- not the
        // calendar's.
        assert_eq!(alarm_days_label(&[2, 1]), "Tue, Mon");
        // A day the store would have dropped already (normalise_alarms keeps
        // 0..=6) is skipped rather than printed as the TS's `undefined`.
        assert_eq!(alarm_days_label(&[9]), "");

        // The card's seven chips: Sun..Sat, lit where the draft has them.
        let chips = day_chips(&[3]);
        assert_eq!(chips.len(), 7);
        assert_eq!(chips[0].label.as_str(), "Sun");
        assert!(!chips[0].on);
        assert!(chips[3].on);
        assert_eq!(chips[6].label.as_str(), "Sat");
    }

    #[test]
    fn a_sound_data_url_gets_the_mime_its_extension_wants() {
        // The browser guesses from the extension; anything it does not know
        // is `application/octet-stream`, which the decoder ignores (the
        // bytes are sniffed either way).
        let mime = |name: &str| sound_mime(std::path::Path::new(name));
        assert_eq!(mime("chime.wav"), "audio/wav");
        assert_eq!(mime("Anthem.MP3"), "audio/mpeg");
        assert_eq!(mime("bell.ogg"), "audio/ogg");
        assert_eq!(mime("tone.flac"), "audio/flac");
        assert_eq!(mime("ring.m4a"), "audio/mp4");
        assert_eq!(mime("ding"), "application/octet-stream");
        assert_eq!(mime("odd.xyz"), "application/octet-stream");
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

    #[test]
    fn the_csv_writes_the_frames_the_typescript_writes() {
        // `escape` doubles every `"` and wraps the cell (Settings.tsx L424);
        // the header is fixed and rows join with plain newlines. The second
        // argument is the item's clock, which lands in `created` verbatim.
        let item = colax_core::normalise_item(
            &serde_json::json!({
                "title": "Comma, \"quoted\"",
                "url": "https://one.test",
                "username": "ann",
                "password": "pw",
                "notes": "line",
                "favorite": true,
            }),
            1_767_255_697_123,
        );

        let text = csv_text(&[item]);
        let mut lines = text.lines();
        assert_eq!(
            lines.next().unwrap(),
            "name,url,username,password,notes,favorite,created"
        );
        assert_eq!(
            lines.next().unwrap(),
            "\"Comma, \"\"quoted\"\"\",\"https://one.test\",\"ann\",\"pw\",\"line\",\"true\",\"2026-01-01T08:21:37.123Z\""
        );
        assert_eq!(lines.next(), None, "no trailing newline");
    }

    #[test]
    fn the_csv_reader_unquotes_what_the_writer_quoted() {
        let item = colax_core::normalise_item(
            &serde_json::json!({
                "title": "Comma, \"quoted\"",
                "url": "https://one.test",
                "username": "ann",
                "password": "pw",
                "notes": "a, b",
                "favorite": true,
            }),
            1_767_255_697_123,
        );

        // The row the writer made must survive the reader: commas inside
        // cells stay, doubled quotes become one, separators still split.
        let text = csv_text(&[item]);
        let cells = csv_cells(text.lines().nth(1).unwrap());
        assert_eq!(cells.len(), 7);
        assert_eq!(cells[0], "Comma, \"quoted\"");
        assert_eq!(cells[1], "https://one.test");
        assert_eq!(cells[4], "a, b");
        assert_eq!(cells[5], "true");

        // Unquoted text passes through untouched; an empty line is one
        // empty cell, the way the TS reader leaves it.
        assert_eq!(csv_cells("a,b"), vec!["a", "b"]);
        assert_eq!(csv_cells(""), vec![""]);
    }
}
