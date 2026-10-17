//! The appearance tuner (Task 8.4) — the right-edge slide-over that retunes
//! one view's card geometry while the cards change under it.
//!
//! Port of `src/ui/AppearancePanel.tsx`. Three things make it what it is, and
//! all three are the TS's: it is a *slide-over*, not a modal, so the cards stay
//! visible down the left while a slider is dragged; it writes every change
//! straight through to preferences, so there is no OK button to forget; and it
//! is *per view*, so Flow keeps its numbers when Orbit is tuned.
//!
//! The geometry it stores is `cardSize` (`colax_core::CardSize`), pushed to the
//! window as a handful of scalars (`tuner::push`) that the three card shapes
//! read. Nothing here touches the engine beyond preferences, so a drag is a
//! plain preference write like any other — and therefore undoable by moving
//! the slider back, exactly as the TS comment says.

use slint::{ModelRc, VecModel};

use crate::settings_ops::snap;
use crate::{MainWindow, Shared};

/// The five writable fields, with the slider step `AppearancePanel.tsx` gives
/// each (L135-200). The id is what the .slint sends back.
const SIZE_STEPS: [(&str, f64); 5] = [
    ("scale", 0.05),
    ("width", 10.0),
    ("minHeight", 4.0),
    ("aspect", 0.05),
    ("radius", 1.0),
];

/// A slider's own bounds, per view. Orbit's width is the ring's front card, so
/// its range is narrower than the fluid views'; List's minimum height tops out
/// lower because a list row is short by nature (L147-200).
fn bounds(view: &str, field: &str) -> (f64, f64) {
    let orbit = view == "carousel";
    let list = view == "basic";
    match field {
        "scale" => (0.6, 1.6),
        "width" => {
            if orbit {
                (220.0, 520.0)
            } else {
                (280.0, 1200.0)
            }
        }
        "aspect" => (0.6, 2.2),
        "minHeight" => {
            if list {
                (40.0, 220.0)
            } else {
                (60.0, 400.0)
            }
        }
        "radius" => (0.0, 48.0),
        _ => (0.0, 100.0),
    }
}

/// Open the tuner, optionally scoped to a view first: the `Card size ▸` menu
/// names a view and the panel opens already showing *that* view's numbers
/// (`openTuner`, App.tsx L1677-1685). Settings closes, since the two slide-overs
/// would otherwise stack.
pub(crate) fn open(ui: &MainWindow, state: &Shared, view: Option<&str>) {
    if let Some(target) = view {
        if target != ui.get_vault_view().as_str() {
            crate::view_picked(ui, state, target);
        }
    }
    ui.set_settings_open(false);
    ui.set_tuner_accents(ModelRc::new(VecModel::from(crate::settings_ops::accent_chips())));
    push(ui, state);
    ui.set_show_tuner(true);
}

/// Push the active view's card geometry and the tuner's own read-outs. Called
/// from `refresh_items`, so a view switch, a slider write and a Reset all land
/// here without each having to remember to.
pub(crate) fn push(ui: &MainWindow, state: &Shared) {
    let view = ui.get_vault_view().to_string();
    let (size, accent) = {
        let guard = state.borrow();
        let prefs = crate::items::prefs_from(guard.engine.preferences());
        let size = prefs
            .card_size
            .get(&view)
            .copied()
            .unwrap_or_else(|| colax_core::default_card_size(&view));
        (size, prefs.accent)
    };

    ui.set_card_scale(size.scale as f32);
    ui.set_card_width(size.width as f32);
    ui.set_card_min_height(size.min_height as f32);
    ui.set_card_aspect(size.aspect as f32);
    ui.set_card_radius(size.radius as f32);
    ui.set_card_surface(size.surface as f32);

    ui.set_tuner_orbit(view == "carousel");
    ui.set_tuner_view(view.as_str().into());
    ui.set_tuner_view_label(view_label(&view).into());
    ui.set_tuner_scale(size.scale as f32);
    ui.set_tuner_width(size.width as f32);
    ui.set_tuner_min_height(size.min_height as f32);
    ui.set_tuner_aspect(size.aspect as f32);
    ui.set_tuner_radius(size.radius as f32);
    ui.set_tuner_accent(accent.as_str().into());
}

/// One slider moved. The value is clamped to the control's own bounds and
/// snapped to its step before it is stored, so a drag can never leave an
/// in-between number behind (`snap`, the same helper the Settings sliders use).
pub(crate) fn size_changed(ui: &MainWindow, state: &Shared, field: &str, value: f32) {
    let Some((id, step)) = SIZE_STEPS.iter().find(|(id, _)| *id == field) else {
        return;
    };
    let view = ui.get_vault_view().to_string();
    let (min, max) = bounds(&view, field);
    let snapped = snap(value as f64, min, max, *step);
    let id = id.to_string();
    crate::settings_ops::write(ui, state, move |prefs| {
        let entry = prefs
            .card_size
            .entry(view.clone())
            .or_insert_with(|| colax_core::default_card_size(&view));
        match id.as_str() {
            "scale" => entry.scale = snapped,
            "width" => entry.width = snapped,
            "minHeight" => entry.min_height = snapped,
            "aspect" => entry.aspect = snapped,
            "radius" => entry.radius = snapped,
            _ => return false,
        }
        true
    });
}

/// One accent swatch. The accent is app-wide (the TS notes channels no longer
/// override it), so this is just the shared string dial.
pub(crate) fn accent_picked(ui: &MainWindow, state: &Shared, id: &str) {
    crate::settings_ops::pref_string(ui, state, "accent", id);
}

/// `Reset Flow to defaults`: the active view's shipped geometry (L236-238).
pub(crate) fn reset(ui: &MainWindow, state: &Shared) {
    let view = ui.get_vault_view().to_string();
    crate::settings_ops::write(ui, state, move |prefs| {
        prefs
            .card_size
            .insert(view.clone(), colax_core::default_card_size(&view));
        true
    });
}

/// The × button, or a click on the strip of window the panel does not cover.
pub(crate) fn close(ui: &MainWindow) {
    ui.set_show_tuner(false);
}

/// The label the panel's prose uses for a view (`VIEW_LABELS`, L27-32).
pub(crate) fn view_label(view: &str) -> &'static str {
    match view {
        "carousel" => "Orbit",
        "basic" => "List",
        "grid" => "Grid",
        _ => "Flow",
    }
}
