//! The email roadmap.
//!
//! Same idea as the Electron route map: every address in the vault becomes a
//! route, its logins become stops, and the first login saved with that address
//! is the route's **Main** owner. Clicking the identity block opens the address
//! sheet; right-clicking offers the copy actions.
//!
//! IMAP is not part of the native port yet, so the sheet is honest about mail:
//! it shows what the vault holds and says plainly that the mailbox side lives in
//! the Electron edition for now.

use std::collections::{BTreeMap, BTreeSet};

use eframe::egui;
use egui::{pos2, vec2, Align2, Color32, Rect, RichText, Sense, Stroke};

use crate::app::{paint_gradient, App};
use crate::icon::draw as icon_draw;
use crate::model::*;
use crate::theme::{hsl, Theme};

#[derive(Default)]
pub struct RoadmapState {
    pub selected: Option<String>,
}

struct Identity {
    address: String,
    logins: Vec<VaultItem>,
    main_id: String,
    tag_names: Vec<String>,
    updated_at: i64,
}

fn identities(app: &App) -> Vec<Identity> {
    let mut grouped: BTreeMap<String, Vec<VaultItem>> = BTreeMap::new();
    for item in &app.data.items {
        let address = item.username.trim().to_lowercase();
        if !address.contains('@') {
            continue;
        }
        grouped.entry(address).or_default().push(item.clone());
    }
    let mut routes: Vec<Identity> = grouped
        .into_iter()
        .map(|(address, mut logins)| {
            logins.sort_by_key(|item| item.created_at);
            let main_id = logins.first().map(|item| item.id.clone()).unwrap_or_default();
            let updated_at = logins.iter().map(|item| item.updated_at).max().unwrap_or(0);
            let mut tags = BTreeSet::new();
            for item in &logins {
                for id in &item.tags {
                    tags.insert(app.data.prefs.tag_name(id));
                }
            }
            Identity {
                address,
                logins,
                main_id,
                tag_names: tags.into_iter().collect(),
                updated_at,
            }
        })
        .collect();
    routes.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    routes
}

pub fn show(ui: &mut egui::Ui, app: &mut App) {
    let theme = app.theme;
    let routes = identities(app);
    let needle = app.query.trim().to_lowercase();
    let shown: Vec<&Identity> = routes
        .iter()
        .filter(|identity| {
            needle.is_empty()
                || identity.address.contains(&needle)
                || identity
                    .logins
                    .iter()
                    .any(|item| item.display_title().to_lowercase().contains(&needle))
        })
        .collect();

    egui::Frame::none()
        .fill(theme.plate(0.7))
        .rounding(theme.radius(14.0))
        .stroke(Stroke::new(1.0_f32, theme.hairline()))
        .inner_margin(egui::Margin::same(14.0))
        .show(ui, |ui| {
            ui.horizontal(|ui| {
                icon_draw(
                    ui.painter(),
                    "mail",
                    Rect::from_center_size(ui.cursor().min + vec2(10.0, 9.0), vec2(18.0, 18.0)),
                    theme.accent(),
                    1.6,
                );
                ui.add_space(26.0);
                ui.vertical(|ui| {
                    ui.label(
                        RichText::new(format!(
                            "{} address{} · {} logins",
                            routes.len(),
                            if routes.len() == 1 { "" } else { "es" },
                            routes.iter().map(|identity| identity.logins.len()).sum::<usize>()
                        ))
                        .size(12.5)
                        .strong()
                        .color(theme.text()),
                    );
                    ui.label(
                        RichText::new(
                            "Each address is a route. The first login saved with it is the main owner; the rest are stops.",
                        )
                        .size(10.5)
                        .color(theme.text_muted()),
                    );
                });
            });
        });
    ui.add_space(theme.space(0.8));

    if shown.is_empty() {
        ui.add_space(theme.space(2.0));
        ui.vertical_centered(|ui| {
            ui.label(RichText::new("No addresses yet").size(17.0).strong().color(theme.text()));
            ui.label(
                RichText::new("Give a login an email username and it appears here as its own route.")
                    .size(11.0)
                    .color(theme.text_muted()),
            );
        });
        return;
    }

    for identity in shown {
        route_card(ui, app, identity);
        ui.add_space(theme.space(0.5));
    }
}

fn route_card(ui: &mut egui::Ui, app: &mut App, identity: &Identity) {
    let theme = app.theme;
    let frame = egui::Frame::none()
        .fill(theme.card())
        .rounding(theme.radius(16.0))
        .stroke(Stroke::new(1.0_f32, theme.hairline()))
        .inner_margin(egui::Margin::same(14.0));

    let mut menu_action: Option<AuthAction> = None;
    let inner = frame.show(ui, |ui| {
        ui.set_width(ui.available_width());
        ui.horizontal(|ui| {
            // Identity block
            let (badge_rect, badge) = ui.allocate_exact_size(vec2(36.0, 36.0), Sense::click());
            let hue = hue_for(&identity.address);
            paint_gradient(
                ui.painter(),
                badge_rect,
                hsl(hue, 46.0, if theme.dark { 58.0 } else { 62.0 }),
                theme.accent_second(),
                11.0,
            );
            icon_draw(
                ui.painter(),
                "mail",
                Rect::from_center_size(badge_rect.center(), vec2(17.0, 17.0)),
                Color32::WHITE,
                1.6,
            );
            let mut text_clicked = false;
            ui.vertical(|ui| {
                ui.horizontal(|ui| {
                    let address_response = ui.add(
                        egui::Label::new(
                            RichText::new(app.mask_email(&identity.address))
                                .size(14.0)
                                .strong()
                                .color(theme.text()),
                        )
                        .sense(Sense::click()),
                    );
                    if address_response.clicked() {
                        text_clicked = true;
                    }
                    if address_response.double_clicked() {
                        text_clicked = true;
                    }
                    chip(ui, &theme, "Vault address", theme.accent_text(), theme.accent_soft());
                    for tag in identity.tag_names.iter().take(3) {
                        chip(ui, &theme, tag, theme.text_muted(), theme.plate(1.0));
                    }
                });
                ui.horizontal(|ui| {
                    ui.label(
                        RichText::new(format!(
                            "{} login{} · {}",
                            identity.logins.len(),
                            if identity.logins.len() == 1 { "" } else { "s" },
                            relative_time(identity.updated_at)
                        ))
                        .size(10.0)
                        .color(theme.text_muted()),
                    );
                });
            });
            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if ui.button("Details").clicked() {
                    menu_action = Some(AuthAction::Details);
                }
                if app.chip_button(ui, "Copy email", false).clicked() {
                    menu_action = Some(AuthAction::CopyEmail);
                }
            });

            if text_clicked || badge.clicked() {
                menu_action = Some(AuthAction::Details);
            }
            if badge.secondary_clicked() {
                menu_action = Some(AuthAction::OpenMenu);
            }
        });

        ui.add_space(8.0);
        ui.horizontal_wrapped(|ui| {
            ui.spacing_mut().item_spacing = vec2(6.0, 6.0);
            for item in &identity.logins {
                let is_main = item.id == identity.main_id;
                let response = stop_pill(ui, &theme, item, is_main, app.data.prefs.mask_emails);
                if response.clicked() {
                    app.edit_login(&item.id);
                }
                response.context_menu(|ui| {
                    if ui.button("Copy email").clicked() {
                        app.copy(ui.ctx(), &item.username, "Email");
                    }
                    if ui.button("Copy password").clicked() {
                        app.copy(ui.ctx(), &item.password, "Password");
                    }
                    if ui.button("Copy email + password").clicked() {
                        app.copy(ui.ctx(), &format!("{}\n{}", item.username, item.password), "Email and password");
                    }
                    ui.separator();
                    if ui.button("Open / edit").clicked() {
                        app.edit_login(&item.id);
                    }
                });
            }
        });
    });

    let identity_response = inner.response.interact(Sense::click());
    if identity_response.secondary_clicked() {
        menu_action = Some(AuthAction::OpenMenu);
    }
    identity_response.context_menu(|ui| {
        ui.set_min_width(220.0);
        if ui.button("Email details…").clicked() {
            menu_action = Some(AuthAction::Details);
            ui.close_menu();
        }
        ui.separator();
        if ui.button("Copy email").clicked() {
            menu_action = Some(AuthAction::CopyEmail);
            ui.close_menu();
        }
        if let Some(main) = identity.logins.iter().find(|item| item.id == identity.main_id) {
            if ui.button("Copy password").clicked() {
                menu_action = Some(AuthAction::CopyPassword);
                ui.close_menu();
            }
            if ui.button("Copy email + password").clicked() {
                menu_action = Some(AuthAction::CopyBoth);
                ui.close_menu();
            }
            if ui.button("Copy login details").clicked() {
                menu_action = Some(AuthAction::CopyDetails);
                ui.close_menu();
            }
            ui.separator();
            if ui.button("Open main login").clicked() {
                menu_action = Some(AuthAction::OpenMain);
                ui.close_menu();
            }
            if !main.url.is_empty() && ui.button("Open website").clicked() {
                menu_action = Some(AuthAction::OpenSite);
                ui.close_menu();
            }
        }
        if ui.button("Open inbox (Electron only)").clicked() {
            menu_action = Some(AuthAction::Inbox);
            ui.close_menu();
        }
    });

    match menu_action {
        Some(AuthAction::Details) => app.roadmap.selected = Some(identity.address.clone()),
        Some(AuthAction::CopyEmail) => app.copy(ui.ctx(), &identity.address, "Email"),
        Some(AuthAction::CopyPassword) => {
            if let Some(main) = identity.logins.iter().find(|item| item.id == identity.main_id) {
                app.copy(ui.ctx(), &main.password, "Password");
            }
        }
        Some(AuthAction::CopyBoth) => {
            if let Some(main) = identity.logins.iter().find(|item| item.id == identity.main_id) {
                app.copy(ui.ctx(), &format!("{}\n{}", identity.address, main.password), "Email and password");
            }
        }
        Some(AuthAction::CopyDetails) => {
            if let Some(main) = identity.logins.iter().find(|item| item.id == identity.main_id) {
                app.copy(
                    ui.ctx(),
                    &format!(
                        "{}\n{}\n{}\n{}",
                        main.display_title(),
                        main.username,
                        main.password,
                        main.url
                    ),
                    "Login details",
                );
            }
        }
        Some(AuthAction::OpenMain) => {
            if let Some(main) = identity.logins.iter().find(|item| item.id == identity.main_id) {
                app.edit_login(&main.id);
            }
        }
        Some(AuthAction::OpenSite) => {
            if let Some(main) = identity.logins.iter().find(|item| item.id == identity.main_id) {
                if !main.url.is_empty() {
                    ui.ctx().open_url(egui::OpenUrl::new_tab(main.url.clone()));
                }
            }
        }
        Some(AuthAction::Inbox) => app.info("IMAP mail lives in the Electron edition; the native port keeps the vault"),
        Some(AuthAction::OpenMenu) => {}
        None => {}
    }
}

enum AuthAction {
    Details,
    CopyEmail,
    CopyPassword,
    CopyBoth,
    CopyDetails,
    OpenMain,
    OpenSite,
    Inbox,
    OpenMenu,
}

pub fn details(ctx: &egui::Context, app: &mut App) {
    let Some(address) = app.roadmap.selected.clone() else { return };
    let routes = identities(app);
    let Some(identity) = routes.into_iter().find(|identity| identity.address == address) else {
        app.roadmap.selected = None;
        return;
    };
    let theme = app.theme;
    let mut open = true;
    let mut action: Option<AuthAction> = None;

    egui::Window::new("email-details")
        .title_bar(false)
        .open(&mut open)
        .collapsible(false)
        .resizable(true)
        .anchor(egui::Align2::CENTER_CENTER, vec2(0.0, 0.0))
        .default_width(660.0)
        .max_height(720.0)
        .frame(
            egui::Frame::none()
                .fill(theme.surface())
                .rounding(theme.radius(20.0))
                .stroke(Stroke::new(1.0_f32, theme.border_strong()))
                .shadow(egui::epaint::Shadow {
                    offset: vec2(0.0, 12.0),
                    blur: 36.0,
                    spread: 0.0,
                    color: Color32::from_black_alpha(130),
                    ..Default::default()
                })
                .inner_margin(egui::Margin::same(18.0)),
        )
        .show(ctx, |ui| {
            ui.set_width(620.0);
            ui.horizontal(|ui| {
                let (rect, _) = ui.allocate_exact_size(vec2(38.0, 38.0), Sense::hover());
                paint_gradient(ui.painter(), rect, theme.gradient().0, theme.gradient().1, 12.0);
                icon_draw(
                    ui.painter(),
                    "mail",
                    Rect::from_center_size(rect.center(), vec2(18.0, 18.0)),
                    Color32::WHITE,
                    1.7,
                );
                ui.add_space(6.0);
                ui.vertical(|ui| {
                    ui.label(
                        RichText::new(app.mask_email(&identity.address))
                            .font(egui::FontId::proportional(18.0))
                            .strong()
                            .color(theme.text()),
                    );
                    ui.horizontal(|ui| {
                        chip(ui, &theme, "Vault address", theme.accent_text(), theme.accent_soft());
                        chip(
                            ui,
                            &theme,
                            &format!("{} logins", identity.logins.len()),
                            theme.text_muted(),
                            theme.plate(1.0),
                        );
                        chip(
                            ui,
                            &theme,
                            &format!("Updated {}", relative_time(identity.updated_at)),
                            theme.text_muted(),
                            theme.plate(1.0),
                        );
                    });
                });
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Min), |ui| {
                    if ui.button("✕").clicked() {
                        action = Some(AuthAction::OpenMenu);
                    }
                });
            });
            ui.add_space(10.0);
            ui.separator();
            ui.add_space(8.0);

            egui::ScrollArea::vertical().max_height(460.0).show(ui, |ui| {
                section_label(ui, &theme, "Main login");
                if let Some(main) = identity.logins.iter().find(|item| item.id == identity.main_id) {
                    egui::Frame::none()
                        .fill(theme.plate(0.8))
                        .rounding(theme.radius(12.0))
                        .stroke(Stroke::new(1.0_f32, theme.hairline()))
                        .inner_margin(egui::Margin::same(12.0))
                        .show(ui, |ui| {
                            ui.horizontal(|ui| {
                                let host = main.host();
                                let subtitle = if host.is_empty() { "No website".to_string() } else { host };
                                ui.vertical(|ui| {
                                    ui.label(
                                        RichText::new(main.display_title())
                                            .size(13.0)
                                            .strong()
                                            .color(theme.text()),
                                    );
                                    ui.label(
                                        RichText::new(format!(
                                            "{} · added {}",
                                            subtitle,
                                            relative_time(main.created_at)
                                        ))
                                        .size(10.0)
                                        .color(theme.text_muted()),
                                    );
                                });
                                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                                    chip(ui, &theme, "Main", theme.warn(), theme.warn_soft());
                                    if ui.button("Open").clicked() {
                                        action = Some(AuthAction::OpenMain);
                                    }
                                    if ui.button("Password").clicked() {
                                        action = Some(AuthAction::CopyPassword);
                                    }
                                });
                            });
                        });
                }

                ui.add_space(12.0);
                section_label(ui, &theme, "Mailbox");
                ui.label(
                    RichText::new(
                        "No IMAP connection in the native port yet. Connecting a mailbox, reading its messages and the temporary Mohmal inbox belong to the Electron edition; this window shows what the vault itself holds.",
                    )
                    .size(10.5)
                    .color(theme.text_muted()),
                );

                ui.add_space(12.0);
                section_label(ui, &theme, "Logins");
                for item in &identity.logins {
                    egui::Frame::none()
                        .fill(theme.card())
                        .rounding(theme.radius(10.0))
                        .stroke(Stroke::new(1.0_f32, theme.hairline()))
                        .inner_margin(egui::Margin::symmetric(10.0, 7.0))
                        .show(ui, |ui| {
                            ui.horizontal(|ui| {
                                ui.vertical(|ui| {
                                    ui.label(
                                        RichText::new(item.display_title())
                                            .size(12.0)
                                            .strong()
                                            .color(theme.text()),
                                    );
                                    ui.label(
                                        RichText::new(if item.host().is_empty() {
                                            item.username.clone()
                                        } else {
                                            item.host()
                                        })
                                        .size(9.5)
                                        .color(theme.text_faint()),
                                    );
                                });
                                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                                    if item.id == identity.main_id {
                                        chip(ui, &theme, "Main", theme.warn(), theme.warn_soft());
                                    }
                                    if ui.button("Open").clicked() {
                                        app.edit_login(&item.id);
                                    }
                                    if ui.button("Password").clicked() {
                                        app.copy(ui.ctx(), &item.password, "Password");
                                    }
                                });
                            });
                        });
                    ui.add_space(4.0);
                }
            });

            ui.add_space(8.0);
            ui.separator();
            ui.add_space(8.0);
            ui.horizontal(|ui| {
                if ui.button("Copy email").clicked() {
                    action = Some(AuthAction::CopyEmail);
                }
                if ui.button("Copy password").clicked() {
                    action = Some(AuthAction::CopyPassword);
                }
                if ui.button("Copy email + password").clicked() {
                    action = Some(AuthAction::CopyBoth);
                }
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if ui.button("Open main login").clicked() {
                        action = Some(AuthAction::OpenMain);
                    }
                });
            });
        });

    match action {
        Some(AuthAction::OpenMenu) => app.roadmap.selected = None,
        Some(AuthAction::CopyEmail) => app.copy(ctx, &identity.address, "Email"),
        Some(AuthAction::CopyPassword) => {
            if let Some(main) = identity.logins.iter().find(|item| item.id == identity.main_id) {
                app.copy(ctx, &main.password, "Password");
            }
        }
        Some(AuthAction::CopyBoth) => {
            if let Some(main) = identity.logins.iter().find(|item| item.id == identity.main_id) {
                app.copy(ctx, &format!("{}\n{}", identity.address, main.password), "Email and password");
            }
        }
        Some(AuthAction::OpenMain) => {
            if let Some(main) = identity.logins.iter().find(|item| item.id == identity.main_id) {
                app.roadmap.selected = None;
                app.edit_login(&main.id);
            }
        }
        _ => {}
    }
    if !open {
        app.roadmap.selected = None;
    }
}

fn section_label(ui: &mut egui::Ui, theme: &Theme, text: &str) {
    ui.label(
        RichText::new(text.to_uppercase())
            .size(9.5)
            .strong()
            .color(theme.text_faint())
            .extra_letter_spacing(0.7),
    );
    ui.add_space(4.0);
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

fn stop_pill(ui: &mut egui::Ui, theme: &Theme, item: &VaultItem, is_main: bool, mask: bool) -> egui::Response {
    let label = if is_main {
        format!("{}  Main", item.display_title())
    } else {
        item.display_title().to_string()
    };
    let color = if is_main { theme.warn() } else { theme.text_muted() };
    let fill = if is_main { theme.warn_soft() } else { theme.plate(1.0) };
    let stroke = if is_main {
        Stroke::new(1.0_f32, theme.warn().gamma_multiply(0.5))
    } else {
        Stroke::new(1.0_f32, theme.hairline())
    };
    let galley = ui.fonts(|fonts| {
        fonts.layout_no_wrap(label.clone(), egui::FontId::proportional(10.5 * theme.text_scale), color)
    });
    let size = galley.size() + vec2(18.0, 8.0);
    let (rect, response) = ui.allocate_exact_size(size, Sense::click());
    ui.painter().rect(rect, egui::Rounding::same(999.0), fill, stroke);
    ui.painter().text(
        pos2(rect.center().x + 6.0, rect.center().y),
        Align2::CENTER_CENTER,
        label,
        egui::FontId::proportional(10.5 * theme.text_scale),
        color,
    );
    let dot = pos2(rect.left() + 9.0, rect.center().y);
    ui.painter().circle_filled(dot, 3.0, if is_main { theme.warn() } else { theme.accent() });
    let _ = mask;
    response.on_hover_text(format!("{} · {}", item.display_title(), item.username))
}
