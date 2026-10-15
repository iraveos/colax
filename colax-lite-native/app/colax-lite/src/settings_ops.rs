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
use crate::{save_prefs, AccentChip, MainWindow, Shared};
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
}

/// One settings write, whichever dial made it. The closure owns the
/// whitelist — it mutates the pref or declines the key, and a decline
/// writes nothing, the same refusal TS gets from its normaliser for a key
/// it does not know. A successful save pushes the values back.
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

/// A string dial: theme cards, the accent grid, the density pills.
pub fn pref_string(ui: &MainWindow, state: &Shared, key: &str, value: &str) {
    write(ui, state, |prefs| match key {
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
        _ => false,
    });
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
/// `set({ reduceTransparency })`.
pub fn pref_bool(ui: &MainWindow, state: &Shared, key: &str, value: bool) {
    write(ui, state, |prefs| match key {
        "reduceTransparency" => {
            prefs.reduce_transparency = value;
            true
        }
        "highContrast" => {
            prefs.high_contrast = value;
            true
        }
        _ => false,
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

    // An unknown key and an out-of-range jump must write nothing at all.
    pref_string(ui, state, "not-a-dial", "x");
    tab_picked(ui, 99);
    dump(ui, state, "settings5.refused");

    close(ui);
    dump(ui, state, "settings6.closed");
}

/// The settings half of a dump: the mount, the lit tab and the eleven
/// dials *as the window holds them*, plus the four values the walk just
/// wrote *as the engine stored them* — screen and storage on one line.
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
        "{tag}: open={} tab={}({}) frame={}x{} panel={} theme=[{}] accent=[{}] density=[{}] motion={} speed={} ambient={} scale={} round={} depth={} reduce={} contrast={} chips={} persisted=[{},{},{},{}]\n",
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
        prefs.theme,
        prefs.text_scale,
        prefs.accent,
        prefs.high_contrast,
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
