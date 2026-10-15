//! The History channel's rows — the Rust half of Task 7.2.
//!
//! Port of the `useMemo` blocks in `E:\acc2\src\ui\HistoryPanel.tsx` (258
//! lines): the filter + search L71-89, the day groups L91-100, and the row's
//! own details L169-247 — badge, name, meta line, and which buttons it
//! offers. Counts, labels and empty states all come from the events
//! themselves, so nothing here can disagree with what was recorded.
//!
//! Everything here is pure: events + logins + query + segment in, a
//! `HistoryData` out. `refresh_items` pushes it through the screen's one
//! property, the way `dashboard::fill` pushes the dashboard's many.

use std::collections::HashMap;

use colax_core::{relative_time, HistoryAction, HistoryEvent, VaultItem};

use crate::items::hostname_of;
use crate::{HistoryData, HistoryGroup, HistoryRow};
use slint::{ModelRc, VecModel};

const DAY: i64 = 86_400_000;

/// `ACTION_LABELS` (HistoryPanel.tsx L22): the badge and the search word for
/// an action.
fn action_label(action: HistoryAction) -> &'static str {
    match action {
        HistoryAction::Added => "Added",
        HistoryAction::Edited => "Edited",
        HistoryAction::Deleted => "Deleted",
    }
}

/// The row's `data-action` form: the segment's value 1..3 maps onto it, and
/// the tint picks itself from it in the .slint.
fn action_key(action: HistoryAction) -> &'static str {
    match action {
        HistoryAction::Added => "added",
        HistoryAction::Edited => "edited",
        HistoryAction::Deleted => "deleted",
    }
}

/// The segment's index for an action (0 = All matches nothing's key, so the
/// caller compares against the raw index).
fn action_index(action: HistoryAction) -> usize {
    match action {
        HistoryAction::Added => 1,
        HistoryAction::Edited => 2,
        HistoryAction::Deleted => 3,
    }
}

/// Day name for the group headers, so the log reads as a diary — `dayLabel`
/// (HistoryPanel.tsx L29): Today, Yesterday, else the long date.
///
/// The TS rolled over at the machine's local midnight and let the locale
/// spell the date; the native build follows `short_date` in dashboard.rs —
/// UTC days and one deterministic English set, so two machines never
/// disagree in a screenshot.
fn day_label(at: i64, now: i64) -> String {
    let midnight = now.div_euclid(DAY) * DAY;
    if at >= midnight {
        return "Today".to_string();
    }
    if at >= midnight - DAY {
        return "Yesterday".to_string();
    }
    const WEEKDAYS: [&str; 7] = [
        "Sunday",
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
    ];
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let days = at.div_euclid(DAY);
    // Civil-from-days, Howard Hinnant's algorithm (the one `short_date`
    // uses) taken to month and day — the long label carries no year, the
    // way `toLocaleDateString({ weekday, day, month })` printed it. 1970-01-01
    // was a Thursday, which is what the weekday offset below counts from.
    let z = days + 719_468;
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let weekday = WEEKDAYS[(days + 4).rem_euclid(7) as usize];
    format!("{weekday}, {d} {}", MONTHS[(month - 1) as usize])
}

/// The whole panel, computed in one pass — `shown` + `groups` + the two
/// empty states of HistoryPanel.tsx, in the TS's order: the segment first,
/// then the haystack, then whichever empty state the counts name.
///
/// `filter` is the segment's index (0 All, 1 Added, 2 Edited, 3 Deleted);
/// `now` is injectable so the day labels do not race a midnight rollover.
pub fn build(
    events: &[HistoryEvent],
    items: &[VaultItem],
    query: &str,
    filter: usize,
    now: i64,
) -> HistoryData {
    let has_events = !events.is_empty();
    let count = if events.len() == 1 {
        "1 change".to_string()
    } else {
        format!("{} changes", events.len())
    };

    let live: HashMap<&str, &VaultItem> = items.iter().map(|item| (item.id.as_str(), item)).collect();

    // The haystack joins name, username, the snapshot's URL, the live
    // login's URL, the action's word and the snapshot's notes (L76-84): one
    // needle reaches any of them, so "find the login I deleted last
    // Tuesday" can start from either side.
    let needle = query.trim().to_lowercase();
    let shown: Vec<&HistoryEvent> = events
        .iter()
        .filter(|event| {
            if filter != 0 && filter != action_index(event.action) {
                return false;
            }
            if needle.is_empty() {
                return true;
            }
            let item = live.get(event.item_id.as_str()).copied();
            let before = event.before.as_ref();
            let haystack = [
                event.title.as_str(),
                event.username.as_str(),
                before.map(|b| b.url.as_str()).unwrap_or(""),
                item.map(|i| i.url.as_str()).unwrap_or(""),
                action_label(event.action),
                before.map(|b| b.notes.as_str()).unwrap_or(""),
            ]
            .join(" ")
            .to_lowercase();
            haystack.contains(&needle)
        })
        .collect();

    // Neither empty state can be shown while rows exist, and the count
    // keeps counting under a filter — the badge describes the log, not the
    // answer to the current query (L108-110, L151-162).
    let none = |title: &str, hint: &str| HistoryData {
        count: count.as_str().into(),
        groups: ModelRc::new(VecModel::from(Vec::<HistoryGroup>::new())),
        empty_title: title.into(),
        empty_hint: hint.into(),
        has_events,
    };
    if !has_events {
        return none(
            "Nothing has changed yet",
            "Add, edit or delete a login and it shows up here — with the previous version kept, so a change can be undone.",
        );
    }
    if shown.is_empty() {
        return none(
            "No matching changes",
            "Try a different word, or switch the filter back to All.",
        );
    }

    // Rows, then consecutive runs of one day label into one group — the log
    // arrives newest-first, so a day's rows are already adjacent (L91-100).
    let mut grouped: Vec<(String, Vec<HistoryRow>)> = Vec::new();
    for event in shown {
        let item = live.get(event.item_id.as_str()).copied();
        let before = event.before.as_ref();

        // `live?.url || event.before?.url` (L171): a live login with no
        // address of its own still borrows the snapshot's, and the dead
        // row's snapshot is the only address left.
        let url = item
            .map(|i| i.url.as_str())
            .filter(|u| !u.is_empty())
            .or_else(|| before.map(|b| b.url.as_str()).filter(|u| !u.is_empty()))
            .unwrap_or("");
        // The copy button copies the *snapshot's* password (L172, L214-223):
        // it is labelled "from history" and shows what the row restored to.
        let password = before.map(|b| b.password.as_str()).unwrap_or("");

        // `{username || 'no username'}{url ? ` · host` : ''} · {rel}{dead}`
        // (L180-184).
        let mut meta = if event.username.is_empty() {
            "no username".to_string()
        } else {
            event.username.clone()
        };
        if !url.is_empty() {
            let host = hostname_of(url).unwrap_or_else(|| url.to_string());
            meta.push_str(&format!(" · {host}"));
        }
        meta.push_str(&format!(" · {}", relative_time(event.at, now)));
        if item.is_none() {
            meta.push_str(" · no longer in the vault");
        }

        let row = HistoryRow {
            event_id: event.id.as_str().into(),
            item_id: event.item_id.as_str().into(),
            action: action_key(event.action).into(),
            badge: action_label(event.action).into(),
            name: if event.title.is_empty() {
                "Untitled".into()
            } else {
                event.title.as_str().into()
            },
            meta: meta.into(),
            restore: before.is_some(),
            live: item.is_some(),
            // Both copy buttons live inside the `live ?` branch (L203-237);
            // the password's non-empty check is the snapshot's (L172).
            copy_pw: item.is_some() && !password.is_empty(),
            copy_pw_value: password.into(),
            copy_url: item.is_some() && !url.is_empty(),
            copy_url_value: url.into(),
        };

        let label = day_label(event.at, now);
        match grouped.last_mut() {
            Some((last, rows)) if *last == label => rows.push(row),
            _ => grouped.push((label, vec![row])),
        }
    }

    let groups: Vec<HistoryGroup> = grouped
        .into_iter()
        .map(|(label, rows)| HistoryGroup {
            label: label.into(),
            rows: ModelRc::new(VecModel::from(rows)),
        })
        .collect();
    HistoryData {
        count: count.into(),
        groups: ModelRc::new(VecModel::from(groups)),
        empty_title: "".into(),
        empty_hint: "".into(),
        has_events: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use colax_core::empty_item;
    use slint::Model;

    fn login(id: &str, title: &str, url: &str, username: &str, password: &str, at: i64) -> VaultItem {
        let mut item = empty_item(id, at);
        item.title = title.into();
        item.url = url.into();
        item.username = username.into();
        item.password = password.into();
        item.updated_at = at;
        item
    }

    fn event(
        id: &str,
        action: HistoryAction,
        item_id: &str,
        at: i64,
        title: &str,
        before: Option<VaultItem>,
    ) -> HistoryEvent {
        HistoryEvent {
            id: id.into(),
            at,
            action,
            item_id: item_id.into(),
            title: title.into(),
            username: "ada@example.com".into(),
            before,
        }
    }

    fn rows(data: &HistoryData) -> Vec<HistoryRow> {
        // Collect per group rather than `flat_map(|g| g.rows.iter())`: each
        // group is an owned value, so its model's iterator borrows it and
        // could not outlive the closure.
        let mut all = Vec::new();
        for group in data.groups.iter() {
            all.extend(group.rows.iter());
        }
        all
    }

    fn labels(data: &HistoryData) -> Vec<String> {
        data.groups
            .iter()
            .map(|group| group.label.as_str().to_string())
            .collect()
    }

    #[test]
    fn the_count_is_singular_for_one_change_and_plural_after() {
        let now = 1_000_000;
        let one = [event("e1", HistoryAction::Added, "a", now, "A", None)];
        let data = build(&one, &[], "", 0, now);
        assert_eq!(data.count, "1 change");
        assert!(data.has_events, "Clear log stays live while the log has entries");
        assert_eq!(data.empty_title, "", "rows to show, so no empty state");

        let two = [
            event("e1", HistoryAction::Added, "a", now, "A", None),
            event("e2", HistoryAction::Added, "b", now, "B", None),
        ];
        let data = build(&two, &[], "", 0, now);
        assert_eq!(data.count, "2 changes");
    }

    #[test]
    fn the_segment_filters_by_action() {
        let now = 1_000_000;
        let events = [
            event("e1", HistoryAction::Added, "a", now, "A", None),
            event(
                "e2",
                HistoryAction::Edited,
                "b",
                now,
                "B",
                Some(login("b", "B", "", "bob", "pw", 9)),
            ),
            event(
                "e3",
                HistoryAction::Deleted,
                "c",
                now,
                "C",
                Some(login("c", "C", "", "cat", "pw", 9)),
            ),
        ];
        let badges = |filter: usize| -> Vec<String> {
            let data = build(&events, &[], "", filter, now);
            rows(&data)
                .iter()
                .map(|row| row.badge.as_str().to_string())
                .collect()
        };
        assert_eq!(badges(0), ["Added", "Edited", "Deleted"]);
        assert_eq!(badges(1), ["Added"]);
        assert_eq!(badges(2), ["Edited"]);
        assert_eq!(badges(3), ["Deleted"]);
        // The badge keeps counting the whole log under a filter — it
        // describes the log, not the answer on screen.
        let data = build(&events, &[], "", 3, now);
        assert_eq!(data.count, "3 changes");
    }

    #[test]
    fn the_query_reaches_every_field_of_a_row() {
        // A fixed clock: 1970-01-04 noon UTC, comfortably past the epoch.
        let now = 3 * DAY + 12 * 3_600_000;
        let live = login("a", "Vault Pi", "https://vaultpi.com/app", "ada", "hunter2", now);
        let mut snapshot = login("a", "Vault Pi", "https://old.vaultpi.net", "ada", "hunter2", 9);
        snapshot.notes = "keep away".into();
        let events = [event(
            "e1",
            HistoryAction::Deleted,
            "a",
            now,
            "Vault Pi",
            Some(snapshot),
        )];
        let hits = |needle: &str| -> usize {
            let data = build(&events, &[live.clone()], needle, 0, now);
            rows(&data).len()
        };
        assert_eq!(hits("vault pi"), 1, "the name");
        assert_eq!(hits("ADA@EXAMPLE"), 1, "the username, case-insensitively");
        assert_eq!(hits("  old.vaultpi.net  "), 1, "the snapshot's address, trimmed");
        assert_eq!(hits("vaultpi.com"), 1, "the live login's address");
        assert_eq!(hits("Deleted"), 1, "the action's word");
        assert_eq!(hits("keep away"), 1, "the snapshot's notes");

        let data = build(&events, &[live.clone()], "no such word", 0, now);
        assert_eq!(data.groups.row_count(), 0);
        assert_eq!(data.empty_title, "No matching changes");
        assert_eq!(data.empty_hint, "Try a different word, or switch the filter back to All.");
        assert!(data.has_events, "the log still has entries — only the query failed");
        assert_eq!(data.count, "1 change");
    }

    #[test]
    fn rows_group_by_day_so_the_log_reads_as_a_diary() {
        let now = 3 * DAY + 12 * 3_600_000;
        let events = [
            event("e1", HistoryAction::Added, "a", now - 3_600_000, "A", None),
            event("e2", HistoryAction::Added, "b", now - 2 * 3_600_000, "B", None),
            event("e3", HistoryAction::Added, "c", 2 * DAY, "C", None),
            // 1970-01-02 was a Friday; two consecutive rows share its label
            // and therefore its section.
            event("e4", HistoryAction::Added, "d", DAY, "D", None),
            event("e5", HistoryAction::Added, "e", DAY, "E", None),
        ];
        let data = build(&events, &[], "", 0, now);
        assert_eq!(labels(&data), ["Today", "Yesterday", "Friday, 2 Jan"]);
        let per_group: Vec<usize> = data.groups.iter().map(|g| g.rows.row_count()).collect();
        assert_eq!(per_group, [2, 1, 2]);
    }

    #[test]
    fn the_two_empty_states_come_from_the_events() {
        let now = 1_000_000;
        let data = build(&[], &[], "", 0, now);
        assert_eq!(data.groups.row_count(), 0);
        assert_eq!(data.empty_title, "Nothing has changed yet");
        assert_eq!(
            data.empty_hint,
            "Add, edit or delete a login and it shows up here — with the previous version kept, so a change can be undone."
        );
        assert!(!data.has_events, "Clear log is dead on an empty log");

        let events = [event("e1", HistoryAction::Added, "a", now, "A", None)];
        let data = build(&events, &[], "", 0, now);
        assert_eq!(data.empty_title, "", "a full log has no empty state");
        assert_eq!(data.groups.row_count(), 1);
    }

    #[test]
    fn a_deleted_row_keeps_its_version_and_says_the_login_is_gone() {
        let now = 1_000_000;
        let snapshot = login("c", "Old Bank", "https://oldbank.com/login", "cat", "s3cret", 9);
        // `history_events_for` fills `username` from the item it describes —
        // the deleted login, here (core history.rs L233: `describe(item)`).
        let mut gone = event(
            "e1",
            HistoryAction::Deleted,
            "c",
            now,
            "Old Bank",
            Some(snapshot),
        );
        gone.username = "cat".into();
        let events = [gone];
        // No live login: the snapshot is the only copy left.
        let data = build(&events, &[], "", 0, now);
        let rows = rows(&data);
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(row.badge, "Deleted");
        assert_eq!(row.action, "deleted");
        assert_eq!(row.name, "Old Bank");
        assert!(row.restore, "a stored version is what makes it undoable");
        assert!(!row.live);
        assert!(!row.copy_pw, "no live login to count the copy against");
        assert!(!row.copy_url);
        assert_eq!(
            row.meta.as_str(),
            "cat · oldbank.com · just now · no longer in the vault"
        );
    }

    #[test]
    fn live_rows_offer_edit_and_the_two_copies() {
        let now = 1_000_000;
        let mut snapshot = login("a", "Old Name", "https://site.com/x", "ada", "old-pw", 9);
        snapshot.notes = "kept".into();
        let live = login("a", "New Name", "https://site.com/x", "ada", "new-pw", now);
        let events = [event(
            "e2",
            HistoryAction::Edited,
            "a",
            now,
            "Old Name",
            Some(snapshot),
        )];
        let data = build(&events, &[live], "", 0, now);
        let rows = rows(&data);
        let row = &rows[0];
        assert!(row.restore, "the version it replaced");
        assert!(row.live);
        assert_eq!(row.name, "Old Name", "labelled with what it was called then");
        assert!(row.copy_pw);
        assert_eq!(row.copy_pw_value, "old-pw", "the snapshot's password — \"from history\"");
        assert!(row.copy_url);
        assert_eq!(row.copy_url_value, "https://site.com/x");
        assert!(
            !row.meta.contains("no longer in the vault"),
            "the login still exists: meta does not claim otherwise ({})",
            row.meta
        );
    }

    #[test]
    fn an_addition_has_nothing_to_restore_and_an_empty_row_is_untitled() {
        let now = 1_000_000;
        let mut added = event("e1", HistoryAction::Added, "a", now, "", None);
        added.username = "".into();
        let data = build(&[added], &[], "", 0, now);
        let rows = rows(&data);
        let row = &rows[0];
        assert!(!row.restore);
        assert_eq!(row.name, "Untitled");
        assert!(!row.copy_pw, "an addition stores no snapshot password");
        assert!(row.meta.starts_with("no username · just now"), "meta: {}", row.meta);
    }

    #[test]
    fn a_live_login_without_an_address_borrows_the_snapshots() {
        let now = 1_000_000;
        let snapshot = login("a", "A", "https://fallback.example", "ada", "pw", 9);
        let live = login("a", "A", "", "ada", "pw", now);
        let events = [event(
            "e1",
            HistoryAction::Edited,
            "a",
            now,
            "A",
            Some(snapshot),
        )];
        let data = build(&events, &[live], "", 0, now);
        let rows = rows(&data);
        let row = &rows[0];
        assert!(row.copy_url);
        assert_eq!(row.copy_url_value, "https://fallback.example");
        assert!(row.meta.contains(" · fallback.example · "), "meta: {}", row.meta);
    }
}
