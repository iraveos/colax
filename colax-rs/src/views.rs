//! The login list: flow cards, list rows and the dashboard.
//!
//! Card anatomy follows the Electron card exactly — a hue-tinted avatar, the
//! title, the username or host, tag chips, an optional note line, and a row of
//! copy/open/edit actions. Click copies the password, double-click edits,
//! right-click opens the same menu the roadmap rows use.

use eframe::egui;
use egui::{pos2, vec2, Align2, Color32, Rect, RichText, Sense, Stroke};

use crate::app::{paint_gradient, App, Scope};
use crate::icon::draw as icon_draw;
use crate::model::*;
use crate::theme::{hsl, Theme};
use crate::totp;

pub fn login_list(ui: &mut egui::Ui, app: &mut App, items: &[VaultItem]) {
    if items.is_empty() {
        empty_state(ui, app);
        return;
    }
    let reused = app.data.reused_passwords();
    // Whether the whole list needs the notes and health lines. Reserving a slot
    // per list rather than per card keeps rows even and still lets a vault with
    // no notes drop the line from every card instead of paying for empty space
    // on all six. Electron's cards only carry the rows they use.
    let notes_slot = app.data.prefs.show_notes
        && items.iter().any(|item| !item.notes.trim().is_empty());
    match app.data.prefs.view {
        VaultView::List => {
            for item in items {
                list_row(ui, app, item, reused.contains(&item.password));
                ui.add_space(app.theme.space(0.35));
            }
        }
        VaultView::Animated => {
            // Flow: one column of full-width cards. Rendering Flow and Grid as
            // the same tiled grid is why switching views looked like it did
            // nothing.
            for item in items {
                card(
                    ui,
                    app,
                    item,
                    reused.contains(&item.password),
                    ui.available_width(),
                    notes_slot,
                );
                ui.add_space(app.theme.space(0.6));
            }
        }
        VaultView::Grid => {
            // A hand-rolled wrapped grid. `horizontal_wrapped` let a fixed-width
            // card run past the right edge instead of starting a second row, so
            // the last card of a row was clipped by the window.
            let spacing = app.theme.space(0.8);
            let card_width = 288.0;
            let available = ui.available_width();
            let columns = (((available + spacing) / (card_width + spacing)).floor() as usize).max(1);
            for row in items.chunks(columns) {
                ui.horizontal_top(|ui| {
                    ui.spacing_mut().item_spacing = vec2(spacing, spacing);
                    for item in row {
                        card(
                            ui,
                            app,
                            item,
                            reused.contains(&item.password),
                            card_width,
                            notes_slot,
                        );
                    }
                });
                ui.add_space(spacing);
            }
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

fn card(
    ui: &mut egui::Ui,
    app: &mut App,
    item: &VaultItem,
    reused: bool,
    width: f32,
    notes_slot: bool,
) {
    let theme = app.theme;
    let hue = item.hue();
    let weak = app.data.sender_is_weak(item);
    let attention = item.needs_attention || reused || weak;

    // A frosted card: 5% white over the ambient gradient, a strong hairline and
    // the depth-scaled lift, exactly the stack `.item` describes in app.css.
    let frame = egui::Frame::none()
        .fill(theme.glass(false))
        .rounding(theme.radius(18.0))
        .stroke(Stroke::new(1.0_f32, theme.border_strong()))
        .shadow(theme.card_shadow())
        .inner_margin(egui::Margin::same(12.0));

    let inner = frame.show(ui, |ui| {
        ui.set_width(width - 24.0);
        ui.vertical(|ui| {
            ui.horizontal(|ui| {
                let (rect, _) = ui.allocate_exact_size(vec2(34.0, 34.0), Sense::hover());
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
                // `add_sized` centres its widget, which is why the title and host
                // sat in the middle of every card. A left-to-right slot keeps
                // them against the avatar where they belong.
                let text_width = (width - 122.0).max(90.0);
                ui.allocate_ui_with_layout(
                    vec2(text_width, 30.0),
                    egui::Layout::top_down(egui::Align::Min),
                    |ui| {
                        ui.add(
                            egui::Label::new(
                                RichText::new(item.display_title())
                                    .size(13.5 * theme.text_scale)
                                    .strong()
                                    .color(theme.text()),
                            )
                            .truncate(),
                        );
                        ui.add(
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
                    },
                );
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

            // Every optional row gets a fixed-height slot, empty or not, so a
            // card with notes or a badge does not push its own action row below
            // its neighbour's. That is what made the grid look ragged.
            ui.add_space(6.0);
            ui.allocate_ui_with_layout(
                vec2(width - 24.0, 18.0),
                egui::Layout::left_to_right(egui::Align::Center),
                |ui| {
                    ui.spacing_mut().item_spacing = vec2(4.0, 0.0);
                    if app.data.prefs.show_tag_chips {
                        for id in item.tags.iter().take(4) {
                            let name = app.data.prefs.tag_name(id);
                            chip(ui, &theme, &name, theme.accent_text(), theme.accent_soft());
                        }
                    }
                    // Health reads on this line too, the way Electron keeps its
                    // badges beside the tags. As its own row it was a 20px band
                    // of nothing on every card that was not flagged.
                    if app.data.prefs.show_health_badges && attention {
                        if reused {
                            chip(ui, &theme, "Reused password", theme.warn(), theme.warn_soft());
                        } else if weak {
                            chip(ui, &theme, "Weak", theme.danger(), theme.danger_soft());
                        }
                        if item.needs_attention {
                            chip(ui, &theme, "Needs attention", theme.warn(), theme.warn_soft());
                        }
                    }
                    // The age lives on this row, where the space exists; in the
                    // action row it was drawn over the 2FA pill.
                    // In a 288px grid cell the chips and the timestamp collide on
                    // one line; the age is the least useful of the two there.
                    let when = if width >= 340.0 {
                        relative_time(item.updated_at)
                    } else {
                        String::new()
                    };
                    if !when.is_empty() {
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            ui.label(RichText::new(when).size(9.0).color(theme.text_faint()));
                        });
                    }
                },
            );
            if notes_slot {
                ui.allocate_ui_with_layout(
                    vec2(width - 24.0, 16.0),
                    egui::Layout::left_to_right(egui::Align::Center),
                    |ui| {
                        if !item.notes.is_empty() {
                            ui.add(
                                egui::Label::new(
                                    RichText::new(item.notes.lines().next().unwrap_or(""))
                                        .size(10.5 * theme.text_scale)
                                        .color(theme.text_faint()),
                                )
                                .truncate(),
                            );
                        }
                    },
                );
            }
            ui.add_space(6.0);
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 4.0;
                if icon_action(ui, &theme, "copy", "Copy the password").clicked() {
                    app.copy(ui.ctx(), &item.password, "Password");
                }
                if let Some(code) = app.totp_code(item) {
                    if totp_button(ui, &theme, &code).clicked() {
                        app.copy(ui.ctx(), &code, "2FA code");
                    }
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
    // The right-click menu resolves by geometry (see App::open_menu_at_pointer),
    // so the card only has to publish where it was drawn.
    app.register_card(inner.response.rect, &item.id);
    if body.hovered() {
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
}

fn list_row(ui: &mut egui::Ui, app: &mut App, item: &VaultItem, reused: bool) {
    let theme = app.theme;
    let hue = item.hue();
    let weak = app.data.sender_is_weak(item);
    let frame = egui::Frame::none()
        .fill(theme.glass(false))
        .shadow(theme.card_shadow())
        .rounding(theme.radius(12.0))
        .stroke(Stroke::new(1.0_f32, theme.hairline()))
        .inner_margin(egui::Margin::symmetric(12.0, 6.0));
    let inner = frame.show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.horizontal(|ui| {
            let (rect, _) = ui.allocate_exact_size(vec2(28.0, 28.0), Sense::hover());
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
            // The identity column is bounded. Left unbounded it claimed the whole
            // row and the action chain was painted over it.
            ui.allocate_ui_with_layout(
                vec2((ui.available_width() - 300.0).max(140.0), 30.0),
                egui::Layout::top_down(egui::Align::Min),
                |ui| {
                    ui.label(RichText::new(item.display_title()).size(13.5).strong().color(theme.text()));
                    let subtitle = if app.data.prefs.show_urls && !item.host().is_empty() {
                        format!("{} · {}", item.username, item.host())
                    } else {
                        item.username.clone()
                    };
                    ui.label(RichText::new(subtitle).size(10.0).color(theme.text_muted()));
                },
            );
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if icon_action(ui, &theme, "external", "Open the site").clicked() {
                    ui.ctx().open_url(egui::OpenUrl::new_tab(item.url.clone()));
                }
                if icon_action(ui, &theme, "copy", "Copy the password").clicked() {
                    app.copy(ui.ctx(), &item.password, "Password");
                }
                if let Some(code) = app.totp_code(item) {
                    if totp_button(ui, &theme, &code).clicked() {
                        app.copy(ui.ctx(), &code, "2FA code");
                    }
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
    // The right-click menu resolves by geometry (see App::open_menu_at_pointer),
    // so the card only has to publish where it was drawn.
    app.register_card(inner.response.rect, &item.id);
}

fn chip(ui: &mut egui::Ui, theme: &Theme, label: &str, text: Color32, fill: Color32) {
    // `--text-xs` (11px), not 9.5: below that the label thins out to a tint on
    // the light theme, where the same colour at 11px is perfectly readable.
    let size = 10.5 * theme.text_scale;
    let galley = ui.fonts(|fonts| {
        fonts.layout_no_wrap(label.to_string(), egui::FontId::proportional(size), text)
    });
    let chip_size = galley.size() + vec2(12.0, 5.0);
    let (rect, _) = ui.allocate_exact_size(chip_size, Sense::hover());
    ui.painter().rect_filled(rect, egui::Rounding::same(999.0), fill);
    ui.painter().text(
        rect.center(),
        Align2::CENTER_CENTER,
        label,
        egui::FontId::proportional(size),
        text,
    );
}

/// A one-tap 2FA code: the six digits grouped the way an authenticator shows
/// them, a hairline countdown along the bottom edge, and the seconds left in the
/// tooltip. Clicking copies it, like every other copy action on a card.
fn totp_button(ui: &mut egui::Ui, theme: &Theme, code: &str) -> egui::Response {
    let now = totp::now_unix();
    let seconds_left = totp::seconds_remaining(now);
    let text = totp::grouped(code);
    let (rect, response) = ui.allocate_exact_size(vec2(58.0, 24.0), Sense::click());
    let fill = if response.hovered() { theme.accent_soft() } else { theme.plate(1.0) };
    ui.painter()
        .rect(rect, theme.radius(7.0), fill, Stroke::new(1.0_f32, theme.hairline()));
    ui.painter().text(
        rect.center() - vec2(0.0, 2.0),
        Align2::CENTER_CENTER,
        &text,
        egui::FontId::monospace(10.5),
        theme.accent_text(),
    );
    let track = Rect::from_min_size(
        pos2(rect.left() + 4.0, rect.bottom() - 4.0),
        vec2(rect.width() - 8.0, 2.0),
    );
    ui.painter().rect_filled(track, egui::Rounding::same(1.0), theme.plate(1.7));
    let width = track.width() * totp::fraction_remaining(now);
    ui.painter().rect_filled(
        Rect::from_min_size(track.min, vec2(width.max(1.0), 2.0)),
        egui::Rounding::same(1.0),
        theme.accent(),
    );
    response.on_hover_text(format!("{text} · {seconds_left}s left — click to copy"))
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

    let cards: Vec<(&str, String, String, Color32)> = vec![
            ("Logins", total.to_string(), "in the vault".to_string(), theme.accent()),
            ("Favorites", favorites.to_string(), "pinned".to_string(), theme.warn()),
            ("Reused", reused.len().to_string(), "passwords".to_string(), theme.danger()),
            ("Weak", weak.to_string(), "passwords".to_string(), theme.danger()),
            ("With password", protected.to_string(), "saved secrets".to_string(), theme.accent_second()),
            ("Addresses", addresses.len().to_string(), "in the roadmap".to_string(), theme.accent()),
            ("Channels", channels.to_string(), format!("{tags} tags"), theme.text_muted()),
    ];
    // Chunked by hand: `horizontal_wrapped` measured each framed tile as
    // zero-width and let the row run off the right edge of the window.
    let spacing = theme.space(0.6);
    let columns = (((ui.available_width() + spacing) / (172.0 + spacing)).floor() as usize).max(1);
    for row in cards.chunks(columns) {
        ui.horizontal(|ui| {
            ui.spacing_mut().item_spacing = vec2(spacing, spacing);
            for (label, value, hint, tone) in row {
                stat_card(ui, &theme, label, value, hint, *tone);
            }
        });
        ui.add_space(spacing);
    }

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
