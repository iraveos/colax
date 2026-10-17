// Vault preferences: the typed shape, the defaults, and the normaliser.
//
// Port of E:\acc2\src\vault\storage.ts (VaultPreferences L473-839,
// DEFAULT_PREFERENCES L841-969, normalisePreferences L1069-1454).
//
// This crate ports the shape that the *appearance* layer needs first; the
// full ~90-field schema lands as the remaining settings tabs need them, and
// normalise_preferences is forward-compatible: unknown keys are ignored and
// missing keys fall back to defaults, so a web-build vault.json with the
// complete schema round-trips without data loss.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

use crate::channels::{builtin_channels, normalise_channels, Channel};
use crate::dock::{default_docks, normalise_docks, DockState};
use crate::history::{normalise_history, HistoryEvent};
use crate::model::{normalise_security, LoginSecurity};
use crate::optimize::{normalise_optimize_profiles, read_style};

/// One entry of the global tag catalogue: logins reference these by id rather
/// than by name, so renaming or recolouring one here changes every login that
/// carries it -- and a tag a login no longer references can be spotted by
/// comparing ids, without reading any of their text.
///
/// Port of `Tag` in `E:\acc2\src\vault\channels.ts:98`. The catalogue lives in
/// preferences, not on the item, because it is shared by every login.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Tag {
    pub id: String,
    pub name: String,
    /// Hue in degrees, drives the chip colour. Kept inside 0..360 by
    /// `normalise_tags`; the three shipped tags sit at 8, 36 and 268 so they
    /// stay apart at a glance.
    pub hue: f64,
}

/// One login's use record: how often it was copied or edited, and when last
/// (`{ count, at }`, storage.ts L613). The dashboard's "most used" and
/// "recent account activity" read these; entries are pruned of deleted
/// logins by the writer, and validated here.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct UsageEntry {
    pub count: i64,
    pub at: i64,
}

/// A repeating reminder with its own sound (`Alarm`, storage.ts L304-314).
/// Lives in preferences beside the tag catalogue, because both are managed
/// from Settings; the app's ticker matches these against the wall clock once
/// a second and rings the ones whose minute arrives.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Alarm {
    pub id: String,
    /// Shown in the toast; an empty label rings the time instead —
    /// `Alarm: ${alarm.label || alarm.time}` (App.tsx L280).
    pub label: String,
    /// 'HH:MM', 24h, local time.
    pub time: String,
    /// 0 = Sunday .. 6 = Saturday, the `Date.getDay()` numbering. Empty
    /// means every day.
    pub days: Vec<u8>,
    /// A name plus an imported data URL; `None` uses the built-in chime.
    pub sound: Option<AlarmSound>,
    pub enabled: bool,
}

/// The imported sound of an alarm: a name for the row that offers it, and
/// the data URL the decoder reads. A missing `dataUrl` is the chime, the way
/// `null` is in the TS (`useAlarms.ts` L60-71).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AlarmSound {
    pub name: String,
    pub data_url: Option<String>,
}

/// `al_` plus the first eight characters of a random UUID — `newAlarmId`
/// (storage.ts L316). The hyphen sits at index 8, so `slice(0, 8)` in JS is
/// exactly the first eight hex characters, which this mirrors.
pub fn new_alarm_id() -> String {
    let uuid = uuid::Uuid::new_v4().simple().to_string();
    format!("al_{}", &uuid[..8])
}

/// The password generator's defaults (`passwordGenerator`, storage.ts L935).
///
/// One object with two doors: the editor's generator reads it and writes every
/// chip back through `onOptionsChange`, and Settings › Generator edits the same
/// six fields. Porting it as a preference rather than a session setting is what
/// makes "Default length — used when the generator opens" true.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct PasswordGenerator {
    pub length: u32,
    pub lower: bool,
    pub upper: bool,
    pub digits: bool,
    pub symbols: bool,
    /// Leave out `l 1 I O 0 o` (`avoid_ambiguous`, storage.ts L941).
    pub avoid_ambiguous: bool,
}

impl Default for PasswordGenerator {
    fn default() -> Self {
        Self {
            length: 20,
            lower: true,
            upper: true,
            digits: true,
            symbols: true,
            avoid_ambiguous: true,
        }
    }
}

/// One view's card geometry (`CardSizePrefs`, storage.ts L68-89). Tuned per
/// view, because the four presentations are shaped differently: Flow and List
/// stay fluid inside a width cap, Orbit is a fixed width times an aspect, and
/// Grid reflows to whatever fits, so its width is the widest a cell may grow.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct CardSize {
    /// Overall scale, 0.6 to 1.6, text included.
    pub scale: f64,
    /// Card width in px, a cap for the fluid views and the ring's front width
    /// for Orbit.
    pub width: f64,
    /// Floor on the card's height, for Flow and List.
    pub min_height: f64,
    /// Orbit only: height as a multiple of the width.
    pub aspect: f64,
    /// How opaque the card's own surface is, 0 to 1.
    pub surface: f64,
    /// Corner radius in px.
    pub radius: f64,
}

impl Default for CardSize {
    /// Flow's numbers, which are also `DEFAULT_CARD_SIZE.animated`
    /// (storage.ts L92).
    fn default() -> Self {
        Self { scale: 1.0, width: 560.0, min_height: 132.0, aspect: 1.0, surface: 1.0, radius: 14.0 }
    }
}

/// The four views that carry their own card geometry, in the order the TS
/// normaliser walks them (storage.ts L1336).
pub const CARD_SIZE_VIEWS: [&str; 4] = ["animated", "carousel", "basic", "grid"];

/// One view's shipped card geometry (`DEFAULT_CARD_SIZE`, storage.ts L91-100).
pub fn default_card_size(view: &str) -> CardSize {
    match view {
        // Orbit is a fixed width x aspect card because its ring geometry is
        // computed from the card width (storage.ts L94).
        "carousel" => CardSize { width: 340.0, min_height: 0.0, aspect: 1.35, radius: 20.0, ..CardSize::default() },
        "basic" => CardSize { width: 900.0, min_height: 64.0, ..CardSize::default() },
        "grid" => CardSize { width: 340.0, min_height: 96.0, ..CardSize::default() },
        _ => CardSize::default(),
    }
}

/// `cardSize` as stored (storage.ts L1333-1352): every view is present, each
/// field clamped on its own so a partially-written record cannot leave a view
/// with a zero width or a NaN radius.
pub fn normalise_card_size(stored: Option<&Value>) -> BTreeMap<String, CardSize> {
    let map = stored.and_then(Value::as_object);
    let mut out = BTreeMap::new();
    for view in CARD_SIZE_VIEWS {
        let fallback = default_card_size(view);
        let raw = map.and_then(|m| m.get(view)).and_then(Value::as_object);
        let field = |key: &str, dflt: f64| num(raw.and_then(|m| m.get(key)), dflt);
        out.insert(
            view.to_string(),
            CardSize {
                scale: clamp(field("scale", fallback.scale), 0.6, 1.6),
                width: clamp(field("width", fallback.width), 180.0, 1200.0).round(),
                min_height: clamp(field("minHeight", fallback.min_height), 0.0, 480.0).round(),
                aspect: clamp(field("aspect", fallback.aspect), 0.5, 3.0),
                surface: clamp(field("surface", fallback.surface), 0.0, 1.0),
                radius: clamp(field("radius", fallback.radius), 0.0, 48.0).round(),
            },
        );
    }
    out
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct VaultPreferences {
    pub theme: String,
    pub accent: String,
    pub text_scale: f64,
    pub motion: f64,
    pub motion_speed: f64,
    /// The small transitions on buttons, chips, tabs, rows and badges
    /// (`microMotion`, storage.ts L496, normalised L1292 as `!== false` —
    /// the masking rule again). Counted as its own optimisation, because
    /// these are the only animations left when `motion` is off.
    pub micro_motion: bool,
    pub ambient: f64,
    pub density: String,
    pub roundness: f64,
    pub card_depth: f64,
    /// Per-view card geometry (`cardSize`, storage.ts L534). Always carries the
    /// four views; `default_card_size` seeds the ones a stored record omits.
    pub card_size: BTreeMap<String, CardSize>,
    /// The quick-launch bars (`docks`, storage.ts L597). At least one always
    /// exists; `normalise_docks` migrates the pre-multi-dock single bar in.
    pub docks: Vec<DockState>,
    /// Set once the Orbit slot repair has run over every stored bar, so it
    /// never runs twice (storage.ts L604).
    pub orbit_dock_restored: bool,
    pub reduce_transparency: bool,
    pub high_contrast: bool,
    pub background_image: String,
    pub background_opacity: f64,
    pub background_blur: f64,
    pub background_dim: f64,
    // Optimize (Task 1.10): the fields a saved profile stores. Every one is a
    // real, existing preference — nothing here is a parallel "performance
    // mode" flag, so applying a profile cannot leave the app in a state the
    // rest of it does not already understand.
    /// Whether opening an HTML message also fetches its inline images
    /// (`mailInlineImages`, storage.ts L742, normalised L1233 as `!== false`).
    /// The mail reader that consumes it is Phase 9; the switch and the count
    /// it feeds are the Optimize panel's.
    pub mail_inline_images: bool,
    /// Switches the spellchecker off (`disableSpellcheck`, storage.ts L527,
    /// read back as `Boolean(...)`). Desktop-only in the TS too — a browser
    /// page has no dictionary of its own. The mail phase consumes it.
    pub disable_spellcheck: bool,
    /// Saved looks (`optimizeProfiles`, storage.ts L510): a whole style under
    /// a name, newest first, at most twelve of them.
    pub optimize_profiles: Vec<crate::optimize::OptimizeProfile>,
    /// What the look was before the first trade-away (`optimizeSnapshot`,
    /// storage.ts L516), so "Restore my look" can undo the presets exactly —
    /// background picture, sliders and mail cadence included.
    pub optimize_snapshot: Option<crate::optimize::OptimizeStyle>,
    /// The saved profile now in force (`activeOptimizeProfile`, storage.ts
    /// L521) — or "" when the look on screen is not one of the saved ones.
    /// Normalised to "" unless it names a profile that exists, so the tick
    /// cannot lie.
    pub active_optimize_profile: String,
    pub view: String,
    pub sort: String,
    pub show_urls: bool,
    pub sidebar_position: String,
    pub sidebar_labels: String,
    /// `data-compact-sidebar` in the TS shell (App.tsx L2897): the rail
    /// narrows to its dot column. Set by Settings there; here it also
    /// answers to icon-only labels, which is the other half of the same
    /// expression.
    pub compact_sidebar: bool,
    /// `showSidebar`: the rail is off the window entirely (the pref is read
    /// before unlock too, so the tray can show it -- but the geometry is the
    /// shell's job).
    pub show_sidebar: bool,
    // Layout (Task 5.2): the switches Settings' Layout tab edits and its
    // Hidden tab reads back by name. `show_*` ones are visibility, so a
    // missing key must never hide a button out from under the user — the TS
    // reads most of them `!== false` (storage.ts L1096-1105).
    /// Rows under a letter heading in the List view (`showLetterGroups`).
    pub show_letter_groups: bool,
    /// Attach the site's tag to a new login as it is created
    /// (`autoTagDomain`, on by default).
    pub auto_tag_domain: bool,
    /// A sidebar entry for logins with no tag yet (`showUnassignedChannel`).
    pub show_unassigned_channel: bool,
    /// A tag created in the editor also becomes a channel (`autoTagChannel`).
    pub auto_tag_channel: bool,
    /// Titles and addresses inside the Orbit ring's cards (`showOrbitLabels`).
    pub show_orbit_labels: bool,
    /// Reused and long-untouched password flags (`showHealthBadges`).
    pub show_health_badges: bool,
    /// The sidebar's shortcut sheet (`showShortcuts`; Settings keeps its own).
    pub show_shortcuts: bool,
    /// The lock control on the main screen (`showLockButton`).
    pub show_lock_button: bool,
    /// The rail's new-channel shortcut (`showNewChannelButton`).
    pub show_new_channel_button: bool,
    /// The rail footer's narrow-rail toggle (`showCompactButton`).
    pub show_compact_button: bool,
    /// The topbar's New login shortcut (`showNewLoginButton`).
    pub show_new_login_button: bool,
    /// The topbar shortcut beside it (`showBulkAddButton`).
    pub show_bulk_add_button: bool,
    /// The rail footer's Settings shortcut (`showSettingsButton`).
    pub show_settings_button: bool,
    /// The rail footer's Hide control (`showHideSidebarButton`).
    pub show_hide_sidebar_button: bool,
    /// Sidebar, view picker and New login detached into their own pills
    /// (`floatingChrome`).
    pub floating_chrome: bool,
    /// No hairline rules inside the settings window (`hideDividers`).
    pub hide_dividers: bool,
    /// Channel ids taken off the rail by right-click (`hiddenChannels`). The
    /// catalogue and the login's tag survive; only the rail row goes.
    pub hidden_channels: Vec<String>,
    /// Folder ids hidden the same way (`hiddenFolders`).
    pub hidden_folders: Vec<String>,
    /// Login-card button ids hidden on every card (`hiddenButtons`).
    pub hidden_buttons: Vec<String>,
    /// `prefs.vaultSecurity`: a second factor over the whole vault. TS gates
    /// the shell itself on it (App.tsx L2830, "Vault verification"), and the
    /// native gate verifies against this same stored factor.
    pub vault_security: LoginSecurity,
    // Sort and delete behaviour (Task 3.5 / 3.6).
    /// Favourites float to the top of every sort mode.
    pub pin_favorites: bool,
    /// Drag order for `sort == "manual"`. Ids not listed sort after the
    /// placed ones, in title order, so a new login needs no bookkeeping.
    pub manual_order: Vec<String>,
    /// Days before a password counts as stale. 0 disables the check.
    pub password_age_days: i64,
    /// Days before an unchanged address counts as stale in the health views
    /// (`emailAgeDays`, storage.ts L643 — a year out of the box; whitelist
    /// [0, 90, 180, 365, 730] at L1411). 0 disables that check too.
    pub email_age_days: i64,
    /// Days before a login's *username* counts as due for review
    /// (`emailCheckDays`, storage.ts L645 — default 90, whitelist
    /// [0, 30, 60, 90, 180, 365] at L1414). 0 disables that check too.
    pub email_check_days: i64,
    /// Ask before deleting, rather than deleting straight to undo.
    pub confirm_deletes: bool,
    /// Ask for a password to protect an exported backup (`confirmBeforeExport`,
    /// storage.ts L822 — shipped off, so the plain export stays one press).
    pub confirm_before_export: bool,
    /// Whether an export carries the app's own settings as well as the vault:
    /// the theme, the folders, the channels, the tags, the alarms and every
    /// other preference. Native-only — the TS export never wrote the
    /// `preferences` blob and its `parseBackup` never reads it, so a file with
    /// this off is the file the web build would have written, and one with it
    /// on still imports there. Shipped on: a backup that quietly dropped the
    /// user's look would be the worse default.
    pub backup_with_settings: bool,
    // Activity (Task 7.1).
    /// Copy/edit counts per login id (`usage`, storage.ts L613): the
    /// dashboard's "most used" and "recent account activity" read this.
    /// Pruning entries for deleted logins is the writer's job — a load only
    /// sees shapes, the writer sees the items.
    pub usage: BTreeMap<String, UsageEntry>,
    /// The History channel's log (`HistoryEvent`, storage.ts L354 — Task 1.7),
    /// newest block first and bounded by count *and* serialized size (L324 /
    /// L331). Shape is validated on load; appending is the writer's job.
    pub history: Vec<HistoryEvent>,
    /// Reminders with their own sound (`alarms`, storage.ts L796): the
    /// ticker in the app rings these, the Settings tab edits them.
    pub alarms: Vec<Alarm>,
    /// Minutes without activity before the vault seals itself. 0 disables
    /// the timer (`AUTO_LOCK_CHOICES` in Settings.tsx L1266).
    pub auto_lock_minutes: i64,
    /// Seconds after a copy before the clipboard is wiped; 0 keeps it
    /// (`clearClipboardSeconds`, storage.ts L803, `clampRange` 0..=300 in
    /// L1433). The same Security group as the lock above in Settings.
    pub clear_clipboard_seconds: f64,
    /// Also wipe the clipboard when the vault locks (`clearClipboardOnLock`,
    /// storage.ts L805 — shipped on).
    pub clear_clipboard_on_lock: bool,
    /// Watch the clipboard for an address and a password copied together and
    /// offer to save them (`clipboardCapture`, storage.ts L710 — shipped
    /// off, and read back as `Boolean(...)`).
    pub clipboard_capture: bool,
    /// Skip that offer and save straight away (`clipboardAutoSave`, L712 —
    /// shipped off; only meaningful with the watch above).
    pub clipboard_auto_save: bool,
    /// Toast on a successful copy (`copyToasts`, storage.ts L836). The
    /// *failure* notice is not a toast and shows either way — TS notifies
    /// it before the toast flag is ever consulted (hooks.ts L580).
    pub copy_toasts: bool,
    /// Show addresses as `ab•••@site.test` outside their own row
    /// (`maskEmails`, storage.ts L714, normalised L1108 as `!== false` —
    /// anything but an explicit `false` leaves it on). Copying still
    /// copies the whole address; this only ever changes what shoulders
    /// can surf.
    pub mask_emails: bool,
    /// A tappable reuse warning after saving a shared password
    /// (`warnOnReuse`, storage.ts L814 — shipped on).
    pub warn_on_reuse: bool,
    /// File every login sharing a password under the "reused" tag
    /// (`autoTagReused`, storage.ts L820, normalised L1104 as `!== false` —
    /// the masking rule again). The tag itself is a shipped seed.
    pub auto_tag_reused: bool,
    /// The global tag catalogue; logins carry ids from it (`Tag` above).
    /// Seeded with the three shipped tags on every load — `ensureDefaultTags`
    /// in storage.ts L1076 — so a vault opened here shows the same tags the
    /// web build would, without the user having created any.
    pub tags: Vec<Tag>,
    /// The channel catalogue the rail is built from (`channels`,
    /// storage.ts L1075 — `normaliseChannels`). Every row of the sidebar is
    /// one of these, shipped or made; the order here *is* the rail's order
    /// until the `sidebar` entries (folders, drag order) are modelled.
    pub channels: Vec<Channel>,
    /// What the generator opens with (`passwordGenerator`, storage.ts L935).
    /// The editor's own panel writes this same object as its chips move, so
    /// Settings and the editor are two doors to one set of six fields.
    pub password_generator: PasswordGenerator,
    // Shell switches. They live in `shell.json` too so the tray (which exists
    // before unlock) can read them, and the two are written together — see
    // `mirror_shell_flags` in the app.
    pub tray_enabled: bool,
    pub close_to_tray: bool,
    pub launch_at_login: bool,
    pub sounds_muted: bool,
    // retained as an opaque pocket for keys we do not model yet, so nothing
    // is dropped on a round trip through this build. The TS build writes
    // many more fields here; we keep the ones we understand typed and let
    // the rest live in `extra`.
    #[serde(flatten)]
    pub extra: Value,
}

impl Default for VaultPreferences {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            accent: "slate".into(),
            text_scale: 100.0,
            motion: 1.0,
            motion_speed: 2.0,
            micro_motion: true,
            ambient: 1.0,
            density: "comfortable".into(),
            roundness: 1.0,
            card_depth: 0.4,
            card_size: normalise_card_size(None),
            docks: default_docks(),
            orbit_dock_restored: true,
            reduce_transparency: false,
            high_contrast: true,
            background_image: String::new(),
            background_opacity: 0.35,
            background_blur: 0.0,
            background_dim: 0.25,
            mail_inline_images: true,
            disable_spellcheck: false,
            optimize_profiles: Vec::new(),
            optimize_snapshot: None,
            active_optimize_profile: String::new(),
            view: "animated".into(),
            sort: "title".into(),
            show_urls: true,
            pin_favorites: true,
            manual_order: Vec::new(),
            password_age_days: 180,
            email_age_days: 365,
            email_check_days: 90,
            confirm_deletes: true,
            confirm_before_export: false,
            backup_with_settings: true,
            usage: BTreeMap::new(),
            history: Vec::new(),
            alarms: Vec::new(),
            auto_lock_minutes: 5,
            clear_clipboard_seconds: 30.0,
            clear_clipboard_on_lock: true,
            clipboard_capture: false,
            clipboard_auto_save: false,
            copy_toasts: true,
            mask_emails: true,
            warn_on_reuse: true,
            auto_tag_reused: true,
            tags: Vec::new(),
            channels: builtin_channels(),
            password_generator: PasswordGenerator::default(),
            sidebar_position: "left".into(),
            sidebar_labels: "both".into(),
            compact_sidebar: false,
            show_sidebar: true,
            show_letter_groups: true,
            auto_tag_domain: true,
            show_unassigned_channel: true,
            auto_tag_channel: false,
            show_orbit_labels: true,
            show_health_badges: true,
            show_shortcuts: false,
            show_lock_button: true,
            show_new_channel_button: true,
            show_compact_button: true,
            show_new_login_button: true,
            show_bulk_add_button: true,
            show_settings_button: true,
            show_hide_sidebar_button: true,
            floating_chrome: true,
            hide_dividers: false,
            hidden_channels: Vec::new(),
            hidden_folders: Vec::new(),
            hidden_buttons: Vec::new(),
            vault_security: LoginSecurity::default(),
            tray_enabled: true,
            close_to_tray: true,
            launch_at_login: false,
            sounds_muted: false,
            extra: Value::Object(serde_json::Map::new()),
        }
    }
}

fn one_of(value: &Value, allowed: &[&str], dflt: &str) -> String {
    let s = value.as_str().unwrap_or(dflt);
    if allowed.contains(&s) { s.to_string() } else { dflt.to_string() }
}

pub fn normalise_preferences(raw: &Value) -> VaultPreferences {
    let mut out = VaultPreferences::default();
    let obj = raw.as_object();
    if obj.is_none() {
        // TS spreads a non-object into `{}` and runs the whole normaliser on
        // the result rather than short-circuiting, so even a corrupt document
        // gains the three shipped tags (storage.ts L1076).
        out.tags = ensure_default_tags(Vec::new());
        return out;
    }
    let o = obj.unwrap();
    macro_rules! get_f64 { ($k:literal, $d:literal) => {
        o.get($k).and_then(|v| v.as_f64()).unwrap_or($d)
    } }
    macro_rules! get_bool { ($k:literal, $d:literal) => {
        o.get($k).and_then(|v| v.as_bool()).unwrap_or($d)
    } }

    if let Some(v) = o.get("theme") { if v.is_string() {
        out.theme = one_of(v, &["light","dark","system"], "system");
    } }

    if let Some(v) = o.get("accent") {
        let a = v.as_str().unwrap_or("slate");
        let allowed = ["slate","sage","dusk","clay"];
        out.accent = if allowed.contains(&a) { a.to_string() } else { "slate".to_string() };
    }
    // Clamps are the same ones `normalisePreferences` applies (L1286-1433):
    // a value outside the range falls back rather than being silently kept.
    out.text_scale  = clamp(get_f64!("textScale", 100.0), 85.0, 130.0);
    out.motion      = clamp(get_f64!("motion", 1.0), 0.0, 1.0);
    out.motion_speed= clamp(get_f64!("motionSpeed", 2.0), 1.0, 2.0);
    // `merged.microMotion = merged.microMotion !== false` (L1292): anything
    // but an explicit false leaves the micro-animations on.
    out.micro_motion = o.get("microMotion").and_then(Value::as_bool) != Some(false);
    out.ambient     = clamp(get_f64!("ambient", 1.0), 0.0, 1.0);
    out.density     = one_of(o.get("density").unwrap_or(&Value::Null), &["compact","comfortable","spacious"], "comfortable");
    out.roundness   = clamp(get_f64!("roundness", 1.0), 0.6, 1.4);
    out.card_depth  = clamp(get_f64!("cardDepth", 0.4), 0.0, 1.0);
    out.card_size   = normalise_card_size(o.get("cardSize"));
    // Quick-launch bars: the migration reads the *stored* record, not `out`,
    // so a legacy single bar is not masked by the defaults backfilled above
    // (storage.ts L1400-1405).
    out.docks = normalise_docks(Some(raw));
    out.orbit_dock_restored = true;
    out.reduce_transparency = get_bool!("reduceTransparency", false);
    out.high_contrast       = get_bool!("highContrast", true);
    if let Some(v) = o.get("backgroundImage") { out.background_image = v.as_str().unwrap_or("").to_string(); }
    out.background_opacity = num(o.get("backgroundOpacity"), 0.35);
    out.background_blur    = num(o.get("backgroundBlur"), 0.0);
    out.background_dim     = num(o.get("backgroundDim"), 0.25);
    // Optimize (Task 1.10): the profile fields, read the way the TS
    // normaliser reads them (L1233 / L1424-1430).
    out.mail_inline_images = o.get("mailInlineImages").and_then(Value::as_bool) != Some(false);
    out.disable_spellcheck = truthy(o.get("disableSpellcheck"), false);
    out.optimize_profiles =
        normalise_optimize_profiles(o.get("optimizeProfiles").unwrap_or(&Value::Null));
    out.optimize_snapshot =
        read_style(o.get("optimizeSnapshot").unwrap_or(&Value::Null));
    // The active name must point at a profile that exists, or the tick lies.
    out.active_optimize_profile = match o.get("activeOptimizeProfile").and_then(Value::as_str) {
        Some(name)
            if out.optimize_profiles.iter().any(|profile| profile.name == name) =>
        {
            name.to_string()
        }
        _ => String::new(),
    };
    out.view = one_of(o.get("view").unwrap_or(&Value::Null), &["animated","carousel","basic","grid"], "animated");
    out.sort = one_of(o.get("sort").unwrap_or(&Value::Null), &["title","recent","oldest","strength","username","manual"], "title");
    out.show_urls = get_bool!("showUrls", true);
    // JS Boolean(...) again: a stored string still reads as a choice.
    out.pin_favorites = truthy(o.get("pinFavorites"), true);
    out.confirm_deletes = truthy(o.get("confirmDeletes"), true);
    out.confirm_before_export = truthy(o.get("confirmBeforeExport"), false);
    // Native-only, so there is no TS normaliser line to mirror: absent keeps
    // the shipped `true`, and any stored value reads the way JS `Boolean()`
    // reads it, like every other switch here.
    out.backup_with_settings = truthy(o.get("backupWithSettings"), true);
    // The list is deduplicated and emptied of anything that is not a non-empty
    // id, so a hand-edited record cannot put nulls in the drag order.
    out.manual_order = id_list(o.get("manualOrder"));
    // The shipped set is 0/30/60/90/180/365/730; anything else falls back
    // rather than being kept (storage.ts L1408).
    out.password_age_days = match o.get("passwordAgeDays").and_then(Value::as_i64) {
        Some(d) if [0, 30, 60, 90, 180, 365, 730].contains(&d) => d,
        _ => 180,
    };
    // The address-review window is the same whitelist the check below uses,
    // by its own list (storage.ts L1411): 0/90/180/365/730.
    out.email_age_days = match o.get("emailAgeDays").and_then(Value::as_i64) {
        Some(d) if [0, 90, 180, 365, 730].contains(&d) => d,
        _ => 365,
    };
    // The shipped set is 0/1/5/15/30/60 (`AUTO_LOCK_CHOICES` in
    // Settings.tsx L1266); anything else falls back, as storage.ts L1438
    // does. 0 is a real choice -- never -- and not a missing value.
    out.auto_lock_minutes = match o.get("autoLockMinutes").and_then(Value::as_i64) {
        Some(m) if [0, 1, 5, 15, 30, 60].contains(&m) => m,
        _ => 5,
    };
    // The address-review window is a whitelist the same way (L1414), and a
    // stored string is not a choice — `includes` is strict in JS too.
    out.email_check_days = match o.get("emailCheckDays").and_then(Value::as_i64) {
        Some(d) if [0, 30, 60, 90, 180, 365].contains(&d) => d,
        _ => 90,
    };
    // `clampRange(..., 0, 300, 30)` in storage.ts L1433: a stored number is
    // clamped into the range -- 0 included, which is the real "never wipe"
    // choice -- and anything that is not a number falls back to the shipped
    // thirty rather than to the nearest bound.
    out.clear_clipboard_seconds = clamp(num(o.get("clearClipboardSeconds"), 30.0), 0.0, 300.0);
    // Switches over their defaults, as above: absent keeps the default, and
    // a stored value reads by JS `Boolean` (the `Boolean(...)` family that
    // normalisePreferences runs the on/off flags through).
    out.clear_clipboard_on_lock = truthy(o.get("clearClipboardOnLock"), true);
    // The clipboard watch is the `Boolean(...)` pair storage.ts L1106-1107
    // runs: truthy either way, both shipped off.
    out.clipboard_capture = truthy(o.get("clipboardCapture"), false);
    out.clipboard_auto_save = truthy(o.get("clipboardAutoSave"), false);
    out.copy_toasts = truthy(o.get("copyToasts"), true);
    // `!== false` in TS: a stored `false` is the only thing that turns the
    // masking off — a missing key, null or any other value leaves it on.
    out.mask_emails = o.get("maskEmails").and_then(Value::as_bool) != Some(false);
    // The reuse pair: the warning is a plain switch over its shipped default,
    // the tag follows the masking rule (`!== false`, L1104).
    out.warn_on_reuse = truthy(o.get("warnOnReuse"), true);
    out.auto_tag_reused = o.get("autoTagReused").and_then(Value::as_bool) != Some(false);
    // Use counts (`storage.ts` L1341-1355): `{ count, at }` objects only —
    // a malformed field falls back to 0, an entry with neither a count nor
    // a date drops out, and the newest 200 survive the cap. Load validates
    // shape; pruning by deleted id belongs to the writer.
    {
        let mut entries: Vec<(String, UsageEntry)> = Vec::new();
        if let Some(map) = o.get("usage").and_then(Value::as_object) {
            for (id, value) in map {
                let Some(record) = value.as_object() else { continue };
                let count = record
                    .get("count")
                    .and_then(Value::as_f64)
                    .filter(|n| n.is_finite())
                    .map(|n| n.floor().max(0.0) as i64)
                    .unwrap_or(0);
                let at = record
                    .get("at")
                    .and_then(Value::as_f64)
                    .filter(|n| n.is_finite())
                    .map(|n| n as i64)
                    .unwrap_or(0);
                if !id.is_empty() && (count > 0 || at > 0) {
                    entries.push((id.clone(), UsageEntry { count, at }));
                }
            }
        }
        // Newest first, then the cap — and the id tiebreak keeps the order
        // (and the saved document) deterministic between loads.
        entries.sort_by(|a, b| b.1.at.cmp(&a.1.at).then(a.0.cmp(&b.0)));
        out.usage = entries.into_iter().take(200).collect();
    }
    // The History log (`normaliseHistory`, storage.ts L377): a malformed
    // entry drops out, a half-written snapshot loses its restore, and a
    // non-array field reads as an empty log rather than a load failure.
    out.history = normalise_history(o.get("history"));
    out.alarms = normalise_alarms(o.get("alarms"));
    out.sidebar_position = one_of(o.get("sidebarPosition").unwrap_or(&Value::Null), &["left","right","top","bottom"], "left");
    out.sidebar_labels = one_of(o.get("sidebarLabels").unwrap_or(&Value::Null), &["icon","name","both"], "both");
    // `Boolean(...)` over the defaults, the way normalisePreferences treats
    // every switch: absent keeps the default the struct starts with, and a
    // stored vault from the web build brings its own.
    out.compact_sidebar = truthy(o.get("compactSidebar"), false);
    out.show_sidebar = truthy(o.get("showSidebar"), true);
    // Layout (Task 5.2), the rules `normalisePreferences` runs (storage.ts
    // L1079-1105, L1278): the flags a missing key must never turn off read
    // `!== false`, the plain switches read by JS `Boolean`, and the three
    // hidden lists are cleaned exactly like `hiddenChannels` — non-empty
    // strings, duplicates dropped, anything else an empty list.
    out.show_letter_groups = o.get("showLetterGroups").and_then(Value::as_bool) != Some(false);
    out.show_new_login_button = o.get("showNewLoginButton").and_then(Value::as_bool) != Some(false);
    out.show_bulk_add_button = o.get("showBulkAddButton").and_then(Value::as_bool) != Some(false);
    out.show_settings_button = o.get("showSettingsButton").and_then(Value::as_bool) != Some(false);
    out.show_hide_sidebar_button = o.get("showHideSidebarButton").and_then(Value::as_bool) != Some(false);
    out.auto_tag_domain = bool_or(o.get("autoTagDomain"), true);
    out.show_unassigned_channel = bool_or(o.get("showUnassignedChannel"), true);
    out.show_new_channel_button = bool_or(o.get("showNewChannelButton"), true);
    out.show_compact_button = bool_or(o.get("showCompactButton"), true);
    // These five are not in the TS normaliser at all: they pass through as
    // stored, so the only rule is what the consuming expression makes of the
    // value — the same truthiness `bool_or` reads here.
    out.auto_tag_channel = bool_or(o.get("autoTagChannel"), false);
    out.show_orbit_labels = bool_or(o.get("showOrbitLabels"), true);
    out.show_health_badges = bool_or(o.get("showHealthBadges"), true);
    out.show_shortcuts = bool_or(o.get("showShortcuts"), false);
    out.show_lock_button = bool_or(o.get("showLockButton"), true);
    out.floating_chrome = bool_or(o.get("floatingChrome"), true);
    out.hide_dividers = bool_or(o.get("hideDividers"), false);
    out.hidden_channels = id_list(o.get("hiddenChannels"));
    out.hidden_folders = id_list(o.get("hiddenFolders"));
    out.hidden_buttons = id_list(o.get("hiddenButtons"));
    // The vault's own second factor, through the same helper the items use:
    // a stored vault.json from the web build verifies exactly the same way.
    out.vault_security = normalise_security(o.get("vaultSecurity"));
    // The generator's defaults (`normalisePreferences`, storage.ts L1434-1451).
    out.password_generator = normalise_generator(o.get("passwordGenerator"));
    // Boolean(...) in JS: anything truthy reads as true, so a legacy string
    // here is still honoured rather than reset.
    out.tray_enabled = truthy(o.get("trayEnabled"), true);
    out.close_to_tray = truthy(o.get("closeToTray"), true);
    out.launch_at_login = truthy(o.get("launchAtLogin"), false);
    out.sounds_muted = truthy(o.get("soundsMuted"), false);

    // The tag catalogue: clean what is stored, then make sure the three
    // shipped tags exist — `ensureDefaultTags(normaliseTags(...))` in
    // storage.ts L1076, in that order so a stored entry always wins over a
    // seed of the same name.
    out.tags = ensure_default_tags(normalise_tags(o.get("tags")));

    // The channel catalogue (`normaliseChannels`): the stored rows cleaned,
    // the shipped ones that are missing appended, and `all` guaranteed. This
    // is what the rail is built from, so a vault that has never seen Settings
    // › Channels still has its seven shipped rows.
    out.channels = normalise_channels(o.get("channels"));

    // absorb everything we didn't model
    let mut extra = serde_json::Map::new();
    let known = ["theme","accent","textScale","motion","motionSpeed","ambient","density","roundness",
        "cardDepth","cardSize","docks","orbitDockRestored","dockEnabled","dockSlots","dockPos","reduceTransparency","highContrast","backgroundImage","backgroundOpacity",        "backgroundBlur","backgroundDim","microMotion","mailInlineImages","disableSpellcheck",
        "optimizeProfiles","optimizeSnapshot","activeOptimizeProfile","view","sort","showUrls","sidebarPosition","sidebarLabels",
        "compactSidebar","showSidebar","vaultSecurity",
        "showLetterGroups","autoTagDomain","showUnassignedChannel","autoTagChannel",
        "showOrbitLabels","showHealthBadges","showShortcuts","showLockButton",
        "showNewChannelButton","showCompactButton","showNewLoginButton","showBulkAddButton",
        "showSettingsButton","showHideSidebarButton","floatingChrome","hideDividers",
        "hiddenChannels","hiddenFolders","hiddenButtons",
        "trayEnabled","closeToTray","launchAtLogin","soundsMuted",
        "pinFavorites","manualOrder","passwordAgeDays","emailAgeDays","emailCheckDays","confirmDeletes","confirmBeforeExport","backupWithSettings","tags","channels","autoLockMinutes",
        "passwordGenerator",
        "clearClipboardSeconds","clearClipboardOnLock","clipboardCapture","clipboardAutoSave","copyToasts","maskEmails","warnOnReuse","autoTagReused","usage","history","alarms"];
    for (k,v) in o.iter() {
        if !known.contains(&k.as_str()) { extra.insert(k.clone(), v.clone()); }
    }
    out.extra = Value::Object(extra);
    out
}

/// `passwordGenerator` as stored (storage.ts L1434-1451): the length is
/// rounded and clamped 8..64, the five switches read the way `Boolean()`
/// reads them after the defaults were spread underneath, and a stored object
/// with every character set off is discarded whole — the TS puts the shipped
/// defaults back (`merged.passwordGenerator = { ...DEFAULT_PREFERENCES.
/// passwordGenerator }`), so the length and the look-alike flag are reset too
/// rather than kept beside a generator that could not run.
pub fn normalise_generator(stored: Option<&Value>) -> PasswordGenerator {
    let Some(obj) = stored.and_then(Value::as_object) else {
        return PasswordGenerator::default();
    };
    let dflt = PasswordGenerator::default();
    let out = PasswordGenerator {
        length: clamp(num(obj.get("length"), dflt.length as f64), 8.0, 64.0).round() as u32,
        lower: bool_or(obj.get("lower"), dflt.lower),
        upper: bool_or(obj.get("upper"), dflt.upper),
        digits: bool_or(obj.get("digits"), dflt.digits),
        symbols: bool_or(obj.get("symbols"), dflt.symbols),
        avoid_ambiguous: bool_or(obj.get("avoidAmbiguous"), dflt.avoid_ambiguous),
    };
    if out.lower || out.upper || out.digits || out.symbols {
        out
    } else {
        dflt
    }
}

fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    if v.is_nan() { return lo; }
    if v < lo { lo } else if v > hi { hi } else { v }
}

/// A finite number, or the fallback. Mirrors `num()` in the TS normaliser.
fn num(v: Option<&Value>, dflt: f64) -> f64 {
    match v.and_then(Value::as_f64) {
        Some(n) if n.is_finite() => n,
        _ => dflt,
    }
}

/// JS `Boolean(v)`: a JSON `true`/`false` as itself, a non-empty string or
/// non-zero number as true, absent as the default.
fn truthy(v: Option<&Value>, dflt: bool) -> bool {
    match v {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0).unwrap_or(dflt),
        Some(Value::Array(a)) => !a.is_empty(),
        _ => dflt,
    }
}

/// JS `Boolean(v)` for a key that *is* in the document: `null`, `false`, `0`,
/// `""` are off and everything else is on — an explicit null is a stored
/// choice, unlike `truthy`'s absent-key reading. `None` (no such key) keeps
/// the shipped default, which is what the TS does by spreading `DEFAULTS`
/// under the stored document before it converts (storage.ts L1070).
fn bool_or(v: Option<&Value>, dflt: bool) -> bool {
    match v {
        None => dflt,
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0).unwrap_or(dflt),
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::Object(o)) => !o.is_empty(),
        Some(Value::Null) => false,
    }
}

/// A list of ids out of a stored field: non-empty strings only, duplicates
/// dropped, the order kept — `[...new Set(list.filter(id => typeof id ===
/// 'string' && id.length > 0))]` (storage.ts L1080, once for each of
/// `hiddenChannels`, `hiddenFolders`, `hiddenButtons` and `manualOrder`).
/// Anything that is not an array is no list at all, not a list of one.
fn id_list(v: Option<&Value>) -> Vec<String> {
    let Some(Value::Array(ids)) = v else { return Vec::new() };
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for id in ids.iter().filter_map(Value::as_str) {
        if !id.is_empty() && seen.insert(id.to_string()) {
            out.push(id.to_string());
        }
    }
    out
}

/// The three tags every vault starts with (`DEFAULT_TAG_SEEDS` in
/// channels.ts L793). They are ordinary tags — rename, recolour or delete them
/// like any other — but they exist so "weak", "needs attention" and "reused"
/// are something you can put on a login instead of only badge text the app
/// decides for you. Hues are spread around the wheel so the three stay
/// distinguishable at a glance.
pub const DEFAULT_TAG_SEEDS: [(&str, f64); 3] = [("weak", 8.0), ("needs attention", 36.0), ("reused", 268.0)];

/// `newTagId` in channels.ts:522 — `tg_` plus the first eight characters of a
/// fresh uuid. Eight is plenty for a catalogue of tens of tags, and the prefix
/// keeps tag ids from reading as item ids in a shared log.
pub fn new_tag_id() -> String {
    let uuid = crate::engine::new_item_id().replace('-', "");
    format!("tg_{}", &uuid[..8])
}

/// Creates a tag, nudging the hue away from the ones already in the catalogue
/// (`createTag`, channels.ts L527). An empty or whitespace-only name becomes
/// "Tag" rather than a chip nobody can tell apart from another blank one.
pub fn create_tag(name: &str, existing: &[Tag]) -> Tag {
    let trimmed = name.trim();
    Tag {
        id: new_tag_id(),
        name: if trimmed.is_empty() { "Tag".to_string() } else { trimmed.to_string() },
        hue: pick_free_hue(existing),
    }
}

/// Evenly spreads hues around the wheel so adjacent tags stay distinguishable:
/// buckets of 24° (a sixth of the wheel per candidate, giving 15 to try), each
/// one claimed if any stored hue rounds into it. The final line mirrors TS's
/// `(existing.length * 47) % 360` — a deterministic scatter for the degenerate
/// case of a catalogue that has already occupied every bucket.
fn pick_free_hue(existing: &[Tag]) -> f64 {
    if existing.is_empty() {
        return 210.0;
    }
    let used: std::collections::HashSet<i64> = existing
        .iter()
        .map(|tag| ((tag.hue / 24.0).round() as i64 * 24) % 360)
        .collect();
    for hue in (0i64..360).step_by(24) {
        if !used.contains(&hue) {
            return hue as f64;
        }
    }
    ((existing.len() as f64 * 47.0) % 360.0).round()
}

/// Adds any missing default tag (matched case-insensitively on the trimmed
/// name), preserving the user's order and never duplicating. Runs on load so
/// older vaults gain the defaults without losing the tags they already have
/// (`ensureDefaultTags`, channels.ts L804).
pub fn ensure_default_tags(mut tags: Vec<Tag>) -> Vec<Tag> {
    let mut have: std::collections::HashSet<String> =
        tags.iter().map(|tag| tag.name.trim().to_lowercase()).collect();
    for (name, hue) in DEFAULT_TAG_SEEDS {
        let key = name.to_lowercase();
        if have.contains(&key) {
            continue;
        }
        tags.push(Tag { id: new_tag_id(), name: name.to_string(), hue });
        have.insert(key);
    }
    tags
}

/// `normaliseTags` in channels.ts L816: one bad entry costs that entry, not
/// the catalogue, so this reads the raw JSON rather than going through `serde`
/// (which would fail the whole preferences document on a single junk row).
/// Duplicates by id keep the first spelling; names trim to a non-empty string
/// or fall back to "Tag"; hues wrap into 0..360 or fall back to 210.
/// `soundsMuted` for the once-a-second ticker: `truthy` without rebuilding
/// every other preference just to reach the one flag.
pub fn sounds_muted_from(raw: &Value) -> bool {
    truthy(raw.get("soundsMuted"), false)
}

/// Field-by-field rebuild of the stored alarm list — storage.ts L1237-1250,
/// quirks included: a row without an `id` *string* and a `time` *string* is
/// dropped whole; any time that is not exactly two digits, a colon and two
/// digits becomes `08:00` rather than being kept for a matcher that could
/// never fire it (`\d{2}:\d{2}` does not range-check either, so `99:99`
/// stays); `enabled` is `Boolean(...)` — an absent flag reads as off, the
/// way `if (!alarm.enabled) continue` reads it.
pub fn normalise_alarms(stored: Option<&Value>) -> Vec<Alarm> {
    let Some(Value::Array(rows)) = stored else {
        return Vec::new();
    };
    rows.iter()
        .filter_map(|row| {
            let obj = row.as_object()?;
            let id = obj.get("id")?.as_str()?.to_string();
            let time = obj.get("time")?.as_str()?.to_string();
            Some(Alarm {
                id,
                label: obj
                    .get("label")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                time: if time.len() == 5
                    && time.as_bytes()[..2].iter().all(u8::is_ascii_digit)
                    && time.as_bytes()[2] == b':'
                    && time[3..].bytes().all(|b| b.is_ascii_digit())
                {
                    time
                } else {
                    "08:00".into()
                },
                days: obj
                    .get("days")
                    .and_then(Value::as_array)
                    .map(|days| {
                        days.iter()
                            .filter_map(|d| {
                                // `Number.isInteger(d)` accepts a whole
                                // float — 3.0 is 3 — and coerces nothing
                                // else, so only JSON numbers survive.
                                let n = d.as_f64()?;
                                if n.fract() == 0.0 && (0.0..=6.0).contains(&n) {
                                    Some(n as u8)
                                } else {
                                    None
                                }
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
                sound: obj.get("sound").and_then(Value::as_object).map(|s| {
                    AlarmSound {
                        // `String(alarm.sound.name ?? 'Custom')`: missing or
                        // null is the label, anything else is stringified.
                        name: match s.get("name") {
                            None | Some(Value::Null) => "Custom".to_string(),
                            Some(Value::String(text)) => text.clone(),
                            Some(other) => other.to_string(),
                        },
                        data_url: s
                            .get("dataUrl")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    }
                }),
                enabled: truthy(obj.get("enabled"), false),
            })
        })
        .collect()
}

pub fn normalise_tags(stored: Option<&Value>) -> Vec<Tag> {
    let Some(Value::Array(items)) = stored else { return Vec::new(); };
    let mut seen = std::collections::HashSet::new();
    let mut tags = Vec::new();
    for raw in items {
        let Some(obj) = raw.as_object() else { continue };
        let Some(id) = obj.get("id").and_then(Value::as_str) else { continue };
        if !seen.insert(id.to_string()) {
            continue;
        }
        let name = match obj.get("name").and_then(Value::as_str) {
            Some(name) if !name.trim().is_empty() => name.trim().to_string(),
            _ => "Tag".to_string(),
        };
        let hue = match obj.get("hue").and_then(Value::as_f64) {
            Some(hue) if hue.is_finite() => ((hue % 360.0) + 360.0) % 360.0,
            _ => 210.0,
        };
        tags.push(Tag { id: id.to_string(), name, hue });
    }
    tags
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn defaults_match_the_typescript_defaults() {
        let p = normalise_preferences(&json!({}));
        assert_eq!(p.theme, "system");
        assert_eq!(p.accent, "slate");
        assert_eq!(p.text_scale, 100.0);
        assert_eq!(p.motion, 1.0);
        assert_eq!(p.motion_speed, 2.0);
        assert_eq!(p.density, "comfortable");
        assert_eq!(p.roundness, 1.0);
        assert_eq!(p.card_depth, 0.4);
        assert!(!p.reduce_transparency);
        assert!(p.high_contrast);
        assert_eq!(p.view, "animated");
        assert_eq!(p.sort, "title");
        assert!(p.show_urls);
        assert_eq!(p.sidebar_position, "left");
        assert_eq!(p.sidebar_labels, "both");
        assert_eq!(p.vault_security, LoginSecurity::default());
    }

    #[test]
    fn card_size_defaults_and_clamps_per_view() {
        let p = normalise_preferences(&json!({}));
        // All four views are always present, each with its shipped geometry.
        assert_eq!(p.card_size.len(), 4);
        assert_eq!(p.card_size["animated"], CardSize { scale: 1.0, width: 560.0, min_height: 132.0, aspect: 1.0, surface: 1.0, radius: 14.0 });
        assert_eq!(p.card_size["carousel"].width, 340.0);
        assert_eq!(p.card_size["carousel"].aspect, 1.35);
        assert_eq!(p.card_size["carousel"].min_height, 0.0);
        assert_eq!(p.card_size["carousel"].radius, 20.0);
        assert_eq!(p.card_size["basic"].width, 900.0);
        assert_eq!(p.card_size["grid"].min_height, 96.0);

        // A partial, out-of-range record: each field clamps on its own, and a
        // view the record omits keeps its default.
        let q = normalise_preferences(&json!({
            "cardSize": {
                "animated": { "scale": 9.0, "width": 10.0, "minHeight": -5.0, "radius": 999.0, "aspect": 0.1, "surface": 2.0 },
                "grid": { "width": 640.4 }
            }
        }));
        assert_eq!(q.card_size["animated"].scale, 1.6);
        assert_eq!(q.card_size["animated"].width, 180.0);
        assert_eq!(q.card_size["animated"].min_height, 0.0);
        assert_eq!(q.card_size["animated"].radius, 48.0);
        assert_eq!(q.card_size["animated"].aspect, 0.5);
        assert_eq!(q.card_size["animated"].surface, 1.0);
        assert_eq!(q.card_size["grid"].width, 640.0); // rounded
        assert_eq!(q.card_size["basic"].width, 900.0); // untouched

        // A hand-edited string where a number belongs falls back, not zero.
        let r = normalise_preferences(&json!({ "cardSize": { "basic": { "width": "wide" } } }));
        assert_eq!(r.card_size["basic"].width, 900.0);
    }

    #[test]
    fn docks_default_and_migrate() {
        let p = normalise_preferences(&json!({}));
        assert!(p.orbit_dock_restored);
        assert_eq!(p.docks.len(), 1);
        assert_eq!(p.docks[0].id, "main");
        assert_eq!(p.docks[0].slots.len(), 5);

        // A pre-multi-dock vault: the legacy keys migrate into the first bar
        // and must not also survive in `extra` (the TS deletes them).
        let q = normalise_preferences(&json!({
            "dockSlots": [{ "kind": "view", "ref": "grid", "key": "1" }],
            "dockEnabled": false,
        }));
        assert_eq!(q.docks[0].slots[0].target, "grid");
        assert!(!q.docks[0].enabled);
        assert!(q.extra.get("dockSlots").is_none());
        assert!(q.extra.get("dockEnabled").is_none());
    }

    #[test]
    fn layout_switches_keep_their_shipped_defaults() {
        let p = normalise_preferences(&json!({}));
        // Shown unless a vault says otherwise: hiding a button from a missing
        // key would be the load doing the user's hiding for them.
        assert!(p.show_letter_groups);
        assert!(p.auto_tag_domain);
        assert!(p.show_unassigned_channel);
        assert!(p.show_orbit_labels);
        assert!(p.show_health_badges);
        assert!(p.show_lock_button);
        assert!(p.show_new_channel_button);
        assert!(p.show_compact_button);
        assert!(p.show_new_login_button);
        assert!(p.show_bulk_add_button);
        assert!(p.show_settings_button);
        assert!(p.show_hide_sidebar_button);
        assert!(p.floating_chrome);
        assert!(!p.auto_tag_channel);
        assert!(!p.show_shortcuts);
        assert!(!p.hide_dividers);
        assert!(p.hidden_channels.is_empty());
        assert!(p.hidden_folders.is_empty());
        assert!(p.hidden_buttons.is_empty());
    }

    #[test]
    fn a_visibility_flag_needs_a_real_false_to_hide() {
        // `!== false` in the TS: null, 0 and strings keep the button shown.
        let p = normalise_preferences(&json!({
            "showNewLoginButton": null,
            "showBulkAddButton": 0,
            "showSettingsButton": "no",
            "showHideSidebarButton": false,
            "showLetterGroups": false,
        }));
        assert!(p.show_new_login_button);
        assert!(p.show_bulk_add_button);
        assert!(p.show_settings_button);
        assert!(!p.show_hide_sidebar_button);
        assert!(!p.show_letter_groups);
        // A plain `Boolean(...)` switch does read null and "" as off.
        let q = normalise_preferences(&json!({ "showCompactButton": null, "autoTagDomain": "" }));
        assert!(!q.show_compact_button);
        assert!(!q.auto_tag_domain);
    }

    #[test]
    fn the_hidden_lists_keep_only_non_empty_unique_ids() {
        let p = normalise_preferences(&json!({
            "hiddenChannels": ["ch_a", "", "ch_a", 7, null, "ch_b"],
            "hiddenFolders": "fd_a",
            "hiddenButtons": ["copy"],
        }));
        assert_eq!(p.hidden_channels, vec!["ch_a", "ch_b"]);
        // A bare string is not a list — the TS checks `Array.isArray` first.
        assert!(p.hidden_folders.is_empty());
        assert_eq!(p.hidden_buttons, vec!["copy"]);
    }

    #[test]
    fn modelled_keys_do_not_leak_into_extra() {
        // `extra` is the round-trip pocket for keys this build does not know;
        // a key that now has a field must leave it, or the document would
        // carry two copies of the same switch.
        let p = normalise_preferences(&json!({
            "hideDividers": true, "somedayKey": 1,
        }));
        let extra = p.extra.as_object().expect("extra is an object");
        assert!(!extra.contains_key("hideDividers"));
        assert_eq!(extra.get("somedayKey"), Some(&json!(1)));
    }

    #[test]
    fn out_of_range_values_clamp_to_the_documented_bounds() {        let p = normalise_preferences(&json!({
            "textScale": 999, "motion": -3, "motionSpeed": 12,
            "roundness": 0, "cardDepth": 7, "ambient": 4,
        }));
        assert_eq!(p.text_scale, 130.0);
        assert_eq!(p.motion, 0.0);
        assert_eq!(p.motion_speed, 2.0);
        assert_eq!(p.roundness, 0.6);
        assert_eq!(p.card_depth, 1.0);
        assert_eq!(p.ambient, 1.0);
    }

    #[test]
    fn unknown_enums_fall_back_to_the_default() {
        let p = normalise_preferences(&json!({
            "theme": "neon", "accent": "chartreuse", "density": "tight",
            "view": "cinema", "sort": "random", "sidebarPosition": "middle",
            "sidebarLabels": "words",
        }));
        assert_eq!(p.theme, "system");
        assert_eq!(p.accent, "slate");
        assert_eq!(p.density, "comfortable");
        assert_eq!(p.view, "animated");
        assert_eq!(p.sort, "title");
        assert_eq!(p.sidebar_position, "left");
        assert_eq!(p.sidebar_labels, "both");
        assert!(!p.compact_sidebar);
        assert!(p.show_sidebar);
    }

    #[test]
    fn known_enums_are_accepted() {
        let p = normalise_preferences(&json!({
            "theme": "dark", "accent": "sage", "density": "spacious",
            "view": "grid", "sort": "recent", "sidebarPosition": "right",
            "sidebarLabels": "icon", "compactSidebar": true, "showSidebar": false,
            "vaultSecurity": { "totp": { "seed": "GEZDGNBVGY3TQOJQ" } },
        }));
        assert_eq!(p.theme, "dark");
        assert_eq!(p.accent, "sage");
        assert_eq!(p.density, "spacious");
        assert_eq!(p.view, "grid");
        assert_eq!(p.sort, "recent");
        assert_eq!(p.sidebar_position, "right");
        assert_eq!(p.sidebar_labels, "icon");
        assert!(p.compact_sidebar);
        assert!(!p.show_sidebar);
        assert_eq!(
            p.vault_security,
            normalise_security(Some(&json!({ "totp": { "seed": "GEZDGNBVGY3TQOJQ" } })))
        );
        // All three are *known* now: they must not linger in `extra` and get
        // written a second time alongside their typed fields.
        assert!(p.extra.get("compactSidebar").is_none());
        assert!(p.extra.get("showSidebar").is_none());
        assert!(p.extra.get("vaultSecurity").is_none());
    }

    #[test]
    fn non_string_values_fall_back_rather_than_panic() {
        let p = normalise_preferences(&json!({
            "theme": 42, "textScale": "big", "showUrls": "yes",
            "highContrast": null, "backgroundImage": 7,
        }));
        assert_eq!(p.theme, "system");
        assert_eq!(p.text_scale, 100.0);
        assert!(p.show_urls); // not a JSON bool, so the default stands
        assert!(p.high_contrast);
        assert_eq!(p.background_image, "");
    }

    #[test]
    fn unknown_keys_survive_a_round_trip() {
        let raw = json!({
            "theme": "dark",
            "clearClipboardSeconds": 30,
            "mailAccount": "primary",
            "passwordGenerator": { "length": 20 },
        });
        let p = normalise_preferences(&raw);
        let back = serde_json::to_value(&p).unwrap();
        assert_eq!(back["theme"], "dark");
        // Modelled since: the same number, now typed -- 30 reads back as
        // 30.0 rather than as the raw pocket's integer, which is the whole
        // point of the field being typed.
        assert_eq!(back["clearClipboardSeconds"].as_f64(), Some(30.0));
        assert_eq!(back["mailAccount"], "primary");
        assert_eq!(back["passwordGenerator"]["length"], 20);
        // and the typed keys are present too
        assert_eq!(back["accent"], "slate");
    }

    #[test]
    fn non_object_documents_read_as_defaults() {
        for raw in [json!(null), json!("dark"), json!([1, 2])] {
            let mut p = normalise_preferences(&raw);
            // The only difference from the shape default is the three shipped
            // tags every load seeds (`ensureDefaultTags`, storage.ts L1076);
            // they carry fresh ids each time, so they are compared away here.
            assert_eq!(p.tags.len(), 3);
            p.tags.clear();
            assert_eq!(p, VaultPreferences::default());
        }
    }

    #[test]
    fn sort_and_delete_preferences_follow_the_documented_rules() {
        let d = normalise_preferences(&json!({}));
        assert!(d.pin_favorites);
        assert!(d.confirm_deletes);
        assert_eq!(d.password_age_days, 180);
        assert!(d.manual_order.is_empty());

        let p = normalise_preferences(&json!({
            "pinFavorites": false,
            "confirmDeletes": false,
            // Not one of 0/30/60/90/180/365/730 -> falls back.
            "passwordAgeDays": 17,
            "manualOrder": ["a", "b", "a", "", null, 7, "c"],
        }));
        assert!(!p.pin_favorites);
        assert!(!p.confirm_deletes);
        assert_eq!(p.password_age_days, 180);
        // Deduped, non-strings dropped, empty ids dropped, order kept.
        assert_eq!(p.manual_order, vec!["a".to_string(), "b".to_string(), "c".to_string()]);

        // 0 is a legitimate value (never stale) and must survive.
        let never = normalise_preferences(&json!({"passwordAgeDays": 0}));
        assert_eq!(never.password_age_days, 0);
    }

    #[test]
    fn auto_lock_follows_the_shipped_choices() {
        // Absent keeps the default the struct starts with: five minutes.
        assert_eq!(normalise_preferences(&json!({})).auto_lock_minutes, 5);
        // Every choice in `AUTO_LOCK_CHOICES` survives, including 0 --
        // "never" is a decision the user made and must not read as missing.
        for minutes in [0, 1, 5, 15, 30, 60] {
            let p = normalise_preferences(&json!({ "autoLockMinutes": minutes }));
            assert_eq!(p.auto_lock_minutes, minutes, "{minutes} must survive");
        }
        // Anything else falls back, as storage.ts L1438 does.
        for off in [json!(7), json!(-1), json!("5"), json!(null), json!(61)] {
            let p = normalise_preferences(&json!({ "autoLockMinutes": off }));
            assert_eq!(p.auto_lock_minutes, 5, "{off} must fall back");
        }
        // A typed field, not a leftover: once modelled, the key must not
        // linger in `extra` where a later field would be shadowed by it.
        let modelled = normalise_preferences(&json!({ "autoLockMinutes": 15 }));
        assert!(modelled.extra.get("autoLockMinutes").is_none());
        assert!(modelled.extra.as_object().is_some_and(|e| e.is_empty()));
    }

    #[test]
    fn clipboard_prefs_follow_the_shipped_choices() {
        // The shipped defaults (storage.ts L928, L929, L943).
        let fresh = normalise_preferences(&json!({}));
        assert_eq!(fresh.clear_clipboard_seconds, 30.0);
        assert!(fresh.clear_clipboard_on_lock);
        assert!(fresh.copy_toasts);

        // `clampRange(0, 300, 30)` (L1433): kept in range -- 0 is the real
        // "never wipe" -- clamped at the ends, and a non-number falls back
        // to the default rather than to the nearest bound.
        let cases = [
            (json!(45), 45.0),
            (json!(0), 0.0),
            (json!(300), 300.0),
            (json!(301), 300.0),
            (json!(-5), 0.0),
            (json!("5"), 30.0),
            (json!(null), 30.0),
        ];
        for (stored, want) in cases {
            let p = normalise_preferences(&json!({ "clearClipboardSeconds": stored }));
            assert_eq!(p.clear_clipboard_seconds, want, "{stored} must read {want}");
        }

        // Switches by JS Boolean over the default: an explicit false wins,
        // and a truthy string ("false" is not "no") still reads as on.
        assert!(!normalise_preferences(&json!({ "clearClipboardOnLock": false })).clear_clipboard_on_lock);
        assert!(!normalise_preferences(&json!({ "copyToasts": false })).copy_toasts);
        assert!(normalise_preferences(&json!({ "copyToasts": "false" })).copy_toasts);

        // Typed fields, not leftovers in `extra`.
        let modelled = normalise_preferences(&json!({
            "clearClipboardSeconds": 15,
            "clearClipboardOnLock": false,
            "copyToasts": false,
        }));
        assert_eq!(modelled.clear_clipboard_seconds, 15.0);
        assert!(modelled.extra.as_object().is_some_and(|e| e.is_empty()));
    }

    #[test]
    fn email_review_days_follow_the_shipped_whitelist() {
        let fresh = normalise_preferences(&json!({}));
        assert_eq!(fresh.email_check_days, 90);
        for days in [0, 30, 60, 90, 180, 365] {
            assert_eq!(
                normalise_preferences(&json!({ "emailCheckDays": days })).email_check_days,
                days
            );
        }
        // Anything off the list — a stray number or a numeric string, which
        // JS `includes` would also reject — falls back to ninety.
        assert_eq!(
            normalise_preferences(&json!({ "emailCheckDays": 45 })).email_check_days,
            90
        );
        assert_eq!(
            normalise_preferences(&json!({ "emailCheckDays": "90" })).email_check_days,
            90
        );
    }

    #[test]
    fn the_health_and_clipboard_watch_fields_land_typed() {
        // The six fields the Security panel's clipboard, warnings and
        // confirmations groups read (Settings.tsx L1311-1433). The shipped
        // defaults first (storage.ts L901, L922-923, L932-934).
        let fresh = normalise_preferences(&json!({}));
        assert_eq!(fresh.email_age_days, 365);
        assert!(!fresh.clipboard_capture && !fresh.clipboard_auto_save);
        assert!(fresh.warn_on_reuse && fresh.auto_tag_reused);
        assert!(!fresh.confirm_before_export);

        // The address window has its own whitelist (L1411): 0/90/180/365/730,
        // where a stray number falls back to the shipped year — not to the
        // nearest choice, the way `includes` is strict in JS.
        for days in [0, 90, 180, 365, 730] {
            assert_eq!(
                normalise_preferences(&json!({ "emailAgeDays": days })).email_age_days,
                days
            );
        }
        assert_eq!(
            normalise_preferences(&json!({ "emailAgeDays": 30 })).email_age_days,
            365
        );

        // The watch is the `Boolean(...)` pair of storage.ts L1106-1107:
        // truthy reads as on, and the two switches are independent.
        assert!(normalise_preferences(&json!({ "clipboardCapture": "yes" })).clipboard_capture);
        assert!(!normalise_preferences(&json!({ "clipboardCapture": false })).clipboard_capture);
        assert!(normalise_preferences(&json!({ "clipboardAutoSave": 1 })).clipboard_auto_save);

        // The reuse pair: the tag follows the masking rule (L1104 — anything
        // but an explicit false leaves it on), the warning is a plain switch.
        assert!(normalise_preferences(&json!({ "autoTagReused": null })).auto_tag_reused);
        assert!(!normalise_preferences(&json!({ "autoTagReused": false })).auto_tag_reused);
        assert!(!normalise_preferences(&json!({ "warnOnReuse": false })).warn_on_reuse);
        assert!(normalise_preferences(&json!({ "confirmBeforeExport": true })).confirm_before_export);

        // Typed fields, not leftovers in `extra`.
        let modelled = normalise_preferences(&json!({
            "emailAgeDays": 90,
            "clipboardCapture": true,
            "clipboardAutoSave": true,
            "warnOnReuse": false,
            "autoTagReused": false,
            "confirmBeforeExport": true,
        }));
        assert_eq!(modelled.email_age_days, 90);
        assert!(modelled.clipboard_capture && modelled.clipboard_auto_save);
        assert!(!modelled.warn_on_reuse && !modelled.auto_tag_reused);
        assert!(modelled.confirm_before_export);
        assert!(modelled.extra.as_object().is_some_and(|e| e.is_empty()));
    }

    #[test]
    fn usage_keeps_only_well_shaped_entries_capped_by_recency() {
        // `health.test.ts` L17: malformed fields fall back to zero, an entry
        // with neither a count nor a date drops out, and a negative count
        // clamps to zero while its date keeps the entry alive.
        let p = normalise_preferences(&json!({
            "usage": {
                "good": { "count": 3, "at": 3000 },
                "zeroed": { "count": 0, "at": 0 },
                "malformed": { "count": "many", "at": null },
                "negative": { "count": -2, "at": 1000 },
            }
        }));
        let ids: Vec<&str> = p.usage.keys().map(String::as_str).collect();
        assert_eq!(ids, ["good", "negative"]);
        assert_eq!(p.usage["good"], UsageEntry { count: 3, at: 3000 });
        assert_eq!(p.usage["negative"], UsageEntry { count: 0, at: 1000 });
        // A typed field, not a leftover in `extra`.
        assert!(p
            .extra
            .as_object()
            .is_some_and(|e| e.get("usage").is_none() && e.is_empty()));
    }

    #[test]
    fn usage_caps_at_the_two_hundred_newest() {
        // 250 ascending stamps: the oldest fifty fall off the cap, the rest
        // keep theirs (storage.ts L1354).
        let mut raw = serde_json::Map::new();
        for i in 0..250 {
            raw.insert(format!("item-{i:03}"), json!({ "count": 1, "at": i }));
        }
        let p = normalise_preferences(&json!({ "usage": Value::Object(raw) }));
        assert_eq!(p.usage.len(), 200);
        assert!(p.usage.get("item-000").is_none());
        assert!(p.usage.get("item-049").is_none());
        assert_eq!(p.usage.get("item-050"), Some(&UsageEntry { count: 1, at: 50 }));
        assert_eq!(p.usage.get("item-249"), Some(&UsageEntry { count: 1, at: 249 }));
    }

    #[test]
    fn the_three_shipped_tags_are_seeded_once_and_never_duplicated() {
        let fresh = normalise_preferences(&json!({}));
        let names: Vec<&str> = fresh.tags.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, ["weak", "needs attention", "reused"]);
        assert_eq!(
            fresh.tags.iter().map(|t| t.hue).collect::<Vec<f64>>(),
            [8.0, 36.0, 268.0]
        );

        // A stored tag that is the seed by another spelling (case-insensitive
        // on the trimmed name) blocks the seed and keeps its own everything.
        let kept = normalise_preferences(&json!({
            "tags": [{"id": "tg_mine", "name": "  Weak ", "hue": 100}],
        }));
        assert_eq!(kept.tags.len(), 3);
        assert_eq!(kept.tags[0].id, "tg_mine");
        assert_eq!(kept.tags[0].name, "Weak");
        assert_eq!(kept.tags[0].hue, 100.0);
        assert_eq!(kept.tags[1].name, "needs attention");
    }

    #[test]
    fn a_stored_catalogue_is_cleaned_entry_by_entry() {
        let p = normalise_preferences(&json!({
            "tags": [
                {"id": "a", "name": "  work  ", "hue": 400},
                {"id": "a", "name": "a duplicate id loses"},
                {"id": "b", "name": "", "hue": -20},
                {"name": "no id at all"},
                {"id": "c", "name": "ok", "hue": 12.5},
                "junk",
                {"id": "d", "name": "bad hue", "hue": "orange"},
            ],
        }));
        let named: Vec<(&str, f64)> = p.tags.iter().map(|t| (t.name.as_str(), t.hue)).collect();
        // Four usable entries — first spelling of a duplicate id wins, blank
        // names become "Tag", hues wrap (400 -> 40, -20 -> 340) or fall back
        // to 210 — then the two seeds neither of them shadows.
        assert_eq!(
            named,
            [
                ("work", 40.0),
                ("Tag", 340.0),
                ("ok", 12.5),
                ("bad hue", 210.0),
                ("weak", 8.0),
                ("needs attention", 36.0),
                ("reused", 268.0),
            ]
        );
        // Typed field, not swallowed by `extra` — and cleaning is idempotent,
        // so the same document read twice agrees with itself.
        let back = serde_json::to_value(&p).unwrap();
        assert_eq!(back["tags"].as_array().unwrap().len(), 7);
        assert_eq!(normalise_preferences(&back).tags, p.tags);
    }

    #[test]
    fn a_created_tag_has_a_name_an_id_and_a_free_hue() {
        let blank = create_tag("   ", &[]);
        assert_eq!(blank.name, "Tag");
        assert_eq!(blank.hue, 210.0); // empty wheel: TS's fixed start
        assert_eq!(&blank.id[..3], "tg_");
        assert_eq!(blank.id.len(), 11); // "tg_" plus eight uuid characters

        // The seeds occupy buckets 0 (hue 8), 48 (36) and 264 (268), so the
        // first free bucket stepping the wheel by 24 is 24.
        let seeded = ensure_default_tags(Vec::new());
        let next = create_tag("  work ", &seeded);
        assert_eq!(next.name, "work");
        assert_eq!(next.hue, 24.0);
        assert!(!seeded.iter().any(|tag| tag.id == next.id));

        // Every bucket claimed: the deterministic scatter at the foot of
        // `pickFreeHue` — TS's (length * 47) % 360 — rather than a collision.
        let full: Vec<Tag> = (0..15)
            .map(|i| Tag { id: format!("tg_{i}"), name: format!("t{i}"), hue: (i * 24) as f64 })
            .collect();
        assert_eq!(create_tag("one more", &full).hue, 345.0);
    }

    #[test]
    fn default_tags_are_never_added_twice_by_repeated_loads() {
        let once = ensure_default_tags(Vec::new());
        let twice = ensure_default_tags(ensure_default_tags(once.clone()));
        assert_eq!(twice, once);
        assert_eq!(once.len(), 3);
    }

    #[test]
    fn the_generator_opens_at_the_shipped_defaults() {
        let p = normalise_preferences(&json!({}));
        // storage.ts L935: twenty characters, every set on, look-alikes out.
        assert_eq!(p.password_generator, PasswordGenerator::default());
        assert_eq!(p.password_generator.length, 20);
        assert!(p.password_generator.lower && p.password_generator.upper);
        assert!(p.password_generator.digits && p.password_generator.symbols);
        assert!(p.password_generator.avoid_ambiguous);

        // camelCase on the wire, and the key is typed rather than pocketed in
        // `extra` -- which is flattened into the same object, so an un-typed
        // copy would write the six fields a second time beside the typed one.
        let back = serde_json::to_value(&p).unwrap();
        assert_eq!(
            back["passwordGenerator"],
            json!({
                "length": 20,
                "lower": true,
                "upper": true,
                "digits": true,
                "symbols": true,
                "avoidAmbiguous": true,
            })
        );
        assert!(back.get("password_generator").is_none());
    }

    #[test]
    fn a_stored_generator_is_clamped_and_cleaned() {
        let p = normalise_preferences(&json!({
            "passwordGenerator": {
                "length": 100.4,
                "lower": false,
                "upper": false,
                "digits": false,
                "symbols": true,
                "avoidAmbiguous": false,
            },
        }));
        assert_eq!(p.password_generator.length, 64);
        assert!(!p.password_generator.lower);
        assert!(p.password_generator.symbols);
        assert!(!p.password_generator.avoid_ambiguous);

        // A length under the floor comes back up to it, and an absent one
        // keeps the shipped default rather than reading as zero.
        let low = normalise_preferences(&json!({ "passwordGenerator": { "length": 3 } }));
        assert_eq!(low.password_generator.length, 8);
        let half = normalise_preferences(&json!({ "passwordGenerator": { "lower": false, "upper": false } }));
        assert_eq!(half.password_generator.length, 20);
        assert!(half.password_generator.digits && half.password_generator.symbols);

        // Junk in place of the object is the default, not a load failure.
        assert_eq!(
            normalise_preferences(&json!({ "passwordGenerator": "twenty" })).password_generator,
            PasswordGenerator::default()
        );
    }

    #[test]
    fn a_generator_with_nothing_on_is_put_back_to_the_defaults() {
        // The panel's own hint is "At least one must stay on"; the TS honours
        // it by discarding the whole object, so a length the user chose beside
        // four dead switches does not survive either (storage.ts L1449-1451).
        let p = normalise_preferences(&json!({
            "passwordGenerator": {
                "length": 48,
                "lower": false,
                "upper": false,
                "digits": false,
                "symbols": false,
                "avoidAmbiguous": false,
            },
        }));
        assert_eq!(p.password_generator, PasswordGenerator::default());

        // One set left on is enough, and the rest of the object is kept.
        let one = normalise_preferences(&json!({
            "passwordGenerator": { "length": 48, "lower": true, "upper": false, "digits": false, "symbols": false },
        }));
        assert_eq!(one.password_generator.length, 48);
        assert!(one.password_generator.lower);
        assert!(!one.password_generator.upper && !one.password_generator.digits);
    }
}