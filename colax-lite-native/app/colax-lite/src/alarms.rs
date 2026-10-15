//! The alarm ticker — Task 7.3, port of `src/ui/useAlarms.ts` (66 lines).
//!
//! One tick a second reads the wall clock and matches it against the alarms
//! stored in preferences (`Alarm` in colax-core): a tick lands, the enabled
//! alarms whose `HH:MM` equals the minute ring — sound unless the vault is
//! muted, toast always — and `lastFired` keeps each one to a single ring per
//! minute. The matcher is lifted out as a pure function so the rules are
//! tested without waiting for a minute to pass; this file owns the clock,
//! the interval and the audio.
//!
//! The Settings tab that *edits* alarms lands with Phase 5 (`AlarmsPanel` is
//! reachable only through it, Settings.tsx L1443); the engine, the chime and
//! the mute gate are here now, so that tab arrives wired.

use std::cell::RefCell;
use std::collections::HashMap;
use std::time::Duration;

use colax_core::{normalise_alarms, Alarm};
use slint::ComponentHandle;
use time::OffsetDateTime;

use crate::{notice, MainWindow, Shared};

/// One reading of the wall clock in the shape the matcher wants: "HH:MM" in
/// local time, the `Date.getDay()` number (0 = Sunday .. 6 = Saturday), and
/// the per-minute stamp that keeps an alarm from ringing twice inside the
/// same minute (`useAlarms` L13-17).
pub struct Clock {
    pub hhmm: String,
    pub day: u8,
    pub stamp: String,
}

/// Any instant turned into a clock reading, laid out exactly as JS builds
/// it: the stamp's month is zero-based because `Date.getMonth()` is, and
/// only the clock part is padded — `"2000-0-2 09:05"`.
pub fn clock_at(now: OffsetDateTime) -> Clock {
    let (year, month, day) = now.to_calendar_date();
    let hhmm = format!("{:02}:{:02}", now.hour(), now.minute());
    let stamp = format!("{}-{}-{} {}", year, u8::from(month) - 1, day, hhmm);
    Clock {
        hhmm,
        // `Date.getDay()` numbering: Sunday 0 .. Saturday 6, which is what
        // time calls the zero-indexed number of days from Sunday.
        day: now.weekday().number_days_from_sunday(),
        stamp,
    }
}

/// The local clock. `now_local` can fail to find an offset (never on
/// Windows; a sandboxed clock elsewhere) — UTC then, so a tick is late by
/// an offset rather than missing forever.
fn local_now() -> OffsetDateTime {
    match OffsetDateTime::now_local() {
        Ok(local) => local,
        Err(_) => OffsetDateTime::now_utc(),
    }
}

/// The wall clock's next minute as "HH:MM" — what the dev walk arms so the
/// gate ("an alarm set one minute out fires") needs one wait, not a day.
pub fn next_minute() -> String {
    let now = local_now();
    let total = now.hour() as u32 * 60 + now.minute() as u32 + 1;
    format!("{:02}:{:02}", (total / 60) % 24, total % 60)
}

/// Which alarms are due at this reading — `useAlarms` L19-26, rule for
/// rule: an off alarm is skipped, the time must equal the minute exactly, a
/// day list must contain today's `Date.getDay()` number while an empty list
/// is every day, and an id that already rang under this stamp is done for
/// the minute.
///
/// Returns indexes rather than alarms: a ring needs the struct, but an
/// imported sound's data URL is not a string a tick should copy.
pub fn due_at(
    alarms: &[Alarm],
    clock: &Clock,
    last_fired: &HashMap<String, String>,
) -> Vec<usize> {
    alarms
        .iter()
        .enumerate()
        .filter(|(_, alarm)| {
            alarm.enabled
                && alarm.time == clock.hhmm
                && (alarm.days.is_empty() || alarm.days.contains(&clock.day))
                && last_fired.get(&alarm.id).map(String::as_str) != Some(clock.stamp.as_str())
        })
        .map(|(index, _)| index)
        .collect()
}

thread_local! {
    /// `lastFired` (useAlarms L6): id -> the stamp it last rang in.
    static LAST_FIRED: RefCell<HashMap<String, String>> = RefCell::new(HashMap::new());
    /// Every toast this process raised, oldest first — a dump can read it
    /// after the visible strip has cleared itself (2.5s).
    static RANG: RefCell<Vec<String>> = RefCell::new(Vec::new());
    /// The output stream, opened on first ring and kept for the thread's
    /// life: dropping it ends playback, and `OutputStream` is !Send, so the
    /// tick's thread is the only place it can live.
    static AUDIO: RefCell<Option<Audio>> = RefCell::new(None);
}

struct Audio {
    _stream: rodio::OutputStream,
    handle: rodio::OutputStreamHandle,
    sinks: Vec<rodio::Sink>,
}

/// Every toast raised since launch, ", "-joined: the walk's proof that the
/// match happened, because the strip itself only lives 2.5s.
pub fn fired_log() -> String {
    RANG.with(|rang| rang.borrow().join(", "))
}

/// Ring one alarm: sound unless muted, toast always — "Muted alarms still
/// toast — silence is about sound, not about missing the reminder"
/// (App.tsx L276-281).
fn ring(ui: &MainWindow, alarm: &Alarm, muted: bool) {
    if !muted {
        play_sound(alarm);
    }
    // `Alarm: ${alarm.label || alarm.time}` (App.tsx L280).
    let toast = format!(
        "Alarm: {}",
        if alarm.label.is_empty() {
            &alarm.time
        } else {
            &alarm.label
        }
    );
    RANG.with(|rang| rang.borrow_mut().push(toast.clone()));
    notice(ui, &toast);
}

/// One second, one comparison — the body of `setInterval(..., 1000)`
/// (useAlarms L12-31). The state borrow ends before any sound or toast
/// starts, so a ring never holds the vault while it plays.
pub fn tick(ui: &MainWindow, state: &Shared) {
    let (due, muted) = {
        let guard = state.borrow();
        let raw = guard.engine.preferences();
        let alarms = normalise_alarms(raw.get("alarms"));
        let muted = colax_core::sounds_muted_from(raw);
        let clock = clock_at(local_now());
        let due = LAST_FIRED.with(|last| {
            let mut last = last.borrow_mut();
            due_at(&alarms, &clock, &last)
                .into_iter()
                .map(|index| {
                    last.insert(alarms[index].id.clone(), clock.stamp.clone());
                    alarms[index].clone()
                })
                .collect::<Vec<_>>()
        });
        (due, muted)
    };
    for alarm in due {
        ring(ui, &alarm, muted);
    }
}

/// The interval itself: one tick a second for the life of the window —
/// `useAlarms` has no off switch, because a reminder has to ring whether or
/// not anyone is looking. The handle is forgotten the way the app's other
/// keep-alive timers are; dropping it would stop the countdown before the
/// first minute ever arrived.
pub fn start(ui: &MainWindow, state: &Shared) {
    let timer = slint::Timer::default();
    let weak = ui.as_weak();
    let st = state.clone();
    timer.start(
        slint::TimerMode::Repeated,
        Duration::from_secs(1),
        move || {
            if let Some(ui) = weak.upgrade() {
                tick(&ui, &st);
            }
        },
    );
    std::mem::forget(timer);
}

/// Hand a source to a sink, opening the output stream on first use. A
/// machine with no usable device stays quiet instead of failing — the TS
/// lets `audio.play()` reject and moves on.
///
/// The source arrives as a closure rather than a generic parameter on
/// purpose: `Source: Iterator where Self::Item: Sample` is a where-clause,
/// and it does not travel through `impl Trait`, so every `append` here is
/// checked at a concrete type where the bounds are plain to see.
fn with_sink(append: impl FnOnce(&rodio::Sink)) {
    AUDIO.with(|audio| {
        let mut slot = audio.borrow_mut();
        if slot.is_none() {
            match rodio::OutputStream::try_default() {
                Ok((stream, handle)) => {
                    *slot = Some(Audio {
                        _stream: stream,
                        handle,
                        sinks: Vec::new(),
                    });
                }
                Err(_) => return,
            }
        }
        let Some(audio) = slot.as_mut() else {
            return;
        };
        // A sink stops when dropped; finished ones make room for the next.
        audio.sinks.retain(|sink| !sink.empty());
        if let Ok(sink) = rodio::Sink::try_new(&audio.handle) {
            append(&sink);
            audio.sinks.push(sink);
        }
    });
}

/// Play the alarm's own sound, or the chime when it has none or will not
/// decode — `playAlarmSound` (useAlarms L60-71), whose `play().catch(...)`
/// falls back to the chime the same way (L64).
fn play_sound(alarm: &Alarm) {
    let decoded = alarm
        .sound
        .as_ref()
        .and_then(|sound| sound.data_url.as_deref())
        .and_then(|url| decode_data_url(url).ok())
        .and_then(|bytes| rodio::Decoder::new(std::io::Cursor::new(bytes)).ok());
    match decoded {
        Some(decoder) => with_sink(|sink| sink.append(decoder)),
        None => play_chime(),
    }
}

/// `data:[<mime>][;base64],<bytes>` down to its bytes. The TS only ever
/// builds these from a FileReader read (Settings), which is base64 after
/// the comma, so splitting on the first comma is the whole parse.
fn decode_data_url(url: &str) -> Result<Vec<u8>, ()> {
    use base64::Engine as _;
    if !url.starts_with("data:") {
        return Err(());
    }
    let (_, payload) = url.split_once(',').ok_or(())?;
    base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|_| ())
}

/// `playDefaultChime` (useAlarms L33-56): three sine tones — 880, 660 and
/// 990 Hz — started 180ms apart, each 180ms long, its gain climbing
/// 0.0001 -> 0.18 over 20ms and falling back over the next 140ms along the
/// same exponential ramps WebAudio draws. 44.1kHz mono, 0.54s all told.
pub fn default_chime() -> Vec<f32> {
    const NOTES: [f32; 3] = [880.0, 660.0, 990.0];
    const RATE: u32 = 44_100;
    let slot = (0.18 * RATE as f32).round() as usize;
    let mut out = vec![0.0f32; slot * NOTES.len()];
    for (i, freq) in NOTES.iter().enumerate() {
        for n in 0..slot {
            let t = n as f32 / RATE as f32;
            out[i * slot + n] = (t * freq * std::f32::consts::TAU).sin() * envelope(t);
        }
    }
    out
}

/// The WebAudio envelope: exponential up over the first 20ms, down over
/// the next 140ms, floor 0.0001 until the oscillator stops at 180ms.
fn envelope(t: f32) -> f32 {
    const FLOOR: f32 = 0.0001;
    const PEAK: f32 = 0.18;
    if t < 0.02 {
        FLOOR * (PEAK / FLOOR).powf(t / 0.02)
    } else if t < 0.16 {
        PEAK * (FLOOR / PEAK).powf((t - 0.02) / 0.14)
    } else {
        FLOOR
    }
}

fn play_chime() {
    with_sink(|sink| {
        sink.append(Samples {
            samples: default_chime().into_iter(),
            rate: 44_100,
        });
    });
}

/// A finished buffer as a rodio source: mono at 44.1kHz, counted out by
/// the iterator itself.
struct Samples {
    samples: std::vec::IntoIter<f32>,
    rate: u32,
}

impl Iterator for Samples {
    type Item = f32;

    fn next(&mut self) -> Option<f32> {
        self.samples.next()
    }
}

impl rodio::Source for Samples {
    fn current_frame_len(&self) -> Option<usize> {
        None
    }

    fn channels(&self) -> u16 {
        1
    }

    fn sample_rate(&self) -> u32 {
        self.rate
    }

    fn total_duration(&self) -> Option<Duration> {
        Some(Duration::from_secs_f64(
            self.samples.len() as f64 / self.rate as f64,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn alarm(id: &str, time: &str, days: Vec<u8>) -> Alarm {
        Alarm {
            id: id.into(),
            label: String::new(),
            time: time.into(),
            days,
            sound: None,
            enabled: true,
        }
    }

    fn clock(hhmm: &str, day: u8, stamp: &str) -> Clock {
        Clock {
            hhmm: hhmm.into(),
            day,
            stamp: stamp.into(),
        }
    }

    fn fired(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(id, stamp)| (id.to_string(), stamp.to_string()))
            .collect()
    }

    #[test]
    fn the_minute_must_match_the_alarm_exactly() {
        let alarms = [alarm("al_1", "14:30", vec![])];
        let due = due_at(&alarms, &clock("14:30", 2, "2026-9-15 14:30"), &HashMap::new());
        assert_eq!(due, vec![0]);

        let due = due_at(&alarms, &clock("14:31", 2, "2026-9-15 14:31"), &HashMap::new());
        assert!(due.is_empty());
    }

    #[test]
    fn a_disabled_alarm_never_rings() {
        let mut alarms = [alarm("al_1", "14:30", vec![])];
        alarms[0].enabled = false;
        let due = due_at(&alarms, &clock("14:30", 2, "x"), &HashMap::new());
        assert!(due.is_empty());
    }

    #[test]
    fn an_empty_day_list_is_every_day_and_a_full_one_is_pick() {
        let every_day = [alarm("al_1", "14:30", vec![])];
        let mondays = [alarm("al_2", "14:30", vec![1])];

        // Tuesday (2): the empty list rings, the Monday-only one does not.
        let due = due_at(&every_day, &clock("14:30", 2, "x"), &HashMap::new());
        assert_eq!(due, vec![0]);
        let due = due_at(&mondays, &clock("14:30", 2, "x"), &HashMap::new());
        assert!(due.is_empty());

        // Monday (1): both ring.
        let due = due_at(&mondays, &clock("14:30", 1, "x"), &HashMap::new());
        assert_eq!(due, vec![0]);
    }

    #[test]
    fn one_alarm_rings_once_per_stamp_but_again_next_minute() {
        let alarms = [alarm("al_1", "14:30", vec![])];
        let this = clock("14:30", 2, "2026-9-15 14:30");
        let next = clock("14:30", 2, "2026-9-15 15:30");

        let last = fired(&[("al_1", "2026-9-15 14:30")]);
        assert!(due_at(&alarms, &this, &last).is_empty());
        // A different stamp (another day's same clock, or a later minute
        // under a different label) is a fresh chance to ring.
        assert_eq!(due_at(&alarms, &next, &last), vec![0]);
    }

    #[test]
    fn the_stamp_follows_javascript_numbering() {
        // 2000-01-02 was a Sunday: Date.getDay() 0, Date.getMonth() 0.
        let date = time::Date::from_calendar_date(2000, time::Month::January, 2).unwrap();
        let at = time::Time::from_hms(9, 5, 0).unwrap();
        let clock = clock_at(OffsetDateTime::new_utc(date, at));
        assert_eq!(clock.hhmm, "09:05");
        assert_eq!(clock.day, 0);
        assert_eq!(clock.stamp, "2000-0-2 09:05");
    }

    #[test]
    fn the_chime_is_the_three_tones_and_envelope_of_the_typescript() {
        let chime = default_chime();
        // 0.18s per note, three notes, 44.1kHz — the TS timeline exactly.
        assert_eq!(chime.len(), 44_100 * 54 / 100);

        let peak = chime
            .iter()
            .fold(0.0f32, |m, s| m.max(s.abs()));
        // The envelope's ceiling is 0.18; the tones do make themselves heard.
        assert!(peak <= 0.180_001);
        assert!(peak > 0.09);

        // The first millisecond is the floor of the ramp, inaudible on
        // purpose — the TS sets 0.0001 before it starts climbing.
        assert!(chime[..44].iter().all(|s| s.abs() < 0.001));
    }

    #[test]
    fn only_a_data_url_with_base64_after_the_comma_decodes() {
        use base64::Engine as _;
        let encoded = base64::engine::general_purpose::STANDARD.encode(b"Hello");
        let url = format!("data:audio/wav;base64,{encoded}");
        assert_eq!(decode_data_url(&url).unwrap(), b"Hello");

        assert!(decode_data_url("https://example.com/ping.mp3").is_err());
        assert!(decode_data_url("data:audio/wav;base64").is_err());
        assert!(decode_data_url("data:audio/wav;base64,%%%").is_err());
    }
}
