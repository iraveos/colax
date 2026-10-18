//! Is the window being watched? — the port of `src/lib/activity.ts`.
//!
//! A window that is minimized, hidden in the tray, or simply behind another
//! app is not being looked at, and the ambient mesh drifts on a 26-32 second
//! loop that paints the whole window. The web answers the question in two
//! halves — `document.visibilityState` for hidden and `window focus` for a
//! window that is on screen but behind another app — and Windows answers both
//! with one question: does the foreground window belong to this process? A
//! minimized or hidden window can never own the foreground, so the ownership
//! test covers the visibility half too.
//!
//! One place answers it (`app_active` on the window) so the things that stop
//! when nobody is looking — the mesh's drift here, the carousel's drift in
//! `main.rs` — do not each keep their own idea of "visible".

use slint::ComponentHandle;

use crate::MainWindow;

/// The truth right now, for the loops that cannot wait for a change.
#[cfg(windows)]
pub fn active_now() -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowThreadProcessId,
    };

    // SAFETY: both calls are queries, and the handle handed to the second one
    // came from the first, checked for null. Nothing is retained.
    unsafe {
        let foreground = GetForegroundWindow();
        if foreground as isize == 0 {
            // No window owns the input focus at all (a session that is locked
            // or being switched away from). Nobody is watching this one.
            return false;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(foreground, &mut pid);
        pid == std::process::id()
    }
}

/// A tray-only build and the tests have no window to ask about; the honest
/// answer is that nothing here has stopped being used.
#[cfg(not(windows))]
pub fn active_now() -> bool {
    true
}

/// The poll: once a second, the period Chromium throttles a hidden page's
/// timers to, because there is nothing to be faster than.
///
/// The window starts out `true` (the optimistic default `activity.ts` also
/// reads), so a cold launch animates from the first frame and this corrects it
/// within the second if that was wrong. The handle is forgotten the way the
/// app's other keep-alive timers are; dropping it would stop the poll before
/// the window ever lost focus.
pub fn start(ui: &MainWindow) {
    let timer = slint::Timer::default();
    let weak = ui.as_weak();
    timer.start(
        slint::TimerMode::Repeated,
        std::time::Duration::from_secs(1),
        move || {
            if let Some(ui) = weak.upgrade() {
                let now = active_now();
                // A write is what repaints anything; an unchanged answer is
                // left alone, so a second of standing still costs one query.
                if ui.get_app_active() != now {
                    ui.set_app_active(now);
                }
            }
        },
    );
    std::mem::forget(timer);
}
