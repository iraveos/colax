//! The vault model, ported from the Electron app's `types.ts` and the
//! preference record in `storage.ts`.
//!
//! Field names are camelCase on disk so a JSON export from either edition reads
//! the same way, and every record carries `serde(default)` so a vault written by
//! an older build opens instead of failing on a missing field.

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or(0)
}

pub fn new_id(prefix: &str) -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    format!("{prefix}-{:x}{:x}", now_ms(), rng.gen::<u32>())
}

/* ---- Enums --------------------------------------------------------------- */

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemeSetting {
    System,
    Light,
    Dark,
}

impl Default for ThemeSetting {
    fn default() -> Self {
        Self::System
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AccentSetting {
    Slate,
    Sage,
    Dusk,
    Clay,
}

impl Default for AccentSetting {
    fn default() -> Self {
        Self::Slate
    }
}

impl AccentSetting {
    pub fn theme(self) -> crate::theme::Accent {
        match self {
            AccentSetting::Slate => crate::theme::Accent::Slate,
            AccentSetting::Sage => crate::theme::Accent::Sage,
            AccentSetting::Dusk => crate::theme::Accent::Dusk,
            AccentSetting::Clay => crate::theme::Accent::Clay,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DensitySetting {
    Compact,
    Comfortable,
    Spacious,
}

impl Default for DensitySetting {
    fn default() -> Self {
        Self::Compact
    }
}

impl DensitySetting {
    pub fn theme(self) -> crate::theme::Density {
        match self {
            DensitySetting::Compact => crate::theme::Density::Compact,
            DensitySetting::Comfortable => crate::theme::Density::Comfortable,
            DensitySetting::Spacious => crate::theme::Density::Spacious,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum VaultView {
    Animated,
    List,
    Grid,
}

impl Default for VaultView {
    fn default() -> Self {
        Self::Animated
    }
}

impl VaultView {
    pub fn label(self) -> &'static str {
        match self {
            VaultView::Animated => "Flow",
            VaultView::List => "List",
            VaultView::Grid => "Grid",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SortMode {
    Title,
    Updated,
    Created,
    Strength,
    Username,
}

impl Default for SortMode {
    fn default() -> Self {
        Self::Title
    }
}

impl SortMode {
    pub fn label(self) -> &'static str {
        match self {
            SortMode::Title => "Name A–Z",
            SortMode::Updated => "Recently updated",
            SortMode::Created => "Newest first",
            SortMode::Strength => "Weakest first",
            SortMode::Username => "Username",
        }
    }

    pub const ALL: [SortMode; 5] = [
        SortMode::Title,
        SortMode::Updated,
        SortMode::Created,
        SortMode::Strength,
        SortMode::Username,
    ];
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SidebarLabels {
    Both,
    Icon,
    Name,
}

impl Default for SidebarLabels {
    fn default() -> Self {
        Self::Both
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RailPosition {
    Left,
    Right,
    Top,
    Bottom,
}

impl Default for RailPosition {
    fn default() -> Self {
        Self::Left
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RailAlign {
    Top,
    Middle,
    Bottom,
}

impl Default for RailAlign {
    fn default() -> Self {
        Self::Middle
    }
}

/* ---- Records ------------------------------------------------------------- */

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VaultItem {
    pub id: String,
    pub title: String,
    pub username: String,
    pub password: String,
    pub url: String,
    pub notes: String,
    pub totp_secret: String,
    pub favorite: bool,
    pub needs_attention: bool,
    pub tags: Vec<String>,
    pub accent_hue: Option<f32>,
    pub background_image: String,
    pub avatar_image: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub password_updated_at: i64,
    /// Since when the username is stale, used by the editor's reminder strip.
    #[serde(default)]
    pub username_updated_at: i64,
    pub reminder_days: f32,
}

impl Default for VaultItem {
    fn default() -> Self {
        let now = now_ms();
        Self {
            id: String::new(),
            title: String::new(),
            username: String::new(),
            password: String::new(),
            url: String::new(),
            notes: String::new(),
            totp_secret: String::new(),
            favorite: false,
            needs_attention: false,
            tags: Vec::new(),
            accent_hue: None,
            background_image: String::new(),
            avatar_image: String::new(),
            created_at: now,
            updated_at: now,
            password_updated_at: now,
            username_updated_at: now,
            reminder_days: 0.0,
        }
    }
}

impl VaultItem {
    pub fn fresh() -> Self {
        Self { id: new_id("login"), ..Default::default() }
    }

    /// The accent hue a card is drawn with: its own choice, else a stable hash
    /// of the identity so a login keeps the same colour between launches.
    pub fn hue(&self) -> f32 {
        if let Some(hue) = self.accent_hue {
            if hue.is_finite() {
                return ((hue % 360.0) + 360.0) % 360.0;
            }
        }
        hue_for(if !self.title.is_empty() {
            &self.title
        } else if !self.username.is_empty() {
            &self.username
        } else if !self.url.is_empty() {
            &self.url
        } else {
            "colax"
        })
    }

    pub fn host(&self) -> String {
        hostname_of(&self.url).unwrap_or_default()
    }

    pub fn initials(&self) -> String {
        let source = if !self.title.is_empty() { &self.title } else { &self.username };
        let mut letters = source
            .split(|character: char| character.is_whitespace() || character == '.' || character == '-')
            .filter(|part| !part.is_empty())
            .filter_map(|part| part.chars().next());
        let first = letters.next().unwrap_or('C');
        let second = letters.next();
        match second {
            Some(second) => format!("{first}{second}").to_uppercase(),
            None => first.to_uppercase().to_string(),
        }
    }

    pub fn display_title(&self) -> &str {
        if !self.title.is_empty() {
            &self.title
        } else if !self.username.is_empty() {
            &self.username
        } else if !self.url.is_empty() {
            &self.url
        } else {
            "Untitled login"
        }
    }
}

pub fn hue_for(label: &str) -> f32 {
    let mut hash: i32 = 0;
    for character in label.chars() {
        hash = hash.wrapping_mul(31).wrapping_add(character as i32);
    }
    (hash.abs() % 360) as f32
}

/// Hostname for the "open site" action and the row subtitle.
pub fn hostname_of(url: &str) -> Option<String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return None;
    }
    let without_scheme = trimmed.split("://").last().unwrap_or(trimmed);
    let host = without_scheme.split(['/', '?', '#']).next().unwrap_or("");
    let host = host.rsplit('@').next().unwrap_or(host);
    let host = host.split(':').next().unwrap_or(host);
    if host.is_empty() {
        None
    } else {
        Some(host.to_string())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub hue: f32,
}

impl Default for Tag {
    fn default() -> Self {
        Self { id: String::new(), name: String::new(), hue: 210.0 }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChannelKind {
    All,
    Favorites,
    Attention,
    Custom,
    Tag,
}

impl Default for ChannelKind {
    fn default() -> Self {
        Self::Custom
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Channel {
    pub id: String,
    pub name: String,
    pub kind: ChannelKind,
    pub icon: String,
    pub hue: f32,
    pub tag_ids: Vec<String>,
    pub folder_id: String,
    pub builtin: bool,
    pub hidden: bool,
}

impl Default for Channel {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            kind: ChannelKind::Custom,
            icon: "channel".into(),
            hue: 210.0,
            tag_ids: Vec::new(),
            folder_id: String::new(),
            builtin: false,
            hidden: false,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Folder {
    pub id: String,
    pub name: String,
    pub collapsed: bool,
    pub hidden: bool,
}

impl Default for Folder {
    fn default() -> Self {
        Self { id: String::new(), name: String::new(), collapsed: false, hidden: false }
    }
}

/// Where a quick-launch slot sends the window. Kept as strings rather than a
/// tagged enum so an unknown action from a newer build reads as inert instead of
/// failing the whole file.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DockSlot {
    pub id: String,
    pub label: String,
    pub key: String,
    pub icon: String,
    /// `view`, `channel`, `tab`, `new-login`, `settings`, `lock`, `search`.
    pub action: String,
    /// View name, channel id, tab id — whatever the action needs.
    pub value: String,
}

impl Default for DockSlot {
    fn default() -> Self {
        Self {
            id: String::new(),
            label: String::new(),
            key: String::new(),
            icon: "dot".into(),
            action: "view".into(),
            value: String::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DockState {
    pub id: String,
    pub slots: Vec<DockSlot>,
    pub enabled: bool,
    /// Normalised position of the bar's centre inside the window.
    pub fx: f32,
    pub fy: f32,
}

impl Default for DockState {
    fn default() -> Self {
        Self { id: String::new(), slots: Vec::new(), enabled: true, fx: 0.5, fy: 0.94 }
    }
}

pub fn default_dock_slots() -> Vec<DockSlot> {
    vec![
        DockSlot {
            id: "slot-flow".into(),
            label: "Flow".into(),
            key: "1".into(),
            icon: "cards".into(),
            action: "view".into(),
            value: "animated".into(),
        },
        DockSlot {
            id: "slot-list".into(),
            label: "List".into(),
            key: "2".into(),
            icon: "list".into(),
            action: "view".into(),
            value: "list".into(),
        },
        DockSlot {
            id: "slot-grid".into(),
            label: "Grid".into(),
            key: "3".into(),
            icon: "grid".into(),
            action: "view".into(),
            value: "grid".into(),
        },
        DockSlot {
            id: "slot-new".into(),
            label: "New login".into(),
            key: "n".into(),
            icon: "plus".into(),
            action: "new-login".into(),
            value: String::new(),
        },
        DockSlot {
            id: "slot-settings".into(),
            label: "Settings".into(),
            key: "s".into(),
            icon: "settings".into(),
            action: "settings".into(),
            value: String::new(),
        },
    ]
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Alarm {
    pub id: String,
    pub label: String,
    pub hour: u32,
    pub minute: u32,
    /// Weekday numbers, 0 = Sunday.
    pub days: Vec<u32>,
    pub enabled: bool,
    pub sound: String,
}

impl Default for Alarm {
    fn default() -> Self {
        Self {
            id: String::new(),
            label: String::new(),
            hour: 9,
            minute: 0,
            days: vec![1, 2, 3, 4, 5],
            enabled: true,
            sound: "chime".into(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GeneratorPrefs {
    pub length: u32,
    pub lower: bool,
    pub upper: bool,
    pub digits: bool,
    pub symbols: bool,
    pub avoid_ambiguous: bool,
}

impl Default for GeneratorPrefs {
    fn default() -> Self {
        Self { length: 20, lower: true, upper: true, digits: true, symbols: true, avoid_ambiguous: true }
    }
}

/* ---- Preferences --------------------------------------------------------- */

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Preferences {
    // Appearance
    pub theme: ThemeSetting,
    pub accent: AccentSetting,
    pub motion: f32,
    pub motion_speed: f32,
    pub micro_motion: bool,
    pub ambient: f32,
    pub density: DensitySetting,
    pub roundness: f32,
    pub card_depth: f32,
    pub text_scale: i32,
    pub reduce_transparency: bool,
    pub high_contrast: bool,
    // Background
    pub background_image: String,
    pub background_opacity: f32,
    pub background_blur: f32,
    pub background_dim: f32,
    // Layout
    pub view: VaultView,
    pub sort: SortMode,
    pub show_urls: bool,
    pub show_notes: bool,
    pub click_to_copy: bool,
    pub pin_favorites: bool,
    pub show_health_badges: bool,
    pub show_tag_chips: bool,
    pub hide_dividers: bool,
    pub show_letter_groups: bool,
    pub sidebar_labels: SidebarLabels,
    pub sidebar_position: RailPosition,
    pub rail_align: RailAlign,
    pub compact_sidebar: bool,
    pub show_sidebar: bool,
    pub show_shortcuts: bool,
    pub show_new_login_button: bool,
    pub show_bulk_add_button: bool,
    pub show_settings_button: bool,
    pub show_lock_button: bool,
    pub show_new_channel_button: bool,
    pub auto_tag_domain: bool,
    pub show_unassigned_channel: bool,
    // Behaviour
    pub mask_emails: bool,
    pub reveal_passwords: bool,
    pub warn_on_reuse: bool,
    pub confirm_before_export: bool,
    pub clear_clipboard_seconds: u32,
    pub clear_clipboard_on_lock: bool,
    pub auto_lock_minutes: u32,
    pub password_age_days: u32,
    pub email_age_days: u32,
    pub email_check_days: u32,
    pub notifications: String,
    // Generator
    pub password_generator: GeneratorPrefs,
    // Data
    pub disable_spellcheck: bool,
    // Desktop
    pub tray_enabled: bool,
    pub close_to_tray: bool,
    pub launch_at_login: bool,
    pub sounds_muted: bool,
    // Collections
    pub channels: Vec<Channel>,
    pub tags: Vec<Tag>,
    pub folders: Vec<Folder>,
    pub docks: Vec<DockState>,
    pub alarms: Vec<Alarm>,
    pub hidden_channels: Vec<String>,
    pub hidden_folders: Vec<String>,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            theme: ThemeSetting::System,
            accent: AccentSetting::Slate,
            motion: 1.0,
            motion_speed: 2.0,
            micro_motion: false,
            ambient: 1.0,
            density: DensitySetting::Compact,
            roundness: 1.4,
            card_depth: 1.0,
            text_scale: 100,
            reduce_transparency: false,
            high_contrast: true,
            background_image: String::new(),
            background_opacity: 0.35,
            background_blur: 0.0,
            background_dim: 0.25,
            view: VaultView::Animated,
            sort: SortMode::Title,
            show_urls: true,
            show_notes: true,
            click_to_copy: true,
            pin_favorites: true,
            show_health_badges: true,
            show_tag_chips: true,
            hide_dividers: true,
            show_letter_groups: false,
            sidebar_labels: SidebarLabels::Both,
            sidebar_position: RailPosition::Left,
            rail_align: RailAlign::Middle,
            compact_sidebar: false,
            show_sidebar: true,
            show_shortcuts: false,
            show_new_login_button: true,
            show_bulk_add_button: true,
            show_settings_button: true,
            show_lock_button: true,
            show_new_channel_button: true,
            auto_tag_domain: true,
            show_unassigned_channel: true,
            mask_emails: true,
            reveal_passwords: false,
            warn_on_reuse: true,
            confirm_before_export: false,
            clear_clipboard_seconds: 30,
            clear_clipboard_on_lock: true,
            auto_lock_minutes: 5,
            password_age_days: 180,
            email_age_days: 365,
            email_check_days: 90,
            notifications: "all".into(),
            password_generator: GeneratorPrefs::default(),
            disable_spellcheck: false,
            tray_enabled: true,
            close_to_tray: true,
            launch_at_login: false,
            sounds_muted: false,
            channels: Vec::new(),
            tags: Vec::new(),
            folders: Vec::new(),
            docks: vec![DockState {
                id: "main".into(),
                slots: default_dock_slots(),
                enabled: true,
                fx: 0.5,
                fy: 0.94,
            }],
            alarms: Vec::new(),
            hidden_channels: Vec::new(),
            hidden_folders: Vec::new(),
        }
    }
}

impl Preferences {
    pub fn tag_name(&self, id: &str) -> String {
        self.tags
            .iter()
            .find(|tag| tag.id == id)
            .map(|tag| tag.name.clone())
            .unwrap_or_else(|| id.to_string())
    }

    pub fn tag_of_name(&self, name: &str) -> Option<&Tag> {
        self.tags.iter().find(|tag| tag.name.eq_ignore_ascii_case(name))
    }

    /// Creates any missing tag with the same hue derivation the Electron app
    /// uses (`hueFor`), so colours survive a round trip between editions.
    pub fn ensure_tag(&mut self, name: &str) -> String {
        if let Some(tag) = self.tag_of_name(name) {
            return tag.id.clone();
        }
        let id = new_id("tag");
        self.tags.push(Tag { id: id.clone(), name: name.trim().to_string(), hue: hue_for(name) });
        id
    }
}

/* ---- Vault --------------------------------------------------------------- */

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct HistoryEntry {
    pub id: String,
    pub at: i64,
    pub action: String,
    pub detail: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct VaultData {
    pub version: u32,
    pub items: Vec<VaultItem>,
    pub prefs: Preferences,
    pub history: Vec<HistoryEntry>,
}

impl Default for VaultData {
    fn default() -> Self {
        Self { version: 1, items: Vec::new(), prefs: Preferences::default(), history: Vec::new() }
    }
}

impl VaultData {
    pub fn log(&mut self, action: &str, detail: &str) {
        self.history.insert(
            0,
            HistoryEntry { id: new_id("ev"), at: now_ms(), action: action.into(), detail: detail.into() },
        );
        self.history.truncate(200);
    }

    pub fn item(&self, id: &str) -> Option<&VaultItem> {
        self.items.iter().find(|item| item.id == id)
    }

    pub fn item_mut(&mut self, id: &str) -> Option<&mut VaultItem> {
        self.items.iter_mut().find(|item| item.id == id)
    }

    /// The tags a login carries, as names, for search and the card chips.
    pub fn tag_names(&self, item: &VaultItem) -> Vec<String> {
        item.tags.iter().map(|id| self.prefs.tag_name(id)).collect()
    }

    /// Passwords used by more than one login. Reuse is the one health signal
    /// that is cheap to compute and impossible to get wrong.
    pub fn reused_passwords(&self) -> BTreeSet<String> {
        let mut seen = BTreeSet::new();
        let mut reused = BTreeSet::new();
        for item in &self.items {
            if item.password.is_empty() {
                continue;
            }
            if !seen.insert(item.password.clone()) {
                reused.insert(item.password.clone());
            }
        }
        reused
    }

    pub fn sender_is_weak(&self, item: &VaultItem) -> bool {
        !item.password.is_empty() && password_score(&item.password) <= 1
    }

    pub fn needs_attention(&self, item: &VaultItem) -> bool {
        item.needs_attention
            || self.reused_passwords().contains(&item.password)
            || self.sender_is_weak(item)
    }
}

/// A small strength heuristic: the Electron build scores entropy; this keeps the
/// same verdicts for the cases the badges care about (short, single-class).
pub fn password_score(password: &str) -> u8 {
    if password.is_empty() {
        return 0;
    }
    let length = password.chars().count();
    let classes = [
        password.chars().any(|c| c.is_lowercase()),
        password.chars().any(|c| c.is_uppercase()),
        password.chars().any(|c| c.is_ascii_digit()),
        password.chars().any(|c| !c.is_alphanumeric()),
    ]
    .iter()
    .filter(|present| **present)
    .count();
    let mut score = 0;
    if length >= 8 {
        score += 1;
    }
    if length >= 12 {
        score += 1;
    }
    if classes >= 2 {
        score += 1;
    }
    if classes >= 3 {
        score += 1;
    }
    if length >= 16 && classes >= 3 {
        score = 4;
    }
    score.min(4)
}

pub fn password_label(score: u8) -> &'static str {
    match score {
        0 => "Empty",
        1 => "Weak",
        2 => "Fair",
        3 => "Good",
        _ => "Strong",
    }
}

/// Sample logins for a new native vault, offered from About — the React edition
/// ships an empty vault, and so does this one unless asked.
pub fn sample_items() -> Vec<VaultItem> {
    let now = now_ms();
    let rows = [
        ("Github", "https://github.com", "ivazeoz@gmail.com", "amber-harbor-42-ridge", &["Work", "Dev"][..], true),
        ("Gmail", "https://mail.google.com", "ivazeoz@gmail.com", "quartz-lantern-88", &["Google"][..], true),
        ("Discord", "https://discord.com", "ivazeoz@gmail.com", "velvet-anchor-31", &["Games"][..], false),
        ("Nvidia", "https://nvidia.com", "ivazeoz@gmail.com", "cobalt-pilot-77", &["Games", "Hardware"][..], false),
        ("Goodreads", "https://goodreads.com", "reader@proton.me", "paper-ember-19", &["Reading"][..], false),
        ("Freelancer", "https://freelancer.com", "work@colax.dev", "copper-meadow-05", &["Work"][..], false),
        ("Signal RGB", "https://signalrgb.com", "ivazeoz@gmail.com", "signalrgb", &["Games"][..], false),
        ("Proton Mail", "https://proton.me", "reader@proton.me", "steel-orchard-63", &["Personal"][..], false),
    ];
    rows.iter()
        .enumerate()
        .map(|(index, (title, url, username, password, tags, favorite))| {
            let mut item = VaultItem {
                title: (*title).into(),
                url: (*url).into(),
                username: (*username).into(),
                password: (*password).into(),
                notes: if index % 2 == 0 {
                    format!("{title} account used for {}. Rotate every few months.", tags.first().copied().unwrap_or("personal"))
                } else {
                    String::new()
                },
                favorite: *favorite,
                created_at: now - (index as i64 + 1) * 86_400_000 * 12,
                updated_at: now - (index as i64) * 3_600_000 * 9,
                password_updated_at: now - (index as i64 + 1) * 86_400_000 * 40,
                ..Default::default()
            };
            item.tags = tags.iter().map(|tag| (*tag).to_string()).collect();
            item
        })
        .collect()
}

/// Relative age text, matching the Electron `relativeTime` wording closely
/// enough that the two editions read the same.
pub fn relative_time(timestamp: i64) -> String {
    if timestamp <= 0 {
        return String::new();
    }
    let seconds = ((now_ms() - timestamp) / 1000).max(0);
    if seconds < 45 {
        return "just now".into();
    }
    if seconds < 3600 {
        return format!("{} minutes ago", (seconds as f64 / 60.0).round() as i64);
    }
    if seconds < 86_400 {
        let hours = (seconds as f64 / 3600.0).round() as i64;
        return format!("{hours} hour{} ago", if hours == 1 { "" } else { "s" });
    }
    let days = seconds / 86_400;
    let hours = (seconds % 86_400) / 3600;
    if days < 30 {
        if hours == 0 {
            return format!("{days} day{} ago", if days == 1 { "" } else { "s" });
        }
        return format!(
            "{days} day{} {hours} hour{} ago",
            if days == 1 { "" } else { "s" },
            if hours == 1 { "" } else { "s" }
        );
    }
    let months = days / 30;
    let rest = days - months * 30;
    format!(
        "{months} month{}{} ago",
        if months == 1 { "" } else { "s" },
        if rest > 0 {
            format!(" {rest} day{}", if rest == 1 { "" } else { "s" })
        } else {
            String::new()
        }
    )
}
