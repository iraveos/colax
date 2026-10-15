//! The History and undo log — Task 1.7: the cases from
//! `E:\acc2\test\history.test.ts`, pinned against the Rust port of
//! `src/vault/storage.ts` L324-470.
//!
//! The log is the only thing in the app that keeps a login after it has been
//! deleted, so the two rules that matter are: a delete records enough to put
//! the login back, and nothing a user typed can make the log unbounded. Both
//! are checked here against the same functions the app calls.

use serde_json::{json, Value};

use colax_core::{
    append_history, empty_item, history_events_for, new_history_event_id, normalise_history,
    normalise_preferences, HistoryAction, HistoryEvent, VaultItem, VaultPreferences,
    MAX_HISTORY_CHARS, MAX_HISTORY_EVENTS,
};

/// The TS fixture: `{ ...emptyItem(id, 1_000), ...patch }` (history.test.ts
/// L25-27), with the patch as a mutation instead of a spread.
fn item(id: &str, patch: impl FnOnce(&mut VaultItem)) -> VaultItem {
    let mut item = empty_item(id, 1_000);
    patch(&mut item);
    item
}

fn edited(id: &str, title: &str, updated: i64) -> VaultItem {
    item(id, |i| {
        i.title = title.into();
        i.updated_at = updated;
    })
}

/// The three events one mutation produces, as `[action, itemId]` pairs — the
/// shape history.test.ts L37-44 asserts on.
fn shapes(events: &[HistoryEvent]) -> Vec<(HistoryAction, &str)> {
    events.iter().map(|e| (e.action, e.item_id.as_str())).collect()
}

#[test]
fn an_addition_an_edit_and_a_delete_each_record_the_right_thing() {
    let before = [edited("a", "A", 10), edited("b", "B", 10)];
    let after = [edited("a", "A renamed", 30), edited("c", "C", 30)];
    let events = history_events_for(&before, &after, 999);

    // Ordering is the after-list first so a paste reads top to bottom, then
    // the deletions.
    assert_eq!(
        shapes(&events),
        [
            (HistoryAction::Edited, "a"),
            (HistoryAction::Added, "c"),
            (HistoryAction::Deleted, "b"),
        ]
    );
    // Every event carries the same clock reading.
    assert!(events.iter().all(|event| event.at == 999));
    // The edit kept the version it replaced: without it there is nothing to
    // restore, and the newer title would be the only copy left.
    assert_eq!(events[0].before.as_ref().unwrap().title, "A");
    assert_eq!(events[0].title, "A", "the row is labelled with what it was called then");
    // A delete keeps the login itself, password included — that snapshot is
    // the only copy once the record is gone from storage.
    assert_eq!(events[2].before.as_ref().unwrap().id, "b");
    assert_eq!(events[2].before.as_ref().unwrap().title, "B");
    // An addition has nothing to go back to.
    assert!(events[1].before.is_none());
}

#[test]
fn an_untouched_item_is_not_logged_at_all() {
    let same = [edited("a", "A", 10)];
    assert!(history_events_for(&same, &same, 0).is_empty());
    // A write that only re-saves identical data must not fill the log with
    // noise, which is why the comparison is on `updatedAt` rather than on
    // identity.
    let copied = same.clone();
    assert_eq!(history_events_for(&same, &copied, 0).len(), 0);
}

#[test]
fn a_re_save_that_changes_nothing_but_the_clock_is_not_a_change() {
    // Saving an editor without touching a field bumps `updatedAt` (and the two
    // per-field clocks with it). That is not an edit, and the log must not
    // grow a row for it.
    let before = [item("a", |i| {
        i.title = "A".into();
        i.updated_at = 10;
        i.password = "hunter2".into();
    })];
    let after = [item("a", |i| {
        i.title = "A".into();
        i.updated_at = 99;
        i.password = "hunter2".into();
        i.password_updated_at = 99;
        i.username_updated_at = 99;
    })];
    assert!(history_events_for(&before, &after, 999).is_empty());

    // A real change alongside the clock bump is still logged, with the old
    // version kept for Restore.
    let renamed = [item("a", |i| {
        i.title = "A renamed".into();
        i.updated_at = 99;
        i.password = "hunter2".into();
    })];
    let events = history_events_for(&before, &renamed, 999);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].action, HistoryAction::Edited);
    assert_eq!(events[0].before.as_ref().unwrap().title, "A");
}

#[test]
fn the_log_is_bounded_by_count_and_by_size() {
    let many: Vec<HistoryEvent> = (0..MAX_HISTORY_EVENTS + 25)
        .map(|index| HistoryEvent {
            id: format!("he_{index}"),
            at: index as i64,
            action: HistoryAction::Added,
            item_id: format!("item_{index}"),
            title: format!("Login {index}"),
            username: "me@x.com".into(),
            before: None,
        })
        .collect();
    let trimmed = append_history(&[], &many);
    assert_eq!(trimmed.len(), MAX_HISTORY_EVENTS, "the oldest entries fall off the end");
    // The tail of the block is what gets evicted: one mutation's entries share
    // a timestamp, so the order inside it is just the order the diff produced.
    assert_eq!(trimmed.last().unwrap().item_id, format!("item_{}", MAX_HISTORY_EVENTS - 1));

    // Between changes, the newest block goes on top — that is what makes the
    // channel read newest-first rather than sorted by anything.
    let older = HistoryEvent {
        id: "he_older".into(),
        at: 1,
        action: HistoryAction::Added,
        item_id: "i_old".into(),
        title: "Old".into(),
        username: "me@x.com".into(),
        before: None,
    };
    let newer = HistoryEvent {
        id: "he_newer".into(),
        at: 2,
        action: HistoryAction::Added,
        item_id: "i_new".into(),
        title: "New".into(),
        username: "me@x.com".into(),
        before: None,
    };
    let log = append_history(&append_history(&[], std::slice::from_ref(&older)), std::slice::from_ref(&newer));
    let ids: Vec<&str> = log.iter().map(|event| event.id.as_str()).collect();
    assert_eq!(ids, ["he_newer", "he_older"]);

    // A single login can be megabytes (an uploaded card image), so the count
    // cap alone cannot bound the record: the whole log has to fit too.
    let heavy: Vec<HistoryEvent> = (0..20)
        .map(|index| HistoryEvent {
            id: format!("he_big_{index}"),
            at: index as i64,
            action: HistoryAction::Deleted,
            item_id: format!("item_{index}"),
            title: "Big".into(),
            username: "me@x.com".into(),
            before: Some(item(&format!("item_{index}"), |i| i.notes = "x".repeat(40_000))),
        })
        .collect();
    let bounded = append_history(&[], &heavy);
    assert!(bounded.len() < heavy.len(), "the size budget evicted entries");
    assert!(serde_json::to_string(&bounded).unwrap().len() <= MAX_HISTORY_CHARS);
}

#[test]
fn a_corrupt_log_is_dropped_rather_than_trusted() {
    let good = HistoryEvent {
        id: "he_ok".into(),
        at: 5,
        action: HistoryAction::Deleted,
        item_id: "i1".into(),
        title: "Keep".into(),
        username: "me@x.com".into(),
        before: Some(item("i1", |i| {
            i.title = "Keep".into();
            i.password = "hunter2".into();
        })),
    };
    let raw = json!([
        serde_json::to_value(&good).unwrap(),
        { "id": "he_bad_action", "at": 6, "action": "exploded", "itemId": "i2" },
        { "id": "he_no_item", "at": 7, "action": "added", "itemId": "" },
        null,
        "not an object",
        // A half-written snapshot is the shape a partial write leaves behind;
        // no restore is better than a login restored from half a record.
        { "id": "he_half", "at": 8, "action": "deleted", "itemId": "i3", "before": "nope" }
    ]);
    let out = normalise_history(Some(&raw));
    assert_eq!(out.len(), 2);
    assert_eq!(out[0].id, "he_ok");
    assert_eq!(out[0].before.as_ref().unwrap().password, "hunter2", "the snapshot survives a reload");
    assert!(out[1].before.is_none(), "an unreadable snapshot becomes \"nothing to restore\"");
    assert!(normalise_history(Some(&Value::String("not a list".into()))).is_empty());
    assert!(normalise_history(None).is_empty());
}

#[test]
fn preferences_carry_the_log_and_a_hand_edited_record_cannot_break_the_load() {
    assert!(VaultPreferences::default().history.is_empty());
    // No `before` field: that is exactly what a stored addition looks like,
    // and the partial record is the point of the test.
    let prefs = normalise_preferences(&json!({
        "history": [
            { "id": "he_1", "at": 4, "action": "added", "itemId": "i1", "title": "GitHub", "username": "me@x.com" }
        ]
    }));
    assert_eq!(prefs.history.len(), 1);
    assert_eq!(prefs.history[0].title, "GitHub");
    assert!(prefs.history[0].before.is_none());
    assert!(normalise_preferences(&json!({ "history": "nonsense" })).history.is_empty());

    // The log rides the typed field, not the opaque `extra` pocket: a saved
    // document must carry it once, not twice.
    assert!(prefs.extra.get("history").is_none());
    let back = serde_json::to_value(&prefs).unwrap();
    assert_eq!(back.get("history").and_then(Value::as_array).map(Vec::len), Some(1));
}

#[test]
fn event_ids_carry_the_he_prefix_and_are_unique() {
    let first = new_history_event_id();
    let second = new_history_event_id();
    assert!(first.starts_with("he_"));
    // 8 random base36 characters plus the 3-digit clock tail (storage.ts L365).
    assert_eq!(first.len(), "he_".len() + 11);
    assert_ne!(first, second, "two rows never collide");
}
