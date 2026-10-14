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
use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::rc::Rc;

use colax_core::model::{SecurityPasscode, SecurityQuestion, TotpSecret};
use colax_core::totp::{
    extract_totp_secret, generate_totp_seed, otpauth_url, qr_matrix, verify_totp,
};
use colax_core::{
    answer_too_weak, create_tag, estimate_strength, from_date_input, generate_passphrase,
    generate_password, hash_answer, hash_passcode, passcode_too_weak, relative_time, resolve_header,
    security_level, to_date_input, verify_answer, verify_passcode, BackupFile, GeneratorOptions,
    LoginSecurity, VaultEngine, VaultError, VaultItem, VaultProtection, VaultStorage,
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
/// What an open SecurityGate is holding up, and the factor it checks
/// against. The panel is thrown away when it closes; *this* is not, because
/// it is what a passed check resumes.
#[derive(Clone)]
struct PendingGate {
    intent: GateIntent,
    security: LoginSecurity,
}

/// The flows SecurityGate.tsx is invoked from that this build has screens
/// for. Folder locks and pending items arrive with their own screens, and
/// the per-view reveal collapses into the editor's: the views copy, and
/// opening a secured login is already gated once.
#[derive(Clone)]
enum GateIntent {
    /// `prefs.vaultSecurity`, checked on every landing on the shell.
    Vault,
    /// A secured login's editor does not open without this -- the TS
    /// `pendingItem` flow with intent `edit`.
    Edit(String),
    /// The password inside the editor stays hidden without it (`reveal`).
    Reveal(String),
}

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
    /// The Security half of the editor's draft. It lives here rather than in
    /// Slint for the same reason passwords stay in the engine: a PBKDF2 hash
    /// and its salt are not something a screen should hold. The panel is sent
    /// only what it can read (the level, the two flags, the prompts) and every
    /// action it reports comes back here to be hashed once, in one place.
    editor_security: LoginSecurity,
    /// A TOTP key that was generated or pasted but *not* yet confirmed by a
    /// code. Staged exactly as `stagedSeed` is in `SecurityForm.tsx` L47:
    /// nothing about the record changes until a code proves a phone holds the
    /// key, and leaving the editor drops it.
    editor_staged_seed: Option<String>,
    /// Which of `QUESTION_PROMPTS` the add-question row is showing.
    editor_prompt_index: usize,
    /// The Organise half of the draft: which of the catalogue's tags this
    /// login carries. Kept here rather than in Slint because the catalogue it
    /// is chosen from lives in preferences and only Rust sees both — and
    /// because Save must hand back exactly the ids, not a drawing of them.
    editor_tags: Vec<String>,
    /// The two stamps of the "Last changed" grid, in milliseconds. Exact i64s
    /// rather than the Slint floats a timestamp would be rounded through: a
    /// date the user typed has to be written back unchanged.
    editor_password_updated_at: i64,
    editor_username_updated_at: i64,
    /// The width the tag cloud last reported, so rows can be packed for it on
    /// every push instead of only while the cloud happens to be on screen.
    editor_panel_width: f64,
    /// The width the vault's grid last reported. Same arrangement as the
    /// cloud's: Slint reports the geometry, Rust answers with the count of
    /// things that fit in it.
    vault_width: f64,
    /// The open SecurityGate, if any: the flow it interrupted and the factor
    /// it verifies against. The gate is modal, so a resumed action simply
    /// re-enters its own handler -- there is no callback to remember.
    gate: Option<PendingGate>,
    /// Logins whose second factor was cleared this session (TS's
    /// `verifiedItems`): the gate asks once per login, not once per click.
    verified: HashSet<String>,
    /// The vault's own factor, cleared for the session (TS's
    /// `vaultVerified`), and spent again on lock: the vault was sealed, so
    /// the proof went with it.
    vault_verified: bool,
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
    // Which of the four presentations is showing, in what order, and how the
    // switcher labels itself -- all prefs, all pushed with the cards they
    // describe so the two cannot disagree mid-switch.
    ui.set_vault_view(prefs.view.as_str().into());
    ui.set_vault_sort(prefs.sort.as_str().into());
    ui.set_vault_sort_label(items::sort_label(&prefs.sort).into());
    ui.set_labels_mode(prefs.sidebar_labels.as_str().into());
    // Where the rail docks and how it reads: three dials straight from the
    // prefs, plus the two the shell derives its chrome from. The compact
    // flag is TS's own expression -- `compactSidebar || labels === 'icon'`
    // (App.tsx L2897) -- because an icon-only rail is a dot column either
    // way Settings looks at it.
    ui.set_rail_position(prefs.sidebar_position.as_str().into());
    ui.set_rail_hidden(!prefs.show_sidebar);
    ui.set_rail_compact(prefs.compact_sidebar || prefs.sidebar_labels == "icon");
    ui.set_motion(prefs.motion as f32);
    let vault_width = state.borrow().vault_width;
    ui.set_grid_cols(grid_cols_for(vault_width));
    ui.set_sort_options(ModelRc::new(VecModel::from(items::sort_options())));
}

/// How many grid cells fit across a given content width. Below ~220px a cell
/// stops reading as a card, which is the floor the tag cloud packs its pills
/// against too -- one number for "smaller than this is not a thing any more".
fn grid_cols_for(width: f64) -> i32 {
    ((width / 230.0) as i32).clamp(2, 8)
}

/// The view switcher. `view` is a preference like any other, so it leaves
/// through the same path -- and the refresh that follows is what applies the
/// List view's letter grouping, which depends on the view.
fn view_picked(ui: &MainWindow, state: &Shared, view: &str) {
    // The screen can only offer the four ids, but a callback is an
    // interface: anything else is refused the way the normaliser would.
    if !matches!(view, "animated" | "carousel" | "basic" | "grid") {
        return;
    }
    let mut prefs = items::prefs_from(state.borrow().engine.preferences());
    if prefs.view == view {
        return;
    }
    prefs.view = view.to_string();
    if !save_prefs(ui, state, &prefs) {
        ui.set_error_text("That view could not be saved.".into());
        return;
    }
    ui.set_vault_view(view.into());
    refresh_items(ui, state);
}

/// The sort menu. Same deal: the id is validated against the pref's own
/// whitelist, the label comes from the shared table, the refresh re-sorts.
fn sort_picked(ui: &MainWindow, state: &Shared, sort: &str) {
    if !matches!(sort, "title" | "recent" | "oldest" | "strength" | "username" | "manual") {
        return;
    }
    let mut prefs = items::prefs_from(state.borrow().engine.preferences());
    if prefs.sort == sort {
        return;
    }
    prefs.sort = sort.to_string();
    if !save_prefs(ui, state, &prefs) {
        ui.set_error_text("That sort order could not be saved.".into());
        return;
    }
    ui.set_vault_sort(sort.into());
    ui.set_vault_sort_label(items::sort_label(sort).into());
    refresh_items(ui, state);
}

/// The grid reports its width and the column count is the answer. A width
/// outside anything a window can hold is a stale value from an earlier
/// layout pass, not a choice, and is ignored.
fn vault_relayout(ui: &MainWindow, state: &Shared, width: f32) {
    if !(240.0..=20000.0).contains(&width) {
        return;
    }
    state.borrow_mut().vault_width = width as f64;
    ui.set_grid_cols(grid_cols_for(width as f64));
}

/// Where the rail docks. Same contract as the other dials: the id is checked
/// against the pref's whitelist, the write goes through `save_prefs`, and the
/// refresh carries it to the shell -- the geometry lives in Slint and reads
/// the pref through this push and nothing else.
fn rail_picked(ui: &MainWindow, state: &Shared, position: &str) {
    if !matches!(position, "left" | "right" | "top" | "bottom") {
        return;
    }
    let mut prefs = items::prefs_from(state.borrow().engine.preferences());
    if prefs.sidebar_position == position {
        return;
    }
    prefs.sidebar_position = position.to_string();
    if !save_prefs(ui, state, &prefs) {
        ui.set_error_text("That rail position could not be saved.".into());
        return;
    }
    refresh_items(ui, state);
}

/// What the rail's rows spell out (`sidebarLabels`). The same contract, and
/// the compact flag follows it out again: icon labels are the other half of
/// `compactSidebar || labels === 'icon'`, and a rail that just changed to
/// icons is a dot column.
fn labels_picked(ui: &MainWindow, state: &Shared, labels: &str) {
    if !matches!(labels, "icon" | "name" | "both") {
        return;
    }
    let mut prefs = items::prefs_from(state.borrow().engine.preferences());
    if prefs.sidebar_labels == labels {
        return;
    }
    prefs.sidebar_labels = labels.to_string();
    if !save_prefs(ui, state, &prefs) {
        ui.set_error_text("Those labels could not be saved.".into());
        return;
    }
    refresh_items(ui, state);
}

/// Switches screens. Setting `screen` runs `changed screen` in the Slint
/// file, which clears the messages and the typed-in text; the refresh
/// afterwards re-reads the now-empty query.
///
/// Must be called with no borrow of `AppState` held -- it takes its own.
fn goto(ui: &MainWindow, state: &Shared, screen: Screen) {
    ui.set_screen(screen);
    refresh_items(ui, state);
    // A second factor on the vault gates the *shell*, so every landing on it
    // passes this check -- the render-time condition TS keeps at App.tsx
    // L2830 becomes an entry-time one here, with `vault_verified` standing in
    // for the session's "already proved it".
    if screen == Screen::Vault {
        maybe_gate_vault(ui, state);
    }
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
    // `COLAX_DEV_VIEW` takes its own branch before the screen picker below:
    // the four presentations live on the vault screen itself, so the run
    // stays exactly where the app opened it and drives the switcher from
    // there. `COLAX_DEV_RAIL` is the same deal for the rail's dials, and
    // `COLAX_DEV_GATE` walks the SecurityGate across every factor it knows.
    if std::env::var_os("COLAX_DEV_VIEW").is_some() {
        let weak = ui.as_weak();
        let timer = slint::Timer::default();
        timer.start(
            slint::TimerMode::SingleShot,
            std::time::Duration::from_millis(400),
            move || {
                if let Some(ui) = weak.upgrade() {
                    dev_view(&ui);
                }
            },
        );
        // Dropping the handle would cancel it before it fires.
        std::mem::forget(timer);
        return;
    }

    if std::env::var_os("COLAX_DEV_RAIL").is_some() {
        let weak = ui.as_weak();
        let st = state.clone();
        let timer = slint::Timer::default();
        timer.start(
            slint::TimerMode::SingleShot,
            std::time::Duration::from_millis(400),
            move || {
                if let Some(ui) = weak.upgrade() {
                    dev_rail(&ui, &st);
                }
            },
        );
        std::mem::forget(timer);
        return;
    }

    if std::env::var_os("COLAX_DEV_GATE").is_some() {
        let weak = ui.as_weak();
        let st = state.clone();
        let timer = slint::Timer::default();
        timer.start(
            slint::TimerMode::SingleShot,
            std::time::Duration::from_millis(400),
            move || {
                if let Some(ui) = weak.upgrade() {
                    dev_gate(&ui, &st);
                }
            },
        );
        std::mem::forget(timer);
        return;
    }

    // `COLAX_DEV_SEC` implies the Security section and `COLAX_DEV_ORG` the
    // Organise one: each exists so its panel can be verified without *looking*
    // at it -- the desktop may be locked, when a screenshot comes back white
    // -- and then one variable is enough.
    let want = match std::env::var_os("COLAX_DEV_SEC") {
        Some(_) => "editor-security".to_string(),
        None => match std::env::var_os("COLAX_DEV_ORG") {
            Some(_) => "editor-organise".to_string(),
            None => {
                let Ok(want) = std::env::var("COLAX_DEV_SCREEN") else {
                    return;
                };
                want.to_lowercase()
            }
        },
    };
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

    // The Security panel's own run: drive every callback it has and dump what
    // came back, then stop -- the generic timeline below would only append
    // noise to a file whose whole point is one line per step.
    //
    // One tick late, because `dev_screen` runs before `main` has wired any
    // callbacks and this sequence *invokes* them; calling it inline would
    // quietly do nothing at all.
    if std::env::var_os("COLAX_DEV_SEC").is_some() {
        let weak = ui.as_weak();
        let st = state.clone();
        let timer = slint::Timer::default();
        timer.start(
            slint::TimerMode::SingleShot,
            std::time::Duration::from_millis(400),
            move || {
                if let Some(ui) = weak.upgrade() {
                    dev_sec(&ui, &st);
                }
            },
        );
        // Dropping the handle would cancel it before it fires.
        std::mem::forget(timer);
        return;
    }

    // The Organise run, for the same one-tick-late reason as Security's.
    if std::env::var_os("COLAX_DEV_ORG").is_some() {
        let weak = ui.as_weak();
        let st = state.clone();
        let timer = slint::Timer::default();
        timer.start(
            slint::TimerMode::SingleShot,
            std::time::Duration::from_millis(400),
            move || {
                if let Some(ui) = weak.upgrade() {
                    dev_org(&ui, &st);
                }
            },
        );
        std::mem::forget(timer);
        return;
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
        "{tag}: editor={} vault={} section=[{}] id=[{}] title=[{}] url=[{}] username=[{}] password=[{}] notes=[{}] fav={} attn={} days={} label=[{}] sec=[{}] totp={} staged={} passcode={} qr={} questions=[{}] prompt=[{}] errs=[{}/{}/{}] notice=[{}] org=[{}] pw=[{}] pwHint=[{}] email=[{}] emailHint=[{}] canadd={} vs=[{}/{}] cols={} rail=[{}/{}] compact={} hidden={} gate={} gf=[{}/{}/{}] gerr=[{}] {}\n",
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
        // The Security half: the level and the flags Rust computed, the QR
        // side, and whatever each tab would be showing as an inline error --
        // enough to tell a factor that was never set from one whose panel
        // simply is not on screen, without a picture to look at.
        ui.get_edit_sec_level(),
        ui.get_edit_sec_totp(),
        ui.get_edit_sec_totp_staged(),
        ui.get_edit_sec_passcode(),
        ui.get_edit_qr_size(),
        ui.get_edit_sec_questions_note(),
        ui.get_edit_sec_new_prompt(),
        ui.get_edit_sec_totp_note(),
        ui.get_edit_sec_passcode_error(),
        ui.get_edit_sec_answer_error(),
        ui.get_notice_text(),
        // The Organise half: the cloud exactly as it will draw (a `*` on each
        // pill this login carries, `|` between lines), both dates with the age
        // under them, and the add box's verdict. Pills with no `*`, a date that
        // did not move, or a blank hint are each a push that never landed --
        // and none of them would show in a screenshot while the desktop is
        // locked, which is the whole reason this line exists.
        describe_tag_cloud(ui),
        ui.get_edit_pw_date(),
        ui.get_edit_pw_date_hint(),
        ui.get_edit_email_date(),
        ui.get_edit_email_date_hint(),
        ui.get_edit_tag_can_add(),
        // The vault half: which presentation is up, what the sort button
        // says, how many columns the grid settled on, and the first two
        // cards with the letter headers they start. A switch that did not
        // land moves none of these -- and none of them would show in a
        // screenshot while the desktop is locked.
        ui.get_vault_view(),
        ui.get_vault_sort_label(),
        ui.get_grid_cols(),
        // ...and the rail's three dials as the window holds them: docked
        // where, spelled how, narrowed or gone at all.
        ui.get_rail_position(),
        ui.get_labels_mode(),
        ui.get_rail_compact(),
        ui.get_rail_hidden(),
        // ...and the gate's: up or down, which factors it was handed, and
        // the error a failed attempt left behind.
        ui.get_gate_open(),
        ui.get_gate_has_passcode(),
        ui.get_gate_has_totp(),
        ui.get_gate_has_questions(),
        ui.get_gate_error(),
        describe_cards(ui),
    );
    let path = app_dir().join("dev-dump.txt");
    let mut existing = std::fs::read_to_string(&path).unwrap_or_default();
    existing.push_str(&dump);
    let _ = std::fs::write(path, existing);
}

/// The vault half of a dump: how many cards, and the first two of them --
/// each with the letter header it starts (`group`), which is the only thing
/// the List view adds over the model Rust already knows about.
#[cfg(debug_assertions)]
fn describe_cards(ui: &MainWindow) -> String {
    use slint::Model;
    let cards = ui.get_cards();
    let mut out = format!("n={}", cards.row_count());
    for index in 0..2 {
        match cards.row_data(index) {
            Some(card) => out.push_str(&format!(" [{}/{}]", card.group, card.label)),
            None => out.push_str(" [-]"),
        }
    }
    out
}

/// Debug-only: drive the Security panel end to end, dumping one line after
/// each step.
///
/// The panel's job is to change state *in Rust* and show what came back -- a
/// staged key becoming a saved one, a hash the screen never gets to hold --
/// and none of that can be confirmed from a screenshot even when one can be
/// taken. Each tag says what the following line must say; anything else is a
/// broken wire. Run with `COLAX_DEV_SEC=1` (plus `COLAX_DEV_DIR`/`_SEED`),
/// which implies `COLAX_DEV_SCREEN=editor-security`.
#[cfg(debug_assertions)]
fn dev_sec(ui: &MainWindow, state: &Shared) {
    dev_dump(ui, "sec1.open");

    // Stage a key. Nothing is saved by this: the line must show `staged=true`
    // with `totp=false`, and a QR symbol for the phone to scan.
    ui.invoke_editor_sec_totp_generate();
    dev_dump(ui, "sec2.generated");

    // A code this clock disagrees with must refuse -- and must not save.
    ui.set_edit_sec_totp_code("000000".into());
    ui.invoke_editor_sec_totp_check();
    dev_dump(ui, "sec3.wrong-code");

    // The real one is the single line that writes the factor.
    let seed = state.borrow().editor_staged_seed.clone();
    let Some(seed) = seed else {
        dev_dump(ui, "sec4.no-seed");
        return;
    };
    let code = colax_core::totp::current_totp_code(&seed).unwrap_or_default();
    ui.set_edit_sec_totp_code(code.as_str().into());
    ui.invoke_editor_sec_totp_check();
    dev_dump(ui, "sec4.confirmed");

    // Stepping the prompt list...
    ui.invoke_editor_sec_prompt_step(1);
    ui.invoke_editor_sec_prompt_step(1);
    dev_dump(ui, "sec5.prompt-step");
    // ...and clean past the end, which must wrap rather than stick.
    for _ in 0..10 {
        ui.invoke_editor_sec_prompt_step(1);
    }
    dev_dump(ui, "sec6.prompt-wrap");

    // An answer a stranger could guess must be refused...
    ui.set_edit_sec_new_answer("yes".into());
    ui.invoke_editor_sec_question_add();
    dev_dump(ui, "sec7.answer-weak");

    // ...and a real one must land as a prompt plus a hash nobody can read.
    ui.set_edit_sec_new_answer("the cobbled lane behind the mill".into());
    ui.invoke_editor_sec_question_add();
    dev_dump(ui, "sec8.answer-added");

    // Checking it back: open the box, fail, then pass. Three lines, because
    // opening and verifying are two different things that could break.
    let question_id = state
        .borrow()
        .editor_security
        .questions
        .first()
        .map(|question| question.id.clone())
        .unwrap_or_default();
    if !question_id.is_empty() {
        ui.invoke_editor_sec_question_check(question_id.as_str().into());
        ui.set_edit_sec_check_input("not the answer".into());
        ui.invoke_editor_sec_question_check(question_id.as_str().into());
        dev_dump(ui, "sec9.answer-wrong");
        ui.set_edit_sec_check_input("the cobbled lane behind the mill".into());
        ui.invoke_editor_sec_question_check(question_id.as_str().into());
        dev_dump(ui, "sec10.answer-ok");
    }

    // The passcode, in the TS order: too weak, then a mismatch, then saved.
    // With an authenticator already set, the saved one has to be 12+.
    ui.set_edit_sec_passcode_new("abc".into());
    ui.set_edit_sec_passcode_confirm("abc".into());
    ui.invoke_editor_sec_passcode_save();
    dev_dump(ui, "sec11.passcode-weak");

    ui.set_edit_sec_passcode_new("correct horse battery staple".into());
    ui.set_edit_sec_passcode_confirm("correct horse battery stapl".into());
    ui.invoke_editor_sec_passcode_save();
    dev_dump(ui, "sec12.passcode-mismatch");

    ui.set_edit_sec_passcode_confirm("correct horse battery staple".into());
    ui.invoke_editor_sec_passcode_save();
    dev_dump(ui, "sec13.passcode-saved");

    // Checking it back against the hash just written.
    ui.set_edit_sec_passcode_input("wrong".into());
    ui.invoke_editor_sec_passcode_check();
    dev_dump(ui, "sec14.passcode-wrong");
    ui.set_edit_sec_passcode_input("correct horse battery staple".into());
    ui.invoke_editor_sec_passcode_check();
    dev_dump(ui, "sec15.passcode-ok");

    // All three factors at once: `full`.
    dev_dump(ui, "sec16.all-set");

    // Then take them away again, so the file ends on the state a screenshot
    // -- if the desktop ever unlocks -- would be expected to show. Asking for
    // `still` leaves all three factors on, which is the picture worth taking.
    if std::env::var("COLAX_DEV_SEC").map(|value| value == "still").unwrap_or(false) {
        dev_dump(ui, "sec17.standing");
        return;
    }
    ui.invoke_editor_sec_question_remove(question_id.as_str().into());
    ui.invoke_editor_sec_passcode_remove();
    ui.invoke_editor_sec_totp_remove();
    dev_dump(ui, "sec17.cleared");
}

/// The tag cloud as one line: pills joined by spaces, a `*` before each one
/// this login carries, `|` between lines. Read off the model the screen will
/// draw rather than off the selection list, so a line here proves the rows
/// crossed the boundary *and* that the right pills got lit.
#[cfg(debug_assertions)]
fn describe_tag_cloud(ui: &MainWindow) -> String {
    use slint::Model;
    let rows = ui.get_edit_tag_rows();
    let mut out = String::new();
    for line in 0..rows.row_count() {
        let Some(pills) = rows.row_data(line) else {
            continue;
        };
        if line > 0 {
            out.push('|');
        }
        for pill in 0..pills.row_count() {
            let Some(tag) = pills.row_data(pill) else {
                continue;
            };
            if pill > 0 {
                out.push(' ');
            }
            if tag.selected {
                out.push('*');
            }
            out.push_str(&tag.name);
        }
    }
    out
}

/// Debug-only: drive the Organise section end to end, dumping one line after
/// each step -- the same shape as `dev_sec`, for the same reason: a locked
/// desktop gives white screenshots, so what has to be checked gets written
/// down instead.
///
/// Run with `COLAX_DEV_ORG=1` (plus `COLAX_DEV_DIR`/`_SEED`), which implies
/// `COLAX_DEV_SCREEN=editor-organise`. Each step's comment says what the line
/// after it must show; the run ends by saving and reopening the login, so the
/// last line is the cloud as it survives a round trip through the vault.
#[cfg(debug_assertions)]
fn dev_org(ui: &MainWindow, state: &Shared) {
    use slint::Model;
    // Start from an empty file: these lines only read as a sequence in order,
    // and the tail of a previous run would otherwise look like this one's.
    let _ = std::fs::remove_file(app_dir().join("dev-dump.txt"));

    // 1. The cloud as it opens: the three shipped tags, none on this login.
    dev_dump(ui, "org1.open");

    // 2. Whitespace is not a tag: the box accepts the keystrokes, but the
    //    button must stay refused (`canadd=false`).
    ui.set_edit_tag_input("   ".into());
    ui.invoke_editor_tag_input_edited();
    dev_dump(ui, "org2.blank");

    // 3. A real name is accepted (`canadd=true`).
    ui.set_edit_tag_input("work".into());
    ui.invoke_editor_tag_input_edited();
    dev_dump(ui, "org3.named");

    // 4. Adding writes the catalogue at once -- four pills now -- and ticks
    //    the new one on (`*work`); the box clears with it, so `canadd` falls
    //    back to false.
    ui.invoke_editor_tag_add();
    dev_dump(ui, "org4.added");

    // 5/6. Toggling a pill that is already in the catalogue, off and back on.
    //      The id has to be the *catalogue's*, so take it from the cloud the
    //      last push drew: the first pill, "weak", starting unselected. An
    //      empty id would be refused by the handler's catalogue check anyway,
    //      so a cloud that somehow came back empty fails quiet, not loud.
    let some_id = ui
        .get_edit_tag_rows()
        .row_data(0)
        .and_then(|line| line.row_data(0))
        .map(|tag| tag.id.to_string())
        .unwrap_or_default();
    ui.invoke_editor_tag_toggle(some_id.as_str().into());
    dev_dump(ui, "org5.toggled-on");
    ui.invoke_editor_tag_toggle(some_id.as_str().into());
    dev_dump(ui, "org6.toggled-off");

    // 7. A date that parses is taken, redrawn padded ("2026-01-02"), and its
    //    hint becomes the age of *that* day rather than of the record's own.
    ui.set_edit_pw_date("2026-1-2".into());
    ui.invoke_editor_date_edited(0);
    dev_dump(ui, "org7.pw-date");

    // 8. Text that is not a date changes nothing: identical to the line above.
    ui.set_edit_pw_date("not a date".into());
    ui.invoke_editor_date_edited(0);
    dev_dump(ui, "org8.pw-garbage");

    // 9. The email column takes its own date without moving the password's.
    ui.set_edit_email_date("2026-03-04".into());
    ui.invoke_editor_date_edited(1);
    dev_dump(ui, "org9.email-date");

    // 10. A narrower cloud repacks: four pills sit on one line at the
    //      fallback width and cannot at 320px, so the answer must be more
    //      lines than before.
    ui.invoke_editor_tag_relayout(320.0);
    dev_dump(ui, "org10.narrow");

    // 11. Save writes the tags and both dates onto the record; reopening it
    //      must bring the same cloud back -- `*work` still lit, both dates
    //      still the ones typed, both hints recomputed from them.
    let id = ui.get_edit_id().to_string();
    ui.invoke_editor_save();
    open_editor(ui, state, &id);
    ui.invoke_editor_section_selected("organise".into());
    dev_dump(ui, "org11.reopened");
}

/// Debug-only: drive the view switcher and the sort menu, dumping one line
/// after each step -- same shape as the other two sequences, same reason.
/// `COLAX_DEV_VIEW=1` keeps the window on the vault screen, which is the
/// point: the four presentations live there and the sequence checks what a
/// click on each leaves behind. The ring's drift is a timer and cannot be
/// caught in a single line; what a line can show is that picking Orbit left
/// the view where the timer looks for it.
#[cfg(debug_assertions)]
fn dev_view(ui: &MainWindow) {
    // Start from a known place: the last run left its picks behind in the
    // vault, and prefs now say whatever it chose.
    let _ = std::fs::remove_file(app_dir().join("dev-dump.txt"));

    // 1. As it opens: whatever the prefs last said, cards included.
    dev_dump(ui, "view1.open");

    // 2-5. Each view in turn. The first two cards keep their names in every
    //      one of them -- same model, four shapes -- and the letter headers
    //      appear only where the List view and the by-name sort agree.
    ui.invoke_view_picked("grid".into());
    dev_dump(ui, "view2.grid");
    ui.invoke_view_picked("basic".into());
    dev_dump(ui, "view3.basic");
    ui.invoke_view_picked("carousel".into());
    dev_dump(ui, "view4.carousel");
    ui.invoke_view_picked("animated".into());
    dev_dump(ui, "view5.animated");

    // 6. An id outside the four is refused: the line must match view5's.
    ui.invoke_view_picked("not-a-view".into());
    dev_dump(ui, "view6.view-refused");

    // 7. Sort by recency: the same cards in a different order at the head,
    //    and the button's label changes with it.
    ui.invoke_sort_picked("recent".into());
    dev_dump(ui, "view7.sort-recent");

    // 8. Refused the same way.
    ui.invoke_sort_picked("not-a-sort".into());
    dev_dump(ui, "view8.sort-refused");

    // 9. Back to the by-name sort on the List view -- the one pairing that
    //    puts letter headers over the cards.
    ui.invoke_view_picked("basic".into());
    ui.invoke_sort_picked("title".into());
    dev_dump(ui, "view9.grouped");

    // 10. The grid's answer to a width: two columns at the floor, more when
    //     there is room for them (the width is Slint's, the count Rust's).
    ui.invoke_view_picked("grid".into());
    ui.invoke_vault_relayout(520.0);
    dev_dump(ui, "view10.narrow");
    ui.invoke_vault_relayout(1400.0);
    dev_dump(ui, "view11.wide");
}

/// Debug-only: dock the rail four ways, label it three, and take it off the
/// window -- one dump per step, same shape as the other runs. `showSidebar`
/// and `compactSidebar` are written as prefs the way Settings will write
/// them (no Settings screen exists yet, and a stored vault from the web
/// build arrives with its own), so every step covers the path a real change
/// takes: pref, save, push. What a line can show is what reached the window;
/// the geometry those props drive is read off by hand when the desktop is
/// unlocked.
#[cfg(debug_assertions)]
fn dev_rail(ui: &MainWindow, state: &Shared) {
    let _ = std::fs::remove_file(app_dir().join("dev-dump.txt"));

    // 1. Whatever the vault opened as -- left/both unless a stored vault
    //    said otherwise.
    dev_dump(ui, "rail1.open");

    // 2-5. The four docks, then an id outside them: the refused line must
    //      be identical to the one before it.
    ui.invoke_rail_picked("right".into());
    dev_dump(ui, "rail2.right");
    ui.invoke_rail_picked("top".into());
    dev_dump(ui, "rail3.top");
    ui.invoke_rail_picked("bottom".into());
    dev_dump(ui, "rail4.bottom");
    ui.invoke_rail_picked("middle".into());
    dev_dump(ui, "rail5.refused");

    // 6-9. Back to the left dock, then the three label modes. Icon labels
    //      narrow the rail too (the compact flag rides the push), and a bad
    //      mode is refused the same way a bad dock is.
    ui.invoke_rail_picked("left".into());
    ui.invoke_labels_picked("icon".into());
    dev_dump(ui, "rail6.icons");
    ui.invoke_labels_picked("name".into());
    dev_dump(ui, "rail7.names");
    ui.invoke_labels_picked("both".into());
    dev_dump(ui, "rail8.both");
    ui.invoke_labels_picked("names".into());
    dev_dump(ui, "rail9.labels-refused");

    // 10-12. The two dials only Settings writes: hidden, then compact on top
    //       of it, then everything back to where it started.
    write_sidebar_prefs(ui, state, false, false);
    dev_dump(ui, "rail10.hidden");
    write_sidebar_prefs(ui, state, true, true);
    dev_dump(ui, "rail11.compact");
    // Back to the defaults, not to the hidden state above: shown and full
    // width, the way the seed writes them.
    write_sidebar_prefs(ui, state, true, false);
    dev_dump(ui, "rail12.restored");
}

/// The bulk write `rail10`-`rail12` need: one prefs round trip for the two
/// sidebar switches the screen has no control for yet, the way Settings
/// will do it when Settings exists.
#[cfg(debug_assertions)]
fn write_sidebar_prefs(ui: &MainWindow, state: &Shared, show: bool, compact: bool) {
    let mut prefs = items::prefs_from(state.borrow().engine.preferences());
    prefs.show_sidebar = show;
    prefs.compact_sidebar = compact;
    if save_prefs(ui, state, &prefs) {
        refresh_items(ui, state);
    }
}

/// The bulk write `dev_gate` needs: one prefs round trip for the vault's own
/// factor, the way Settings will do it when Settings exists.
#[cfg(debug_assertions)]
fn write_vault_security(ui: &MainWindow, state: &Shared, security: LoginSecurity) {
    let mut prefs = items::prefs_from(state.borrow().engine.preferences());
    prefs.vault_security = security;
    if !save_prefs(ui, state, &prefs) {
        ui.set_error_text("That factor could not be saved.".into());
    }
}

/// Debug-only: put a second factor on the scratch vault and walk every
/// branch the gate has -- a wrong factor and its exact sentence, a right one,
/// the proof surviving a second landing, lock spending it, all three factor
/// types, an edit-gated login, and Cancel's one unusual outcome (the vault's
/// own gate locks). Everything runs through the functions the screen calls
/// (prefs writes, `goto`, `invoke_gate_unlock`, `invoke_gate_cancel`), so the
/// run covers the paths a real click takes. What a line can show is what
/// reached the window; the panel itself is read off by hand once the desktop
/// is unlocked.
#[cfg(debug_assertions)]
fn dev_gate(ui: &MainWindow, state: &Shared) {
    let _ = std::fs::remove_file(app_dir().join("dev-dump.txt"));

    // 1. A fresh vault carries no vault factor, so nothing raises.
    dev_dump(ui, "gate1.bare");

    // 2. Give it a passcode over "123456" and take the landing that looks
    //    for one.
    let (hash, salt) = hash_passcode("123456");
    write_vault_security(
        ui,
        state,
        LoginSecurity {
            totp: None,
            passcode: Some(SecurityPasscode { hash, salt }),
            questions: Vec::new(),
        },
    );
    goto(ui, state, Screen::Vault);
    dev_dump(ui, "gate2.open");

    // 3. Wrong: SecurityGate.tsx's own sentence, and the gate stays up.
    ui.invoke_gate_unlock("passcode".into(), "000000".into(), "".into());
    dev_dump(ui, "gate3.refused");

    // 4. Right: the gate drops.
    ui.invoke_gate_unlock("passcode".into(), "123456".into(), "".into());
    dev_dump(ui, "gate4.verified");

    // 5. ...and the proof holds for the session: no second asking.
    goto(ui, state, Screen::Vault);
    dev_dump(ui, "gate5.silent");

    // 6-7. Lock spends the proof; the next unlock asks again.
    lock_vault(ui, state);
    dev_dump(ui, "gate6.locked");
    unlock_with(ui, state, "");
    dev_dump(ui, "gate7.reasks");

    // 8. The recovery-question path. Swap the factor for one stored
    //    question, then lock and unlock once more so the new one is what the
    //    gate is handed.
    let (hash, salt) = hash_answer("Rex");
    write_vault_security(
        ui,
        state,
        LoginSecurity {
            totp: None,
            passcode: None,
            questions: vec![SecurityQuestion {
                id: "q1".into(),
                prompt: "First pet's name?".into(),
                hash,
                salt,
            }],
        },
    );
    lock_vault(ui, state);
    unlock_with(ui, state, "");
    dev_dump(ui, "gate8.question-open");

    // 9-10. Its wrong sentence, then its pass.
    ui.invoke_gate_unlock("question".into(), "Fido".into(), "q1".into());
    dev_dump(ui, "gate9.answer-refused");
    ui.invoke_gate_unlock("question".into(), "Rex".into(), "q1".into());
    dev_dump(ui, "gate10.answer-ok");

    // 11-12. An edit-gated login: a secured record lands straight from the
    //       engine (its own passcode), and opening it raises the gate with
    //       the TS title. Cancel abandons the open and stays out of the
    //       editor -- the vault's cancel, which locks, is a different intent.
    let (hash, salt) = hash_passcode("654321");
    let secured_login = {
        let mut guard = state.borrow_mut();
        guard
            .engine
            .add_item(&serde_json::json!({
                "title": "Secured Bank",
                "url": "bank.example",
                "username": "ada",
                "password": "hunter22hunter2",
                "security": { "passcode": { "hash": hash, "salt": salt } },
            }))
            .ok()
            .map(|item| item.id)
    };
    let Some(id) = secured_login else {
        dev_dump(ui, "gate11.no-item");
        return;
    };
    open_editor(ui, state, &id);
    dev_dump(ui, "gate11.edit-open");
    ui.invoke_gate_cancel();
    dev_dump(ui, "gate12.edit-cancel");

    // 13-15. The authenticator path: a seed on the vault, a stale code
    //       refused first, then the *current* one -- from the same core
    //       clock `verify_totp` reads.
    let seed = "GEZDGNBVGY3TQOJQ".to_string();
    write_vault_security(
        ui,
        state,
        LoginSecurity {
            totp: Some(TotpSecret { seed: seed.clone() }),
            passcode: None,
            questions: Vec::new(),
        },
    );
    lock_vault(ui, state);
    unlock_with(ui, state, "");
    dev_dump(ui, "gate13.totp-open");
    ui.invoke_gate_unlock("totp".into(), "000000".into(), "".into());
    dev_dump(ui, "gate14.code-refused");
    let code = colax_core::totp::current_totp_code(&seed).unwrap_or_default();
    ui.invoke_gate_unlock("totp".into(), code.as_str().into(), "".into());
    dev_dump(ui, "gate15.code-ok");

    // 16-17. And the vault gate's one unusual outcome: cancel *locks*
    //       (the TS `onCancel` at L2839), which a line ending on the lock
    //       screen shows.
    lock_vault(ui, state);
    unlock_with(ui, state, "");
    dev_dump(ui, "gate16.reasked");
    ui.invoke_gate_cancel();
    dev_dump(ui, "gate17.cancel-locks");
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

/// The mail filter: what the record stores, and what the screen shows. One
/// table for both halves, like `REMINDER_PRESETS`, so `Segmented`'s index
/// cannot drift from the value the normaliser coerces to.
const MAIL_FILTERS: [(&str, &str); 3] = [
    ("auto", "Auto"),
    ("matched", "Matched only"),
    ("recent", "Recent only"),
];

fn mail_filter_label(value: &str) -> String {
    MAIL_FILTERS
        .iter()
        .find(|(v, _)| *v == value)
        .map(|(_, label)| (*label).to_string())
        // The model coerces anything unknown to `auto`, so this can only be
        // reached by a value that has not been through it yet — and agreeing
        // with it beats showing a lit segment for a stored value that is not.
        .unwrap_or_else(|| MAIL_FILTERS[0].1.to_string())
}

fn mail_filter_value(label: &str) -> &'static str {
    MAIL_FILTERS
        .iter()
        .find(|(_, l)| *l == label)
        .map(|(value, _)| *value)
        .unwrap_or(MAIL_FILTERS[0].0)
}

/// `HUE_PRESETS` in `ItemEditor.tsx` L879, in order. Auto carries -1 rather
/// than a hue: the choice is to *derive* one from the title, not to pick
/// hue zero, and the swatch row checks this number to light the active chip.
const HUE_PRESETS: [(&str, f64); 8] = [
    ("Auto", -1.0),
    ("Slate", 212.0),
    ("Sage", 152.0),
    ("Dusk", 268.0),
    ("Clay", 28.0),
    ("Sea", 196.0),
    ("Moss", 118.0),
    ("Plum", 316.0),
];

/// The eight recovery prompts, in `QUESTION_PROMPTS` order in
/// `SecurityForm.tsx` L627. Copy lives beside the presets for the same reason
/// they do: Rust steps the index and shows one of them, and a list written in
/// two files would have two chances to drift.
const QUESTION_PROMPTS: [&str; 8] = [
    "The name of the street you grew up on",
    "The name of your first pet",
    "The make of your first car",
    "The name of the school you attended",
    "The name of a city you have lived in",
    "The name of your favourite teacher",
    "The model of your first phone",
    "The name of a book that mattered to you",
];

/// Only http(s) and inline images are allowed, so a login cannot smuggle in
/// markup (`isAllowedImageSrc`, `types.ts` L251). Anything else is stored as
/// the empty string rather than as a value the card would later trust.
fn allowed_image(src: &str) -> String {
    let src = src.trim();
    if src.starts_with("data:image/")
        || src.starts_with("https://")
        || src.starts_with("http://")
    {
        src.to_string()
    } else {
        String::new()
    }
}

/// Pushes the Appearance section's read-outs: the eight swatches, the hue as
/// text, where the slider sits, the blur read-out and the preview gradient.
///
/// The hue is the draft's when it has one, and `hue_for(title || username ||
/// url || "aegis")` when it does not — `accentOf()` in `types.ts` — so the
/// preview shows exactly the colour the card will show, before anything is
/// saved. Call it whenever a field that feeds it changes.
fn push_appearance(ui: &MainWindow) {
    let title = ui.get_edit_title().to_string();
    let username = ui.get_edit_username().to_string();
    let url = ui.get_edit_url().to_string();
    let chosen = ui.get_edit_accent_hue();

    let seed = if !title.is_empty() {
        title.as_str()
    } else if !username.is_empty() {
        username.as_str()
    } else if !url.is_empty() {
        url.as_str()
    } else {
        "aegis"
    };
    let hue = if chosen.is_finite() && chosen >= 0.0 {
        chosen.rem_euclid(360.0)
    } else {
        colax_core::model::hue_for(seed) as f32
    };

    ui.set_edit_hue_slider(hue);
    let hue_text = format!("{}\u{b0}", hue.round() as i32);
    ui.set_edit_hue_readout(hue_text.as_str().into());
    // The card's own gradient: 135deg, hsl(h 40% 56%) -> hsl(h+34 36% 44%),
    // which is what `accentOf()` renders through the same two stops.
    ui.set_edit_preview_from(appearance::hsl(f64::from(hue), 40.0, 56.0, 1.0));
    ui.set_edit_preview_to(appearance::hsl(f64::from(hue) + 34.0, 36.0, 44.0, 1.0));

    let blur_text = format!("{}", ui.get_edit_bg_blur().round() as i32);
    ui.set_edit_blur_readout(blur_text.as_str().into());
    // `title.trim()[0] ?? '?'`, upper-cased — including when the name is
    // empty, because the card in the list falls back to the username or the
    // host instead and this preview must not pretend to show that.
    let initial = title
        .trim()
        .chars()
        .next()
        .map(|c| c.to_uppercase().collect::<String>())
        .unwrap_or_else(|| "?".to_string());
    ui.set_edit_preview_initial(initial.as_str().into());

    let swatches: Vec<HueSwatch> = HUE_PRESETS
        .iter()
        .map(|(label, preset)| {
            // Auto's chip is a sweep of the calm set, which is the stand-in
            // here for CSS's conic gradient; every other chip is the same
            // 135° pair the card draws.
            let (from, to) = if *preset < 0.0 {
                (
                    appearance::hsl(212.0, 40.0, 58.0, 1.0),
                    appearance::hsl(152.0, 40.0, 58.0, 1.0),
                )
            } else {
                (
                    appearance::hsl(*preset, 40.0, 56.0, 1.0),
                    appearance::hsl(*preset + 34.0, 36.0, 44.0, 1.0),
                )
            };
            HueSwatch {
                label: (*label).into(),
                hue: *preset as f32,
                from,
                to,
            }
        })
        .collect();
    ui.set_edit_hue_swatches(ModelRc::new(VecModel::from(swatches)));
}

/// Pushes the Security section's readable half: the level, the two flags, the
/// question rows (prompts only), the prompt the add row offers, and the QR
/// symbol for whichever key is live.
///
/// The draft itself is read from `state` and never from the screen — a hash
/// cannot round-trip through Slint, so this is the one place the two are
/// reconciled. Call it after every action that changes a factor, and from
/// `open_editor` once the draft has been seeded.
fn push_security(ui: &MainWindow, state: &Shared) {
    let (sec, staged, prompt_index) = {
        let guard = state.borrow();
        (
            guard.editor_security.clone(),
            guard.editor_staged_seed.clone(),
            guard.editor_prompt_index,
        )
    };

    ui.set_edit_sec_level(security_level(&sec).into());
    ui.set_edit_sec_totp(sec.totp.is_some());
    ui.set_edit_sec_passcode(sec.passcode.is_some());
    // Staged is a *separate* flag from saved, as `stagedSeed` is in TS: a
    // key the phone has never confirmed must never look like a set factor.
    ui.set_edit_sec_totp_staged(staged.is_some());

    // "Not set" / "1 question" / "2 questions": composed here because Slint
    // cannot turn a number into part of a string.
    let note = match sec.questions.len() {
        0 => "Not set".to_string(),
        1 => "1 question".to_string(),
        n => format!("{n} questions"),
    };
    ui.set_edit_sec_questions_note(note.as_str().into());

    let rows: Vec<QuestionRow> = sec
        .questions
        .iter()
        .map(|q| QuestionRow {
            id: q.id.clone().into(),
            prompt: q.prompt.clone().into(),
        })
        .collect();
    ui.set_edit_sec_questions(ModelRc::new(VecModel::from(rows)));

    let prompt = QUESTION_PROMPTS
        .get(prompt_index)
        .copied()
        .unwrap_or(QUESTION_PROMPTS[0]);
    ui.set_edit_sec_new_prompt(prompt.into());

    push_security_qr(ui, &sec, staged.as_deref());
}

/// The QR half, split out because the login's *name* feeds it too: the
/// `otpauth://` URI carries the name, so renaming a login has to regenerate
/// the symbol — the TS effect depends on `[activeSeed, label]`.
fn push_security_qr(ui: &MainWindow, sec: &LoginSecurity, staged: Option<&str>) {
    let seed = staged.or_else(|| sec.totp.as_ref().map(|t| t.seed.as_str()));
    let Some(seed) = seed else {
        ui.set_edit_qr_size(0);
        ui.set_edit_qr_cells(ModelRc::new(VecModel::from(Vec::<QrCell>::new())));
        ui.set_edit_sec_otpauth("".into());
        return;
    };

    // `label={draft.title || 'login'}` in ItemEditor.tsx L559; `otpauth_url`
    // then does the `|| 'vault'` fallback byte-for-byte with TS.
    let title = ui.get_edit_title().to_string();
    let label = if title.is_empty() { "login" } else { title.as_str() };
    let url = otpauth_url(label, seed);

    let symbol = qr_matrix(&url).map(|(side, bits)| {
        // Only the dark half is shipped — a symbol is half light — and each
        // module keeps its own row and column, because Slint has no `%` to
        // split a flat index back apart again.
        let cells: Vec<QrCell> = bits
            .iter()
            .enumerate()
            .filter(|(_, dark)| **dark)
            .map(|(i, _)| QrCell {
                col: (i % side) as i32,
                row: (i / side) as i32,
            })
            .collect();
        (side as i32, cells)
    });

    match symbol {
        Some((side, cells)) => {
            ui.set_edit_qr_size(side);
            ui.set_edit_qr_cells(ModelRc::new(VecModel::from(cells)));
            ui.set_edit_sec_otpauth(url.as_str().into());
        }
        None => {
            // No symbol can hold this URI. TS treats that as "no QR" and
            // keeps the setup key usable; the screen says so and shows it.
            ui.set_edit_qr_size(0);
            ui.set_edit_qr_cells(ModelRc::new(VecModel::from(Vec::<QrCell>::new())));
            ui.set_edit_sec_otpauth(url.as_str().into());
        }
    }
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
        // New logins start on auto colour, no background, no icon and mail
        // off — the last one deliberately: one connected mailbox must not put
        // a Messages button on every login created after it.
        ui.set_edit_accent_hue(-1.0);
        ui.set_edit_bg_image("".into());
        ui.set_edit_bg_blur(0.0);
        ui.set_edit_avatar_image("".into());
        ui.set_edit_show_mail(false);
        ui.set_edit_mail_filter(MAIL_FILTERS[0].0.into());
        ui.set_edit_mail_filter_label(MAIL_FILTERS[0].1.into());
        // A new login starts with no second factor (`EMPTY_SECURITY`), no
        // tags, and both dates at *now* — the TS draft reads
        // `draft.passwordUpdatedAt ?? Date.now()` for exactly this case, since
        // a blank draft has no stamps of its own.
        {
            let now = colax_core::util::now_ms();
            let mut guard = state.borrow_mut();
            guard.editor_security = LoginSecurity::default();
            guard.editor_tags = Vec::new();
            guard.editor_password_updated_at = now;
            guard.editor_username_updated_at = now;
        }
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
        // A second factor on this login gates the editor itself (the TS
        // `pendingItem` flow with intent `edit`, App.tsx L3399-3410): the
        // gate resumes *this* open once a factor clears, and `verified`
        // keeps it from asking twice in one session.
        if colax_core::is_secured(&item.security)
            && !state.borrow().verified.contains(&item.id)
        {
            let title = if item.title.is_empty() {
                "this login".to_string()
            } else {
                format!("Unlock {}", item.title)
            };
            open_gate(
                ui,
                state,
                GateIntent::Edit(item.id.clone()),
                item.security.clone(),
                &title,
                "This login has a second factor. Clear it to open the editor.",
            );
            return;
        }
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
        ui.set_edit_accent_hue(
            item.accent_hue
                .filter(|hue| hue.is_finite())
                .map(|hue| hue as f32)
                .unwrap_or(-1.0),
        );
        ui.set_edit_bg_image(item.background_image.as_str().into());
        ui.set_edit_bg_blur(item.background_blur as f32);
        ui.set_edit_avatar_image(item.avatar_image.as_str().into());
        ui.set_edit_show_mail(item.show_mail);
        ui.set_edit_mail_filter(item.mail_filter.as_str().into());
        ui.set_edit_mail_filter_label(mail_filter_label(&item.mail_filter).as_str().into());
        // The Security draft is Rust's, so it is seeded here rather than in
        // the panel: whatever this record carries is what Save will write back.
        // The tag selection and the two dates are seeded here for the same
        // reason — they are read back by `editor_save`, not by the screen.
        {
            let mut guard = state.borrow_mut();
            guard.editor_security = item.security.clone();
            guard.editor_tags = item.tags.clone();
            guard.editor_password_updated_at = item.password_updated_at;
            guard.editor_username_updated_at = item.username_updated_at;
        }
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

    // The Security transient layer. `changed screen` cannot reach it (the
    // editor may already be open, and this runs before the screen changes),
    // and the staged key in particular must not survive one login being
    // closed for another: it would arm a record it was never confirmed for.
    {
        let mut guard = state.borrow_mut();
        guard.editor_staged_seed = None;
        guard.editor_prompt_index = 0;
    }
    ui.set_edit_sec_totp_seed("".into());
    ui.set_edit_sec_totp_code("".into());
    ui.set_edit_sec_totp_note("".into());
    ui.set_edit_sec_passcode_new("".into());
    ui.set_edit_sec_passcode_confirm("".into());
    ui.set_edit_sec_passcode_input("".into());
    ui.set_edit_sec_passcode_error("".into());
    ui.set_edit_sec_answer_error("".into());
    ui.set_edit_sec_checking_id("".into());
    ui.set_edit_sec_check_input("".into());
    ui.set_edit_sec_new_answer("".into());

    // The Organise transient layer, same reason as the Security one above: the
    // add box empties with the login, so a half-typed tag from the previous
    // one cannot be added to the next.
    ui.set_edit_tag_input("".into());
    ui.set_edit_tag_can_add(false);

    let password = ui.get_edit_password().to_string();
    push_strength(ui, &password);
    // The Appearance read-outs depend on the name, so they are pushed last,
    // once both branches have filled the draft.
    push_appearance(ui);
    // ...and so does the QR code, because the `otpauth://` URI carries the
    // name -- same reason, same place.
    push_security(ui, state);
    // The Organise cloud and dates last of all: both read the draft the two
    // branches above just filled.
    push_organise(ui, state);

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
    let hue = ui.get_edit_accent_hue();
    // The Security half of the draft lives in Rust, not in the screen, so it
    // is read here -- hashes never crossed the boundary to be read back. The
    // same is true of the tag selection and the two dates, which `open_editor`
    // seeded from the record and the Organise section may have moved.
    let (security, tags, password_updated_at, username_updated_at) = {
        let guard = state.borrow();
        (
            guard.editor_security.clone(),
            guard.editor_tags.clone(),
            guard.editor_password_updated_at,
            guard.editor_username_updated_at,
        )
    };
    // -1 is the draft's "auto": saved as null so the card keeps deriving its
    // colour from the name, which is what `accentOf()` does with a null.
    let accent_hue: Option<f64> = if hue.is_finite() && hue >= 0.0 {
        Some(f64::from(hue))
    } else {
        None
    };
    let patch = serde_json::json!({
        "title": title,
        "url": url,
        "username": username,
        "password": password,
        "notes": ui.get_edit_notes().to_string(),
        "favorite": ui.get_edit_favorite(),
        "needsAttention": ui.get_edit_needs_attention(),
        "reminderDays": f64::from(ui.get_edit_reminder_days()),
        "accentHue": accent_hue,
        "backgroundImage": allowed_image(ui.get_edit_bg_image().as_str()),
        "backgroundBlur": f64::from(ui.get_edit_bg_blur()),
        "avatarImage": allowed_image(ui.get_edit_avatar_image().as_str()),
        "showMail": ui.get_edit_show_mail(),
        "mailFilter": mail_filter_value(ui.get_edit_mail_filter_label().as_str()),
        // The Organise half. Both stamps always travel, because the engine's
        // rule (`update_item`) needs them there to keep a manual date from
        // being overwritten -- and a whole-draft patch is what the TS editor
        // sends too (`onSave(draft)` in ItemEditor.tsx L399), so a changed
        // password lands on the same side of `?? next.updatedAt` here as there.
        "passwordUpdatedAt": password_updated_at,
        "usernameUpdatedAt": username_updated_at,
        "tags": serde_json::to_value(&tags).unwrap_or(serde_json::Value::Null),
        // A whole value rather than a serialisation inside the macro, so a
        // factor can never be written as `null` by a failed conversion.
        "security": serde_json::to_value(&security).unwrap_or(serde_json::Value::Null),
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

fn editor_reveal(ui: &MainWindow, state: &Shared) {
    if ui.get_screen() != Screen::Editor {
        return;
    }
    // Only *showing* is gated; hiding what is already shown is free. The
    // title and hint are the `reveal` intent's own strings (App.tsx L3401-05).
    if !ui.get_gen_reveal_editor() {
        let id = ui.get_edit_id().to_string();
        let (secured, verified, security) = {
            let guard = state.borrow();
            (
                colax_core::is_secured(&guard.editor_security),
                guard.verified.contains(&id),
                guard.editor_security.clone(),
            )
        };
        if secured && !verified && !id.is_empty() {
            open_gate(
                ui,
                state,
                GateIntent::Reveal(id),
                security,
                "Show password",
                "This login has a second factor. Clear it to reveal the password.",
            );
            return;
        }
    }
    ui.set_gen_reveal_editor(!ui.get_gen_reveal_editor());
}

/* ---- SecurityGate -------------------------------------------------------- */

/// Raise the gate over whatever is on screen. The title and hint are the
/// exact strings SecurityGate.tsx prints for the flow being resumed; the
/// factors go out first and `gate-open` last, because opening builds the
/// panel and the panel reads its options at construction.
fn open_gate(
    ui: &MainWindow,
    state: &Shared,
    intent: GateIntent,
    security: LoginSecurity,
    title: &str,
    hint: &str,
) {
    ui.set_gate_has_passcode(security.passcode.is_some());
    ui.set_gate_has_totp(
        security
            .totp
            .as_ref()
            .map(|totp| !totp.seed.is_empty())
            .unwrap_or(false),
    );
    ui.set_gate_has_questions(!security.questions.is_empty());
    let prompts: Vec<QuestionRow> = security
        .questions
        .iter()
        .map(|question| QuestionRow {
            id: question.id.clone().into(),
            prompt: question.prompt.clone().into(),
        })
        .collect();
    ui.set_gate_questions(ModelRc::new(VecModel::from(prompts)));
    ui.set_gate_title(title.into());
    ui.set_gate_hint(hint.into());
    ui.set_gate_error("".into());
    state.borrow_mut().gate = Some(PendingGate { intent, security });
    ui.set_gate_open(true);
}

/// A second factor on the vault itself gates the shell ("Vault
/// verification", App.tsx L2829-2844). TS keeps this as a render-time
/// condition; here every landing on the vault re-checks it, and
/// `vault_verified` is the session's already-proved-it.
fn maybe_gate_vault(ui: &MainWindow, state: &Shared) {
    if state.borrow().vault_verified {
        return;
    }
    let security = {
        let guard = state.borrow();
        colax_core::normalise_preferences(guard.engine.preferences()).vault_security
    };
    if !colax_core::is_secured(&security) {
        return;
    }
    open_gate(
        ui,
        state,
        GateIntent::Vault,
        security,
        "Vault verification",
        "The vault is open, but this account added a second factor. Prove it is you.",
    );
}

/// One attempt. The mode decides which stored factor is checked and which
/// sentence a wrong answer earns -- the three are SecurityGate.tsx's own
/// (L48, L61, L74). The PBKDF2 behind a passcode or an answer runs here on
/// the UI thread, exactly where the unlock password already runs it: one
/// timing story, told in one place.
fn gate_unlock(
    ui: &MainWindow,
    state: &Shared,
    mode: &str,
    value: &str,
    question_id: &str,
) {
    // A second click queued behind the first (the check freezes the thread)
    // arrives after the gate is already gone; without a gate there is
    // nothing left to submit to.
    let Some(gate) = state.borrow().gate.clone() else {
        return;
    };
    let ok = match mode {
        "passcode" => gate
            .security
            .passcode
            .as_ref()
            .map(|passcode| verify_passcode(value, &passcode.hash, &passcode.salt))
            .unwrap_or(false),
        "totp" => {
            let digits: String = value.chars().filter(char::is_ascii_digit).collect();
            let digits: String = digits.chars().take(6).collect();
            gate.security
                .totp
                .as_ref()
                .map(|totp| verify_totp(&totp.seed, &digits))
                .unwrap_or(false)
        }
        _ => gate
            .security
            .questions
            .iter()
            .find(|question| question.id == question_id)
            .map(|question| verify_answer(value, &question.hash, &question.salt))
            .unwrap_or(false),
    };
    if !ok {
        let error = match mode {
            "passcode" => "That passcode does not match.",
            "totp" => "That code did not match. Try the current one.",
            _ => "That answer does not match.",
        };
        ui.set_gate_error(error.into());
        return;
    }

    // A pass is spent: close the gate, remember it against the flow that
    // asked, then re-run that flow -- which now finds its own proof waiting.
    // The error line goes with the panel (and `open_gate` clears it again on
    // every reopen, so a failed attempt can never be read twice).
    {
        let mut guard = state.borrow_mut();
        guard.gate = None;
        match gate.intent {
            GateIntent::Vault => guard.vault_verified = true,
            GateIntent::Edit(ref id) | GateIntent::Reveal(ref id) => {
                guard.verified.insert(id.clone());
            }
        }
    }
    ui.set_gate_open(false);
    ui.set_gate_error("".into());
    match gate.intent {
        GateIntent::Vault => {}
        GateIntent::Edit(id) => open_editor(ui, state, &id),
        GateIntent::Reveal(_) => editor_reveal(ui, state),
    }
}

/// Cancel: the interrupted flow is abandoned (the `onCancel` each TS
/// invocation passes in). The vault's gate has one other outcome in TS --
/// cancel *locks* the vault (L2839) -- and that difference lives here.
fn gate_cancel(ui: &MainWindow, state: &Shared) {
    let intent = state.borrow_mut().gate.take().map(|gate| gate.intent);
    ui.set_gate_open(false);
    ui.set_gate_error("".into());
    if matches!(intent, Some(GateIntent::Vault)) {
        lock_vault(ui, state);
    }
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

fn editor_hue_picked(ui: &MainWindow, hue: f32) {
    if ui.get_screen() != Screen::Editor {
        return;
    }
    // Committing an explicit hue, which is what dragging past the swatches
    // does in TS too — the only way back to "auto" is the Auto chip.
    ui.set_edit_accent_hue(hue);
    push_appearance(ui);
}

fn editor_title_edited(ui: &MainWindow, state: &Shared) {
    if ui.get_screen() != Screen::Editor {
        return;
    }
    push_appearance(ui);
    // The `otpauth://` URI carries the name, so renaming the login changes
    // the QR symbol too -- the TS effect depends on `[activeSeed, label]`.
    // Pushing all of Security rather than only the symbol keeps one place
    // that decides what the panel shows.
    push_security(ui, state);
}

fn editor_bg_blur_changed(ui: &MainWindow, value: f32) {
    if ui.get_screen() != Screen::Editor {
        return;
    }
    // The slider reports the raw position; the stored value is a whole pixel
    // of blur, as the TS range input's step of 1 gives it.
    let rounded = value.round();
    ui.set_edit_bg_blur(rounded);
    let text = format!("{}", rounded as i32);
    ui.set_edit_blur_readout(text.as_str().into());
}

fn editor_mail_filter_picked(ui: &MainWindow, index: i32) {
    if ui.get_screen() != Screen::Editor {
        return;
    }
    if let Some((value, label)) = MAIL_FILTERS.get(index.max(0) as usize) {
        ui.set_edit_mail_filter((*value).into());
        ui.set_edit_mail_filter_label((*label).into());
    }
}

/* --------------------------------------------------------------------------
Organise: the tag catalogue and the two dates

The catalogue is a *preference* -- shared by every login, created on the spot
from the add box -- while the selection belongs to the login being edited.
That split is why the selection lives here rather than in Slint: only Rust can
hold a chip's id and the catalogue it came from at the same time.

The cloud also has to be drawn in lines, and Slint has no wrapping layout, so
packing is Rust's too -- which costs little, because the pills are short text
and a per-character estimate errs on the long side: a line packed too wide
only ends early, while one packed too narrow runs two pills into each other.
-------------------------------------------------------------------------- */

/// The pill's own furniture, as `Chip` lays it out: 10px of padding either
/// side, the 8px dot, its 4px gap, and a pixel of border each side.
const CHIP_CHROME: f64 = 10.0 + 8.0 + 4.0 + 10.0 + 2.0;
/// Pill-to-pill gap, mirroring the row's `spacing` -- packing with any other
/// number would end lines a pill early or late against what is drawn.
const TAG_ROW_GAP: f64 = 8.0;
/// How wide the cloud packs for before anything has reported a width: its own
/// width at the window's *minimum* (880, less the 176px the panel gives away
/// to the rail, less 68px of its own padding), so a first paint at the
/// narrowest the window can be never packs a line too wide. `init` and every
/// resize replace it through `editor_tag_relayout`.
const TAG_PACK_FALLBACK_WIDTH: f64 = 636.0;

/// How wide a tag's name will draw, close enough to pack pills against.
///
/// Rust cannot ask Slint how wide its font makes a string, so this estimates
/// per character class at the chip's 12px and errs long.
fn label_width(name: &str) -> f64 {
    name.chars()
        .map(|c| match c {
            ' ' => 3.6,
            '.' | ',' | ':' | ';' | '\'' | 'i' | 'j' | 'l' | 't' | 'f' | 'r' | '1' => 4.2,
            'm' | 'w' | 'M' | 'W' => 10.5,
            'A'..='Z' | '0'..='9' => 8.8,
            // CJK, kana, Hangul, full-width forms and most emoji take a whole
            // em at this size -- the glyphs a flat per-character average
            // under-counts most, and the ones that would collide first.
            c if (c as u32) >= 0x2E80 => 13.0,
            _ => 7.2,
        })
        .sum()
}

fn chip_width(name: &str) -> f64 {
    CHIP_CHROME + label_width(name)
}

/// Splits the catalogue into lines that fit `width`, keeping catalogue order.
fn pack_tag_rows(
    tags: &[colax_core::Tag],
    selected: &[String],
    width: f64,
) -> ModelRc<ModelRc<PickTag>> {
    let avail = if (240.0..=20_000.0).contains(&width) {
        width
    } else {
        TAG_PACK_FALLBACK_WIDTH
    };
    let mut lines: Vec<Vec<PickTag>> = Vec::new();
    let mut line: Vec<PickTag> = Vec::new();
    let mut used = 0.0;

    for tag in tags {
        let w = chip_width(&tag.name);
        if !line.is_empty() && used + TAG_ROW_GAP + w > avail {
            lines.push(std::mem::take(&mut line));
            used = 0.0;
        }
        used = if line.is_empty() { w } else { used + TAG_ROW_GAP + w };
        line.push(PickTag {
            id: tag.id.clone().into(),
            name: tag.name.clone().into(),
            hue: items::hue_color(tag.hue.round() as i32),
            selected: selected.iter().any(|id| id == &tag.id),
        });
    }
    if !line.is_empty() {
        lines.push(line);
    }

    let packed: Vec<ModelRc<PickTag>> = lines
        .into_iter()
        .map(|line| ModelRc::new(VecModel::from(line)))
        .collect();
    ModelRc::new(VecModel::from(packed))
}

/// Everything the Organise section draws: the cloud split into lines, the two
/// dates with their hints, and the verdict on the add box.
///
/// Called from `open_editor` and after every action that moves the selection,
/// a date, or the width the cloud packs for.
fn push_organise(ui: &MainWindow, state: &Shared) {
    let (selected, width, pw_at, email_at) = {
        let guard = state.borrow();
        (
            guard.editor_tags.clone(),
            guard.editor_panel_width,
            guard.editor_password_updated_at,
            guard.editor_username_updated_at,
        )
    };
    let prefs = items::prefs_from(state.borrow().engine.preferences());

    ui.set_edit_tag_rows(pack_tag_rows(&prefs.tags, &selected, width));
    // `name.trim() != ""`, the add button's `disabled` in TS -- evaluated here
    // because Slint has no trim, and a button that would accept a box of
    // spaces as a tag is worse than one that waits.
    ui.set_edit_tag_can_add(!ui.get_edit_tag_input().to_string().trim().is_empty());

    // Both dates and both hints together: the hint is the age of the *same*
    // stamp the box shows, so they can never drift apart across two pushes.
    let now = colax_core::util::now_ms();
    ui.set_edit_pw_date(to_date_input(pw_at).as_str().into());
    ui.set_edit_pw_date_hint(relative_time(pw_at, now).as_str().into());
    ui.set_edit_email_date(to_date_input(email_at).as_str().into());
    ui.set_edit_email_date_hint(relative_time(email_at, now).as_str().into());
}

/// Add the typed name to the catalogue and tick it on this login.
///
/// The catalogue write is immediate, as `onCommitTags` is in TS: a tag that
/// only lands if the login is then saved is a tag a cancelled edit takes with
/// it. A name already in the catalogue is selected rather than duplicated --
/// compared case-insensitively on the trimmed text, as TS does.
fn editor_tag_add(ui: &MainWindow, state: &Shared) {
    if ui.get_screen() != Screen::Editor || ui.get_busy() {
        return;
    }
    let trimmed = ui.get_edit_tag_input().to_string().trim().to_string();
    if trimmed.is_empty() {
        return;
    }

    let mut prefs = items::prefs_from(state.borrow().engine.preferences());
    let existing = prefs
        .tags
        .iter()
        .find(|tag| tag.name.to_lowercase() == trimmed.to_lowercase())
        .cloned();

    let id = match existing {
        Some(tag) => tag.id,
        None => {
            let tag = create_tag(&trimmed, &prefs.tags);
            prefs.tags.push(tag.clone());
            if !save_prefs(ui, state, &prefs) {
                ui.set_error_text("That tag could not be saved.".into());
                return;
            }
            tag.id
        }
    };

    {
        let mut guard = state.borrow_mut();
        if !guard.editor_tags.contains(&id) {
            guard.editor_tags.push(id);
        }
    }
    ui.set_edit_tag_input("".into());
    push_organise(ui, state);
}

/// Flip one tag on this login. Nothing is written: the id joins or leaves the
/// draft's selection and Save carries it, exactly as `onChange` in TS.
fn editor_tag_toggle(ui: &MainWindow, state: &Shared, id: &str) {
    if ui.get_screen() != Screen::Editor {
        return;
    }
    // Only a tag that is actually in the catalogue can be toggled. The screen
    // can only ever offer chips it was given, so anything else is a stale id
    // from an earlier push rather than a choice the user made -- and letting
    // it in would save a tag nobody can see.
    let known = {
        let guard = state.borrow();
        items::prefs_from(guard.engine.preferences())
            .tags
            .iter()
            .any(|tag| tag.id == id)
    };
    if !known {
        return;
    }
    {
        let mut guard = state.borrow_mut();
        match guard.editor_tags.iter().position(|tag| tag == id) {
            Some(at) => {
                guard.editor_tags.remove(at);
            }
            None => guard.editor_tags.push(id.to_string()),
        }
    }
    push_organise(ui, state);
}

/// The cloud reports the width it was laid out at; the reply comes back as
/// rows packed for it. Widths that have not been measured yet are ignored --
/// `init` runs before the layout pass has given the element a size, and
/// packing for 0 would split every pill onto a line of its own.
fn editor_tag_relayout(ui: &MainWindow, state: &Shared, width: f32) {
    if ui.get_screen() != Screen::Editor {
        return;
    }
    let width = f64::from(width);
    if !(240.0..=20_000.0).contains(&width) {
        return;
    }
    state.borrow_mut().editor_panel_width = width;
    push_organise(ui, state);
}

/// The add box changed. Only the *verdict* travels back: the text is already
/// `<=>`-bound, and reading it again here would give the two a way to disagree.
fn editor_tag_input_edited(ui: &MainWindow) {
    if ui.get_screen() != Screen::Editor {
        return;
    }
    let can = !ui.get_edit_tag_input().to_string().trim().is_empty();
    ui.set_edit_tag_can_add(can);
}

/// One of the two date boxes changed: 0 = password, 1 = email.
///
/// Text that is not a calendar date changes nothing and leaves the hint where
/// it was, which is what the TS handler does when its own parse fails -- and
/// what the native date field behind their `type="date"` does with the same
/// text, before the handler ever runs.
fn editor_date_edited(ui: &MainWindow, state: &Shared, which: i32) {
    if ui.get_screen() != Screen::Editor {
        return;
    }
    let text = if which == 0 {
        ui.get_edit_pw_date().to_string()
    } else {
        ui.get_edit_email_date().to_string()
    };
    let Some(at) = from_date_input(&text) else {
        return;
    };
    {
        let mut guard = state.borrow_mut();
        if which == 0 {
            guard.editor_password_updated_at = at;
        } else {
            guard.editor_username_updated_at = at;
        }
    }
    // Pushing redraws the box from the stamp: "2026-6-5" becomes
    // "2026-06-05", the way the TS app's controlled input rounds its own text.
    push_organise(ui, state);
}

/* --------------------------------------------------------------------------
Security: the second factor

Every handler here follows the same shape as the TS form it ports -- stage,
prove, then write -- with one difference: the write lands in
`AppState::editor_security` instead of on the record, and only Save carries
the whole thing. Hashing stays in `colax-core`, so the web build and this one
produce byte-identical digests for the same input.
-------------------------------------------------------------------------- */

/// Paste a setup key or an `otpauth://` link and *stage* it.
///
/// Staged, not saved: see the note on `stagedSeed` in SecurityForm.tsx L47-58.
/// The refusal lands inline beside the field rather than in a toast, because
/// the mistake and its explanation then sit on the same line.
fn editor_sec_totp_attach(ui: &MainWindow, state: &Shared) {
    if ui.get_screen() != Screen::Editor {
        return;
    }
    let input = ui.get_edit_sec_totp_seed().to_string();
    let Some(seed) = extract_totp_secret(&input) else {
        ui.set_edit_sec_totp_note("That does not look like an authenticator key".into());
        return;
    };
    ui.set_edit_sec_totp_seed("".into());
    ui.set_edit_sec_totp_code("".into());
    ui.set_edit_sec_totp_note("".into());
    state.borrow_mut().editor_staged_seed = Some(seed);
    push_security(ui, state);
    notice(ui, "Scan the code, then confirm one to keep the key");
}

/// Mint a fresh key and stage it -- the same staging, from a seed the app
/// generated rather than one the user pasted.
fn editor_sec_totp_generate(ui: &MainWindow, state: &Shared) {
    if ui.get_screen() != Screen::Editor {
        return;
    }
    let seed = generate_totp_seed();
    ui.set_edit_sec_totp_code("".into());
    ui.set_edit_sec_totp_note("".into());
    state.borrow_mut().editor_staged_seed = Some(seed);
    push_security(ui, state);
    notice(ui, "Scan the code, then confirm one to keep the key");
}

/// Check the typed code against whichever key is live: the staged one while
/// confirming, otherwise the saved one -- `activeSeed` in TS.
///
/// The first successful check of a staged key is the line that writes it, so
/// until it passes, nothing has happened.
fn editor_sec_totp_check(ui: &MainWindow, state: &Shared) {
    if ui.get_screen() != Screen::Editor {
        return;
    }
    let code = ui.get_edit_sec_totp_code().to_string();
    let (staged, saved) = {
        let guard = state.borrow();
        (
            guard.editor_staged_seed.clone(),
            guard
                .editor_security
                .totp
                .as_ref()
                .map(|totp| totp.seed.clone()),
        )
    };
    let Some(seed) = staged.clone().or(saved) else {
        return;
    };
    // The screen cannot count characters (Slint has no `length` on a string),
    // so the button is enabled on any text and the count is checked here.
    if code.chars().filter(char::is_ascii_digit).count() != 6 {
        ui.set_edit_sec_totp_note("A code is six digits.".into());
        return;
    }
    if !verify_totp(&seed, &code) {
        ui.set_edit_sec_totp_note("That code did not match. Check the clock on this device.".into());
        return;
    }
    ui.set_edit_sec_totp_note("".into());
    if staged.is_some() {
        // First successful confirmation is what saves the key. Until this
        // block runs, nothing about the login has changed.
        {
            let mut guard = state.borrow_mut();
            guard.editor_security.totp = Some(TotpSecret { seed });
            guard.editor_staged_seed = None;
        }
        push_security(ui, state);
        notice(ui, "Authenticator key saved");
    } else {
        notice(ui, "Authenticator confirmed");
    }
}

/// Drop a staged key without touching the record -- which is the whole point
/// of staging: walking away leaves no trace.
fn editor_sec_totp_discard(ui: &MainWindow, state: &Shared) {
    if ui.get_screen() != Screen::Editor {
        return;
    }
    state.borrow_mut().editor_staged_seed = None;
    ui.set_edit_sec_totp_code("".into());
    ui.set_edit_sec_totp_note("".into());
    push_security(ui, state);
}

/// Remove the saved key from the draft.
fn editor_sec_totp_remove(ui: &MainWindow, state: &Shared) {
    if ui.get_screen() != Screen::Editor {
        return;
    }
    {
        let mut guard = state.borrow_mut();
        guard.editor_security.totp = None;
        guard.editor_staged_seed = None;
    }
    ui.set_edit_sec_totp_code("".into());
    ui.set_edit_sec_totp_note("".into());
    push_security(ui, state);
    notice(ui, "Authenticator removed");
}

/// Set the extra passcode. The three refusals are checked in the TS order so
/// the first message the user sees is the one that describes *their* mistake,
/// not the last rule the string happened to break.
fn editor_sec_passcode_save(ui: &MainWindow, state: &Shared) {
    if ui.get_screen() != Screen::Editor {
        return;
    }
    let new = ui.get_edit_sec_passcode_new().to_string();
    let confirm = ui.get_edit_sec_passcode_confirm().to_string();
    if passcode_too_weak(&new, false) {
        ui.set_edit_sec_passcode_error(
            "Use at least 8 characters, and mix letters, numbers or symbols. Not \"password\"."
                .into(),
        );
        return;
    }
    if new != confirm {
        ui.set_edit_sec_passcode_error("Those two do not match.".into());
        return;
    }
    // Refuse to make the gate the credential itself: a 10-character passcode
    // beside an authenticator would be the weakest factor guarding the login.
    let totp_set = state.borrow().editor_security.totp.is_some();
    if totp_set && new.chars().count() < 12 {
        ui.set_edit_sec_passcode_error(
            "With an authenticator already set, use at least 12 characters.".into(),
        );
        return;
    }
    let (hash, salt) = hash_passcode(&new);
    state.borrow_mut().editor_security.passcode = Some(SecurityPasscode { hash, salt });
    ui.set_edit_sec_passcode_new("".into());
    ui.set_edit_sec_passcode_confirm("".into());
    ui.set_edit_sec_passcode_error("".into());
    ui.set_edit_sec_passcode_input("".into());
    push_security(ui, state);
    notice(ui, "Passcode saved");
}

/// Prove the typed passcode against the stored hash.
fn editor_sec_passcode_check(ui: &MainWindow, state: &Shared) {
    if ui.get_screen() != Screen::Editor {
        return;
    }
    let input = ui.get_edit_sec_passcode_input().to_string();
    let stored = {
        let guard = state.borrow();
        guard
            .editor_security
            .passcode
            .as_ref()
            .map(|passcode| (passcode.hash.clone(), passcode.salt.clone()))
    };
    let Some((hash, salt)) = stored else {
        return;
    };
    if verify_passcode(&input, &hash, &salt) {
        ui.set_edit_sec_passcode_input("".into());
        ui.set_edit_sec_passcode_error("".into());
        notice(ui, "Passcode confirmed");
    } else {
        ui.set_edit_sec_passcode_error("That does not match the stored passcode.".into());
    }
}

/// Drop the extra passcode from the draft.
fn editor_sec_passcode_remove(ui: &MainWindow, state: &Shared) {
    if ui.get_screen() != Screen::Editor {
        return;
    }
    state.borrow_mut().editor_security.passcode = None;
    ui.set_edit_sec_passcode_input("".into());
    ui.set_edit_sec_passcode_error("".into());
    push_security(ui, state);
    notice(ui, "Passcode removed");
}

/// Add a recovery question. Only the prompt is shown to the screen; the hash
/// and salt are built here and stay here.
fn editor_sec_question_add(ui: &MainWindow, state: &Shared) {
    if ui.get_screen() != Screen::Editor {
        return;
    }
    let prompt = ui.get_edit_sec_new_prompt().to_string();
    let answer = ui.get_edit_sec_new_answer().to_string();
    if prompt.trim().is_empty() {
        return;
    }
    if answer_too_weak(&answer) {
        ui.set_edit_sec_answer_error(
            "Use something a stranger could not guess, not a single word or \"yes\".".into(),
        );
        return;
    }
    let (hash, salt) = hash_answer(&answer);
    // `sq_` plus eight characters, as `sq_${...slice(2, 10)}` gives in TS --
    // opaque either way, and this id only ever has to be unique in a record.
    let id = format!("sq_{}", &colax_core::new_item_id().replace('-', "")[..8]);
    state
        .borrow_mut()
        .editor_security
        .questions
        .push(SecurityQuestion {
            id,
            prompt: prompt.trim().to_string(),
            hash,
            salt,
        });
    ui.set_edit_sec_new_answer("".into());
    ui.set_edit_sec_answer_error("".into());
    push_security(ui, state);
    notice(ui, "Recovery question added");
}

/// Two-stage, exactly as `checkQuestion` in TS: the first press for an id
/// opens its answer box, the second verifies what is typed in it.
fn editor_sec_question_check(ui: &MainWindow, state: &Shared, id: &str) {
    if ui.get_screen() != Screen::Editor {
        return;
    }
    if ui.get_edit_sec_checking_id().to_string() != id {
        ui.set_edit_sec_checking_id(id.into());
        ui.set_edit_sec_check_input("".into());
        ui.set_edit_sec_answer_error("".into());
        return;
    }
    let answer = ui.get_edit_sec_check_input().to_string();
    let stored = {
        let guard = state.borrow();
        guard
            .editor_security
            .questions
            .iter()
            .find(|question| question.id == id)
            .map(|question| (question.hash.clone(), question.salt.clone()))
    };
    let Some((hash, salt)) = stored else {
        // Removed while its box was open: the row is gone, so the box is too.
        ui.set_edit_sec_checking_id("".into());
        ui.set_edit_sec_check_input("".into());
        return;
    };
    if verify_answer(&answer, &hash, &salt) {
        ui.set_edit_sec_checking_id("".into());
        ui.set_edit_sec_check_input("".into());
        ui.set_edit_sec_answer_error("".into());
        notice(ui, "Answer confirmed");
    } else {
        ui.set_edit_sec_answer_error("That does not match the stored answer.".into());
    }
}

/// Remove a question, and close its box if that is the one that was open.
fn editor_sec_question_remove(ui: &MainWindow, state: &Shared, id: &str) {
    if ui.get_screen() != Screen::Editor {
        return;
    }
    if ui.get_edit_sec_checking_id().to_string() == id {
        ui.set_edit_sec_checking_id("".into());
        ui.set_edit_sec_check_input("".into());
    }
    state
        .borrow_mut()
        .editor_security
        .questions
        .retain(|question| question.id != id);
    push_security(ui, state);
}

/// Step the prompt the add row offers. The list is fixed, so it wraps: a
/// stepper that stopped at either end would make the last prompt unreachable.
fn editor_sec_prompt_step(ui: &MainWindow, state: &Shared, delta: i32) {
    if ui.get_screen() != Screen::Editor {
        return;
    }
    let len = QUESTION_PROMPTS.len() as i32;
    let index = {
        let mut guard = state.borrow_mut();
        guard.editor_prompt_index =
            (guard.editor_prompt_index as i32 + delta).rem_euclid(len) as usize;
        guard.editor_prompt_index
    };
    ui.set_edit_sec_new_prompt(QUESTION_PROMPTS[index].into());
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
        // Neither can the vault's proof: sealed again means asked again on
        // the next unlock (TS rebuilds `vaultVerified` along with the locked
        // component tree).
        guard.vault_verified = false;
        // A gate is proof-seeking for what is being sealed. Closing it here
        // is what stops a lock raised from the tray -- no backdrop sits in
        // front of that menu -- from parking the panel over the lock screen.
        guard.gate = None;
        lock_screen_for(&guard.engine)
    };
    ui.set_undo_text("".into());
    ui.set_gate_open(false);
    ui.set_gate_error("".into());
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
                editor_security: LoginSecurity::default(),
                editor_staged_seed: None,
                editor_prompt_index: 0,
                editor_tags: Vec::new(),
                editor_password_updated_at: 0,
                editor_username_updated_at: 0,
                editor_panel_width: 0.0,
                // Wide enough for three grid columns before anything has
                // reported a width (the content area at the default window).
                vault_width: 800.0,
                gate: None,
                verified: HashSet::new(),
                vault_verified: false,
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
                Ok(screen) => {
                    ui.set_screen(screen);
                    // The cards only ever come from a refresh, and the way in
                    // to the vault normally goes through `goto`, which does
                    // one. A seeded debug profile lands here directly, so the
                    // first frame of the vault would otherwise be empty.
                    if screen == Screen::Vault {
                        refresh_items(&ui, &state);
                        // Device vaults -- and a debug profile that opens
                        // unlocked -- land here without passing `goto`, so the
                        // vault's own factor has to be checked here too.
                        maybe_gate_vault(&ui, &state);
                    }
                }
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
            ui.on_view_picked(move |view| {
                if let Some(ui) = weak.upgrade() {
                    view_picked(&ui, &st, &view);
                }
            });

            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_sort_picked(move |sort| {
                if let Some(ui) = weak.upgrade() {
                    sort_picked(&ui, &st, &sort);
                }
            });

            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_vault_relayout(move |width| {
                if let Some(ui) = weak.upgrade() {
                    vault_relayout(&ui, &st, width);
                }
            });

            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_rail_picked(move |position| {
                if let Some(ui) = weak.upgrade() {
                    rail_picked(&ui, &st, &position);
                }
            });

            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_labels_picked(move |labels| {
                if let Some(ui) = weak.upgrade() {
                    labels_picked(&ui, &st, &labels);
                }
            });

            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_gate_unlock(move |mode, value, question_id| {
                if let Some(ui) = weak.upgrade() {
                    gate_unlock(&ui, &st, &mode, &value, &question_id);
                }
            });

            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_gate_cancel(move || {
                if let Some(ui) = weak.upgrade() {
                    gate_cancel(&ui, &st);
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
            let st = state.clone();
            ui.on_editor_reveal(move || {
                if let Some(ui) = weak.upgrade() {
                    editor_reveal(&ui, &st);
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
            ui.on_editor_hue_picked(move |hue| {
                if let Some(ui) = weak.upgrade() {
                    editor_hue_picked(&ui, hue);
                }
            });

            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_editor_title_edited(move || {
                if let Some(ui) = weak.upgrade() {
                    editor_title_edited(&ui, &st);
                }
            });

            let weak = ui.as_weak();
            ui.on_editor_bg_blur_changed(move |value| {
                if let Some(ui) = weak.upgrade() {
                    editor_bg_blur_changed(&ui, value);
                }
            });

            let weak = ui.as_weak();
            ui.on_editor_mail_filter_picked(move |index| {
                if let Some(ui) = weak.upgrade() {
                    editor_mail_filter_picked(&ui, index);
                }
            });

            // ---- Organise -------------------------------------------------
            // Adding and toggling read the catalogue and the draft out of
            // `AppState`; relayout only reports a width in, but it answers by
            // pushing rows out, so it takes a handle on the state too.
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_editor_tag_add(move || {
                if let Some(ui) = weak.upgrade() {
                    editor_tag_add(&ui, &st);
                }
            });

            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_editor_tag_toggle(move |id| {
                if let Some(ui) = weak.upgrade() {
                    editor_tag_toggle(&ui, &st, &id);
                }
            });

            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_editor_tag_relayout(move |width| {
                if let Some(ui) = weak.upgrade() {
                    editor_tag_relayout(&ui, &st, width);
                }
            });

            let weak = ui.as_weak();
            ui.on_editor_tag_input_edited(move || {
                if let Some(ui) = weak.upgrade() {
                    editor_tag_input_edited(&ui);
                }
            });

            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_editor_date_edited(move |which| {
                if let Some(ui) = weak.upgrade() {
                    editor_date_edited(&ui, &st, which);
                }
            });

            // ---- Security -------------------------------------------------
            // Each of these reads or writes the draft in `AppState`, so each
            // takes a handle on it as well as on the window.
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_editor_sec_totp_attach(move || {
                if let Some(ui) = weak.upgrade() {
                    editor_sec_totp_attach(&ui, &st);
                }
            });

            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_editor_sec_totp_generate(move || {
                if let Some(ui) = weak.upgrade() {
                    editor_sec_totp_generate(&ui, &st);
                }
            });

            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_editor_sec_totp_check(move || {
                if let Some(ui) = weak.upgrade() {
                    editor_sec_totp_check(&ui, &st);
                }
            });

            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_editor_sec_totp_discard(move || {
                if let Some(ui) = weak.upgrade() {
                    editor_sec_totp_discard(&ui, &st);
                }
            });

            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_editor_sec_totp_remove(move || {
                if let Some(ui) = weak.upgrade() {
                    editor_sec_totp_remove(&ui, &st);
                }
            });

            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_editor_sec_passcode_save(move || {
                if let Some(ui) = weak.upgrade() {
                    editor_sec_passcode_save(&ui, &st);
                }
            });

            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_editor_sec_passcode_check(move || {
                if let Some(ui) = weak.upgrade() {
                    editor_sec_passcode_check(&ui, &st);
                }
            });

            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_editor_sec_passcode_remove(move || {
                if let Some(ui) = weak.upgrade() {
                    editor_sec_passcode_remove(&ui, &st);
                }
            });

            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_editor_sec_question_add(move || {
                if let Some(ui) = weak.upgrade() {
                    editor_sec_question_add(&ui, &st);
                }
            });

            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_editor_sec_question_check(move |id| {
                if let Some(ui) = weak.upgrade() {
                    editor_sec_question_check(&ui, &st, &id);
                }
            });

            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_editor_sec_question_remove(move |id| {
                if let Some(ui) = weak.upgrade() {
                    editor_sec_question_remove(&ui, &st, &id);
                }
            });

            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_editor_sec_prompt_step(move |delta| {
                if let Some(ui) = weak.upgrade() {
                    editor_sec_prompt_step(&ui, &st, delta);
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

    // ---- Orbit's drift ----------------------------------------------------
    // One timer for the whole app, started before the window shows. While the
    // ring is not on screen the callback changes no property, and a property
    // that does not change does not paint a frame, so standing by costs a
    // comparison every 40ms -- and only while the ring *is* on screen does it
    // cost anything more. `motion == 0` stops the angle where it is, which is
    // what "reduce animation" means for a carousel that would otherwise never
    // hold still.
    {
        let weak = ui.as_weak();
        let timer = slint::Timer::default();
        timer.start(
            slint::TimerMode::Repeated,
            std::time::Duration::from_millis(40),
            move || {
                if let Some(ui) = weak.upgrade() {
                    let motion = ui.get_motion();
                    if ui.get_vault_view() == "carousel" && motion > 0.0 {
                        let step = 3.0 * motion;
                        let angle = ui.get_orbit_angle();
                        ui.set_orbit_angle(if angle >= 360.0 {
                            angle - 360.0 + step
                        } else {
                            angle + step
                        });
                    }
                }
            },
        );
        // Dropping the handle would cancel the drift before it starts.
        std::mem::forget(timer);
    }

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
