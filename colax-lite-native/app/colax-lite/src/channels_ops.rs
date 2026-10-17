//! Settings › Channels (Task 5.10) and the shared channel editor: the panel's
//! twelve actions, the tag catalogue underneath it, and the one modal both
//! the panel and (later) the rail open.
//!
//! Port of `ChannelManager.tsx` (the panel) and `ChannelEditor.tsx` (the
//! modal), with the writes flowing through `App.tsx`'s `writeChannel` /
//! `deleteChannel` (L925-963). The draft lives in `AppState`, not in Slint,
//! for the same reason the login editor's does: `Add channel` must hand back
//! exactly a `Channel`, and the tags it narrows by have to be checked against
//! the catalogue only Rust can see.
//!
//! Two dials the TS has are deliberately not ported, both noted at their
//! sites: the 350 ms `useDraftAutoSave` debounce (every other port dial
//! writes on the move) and `moveChannelToFolder` (folders are Phase 8).

use colax_core::channels::{apply_channel, create_channel, new_channel_id, Channel, ChannelAccent, ChannelKind, CHANNEL_ICONS};
use colax_core::{create_tag, VaultPreferences};use serde_json::json;
use slint::{ModelRc, VecModel};

use crate::items;
use crate::settings_ops;
use crate::{notice, AccentChip, ChannelRow, IconOption, MainWindow, Shared, TagRow};

/// The four kinds the editor offers, in the TS's order (`KIND_OPTIONS`).
/// Everything else the enum holds is structural (Dashboard, Mail, History),
/// vestigial (Tags, Unassigned) or reachable only from the rail — so a
/// channel can be edited into one of these four and no other.
const KIND_LABELS: [&str; 4] = ["Everything", "Favorites", "Needs attention", "Weak or reused"];
const KIND_HINTS: [&str; 4] = ["Every login", "Starred only", "Flagged", "Reused or old"];

/// The icon picker's glyphs, one per key in `CHANNEL_ICONS`. Slint has no
/// Lucide set, so each "icon" is a text glyph from the port's own alphabet —
/// including `clock`, which the TS's own table has no entry for and draws as
/// `layers`.
const ICON_GLYPHS: [&str; 10] = ["✉", "★", "⚑", "⛨", "≣", "⚷", "⚿", "☁", "⊞", "◷"];

/// Which of the four options a stored kind lights up, or `-1` for a kind with
/// no option — the TS's `aria-pressed={draft.kind === option.id}`, which
/// presses nothing for a Dashboard, a Mail or a Tagged channel.
fn kind_index(kind: &ChannelKind) -> i32 {
    match kind {
        ChannelKind::All => 0,
        ChannelKind::Favorites => 1,
        ChannelKind::Attention => 2,
        ChannelKind::Weak => 3,
        _ => -1,
    }
}

fn kind_from_index(index: i32) -> Option<ChannelKind> {
    match index {
        0 => Some(ChannelKind::All),
        1 => Some(ChannelKind::Favorites),
        2 => Some(ChannelKind::Attention),
        3 => Some(ChannelKind::Weak),
        _ => None,
    }
}

/// The accent chips the editor's Theme row draws: the same four the
/// Appearance panel does, from the same table, so the two cannot drift.
fn accent_chips() -> Vec<AccentChip> {
    settings_ops::accent_chips()
}

/// The connected mailboxes, read out of the preferences' untyped pocket
/// (`gmailAccounts`, storage.ts) — the mail engine that will model them is
/// Phase 9, so until then they are read as the `{ id, address }` pairs the
/// editor needs. A vault with none lists none, and the picker stays away.
fn mail_accounts(prefs: &VaultPreferences) -> Vec<(String, String)> {
    prefs
        .extra
        .get("gmailAccounts")
        .and_then(|value| value.as_array())
        .map(|accounts| {
            accounts
                .iter()
                .filter_map(|account| {
                    let object = account.as_object()?;
                    let id = object.get("id").and_then(|id| id.as_str())?;
                    if id.is_empty() {
                        return None;
                    }
                    let address = object
                        .get("address")
                        .and_then(|address| address.as_str())
                        .unwrap_or("")
                        .to_string();
                    Some((id.to_string(), address))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn icon_options() -> Vec<IconOption> {
    CHANNEL_ICONS
        .iter()
        .zip(ICON_GLYPHS)
        .map(|(key, glyph)| IconOption {
            key: (*key).into(),
            glyph: glyph.into(),
        })
        .collect()
}

/// The stored sidebar tree, as far as this port keeps it. Folders, separators
/// and drag order stay in the preferences' untyped `extra` pocket (Phase 8
/// owns the rail's own tree); this reads it so a channel that is created or
/// deleted can be added to or taken out of it, which is what makes the
/// document the web build reads back list the same rows.
fn sidebar_entries(prefs: &VaultPreferences) -> Vec<serde_json::Value> {
    prefs
        .extra
        .get("sidebar")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_else(|| {
            prefs
                .channels
                .iter()
                .map(|channel| json!({ "kind": "channel", "id": channel.id }))
                .collect()
        })
}

/// Removes every `channel` entry naming `id`, at the root and inside a
/// folder — `stripChannel` (App.tsx L136).
fn strip_channel(entries: Vec<serde_json::Value>, id: &str) -> Vec<serde_json::Value> {
    entries
        .into_iter()
        .filter_map(|entry| {
            let Some(object) = entry.as_object() else {
                return None;
            };
            match object.get("kind").and_then(|kind| kind.as_str()) {
                Some("channel") if object.get("id").and_then(|v| v.as_str()) == Some(id) => None,
                Some("folder") => {
                    let mut folder = object.clone();
                    let children = object
                        .get("children")
                        .and_then(|children| children.as_array())
                        .cloned()
                        .unwrap_or_default();
                    folder.insert("children".into(), json!(strip_channel(children, id)));
                    Some(serde_json::Value::Object(folder))
                }
                _ => Some(entry),
            }
        })
        .collect()
}

/* --------------------------------------------------------------------------
The panel

`ChannelManager.tsx`: one row per channel with its count and what its filter
is, the eye that takes a row off the rail, New channel / Hide all / Show all,
then the tag catalogue with its own rename, recolour and delete.
-------------------------------------------------------------------------- */

/// Everything the Channels panel draws. Called on open and after every write,
/// the way the other tabs' pushes are: the panel is a view of the document.
pub fn push_manager(ui: &MainWindow, state: &Shared) {
    let (prefs, logins, tag_editing, tag_hue) = {
        let guard = state.borrow();
        (
            items::prefs_from(guard.engine.preferences()),
            guard
                .engine
                .items()
                .map(|items| items.to_vec())
                .unwrap_or_default(),
            guard.channel_tag_editing.clone(),
            guard.channel_tag_hue.clone(),
        )
    };
    let stale = prefs.password_age_days as f64;

    let rows: Vec<ChannelRow> = prefs
        .channels
        .iter()
        .map(|channel| {
            let count = apply_channel(channel, &logins, stale).len();
            // `{count} · {kind label or the tags' names}` (L126-131). A tag
            // id with no catalogue entry prints "Missing tag", the TS's own
            // fallback.
            let detail = if channel.tag_ids.is_empty() {
                channel.kind.label().to_string()
            } else {
                channel
                    .tag_ids
                    .iter()
                    .map(|id| {
                        prefs
                            .tags
                            .iter()
                            .find(|tag| tag.id == *id)
                            .map(|tag| tag.name.clone())
                            .unwrap_or_else(|| "Missing tag".into())
                    })
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            ChannelRow {
                id: channel.id.clone().into(),
                name: channel.name.clone().into(),
                hue: items::hue_color(channel.hue),
                count: count as i32,
                detail: format!("{count} · {detail}").into(),
                builtin: channel.builtin,
                hidden: prefs.hidden_channels.iter().any(|id| id == &channel.id),
                locked: channel.locked,
            }
        })
        .collect();
    let hidden = prefs
        .channels
        .iter()
        .filter(|channel| prefs.hidden_channels.iter().any(|id| id == &channel.id))
        .count();
    ui.set_settings_chan_rows(ModelRc::new(VecModel::from(rows)));
    ui.set_settings_chan_can_hide_all(hidden < prefs.channels.len());
    ui.set_settings_chan_can_show_all(hidden > 0);

    let tag_rows: Vec<TagRow> = prefs
        .tags
        .iter()
        .map(|tag| {
            let used = prefs
                .channels
                .iter()
                .filter(|channel| channel.tag_ids.iter().any(|id| id == &tag.id))
                .count();
            TagRow {
                id: tag.id.clone().into(),
                name: tag.name.clone().into(),
                hue: items::hue_color(tag.hue.round() as i32),
                hue_value: tag.hue.round() as i32,
                usage: if used == 0 {
                    "unused".into()
                } else {
                    format!("{used} channel{}", if used == 1 { "" } else { "s" }).into()
                },
                editing: tag_editing.as_deref() == Some(tag.id.as_str()),
                hue_open: tag_hue.as_deref() == Some(tag.id.as_str()),
            }
        })
        .collect();
    ui.set_settings_chan_tag_rows(ModelRc::new(VecModel::from(tag_rows)));
    // `disabled={!newTagName.trim()}` — the trim is Rust's, and a button that
    // would accept a box of spaces as a tag is worse than one that waits.
    ui.set_settings_chan_tag_can_add(
        !ui.get_settings_chan_tag_input().to_string().trim().is_empty(),
    );
}

/// The add box changed. Only the verdict travels back: the text is already
/// `<=>`-bound, and reading it again here would give the two a way to
/// disagree.
pub fn tag_input_edited(ui: &MainWindow) {
    let can = !ui.get_settings_chan_tag_input().to_string().trim().is_empty();
    ui.set_settings_chan_tag_can_add(can);
}

/// `addTag()` (L65-75): trim, refuse a blank, refuse a name the catalogue
/// already has (case-insensitively) with the TS's toast, otherwise mint one
/// and clear the box.
pub fn tag_add(ui: &MainWindow, state: &Shared) {
    let trimmed = ui.get_settings_chan_tag_input().to_string().trim().to_string();
    if trimmed.is_empty() {
        return;
    }
    let prefs = items::prefs_from(state.borrow().engine.preferences());
    if prefs
        .tags
        .iter()
        .any(|tag| tag.name.to_lowercase() == trimmed.to_lowercase())
    {
        notice(ui, &format!("\"{trimmed}\" already exists"));
        return;
    }
    let tag = create_tag(&trimmed, &prefs.tags);
    settings_ops::write(ui, state, |prefs| {
        prefs.tags.push(tag);
        true
    });
    ui.set_settings_chan_tag_input("".into());
    push_manager(ui, state);
}

/// Clicking a tag's name opens the box that renames it (L238).
pub fn tag_rename_start(ui: &MainWindow, state: &Shared, id: &str) {
    state.borrow_mut().channel_tag_editing = Some(id.to_string());
    // Opening one row's colour range closes any other's, the way the TS's
    // two `useState` ids do.
    state.borrow_mut().channel_tag_hue = None;
    push_manager(ui, state);
}

/// `renameTag` (L80-85) as the box types: trim, ignore a blank, otherwise
/// write. The TS commits on blur; Slint has no blur, so the write is live and
/// the box closes on Enter (or on opening another tag). Nothing is ever lost
/// and the row always shows what is stored.
pub fn tag_renamed(ui: &MainWindow, state: &Shared, id: &str, name: &str) {
    let trimmed = name.trim().to_string();
    if trimmed.is_empty() {
        return;
    }
    let ok = settings_ops::write(ui, state, |prefs| {
        let Some(tag) = prefs.tags.iter_mut().find(|tag| tag.id == id) else {
            return false;
        };
        tag.name = trimmed;
        true
    });
    if ok {
        push_manager(ui, state);
    }
}

/// Enter in the rename box: the write already happened, this only closes it.
pub fn tag_rename_done(ui: &MainWindow, state: &Shared, id: &str) {
    {
        let mut guard = state.borrow_mut();
        if guard.channel_tag_editing.as_deref() == Some(id) {
            guard.channel_tag_editing = None;
        }
    }
    push_manager(ui, state);
}

/// The swatch opens that tag's colour range; a second click closes it (L264).
pub fn tag_hue_toggle(ui: &MainWindow, state: &Shared, id: &str) {
    let mut guard = state.borrow_mut();
    guard.channel_tag_hue = if guard.channel_tag_hue.as_deref() == Some(id) {
        None
    } else {
        Some(id.to_string())
    };
    guard.channel_tag_editing = None;
    drop(guard);
    push_manager(ui, state);
}

/// A drag on the colour range: 0..359, one degree at a time (L242-258).
pub fn tag_hue_changed(ui: &MainWindow, state: &Shared, id: &str, value: f64) {
    let hue = settings_ops::snap(value, 0.0, 359.0, 1.0);
    let ok = settings_ops::write(ui, state, |prefs| {
        let Some(tag) = prefs.tags.iter_mut().find(|tag| tag.id == id) else {
            return false;
        };
        tag.hue = hue;
        true
    });
    if ok {
        push_manager(ui, state);
    }
}

/// `deleteTag` (L87-97): name the channels that were watching it in a toast,
/// drop it from the catalogue, and scrub the id out of every login that
/// carries it — logins keep their own copy of the tag list, so an id left
/// behind would linger invisibly forever.
pub fn tag_delete(ui: &MainWindow, state: &Shared, id: &str) {
    let (name, used_by) = {
        let prefs = items::prefs_from(state.borrow().engine.preferences());
        let name = prefs
            .tags
            .iter()
            .find(|tag| tag.id == id)
            .map(|tag| tag.name.clone())
            .unwrap_or_default();
        let used: Vec<String> = prefs
            .channels
            .iter()
            .filter(|channel| channel.tag_ids.iter().any(|tag| tag == id))
            .map(|channel| channel.name.clone())
            .collect();
        (name, used)
    };
    if !used_by.is_empty() {
        notice(
            ui,
            &format!(
                "\"{name}\" is used by {} — it will be removed from {}",
                used_by.join(", "),
                if used_by.len() == 1 {
                    "that channel"
                } else {
                    "those channels"
                }
            ),
        );
    }
    let ok = settings_ops::write(ui, state, |prefs| {
        let before = prefs.tags.len();
        prefs.tags.retain(|tag| tag.id != id);
        // The channels' own `tagIds` go with it, or the channel would keep
        // narrowing by a tag nobody can see any more.
        for channel in prefs.channels.iter_mut() {
            channel.tag_ids.retain(|tag| tag != id);
        }
        before != prefs.tags.len()
    });
    if !ok {
        return;
    }
    scrub_tag_from_logins(ui, state, id);
    if state.borrow().channel_tag_editing.as_deref() == Some(id) {
        state.borrow_mut().channel_tag_editing = None;
    }
    if state.borrow().channel_tag_hue.as_deref() == Some(id) {
        state.borrow_mut().channel_tag_hue = None;
    }
    push_manager(ui, state);
}

/// `onScrubTag`: every login that carried the tag loses the id. A patch per
/// item, the way the editor's own tag list is written.
fn scrub_tag_from_logins(ui: &MainWindow, state: &Shared, id: &str) {
    let victims: Vec<(String, Vec<String>)> = {
        let guard = state.borrow();
        guard
            .engine
            .items()
            .map(|items| items.to_vec())
            .unwrap_or_default()
            .into_iter()
            .filter(|item| item.tags.iter().any(|tag| tag == id))
            .map(|item| {
                (
                    item.id.clone(),
                    item.tags
                        .iter()
                        .filter(|tag| *tag != id)
                        .cloned()
                        .collect::<Vec<_>>(),
                )
            })
            .collect()
    };
    if victims.is_empty() {
        return;
    }
    {
        let mut guard = state.borrow_mut();
        for (item_id, tags) in victims {
            let _ = guard.engine.update_item(&item_id, &json!({ "tags": tags }));
        }
    }
    crate::refresh_items(ui, state);
}

/// The eye: one channel joins or leaves `hiddenChannels`, and the toast names
/// which way (L54-60). Nothing is deleted, so the row stays in this panel.
pub fn toggle_hidden(ui: &MainWindow, state: &Shared, id: &str) {
    let (name, was_hidden) = {
        let prefs = items::prefs_from(state.borrow().engine.preferences());
        let name = prefs
            .channels
            .iter()
            .find(|channel| channel.id == id)
            .map(|channel| channel.name.clone())
            .unwrap_or_default();
        (
            name,
            prefs.hidden_channels.iter().any(|hidden| hidden == id),
        )
    };
    settings_ops::write(ui, state, |prefs| {
        if !prefs.channels.iter().any(|channel| channel.id == id) {
            return false;
        }
        prefs.hidden_channels.retain(|hidden| hidden != id);
        if !was_hidden {
            prefs.hidden_channels.push(id.to_string());
        }
        true
    });
    notice(
        ui,
        &if was_hidden {
            format!("\"{name}\" is back in the sidebar")
        } else {
            format!("\"{name}\" hidden from the sidebar")
        },
    );
    push_manager(ui, state);
}

/// `Hide all`: every channel id joins the list, and the toast counts them
/// (L158-170).
pub fn hide_all(ui: &MainWindow, state: &Shared) {
    let total = {
        let prefs = items::prefs_from(state.borrow().engine.preferences());
        prefs.channels.len()
    };
    let ok = settings_ops::write(ui, state, |prefs| {
        let ids: Vec<String> = prefs.channels.iter().map(|c| c.id.clone()).collect();
        prefs.hidden_channels = ids;
        true
    });
    if ok {
        notice(
            ui,
            &format!(
                "Hid {total} channel{} from the sidebar",
                if total == 1 { "" } else { "s" }
            ),
        );
    }
    push_manager(ui, state);
}

/// `Show all`: the list empties (L171-183).
pub fn show_all(ui: &MainWindow, state: &Shared) {
    let ok = settings_ops::write(ui, state, |prefs| {
        prefs.hidden_channels.clear();
        true
    });
    if ok {
        notice(ui, "Every channel is back in the sidebar");
    }
    push_manager(ui, state);
}

/* --------------------------------------------------------------------------
The editor

One modal with two jobs. `open` stages a draft (a clone of a stored channel,
or `createChannel('')` for a new one), every control writes into that draft
and — for an existing channel — through to the document, and `save` is the
only path that *adds* a channel, so a new one can never half-exist.
-------------------------------------------------------------------------- */

/// Opens the editor for a channel id, or `"new"` for the new-channel flow
/// (`onEditChannel`). An id that is not in the catalogue falls back to the
/// new flow, the TS's `?? null` (App.tsx L3537).
pub fn open(ui: &MainWindow, state: &Shared, id: &str) {
    let prefs = items::prefs_from(state.borrow().engine.preferences());
    let existing = prefs.channels.iter().find(|channel| channel.id == id).cloned();
    let draft = existing.clone().unwrap_or_else(|| create_channel(""));
    let is_new = existing.is_none();
    let draft_name = draft.name.clone();
    {
        let mut guard = state.borrow_mut();
        guard.channel_new = is_new;
        guard.channel_editing = if is_new { None } else { Some(id.to_string()) };
        guard.channel_draft = Some(draft);
        // The URL box starts on a stored `http(s)` source only: a photo that
        // came in through Upload is a data URL, and showing it as text would
        // be a wall of base64 the user never typed.
        guard.channel_ed_width = 0.0;
    }
    ui.set_channel_ed_image_url(
        draft_image_url(existing.as_ref())
            .as_str()
            .into(),
    );
    // The name box is seeded here and nowhere else: every later push leaves
    // it alone so a half-typed name is never settled back under the cursor,
    // and the draft's own name is only pushed to the preview. The TS's
    // `useState(channel?.name ?? createChannel('').name)`.
    ui.set_channel_ed_name(draft_name.as_str().into());
    // A fresh mount starts at the top of the form.
    ui.set_channel_ed_scroll_y(0.0);
    ui.set_channel_ed_open(true);
    push_editor(ui, state);
}

fn draft_image_url(existing: Option<&Channel>) -> String {
    existing
        .map(|channel| channel.background_image.clone())
        .filter(|image| image.starts_with("http"))
        .unwrap_or_default()
}

/// Closes the editor and drops the draft. An existing channel has already
/// been written as it was edited; a new one is simply discarded, which is
/// what Cancel means.
pub fn close(ui: &MainWindow, state: &Shared) {
    {
        let mut guard = state.borrow_mut();
        guard.channel_draft = None;
        guard.channel_editing = None;
        guard.channel_new = false;
        guard.channel_ed_width = 0.0;
    }
    ui.set_channel_ed_open(false);
    ui.set_channel_ed_error("".into());
}

/// The editor's tag cloud reported the width it was laid out at; the reply
/// comes back as rows packed for it. Widths that have not been measured yet
/// are ignored — `init` runs before the layout pass has given the element a
/// size, and packing for 0 would split every pill onto a line of its own.
pub fn relayout(ui: &MainWindow, state: &Shared, width: f32) {
    let width = f64::from(width);
    if !(240.0..=20_000.0).contains(&width) {
        return;
    }
    if state.borrow().channel_draft.is_none() {
        return;
    }
    state.borrow_mut().channel_ed_width = width;
    push_editor(ui, state);
}

/// Everything the editor draws, from the draft. The preview's count is
/// `applyChannel(draft).length` for an existing channel and *every* login for
/// a new one, which is what the TS passes as `itemCount` (App.tsx L3540-3547).
pub fn push_editor(ui: &MainWindow, state: &Shared) {
    let (draft, width, is_new) = {
        let guard = state.borrow();
        let Some(draft) = guard.channel_draft.clone() else {
            return;
        };
        (draft, guard.channel_ed_width, guard.channel_new)
    };
    let (prefs, logins) = {
        let guard = state.borrow();
        (
            items::prefs_from(guard.engine.preferences()),
            guard
                .engine
                .items()
                .map(|items| items.to_vec())
                .unwrap_or_default(),
        )
    };
    let stale = prefs.password_age_days as f64;
    let count = if is_new {
        logins.len()
    } else {
        apply_channel(&draft, &logins, stale).len()
    };

    ui.set_channel_ed_title(
        if is_new {
            "New channel".to_string()
        } else {
            format!("Edit {}", draft.name)
        }
        .as_str()
        .into(),
    );
    ui.set_channel_ed_is_new(is_new);
    // Delete is drawn for an existing channel that is not `locked` — the
    // *role*, not the badge: a shipped Favorites can go, a user's Dashboard
    // cannot (the TS gates on `locked`).
    ui.set_channel_ed_can_delete(!is_new && !draft.locked);
    ui.set_channel_ed_can_save(!draft.name.trim().is_empty());
    ui.set_channel_ed_preview_name(
        if draft.name.trim().is_empty() {
            "Channel name"
        } else {
            draft.name.trim()
        }
        .into(),
    );
    ui.set_channel_ed_dot(items::hue_color(draft.hue));
    ui.set_channel_ed_count(count as i32);
    let index = kind_index(&draft.kind);
    ui.set_channel_ed_kind_index(index);
    // The four labels travel from here so the options and the kind they
    // select cannot drift apart: the index the control reports is an index
    // into this list.
    ui.set_channel_ed_kind_options(ModelRc::new(VecModel::from(
        KIND_LABELS
            .iter()
            .map(|label| (*label).into())
            .collect::<Vec<slint::SharedString>>(),
    )));
    ui.set_channel_ed_kind_hint(
        KIND_HINTS
            .get(index.max(0) as usize)
            .filter(|_| index >= 0)
            .copied()
            .unwrap_or("")
            .into(),
    );
    ui.set_channel_ed_has_tags(!prefs.tags.is_empty());
    ui.set_channel_ed_tag_rows(crate::pack_tag_rows(&prefs.tags, &draft.tag_ids, width));
    ui.set_channel_ed_tag_hint(
        if draft.tag_ids.is_empty() {
            "No tag filter — this channel shows everything the filter above returns.".to_string()
        } else {
            format!(
                "Only logins carrying {} appear here.",
                if draft.tag_ids.len() == 1 {
                    "this tag"
                } else {
                    "these tags"
                }
            )
        }
        .as_str()
        .into(),
    );
    ui.set_channel_ed_icons(ModelRc::new(VecModel::from(icon_options())));
    ui.set_channel_ed_icon(draft.icon.as_str().into());
    ui.set_channel_ed_hue(draft.hue as f32);
    ui.set_channel_ed_hue_label(format!("{}°", draft.hue).as_str().into());
    ui.set_channel_ed_accents(ModelRc::new(VecModel::from(accent_chips())));
    ui.set_channel_ed_accent(draft.accent.as_str().into());
    ui.set_channel_ed_has_image(!draft.background_image.is_empty());
    ui.set_channel_ed_image_opacity(draft.background_opacity as f32);
    ui.set_channel_ed_image_blur(draft.background_blur as f32);
    ui.set_channel_ed_image_dim(draft.background_dim as f32);
    ui.set_channel_ed_show_mail(draft.show_mail);
    // `accounts.length > 1`: the picker only appears when there is a choice
    // to make, and "All connected mailboxes" is the one-entry answer.
    let accounts = mail_accounts(&prefs);
    ui.set_channel_ed_has_accounts(accounts.len() > 1);
    ui.set_channel_ed_account_ids(ModelRc::new(VecModel::from(
        accounts
            .iter()
            .map(|(id, _)| id.clone().into())
            .collect::<Vec<slint::SharedString>>(),
    )));
    ui.set_channel_ed_account_labels(ModelRc::new(VecModel::from(
        accounts
            .iter()
            .map(|(_, address)| {
                if address.is_empty() {
                    "(no address)".into()
                } else {
                    address.clone().into()
                }
            })
            .collect::<Vec<slint::SharedString>>(),
    )));
    // A stale id — an account that was disconnected while a channel still
    // named it — reads as "all", for display only, exactly as the TS coerces
    // it before rendering (ChannelEditor.tsx L446).
    let known = accounts.iter().any(|(id, _)| *id == draft.mail_account);
    ui.set_channel_ed_mail_account(
        if draft.mail_account == "all" || known {
            draft.mail_account.as_str()
        } else {
            "all"
        }
        .into(),
    );
}

/// Applies a change to the draft and, for an existing channel, writes it
/// through — `patch()` plus `useDraftAutoSave`. The 350 ms debounce is not
/// ported: every other dial in this app writes on the move, and a save that
/// lands between two keystrokes is one more write, not a different document.
fn patch<F>(ui: &MainWindow, state: &Shared, apply: F)
where
    F: FnOnce(&mut Channel),
{
    let (is_new, id) = {
        let mut guard = state.borrow_mut();
        let Some(draft) = guard.channel_draft.as_mut() else {
            return;
        };
        apply(draft);
        // A draft with no id would be dropped on the next read, so one is
        // minted here rather than relying on the caller (L135-137).
        if draft.id.is_empty() {
            draft.id = new_channel_id();
        }
        (guard.channel_new, guard.channel_editing.clone())
    };
    if !is_new {
        let Some(id) = id else { return };
        let draft = state.borrow().channel_draft.clone();
        if let Some(draft) = draft {
            let mut next = draft;
            next.name = next.name.trim().to_string();
            settings_ops::write(ui, state, |prefs| {
                let Some(slot) = prefs.channels.iter_mut().find(|c| c.id == id) else {
                    return false;
                };
                *slot = next;
                true
            });
        }
    }
    push_editor(ui, state);
}

/// The name box. `can-save` is the footer's gate; an existing channel writes
/// as it is typed.
pub fn name_edited(ui: &MainWindow, state: &Shared) {
    let name = ui.get_channel_ed_name().to_string();
    patch(ui, state, |draft| draft.name = name);
}

pub fn kind_picked(ui: &MainWindow, state: &Shared, index: i32) {
    let Some(kind) = kind_from_index(index) else {
        return;
    };
    patch(ui, state, |draft| draft.kind = kind);
}

/// One tag chip: joins or leaves the draft's `tagIds`, keeping catalogue
/// order rather than click order — the TS appends, but a channel's tags read
/// back as the catalogue's order in every list this app draws.
pub fn tag_toggled(ui: &MainWindow, state: &Shared, id: &str) {
    let known = items::prefs_from(state.borrow().engine.preferences())
        .tags
        .iter()
        .any(|tag| tag.id == id);
    if !known {
        return;
    }
    let order: Vec<String> = items::prefs_from(state.borrow().engine.preferences())
        .tags
        .iter()
        .map(|tag| tag.id.clone())
        .collect();
    patch(ui, state, |draft| {
        if let Some(at) = draft.tag_ids.iter().position(|tag| tag == id) {
            draft.tag_ids.remove(at);
        } else {
            draft.tag_ids.push(id.to_string());
        }
        draft.tag_ids.sort_by_key(|tag| {
            order
                .iter()
                .position(|known| known == tag)
                .unwrap_or(usize::MAX)
        });
    });
}

pub fn icon_picked(ui: &MainWindow, state: &Shared, key: &str) {
    if !CHANNEL_ICONS.contains(&key) {
        return;
    }
    let key = key.to_string();
    patch(ui, state, |draft| draft.icon = key);
}

pub fn hue_changed(ui: &MainWindow, state: &Shared, value: f64) {
    let hue = settings_ops::snap(value, 0.0, 359.0, 1.0) as i32;
    patch(ui, state, |draft| draft.hue = hue);
}

pub fn accent_picked(ui: &MainWindow, state: &Shared, id: &str) {
    let Some(accent) = ChannelAccent::parse(id) else {
        return;
    };
    patch(ui, state, |draft| draft.accent = accent);
}

/// The image URL box. Text that is empty or a bare `http(s)` URL is stored;
/// anything else is left in the box without a write, which is what the TS's
/// `onChange` guard does (L329-335) — so a half-typed address never becomes
/// the channel's picture.
pub fn image_edited(ui: &MainWindow, state: &Shared) {
    let value = ui.get_channel_ed_image_url().to_string();
    let trimmed = value.trim().to_string();
    if !trimmed.is_empty() && !is_http_url(&trimmed) {
        return;
    }
    patch(ui, state, |draft| draft.background_image = trimmed);
}

fn is_http_url(value: &str) -> bool {
    let lower = value.to_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// `readImageFile` + the notify the TS sends on a successful pick. The error
/// path prints into the editor's own line, not the app's toast.
pub fn image_upload(ui: &MainWindow, state: &Shared) {
    let Some(path) = crate::platform::pick_image_file(crate::find_main_window()) else {
        return;
    };
    match crate::art::read_image_data_url(&path, crate::art::MAX_APP_BACKGROUND_BYTES) {
        Ok(data_url) => {
            ui.set_channel_ed_image_url("".into());
            patch(ui, state, |draft| draft.background_image = data_url);
            ui.set_channel_ed_error("".into());
            notice(ui, "Channel image added");
        }
        Err(message) => ui.set_channel_ed_error(message.as_str().into()),
    }
}

pub fn image_remove(ui: &MainWindow, state: &Shared) {
    ui.set_channel_ed_image_url("".into());
    patch(ui, state, |draft| draft.background_image = String::new());
}

/// The three look dials. `key` is "opacity", "blur" or "dim" — the ranges and
/// steps are the editor's own sliders (0..1/.05, 0..40/1, 0..0.9/.05).
pub fn image_float(ui: &MainWindow, state: &Shared, key: &str, value: f64) {
    match key {
        "opacity" => {
            let v = settings_ops::snap(value, 0.0, 1.0, 0.05);
            patch(ui, state, |draft| draft.background_opacity = v);
        }
        "blur" => {
            let v = settings_ops::snap(value, 0.0, 40.0, 1.0);
            patch(ui, state, |draft| draft.background_blur = v);
        }
        "dim" => {
            let v = settings_ops::snap(value, 0.0, 0.9, 0.05);
            patch(ui, state, |draft| draft.background_dim = v);
        }
        _ => {}
    }
}

pub fn show_mail_toggled(ui: &MainWindow, state: &Shared, value: bool) {
    patch(ui, state, |draft| draft.show_mail = value);
}

pub fn mail_account_picked(ui: &MainWindow, state: &Shared, id: &str) {
    let known = id == "all"
        || mail_accounts(&items::prefs_from(state.borrow().engine.preferences()))
            .iter()
            .any(|(account, _)| account == id);
    if !known {
        return;
    }
    let id = id.to_string();
    patch(ui, state, |draft| draft.mail_account = id);
}

/// The footer's Add channel: the one path that *adds* a channel. Validates
/// the name, appends the channel, gives it a sidebar entry, makes it the
/// active view and says so — `writeChannel(next, true)` with `exists === false`
/// (App.tsx L925-946).
pub fn save(ui: &MainWindow, state: &Shared) {
    let Some(mut draft) = state.borrow().channel_draft.clone() else {
        return;
    };
    if draft.name.trim().is_empty() {
        ui.set_channel_ed_error("Give the channel a name.".into());
        return;
    }
    draft.name = draft.name.trim().to_string();
    if draft.id.is_empty() {
        draft.id = new_channel_id();
    }
    let id = draft.id.clone();
    let name = draft.name.clone();
    let ok = settings_ops::write(ui, state, |prefs| {
        if prefs.channels.iter().any(|channel| channel.id == id) {
            return false;
        }
        // The tree as it stood *before* the new row: the stored entries, or
        // the default built from the channels that were already there. The
        // new one goes on the end, the way `writeChannel` appends to
        // `sidebarBase` (App.tsx L932).
        let mut entries = sidebar_entries(prefs);
        prefs.channels.push(draft);
        entries.push(json!({ "kind": "channel", "id": id }));
        prefs.extra["sidebar"] = json!(entries);
        true
    });
    if !ok {
        ui.set_channel_ed_error("That channel could not be saved.".into());
        return;
    }
    ui.set_active_channel(id.as_str().into());
    notice(ui, &format!("Channel \"{name}\" added"));
    close(ui, state);
    crate::refresh_items(ui, state);
    push_manager(ui, state);
    crate::push_background(ui, state);
}

/// The footer's Delete, drawn only for a deletable channel. Removes it from
/// the catalogue and from the stored sidebar tree, drops it from
/// `hiddenChannels`, falls back to `all` when it was the active view, and
/// says so — `deleteChannel` (App.tsx L951-963).
pub fn deleted(ui: &MainWindow, state: &Shared) {
    let (id, name) = {
        let guard = state.borrow();
        let Some(draft) = guard.channel_draft.as_ref() else {
            return;
        };
        (draft.id.clone(), draft.name.clone())
    };
    let was_active = ui.get_active_channel().to_string() == id;
    let ok = settings_ops::write(ui, state, |prefs| {
        let Some(target) = prefs.channels.iter().find(|channel| channel.id == id) else {
            return false;
        };
        if target.locked {
            return false;
        }
        prefs.channels.retain(|channel| channel.id != id);
        prefs.hidden_channels.retain(|hidden| *hidden != id);
        let entries = strip_channel(sidebar_entries(prefs), &id);
        prefs.extra["sidebar"] = json!(entries);
        true
    });
    if !ok {
        return;
    }
    if was_active {
        ui.set_active_channel("all".into());
    }
    notice(ui, &format!("Channel \"{name}\" removed"));
    close(ui, state);
    crate::refresh_items(ui, state);
    push_manager(ui, state);
    crate::push_background(ui, state);
}
