//! Settings › Optimize (Task 5.11): the tab's four groups, its presets and
//! its saved profiles — `Settings.tsx`'s `optimizeGroup` block, L1599-2066.
//!
//! The vocabulary lives in `colax-core::optimize`: the presets, the ten
//! switches the counter counts and the style conversions. This module is only
//! the wiring — each row writes through `settings_ops::write`, so the panel,
//! the document and any backup exported later all move at once, exactly as
//! the TS's `set` did through `savePreferences`.
//!
//! Three deviations, all about the machine the TS runs on:
//! - The Speed group's "Low-memory mode" and "Hardware acceleration"
//!   (Settings.tsx L1929-1971) are Chromium trades; the TS renders them only
//!   where `runtime.efficiency` exists, and a native build has no such
//!   runtime — so they are gone and the group is the spellcheck switch alone.
//! - "What it costs right now" reads this process's working set and private
//!   bytes (see `platform::memory_snapshot`). No engine tree, so the
//!   per-process breakdown, the element count and the blur count have
//!   nothing to report and are not shown.
//! - The spellcheck switch is stored and counted here, and takes effect when
//!   the mail phases bring the editable text they touch (the TS's dictionary
//!   belongs to the shell it was running in).

use serde_json::{json, Value};
use slint::{ModelRc, VecModel};

use colax_core::optimize::{
    apply_style, clean_profile_name, new_optimize_profile_id, optimisations_on, snapshot_style,
    MAX_OPTIMIZE_PROFILES,
};
use colax_core::{util, OptimizeProfile, VaultPreferences};

use crate::dashboard::short_date;
use crate::items;
use crate::settings_ops;
use crate::{notice, MainWindow, OptProfileRow, Shared};

/// Pushes every panel reading the document can answer. Called from the
/// settings refresh, so one write anywhere redraws this tab against what is
/// stored rather than drifting into guessing.
pub fn push_panel(ui: &MainWindow, state: &Shared) {
    let prefs = {
        let guard = state.borrow();
        items::prefs_from(guard.engine.preferences())
    };
    push_panel_from(ui, &prefs);
}

/// The same push from a preferences record already in hand — the walk uses
/// it so its dumps read off the same record the panel was drawn from.
pub fn push_panel_from(ui: &MainWindow, prefs: &VaultPreferences) {
    ui.set_settings_opt_count_on(optimisations_on(prefs) as i32);
    ui.set_settings_opt_snapshotted(prefs.optimize_snapshot.is_some());
    ui.set_settings_opt_active_profile(prefs.active_optimize_profile.as_str().into());

    // The Look rows. The two compound ones read like their TS `checked`
    // expression (`prefs.motion <= 0.001`, `prefs.ambient <= 0.05` — the
    // slider itself stays where Appearance owns it).
    ui.set_settings_opt_motion_off(prefs.motion <= 0.001);
    ui.set_settings_opt_micro(prefs.micro_motion);
    ui.set_settings_opt_ambient_off(prefs.ambient <= 0.05);
    ui.set_settings_opt_flat(prefs.card_depth <= 0.05);
    ui.set_settings_opt_no_picture(prefs.background_image.is_empty());
    // The plain ones mirror their field directly.
    ui.set_settings_opt_transparency(prefs.reduce_transparency);
    ui.set_settings_opt_compact(prefs.density == "compact");

    // The Messages rows. The mail row's checked state comes from the same
    // OPTIMISATIONS entry the counter counts, so a row, its lock and the
    // readout cannot disagree; the page size and the cache are untyped until
    // Task 9.1 models them, and read the way `channels_ops` reads the
    // accounts.
    let mail_on = colax_core::OPTIMISATIONS
        .iter()
        .find(|entry| entry.id == "mail")
        .map(|entry| (entry.on)(prefs))
        .unwrap_or(true);
    ui.set_settings_opt_mail_on(mail_on);
    ui.set_settings_opt_mail_locked(
        prefs
            .extra
            .get("gmailAccounts")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0)
            == 0,
    );
    ui.set_settings_opt_mail_images(prefs.mail_inline_images);
    ui.set_settings_opt_spellcheck(prefs.disable_spellcheck);
    let page = prefs
        .extra
        .get("mailPageSize")
        .and_then(Value::as_i64)
        .unwrap_or(50);
    ui.set_settings_opt_page_size(format!("{page}").into());
    ui.set_settings_opt_cache_empty(
        prefs
            .extra
            .get("mailCache")
            .and_then(Value::as_object)
            .map_or(true, |cache| cache.is_empty()),
    );

    // The readout, assembled the way the TS template text assembled it.
    let count = optimisations_on(prefs);
    ui.set_settings_opt_readout(
        format!(
            "{} of 10 optimisations on right now.{}{}",
            count,
            if count == 0 {
                " Everything is running at full detail. "
            } else {
                " "
            },
            if prefs.optimize_snapshot.is_some() {
                "Restore my look puts back exactly what was here before you traded anything away."
            } else {
                "Trading anything away records what you had first, so Restore my look can undo it."
            }
        )
        .into(),
    );

    // Saved profiles, newest first the way the store keeps them.
    let rows: Vec<OptProfileRow> = prefs
        .optimize_profiles
        .iter()
        .map(|profile| OptProfileRow {
            id: profile.id.clone().into(),
            name: profile.name.clone().into(),
            meta: format!("saved {}", short_date(profile.created_at)).into(),
            active: prefs.active_optimize_profile == profile.name,
        })
        .collect();
    ui.set_settings_opt_profiles(ModelRc::new(VecModel::from(rows)));
    ui.set_settings_opt_can_save(prefs.optimize_profiles.len() < MAX_OPTIMIZE_PROFILES);

    push_metrics(ui);
}

/// The two readings under "What it costs right now". Pushed on every refresh
/// as well as on "Measure again" — the numbers are a single `GetProcessMemoryInfo`
/// call, and a panel that needs a button press to notice the app just did
/// something is the wrong one for a build with no virtual memory to hide.
pub fn push_metrics(ui: &MainWindow) {
    let snapshot = crate::platform::memory_snapshot();
    match snapshot {
        Some(readings) => {
            ui.set_settings_opt_work(format_bytes(readings.working_set).into());
            ui.set_settings_opt_priv(format_bytes(readings.private_bytes).into());
        }
        None => {
            // The dash the TS prints for a platform with no reading — and a
            // zero is a legal reading, "no reading" is not one.
            ui.set_settings_opt_work("—".into());
            ui.set_settings_opt_priv("—".into());
        }
    }
}

/// `formatBytes` (useEfficiency.ts): bytes under a KiB, one decimal or a
/// rounded MB, and two decimals in GB.
pub(crate) fn format_bytes(bytes: u64) -> String {
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let mb = bytes as f64 / 1_048_576.0;
    if mb < 1024.0 {
        if mb < 10.0 {
            format!("{mb:.1} MB")
        } else {
            format!("{:.0} MB", mb.round())
        }
    } else {
        format!("{:.2} GB", mb / 1024.0)
    }
}

/// The shared tail of the two presets and a saved profile's Apply
/// (`applyStyle`, Settings.tsx L322): a first trade-away records what was
/// there *before* it, and everything after it is savings on top of savings —
/// re-snapshotting would replace the real "before" with an already-reduced
/// look.
fn apply_look(
    ui: &MainWindow,
    state: &Shared,
    style: &colax_core::OptimizeStyle,
    active: &str,
    note: &str,
) {
    // One read answers all three questions the write will ask: what the
    // before-look is (recorded if this is the first trade-away), whether a
    // snapshot was already in force, and what the counter was reading.
    let (first_trade, snapshot, before) = {
        let guard = state.borrow();
        let prefs = items::prefs_from(guard.engine.preferences());
        (
            prefs.optimize_snapshot.is_none(),
            snapshot_style(&prefs),
            optimisations_on(&prefs),
        )
    };
    settings_ops::write(ui, state, move |prefs| {
        apply_style(prefs, style);
        let after = optimisations_on(prefs);
        prefs.active_optimize_profile = active.into();
        if first_trade && after > before {
            prefs.optimize_snapshot = Some(snapshot.clone());
        }
        true
    });
    notice(ui, note);
}

/// The two named buttons. `active` is "" because neither of them *is* a
/// saved profile: applying one clears the tick, which is what the TS's
/// `appliedProfile = ''` default does.
pub fn preset_balanced(ui: &MainWindow, state: &Shared) {
    apply_look(ui, state, &colax_core::BALANCED_STYLE, "", "Balanced profile applied");
}

pub fn preset_max(ui: &MainWindow, state: &Shared) {
    apply_look(ui, state, &colax_core::MAX_SAVINGS_STYLE, "", "Maximum savings applied");
}

/// "Restore my look" and "Reset optimisations" are one handler with two
/// doors: the snapshot if there is one, else the shipped full-detail look
/// (`restoreLook`, Settings.tsx L339).
pub fn restore(ui: &MainWindow, state: &Shared) {
    let had = {
        let guard = state.borrow();
        items::prefs_from(guard.engine.preferences())
            .optimize_snapshot
            .is_some()
    };
    settings_ops::write(ui, state, |prefs| {
        let target = (*colax_core::FULL_DETAIL_STYLE).clone();
        let target = prefs
            .optimize_snapshot
            .clone()
            .unwrap_or(target);
        apply_style(prefs, &target);
        prefs.optimize_snapshot = None;
        prefs.active_optimize_profile = String::new();
        true
    });
    notice(
        ui,
        if had {
            "Your look is back"
        } else {
            "Appearance restored to full detail"
        },
    );
}

// ---- The Look group's compound rows ----------------------------------------
// Three switches write a pair (or a quartet) rather than one key, so they get
// their own handlers instead of the generic `pref_bool`. Each mirrors one TS
// `onChange`, with the shipped defaults it restores spelled out.

pub fn motion_toggled(ui: &MainWindow, state: &Shared) {
    let on = ui.get_settings_opt_motion_off();
    settings_ops::write(ui, state, |prefs| {
        prefs.motion = if on { 0.0 } else { 1.0 };
        prefs.motion_speed = if on { 1.0 } else { 2.0 };
        true
    });
}

pub fn ambient_toggled(ui: &MainWindow, state: &Shared) {
    let on = ui.get_settings_opt_ambient_off();
    settings_ops::write(ui, state, |prefs| {
        prefs.ambient = if on { 0.0 } else { 1.0 };
        true
    });
}

pub fn cards_toggled(ui: &MainWindow, state: &Shared) {
    let on = ui.get_settings_opt_flat();
    settings_ops::write(ui, state, |prefs| {
        prefs.card_depth = if on { 0.0 } else { 0.4 };
        true
    });
}

/// Removing the picture empties it *and* puts the three background dials on
/// their shipped values — the whole of the TS `onChange`, since a picture
/// removed with last week's 80% veil left behind would be a background the
/// Appearance tab did not set.
pub fn background_removed(ui: &MainWindow, state: &Shared) {
    settings_ops::write(ui, state, |prefs| {
        prefs.background_image = String::new();
        prefs.background_opacity = 0.35;
        prefs.background_blur = 0.0;
        prefs.background_dim = 0.25;
        true
    });
}

// ---- Saved profiles ---------------------------------------------------------

/// "Save current" (`saveProfile`, Settings.tsx L345): a duplicate name and
/// the twelfth profile are both refused with the reasons the TS gives, and a
/// save always makes the new profile the active one — the look on screen now
/// *is* the one just saved.
pub fn save_profile(ui: &MainWindow, state: &Shared) {
    let (name, exists, count) = {
        let guard = state.borrow();
        let prefs = items::prefs_from(guard.engine.preferences());
        let name = clean_profile_name(&ui.get_settings_opt_name(), "Untitled look");
        let exists = prefs
            .optimize_profiles
            .iter()
            .any(|entry| entry.name.to_lowercase() == name.to_lowercase());
        (name, exists, prefs.optimize_profiles.len())
    };
    if exists {
        notice(
            ui,
            &format!("A profile called \"{name}\" already exists — rename or delete it first."),
        );
        return;
    }
    if count >= MAX_OPTIMIZE_PROFILES {
        notice(
            ui,
            &format!("That is all {MAX_OPTIMIZE_PROFILES} profiles — delete one to make room."),
        );
        return;
    }
    settings_ops::write(ui, state, |prefs| {
        // `snapshot_style(prefs)` first: the style is the look as the save
        // found it, including the shared mail cadence, and the insert below
        // borrows the list mutably.
        let style = snapshot_style(prefs);
        prefs.optimize_profiles.insert(
            0,
            OptimizeProfile {
                id: new_optimize_profile_id(),
                name: name.clone(),
                created_at: util::now_ms(),
                style,
            },
        );
        prefs.active_optimize_profile = name.clone();
        true
    });
    ui.set_settings_opt_name("".into());
    notice(ui, &format!("Saved \"{name}\""));
}

/// Opens the rename box. The draft is the window's own `opt-rename` field, so
/// the rows never have to write back into a model — the commit reads it in.
pub fn rename_start(ui: &MainWindow, state: &Shared, id: &str) {
    let name = {
        let guard = state.borrow();
        items::prefs_from(guard.engine.preferences())
            .optimize_profiles
            .iter()
            .find(|entry| entry.id == id)
            .map(|entry| entry.name.clone())
            .unwrap_or_default()
    };
    ui.set_settings_opt_rename(name.as_str().into());
    ui.set_settings_opt_renamer(id.into());
}

/// Enter or "Save name" (`renameProfile`, Settings.tsx L369): the fallback
/// keeps the old name on an empty box, a *changed* name still has to be
/// unique, and a profile the user is standing in follows the rename so the
/// active tick keeps pointing at it.
pub fn rename_commit(ui: &MainWindow, state: &Shared, id: &str) {
    let take = {
        let guard = state.borrow();
        let prefs = items::prefs_from(guard.engine.preferences());
        let old = prefs
            .optimize_profiles
            .iter()
            .find(|entry| entry.id == id)
            .map(|entry| entry.name.clone());
        old.map(|old_name| {
            let name = clean_profile_name(&ui.get_settings_opt_rename(), &old_name);
            let taken = name.to_lowercase() != old_name.to_lowercase()
                && prefs
                    .optimize_profiles
                    .iter()
                    .any(|entry| entry.name.to_lowercase() == name.to_lowercase());
            (old_name, name, taken)
        })
    };
    let Some((old_name, name, taken)) = take else {
        ui.set_settings_opt_renamer("".into());
        return;
    };
    if taken {
        notice(ui, &format!("\"{name}\" is already taken."));
        return;
    }
    if name == old_name {
        ui.set_settings_opt_renamer("".into());
        return;
    }
    settings_ops::write(ui, state, |prefs| {
        if let Some(entry) = prefs
            .optimize_profiles
            .iter_mut()
            .find(|entry| entry.id == id)
        {
            entry.name = name.clone();
        }
        if prefs.active_optimize_profile == old_name {
            prefs.active_optimize_profile = name.clone();
        }
        true
    });
    ui.set_settings_opt_renamer("".into());
    notice(ui, &format!("Renamed to \"{name}\""));
}

pub fn rename_cancel(ui: &MainWindow) {
    ui.set_settings_opt_renamer("".into());
}

/// "Overwrite" points the profile at the look on screen now, stamp and all
/// (Settings.tsx L1722-1732).
pub fn overwrite_profile(ui: &MainWindow, state: &Shared, id: &str) {
    let name = {
        let guard = state.borrow();
        items::prefs_from(guard.engine.preferences())
            .optimize_profiles
            .iter()
            .find(|entry| entry.id == id)
            .map(|entry| entry.name.clone())
            .unwrap_or_default()
    };
    if name.is_empty() {
        return;
    }
    settings_ops::write(ui, state, |prefs| {
        let style = snapshot_style(prefs);
        let at = util::now_ms();
        if let Some(entry) = prefs
            .optimize_profiles
            .iter_mut()
            .find(|entry| entry.id == id)
        {
            entry.style = style;
            entry.created_at = at;
        }
        true
    });
    notice(ui, &format!("\"{name}\" updated to the current look"));
}

pub fn delete_profile(ui: &MainWindow, state: &Shared, id: &str) {
    let active = {
        let guard = state.borrow();
        let prefs = items::prefs_from(guard.engine.preferences());
        prefs
            .optimize_profiles
            .iter()
            .find(|entry| entry.id == id)
            .map(|entry| {
                let was_active = prefs.active_optimize_profile == entry.name;
                (entry.name.clone(), was_active)
            })
    };
    let Some((name, was_active)) = active else {
        return;
    };
    settings_ops::write(ui, state, |prefs| {
        prefs.optimize_profiles.retain(|entry| entry.id != id);
        if was_active {
            prefs.active_optimize_profile = String::new();
        }
        true
    });
    notice(ui, &format!("Deleted \"{name}\""));
}

/// A saved profile's Apply is the preset path with its own name and note.
pub fn apply_profile(ui: &MainWindow, state: &Shared, id: &str) {
    let found = {
        let guard = state.borrow();
        items::prefs_from(guard.engine.preferences())
            .optimize_profiles
            .iter()
            .find(|entry| entry.id == id)
            .cloned()
    };
    if let Some(profile) = found {
        // The TS disables the button on the active profile, so this only
        // fires for the others — but a click is still refused, not guessed.
        let note = format!("Applied \"{}\"", profile.name);
        let name = profile.name.clone();
        let style = profile.style;
        apply_look(ui, state, &style, &name, &note);
    }
}

// ---- The Messages group's untyped dials ------------------------------------

/// "Slower mail polling" stretches or restores every connected mailbox at
/// once (Settings.tsx L2011-2018): 900 seconds on, 300 off. Mail has no
/// engine of its own yet, so the accounts are the untyped records the
/// Address book stores.
pub fn mail_toggled(ui: &MainWindow, state: &Shared) {
    let on = ui.get_settings_opt_mail_on();
    let seconds = if on { 900 } else { 300 };
    settings_ops::write(ui, state, move |prefs| {
        if let Some(accounts) = prefs
            .extra
            .get_mut("gmailAccounts")
            .and_then(Value::as_array_mut)
        {
            for account in accounts {
                if let Some(record) = account.as_object_mut() {
                    record.insert("refreshSeconds".into(), json!(seconds));
                }
            }
        }
        true
    });
}

/// "Messages per page" — one of the three sizes the TS selects, landing in
/// `extra` until the mail phases model the field.
pub fn page_size_picked(ui: &MainWindow, state: &Shared, id: &str) {
    let size: i64 = id.parse().unwrap_or(50);
    settings_ops::write(ui, state, move |prefs| {
        if let Some(extra) = prefs.extra.as_object_mut() {
            extra.insert("mailPageSize".into(), json!(size));
        }
        true
    });
}

/// "Clear cached messages": one write of an empty map. The next open of a
/// message refetches it, so nothing is lost.
pub fn cache_clear(ui: &MainWindow, state: &Shared) {
    settings_ops::write(ui, state, |prefs| {
        if let Some(extra) = prefs.extra.as_object_mut() {
            extra.insert("mailCache".into(), json!({}));
        }
        true
    });
    notice(ui, "Cached messages cleared");
}

/// "Measure again": one fresh read.
pub fn measure(ui: &MainWindow) {
    push_metrics(ui);
}

/// The walk's read of the page-size pref, off the same record the panel drew
/// from. Only a dump run reaches this, hence the gate.
#[cfg(debug_assertions)]
pub fn page_size_of(prefs: &VaultPreferences) -> i64 {
    prefs
        .extra
        .get("mailPageSize")
        .and_then(Value::as_i64)
        .unwrap_or(50)
}
