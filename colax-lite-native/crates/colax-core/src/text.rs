// The two date shapes the editor shows: `YYYY-MM-DD` for an input, and a human
// age for the line under it.
//
// Port of `toDateInput`, `fromDateInput` and `relativeTime` in
// `E:\acc2\src\vault\types.ts:177-243` (Task 1.8 of
// `docs/plans/2026-10-13-colax-lite-native-full-ui.md`, whose `hostname_of`
// lands in this file too), which is what the Organise section of the item
// editor renders. The web build gets calendar days from a native
// `<input type="date">` — that widget works in *local* time — so both halves
// here go through the machine's own offset, or the day would come out wrong
// for anyone not on UTC by a whole morning or evening.
use time::{Date, Month, OffsetDateTime, UtcOffset};

/// The machine's own UTC offset, falling back to UTC when the OS declines to
/// say (the `time` crate can refuse while other threads are running). A wrong
/// answer here shifts `to_date_input` and `from_date_input` by the same
/// amount, so the field still round-trips — it is only the *day* that could
/// land a day out, exactly once, at the two extremes of the clock.
fn local_offset() -> UtcOffset {
    UtcOffset::current_local_offset().unwrap_or(UtcOffset::UTC)
}

/// `YYYY-MM-DD` in local time — `toDateInput`, types.ts L236.
pub fn to_date_input(timestamp_ms: i64) -> String {
    match OffsetDateTime::from_unix_timestamp(timestamp_ms.div_euclid(1000)) {
        Ok(at) => {
            let date = at.to_offset(local_offset()).date();
            format!("{:04}-{:02}-{:02}", date.year(), u8::from(date.month()), date.day())
        }
        // A timestamp the `time` crate cannot place (year out of range) shows
        // as an empty field rather than a wrong date.
        Err(_) => String::new(),
    }
}

/// `YYYY-MM-DD` back to a timestamp — `fromDateInput`, types.ts L229.
///
/// TS appends `T12:00:00` before parsing: a date-time with no zone is read as
/// *local* (a bare date would be UTC), and noon keeps the stamp on the right
/// side of a DST switch in the small hours. None when the text is not a real
/// calendar date, which is the same input a native date field rejects — the
/// draft then keeps its previous value, exactly as TS does when its parse
/// fails.
pub fn from_date_input(value: &str) -> Option<i64> {
    let mut parts = value.trim().split('-');
    let year: i32 = parts.next()?.parse().ok()?;
    let month: u8 = parts.next()?.parse().ok()?;
    let day: u8 = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    let date = Date::from_calendar_date(year, Month::try_from(month).ok()?, day).ok()?;
    let noon = date.with_hms(12, 0, 0).ok()?.assume_offset(local_offset());
    Some(noon.unix_timestamp() * 1000)
}

/// Human-friendly relative age, e.g. "3 days ago" — `relativeTime`, types.ts
/// L177. The date fields show this under the input so an age reads without
/// having to work out what today minus that day is.
///
/// Ported from the code, quirks included: minutes are pluralised
/// unconditionally ("1 minutes ago"), minutes and hours *round* rather than
/// floor, and past a month the count is a flat 30 days rather than the
/// average month. The TS unit table at the foot of the function is unreachable
/// — every branch above it returns — so it has no counterpart here.
pub fn relative_time(timestamp_ms: i64, now_ms: i64) -> String {
    // `Math.max(0, Math.round((now - timestamp) / 1000))`: a stamp in the
    // future reads as zero seconds, i.e. "just now", not as a negative age.
    let seconds = ((now_ms - timestamp_ms) as f64 / 1000.0).round().max(0.0) as i64;
    if seconds < 45 {
        return "just now".to_string();
    }
    if seconds < 3600 {
        return format!("{} minutes ago", (seconds as f64 / 60.0).round());
    }
    // Hours, not minutes. "120 minutes ago" is the same fact as "2 hours ago"
    // written in a way nobody says.
    if seconds < 86_400 {
        let hours = (seconds as f64 / 3600.0).round() as i64;
        return format!("{hours} hour{} ago", plural(hours));
    }

    // Past a day, round down to two units: knowing it is three days old is
    // the useful part, and the hour only matters when it is close enough to
    // be worth acting on.
    let days = seconds / 86_400;
    let hours = (seconds % 86_400) / 3600;
    let day_part = format!("{days} day{}", plural(days));
    if days < 30 {
        if hours == 0 {
            return format!("{day_part} ago");
        }
        return format!("{day_part} {hours} hour{} ago", plural(hours));
    }
    // A month as a flat 30 days rather than the average 30.44. Averaging
    // leaves a remainder that is off by one against how people count months,
    // which reads as a bug in a value the user is meant to trust.
    let months = days / 30;
    let rest_days = days - months * 30;
    format!(
        "{months} month{}{} ago",
        plural(months),
        if rest_days > 0 {
            format!(" {rest_days} day{}", plural(rest_days))
        } else {
            String::new()
        }
    )
}

fn plural(n: i64) -> &'static str {
    if n == 1 {
        ""
    } else {
        "s"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_round_trip_through_local_noon() {
        // Whatever offset the test machine runs at, typing a day and having it
        // redrawn must give back the same day.
        for day in ["2026-06-15", "1999-12-31", "2000-01-01"] {
            let at = from_date_input(day).expect("a real date parses");
            assert_eq!(to_date_input(at), day);
        }
        // Unpadded input is accepted and redrawn padded, as the TS parse does.
        assert_eq!(to_date_input(from_date_input("2026-6-5").unwrap()), "2026-06-05");
    }

    #[test]
    fn a_date_that_does_not_exist_is_refused() {
        for bad in ["", "   ", "abc", "2026-02-30", "2026-13-01", "2026-00-10", "15/06/2026", "2026-06-15 extra", "2026-06"] {
            assert!(from_date_input(bad).is_none(), "{bad:?} should not parse");
        }
    }

    #[test]
    fn relative_ages_match_the_typescript_strings() {
        let now = 1_760_000_000_000i64;
        let cases: [(i64, &str); 11] = [
            (now - 10_000, "just now"),
            // The 45s threshold is on the *rounded* second count, so 44.499s
            // is still "just now" and 44.5s is already a minute.
            (now - 44_499, "just now"),
            // TS pluralises this branch unconditionally: the rounded count is
            // a singular number and it still says "minutes". Pinned, not
            // approved.
            (now - 45_000, "1 minutes ago"),
            (now - 90_000, "2 minutes ago"),
            (now - 3_600_000, "1 hour ago"),
            (now - 5_400_000, "2 hours ago"),
            (now - 86_400_000, "1 day ago"),
            (now - 90_000_000, "1 day 1 hour ago"),
            (now - 45 * 86_400_000, "1 month 15 days ago"),
            (now - 30 * 86_400_000, "1 month ago"),
            // A stamp ahead of the clock is clamped, never negative.
            (now + 60_000, "just now"),
        ];
        for (at, want) in cases {
            assert_eq!(relative_time(at, now), want, "for stamp {at}");
        }
    }

    #[test]
    fn the_year_and_a_half_old_stamp_counts_months_not_weeks() {
        // The app's own `ago` (items.rs) stops at weeks; this one does not,
        // which is the point of having both ported rather than shared.
        let now = 1_760_000_000_000i64;
        assert_eq!(relative_time(now - 400 * 86_400_000, now), "13 months 10 days ago");
    }
}
