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

mod activity;
mod appearance;
mod alarms;
mod art;
mod channels_ops;
mod dashboard;
mod dock;
mod history;
mod items;
mod menus;
mod optimize_ops;
mod platform;
mod reorder;
mod settings_ops;
mod shortcuts;
mod tuner;

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
    security_level, to_date_input, verify_answer, verify_passcode, BackupFile, ChannelKind,
    GeneratorOptions, LoginSecurity, VaultEngine, VaultError, VaultItem, VaultProtection,
    VaultStorage,
};
use serde::{Deserialize, Serialize};
use slint::{ComponentHandle, Model, ModelRc, VecModel, Weak};

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

/// Whether the app's own data folder took a write just now. The TS build
/// asks the browser the same question (`persistent` in LockScreen.tsx
/// L297-301) and warns that the vault will not outlive the session when
/// the answer is no; this app's equivalent of blocked storage is a data
/// folder that refuses a write. Probed once at boot -- storage does not
/// change its mind while the process runs.
fn storage_is_persistent() -> bool {
    let dir = app_dir();
    if fs::create_dir_all(&dir).is_err() {
        return false;
    }
    let probe = dir.join(".write-probe");
    match fs::write(&probe, b"") {
        Ok(()) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
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
pub(crate) fn find_main_window() -> isize {
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
    /// The file the Backup tab's restore sheet is holding: its text and its
    /// name, stashed at pick time the way `pickBackupFile` hands the modal a
    /// `{ name, text }` pair, and cleared on cancel or a finished restore.
    settings_restore: Option<(String, String)>,
    /// The row the strip at the bottom of the list offers to put back. Kept
    /// whole rather than as an id, because `delete_item` has already dropped
    /// the record by the time Undo is pressed.
    last_deleted: Option<VaultItem>,
    /// Undo/redo (Task 8.2): whole-document snapshots -- the item list and the
    /// preferences as they stood before a write -- the TS's `HistoryEntry`
    /// (`{ items, prefs }`, hooks.ts L231). One is pushed by `record_history`
    /// for every recorded mutation, so Ctrl+Z reaches exactly the changes the
    /// History channel logs; undo/redo themselves do not push (they swap
    /// between the two stacks), matching `restore`'s separation from `mutate`.
    /// Capped at 50 like the TS stacks, and emptied on lock -- a snapshot
    /// holds plaintext, so it must not outlive the key.
    undo_stack: Vec<UndoSnapshot>,
    redo_stack: Vec<UndoSnapshot>,
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
    /// The vault's own second factor (Settings › Security) staged exactly as
    /// the editor's is: a key generated or pasted but not yet confirmed by a
    /// code. Nothing about `prefs.vaultSecurity` changes until a code proves
    /// a phone holds the key; closing the modal drops it.
    vault_staged_seed: Option<String>,
    /// Which of `QUESTION_PROMPTS` the vault form's add row is showing — the
    /// editor's own index again, kept apart so one window's stepper never
    /// moves the other's.
    vault_prompt_index: usize,
    /// The Organise half of the draft: which of the catalogue's tags this
    /// login carries. Kept here rather than in Slint because the catalogue it
    /// is chosen from lives in preferences and only Rust sees both — and
    /// because Save must hand back exactly the ids, not a drawing of them.
    editor_tags: Vec<String>,
    /// The New-alarm draft's two halves that are not editable text: the days
    /// picked so far (0 = Sunday, `Alarm.days`) and the imported sound. The
    /// label and the time stay in the panel's own fields, so these two are
    /// kept here for the same reason the editor's tags are — both arrive in
    /// the panel as data, and `Add alarm` reads them straight back.
    alarm_days: Vec<u8>,
    alarm_sound: Option<colax_core::AlarmSound>,
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
    /// What `push_background` last painted: the source, blur, opacity and dim
    /// it handed Slint. Decoding and blurring a photo costs real
    /// milliseconds, and the layer is re-resolved on every pref write and
    /// every channel switch, so a push that would paint the same picture is
    /// skipped.
    background_pushed: Option<(String, f64, f64, f64)>,
    /// The channel editor's draft (Task 5.10), if it is open. Kept whole here
    /// rather than in Slint for the same reason the login editor's tags are:
    /// `Add channel` must hand back exactly a `Channel`, and the tag ids it
    /// narrows by have to be checked against the catalogue only Rust sees.
    /// `channel_new` is the TS's `channel === null` — the Add flow, whose
    /// footer is Cancel/Add channel rather than Delete/Done.
    channel_draft: Option<colax_core::Channel>,
    channel_new: bool,
    /// The id of the stored channel being edited, so an autosave knows which
    /// row to replace without trusting the draft's own id.
    channel_editing: Option<String>,
    /// Which tag's name is being retyped and which tag's colour range is
    /// open. One at a time each, exactly as the panel's two `useState` ids
    /// are, so a row can be rebuilt from the model without losing them.
    channel_tag_editing: Option<String>,
    channel_tag_hue: Option<String>,
    /// The width the editor's tag cloud last reported, so its rows can be
    /// packed for it on every push instead of only while it is on screen.
    channel_ed_width: f64,
    /// A dock slot waiting for its key (Task 8.3): the bar id and slot index
    /// the recorder was armed for, cleared by the next keypress. `KeyRecorder`
    /// holds this in React state; here it must outlive the menu that armed it,
    /// because the key arrives after that menu has closed.
    dock_key_target: Option<(String, usize)>,
    /// A card drag in flight (Task 8.5): the pressed card's rectangle and the
    /// view's packing, so a pointer position can be turned into a slot. Kept
    /// here because the pointer outlives the row that started it -- the row
    /// keeps receiving moves, but only Rust knows the whole view.
    reorder_drag: Option<reorder::Drag>,
    /// The slot the drag is aiming at: the target card index and whether the
    /// drop lands after it. Committed by `reorder::finish`.
    reorder_drop: Option<(usize, bool)>,
}

/// One undoable state: the whole item list and the raw preferences document,
/// exactly the pair `replaceItems` + `savePreferences` put back (hooks.ts
/// L217-226). Preferences are held raw rather than through
/// `VaultPreferences` so the round-trip cannot drop the untyped fields the
/// rail tree lives in (`prefs.extra["sidebar"]`).
struct UndoSnapshot {
    items: Vec<VaultItem>,
    prefs: serde_json::Value,
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

/// The two lines the card area shows when it has nothing to draw.
///
/// Port of `ViewEmptyState`'s `title`/`text` (`views.tsx:1607-1621`), in the
/// TS's own order: a query that matched nothing outranks the channel's own
/// empty state, so "nothing here yet" can never be mistaken for "your search
/// found nothing". The three merged sections — the tabs of All logins — get
/// their own copy (`slot` is then the tab's kind); a user's own channel of
/// that kind opens as a real row and gets the same copy by channel id,
/// exactly as the web does through `screen`.
fn cards_empty_state(query: &str, slot: &str) -> (String, String) {
    if !query.is_empty() {
        return (
            "No matches".to_string(),
            format!("Nothing matches \"{query}\" here. Try a different search."),
        );
    }
    match slot {
        "favorites" => (
            "No favorites yet".to_string(),
            "Star a login to pin it to the top of every view.".to_string(),
        ),
        "attention" => (
            "Nothing flagged".to_string(),
            "Logins you flag for follow-up collect here.".to_string(),
        ),
        "weak" => (
            "Nothing needs attention".to_string(),
            "No reused or long-untouched passwords. Nice.".to_string(),
        ),
        _ => (
            "Your vault is empty".to_string(),
            "Add your first login and it will be encrypted on this device straight away.".to_string(),
        ),
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
    let all_tab = ui.get_all_tab().to_string();
    let guard = state.borrow();
    let prefs = items::prefs_from(guard.engine.preferences());
    let channel = items::channel_by_id(&prefs, &channel_id);
    // The merged sections are tabs of the main channel, not rows: the list
    // reads the All-logins channel with the tab's kind swapped in (App.tsx
    // `listChannel`), while the channel itself — tags, look, name — stays
    // what it is. Any other channel, or the strip's "All" tab, lists as-is.
    let tab_kind = match all_tab.as_str() {
        "favorites" => ChannelKind::Favorites,
        "attention" => ChannelKind::Attention,
        "weak" => ChannelKind::Weak,
        _ => ChannelKind::All,
    };
    let on_a_tab = channel.id == "all" && tab_kind != ChannelKind::All;
    let mut list_channel = channel.clone();
    if on_a_tab {
        list_channel.kind = tab_kind.clone();
    }
    // The dashboard replaces the whole pane, and it reads every item — so
    // it is computed here, while the engine is already open, and applied
    // after the guard drops like everything else on this path.
    let is_dashboard = channel.kind == ChannelKind::Dashboard;
    // The History channel takes the pane the dashboard's way (Task 7.2),
    // and its rows need the log *and* the logins that still exist — so the
    // panel is computed here too, while the engine is already open, and
    // applied after the guard drops.
    let is_history = channel.kind == ChannelKind::History;
    let (cards, sidebar, total, dash, history, tabs) = match guard.engine.items() {
        Some(items) => {
            // The strip's tabs with their counts (App.tsx `tabCounts`): each
            // tab is the All-logins channel with the section swapped in,
            // counted through the filter the list itself uses, so a tab can
            // never advertise a number the list behind it would not show.
            let tabs: Vec<crate::ListTab> = if channel.id == "all" {
                colax_core::ALL_LOGIN_TABS
                    .iter()
                    .map(|(kind, label)| {
                        let mut view = channel.clone();
                        view.kind = kind.clone();
                        crate::ListTab {
                            kind: kind.as_str().into(),
                            label: (*label).into(),
                            count: colax_core::apply_channel(
                                &view,
                                items,
                                prefs.password_age_days as f64,
                            )
                            .len() as i32,
                        }
                    })
                    .collect()
            } else {
                Vec::new()
            };
            let cards = items::build_cards(items, &list_channel, &prefs, &query);
            let sidebar = items::build_sidebar(items, &channel_id, &prefs);
            let dash = is_dashboard
                .then(|| dashboard::build(items, &prefs, &prefs.usage, colax_core::util::now_ms()));
            let history = (is_history || is_dashboard).then(|| {
                history::build(
                    &prefs.history,
                    items,
                    ui.get_history_query().as_str(),
                    ui.get_history_filter() as usize,
                    colax_core::util::now_ms(),
                )
            });
            (cards, sidebar, items.len(), dash, history, tabs)
        }
        None => (
            Vec::new(),
            items::build_sidebar(&[], &channel_id, &prefs),
            0,
            None,
            None,
            Vec::new(),
        ),
    };
    drop(guard);

    let shown = cards.len();
    let label = if query.is_empty() && shown == total {
        format!("{total} {}", if total == 1 { "login" } else { "logins" })
    } else {
        format!("{shown} of {total} {}", if total == 1 { "login" } else { "logins" })
    };

    // The empty state, from the TS's `ViewEmptyState` (`views.tsx`
    // L1607-1621). The order matters and is the TS's: a search that found
    // nothing is a different problem from a view with nothing in it, and the
    // first line has to say which one the user is looking at. The native
    // search is vault-wide, so the TS's "Search entire vault" button has no
    // scope to widen -- that is why the hint is advice, not an offer. The
    // key is the tab kind on a merged section, the channel's id otherwise.
    let empty_slot = if on_a_tab {
        tab_kind.as_str().to_string()
    } else {
        channel.id.clone()
    };
    let (empty_title, empty_hint) = cards_empty_state(query.trim(), &empty_slot);

    ui.set_cards(ModelRc::new(VecModel::from(cards)));
    ui.set_sidebar(ModelRc::new(VecModel::from(sidebar)));
    ui.set_all_tabs(ModelRc::new(VecModel::from(tabs)));
    // The strip lives on All logins alone (App.tsx `showAllTabs`).
    ui.set_show_all_tabs(channel.id == "all");
    ui.set_count_label(label.into());
    ui.set_channel_name(channel.name.as_str().into());
    // The dashboard takes the pane; everything the list draws is simply
    // unused behind it, which is cheaper than a second screen branch.
    ui.set_show_dashboard(is_dashboard);
    ui.set_show_history(is_history);
    // The log badge rides the dashboard's History tab, in events (`ViewBadge`)
    // — computed while the engine was open, like everything else here.
    let dash_history_count = if is_dashboard {
        items::prefs_from(state.borrow().engine.preferences()).history.len()
    } else {
        0
    };
    ui.set_dash_history_count(dash_history_count as i32);
    if let Some(dash) = dash {
        dashboard::fill(ui, &dash);
    }
    if let Some(history) = history {
        ui.set_history_data(history);
    }
    ui.set_show_urls(prefs.show_urls);
    // The three shortcuts the Layout tab switches off (Task 5.2b). They are
    // read on every refresh, so a switch thrown in Settings lands on the
    // shell in the same tick the preference is written.
    ui.set_show_new_login(prefs.show_new_login_button);
    ui.set_show_lock(prefs.show_lock_button);
    ui.set_show_settings_button(prefs.show_settings_button);
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
    // Task 8.4: the grid's own width preference is the cell's floor, so the
    // tuner moves the column count with it (`cardSize.grid`, scaled).
    let grid = prefs
        .card_size
        .get("grid")
        .copied()
        .unwrap_or_else(|| colax_core::default_card_size("grid"));
    ui.set_grid_cols(grid_cols_for(vault_width, grid.width * grid.scale));
    ui.set_sort_options(ModelRc::new(VecModel::from(items::sort_options())));
    // The app's own background layer rides the same derivation: it is the
    // preference's photo, or the active channel's, and both are read from the
    // same guard that produced the rails above.
    push_background(ui, state);
    // The active view's card geometry (Task 8.4) rides the same refresh: a
    // view switch, a size write and a Reset all land here.
    tuner::push(ui, state);
    // The quick-launch bars and the Layout tab's dock manager (Task 8.3) ride
    // it too: a key write, a drag commit and a channel rename all land here.
    dock::push(ui, state);
}

/// The picture behind every screen, and its wash.
///
/// `body::before` plus `.ambient:after` in the web: the photo at its own
/// opacity, then a `--bg`-coloured veil at `--bg-dim`, which is what keeps
/// the shell readable over an arbitrary picture. Which photo is
/// `background_of`'s decision — the active channel's own wins, dials
/// included — and the *painting* is Slint's, so what crosses the fence is an
/// already-decoded `image` (this app fetches nothing, so an http URL paints
/// nothing at all).
///
/// Cheap to call: the last painted tuple is kept in `AppState`, and an
/// unchanged background is skipped rather than decoded and blurred again.
fn push_background(ui: &MainWindow, state: &Shared) {
    let resolved = {
        let guard = state.borrow();
        let prefs = items::prefs_from(guard.engine.preferences());
        let channel = items::channel_by_id(&prefs, &ui.get_active_channel());
        crate::art::background_of(&prefs, Some(&channel))
    };
    if state.borrow().background_pushed.as_ref() == resolved.as_ref() {
        return;
    }
    match &resolved {
        Some((src, opacity, blur, dim)) => {
            match crate::art::slint_background(src, *blur) {
                Some(image) => {
                    ui.set_app_bg(image);
                    ui.set_app_bg_opacity(*opacity as f32);
                    ui.set_app_bg_dim(*dim as f32);
                }
                // A URL, or a picture this build cannot decode: nothing is
                // painted, and no veil either. The web sets `--bg-dim` whenever
                // a photo is *named*, so a URL that fails to load still darkens
                // the app for no reason; there is nothing to read over here, so
                // the wash stays off until pixels arrive.
                None => {
                    ui.set_app_bg(slint::Image::default());
                    ui.set_app_bg_opacity(0.0);
                    ui.set_app_bg_dim(0.0);
                }
            }
        }
        None => {
            ui.set_app_bg(slint::Image::default());
            ui.set_app_bg_opacity(0.0);
            ui.set_app_bg_dim(0.0);
        }
    }
    state.borrow_mut().background_pushed = resolved;
}

/// How many grid cells fit across a given content width. Below ~220px a cell
/// stops reading as a card, which is the floor the tag cloud packs its pills
/// against too -- one number for "smaller than this is not a thing any more".
fn grid_cols_for(width: f64, target: f64) -> i32 {
    ((width / target.max(120.0)) as i32).clamp(2, 8)
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
/// layout pass, not a choice, and is ignored. `target` is the cell's floor --
/// the grid view's own card width (Task 8.4), so the tuner reflows the grid.
fn vault_relayout(ui: &MainWindow, state: &Shared, width: f32) {
    if !(240.0..=20000.0).contains(&width) {
        return;
    }
    let grid = items::prefs_from(state.borrow().engine.preferences())
        .card_size
        .get("grid")
        .copied()
        .unwrap_or_else(|| colax_core::default_card_size("grid"));
    state.borrow_mut().vault_width = width as f64;
    ui.set_grid_cols(grid_cols_for(width as f64, grid.width * grid.scale));
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
/// The one path between screens, and therefore the one place the transient
/// layer is reset: the messages, the typed-in text that cannot still be
/// needed, the meter that was describing it, and the search box when the
/// list is left behind.
///
/// This used to be a `changed screen` handler in Slint. A `changed` callback
/// fires after the frame in which the property changed, so anything set on
/// the far side of the switch was wiped a frame later, before it was ever
/// drawn -- "Vault created." and the suggested password each survived one
/// synchronous dump and were gone by the next, half a second later. Doing it
/// here runs it in the same tick as the switch and *before* the caller sets
/// its own values, so a notice or a filled field lands after the reset and
/// stays.
fn goto(ui: &MainWindow, state: &Shared, screen: Screen) {
    ui.set_error_text("".into());
    ui.set_notice_text("".into());
    if screen != Screen::Vault {
        // The create flow stashes its password in Rust before leaving its
        // stage, so the fields cannot be needed on the far side.
        ui.set_password_value("".into());
        ui.set_confirm_value("".into());
        // ...and the meter that was describing them: a fresh password screen
        // starts with an empty field, so it must not open with the last
        // attempt's verdict still lit.
        ui.set_lock_strength_score(-1);
        ui.set_lock_strength_label("".into());
        ui.set_lock_strength_bits("".into());
        ui.set_lock_strength_crack("".into());
    }
    if screen == Screen::Vault {
        ui.set_search_text("".into());
        // The History panel keeps its query and segment on the window, so
        // they reset on the way back from anywhere else — the TS panel's
        // would have unmounted and lost them to useState (Task 7.2).
        ui.set_history_query("".into());
        ui.set_history_filter(0);
    }
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
/// lifetime, so there is nothing to keep alive here. Visible to the whole
/// crate because the Settings window's Alarms tab raises the same toasts the
/// TS does ("Alarm added", `Sound "…" imported`).
pub(crate) fn notice(ui: &MainWindow, text: &str) {
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

    let (created, before) = {
        let mut guard = state.borrow_mut();
        // What the log saw before the seed: a fresh vault's logins were
        // really added, and the History channel reports them exactly as it
        // would a pasted import.
        let before: Vec<VaultItem> = guard
            .engine
            .items()
            .map(|items| items.to_vec())
            .unwrap_or_default();
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
        (result, before)
    };

    match created {
        Ok(()) => {
            record_history(ui, state, &before);
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
/// saved login), `editor-<section>` for any of its tabs, `settings` (the
/// Settings walk, which closes the modal when it is done), `settings-open`
/// (the appearance panel), `settings-layout`, `settings-hidden` or
/// `settings-desktop` (each left open for a screenshot), `settings-generator`
/// (same, with a stored length and one switch off), `settings-alarms` (same,
/// two stored alarms and one switched off), `settings-security` (same, with
/// the vault's own factor stored: key, passcode and two questions),
/// `settings-security-clip` (the clipboard group with a pick moved),
/// `settings-data` or `settings-backup` (the two seams Task 5.8 added, left
/// open for a screenshot), `settings-data-protect` / `settings-data-reset` /
/// `settings-data-restore` (the same panel with one of its three sheets up),
/// `settings-background` (the Background panel, left open) or
/// `background-photo` (the vault screen wearing a stored photo, which is the
/// layer rather than the panel), `editor-generator` (the editor's own
/// generator with one chip flipped), or
/// `chrome` (the three shortcuts the Layout tab takes off the shell, all left
/// off).
#[cfg(debug_assertions)]
fn dev_screen(ui: &MainWindow, state: &Shared, tray: &Weak<AppTray>) {
    // `COLAX_DEV_VIEW` takes its own branch before the screen picker below:
    // the four presentations live on the vault screen itself, so the run
    // stays exactly where the app opened it and drives the switcher from
    // there. `COLAX_DEV_RAIL` is the same deal for the rail's dials,
    // `COLAX_DEV_GATE` walks the SecurityGate across every factor it knows,
    // `COLAX_DEV_LOCK` walks the lock card's meter, floor, suggestion
    // and theme dial, and `COLAX_DEV_AUTOLOCK` watches the idle lock seal
    // the vault on its own and a press hold it off.
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

    if std::env::var_os("COLAX_DEV_LOCK").is_some() {
        let weak = ui.as_weak();
        let st = state.clone();
        let timer = slint::Timer::default();
        timer.start(
            slint::TimerMode::SingleShot,
            std::time::Duration::from_millis(400),
            move || {
                if let Some(ui) = weak.upgrade() {
                    dev_lock(&ui, &st);
                }
            },
        );
        std::mem::forget(timer);
        return;
    }

    // ...and `COLAX_DEV_AUTOLOCK` times the idle lock itself, with its
    // seconds standing in for the preference's minutes.
    if std::env::var_os("COLAX_DEV_AUTOLOCK").is_some() {
        let weak = ui.as_weak();
        let st = state.clone();
        let timer = slint::Timer::default();
        timer.start(
            slint::TimerMode::SingleShot,
            std::time::Duration::from_millis(400),
            move || {
                if let Some(ui) = weak.upgrade() {
                    dev_autolock(&ui, &st);
                }
            },
        );
        std::mem::forget(timer);
        return;
    }

    // ...and `COLAX_DEV_CLIP` copies once and then watches the clipboard
    // be wiped -- by its own deadline with the flag's seconds, or by the
    // lock when the flag reads `lock`.
    if std::env::var_os("COLAX_DEV_CLIP").is_some() {
        let weak = ui.as_weak();
        let st = state.clone();
        let timer = slint::Timer::default();
        timer.start(
            slint::TimerMode::SingleShot,
            std::time::Duration::from_millis(400),
            move || {
                if let Some(ui) = weak.upgrade() {
                    dev_clip(&ui, &st);
                }
            },
        );
        std::mem::forget(timer);
        return;
    }

    // ...and `COLAX_DEV_KEYS` drives the global shortcuts (Task 8.2) through
    // the dispatcher itself: a dev walk cannot press a key, so it hands
    // `shortcuts::key` the text and modifiers a real press would carry and
    // writes back what the window then holds.
    if std::env::var_os("COLAX_DEV_KEYS").is_some() {
        let weak = ui.as_weak();
        let st = state.clone();
        let timer = slint::Timer::default();
        timer.start(
            slint::TimerMode::SingleShot,
            std::time::Duration::from_millis(400),
            move || {
                if let Some(ui) = weak.upgrade() {
                    dev_keys(&ui, &st);
                }
            },
        );
        std::mem::forget(timer);
        return;
    }

    // ...and `COLAX_DEV_DOCKS` walks the quick-launch docks (Task 8.3): it
    // presses a slot's key, drags a bar onto an edge, opens the bar and slot
    // menus, records a new key, adds a bar and hides one, writing back what
    // the window and the preferences then hold.
    if std::env::var_os("COLAX_DEV_DOCKS").is_some() {
        let weak = ui.as_weak();
        let st = state.clone();
        let timer = slint::Timer::default();
        timer.start(
            slint::TimerMode::SingleShot,
            std::time::Duration::from_millis(400),
            move || {
                if let Some(ui) = weak.upgrade() {
                    dev_docks(&ui, &st);
                }
            },
        );
        std::mem::forget(timer);
        return;
    }

    // ...and `COLAX_DEV_REORDER` walks the drag-reorder engine (Task 8.5): it
    // reports the pointer positions a row would, and reads back the slot, the
    // insertion bar and the order the drop wrote.
    if std::env::var_os("COLAX_DEV_REORDER").is_some() {
        let weak = ui.as_weak();
        let st = state.clone();
        let timer = slint::Timer::default();
        timer.start(
            slint::TimerMode::SingleShot,
            std::time::Duration::from_millis(400),
            move || {
                if let Some(ui) = weak.upgrade() {
                    dev_reorder(&ui, &st);
                }
            },
        );
        std::mem::forget(timer);
        return;
    }

    // ...and `COLAX_DEV_TUNER` walks the appearance tuner (Task 8.4): it opens
    // it from the menu, drives each dial through `tuner::size_changed` (a dev
    // walk cannot drag a slider), and reads back the stored geometry and the
    // window scalars it produced.
    if std::env::var_os("COLAX_DEV_TUNER").is_some() {
        let weak = ui.as_weak();
        let st = state.clone();
        let timer = slint::Timer::default();
        timer.start(
            slint::TimerMode::SingleShot,
            std::time::Duration::from_millis(400),
            move || {
                if let Some(ui) = weak.upgrade() {
                    dev_tuner(&ui, &st);
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
    if want == "dashboard" {
        dev_dashboard(ui, state);
        return;
    }
    if want == "history" {
        dev_history(ui, state);
        return;
    }
    if want == "alarm" {
        dev_alarm(ui, state);
        return;
    }
    if want == "settings" {
        settings_ops::dev(ui, state, tray);
        return;
    }
    // The panels, opened and left open: the walk above closes the modal on
    // its last step, so a screenshot needs its own target. `settings-hidden`
    // switches a couple of buttons off first, so the panel has rows to show.
    if want == "settings-open" {
        settings_ops::open(ui, state, "");
        return;
    }
    if want == "settings-layout" || want == "settings-hidden" {
        if want == "settings-hidden" {
            settings_ops::pref_bool(ui, state, "showNewLoginButton", false);
            settings_ops::pref_bool(ui, state, "showSidebar", false);
        }
        settings_ops::open(
            ui,
            state,
            if want == "settings-layout" { "layout" } else { "hidden" },
        );
        return;
    }
    // The Desktop tab. Its third row reads `closeToTray && trayEnabled`
    // (the TS's own expression), so the tray goes off first: a screenshot of
    // the panel in its default state could not tell the mask from the flag.
    if want == "settings-desktop" {
        settings_ops::pref_bool(ui, state, "trayEnabled", false);
        settings_ops::open(ui, state, "desktop");
        return;
    }
    // The Generator tab. A length and one switch are moved first so the
    // screenshot shows a stored generator rather than the shipped defaults --
    // and so the panel is known to be reading what the document holds.
    if want == "settings-generator" {
        settings_ops::pref_float(ui, state, "gen-length", 32.0);
        settings_ops::pref_bool(ui, state, "gen-symbols", false);
        settings_ops::open(ui, state, "generator");
        return;
    }
    // The Alarms tab: one alarm with two picked days, one left on the reset
    // draft (no label, 08:00, every day) and switched off -- so the shot has
    // all three cell readings and both dot states, with the New alarm card
    // under them holding a clean draft.
    if want == "settings-alarms" {
        ui.set_settings_alarm_label("Call mum".into());
        ui.set_settings_alarm_time("18:30".into());
        settings_ops::alarm_day_toggled(ui, state, 1); // Mon
        settings_ops::alarm_day_toggled(ui, state, 3); // Wed
        settings_ops::alarms_add(ui, state);
        settings_ops::alarms_add(ui, state);
        let first = settings_ops::stored_alarm_id(state, 0);
        settings_ops::alarm_toggle(ui, state, &first);
        settings_ops::open(ui, state, "alarms");
        return;
    }
    // The Security tab, two shots. The first seeds the vault's own factor
    // through the panel's own ops — a generated key confirmed with the code
    // the app itself derives, a passcode, two recovery questions — so the
    // form shows filled tiles and the QR in place under the locking group.
    if want == "settings-security" {
        settings_ops::open(ui, state, "security");
        settings_ops::vsec_totp_generate(ui, state);
        let code = state
            .borrow()
            .vault_staged_seed
            .clone()
            .and_then(|seed| colax_core::totp::current_totp_code(&seed).ok())
            .unwrap_or_default();
        ui.set_settings_vsec_totp_code(code.as_str().into());
        settings_ops::vsec_totp_check(ui, state);
        ui.set_settings_vsec_passcode_new("vault-gate-2026".into());
        ui.set_settings_vsec_passcode_confirm("vault-gate-2026".into());
        settings_ops::vsec_passcode_save(ui, state);
        ui.set_settings_vsec_new_answer("ten past four".into());
        settings_ops::vsec_question_add(ui, state);
        settings_ops::vsec_prompt_step(ui, state, 1);
        ui.set_settings_vsec_new_answer("the blue door".into());
        settings_ops::vsec_question_add(ui, state);
        return;
    }
    // The clipboard group: a moved pick and one switch on, so the shot has
    // both a set and an unset row.
    if want == "settings-security-clip" {
        settings_ops::pref_string(ui, state, "clear-clipboard", "60");
        settings_ops::pref_bool(ui, state, "clipboardCapture", true);
        settings_ops::open(ui, state, "security");
        ui.set_settings_sec_group(1);
        return;
    }
    // The two panels Task 5.8 added, left open for a screenshot. The walk
    // covers both flows end to end; these targets only hold the tab still.
    if want == "settings-data" {
        settings_ops::open(ui, state, "data");
        return;
    }
    if want == "settings-backup" {
        settings_ops::open(ui, state, "backup");
        return;
    }
    // Optimize (Task 5.11): the General group as a shot — one profile saved
    // through the panel's own save box, so the rows the walkthrough pinned
    // are on screen too — and the Look group drawn mid-trade, so the two
    // compound rows show checked states.
    if want == "settings-optimize" {
        settings_ops::open(ui, state, "optimize");
        ui.set_settings_opt_name("Evening focus".into());
        optimize_ops::save_profile(ui, state);
        return;
    }
    if want == "settings-optimize-look" {
        settings_ops::open(ui, state, "optimize");
        ui.set_settings_opt_ambient_off(true);
        optimize_ops::ambient_toggled(ui, state);
        ui.set_settings_opt_motion_off(true);
        optimize_ops::motion_toggled(ui, state);
        ui.set_settings_opt_group(1);
        return;
    }
    if want == "settings-about" {
        settings_ops::open(ui, state, "about");
        return;
    }
    // Background (Task 5.9): the panel itself, or the whole app wearing the
    // stored photo, which is what the panel's picture actually does.
    if want == "settings-background" {
        settings_ops::open(ui, state, "background");
        return;
    }
    if want == "background-photo" {
        settings_ops::background_dev_photo(ui, state);
        return;
    }
    // Channels (Task 5.10): the panel itself, the shared editor opened on a
    // stored channel, and the editor's Add flow. `favorites` is the one the
    // editor opens on — shipped, so its name and icon come from the document,
    // and not `locked`, so the footer has its Delete.
    if want == "settings-channels" {
        settings_ops::open(ui, state, "channels");
        return;
    }
    if want == "channel-editor" {
        settings_ops::open(ui, state, "channels");
        // The editor walk needs a stored channel: the shipped `favorites`
        // row is retired (tab strip), so one is created like a user would.
        crate::channels_ops::open(ui, state, "new");
        ui.set_channel_ed_name("Stars".into());
        crate::channels_ops::name_edited(ui, state);
        crate::channels_ops::save(ui, state);
        let id = items::prefs_from(state.borrow().engine.preferences())
            .channels
            .iter()
            .find(|channel| channel.name == "Stars")
            .map(|channel| channel.id.clone())
            .expect("the walk's channel is stored");
        channels_ops::open(ui, state, &id);
        return;
    }
    if want == "channel-new" {
        settings_ops::open(ui, state, "channels");
        channels_ops::open(ui, state, "new");
        return;
    }
    // The editor's lower half — the Image section with its three dials, then
    // Messages — which the window is too short to show at once. The draft is
    // given a stored photo through the field's own rule, and the body is
    // scrolled so a screenshot can see what the walk can only dump.
    if want == "channel-editor-image" {
        settings_ops::open(ui, state, "channels");
        let id = {
            crate::channels_ops::open(ui, state, "new");
            ui.set_channel_ed_name("Stars".into());
            crate::channels_ops::name_edited(ui, state);
            crate::channels_ops::save(ui, state);
            items::prefs_from(state.borrow().engine.preferences())
                .channels
                .iter()
                .find(|channel| channel.name == "Stars")
                .map(|channel| channel.id.clone())
                .expect("the walk's channel is stored")
        };
        channels_ops::open(ui, state, &id);
        ui.set_channel_ed_image_url("https://example.com/backdrop.jpg".into());
        channels_ops::image_edited(ui, state);
        channels_ops::image_float(ui, state, "opacity", 0.8);
        channels_ops::image_float(ui, state, "blur", 7.0);
        channels_ops::image_float(ui, state, "dim", 0.45);
        // The content's offset is negative once scrolled down.
        ui.set_channel_ed_scroll_y(-430.0);
        return;
    }
    // The three sheets 5.8 added, opened with their fields as a user would
    // leave them: the export protector past its gate, the delete confirm
    // (whose message carries the count), and a restore already holding a
    // picked file.
    if want == "settings-data-protect" {
        settings_ops::open(ui, state, "data");
        settings_ops::pref_bool(ui, state, "confirmBeforeExport", true);
        settings_ops::backup_export(ui, state);
        ui.set_settings_data_export_password("Tr0ub4dor&3".into());
        settings_ops::data_export_edited(ui);
        return;
    }
    if want == "settings-data-reset" {
        settings_ops::open(ui, state, "data");
        settings_ops::data_reset_open(ui, state);
        return;
    }
    if want == "settings-data-restore" {
        settings_ops::open(ui, state, "backup");
        let text = {
            let guard = state.borrow();
            guard.engine.export_backup_json().unwrap_or_default()
        };
        settings_ops::backup_restore_from_text(
            ui,
            state,
            "colax-vault-backup-2026-10-16-09-30-00.json",
            &text,
        );
        return;
    }
    // The three shortcuts the Layout tab takes off the shell (Task 5.2b),
    // left off so a screenshot shows the bare topbar and rail.
    if want == "chrome" {
        settings_ops::pref_bool(ui, state, "showNewLoginButton", false);
        settings_ops::pref_bool(ui, state, "showLockButton", false);
        settings_ops::pref_bool(ui, state, "showSettingsButton", false);
        return;
    }

    if want == "menu-app" {
        menus::open_app_menu(ui, state, 560.0, 300.0);
        return;
    }

    let id = state
        .borrow()
        .engine
        .items()
        .and_then(|items| items.first().map(|item| item.id.clone()));
    let Some(id) = id else { return };

    // Task 8.1's shots: the item menu over the first card. Called directly
    // (this runs before the callback wiring), at a point the shot has room
    // around; `menu-item-open` also arms the row that owns a submenu so the
    // cascade itself lands in one picture.
    if want == "menu-item" || want == "menu-item-open" {
        menus::open_item_menu(ui, state, &id, 620.0, 320.0);
        if want == "menu-item-open" {
            use slint::Model as _;
            if let Some(row) = ui.get_menu_root_rows().row_data(7) {
                if row.sub {
                    menus::menu_hover(ui, state, 7);
                }
            }
        }
        return;
    }

    // The editor's own generator is the second door to `passwordGenerator`:
    // a chip there is a write (ItemEditor.tsx L171), not a session switch, so
    // the walk flips one and leaves the document to say whether it landed --
    // `passwordGenerator.lower` false in vault.json. One tick late, for the
    // reason the security run below gives: `dev_screen` runs before `main`
    // has wired any callbacks, and this drives the callback a chip would.
    if want == "editor-generator" {
        let weak = ui.as_weak();
        let st = state.clone();
        let timer = slint::Timer::default();
        timer.start(
            slint::TimerMode::SingleShot,
            std::time::Duration::from_millis(400),
            move || {
                let Some(ui) = weak.upgrade() else { return };
                let id = st
                    .borrow()
                    .engine
                    .items()
                    .and_then(|items| items.first().map(|item| item.id.clone()));
                let Some(id) = id else { return };
                open_editor(&ui, &st, &id);
                ui.set_editor_section("credentials".into());
                ui.set_gen_show(true);
                // The chip's own handler: flip the property, then call back.
                ui.set_gen_lower(false);
                ui.invoke_editor_gen_options_changed();
            },
        );
        // Dropping the handle would cancel it before it fires.
        std::mem::forget(timer);
        return;
    }

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

/// Debug-only: append one free-form line to `dev-dump.txt`, for walks whose
/// steps are not the editor draft the stock `dev_dump` describes.
#[cfg(debug_assertions)]
fn dev_note(tag: &str, text: &str) {
    let path = app_dir().join("dev-dump.txt");
    let mut existing = std::fs::read_to_string(&path).unwrap_or_default();
    existing.push_str(&format!("{tag}: {text}\n"));
    let _ = std::fs::write(path, existing);
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
        "{tag}: editor={} vault={} scr=[{}] werr=[{}] section=[{}] id=[{}] title=[{}] url=[{}] username=[{}] password=[{}] notes=[{}] fav={} attn={} days={} label=[{}] sec=[{}] totp={} staged={} passcode={} qr={} questions=[{}] prompt=[{}] errs=[{}/{}/{}] notice=[{}] org=[{}] pw=[{}] pwHint=[{}] email=[{}] emailHint=[{}] canadd={} vs=[{}/{}] cols={} rail=[{}/{}] compact={} hidden={} gate={} gf=[{}/{}/{}] gerr=[{}] thr=[{}] pers={} ls=[{}/{}] lp={} lpair={} al=[{}] clip=[{}] {}\n",
        ui.get_screen() == Screen::Editor,
        ui.get_screen() == Screen::Vault,
        // Which screen, by name: a refusal that left the screen, or a
        // suggestion that never reached confirm, reads here. `editor` and
        // `vault` above are booleans and cannot say which of the eight
        // other screens the window is on.
        match ui.get_screen() {
            Screen::Vault => "vault",
            Screen::Editor => "editor",
            Screen::CreateChoose => "create-choose",
            Screen::CreatePassword => "create-password",
            Screen::CreateConfirm => "create-confirm",
            Screen::UnlockPassword => "unlock-password",
            Screen::UnlockDevice => "unlock-device",
            Screen::ImportPassword => "import-password",
            Screen::Error => "error",
        },
        // The lock card's own error strip, which the editor's trio below
        // does not carry: the refusals land here.
        ui.get_error_text(),
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
        // ...and the lock card's: which palette is up, whether the data
        // folder took a write, what the create-password meter says, and
        // whether the two create fields hold the same thing (a suggestion
        // that filled only one of them would still look filled).
        ui.global::<Theme>().get_resolved_theme(),
        ui.get_storage_persistent(),
        ui.get_lock_strength_score(),
        ui.get_lock_strength_label(),
        !ui.get_password_value().is_empty(),
        ui.get_password_value() == ui.get_confirm_value()
            && !ui.get_password_value().is_empty(),
        // ...and the idle lock's: the minutes armed, where 0 is nothing
        // running at all (a sealed vault, or the "never" choice).
        AUTO_LOCK.with(|slot| slot.borrow().as_ref().map_or(0, |entry| entry.minutes)),
        // ...and the clipboard's: `len=N` while it holds text (ours, or
        // somebody else's -- either way something a wipe has not
        // touched), `empty` once a wipe landed, `?` when it would not
        // open. The auto-clear and the lock wipe each prove themselves
        // by moving this segment from `len=` to `empty`.
        match platform::read_text() {
            None => "?".to_string(),
            Some(text) if text.is_empty() => "empty".to_string(),
            Some(text) => format!("len={}", text.chars().count()),
        },
        describe_cards(ui),
    );
    let path = app_dir().join("dev-dump.txt");
    let mut existing = std::fs::read_to_string(&path).unwrap_or_default();
    existing.push_str(&dump);
    let _ = std::fs::write(path, existing);
}

/// Debug-only: open the Command Center and dump what reached the window.
///
/// `COLAX_DEV_SCREEN=dashboard`. The numbers are the point of the walk: the
/// score and every section's count are read back off the screen's own
/// properties, so a seeded vault's buckets can be checked against the engine
/// without looking at the window -- the desktop may be locked, and a
/// screenshot then comes back white.
#[cfg(debug_assertions)]
fn dev_dashboard(ui: &MainWindow, state: &Shared) {
    let _ = std::fs::remove_file(app_dir().join("dev-dump.txt"));

    // 1. Pick the channel the way the rail's row does: set the id, then
    //    refresh (the row sets `active-channel` before it fires the
    //    callback, and the callback only clears the search and redraws).
    ui.set_active_channel("dashboard".into());
    refresh_items(ui, state);
    dev_dump_dash(ui, "dash1.open");

    // 2. A copy bumps the usage record: Recent Logins must lead with the
    //    copied login and its use count, and Most used must rank it first.
    //    The id is fetched in its own statement: an `if let` scrutinee's
    //    temporary `Ref` would still be alive inside the body, and the copy
    //    path saves preferences (`borrow_mut`) through it.
    let first = state
        .borrow()
        .engine
        .items()
        .and_then(|items| items.first().map(|item| item.id.clone()));
    if let Some(id) = first {
        copy_item_password(ui, state, &id);
        refresh_items(ui, state);
    }
    dev_dump_dash(ui, "dash2.after-copy");

    // 3. Flag one login and refresh: the attention list and the score both
    //    move -- one login fewer counts as clear.
    let first = state
        .borrow()
        .engine
        .items()
        .and_then(|items| items.first().map(|item| item.id.clone()));
    if let Some(id) = first {
        let before: Vec<VaultItem> = state
            .borrow()
            .engine
            .items()
            .map(|items| items.to_vec())
            .unwrap_or_default();
        let _ = state
            .borrow_mut()
            .engine
            .update_item(&id, &serde_json::json!({ "needsAttention": true }));
        record_history(ui, state, &before);
        refresh_items(ui, state);
    }
    dev_dump_dash(ui, "dash3.flagged");

    // 4. Back to the list: the pane swaps with the channel, and the
    //    dashboard's models stay where they were (nothing clears them; the
    //    `if` simply stops rendering them).
    ui.set_active_channel("all".into());
    refresh_items(ui, state);
    dev_dump_dash(ui, "dash4.left");
}

/// The dashboard half of a dump: the swap flag, the score and label, and
/// every section's count as the screen holds them.
#[cfg(debug_assertions)]
fn dev_dump_dash(ui: &MainWindow, tag: &str) {
    use slint::Model;
    let dash = format!(
        "{tag}: show={} score={} {} band={} headline=[{} x{}] has={} tiles=[{}] issues=[{}] recent=[{}] segs=[{}] days={}/{} domains={} reuse={} uses=[{}] emails={} factors={} channels={} org=[{}/{}] {} {}\n",
        ui.get_show_dashboard(),
        ui.get_dash_ring().score,
        ui.get_dash_ring().label,
        ui.get_dash_ring().band,
        ui.get_dash_headline().label,
        ui.get_dash_headline().count,
        ui.get_dash_has_headline(),
        ui.get_dash_stats()
            .as_any()
            .downcast_ref::<VecModel<crate::DashStat>>()
            .map(|m| (0..m.row_count())
                .map(|i| m.row_data(i).map(|s| s.value).unwrap_or(-1))
                .collect::<Vec<_>>()
                .iter()
                .map(|v| v.to_string())
                .collect::<Vec<_>>()
                .join("/"))
            .unwrap_or_default(),
        ui.get_dash_issues()
            .as_any()
            .downcast_ref::<VecModel<crate::DashIssue>>()
            .map(|m| (0..m.row_count())
                .filter_map(|i| m.row_data(i))
                .map(|i| i.count.to_string())
                .collect::<Vec<_>>()
                .join("/"))
            .unwrap_or_default(),
        ui.get_dash_recent().row_count(),
        ui.get_dash_segments().row_count(),
        ui.get_dash_days_added(),
        ui.get_dash_days_changed(),
        ui.get_dash_domains().row_count(),
        ui.get_dash_reuse().row_count(),
        ui.get_dash_uses()
            .as_any()
            .downcast_ref::<VecModel<crate::DashUse>>()
            .map(|m| (0..m.row_count())
                .filter_map(|i| m.row_data(i))
                .map(|u| format!("{}x{}", u.count, u.name))
                .collect::<Vec<_>>()
                .join(","))
            .unwrap_or_default(),
        ui.get_dash_emails().row_count(),
        ui.get_dash_factors().row_count(),
        ui.get_dash_channels().row_count(),
        ui.get_dash_tag_count(),
        ui.get_dash_channel_count(),
        describe_cards(ui),
        pops(ui),
    );
    let path = app_dir().join("dev-dump.txt");
    let mut existing = std::fs::read_to_string(&path).unwrap_or_default();
    existing.push_str(&dash);
    let _ = std::fs::write(path, existing);
}

/// Debug-only: open the History channel and dump what reached the window.
///
/// `COLAX_DEV_SCREEN=history`. The rows are read back off the screen's own
/// properties — count, day groups, flags, and the meta line — so the panel
/// can be checked against the engine without looking at the window (the
/// desktop may be locked, and this writes the same file every other screen
/// writes). Four steps: everything the seed recorded, the Added segment, a
/// query with no answer (the second empty state), and a Forget to prove the
/// log writes.
#[cfg(debug_assertions)]
fn dev_history(ui: &MainWindow, state: &Shared) {
    ui.set_active_channel("history".into());
    refresh_items(ui, state);
    dev_dump_history(ui, "history1.open");

    ui.set_history_filter(1); // the Added segment
    refresh_items(ui, state);
    dev_dump_history(ui, "history2.added");

    ui.set_history_filter(0);
    ui.set_history_query("no such word".into());
    refresh_items(ui, state);
    dev_dump_history(ui, "history3.nomatch");

    // Forget the first row: the log writes, the count follows, and the
    // rows behind it survive.
    ui.set_history_query("".into());
    let first_event = {
        let guard = state.borrow();
        items::prefs_from(guard.engine.preferences())
            .history
            .first()
            .map(|event| event.id.clone())
    };
    if let Some(id) = first_event {
        history_forget(ui, state, &id);
        dev_dump_history(ui, "history4.forgot");
    }
}

/// The history half of a dump: the swap flag, the count, the segment and
/// query as the screen holds them, each day group with its row count, and
/// the first row's badge, name, meta and flags — enough to prove the log
/// reached the screen without a picture of it. Password *lengths* only: a
/// dump file is not a place to write secrets.
#[cfg(debug_assertions)]
fn dev_dump_history(ui: &MainWindow, tag: &str) {
    use slint::Model;
    let data = ui.get_history_data();
    let groups = data
        .groups
        .iter()
        .map(|group| format!("{}:{}", group.label, group.rows.row_count()))
        .collect::<Vec<_>>()
        .join(",");
    let first_row = data
        .groups
        .iter()
        .next()
        .and_then(|group| group.rows.iter().next())
        .map(|row| {
            format!(
                "{} [{}] {} — {} | r={} l={} pw={} url={} pwlen={} urlv=[{}]",
                row.badge,
                row.action,
                row.name,
                row.meta,
                row.restore,
                row.live,
                row.copy_pw,
                row.copy_url,
                row.copy_pw_value.chars().count(),
                row.copy_url_value,
            )
        })
        .unwrap_or_default();
    let line = format!(
        "{tag}: show={} count=[{}] filter={} query=[{}] has={} groups=[{}] empty=[{}] row0=[{}]\n",
        ui.get_show_history(),
        data.count,
        ui.get_history_filter(),
        ui.get_history_query(),
        data.has_events,
        groups,
        data.empty_title,
        first_row,
    );
    let path = app_dir().join("dev-dump.txt");
    let mut existing = std::fs::read_to_string(&path).unwrap_or_default();
    existing.push_str(&line);
    let _ = std::fs::write(path, existing);
}

/// The alarms walk — the phase gate: *an alarm set one minute out fires*.
/// Arms a real alarm through the same prefs write Settings will use, dumps
/// the arming, then watches the ticker and dumps the moment it rings. The
/// second line comes from the ring itself, never a later read of the toast
/// strip: that clears after 2.5s and the wait is a minute.
#[cfg(debug_assertions)]
fn dev_alarm(ui: &MainWindow, state: &Shared) {
    let armed_for = alarms::next_minute();
    let mut prefs = {
        let guard = state.borrow();
        items::prefs_from(guard.engine.preferences())
    };
    prefs.alarms = vec![colax_core::Alarm {
        id: colax_core::new_alarm_id(),
        label: "One minute out".into(),
        time: armed_for,
        days: vec![],
        sound: None,
        enabled: true,
    }];
    if !save_prefs(ui, state, &prefs) {
        // A walk that could not arm the alarm must say so rather than wait
        // a minute for a line that will never come.
        let path = app_dir().join("dev-dump.txt");
        let mut existing = std::fs::read_to_string(&path).unwrap_or_default();
        existing.push_str("alarm1.set: FAILED to arm\n");
        let _ = std::fs::write(path, existing);
        return;
    }
    dev_dump_alarm(ui, state, "alarm1.set");

    // Watch: dump as soon as the ticker rings (the toast is still on
    // screen then), or at 75s — a missing second line is the failure, so
    // it is written either way.
    let weak = ui.as_weak();
    let st = state.clone();
    let ticks = std::rc::Rc::new(std::cell::Cell::new(0u32));
    let dumped = std::rc::Rc::new(std::cell::Cell::new(false));
    let tick_count = ticks.clone();
    let already = dumped.clone();
    let timer = slint::Timer::default();
    timer.start(
        slint::TimerMode::Repeated,
        std::time::Duration::from_millis(1000),
        move || {
            let Some(ui) = weak.upgrade() else { return };
            let n = tick_count.get() + 1;
            tick_count.set(n);
            if already.get() {
                return;
            }
            if !alarms::fired_log().is_empty() || n >= 75 {
                already.set(true);
                dev_dump_alarm(&ui, &st, "alarm2.fired");
            }
        },
    );
    // Dropping the handle would stop watching before the minute arrived.
    std::mem::forget(timer);
}

/// The alarms half of a dump: what is armed and whether it is on, the mute
/// flag the ring reads, everything that has rung since launch, and the
/// toast the window currently holds — enough to prove the match without a
/// picture of the strip.
#[cfg(debug_assertions)]
fn dev_dump_alarm(ui: &MainWindow, state: &Shared, tag: &str) {
    let prefs = {
        let guard = state.borrow();
        colax_core::normalise_preferences(guard.engine.preferences())
    };
    let armed = prefs
        .alarms
        .iter()
        .map(|alarm| format!("{}{}", if alarm.enabled { "+" } else { "-" }, alarm.time))
        .collect::<Vec<_>>()
        .join(",");
    let line = format!(
        "{tag}: armed=[{armed}] count={} muted={} fired=[{}] notice=[{}]\n",
        prefs.alarms.len(),
        prefs.sounds_muted,
        alarms::fired_log(),
        ui.get_notice_text(),
    );
    let path = app_dir().join("dev-dump.txt");
    let mut existing = std::fs::read_to_string(&path).unwrap_or_default();
    existing.push_str(&line);
    let _ = std::fs::write(path, existing);
}

/// The popover half of a dump: every panel's group and row counts, the
/// three heights Rust measured for it, and its first title — enough to
/// prove the `DashPop` data reached the screen without a pixel to look at.
#[cfg(debug_assertions)]
fn pops(ui: &MainWindow) -> String {
    use slint::Model;
    let one = |pop: crate::DashPop| {
        let grouped: usize = pop.groups.iter().map(|group| group.rows.row_count()).sum();
        let rows = grouped + pop.rows.row_count();
        let sample = pop
            .groups
            .iter()
            .next()
            .map(|group| group.title)
            .or_else(|| pop.rows.iter().next().map(|row| row.name))
            .unwrap_or_default();
        format!(
            "{}g/{}r/h={:.0}+{:.0}={:.0}/{}",
            pop.groups.row_count(),
            rows,
            pop.about_h,
            pop.scroll_h,
            pop.height,
            sample
        )
    };
    format!(
        " pops=[s:{} d:{} r:{} u:{}]",
        one(ui.get_dash_pop_strength()),
        one(ui.get_dash_pop_domains()),
        one(ui.get_dash_pop_reuse()),
        one(ui.get_dash_pop_uses()),
    )
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

/// Debug-only: drive the global shortcuts (Task 8.2) straight through the
/// dispatcher -- a dev walk cannot press an OS key, so each step hands
/// `shortcuts::key` the text and modifiers a real press would carry and reads
/// back what the window then holds. `COLAX_DEV_KEYS=1`.
#[cfg(debug_assertions)]
fn dev_keys(ui: &MainWindow, state: &Shared) {
    let _ = std::fs::remove_file(app_dir().join("dev-dump.txt"));

    let screen = || match ui.get_screen() {
        Screen::Vault => "vault",
        Screen::Editor => "editor",
        Screen::CreateChoose => "create-choose",
        Screen::CreatePassword => "create-password",
        Screen::CreateConfirm => "create-confirm",
        Screen::UnlockPassword => "unlock-password",
        Screen::UnlockDevice => "unlock-device",
        Screen::ImportPassword => "import-password",
        Screen::Error => "error",
    };
    let count = |state: &Shared| state.borrow().engine.items().map(|i| i.len()).unwrap_or(0);

    // 1. Where the walk opens: the vault, nothing open, nothing typed.
    dev_note(
        "keys01.open",
        &format!(
            "scr={} view={} chan={} tick={} sheet={} items={}",
            screen(),
            ui.get_vault_view(),
            ui.get_active_channel(),
            ui.get_search_focus_tick(),
            ui.get_show_shortcuts(),
            count(state),
        ),
    );

    // 2. `/` focuses the search box; the tick is the only thing it moves.
    let took = shortcuts::key(ui, state, "/", false, false, false);
    dev_note(
        "keys02.slash",
        &format!("took={took} tick={}", ui.get_search_focus_tick()),
    );

    // 3. `N` opens a blank editor and Escape backs out of it.
    let took = shortcuts::key(ui, state, "n", false, false, false);
    let opened = screen() == "editor";
    let took_esc = shortcuts::key(ui, state, "\u{1b}", false, false, false);
    dev_note(
        "keys03.new+esc",
        &format!("n={took} opened={opened} esc={took_esc} scr={}", screen()),
    );

    // 4. `V` cycles the view: animated -> carousel.
    let before = ui.get_vault_view().to_string();
    let took = shortcuts::key(ui, state, "v", false, false, false);
    dev_note(
        "keys04.v",
        &format!("took={took} {before}->{}", ui.get_vault_view()),
    );

    // 5. Ctrl+3 picks the third view by number.
    let took = shortcuts::key(ui, state, "3", true, false, false);
    dev_note(
        "keys05.ctrl3",
        &format!("took={took} view={}", ui.get_vault_view()),
    );

    // 6. `?` opens the sheet with all ten rows, and Escape closes it.
    let took = shortcuts::key(ui, state, "?", false, true, false);
    let rows = ui.get_shortcut_rows().row_count();
    let sheet_open = ui.get_show_shortcuts();
    let took_esc = shortcuts::key(ui, state, "\u{1b}", false, false, false);
    dev_note(
        "keys06.sheet+esc",
        &format!(
            "took={took} rows={rows} open={sheet_open} esc={took_esc} closed={}",
            !ui.get_show_shortcuts()
        ),
    );

    // 7. Alt+2 jumps to the second rail channel.
    let second = ui
        .get_sidebar()
        .iter()
        .filter(|row| row.kind == 0 && !row.hidden)
        .nth(1)
        .map(|row| row.id.to_string())
        .unwrap_or_default();
    let took = shortcuts::key(ui, state, "2", false, false, true);
    dev_note(
        "keys07.alt2",
        &format!(
            "took={took} want={second} chan={}",
            ui.get_active_channel()
        ),
    );

    // 8. The guard: with Settings open a bare `v` is refused and the view is
    //    untouched -- the one rule a stray shortcut could break.
    ui.set_settings_open(true);
    let view_before = ui.get_vault_view().to_string();
    let took = shortcuts::key(ui, state, "v", false, false, false);
    ui.set_settings_open(false);
    dev_note(
        "keys08.guard",
        &format!(
            "took={took} view={} unchanged={}",
            ui.get_vault_view(),
            view_before == ui.get_vault_view().to_string()
        ),
    );

    // 9. The app menu's own row: open the menu, find "Keyboard shortcuts"
    //    among its rows, and dispatch it the way a click would.
    crate::menus::open_app_menu(ui, state, 10.0, 10.0);
    let menu_ids: Vec<String> = ui
        .get_menu_root_rows()
        .iter()
        .map(|row| row.id.to_string())
        .collect();
    let has_shortcuts_row = menu_ids.iter().any(|id| id == "app.shortcuts");
    crate::menus::menu_picked(ui, state, "app.shortcuts");
    dev_note(
        "keys09.menu",
        &format!(
            "row={has_shortcuts_row} sheet={} rows={}",
            ui.get_show_shortcuts(),
            ui.get_shortcut_rows().row_count()
        ),
    );
    let _ = shortcuts::key(ui, state, "\u{1b}", false, false, false);

    // 10. Undo/redo: delete the first login through the same `record_history`
    //     path every mutation takes, then Ctrl+Z puts it back and
    //     Ctrl+Shift+Z takes it away again.
    let (victim, before_count, before_items) = {
        let guard = state.borrow();
        let items = guard.engine.items().map(|i| i.to_vec()).unwrap_or_default();
        let victim = items.first().map(|i| i.id.clone()).unwrap_or_default();
        (victim, items.len(), items)
    };
    let _ = state.borrow_mut().engine.delete_item(&victim);
    record_history(ui, state, &before_items);
    let after_delete = count(state);
    let took_undo = shortcuts::key(ui, state, "z", true, false, false);
    let after_undo = count(state);
    let took_redo = shortcuts::key(ui, state, "z", true, true, false);
    let after_redo = count(state);
    dev_note(
        "keys10.undo",
        &format!(
            "del={before_count}->{after_delete} undo={took_undo}->{after_undo} redo={took_redo}->{after_redo}"
        ),
    );

    // 11. `L` locks the vault -- last, so the dump survives it.
    let took = shortcuts::key(ui, state, "l", false, false, false);
    dev_note("keys11.lock", &format!("took={took} scr={}", screen()));
}

/// Debug-only: walk the quick-launch docks (Task 8.3) the way a hand would --
/// read the bars the window holds, press a slot's key, drag a bar onto an
/// edge, open the bar and slot menus, record a new key, add and hide a bar --
/// and read back both halves of the wire: the bars Slint actually draws and
/// the placement stored in preferences. `COLAX_DEV_DOCKS=1`.
#[cfg(debug_assertions)]
fn dev_docks(ui: &MainWindow, state: &Shared) {
    let _ = std::fs::remove_file(app_dir().join("dev-dump.txt"));

    // The bars the window holds: id, edge, placement, then each slot's kind,
    // label, glyph, key and its active/divider flags. A bar that never reached
    // Slint draws nothing, so this is the only trustworthy reading.
    let bars = || {
        let mut text = String::new();
        for bar in ui.get_dock_bars().iter() {
            text.push_str(&format!(
                "<{} {} {:.2}/{:.2}",
                bar.id, bar.edge, bar.fx, bar.fy
            ));
            for slot in bar.slots.iter() {
                text.push_str(&format!(
                    " [{} {} {} k={} a={} d={}]",
                    slot.kind, slot.label, slot.glyph, slot.key, slot.active, slot.divider
                ));
            }
            text.push('>');
        }
        text
    };
    let rows = || {
        let mut text = String::new();
        for row in ui.get_dock_rows().iter() {
            text.push_str(&format!(
                "({} {}/{} {} k={} on={} miss={})",
                row.kind, row.dock, row.slot, row.title, row.key, row.enabled, row.missing
            ));
        }
        text
    };
    let stored = |dock_id: &str| {
        let prefs = items::prefs_from(state.borrow().engine.preferences());
        match prefs.docks.iter().find(|dock| dock.id == dock_id) {
            Some(dock) => format!(
                "{} {:.2}/{:.2} keys=[{}]",
                dock::edge_name(dock.pos.edge),
                dock.pos.fx,
                dock.pos.fy,
                dock
                    .slots
                    .iter()
                    .map(|slot| slot.key.clone())
                    .collect::<Vec<_>>()
                    .join(",")
            ),
            None => "gone".to_string(),
        }
    };
    let dock_ids = || {
        items::prefs_from(state.borrow().engine.preferences())
            .docks
            .iter()
            .map(|dock| dock.id.clone())
            .collect::<Vec<_>>()
    };
    let press = |key: &str| shortcuts::key(ui, state, key, false, false, false);

    // 1. Where the walk opens: the shipped bar, five slots, keys 1-5.
    dev_note(
        "docks01.open",
        &format!(
            "view={} bars={} rows=[{}] {}",
            ui.get_vault_view(),
            ui.get_dock_bars().row_count(),
            rows(),
            bars(),
        ),
    );

    // 2-3. A slot key jumps. `2` is Orbit, `1` is Flow; the second press
    // proves the keys keep working after the view has moved under them.
    let accepted = press("2");
    dev_note(
        "docks02.key2",
        &format!("accept={} view={}", accepted, ui.get_vault_view()),
    );
    let accepted = press("1");
    dev_note(
        "docks03.key1",
        &format!("accept={} view={}", accepted, ui.get_vault_view()),
    );

    // 4. A drag: the drop point becomes the stored placement, and the snapped
    // edge decides the orientation.
    let ids = dock_ids();
    let first = ids.first().cloned().unwrap_or_default();
    dock::pos_committed(ui, state, &first, "left", 0.05, 0.5);
    dev_note(
        "docks04.drag",
        &format!("stored=[{}] drawn=[{}]", stored(&first), bars()),
    );

    // 5. The bar's own menu.
    menus::open_dock_menu(ui, state, &first, 10.0, 10.0);
    let menu: Vec<String> = ui
        .get_menu_root_rows()
        .iter()
        .map(|row| row.id.to_string())
        .collect();
    dev_note("docks05.barmenu", &format!("rows=[{}]", menu.join(" ")));
    menus::close(ui);

    // 6. One slot's menu, named the way the bar's right-click names it.
    let slot_id = "view:animated".to_string();
    menus::open_dock_slot_menu(ui, state, &first, &slot_id, 10.0, 10.0);
    let menu: Vec<String> = ui
        .get_menu_root_rows()
        .iter()
        .map(|row| row.id.to_string())
        .collect();
    dev_note("docks06.slotmenu", &format!("rows=[{}]", menu.join(" ")));
    // A menu suppresses bare keys, so it is closed (as a press on one of its
    // rows would close it) before the keypress below is tried.
    menus::close(ui);

    // 7-8. Rekey slot 1 (Orbit) to `9` through the recorder, then press it:
    // the view must move exactly as a stored key would.
    dock::arm_key(ui, state, &first, 1);
    let captured = dock::capture(ui, state, "9");
    dev_note(
        "docks07.rekey",
        &format!("captured={} stored=[{}]", captured, stored(&first)),
    );
    let accepted = press("9");
    dev_note(
        "docks08.press9",
        &format!(
            "accept={} view={} notice=[{}]",
            accepted,
            ui.get_vault_view(),
            ui.get_notice_text(),
        ),
    );

    // 9. A new bar, then a hidden one: the count moves and the drawn layer
    // follows.
    dock::add_dock(ui, state);
    dev_note(
        "docks09.add",
        &format!("docks={} bars={} rows=[{}]", dock_ids().len(), bars(), rows()),
    );
    dock::hide(ui, state, &first);
    dev_note(
        "docks10.hide",
        &format!(
            "docks={} bars={} notice=[{}]",
            dock_ids().len(),
            bars(),
            ui.get_notice_text(),
        ),
    );

    // 11. The Layout tab's Key button: the recorder is armed for the bar in
    // Settings, and the Settings scope forwards the very next key through
    // `dock-key` rather than treating it as a tab jump.
    ui.invoke_open_settings("layout".into());
    dock::arm_key(ui, state, &first, 2);
    let recording = ui.get_dock_recording();
    ui.invoke_dock_key_captured("8".into());
    dev_note(
        "docks11.settings-key",
        &format!(
            "armed={} after={} stored=[{}] view={}",
            recording,
            ui.get_dock_recording(),
            stored(&first),
            ui.get_vault_view(),
        ),
    );

    // 12. The Hidden tab lists a hidden bar and brings it back: hiding takes
    // away the bar you would unhide it from, so this is the only door.
    let hidden = {
        let prefs = items::prefs_from(state.borrow().engine.preferences());
        let items = state
            .borrow()
            .engine
            .items()
            .map(|items| items.to_vec())
            .unwrap_or_default();
        settings_ops::hidden_rows(&prefs, &items)
            .iter()
            .filter(|row| row.key == "dock")
            .map(|row| format!("{}({})", row.label, row.id))
            .collect::<Vec<_>>()
            .join(" ")
    };
    settings_ops::restore(ui, state, "dock", &first);
    dev_note(
        "docks12.hidden",
        &format!(
            "listed=[{}] after-restore=[{}] bars={}",
            hidden,
            stored(&first),
            ui.get_dock_bars().row_count(),
        ),
    );

    // 13. "Show all" turns every bar back on in one write.
    dock::hide(ui, state, &first);
    settings_ops::restore_all(ui, state);
    dev_note(
        "docks13.show-all",
        &format!("bars={} rows=[{}]", ui.get_dock_bars().row_count(), rows()),
    );
}

/// Debug-only: walk the drag-reorder engine (Task 8.5). A dev walk cannot
/// press and hold a pointer, so the gesture's three reports are called where
/// the row would call them -- with a rectangle standing in for the row it
/// reported. What is checked is the half that has to be right: the slot the
/// geometry resolves to, the bar drawn there, and the order a drop writes.
/// `COLAX_DEV_REORDER=1`.
#[cfg(debug_assertions)]
fn dev_reorder(ui: &MainWindow, state: &Shared) {
    let _ = std::fs::remove_file(app_dir().join("dev-dump.txt"));

    let order = || {
        ui.get_cards()
            .iter()
            .take(8)
            .map(|card| card.label.to_string())
            .collect::<Vec<_>>()
            .join("|")
    };
    let sort = || {
        items::prefs_from(state.borrow().engine.preferences())
            .sort
            .clone()
    };
    let manual = || {
        items::prefs_from(state.borrow().engine.preferences())
            .manual_order
            .len()
    };
    // The stored order, by title: `GitHub` being pinned first means the drawn
    // order cannot show a drop below it, so the saved list is the proof.
    let stored_order = || {
        let guard = state.borrow();
        let prefs = items::prefs_from(guard.engine.preferences());
        let items = guard.engine.items().unwrap_or_default();
        prefs
            .manual_order
            .iter()
            .map(|id| {
                items
                    .iter()
                    .find(|item| item.id == *id)
                    .map(|item| item.title.clone())
                    .unwrap_or_else(|| id.clone())
            })
            .collect::<Vec<_>>()
            .join("|")
    };
    let bar = || {
        format!(
            "vis={} {:.0},{:.0} {:.0}x{:.0} target={:?}",
            ui.get_reorder_drop_visible(),
            ui.get_reorder_drop_x(),
            ui.get_reorder_drop_y(),
            ui.get_reorder_drop_w(),
            ui.get_reorder_drop_h(),
            state.borrow().reorder_drop,
        )
    };

    // 1. Grid: a 2-D drag one row down lands one `cols` further along. Index 1
    // rather than 0: the seed's first card is a pinned favourite, and pinning
    // outranks the manual order in the drawn list by design.
    let _ = shortcuts::key(ui, state, "4", false, false, false);
    let cols = ui.get_grid_cols().max(1) as usize;
    dev_note(
        "reorder01.grid-open",
        &format!(
            "view={} cols={} count={} sort={} order=[{}]",
            ui.get_vault_view(),
            cols,
            ui.get_cards().row_count(),
            sort(),
            order(),
        ),
    );
    let before = order();
    reorder::begin(ui, state, 1, 100.0, 100.0, 100.0, 100.0, 200.0, 124.0);
    reorder::moved(ui, state, 100.0, 100.0 + 134.0);
    dev_note(
        "reorder02.grid-move",
        &format!("cols={} bar=[{}]", cols, bar()),
    );
    reorder::finish(ui, state, true);
    dev_note(
        "reorder03.grid-drop",
        &format!(
            "sort={} manual={} stored=[{}] before=[{}] after=[{}]",
            sort(),
            manual(),
            stored_order(),
            before,
            order(),
        ),
    );

    // 2. List: a vertical drag two rows down. The list row is the same height
    // for every card, so the pitch is the reported rectangle plus the 2px
    // spacing; two pitches must land two rows on.
    let _ = shortcuts::key(ui, state, "3", false, false, false);
    let before = order();
    reorder::begin(ui, state, 1, 100.0, 300.0, 100.0, 300.0, 420.0, 92.0);
    reorder::moved(ui, state, 100.0, 300.0 + 188.0);
    dev_note(
        "reorder04.list-move",
        &format!("sort={} bar=[{}]", sort(), bar()),
    );
    reorder::finish(ui, state, true);
    dev_note(
        "reorder05.list-drop",
        &format!(
            "sort={} stored=[{}] before=[{}] after=[{}]",
            sort(),
            stored_order(),
            before,
            order()
        ),
    );

    // 3. A cancelled drag changes nothing and leaves no bar.
    reorder::begin(ui, state, 1, 100.0, 300.0, 100.0, 300.0, 420.0, 92.0);
    reorder::moved(ui, state, 100.0, 300.0 + 188.0);
    reorder::finish(ui, state, false);
    dev_note(
        "reorder06.cancel",
        &format!("bar=[{}] after=[{}]", bar(), order()),
    );

    // 4. Released over the card it lifted: no indicator, and no write (the
    // sort stays Custom because step 1 already switched it).
    let before = stored_order();
    reorder::begin(ui, state, 1, 100.0, 300.0, 100.0, 300.0, 420.0, 92.0);
    reorder::moved(ui, state, 100.0, 301.0);
    reorder::finish(ui, state, true);
    dev_note(
        "reorder07.noop",
        &format!("bar=[{}] before=[{}] after=[{}]", bar(), before, stored_order()),
    );
}

/// Debug-only: walk the appearance tuner (Task 8.4) the way a hand would --
/// open it from the menu, drag each dial, reset, and read back *both* halves
/// of the wire: the geometry stored in preferences and the scalars the window
/// actually holds, which is what the cards draw from. `COLAX_DEV_TUNER=1`.
#[cfg(debug_assertions)]
fn dev_tuner(ui: &MainWindow, state: &Shared) {
    let _ = std::fs::remove_file(app_dir().join("dev-dump.txt"));

    let stored = |view: &str| {
        items::prefs_from(state.borrow().engine.preferences())
            .card_size
            .get(view)
            .copied()
            .unwrap_or_else(|| colax_core::default_card_size(view))
    };
    // The scalars on the window, which is the only place the cards can read
    // them: a pref that never reaches here draws nothing.
    let pushed = || {
        format!(
            "card(scale={} w={} minH={} aspect={} r={})",
            ui.get_card_scale(),
            ui.get_card_width(),
            ui.get_card_min_height(),
            ui.get_card_aspect(),
            ui.get_card_radius(),
        )
    };

    // 1. Closed to start, and the `Card size` submenu is on the background
    //    menu: the door the TS opens the tuner through.
    crate::menus::open_app_menu(ui, state, 10.0, 10.0);
    let has_row = ui
        .get_menu_root_rows()
        .iter()
        .any(|row| row.id.as_str() == "app.cardSize");
    dev_note(
        "tuner01.menu",
        &format!("row={has_row} tuner={} view={}", ui.get_show_tuner(), ui.get_vault_view()),
    );

    // 2. Dispatching the submenu's Flow row opens the tuner on Flow, showing
    //    the shipped 560/132/14 and no aspect dial.
    crate::menus::menu_picked(ui, state, "app.cardSize:animated");
    dev_note(
        "tuner02.flow",
        &format!(
            "open={} view={} orbit={} tuner(scale={} w={} minH={}) {}",
            ui.get_show_tuner(),
            ui.get_vault_view(),
            ui.get_tuner_orbit(),
            ui.get_tuner_scale(),
            ui.get_tuner_width(),
            ui.get_tuner_min_height(),
            pushed(),
        ),
    );

    // 3. Dragging Scale stores the snapped value and pushes it: 1.37 lands on
    //    the 0.05 step at 1.35.
    tuner::size_changed(ui, state, "scale", 1.37);
    dev_note(
        "tuner03.scale",
        &format!("stored={} {}", stored("animated").scale, pushed()),
    );

    // 4. Width, rounded to the slider's 10px step.
    tuner::size_changed(ui, state, "width", 703.0);
    dev_note(
        "tuner04.width",
        &format!("stored={} {}", stored("animated").width, pushed()),
    );

    // 5. Radius, clamped to the slider's 0-48 ceiling.
    tuner::size_changed(ui, state, "radius", 90.0);
    dev_note(
        "tuner05.radius",
        &format!("stored={} {}", stored("animated").radius, pushed()),
    );

    // 6. Reset puts Flow back to its shipped numbers, and the window follows.
    tuner::reset(ui, state);
    dev_note(
        "tuner06.reset",
        &format!(
            "scale={} w={} r={} {}",
            stored("animated").scale,
            stored("animated").width,
            stored("animated").radius,
            pushed(),
        ),
    );

    // 7. The same submenu row for Orbit re-scopes the tuner: it is still the
    //    same panel, but the view (and so the numbers) changed under it, and
    //    the aspect dial is the one it now shows.
    crate::menus::menu_picked(ui, state, "app.cardSize:carousel");
    dev_note(
        "tuner07.orbit",
        &format!(
            "open={} view={} orbit={} w={} aspect={}",
            ui.get_show_tuner(),
            ui.get_vault_view(),
            ui.get_tuner_orbit(),
            ui.get_tuner_width(),
            ui.get_tuner_aspect(),
        ),
    );

    // 8. Orbit's own dial: aspect is a plain multiplier, stored as written.
    tuner::size_changed(ui, state, "aspect", 1.8);
    dev_note(
        "tuner08.aspect",
        &format!("stored={} aspect={}", stored("carousel").aspect, ui.get_card_aspect()),
    );

    // 9. An accent swatch writes the app-wide accent.
    tuner::accent_picked(ui, state, "clay");
    let accent = items::prefs_from(state.borrow().engine.preferences()).accent;
    dev_note(
        "tuner09.accent",
        &format!("stored={accent} shown={}", ui.get_tuner_accent()),
    );

    // 10. While the tuner is open the Alt-jump is refused (the TS blocks the
    //     channel shortcut but not the bare keys), and Escape dismisses it.
    let alt_refused = !shortcuts::key(ui, state, "2", false, false, true);
    let esc = shortcuts::key(ui, state, "\u{1b}", false, false, false);
    dev_note(
        "tuner10.close",
        &format!("alt_refused={alt_refused} esc={esc} open={}", ui.get_show_tuner()),
    );
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
    let (secured_login, before) = {
        let mut guard = state.borrow_mut();
        let before: Vec<VaultItem> = guard
            .engine
            .items()
            .map(|items| items.to_vec())
            .unwrap_or_default();
        let added = guard
            .engine
            .add_item(&serde_json::json!({
                "title": "Secured Bank",
                "url": "bank.example",
                "username": "ada",
                "password": "hunter22hunter2",
                "security": { "passcode": { "hash": hash, "salt": salt } },
            }))
            .ok()
            .map(|item| item.id);
        (added, before)
    };
    record_history(ui, state, &before);
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

/// Debug-only: walk the lock card's dials -- the create-password meter
/// and the estimator's floor under it, the suggestion that fills both
/// fields and jumps a stage, and the Sun/Moon writing the palette back.
/// `COLAX_DEV_LOCK=1`.
#[cfg(debug_assertions)]
fn dev_lock(ui: &MainWindow, state: &Shared) {
    let _ = std::fs::remove_file(app_dir().join("dev-dump.txt"));

    // 1. The protection chooser, as a first run would open it.
    goto(ui, state, Screen::CreateChoose);
    dev_dump(ui, "lock1.choose");

    // 2-3. A short password: the meter says so per keystroke, and the
    //      floor refuses it with the TS sentence (L76-79) that points at
    //      the suggestion under the button.
    goto(ui, state, Screen::CreatePassword);
    ui.set_password_value("abc".into());
    ui.invoke_password_edited();
    dev_dump(ui, "lock2.weak-meter");
    ui.invoke_password_next();
    dev_dump(ui, "lock3.refused");

    // 4-5. A strong one: the meter climbs, the floor lets it through,
    //      and the confirm stage holds the password stashed in Rust.
    ui.set_password_value("H7$mQx2vB9nR4wZ".into());
    ui.invoke_password_edited();
    dev_dump(ui, "lock4.strong-meter");
    ui.invoke_password_next();
    dev_dump(ui, "lock5.confirm");

    // 6. A confirm that does not match: the TS sentence, stage unchanged.
    ui.set_confirm_value("something else".into());
    ui.invoke_create_submit();
    dev_dump(ui, "lock6.mismatch");

    // 7. The suggestion: both fields the same phrase, one stage skipped
    //    ahead, and the notice that says to write it down.
    goto(ui, state, Screen::CreatePassword);
    ui.invoke_suggest_password();
    dev_dump(ui, "lock7.suggested");

    // 8-9. The Sun/Moon: the resolved palette flips twice and the
    //      preference is written back each time, dark -> light -> dark.
    ui.invoke_toggle_theme();
    dev_dump(ui, "lock8.light");
    ui.invoke_toggle_theme();
    dev_dump(ui, "lock9.dark");

    // 10-13. `changed screen` clears the error, the two fields and the
    //        meter on every switch -- but a synchronous dump cannot tell a
    //        clear that is coming on the next frame from one that never
    //        comes, and lock5/lock7 above look like the latter. Two probes
    //        settle it: Back to the chooser and look again half a second
    //        later; then a suggestion, whose notice must survive its own
    //        screen switch, because a strip the user never gets to read is
    //        the same as no strip at all.
    ui.invoke_create_back();
    dev_dump(ui, "lock10.back-now");
    {
        let weak = ui.as_weak();
        let timer = slint::Timer::default();
        timer.start(
            slint::TimerMode::SingleShot,
            std::time::Duration::from_millis(500),
            move || {
                if let Some(ui) = weak.upgrade() {
                    dev_dump(&ui, "lock11.back-frame");
                    ui.invoke_create_with_password();
                    ui.invoke_suggest_password();
                    dev_dump(&ui, "lock12.suggest-now");
                }
            },
        );
        std::mem::forget(timer);
        let weak = ui.as_weak();
        let timer = slint::Timer::default();
        timer.start(
            slint::TimerMode::SingleShot,
            std::time::Duration::from_millis(1000),
            move || {
                if let Some(ui) = weak.upgrade() {
                    dev_dump(&ui, "lock13.suggest-frame");
                }
            },
        );
        std::mem::forget(timer);
    }
}

/// The logins `--render-check` draws.
///
/// Deliberately not `demo_drafts`, which is `debug_assertions`-only: a release
/// build has to be able to run the check without shipping the demo profile.
/// Three logins are enough -- a favourite (the pinned card), a weak reused
/// password (so the dashboard's issue ring has something to count) and a
/// note-only login with no username -- because what is being checked is that
/// each screen builds, not what it says.
fn render_check_drafts() -> Vec<serde_json::Value> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let row = |title: &str, username: &str, url: &str, password: &str, extra: serde_json::Value| {
        let mut draft = serde_json::json!({
            "title": title,
            "username": username,
            "url": url,
            "password": password,
            // `add_item` spreads the draft over `emptyItem`, whose own stamps
            // are "now", so every age the screens report comes from here.
            "createdAt": now - 90 * 86_400_000i64,
            "updatedAt": now - 86_400_000i64,
            "passwordUpdatedAt": now - 86_400_000i64,
            "usernameUpdatedAt": now - 86_400_000i64,
        });
        draft
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        draft
    };

    vec![
        row(
            "Favourite",
            "iraveos@example.com",
            "https://example.com",
            "9x!Km2$vQpLz7Rw",
            serde_json::json!({ "favorite": true, "showMail": true }),
        ),
        row(
            "Weak",
            "iraveos",
            "https://weak.example.com",
            "password",
            serde_json::json!({ "tags": ["work"] }),
        ),
        row(
            "Note only",
            "",
            "",
            "zZ4#nQ8!tV2@wX6&",
            serde_json::json!({ "notes": "The gate code is on the fridge." }),
        ),
    ]
}

/// `--render-check`: brings up every screen the app can show, in one process,
/// against a throwaway vault, and reports.
///
/// This is not a pixel golden. A golden needs a screen capture and this
/// environment cannot take one -- GDI's `CopyFromScreen` answers "The handle is
/// invalid" -- so what is checked is the wire between Rust and the `.slint`
/// files: every screen's models and scalars are built by the same code that
/// builds them in anger, and Slint raises on a binding whose value does not
/// type-check. A screen that comes up is a screen whose Rust half ran.
///
/// The profile is a scratch one: `main` points `COLAX_DEV_DIR` at a temp
/// directory before anything reads `app_dir()`, so the real vault is never
/// touched. Every step is synchronous, so no event loop is needed -- the check
/// walks the screens and exits with 0 when they all came up.
fn render_check(ui: &MainWindow, state: &Shared) -> i32 {
    let mut lines: Vec<String> = Vec::new();
    let mut failures: Vec<String> = Vec::new();

    // A vault with content, so no screen draws its empty state by accident.
    let seeded = {
        let mut guard = state.borrow_mut();
        let before: Vec<VaultItem> = guard
            .engine
            .items()
            .map(|items| items.to_vec())
            .unwrap_or_default();
        let result = (|| -> Result<(), VaultError> {
            if !guard.engine.exists() {
                guard.engine.create(None)?;
            } else if !guard.engine.is_unlocked() {
                guard.engine.unlock("")?;
            }
            if guard.engine.items().map(|items| items.is_empty()).unwrap_or(true) {
                for draft in render_check_drafts() {
                    guard.engine.add_item(&draft)?;
                }
            }
            Ok(())
        })();
        (result, before)
    };
    let before = match seeded {
        (Ok(()), before) => before,
        (Err(err), _) => {
            eprintln!("render-check: cannot open the scratch vault: {err}");
            return 1;
        }
    };
    record_history(ui, state, &before);
    lines.push(format!(
        "vault: {} logins",
        state.borrow().engine.items().map(|items| items.len()).unwrap_or(0)
    ));

    // Every screen that is not the vault, in the order they can appear.
    for screen in [
        Screen::Error,
        Screen::CreateChoose,
        Screen::CreatePassword,
        Screen::CreateConfirm,
        Screen::UnlockPassword,
        Screen::UnlockDevice,
        Screen::ImportPassword,
    ] {
        goto(ui, state, screen);
        let got = ui.get_screen();
        if got != screen {
            failures.push(format!("{screen:?}: the window holds {got:?}"));
        }
        lines.push(format!("{screen:?}"));
    }

    // The vault itself: the four presentations, then the search states.
    goto(ui, state, Screen::Vault);
    for view in ["animated", "carousel", "basic", "grid"] {
        ui.set_vault_view(view.into());
        refresh_items(ui, state);
        let cards = ui.get_cards().row_count();
        if cards == 0 {
            failures.push(format!("view {view}: no cards"));
        }
        lines.push(format!(
            "vault/{view}: {cards} cards, {} rail rows",
            ui.get_sidebar().row_count()
        ));
    }
    ui.set_search_text("zzzz-no-match".into());
    refresh_items(ui, state);
    let no_match_title = ui.get_cards_empty_title().to_string();
    let no_match_hint = ui.get_cards_empty_hint().to_string();
    if no_match_title != "No matches" {
        failures.push(format!(
            "search/no-match: titled {no_match_title:?}, expected \"No matches\""
        ));
    }
    lines.push(format!(
        "search/no-match: {} cards, {no_match_title:?} / {no_match_hint:?}",
        ui.get_cards().row_count()
    ));
    ui.set_search_text("".into());
    refresh_items(ui, state);
    lines.push(format!(
        "search/cleared: {} cards, titled {:?}",
        ui.get_cards().row_count(),
        ui.get_cards_empty_title()
    ));

    // Every destination the rail offers, the two built-ins included: the
    // dashboard and the history are channels here, not screens.
    for channel in colax_core::builtin_channels() {
        ui.set_active_channel(channel.id.as_str().into());
        refresh_items(ui, state);
        lines.push(format!(
            "channel/{}: {:?} dashboard={} history={}",
            channel.id,
            ui.get_channel_name(),
            ui.get_show_dashboard(),
            ui.get_show_history()
        ));
    }
    let user_channels: Vec<String> = items::prefs_from(state.borrow().engine.preferences())
        .channels
        .iter()
        .map(|channel| channel.id.clone())
        .collect();
    for id in user_channels {
        ui.set_active_channel(id.as_str().into());
        refresh_items(ui, state);
        lines.push(format!("channel/{id}: {:?}", ui.get_channel_name()));
    }

    // The merged sections (channels.ts ALL_LOGIN_TABS): the strip is a
    // feature of All logins, so each tab is read on it — the model's tab
    // count and the count pill, plus the empty state the section owns.
    ui.set_active_channel("all".into());
    for tab in ["all", "favorites", "attention", "weak"] {
        ui.set_all_tab(tab.into());
        refresh_items(ui, state);
        let counts = ui.get_all_tabs();
        let pill = (0..counts.row_count())
            .filter_map(|i| counts.row_data(i))
            .find(|row| row.kind == tab)
            .map(|row| row.count)
            .unwrap_or(-1);
        lines.push(format!(
            "strip/{tab}: tabs={} count={pill}",
            counts.row_count()
        ));
    }
    ui.set_all_tab("all".into());
    refresh_items(ui, state);

    // Settings, every section and every tab: the dock manager lives in Layout.
    for section in ["", "layout", "desktop", "generator", "alarms", "security"] {
        settings_ops::open(ui, state, section);
        lines.push(format!(
            "settings/{section}: open={}",
            ui.get_settings_open()
        ));
    }
    for tab in 0..12 {
        settings_ops::tab_picked(ui, tab);
        settings_ops::refresh(ui, state);
        lines.push(format!(
            "settings/tab {tab}: index={}",
            ui.get_settings_tab_index()
        ));
    }
    dock::push(ui, state);
    lines.push(format!(
        "dock: {} bars, {} manager rows",
        ui.get_dock_bars().row_count(),
        ui.get_dock_rows().row_count()
    ));

    // The overlays: menus, the tuner and the shortcut sheet.
    let first = ui.get_cards().row_data(0).map(|card| card.id.to_string());
    if let Some(id) = &first {
        menus::open_item_menu(ui, state, id, 12.0, 12.0);
        lines.push(format!(
            "menu/item: open={} rows={}",
            ui.get_menu_open(),
            ui.get_menu_root_rows().row_count()
        ));
        menus::close(ui);
    } else {
        failures.push("menu/item: no card to hang a menu on".to_string());
    }
    menus::open_app_menu(ui, state, 12.0, 12.0);
    lines.push(format!(
        "menu/app: open={} rows={}",
        ui.get_menu_open(),
        ui.get_menu_root_rows().row_count()
    ));
    menus::close(ui);
    if let Some(dock_id) = ui.get_dock_bars().row_data(0).map(|bar| bar.id.to_string()) {
        menus::open_dock_menu(ui, state, &dock_id, 12.0, 12.0);
        lines.push(format!("menu/dock: open={}", ui.get_menu_open()));
        menus::close(ui);
        menus::open_dock_add_menu(ui, state, &dock_id, 12.0, 12.0);
        lines.push(format!("menu/dock-add: open={}", ui.get_menu_open()));
        menus::close(ui);
    } else {
        failures.push("menu/dock: no bar to hang a menu on".to_string());
    }
    tuner::open(ui, state, Some("grid"));
    lines.push(format!("tuner: open={}", ui.get_show_tuner()));
    tuner::close(ui);
    shortcuts::open_sheet(ui);
    lines.push(format!(
        "shortcuts: open={} rows={}",
        ui.get_show_shortcuts(),
        ui.get_shortcut_rows().row_count()
    ));
    ui.set_show_shortcuts(false);

    // The editor, on a real login.
    if let Some(id) = &first {
        open_editor(ui, state, id);
        let opened = ui.get_screen() == Screen::Editor;
        if !opened {
            failures.push("editor: did not open".to_string());
        }
        lines.push(format!(
            "editor: {}",
            if opened { "open" } else { "missing" }
        ));
        editor_cancel(ui, state);
    } else {
        failures.push("editor: no card to edit".to_string());
    }

    for line in &lines {
        println!("render-check: {line}");
    }
    for failure in &failures {
        eprintln!("render-check: FAIL {failure}");
    }
    println!(
        "render-check: {} checks, {} failures",
        lines.len(),
        failures.len()
    );
    if failures.is_empty() { 0 } else { 1 }
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
            // A new vault is an open vault, so the countdown arms for it
            // the same as an unlock.
            sync_auto_lock(ui, state);
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
            // The vault is open now, so the idle countdown arms -- with the
            // minutes as they came back out of that re-read.
            sync_auto_lock(ui, state);
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
        // The minutes may have just changed; `useAutoLock` re-runs its
        // effect on the same edit (hooks.ts L636).
        sync_auto_lock(ui, state);
    }
    saved
}

/// One use of a login (copied or edited): the count behind the dashboard's
/// "most used" and "recent account activity" (`recordUse`, hooks.ts L258).
///
/// Deliberately not part of any undo history — undoing "copy password"
/// makes no sense — and it prunes entries for logins that no longer exist,
/// which the normaliser cannot: a load only sees shapes, this is what sees
/// the items.
fn record_use(ui: &MainWindow, state: &Shared, id: &str) {
    if id.is_empty() {
        return;
    }
    let now = colax_core::util::now_ms();
    let (mut prefs, known) = {
        let guard = state.borrow();
        let known: std::collections::HashSet<String> = guard
            .engine
            .items()
            .map(|items| items.iter().map(|item| item.id.clone()).collect())
            .unwrap_or_default();
        (items::prefs_from(guard.engine.preferences()), known)
    };
    prefs.usage.retain(|key, _| known.contains(key));
    let count = prefs.usage.get(id).map(|entry| entry.count).unwrap_or(0) + 1;
    prefs.usage
        .insert(id.to_string(), colax_core::UsageEntry { count, at: now });
    // The cap is applied here too — by recency — so the stored document is
    // already within bounds before the next read sees it.
    if prefs.usage.len() > 200 {
        let mut by_recency: Vec<(String, colax_core::UsageEntry)> = prefs
            .usage
            .iter()
            .map(|(key, entry)| (key.clone(), *entry))
            .collect();
        by_recency.sort_by(|a, b| b.1.at.cmp(&a.1.at).then(a.0.cmp(&b.0)));
        prefs.usage = by_recency.into_iter().take(200).collect();
    }
    save_prefs(ui, state, &prefs);
}

/* ---- The History channel (Task 7.2) -------------------------------------- */

/// Writes one mutation into the History channel's log — the `mutate`
/// wrapper of `hooks.ts` L188-201: every item write passes the list as it
/// stood before, and this diffs it against the list now, so no call site
/// can forget to log what it changed. A write that changed nothing (a
/// re-save of identical data) produces no events and no preference write.
fn record_history(ui: &MainWindow, state: &Shared, before: &[VaultItem]) {
    let events = {
        let guard = state.borrow();
        let Some(items) = guard.engine.items() else { return };
        colax_core::history_events_for(before, items, colax_core::util::now_ms())
    };
    if events.is_empty() {
        return;
    }
    // A write that changed something is undoable: snapshot the state it is
    // moving away from, before this call's own log entry is added (so undoing
    // takes that entry back too, as the TS's pre-change snapshot does). The
    // redo stack belongs to a branch that no longer exists once a fresh change
    // lands.
    {
        let mut guard = state.borrow_mut();
        let prefs = guard.engine.preferences().clone();
        guard.undo_stack.push(UndoSnapshot {
            items: before.to_vec(),
            prefs,
        });
        if guard.undo_stack.len() > 50 {
            guard.undo_stack.remove(0);
        }
        guard.redo_stack.clear();
    }
    let mut prefs = {
        let guard = state.borrow();
        items::prefs_from(guard.engine.preferences())
    };
    prefs.history = colax_core::append_history(&prefs.history, &events);
    save_prefs(ui, state, &prefs);
}

/// Ctrl+Z: put the previous snapshot back -- `restore`, the `replaceItems` +
/// `savePreferences` pair of hooks.ts L217-226. Where the change being left
/// stood is pushed onto the redo stack first, so Ctrl+Shift+Z can return to
/// it. Nothing is logged: an undo is not itself a change to log, which is why
/// the TS keeps `restore` apart from `mutate`.
///
/// Returns whether there was anything to undo, which the caller turns into the
/// "Undone" toast.
pub(crate) fn undo(ui: &MainWindow, state: &Shared) -> bool {
    let snapshot = {
        let mut guard = state.borrow_mut();
        let Some(snapshot) = guard.undo_stack.pop() else {
            return false;
        };
        push_current(&mut guard, false);
        snapshot
    };
    apply_snapshot(ui, state, snapshot);
    notice(ui, "Undone");
    true
}

/// Ctrl+Shift+Z / Ctrl+Y: the other way along the same two stacks.
pub(crate) fn redo(ui: &MainWindow, state: &Shared) -> bool {
    let snapshot = {
        let mut guard = state.borrow_mut();
        let Some(snapshot) = guard.redo_stack.pop() else {
            return false;
        };
        push_current(&mut guard, true);
        snapshot
    };
    apply_snapshot(ui, state, snapshot);
    notice(ui, "Redone");
    true
}

/// Move the live document onto one of the stacks before a restore. `onto_undo`
/// says which: an undo sends the current state to the redo stack, a redo sends
/// it back to the undo stack.
fn push_current(guard: &mut AppState, onto_undo: bool) {
    let items = guard
        .engine
        .items()
        .map(|items| items.to_vec())
        .unwrap_or_default();
    let prefs = guard.engine.preferences().clone();
    let stack = if onto_undo {
        &mut guard.undo_stack
    } else {
        &mut guard.redo_stack
    };
    stack.push(UndoSnapshot { items, prefs });
    if stack.len() > 50 {
        stack.remove(0);
    }
}

/// Write a snapshot back and repaint everything it can have touched: the
/// cards and rail (`items`), the look and the idle countdown (`prefs`).
fn apply_snapshot(ui: &MainWindow, state: &Shared, snapshot: UndoSnapshot) {
    {
        let mut guard = state.borrow_mut();
        if guard.engine.replace_items(snapshot.items).is_err() {
            notice(ui, "Could not restore");
            return;
        }
        let _ = guard.engine.save_preferences(snapshot.prefs);
    }
    refresh_items(ui, state);
    refresh_appearance(ui, state);
    sync_auto_lock(ui, state);
}

/// `Clear log` — the whole log goes at once, event count and all. No
/// confirmation in the TS either (`onClear`, HistoryPanel.tsx L140-147).
fn history_clear(ui: &MainWindow, state: &Shared) {
    if ui.get_busy() {
        return;
    }
    let mut prefs = {
        let guard = state.borrow();
        items::prefs_from(guard.engine.preferences())
    };
    if prefs.history.is_empty() {
        return;
    }
    prefs.history.clear();
    save_prefs(ui, state, &prefs);
    refresh_items(ui, state);
}

/// `Forget` — one row leaves the log, everything else stays (`onForget`).
fn history_forget(ui: &MainWindow, state: &Shared, id: &str) {
    if ui.get_busy() {
        return;
    }
    let mut prefs = {
        let guard = state.borrow();
        items::prefs_from(guard.engine.preferences())
    };
    let had = prefs.history.len();
    prefs.history.retain(|event| event.id != id);
    if prefs.history.len() == had {
        return;
    }
    save_prefs(ui, state, &prefs);
    refresh_items(ui, state);
}

/// `Restore` — the row's stored version writes back over whatever stands
/// there now, deleted or not (`onRestore`; the undo strip reaches the same
/// engine call through `undo_delete`). The log records the put-back as its
/// own row, the way the TS's `mutate` would.
fn history_restore(ui: &MainWindow, state: &Shared, id: &str) {
    if ui.get_busy() {
        return;
    }
    let stored = {
        let guard = state.borrow();
        items::prefs_from(guard.engine.preferences())
            .history
            .iter()
            .find(|event| event.id == id)
            .and_then(|event| event.before.clone())
    };
    // A row with no stored version has nothing to put back — its button is
    // not drawn, and a race that reaches here changes nothing.
    let Some(item) = stored else { return };
    let title = item.title.clone();

    ui.set_busy(true);
    let (result, before) = {
        let mut guard = state.borrow_mut();
        let before: Vec<VaultItem> = guard
            .engine
            .items()
            .map(|items| items.to_vec())
            .unwrap_or_default();
        let result = guard.engine.restore_item(&item).map(|_| ());
        (result, before)
    };
    ui.set_busy(false);

    match result {
        Ok(()) => {
            record_history(ui, state, &before);
            refresh_items(ui, state);
            notice(ui, format!("Restored \u{201c}{title}\u{201d}.").as_str());
        }
        Err(err) => ui.set_error_text(err.to_string().as_str().into()),
    }
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

/// The Desktop tab's write path: the ordinary boolean write, plus the shell
/// mirror when the key is one of the four the tab owns. Those are the only
/// preferences stored twice -- `mirror_shell_flags` writes `shell.json`, the
/// Run key and the vault document -- and the mirror only runs when the write
/// really happened, so a refused or near-miss key cannot leave the two copies
/// disagreeing.
fn settings_bool(ui: &MainWindow, state: &Shared, key: &str, value: bool) {
    if !settings_ops::pref_bool(ui, state, key, value) {
        return;
    }
    if !settings_ops::is_shell_flag(key) {
        return;
    }
    let prefs = {
        let guard = state.borrow();
        items::prefs_from(guard.engine.preferences())
    };
    let mut shell = read_state();
    mirror_shell_flags(ui, state, &mut shell, &prefs);
}

/// The tray follows the two preferences that describe it the moment either
/// moves. `trayEnabled` needs it most: a switch that only takes effect on the
/// next launch is the dead control the TS's Desktop tab is careful about, and
/// Slint's own `SystemTrayIcon` is what shows and hides it. `soundsMuted` is
/// the menu item's own label, which has to read the same flag the switch does.
fn sync_tray(tray: &Weak<AppTray>, state: &Shared) {
    let Some(tray) = tray.upgrade() else { return };
    let prefs = {
        let guard = state.borrow();
        items::prefs_from(guard.engine.preferences())
    };
    // Errors here are the shell refusing the icon; there is nothing the app
    // can do about it, and the preference is already stored either way.
    if prefs.tray_enabled {
        let _ = tray.show();
    } else {
        let _ = tray.hide();
    }
    tray.set_muted(prefs.sounds_muted);
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
            // ...the four shell flags included, so a backup from a machine
            // that kept its tray on lands on this one with the icon up.
            sync_tray(tray, state);
            // ...including its auto-lock minutes, and the vault is open.
            sync_auto_lock(ui, state);
            notice(ui, "Backup imported.");
        }
        Err(VaultError::Auth) => {
            ui.set_password_value("".into());
            ui.set_error_text("That backup password is not correct.".into());
        }
        Err(err) => ui.set_error_text(err.to_string().into()),
    }
}

/// Settings › Data's confirmed "Delete everything" — `resetVault` in the TS
/// (hooks.ts L291) driven from the Data tab's sheet: the clipboard is wiped,
/// the document and its key are forgotten, the shipped preferences come
/// back, everything repaints, and the app lands on first-run setup.
fn settings_data_reset(ui: &MainWindow, state: &Shared, tray: &Weak<AppTray>) {
    ui.set_settings_data_reset_open(false);
    settings_ops::close(ui);
    // Before the erase, not after: whatever is on the clipboard was copied
    // out of a login that is about to not exist.
    let _ = platform::copy_text("");
    {
        let mut guard = state.borrow_mut();
        let _ = guard.engine.reset();
        guard.pending_backup = None;
        guard.settings_restore = None;
        // The undo offering and the gate are both proof of a vault that is
        // gone; the two staged keys are secrets of the same gone world.
        guard.last_deleted = None;
        // The undo history is of the vault that is gone too: replaying it
        // would put the wiped logins back.
        guard.undo_stack.clear();
        guard.redo_stack.clear();
        guard.vault_staged_seed = None;
        guard.editor_staged_seed = None;
        guard.gate = None;
    }
    // The defaults carry the appearance, so the repaint starts there.
    refresh_appearance(ui, state);
    refresh_items(ui, state);
    tray_lock_enabled(tray, true);
    sync_tray(tray, state);
    sync_auto_lock(ui, state);
    goto(ui, state, Screen::CreateChoose);
    notice(ui, "All data deleted from this device");
}

/// Settings › Backup's restore submit — the gate's engine call with the
/// sheet's own re-key options, landing back in the sheet's world: the app
/// stays where it is, everything the backup carries is repainted, and the
/// toast is the settings one (Settings.tsx L2659-2675; the TS `onDone`
/// notifies and navigates nowhere).
fn settings_data_restore_submit(ui: &MainWindow, state: &Shared, tray: &Weak<AppTray>) {
    let text = state
        .borrow()
        .settings_restore
        .as_ref()
        .map(|(text, _)| text.clone());
    let Some(text) = text else { return };
    let backup = match colax_core::parse_backup(&text) {
        Ok(backup) => backup,
        Err(_) => {
            ui.set_settings_data_restore_error("Could not restore that file.".into());
            return;
        }
    };
    let password = ui.get_settings_data_restore_password().to_string();
    let passwordless = ui.get_settings_data_restore_passwordless();
    let rekey = ui.get_settings_data_restore_rekey();
    let next = ui.get_settings_data_restore_next().to_string();
    let new_password: Option<&str> = if passwordless {
        Some("")
    } else if rekey {
        Some(next.as_str())
    } else {
        None
    };
    ui.set_settings_data_restore_busy(true);
    let result = {
        state
            .borrow_mut()
            .engine
            .restore_backup(&backup, Some(&password), new_password)
    };
    ui.set_settings_data_restore_busy(false);
    match result {
        Ok(()) => {
            state.borrow_mut().settings_restore = None;
            // The sheet's fields are spent; the empty name closes it. (The
            // TS unmounts the modal with its own state.)
            ui.set_settings_data_restore_name("".into());
            ui.set_settings_data_restore_error("".into());
            ui.set_settings_data_restore_password("".into());
            ui.set_settings_data_restore_passwordless(false);
            ui.set_settings_data_restore_rekey(false);
            ui.set_settings_data_restore_next("".into());
            ui.set_settings_data_restore_ready(false);
            // The backup carries its own preferences and logins: repaint the
            // app, the sidebar and the still-open window over it.
            refresh_appearance(ui, state);
            refresh_items(ui, state);
            settings_ops::refresh(ui, state);
            tray_lock_enabled(tray, true);
            sync_tray(tray, state);
            sync_auto_lock(ui, state);
            notice(ui, "Vault restored from backup");
        }
        Err(VaultError::Auth) => {
            ui.set_settings_data_restore_error(
                "That password does not unlock this backup file.".into(),
            );
        }
        Err(err) => ui.set_settings_data_restore_error(err.to_string().as_str().into()),
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

/* ==========================================================================
Clipboard -- `useClipboard` (hooks.ts L570)
========================================================================== */

// The armed auto-clear: one timer for the whole app, restarted by every
// copy so the *newest* copy is the one with a deadline (`clearTimeout` in
// hooks.ts L585 -- `Timer::start` restarts in place, which is the same
// thing). The text it armed with is remembered because the wipe is
// conditional: at the deadline the clipboard is read back and only
// cleared if it still holds what we put there (Task 6.4's "only if the
// clipboard still holds our own write" -- a password copied out of
// another app in the meantime is not ours to destroy; TS writes the
// clear unconditionally, and would wipe it).
thread_local! {
    static CLIP_CLEAR: RefCell<ClipboardClear> = RefCell::new(ClipboardClear {
        timer: slint::Timer::default(),
        last: String::new(),
    });
}

struct ClipboardClear {
    timer: slint::Timer,
    /// What the armed write put on the clipboard.
    last: String,
}

/// The one place a value reaches the clipboard: the write, the toast
/// (unless `copyToasts` is off), and the auto-clear deadline from
/// `clearClipboardSeconds` (0 = keep it).
fn copy_to_clipboard(ui: &MainWindow, state: &Shared, value: &str, label: &str) {
    let prefs = {
        let guard = state.borrow();
        colax_core::normalise_preferences(guard.engine.preferences())
    };
    arm_clipboard_clear(ui, value, label, prefs.clear_clipboard_seconds, prefs.copy_toasts);
}

/// The write itself, with the deadline handed over: the dev walk passes
/// its own seconds so it need not sit out the shipped thirty.
fn arm_clipboard_clear(ui: &MainWindow, value: &str, label: &str, clear_seconds: f64, toasts: bool) {
    if value.is_empty() {
        return;
    }
    if !platform::copy_text(value) {
        // Not a toast: TS notifies the failure before the toast flag is
        // ever consulted (hooks.ts L580), and so do we.
        ui.set_error_text("Could not access the clipboard.".into());
        return;
    }
    if toasts {
        notice(ui, &format!("{label} copied."));
    }
    CLIP_CLEAR.with(|slot| {
        let mut entry = slot.borrow_mut();
        entry.last = value.to_string();
        // A new copy moves the deadline; 0 seconds is the "never" choice
        // and stops the old deadline along with arming nothing new.
        entry.timer.stop();
        if clear_seconds > 0.0 {
            let duration = std::time::Duration::from_secs_f64(clear_seconds);
            entry
                .timer
                .start(slint::TimerMode::SingleShot, duration, || {
                    CLIP_CLEAR.with(|slot| {
                        let entry = slot.borrow();
                        // Only still-our-text is wiped: the read-back is
                        // what makes an unrelated copy in the meantime
                        // safe (Task 6.4).
                        if platform::read_text().as_deref() == Some(entry.last.as_str()) {
                            let _ = platform::copy_text("");
                        }
                    });
                });
        }
    });
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

    // Reaching for a login counts as a use — the clipboard's outcome is
    // another matter (`touchLogin`, App.tsx L1759).
    record_use(ui, state, id);

    if password.is_empty() {
        notice(ui, "This login has no password.");
    } else {
        copy_to_clipboard(ui, state, &password, "Password");
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

/// The lock card's meter: the same estimator the editor's meter reads,
/// pushed to its own props because the lock screens and the editor never
/// share a screen but do share a window. -1 means "nothing typed yet",
/// which the widget renders as no meter at all.
fn push_lock_strength(ui: &MainWindow, password: &str) {
    if password.is_empty() {
        ui.set_lock_strength_score(-1);
        ui.set_lock_strength_label("".into());
        ui.set_lock_strength_bits("".into());
        ui.set_lock_strength_crack("".into());
        return;
    }
    let strength = estimate_strength(password);
    ui.set_lock_strength_score(strength.score as i32);
    ui.set_lock_strength_label(strength.label.as_str().into());
    ui.set_lock_strength_bits(strength.bits.to_string().into());
    ui.set_lock_strength_crack(strength.crack_time.as_str().into());
}

/// "Suggest a strong vault password" (LockScreen.tsx L96-103): a seven-
/// word passphrase plus four digits, dropped into both fields and taken
/// straight to confirm -- a password the user never had to type cannot be
/// mistyped. The values land *after* the screen change, whose handler
/// clears the fields the switch wiped.
fn suggest_password(ui: &MainWindow, state: &Shared) {
    if ui.get_busy() || ui.get_screen() != Screen::CreatePassword {
        return;
    }
    let suggestion = colax_core::suggest_master_password(7);
    state.borrow_mut().pending_password = suggestion.clone();
    goto(ui, state, Screen::CreateConfirm);
    ui.set_password_value(suggestion.clone().into());
    ui.set_confirm_value(suggestion.as_str().into());
    push_lock_strength(ui, &suggestion);
    notice(
        ui,
        "Suggested vault password set \u{2014} save it somewhere safe now",
    );
}

/// The lock card's Sun/Moon: flips the *resolved* theme dark <-> light
/// and writes that as the preference, exactly as the TS toggle reads
/// `dataset.theme` and writes the opposite (App.tsx L2750-2753). A
/// `system` vault therefore lands on an explicit dark or light on the
/// user's word. Preferences are readable and writable at every lock
/// state, so this works before the first vault exists too.
fn toggle_theme(ui: &MainWindow, state: &Shared) {
    let resolved = ui.global::<Theme>().get_resolved_theme().to_string();
    let next = if resolved == "dark" { "light" } else { "dark" };
    let mut prefs = {
        let guard = state.borrow();
        colax_core::normalise_preferences(guard.engine.preferences())
    };
    prefs.theme = next.to_string();
    save_prefs(ui, state, &prefs);
}

/// Re-rolls the generator from the options currently in the UI and pushes
/// the value, its mask and its strength together.
///
/// Everything the generator shows is written here, in one place, so the
/// preview can never be one password while the meter describes another.
fn regenerate(ui: &MainWindow) {
    // The read-outs are the TS's own: `{options.length}` beside the random
    // slider and `${words} words` beside the word one (ItemEditor.tsx L150-152).
    ui.set_gen_length_label(
        format!("{}", ui.get_gen_length().round().max(0.0) as i64).as_str().into(),
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
    // The generator's options are the stored preference, so they are read off
    // the document as the editor opens -- "Default length: used when the
    // generator opens" (Settings.tsx L1206) is exactly this line.
    settings_ops::refresh_generator(ui, state);

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
    let (result, before) = {
        let mut guard = state.borrow_mut();
        let before: Vec<VaultItem> = guard
            .engine
            .items()
            .map(|items| items.to_vec())
            .unwrap_or_default();
        let result = if id.is_empty() {
            guard.engine.add_item(&patch).map(|item| item.id)
        } else {
            guard.engine.update_item(&id, &patch).map(|item| item.id)
        };
        (result, before)
    };
    ui.set_busy(false);

    match result {
        Ok(saved_id) => {
            // The write goes through History the way `mutate` wraps every
            // write in the TS (hooks.ts L188-201): the before-list through
            // one diff, so no save can go unlogged.
            record_history(ui, state, &before);
            // Saving counts as a use — a create too (`touchLogin` on both,
            // App.tsx L3612/L3630) — which is what "recent account
            // activity" and "most used" read.
            record_use(ui, state, &saved_id);
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
    let (deleted, result, before) = {
        let mut guard = state.borrow_mut();
        let before: Vec<VaultItem> = guard
            .engine
            .items()
            .map(|items| items.to_vec())
            .unwrap_or_default();
        let deleted = guard
            .engine
            .items()
            .and_then(|items| items.iter().find(|item| item.id == id))
            .cloned();
        let result = guard.engine.delete_item(&id);
        (deleted, result, before)
    };
    ui.set_busy(false);

    match result {
        Ok(()) => {
            let title = deleted
                .as_ref()
                .map(|item| item.title.clone())
                .unwrap_or_default();
            state.borrow_mut().last_deleted = deleted;
            // The row carries the login itself into the log (storage.ts
            // L407): that snapshot is the only copy left once the record is
            // gone from storage.
            record_history(ui, state, &before);
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
    let (result, before) = {
        let mut guard = state.borrow_mut();
        let before: Vec<VaultItem> = guard
            .engine
            .items()
            .map(|items| items.to_vec())
            .unwrap_or_default();
        let result = guard.engine.restore_item(&item).map(|_| ());
        (result, before)
    };
    ui.set_busy(false);
    ui.set_undo_text("".into());

    match result {
        Ok(()) => {
            record_history(ui, state, &before);
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
    let (result, before) = {
        let mut guard = state.borrow_mut();
        let before: Vec<VaultItem> = guard
            .engine
            .items()
            .map(|items| items.to_vec())
            .unwrap_or_default();
        let result = guard
            .engine
            .update_item(id, &serde_json::json!({ "favorite": next }))
            .map(|_| ());
        (result, before)
    };
    match result {
        Ok(()) => {
            // A star is an edit: `update_item` moves `updatedAt` and the
            // content moved with it, so the log takes a row — the TS wraps
            // this same call in `mutate` (App.tsx L1679).
            record_history(ui, state, &before);
            refresh_items(ui, state);
        }
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

fn editor_copy_generated(ui: &MainWindow, state: &Shared) {
    if ui.get_screen() != Screen::Editor {
        return;
    }
    let value = ui.get_gen_value().to_string();
    if value.is_empty() {
        return;
    }
    copy_to_clipboard(ui, state, &value, "Password");
}

/// Lock: drop the key handle in the engine, then present the right unlock
/// screen.
///
/// The guard is whether there is anything left to seal, not which screen
/// is up: the editor and the import's password stage are both open while
/// unlocked, so "not the vault screen" can mean either "already sealed" or
/// "seal it from over here" -- and a lock that quietly does nothing when
/// the idle timer fires in the editor is a lock that does not exist.
fn lock_vault(ui: &MainWindow, state: &Shared) {
    if !state.borrow().engine.is_unlocked() {
        return;
    }
    let (screen, wipe_clipboard) = {
        let mut guard = state.borrow_mut();
        // Read before the key drops: the preference lives behind it, and
        // the clipboard goes down with the lock when it says so
        // (`clearClipboardOnLock` -- App.tsx L2972 wipes on lock too).
        let wipe_clipboard =
            colax_core::normalise_preferences(guard.engine.preferences()).clear_clipboard_on_lock;
        guard.engine.lock();
        // An undo offering to restore a row cannot outlive the lock: the
        // offer would still be on screen while the vault is sealed.
        guard.last_deleted = None;
        // Neither can the undo history, for the same reason: a snapshot is
        // plaintext standing outside the sealed engine.
        guard.undo_stack.clear();
        guard.redo_stack.clear();
        // Neither can the vault's proof: sealed again means asked again on
        // the next unlock (TS rebuilds `vaultVerified` along with the locked
        // component tree).
        guard.vault_verified = false;
        // A gate is proof-seeking for what is being sealed. Closing it here
        // is what stops a lock raised from the tray -- no backdrop sits in
        // front of that menu -- from parking the panel over the lock screen.
        guard.gate = None;
        (lock_screen_for(&guard.engine), wipe_clipboard)
    };
    // The wipe on the way down. An armed auto-clear keeps its own
    // deadline -- TS never cancels it either -- so this only answers
    // whether the lock takes what is on the clipboard *now*.
    if wipe_clipboard {
        let _ = platform::copy_text("");
    }
    ui.set_undo_text("".into());
    ui.set_gate_open(false);
    ui.set_gate_error("".into());
    goto(ui, state, screen);
    // Sealed again means the idle countdown has nothing left to guard, and
    // the next unlock arms it afresh.
    sync_auto_lock(ui, state);
}

/* ==========================================================================
Auto-lock -- `useAutoLock` (hooks.ts L632)
========================================================================== */

// The armed countdown, or nothing while there is nothing to guard.
//
// Slint cannot carry this signal itself: a `TouchArea` consumes the event
// it handles and nothing above it is told, so the UI has no window-wide
// "someone interacted" hook to subscribe to the way the TS build
// subscribes to `window` (hooks.ts L649). The same four kinds of input
// are taken from a thread-scoped Win32 hook on this window's own thread
// instead -- button presses, the wheel and real keys, with pointer moves
// left out, because a mouse parked over the window is not someone using
// it.
thread_local! {
    static AUTO_LOCK: RefCell<Option<AutoLock>> = const { RefCell::new(None) };
}

struct AutoLock {
    timer: slint::Timer,
    /// The minutes in force; 0 while the vault is sealed or the preference
    /// says never, which are the same thing as far as this is concerned.
    minutes: i64,
    ui: Weak<MainWindow>,
    state: std::rc::Weak<RefCell<AppState>>,
}

impl AutoLock {
    /// Restarts the countdown -- the `bump` of hooks.ts L644.
    fn bump(&self) {
        let Some(interval) = auto_lock_interval(self.minutes) else {
            return;
        };
        let ui = self.ui.clone();
        let state = self.state.clone();
        self.timer
            .start(slint::TimerMode::SingleShot, interval, move || {
                if let (Some(ui), Some(state)) = (ui.upgrade(), state.upgrade()) {
                    // `lock_vault` is the whole of what locking means here:
                    // the engine key goes, the proof and the undo offering
                    // with it, and the lock screen is derived from whatever
                    // protection the vault has.
                    lock_vault(&ui, &state);
                }
            });
    }
}

/// How long an idle vault has. The preference is minutes, 0 = never
/// (`AUTO_LOCK_CHOICES` in Settings.tsx L1266, whitelisted in prefs.rs);
/// `COLAX_DEV_AUTOLOCK=<seconds>` replaces them in debug builds so the
/// harness can watch a lock fire without sitting out five real minutes.
fn auto_lock_interval(minutes: i64) -> Option<std::time::Duration> {
    if minutes <= 0 {
        return None;
    }
    let seconds = minutes as u64 * 60;
    #[cfg(debug_assertions)]
    let seconds = dev_auto_lock_seconds().unwrap_or(seconds);
    Some(std::time::Duration::from_secs(seconds))
}

/// `COLAX_DEV_AUTOLOCK=<seconds>`'s own interval, or the preference's.
#[cfg(debug_assertions)]
fn dev_auto_lock_seconds() -> Option<u64> {
    std::env::var_os("COLAX_DEV_AUTOLOCK")
        .and_then(|value| value.to_str()?.parse::<u64>().ok())
        .filter(|seconds| *seconds > 0)
}

fn bump_auto_lock() {
    AUTO_LOCK.with(|slot| {
        if let Some(entry) = slot.borrow().as_ref() {
            entry.bump();
        }
    });
}

/// Every mouse message this window is about to see, minus the two that say
/// only that the cursor passed over it.
unsafe extern "system" fn auto_lock_mouse(
    code: i32,
    wparam: windows_sys::Win32::Foundation::WPARAM,
    _lparam: windows_sys::Win32::Foundation::LPARAM,
) -> windows_sys::Win32::Foundation::LRESULT {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, WM_MOUSEMOVE, WM_NCMOUSEMOVE,
    };
    if code >= 0 && !matches!(wparam as u32, WM_MOUSEMOVE | WM_NCMOUSEMOVE) {
        bump_auto_lock();
    }
    // The old-hook parameter is not read anymore; passing null chains to
    // whatever the next hook on this thread is.
    CallNextHookEx(core::ptr::null_mut(), code, wparam, _lparam)
}

/// The keyboard half. `wparam` here is the key, not the message: bit 31 of
/// `lparam` is the transition state, so a key going down is activity and
/// the release is not a second helping of it.
unsafe extern "system" fn auto_lock_key(
    code: i32,
    _wparam: windows_sys::Win32::Foundation::WPARAM,
    lparam: windows_sys::Win32::Foundation::LPARAM,
) -> windows_sys::Win32::Foundation::LRESULT {
    use windows_sys::Win32::UI::WindowsAndMessaging::CallNextHookEx;
    if code >= 0 && (lparam >> 31) & 1 == 0 {
        bump_auto_lock();
    }
    CallNextHookEx(core::ptr::null_mut(), code, _wparam, lparam)
}

/// Puts both hooks on the UI thread. A thread-scoped hook (a non-zero
/// thread id) needs no module handle and sees only the input arriving at
/// this thread's windows -- which is this window's input and nobody else's,
/// exactly the scope the TS `window` listeners have. The OS keeps the
/// hooks until the thread ends, which is when the process does.
fn install_auto_lock() {
    use windows_sys::Win32::System::Threading::GetCurrentThreadId;
    use windows_sys::Win32::UI::WindowsAndMessaging::{SetWindowsHookExW, WH_KEYBOARD, WH_MOUSE};
    let thread = unsafe { GetCurrentThreadId() };
    let mouse = unsafe {
        SetWindowsHookExW(
            WH_MOUSE,
            Some(auto_lock_mouse),
            core::ptr::null_mut(),
            thread,
        )
    };
    let keys = unsafe {
        SetWindowsHookExW(
            WH_KEYBOARD,
            Some(auto_lock_key),
            core::ptr::null_mut(),
            thread,
        )
    };
    debug_assert!(
        !mouse.is_null() && !keys.is_null(),
        "auto-lock input hooks did not install"
    );
}

/// Arms, re-arms or disarms the countdown. `useAutoLock` re-runs its
/// effect whenever the minutes or the unlocked state change (hooks.ts
/// L636), so this is called from the same three places: an unlock, a lock,
/// and a preference save.
fn sync_auto_lock(ui: &MainWindow, state: &Shared) {
    let minutes = {
        let guard = state.borrow();
        let minutes =
            colax_core::normalise_preferences(guard.engine.preferences()).auto_lock_minutes;
        if guard.engine.is_unlocked() {
            minutes
        } else {
            0
        }
    };
    AUTO_LOCK.with(|slot| {
        let mut slot = slot.borrow_mut();
        let entry = slot.get_or_insert_with(|| AutoLock {
            timer: slint::Timer::default(),
            minutes: 0,
            ui: ui.as_weak(),
            state: Rc::downgrade(state),
        });
        entry.ui = ui.as_weak();
        entry.state = Rc::downgrade(state);
        entry.minutes = minutes;
        if minutes > 0 {
            entry.bump();
        } else {
            entry.timer.stop();
        }
    });
}

/// Debug-only: watch an idle lock fire and a press hold it off, without a
/// human sitting through five real minutes. `COLAX_DEV_AUTOLOCK=<seconds>`
/// sets the interval this walk times against.
#[cfg(debug_assertions)]
fn dev_autolock(ui: &MainWindow, state: &Shared) {
    use std::time::Duration;
    let _ = std::fs::remove_file(app_dir().join("dev-dump.txt"));

    // 1-2. Seal and unlock the seeded vault: the countdown arms, and with
    //      no input at all it expires and the lock screen is back.
    lock_vault(ui, state);
    unlock_with(ui, state, "");
    dev_dump(ui, "al1.unlocked");
    let weak = ui.as_weak();
    let st = state.clone();
    let timer = slint::Timer::default();
    timer.start(
        slint::TimerMode::SingleShot,
        Duration::from_millis(1400),
        move || {
            let Some(ui) = weak.upgrade() else { return };
            dev_dump(&ui, "al2.idle-sealed");

            // 3-4. Unlock once more, then put one button press on this
            //     thread's own queue. It is input, not a screen change, so
            //     the clock restarts: at the mark where al2 sealed, the
            //     vault is still open.
            unlock_with(&ui, &st, "");
            unsafe {
                use windows_sys::Win32::System::Threading::GetCurrentThreadId;
                use windows_sys::Win32::UI::WindowsAndMessaging::{
                    PostThreadMessageW, WM_LBUTTONDOWN,
                };
                PostThreadMessageW(GetCurrentThreadId(), WM_LBUTTONDOWN, 0, 0);
            }
            dev_dump(&ui, "al3.bumped");
            let weak = ui.as_weak();
            let timer = slint::Timer::default();
            timer.start(
                slint::TimerMode::SingleShot,
                Duration::from_millis(600),
                move || {
                    let Some(ui) = weak.upgrade() else { return };
                    dev_dump(&ui, "al4.held-open");
                    let weak = ui.as_weak();
                    let timer = slint::Timer::default();
                    timer.start(
                        slint::TimerMode::SingleShot,
                        Duration::from_millis(1200),
                        move || {
                            if let Some(ui) = weak.upgrade() {
                                // 5. ...and the press only moved the clock:
                                //     once its minute is spent too, sealed
                                //     again.
                                dev_dump(&ui, "al5.sealed-again");
                            }
                        },
                    );
                    std::mem::forget(timer);
                },
            );
            std::mem::forget(timer);
        },
    );
    // Dropping the handle would cancel it before it fires.
    std::mem::forget(timer);
}

/// Debug-only: prove both clipboard wipes without a human watching a
/// thirty-second clock. `COLAX_DEV_CLIP=<seconds>` copies and waits out
/// that many of them; `COLAX_DEV_CLIP=lock` copies against a long
/// deadline and locks a beat later instead -- so in that mode only the
/// lock could have removed the text. The first dump must show it there,
/// the last must show it gone.
#[cfg(debug_assertions)]
fn dev_clip(ui: &MainWindow, state: &Shared) {
    use std::time::Duration;
    let _ = std::fs::remove_file(app_dir().join("dev-dump.txt"));

    // Same opening as the auto-lock walk: whatever state the seed left,
    // start sealed and reopened, so the dumps read `vault` and the lock
    // below has somewhere to go from. (The reopen's own lock wipe runs
    // against whatever was on the clipboard before -- the lock's job.)
    lock_vault(ui, state);
    unlock_with(ui, state, "");

    let mode = std::env::var("COLAX_DEV_CLIP").unwrap_or_default();
    let lock_mode = mode.trim().eq_ignore_ascii_case("lock");
    // The deadline the walk arms with: its own seconds, or a long one in
    // `lock` mode so the timer can never be the thing that wiped it.
    let seconds: f64 = if lock_mode {
        60.0
    } else {
        mode.parse::<f64>().ok().filter(|s| *s > 0.0).unwrap_or(3.0)
    };

    arm_clipboard_clear(ui, "devclip", "Password", seconds, true);
    dev_dump(ui, "clip1.copied");

    let weak = ui.as_weak();
    let st = state.clone();
    let timer = slint::Timer::default();
    timer.start(
        slint::TimerMode::SingleShot,
        Duration::from_millis(if lock_mode { 1200 } else { 1500 }),
        move || {
            let Some(ui) = weak.upgrade() else { return };
            if lock_mode {
                // The wipe on the way down: the text went on with a
                // minute's grace, so only the lock can have removed it.
                lock_vault(&ui, &st);
                dev_dump(&ui, "clip2.locked");
                return;
            }
            // Halfway to the deadline: still ours.
            dev_dump(&ui, "clip2.still-there");
            let weak = ui.as_weak();
            let timer = slint::Timer::default();
            timer.start(
                slint::TimerMode::SingleShot,
                Duration::from_millis(3500),
                move || {
                    if let Some(ui) = weak.upgrade() {
                        dev_dump(&ui, "clip3.cleared");
                    }
                },
            );
            std::mem::forget(timer);
        },
    );
    // Dropping the handle would cancel it before it fires.
    std::mem::forget(timer);
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
    // `--render-check` (Task 9.7) sweeps every screen and exits with a report.
    // It fills a vault, so it takes a scratch directory of its own unless the
    // caller already pointed `COLAX_DEV_DIR` at one -- the real profile is
    // never written to by the check.
    if std::env::args().any(|arg| arg == "--render-check") {
        if std::env::var_os("COLAX_DEV_DIR").is_none() {
            let dir = std::env::temp_dir().join("colax-render-check");
            let _ = std::fs::remove_dir_all(&dir);
            let _ = std::fs::create_dir_all(&dir);
            std::env::set_var("COLAX_DEV_DIR", &dir);
        }
        std::env::set_var("COLAX_RENDER_CHECK", "1");
    }

    let mut state_file = read_state();

    // Only ever re-affirmed at boot, never withdrawn: if no shell.json exists
    // yet but a Run entry does (set by an earlier build), starting this app
    // must not silently un-set it. Deletion happens on the user's switch.
    if state_file.launch_at_login {
        apply_autostart(true);
    }

    let ui = MainWindow::new()?;

    // The lock card's storage warning is decided here, once: the folder
    // either takes a write or it does not.
    ui.set_storage_persistent(storage_is_persistent());

    let tray = AppTray::new()?;

    // ---- Open the vault ---------------------------------------------------
    let mut startup_error: Option<String> = None;
    let app_state: Option<Shared> = match VaultEngine::open(VaultStorage::new(vault_path())) {
        Ok(engine) => {
            let state = Rc::new(RefCell::new(AppState {
                engine,
                pending_password: String::new(),
                pending_backup: None,
                settings_restore: None,
                last_deleted: None,
                undo_stack: Vec::new(),
                redo_stack: Vec::new(),
                editor_security: LoginSecurity::default(),
                editor_staged_seed: None,
                editor_prompt_index: 0,
                vault_staged_seed: None,
                vault_prompt_index: 0,
                editor_tags: Vec::new(),
                alarm_days: Vec::new(),
                alarm_sound: None,
                editor_password_updated_at: 0,
                editor_username_updated_at: 0,
                editor_panel_width: 0.0,
                // Wide enough for three grid columns before anything has
                // reported a width (the content area at the default window).
                vault_width: 800.0,
                gate: None,
                verified: HashSet::new(),
                vault_verified: false,
                background_pushed: None,
                channel_draft: None,
                channel_new: false,
                channel_editing: None,
                channel_tag_editing: None,
                channel_tag_hue: None,
                channel_ed_width: 0.0,
                dock_key_target: None,
                reorder_drag: None,
                reorder_drop: None,
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
                dev_screen(&ui, &state, &tray.as_weak());
            }
            // `--render-check` sweeps every screen here and exits; no event
            // loop is involved, because every step it takes is synchronous.
            if std::env::var_os("COLAX_RENDER_CHECK").is_some() {
                let code = render_check(&ui, &state);
                std::process::exit(code);
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

    // `--render-check` needs somewhere to stand: without a vault every screen
    // below would be reported as missing, which says nothing about the wire.
    if app_state.is_none() && std::env::var_os("COLAX_RENDER_CHECK").is_some() {
        eprintln!("render-check: the scratch vault could not be opened");
        std::process::exit(1);
    }

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

    let weak = ui.as_weak();
    let tray_state = app_state.clone();
    let tray_weak = tray.as_weak();
    tray.on_mute_requested(move || {
        let Some(ui) = weak.upgrade() else { return };
        let Some(state) = &tray_state else { return };
        let muted = {
            let guard = state.borrow();
            items::prefs_from(guard.engine.preferences()).sounds_muted
        };
        // The same write the Desktop tab's "Mute all sounds" makes, through the
        // same whitelist: the menu item and the switch are two doors to one
        // preference, which is what the panel's own hint promises.
        settings_bool(&ui, state, "soundsMuted", !muted);
        sync_tray(&tray_weak, state);
    });

    tray.on_restart_requested(|| {
        // Electron's `app.relaunch()` in one line: start the same binary
        // again and let this process quit. Nothing needs flushing first --
        // shell state was written as it changed and the vault writes
        // atomically -- and a spawn that fails still quits, because a
        // Restart that leaves the old window up is worse than no restart.
        if let Ok(exe) = std::env::current_exe() {
            let _ = std::process::Command::new(exe).spawn();
        } else {
            eprintln!("restart -> could not resolve the executable path");
        }
        let _ = slint::quit_event_loop();
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

            // The lock card's three dials: the meter under the password
            // field, the suggestion, and the Sun/Moon in the corner.
            let weak = ui.as_weak();
            ui.on_password_edited(move || {
                let Some(ui) = weak.upgrade() else { return };
                if ui.get_screen() != Screen::CreatePassword {
                    return;
                }
                let password = ui.get_password_value().to_string();
                push_lock_strength(&ui, &password);
            });

            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_suggest_password(move || {
                let Some(ui) = weak.upgrade() else { return };
                suggest_password(&ui, &st);
            });

            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_toggle_theme(move || {
                let Some(ui) = weak.upgrade() else { return };
                toggle_theme(&ui, &st);
            });
        }

        {
            // Create: password -> confirm -> create. The floor is the
            // estimator's, not a ruler's (LockScreen.tsx L76-79): below
            // "fair" the password is refused with the sentence that points
            // at the button under it. The meter is what makes the refusal
            // legible -- it was already saying the same thing per keystroke.
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_password_next(move || {
                let Some(ui) = weak.upgrade() else { return };
                if ui.get_busy() || ui.get_screen() != Screen::CreatePassword {
                    return;
                }
                let password = ui.get_password_value().to_string();
                if estimate_strength(&password).score < 2 {
                    ui.set_error_text(
                        "Choose a longer vault password, or use the suggestion.".into(),
                    );
                    return;
                }
                st.borrow_mut().pending_password = password;
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

            // ---- Context menus (Task 8.1) -----------------------------
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_app_menu(move |x, y| {
                if let Some(ui) = weak.upgrade() {
                    menus::open_app_menu(&ui, &st, x, y);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_item_menu(move |id, x, y| {
                if let Some(ui) = weak.upgrade() {
                    menus::open_item_menu(&ui, &st, &id, x, y);
                }
            });
            let weak = ui.as_weak();
            ui.on_menu_close(move || {
                if let Some(ui) = weak.upgrade() {
                    menus::close(&ui);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_menu_picked(move |id| {
                if let Some(ui) = weak.upgrade() {
                    menus::menu_picked(&ui, &st, &id);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_menu_key(move |text| {
                if let Some(ui) = weak.upgrade() {
                    menus::menu_key(&ui, &st, &text);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_menu_hover(move |index| {
                if let Some(ui) = weak.upgrade() {
                    menus::menu_hover(&ui, &st, index);
                }
            });

            // ---- Global keyboard shortcuts (Task 8.2) -------------------------
            // The window's one FocusScope hands every key no widget claimed to
            // `shortcuts::key`, which answers whether it acted; `accept` stops
            // the key there, `reject` lets Slint go on to Tab traversal. This
            // is the whole native replacement for the web build's `window`
            // keydown listeners.
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_shortcut_key(move |text, ctrl, shift, alt| match weak.upgrade() {
                Some(ui) => shortcuts::key(&ui, &st, &text, ctrl, shift, alt),
                None => false,
            });

            // The sheet's Close button and backdrop landing here. The `changed
            // show-shortcuts` handler in the .slint re-focuses the key scope
            // once it is gone.
            let weak = ui.as_weak();
            ui.on_shortcuts_closed(move || {
                if let Some(ui) = weak.upgrade() {
                    ui.set_show_shortcuts(false);
                }
            });

            // The appearance tuner (Task 8.4): every dial is a plain preference
            // write, so these four are thin -- the rule that decides what each
            // one may store lives in `tuner.rs`, next to the ranges the panel
            // draws.
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_tuner_size_changed(move |field, value| {
                if let Some(ui) = weak.upgrade() {
                    tuner::size_changed(&ui, &st, &field, value);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_tuner_accent_picked(move |id| {
                if let Some(ui) = weak.upgrade() {
                    tuner::accent_picked(&ui, &st, &id);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_tuner_reset(move || {
                if let Some(ui) = weak.upgrade() {
                    tuner::reset(&ui, &st);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_dock_key_captured(move |text| {
                if let Some(ui) = weak.upgrade() {
                    dock::capture(&ui, &st, &text);
                }
            });

            // Drag-reorder (Task 8.5). The row owns the gesture; the three
            // reports carry the pointer and, at the start, the row's own
            // rectangle, which is the only geometry Rust cannot derive.
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_reorder_start(move |index, px, py, x, y, w, h| {
                if let Some(ui) = weak.upgrade() {
                    reorder::begin(
                        &ui,
                        &st,
                        index.max(0) as usize,
                        px,
                        py,
                        x,
                        y,
                        w,
                        h,
                    );
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_reorder_move(move |px, py| {
                if let Some(ui) = weak.upgrade() {
                    reorder::moved(&ui, &st, px, py);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_reorder_end(move |commit| {
                if let Some(ui) = weak.upgrade() {
                    reorder::finish(&ui, &st, commit);
                }
            });

            let weak = ui.as_weak();
            ui.on_tuner_closed(move || {
                if let Some(ui) = weak.upgrade() {
                    tuner::close(&ui);
                }
            });

            // The quick-launch docks (Task 8.3). The bar's four callbacks are
            // thin forwarders into `dock.rs`; the manager's eight are the
            // Layout tab's controls, keyed by index into `dock-rows`' own
            // dock/slot numbers rather than by id, because the rows model is
            // rebuilt on every refresh and only the indices survive a write.
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_dock_slot_pressed(move |dock_id, slot_id| {
                if let Some(ui) = weak.upgrade() {
                    dock::slot_pressed(&ui, &st, &dock_id, &slot_id);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_dock_bar_menu(move |dock_id, x, y| {
                if let Some(ui) = weak.upgrade() {
                    menus::open_dock_menu(&ui, &st, &dock_id, x, y);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_dock_slot_menu(move |dock_id, slot_id, x, y| {
                if let Some(ui) = weak.upgrade() {
                    menus::open_dock_slot_menu(&ui, &st, &dock_id, &slot_id, x, y);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_dock_moved(move |dock_id, edge, fx, fy| {
                if let Some(ui) = weak.upgrade() {
                    dock::pos_committed(&ui, &st, &dock_id, &edge, fx, fy);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_dock_toggle(move |index, enabled| {
                if let Some(ui) = weak.upgrade() {
                    if let Some(id) = dock::dock_id_at(&st, index as usize) {
                        dock::set_enabled(&ui, &st, &id, enabled);
                    }
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_dock_remove(move |index| {
                if let Some(ui) = weak.upgrade() {
                    if let Some(id) = dock::dock_id_at(&st, index as usize) {
                        dock::remove_dock(&ui, &st, &id);
                    }
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_dock_pos(move |index, edge| {
                if let Some(ui) = weak.upgrade() {
                    if let Some(id) = dock::dock_id_at(&st, index as usize) {
                        dock::set_pos(&ui, &st, &id, &edge);
                    }
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_dock_slot_key(move |index, slot| {
                if let Some(ui) = weak.upgrade() {
                    if let Some(id) = dock::dock_id_at(&st, index as usize) {
                        dock::arm_key(&ui, &st, &id, slot as usize);
                        crate::notice(&ui, "Press the key you want this slot to answer to…");
                    }
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_dock_slot_menu_at(move |index, slot, x, y| {
                if let Some(ui) = weak.upgrade() {
                    if let Some(id) = dock::dock_id_at(&st, index as usize) {
                        menus::open_dock_slot_menu_at(&ui, &st, &id, slot as usize, x, y);
                    }
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_dock_slot_remove(move |index, slot| {
                if let Some(ui) = weak.upgrade() {
                    if let Some(id) = dock::dock_id_at(&st, index as usize) {
                        dock::remove_slot(&ui, &st, &id, slot as usize);
                    }
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_dock_slot_move(move |index, slot, delta| {
                if let Some(ui) = weak.upgrade() {
                    if let Some(id) = dock::dock_id_at(&st, index as usize) {
                        dock::move_slot(&ui, &st, &id, slot as usize, delta);
                    }
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_dock_add_slot(move |index| {
                if let Some(ui) = weak.upgrade() {
                    if let Some(id) = dock::dock_id_at(&st, index as usize) {
                        // The picker opens beside the bar it edits, which is
                        // the only anchor the Layout tab and the bar share.
                        let scale = ui.window().scale_factor();
                        let size = ui.window().size();
                        let (fx, fy) = dock::bar_anchor(&st, &id);
                        menus::open_dock_add_menu(
                            &ui,
                            &st,
                            &id,
                            fx * size.width as f32 / scale,
                            fy * size.height as f32 / scale,
                        );
                    }
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_dock_add(move || {
                if let Some(ui) = weak.upgrade() {
                    dock::add_dock(&ui, &st);
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
                    // Through open-section rather than an id-only switch so the
                    // merged sections reset (App.tsx `openChannel`): clicking
                    // All logins in the rail means the whole list, not
                    // whichever section was left open last time.
                    ui.set_all_tab("all".into());
                    // TS's Dashboard remounts on the overview every arrival.
                    ui.set_dash_tab(0);
                    // A new channel is a new scope: a query that meant
                    // something in the old one would silently filter the new
                    // one, so the box empties with the switch (App.tsx L167).
                    // The History panel's own two state values switch off
                    // with it, for the same reason.
                    ui.set_search_text("".into());
                    ui.set_history_query("".into());
                    ui.set_history_filter(0);
                    refresh_items(&ui, &st);
                }
            });

            // A dashboard tile, a merged-section tab, or anything else that
            // jumps with a tab in hand (App.tsx `openChannel`): the tab is
            // chosen by the jump, so a tile for Favorites opens All logins
            // *on* Favorites, while an empty tab resets to the whole list.
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_open_section(move |id, tab| {
                if let Some(ui) = weak.upgrade() {
                    let id = id.trim().to_string();
                    if id.is_empty() {
                        return;
                    }
                    // A tab that is not one of the strip's reads as no tab, so
                    // a stale id cannot strand the list on a section.
                    let tab = match tab.trim() {
                        "all" => "all".to_string(),
                        "favorites" => "favorites".to_string(),
                        "attention" => "attention".to_string(),
                        "weak" => "weak".to_string(),
                        _ => String::new(),
                    };
                    ui.set_all_tab(if tab.is_empty() { "all".into() } else { tab.as_str().into() });
                    // TS's Dashboard remounts on the overview every arrival.
                    ui.set_dash_tab(0);
                    // The same scope rules a rail click follows.
                    ui.set_search_text("".into());
                    ui.set_history_query("".into());
                    ui.set_history_filter(0);
                    ui.set_active_channel(id.as_str().into());
                    refresh_items(&ui, &st);
                }
            });

            // The History panel's seven (Task 7.2). The query and the
            // segment only recompute the screen; Clear and the row actions
            // write through Rust first, then recompute.
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_history_query_changed(move || {
                // The text itself lives in `history-query`, which
                // `refresh_items` reads back off the window.
                if let Some(ui) = weak.upgrade() {
                    refresh_items(&ui, &st);
                }
            });

            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_history_filter_changed(move |index| {
                if let Some(ui) = weak.upgrade() {
                    ui.set_history_filter(index);
                    refresh_items(&ui, &st);
                }
            });

            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_history_clear(move || {
                if let Some(ui) = weak.upgrade() {
                    history_clear(&ui, &st);
                }
            });

            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_history_restore(move |id| {
                if let Some(ui) = weak.upgrade() {
                    history_restore(&ui, &st, &id);
                }
            });

            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_history_open(move |id| {
                if let Some(ui) = weak.upgrade() {
                    open_editor(&ui, &st, &id);
                }
            });

            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_history_copy(move |value, label, item_id| {
                if let Some(ui) = weak.upgrade() {
                    // Reaching for a row counts as a use of its login, like
                    // every other copy (`onCopy` carries the live one).
                    if !item_id.is_empty() {
                        record_use(&ui, &st, &item_id);
                    }
                    copy_to_clipboard(&ui, &st, &value, &label);
                }
            });

            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_history_forget(move |id| {
                if let Some(ui) = weak.upgrade() {
                    history_forget(&ui, &st, &id);
                }
            });

            // The dashboard's three deferred actions. Bulk add and the
            // channel editor have no native panel yet (the TS modals land
            // with the import tools and Task 1.5); Settings is Phase 5. The
            // buttons say so rather than sitting dead.
            let weak = ui.as_weak();
            ui.on_dash_bulk_add(move || {
                if let Some(ui) = weak.upgrade() {
                    notice(&ui, "Bulk add arrives with the import tools.");
                }
            });
            let weak = ui.as_weak();
            ui.on_dash_new_channel(move || {
                if let Some(ui) = weak.upgrade() {
                    notice(&ui, "The channel editor arrives with the next phase.");
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_dash_open_settings(move |section| {
                if let Some(ui) = weak.upgrade() {
                    settings_ops::open(&ui, &st, &section);
                }
            });

            // The Settings window itself: the sidebar's footer row (and the
            // dashboard's cards through `on_dash_open_settings` above) open
            // it, Escape and Ctrl+1..9 arrive as `settings-closed` /
            // `settings-tab-picked`, and the three typed dial callbacks are
            // every panel's way of writing a pref — validated, saved and
            // pushed back inside settings_ops.
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_open_settings(move |section| {
                if let Some(ui) = weak.upgrade() {
                    settings_ops::open(&ui, &st, &section);
                }
            });
            let weak = ui.as_weak();
            ui.on_settings_closed(move || {
                if let Some(ui) = weak.upgrade() {
                    settings_ops::close(&ui);
                }
            });
            let weak = ui.as_weak();
            ui.on_settings_tab_picked(move |index| {
                if let Some(ui) = weak.upgrade() {
                    settings_ops::tab_picked(&ui, index);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_pref_string(move |key, value| {
                if let Some(ui) = weak.upgrade() {
                    settings_ops::pref_string(&ui, &st, &key, &value);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_pref_float(move |key, value| {
                if let Some(ui) = weak.upgrade() {
                    settings_ops::pref_float(&ui, &st, &key, value as f64);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            let tw = tray.as_weak();
            ui.on_settings_pref_bool(move |key, value| {
                if let Some(ui) = weak.upgrade() {
                    settings_bool(&ui, &st, &key, value);
                    // The Desktop tab's two tray preferences land on the icon
                    // as they are written, not on the next launch.
                    sync_tray(&tw, &st);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_hidden_restore(move |key, id| {
                if let Some(ui) = weak.upgrade() {
                    settings_ops::restore(&ui, &st, &key, &id);
                }
            });
            // The Alarms tab's seven handholds. Everything but Test goes
            // through `write`, so the panel is repainted from the document
            // after each one; Test only plays, and the draft's own day chip
            // and sound never leave `settings_ops`.
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_alarm_add(move || {
                if let Some(ui) = weak.upgrade() {
                    settings_ops::alarms_add(&ui, &st);
                }
            });
            let st = state.clone();
            ui.on_settings_alarm_test(move |id| {
                settings_ops::alarm_test(&st, &id);
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_alarm_toggle(move |id| {
                if let Some(ui) = weak.upgrade() {
                    settings_ops::alarm_toggle(&ui, &st, &id);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_alarm_delete(move |id| {
                if let Some(ui) = weak.upgrade() {
                    settings_ops::alarm_delete(&ui, &st, &id);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_alarm_day_toggled(move |index| {
                if let Some(ui) = weak.upgrade() {
                    settings_ops::alarm_day_toggled(&ui, &st, index);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_alarm_import(move || {
                if let Some(ui) = weak.upgrade() {
                    settings_ops::alarm_import(&ui, &st);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_alarm_reset_sound(move || {
                if let Some(ui) = weak.upgrade() {
                    settings_ops::alarm_reset_sound(&ui, &st);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_hidden_restore_all(move || {
                if let Some(ui) = weak.upgrade() {
                    settings_ops::restore_all(&ui, &st);
                }
            });
            // The Security tab's own handholds: the lock button and the vault
            // form's twelve actions, each the same shape as the alarm block
            // above. "Lock now" seals the vault and closes the sheet; every
            // other op either stages a key (nothing written yet) or writes
            // `prefs.vaultSecurity` through the panel's own door.
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_security_lock(move || {
                if let Some(ui) = weak.upgrade() {
                    settings_ops::security_lock(&ui, &st);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_vsec_totp_attach(move || {
                if let Some(ui) = weak.upgrade() {
                    settings_ops::vsec_totp_attach(&ui, &st);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_vsec_totp_generate(move || {
                if let Some(ui) = weak.upgrade() {
                    settings_ops::vsec_totp_generate(&ui, &st);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_vsec_totp_check(move || {
                if let Some(ui) = weak.upgrade() {
                    settings_ops::vsec_totp_check(&ui, &st);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_vsec_totp_discard(move || {
                if let Some(ui) = weak.upgrade() {
                    settings_ops::vsec_totp_discard(&ui, &st);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_vsec_totp_remove(move || {
                if let Some(ui) = weak.upgrade() {
                    settings_ops::vsec_totp_remove(&ui, &st);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_vsec_passcode_save(move || {
                if let Some(ui) = weak.upgrade() {
                    settings_ops::vsec_passcode_save(&ui, &st);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_vsec_passcode_check(move || {
                if let Some(ui) = weak.upgrade() {
                    settings_ops::vsec_passcode_check(&ui, &st);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_vsec_passcode_remove(move || {
                if let Some(ui) = weak.upgrade() {
                    settings_ops::vsec_passcode_remove(&ui, &st);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_vsec_question_add(move || {
                if let Some(ui) = weak.upgrade() {
                    settings_ops::vsec_question_add(&ui, &st);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_vsec_question_remove(move |id| {
                if let Some(ui) = weak.upgrade() {
                    settings_ops::vsec_question_remove(&ui, &st, &id);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_vsec_question_check(move |id| {
                if let Some(ui) = weak.upgrade() {
                    settings_ops::vsec_question_check(&ui, &st, &id);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_vsec_prompt_step(move |delta| {
                if let Some(ui) = weak.upgrade() {
                    settings_ops::vsec_prompt_step(&ui, &st, delta);
                }
            });

            // Data and Backup (Task 5.8): the two panels' rows and the three
            // confirm sheets. The pickers and the save dialog live inside the
            // ops; the two sheet actions that repaint the world — reset and
            // restore — need the tray, which is why they are wired here.
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_data_export_csv(move || {
                if let Some(ui) = weak.upgrade() {
                    settings_ops::data_export_csv(&ui, &st);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_data_import_csv(move || {
                if let Some(ui) = weak.upgrade() {
                    settings_ops::data_import_csv(&ui, &st);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_data_reset_ask(move || {
                if let Some(ui) = weak.upgrade() {
                    settings_ops::data_reset_open(&ui, &st);
                }
            });
            let weak = ui.as_weak();
            ui.on_settings_data_reset_cancel(move || {
                if let Some(ui) = weak.upgrade() {
                    settings_ops::data_reset_cancel(&ui);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            let tw = tray.as_weak();
            ui.on_settings_data_reset_confirmed(move || {
                if let Some(ui) = weak.upgrade() {
                    settings_data_reset(&ui, &st, &tw);
                }
            });
            let weak = ui.as_weak();
            ui.on_settings_data_export_edited(move || {
                if let Some(ui) = weak.upgrade() {
                    settings_ops::data_export_edited(&ui);
                }
            });
            let weak = ui.as_weak();
            ui.on_settings_data_protect_cancel(move || {
                if let Some(ui) = weak.upgrade() {
                    settings_ops::data_protect_cancel(&ui);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_data_protect_confirm(move || {
                if let Some(ui) = weak.upgrade() {
                    settings_ops::data_protect_confirm(&ui, &st);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_backup_export(move || {
                if let Some(ui) = weak.upgrade() {
                    settings_ops::backup_export(&ui, &st);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_backup_restore_pick(move || {
                if let Some(ui) = weak.upgrade() {
                    settings_ops::backup_restore_pick(&ui, &st);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_backup_with_settings_toggled(move || {
                if let Some(ui) = weak.upgrade() {
                    settings_ops::backup_with_settings_toggled(&ui, &st);
                }
            });
            // ---- Optimize (Task 5.11) --------------------------------
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_opt_balanced(move || {
                if let Some(ui) = weak.upgrade() {
                    optimize_ops::preset_balanced(&ui, &st);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_opt_max(move || {
                if let Some(ui) = weak.upgrade() {
                    optimize_ops::preset_max(&ui, &st);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_opt_restore(move || {
                if let Some(ui) = weak.upgrade() {
                    optimize_ops::restore(&ui, &st);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_opt_motion_toggled(move || {
                if let Some(ui) = weak.upgrade() {
                    optimize_ops::motion_toggled(&ui, &st);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_opt_ambient_toggled(move || {
                if let Some(ui) = weak.upgrade() {
                    optimize_ops::ambient_toggled(&ui, &st);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_opt_cards_toggled(move || {
                if let Some(ui) = weak.upgrade() {
                    optimize_ops::cards_toggled(&ui, &st);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_opt_background_removed(move || {
                if let Some(ui) = weak.upgrade() {
                    optimize_ops::background_removed(&ui, &st);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_opt_save_profile(move || {
                if let Some(ui) = weak.upgrade() {
                    optimize_ops::save_profile(&ui, &st);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_opt_apply_profile(move |id| {
                if let Some(ui) = weak.upgrade() {
                    optimize_ops::apply_profile(&ui, &st, &id);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_opt_rename_start(move |id| {
                if let Some(ui) = weak.upgrade() {
                    optimize_ops::rename_start(&ui, &st, &id);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_opt_rename_commit(move |id| {
                if let Some(ui) = weak.upgrade() {
                    optimize_ops::rename_commit(&ui, &st, &id);
                }
            });
            let weak = ui.as_weak();
            ui.on_settings_opt_rename_cancel(move || {
                if let Some(ui) = weak.upgrade() {
                    optimize_ops::rename_cancel(&ui);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_opt_overwrite(move |id| {
                if let Some(ui) = weak.upgrade() {
                    optimize_ops::overwrite_profile(&ui, &st, &id);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_opt_delete_profile(move |id| {
                if let Some(ui) = weak.upgrade() {
                    optimize_ops::delete_profile(&ui, &st, &id);
                }
            });
            let weak = ui.as_weak();
            ui.on_settings_opt_measure(move || {
                if let Some(ui) = weak.upgrade() {
                    optimize_ops::measure(&ui);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_opt_mail_toggled(move || {
                if let Some(ui) = weak.upgrade() {
                    optimize_ops::mail_toggled(&ui, &st);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_opt_page_picked(move |id| {
                if let Some(ui) = weak.upgrade() {
                    optimize_ops::page_size_picked(&ui, &st, &id);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_opt_cache_clear(move || {
                if let Some(ui) = weak.upgrade() {
                    optimize_ops::cache_clear(&ui, &st);
                }
            });
            // ---- About (Task 5.12) -----------------------------------
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_about_copy_report(move || {
                if let Some(ui) = weak.upgrade() {
                    settings_ops::about_copy_report(&ui, &st);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_about_reset(move || {
                if let Some(ui) = weak.upgrade() {
                    settings_ops::about_reset(&ui, &st);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_data_restore_cancel(move || {
                if let Some(ui) = weak.upgrade() {
                    settings_ops::data_restore_cancel(&ui, &st);
                }
            });
            let weak = ui.as_weak();
            ui.on_settings_data_restore_edit(move || {
                if let Some(ui) = weak.upgrade() {
                    settings_ops::data_restore_edited(&ui);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            let tw = tray.as_weak();
            ui.on_settings_data_restore_submit(move || {
                if let Some(ui) = weak.upgrade() {
                    settings_data_restore_submit(&ui, &st, &tw);
                }
            });
            // Background (Task 5.9): the field's own edits, then the two
            // buttons. Upload opens a real dialog, the way every other file
            // row in this window does.
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_bg_url_edited(move || {
                if let Some(ui) = weak.upgrade() {
                    settings_ops::background_url_edited(&ui, &st);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_bg_upload(move || {
                if let Some(ui) = weak.upgrade() {
                    settings_ops::background_upload(&ui, &st);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_bg_remove(move || {
                if let Some(ui) = weak.upgrade() {
                    settings_ops::background_remove(&ui, &st);
                }
            });
            // Channels (Task 5.10): the panel's twelve, then the shared
            // editor's own. Every one of them stages or patches a draft in
            // `AppState` and then pushes the whole panel or form back, so a
            // refused write settles on the widget that asked.
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_chan_edit(move |id| {
                if let Some(ui) = weak.upgrade() {
                    channels_ops::open(&ui, &st, &id);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_chan_toggle_hidden(move |id| {
                if let Some(ui) = weak.upgrade() {
                    channels_ops::toggle_hidden(&ui, &st, &id);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_chan_hide_all(move || {
                if let Some(ui) = weak.upgrade() {
                    channels_ops::hide_all(&ui, &st);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_chan_show_all(move || {
                if let Some(ui) = weak.upgrade() {
                    channels_ops::show_all(&ui, &st);
                }
            });
            let weak = ui.as_weak();
            ui.on_settings_chan_tag_edited(move || {
                if let Some(ui) = weak.upgrade() {
                    channels_ops::tag_input_edited(&ui);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_chan_tag_add(move || {
                if let Some(ui) = weak.upgrade() {
                    channels_ops::tag_add(&ui, &st);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_chan_tag_rename_start(move |id| {
                if let Some(ui) = weak.upgrade() {
                    channels_ops::tag_rename_start(&ui, &st, &id);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_chan_tag_renamed(move |id, name| {
                if let Some(ui) = weak.upgrade() {
                    channels_ops::tag_renamed(&ui, &st, &id, &name);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_chan_tag_rename_done(move |id| {
                if let Some(ui) = weak.upgrade() {
                    channels_ops::tag_rename_done(&ui, &st, id.as_str());
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_chan_tag_hue_toggle(move |id| {
                if let Some(ui) = weak.upgrade() {
                    channels_ops::tag_hue_toggle(&ui, &st, &id);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_chan_tag_hue_changed(move |id, value| {
                if let Some(ui) = weak.upgrade() {
                    channels_ops::tag_hue_changed(&ui, &st, &id, value as f64);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_settings_chan_tag_delete(move |id| {
                if let Some(ui) = weak.upgrade() {
                    channels_ops::tag_delete(&ui, &st, &id);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_channel_ed_closed(move || {
                if let Some(ui) = weak.upgrade() {
                    channels_ops::close(&ui, &st);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_channel_ed_save(move || {
                if let Some(ui) = weak.upgrade() {
                    channels_ops::save(&ui, &st);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_channel_ed_deleted(move || {
                if let Some(ui) = weak.upgrade() {
                    channels_ops::deleted(&ui, &st);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_channel_ed_name_edited(move || {
                if let Some(ui) = weak.upgrade() {
                    channels_ops::name_edited(&ui, &st);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_channel_ed_kind_picked(move |index| {
                if let Some(ui) = weak.upgrade() {
                    channels_ops::kind_picked(&ui, &st, index);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_channel_ed_tag_toggled(move |id| {
                if let Some(ui) = weak.upgrade() {
                    channels_ops::tag_toggled(&ui, &st, &id);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_channel_ed_tag_relayout(move |width| {
                if let Some(ui) = weak.upgrade() {
                    channels_ops::relayout(&ui, &st, width);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_channel_ed_icon_picked(move |key| {
                if let Some(ui) = weak.upgrade() {
                    channels_ops::icon_picked(&ui, &st, &key);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_channel_ed_hue_changed(move |value| {
                if let Some(ui) = weak.upgrade() {
                    channels_ops::hue_changed(&ui, &st, value as f64);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_channel_ed_accent_picked(move |id| {
                if let Some(ui) = weak.upgrade() {
                    channels_ops::accent_picked(&ui, &st, &id);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_channel_ed_image_edited(move || {
                if let Some(ui) = weak.upgrade() {
                    channels_ops::image_edited(&ui, &st);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_channel_ed_image_upload(move || {
                if let Some(ui) = weak.upgrade() {
                    channels_ops::image_upload(&ui, &st);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_channel_ed_image_remove(move || {
                if let Some(ui) = weak.upgrade() {
                    channels_ops::image_remove(&ui, &st);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_channel_ed_image_float(move |key, value| {
                if let Some(ui) = weak.upgrade() {
                    channels_ops::image_float(&ui, &st, &key, value as f64);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_channel_ed_show_mail_toggled(move |value| {
                if let Some(ui) = weak.upgrade() {
                    channels_ops::show_mail_toggled(&ui, &st, value);
                }
            });
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_channel_ed_mail_account_picked(move |id| {
                if let Some(ui) = weak.upgrade() {
                    channels_ops::mail_account_picked(&ui, &st, &id);
                }
            });

            // The modal's frame follows the window. A poll, not a binding:
            // Slint cannot size the sheet from the window without the loop
            // settings.slint documents. One comparison while it is closed.
            let weak = ui.as_weak();
            let frame_timer = slint::Timer::default();
            frame_timer.start(
                slint::TimerMode::Repeated,
                std::time::Duration::from_millis(400),
                move || {
                    if let Some(ui) = weak.upgrade() {
                        if ui.get_settings_open() {
                            settings_ops::follow_window(&ui);
                        }
                    }
                },
            );
            std::mem::forget(frame_timer);

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

            // The editor's generator options are a write, not a redraw: the
            // chips and the length slider are the same six fields Settings ›
            // Generator holds (`onOptionsChange` -> `updatePrefs` in the TS).
            // The mode and the word count stay session state -- neither is in
            // `passwordGenerator`, and the word count is derived from the
            // length when the panel opens (`ItemEditor.tsx L69`).
            let weak = ui.as_weak();
            let st = state.clone();
            ui.on_editor_gen_options_changed(move || {
                if let Some(ui) = weak.upgrade() {
                    if ui.get_screen() == Screen::Editor {
                        settings_ops::gen_options(&ui, &st);
                    }
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
            let st = state.clone();
            ui.on_editor_copy_generated(move || {
                if let Some(ui) = weak.upgrade() {
                    editor_copy_generated(&ui, &st);
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
    // The two flags are read off the live preferences, not the startup
    // snapshot: the Desktop tab can move either one while the window is up,
    // and a close that ignored the switch would be exactly the dead control
    // that tab warns about. A vault that never opened has no preferences to
    // read, so the snapshot is the fallback there.
    let close_state = state_file;
    let close_engine = app_state.clone();
    let weak = ui.as_weak();
    ui.window().on_close_requested(move || {
        let on_error = weak
            .upgrade()
            .is_some_and(|ui| ui.get_screen() == Screen::Error);
        let (close_to_tray, tray_enabled) = match &close_engine {
            Some(state) => {
                let guard = state.borrow();
                let prefs = items::prefs_from(guard.engine.preferences());
                (prefs.close_to_tray, prefs.tray_enabled)
            }
            None => (close_state.close_to_tray, close_state.tray_enabled),
        };
        if !on_error && close_to_tray && tray_enabled {
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
    // hold still, and `!app-active` does the same for a ring nobody is looking
    // at (`.rb-animated-list` is in the `[data-quiet]` pause list too, app.css
    // L1772) -- stopped where it stands rather than put back to zero.
    {
        let weak = ui.as_weak();
        let timer = slint::Timer::default();
        timer.start(
            slint::TimerMode::Repeated,
            std::time::Duration::from_millis(40),
            move || {
                if let Some(ui) = weak.upgrade() {
                    let motion = ui.get_motion();
                    if ui.get_vault_view() == "carousel"
                        && motion > 0.0
                        && ui.get_app_active()
                    {
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

    // ---- Alarms ------------------------------------------------------------
    // The other whole-app timer: a match against the wall clock once a
    // second, from before the window shows (useAlarms mounts for the life of
    // the app — a reminder rings whether or not anyone is looking). Only the
    // path that opened a vault: an error screen has nothing to ring for and
    // quits on close anyway.
    if let Some(state) = &app_state {
        alarms::start(&ui, state);
    }

    // ---- Being watched -----------------------------------------------------
    // The other whole-app timer, and the reason the ambient mesh can animate
    // at all: one query a second asks whether the foreground window belongs to
    // this process, and both continuous animations stop while it does not --
    // the mesh's drift in the Slint file, the ring's here. That is the web's
    // `[data-quiet]` (app.css L1762), which exists because a window behind
    // another app is still painting every frame at nobody.
    activity::start(&ui);

    ui.show()?;

    // The idle lock listens on the thread the window runs on, so it goes
    // up with the window.
    install_auto_lock();

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

    // The tray's own reading, from the same two flags the Desktop tab writes.
    // With a vault open the preferences are the newer copy (a restore brings
    // them from another machine); before that there is nothing but the shell
    // file to read.
    if let Some(state) = &app_state {
        sync_tray(&tray.as_weak(), state);
    } else if state_file.tray_enabled {
        tray.show()?;
    } else {
        tray.hide()?;
    }
    eprintln!("shell up: window and tray shown");

    ui.run()?;
    Ok(())
}
