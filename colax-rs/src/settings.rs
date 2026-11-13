//! Settings, in the same shape as the Electron window: a short rail of merged
//! groups, a strip of mini-tabs inside each, and a hand-built search index that
//! jumps to the right group and tab.
//!
//! Every control writes the same preference the Electron build writes, so the
//! two editions stay one product. Controls that need a capability the native
//! port does not have yet (IMAP, the share server, the tray) are labelled as
//! such instead of pretending to work.

use eframe::egui;
use egui::{pos2, vec2, Align2, Color32, Rect, RichText, Sense, Stroke};

use crate::app::{paint_gradient, App, Confirm, SettingsGroup};
use crate::icon::draw as icon_draw;
use crate::model::*;
use crate::theme::{Accent, Theme};

pub struct SettingsState {
    pub open: bool,
    pub group: SettingsGroup,
    pub section: String,
    pub query: String,
    pub sample: String,
    pub new_channel: String,
    pub new_channel_tags: String,
    pub new_folder: String,
    pub new_tag: String,
    pub vault_password: String,
    pub vault_password_confirm: String,
    pub vault_password_error: String,
    pub import_path: String,
    pub backup_password: String,
    pub backup_message: String,
    pub new_alarm_label: String,
    pub alarm_hour: u32,
    pub alarm_minute: u32,
    pub new_slot_label: String,
    pub new_slot_key: String,
}

impl Default for SettingsState {
    fn default() -> Self {
        Self {
            open: false,
            group: SettingsGroup::Appearance,
            section: "design".into(),
            query: String::new(),
            sample: String::new(),
            new_channel: String::new(),
            new_channel_tags: String::new(),
            new_folder: String::new(),
            new_tag: String::new(),
            vault_password: String::new(),
            vault_password_confirm: String::new(),
            vault_password_error: String::new(),
            import_path: String::new(),
            backup_password: String::new(),
            backup_message: String::new(),
            new_alarm_label: String::new(),
            alarm_hour: 9,
            alarm_minute: 0,
            new_slot_label: String::new(),
            new_slot_key: String::new(),
        }
    }
}

const GROUPS: [(SettingsGroup, &str, &str); 8] = [
    (SettingsGroup::Appearance, "Appearance", "grid"),
    (SettingsGroup::Workspace, "Workspace", "folder"),
    (SettingsGroup::Security, "Security", "shield"),
    (SettingsGroup::Data, "Data", "inbox"),
    (SettingsGroup::Optimize, "Optimize", "refresh"),
    (SettingsGroup::Sharing, "Sharing", "external"),
    (SettingsGroup::Desktop, "Desktop", "dock"),
    (SettingsGroup::About, "About", "dot"),
];

fn sections(group: SettingsGroup) -> &'static [(&'static str, &'static str)] {
    match group {
        SettingsGroup::Appearance => &[
            ("design", "Design"),
            ("layout", "Layout"),
            ("background", "Background"),
            ("hidden", "Hidden"),
        ],
        SettingsGroup::Workspace => &[("channels", "Channels & tags"), ("docks", "Docks")],
        SettingsGroup::Security => &[("security", "Security"), ("generator", "Generator"), ("alarms", "Alarms")],
        SettingsGroup::Data => &[("everything", "Everything"), ("theme", "Theme"), ("data", "Data")],
        SettingsGroup::Optimize => &[
            ("general", "General"),
            ("resources", "Resources"),
            ("look", "Look & feel"),
            ("speed", "Speed"),
            ("messages", "Messages"),
        ],
        SettingsGroup::Sharing => &[("sharing", "Sharing")],
        SettingsGroup::Desktop => &[("desktop", "Desktop")],
        SettingsGroup::About => &[("about", "About")],
    }
}

fn group_label(group: SettingsGroup) -> &'static str {
    GROUPS.iter().find(|entry| entry.0 == group).map(|entry| entry.1).unwrap_or("Settings")
}

/// The search index, mirroring the Electron one: every findable control, the
/// group and mini-tab it lives in, and the words people type to find it.
const INDEX: &[(&str, SettingsGroup, &str, &str, &str)] = &[
    ("Theme", SettingsGroup::Appearance, "design", "light dark system mode colour", "Light · Dark · System"),
    ("Accent colour", SettingsGroup::Appearance, "design", "slate sage dusk clay palette", "Slate · Sage · Dusk · Clay"),
    ("Animation intensity", SettingsGroup::Appearance, "design", "motion reduce slider", "0–100%"),
    ("Animation speed", SettingsGroup::Appearance, "design", "motion instant normal relaxed", "Instant · Normal · Relaxed"),
    ("Glow", SettingsGroup::Appearance, "design", "ambient mesh gradient depth", "0–100%"),
    ("Text size", SettingsGroup::Appearance, "design", "font scale accessibility", "80–140%"),
    ("Corner roundness", SettingsGroup::Appearance, "design", "radius sharp soft", "0.6–1.6"),
    ("Density", SettingsGroup::Appearance, "design", "compact comfortable spacious spacing", "Compact · Comfortable · Spacious"),
    ("Card shadow", SettingsGroup::Appearance, "design", "depth elevation lift", "0–100%"),
    ("Reduce transparency", SettingsGroup::Appearance, "design", "glass blur frosted flat faster", "On · Off"),
    ("High contrast", SettingsGroup::Appearance, "design", "borders text visibility", "On · Off"),
    ("Default view", SettingsGroup::Appearance, "layout", "flow list grid cards views", "Flow · List · Grid"),
    ("Sort by", SettingsGroup::Appearance, "layout", "order name recent updated weakest username", "Name · Updated · Created · Strength · Username"),
    ("Show websites", SettingsGroup::Appearance, "layout", "urls domains display", "On · Off"),
    ("Show notes", SettingsGroup::Appearance, "layout", "notes preview cards", "On · Off"),
    ("Click a login to copy", SettingsGroup::Appearance, "layout", "copy click card password", "On · Off"),
    ("Pin favorites", SettingsGroup::Appearance, "layout", "starred top section", "On · Off"),
    ("Health badges", SettingsGroup::Appearance, "layout", "weak reused stale warning", "On · Off"),
    ("Channel labels", SettingsGroup::Appearance, "layout", "sidebar icons names rail", "Both · Icons · Names"),
    ("Rail position", SettingsGroup::Appearance, "layout", "sidebar left right top bottom", "Left · Right · Top · Bottom"),
    ("Rail alignment", SettingsGroup::Appearance, "layout", "sidebar middle bottom align", "Top · Middle · Bottom"),
    ("Compact rail", SettingsGroup::Appearance, "layout", "sidebar icons narrow", "On · Off"),
    ("Background image", SettingsGroup::Appearance, "background", "wallpaper photo backdrop url", "Image URL · Remove"),
    ("Image opacity", SettingsGroup::Appearance, "background", "transparency strength photo", "0–100%"),
    ("Blur", SettingsGroup::Appearance, "background", "soften photo blur", "0–40px"),
    ("Dim", SettingsGroup::Appearance, "background", "darken lighten veil", "0–90%"),
    ("Show hidden", SettingsGroup::Appearance, "hidden", "restore hidden channels folders", "Restore · Show everything"),
    ("Channels", SettingsGroup::Workspace, "channels", "sidebar views list manage folders", "New channel · Rename · Delete"),
    ("Tags", SettingsGroup::Workspace, "channels", "labels catalogue rename delete", "New tag · Delete"),
    ("Folders", SettingsGroup::Workspace, "channels", "group channels move", "Create · Delete"),
    ("Quick-launch docks", SettingsGroup::Workspace, "docks", "docks shortcuts bars keys", "Add · Remove · Position"),
    ("Vault password", SettingsGroup::Security, "security", "master password encrypt remove", "Set · Change · Remove"),
    ("Auto-lock", SettingsGroup::Security, "security", "lock idle timer minutes inactivity", "1 · 5 · 15 · 30 · 60 min"),
    ("Clipboard", SettingsGroup::Security, "security", "wipe clear seconds copy", "Never · 15s · 30s · 60s"),
    ("Mask email addresses", SettingsGroup::Security, "security", "usernames hidden dots privacy", "On · Off"),
    ("Reveal passwords", SettingsGroup::Security, "security", "show secrets unhide", "On · Off"),
    ("Reuse warnings", SettingsGroup::Security, "security", "reused duplicate warning", "On · Off"),
    ("Stale passwords", SettingsGroup::Security, "security", "password age days rotation", "Never · 30 · 60 · 90 · 180 · 365"),
    ("Generator presets", SettingsGroup::Security, "generator", "pin web login long sample", "PIN · Web login · Long"),
    ("Password length", SettingsGroup::Security, "generator", "characters size generator", "8–64"),
    ("Character sets", SettingsGroup::Security, "generator", "lowercase uppercase digits symbols look-alikes", "Lower · Upper · Digits · Symbols"),
    ("Alarms", SettingsGroup::Security, "alarms", "reminders clock time days", "Add · Time · Days · Sound"),
    ("Backup", SettingsGroup::Data, "everything", "export encrypted backup restore", "Export · Restore"),
    ("Theme backup", SettingsGroup::Data, "theme", "export import look channels tags", "Export · Import"),
    ("CSV", SettingsGroup::Data, "data", "export import text csv", "Export · Import"),
    ("Storage", SettingsGroup::Data, "data", "size kilobytes vault file", "Size · Path"),
    ("Delete all data", SettingsGroup::Data, "data", "reset remove everything vault", "Delete"),
    ("Resources", SettingsGroup::Optimize, "resources", "memory ram feature heavy motion blur cache", "Feature costs"),
    ("Measurements", SettingsGroup::Optimize, "general", "logins tags channels size", "Counts"),
    ("Spellchecker", SettingsGroup::Optimize, "speed", "dictionary spellcheck", "On · Off"),
    ("Mail polling", SettingsGroup::Optimize, "messages", "imap mail check interval", "Electron only"),
    ("Share server", SettingsGroup::Sharing, "sharing", "lan tunnel codes devices", "Electron only"),
    ("Tray", SettingsGroup::Desktop, "desktop", "startup tray minimise quit", "On · Off"),
    ("Sounds", SettingsGroup::Desktop, "desktop", "mute alarm chime", "On · Off"),
    ("Version", SettingsGroup::About, "about", "build diagnostics update", "0.1.0"),
];

pub fn show(ctx: &egui::Context, app: &mut App) {
    if !app.settings.open {
        return;
    }
    let theme = app.theme;
    let mut open = true;

    egui::Window::new("settings-window")
        .title_bar(false)
        .open(&mut open)
        .collapsible(false)
        .resizable(true)
        .anchor(Align2::CENTER_CENTER, vec2(0.0, 0.0))
        .default_width(1080.0)
        .default_height(720.0)
        .frame(
            egui::Frame::none()
                .fill(theme.bg())
                .rounding(theme.radius(20.0))
                .stroke(Stroke::new(1.0_f32, theme.border_strong()))
                .shadow(egui::epaint::Shadow {
                    offset: vec2(0.0, 10.0),
                    blur: 38.0,
                    spread: 0.0,
                    color: Color32::from_black_alpha(140),
                    ..Default::default()
                })
                .inner_margin(egui::Margin::same(0.0)),
        )
        .show(ctx, |ui| {
            ui.set_width(1060.0);
            ui.set_height(700.0);
            ui.horizontal_top(|ui| {
                // ---- Rail -------------------------------------------------
                egui::Frame::none()
                    .fill(theme.plate(0.35))
                    .inner_margin(egui::Margin::symmetric(12.0, 14.0))
                    .show(ui, |ui| {
                        ui.set_width(210.0);
                        ui.set_height(672.0);
                        ui.horizontal(|ui| {
                            ui.label(
                                RichText::new("Settings")
                                    .font(egui::FontId::proportional(18.0))
                                    .strong()
                                    .color(theme.text()),
                            );
                            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                                if close_button(ui, &theme).clicked() {
                                    app.settings.open = false;
                                }
                            });
                        });
                        ui.add_space(8.0);
                        let search = ui.add(
                            egui::TextEdit::singleline(&mut app.settings.query)
                                .hint_text("Search settings")
                                .desired_width(f32::INFINITY),
                        );
                        let _ = search;
                        ui.add_space(8.0);

                        if !app.settings.query.trim().is_empty() {
                            let needle = app.settings.query.trim().to_lowercase();
                            let matches: Vec<&(&str, SettingsGroup, &str, &str, &str)> = INDEX
                                .iter()
                                .filter(|entry| {
                                    let haystack =
                                        format!("{} {} {}", entry.0, entry.3, entry.4).to_lowercase();
                                    needle.split_whitespace().all(|term| haystack.contains(term))
                                })
                                .collect();
                            if matches.is_empty() {
                                ui.label(
                                    RichText::new("No matching settings")
                                        .size(10.5)
                                        .color(theme.text_faint()),
                                );
                            }
                            egui::ScrollArea::vertical().max_height(600.0).show(ui, |ui| {
                                for entry in matches {
                                    let response = search_result(ui, &theme, entry.0, group_label(entry.1));
                                    if response.clicked() {
                                        app.settings.group = entry.1;
                                        app.settings.section = entry.2.to_string();
                                        app.settings.query.clear();
                                    }
                                }
                            });
                        } else {
                            for (group, label, icon) in GROUPS {
                                let active = app.settings.group == group;
                                let response = rail_item(ui, &theme, icon, label, active);
                                if response.clicked() {
                                    app.settings.group = group;
                                    app.settings.section = sections(group)[0].0.to_string();
                                }
                            }
                            ui.with_layout(egui::Layout::bottom_up(egui::Align::Min), |ui| {
                                ui.label(
                                    RichText::new("Preferences save as you change them")
                                        .size(9.5)
                                        .color(theme.text_faint()),
                                );
                            });
                        }
                    });

                ui.separator();

                // ---- Body -------------------------------------------------
                egui::Frame::none()
                    .inner_margin(egui::Margin::symmetric(20.0, 16.0))
                    .show(ui, |ui| {
                        ui.set_width(818.0);
                        ui.set_height(668.0);
                        let group = app.settings.group;
                        let tabs = sections(group);
                        ui.horizontal(|ui| {
                            for (id, label) in tabs {
                                let active = app.settings.section == *id;
                                if app.tab_pill(ui, label, active, false).clicked() {
                                    app.settings.section = (*id).into();
                                }
                            }
                        });
                        ui.add_space(4.0);
                        ui.label(
                            RichText::new(group_hint(group))
                                .size(10.5)
                                .color(theme.text_muted()),
                        );
                        ui.add_space(8.0);
                        egui::ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
                            match (group, app.settings.section.as_str()) {
                                (SettingsGroup::Appearance, "design") => design(ui, app),
                                (SettingsGroup::Appearance, "layout") => layout(ui, app),
                                (SettingsGroup::Appearance, "background") => background(ui, app),
                                (SettingsGroup::Appearance, "hidden") => hidden(ui, app),
                                (SettingsGroup::Workspace, "channels") => channels(ui, app),
                                (SettingsGroup::Workspace, "docks") => docks(ui, app),
                                (SettingsGroup::Security, "security") => security(ui, app),
                                (SettingsGroup::Security, "generator") => generator(ui, app),
                                (SettingsGroup::Security, "alarms") => alarms(ui, app),
                                (SettingsGroup::Data, "everything") => backup(ui, app),
                                (SettingsGroup::Data, "theme") => theme_backup(ui, app),
                                (SettingsGroup::Data, "data") => data(ui, app),
                                (SettingsGroup::Optimize, "general") => optimize_general(ui, app),
                                (SettingsGroup::Optimize, "resources") => resources(ui, app),
                                (SettingsGroup::Optimize, "look") => optimize_look(ui, app),
                                (SettingsGroup::Optimize, "speed") => optimize_speed(ui, app),
                                (SettingsGroup::Optimize, "messages") => optimize_messages(ui, app),
                                (SettingsGroup::Sharing, _) => sharing(ui, app),
                                (SettingsGroup::Desktop, _) => desktop(ui, app),
                                (SettingsGroup::About, _) => about(ui, app),
                                _ => {}
                            }
                        });
                    });
            });
        });
    if !open {
        app.settings.open = false;
    }
}

fn group_hint(group: SettingsGroup) -> &'static str {
    match group {
        SettingsGroup::Appearance => "Design, layout, background and what is hidden",
        SettingsGroup::Workspace => "Channels, tags, folders and the quick-launch bars",
        SettingsGroup::Security => "Locking, the vault password, passwords and reminders",
        SettingsGroup::Data => "Every export, every import, and what is stored",
        SettingsGroup::Optimize => "Profiles, resources, speed and mail loading",
        SettingsGroup::Sharing => "Sharing with another device",
        SettingsGroup::Desktop => "Tray, startup and shutting down",
        SettingsGroup::About => "Diagnostics and resets",
    }
}

/* ---- Rail pieces --------------------------------------------------------- */

fn rail_item(ui: &mut egui::Ui, theme: &Theme, icon: &str, label: &str, active: bool) -> egui::Response {
    let (rect, response) = ui.allocate_exact_size(vec2(ui.available_width(), 33.0), Sense::click());
    let fill = if active {
        theme.accent_soft()
    } else if response.hovered() {
        theme.surface_hover()
    } else {
        Color32::TRANSPARENT
    };
    ui.painter().rect_filled(rect, theme.radius(9.0), fill);
    if active {
        ui.painter().rect_filled(
            Rect::from_center_size(pos2(rect.left() + 1.0, rect.center().y), vec2(3.0, 16.0)),
            egui::Rounding::same(2.0),
            theme.accent(),
        );
    }
    let color = if active { theme.accent_text() } else { theme.text_muted() };
    icon_draw(
        ui.painter(),
        icon,
        Rect::from_center_size(pos2(rect.left() + 18.0, rect.center().y), vec2(14.0, 14.0)),
        color,
        1.5,
    );
    ui.painter().text(
        pos2(rect.left() + 34.0, rect.center().y),
        Align2::LEFT_CENTER,
        label,
        egui::FontId::proportional(12.0),
        color,
    );
    response
}

fn search_result(ui: &mut egui::Ui, theme: &Theme, label: &str, group: &str) -> egui::Response {
    let (rect, response) = ui.allocate_exact_size(vec2(ui.available_width(), 34.0), Sense::click());
    if response.hovered() {
        ui.painter().rect_filled(rect, theme.radius(8.0), theme.accent_soft());
    }
    ui.painter().text(
        pos2(rect.left() + 6.0, rect.center().y - 6.0),
        Align2::LEFT_CENTER,
        label,
        egui::FontId::proportional(11.0),
        theme.text(),
    );
    ui.painter().text(
        pos2(rect.left() + 6.0, rect.center().y + 7.0),
        Align2::LEFT_CENTER,
        group,
        egui::FontId::proportional(8.5),
        theme.text_faint(),
    );
    response
}

fn close_button(ui: &mut egui::Ui, theme: &Theme) -> egui::Response {
    let (rect, response) = ui.allocate_exact_size(vec2(24.0, 24.0), Sense::click());
    if response.hovered() {
        ui.painter().rect_filled(rect, theme.radius(7.0), theme.plate(1.4));
    }
    icon_draw(
        ui.painter(),
        "close",
        Rect::from_center_size(rect.center(), vec2(11.0, 11.0)),
        theme.text_muted(),
        1.4,
    );
    response
}

/* ---- Generic controls ---------------------------------------------------- */

fn card(ui: &mut egui::Ui, theme: &Theme, title: &str, hint: &str, body: impl FnOnce(&mut egui::Ui)) {
    egui::Frame::none()
        .fill(theme.card())
        .rounding(theme.radius(14.0))
        .stroke(Stroke::new(1.0_f32, theme.hairline()))
        .inner_margin(egui::Margin::same(13.0))
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.label(RichText::new(title).size(12.5).strong().color(theme.text()));
            if !hint.is_empty() {
                ui.label(
                    RichText::new(hint)
                        .size(10.0)
                        .color(theme.text_muted()),
                );
            }
            ui.add_space(6.0);
            body(ui);
        });
    ui.add_space(8.0);
}

fn toggle(ui: &mut egui::Ui, theme: &Theme, label: &str, hint: &str, value: &mut bool) -> bool {
    let before = *value;
    ui.horizontal(|ui| {
        ui.vertical(|ui| {
            ui.label(RichText::new(label).size(12.0).color(theme.text()));
            if !hint.is_empty() {
                ui.label(RichText::new(hint).size(9.5).color(theme.text_faint()));
            }
        });
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            ui.checkbox(value, "");
        });
    });
    before != *value
}

fn segmented<T: PartialEq + Copy>(ui: &mut egui::Ui, theme: &Theme, value: &mut T, options: &[(T, &str)]) -> bool {
    let before = *value;
    ui.horizontal_wrapped(|ui| {
        for (option, label) in options {
            let active = *value == *option;
            let (rect, response) = {
                let galley = ui.fonts(|fonts| {
                    fonts.layout_no_wrap(label.to_string(), egui::FontId::proportional(10.5), theme.text())
                });
                let size = galley.size() + vec2(18.0, 7.0);
                let (rect, response) = ui.allocate_exact_size(size, Sense::click());
                (rect, response)
            };
            let fill = if active {
                theme.accent_soft()
            } else if response.hovered() {
                theme.surface_hover()
            } else {
                theme.plate(0.8)
            };
            let stroke = if active {
                Stroke::new(1.0_f32, theme.accent_wash(0.45))
            } else {
                Stroke::new(1.0_f32, theme.border())
            };
            ui.painter().rect(rect, egui::Rounding::same(999.0), fill, stroke);
            ui.painter().text(
                rect.center(),
                Align2::CENTER_CENTER,
                *label,
                egui::FontId::proportional(10.5),
                if active { theme.accent_text() } else { theme.text_muted() },
            );
            if response.clicked() {
                *value = *option;
            }
        }
    });
    before != *value
}

fn slider(ui: &mut egui::Ui, theme: &Theme, label: &str, value: &mut f32, range: std::ops::RangeInclusive<f32>, suffix: &str) -> bool {
    let before = *value;
    ui.horizontal(|ui| {
        ui.add_sized(vec2(160.0, 18.0), egui::Label::new(RichText::new(label).size(11.5).color(theme.text())));
        ui.add(egui::Slider::new(value, range).show_value(false));
        ui.label(
            RichText::new(format!("{:.0}{}", *value * 100.0, suffix))
                .size(10.0)
                .color(theme.text_muted()),
        );
    });
    (before - *value).abs() > f32::EPSILON
}

fn action_row(ui: &mut egui::Ui, theme: &Theme, label: &str, hint: &str, button: &str, danger: bool) -> bool {
    let mut clicked = false;
    ui.horizontal(|ui| {
        ui.vertical(|ui| {
            ui.label(RichText::new(label).size(12.0).color(theme.text()));
            if !hint.is_empty() {
                ui.label(RichText::new(hint).size(9.5).color(theme.text_faint()));
            }
        });
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            let fill = if danger { theme.danger() } else { theme.plate(1.2) };
            let text = if danger { Color32::WHITE } else { theme.text() };
            if ui
                .add(
                    egui::Button::new(RichText::new(button).size(10.5).color(text))
                        .fill(fill)
                        .rounding(theme.radius(8.0)),
                )
                .clicked()
            {
                clicked = true;
            }
        });
    });
    clicked
}

/* ---- Appearance ---------------------------------------------------------- */

fn design(ui: &mut egui::Ui, app: &mut App) {
    let theme = app.theme;
    let mut changed = false;
    let prefs = &mut app.data.prefs;

    card(ui, &theme, "Theme", "Applies to every window immediately.", |ui| {
        changed |= segmented(
            ui,
            &theme,
            &mut prefs.theme,
            &[(ThemeSetting::Light, "Light"), (ThemeSetting::Dark, "Dark"), (ThemeSetting::System, "System")],
        );
        ui.add_space(8.0);
        ui.label(RichText::new("Accent").size(10.5).color(theme.text_muted()));
        ui.horizontal(|ui| {
            for accent in Accent::ALL {
                let selected = prefs.accent.theme() == accent;
                let (hue, hue2) = accent.hues();
                let (rect, response) = ui.allocate_exact_size(vec2(30.0, 30.0), Sense::click());
                let from = crate::theme::hsl(hue, 52.0, 58.0);
                let to = crate::theme::hsl(hue2, 46.0, 58.0);
                paint_gradient(ui.painter(), rect, from, to, 10.0);
                if selected {
                    ui.painter().rect_stroke(rect.expand(2.0), egui::Rounding::same(12.0), Stroke::new(1.5_f32, theme.text()));
                }
                if response.clicked() {
                    prefs.accent = match accent {
                        Accent::Slate => AccentSetting::Slate,
                        Accent::Sage => AccentSetting::Sage,
                        Accent::Dusk => AccentSetting::Dusk,
                        Accent::Clay => AccentSetting::Clay,
                    };
                    changed = true;
                }
                response.on_hover_text(accent.label());
            }
        });
    });

    card(ui, &theme, "Motion", "The app shipped calm; these two sliders set how calm.", |ui| {
        changed |= slider(ui, &theme, "Intensity", &mut prefs.motion, 0.0..=1.0, "%");
        ui.add_space(4.0);
        ui.horizontal(|ui| {
            ui.add_sized(vec2(160.0, 18.0), egui::Label::new(RichText::new("Speed").size(11.5).color(theme.text())));
            if segmented(ui, &theme, &mut prefs.motion_speed, &[(1.0, "Normal"), (2.0, "Instant"), (0.5, "Relaxed")]) {
                changed = true;
            }
        });
        changed |= toggle(ui, &theme, "Micro motion", "Hover lifts and small transitions.", &mut prefs.micro_motion);
    });

    card(ui, &theme, "Light and glass", "How much of the ambient gradient survives the surfaces.", |ui| {
        changed |= slider(ui, &theme, "Glow", &mut prefs.ambient, 0.0..=1.0, "%");
        changed |= slider(ui, &theme, "Card shadow", &mut prefs.card_depth, 0.0..=1.0, "%");
        changed |= toggle(ui, &theme, "Reduce transparency", "Flat surfaces instead of frosted glass.", &mut prefs.reduce_transparency);
        changed |= toggle(ui, &theme, "High contrast", "Stronger borders and brighter secondary text.", &mut prefs.high_contrast);
    });

    card(ui, &theme, "Type and shape", "", |ui| {
        changed |= segmented(
            ui,
            &theme,
            &mut prefs.density,
            &[
                (DensitySetting::Compact, "Compact"),
                (DensitySetting::Comfortable, "Comfortable"),
                (DensitySetting::Spacious, "Spacious"),
            ],
        );
        ui.add_space(6.0);
        let mut scale = prefs.text_scale as f32;
        if slider(ui, &theme, "Text size", &mut scale, 0.8..=1.4, "%") {
            prefs.text_scale = (scale * 100.0).round() as i32;
            changed = true;
        }
        ui.add_space(4.0);
        let mut roundness = (prefs.roundness - 0.6) / 0.8;
        if slider(ui, &theme, "Corner roundness", &mut roundness, 0.0..=1.0, "%") {
            prefs.roundness = 0.6 + roundness * 0.8;
            changed = true;
        }
    });

    if changed {
        app.mark_dirty();
    }
}

fn layout(ui: &mut egui::Ui, app: &mut App) {
    let theme = app.theme;
    let mut changed = false;
    let prefs = &mut app.data.prefs;

    card(ui, &theme, "Views", "Each view is tuned separately; this is the one that opens.", |ui| {
        changed |= segmented(
            ui,
            &theme,
            &mut prefs.view,
            &[(VaultView::Animated, "Flow"), (VaultView::List, "List"), (VaultView::Grid, "Grid")],
        );
        ui.add_space(6.0);
        egui::ComboBox::from_id_source("sort")
            .width(220.0)
            .selected_text(prefs.sort.label())
            .show_ui(ui, |ui| {
                for mode in SortMode::ALL {
                    if ui.selectable_value(&mut prefs.sort, mode, mode.label()).changed() {
                        changed = true;
                    }
                }
            });
    });

    card(ui, &theme, "What a login shows", "", |ui| {
        changed |= toggle(ui, &theme, "Show websites", "The domain under each title.", &mut prefs.show_urls);
        changed |= toggle(ui, &theme, "Show notes", "A one-line preview on cards.", &mut prefs.show_notes);
        changed |= toggle(ui, &theme, "Tag chips", "Show the tags a login carries.", &mut prefs.show_tag_chips);
        changed |= toggle(ui, &theme, "Health badges", "Weak and reused warnings.", &mut prefs.show_health_badges);
        changed |= toggle(ui, &theme, "Pin favorites", "Favorites first in every list.", &mut prefs.pin_favorites);
        changed |= toggle(ui, &theme, "Click a login to copy its password", "Turn off to make copying deliberate.", &mut prefs.click_to_copy);
        changed |= toggle(ui, &theme, "Group the list by first letter", "", &mut prefs.show_letter_groups);
        changed |= toggle(ui, &theme, "Hide dividers", "No hairlines between settings rows.", &mut prefs.hide_dividers);
    });

    card(ui, &theme, "The rail", "", |ui| {
        ui.horizontal(|ui| {
            ui.add_sized(vec2(160.0, 18.0), egui::Label::new(RichText::new("Channel labels").size(11.5).color(theme.text())));
            changed |= segmented(
                ui,
                &theme,
                &mut prefs.sidebar_labels,
                &[(SidebarLabels::Both, "Both"), (SidebarLabels::Icon, "Icons"), (SidebarLabels::Name, "Names")],
            );
        });
        ui.add_space(4.0);
        ui.horizontal(|ui| {
            ui.add_sized(vec2(160.0, 18.0), egui::Label::new(RichText::new("Rail position").size(11.5).color(theme.text())));
            changed |= segmented(
                ui,
                &theme,
                &mut prefs.sidebar_position,
                &[
                    (RailPosition::Left, "Left"),
                    (RailPosition::Right, "Right"),
                    (RailPosition::Top, "Top"),
                    (RailPosition::Bottom, "Bottom"),
                ],
            );
        });
        ui.add_space(4.0);
        ui.horizontal(|ui| {
            ui.add_sized(vec2(160.0, 18.0), egui::Label::new(RichText::new("Rail alignment").size(11.5).color(theme.text())));
            changed |= segmented(
                ui,
                &theme,
                &mut prefs.rail_align,
                &[(RailAlign::Top, "Top"), (RailAlign::Middle, "Middle"), (RailAlign::Bottom, "Bottom")],
            );
        });
        ui.add_space(6.0);
        changed |= toggle(ui, &theme, "Compact rail", "Icons only, a narrow strip.", &mut prefs.compact_sidebar);
        changed |= toggle(ui, &theme, "Show the rail", "", &mut prefs.show_sidebar);
        changed |= toggle(ui, &theme, "Show unassigned channel", "", &mut prefs.show_unassigned_channel);
        changed |= toggle(ui, &theme, "Auto-tag new logins", "Reads the site domain.", &mut prefs.auto_tag_domain);
    });

    card(ui, &theme, "Buttons", "Which chrome the window offers.", |ui| {
        changed |= toggle(ui, &theme, "New login", "", &mut prefs.show_new_login_button);
        changed |= toggle(ui, &theme, "Bulk add", "", &mut prefs.show_bulk_add_button);
        changed |= toggle(ui, &theme, "Settings", "", &mut prefs.show_settings_button);
        changed |= toggle(ui, &theme, "Lock", "", &mut prefs.show_lock_button);
        changed |= toggle(ui, &theme, "New channel", "", &mut prefs.show_new_channel_button);
    });

    if changed {
        app.mark_dirty();
    }
}

fn background(ui: &mut egui::Ui, app: &mut App) {
    let theme = app.theme;
    let mut changed = false;
    let prefs = &mut app.data.prefs;
    card(
        ui,
        &theme,
        "App background",
        "A URL is fetched by the system image loader; an upload stays local. The native port keeps the URL form only.",
        |ui| {
            let response = ui.add(
                egui::TextEdit::singleline(&mut prefs.background_image)
                    .hint_text("https://…/wallpaper.jpg")
                    .desired_width(f32::INFINITY),
            );
            if response.changed() {
                changed = true;
            }
            ui.add_space(6.0);
            changed |= slider(ui, &theme, "Opacity", &mut prefs.background_opacity, 0.0..=1.0, "%");
            changed |= slider(ui, &theme, "Blur", &mut prefs.background_blur, 0.0..=1.0, "%");
            changed |= slider(ui, &theme, "Dim", &mut prefs.background_dim, 0.0..=1.0, "%");
            ui.add_space(4.0);
            if action_row(ui, &theme, "Remove the background", "", "Remove", false) {
                prefs.background_image.clear();
                changed = true;
            }
        },
    );
    if changed {
        app.mark_dirty();
    }
}

fn hidden(ui: &mut egui::Ui, app: &mut App) {
    let theme = app.theme;
    let mut changed = false;
    let mut restore_channel: Option<String> = None;
    let mut restore_folder: Option<String> = None;
    let channels = app.data.prefs.channels.clone();
    let folders = app.data.prefs.folders.clone();
    card(ui, &theme, "Hidden channels", "Restore anything a right-click put away.", |ui| {
        let hidden: Vec<&Channel> = channels.iter().filter(|channel| channel.hidden).collect();
        if hidden.is_empty() {
            ui.label(RichText::new("Nothing is hidden.").size(10.5).color(theme.text_faint()));
        }
        for channel in hidden {
            ui.horizontal(|ui| {
                ui.label(RichText::new(&channel.name).size(11.5).color(theme.text()));
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if ui.button("Restore").clicked() {
                        restore_channel = Some(channel.id.clone());
                    }
                });
            });
        }
    });
    card(ui, &theme, "Hidden folders", "", |ui| {
        let hidden: Vec<&Folder> = folders.iter().filter(|folder| folder.hidden).collect();
        if hidden.is_empty() {
            ui.label(RichText::new("Nothing is hidden.").size(10.5).color(theme.text_faint()));
        }
        for folder in hidden {
            ui.horizontal(|ui| {
                ui.label(RichText::new(&folder.name).size(11.5).color(theme.text()));
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if ui.button("Restore").clicked() {
                        restore_folder = Some(folder.id.clone());
                    }
                });
            });
        }
    });
    if let Some(id) = restore_channel {
        if let Some(channel) = app.data.prefs.channels.iter_mut().find(|channel| channel.id == id) {
            channel.hidden = false;
        }
        changed = true;
    }
    if let Some(id) = restore_folder {
        if let Some(folder) = app.data.prefs.folders.iter_mut().find(|folder| folder.id == id) {
            folder.hidden = false;
        }
        changed = true;
    }
    if action_row(ui, &theme, "Show everything", "Brings back every hidden channel and folder.", "Restore all", false) {
        for channel in &mut app.data.prefs.channels {
            channel.hidden = false;
        }
        for folder in &mut app.data.prefs.folders {
            folder.hidden = false;
        }
        changed = true;
    }
    if changed {
        app.mark_dirty();
    }
}

/* ---- Workspace ----------------------------------------------------------- */

fn channels(ui: &mut egui::Ui, app: &mut App) {
    let theme = app.theme;
    let mut changed = false;

    card(ui, &theme, "New channel", "A channel collects logins by tag.", |ui| {
        ui.horizontal(|ui| {
            ui.add_sized(
                vec2(200.0, 28.0),
                egui::TextEdit::singleline(&mut app.settings.new_channel).hint_text("Channel name"),
            );
            ui.add_sized(
                vec2(220.0, 28.0),
                egui::TextEdit::singleline(&mut app.settings.new_channel_tags)
                    .hint_text("Tags, comma separated"),
            );
            if ui.button("Add channel").clicked() && !app.settings.new_channel.trim().is_empty() {
                let tag_ids: Vec<String> = app.settings
                    .new_channel_tags
                    .split(',')
                    .map(|tag| tag.trim())
                    .filter(|tag| !tag.is_empty())
                    .map(|tag| app.data.prefs.ensure_tag(tag))
                    .collect();
                let hue = hue_for(&app.settings.new_channel);
                app.data.prefs.channels.push(Channel {
                    id: new_id("channel"),
                    name: app.settings.new_channel.trim().to_string(),
                    kind: ChannelKind::Custom,
                    icon: "tag".into(),
                    hue,
                    tag_ids,
                    ..Default::default()
                });
                app.settings.new_channel.clear();
                app.settings.new_channel_tags.clear();
                changed = true;
            }
        });
    });

    card(ui, &theme, "Channels", "Rename inline; delete removes the channel, never the logins.", |ui| {
        let mut remove: Option<String> = None;
        if app.data.prefs.channels.is_empty() {
            ui.label(RichText::new("No custom channels yet.").size(10.5).color(theme.text_faint()));
        }
        for channel in &mut app.data.prefs.channels {
            ui.horizontal(|ui| {
                icon_draw(
                    ui.painter(),
                    &channel.icon,
                    Rect::from_center_size(ui.cursor().min + vec2(8.0, 14.0), vec2(13.0, 13.0)),
                    theme.text_muted(),
                    1.4,
                );
                ui.add_space(20.0);
                if ui
                    .add(egui::TextEdit::singleline(&mut channel.name).desired_width(240.0))
                    .changed()
                {
                    changed = true;
                }
                ui.label(
                    RichText::new(format!(
                        "{} tag{}",
                        channel.tag_ids.len(),
                        if channel.tag_ids.len() == 1 { "" } else { "s" }
                    ))
                    .size(9.5)
                    .color(theme.text_faint()),
                );
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if ui.button("Delete").clicked() {
                        remove = Some(channel.id.clone());
                    }
                });
            });
            ui.separator();
        }
        if let Some(id) = remove {
            app.data.prefs.channels.retain(|channel| channel.id != id);
            changed = true;
        }
    });

    card(ui, &theme, "Folders", "Folders group channels in the rail.", |ui| {
        ui.horizontal(|ui| {
            ui.add_sized(
                vec2(240.0, 28.0),
                egui::TextEdit::singleline(&mut app.settings.new_folder).hint_text("Folder name"),
            );
            if ui.button("Add folder").clicked() && !app.settings.new_folder.trim().is_empty() {
                app.data.prefs.folders.push(Folder {
                    id: new_id("folder"),
                    name: app.settings.new_folder.trim().to_string(),
                    collapsed: false,
                    hidden: false,
                });
                app.settings.new_folder.clear();
                changed = true;
            }
        });
        ui.add_space(4.0);
        let mut remove: Option<String> = None;
        for folder in &app.data.prefs.folders {
            ui.horizontal(|ui| {
                ui.label(RichText::new(&folder.name).size(11.5).color(theme.text()));
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if ui.button("Delete").clicked() {
                        remove = Some(folder.id.clone());
                    }
                });
            });
        }
        if let Some(id) = remove {
            app.data.prefs.folders.retain(|folder| folder.id != id);
            for channel in &mut app.data.prefs.channels {
                if channel.folder_id == id {
                    channel.folder_id.clear();
                }
            }
            changed = true;
        }
        ui.add_space(4.0);
        ui.label(RichText::new("Move a channel into a folder").size(10.0).color(theme.text_faint()));
        for channel in &mut app.data.prefs.channels {
            ui.horizontal(|ui| {
                ui.label(RichText::new(&channel.name).size(10.5).color(theme.text_muted()));
                egui::ComboBox::from_id_source(format!("folder-{}", channel.id))
                    .selected_text(
                        app.data
                            .prefs
                            .folders
                            .iter()
                            .find(|folder| folder.id == channel.folder_id)
                            .map(|folder| folder.name.clone())
                            .unwrap_or_else(|| "No folder".into()),
                    )
                    .show_ui(ui, |ui| {
                        if ui.selectable_label(channel.folder_id.is_empty(), "No folder").clicked() {
                            channel.folder_id.clear();
                            changed = true;
                        }
                        for folder in &app.data.prefs.folders {
                            if ui
                                .selectable_label(channel.folder_id == folder.id, &folder.name)
                                .clicked()
                            {
                                channel.folder_id = folder.id.clone();
                                changed = true;
                            }
                        }
                    });
            });
        }
    });

    card(ui, &theme, "Tags", "The catalogue behind channels, chips and search.", |ui| {
        ui.horizontal(|ui| {
            ui.add_sized(
                vec2(220.0, 28.0),
                egui::TextEdit::singleline(&mut app.settings.new_tag).hint_text("Tag name"),
            );
            if ui.button("Add tag").clicked() && !app.settings.new_tag.trim().is_empty() {
                app.data.prefs.ensure_tag(&app.settings.new_tag.clone());
                app.settings.new_tag.clear();
                changed = true;
            }
        });
        ui.add_space(4.0);
        let mut remove: Option<String> = None;
        ui.horizontal_wrapped(|ui| {
            for tag in &app.data.prefs.tags {
                if ui.button(format!("{} ✕", tag.name)).clicked() {
                    remove = Some(tag.id.clone());
                }
            }
        });
        if let Some(id) = remove {
            app.data.prefs.tags.retain(|tag| tag.id != id);
            for channel in &mut app.data.prefs.channels {
                channel.tag_ids.retain(|tag| tag != &id);
            }
            for item in &mut app.data.items {
                item.tags.retain(|tag| tag != &id);
            }
            changed = true;
        }
    });

    if changed {
        app.mark_dirty();
    }
}

fn docks(ui: &mut egui::Ui, app: &mut App) {
    let theme = app.theme;
    let mut changed = false;
    let mut remove_slot: Option<(usize, usize)> = None;

    let docks = app.data.prefs.docks.clone();
    for (index, dock) in docks.iter().enumerate() {
        card(
            ui,
            &theme,
            &format!("Dock {}", index + 1),
            "A floating bar. Drag it anywhere; its slots run on click or on their bare key.",
            |ui| {
                let mut enabled = dock.enabled;
                if toggle(ui, &theme, "Show this dock", "", &mut enabled) {
                    if let Some(target) = app.data.prefs.docks.get_mut(index) {
                        target.enabled = enabled;
                    }
                    changed = true;
                }
                ui.add_space(4.0);
                ui.horizontal(|ui| {
                    ui.label(RichText::new("Position").size(10.5).color(theme.text_muted()));
                    let mut fx = dock.fx;
                    let mut fy = dock.fy;
                    if ui.add(egui::Slider::new(&mut fx, 0.05..=0.95).text("x")).changed()
                        || ui.add(egui::Slider::new(&mut fy, 0.05..=0.95).text("y")).changed()
                    {
                        if let Some(target) = app.data.prefs.docks.get_mut(index) {
                            target.fx = fx;
                            target.fy = fy;
                        }
                        changed = true;
                    }
                });
                ui.add_space(4.0);
                for (slot_index, slot) in dock.slots.iter().enumerate() {
                    ui.horizontal(|ui| {
                        icon_draw(
                            ui.painter(),
                            &slot.icon,
                            Rect::from_center_size(ui.cursor().min + vec2(9.0, 14.0), vec2(13.0, 13.0)),
                            theme.text_muted(),
                            1.4,
                        );
                        ui.add_space(22.0);
                        let mut label = slot.label.clone();
                        if ui
                            .add(egui::TextEdit::singleline(&mut label).desired_width(200.0))
                            .changed()
                        {
                            if let Some(target) = app
                                .data
                                .prefs
                                .docks
                                .get_mut(index)
                                .and_then(|dock| dock.slots.get_mut(slot_index))
                            {
                                target.label = label;
                            }
                            changed = true;
                        }
                        let mut key = slot.key.clone();
                        if ui
                            .add(egui::TextEdit::singleline(&mut key).desired_width(40.0).hint_text("key"))
                            .changed()
                        {
                            if let Some(target) = app
                                .data
                                .prefs
                                .docks
                                .get_mut(index)
                                .and_then(|dock| dock.slots.get_mut(slot_index))
                            {
                                target.key = key;
                            }
                            changed = true;
                        }
                        ui.label(RichText::new(&slot.action).size(9.5).color(theme.text_faint()));
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            if ui.button("Remove").clicked() {
                                remove_slot = Some((index, slot_index));
                            }
                        });
                    });
                }
                ui.add_space(4.0);
                ui.horizontal(|ui| {
                    ui.add_sized(
                        vec2(160.0, 26.0),
                        egui::TextEdit::singleline(&mut app.settings.new_slot_label).hint_text("Slot label"),
                    );
                    ui.add_sized(
                        vec2(46.0, 26.0),
                        egui::TextEdit::singleline(&mut app.settings.new_slot_key).hint_text("key"),
                    );
                    if ui.button("Add slot").clicked() && !app.settings.new_slot_label.trim().is_empty() {
                        if let Some(target) = app.data.prefs.docks.get_mut(index) {
                            target.slots.push(DockSlot {
                                id: new_id("slot"),
                                label: app.settings.new_slot_label.trim().to_string(),
                                key: app.settings.new_slot_key.clone(),
                                icon: "dot".into(),
                                action: "view".into(),
                                value: "animated".into(),
                            });
                        }
                        app.settings.new_slot_label.clear();
                        app.settings.new_slot_key.clear();
                        changed = true;
                    }
                });
            },
        );
    }
    if let Some((dock, slot)) = remove_slot {
        if let Some(target) = app.data.prefs.docks.get_mut(dock) {
            if slot < target.slots.len() {
                target.slots.remove(slot);
            }
        }
        changed = true;
    }
    ui.horizontal(|ui| {
        if ui.button("+ New dock").clicked() {
            app.data.prefs.docks.push(DockState {
                id: new_id("dock"),
                slots: default_dock_slots(),
                enabled: true,
                fx: 0.5,
                fy: 0.8,
            });
            changed = true;
        }
        if ui.button("Reset main dock").clicked() {
            if let Some(dock) = app.data.prefs.docks.first_mut() {
                dock.slots = default_dock_slots();
            }
            changed = true;
        }
    });
    if changed {
        app.mark_dirty();
    }
}

/* ---- Security ------------------------------------------------------------ */

fn security(ui: &mut egui::Ui, app: &mut App) {
    let theme = app.theme;
    let mut changed = false;
    let has_password = app.password.is_some();

    card(
        ui,
        &theme,
        if has_password { "Vault password" } else { "Set a vault password" },
        "Argon2id derives the key; AES-256-GCM seals the file. Without one the vault is plain JSON.",
        |ui| {
            ui.horizontal(|ui| {
                ui.add_sized(
                    vec2(230.0, 28.0),
                    egui::TextEdit::singleline(&mut app.settings.vault_password)
                        .password(true)
                        .hint_text("New password"),
                );
                ui.add_sized(
                    vec2(230.0, 28.0),
                    egui::TextEdit::singleline(&mut app.settings.vault_password_confirm)
                        .password(true)
                        .hint_text("Repeat it"),
                );
                if ui.button(if has_password { "Change" } else { "Set" }).clicked() {
                    if app.settings.vault_password.len() < 6 {
                        app.settings.vault_password_error = "Use at least six characters".into();
                    } else if app.settings.vault_password != app.settings.vault_password_confirm {
                        app.settings.vault_password_error = "The two passwords do not match".into();
                    } else {
                        let password = app.settings.vault_password.clone();
                        app.settings.vault_password.clear();
                        app.settings.vault_password_confirm.clear();
                        app.settings.vault_password_error.clear();
                        app.set_password(Some(password));
                        app.info("Vault password set — the file is ciphertext now");
                    }
                }
                if has_password && ui.button("Remove").clicked() {
                    app.set_password(None);
                    app.info("Vault password removed — the file is readable now");
                }
            });
            if !app.settings.vault_password_error.is_empty() {
                ui.label(RichText::new(&app.settings.vault_password_error).size(10.0).color(theme.danger()));
            }
        },
    );

    card(ui, &theme, "Locking", "", |ui| {
        ui.horizontal(|ui| {
            ui.label(RichText::new("Auto-lock after").size(11.5).color(theme.text()));
            let mut minutes = app.data.prefs.auto_lock_minutes;
            if ui.add(egui::DragValue::new(&mut minutes).speed(1.0).clamp_range(0..=240)).changed() {
                app.data.prefs.auto_lock_minutes = minutes;
                changed = true;
            }
            ui.label(RichText::new("minutes (0 = never)").size(10.0).color(theme.text_faint()));
        });
        changed |= toggle(ui, &theme, "Clear the clipboard on lock", "", &mut app.data.prefs.clear_clipboard_on_lock);
    });

    card(ui, &theme, "Clipboard", "", |ui| {
        ui.horizontal(|ui| {
            ui.label(RichText::new("Clear after").size(11.5).color(theme.text()));
            let mut seconds = app.data.prefs.clear_clipboard_seconds;
            if ui.add(egui::DragValue::new(&mut seconds).speed(5.0).clamp_range(0..=300)).changed() {
                app.data.prefs.clear_clipboard_seconds = seconds;
                changed = true;
            }
            ui.label(RichText::new("seconds (0 = never)").size(10.0).color(theme.text_faint()));
        });
    });

    card(ui, &theme, "Privacy", "", |ui| {
        changed |= toggle(ui, &theme, "Mask email addresses", "Show iv•••••@gmail.com instead of the full address.", &mut app.data.prefs.mask_emails);
        changed |= toggle(ui, &theme, "Reveal passwords by default", "", &mut app.data.prefs.reveal_passwords);
        changed |= toggle(ui, &theme, "Warn about reused passwords", "", &mut app.data.prefs.warn_on_reuse);
        changed |= toggle(ui, &theme, "Confirm before export", "", &mut app.data.prefs.confirm_before_export);
    });

    card(ui, &theme, "Health", "", |ui| {
        ui.horizontal(|ui| {
            ui.label(RichText::new("Stale password after").size(11.5).color(theme.text()));
            let mut days = app.data.prefs.password_age_days;
            if ui.add(egui::DragValue::new(&mut days).speed(5.0).clamp_range(0..=3650)).changed() {
                app.data.prefs.password_age_days = days;
                changed = true;
            }
            ui.label(RichText::new("days").size(10.0).color(theme.text_faint()));
        });
        ui.horizontal(|ui| {
            ui.label(RichText::new("Stale email after").size(11.5).color(theme.text()));
            let mut days = app.data.prefs.email_age_days;
            if ui.add(egui::DragValue::new(&mut days).speed(5.0).clamp_range(0..=3650)).changed() {
                app.data.prefs.email_age_days = days;
                changed = true;
            }
            ui.label(RichText::new("days").size(10.0).color(theme.text_faint()));
        });
    });

    if changed {
        app.mark_dirty();
    }
}

fn generator(ui: &mut egui::Ui, app: &mut App) {
    let theme = app.theme;
    let mut changed = false;
    if app.settings.sample.is_empty() {
        app.settings.sample = crate::editor::generate_password(&app.data.prefs.password_generator);
    }
    card(ui, &theme, "Presets", "One click sets every character option below.", |ui| {
        ui.horizontal_wrapped(|ui| {
            for (name, length, lower, upper, digits, symbols) in [
                ("PIN 4", 4u32, false, false, true, false),
                ("PIN 6", 6, false, false, true, false),
                ("Web login", 20, true, true, true, true),
                ("Long", 32, true, true, true, true),
            ] {
                if ui.button(name).clicked() {
                    let prefs = &mut app.data.prefs.password_generator;
                    prefs.length = length;
                    prefs.lower = lower;
                    prefs.upper = upper;
                    prefs.digits = digits;
                    prefs.symbols = symbols;
                    app.settings.sample = crate::editor::generate_password(&app.data.prefs.password_generator);
                    changed = true;
                    app.info(format!("{name} preset applied"));
                }
            }
        });
    });

    card(ui, &theme, "Live sample", "Generated from exactly these options; nothing is stored.", |ui| {
        ui.horizontal(|ui| {
            ui.label(
                RichText::new(&app.settings.sample)
                    .monospace()
                    .size(13.0)
                    .color(theme.accent_text()),
            );
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if ui.button("Copy").clicked() {
                    app.copy(ui.ctx(), &app.settings.sample.clone(), "Sample");
                }
                if ui.button("New sample").clicked() {
                    app.settings.sample = crate::editor::generate_password(&app.data.prefs.password_generator);
                }
            });
        });
        ui.add_space(6.0);
        let prefs = &mut app.data.prefs.password_generator;
        if ui.add(egui::Slider::new(&mut prefs.length, 4..=64).text("Length")).changed() {
            changed = true;
        }
        if ui.checkbox(&mut prefs.lower, "Lowercase").changed()
            | ui.checkbox(&mut prefs.upper, "Uppercase").changed()
            | ui.checkbox(&mut prefs.digits, "Digits").changed()
            | ui.checkbox(&mut prefs.symbols, "Symbols").changed()
            | ui.checkbox(&mut prefs.avoid_ambiguous, "Avoid look-alikes").changed()
        {
            changed = true;
        }
        if ui.button("Regenerate sample").clicked() {
            app.settings.sample = crate::editor::generate_password(&app.data.prefs.password_generator);
        }
    });
    if changed {
        app.mark_dirty();
    }
}

fn alarms(ui: &mut egui::Ui, app: &mut App) {
    let theme = app.theme;
    let mut changed = false;
    let mut remove: Option<String> = None;

    card(ui, &theme, "New alarm", "A desktop toast at the chosen minute.", |ui| {
        ui.horizontal(|ui| {
            ui.add_sized(
                vec2(220.0, 28.0),
                egui::TextEdit::singleline(&mut app.settings.new_alarm_label).hint_text("Label"),
            );
            ui.add(egui::DragValue::new(&mut app.settings.alarm_hour).clamp_range(0..=23).prefix("h "));
            ui.add(egui::DragValue::new(&mut app.settings.alarm_minute).clamp_range(0..=59).prefix("m "));
            if ui.button("Add").clicked() {
                app.data.prefs.alarms.push(Alarm {
                    id: new_id("alarm"),
                    label: app.settings.new_alarm_label.trim().to_string(),
                    hour: app.settings.alarm_hour,
                    minute: app.settings.alarm_minute,
                    days: vec![1, 2, 3, 4, 5],
                    enabled: true,
                    sound: "chime".into(),
                });
                app.settings.new_alarm_label.clear();
                changed = true;
            }
        });
    });

    card(ui, &theme, "Alarms", "Days are Monday-first in the picker; Sunday is 0.", |ui| {
        if app.data.prefs.alarms.is_empty() {
            ui.label(RichText::new("No alarms yet.").size(10.5).color(theme.text_faint()));
        }
        for alarm in &mut app.data.prefs.alarms {
            ui.horizontal(|ui| {
                let mut enabled = alarm.enabled;
                if ui.checkbox(&mut enabled, "").changed() {
                    alarm.enabled = enabled;
                    changed = true;
                }
                let mut label = alarm.label.clone();
                if ui.add(egui::TextEdit::singleline(&mut label).desired_width(180.0)).changed() {
                    alarm.label = label;
                    changed = true;
                }
                let mut hour = alarm.hour;
                let mut minute = alarm.minute;
                if ui.add(egui::DragValue::new(&mut hour).clamp_range(0..=23).suffix("h")).changed()
                    | ui.add(egui::DragValue::new(&mut minute).clamp_range(0..=59).suffix("m")).changed()
                {
                    alarm.hour = hour;
                    alarm.minute = minute;
                    changed = true;
                }
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if ui.button("Delete").clicked() {
                        remove = Some(alarm.id.clone());
                    }
                    for (day, name) in [(6u32, "S"), (5, "F"), (4, "T"), (3, "W"), (2, "T"), (1, "M"), (0, "S")] {
                        let mut on = alarm.days.contains(&day);
                        if ui.add(egui::Button::new(RichText::new(name).size(9.0)).fill(if on { theme.accent_soft() } else { theme.plate(0.8) })).clicked() {
                            on = !on;
                            if on {
                                alarm.days.push(day);
                            } else {
                                alarm.days.retain(|value| value != &day);
                            }
                            changed = true;
                        }
                    }
                });
            });
            ui.separator();
        }
    });

    card(ui, &theme, "Sound", "", |ui| {
        changed |= toggle(ui, &theme, "Mute alarm sounds", "The toast still appears; the desktop edition plays a chime.", &mut app.data.prefs.sounds_muted);
    });

    if let Some(id) = remove {
        app.data.prefs.alarms.retain(|alarm| alarm.id != id);
    }
    if changed {
        app.mark_dirty();
    }
}

/* ---- Data ---------------------------------------------------------------- */

fn backup(ui: &mut egui::Ui, app: &mut App) {
    let theme = app.theme;
    card(
        ui,
        &theme,
        "Encrypted backup",
        "One file with every login, tag, channel, dock and preference. A password protects the file itself.",
        |ui| {
            ui.horizontal(|ui| {
                ui.add_sized(
                    vec2(240.0, 28.0),
                    egui::TextEdit::singleline(&mut app.settings.backup_password)
                        .password(true)
                        .hint_text("Optional file password"),
                );
                if ui.button("Export backup").clicked() {
                    let password = app.settings.backup_password.clone();
                    let path = crate::io::data_dir().join(format!("colax-backup-{}.colax", now_ms()));
                    let _ = std::fs::create_dir_all(crate::io::data_dir());
                    let written: Result<(), String> = if password.is_empty() {
                        std::fs::write(&path, serde_json::to_string_pretty(&app.data).unwrap_or_default())
                            .map_err(|error| error.to_string())
                    } else {
                        crate::io::seal(&app.data, &password).and_then(|text| {
                            std::fs::write(&path, text).map_err(|error| error.to_string())
                        })
                    };
                    match written {
                        Ok(()) => app.settings.backup_message = format!("Saved to {}", path.display()),
                        Err(error) => app.settings.backup_message = format!("Export failed: {error}"),
                    }
                }
            });
            if !app.settings.backup_message.is_empty() {
                ui.label(
                    RichText::new(&app.settings.backup_message)
                        .size(10.0)
                        .color(theme.text_muted()),
                );
            }
        },
    );

    card(
        ui,
        &theme,
        "Restore from backup",
        "Enter the full path to a .colax file. Restoring replaces the vault in memory; press Save is not needed — it is written at once.",
        |ui| {
            ui.horizontal(|ui| {
                ui.add_sized(
                    vec2(460.0, 28.0),
                    egui::TextEdit::singleline(&mut app.settings.import_path)
                        .hint_text(r"C:\Users\you\colax-backup-123.colax"),
                );
                if ui.button("Restore").clicked() {
                    match std::fs::read_to_string(app.settings.import_path.trim()) {
                        Ok(text) => {
                            let parsed = if text.trim_start().starts_with('{') && text.contains("\"ciphertext\"") {
                                if app.settings.backup_password.is_empty() {
                                    Err("This backup is encrypted — enter its password above".to_string())
                                } else {
                                    crate::io::unlock(&text, &app.settings.backup_password)
                                }
                            } else {
                                serde_json::from_str::<VaultData>(&text).map_err(|error| error.to_string())
                            };
                            match parsed {
                                Ok(data) => {
                                    app.data = data;
                                    app.save_now();
                                    app.settings.backup_message = "Backup restored".into();
                                    app.info("Backup restored");
                                }
                                Err(error) => app.settings.backup_message = error,
                            }
                        }
                        Err(error) => app.settings.backup_message = format!("Could not read that file: {error}"),
                    }
                }
            });
        },
    );
}

fn theme_backup(ui: &mut egui::Ui, app: &mut App) {
    let theme = app.theme;
    card(
        ui,
        &theme,
        "Theme & layout",
        "Appearance, channels, folders, tags and docks, without a single login. Safe to share.",
        |ui| {
            ui.horizontal(|ui| {
                if ui.button("Export theme").clicked() {
                    let mut prefs = app.data.prefs.clone();
                    prefs.docks = Vec::new();
                    let path = crate::io::data_dir().join("colax-theme.json");
                    let _ = std::fs::create_dir_all(crate::io::data_dir());
                    match std::fs::write(&path, serde_json::to_string_pretty(&prefs).unwrap_or_default()) {
                        Ok(()) => app.info(format!("Theme saved to {}", path.display())),
                        Err(error) => app.error(format!("Could not export: {error}")),
                    }
                }
                ui.add_sized(
                    vec2(420.0, 28.0),
                    egui::TextEdit::singleline(&mut app.settings.import_path).hint_text("Path to a theme JSON"),
                );
                if ui.button("Import theme").clicked() {
                    match std::fs::read_to_string(app.settings.import_path.trim()) {
                        Ok(text) => match serde_json::from_str::<Preferences>(&text) {
                            Ok(mut prefs) => {
                                prefs.docks = app.data.prefs.docks.clone();
                                app.data.prefs = prefs;
                                app.mark_dirty();
                                app.info("Theme imported");
                            }
                            Err(error) => app.error(format!("That is not a theme file: {error}")),
                        },
                        Err(error) => app.error(format!("Could not read that file: {error}")),
                    }
                }
            });
            ui.add_space(4.0);
            ui.label(
                RichText::new("Importing replaces channels, folders, tags and the look. Logins are untouched.")
                    .size(10.0)
                    .color(theme.text_muted()),
            );
        },
    );
}

fn data(ui: &mut egui::Ui, app: &mut App) {
    let theme = app.theme;
    card(ui, &theme, "CSV", "Text only — credentials, notes and tags, never images.", |ui| {
        ui.horizontal(|ui| {
            if ui.button("Export CSV").clicked() {
                let path = crate::io::data_dir().join("colax-export.csv");
                let _ = std::fs::create_dir_all(crate::io::data_dir());
                match std::fs::write(&path, crate::io::csv_export(&app.data)) {
                    Ok(()) => app.info(format!("CSV saved to {}", path.display())),
                    Err(error) => app.error(format!("Could not export: {error}")),
                }
            }
            ui.add_sized(
                vec2(420.0, 28.0),
                egui::TextEdit::singleline(&mut app.settings.import_path).hint_text("Path to a CSV file"),
            );
            if ui.button("Import CSV").clicked() {
                match std::fs::read_to_string(app.settings.import_path.trim()) {
                    Ok(text) => {
                        let added = crate::io::csv_import(&text, &mut app.data);
                        app.data.log("Imported CSV", &format!("{added} logins"));
                        app.mark_dirty();
                        app.info(format!("{added} logins imported"));
                    }
                    Err(error) => app.error(format!("Could not read that file: {error}")),
                }
            }
        });
    });

    card(ui, &theme, "What is stored", "", |ui| {
        ui.horizontal(|ui| {
            ui.label(RichText::new(format!("{} logins", app.data.items.len())).size(11.5).color(theme.text()));
            ui.label(
                RichText::new(format!("about {} KB", crate::io::vault_kb(&app.data)))
                    .size(10.5)
                    .color(theme.text_muted()),
            );
        });
        ui.add_space(2.0);
        ui.label(
            RichText::new(crate::io::vault_path().display().to_string())
                .monospace()
                .size(9.5)
                .color(theme.text_faint()),
        );
        if app.password.is_some() {
            ui.label(
                RichText::new(crate::io::locked_path().display().to_string())
                    .monospace()
                    .size(9.5)
                    .color(theme.text_faint()),
            );
        }
    });

    card(ui, &theme, "Delete all data", "Removes every login, tag, channel, alarm, dock and setting from this machine.", |ui| {
        if ui
            .add(
                egui::Button::new(RichText::new("Delete everything").size(11.0).color(Color32::WHITE))
                    .fill(theme.danger()),
            )
            .clicked()
        {
            app.confirm = Some(Confirm::ResetVault);
        }
    });
}

/* ---- Optimize ------------------------------------------------------------ */

fn optimize_general(ui: &mut egui::Ui, app: &mut App) {
    let theme = app.theme;
    card(ui, &theme, "Right now", "Measured on this machine, not estimated.", |ui| {
        let lines = [
            ("Logins", app.data.items.len().to_string()),
            ("Tags", app.data.prefs.tags.len().to_string()),
            ("Channels", app.data.prefs.channels.len().to_string()),
            ("Docks", app.data.prefs.docks.len().to_string()),
            ("Vault size", format!("{} KB", crate::io::vault_kb(&app.data))),
            ("History", format!("{} events", app.data.history.len())),
        ];
        for (label, value) in lines {
            ui.horizontal(|ui| {
                ui.label(RichText::new(label).size(11.0).color(theme.text_muted()));
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.label(RichText::new(value).monospace().size(11.0).color(theme.text()));
                });
            });
        }
    });
    card(ui, &theme, "Profiles", "One-click savings profiles are an Electron feature; the switches themselves live in Resources and Look & feel here.", |ui| {
        ui.horizontal(|ui| {
            if ui.button("Turn animations off").clicked() {
                app.data.prefs.motion = 0.0;
                app.mark_dirty();
                app.info("Animations off");
            }
            if ui.button("Flatten glass").clicked() {
                app.data.prefs.reduce_transparency = true;
                app.data.prefs.ambient = 0.0;
                app.mark_dirty();
                app.info("Glass flattened");
            }
            if ui.button("Remove background image").clicked() {
                app.data.prefs.background_image.clear();
                app.mark_dirty();
                app.info("Background removed");
            }
        });
    });
}

fn resources(ui: &mut egui::Ui, app: &mut App) {
    let theme = app.theme;
    let cached = app.data.items.len();
    let media_bytes: usize = app
        .data
        .items
        .iter()
        .map(|item| item.background_image.len() + item.avatar_image.len())
        .sum();
    let vehicles = [
        (
            "Animations",
            format!("{:.0}%", app.data.prefs.motion * 100.0),
            "Large motion repaints the list on every state change.".to_string(),
            app.data.prefs.motion > 0.0,
            "Turn off",
        ),
        (
            "Frosted glass",
            if app.data.prefs.reduce_transparency { "0".into() } else { "on".into() },
            "Each frosted panel re-blurs its backdrop while you scroll.".to_string(),
            !app.data.prefs.reduce_transparency,
            "Flatten",
        ),
        (
            "Ambient gradient",
            format!("{:.0}%", app.data.prefs.ambient * 100.0),
            "A mesh gradient painted behind every screen.".to_string(),
            app.data.prefs.ambient > 0.0,
            "Turn off",
        ),
        (
            "Background image",
            if app.data.prefs.background_image.is_empty() {
                "None".into()
            } else {
                format!("{} chars", app.data.prefs.background_image.len())
            },
            "Decoded once, then blended under the whole window.".to_string(),
            !app.data.prefs.background_image.is_empty(),
            "Remove",
        ),
        (
            "Card shadows",
            format!("{:.0}%", app.data.prefs.card_depth * 100.0),
            "A shadow per card, restruck whenever the list scrolls.".to_string(),
            app.data.prefs.card_depth > 0.0,
            "Flatten",
        ),
        (
            "Images in logins",
            format!("{} chars", media_bytes),
            "Card art and avatars stored inside encrypted records.".to_string(),
            media_bytes > 0,
            "Reported",
        ),
        (
            "Loaded logins",
            format!("{cached}"),
            "Decrypted in memory while the vault is open.".to_string(),
            cached > 500,
            "Reported",
        ),
        (
            "History log",
            format!("{} events", app.data.history.len()),
            "Past edits kept for the activity list; capped at 200.".to_string(),
            app.data.history.len() > 120,
            "Reported",
        ),
    ];

    ui.label(
        RichText::new("Feature costs")
            .size(12.5)
            .strong()
            .color(theme.text()),
    );
    ui.label(
        RichText::new("Every number is counted from the vault or the running window. Heavy items are listed first.")
            .size(10.0)
            .color(theme.text_muted()),
    );
    ui.add_space(6.0);

    for (label, reading, detail, heavy, action) in vehicles {
        egui::Frame::none()
            .fill(theme.card())
            .rounding(theme.radius(12.0))
            .stroke(Stroke::new(1.0_f32, if heavy { theme.danger().gamma_multiply(0.4) } else { theme.hairline() }))
            .inner_margin(egui::Margin::same(12.0))
            .show(ui, |ui| {
                ui.set_width(ui.available_width());
                ui.horizontal(|ui| {
                    ui.vertical(|ui| {
                        ui.label(RichText::new(label).size(12.0).strong().color(theme.text()));
                        ui.label(RichText::new(detail).size(9.5).color(theme.text_muted()));
                    });
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if heavy && action != "Reported" && ui.button(action).clicked() {
                            match label {
                                "Animations" => app.data.prefs.motion = 0.0,
                                "Frosted glass" => app.data.prefs.reduce_transparency = true,
                                "Ambient gradient" => app.data.prefs.ambient = 0.0,
                                "Background image" => app.data.prefs.background_image.clear(),
                                "Card shadows" => app.data.prefs.card_depth = 0.0,
                                _ => {}
                            }
                            app.mark_dirty();
                            app.info(format!("{label} turned down"));
                        }
                        ui.label(
                            RichText::new(reading)
                                .monospace()
                                .size(12.0)
                                .color(if heavy { theme.warn() } else { theme.text_muted() }),
                        );
                        ui.label(
                            RichText::new(if heavy { "Heavy" } else { "Light" })
                                .size(9.0)
                                .color(if heavy { theme.danger() } else { theme.text_faint() }),
                        );
                    });
                });
            });
        ui.add_space(6.0);
    }
}

fn optimize_look(ui: &mut egui::Ui, app: &mut App) {
    let theme = app.theme;
    let mut changed = false;
    let prefs = &mut app.data.prefs;
    card(ui, &theme, "Look & feel", "The switches that cost the most frames.", |ui| {
        changed |= toggle(ui, &theme, "Frosted glass", "Off is flatter and faster.", &mut prefs.reduce_transparency);
        changed |= toggle(ui, &theme, "High contrast", "", &mut prefs.high_contrast);
        changed |= slider(ui, &theme, "Ambient", &mut prefs.ambient, 0.0..=1.0, "%");
        changed |= slider(ui, &theme, "Card depth", &mut prefs.card_depth, 0.0..=1.0, "%");
    });
    if changed {
        app.mark_dirty();
    }
}

fn optimize_speed(ui: &mut egui::Ui, app: &mut App) {
    let theme = app.theme;
    let mut changed = false;
    card(ui, &theme, "Speed", "", |ui| {
        changed |= toggle(ui, &theme, "Disable spellchecker", "The native build has no Hunspell dictionaries loaded, so this is already free.", &mut app.data.prefs.disable_spellcheck);
        let mut motion_off = app.data.prefs.motion <= 0.0;
        if toggle(ui, &theme, "Turn all animation off", "", &mut motion_off) {
            app.data.prefs.motion = if motion_off { 0.0 } else { 1.0 };
            changed = true;
        }
    });
    card(ui, &theme, "Window", "", |ui| {
        changed |= toggle(ui, &theme, "High contrast", "", &mut app.data.prefs.high_contrast);
        changed |= toggle(ui, &theme, "Hide dividers", "", &mut app.data.prefs.hide_dividers);
    });
    if changed {
        app.mark_dirty();
    }
}

fn optimize_messages(ui: &mut egui::Ui, app: &mut App) {
    let theme = app.theme;
    card(
        ui,
        &theme,
        "Mail loading",
        "IMAP, inline images, the message cache and temporary Mohmal inboxes belong to the Electron edition. The native port stores no mail, so there is nothing here to tune yet.",
        |ui| {
            ui.label(
                RichText::new("Nothing cached · no polling · no network access from the vault")
                    .size(10.5)
                    .color(theme.text_faint()),
            );
        },
    );
    let _ = app;
}

/* ---- The rest ------------------------------------------------------------ */

fn sharing(ui: &mut egui::Ui, app: &mut App) {
    let theme = app.theme;
    card(
        ui,
        &theme,
        "Sharing",
        "The share server, live codes, device approval and linked copies are Electron features; porting them means porting the tunnel and the approval flow, which is a later step.",
        |ui| {
            ui.label(
                RichText::new("Until then, an encrypted backup moved by hand is the way to another device.")
                    .size(10.5)
                    .color(theme.text_muted()),
            );
        },
    );
    let _ = app;
}

fn desktop(ui: &mut egui::Ui, app: &mut App) {
    let theme = app.theme;
    let mut changed = false;
    card(ui, &theme, "Desktop", "Stored with the vault so a backup carries them; the native window honours close-to-tray only when a tray is added.", |ui| {
        changed |= toggle(ui, &theme, "System tray", "", &mut app.data.prefs.tray_enabled);
        changed |= toggle(ui, &theme, "Minimise to tray on close", "", &mut app.data.prefs.close_to_tray);
        changed |= toggle(ui, &theme, "Launch at sign-in", "", &mut app.data.prefs.launch_at_login);
        changed |= toggle(ui, &theme, "Mute sounds", "", &mut app.data.prefs.sounds_muted);
    });
    if changed {
        app.mark_dirty();
    }
}

fn about(ui: &mut egui::Ui, app: &mut App) {
    let theme = app.theme;
    card(ui, &theme, "Colax, native edition", "A Rust port of the Electron app: same vault model, same tokens, same interactions.", |ui| {
        ui.label(RichText::new("Version 0.1.0 · egui + eframe").size(10.5).color(theme.text_muted()));
        ui.add_space(4.0);
        ui.label(
            RichText::new(format!("Vault: {}", crate::io::vault_path().display()))
                .monospace()
                .size(9.5)
                .color(theme.text_faint()),
        );
        ui.label(
            RichText::new(if app.password.is_some() {
                "Encrypted with Argon2id + AES-256-GCM"
            } else {
                "Plain JSON — set a vault password in Security"
            })
            .size(10.0)
            .color(theme.text_faint()),
        );
    });

    card(ui, &theme, "Samples", "Eight demo logins, tagged and ready to look at.", |ui| {
        if ui.button("Load sample logins").clicked() {
            let mut seeded = sample_items();
            for item in &mut seeded {
                let tags: Vec<String> = item.tags.clone();
                item.tags = tags.iter().map(|name| app.data.prefs.ensure_tag(name)).collect();
            }
            app.data.items.extend(seeded);
            app.data.log("Loaded samples", "eight demo logins");
            app.mark_dirty();
            app.info("Sample logins added");
        }
    });

    card(ui, &theme, "Diagnostics", "", |ui| {
        ui.horizontal(|ui| {
            if ui.button("Copy a report").clicked() {
                let report = format!(
                    "Colax native 0.1.0\nlogins: {}\ntags: {}\nchannels: {}\ndocks: {}\nvault: {}\nencrypted: {}",
                    app.data.items.len(),
                    app.data.prefs.tags.len(),
                    app.data.prefs.channels.len(),
                    app.data.prefs.docks.len(),
                    crate::io::vault_path().display(),
                    app.password.is_some()
                );
                app.copy(ui.ctx(), &report, "Diagnostics");
            }
            if ui.button("Reset preferences").clicked() {
                let docks = app.data.prefs.docks.clone();
                app.data.prefs = Preferences::default();
                app.data.prefs.docks = docks;
                app.mark_dirty();
                app.info("Preferences reset");
            }
        });
    });
    let _ = theme;
}
