//! The History and undo log — Task 1.7, ported from `src/vault/storage.ts`
//! L324-470 (`HistoryEvent`, `normaliseHistory`, `historyEventsFor`,
//! `appendHistory`, the two caps), with the wiring the TS does at
//! `src/ui/hooks.ts` L192-194.
//!
//! The log is the only thing in the app that keeps a login after it has been
//! deleted, so two rules matter and are enforced here: a delete records enough
//! to put the login back, and nothing a user typed can make the log unbounded.
//! The diff lives in core rather than the UI because the caller has the
//! before/after lists anyway, and a diff that can be called from a test is a
//! diff that can be trusted.

use std::collections::{HashMap, HashSet};

use rand::distributions::Alphanumeric;
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::model::{normalise_item, VaultItem};
use crate::util::now_ms;

/// The count cap (`MAX_HISTORY_EVENTS`, storage.ts L324).
pub const MAX_HISTORY_EVENTS: usize = 200;

/// Rough ceiling on the whole log, in serialized characters (`MAX_HISTORY_CHARS`,
/// storage.ts L331). A login with an uploaded card image is megabytes on its
/// own, so the count cap alone cannot bound this: the oldest entries are
/// evicted until the log fits again.
pub const MAX_HISTORY_CHARS: usize = 400_000;

/// One thing that happened to one login (`action` in storage.ts L357).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum HistoryAction {
    Added,
    Edited,
    Deleted,
}

/// One thing that happened to one login (storage.ts L354-363).
///
/// `before` is the login as it stood *prior* to the change, and exists only
/// for the actions that overwrote or removed it. `restore` writes it back; for
/// an addition there is nothing to go back to, so the row offers to remove the
/// login instead.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEvent {
    pub id: String,
    pub at: i64,
    pub action: HistoryAction,
    pub item_id: String,
    /// Name as it read at the time, so the log stays readable after a rename.
    pub title: String,
    pub username: String,
    /// A stored addition carries no `before` field at all (history.test.ts
    /// L166-174), so a missing key must deserialize as "nothing to restore"
    /// rather than an error.
    #[serde(default)]
    pub before: Option<VaultItem>,
}

/// `he_` plus eight random base36 characters plus the last three base36
/// digits of the clock — `newHistoryEventId` (storage.ts L365): short enough
/// to sit in every row, unique enough that two blocks never collide.
pub fn new_history_event_id() -> String {
    let suffix: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .map(|c| (c as char).to_ascii_lowercase())
        .take(8)
        .collect();
    format!("he_{suffix}{}", base36_tail(now_ms(), 3))
}

/// `Date.now().toString(36).slice(-3)`: the last `keep` base36 digits of a
/// millisecond clock.
fn base36_tail(mut n: i64, keep: usize) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut digits = Vec::new();
    while n > 0 {
        digits.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    digits.reverse();
    digits
        .iter()
        .rev()
        .take(keep)
        .rev()
        .map(|b| *b as char)
        .collect()
}

/// True when two versions of a login differ in nothing a user would call a
/// change (storage.ts L338-344): every field matches apart from the save
/// clocks. Used to keep a re-save out of the History log — open a login, save
/// it untouched, and without this a row appeared describing nothing.
fn same_content(a: &VaultItem, b: &VaultItem) -> bool {
    fn strip(item: &VaultItem) -> Value {
        let mut value = serde_json::to_value(item).unwrap_or(Value::Null);
        if let Some(object) = value.as_object_mut() {
            object.remove("updatedAt");
            object.remove("passwordUpdatedAt");
            object.remove("usernameUpdatedAt");
        }
        value
    }
    strip(a) == strip(b)
}

/// Reads the stored log back, dropping anything malformed (storage.ts
/// L377-401).
///
/// Shape-checked field by field like the rest of preferences: a truncated or
/// hand-edited record must not be able to make the History channel throw, and
/// a `before` snapshot that is not an object is exactly what a partial write
/// looks like — better no restore than a login restored from half a record.
pub fn normalise_history(raw: Option<&Value>) -> Vec<HistoryEvent> {
    let Some(Value::Array(entries)) = raw else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.iter().take(MAX_HISTORY_EVENTS) {
        let Some(record) = entry.as_object() else { continue };
        let action = match record.get("action").and_then(Value::as_str) {
            Some("added") => HistoryAction::Added,
            Some("edited") => HistoryAction::Edited,
            Some("deleted") => HistoryAction::Deleted,
            _ => continue,
        };
        let item_id = record.get("itemId").and_then(Value::as_str).unwrap_or("");
        if item_id.is_empty() {
            continue;
        }
        let id = match record.get("id").and_then(Value::as_str) {
            Some(id) if !id.is_empty() => id.to_string(),
            _ => new_history_event_id(),
        };
        let at = record
            .get("at")
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite())
            .map(|n| n as i64)
            .unwrap_or(0);
        let clip = |key: &str| -> String {
            record
                .get(key)
                .and_then(Value::as_str)
                .map(|s| s.chars().take(200).collect())
                .unwrap_or_default()
        };
        let before = match record.get("before") {
            Some(value) if value.is_object() => Some(normalise_item(value, 0)),
            _ => None,
        };
        out.push(HistoryEvent {
            id,
            at,
            action,
            item_id: item_id.to_string(),
            title: clip("title"),
            username: clip("username"),
            before,
        });
    }
    out
}

/// Turns "what the items were" and "what they are now" into log entries
/// (storage.ts L422-455).
///
/// Three shapes only: something that appeared is `added`, something that
/// vanished is `deleted` (carrying the login as it was, which is the only copy
/// left once the record is gone), and something whose `updatedAt` moved is
/// `edited` (carrying the version it replaced). Ordering is the after-list
/// first, so a paste of five logins reads top to bottom the way it was pasted,
/// then the deletions.
///
/// A bulk action produces one entry per login on purpose: "delete 12 logins"
/// is twelve restorable rows, not one lump that can only come back whole.
/// `now` is injectable so the tests do not have to race the clock.
pub fn history_events_for(before: &[VaultItem], after: &[VaultItem], now: i64) -> Vec<HistoryEvent> {
    let previous: HashMap<&str, &VaultItem> =
        before.iter().map(|item| (item.id.as_str(), item)).collect();
    let describe = |item: &VaultItem| -> (String, String) {
        let title = if item.title.is_empty() {
            if item.username.is_empty() {
                "Untitled".to_string()
            } else {
                item.username.clone()
            }
        } else {
            item.title.clone()
        };
        (title, item.username.clone())
    };
    let mut events = Vec::new();
    for item in after {
        let Some(was) = previous.get(item.id.as_str()) else {
            let (title, username) = describe(item);
            events.push(HistoryEvent {
                id: new_history_event_id(),
                at: now,
                action: HistoryAction::Added,
                item_id: item.id.clone(),
                title,
                username,
                before: None,
            });
            continue;
        };
        // A bump to `updatedAt` with nothing else different is a re-save, not
        // a change (storage.ts L441-445).
        if was.updated_at != item.updated_at && !same_content(was, item) {
            let (title, username) = describe(was);
            events.push(HistoryEvent {
                id: new_history_event_id(),
                at: now,
                action: HistoryAction::Edited,
                item_id: item.id.clone(),
                title,
                username,
                before: Some((*was).clone()),
            });
        }
    }
    let alive: HashSet<&str> = after.iter().map(|item| item.id.as_str()).collect();
    for item in before {
        if alive.contains(item.id.as_str()) {
            continue;
        }
        let (title, username) = describe(item);
        events.push(HistoryEvent {
            id: new_history_event_id(),
            at: now,
            action: HistoryAction::Deleted,
            item_id: item.id.clone(),
            title,
            username,
            before: Some(item.clone()),
        });
    }
    events
}

/// Prepends an event and trims the log to its count and size budgets
/// (storage.ts L463-471).
///
/// Purely functional so the caller can fold several events from one mutation
/// into one write, and so the trimming rule is testable without a vault.
pub fn append_history(existing: &[HistoryEvent], additions: &[HistoryEvent]) -> Vec<HistoryEvent> {
    if additions.is_empty() {
        return existing.to_vec();
    }
    let mut log: Vec<HistoryEvent> = additions.to_vec();
    log.extend_from_slice(existing);
    log.truncate(MAX_HISTORY_EVENTS);
    loop {
        if log.len() <= 1 {
            break;
        }
        // Measured fresh each pass: `truncate` above borrows `log` mutably,
        // so the size cannot be held in a closure across it.
        let size = serde_json::to_string(&log).map(|s| s.len()).unwrap_or(0);
        if size <= MAX_HISTORY_CHARS {
            break;
        }
        log.truncate(std::cmp::max(1, log.len() / 2));
    }
    log
}
