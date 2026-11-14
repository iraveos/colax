//! Native Colax: the window, its rail, the login list and every overlay.
//!
//! This is a faithful port of the Electron shell rather than an imitation: the
//! same palette tokens, the same rail order, the same interactions (click a card
//! to copy, double-click to edit, right-click for the copy menu), and the same
//! settings groups. Data lives in one `VaultData`, saved debounced to the native
//! vault file described in `io.rs`.

use crate::{editor, icon, io, roadmap, settings, views};
use eframe::egui;
use egui::{pos2, vec2, Align2, Color32, Id, Rect, RichText, Sense, Stroke};
use std::collections::BTreeMap;

use icon::draw as icon_draw;
use crate::model::*;
use crate::theme::{mix, Theme};

pub const APP_NAME: &str = "Colax";
pub const TITLE_SIZE: f32 = 22.0;

/// Hidden launch options, used by the UI review harness:
///
/// ```text
/// colax --screenshot shot.png --view grid --scope dashboard --size 1280x840
/// ```
///
/// They exist so a screen can be rendered to a file without moving the mouse,
/// capturing the desktop, or touching the real vault.
#[derive(Clone, Default)]
pub struct Launch {
    pub screenshot: Option<std::path::PathBuf>,
    pub view: Option<String>,
    pub scope: Option<String>,
    pub size: Option<(f32, f32)>,
    /// `settings`, `editor`, `palette` or `shortcuts`: the harness cannot click,
    /// so it asks for an overlay to be open in the frame it captures.
    pub open: Option<String>,
    /// `light`, `dark` or `system`: checks the other palette without touching
    /// the stored preference.
    pub theme: Option<String>,
    /// Pixels per point, the same value winit feeds egui at 150% Windows
    /// scaling. Lets a capture check a DPI the machine is not set to.
    pub scale: Option<f32>,
}

impl Launch {
    pub fn parse(mut args: impl Iterator<Item = String>) -> Self {
        let mut launch = Launch::default();
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--screenshot" => launch.screenshot = args.next().map(std::path::PathBuf::from),
                "--view" => launch.view = args.next(),
                "--scope" => launch.scope = args.next(),
                "--open" => launch.open = args.next(),
                "--theme" => launch.theme = args.next(),
                "--scale" => launch.scale = args.next().and_then(|value| value.parse().ok()),
                "--size" => {
                    if let Some(size) = args.next().and_then(|value| parse_size(&value)) {
                        launch.size = Some(size);
                    }
                }
                _ => {}
            }
        }
        launch
    }
}

fn parse_size(value: &str) -> Option<(f32, f32)> {
    let (width, height) = value.split_once('x')?;
    Some((width.trim().parse().ok()?, height.trim().parse().ok()?))
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Scope {
    All,
    Favorites,
    Attention,
    Dashboard,
    Roadmap,
    Channel(String),
    Folder(String),
}

impl Scope {
    pub fn label(&self, data: &VaultData) -> String {
        match self {
            Scope::All => "All logins".into(),
            Scope::Favorites => "Favorites".into(),
            Scope::Attention => "Needs attention".into(),
            Scope::Dashboard => "Dashboard".into(),
            Scope::Roadmap => "Email roadmap".into(),
            Scope::Channel(id) => data
                .prefs
                .channels
                .iter()
                .find(|channel| &channel.id == id)
                .map(|channel| channel.name.clone())
                .unwrap_or_else(|| "Channel".into()),
            Scope::Folder(id) => data
                .prefs
                .folders
                .iter()
                .find(|folder| &folder.id == id)
                .map(|folder| folder.name.clone())
                .unwrap_or_else(|| "Folder".into()),
        }
    }

    pub fn hint(&self) -> &'static str {
        match self {
            Scope::All => "Every login in the vault",
            Scope::Favorites => "The ones you pinned",
            Scope::Attention => "Reused, weak or flagged logins",
            Scope::Dashboard => "The state of the vault at a glance",
            Scope::Roadmap => "Addresses, the mailboxes behind them and the logins they open",
            Scope::Channel(_) => "A channel you made",
            Scope::Folder(_) => "Every channel in this folder",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AllTab {
    All,
    Favorites,
    Attention,
    Dashboard,
    Roadmap,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum SettingsGroup {
    Appearance,
    Workspace,
    Security,
    Data,
    Optimize,
    Sharing,
    Desktop,
    About,
}

#[derive(Clone)]
pub struct Toast {
    pub text: String,
    pub tone: ToastTone,
    pub at: f64,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ToastTone {
    Info,
    Error,
}

/// Which control an overlay is waiting on, so a modal can be opened from more
/// than one place without inventing a second flag each time.
#[derive(Clone, PartialEq, Eq)]
pub enum Confirm {
    DeleteItem(String),
    ResetVault,
}

pub struct App {
    pub data: VaultData,
    pub theme: Theme,
    pub system_dark: bool,
    pub locked: bool,
    pub envelope: Option<String>,
    pub password: Option<String>,
    pub unlock_password: String,
    pub unlock_error: String,

    pub scope: Scope,
    pub all_tab: AllTab,
    pub query: String,
    pub search_focus: bool,
    pub tag_filters: Vec<String>,
    pub editor: editor::Editor,
    pub settings: settings::SettingsState,
    pub roadmap: roadmap::RoadmapState,
    pub confirm: Option<Confirm>,
    pub palette_open: bool,
    pub palette_query: String,
    pub shortcuts_open: bool,
    pub about_open: bool,
    pub bulk_open: bool,
    pub bulk_text: String,
    pub bulk_error: String,
    pub collapsed_folders: Vec<String>,
    pub rail_hidden: bool,
    pub toasts: Vec<Toast>,
    pub dock_drag: Option<(usize, egui::Vec2)>,
    pub dirty_at: Option<f64>,
    pub clipboard_clear_at: Option<f64>,
    pub last_input: f64,
    pub fired_alarms: Vec<String>,
    pub reset_theme_cache: bool,
    /// Set by `--screenshot`: where to write the frame, and the frame count that
    /// decides when to ask for it.
    pub screenshot_path: Option<std::path::PathBuf>,
    pub frames: u32,
    pub screenshot_requested: bool,
    /// `--scale`: re-applied every frame because eframe overwrites the pixels
    /// per point from the window on each draw.
    pub harness_scale: Option<f32>,
    /// True when `--size` asked for an exact window, which suppresses the fit.
    pub explicit_size: bool,
    /// The window is fitted to the monitor once, on the first frame that knows
    /// how big the monitor is.
    pub fitted_window: bool,
    /// Frames drawn, independent of the capture counter.
    pub ticks: u32,
    /// Every card's rect this frame, so a right-click can be resolved by
    /// geometry instead of per-widget click state.
    pub card_rects: Vec<(egui::Rect, String)>,
    /// The open right-click menu, if any. Held as state rather than delegated to
    /// `Response::context_menu`, which never opened here.
    pub ctx_menu: Option<CtxMenu>,
}

#[derive(Clone)]
pub struct CtxMenu {
    pub pos: egui::Pos2,
    pub item: String,
    /// Tick the menu opened on, so its own opening click cannot dismiss it.
    pub opened: u32,
}

enum CtxAction {
    Edit,
    Copy(String, &'static str),
    OpenSite,
    Favorite,
    Attention,
    Delete,
}

impl App {
    pub fn new(cc: &eframe::CreationContext<'_>, launch: Launch) -> Self {
        let system_dark = cc.egui_ctx.style().visuals.dark_mode;
        let (data, envelope, locked) = match io::load() {
            Ok(io::LoadOutcome::Unlocked(data)) => (data, None, false),
            Ok(io::LoadOutcome::Locked { envelope }) => (VaultData::default(), Some(envelope), true),
            Ok(io::LoadOutcome::Missing) => (VaultData::default(), None, false),
            Err(error) => {
                let mut data = VaultData::default();
                data.log("Storage error", &error);
                (data, None, false)
            }
        };
        let theme = Theme::build(data.prefs.theme.into(), data.prefs.accent.theme(), system_dark);
        let theme = decorate_theme(theme, &data.prefs);
        let mut app = Self {
            data,
            theme,
            system_dark,
            locked,
            envelope,
            password: None,
            unlock_password: String::new(),
            unlock_error: String::new(),
            scope: Scope::All,
            all_tab: AllTab::All,
            query: String::new(),
            search_focus: false,
            tag_filters: Vec::new(),
            editor: editor::Editor::default(),
            settings: settings::SettingsState::default(),
            roadmap: roadmap::RoadmapState::default(),
            confirm: None,
            palette_open: false,
            palette_query: String::new(),
            shortcuts_open: false,
            about_open: false,
            bulk_open: false,
            bulk_text: String::new(),
            bulk_error: String::new(),
            collapsed_folders: Vec::new(),
            rail_hidden: false,
            toasts: Vec::new(),
            dock_drag: None,
            dirty_at: None,
            clipboard_clear_at: None,
            last_input: 0.0,
            fired_alarms: Vec::new(),
            reset_theme_cache: true,
            screenshot_path: None,
            frames: 0,
            screenshot_requested: false,
            harness_scale: launch.scale,
            ticks: 0,
            card_rects: Vec::new(),
            ctx_menu: None,
            explicit_size: launch.size.is_some(),
            fitted_window: false,
        };
        // `--view` / `--scope` make one frame reproducible; nothing in the app
        // depends on them beyond the first draw.
        if let Some(view) = launch.view.as_deref() {
            app.data.prefs.view = match view {
                "list" => VaultView::List,
                "grid" => VaultView::Grid,
                _ => VaultView::Animated,
            };
        }
        if let Some(scope) = launch.scope.as_deref() {
            app.scope = match scope {
                "favorites" => Scope::Favorites,
                "attention" => Scope::Attention,
                "dashboard" => Scope::Dashboard,
                "roadmap" => Scope::Roadmap,
                _ => Scope::All,
            };
        }
        if let Some(theme) = launch.theme.as_deref() {
            app.data.prefs.theme = match theme {
                "light" => crate::model::ThemeSetting::Light,
                "dark" => crate::model::ThemeSetting::Dark,
                _ => crate::model::ThemeSetting::System,
            };
        }
        match launch.open.as_deref() {
            Some("settings") => app.settings.open = true,
            Some("editor") => app.editor.open_new(&app.data),
            Some("palette") => {
                app.palette_open = true;
                app.palette_query.clear();
            }
            Some("shortcuts") => app.shortcuts_open = true,
            // Opens the card menu without a click, so its layout and styling can
            // be captured. The click path itself is resolved by geometry.
            Some("ctx") => {
                if let Some(id) = app.data.items.first().map(|item| item.id.clone()) {
                    app.open_context_menu(pos2(520.0, 240.0), &id);
                }
            }
            _ => {}
        }
        app.screenshot_path = launch.screenshot;
        // Reinstalling can move the exe, so the sign-in entry is rewritten on
        // every start while the setting is on, repairing a stale path.
        if app.data.prefs.launch_at_login {
            let _ = crate::autostart::apply(true);
        }
        crate::theme::install_fonts(&cc.egui_ctx);
        app.theme.apply(&cc.egui_ctx, app.text_scale());
        app
    }

    pub fn text_scale(&self) -> f32 {
        (self.data.prefs.text_scale as f32 / 100.0).clamp(0.75, 1.5)
    }

    pub fn toast(&mut self, text: impl Into<String>, tone: ToastTone) {
        if self.data.prefs.notifications == "off" && tone == ToastTone::Info {
            return;
        }
        if self.data.prefs.notifications == "errors" && tone == ToastTone::Info {
            return;
        }
        self.toasts.push(Toast { text: text.into(), tone, at: 0.0 });
        self.toasts.truncate(4);
    }

    pub fn info(&mut self, text: impl Into<String>) {
        self.toast(text, ToastTone::Info);
    }

    pub fn error(&mut self, text: impl Into<String>) {
        self.toast(text, ToastTone::Error);
    }

    pub fn mark_dirty(&mut self) {
        self.dirty_at = Some(now_seconds());
    }

    /// Saves at most twice a second. Every preference and login edit funnels
    /// through here, so closing the window mid-edit loses nothing.
    fn flush(&mut self) {
        let Some(dirty_at) = self.dirty_at else { return };
        if now_seconds() - dirty_at < 0.7 {
            return;
        }
        if self.locked {
            return;
        }
        match io::save(&self.data, self.password.as_deref()) {
            Ok(()) => {
                self.dirty_at = None;
            }
            Err(error) => {
                self.dirty_at = None;
                self.error(error);
            }
        }
    }

    /// Writes the currently rendered frame to a PNG through eframe's own
    /// screenshot command, then closes. This reads what egui painted, so it
    /// never captures whatever else is on the user's screen.
    fn capture(&mut self, ctx: &egui::Context, path: &std::path::Path) {
        self.frames += 1;
        // With an injected click the menu only exists a few ticks later, so the
        // capture waits for it instead of photographing the frame before it.
        if self.frames < 3 {
            ctx.request_repaint();
            return;
        }
        if !self.screenshot_requested {
            self.screenshot_requested = true;
            ctx.send_viewport_cmd(egui::ViewportCommand::Screenshot);
        }
        let frame = ctx.input(|input| {
            input.events.iter().find_map(|event| match event {
                egui::Event::Screenshot { image, .. } => Some(image.clone()),
                _ => None,
            })
        });
        match frame {
            Some(image) => {
                save_png(path, &image);
                ctx.send_viewport_cmd(egui::ViewportCommand::Close);
            }
            None => ctx.request_repaint(),
        }
    }

    pub fn copy(&mut self, ctx: &egui::Context, text: &str, what: &str) {
        ctx.output_mut(|output| output.copied_text = text.to_string());
        self.toast(format!("{what} copied"), ToastTone::Info);
        if self.data.prefs.clear_clipboard_seconds > 0 {
            self.clipboard_clear_at = Some(now_seconds() + self.data.prefs.clear_clipboard_seconds as f64);
        }
    }

    /// The live 2FA code for a login, or `None` when it has no seed or the seed
    /// does not decode. Computed on the spot: a code is never written to the
    /// vault or to a log.
    pub fn totp_code(&self, item: &VaultItem) -> Option<String> {
        if item.totp_secret.trim().is_empty() {
            return None;
        }
        crate::totp::code_at(&item.totp_secret, crate::totp::now_unix())
    }

    pub fn mask_email(&self, address: &str) -> String {
        if !self.data.prefs.mask_emails {
            return address.to_string();
        }
        let Some((name, domain)) = address.split_once('@') else { return address.to_string() };
        let visible: String = name.chars().take(2).collect();
        let hidden = "•".repeat(name.chars().count().saturating_sub(2).min(5).max(3));
        format!("{visible}{hidden}@{domain}")
    }

    pub fn new_login(&mut self) {
        self.editor.open_new(&self.data);
    }

    pub fn edit_login(&mut self, id: &str) {
        self.editor.open_existing(&self.data, id);
    }

    pub fn save_item(&mut self, item: VaultItem, is_new: bool) {
        let title = item.display_title().to_string();
        if is_new {
            self.data.items.push(item);
            self.data.log("Added login", &title);
            self.info(format!("{title} saved"));
        } else {
            if let Some(existing) = self.data.item_mut(&item.id) {
                *existing = item;
            }
            self.data.log("Updated login", &title);
            self.info(format!("{title} updated"));
        }
        self.mark_dirty();
    }

    pub fn delete_item(&mut self, id: &str) {
        if let Some(index) = self.data.items.iter().position(|item| item.id == id) {
            let removed = self.data.items.remove(index);
            self.data.log("Deleted login", removed.display_title());
            self.info(format!("{} deleted", removed.display_title()));
            self.mark_dirty();
        }
    }

    pub fn lock(&mut self) {
        if self.password.is_none() {
            self.info("Set a vault password first — everything else is already local");
            self.settings.open = true;
            self.settings.group = SettingsGroup::Security;
            self.settings.section = "security".into();
            return;
        }
        self.locked = true;
        self.unlock_password.clear();
        self.unlock_error.clear();
        if self.data.prefs.clear_clipboard_on_lock {
            self.clipboard_clear_at = Some(now_seconds());
        }
        self.dock_drag = None;
        self.editor.close();
        self.settings.open = false;
    }

    pub fn set_password(&mut self, password: Option<String>) {
        self.password = password;
        self.mark_dirty();
        // Save immediately: a password change that is only scheduled has a
        // window where quitting leaves the old file behind.
        let _ = io::save(&self.data, self.password.as_deref());
        self.dirty_at = None;
    }

    pub fn save_now(&mut self) {
        let _ = io::save(&self.data, self.password.as_deref());
        self.dirty_at = None;
    }

    fn attempt_unlock(&mut self, ctx: &egui::Context) {
        let Some(envelope) = self.envelope.clone() else { return };
        if self.unlock_password.is_empty() {
            return;
        }
        match io::unlock(&envelope, &self.unlock_password) {
            Ok(mut data) => {
                if data.version == 0 {
                    data.version = 1;
                }
                self.data = data;
                self.password = Some(std::mem::take(&mut self.unlock_password));
                self.envelope = None;
                self.locked = false;
                self.unlock_error.clear();
                self.theme = decorate_theme(
                    Theme::build(self.data.prefs.theme.into(), self.data.prefs.accent.theme(), self.system_dark),
                    &self.data.prefs,
                );
                self.theme.apply(ctx, self.text_scale());
                self.toast("Vault unlocked", ToastTone::Info);
            }
            Err(error) => {
                self.unlock_error = error;
                self.unlock_password.clear();
            }
        }
    }

    /* ---- Scope and filtering ------------------------------------------- */

    pub fn visible_items(&self) -> Vec<VaultItem> {
        let reused = self.data.reused_passwords();
        let mut items: Vec<VaultItem> = self
            .data
            .items
            .iter()
            .filter(|item| match &self.scope {
                Scope::Favorites => item.favorite,
                Scope::Attention => {
                    item.needs_attention || reused.contains(&item.password) || self.data.sender_is_weak(item)
                }
                Scope::Channel(id) => self
                    .data
                    .prefs
                    .channels
                    .iter()
                    .find(|channel| &channel.id == id)
                    .map(|channel| item.tags.iter().any(|tag| channel.tag_ids.contains(tag)))
                    .unwrap_or(false),
                Scope::Folder(id) => {
                    let ids: Vec<String> = self
                        .data
                        .prefs
                        .channels
                        .iter()
                        .filter(|channel| &channel.folder_id == id)
                        .flat_map(|channel| channel.tag_ids.clone())
                        .collect();
                    item.tags.iter().any(|tag| ids.contains(tag))
                }
                _ => true,
            })
            .cloned()
            .collect();

        let needle = self.query.trim().to_lowercase();
        if !needle.is_empty() {
            items.retain(|item| {
                let tags = self.data.tag_names(item).join(" ");
                let haystack = format!(
                    "{} {} {} {} {} {}",
                    item.title,
                    item.username,
                    item.url,
                    item.notes,
                    item.host(),
                    tags
                )
                .to_lowercase();
                needle.split_whitespace().all(|term| haystack.contains(term))
            });
        }
        if !self.tag_filters.is_empty() {
            items.retain(|item| self.tag_filters.iter().all(|tag| item.tags.contains(tag)));
        }

        match self.data.prefs.sort {
            SortMode::Title => items.sort_by(|left, right| {
                left.display_title().to_lowercase().cmp(&right.display_title().to_lowercase())
            }),
            SortMode::Updated => items.sort_by(|left, right| right.updated_at.cmp(&left.updated_at)),
            SortMode::Created => items.sort_by(|left, right| right.created_at.cmp(&left.created_at)),
            SortMode::Username => {
                items.sort_by(|left, right| left.username.to_lowercase().cmp(&right.username.to_lowercase()))
            }
            SortMode::Strength => items.sort_by_key(|item| password_score(&item.password)),
        }
        items
    }

    pub fn all_tags(&self) -> Vec<Tag> {
        let mut tags = self.data.prefs.tags.clone();
        tags.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
        tags
    }

    pub fn channel_counts(&self) -> BTreeMap<String, usize> {
        let mut counts = BTreeMap::new();
        for channel in &self.data.prefs.channels {
            let count = self
                .data
                .items
                .iter()
                .filter(|item| item.tags.iter().any(|tag| channel.tag_ids.contains(tag)))
                .count();
            counts.insert(channel.id.clone(), count);
        }
        counts
    }

    /* ---- Keyboard ------------------------------------------------------- */

    fn hotkeys(&mut self, ctx: &egui::Context) {
        if self.locked {
            return;
        }
        let typing = ctx.wants_keyboard_input();
        let command = ctx.input(|input| input.modifiers.command);
        let pressed = |key: egui::Key| ctx.input(|input| input.key_pressed(key));

        if command && pressed(egui::Key::K) {
            self.palette_open = true;
            self.palette_query.clear();
            self.settings.open = false;
        }
        if command && pressed(egui::Key::N) {
            self.new_login();
        }
        if command && pressed(egui::Key::F) {
            self.search_focus = true;
        }
        if !typing && !self.editor.is_open() {
            if pressed(egui::Key::Slash) {
                self.search_focus = true;
            }
            if pressed(egui::Key::N) {
                self.new_login();
            }
            if pressed(egui::Key::Questionmark) {
                self.shortcuts_open = true;
            }
            if pressed(egui::Key::Escape) {
                self.palette_open = false;
                self.shortcuts_open = false;
                self.about_open = false;
                self.bulk_open = false;
            }
        }
        if pressed(egui::Key::Escape) && !typing {
            self.editor.close();
            self.settings.open = false;
            self.roadmap.selected = None;
            self.palette_open = false;
        }
    }

    /* ---- Alarms --------------------------------------------------------- */

    fn check_alarms(&mut self) {
        if self.locked || self.data.prefs.alarms.is_empty() {
            return;
        }
        let seconds = now_seconds();
        let minute_of_day = ((seconds as i64 / 60) % (24 * 60)) as u32;
        let weekday = ((seconds as i64 / 86_400 + 4) % 7) as u32; // 1970-01-01 was a Thursday
        let hour = minute_of_day / 60;
        let minute = minute_of_day % 60;
        // Collected first: toasting mutates self, and the loop borrows the alarm
        // list out of it.
        let mut due: Vec<(String, String)> = Vec::new();
        for alarm in &self.data.prefs.alarms {
            if !alarm.enabled || alarm.hour != hour || alarm.minute != minute {
                continue;
            }
            if !alarm.days.is_empty() && !alarm.days.contains(&weekday) {
                continue;
            }
            let key = format!("{}-{}", alarm.id, seconds as i64 / 60);
            if self.fired_alarms.contains(&key) {
                continue;
            }
            let label = if alarm.label.is_empty() { "Alarm".to_string() } else { alarm.label.clone() };
            due.push((key, label));
        }
        for (key, label) in due {
            self.fired_alarms.push(key);
            self.fired_alarms.truncate(20);
            self.toast(format!("Alarm · {label}"), ToastTone::Info);
        }
    }

    /// The page background: the base colour plus the three accent washes the
    /// Electron build paints under the glass. egui has no radial gradient, so
    /// each blob is a triangle fan with a coloured centre and a clear rim.
    fn paint_ambient(&self, ctx: &egui::Context) {
        let painter = ctx.layer_painter(egui::LayerId::background());
        let screen = ctx.screen_rect();
        painter.rect_filled(screen, 0.0, self.theme.bg());
        if self.theme.reduce_transparency {
            return;
        }
        let (h1, h2) = self.theme.hues;
        let width = screen.width();
        let height = screen.height();
        // A light page needs a stronger wash to read at all; the dark values are
        // tuned against a near-black base.
        let (strength_1, strength_2, strength_3) = if self.theme.dark {
            (0.10, 0.07, 0.05)
        } else {
            (0.20, 0.16, 0.10)
        };
        let blobs = [
            (
                pos2(screen.left() - width * 0.10, screen.top() - height * 0.14),
                width * 0.44,
                crate::theme::hsl(h1, 55.0, 48.0),
                strength_1,
            ),
            (
                pos2(screen.right() + width * 0.10, screen.bottom() + height * 0.16),
                width * 0.42,
                crate::theme::hsl(h2, 52.0, 52.0),
                strength_2,
            ),
            (
                pos2(screen.left() + width * 0.74, screen.top() + height * 0.24),
                width * 0.30,
                crate::theme::hsl(h1 + 30.0, 50.0, 50.0),
                strength_3,
            ),
        ];
        for (center, radius, colour, strength) in blobs {
            radial_blob(&painter, center, radius, colour, strength);
        }
    }

    /* ---- Context menu --------------------------------------------------- */

    pub fn register_card(&mut self, rect: egui::Rect, item_id: &str) {
        self.card_rects.push((rect, item_id.to_string()));
    }

    /// Resolves a right-click against the cards drawn this frame. Geometry works
    /// where `Response::secondary_clicked()` did not: the card body is a frame
    /// response, and its click never arrived.
    fn open_menu_at_pointer(&mut self, ctx: &egui::Context) {
        let Some(pos) = ctx.input(|input| {
            if input.pointer.secondary_clicked() {
                input.pointer.interact_pos()
            } else {
                None
            }
        }) else {
            return;
        };
        if let Some(id) = card_at(&self.card_rects, pos) {
            let id = id.to_string();
            self.open_context_menu(pos, &id);
        }
    }

    pub fn open_context_menu(&mut self, pos: egui::Pos2, item_id: &str) {
        self.ctx_menu = Some(CtxMenu {
            pos,
            item: item_id.to_string(),
            opened: self.ticks,
        });
    }

    /// The login card's right-click menu: `--surface` panel, 12px radius, hairline,
    /// 28px rows with icons, danger row for Delete.
    fn context_menu(&mut self, ctx: &egui::Context) {
        let Some(menu) = self.ctx_menu.clone() else {
            return;
        };
        if ctx.input(|input| input.key_pressed(egui::Key::Escape)) {
            self.ctx_menu = None;
            return;
        }
        let Some(item) = self.data.item(&menu.item).cloned() else {
            self.ctx_menu = None;
            return;
        };
        let theme = self.theme;
        let address = if item.username.trim().is_empty() {
            item.title.clone()
        } else {
            item.username.clone()
        };
        let code = self.totp_code(&item);
        let mut action: Option<CtxAction> = None;

        let screen = ctx.screen_rect();
        let pos = pos2(
            menu.pos.x.min(screen.right() - 250.0).max(screen.left() + 4.0),
            menu.pos.y.min(screen.bottom() - 340.0).max(screen.top() + 4.0),
        );
        let area = egui::Area::new(Id::new("ctx-menu"))
            .order(egui::Order::Foreground)
            .fixed_pos(pos)
            .show(ctx, |ui| {
                let frame = egui::Frame::none()
                    .fill(theme.surface_raised())
                    .rounding(theme.radius(12.0))
                    .stroke(Stroke::new(1.0_f32, theme.border_strong()))
                    .shadow(egui::epaint::Shadow {
                        offset: vec2(0.0, 12.0),
                        blur: 32.0,
                        spread: 0.0,
                        color: Color32::from_black_alpha(96),
                    })
                    .inner_margin(egui::Margin::symmetric(6.0, 6.0));
                frame.show(ui, |ui| {
                    ui.set_min_width(232.0);
                    if ctx_row(ui, &theme, "key", "Edit this login", true, false) {
                        action = Some(CtxAction::Edit);
                    }
                    ctx_divider(ui, &theme);
                    if ctx_row(ui, &theme, "copy", "Copy email", !address.trim().is_empty(), false) {
                        action = Some(CtxAction::Copy(address.clone(), "Email"));
                    }
                    if ctx_row(ui, &theme, "copy", "Copy password", !item.password.is_empty(), false) {
                        action = Some(CtxAction::Copy(item.password.clone(), "Password"));
                    }
                    if ctx_row(ui, &theme, "copy", "Copy email + password", !item.password.is_empty(), false) {
                        action = Some(CtxAction::Copy(
                            format!("{address}\n{}", item.password),
                            "Email and password",
                        ));
                    }
                    if ctx_row(ui, &theme, "copy", "Copy login details", true, false) {
                        action = Some(CtxAction::Copy(
                            format!("{}\n{}\n{}\n{}", item.display_title(), item.username, item.password, item.url),
                            "Login details",
                        ));
                    }
                    if let Some(code) = &code {
                        if ctx_row(ui, &theme, "clock", "Copy 2FA code", true, false) {
                            action = Some(CtxAction::Copy(code.clone(), "2FA code"));
                        }
                    }
                    ctx_divider(ui, &theme);
                    if ctx_row(ui, &theme, "external", "Open website", !item.url.is_empty(), false) {
                        action = Some(CtxAction::OpenSite);
                    }
                    let favorite = if item.favorite { "Remove favorite" } else { "Add to favorites" };
                    if ctx_row(ui, &theme, "star", favorite, true, false) {
                        action = Some(CtxAction::Favorite);
                    }
                    let attention = if item.needs_attention {
                        "Clear attention flag"
                    } else {
                        "Needs attention"
                    };
                    if ctx_row(ui, &theme, "alert", attention, true, false) {
                        action = Some(CtxAction::Attention);
                    }
                    ctx_divider(ui, &theme);
                    if ctx_row(ui, &theme, "trash", "Delete", true, true) {
                        action = Some(CtxAction::Delete);
                    }
                });
            });

        // A click anywhere else dismisses. The click that opened the menu is in
        // this same frame, so it cannot count.
        let click_outside = self.ticks > menu.opened
            && ctx.input(|input| {
                input.pointer.any_click()
                    && input
                        .pointer
                        .interact_pos()
                        .map(|at| !area.response.rect.contains(at))
                        .unwrap_or(false)
            });
        if click_outside || action.is_some() {
            self.ctx_menu = None;
        }

        match action {
            Some(CtxAction::Edit) => self.edit_login(&item.id),
            Some(CtxAction::Copy(text, what)) => self.copy(ctx, &text, what),
            Some(CtxAction::OpenSite) => ctx.open_url(egui::OpenUrl::new_tab(item.url.clone())),
            Some(CtxAction::Favorite) => {
                if let Some(existing) = self.data.item_mut(&item.id) {
                    existing.favorite = !existing.favorite;
                }
                self.mark_dirty();
            }
            Some(CtxAction::Attention) => {
                if let Some(existing) = self.data.item_mut(&item.id) {
                    existing.needs_attention = !existing.needs_attention;
                }
                self.mark_dirty();
            }
            Some(CtxAction::Delete) => self.confirm = Some(Confirm::DeleteItem(item.id.clone())),
            None => {}
        }
    }

    /* ---- Chrome --------------------------------------------------------- */

    fn topbar(&mut self, ctx: &egui::Context) {
        egui::TopBottomPanel::top("topbar")
            .frame(egui::Frame::none().inner_margin(egui::Margin::symmetric(self.theme.space(1.6), self.theme.space(1.0))))
            .show(ctx, |ui| {
                ui.horizontal(|ui| {
                    if self.data.prefs.show_sidebar {
                        let response = self.icon_button(ui, if self.rail_hidden { "grid" } else { "chevron-left" }, 30.0);
                        if response.clicked() {
                            self.rail_hidden = !self.rail_hidden;
                        }
                    }
                    ui.add_space(self.theme.space(0.2));

                    // Search. The right-hand controls are laid out after this
                    // frame, so their width is reserved here — otherwise egui
                    // painted the sort menu and view buttons on top of it.
                    // `.search` is centred in the header and capped at 520px, so
                    // the field sits under the title rather than hugging the
                    // rail. The actions on the right keep their reservation.
                    let controls = 408.0;
                    let room = (ui.available_width() - controls).max(200.0);
                    let desired = room.min(520.0);
                    ui.add_space(((room - desired) * 0.5).max(0.0));
                    let frame = egui::Frame::none()
                        .fill(self.theme.surface_raised())
                        .rounding(self.theme.radius(18.0))
                        .stroke(Stroke::new(1.0_f32, self.theme.hairline()))
                        .inner_margin(egui::Margin::symmetric(12.0, 7.0));
                    frame.show(ui, |ui| {
                        // The frame must not grow past its reservation, or it runs
                        // under the sort menu drawn to its right.
                        ui.set_max_width((desired - 20.0).max(220.0));
                        ui.horizontal(|ui| {
                            let icon_rect =
                                Rect::from_center_size(ui.cursor().min + vec2(9.0, 12.0), vec2(15.0, 15.0));
                            icon_draw(ui.painter(), "search", icon_rect, self.theme.text_faint(), 1.6);
                            ui.add_space(20.0);
                            let response = ui.add(
                                egui::TextEdit::singleline(&mut self.query)
                                    .id(Id::new("search"))
                                    .desired_width((ui.available_width() - 150.0).max(120.0))
                                    .hint_text("Search logins, addresses and tags")
                                    .frame(false),
                            );
                            if self.search_focus {
                                response.request_focus();
                                self.search_focus = false;
                            }
                            if !self.query.is_empty() {
                                if self.text_button(ui, "Clear").clicked() {
                                    self.query.clear();
                                }
                            }
                            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                                self.tab_pill(ui, "Ctrl K", false, true);
                                ui.add_space(self.theme.space(0.2));
                                let tag_label = if self.tag_filters.is_empty() {
                                    "Tags".to_string()
                                } else {
                                    format!("{} tags", self.tag_filters.len())
                                };
                                if self.chip_button(ui, &tag_label, !self.tag_filters.is_empty()).clicked() {
                                    self.settings.open = false;
                                    self.palette_open = true;
                                    self.palette_query = "tag:".into();
                                }
                            });
                        });
                    });

                    // View switcher
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if self.data.prefs.show_new_login_button {
                            if self.primary_button(ui, "New login", Some("plus")).clicked() {
                                self.new_login();
                            }
                        }
                        // Settings and lock live in the rail footer, the way
                        // Electron places them. Drawing them here as well is
                        // what put two settings buttons beside New login.
                        ui.add_space(self.theme.space(0.2));
                        for view in [VaultView::Grid, VaultView::List, VaultView::Animated] {
                            if self.view_button(ui, view).clicked() {
                                self.data.prefs.view = view;
                                self.mark_dirty();
                            }
                        }
                        sort_menu(ui, self);
                    });
                });
            });
    }

    fn sidebar(&mut self, ctx: &egui::Context) {
        if !self.data.prefs.show_sidebar || self.rail_hidden {
            return;
        }
        let compact = self.data.prefs.compact_sidebar || self.data.prefs.sidebar_labels == SidebarLabels::Icon;
        let width = if compact { 76.0 } else { 272.0 };
        // Transparent, like `.sidebar`: rail and page are one surface, so the
        // ambient gradient runs behind both instead of a panel on top of it.
        let frame = egui::Frame::none()
            .fill(Color32::TRANSPARENT)
            .inner_margin(egui::Margin::symmetric(self.theme.space(0.8), self.theme.space(1.2)));
        let position = self.data.prefs.sidebar_position;
        if matches!(position, RailPosition::Right) {
            egui::SidePanel::right("rail").resizable(false).exact_width(width).frame(frame).show(ctx, |ui| {
                self.sidebar_body(ui, compact);
            });
        } else {
            egui::SidePanel::left("rail").resizable(false).exact_width(width).frame(frame).show(ctx, |ui| {
                self.sidebar_body(ui, compact);
            });
        }
    }

    fn sidebar_body(&mut self, ui: &mut egui::Ui, compact: bool) {
        // Brand
        ui.horizontal(|ui| {
            let (rect, _) = ui.allocate_exact_size(vec2(38.0, 38.0), Sense::hover());
            paint_gradient(ui.painter(), rect, self.theme.gradient().0, self.theme.gradient().1, 10.0);
            icon_draw(ui.painter(), "shield", Rect::from_center_size(rect.center(), vec2(18.0, 18.0)), Color32::WHITE, 1.8);
            if !compact {
                ui.add_space(self.theme.space(0.6));
                ui.vertical(|ui| {
                    ui.label(RichText::new("Colax").size(15.0).strong().color(self.theme.text()));
                    ui.label(RichText::new("native edition").size(10.5).color(self.theme.text_faint()));
                });
            }
        });
        ui.add_space(self.theme.space(1.2));
        ui.separator();
        ui.add_space(self.theme.space(0.8));

        // The footer is drawn after this list. Without a cap the list claimed
        // every pixel and the last tags were painted underneath the footer card.
        let list_height = (ui.available_height() - 62.0).max(140.0);
        egui::ScrollArea::vertical()
            .auto_shrink([false, false])
            .max_height(list_height)
            .show(ui, |ui| {
            let builtins: [(&str, Scope, &str); 5] = [
                ("inbox", Scope::All, "All logins"),
                ("star", Scope::Favorites, "Favorites"),
                ("alert", Scope::Attention, "Needs attention"),
                ("grid", Scope::Dashboard, "Dashboard"),
                ("mail", Scope::Roadmap, "Email roadmap"),
            ];
            for (icon, scope, label) in builtins {
                let active = self.scope == scope;
                let count = match scope {
                    Scope::All => Some(self.data.items.len()),
                    Scope::Favorites => Some(self.data.items.iter().filter(|item| item.favorite).count()),
                    Scope::Attention => Some(
                        self.data
                            .items
                            .iter()
                            .filter(|item| {
                                item.needs_attention
                                    || self.data.reused_passwords().contains(&item.password)
                                    || self.data.sender_is_weak(item)
                            })
                            .count(),
                    ),
                    _ => None,
                };
                if nav_item(ui, &self.theme, icon, label, count, active, compact, 0.0, None).clicked() {
                    self.scope = scope.clone();
                    self.all_tab = match scope {
                        Scope::All => AllTab::All,
                        Scope::Favorites => AllTab::Favorites,
                        Scope::Attention => AllTab::Attention,
                        Scope::Dashboard => AllTab::Dashboard,
                        Scope::Roadmap => AllTab::Roadmap,
                        _ => AllTab::All,
                    };
                }
            }

            ui.add_space(self.theme.space(1.0));
            ui.label(
                RichText::new("CHANNELS")
                    .size(10.5)
                    .strong()
                    .color(self.theme.text_faint())
                    .extra_letter_spacing(0.9),
            );
            ui.add_space(self.theme.space(0.3));

            let counts = self.channel_counts();
            let folders = self.data.prefs.folders.clone();
            let channels = self.data.prefs.channels.clone();
            for folder in &folders {
                if folder.hidden {
                    continue;
                }
                let collapsed = self.collapsed_folders.contains(&folder.id);
                let child_count: usize = channels
                    .iter()
                    .filter(|channel| channel.folder_id == folder.id)
                    .map(|channel| counts.get(&channel.id).copied().unwrap_or(0))
                    .sum();
                let response = nav_folder(
                    ui,
                    &self.theme,
                    &folder.name,
                    child_count,
                    self.scope == Scope::Folder(folder.id.clone()),
                    compact,
                    collapsed,
                );
                if response.clicked() {
                    self.scope = Scope::Folder(folder.id.clone());
                }
                if response.secondary_clicked() || response.double_clicked() {
                    if collapsed {
                        self.collapsed_folders.retain(|id| id != &folder.id);
                    } else {
                        self.collapsed_folders.push(folder.id.clone());
                    }
                }
                if !collapsed {
                    for channel in channels.iter().filter(|channel| channel.folder_id == folder.id) {
                        let active = self.scope == Scope::Channel(channel.id.clone());
                        let count = counts.get(&channel.id).copied().unwrap_or(0);
                        if nav_item(
                            ui,
                            &self.theme,
                            &channel.icon,
                            &channel.name,
                            Some(if count > 0 { count } else { 0 }),
                            active,
                            compact,
                            14.0,
                            Some(channel.hue),
                        )
                        .clicked()
                        {
                            self.scope = Scope::Channel(channel.id.clone());
                        }
                    }
                }
            }
            for channel in channels.iter().filter(|channel| channel.folder_id.is_empty() && !channel.hidden) {
                let active = self.scope == Scope::Channel(channel.id.clone());
                let count = counts.get(&channel.id).copied().unwrap_or(0);
                if nav_item(
                    ui,
                    &self.theme,
                    &channel.icon,
                    &channel.name,
                    Some(count),
                    active,
                    compact,
                    0.0,
                    Some(channel.hue),
                )
                .clicked()
                {
                    self.scope = Scope::Channel(channel.id.clone());
                }
            }
            if channels.is_empty() && !compact {
                ui.label(
                    RichText::new("Channels group logins by tag. Add one in Settings › Workspace.")
                        .size(10.5)
                        .color(self.theme.text_faint()),
                );
            }

            if !compact {
                ui.add_space(self.theme.space(1.2));
                ui.label(
                    RichText::new("TAGS")
                        .size(10.0)
                        .strong()
                        .color(self.theme.text_faint())
                        .extra_letter_spacing(0.6),
                );
                ui.add_space(self.theme.space(0.3));
                let tags = self.all_tags();
                if tags.is_empty() {
                    ui.label(RichText::new("No tags yet").size(10.5).color(self.theme.text_faint()));
                }
                let mut toggle: Option<String> = None;
                for tag in tags.iter().take(12) {
                    let active = self.tag_filters.contains(&tag.id);
                    let response = nav_item(ui, &self.theme, "tag", &tag.name, None, active, compact, 0.0, None);
                    if response.clicked() {
                        toggle = Some(tag.id.clone());
                    }
                }
                if let Some(id) = toggle {
                    if let Some(index) = self.tag_filters.iter().position(|tag| tag == &id) {
                        self.tag_filters.remove(index);
                    } else {
                        self.tag_filters.push(id);
                    }
                }
            }
        });

        ui.with_layout(egui::Layout::bottom_up(egui::Align::Min), |ui| {
            ui.add_space(self.theme.space(0.4));
            let frame = egui::Frame::none()
                .fill(self.theme.plate(0.8))
                .rounding(self.theme.radius(12.0))
                .inner_margin(egui::Margin::symmetric(8.0, 6.0));
            frame.show(ui, |ui| {
                ui.horizontal(|ui| {
                    let (rect, _) = ui.allocate_exact_size(vec2(28.0, 28.0), Sense::hover());
                    paint_gradient(ui.painter(), rect, self.theme.gradient().0, self.theme.gradient().1, 14.0);
                    ui.painter().text(
                        rect.center(),
                        Align2::CENTER_CENTER,
                        "C",
                        egui::FontId::proportional(13.0),
                        Color32::WHITE,
                    );
                    if !compact {
                        ui.vertical(|ui| {
                            ui.label(RichText::new("Local vault").size(12.0).color(self.theme.text()));
                            let state = if self.password.is_some() { "Encrypted at rest" } else { "No vault password" };
                            ui.label(RichText::new(state).size(10.0).color(self.theme.text_faint()));
                        });
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            if self.icon_button(ui, "settings", 24.0).clicked() {
                                self.settings.open = true;
                            }
                            if self.icon_button(ui, "lock", 24.0).clicked() {
                                self.lock();
                            }
                        });
                    }
                });
            });
        });
    }

    fn content(&mut self, ctx: &egui::Context) {
        egui::CentralPanel::default()
            .frame(egui::Frame::none().inner_margin(egui::Margin::symmetric(
                self.theme.space(1.8),
                self.theme.space(1.0),
            )).fill(Color32::TRANSPARENT))
            .show(ctx, |ui| {
                self.content_header(ui);
                ui.add_space(self.theme.space(0.8));
                egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
                    match self.scope {
                        Scope::Dashboard => views::dashboard(ui, self),
                        Scope::Roadmap => roadmap::show(ui, self),
                        _ => {
                            let items = self.visible_items();
                            views::login_list(ui, self, &items);
                        }
                    }
                    // The dock floats over the bottom of the window, so the list
                    // needs room to scroll clear of it.
                    if self.data.prefs.docks.iter().any(|dock| dock.enabled && !dock.slots.is_empty()) {
                        ui.add_space(64.0);
                    }
                });
            });
    }

    fn content_header(&mut self, ui: &mut egui::Ui) {
        ui.horizontal(|ui| {
            ui.vertical(|ui| {
                ui.label(
                    RichText::new(self.scope.label(&self.data))
                        .font(egui::FontId::proportional(self.theme.font_size(TITLE_SIZE)))
                        .strong()
                        .color(self.theme.text()),
                );
                let subtitle = match self.scope {
                    Scope::All | Scope::Favorites | Scope::Attention => format!(
                        "{} · {} shown{}",
                        self.scope.hint(),
                        self.visible_items().len(),
                        if self.query.is_empty() { String::new() } else { format!(" · filtered by \"{}\"", self.query) }
                    ),
                    _ => self.scope.hint().to_string(),
                };
                ui.label(RichText::new(subtitle).size(self.theme.font_size(11.0)).color(self.theme.text_muted()));
            });
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if self.visible_items().len() > 0 {
                    if self.text_button(ui, "Export CSV").clicked() {
                        let csv = io::csv_export(&self.data);
                        if let Some(path) = io::pick_save(
                            "Save a CSV of your logins",
                            "CSV",
                            &["csv"],
                            "colax-export.csv",
                        ) {
                            match std::fs::write(&path, csv) {
                                Ok(()) => self.info(format!("Exported to {}", path.display())),
                                Err(error) => self.error(format!("Could not export: {error}")),
                            }
                        }
                    }
                }
                if self.chip_button(ui, "Bulk add", false).clicked() {
                    self.bulk_open = true;
                    self.bulk_text.clear();
                }
            });
        });
        ui.add_space(self.theme.space(0.5));

        // Built-in tab strip, the same five tabs the Electron content header has.
        let tabs: [(AllTab, &str); 5] = [
            (AllTab::All, "All"),
            (AllTab::Favorites, "Favorites"),
            (AllTab::Attention, "Attention"),
            (AllTab::Dashboard, "Dashboard"),
            (AllTab::Roadmap, "Roadmap"),
        ];
        ui.horizontal(|ui| {
            for (tab, label) in tabs {
                let active = match (&self.scope, tab) {
                    (Scope::All, AllTab::All) => true,
                    (Scope::Favorites, AllTab::Favorites) => true,
                    (Scope::Attention, AllTab::Attention) => true,
                    (Scope::Dashboard, AllTab::Dashboard) => true,
                    (Scope::Roadmap, AllTab::Roadmap) => true,
                    _ => false,
                };
                if self.tab_pill(ui, label, active, false).clicked() {
                    self.scope = match tab {
                        AllTab::All => Scope::All,
                        AllTab::Favorites => Scope::Favorites,
                        AllTab::Attention => Scope::Attention,
                        AllTab::Dashboard => Scope::Dashboard,
                        AllTab::Roadmap => Scope::Roadmap,
                    };
                    self.all_tab = tab;
                }
            }
            if !self.tag_filters.is_empty() {
                ui.add_space(self.theme.space(0.4));
                let tags = self.tag_filters.clone();
                for id in tags {
                    let name = self.data.prefs.tag_name(&id);
                    if self.chip_button(ui, &format!("{name} ✕"), true).clicked() {
                        self.tag_filters.retain(|tag| tag != &id);
                    }
                }
            }
        });
    }

    /* ---- Small widgets -------------------------------------------------- */

    pub fn icon_button(&mut self, ui: &mut egui::Ui, icon: &str, size: f32) -> egui::Response {
        let (rect, response) = ui.allocate_exact_size(vec2(size + 8.0, size), Sense::click());
        let bg = if response.hovered() { self.theme.surface_hover() } else { Color32::TRANSPARENT };
        ui.painter().rect_filled(rect, self.theme.radius(9.0), bg);
        let color = if response.hovered() { self.theme.text() } else { self.theme.text_muted() };
        icon_draw(ui.painter(), icon, Rect::from_center_size(rect.center(), vec2(size * 0.5, size * 0.5)), color, 1.6);
        response
    }

    pub fn text_button(&mut self, ui: &mut egui::Ui, label: &str) -> egui::Response {
        let padding = vec2(self.theme.space(0.7), self.theme.space(0.35));
        let text = RichText::new(label).size(self.theme.font_size(11.5)).color(self.theme.text_muted());
        let galley = ui.fonts(|fonts| fonts.layout_no_wrap(label.to_string(), egui::FontId::proportional(11.5 * self.text_scale()), self.theme.text_muted()));
        let size = galley.size() + padding * 2.0;
        let (rect, response) = ui.allocate_exact_size(size, Sense::click());
        let bg = if response.hovered() { self.theme.plate(1.4) } else { Color32::TRANSPARENT };
        ui.painter().rect_filled(rect, self.theme.radius(9.0), bg);
        ui.painter().text(rect.center(), Align2::CENTER_CENTER, label, egui::FontId::proportional(11.5 * self.text_scale()), if response.hovered() { self.theme.text() } else { self.theme.text_muted() });
        let _ = text;
        response
    }

    pub fn chip_button(&mut self, ui: &mut egui::Ui, label: &str, active: bool) -> egui::Response {
        let galley = ui.fonts(|fonts| {
            fonts.layout_no_wrap(
                label.to_string(),
                egui::FontId::proportional(10.5 * self.text_scale()),
                self.theme.text(),
            )
        });
        let size = galley.size() + vec2(self.theme.space(0.8), self.theme.space(0.3));
        let (rect, response) = ui.allocate_exact_size(size, Sense::click());
        let fill = if active { self.theme.accent_soft() } else { self.theme.plate(1.0) };
        let stroke = if active { Stroke::new(1.0_f32, self.theme.accent_wash(0.4)) } else { Stroke::new(1.0_f32, self.theme.border()) };
        ui.painter().rect(rect, self.theme.radius(999.0), fill, stroke);
        let color = if active { self.theme.accent_text() } else { self.theme.text_muted() };
        ui.painter().text(rect.center(), Align2::CENTER_CENTER, label, egui::FontId::proportional(10.5 * self.text_scale()), color);
        response
    }

    pub fn primary_button(&mut self, ui: &mut egui::Ui, label: &str, icon: Option<&str>) -> egui::Response {
        let galley = ui.fonts(|fonts| {
            fonts.layout_no_wrap(
                label.to_string(),
                egui::FontId::proportional(12.0 * self.text_scale()),
                Color32::WHITE,
            )
        });
        let icon_space = if icon.is_some() { 22.0 } else { 0.0 };
        let size = vec2(galley.size().x + icon_space + self.theme.space(1.4), 34.0 * self.theme.density);
        let (rect, response) = ui.allocate_exact_size(size, Sense::click());
        let (from, to) = self.theme.gradient();
        let color_from = if response.hovered() { self.theme.accent_hover() } else { from };
        paint_gradient(ui.painter(), rect, color_from, to, 10.0);
                if let Some(icon) = icon {
            let text_left = rect.center().x - galley.size().x / 2.0 + icon_space / 2.0;
            let icon_rect = Rect::from_center_size(pos2(text_left - 18.0, rect.center().y), vec2(13.0, 13.0));
            icon_draw(ui.painter(), icon, icon_rect, Color32::WHITE, 1.7);
        }
        ui.painter().text(
            pos2(rect.center().x + icon_space / 2.0, rect.center().y),
            Align2::CENTER_CENTER,
            label,
            egui::FontId::proportional(12.0 * self.text_scale()),
            Color32::WHITE,
        );
        response
    }

    pub fn tab_pill(&mut self, ui: &mut egui::Ui, label: &str, active: bool, muted: bool) -> egui::Response {
        let galley = ui.fonts(|fonts| {
            fonts.layout_no_wrap(
                label.to_string(),
                egui::FontId::proportional(11.0 * self.text_scale()),
                self.theme.text(),
            )
        });
        let size = vec2(galley.size().x + 22.0, 26.0 * self.theme.density.max(0.9));
        let (rect, response) = ui.allocate_exact_size(size, Sense::click());
        let (fill, stroke, color) = if active {
            (self.theme.accent_soft(), Stroke::new(1.0_f32, self.theme.accent_wash(0.45)), self.theme.accent_text())
        } else if muted {
            (Color32::TRANSPARENT, Stroke::new(1.0_f32, self.theme.border()), self.theme.text_faint())
        } else {
            (Color32::TRANSPARENT, Stroke::new(1.0_f32, Color32::TRANSPARENT), self.theme.text_muted())
        };
        ui.painter().rect(rect, self.theme.radius(999.0), fill, stroke);
        ui.painter().text(rect.center(), Align2::CENTER_CENTER, label, egui::FontId::proportional(11.0 * self.text_scale()), color);
        response
    }

    fn view_button(&mut self, ui: &mut egui::Ui, view: VaultView) -> egui::Response {
        let active = self.data.prefs.view == view;
        let icon = match view {
            VaultView::Animated => "cards",
            VaultView::List => "list",
            VaultView::Grid => "grid",
        };
        let (rect, response) = ui.allocate_exact_size(vec2(30.0, 30.0), Sense::click());
        let bg = if active { self.theme.accent_soft() } else if response.hovered() { self.theme.surface_hover() } else { Color32::TRANSPARENT };
        ui.painter().rect_filled(rect, self.theme.radius(8.0), bg);
        let color = if active { self.theme.accent_text() } else { self.theme.text_muted() };
        icon_draw(ui.painter(), icon, Rect::from_center_size(rect.center(), vec2(15.0, 15.0)), color, 1.6);
        response.on_hover_text(format!("{} view", view.label()))
    }

    /* ---- Overlays ------------------------------------------------------- */

    fn unlock_screen(&mut self, ctx: &egui::Context) {
        egui::CentralPanel::default()
            .frame(egui::Frame::none().fill(Color32::TRANSPARENT))
            .show(ctx, |ui| {
                ui.vertical_centered(|ui| {
                    ui.add_space((ui.available_height() * 0.24).max(40.0));
                    let (rect, _) = ui.allocate_exact_size(vec2(62.0, 62.0), Sense::hover());
                    paint_gradient(ui.painter(), rect, self.theme.gradient().0, self.theme.gradient().1, 18.0);
                    icon_draw(ui.painter(), "lock", Rect::from_center_size(rect.center(), vec2(26.0, 26.0)), Color32::WHITE, 2.0);
                    ui.add_space(self.theme.space(1.2));
                    ui.label(
                        RichText::new("Colax is locked")
                            .font(egui::FontId::proportional(28.0))
                            .strong()
                            .color(self.theme.text()),
                    );
                    ui.label(
                        RichText::new("Enter the vault password to decrypt it on this machine.")
                            .size(12.0)
                            .color(self.theme.text_muted()),
                    );
                    ui.add_space(self.theme.space(1.4));
                    let width = 320.0;
                    let response = ui.add_sized(
                        vec2(width, 38.0),
                        egui::TextEdit::singleline(&mut self.unlock_password)
                            .password(true)
                            .hint_text("Vault password")
                            .font(egui::FontId::proportional(14.0)),
                    );
                    if self.unlock_error.is_empty() {
                        ui.add_space(self.theme.space(0.5));
                        ui.label(RichText::new(" ").size(11.0));
                    } else {
                        ui.add_space(self.theme.space(0.5));
                        ui.label(RichText::new(&self.unlock_error).size(11.0).color(self.theme.danger()));
                    }
                    let enter = response.lost_focus() && ui.input(|input| input.key_pressed(egui::Key::Enter));
                    if ui
                        .add_sized(
                            vec2(width, 38.0),
                            egui::Button::new(RichText::new("Unlock").size(13.0).color(Color32::WHITE))
                                .fill(self.theme.accent())
                                .rounding(self.theme.radius(10.0)),
                        )
                        .clicked()
                        || enter
                    {
                        self.attempt_unlock(ctx);
                    }
                    ui.add_space(self.theme.space(1.2));
                    ui.label(
                        RichText::new(format!("Vault file: {}", io::locked_path().display()))
                            .size(10.0)
                            .color(self.theme.text_faint()),
                    );
                });
            });
    }

    fn toasts_ui(&mut self, ctx: &egui::Context) {
        if self.toasts.is_empty() {
            return;
        }
        let now = now_seconds();
        self.toasts.retain(|toast| now - toast.at < 4.0);
        egui::Area::new(Id::new("toasts"))
            .anchor(Align2::RIGHT_TOP, vec2(-16.0, 68.0))
            .order(egui::Order::Foreground)
            .show(ctx, |ui| {
                ui.set_max_width(300.0);
                for toast in &self.toasts {
                    let accent = if toast.tone == ToastTone::Error { self.theme.danger() } else { self.theme.accent() };
                    egui::Frame::none()
                        .fill(self.theme.surface())
                        .rounding(self.theme.radius(12.0))
                        .stroke(Stroke::new(1.0_f32, accent.gamma_multiply(0.5)))
                        .inner_margin(egui::Margin::symmetric(12.0, 9.0))
                        .show(ui, |ui| {
                            ui.label(RichText::new(&toast.text).size(11.5).color(self.theme.text()));
                        });
                    ui.add_space(6.0);
                }
            });
    }

    fn palette(&mut self, ctx: &egui::Context) {
        if !self.palette_open {
            return;
        }
        let mut open = true;
        egui::Window::new("palette")
            .title_bar(false)
            .open(&mut open)
            .anchor(Align2::CENTER_TOP, vec2(0.0, 120.0))
            .default_width(560.0)
            .frame(
                egui::Frame::none()
                    .fill(self.theme.surface())
                    .rounding(self.theme.radius(18.0))
                    .stroke(Stroke::new(1.0_f32, self.theme.border_strong()))
                    .inner_margin(egui::Margin::same(12.0)),
            )
            .show(ctx, |ui| {
                let response = ui.add(
                    egui::TextEdit::singleline(&mut self.palette_query)
                        .hint_text("Type a command or an address…")
                        .desired_width(f32::INFINITY),
                );
                response.request_focus();
                ui.add_space(6.0);
                let query = self.palette_query.trim().to_lowercase();
                let mut action: Option<PaletteAction> = None;
                let mut first = true;
                let mut entries: Vec<(String, String, PaletteAction)> = vec![
                    ("New login".into(), "plus".into(), PaletteAction::NewLogin),
                    ("Open settings".into(), "settings".into(), PaletteAction::Settings),
                    ("Lock the vault".into(), "lock".into(), PaletteAction::Lock),
                    ("All logins".into(), "inbox".into(), PaletteAction::Scope(Scope::All)),
                    ("Favorites".into(), "star".into(), PaletteAction::Scope(Scope::Favorites)),
                    ("Needs attention".into(), "alert".into(), PaletteAction::Scope(Scope::Attention)),
                    ("Dashboard".into(), "grid".into(), PaletteAction::Scope(Scope::Dashboard)),
                    ("Email roadmap".into(), "mail".into(), PaletteAction::Scope(Scope::Roadmap)),
                    ("Shortcuts".into(), "settings".into(), PaletteAction::Shortcuts),
                ];
                for channel in &self.data.prefs.channels {
                    entries.push((
                        format!("Channel · {}", channel.name),
                        channel.icon.clone(),
                        PaletteAction::Scope(Scope::Channel(channel.id.clone())),
                    ));
                }
                for tag in &self.data.prefs.tags {
                    entries.push((
                        format!("Tag · {}", tag.name),
                        "tag".into(),
                        PaletteAction::Tag(tag.id.clone()),
                    ));
                }
                egui::ScrollArea::vertical().max_height(360.0).show(ui, |ui| {
                    for (label, icon, entry_action) in entries {
                        if !query.is_empty() && !label.to_lowercase().contains(&query) {
                            continue;
                        }
                        let selected = first;
                        first = false;
                        let response = command_row(ui, &self.theme, &icon, &label, selected);
                        if response.clicked() {
                            action = Some(entry_action.clone());
                        }
                    }
                });
                if let Some(action) = action {
                    self.palette_open = false;
                    match action {
                        PaletteAction::NewLogin => self.new_login(),
                        PaletteAction::Settings => self.settings.open = true,
                        PaletteAction::Lock => self.lock(),
                        PaletteAction::Scope(scope) => {
                            self.scope = scope;
                        }
                        PaletteAction::Shortcuts => self.shortcuts_open = true,
                        PaletteAction::Tag(id) => {
                            if !self.tag_filters.contains(&id) {
                                self.tag_filters.push(id);
                            }
                        }
                    }
                }
            });
        if !open {
            self.palette_open = false;
        }
    }

    fn shortcuts(&mut self, ctx: &egui::Context) {
        if !self.shortcuts_open {
            return;
        }
        let mut open = true;
        egui::Window::new("Keyboard shortcuts")
            .open(&mut open)
            .collapsible(false)
            .resizable(false)
            .anchor(Align2::CENTER_CENTER, vec2(0.0, 0.0))
            .frame(window_frame(&self.theme))
            .show(ctx, |ui| {
                ui.set_width(420.0);
                for (keys, what) in [
                    ("Ctrl K", "Command palette"),
                    ("Ctrl N / N", "New login"),
                    ("/ or Ctrl F", "Focus the search box"),
                    ("Enter", "Open the selected login"),
                    ("Double-click", "Edit a login"),
                    ("Right-click", "Copy and open menu"),
                    ("Ctrl C", "Copy the password of the hovered login"),
                    ("L", "Lock the vault"),
                    ("?", "This list"),
                    ("Esc", "Close the top overlay"),
                ] {
                    ui.horizontal(|ui| {
                        ui.add_sized(
                            vec2(96.0, 22.0),
                            egui::Label::new(RichText::new(keys).monospace().size(10.5).color(self.theme.accent_text())),
                        );
                        ui.label(RichText::new(what).size(12.0).color(self.theme.text_muted()));
                    });
                }
            });
        if !open {
            self.shortcuts_open = false;
        }
    }

    fn confirm_modal(&mut self, ctx: &egui::Context) {
        let Some(confirm) = self.confirm.clone() else { return };
        let mut open = true;
        egui::Window::new("Confirm")
            .open(&mut open)
            .title_bar(false)
            .collapsible(false)
            .resizable(false)
            .anchor(Align2::CENTER_CENTER, vec2(0.0, 0.0))
            .frame(window_frame(&self.theme))
            .show(ctx, |ui| {
                ui.set_width(380.0);
                let (title, body) = match &confirm {
                    Confirm::DeleteItem(id) => {
                        let name = self.data.item(id).map(|item| item.display_title().to_string()).unwrap_or_default();
                        ("Delete this login?", format!("\"{name}\" will be removed. This cannot be undone."))
                    }
                    Confirm::ResetVault => (
                        "Delete all data?",
                        "Every login, tag, channel, alarm and setting on this machine will be removed.".to_string(),
                    ),
                };
                ui.label(RichText::new(title).size(16.0).strong().color(self.theme.text()));
                ui.add_space(4.0);
                ui.label(RichText::new(body).size(11.5).color(self.theme.text_muted()));
                ui.add_space(12.0);
                ui.horizontal(|ui| {
                    if ui.button("Cancel").clicked() {
                        self.confirm = None;
                    }
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if ui
                            .add(
                                egui::Button::new(RichText::new("Delete").size(12.0).color(Color32::WHITE))
                                    .fill(self.theme.danger()),
                            )
                            .clicked()
                        {
                            match &confirm {
                                Confirm::DeleteItem(id) => {
                                    let id = id.clone();
                                    self.delete_item(&id);
                                }
                                Confirm::ResetVault => {
                                    self.data = VaultData::default();
                                    self.password = None;
                                    self.save_now();
                                    self.info("Vault reset");
                                }
                            }
                            self.confirm = None;
                        }
                    });
                });
            });
        if !open {
            self.confirm = None;
        }
    }

    fn bulk_add(&mut self, ctx: &egui::Context) {
        if !self.bulk_open {
            return;
        }
        let mut open = true;
        egui::Window::new("Bulk add")
            .open(&mut open)
            .collapsible(false)
            .resizable(true)
            .anchor(Align2::CENTER_CENTER, vec2(0.0, 0.0))
            .frame(window_frame(&self.theme))
            .show(ctx, |ui| {
                ui.set_width(520.0);
                ui.label(RichText::new("One login per line").size(15.0).strong().color(self.theme.text()));
                ui.label(
                    RichText::new("title, url, username, password — one per line. Paste a CSV and the header is skipped.")
                        .size(11.0)
                        .color(self.theme.text_muted()),
                );
                ui.add_space(6.0);
                ui.add(
                    egui::TextEdit::multiline(&mut self.bulk_text)
                        .desired_rows(9)
                        .desired_width(f32::INFINITY)
                        .hint_text("GitHub, https://github.com, me@example.com, secret"),
                );
                if !self.bulk_error.is_empty() {
                    ui.label(RichText::new(&self.bulk_error).size(10.5).color(self.theme.danger()));
                }
                ui.add_space(6.0);
                ui.horizontal(|ui| {
                    if ui.button("Cancel").clicked() {
                        self.bulk_open = false;
                    }
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if ui.button("Add logins").clicked() {
                            let mut added = 0;
                            let mut errors = 0;
                            for line in self.bulk_text.lines() {
                                let line = line.trim();
                                if line.is_empty() || line.to_lowercase().starts_with("title,") {
                                    continue;
                                }
                                let cells: Vec<&str> = line.split(',').map(|cell| cell.trim()).collect();
                                if cells.len() < 2 {
                                    errors += 1;
                                    continue;
                                }
                                let mut item = VaultItem::fresh();
                                item.title = cells.first().unwrap_or(&"").to_string();
                                item.url = cells.get(1).unwrap_or(&"").to_string();
                                item.username = cells.get(2).unwrap_or(&"").to_string();
                                item.password = cells.get(3).unwrap_or(&"").to_string();
                                if !item.url.is_empty() && !item.url.contains("://") {
                                    item.url = format!("https://{}", item.url);
                                }
                                self.data.items.push(item);
                                added += 1;
                            }
                            if added > 0 {
                                self.data.log("Bulk add", &format!("{added} logins"));
                                self.mark_dirty();
                                self.info(format!("{added} logins added"));
                                self.bulk_open = false;
                            } else {
                                self.bulk_error = format!("Nothing added ({errors} lines could not be read)");
                            }
                        }
                    });
                });
            });
        if !open {
            self.bulk_open = false;
        }
    }

    fn dock(&mut self, ctx: &egui::Context) {
        if self.locked {
            return;
        }
        // A floating dock over a dialog hides the buttons underneath it: the
        // editor's Save row was the casualty.
        if self.editor.is_open()
            || self.settings.open
            || self.palette_open
            || self.shortcuts_open
            || self.bulk_open
            || self.confirm.is_some()
        {
            return;
        }
        let docks = self.data.prefs.docks.clone();
        for (index, dock) in docks.iter().enumerate() {
            if !dock.enabled || dock.slots.is_empty() {
                continue;
            }
            let screen = ctx.screen_rect();
            let pos = pos2(
                (dock.fx * screen.width()).clamp(120.0, screen.width() - 120.0) - 110.0,
                (dock.fy * screen.height()).clamp(40.0, screen.height() - 60.0) - 22.0,
            );
            let mut clicked_slot: Option<DockSlot> = None;
            egui::Area::new(Id::new(("dock", index)))
                .fixed_pos(pos)
                .order(egui::Order::Foreground)
                .show(ctx, |ui| {
                    // `.dock`: 72% of the deep page colour, radius 26, a strong
                    // hairline and a long shadow, so it reads as chrome floating
                    // over the page rather than a solid bar.
                    // The dock is chrome in both themes: near-black on the dark
                    // page, near-white on the light one, as `.dock` does.
                    let deep = if self.theme.dark {
                        crate::theme::hsl(220.0, 24.0, 8.0)
                    } else {
                        crate::theme::hsl(210.0, 30.0, 97.0)
                    };
                    let frame = egui::Frame::none()
                        .fill(Color32::from_rgba_unmultiplied(
                            deep.r(),
                            deep.g(),
                            deep.b(),
                            if self.theme.dark { 184 } else { 214 },
                        ))
                        .rounding(self.theme.radius(26.0))
                        .stroke(Stroke::new(1.0_f32, self.theme.border()))
                        .shadow(egui::epaint::Shadow {
                            offset: vec2(0.0, 18.0),
                            blur: 50.0,
                            spread: 0.0,
                            color: Color32::from_black_alpha(72),
                        })
                        .inner_margin(egui::Margin::symmetric(8.0, 6.0));
                    let response = frame
                        .show(ui, |ui| {
                            ui.horizontal(|ui| {
                                ui.spacing_mut().item_spacing.x = 4.0;
                                for slot in &dock.slots {
                                    let (rect, response) =
                                        ui.allocate_exact_size(vec2(34.0, 30.0), Sense::click());
                                    let bg = if response.hovered() { self.theme.accent_soft() } else { Color32::TRANSPARENT };
                                    ui.painter().rect_filled(rect, self.theme.radius(9.0), bg);
                                    let color = if response.hovered() { self.theme.accent_text() } else { self.theme.text_muted() };
                                    icon_draw(ui.painter(), &slot.icon, Rect::from_center_size(rect.center(), vec2(15.0, 15.0)), color, 1.6);
                                    if !slot.key.is_empty() {
                                        ui.painter().text(
                                            rect.right_bottom() - vec2(4.0, 5.0),
                                            Align2::RIGHT_BOTTOM,
                                            &slot.key,
                                            egui::FontId::proportional(8.0),
                                            self.theme.text_faint(),
                                        );
                                    }
                                    if response.clicked() {
                                        clicked_slot = Some(slot.clone());
                                        self.info(slot.label.clone());
                                    }
                                    response.on_hover_text(format!("{} ({})", slot.label, slot.key));
                                }
                            });
                        })
                        .response;
                    let drag = ui.interact(response.rect, Id::new(("dock-drag", index)), Sense::drag());
                    if drag.dragged() {
                        let delta = ctx.input(|input| input.pointer.delta());
                        if let Some(dock) = self.data.prefs.docks.get_mut(index) {
                            dock.fx = (dock.fx + delta.x / screen.width()).clamp(0.05, 0.95);
                            dock.fy = (dock.fy + delta.y / screen.height()).clamp(0.05, 0.95);
                        }
                        self.mark_dirty();
                    }
                });
            if let Some(slot) = clicked_slot {
                self.run_dock_action(&slot);
            }
        }
    }

    fn run_dock_action(&mut self, slot: &DockSlot) {
        match slot.action.as_str() {
            "view" => {
                self.data.prefs.view = match slot.value.as_str() {
                    "list" => VaultView::List,
                    "grid" => VaultView::Grid,
                    _ => VaultView::Animated,
                };
            }
            "channel" => self.scope = Scope::Channel(slot.value.clone()),
            "tab" => {
                self.scope = match slot.value.as_str() {
                    "favorites" => Scope::Favorites,
                    "attention" => Scope::Attention,
                    "dashboard" => Scope::Dashboard,
                    "roadmap" => Scope::Roadmap,
                    _ => Scope::All,
                }
            }
            "new-login" => self.new_login(),
            "settings" => self.settings.open = true,
            "lock" => self.lock(),
            "search" => self.search_focus = true,
            _ => {}
        }
    }

    fn run_dock_keys(&mut self, ctx: &egui::Context) {
        if self.locked || ctx.wants_keyboard_input() || self.editor.is_open() || self.settings.open || self.palette_open {
            return;
        }
        let events = ctx.input(|input| input.events.clone());
        for event in events {
            if let egui::Event::Text(text) = event {
                if text.chars().count() != 1 {
                    continue;
                }
                let key = text.to_lowercase();
                for dock in self.data.prefs.docks.clone() {
                    if !dock.enabled {
                        continue;
                    }
                    if let Some(slot) = dock.slots.iter().find(|slot| slot.key.to_lowercase() == key) {
                        self.run_dock_action(slot);
                        return;
                    }
                }
            }
        }
    }
}

/// One soft accent wash. A fan of triangles from a coloured centre to a
/// transparent rim gives the radial falloff egui lacks natively.
fn radial_blob(painter: &egui::Painter, center: egui::Pos2, radius: f32, colour: Color32, strength: f32) {
    const STEPS: usize = 48;
    let mut mesh = egui::Mesh::default();
    mesh.vertices.push(egui::epaint::Vertex {
        pos: center,
        uv: egui::epaint::WHITE_UV,
        color: Color32::from_rgba_unmultiplied(
            colour.r(),
            colour.g(),
            colour.b(),
            (255.0 * strength) as u8,
        ),
    });
    for index in 0..STEPS {
        let angle = index as f32 / STEPS as f32 * std::f32::consts::TAU;
        mesh.vertices.push(egui::epaint::Vertex {
            pos: center + vec2(angle.cos(), angle.sin()) * radius,
            uv: egui::epaint::WHITE_UV,
            color: Color32::TRANSPARENT,
        });
    }
    for index in 0..STEPS {
        let next = (index + 1) % STEPS;
        mesh.add_triangle(0, 1 + index as u32, 1 + next as u32);
    }
    painter.add(egui::Shape::mesh(mesh));
}

fn save_png(path: &std::path::Path, image: &egui::ColorImage) {
    let mut bytes = Vec::with_capacity(image.width() * image.height() * 4);
    for pixel in &image.pixels {
        bytes.extend_from_slice(&pixel.to_array());
    }
    match image::save_buffer(
        path,
        &bytes,
        image.width() as u32,
        image.height() as u32,
        image::ColorType::Rgba8,
    ) {
        Ok(()) => eprintln!("screenshot: {}", path.display()),
        Err(error) => eprintln!("could not write {}: {error}", path.display()),
    }
}

fn now_seconds() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs_f64())
        .unwrap_or(0.0)
}

fn decorate_theme(mut theme: Theme, prefs: &Preferences) -> Theme {
    theme.density = prefs.density.theme().scale();
    theme.roundness = prefs.roundness;
    theme.text_scale = (prefs.text_scale as f32 / 100.0).clamp(0.75, 1.5);
    theme.reduce_transparency = prefs.reduce_transparency;
    theme.high_contrast = prefs.high_contrast;
    theme
}

fn window_frame(theme: &Theme) -> egui::Frame {
    egui::Frame::none()
        .fill(theme.surface())
        .rounding(theme.radius(18.0))
        .stroke(Stroke::new(1.0_f32, theme.border_strong()))
        .shadow(egui::epaint::Shadow {
            offset: vec2(0.0, 12.0),
            blur: 34.0,
            spread: 0.0,
            color: Color32::from_black_alpha(120),
        })
        .inner_margin(egui::Margin::same(16.0))
}

/// CSS `linear-gradient(120deg, …)` approximated with a 2×2 mesh. Rounded
/// corners come from painting a rounded rect first and clipping the mesh to it.
pub fn paint_gradient(painter: &egui::Painter, rect: Rect, from: Color32, to: Color32, rounding: f32) {
    painter.rect_filled(rect, egui::Rounding::same(rounding), from);
    let mut mesh = egui::Mesh::default();
    mesh.colored_vertex(rect.left_top(), from);
    mesh.colored_vertex(rect.right_top(), mix(from, to, 0.55));
    mesh.colored_vertex(rect.right_bottom(), to);
    mesh.colored_vertex(rect.left_bottom(), mix(from, to, 0.35));
    mesh.add_triangle(0, 1, 2);
    mesh.add_triangle(0, 2, 3);
    painter.with_clip_rect(rect.shrink(1.0)).add(egui::Shape::mesh(mesh));}

/// One rail row, following `.nav-item`: a 7px hue dot, the glyph in a 26px
/// circular hue-tinted chip, the name, then the count. The chip is what makes
/// the Electron rail read as channels rather than as a plain icon list.
fn nav_item(
    ui: &mut egui::Ui,
    theme: &Theme,
    icon: &str,
    label: &str,
    count: Option<usize>,
    active: bool,
    compact: bool,
    indent: f32,
    hue: Option<f32>,
) -> egui::Response {
    let (rect, response) = ui.allocate_exact_size(vec2(ui.available_width(), 42.0), Sense::click());
    paint_rail_row(ui, theme, rect, &response, active);
    let channel_hue = hue.unwrap_or(212.0);
    let accent = if active { theme.accent_text() } else { theme.text() };
    let mut left = rect.left() + 12.0 + indent;
    if let Some(hue) = hue {
        let dot_colour = crate::theme::hsl(hue, 48.0, if theme.dark { 56.0 } else { 46.0 });
        ui.painter().circle_filled(pos2(left + 3.5, rect.center().y), 3.5, dot_colour);
        left += 19.0;
    }
    // `.nav-item__icon`: 26px round chip, hue at 14% behind a 70% hue glyph.
    let chip = Rect::from_center_size(pos2(left + 13.0, rect.center().y), vec2(26.0, 26.0));
    let chip_bg = crate::theme::hsl_alpha(channel_hue, 48.0, 55.0, if theme.dark { 0.14 } else { 0.16 });
    ui.painter().circle_filled(chip.center(), 13.0, chip_bg);
    let glyph = if active {
        theme.accent_text()
    } else if theme.dark {
        crate::theme::hsl(channel_hue, 55.0, 70.0)
    } else {
        crate::theme::hsl(channel_hue, 45.0, 42.0)
    };
    icon_draw(
        ui.painter(),
        icon,
        Rect::from_center_size(chip.center(), vec2(15.0, 15.0)),
        glyph,
        1.5,
    );
    if !compact {
        ui.painter().text(
            pos2(left + 38.0, rect.center().y),
            Align2::LEFT_CENTER,
            label,
            egui::FontId::proportional(13.0 * theme.text_scale),
            accent,
        );
        if let Some(count) = count {
            ui.painter().text(
                pos2(rect.right() - 12.0, rect.center().y),
                Align2::RIGHT_CENTER,
                count.to_string(),
                egui::FontId::proportional(11.0 * theme.text_scale),
                if active { theme.accent_text() } else { theme.text_faint() },
            );
        }
    }
    response
}

/// A folder header: chevron, folder glyph in an accent chip, name, child count.
fn nav_folder(
    ui: &mut egui::Ui,
    theme: &Theme,
    label: &str,
    count: usize,
    active: bool,
    compact: bool,
    collapsed: bool,
) -> egui::Response {
    let (rect, response) = ui.allocate_exact_size(vec2(ui.available_width(), 42.0), Sense::click());
    paint_rail_row(ui, theme, rect, &response, active);
    icon_draw(
        ui.painter(),
        if collapsed { "chevron-left" } else { "chevron" },
        Rect::from_center_size(pos2(rect.left() + 16.0, rect.center().y), vec2(10.0, 10.0)),
        theme.text_faint(),
        1.3,
    );
    let chip = Rect::from_center_size(pos2(rect.left() + 44.0, rect.center().y), vec2(26.0, 26.0));
    ui.painter().circle_filled(
        chip.center(),
        13.0,
        crate::theme::hsl_alpha(212.0, 48.0, 55.0, if theme.dark { 0.14 } else { 0.16 }),
    );
    icon_draw(
        ui.painter(),
        "folder",
        Rect::from_center_size(chip.center(), vec2(15.0, 15.0)),
        if active {
            theme.accent_text()
        } else if theme.dark {
            crate::theme::hsl(212.0, 55.0, 70.0)
        } else {
            crate::theme::hsl(212.0, 45.0, 42.0)
        },
        1.5,
    );
    if !compact {
        ui.painter().text(
            pos2(rect.left() + 69.0, rect.center().y),
            Align2::LEFT_CENTER,
            label,
            egui::FontId::proportional(13.0 * theme.text_scale),
            if active { theme.accent_text() } else { theme.text() },
        );
        ui.painter().text(
            pos2(rect.right() - 12.0, rect.center().y),
            Align2::RIGHT_CENTER,
            count.to_string(),
            egui::FontId::proportional(11.0 * theme.text_scale),
            if active { theme.accent_text() } else { theme.text_faint() },
        );
    }
    response
}

/// The row underlay both rail rows share: gradient wash plus the gutter bar.
fn paint_rail_row(ui: &egui::Ui, theme: &Theme, rect: egui::Rect, response: &egui::Response, active: bool) {
    let (wash_a, wash_b) = theme.accent_gradient_soft();
    if active {
        paint_gradient(ui.painter(), rect, wash_a, wash_b, 12.0 * theme.roundness * 0.6);
        let (bar_a, bar_b) = theme.gradient();
        // The bar sits in the gutter outside the pill, the way
        // `.nav-item[aria-current]:before { left: -12px }` places it.
        let bar = Rect::from_min_size(pos2(rect.left() - 10.0, rect.center().y - 9.0), vec2(3.0, 18.0));
        paint_gradient(ui.painter(), bar, bar_a, bar_b, 2.0);
    } else if response.hovered() {
        ui.painter().rect_filled(rect, theme.radius(12.0), theme.surface_hover());
    }
}

/// Which card covers `pos`. Later cards win, which is the draw order.
fn card_at<'a>(rects: &'a [(egui::Rect, String)], pos: egui::Pos2) -> Option<&'a str> {
    rects
        .iter()
        .rev()
        .find(|(rect, _)| rect.contains(pos))
        .map(|(_, id)| id.as_str())
}

fn ctx_row(
    ui: &mut egui::Ui,
    theme: &Theme,
    icon: &str,
    label: &str,
    enabled: bool,
    danger: bool,
) -> bool {
    let (rect, response) = ui.allocate_exact_size(vec2(ui.available_width(), 28.0), Sense::click());
    let hot = response.hovered() && enabled;
    if hot {
        let fill = if danger { theme.danger_soft() } else { theme.accent_soft() };
        ui.painter().rect_filled(rect, theme.radius(8.0), fill);
    }
    let text_color = if !enabled {
        theme.text_faint()
    } else if danger {
        if hot { theme.danger() } else { theme.text() }
    } else if hot {
        theme.accent_text()
    } else {
        theme.text()
    };
    icon_draw(
        ui.painter(),
        icon,
        Rect::from_center_size(pos2(rect.left() + 17.0, rect.center().y), vec2(13.0, 13.0)),
        if enabled { text_color } else { theme.text_faint() },
        1.4,
    );
    ui.painter().text(
        pos2(rect.left() + 36.0, rect.center().y),
        Align2::LEFT_CENTER,
        label,
        egui::FontId::proportional(12.5 * theme.text_scale),
        text_color,
    );
    enabled && response.clicked()
}

/// The feathered divider the Electron menus use between groups.
fn ctx_divider(ui: &mut egui::Ui, theme: &Theme) {
    ui.add_space(5.0);
    let (rect, _) = ui.allocate_exact_size(vec2(ui.available_width(), 1.0), Sense::hover());
    let left = rect.left() + 8.0;
    let right = rect.right() - 8.0;
    ui.painter().line_segment(
        [pos2(left, rect.center().y), pos2(right, rect.center().y)],
        Stroke::new(1.0_f32, theme.border()),
    );
    ui.add_space(5.0);
}

#[cfg(test)]
mod tests {
    use super::card_at;
    use egui::{pos2, Rect};

    #[test]
    fn a_right_click_resolves_to_the_card_under_it() {
        let rects = vec![
            (Rect::from_min_max(pos2(10.0, 10.0), pos2(200.0, 100.0)), "first".to_string()),
            (Rect::from_min_max(pos2(10.0, 110.0), pos2(200.0, 200.0)), "second".to_string()),
        ];
        assert_eq!(card_at(&rects, pos2(50.0, 50.0)), Some("first"));
        assert_eq!(card_at(&rects, pos2(50.0, 150.0)), Some("second"));
        assert_eq!(card_at(&rects, pos2(500.0, 50.0)), None);
    }
}

fn command_row(ui: &mut egui::Ui, theme: &Theme, icon: &str, label: &str, selected: bool) -> egui::Response {
    let (rect, response) = ui.allocate_exact_size(vec2(ui.available_width(), 32.0), Sense::click());
    let fill = if response.hovered() || selected {
        theme.accent_soft()
    } else {
        Color32::TRANSPARENT
    };
    ui.painter().rect_filled(rect, theme.radius(9.0), fill);
    icon_draw(
        ui.painter(),
        icon,
        Rect::from_center_size(pos2(rect.left() + 18.0, rect.center().y), vec2(13.0, 13.0)),
        theme.text_muted(),
        1.5,
    );
    ui.painter().text(
        pos2(rect.left() + 36.0, rect.center().y),
        Align2::LEFT_CENTER,
        label,
        egui::FontId::proportional(12.0 * theme.text_scale),
        theme.text(),
    );
    response
}

fn sort_menu(ui: &mut egui::Ui, app: &mut App) {
    let label = app.data.prefs.sort.label();
    egui::menu::menu_button(ui, RichText::new(label).size(10.5).color(app.theme.text_muted()), |ui| {
        for mode in SortMode::ALL {
            if ui.selectable_label(app.data.prefs.sort == mode, mode.label()).clicked() {
                app.data.prefs.sort = mode;
                app.mark_dirty();
            }
        }
    });
}

#[derive(Clone)]
enum PaletteAction {
    NewLogin,
    Settings,
    Lock,
    Scope(Scope),
    Shortcuts,
    Tag(String),
}

impl eframe::App for App {
    /// The debounced saver may still be waiting for its 0.7 s window when the
    /// window closes; flushing here is what stops the last edit being lost.
    fn on_exit(&mut self, _gl: Option<&eframe::glow::Context>) {
        if !self.locked {
            let _ = io::save(&self.data, self.password.as_deref());
        }
    }

    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        if let Some(scale) = self.harness_scale {
            ctx.set_pixels_per_point(scale);
        }
        self.ticks += 1;
        // At 150% the logical screen is 1280x720, so the 1280x840 default window
        // ran off the bottom: the dock and the last card sat below the display.
        // Fit once, and only when the harness did not ask for an exact size.
        if !self.fitted_window {
            if let Some(monitor) = ctx.input(|input| input.viewport().monitor_size) {
                self.fitted_window = true;
                let current = ctx.screen_rect().size();
                let limit = vec2(monitor.x * 0.94, monitor.y * 0.92);
                if !self.explicit_size && (current.x > limit.x || current.y > limit.y) {
                    ctx.send_viewport_cmd(egui::ViewportCommand::InnerSize(vec2(
                        current.x.min(limit.x),
                        current.y.min(limit.y),
                    )));
                }
            }
        }
        // Theme follows the settings and the OS without a rebuild button.
        self.system_dark = ctx.style().visuals.dark_mode;
        let wanted = decorate_theme(
            Theme::build(self.data.prefs.theme.into(), self.data.prefs.accent.theme(), self.system_dark),
            &self.data.prefs,
        );
        let changed = wanted.dark != self.theme.dark
            || wanted.hues != self.theme.hues
            || wanted.density != self.theme.density
            || wanted.roundness != self.theme.roundness
            || wanted.text_scale != self.theme.text_scale
            || wanted.high_contrast != self.theme.high_contrast
            || wanted.reduce_transparency != self.theme.reduce_transparency
            || self.reset_theme_cache;
        if changed {
            self.theme = wanted;
            self.theme.apply(ctx, self.text_scale());
            self.reset_theme_cache = false;
        }
        if ctx.input(|input| input.pointer.any_down() || input.key_pressed(egui::Key::Enter)) {
            self.last_input = now_seconds();
        }

        if let Some(path) = self.screenshot_path.clone() {
            self.capture(ctx, &path);
        }

        // Behind every panel, like the Electron build's `.ambient` layer.
        self.paint_ambient(ctx);

        if self.locked {
            self.unlock_screen(ctx);
            self.toasts_ui(ctx);
            return;
        }

        self.hotkeys(ctx);
        self.run_dock_keys(ctx);
        self.check_alarms();

        // Half a second is enough to turn the 2FA countdown over on time without
        // repainting a window that has nothing to show.
        if self.editor.is_open() || self.data.items.iter().any(|item| !item.totp_secret.trim().is_empty()) {
            ctx.request_repaint_after(std::time::Duration::from_millis(500));
        }

        if self.clipboard_clear_at.map(|at| now_seconds() >= at).unwrap_or(false) {
            ctx.output_mut(|output| output.copied_text = String::new());
            self.clipboard_clear_at = None;
        }
        let auto_lock = self.data.prefs.auto_lock_minutes;
        if self.password.is_some()
            && auto_lock > 0
            && now_seconds() - self.last_input > auto_lock as f64 * 60.0
            && !self.settings.open
        {
            self.lock();
        }

        self.card_rects.clear();
        self.topbar(ctx);
        self.sidebar(ctx);
        self.content(ctx);
        self.open_menu_at_pointer(ctx);
        self.dock(ctx);

        editor::show(ctx, self);
        self.context_menu(ctx);
        roadmap::details(ctx, self);
        settings::show(ctx, self);
        self.palette(ctx);
        self.shortcuts(ctx);
        self.confirm_modal(ctx);
        self.bulk_add(ctx);
        self.toasts_ui(ctx);
        self.flush();
    }
}
