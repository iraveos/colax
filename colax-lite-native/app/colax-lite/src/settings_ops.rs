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
use colax_core::totp::{
    current_totp_code, extract_totp_secret, generate_totp_seed, otpauth_url, qr_matrix, verify_totp,
};
use colax_core::{
    answer_too_weak, hash_answer, hash_passcode, passcode_too_weak, security_level, verify_answer,
    verify_passcode, Alarm, AlarmSound, LoginSecurity, VaultPreferences,
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
        "confirmDeletes" => &mut prefs.confirm_deletes,
        "copyToasts" => &mut prefs.copy_toasts,
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

    let code = state
        .borrow()
        .vault_staged_seed
        .clone()
        .and_then(|seed| current_totp_code(&seed).ok())
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

    close(ui);
    dump(ui, state, "settings17.closed");
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
    let line = format!(
        "{tag}: open={} tab={}({}) frame={}x{} panel={} theme=[{}] accent=[{}] density=[{}] motion={} speed={} ambient={} scale={} round={} depth={} reduce={} contrast={} chips={} lay=[{} {} {} {}] chrome={}{}{}{}{}{}{}{}{} hidden={} shell=[{} {} {} {}{}{}] desk=[{}{}{}{}] gen=[{} {} {} {} {} {}] alarms=[{} {} {} {}] sec=[{} {} {} {} {} {} {}{}{}{}{}{}{}{}{}] kdf=[{}] vsec=[{} {} {} {} {}] vsave=[{} {} {} {}] persisted=[{},{},{},{}] store=[{},{},{},{},{},{}]\n",
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
}
