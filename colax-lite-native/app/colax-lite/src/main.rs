//! Colax Lite's native desktop shell -- Phase 0's window, tray, autostart
//! and stored state, plus Phase 2's vault screens.
//!
//! One Rust binary drawing its own window: no WebView2, no Chromium, no
//! Node. Everything the OS is asked to do lives here as an ordinary
//! function call -- the same capability-per-function rule the Tauri shell
//! kept, minus the IPC, because there is no renderer to talk to.
//!
//! The vault engine itself lives in `colax-core`; this file is the state
//! machine between its results and the screens declared in
//! `ui/main.slint`. Every handler follows one rule: engine work happens in
//! a short borrow, UI properties are set afterwards, because setting
//! `screen` re-enters this code through `changed screen` and
//! `search-changed`.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod appearance;
mod items;
mod platform;

use std::cell::RefCell;
use std::fs;
use std::path::PathBuf;
use std::rc::Rc;

use colax_core::{
    estimate_strength, generate_passphrase, generate_password, resolve_header, BackupFile,
    GeneratorOptions, VaultEngine, VaultError, VaultItem, VaultProtection, VaultStorage,
};
use serde::{Deserialize, Serialize};
use slint::{ComponentHandle, ModelRc, VecModel, Weak};

slint::include_modules!();

const STATE_FILE: &str = "shell.json";
/// The directory the Tauri shell used, so window/tray switches made by the
/// WebView build hand straight over to this one.
const APP_DIR: &str = "app.colax.lite";
/// Same Run-key value name Electron's and Tauri's builds used, so an upgrade
/// never leaves two entries starting the app.
const AUTOSTART_VALUE: &str = "Colax Lite";
/// The window title, also what the tray's Show action looks up by name.
const WINDOW_TITLE: &str = "Colax Lite";

/* ==========================================================================
Stored shell state
========================================================================== */

/// What the shell remembers between launches, in `%APPDATA%\app.colax.lite\shell.json`.
///
/// `max_savings` and `gpu` are WebView2 launch switches: this build reads them
/// never but writes them back unchanged, so the file round-trips with the
/// Tauri build instead of quietly resetting its switches. Nothing here is
/// secret -- it is window chrome, so it lives in plain JSON as before.
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
struct ShellState {
    max_savings: bool,
    gpu: bool,
    tray_enabled: bool,
    close_to_tray: bool,
    launch_at_login: bool,
    sounds_muted: bool,
}

impl Default for ShellState {
    fn default() -> Self {
        // Mirrors the Tauri shell's defaults so a first launch and a stored
        // launch agree and nothing flips on the first write.
        Self {
            max_savings: true,
            gpu: true,
            tray_enabled: true,
            close_to_tray: true,
            launch_at_login: false,
            sounds_muted: false,
        }
    }
}

/// Where this profile keeps its files.
///
/// `COLAX_DEV_DIR` redirects both `shell.json` and `vault.json` at a
/// scratch directory, so a debug build can be driven with demo data without
/// ever opening -- let alone overwriting -- the real vault. Debug builds
/// only; a release build always uses the real config directory, because a
/// switch that repointed the app at somebody else's file would be a bug of a
/// different order.
fn app_dir() -> PathBuf {
    if cfg!(debug_assertions) {
        if let Some(dir) = std::env::var_os("COLAX_DEV_DIR") {
            return PathBuf::from(dir);
        }
    }
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(APP_DIR)
}

fn state_path() -> PathBuf {
    app_dir().join(STATE_FILE)
}

fn read_state() -> ShellState {
    fs::read_to_string(state_path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Best-effort write: a read-only config directory must not stop the app.
///
/// Written alongside the preferences copy of the same four switches, so the
/// tray (alive before unlock) and the vault agree â€” see `mirror_shell_flags`.
fn write_state(state: ShellState) {
    let path = state_path();
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(raw) = serde_json::to_string_pretty(&state) {
        let _ = fs::write(path, raw);
    }
}

/* ==========================================================================
Launch at login (Windows Run key)
========================================================================== */

/// Writes or clears the per-user Run entry.
///
/// HKCU only -- no elevation, no machine-wide change, and reversible by the
/// same switch that set it. Ported verbatim from the Tauri shell: the key,
/// the value name and the quoting are all load-bearing.
#[cfg(windows)]
fn apply_autostart(enabled: bool) {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegDeleteValueW, RegOpenKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER,
        KEY_SET_VALUE, REG_SZ,
    };

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    let subkey = wide("Software\\Microsoft\\Windows\\CurrentVersion\\Run");
    let name = wide(AUTOSTART_VALUE);
    let mut key: HKEY = std::ptr::null_mut();

    // SAFETY: `subkey` and `name` are NUL-terminated UTF-16 buffers that outlive
    // every call, and `key` is checked against the documented success code
    // before any value is written through it.
    unsafe {
        if RegOpenKeyExW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            0,
            KEY_SET_VALUE,
            &mut key,
        ) != ERROR_SUCCESS
        {
            return;
        }

        if enabled {
            let exe = std::env::current_exe().unwrap_or_default();
            // Quoted, because an install path with a space in it would
            // otherwise be read as a command plus an argument.
            let command = wide(&format!("\"{}\"", exe.display()));
            RegSetValueExW(
                key,
                name.as_ptr(),
                0,
                REG_SZ,
                command.as_ptr() as *const u8,
                (command.len() * std::mem::size_of::<u16>()) as u32,
            );
        } else {
            RegDeleteValueW(key, name.as_ptr());
        }

        RegCloseKey(key);
    }
}

#[cfg(not(windows))]
fn apply_autostart(_enabled: bool) {}

/* ==========================================================================
Window chrome
========================================================================== */

/// Finds this process's own top-level window.
///
/// EnumWindows filtered by PID and exact title, not `FindWindowW(NULL, ...)`:
/// winit registers its windows under the generic class "Window Class", and
/// FindWindow with a null class name does not match it -- measured, not assumed.
/// The tray's message window carries an empty title, so the title check
/// is what keeps this from returning that instead.
#[cfg(windows)]
fn find_main_window() -> isize {
    use windows_sys::core::BOOL;
    use windows_sys::Win32::Foundation::{HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextW, GetWindowThreadProcessId,
    };

    const TRUE: BOOL = 1;
    const FALSE: BOOL = 0;

    struct Search {
        pid: u32,
        title: Vec<u16>,
        hwnd: isize,
    }

    unsafe extern "system" fn callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
        // SAFETY: EnumWindows passes back exactly the pointer we handed it,
        // alive for the duration of the call.
        let search = &mut *(lparam as *mut Search);

        let mut window_pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut window_pid);
        if window_pid != search.pid {
            return TRUE;
        }

        let mut buf = [0u16; 64];
        let len = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32) as usize;
        if len > 0 && buf[..len] == search.title[..] {
            search.hwnd = hwnd as isize;
            return FALSE; // found; stop enumerating
        }
        TRUE
    }

    let mut search = Search {
        pid: std::process::id(),
        title: WINDOW_TITLE.encode_utf16().collect(), // no NUL: compared by length
        hwnd: 0,
    };

    // SAFETY: the callback only touches `search`, which outlives the call.
    unsafe {
        EnumWindows(Some(callback), &mut search as *mut Search as LPARAM);
    }
    search.hwnd
}

/// Brings the window back from the tray: show, un-minimize, hand it the
/// foreground -- the same show + unminimize + set_focus the Tauri shell did.
fn show_window(ui: &MainWindow) {
    let _ = ui.show();
    ui.window().set_minimized(false);
    focus_main_window();
}

/// Gives the window the foreground.
///
/// Windows only lets a process take the foreground while it owns the input
/// event, and a tray-menu click counts as ours -- so this runs inside one.
#[cfg(windows)]
fn focus_main_window() {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::SetForegroundWindow;

    let hwnd = find_main_window();
    if hwnd == 0 {
        return;
    }
    // SAFETY: the handle came from EnumWindows against our own PID moments ago.
    unsafe {
        SetForegroundWindow(hwnd as HWND);
    }
}

#[cfg(not(windows))]
fn focus_main_window() {}

/* ==========================================================================
Vault UI state
========================================================================== */

/// Everything the handlers share: the engine, plus the two pieces of
/// in-flight input that outlive a single screen (the chosen password
/// between the create stages, the parsed backup before its password is
/// entered).
///
/// Behinds a `RefCell` because the Slint callbacks are plain `Fn` closures
/// on one thread -- no `Send`/`Sync` needed, but the borrows still have to
/// be short: `goto` re-enters handlers.
struct AppState {
    engine: VaultEngine,
    pending_password: String,
    pending_backup: Option<BackupFile>,
    /// The row the strip at the bottom of the list offers to put back. Kept
    /// whole rather than as an id, because `delete_item` has already dropped
    /// the record by the time Undo is pressed.
    last_deleted: Option<VaultItem>,
}

type Shared = Rc<RefCell<AppState>>;

fn vault_path() -> PathBuf {
    app_dir().join("vault.json")
}

/// The screen a locked or missing vault should start on.
fn startup_screen(engine: &VaultEngine) -> Result<Screen, VaultError> {
    if !engine.exists() {
        return Ok(Screen::CreateChoose);
    }
    match engine.protection()? {
        Some(VaultProtection::Device) => Ok(Screen::UnlockDevice),
        _ => Ok(Screen::UnlockPassword),
    }
}

/// Where locking sends the user -- derived fresh each time, because the
/// protection can change when a password is added or removed.
fn lock_screen_for(engine: &VaultEngine) -> Screen {
    match engine.protection() {
        Ok(Some(VaultProtection::Device)) => Screen::UnlockDevice,
        _ => Screen::UnlockPassword,
    }
}

/// Rebuilds the visible rows from the engine and the current query.
///
/// Called after every screen change (the query box resets with it) and on
/// each keystroke. Reads the query from the UI rather than from a handler
/// argument so both paths stay identical.
///
/// Three models go out together â€” the rail, the cards and the count â€” because
/// they are one derivation: channel filter, then sort, then text query. Pushing
/// them separately would let them disagree mid-keystroke.
fn refresh_items(ui: &MainWindow, state: &Shared) {
    let query = ui.get_search_text().to_lowercase();
    let channel_id = ui.get_active_channel().to_string();
    let guard = state.borrow();
    let prefs = items::prefs_from(guard.engine.preferences());
    let channel = items::channel_by_id(&channel_id);
    let (cards, sidebar, total) = match guard.engine.items() {
        Some(items) => {
            let cards = items::build_cards(items, &channel, &prefs, &query);
            let sidebar = items::build_sidebar(items, &channel_id, &prefs);
            (cards, sidebar, items.len())
        }
        None => (Vec::new(), items::build_sidebar(&[], &channel_id, &prefs), 0),
    };
    drop(guard);

    let shown = cards.len();
    let label = if query.is_empty() && shown == total {
        format!("{total} {}", if total == 1 { "login" } else { "logins" })
    } else {
        format!("{shown} of {total} {}", if total == 1 { "login" } else { "logins" })
    };

    // The empty state names the *channel*, because "no matches" and "this
    // view is empty" are different problems with different fixes.
    let (empty_title, empty_hint) = if total == 0 {
        (
            "No logins yet",
            "Use Import to bring your logins over from Colax Lite.",
        )
    } else if shown == 0 {
        match channel.id.as_str() {
            "all" => ("No logins yet", "Add one, or import from Colax Lite."),
            "favorites" => (
                "No favorites",
                "Star a login to keep it one click away.",
            ),
            "attention" => (
                "Nothing needs attention",
                "Logins you flag will show up here.",
            ),
            "weak" => (
                "No weak passwords",
                "Everything here is unique, current and strong.",
            ),
            "history" => (
                "No changes yet",
                "Edits and restores are listed here once they happen.",
            ),
            _ => ("Nothing here yet", "This view has no logins in it."),
        }
    } else {
        ("", "")
    };

    ui.set_cards(ModelRc::new(VecModel::from(cards)));
    ui.set_sidebar(ModelRc::new(VecModel::from(sidebar)));
    ui.set_count_label(label.into());
    ui.set_channel_name(channel.name.as_str().into());
    ui.set_show_urls(prefs.show_urls);
    ui.set_cards_empty_title(empty_title.into());
    ui.set_cards_empty_hint(empty_hint.into());
}

/// Switches screens. Setting `screen` runs `changed screen` in the Slint
/// file, which clears the messages and the typed-in text; the refresh
/// afterwards re-reads the now-empty query.
///
/// Must be called with no borrow of `AppState` held -- it takes its own.
fn goto(ui: &MainWindow, state: &Shared, screen: Screen) {
    ui.set_screen(screen);
    refresh_items(ui, state);
}

/// A green strip that clears itself. `Timer::single_shot` owns its own
/// lifetime, so there is nothing to keep alive here.
fn notice(ui: &MainWindow, text: &str) {
    ui.set_notice_text(text.into());
    let weak = ui.as_weak();
    slint::Timer::single_shot(std::time::Duration::from_millis(2500), move || {
        if let Some(ui) = weak.upgrade() {
            ui.set_notice_text("".into());
        }
    });
}

fn tray_lock_enabled(tray: &Weak<AppTray>, enabled: bool) {
    if let Some(tray) = tray.upgrade() {
        tray.set_lock_enabled(enabled);
    }
}

/* ---- Flows -------------------------------------------------------------- */

/// Debug-only: build a throwaway vault full of representative logins and
/// open it, so the shell can be seen with real content.
///
/// Gated on `debug_assertions` and `COLAX_DEV_SEED`, and only ever writes to
/// `COLAX_DEV_DIR`. A release build contains neither the code nor the flag:
/// this exists so a screenshot can be taken of the rail and the card list
/// without a human typing six logins into a scratch profile first.
#[cfg(debug_assertions)]
fn dev_seed(ui: &MainWindow, state: &Shared, tray: &Weak<AppTray>) -> bool {
    if std::env::var_os("COLAX_DEV_SEED").is_none() {
        return false;
    }
    if std::env::var_os("COLAX_DEV_DIR").is_none() {
        eprintln!("COLAX_DEV_SEED also needs COLAX_DEV_DIR: refusing to seed the real vault");
        return false;
    }

    let created = {
        let mut guard = state.borrow_mut();
        let result = (|| -> Result<(), VaultError> {
            if !guard.engine.exists() {
                guard.engine.create(None)?;
            } else if !guard.engine.is_unlocked() {
                guard.engine.unlock("")?;
            }
            if guard.engine.items().map(|items| items.is_empty()).unwrap_or(true) {
                for draft in demo_drafts() {
                    guard.engine.add_item(&draft)?;
                }
            }
            Ok(())
        })();
        result
    };

    match created {
        Ok(()) => {
            goto(ui, state, Screen::Vault);
            tray_lock_enabled(tray, true);
            true
        }
        Err(err) => {
            ui.set_error_text(err.to_string().into());
            false
        }
    }
}

/// Debug-only: the scratch profile can also be dropped straight onto a screen
/// that is normally several clicks away.
///
/// The clicks this would otherwise need do not reach the window when another
/// process holds the foreground, and "click the thing and look at it" is the
/// only honest way to check a layout -- so the harness drives the screen
/// instead of the mouse.
///
/// `COLAX_DEV_SCREEN` takes `vault`, `new` (a blank editor), `editor` (a
/// saved login), or `editor-<section>` for any of its tabs.
#[cfg(debug_assertions)]
fn dev_screen(ui: &MainWindow, state: &Shared) {
    let Ok(want) = std::env::var("COLAX_DEV_SCREEN") else {
        return;
    };
    let want = want.to_lowercase();
    if want.is_empty() || want == "vault" {
        return;
    }
    if want == "new" {
        open_editor(ui, state, "");
        return;
    }

    let id = state
        .borrow()
        .engine
        .items()
        .and_then(|items| items.first().map(|item| item.id.clone()));
    let Some(id) = id else { return };
    open_editor(ui, state, &id);

    if let Some(section) = want.strip_prefix("editor-") {
        ui.set_editor_section(section.into());
        if section == "credentials" {
            // The generator is the tallest thing the panel has to fit, so it
            // is the one worth opening when measuring.
            ui.set_gen_show(true);
            regenerate(ui);
        }
    }

    // Temporary: what the UI actually holds, so a blank field can be told
    // apart from a blank draft -- and so a screen that changes on its own
    // cannot be blamed on whatever was clicked last.
    if std::env::var_os("COLAX_DEV_DUMP").is_some() {
        let _ = std::fs::remove_file(app_dir().join("dev-dump.txt"));
        dev_dump(ui, "before-first-frame");

        // The tab round trip: visit another section and come back, which
        // destroys and rebuilds every field here. A `<=>` re-established
        // that late is the one thing that could quietly blank the draft, and
        // a screenshot cannot show it -- the fields look the same whether
        // they hold the old value or "".
        //
        // Driven by one repeating timer rather than nested one-shots so the
        // samples bracket the moment the harness captures: if the window
        // looks wrong in the picture, the line beside it says what the app
        // thought it was showing.
        let start = ui.get_editor_section().to_string();
        let other = if start == "notes" { "flags" } else { "notes" }.to_string();
        let weak = ui.as_weak();
        let counter = std::rc::Rc::new(std::cell::Cell::new(0u32));
        let tick = counter.clone();
        let timer = slint::Timer::default();
        timer.start(
            slint::TimerMode::Repeated,
            std::time::Duration::from_millis(400),
            move || {
                let n = tick.get();
                tick.set(n + 1);
                if n > 20 {
                    return;
                }
                let Some(ui) = weak.upgrade() else { return };
                match n {
                    3 => {
                        dev_dump(&ui, "t1.2");
                        ui.invoke_editor_section_selected(other.clone().into());
                    }
                    5 => {
                        dev_dump(&ui, "t2.0");
                        ui.invoke_editor_section_selected(start.clone().into());
                    }
                    8 => dev_dump(&ui, "t3.2"),
                    13 => dev_dump(&ui, "t5.2"),
                    17 => dev_dump(&ui, "t6.8"),
                    20 => dev_dump(&ui, "t8.0"),
                    _ => {}
                }
            },
        );
        // Dropping the handle would stop it before the timeline is finished.
        std::mem::forget(timer);
        let _ = counter;
    }
}

/// Debug-only: write what the UI actually holds, so a blank field can be
/// told apart from a blank draft.
///
/// Runs twice when `COLAX_DEV_DUMP` is set: once before the first frame and
/// again a beat later. Only the second one is trustworthy -- the `Editor`'s
/// elements come into existence during the first render, and whatever they
/// write into the draft when they do is invisible to a dump taken earlier.
#[cfg(debug_assertions)]
fn dev_dump(ui: &MainWindow, tag: &str) {
    let dump = format!(
        "{tag}: editor={} vault={} section=[{}] id=[{}] title=[{}] url=[{}] username=[{}] password=[{}] notes=[{}] fav={} attn={} days={} label=[{}]\n",
        ui.get_screen() == Screen::Editor,
        ui.get_screen() == Screen::Vault,
        ui.get_editor_section(),
        ui.get_edit_id(),
        ui.get_edit_title(),
        ui.get_edit_url(),
        ui.get_edit_username(),
        ui.get_edit_password(),
        ui.get_edit_notes(),
        ui.get_edit_favorite(),
        ui.get_edit_needs_attention(),
        ui.get_edit_reminder_days(),
        ui.get_edit_reminder_label(),
    );
    let path = app_dir().join("dev-dump.txt");
    let mut existing = std::fs::read_to_string(&path).unwrap_or_default();
    existing.push_str(&dump);
    let _ = std::fs::write(path, existing);
}

/// A spread of logins chosen to exercise the cards: a favorite, a stale one,
/// a reused password, an old password, a note-only login, and something with
/// a username and nothing else.
#[cfg(debug_assertions)]
fn demo_drafts() -> Vec<serde_json::Value> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let days = |n: i64| now - n * 86_400_000;
    let row = |title: &str, username: &str, url: &str, password: &str, extra: serde_json::Value| {
        let mut draft = serde_json::json!({
            "title": title,
            "username": username,
            "url": url,
            "password": password,
            "createdAt": days(900),
            "updatedAt": days(3),
            // `add_item` spreads the draft over `emptyItem`, whose own stamps
            // are "now" -- so without these every card would read "Created
            // just now" no matter how old the login is meant to be.
            "passwordUpdatedAt": days(3),
            "usernameUpdatedAt": days(900),
        });
        draft.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        draft
    };

    vec![
        row(
            "GitHub",
            "iraveos",
            "https://github.com",
            // A strong random password: this row is the "nothing wrong" card
            // in the screenshot, so it must not pick up a `weak` badge.
            "9x!Km2$vQpLz7Rw",
            serde_json::json!({ "favorite": true, "showMail": true }),
        ),
        row(
            "Proton Mail",
            "iraveos@proton.me",
            "https://mail.proton.me",
            "Pr0ton-super-secret-1",
            serde_json::json!({}),
        ),
        row(
            "Work VPN",
            "iraveos",
            "https://vpn.example.com",
            "password",
            serde_json::json!({ "updatedAt": days(400) }),
        ),
        row(
            "Gym Wi-Fi",
            "",
            "",
            "member2019",
            serde_json::json!({ "updatedAt": days(700) }),
        ),
        row(
            "Old Bank",
            "iraveos",
            "https://bank.example.com",
            "Pr0ton-super-secret-1",
            serde_json::json!({ "notes": "Call the branch before resetting.", "updatedAt": days(400) }),
        ),
        row(
            "Zephyr",
            "",
            "https://zephyr.example.com",
            "short",
            serde_json::json!({ "needsAttention": true }),
        ),
        row(
            "Delta Bank",
            "iraveos",
            "https://delta.example.com",
            // A mixed random string rather than a word passphrase: the
            // estimator deliberately reads known-word passphrases as weaker
            // than their length suggests, so only a random one reliably earns
            // no `weak` badge.
            "V7#kq2Lm!zR9wXe",
            // The only login with a second factor: it is the one that has to
            // earn the `2FA` badge, and the one that must not earn `weak`.
            serde_json::json!({ "security": { "totp": { "seed": "JBSWY3DPEHPK3PXP" } } }),
        ),
    ]
}

/// First run: make a vault with the chosen protection and land in it.
fn create_vault(ui: &MainWindow, state: &Shared, tray: &Weak<AppTray>, password: Option<&str>) {
    ui.set_busy(true);
    let result = { state.borrow_mut().engine.create(password) };
    ui.set_busy(false);
    match result {
        Ok(()) => {
            state.borrow_mut().pending_password.clear();
            goto(ui, state, Screen::Vault);
            tray_lock_enabled(tray, true);
            notice(ui, "Vault created.");
        }
        Err(err) => ui.set_error_text(err.to_string().into()),
    }
}

/// Unlock with a password; the empty string means "device vault".
fn unlock_with(ui: &MainWindow, state: &Shared, password: &str) {
    ui.set_busy(true);
    let result = { state.borrow_mut().engine.unlock(password) };
    ui.set_busy(false);
    match result {
        Ok(true) => {
            // Unlock re-reads the document, so the preferences may have
            // changed since boot (another device, a restore, an import).
            refresh_appearance(ui, state);
            goto(ui, state, Screen::Vault);
        }
        Ok(false) => {
            ui.set_password_value("".into());
            ui.set_error_text("That vault password is not correct.".into());
        }
        Err(err) => {
            ui.set_password_value("".into());
            ui.set_error_text(err.to_string().into());
        }
    }
}

/// Re-pushes the vault's preferences into the Theme global. Safe to call any
/// time the engine has a document; a no-op with nothing to read.
fn refresh_appearance(ui: &MainWindow, state: &Shared) {
    let prefs = {
        let guard = state.borrow();
        colax_core::normalise_preferences(guard.engine.preferences())
    };
    appearance::apply_appearance(ui, &prefs);
}

/// Writes preferences back through the engine and re-applies them, the
/// `savePreferences` path in `hooks.ts:useVault`. Returns false when the write
/// failed, so a settings screen can say so rather than pretend it held.
fn save_prefs(ui: &MainWindow, state: &Shared, prefs: &colax_core::VaultPreferences) -> bool {
    let raw = match serde_json::to_value(prefs) {
        Ok(raw) => raw,
        Err(_) => return false,
    };
    let saved = state
        .borrow_mut()
        .engine
        .save_preferences(raw)
        .is_ok();
    if saved {
        appearance::apply_appearance(ui, prefs);
    }
    saved
}

/// The four shell switches exist twice â€” in `shell.json` (read by the tray,
/// which is alive before any vault is unlocked) and in the vault's
/// preferences (so they follow a backup to another machine). Any change must
/// land in both, and the shell file is written first: it is the one the next
/// launch reads for tray behaviour even if the vault write is refused.
fn mirror_shell_flags(ui: &MainWindow, state: &Shared, shell: &mut ShellState, prefs: &colax_core::VaultPreferences) {
    shell.tray_enabled = prefs.tray_enabled;
    shell.close_to_tray = prefs.close_to_tray;
    shell.launch_at_login = prefs.launch_at_login;
    shell.sounds_muted = prefs.sounds_muted;
    write_state(*shell);
    // The Run key is an OS change, not a preference: apply it as it flips.
    apply_autostart(prefs.launch_at_login);
    save_prefs(ui, state, prefs);
}

/// Replace this device's vault with a parsed backup, keeping whatever
/// protection the backup itself carried.
fn restore_backup(
    ui: &MainWindow,
    state: &Shared,
    tray: &Weak<AppTray>,
    backup: BackupFile,
    password: Option<&str>,
) {
    ui.set_busy(true);
    let result = {
        state
            .borrow_mut()
            .engine
            .restore_backup(&backup, password, None)
    };
    ui.set_busy(false);
    match result {
        Ok(()) => {
            state.borrow_mut().pending_backup = None;
            // The backup carries its own preferences document.
            refresh_appearance(ui, state);
            goto(ui, state, Screen::Vault);
            tray_lock_enabled(tray, true);
            notice(ui, "Backup imported.");
        }
        Err(VaultError::Auth) => {
            ui.set_password_value("".into());
            ui.set_error_text("That backup password is not correct.".into());
        }
        Err(err) => ui.set_error_text(err.to_string().into()),
    }
}

/// File dialog -> parse -> either restore straight away (device backup) or
/// ask for the backup's password first.
fn pick_backup(ui: &MainWindow, state: &Shared, tray: &Weak<AppTray>) {
    let screen = ui.get_screen();
    if ui.get_busy() || (screen != Screen::CreateChoose && screen != Screen::Vault) {
        return;
    }

    let Some(path) = platform::pick_backup_file(find_main_window()) else {
        return; // cancelled
    };

    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(err) => {
            ui.set_error_text(format!("Could not read that file: {err}").into());
            return;
        }
    };
    let backup = match colax_core::parse_backup(&text) {
        Ok(backup) => backup,
        Err(err) => {
            ui.set_error_text(err.to_string().into());
            return;
        }
    };
    let protection = match resolve_header(&backup.header) {
        Ok(resolved) => resolved.protection,
        Err(err) => {
            ui.set_error_text(err.to_string().into());
            return;
        }
    };

    match protection {
        VaultProtection::Device => restore_backup(ui, state, tray, backup, None),
        VaultProtection::Password => {
            state.borrow_mut().pending_backup = Some(backup);
            goto(ui, state, Screen::ImportPassword);
        }
    }
}

/// Copy an item's password. Called from the row, the Copy button, and so
/// both paths get the same message.
fn copy_item_password(ui: &MainWindow, state: &Shared, id: &str) {
    if ui.get_screen() != Screen::Vault {
        return;
    }
    let password = {
        let guard = state.borrow();
        guard
            .engine
            .items()
            .and_then(|items| items.iter().find(|item| item.id == id))
            .map(|item| item.password.clone())
    };
    let Some(password) = password else {
        ui.set_error_text("That item no longer exists.".into());
        return;
    };

    if password.is_empty() {
        notice(ui, "This login has no password.");
    } else if platform::copy_text(&password) {
        notice(ui, "Password copied.");
    } else {
        ui.set_error_text("Could not access the clipboard.".into());
    }
}

/* ==========================================================================
The item editor
========================================================================== */

/// The rotation-reminder presets, in `Segmented` order.
///
/// The table lives here rather than in the `.slint` file because the same
/// numbers are what the stale check reads: one table, one meaning. TS keeps
/// the list in `ItemEditor.tsx` and separately reads `reminderDays`, and the
/// two agree only by being written down in two places.
const REMINDER_PRESETS: [(&str, f64); 8] = [
    ("Follow global", 0.0),
    ("15 min", 15.0 / 1440.0),
    ("1 hour", 1.0 / 24.0),
    ("12 hours", 0.5),
    ("1 day", 1.0),
    ("7 days", 7.0),
    ("30 days", 30.0),
    ("90 days", 90.0),
];

/// The preset label for `days`, or "" when the stored value is not one.
///
/// Empty means "no option is lit". Claiming "Follow global" for a 45-day
/// reminder imported from the web build would be a lie the user could only
/// catch by picking something else and back.
fn reminder_label(days: f64) -> String {
    REMINDER_PRESETS
        .iter()
        .find(|(_, d)| (days - *d).abs() < 1e-6)
        .map(|(label, _)| (*label).to_string())
        .unwrap_or_default()
}

/// Pushes the strength read-out for `password` into the editor's meter.
///
/// An empty password pushes -1, which `StrengthMeter` draws as five dead
/// segments and no words at all: a field nobody has typed into is untyped,
/// not weak.
fn push_strength(ui: &MainWindow, password: &str) {
    if password.is_empty() {
        ui.set_edit_strength_score(-1);
        ui.set_edit_strength_label("".into());
        ui.set_edit_strength_bits("".into());
        ui.set_edit_strength_crack("".into());
        return;
    }
    let strength = estimate_strength(password);
    ui.set_edit_strength_score(strength.score as i32);
    ui.set_edit_strength_label(strength.label.as_str().into());
    ui.set_edit_strength_bits(strength.bits.to_string().into());
    ui.set_edit_strength_crack(strength.crack_time.as_str().into());
}

/// Re-rolls the generator from the options currently in the UI and pushes
/// the value, its mask and its strength together.
///
/// Everything the generator shows is written here, in one place, so the
/// preview can never be one password while the meter describes another.
fn regenerate(ui: &MainWindow) {
    ui.set_gen_length_label(
        format!("{} characters", ui.get_gen_length().round().max(0.0) as i64).as_str().into(),
    );
    ui.set_gen_words_label(
        format!("{} words", ui.get_gen_words().round().max(0.0) as i64).as_str().into(),
    );

    // Every character set off: TS raises "turn on at least one" and generates
    // nothing. Generating anyway would need `generate_password`'s coercion
    // (which switches lower+digits back on behind the user's back) to
    // contradict the alert sitting right below it.
    let no_sets = !ui.get_gen_lower()
        && !ui.get_gen_upper()
        && !ui.get_gen_digits()
        && !ui.get_gen_symbols();
    if ui.get_gen_mode().as_str() == "Random" && no_sets {
        ui.set_gen_value("".into());
        ui.set_gen_mask("".into());
        ui.set_gen_strength_score(-1);
        ui.set_gen_strength_label("".into());
        ui.set_gen_strength_bits("".into());
        ui.set_gen_strength_crack("".into());
        return;
    }

    let value = if ui.get_gen_mode().as_str() == "Words" {
        generate_passphrase(ui.get_gen_words().round().clamp(3.0, 10.0) as usize, "-")
    } else {
        generate_password(&GeneratorOptions {
            length: ui.get_gen_length().round().clamp(8.0, 64.0) as usize,
            lower: ui.get_gen_lower(),
            upper: ui.get_gen_upper(),
            digits: ui.get_gen_digits(),
            symbols: ui.get_gen_symbols(),
            avoid_ambiguous: ui.get_gen_avoid(),
        })
    };

    // The dots are a *fixed* count, not the password's length: a mask that
    // grows with the value advertises how long the secret is to anyone
    // looking over a shoulder.
    let mask = "\u{2022}".repeat(32);
    let strength = estimate_strength(&value);
    ui.set_gen_value(value.as_str().into());
    ui.set_gen_mask(mask.as_str().into());
    ui.set_gen_strength_score(strength.score as i32);
    ui.set_gen_strength_label(strength.label.as_str().into());
    ui.set_gen_strength_bits(strength.bits.to_string().into());
    ui.set_gen_strength_crack(strength.crack_time.as_str().into());
}

/// Fills the editor with a login, or with a blank draft for a new one.
///
/// `id` empty means "new". The generator is not rolled here: TS opens it
/// closed and generates on demand, and a fresh secret nobody asked for is a
/// secret that now has to be kept.
fn open_editor(ui: &MainWindow, state: &Shared, id: &str) {
    if ui.get_screen() != Screen::Vault && ui.get_screen() != Screen::Editor {
        return;
    }

    if id.is_empty() {
        ui.set_edit_id("".into());
        ui.set_edit_title("".into());
        ui.set_edit_url("".into());
        ui.set_edit_username("".into());
        ui.set_edit_password("".into());
        ui.set_edit_notes("".into());
        ui.set_edit_favorite(false);
        ui.set_edit_needs_attention(false);
        ui.set_edit_reminder_days(0.0);
        ui.set_edit_reminder_label(REMINDER_PRESETS[0].0.into());
        ui.set_edit_can_delete(false);
    } else {
        let found = {
            let guard = state.borrow();
            guard
                .engine
                .items()
                .and_then(|items| items.iter().find(|item| item.id == id))
                .cloned()
        };
        let Some(item) = found else {
            ui.set_error_text("That login no longer exists.".into());
            return;
        };
        ui.set_edit_id(item.id.as_str().into());
        ui.set_edit_title(item.title.as_str().into());
        ui.set_edit_url(item.url.as_str().into());
        ui.set_edit_username(item.username.as_str().into());
        ui.set_edit_password(item.password.as_str().into());
        ui.set_edit_notes(item.notes.as_str().into());
        ui.set_edit_favorite(item.favorite);
        ui.set_edit_needs_attention(item.needs_attention);
        ui.set_edit_reminder_days(item.reminder_days as f32);
        ui.set_edit_reminder_label(reminder_label(item.reminder_days).as_str().into());
        ui.set_edit_can_delete(true);
    }

    // The transient layer `changed screen` cannot reach: this runs while the
    // editor may already be open, and a stale error or a left-open delete
    // confirmation would then belong to the *previous* login.
    ui.set_editor_confirm_delete(false);
    ui.set_editor_section("identity".into());
    ui.set_gen_show(false);
    ui.set_gen_revealed(false);
    ui.set_gen_reveal_editor(false);
    ui.set_error_text("".into());
    ui.set_notice_text("".into());
    let password = ui.get_edit_password().to_string();
    push_strength(ui, &password);

    goto(ui, state, Screen::Editor);
}

/// Save. A new login goes in as a fresh record; an existing one is patched,
/// which is what lets `passwordUpdatedAt` stay put when the password itself
/// did not change.
fn editor_save(ui: &MainWindow, state: &Shared) {
    if ui.get_screen() != Screen::Editor || ui.get_busy() {
        return;
    }

    let title = ui.get_edit_title().to_string();
    let username = ui.get_edit_username().to_string();
    let password = ui.get_edit_password().to_string();
    let url = ui.get_edit_url().to_string();
    if title.trim().is_empty() && username.trim().is_empty() && password.is_empty() {
        ui.set_error_text("Give this login a name, or something to remember it by.".into());
        return;
    }

    let id = ui.get_edit_id().to_string();
    let patch = serde_json::json!({
        "title": title,
        "url": url,
        "username": username,
        "password": password,
        "notes": ui.get_edit_notes().to_string(),
        "favorite": ui.get_edit_favorite(),
        "needsAttention": ui.get_edit_needs_attention(),
        "reminderDays": f64::from(ui.get_edit_reminder_days()),
    });

    ui.set_busy(true);
    let result = {
        let mut guard = state.borrow_mut();
        if id.is_empty() {
            guard.engine.add_item(&patch).map(|_| ())
        } else {
            guard.engine.update_item(&id, &patch).map(|_| ())
        }
    };
    ui.set_busy(false);

    match result {
        Ok(()) => {
            let message = if id.is_empty() {
                "Login added."
            } else {
                "Changes saved."
            };
            goto(ui, state, Screen::Vault);
            notice(ui, message);
        }
        Err(err) => ui.set_error_text(err.to_string().as_str().into()),
    }
}

fn editor_cancel(ui: &MainWindow, state: &Shared) {
    if ui.get_screen() != Screen::Editor {
        return;
    }
    goto(ui, state, Screen::Vault);
}

fn editor_confirm_cancelled(ui: &MainWindow) {
    if ui.get_screen() != Screen::Editor {
        return;
    }
    ui.set_editor_confirm_delete(false);
}

/// Delete, first half. `confirmDeletes` decides whether this asks; either
/// way the editor ends up at `editor_delete_confirmed`, so there is exactly
/// one code path that actually removes anything.
fn editor_delete_asked(ui: &MainWindow, state: &Shared) {
    if ui.get_screen() != Screen::Editor || ui.get_busy() {
        return;
    }
    // A login that has never been saved has nothing to delete.
    if ui.get_edit_id().is_empty() {
        return;
    }
    let confirm = {
        let guard = state.borrow();
        items::prefs_from(guard.engine.preferences()).confirm_deletes
    };
    if confirm {
        ui.set_editor_confirm_delete(true);
    } else {
        editor_delete_confirmed(ui, state);
    }
}

/// Delete, second half. The row is kept so the strip at the bottom of the
/// list can put it back -- and put back the *whole* row, not a re-typed
/// approximation of it.
fn editor_delete_confirmed(ui: &MainWindow, state: &Shared) {
    if ui.get_screen() != Screen::Editor || ui.get_busy() {
        return;
    }
    let id = ui.get_edit_id().to_string();
    if id.is_empty() {
        return;
    }

    ui.set_busy(true);
    let (deleted, result) = {
        let mut guard = state.borrow_mut();
        let deleted = guard
            .engine
            .items()
            .and_then(|items| items.iter().find(|item| item.id == id))
            .cloned();
        let result = guard.engine.delete_item(&id);
        (deleted, result)
    };
    ui.set_busy(false);

    match result {
        Ok(()) => {
            let title = deleted
                .as_ref()
                .map(|item| item.title.clone())
                .unwrap_or_default();
            state.borrow_mut().last_deleted = deleted;
            goto(ui, state, Screen::Vault);
            ui.set_undo_text(format!("Deleted \u{201c}{title}\u{201d}.").as_str().into());
        }
        Err(err) => ui.set_error_text(err.to_string().as_str().into()),
    }
}

/// Puts back exactly what was deleted. `restore_item` takes the whole row,
/// id included, so a restored login lands in its old place with its dates
/// intact rather than being born a second time.
fn undo_delete(ui: &MainWindow, state: &Shared) {
    if ui.get_screen() != Screen::Vault || ui.get_busy() {
        return;
    }
    let deleted = state.borrow_mut().last_deleted.take();
    let Some(item) = deleted else {
        ui.set_undo_text("".into());
        return;
    };
    let title = item.title.clone();

    ui.set_busy(true);
    let result = {
        let mut guard = state.borrow_mut();
        guard.engine.restore_item(&item).map(|_| ())
    };
    ui.set_busy(false);
    ui.set_undo_text("".into());

    match result {
        Ok(()) => {
            refresh_items(ui, state);
            notice(ui, format!("Restored \u{201c}{title}\u{201d}.").as_str());
        }
        Err(err) => ui.set_error_text(err.to_string().as_str().into()),
    }
}

fn undo_dismiss(ui: &MainWindow, state: &Shared) {
    if ui.get_busy() {
        return;
    }
    ui.set_undo_text("".into());
    state.borrow_mut().last_deleted = None;
}

fn toggle_favorite(ui: &MainWindow, state: &Shared, id: &str) {
    if ui.get_screen() != Screen::Vault || ui.get_busy() {
        return;
    }
    // Read, then write: the engine has no "flip" (and a blind toggle would
    // race a double-click into two writes in the opposite direction).
    let next = {
        let guard = state.borrow();
        guard
            .engine
            .items()
            .and_then(|items| items.iter().find(|item| item.id == id))
            .map(|item| !item.favorite)
    };
    let Some(next) = next else { return };
    let result = {
        let mut guard = state.borrow_mut();
        guard
            .engine
            .update_item(id, &serde_json::json!({ "favorite": next }))
            .map(|_| ())
    };
    match result {
        Ok(()) => refresh_items(ui, state),
        Err(err) => ui.set_error_text(err.to_string().as_str().into()),
    }
}

fn editor_reveal(ui: &MainWindow) {
    if ui.get_screen() != Screen::Editor {
        return;
    }
    ui.set_gen_reveal_editor(!ui.get_gen_reveal_editor());
}

fn editor_section_selected(ui: &MainWindow, id: &str) {
    if ui.get_screen() != Screen::Editor {
        return;
    }
    ui.set_editor_section(id.into());
}

fn editor_password_edited(ui: &MainWindow) {
    if ui.get_screen() != Screen::Editor {
        return;
    }
    let password = ui.get_edit_password().to_string();
    push_strength(ui, &password);
}

fn editor_generator_toggled(ui: &MainWindow) {
    if ui.get_screen() != Screen::Editor {
        return;
    }
    let show = !ui.get_gen_show();
    ui.set_gen_show(show);
    if show {
        regenerate(ui);
    }
}

fn editor_gen_mode_picked(ui: &MainWindow, index: i32) {
    if ui.get_screen() != Screen::Editor {
        return;
    }
    ui.set_gen_mode(if index == 1 { "Words" } else { "Random" }.into());
    regenerate(ui);
}

fn editor_reminder_picked(ui: &MainWindow, index: i32) {
    if ui.get_screen() != Screen::Editor {
        return;
    }
    if let Some((label, days)) = REMINDER_PRESETS.get(index.max(0) as usize) {
        ui.set_edit_reminder_days(*days as f32);
        ui.set_edit_reminder_label((*label).into());
    }
}

fn editor_use_generated(ui: &MainWindow) {
    if ui.get_screen() != Screen::Editor {
        return;
    }
    let value = ui.get_gen_value().to_string();
    if value.is_empty() {
        return;
    }
    ui.set_edit_password(value.as_str().into());
    push_strength(ui, &value);
}

fn editor_copy_generated(ui: &MainWindow) {
    if ui.get_screen() != Screen::Editor {
        return;
    }
    let value = ui.get_gen_value().to_string();
    if value.is_empty() {
        return;
    }
    if platform::copy_text(&value) {
        notice(ui, "Password copied.");
    } else {
        ui.set_error_text("Could not access the clipboard.".into());
    }
}

/// Lock: drop the key handle in the engine, then present the right unlock
/// screen. Only meaningful from the vault screen, which is the only screen
/// that exists while unlocked.
fn lock_vault(ui: &MainWindow, state: &Shared) {
    if ui.get_screen() != Screen::Vault {
        return;
    }
    let screen = {
        let mut guard = state.borrow_mut();
        guard.engine.lock();
        // An undo offering to restore a row cannot outlive the lock: the
        // offer would still be on screen while the vault is sealed.
        guard.last_deleted = None;
        lock_screen_for(&guard.engine)
    };
    ui.set_undo_text("".into());
    goto(ui, state, screen);
}

/// `on_create_import` and `on_import_from_vault` are the same handler from
/// two screens; this builds one of each without repeating the body.
fn import_handler(ui: Weak<MainWindow>, state: Shared, tray: Weak<AppTray>) -> impl Fn() {
    move || {
        if let Some(ui) = ui.upgrade() {
            pick_backup(&ui, &state, &tray);
        }
    }
}

/* ==========================================================================
Entry point
========================================================================== */

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut state_file = read_state();

    // Only ever re-affirmed at boot, never withdrawn: if no shell.json exists
    // yet but a Run entry does (set by an earlier build), starting this app
    // must not silently un-set it. Deletion happens on the user's switch.
    if state_file.launch_at_login {
        apply_autostart(true);
    }

    let ui = MainWindow::new()?;

    let tray = AppTray::new()?;

    // ---- Open the vault ---------------------------------------------------
    let mut startup_error: Option<String> = None;
    let app_state: Option<Shared> = match VaultEngine::open(VaultStorage::new(vault_path())) {
        Ok(engine) => {
            let state = Rc::new(RefCell::new(AppState {
                engine,
                pending_password: String::new(),
                pending_backup: None,
                last_deleted: None,
            }));
            // Debug scratch profiles open straight into the vault with demo
            // content; everything else starts on the real startup screen.
            #[cfg(debug_assertions)]
            let seeded = {
                let tray_weak = tray.as_weak();
                dev_seed(&ui, &state, &tray_weak)
            };
            #[cfg(not(debug_assertions))]
            let seeded = false;

            let (screen, exists) = {
                let guard = state.borrow();
                (if seeded { Ok(Screen::Vault) } else { startup_screen(&guard.engine) }, guard.engine.exists())
            };
            tray.set_lock_enabled(exists);
            match screen {
                Ok(screen) => ui.set_screen(screen),
                Err(err) => {
                    ui.set_screen(Screen::Error);
                    startup_error = Some(err.to_string());
                }
            }
            // After the real startup screen, not before: this opens its own
            // screen and would otherwise be overwritten by the one above.
            #[cfg(debug_assertions)]
            if seeded {
                dev_screen(&ui, &state);
            }
            Some(state)
        }
        Err(err) => {
            ui.set_screen(Screen::Error);
            startup_error = Some(format!(
                "The vault on this device could not be opened.\n\n{err}"
            ));
            None
        }
    };

    // ---- Appearance ------------------------------------------------------
    // Preferences ride in the vault document, so they are known the moment it
    // is open â€” including before the first unlock, which is why this runs
    // here and not after a screen change.
    if let Some(state) = &app_state {
        // shell.json is where the Tauri/Electron builds kept these four
        // switches. Adopt them into the vault preferences only when the
        // preferences document has never recorded them â€” once it has, the
        // preferences are the newer copy (a restore can bring them from
        // another machine) and shell.json follows them instead.
        let mut shell = state_file;
        let (mut prefs, unmirrored) = {
            let guard = state.borrow();
            let raw = guard.engine.preferences();
            let missing = raw.get("trayEnabled").is_none()
                && raw.get("closeToTray").is_none()
                && raw.get("launchAtLogin").is_none()
                && raw.get("soundsMuted").is_none();
            (colax_core::normalise_preferences(raw), missing)
        };
        if unmirrored {
            prefs.tray_enabled = shell.tray_enabled;
            prefs.close_to_tray = shell.close_to_tray;
            prefs.launch_at_login = shell.launch_at_login;
            prefs.sounds_muted = shell.sounds_muted;
            mirror_shell_flags(&ui, state, &mut shell, &prefs);
            state_file = shell;
        }
        refresh_appearance(&ui, state);
    }

    // ---- Tray callbacks ---------------------------------------------------
    let weak = ui.as_weak();
    tray.on_show_requested(move || {
        if let Some(ui) = weak.upgrade() {
            show_window(&ui);
        }
    });

    // A left-click on the icon itself must bring the window back too --
    // hiding to the tray and then needing a right-click to return is a trap.
    let weak = ui.as_weak();
    tray.on_icon_clicked(move || {
        if let Some(ui) = weak.upgrade() {
            show_window(&ui);
        }
    });

    let weak = ui.as_weak();
    let tray_state = app_state.clone();
    tray.on_lock_requested(move || {
        if let Some(ui) = weak.upgrade() {
            if let Some(state) = &tray_state {
                lock_vault(&ui, state);
            }
            show_window(&ui);
        }
    });

    tray.on_mute_requested(|| {
        // The Tauri shell only forwarded the toggle to the renderer, which
        // owned the sounds. Sounds arrive in a later phase.
        eprintln!("mute -> no-op until sounds land");
    });

    tray.on_quit_requested(|| {
        // No unsaved state to flush: shell state was written when it last
        // changed, and the vault writes atomically.
        let _ = slint::quit_event_loop();
    });

    // ---- Vault screen callbacks ------------------------------------------
    if let Some(state) = app_state.clone() {
        {
            // First run: either straight to a device vault or into the
            // password stages.
            let weak = ui.as_weak();
            let st = state.clone();
            let tw = tray.as_weak();
            ui.on_create_no_password(move || {
                let Some(ui) = weak.upgrade() else { return };
                if ui.get_busy() || ui.get_screen() != Screen::CreateChoose {
                    return;
                }
                create_vault(&ui, &st, &tw, None);
            });

            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_create_with_password(move || {
                let Some(ui) = weak.upgrade() else { return };
                if ui.get_busy() || ui.get_screen() != Screen::CreateChoose {
                    return;
                }
                goto(&ui, &st, Screen::CreatePassword);
            });

            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_create_back(move || {
                let Some(ui) = weak.upgrade() else { return };
                if ui.get_busy() {
                    return;
                }
                st.borrow_mut().pending_password.clear();
                goto(&ui, &st, Screen::CreateChoose);
            });
        }

        {
            // Create: password -> confirm -> create. The length floor here
            // stands in for the lite app's strength meter; the meter and the
            // suggestion button come with the passwords module.
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_password_next(move || {
                let Some(ui) = weak.upgrade() else { return };
                if ui.get_busy() || ui.get_screen() != Screen::CreatePassword {
                    return;
                }
                let password = ui.get_password_value();
                if password.chars().count() < 8 {
                    ui.set_error_text(
                        "Choose a longer vault password (at least 8 characters).".into(),
                    );
                    return;
                }
                st.borrow_mut().pending_password = password.into();
                goto(&ui, &st, Screen::CreateConfirm);
            });

            let weak = ui.as_weak();
            let st = state.clone();
            let tw = tray.as_weak();
            ui.on_create_submit(move || {
                let Some(ui) = weak.upgrade() else { return };
                if ui.get_busy() || ui.get_screen() != Screen::CreateConfirm {
                    return;
                }
                let confirm = ui.get_confirm_value().to_string();
                let pending = st.borrow().pending_password.clone();
                if confirm != pending {
                    ui.set_error_text("The two passwords do not match.".into());
                    return;
                }
                create_vault(&ui, &st, &tw, Some(&pending));
            });
        }

        {
            // Unlock: password and device vaults.
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_unlock_submit(move || {
                let Some(ui) = weak.upgrade() else { return };
                if ui.get_busy() || ui.get_screen() != Screen::UnlockPassword {
                    return;
                }
                let password = ui.get_password_value();
                unlock_with(&ui, &st, &password);
            });

            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_open_device(move || {
                let Some(ui) = weak.upgrade() else { return };
                if ui.get_busy() || ui.get_screen() != Screen::UnlockDevice {
                    return;
                }
                unlock_with(&ui, &st, "");
            });
        }

        {
            // Import: pick from either screen, enter the backup's password,
            // back out to wherever the flow started.
            ui.on_create_import(import_handler(ui.as_weak(), state.clone(), tray.as_weak()));
            ui.on_import_from_vault(import_handler(ui.as_weak(), state.clone(), tray.as_weak()));

            let weak = ui.as_weak();
            let st = state.clone();
            let tw = tray.as_weak();
            ui.on_import_submit(move || {
                let Some(ui) = weak.upgrade() else { return };
                if ui.get_busy() || ui.get_screen() != Screen::ImportPassword {
                    return;
                }
                let backup = st.borrow_mut().pending_backup.take();
                let Some(backup) = backup else { return };
                let password = ui.get_password_value();
                restore_backup(&ui, &st, &tw, backup, Some(&password));
            });

            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_import_back(move || {
                let Some(ui) = weak.upgrade() else { return };
                if ui.get_busy() {
                    return;
                }
                st.borrow_mut().pending_backup = None;
                let screen = {
                    let guard = st.borrow();
                    if guard.engine.exists() {
                        Screen::Vault
                    } else {
                        Screen::CreateChoose
                    }
                };
                goto(&ui, &st, screen);
            });
        }

        {
            // The list itself.
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_lock_vault(move || {
                if let Some(ui) = weak.upgrade() {
                    lock_vault(&ui, &st);
                }
            });

            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_copy_password(move |id| {
                if let Some(ui) = weak.upgrade() {
                    copy_item_password(&ui, &st, &id);
                }
            });

            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_search_changed(move |_query| {
                if let Some(ui) = weak.upgrade() {
                    refresh_items(&ui, &st);
                }
            });

            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_channel_selected(move |_id| {
                if let Some(ui) = weak.upgrade() {
                    // A new channel is a new scope: a query that meant
                    // something in the old one would silently filter the new
                    // one, so the box empties with the switch (App.tsx L167).
                    ui.set_search_text("".into());
                    refresh_items(&ui, &st);
                }
            });

            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_toggle_favorite(move |id| {
                if let Some(ui) = weak.upgrade() {
                    toggle_favorite(&ui, &st, &id);
                }
            });

            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_undo_clicked(move || {
                if let Some(ui) = weak.upgrade() {
                    undo_delete(&ui, &st);
                }
            });

            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_undo_dismissed(move || {
                if let Some(ui) = weak.upgrade() {
                    undo_dismiss(&ui, &st);
                }
            });
        }

        // ---- The item editor -----------------------------------------------
        {
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_open_editor(move |id| {
                if let Some(ui) = weak.upgrade() {
                    open_editor(&ui, &st, &id);
                }
            });

            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_editor_save(move || {
                if let Some(ui) = weak.upgrade() {
                    editor_save(&ui, &st);
                }
            });

            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_editor_cancel(move || {
                if let Some(ui) = weak.upgrade() {
                    editor_cancel(&ui, &st);
                }
            });

            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_editor_delete_asked(move || {
                if let Some(ui) = weak.upgrade() {
                    editor_delete_asked(&ui, &st);
                }
            });

            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_editor_delete_confirmed(move || {
                if let Some(ui) = weak.upgrade() {
                    editor_delete_confirmed(&ui, &st);
                }
            });

            let weak = ui.as_weak();
            ui.on_editor_confirm_cancelled(move || {
                if let Some(ui) = weak.upgrade() {
                    editor_confirm_cancelled(&ui);
                }
            });

            let weak = ui.as_weak();
            ui.on_editor_reveal(move || {
                if let Some(ui) = weak.upgrade() {
                    editor_reveal(&ui);
                }
            });

            let weak = ui.as_weak();
            ui.on_editor_password_edited(move || {
                if let Some(ui) = weak.upgrade() {
                    editor_password_edited(&ui);
                }
            });

            let weak = ui.as_weak();
            ui.on_editor_section_selected(move |id| {
                if let Some(ui) = weak.upgrade() {
                    editor_section_selected(&ui, &id);
                }
            });

            let weak = ui.as_weak();
            ui.on_editor_generator_toggled(move || {
                if let Some(ui) = weak.upgrade() {
                    editor_generator_toggled(&ui);
                }
            });

            let weak = ui.as_weak();
            ui.on_editor_regenerate(move || {
                if let Some(ui) = weak.upgrade() {
                    if ui.get_screen() == Screen::Editor {
                        regenerate(&ui);
                    }
                }
            });

            let weak = ui.as_weak();
            ui.on_editor_gen_mode_picked(move |index| {
                if let Some(ui) = weak.upgrade() {
                    editor_gen_mode_picked(&ui, index);
                }
            });

            let weak = ui.as_weak();
            ui.on_editor_reminder_picked(move |index| {
                if let Some(ui) = weak.upgrade() {
                    editor_reminder_picked(&ui, index);
                }
            });

            let weak = ui.as_weak();
            ui.on_editor_use_generated(move || {
                if let Some(ui) = weak.upgrade() {
                    editor_use_generated(&ui);
                }
            });

            let weak = ui.as_weak();
            ui.on_editor_copy_generated(move || {
                if let Some(ui) = weak.upgrade() {
                    editor_copy_generated(&ui);
                }
            });
        }
    }

    ui.on_quit_app(|| {
        let _ = slint::quit_event_loop();
    });

    // Hide, not destroy: the window has to still exist for Show to bring it
    // back, and the visible tray icon holds the event loop open meanwhile.
    // (Returning the default would hide it anyway -- but the quit branch must
    // actually quit, because a hidden window alone releases the keepalive.)
    // A vault that failed to open is the exception: there is no shell to
    // hide behind, so closing it quits.
    let close_state = state_file;
    let weak = ui.as_weak();
    ui.window().on_close_requested(move || {
        let on_error = weak
            .upgrade()
            .is_some_and(|ui| ui.get_screen() == Screen::Error);
        if !on_error && close_state.close_to_tray && close_state.tray_enabled {
            eprintln!("close -> hide to tray");
        } else {
            eprintln!("close -> quit");
            let _ = slint::quit_event_loop();
        }
        slint::CloseRequestResponse::HideWindow
    });

    ui.show()?;

    // Focus the first input of the opening screen. The field's `init` ran
    // while the window was still invisible, so re-enter the screen now that
    // it can take focus. (The error screen has no field -- and its message
    // must survive, so it is set after this.)
    let opening = ui.get_screen();
    if opening != Screen::Error {
        ui.set_screen(Screen::Error);
        ui.set_screen(opening);
    }
    if let Some(message) = startup_error {
        ui.set_error_text(message.into());
    }

    if state_file.tray_enabled {
        tray.show()?;
    } else {
        tray.hide()?;
    }
    eprintln!("shell up: window and tray shown");

    ui.run()?;
    Ok(())
}
