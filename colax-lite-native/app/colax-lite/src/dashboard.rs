//! The dashboard's numbers — the Rust half of the Command Center (Task 7.1).
//!
//! Port of the `useMemo` blocks in `E:\acc2\src\ui\Dashboard.tsx` (1,058
//! lines): health buckets L94-127, reuse clusters L130-142, per-site counts
//! L145-165, most-used L173-181, strength bands L187-210, the 30-day
//! timeline L213-235, recent logins L242-262, the issue list L306-361, the
//! tiles L403-428, and the score L389-434. One `now_ms` instant is shared
//! by every bucket so the counts cannot disagree with each other by a
//! midnight rollover.
//!
//! Everything here is pure: items + preferences + usage in, a
//! `DashboardData` out. `fill` is the only half that touches the screen,
//! and it only copies fields into the models `models.slint` declared.
//!
//! The mail sections are deliberately absent until the mail engine lands:
//! the TS hides them when no mailbox is connected (`onOpenMailbox` absent),
//! and that is exactly the native state today.

use std::collections::HashMap;

use colax_core::{
    apply_channel, builtin_channels, estimate_strength, find_weak_items, is_secured,
    relative_time, stale_days_for, ChannelKind, VaultItem, VaultPreferences,
};

use crate::items::{hostname_of, label_of};
use crate::{
    DashBar, DashDay, DashIssue, DashKey, DashRing, DashRow, DashReuse, DashStat, DashUse,
    MainWindow,
};

const DAY: i64 = 86_400_000;
/// The TS strength key, worst first (Dashboard.tsx L697).
const STRENGTH_LABELS: [&str; 5] = ["Very weak", "Weak", "Fair", "Strong", "Excellent"];

/// Everything the dashboard draws, in one snapshot.
pub struct DashboardData {
    pub ring: DashRing,
    pub sub: String,
    pub empty: bool,
    pub has_password: bool,
    pub has_headline: bool,
    pub headline: DashIssue,
    pub stats: Vec<DashStat>,
    pub issues: Vec<DashIssue>,
    pub recent: Vec<DashRow>,
    pub segments: Vec<DashKey>,
    pub keys: Vec<DashKey>,
    pub has_days: bool,
    pub days: Vec<DashDay>,
    pub days_added: i32,
    pub days_changed: i32,
    pub domains: Vec<DashBar>,
    pub reuse: Vec<DashReuse>,
    pub uses: Vec<DashUse>,
    pub uses_total: i32,
    pub emails: Vec<DashRow>,
    pub emails_more: i32,
    pub factors: Vec<DashRow>,
    pub factors_more: i32,
    pub channels: Vec<DashBar>,
    pub channels_more: i32,
    pub tag_count: i32,
    pub channel_count: i32,
}

/// The dashboard's snapshot for these items, at this instant.
///
/// `usage` is the preferences' copy/edit counters; deleted logins are
/// skipped, never rendered as dead rows — the TS is emphatic about that.
pub fn build(
    items: &[VaultItem],
    prefs: &VaultPreferences,
    usage: &std::collections::BTreeMap<String, colax_core::UsageEntry>,
    now: i64,
) -> DashboardData {
    let total = items.len() as i32;
    let empty = total == 0;

    // ---- Health buckets (Dashboard.tsx L94-127) --------------------------
    // `weak` deliberately uses the same source the "Weak or reused" channel
    // filters on: counting strength alone once made the dashboard report
    // zero weak logins while the sidebar reported four (TS comment L96-98).
    let weak = find_weak_items(items, prefs.password_age_days as f64, now);
    let stale: Vec<&VaultItem> = items
        .iter()
        .filter(|item| {
            if item.password.is_empty() {
                return false;
            }
            let threshold = stale_days_for(item, prefs.password_age_days as f64);
            threshold > 0.0 && now - item.password_updated_at > (threshold * DAY as f64) as i64
        })
        .collect();
    let email_check: Vec<&VaultItem> = if prefs.email_check_days > 0 {
        items
            .iter()
            .filter(|item| {
                !item.username.is_empty()
                    && now - item.username_updated_at > prefs.email_check_days * DAY
            })
            .collect()
    } else {
        Vec::new()
    };
    let untagged: Vec<&VaultItem> = items.iter().filter(|item| item.tags.is_empty()).collect();
    let favorites = items.iter().filter(|item| item.favorite).count() as i32;
    let flagged = items.iter().filter(|item| item.needs_attention).count() as i32;
    let with_totp: Vec<&VaultItem> = items
        .iter()
        .filter(|item| !item.totp_secret.is_empty() || is_secured(&item.security))
        .collect();

    // ---- Score (L389-434): unique troubled logins, then the covered share
    let mut troubled: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for item in weak.iter().chain(stale.iter()).chain(email_check.iter()) {
        troubled.insert(item.id.as_str());
    }
    for item in items {
        if item.needs_attention {
            troubled.insert(item.id.as_str());
        }
    }
    let troubled_count = troubled.len() as i32;
    let clear = (total - troubled_count).max(0);
    let score = if empty {
        0
    } else {
        (((total - troubled_count) as f64 / total as f64) * 100.0)
            .round()
            .max(0.0) as i32
    };
    let score_label = if score >= 90 {
        "Excellent"
    } else if score >= 70 {
        "Good"
    } else if score >= 40 {
        "Needs work"
    } else {
        "At risk"
    };
    // The arc, as the TS dasharray worked it: r = 26 in a 64-unit view,
    // circumference 2πr, filled by the covered share. The donut the Slint
    // Path draws uses outer 29 / inner 23 around the same mid-radius.
    let angle = score as f64 * 3.6;
    let radians = angle.to_radians();
    let (sin, cos) = radians.sin_cos();
    let ring = DashRing {
        angle: angle as f32,
        end_outer_x: (32.0 + 29.0 * cos) as f32,
        end_outer_y: (32.0 + 29.0 * sin) as f32,
        end_inner_x: (32.0 + 23.0 * cos) as f32,
        end_inner_y: (32.0 + 23.0 * sin) as f32,
        large_arc: angle > 180.0,
        closed: score >= 100,
        score,
        label: score_label.into(),
        band: if score >= 90 { 0 } else if score >= 70 { 1 } else { 2 },
        clear,
        total,
    };

    // ---- Issues (L306-361): worst first, biggest first inside a severity
    // The channel id a stat or issue opens; `SharedString` so every field
    // below can take it directly.
    let id_of = |kind: ChannelKind| -> slint::SharedString {
        builtin_channels()
            .into_iter()
            .find(|channel| channel.kind == kind)
            .map(|channel| channel.id.into())
            .unwrap_or_else(|| "all".into())
    };
    let mut issues: Vec<DashIssue> = Vec::new();
    if !weak.is_empty() {
        issues.push(DashIssue {
            label: "Weak or reused passwords".into(),
            detail: "Short, guessable, or the same password used twice".into(),
            count: weak.len() as i32,
            severity: 0,
            channel: id_of(ChannelKind::Weak),
        });
    }
    if !stale.is_empty() {
        // The window is named because "overdue" means different things in
        // vaults with different reminders (TS L325).
        let detail = if prefs.password_age_days > 0 {
            format!(
                "Unchanged past the reminder window ({} days, per-login overrides apply)",
                prefs.password_age_days
            )
        } else {
            "Unchanged past the reminder window".to_string()
        };
        issues.push(DashIssue {
            label: "Rotation overdue".into(),
            detail: detail.into(),
            count: stale.len() as i32,
            severity: 0,
            channel: id_of(ChannelKind::Weak),
        });
    }
    if !email_check.is_empty() {
        issues.push(DashIssue {
            label: "Email review due".into(),
            detail: format!(
                "Addresses untouched past the check window ({} days)",
                prefs.email_check_days
            )
            .into(),
            count: email_check.len() as i32,
            severity: 1,
            channel: id_of(ChannelKind::All),
        });
    }
    if flagged > 0 {
        issues.push(DashIssue {
            label: "Flagged by you".into(),
            detail: "You marked these as needing attention".into(),
            count: flagged,
            severity: 1,
            channel: id_of(ChannelKind::Attention),
        });
    }
    if !untagged.is_empty() {
        issues.push(DashIssue {
            label: "Untagged logins".into(),
            detail: "Nothing to search them by later".into(),
            count: untagged.len() as i32,
            severity: 2,
            channel: "unassigned".into(),
        });
    }
    issues.sort_by_key(|issue| (issue.severity, -issue.count));
    let headline = issues
        .first()
        .cloned()
        .unwrap_or(DashIssue {
            label: "".into(),
            detail: "".into(),
            count: 0,
            severity: 0,
            channel: "".into(),
        });

    // ---- The four tiles (L403-428), notes included ------------------------
    let stats = vec![
        DashStat {
            value: total,
            label: "Total Logins".into(),
            note: format!("{} with a second factor", with_totp.len()).into(),
            channel: id_of(ChannelKind::All),
        },
        DashStat {
            value: favorites,
            label: "Favorites".into(),
            note: if favorites == 0 {
                "Star a login to pin it here".into()
            } else {
                "Pinned to the top of the list".into()
            },
            channel: id_of(ChannelKind::Favorites),
        },
        DashStat {
            value: weak.len() as i32,
            label: "Weak Passwords".into(),
            note: if weak.is_empty() {
                "Nothing short, reused or guessable".into()
            } else {
                "Short, reused or guessable".into()
            },
            channel: id_of(ChannelKind::Weak),
        },
        DashStat {
            value: untagged.len() as i32,
            label: "Untagged Logins".into(),
            note: if untagged.is_empty() {
                "Everything is filed".into()
            } else {
                "Nothing to search them by".into()
            },
            channel: "unassigned".into(),
        },
    ];

    // ---- Recent logins (L242-262): real recency first, then newest edits --
    let by_id: HashMap<&str, &VaultItem> =
        items.iter().map(|item| (item.id.as_str(), item)).collect();
    let mut recent: Vec<DashRow> = Vec::new();
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    let mut recency: Vec<(&str, i64, i64)> = usage
        .iter()
        .map(|(id, stat)| (id.as_str(), stat.at, stat.count))
        .collect();
    recency.sort_by(|a, b| b.1.cmp(&a.1));
    for (id, at, uses) in recency {
        let Some(item) = by_id.get(id).copied() else {
            continue;
        };
        if !seen.insert(id) {
            continue;
        }
        recent.push(recent_row(item, at, uses, prefs, now));
        if recent.len() >= 5 {
            break;
        }
    }
    if recent.len() < 5 {
        // Deterministic order for ties: the engine's own item order, as the
        // TS iterated its items array.
        let mut edits: Vec<&VaultItem> = items.iter().collect();
        edits.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        for item in edits {
            if !seen.insert(item.id.as_str()) {
                continue;
            }
            recent.push(recent_row(item, item.updated_at, 0, prefs, now));
            if recent.len() >= 5 {
                break;
            }
        }
    }

    // ---- Strength bands (L187-210) ----------------------------------------
    let mut band_counts = [0i32; 5];
    let mut with_password = 0i32;
    for item in items {
        if item.password.is_empty() {
            continue;
        }
        with_password += 1;
        // Clamped because the scorer answers 0..4 and a future one must not
        // be able to walk off the end of the list (TS L193-195).
        let band = estimate_strength(&item.password).score.clamp(0, 4) as usize;
        band_counts[band] += 1;
    }
    let segments: Vec<DashKey> = band_counts
        .iter()
        .enumerate()
        .filter(|(_, count)| **count > 0)
        .map(|(band, count)| DashKey {
            label: STRENGTH_LABELS[band].into(),
            count: *count,
            band: band as i32,
        })
        .collect();
    let keys: Vec<DashKey> = band_counts
        .iter()
        .enumerate()
        .map(|(band, count)| DashKey {
            label: STRENGTH_LABELS[band].into(),
            count: *count,
            band: band as i32,
        })
        .collect();

    // ---- The 30-day timeline (L213-235), oldest day first ----------------
    // TS: today at midnight, back 29 days; a login counts as *changed* if it
    // was also created that day only when the edit count exceeds the adds.
    let today_start = (now / DAY) * DAY;
    let start = today_start - 29 * DAY;
    let mut days: Vec<DashDay> = Vec::with_capacity(30);
    let mut days_added = 0i32;
    let mut days_changed = 0i32;
    for index in 0..30 {
        let day_start = start + index * DAY;
        let day_end = day_start + DAY;
        let added = items
            .iter()
            .filter(|item| item.created_at >= day_start && item.created_at < day_end)
            .count();
        let edited = items
            .iter()
            .filter(|item| item.updated_at >= day_start && item.updated_at < day_end)
            .count();
        let changed = edited.saturating_sub(added);
        days_added += added as i32;
        days_changed += changed as i32;
        let total_day = (added + changed) as f64;
        // The TS bar height curve: min(100, total*18 + (total ? 8 : 0))%.
        let fill = if total_day > 0.0 {
            ((total_day * 18.0 + 8.0) / 100.0).min(1.0)
        } else {
            0.0
        };
        days.push(DashDay {
            label: short_date(day_start).into(),
            added: added as i32,
            changed: changed as i32,
            fill: fill as f32,
        });
    }
    let has_days = days_added + days_changed > 0;

    // ---- Per-site counts (L145-165): subdomains collapsed -----------------
    let mut hosts: Vec<(String, i32)> = Vec::new();
    let mut host_index: HashMap<String, usize> = HashMap::new();
    for item in items {
        let Some(host) = hostname_of(&item.url) else {
            continue;
        };
        // Collapse subdomains so login.example.com and example.com are one
        // row (TS L150-152).
        let registrable = {
            let parts: Vec<&str> = host.split('.').collect();
            if parts.len() > 2 {
                parts[parts.len() - 2..].join(".")
            } else {
                host.clone()
            }
        };
        match host_index.get(&registrable) {
            Some(&slot) => hosts[slot].1 += 1,
            None => {
                host_index.insert(registrable.clone(), hosts.len());
                hosts.push((registrable, 1));
            }
        }
    }
    hosts.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    let biggest_site = hosts.first().map(|(_, count)| *count).unwrap_or(1).max(1);
    let domains: Vec<DashBar> = hosts
        .iter()
        .take(8)
        .map(|(host, count)| DashBar {
            label: host.clone().into(),
            count: *count,
            share: *count as f32 / biggest_site as f32,
            channel: "".into(),
        })
        .collect();

    // ---- Reuse clusters (L130-142): one row per shared password ----------
    let mut by_password: HashMap<&str, Vec<&VaultItem>> = HashMap::new();
    for item in items {
        if item.password.is_empty() {
            continue;
        }
        by_password
            .entry(item.password.as_str())
            .or_default()
            .push(item);
    }
    let mut clusters: Vec<Vec<&VaultItem>> = by_password
        .into_values()
        .filter(|group| group.len() > 1)
        .collect();
    for group in &mut clusters {
        group.sort_by(|a, b| a.title.cmp(&b.title));
    }
    clusters.sort_by(|a, b| b.len().cmp(&a.len()));
    let reuse: Vec<DashReuse> = clusters
        .iter()
        .take(5)
        .map(|group| DashReuse {
            count: group.len() as i32,
            sites: group
                .iter()
                .map(|item| label_of(item))
                .collect::<Vec<_>>()
                .join(", ")
                .into(),
        })
        .collect();

    // ---- Most used (L173-181): count first, recency second, top 20 -------
    let mut usage_rows: Vec<(&str, i64, i64)> = usage
        .iter()
        .map(|(id, stat)| (id.as_str(), stat.count, stat.at))
        .collect();
    usage_rows.sort_by(|a, b| b.1.cmp(&a.1).then(b.2.cmp(&a.2)));
    // Deleted logins drop out before the cap, exactly as TS filters before
    // it slices -- the foot line counts what the list can actually open.
    let survivors: Vec<DashUse> = usage_rows
        .iter()
        .filter_map(|(id, count, _)| {
            by_id.get(id).map(|item| DashUse {
                count: *count as i32,
                name: label_of(item).into(),
                item: (*id).into(),
            })
        })
        .collect();
    let uses_total = survivors.len().min(20) as i32;
    let uses: Vec<DashUse> = survivors.into_iter().take(20).collect();

    // ---- The review lists (L906-955): top 8 each, "+N more" --------------
    let emails_more = (email_check.len() as i32 - 8).max(0);
    let emails: Vec<DashRow> = email_check
        .iter()
        .take(8)
        .map(|item| review_row(item, prefs))
        .collect();
    let factors_more = (with_totp.len() as i32 - 8).max(0);
    let factors: Vec<DashRow> = with_totp
        .iter()
        .take(8)
        .map(|item| review_row(item, prefs))
        .collect();

    // ---- Channels (L367-380): biggest first, name as the tiebreak --------
    let mut channel_rows: Vec<(String, String, i32)> = builtin_channels()
        .into_iter()
        .map(|channel| {
            let count = apply_channel(&channel, items, prefs.password_age_days as f64).len() as i32;
            (channel.id, channel.name, count)
        })
        .collect();
    channel_rows.sort_by(|a, b| b.2.cmp(&a.2).then(a.1.cmp(&b.1)));
    let biggest_channel = channel_rows
        .first()
        .map(|(_, _, count)| *count)
        .unwrap_or(1)
        .max(1);
    let channels_more = (channel_rows.len() as i32 - 8).max(0);
    let channels: Vec<DashBar> = channel_rows
        .iter()
        .take(8)
        .map(|(id, name, count)| DashBar {
            label: name.clone().into(),
            count: *count,
            share: *count as f32 / biggest_channel as f32,
            channel: id.clone().into(),
        })
        .collect();

    let sub = if empty {
        "Your vault is empty — add a login to get started.".to_string()
    } else {
        format!("{total} {}", if total == 1 { "login" } else { "logins" })
    };

    DashboardData {
        ring,
        sub,
        empty,
        has_password: with_password > 0,
        has_headline: !issues.is_empty(),
        headline,
        stats,
        issues,
        recent,
        segments,
        keys,
        has_days,
        days,
        days_added: days_added as i32,
        days_changed: days_changed as i32,
        domains,
        reuse,
        uses,
        uses_total,
        emails,
        emails_more,
        factors,
        factors_more,
        channels,
        channels_more,
        tag_count: prefs.tags.len() as i32,
        channel_count: builtin_channels().len() as i32,
    }
}

/// One Recent-Logins row: name, masked meta with the use count, and the
/// relative time (Dashboard.tsx L603-607).
fn recent_row(item: &VaultItem, at: i64, uses: i64, prefs: &VaultPreferences, now: i64) -> DashRow {
    let mut meta = if prefs.mask_emails {
        mask_email(&item.username)
    } else {
        item.username.clone()
    };
    if meta.is_empty() {
        meta = hostname_of(&item.url).unwrap_or_default();
    }
    if uses > 0 {
        meta.push_str(&format!(" · {uses} use{}", if uses == 1 { "" } else { "s" }));
    }
    DashRow {
        name: label_of(item).into(),
        meta: meta.into(),
        right: relative_time(at, now).into(),
        item: item.id.clone().into(),
    }
}

/// One review-list row: name, and the (possibly masked) address
/// (Dashboard.tsx L919-923).
fn review_row(item: &VaultItem, prefs: &VaultPreferences) -> DashRow {
    DashRow {
        name: label_of(item).into(),
        meta: if prefs.mask_emails {
            mask_email(&item.username)
        } else {
            item.username.clone()
        }
        .into(),
        right: "".into(),
        item: item.id.clone().into(),
    }
}

/// `maskEmail` (site-intel.ts L234): the first one or two letters stay, the
/// rest of the local part becomes bullets, the domain stays readable.
///
/// Only ever what shoulders see — copying still copies the whole address.
/// Works on chars, not bytes, so an address in any script masks correctly.
pub fn mask_email(value: &str) -> String {
    let trimmed = value.trim();
    let Some(at) = trimmed.find('@') else {
        return trimmed.to_string();
    };
    if at == 0 {
        return trimmed.to_string();
    }
    let local = &trimmed[..at];
    let domain = &trimmed[at + 1..];
    let chars = local.chars().count();
    // TS: `slice(0, min(2, max(1, len - 1)))` — one letter addresses keep
    // their only letter, two-letter ones keep one, longer ones keep two.
    let keep = chars.saturating_sub(1).clamp(1, 2);
    let shown: String = local.chars().take(keep).collect();
    let bullets = "•".repeat(chars.saturating_sub(keep).max(1));
    format!("{shown}{bullets}@{domain}")
}

/// "12 Oct" — the short date the sparkline columns and their tooltips read.
/// The TS used the locale's own short month; the native build ships one
/// deterministic English set so two machines never disagree in a screenshot.
fn short_date(ms: i64) -> String {
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    // Civil-from-days, Howard Hinnant's algorithm: the local calendar day,
    // independent of the machine's time zone drift.
    let days = ms.div_euclid(DAY);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };
    format!("{d} {} {year}", MONTHS[(month - 1) as usize])
}

/// Push the snapshot into the screen's models. Called from `refresh_items`
/// whenever the dashboard channel is showing.
pub fn fill(ui: &MainWindow, data: &DashboardData) {
    use slint::{ModelRc, VecModel};
    let model = |rows: &Vec<DashRow>| ModelRc::new(VecModel::from(rows.clone()));

    ui.set_dash_ring(data.ring.clone());
    ui.set_dash_sub(data.sub.as_str().into());
    ui.set_dash_empty(data.empty);
    ui.set_dash_has_password(data.has_password);
    ui.set_dash_has_headline(data.has_headline);
    ui.set_dash_headline(data.headline.clone());
    ui.set_dash_stats(ModelRc::new(VecModel::from(data.stats.clone())));
    ui.set_dash_issues(ModelRc::new(VecModel::from(data.issues.clone())));
    ui.set_dash_recent(model(&data.recent));
    ui.set_dash_segments(ModelRc::new(VecModel::from(data.segments.clone())));
    ui.set_dash_keys(ModelRc::new(VecModel::from(data.keys.clone())));
    ui.set_dash_has_days(data.has_days);
    ui.set_dash_days(ModelRc::new(VecModel::from(data.days.clone())));
    ui.set_dash_days_added(data.days_added);
    ui.set_dash_days_changed(data.days_changed);
    ui.set_dash_domains(ModelRc::new(VecModel::from(data.domains.clone())));
    ui.set_dash_reuse(ModelRc::new(VecModel::from(data.reuse.clone())));
    ui.set_dash_uses(ModelRc::new(VecModel::from(data.uses.clone())));
    ui.set_dash_uses_total(data.uses_total);
    ui.set_dash_emails(model(&data.emails));
    ui.set_dash_emails_more(data.emails_more);
    ui.set_dash_factors(model(&data.factors));
    ui.set_dash_factors_more(data.factors_more);
    ui.set_dash_channels(ModelRc::new(VecModel::from(data.channels.clone())));
    ui.set_dash_channels_more(data.channels_more);
    ui.set_dash_tag_count(data.tag_count);
    ui.set_dash_channel_count(data.channel_count);
}

#[cfg(test)]
mod tests {
    use colax_core::{empty_item, normalise_preferences, UsageEntry};

    use super::*;

    /// A 20-login vault with one of everything: three favorites, a reuse
    /// cluster of three, one common password, two stale (which the weak
    /// union also claims), one flagged, two tagged, two with TOTP, spread
    /// across days for the timeline.
    ///
    /// The passwords are twenty *distinct* words on purpose: `pattern_stem`
    /// strips digits, so twenty "correct-horse-battery-staple-N" logins
    /// would be one pattern family — every login weak, and a fixture that
    /// cannot tell the buckets apart.
    fn fixture() -> (Vec<VaultItem>, VaultPreferences, std::collections::BTreeMap<String, UsageEntry>) {
        let now = 1_760_000_000_000i64; // fixed clock, mid-morning
        const WORDS: [&str; 20] = [
            "almond", "brocade", "cobalt", "delta", "ember", "filament", "granite", "harbor",
            "indigo", "jasper", "krypton", "lantern", "marble", "nectar", "onyx", "prairie",
            "quartz", "riverbed", "sandstone", "timber",
        ];
        let prefs = normalise_preferences(&serde_json::json!({
            "passwordAgeDays": 180,
            "emailCheckDays": 90,
        }));
        let mut items = Vec::new();
        for index in 0..20 {
            let mut item = empty_item(&format!("item-{index:02}"), now);
            item.title = format!("Site {index:02}");
            item.username = format!("user{index}@example.com");
            // One token with mixed case, a digit and a symbol: single token
            // so `passphrase_entropy` never claims it (two dictionary words
            // would read as a weak passphrase), mixed pool ~95 chars over
            // 9-11 of length → 59-73 bits → score 2-3, safely above the
            // weak line. The stem is lowercase+digits-stripped, so each
            // word keeps its own family and no bucket bleeds into another.
            item.password = format!("Qz{}7v!", WORDS[index]);
            // Subdomain over a distinct registrable host: five sites, four
            // logins each, once the subdomain collapses.
            item.url = format!("https://login{}.site{}.com/path", index % 3, index % 5);
            item.created_at = now - index as i64 * 3 * DAY;
            item.updated_at = item.created_at;
            item.password_updated_at = item.created_at;
            item.username_updated_at = item.created_at;
            items.push(item);
        }
        // Three logins sharing one password: the reuse cluster. The shared
        // string is its own stem, so it claims nothing else.
        items[2].password = "shared-secret-one".into();
        items[3].password = "shared-secret-one".into();
        items[4].password = "shared-secret-one".into();
        // One genuinely weak, unique password.
        items[5].password = "123456".into();
        // Two stale: password last changed a year ago -- and the weak union
        // counts stale, so the weak bucket is these two plus the four above.
        items[6].password_updated_at = now - 400 * DAY;
        items[7].password_updated_at = now - 400 * DAY;
        // One flagged.
        items[8].needs_attention = true;
        // Three favorites.
        items[0].favorite = true;
        items[1].favorite = true;
        items[2].favorite = true;
        // Two with TOTP.
        items[9].totp_secret = "JBSWY3DPEHPK3PXP".into();
        items[10].totp_secret = "KRSXG5CTMVRXEZLU".into();
        // Two tagged, so eighteen are untagged.
        items[11].tags = vec!["tag-a".into()];
        items[12].tags = vec!["tag-a".into()];
        // Two untouched usernames past the 90-day window.
        items[13].username_updated_at = now - 120 * DAY;
        items[14].username_updated_at = now - 120 * DAY;
        // The timeline's three moves: two added inside the window, one old
        // login changed inside it.
        items[15].created_at = now - 2 * DAY;
        items[15].updated_at = items[15].created_at;
        items[16].created_at = now - 1 * DAY;
        items[16].updated_at = now - 1 * DAY;
        items[17].created_at = now - 40 * DAY;
        items[17].updated_at = now - 1 * DAY;

        let mut usage = std::collections::BTreeMap::new();
        usage.insert("item-00".to_string(), UsageEntry { count: 9, at: now - 1_000 });
        usage.insert("item-01".to_string(), UsageEntry { count: 2, at: now - 2_000 });
        usage.insert("item-05".to_string(), UsageEntry { count: 5, at: now - 3_000 });
        usage.insert("item-99".to_string(), UsageEntry { count: 7, at: now }); // deleted

        (items, prefs, usage)
    }

    fn data() -> DashboardData {
        let now = 1_760_000_000_000i64;
        let (items, prefs, usage) = fixture();
        build(&items, &prefs, &usage, now)
    }

    #[test]
    fn empty_vault_scores_zero_and_says_so() {
        let prefs = normalise_preferences(&serde_json::json!({}));
        let built = build(&[], &prefs, &std::collections::BTreeMap::new(), 1_760_000_000_000);
        assert!(built.empty);
        assert_eq!(built.ring.score, 0);
        assert_eq!(built.ring.total, 0);
        assert!(!built.has_headline);
        assert_eq!(built.sub, "Your vault is empty — add a login to get started.");
        assert!(built.reuse.is_empty());
        assert!(!built.has_days);
    }

    #[test]
    fn buckets_match_the_ts_one_for_one() {
        let built = data();
        assert!(!built.empty);
        // weak = the reuse trio + "123456" + the two stale: find_weak_items
        // is a union, and staleness belongs to it (health.rs L56-59).
        assert_eq!(built.stats[2].value, 6);
        // stale: the two year-old passwords.
        assert_eq!(built.issues[1].count, 2);
        assert!(built.issues[1].detail.contains("180 days"));
        // flagged: one.
        assert_eq!(built.issues[3].label, "Flagged by you");
        // untagged: the two tagged items leave 18.
        assert_eq!(built.stats[3].value, 18);
        // favorites: three.
        assert_eq!(built.stats[1].value, 3);
        // total tile: 20, with 2 second factors.
        assert_eq!(built.stats[0].value, 20);
        assert!(built.stats[0].note.starts_with("2 with"));
    }

    #[test]
    fn score_is_the_covered_share_and_labels_it() {
        // troubled = weak(6) ∪ stale(2) ∪ flagged(1) ∪ email(2), with stale
        // sitting inside weak: 9 unique → clear = 11, score = 55.
        let built = data();
        assert_eq!(built.ring.clear, 11);
        assert_eq!(built.ring.total, 20);
        assert_eq!(built.ring.score, 55);
        assert_eq!(built.ring.label, "Needs work");
        assert_eq!(built.ring.band, 2);
        // The arc's end point lies on the outer circle at the swept angle.
        // The struct holds f32 (Slint's float), so the epsilon is an f32's,
        // not an f64's.
        let radians = (built.ring.score as f32 * 3.6).to_radians();
        let dx = built.ring.end_outer_x - 32.0;
        let dy = built.ring.end_outer_y - 32.0;
        assert!((dx.hypot(dy) - 29.0).abs() < 1e-4);
        assert!((dx - 29.0 * radians.cos()).abs() < 1e-4);
    }

    #[test]
    fn issues_sort_worst_first_then_biggest() {
        let built = data();
        let labels: Vec<&str> = built.issues.iter().map(|i| i.label.as_str()).collect();
        // severity 0: weak (6) before stale (2); then severity 1: email (2)
        // before flagged (1); then severity 2: untagged.
        assert_eq!(
            labels,
            [
                "Weak or reused passwords",
                "Rotation overdue",
                "Email review due",
                "Flagged by you",
                "Untagged logins"
            ]
        );
        assert_eq!(built.headline.label, "Weak or reused passwords");
        assert!(built.has_headline);
    }

    #[test]
    fn reuse_clusters_group_by_password_largest_first() {
        let built = data();
        assert_eq!(built.reuse.len(), 1);
        assert_eq!(built.reuse[0].count, 3);
        assert!(built.reuse[0].sites.contains("Site 02"));
        assert!(built.reuse[0].sites.contains("Site 03"));
        assert!(built.reuse[0].sites.contains("Site 04"));
    }

    #[test]
    fn per_site_counts_collapse_subdomains_and_cap_at_eight() {
        let built = data();
        // Five registrable hosts (index % 5), evenly spread 4/4/4/4/4.
        assert_eq!(built.domains.len(), 5);
        assert_eq!(built.domains[0].count, 4);
        assert!((built.domains[0].share - 1.0).abs() < 1e-6);
        // Every host is a registrable pair, no subdomain paths left.
        assert!(built.domains.iter().all(|bar| !bar.label.contains("login")));
    }

    #[test]
    fn most_used_ranks_by_count_ignores_deleted() {
        let built = data();
        // item-00 (9), item-05 (5), item-01 (2); item-99 is deleted.
        assert_eq!(built.uses.len(), 3);
        assert_eq!(built.uses[0].count, 9);
        assert_eq!(built.uses[0].name, "Site 00");
        assert_eq!(built.uses[1].count, 5);
        assert_eq!(built.uses[2].item, "item-01");
        // TS filters deleted entries before it slices, so the foot line
        // counts only rows the list can actually open: three, not four.
        assert_eq!(built.uses_total, 3);
    }

    #[test]
    fn recent_logins_prefers_real_recency_then_newest_edits() {
        let built = data();
        assert_eq!(built.recent.len(), 5);
        // The three usage entries first, by `at` desc: item-00, 01, 05.
        assert_eq!(built.recent[0].item, "item-00");
        assert_eq!(built.recent[1].item, "item-01");
        assert_eq!(built.recent[2].item, "item-05");
        // Then the newest edits fill: item-17/16 changed a day ago.
        assert_eq!(built.recent[3].item, "item-16");
        assert_eq!(built.recent[4].item, "item-17");
        // The use count rides the meta line.
        assert!(built.recent[0].meta.contains("9 uses"));
    }

    #[test]
    fn strength_bands_count_passwords_only_and_key_covers_all_five() {
        let built = data();
        // 20 passwords: one very weak ("123456"), the rest strong-ish by the
        // scorer — assert the totals, not the scorer's opinion.
        assert_eq!(built.keys.iter().map(|k| k.count).sum::<i32>(), 20);
        assert_eq!(built.keys.len(), 5);
        // Segments only carry non-empty bands.
        assert!(built.segments.iter().all(|s| s.count > 0));
        assert!(built.has_password);
    }

    #[test]
    fn timeline_counts_creates_and_the_one_pure_edit() {
        let built = data();
        assert!(built.has_days);
        // Ten of the fixture's logins are 3-27 days old (index * 3) and land
        // inside the window, plus item-15 and item-16: 12 added. Exactly one
        // day carries a pure change — item-17 was edited a day ago but
        // created outside the window, so it cannot read as an add.
        assert_eq!(built.days_added, 12);
        assert_eq!(built.days_changed, 1);
        assert_eq!(built.days.len(), 30);
        // Oldest first: only the last three days carry anything.
        assert_eq!(built.days[0].fill, 0.0);
        assert!(built.days[29].fill > 0.0);
    }

    #[test]
    fn review_lists_carry_the_right_names_and_more_counts() {
        let built = data();
        // Email check: the two untouched usernames.
        assert_eq!(built.emails.len(), 2);
        assert_eq!(built.emails_more, 0);
        // The address is masked: first letter, bullets, readable domain.
        assert!(built.emails[0].meta.ends_with("@example.com"));
        assert!(built.emails[0].meta.starts_with('u'));
        assert!(built.emails[0].meta.contains('•'));
        // Second factors: the two TOTP logins.
        assert_eq!(built.factors.len(), 2);
    }

    #[test]
    fn channel_bars_cover_the_builtins_largest_first() {
        let built = data();
        assert_eq!(built.channels.len(), builtin_channels().len());
        // The all channel carries every login: it is the biggest bar.
        assert_eq!(built.channels[0].count, 20);
        assert!((built.channels[0].share - 1.0).abs() < 1e-6);
        // Every bar names a channel the rail can open.
        assert!(built.channels.iter().all(|bar| !bar.channel.is_empty()));
    }

    #[test]
    fn mask_email_port_matches_the_ts() {
        assert_eq!(mask_email(""), "");
        assert_eq!(mask_email("  "), "");
        assert_eq!(mask_email("nobody@example.com"), "no••••@example.com");
        assert_eq!(mask_email("ab@x.test"), "a•@x.test");
        assert_eq!(mask_email("a@x.test"), "a•@x.test");
        assert_eq!(mask_email("not-an-address"), "not-an-address");
        // Two letters: keep one (TS `min(2, max(1, len - 1))`).
        assert_eq!(mask_email("jo@site.test"), "j•@site.test");
        // Three letters: keep two.
        assert_eq!(mask_email("joe@site.test"), "jo•@site.test");
    }

    #[test]
    fn short_date_formats_like_the_ts_locale_set() {
        // 2025-10-09 00:00 UTC → "9 Oct 2025" (days algorithm, no tz drift).
        assert_eq!(short_date(1_759_977_600_000), "9 Oct 2025");
        // 2024-02-29 (leap day) → "29 Feb 2024".
        assert_eq!(short_date(1_709_164_800_000), "29 Feb 2024");
    }
}
