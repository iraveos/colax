//! The login list: flow cards, list rows and the dashboard.
//!
//! Card anatomy follows the Electron card exactly — a hue-tinted avatar, the
//! title, the username or host, tag chips, an optional note line, and a row of
//! copy/open/edit actions. Click copies the password, double-click edits,
//! right-click opens the same menu the roadmap rows use.

use eframe::egui;
use egui::{pos2, vec2, Align2, Color32, Rect, RichText, Sense, Stroke};

use crate::app::{paint_gradient, App, Confirm, Scope};
use crate::icon::draw as icon_draw;
use crate::model::*;
use crate::theme::{hsl, Theme};

pub fn login_list(ui: &mut egui::Ui, app: &mut App, items: &[VaultItem]) {
    if items.is_empty() {
        empty_state(ui, app);
        return;
    }
    let reused = app.data.reused_passwords();
    match app.data.prefs.view {
        VaultView::List => {
            for item in items {
                list_row(ui, app, item, reused.contains(&item.password));
                ui.add_space(app.theme.space(0.35));
            }
        }
        VaultView::Grid | VaultView::Animated => {
            let card_width = 296.0;
            ui.horizontal_wrapped(|ui| {
                ui.spacing_mut().item_spacing = vec2(app.theme.space(0.8), app.theme.space(0.8));
                for item in items {
                    card(ui, app, item, reused.contains(&item.password), card_width);
                }
            });
        }
    }
}

fn empty_state(ui: &mut egui::Ui, app: &mut App) {
    ui.add_space(app.theme.space(3.0));
    ui.vertical_centered(|ui| {
        let (rect, _) = ui.allocate_exact_size(vec2(64.0, 64.0), Sense::hover());
        ui.painter().rect_filled(rect, app.theme.radius(20.0), app.theme.plate(1.2));
        icon_draw(
            ui.painter(),
            "key",
            Rect::from_center_size(rect.center(), vec2(26.0, 26.0)),
            app.theme.text_faint(),
            1.6,
        );
        ui.add_space(app.theme.space(1.0));
        let (title, body) = if !app.query.is_empty() {
            ("Nothing matches that search", "Try fewer words, or clear the tag filters above.")
        } else if app.scope == Scope::All {
            ("Your vault is empty", "Add a login, paste a CSV, or load the sample set from Settings › About.")
        } else {
            ("Nothing here yet", "Logins appear once they carry the tag this view collects.")
        };
        ui.label(RichText::new(title).size(18.0).strong().color(app.theme.text()));
        ui.label(RichText::new(body).size(11.5).color(app.theme.text_muted()));
        ui.add_space(app.theme.space(1.0));
        if app.scope == Scope::All && app.query.is_empty() {
            ui.horizontal(|ui| {
                ui.add_space((ui.available_width() - 260.0) / 2.0);
                if app.primary_button(ui, "New login", Some("plus")).clicked() {
                    app.new_login();
                }
                if app.text_button(ui, "Load sample logins").clicked() {
                    let mut seeded = sample_items();
                    for item in &mut seeded {
                        let names: Vec<String> = item.tags.clone();
                        item.tags = names.iter().map(|name| app.data.prefs.ensure_tag(name)).collect();
                    }
                    app.data.items.extend(seeded);
                    app.data.log("Loaded samples", "eight demo logins");
                    app.mark_dirty();
                    app.info("Sample logins added");
                }
            });
        }
    });
}

fn card(ui: &mut egui::Ui, app: &mut App, item: &VaultItem, reused: bool, width: f32) {
    let theme = app.theme;
    let hue = item.hue();
    let weak = app.data.sender_is_weak(item);
    let attention = item.needs_attention || reused || weak;

    let frame = egui::Frame::none()
        .fill(theme.card())
        .rounding(theme.radius(16.0))
        .stroke(Stroke::new(1.0_f32, theme.hairline()))
        .inner_margin(egui::Margin::same(14.0));

    let inner = frame.show(ui, |ui| {
        ui.set_width(width - 28.0);
        ui.vertical(|ui| {
            ui.horizontal(|ui| {
                let (rect, _) = ui.allocate_exact_size(vec2(38.0, 38.0), Sense::hover());
                let from = hsl(hue, if theme.dark { 46.0 } else { 50.0 }, if theme.dark { 58.0 } else { 62.0 });
                let to = hsl(hue + 24.0, 40.0, if theme.dark { 46.0 } else { 48.0 });
                paint_gradient(ui.painter(), rect, from, to, 12.0);
                ui.painter().text(
                    rect.center(),
                    Align2::CENTER_CENTER,
                    item.initials(),
                    egui::FontId::proportional(13.0),
                    Color32::WHITE,
                );
                ui.add_space(4.0);
                ui.vertical(|ui| {
                    ui.add_sized(
                        vec2(width - 130.0, 18.0),
                        egui::Label::new(
                            RichText::new(item.display_title())
                                .size(13.5 * theme.text_scale)
                                .strong()
                                .color(theme.text()),
                        )
                        .truncate(),
                    );
                    ui.add_sized(
                        vec2(width - 130.0, 15.0),
                        egui::Label::new(
                            RichText::new(if app.data.prefs.show_urls && !item.host().is_empty() {
                                item.host()
                            } else {
                                item.username.clone()
                            })
                            .size(10.5 * theme.text_scale)
                            .color(theme.text_muted()),
                        )
                        .truncate(),
                    );
                });
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Min), |ui| {
                    let star = if item.favorite { "★" } else { "☆" };
                    let response = ui.add(
                        egui::Button::new(RichText::new(star).size(15.0).color(if item.favorite {
                            theme.warn()
                        } else {
                            theme.text_faint()
                        }))
                        .frame(false),
                    );
                    if response.clicked() {
                        if let Some(existing) = app.data.item_mut(&item.id) {
                            existing.favorite = !existing.favorite;
                        }
                        app.mark_dirty();
                    }
                });
            });

            if !item.tags.is_empty() && app.data.prefs.show_tag_chips {
                ui.add_space(8.0);
                ui.horizontal_wrapped(|ui| {
                    ui.spacing_mut().item_spacing = vec2(4.0, 4.0);
                    for id in item.tags.iter().take(4) {
                        let name = app.data.prefs.tag_name(id);
                        chip(ui, &theme, &name, theme.accent_text(), theme.accent_soft());
                    }
                });
            }

            if app.data.prefs.show_notes && !item.notes.is_empty() {
                ui.add_space(8.0);
                ui.add_sized(
                    vec2(width - 28.0, 32.0),
                    egui::Label::new(
                        RichText::new(item.notes.lines().next().unwrap_or(""))
                            .size(10.5 * theme.text_scale)
                            .color(theme.text_faint()),
                    )
                    .truncate(),
                );
            }

            if attention && app.data.prefs.show_health_badges {
                ui.add_space(8.0);
                ui.horizontal(|ui| {
                    if reused {
                        chip(ui, &theme, "Reused password", theme.warn(), theme.warn_soft());
                    } else if weak {
                        chip(ui, &theme, "Weak", theme.danger(), theme.danger_soft());
                    }
                    if item.needs_attention {
                        chip(ui, &theme, "Needs attention", theme.warn(), theme.warn_soft());
                    }
                });
            }

            ui.add_space(10.0);
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 4.0;
                if icon_action(ui, &theme, "copy", "Copy the password").clicked() {
                    app.copy(ui.ctx(), &item.password, "Password");
                }
                if icon_action(ui, &theme, "user", "Copy the username").clicked() {
                    app.copy(ui.ctx(), &item.username, "Username");
                }
                if !item.url.is_empty() && icon_action(ui, &theme, "external", "Open the site").clicked() {
                    ui.ctx().open_url(egui::OpenUrl::new_tab(item.url.clone()));
                }
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if app.text_button(ui, "Edit").clicked() {
                        app.edit_login(&item.id);
                    }
                    let when = relative_time(item.updated_at);
                    if !when.is_empty() {
                        ui.label(RichText::new(when).size(9.5).color(theme.text_faint()));
                    }
                });
            });
        });
    });

    let body = inner.response.interact(Sense::click());
    if body.clicked() && app.data.prefs.click_to_copy && !body.secondary_clicked() {
        app.copy(ui.ctx(), &item.password, "Password");
    }
    if body.double_clicked() {
        app.edit_login(&item.id);
    }
    card_menu(&body, app, item);
    if body.hovered() {
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
}

fn list_row(ui: &mut egui::Ui, app: &mut App, item: &VaultItem, reused: bool) {
    let theme = app.theme;
    let hue = item.hue();
    let weak = app.data.sender_is_weak(item);
    let frame = egui::Frame::none()
        .fill(theme.card())
        .rounding(theme.radius(12.0))
        .stroke(Stroke::new(1.0_f32, theme.hairline()))
        .inner_margin(egui::Margin::symmetric(12.0, 8.0));
    let inner = frame.show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.horizontal(|ui| {
            let (rect, _) = ui.allocate_exact_size(vec2(30.0, 30.0), Sense::hover());
            let from = hsl(hue, 46.0, if theme.dark { 58.0 } else { 62.0 });
            paint_gradient(ui.painter(), rect, from, theme.accent_second(), 9.0);
            ui.painter().text(
                rect.center(),
                Align2::CENTER_CENTER,
                item.initials(),
                egui::FontId::proportional(11.0),
                Color32::WHITE,
            );
            ui.add_space(6.0);
            ui.vertical(|ui| {
                ui.label(RichText::new(item.display_title()).size(12.5).strong().color(theme.text()));
                let subtitle = if app.data.prefs.show_urls && !item.host().is_empty() {
                    format!("{} · {}", item.username, item.host())
                } else {
                    item.username.clone()
                };
                ui.label(RichText::new(subtitle).size(10.0).color(theme.text_muted()));
            });
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if icon_action(ui, &theme, "external", "Open the site").clicked() {
                    ui.ctx().open_url(egui::OpenUrl::new_tab(item.url.clone()));
                }
                if icon_action(ui, &theme, "copy", "Copy the password").clicked() {
                    app.copy(ui.ctx(), &item.password, "Password");
                }
                if icon_action(ui, &theme, "key", "Edit this login").clicked() {
                    app.edit_login(&item.id);
                }
                if item.favorite {
                    ui.label(RichText::new("★").size(13.0).color(theme.warn()));
                }
                if reused {
                    chip(ui, &theme, "Reused", theme.warn(), theme.warn_soft());
                } else if weak {
                    chip(ui, &theme, "Weak", theme.danger(), theme.danger_soft());
                }
                if app.data.prefs.show_tag_chips {
                    for id in item.tags.iter().take(2) {
                        let name = app.data.prefs.tag_name(id);
                        chip(ui, &theme, &name, theme.text_muted(), theme.plate(1.0));
                    }
                }
            });
        });
    });
    let body = inner.response.interact(Sense::click());
    if body.clicked() && app.data.prefs.click_to_copy {
        app.copy(ui.ctx(), &item.password, "Password");
    }
    if body.double_clicked() {
        app.edit_login(&item.id);
    }
    card_menu(&body, app, item);
}

fn card_menu(response: &egui::Response, app: &mut App, item: &VaultItem) {
    let mut action: Option<MenuAction> = None;
    response.context_menu(|ui| {
        ui.set_min_width(210.0);
        let address = if item.username.trim().is_empty() { item.title.clone() } else { item.username.clone() };
        if menu_item(ui, app, "Email details / edit", "key", true) {
            action = Some(MenuAction::Edit);
        }
        ui.separator();
        if menu_item(ui, app, "Copy email", "copy", !address.is_empty()) {
            action = Some(MenuAction::Copy(address.clone(), "Email".into()));
        }
        if menu_item(ui, app, "Copy password", "copy", !item.password.is_empty()) {
            action = Some(MenuAction::Copy(item.password.clone(), "Password".into()));
        }
        if menu_item(ui, app, "Copy email + password", "copy", !item.password.is_empty()) {
            action = Some(MenuAction::Copy(format!("{address}\n{}", item.password), "Email and password".into()));
        }
        if menu_item(ui, app, "Copy login details", "copy", true) {
            action = Some(MenuAction::Copy(login_compact(item), "Login details".into()));
        }
        ui.separator();
        if menu_item(ui, app, "Open website", "external", !item.url.is_empty()) {
            action = Some(MenuAction::OpenSite);
        }
        if menu_item(ui, app, "Open / edit", "key", true) {
            action = Some(MenuAction::Edit);
        }
        if menu_item(ui, app, if item.favorite { "Remove favorite" } else { "Add to favorites" }, "star", true) {
            action = Some(MenuAction::Favorite);
        }
        if menu_item(ui, app, "Needs attention", "alert", true) {
            action = Some(MenuAction::Attention);
        }
        ui.separator();
        if menu_item(ui, app, "Delete", "trash", true) {
            action = Some(MenuAction::Delete);
        }
    });
    if let Some(action) = action {
        match action {
            MenuAction::Copy(text, what) => app.copy(ui_context(response), &text, &what),
            MenuAction::OpenSite => {
                let ctx = ui_context(response);
                ctx.open_url(egui::OpenUrl::new_tab(item.url.clone()));
            }
            MenuAction::Edit => app.edit_login(&item.id),
            MenuAction::Favorite => {
                if let Some(existing) = app.data.item_mut(&item.id) {
                    existing.favorite = !existing.favorite;
                }
                app.mark_dirty();
            }
            MenuAction::Attention => {
                if let Some(existing) = app.data.item_mut(&item.id) {
                    existing.needs_attention = !existing.needs_attention;
                }
                app.mark_dirty();
            }
            MenuAction::Delete => app.confirm = Some(Confirm::DeleteItem(item.id.clone())),
        }
    }
}

enum MenuAction {
    Copy(String, String),
    OpenSite,
    Edit,
    Favorite,
    Attention,
    Delete,
}

/// Menu rows are custom so their icons and hover fill match the rest of the app.
fn menu_item(ui: &mut egui::Ui, app: &mut App, label: &str, icon: &str, enabled: bool) -> bool {
    let theme = app.theme;
    let (rect, response) = ui.allocate_exact_size(vec2(ui.available_width().max(190.0), 26.0), Sense::click());
    if !enabled {
        let color = theme.text_faint();
        icon_draw(
            ui.painter(),
            icon,
            Rect::from_center_size(pos2(rect.left() + 16.0, rect.center().y), vec2(12.0, 12.0)),
            color,
            1.4,
        );
        ui.painter().text(
            pos2(rect.left() + 32.0, rect.center().y),
            Align2::LEFT_CENTER,
            label,
            egui::FontId::proportional(11.5),
            color,
        );
        return false;
    }
    if response.hovered() {
        ui.painter().rect_filled(rect, theme.radius(6.0), theme.accent_soft());
    }
    icon_draw(
        ui.painter(),
        icon,
        Rect::from_center_size(pos2(rect.left() + 16.0, rect.center().y), vec2(12.0, 12.0)),
        theme.text_muted(),
        1.4,
    );
    ui.painter().text(
        pos2(rect.left() + 32.0, rect.center().y),
        Align2::LEFT_CENTER,
        label,
        egui::FontId::proportional(11.5),
        theme.text(),
    );
    response.clicked()
}

fn ui_context(response: &egui::Response) -> &egui::Context {
    &response.ctx
}

fn login_compact(item: &VaultItem) -> String {
    format!(
        "{}\n{}\n{}\n{}",
        item.display_title(),
        item.username,
        item.password,
        item.url
    )
}

fn chip(ui: &mut egui::Ui, theme: &Theme, label: &str, text: Color32, fill: Color32) {
    let galley = ui.fonts(|fonts| {
        fonts.layout_no_wrap(label.to_string(), egui::FontId::proportional(9.5 * theme.text_scale), text)
    });
    let size = galley.size() + vec2(12.0, 5.0);
    let (rect, _) = ui.allocate_exact_size(size, Sense::hover());
    ui.painter().rect_filled(rect, egui::Rounding::same(999.0), fill);
    ui.painter().text(
        rect.center(),
        Align2::CENTER_CENTER,
        label,
        egui::FontId::proportional(9.5 * theme.text_scale),
        text,
    );
}

fn icon_action(ui: &mut egui::Ui, theme: &Theme, icon: &str, tooltip: &str) -> egui::Response {
    let (rect, response) = ui.allocate_exact_size(vec2(24.0, 24.0), Sense::click());
    let bg = if response.hovered() { theme.plate(1.4) } else { Color32::TRANSPARENT };
    ui.painter().rect_filled(rect, theme.radius(7.0), bg);
    icon_draw(
        ui.painter(),
        icon,
        Rect::from_center_size(rect.center(), vec2(13.0, 13.0)),
        if response.hovered() { theme.text() } else { theme.text_faint() },
        1.4,
    );
    response.on_hover_text(tooltip)
}

/* ---- Dashboard ----------------------------------------------------------- */

pub fn dashboard(ui: &mut egui::Ui, app: &mut App) {
    let theme = app.theme;
    let total = app.data.items.len();
    let favorites = app.data.items.iter().filter(|item| item.favorite).count();
    let reused = app.data.reused_passwords();
    let weak = app.data.items.iter().filter(|item| app.data.sender_is_weak(item)).count();
    let protected = app.data.items.iter().filter(|item| !item.password.is_empty()).count();
    let tags = app.data.prefs.tags.len();
    let channels = app.data.prefs.channels.len();
    let addresses: std::collections::BTreeSet<String> = app
        .data
        .items
        .iter()
        .filter(|item| item.username.contains('@'))
        .map(|item| item.username.to_lowercase())
        .collect();

    ui.horizontal_wrapped(|ui| {
        ui.spacing_mut().item_spacing = vec2(theme.space(0.6), theme.space(0.6));
        let cards: Vec<(&str, String, String, Color32)> = vec![
            ("Logins", total.to_string(), "in the vault".to_string(), theme.accent()),
            ("Favorites", favorites.to_string(), "pinned".to_string(), theme.warn()),
            ("Reused", reused.len().to_string(), "passwords".to_string(), theme.danger()),
            ("Weak", weak.to_string(), "passwords".to_string(), theme.danger()),
            ("With password", protected.to_string(), "saved secrets".to_string(), theme.accent_second()),
            ("Addresses", addresses.len().to_string(), "in the roadmap".to_string(), theme.accent()),
            ("Channels", channels.to_string(), format!("{tags} tags"), theme.text_muted()),
        ];
        for (label, value, hint, tone) in cards {
            stat_card(ui, &theme, label, &value, &hint, tone);
        }
    });

    ui.add_space(theme.space(1.0));
    ui.horizontal(|ui| {
        ui.label(RichText::new("Recent activity").size(15.0).strong().color(theme.text()));
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            if app.text_button(ui, "Open roadmap").clicked() {
                app.scope = Scope::Roadmap;
            }
        });
    });
    ui.add_space(theme.space(0.3));
    if app.data.history.is_empty() {
        ui.label(RichText::new("No activity yet.").size(11.0).color(theme.text_faint()));
    } else {
        let rows: Vec<_> = app.data.history.iter().take(8).cloned().collect();
        for entry in rows {
            egui::Frame::none()
                .fill(theme.card())
                .rounding(theme.radius(10.0))
                .stroke(Stroke::new(1.0_f32, theme.hairline()))
                .inner_margin(egui::Margin::symmetric(12.0, 8.0))
                .show(ui, |ui| {
                    ui.horizontal(|ui| {
                        ui.label(RichText::new(entry.action).size(11.5).strong().color(theme.text()));
                        ui.label(RichText::new(entry.detail).size(10.5).color(theme.text_muted()));
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            ui.label(RichText::new(relative_time(entry.at)).size(9.5).color(theme.text_faint()));
                        });
                    });
                });
            ui.add_space(4.0);
        }
    }

    ui.add_space(theme.space(1.2));
    ui.label(RichText::new("Addresses").size(15.0).strong().color(theme.text()));
    ui.add_space(theme.space(0.3));
    let mut counts: Vec<(String, usize)> = Vec::new();
    for address in &addresses {
        let count = app
            .data
            .items
            .iter()
            .filter(|item| item.username.eq_ignore_ascii_case(address))
            .count();
        counts.push((address.clone(), count));
    }
    counts.sort_by(|left, right| right.1.cmp(&left.1));
    if counts.is_empty() {
        ui.label(
            RichText::new("No login carries an email address yet.")
                .size(11.0)
                .color(theme.text_faint()),
        );
    }
    ui.horizontal_wrapped(|ui| {
        for (address, count) in counts.iter().take(10) {
            let response = app.chip_button(ui, &format!("{} · {count}", app.mask_email(address)), false);
            if response.clicked() {
                app.roadmap.selected = Some(address.clone());
            }
        }
    });

    ui.add_space(theme.space(1.2));
    egui::Frame::none()
        .fill(theme.plate(0.7))
        .rounding(theme.radius(14.0))
        .stroke(Stroke::new(1.0_f32, theme.hairline()))
        .inner_margin(egui::Margin::same(14.0))
        .show(ui, |ui| {
            ui.horizontal(|ui| {
                icon_draw(
                    ui.painter(),
                    "shield",
                    Rect::from_center_size(ui.cursor().min + vec2(9.0, 8.0), vec2(16.0, 16.0)),
                    theme.accent(),
                    1.6,
                );
                ui.add_space(22.0);
                ui.vertical(|ui| {
                    let headline = if app.password.is_some() {
                        "This vault is encrypted at rest"
                    } else {
                        "This vault is not password protected"
                    };
                    ui.label(RichText::new(headline).size(12.5).strong().color(theme.text()));
                    ui.label(
                        RichText::new(if app.password.is_some() {
                            "Argon2id + AES-256-GCM, stored in %APPDATA%\\Colax Native."
                        } else {
                            "Add a password in Settings › Security so the file on disk is ciphertext."
                        })
                        .size(10.5)
                        .color(theme.text_muted()),
                    );
                });
            });
        });
}

fn stat_card(ui: &mut egui::Ui, theme: &Theme, label: &str, value: &str, hint: &str, tone: Color32) {
    egui::Frame::none()
        .fill(theme.card())
        .rounding(theme.radius(14.0))
        .stroke(Stroke::new(1.0_f32, theme.hairline()))
        .inner_margin(egui::Margin::same(12.0))
        .show(ui, |ui| {
            ui.set_width(148.0);
            ui.vertical(|ui| {
                ui.label(RichText::new(label.to_uppercase()).size(9.5).strong().color(theme.text_faint()));
                ui.label(RichText::new(value).size(26.0).strong().color(tone));
                ui.label(RichText::new(hint).size(9.5).color(theme.text_muted()));
            });
        });
}
