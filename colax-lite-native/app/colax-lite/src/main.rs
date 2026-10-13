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
mod platform;

use std::cell::RefCell;
use std::fs;
use std::path::PathBuf;
use std::rc::Rc;

use colax_core::model::accent_of;
use colax_core::{
    resolve_header, BackupFile, VaultEngine, VaultError, VaultProtection, VaultStorage,
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

fn state_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(APP_DIR)
        .join(STATE_FILE)
}

fn read_state() -> ShellState {
    fs::read_to_string(state_path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Best-effort write: a read-only config directory must not stop the app.
///
/// No switch exists yet that changes the state -- the Settings surface
/// arrives in a later phase -- so this is written for that path and dead
/// until then.
#[allow(dead_code)]
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
}

type Shared = Rc<RefCell<AppState>>;

fn vault_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(APP_DIR)
        .join("vault.json")
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

/// The row icon's fill: the item's own accent hue, or the title's, turned
/// into a solid colour at the lite app's card saturation and lightness.
fn tile_color(hue: i32) -> slint::Color {
    let h = hue.rem_euclid(360) as f64 / 60.0;
    let (s, l): (f64, f64) = (0.48, 0.46);
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let x = c * (1.0 - (h.rem_euclid(2.0) - 1.0).abs());
    let m = l - c / 2.0;
    let (r, g, b) = match h.floor() as i32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let channel = |v: f64| ((v + m) * 255.0).round().clamp(0.0, 255.0) as u8;
    slint::Color::from_rgb_u8(channel(r), channel(g), channel(b))
}

/// One list row. The initial is the first character of the first non-empty
/// label, uppercased; the hue is the item's own accent or the title's, the
/// same derivation the lite cards use.
fn row_for(item: &colax_core::VaultItem) -> ItemRow {
    let source = if !item.title.is_empty() {
        item.title.as_str()
    } else if !item.username.is_empty() {
        item.username.as_str()
    } else if !item.url.is_empty() {
        item.url.as_str()
    } else {
        "?"
    };
    let initial = source
        .trim()
        .chars()
        .next()
        .map(|c| c.to_uppercase().collect::<String>())
        .unwrap_or_else(|| "?".to_string());

    ItemRow {
        id: item.id.clone().into(),
        title: item.title.clone().into(),
        username: item.username.clone().into(),
        subtitle: item.url.clone().into(),
        initial: initial.into(),
        tile: tile_color(accent_of(item)),
    }
}

/// Rebuilds the visible rows from the engine and the current query.
///
/// Called after every screen change (the query box resets with it) and on
/// each keystroke. Reads the query from the UI rather than from a handler
/// argument so both paths stay identical.
fn refresh_items(ui: &MainWindow, state: &Shared) {
    let query = ui.get_search_text().to_lowercase();
    let guard = state.borrow();
    let (rows, total) = match guard.engine.items() {
        Some(items) => (
            items
                .iter()
                .filter(|item| {
                    query.is_empty()
                        || item.title.to_lowercase().contains(&query)
                        || item.username.to_lowercase().contains(&query)
                        || item.url.to_lowercase().contains(&query)
                })
                .map(row_for)
                .collect::<Vec<_>>(),
            items.len(),
        ),
        None => (Vec::new(), 0),
    };
    drop(guard);

    let label = format!("{total} {}", if total == 1 { "login" } else { "logins" });
    ui.set_items(ModelRc::new(VecModel::from(rows)));
    ui.set_count_label(label.into());
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
        lock_screen_for(&guard.engine)
    };
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
    let state_file = read_state();

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
            }));
            let (screen, exists) = {
                let guard = state.borrow();
                (startup_screen(&guard.engine), guard.engine.exists())
            };
            tray.set_lock_enabled(exists);
            match screen {
                Ok(screen) => ui.set_screen(screen),
                Err(err) => {
                    ui.set_screen(Screen::Error);
                    startup_error = Some(err.to_string());
                }
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
    // is open — including before the first unlock, which is why this runs
    // here and not after a screen change.
    if let Some(state) = &app_state {
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
