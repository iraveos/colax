//! The toast stack — the Rust half of `.toasts` in app.css and of `useToasts`
//! in hooks.ts.
//!
//! The web keeps toast state in React with one `setTimeout` per card; a timer
//! per card here would be four kinds of bookkeeping for the same shelf, so
//! this module runs the ledger itself on one repeating Slint timer instead:
//!
//! - `notify` appends a card. The TS keeps at most three
//!   (`setToasts((current) => [...current.slice(-2), card])`), so a fourth
//!   drops the oldest with no ceremony, the way the TS's array write does.
//! - each card carries its own clock: 2200ms of life (hooks.ts
//!   `notify`'s default `duration`), then the card is *marked leaving* rather
//!   than removed — `dismiss` in the TS sets `leaving: true` first and drops
//!   the node once `TOAST_EXIT_MS` (200ms) has played, because removing it
//!   outright is what made every message blink out mid-sentence.
//! - the drain hairline's fraction of life left is pushed every tick; the
//!   card's slide and fade happen on the Slint side, in place, off the row
//!   data changing.
//!
//! A thread-local ledger, the way `alarms::RANG` already works: the app is
//! one window on one thread, and `notice`'s call sites get `ui` alone.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use slint::{Model, ModelRc, VecModel};

use crate::{MainWindow, ToastRow};

/// hooks.ts L494: `const TOAST_EXIT_MS = 200;`
const EXIT_MS: f64 = 200.0;
/// hooks.ts `notify`'s default `duration = 2200`.
const LIFE_MS: f64 = 2200.0;
/// The TS caps the stack at three: `[...current.slice(-2), card]`.
const MAX_STACK: usize = 3;

struct LiveToast {
    id: u32,
    text: String,
    tone: i32,
    start_ms: f64,
    duration_ms: f64,
    /// Set the moment the card is marked leaving; `Some` is the stamp, and
    /// the card comes off the stack EXIT_MS later.
    leaving_ms: Option<f64>,
}

thread_local! {
    static LIVE: RefCell<Vec<LiveToast>> = RefCell::new(Vec::new());
    static MODEL: RefCell<Option<Rc<VecModel<ToastRow>>>> = const { RefCell::new(None) };
    static NEXT_ID: Cell<u32> = const { Cell::new(1) };
    static CLOCK: RefCell<Option<slint::Timer>> = const { RefCell::new(None) };
}

/// `colax_core::util::now_ms`, for the stamps the ledger compares.
fn now_ms() -> f64 {
    colax_core::util::now_ms() as f64
}

/// `notify(message, tone = 'ok', duration = 2200)` (hooks.ts L509). `tone` is
/// 0 ok, 1 error — the card's icon and drain colour only.
pub(crate) fn notify(text: &str, tone: i32, duration_ms: f64) {
    let id = NEXT_ID.with(|next| {
        let id = next.get();
        next.set(id + 1);
        id
    });
    LIVE.with(|live| {
        let mut live = live.borrow_mut();
        if live.len() >= MAX_STACK {
            live.remove(0);
        }
        live.push(LiveToast {
            id,
            text: text.to_string(),
            tone,
            start_ms: now_ms(),
            duration_ms,
            leaving_ms: None,
        });
    });
    ensure_clock();
    repaint();
}

/// The repeating tick, started the moment `notify` puts a card up. It stops
/// itself the tick the stack empties, so between cards there is no timer
/// running at all — the useToasts equivalent of nothing owning a `setTimeout`
/// while the shelf is empty.
fn ensure_clock() {
    let running = CLOCK.with(|clock| {
        let mut running = false;
        if let Some(clock) = clock.borrow().as_ref() {
            running = clock.running();
        }
        running
    });
    if running {
        return;
    }
    let timer = slint::Timer::default();
    timer.start(
        slint::TimerMode::Repeated,
        std::time::Duration::from_millis(33),
        repaint,
    );
    CLOCK.with(|slot| *slot.borrow_mut() = Some(timer));
}

/// `useToasts()`'s tick, on one 33ms timer while anything is up. Rust owns
/// the whole lifecycle so the cards can leave in order rather than all
/// sharing the first `setTimeout` that fired.
fn repaint() {
    let now = now_ms();
    // Prune first: a card whose life has run is marked leaving, and one that
    // has been leaving long enough comes off.
    LIVE.with(|live| {
        let mut live = live.borrow_mut();
        for toast in live.iter_mut() {
            if toast.leaving_ms.is_none() && now - toast.start_ms >= toast.duration_ms {
                toast.leaving_ms = Some(now);
            }
        }
        live.retain(|toast: &LiveToast| {
            toast
                .leaving_ms
                .map(|at| now - at < EXIT_MS)
                .unwrap_or(true)
        });
    });

    MODEL.with(|model| {
        let model = if let Some(model) = model.borrow().as_ref() {
            model.clone()
        } else {
            return;
        };
        // Reconcile the rows against the ledger: rows are appended, edited in
        // place, and dropped from the front only when the stack cap evicts.
        // Row-level writes (rather than one wholesale `set_vec`) are what keep
        // the Slint elements alive across ticks, so the slide and fade
        // animations play instead of restarting every frame.
        LIVE.with(|live| {
            let live = live.borrow();
            let mut row = 0;
            for toast in live.iter() {
                let progress = ((now - toast.start_ms) / toast.duration_ms).clamp(0.0, 1.0);
                let leaving = toast.leaving_ms.is_some();
                if row < model.row_count() {
                    let current = model.row_data(row).expect("row exists");
                    if current.id == toast.id as i32 {
                        if (current.text != toast.text)
                            || (current.tone != toast.tone)
                            || (current.leaving != leaving)
                            || ((current.progress - progress as f32).abs() > 0.004)
                        {
                            model.set_row_data(
                                row,
                                ToastRow {
                                    id: toast.id as i32,
                                    text: toast.text.clone().into(),
                                    tone: toast.tone,
                                    leaving,
                                    progress: progress as f32,
                                },
                            );
                        }
                    } else {
                        model.set_row_data(
                            row,
                            ToastRow {
                                id: toast.id as i32,
                                text: toast.text.clone().into(),
                                tone: toast.tone,
                                leaving,
                                progress: progress as f32,
                            },
                        );
                    }
                } else {
                    let _ = model.insert_row(
                        row,
                        ToastRow {
                            id: toast.id as i32,
                            text: toast.text.clone().into(),
                            tone: toast.tone,
                            leaving,
                            progress: progress as f32,
                        },
                    );
                }
                row += 1;
            }
            // Anything beyond the ledger is a card that has gone. Removing
            // only happens after its fade has played, so at that point the
            // row is already invisible.
            while model.row_count() > row {
                let _ = model.remove_row(model.row_count() - 1);
            }
        });
    });

    // Nothing left to show: the tick stops itself, as the TS timers would
    // once their clear callbacks closed the last card.
    if !LIVE.with(|live| live.borrow().is_empty()) {
        return;
    }
    CLOCK.with(|clock| {
        if let Some(clock) = clock.borrow().as_ref() {
            clock.stop();
        }
    });
}

/// `pub(crate) fn notice(ui: &MainWindow, text: &str)`, kept whole for its
/// ~40 call sites: the shape (`notice(ui, text)`) did not need to change,
/// only where the text goes.
pub(crate) fn notice(text: &str) {
    notify(text, 0, LIFE_MS);
}

/// What the top card reads, for the dev walkers and the render check: the
/// thing `ui.get_notice_text()` used to answer.
pub(crate) fn top_text() -> String {
    LIVE.with(|live| {
        live.borrow()
            .iter()
            .find(|toast| toast.leaving_ms.is_none())
            .map(|toast| toast.text.clone())
            .unwrap_or_default()
    })
}

/// One manual reconcile for the render check: the tick is a repeating timer
/// the sweep does not stop for, so the check pumping the ledger itself is
/// what makes a raised card visible to the model it asserts on.
#[cfg(debug_assertions)]
pub(crate) fn pump() {
    repaint();
}

/// How many up cards read exactly `text`: the render check's assertion that
/// a raised toast is on the stack and still there after a synchronous dump.
#[cfg(debug_assertions)]
pub(crate) fn cards_reading(text: &str) -> usize {
    let mut found = 0;
    MODEL.with(|model| {
        if let Some(model) = model.borrow().as_ref() {
            for row in 0..model.row_count() {
                if model.row_data(row).map(|r| r.text == text) == Some(true) {
                    found += 1;
                }
            }
        }
    });
    found
}

/// `main()` wires the model up once, right after the window exists — the
/// render check reads it before any card is raised. The clock starts the
/// moment the first `notify` lands, not here.
pub(crate) fn install(ui: &MainWindow) {
    let model = Rc::new(VecModel::<ToastRow>::default());
    ui.set_toasts(ModelRc::from(model.clone()));
    MODEL.with(|slot| *slot.borrow_mut() = Some(model));
    ensure_clock();
}
