//! The login editor.
//!
//! One window, the same field order as the Electron editor, with the same
//! affordances: reveal, copy, generate, presets, strength, tags, reminder,
//! favourite and "needs attention". Saving writes straight into the vault and
//! the debounced saver picks it up.

use eframe::egui;
use egui::{vec2, Color32, RichText, Sense, Stroke};

use crate::icon::draw as icon_draw;
use crate::model::*;
use crate::theme::Theme;

#[derive(Default)]
pub struct Editor {
    draft: Option<VaultItem>,
    is_new: bool,
    tag_input: String,
    sample: String,
    error: String,
    show_password: bool,
    reminder_open: bool,
}

const PRESETS: [(&str, u32, bool, bool, bool, bool); 4] = [
    ("PIN 4", 4, false, false, true, false),
    ("PIN 6", 6, false, false, true, false),
    ("Web login", 20, true, true, true, true),
    ("Long", 32, true, true, true, true),
];

impl Editor {
    pub fn is_open(&self) -> bool {
        self.draft.is_some()
    }

    pub fn close(&mut self) {
        self.draft = None;
        self.error.clear();
        self.tag_input.clear();
    }

    pub fn open_new(&mut self, data: &VaultData) {
        let mut draft = VaultItem::fresh();
        draft.password = generate_password(&data.prefs.password_generator);
        self.sample = generate_password(&data.prefs.password_generator);
        self.draft = Some(draft);
        self.is_new = true;
        self.error.clear();
        self.tag_input.clear();
        self.show_password = false;
        self.reminder_open = false;
    }

    pub fn open_existing(&mut self, data: &VaultData, id: &str) {
        if let Some(item) = data.item(id) {
            self.draft = Some(item.clone());
            self.sample = generate_password(&data.prefs.password_generator);
            self.is_new = false;
            self.error.clear();
            self.tag_input.clear();
            self.show_password = false;
            self.reminder_open = item.reminder_days > 0.0;
        }
    }
}

pub fn generate_password(prefs: &GeneratorPrefs) -> String {
    use rand::Rng;
    let mut alphabet = String::new();
    if prefs.lower {
        alphabet.push_str("abcdefghijkmnopqrstuvwxyz");
    }
    if prefs.upper {
        alphabet.push_str("ABCDEFGHJKLMNPQRSTUVWXYZ");
    }
    if prefs.digits {
        alphabet.push_str("23456789");
    }
    if prefs.symbols {
        alphabet.push_str("!@#$%^&*()-_=+[]{};:,.?/");
    }
    if !prefs.avoid_ambiguous {
        if prefs.lower {
            alphabet.push_str("l");
        }
        if prefs.upper {
            alphabet.push_str("IO");
        }
        if prefs.digits {
            alphabet.push_str("01");
        }
    }
    if alphabet.is_empty() {
        alphabet.push_str("abcdefghijkmnopqrstuvwxyz23456789");
    }
    let characters: Vec<char> = alphabet.chars().collect();
    let mut rng = rand::thread_rng();
    (0..prefs.length.clamp(4, 128))
        .map(|_| characters[rng.gen_range(0..characters.len())])
        .collect()
}

pub fn show(ctx: &egui::Context, app: &mut crate::app::App) {
    if !app.editor.is_open() {
        return;
    }
    let mut draft = app.editor.draft.take().unwrap();
    let theme = app.theme;
    let mut open = true;
    let mut save = false;
    let mut cancel = false;
    let mut delete = false;

    egui::Window::new("login-editor")
        .title_bar(false)
        .open(&mut open)
        .collapsible(false)
        .resizable(true)
        .anchor(egui::Align2::CENTER_CENTER, vec2(0.0, 0.0))
        // No max height: with one, the Delete/Save row was laid out past the
        // bottom edge and never drawn at all.
        .default_width(660.0)
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
            // A fixed body height, with the footer's space taken out of the
            // scroll area. Auto-sizing clipped the Delete/Save row entirely.
            ui.set_width(620.0);
            ui.set_height(700.0);
            ui.horizontal(|ui| {
                ui.vertical(|ui| {
                    ui.label(
                        RichText::new(if app.editor.is_new { "New login" } else { "Edit login" })
                            .font(egui::FontId::proportional(20.0))
                            .strong()
                            .color(theme.text()),
                    );
                    ui.label(
                        RichText::new(if app.editor.is_new {
                            "Stored encrypted on this machine, nowhere else."
                        } else {
                            "Changes are saved when you press Save."
                        })
                        .size(10.5)
                        .color(theme.text_muted()),
                    );
                });
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Min), |ui| {
                    if icon_close(ui, &theme).clicked() {
                        cancel = true;
                    }
                });
            });
            ui.add_space(10.0);
            ui.separator();
            ui.add_space(10.0);

            let body_height = (ui.available_height() - 64.0).max(220.0);
            egui::ScrollArea::vertical()
                .max_height(body_height)
                .auto_shrink([false, false])
                .show(ui, |ui| {
                field_row(ui, &theme, "Title", &mut draft.title, false, "GitHub");
                field_row(ui, &theme, "Website", &mut draft.url, false, "https://github.com");
                field_row(ui, &theme, "Email or username", &mut draft.username, false, "you@example.com");

                // Password
                ui.horizontal(|ui| {
                    ui.add_sized(vec2(150.0, 20.0), egui::Label::new(label(&theme, "Password")));
                    let response = ui.add_sized(
                        vec2(300.0, 30.0),
                        egui::TextEdit::singleline(&mut draft.password)
                            .password(!app.editor.show_password)
                            .font(egui::FontId::monospace(12.0)),
                    );
                    let _ = response;
                    if icon_button(ui, &theme, if app.editor.show_password { "eye" } else { "eye" }, app.editor.show_password)
                        .clicked()
                    {
                        app.editor.show_password = !app.editor.show_password;
                    }
                    if icon_button(ui, &theme, "copy", false).clicked() {
                        app.copy(ctx, &draft.password, "Password");
                    }
                    if icon_button(ui, &theme, "refresh", false).clicked() {
                        draft.password = generate_password(&app.data.prefs.password_generator);
                    }
                });
                strength_bar(ui, &theme, &draft.password);
                ui.add_space(6.0);

                // TOTP: the seed is checked and turned into a live code as it is
                // typed, so a mistyped seed is caught here instead of on the card.
                ui.horizontal(|ui| {
                    ui.add_sized(vec2(150.0, 20.0), egui::Label::new(label(&theme, "Authenticator seed")));
                    ui.add_sized(
                        vec2(430.0, 30.0),
                        egui::TextEdit::singleline(&mut draft.totp_secret)
                            .hint_text("JBSWY3DPEHPK3PXP or an otpauth:// link"),
                    );
                    if !draft.totp_secret.trim().is_empty() {
                        let now = crate::totp::now_unix();
                        match crate::totp::code_at(&draft.totp_secret, now) {
                            Some(code) => {
                                let text = crate::totp::grouped(&code);
                                if ui
                                    .button(RichText::new(&text).monospace().size(11.5).color(theme.accent_text()))
                                    .on_hover_text("Copy this code")
                                    .clicked()
                                {
                                    app.copy(ctx, &code, "2FA code");
                                }
                                ui.label(
                                    RichText::new(format!("{}s left", crate::totp::seconds_remaining(now)))
                                        .size(10.0)
                                        .color(theme.text_faint()),
                                );
                            }
                            None => {
                                ui.label(
                                    RichText::new("not a base32 seed")
                                        .size(10.0)
                                        .color(theme.warn()),
                                );
                            }
                        }
                    }
                });
                ui.horizontal(|ui| {
                    ui.add_sized(vec2(150.0, 20.0), egui::Label::new(label(&theme, "Rotation reminder")));
                    if ui.checkbox(&mut app.editor.reminder_open, "Only this login").changed() {
                        if !app.editor.reminder_open {
                            draft.reminder_days = 0.0;
                        }
                    }
                    if app.editor.reminder_open {
                        ui.add(egui::DragValue::new(&mut draft.reminder_days).speed(1.0).range(0.0..=3650.0));
                        ui.label(RichText::new("days").size(10.5).color(theme.text_muted()));
                    } else {
                        ui.label(
                            RichText::new(format!("Follows the vault's {} days", app.data.prefs.password_age_days))
                                .size(10.0)
                                .color(theme.text_faint()),
                        );
                    }
                });
                ui.add_space(8.0);

                // Notes
                ui.label(label(&theme, "Notes"));
                ui.add(
                    egui::TextEdit::multiline(&mut draft.notes)
                        .desired_rows(3)
                        .desired_width(f32::INFINITY)
                        .hint_text("Anything worth remembering"),
                );
                ui.add_space(8.0);

                // Tags
                ui.label(label(&theme, "Tags"));
                ui.horizontal_wrapped(|ui| {
                    let mut remove: Option<String> = None;
                    for id in draft.tags.clone() {
                        let name = app.data.prefs.tag_name(&id);
                        if tag_chip(ui, &theme, &format!("{name} ✕")).clicked() {
                            remove = Some(id);
                        }
                    }
                    if let Some(id) = remove {
                        draft.tags.retain(|tag| tag != &id);
                    }
                    if app.data.prefs.tags.is_empty() {
                        ui.label(RichText::new("No tags yet — type one below.").size(10.0).color(theme.text_faint()));
                    }
                });
                ui.horizontal(|ui| {
                    let response = ui.add_sized(
                        vec2(200.0, 28.0),
                        egui::TextEdit::singleline(&mut app.editor.tag_input).hint_text("Add or create a tag"),
                    );
                    let submit = response.lost_focus() && ui.input(|input| input.key_pressed(egui::Key::Enter));
                    if (ui.button("Add tag").clicked() || submit) && !app.editor.tag_input.trim().is_empty() {
                        let id = app.data.prefs.ensure_tag(&app.editor.tag_input);
                        if !draft.tags.contains(&id) {
                            draft.tags.push(id);
                        }
                        app.editor.tag_input.clear();
                    }
                    if !app.data.prefs.tags.is_empty() {
                        ui.menu_button("Existing", |ui| {
                            for tag in app.data.prefs.tags.clone() {
                                if ui.checkbox(&mut draft.tags.contains(&tag.id), &tag.name).clicked() {
                                    if let Some(index) = draft.tags.iter().position(|id| id == &tag.id) {
                                        draft.tags.remove(index);
                                    } else {
                                        draft.tags.push(tag.id.clone());
                                    }
                                }
                            }
                        });
                    }
                });
                ui.add_space(8.0);

                // Flags
                ui.horizontal(|ui| {
                    ui.checkbox(&mut draft.favorite, "Favorite");
                    ui.checkbox(&mut draft.needs_attention, "Needs attention");
                });
                ui.add_space(10.0);

                // Generator panel
                egui::Frame::none()
                    .fill(theme.plate(0.8))
                    .rounding(theme.radius(12.0))
                    .stroke(Stroke::new(1.0_f32, theme.hairline()))
                    .inner_margin(egui::Margin::same(12.0))
                    .show(ui, |ui| {
                        ui.horizontal(|ui| {
                            icon_draw(
                                ui.painter(),
                                "key",
                                egui::Rect::from_center_size(ui.cursor().min + vec2(8.0, 8.0), vec2(14.0, 14.0)),
                                theme.accent(),
                                1.5,
                            );
                            ui.add_space(20.0);
                            ui.label(RichText::new("Generator").size(12.0).strong().color(theme.text()));
                            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                                if ui.button("Use").clicked() {
                                    draft.password = app.editor.sample.clone();
                                }
                                if ui.button("New sample").clicked() {
                                    app.editor.sample = generate_password(&app.data.prefs.password_generator);
                                }
                            });
                        });
                        ui.add_space(6.0);
                        ui.label(
                            RichText::new(&app.editor.sample)
                                .monospace()
                                .size(12.0)
                                .color(theme.accent_text()),
                        );
                        ui.add_space(6.0);
                        ui.horizontal(|ui| {
                            for (name, length, lower, upper, digits, symbols) in PRESETS {
                                if ui.button(name).clicked() {
                                    let prefs = &mut app.data.prefs.password_generator;
                                    prefs.length = length;
                                    prefs.lower = lower;
                                    prefs.upper = upper;
                                    prefs.digits = digits;
                                    prefs.symbols = symbols;
                                    app.editor.sample = generate_password(&app.data.prefs.password_generator);
                                }
                            }
                        });
                        ui.add_space(4.0);
                        let prefs = &mut app.data.prefs.password_generator;
                        ui.add(egui::Slider::new(&mut prefs.length, 4..=64).text("Length"));
                        ui.horizontal(|ui| {
                            ui.checkbox(&mut prefs.lower, "Lowercase");
                            ui.checkbox(&mut prefs.upper, "Uppercase");
                            ui.checkbox(&mut prefs.digits, "Digits");
                            ui.checkbox(&mut prefs.symbols, "Symbols");
                            ui.checkbox(&mut prefs.avoid_ambiguous, "Avoid look-alikes");
                        });
                        if ui.button("Remember these defaults").clicked() {
                            app.mark_dirty();
                            app.info("Generator defaults saved");
                        }
                    });

                if !app.editor.error.is_empty() {
                    ui.add_space(8.0);
                    ui.label(RichText::new(&app.editor.error).size(10.5).color(theme.danger()));
                }
            });

            ui.add_space(10.0);
            ui.separator();
            ui.add_space(8.0);
            ui.horizontal(|ui| {
                let has_item = !app.editor.is_new;
                if has_item && ui.button("Delete").clicked() {
                    delete = true;
                }
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if ui
                        .add(
                            egui::Button::new(RichText::new("Save").size(12.0).color(Color32::WHITE))
                                .fill(theme.accent())
                                .rounding(theme.radius(9.0)),
                        )
                        .clicked()
                    {
                        save = true;
                    }
                    if ui.button("Cancel").clicked() {
                        cancel = true;
                    }
                });
            });
        });

    if save {
        if draft.title.trim().is_empty() && draft.username.trim().is_empty() && draft.url.trim().is_empty() {
            app.editor.error = "Give the login a title, a username or a website".into();
            app.editor.draft = Some(draft);
            return;
        }
        if draft.title.trim().is_empty() {
            draft.title = if !draft.username.is_empty() {
                draft.username.clone()
            } else {
                hostname_of(&draft.url).unwrap_or_else(|| "Untitled login".into())
            };
        }
        // Store the seed in one canonical shape, so a pasted URL or a spaced
        // grouping opens the same on the card next time.
        draft.totp_secret = crate::totp::normalize_seed(&draft.totp_secret);
        if !draft.totp_secret.is_empty() && !crate::totp::valid_seed(&draft.totp_secret) {
            app.editor.error = "That authenticator seed is not valid base32 — check it for typos".into();
            app.editor.draft = Some(draft);
            return;
        }
        let is_new = app.editor.is_new;
        if !is_new {
            draft.updated_at = now_ms();
            if let Some(existing) = app.data.item(&draft.id) {
                if existing.password != draft.password {
                    draft.password_updated_at = now_ms();
                }
                if existing.username != draft.username {
                    draft.username_updated_at = now_ms();
                }
            }
        }
        draft.updated_at = now_ms();
        let id = draft.id.clone();
        app.save_item(draft, is_new);
        app.editor.close();
        app.editor.draft = None;
        let _ = id;
        return;
    }
    if delete {
        let id = draft.id.clone();
        app.confirm = Some(crate::app::Confirm::DeleteItem(id));
        app.editor.draft = Some(draft);
        return;
    }
    if cancel || !open {
        app.editor.close();
    } else {
        app.editor.draft = Some(draft);
    }
}

fn label(theme: &Theme, text: &str) -> RichText {
    RichText::new(text).size(11.0 * theme.text_scale).color(theme.text_muted())
}

fn field_row(ui: &mut egui::Ui, theme: &Theme, title: &str, value: &mut String, password: bool, hint: &str) {
    ui.horizontal(|ui| {
        ui.add_sized(vec2(150.0, 20.0), egui::Label::new(label(theme, title)));
        ui.add_sized(
            vec2(430.0, 30.0),
            egui::TextEdit::singleline(value).password(password).hint_text(hint),
        );
    });
}

fn strength_bar(ui: &mut egui::Ui, theme: &Theme, password: &str) {
    let score = password_score(password);
    let color = match score {
        0 => theme.text_faint(),
        1 => theme.danger(),
        2 => theme.warn(),
        _ => theme.accent(),
    };
    let label_text = if score == 0 { "No password" } else { password_label(score) };
    let (rect, _) = ui.allocate_exact_size(vec2(ui.available_width(), 16.0), Sense::hover());
    let bar = egui::Rect::from_min_size(rect.min, vec2(rect.width() * 0.55, 5.0));
    ui.painter().rect_filled(bar, egui::Rounding::same(3.0), theme.plate(1.4));
    if score > 0 {
        let width = bar.width() * (score as f32 / 4.0);
        ui.painter().rect_filled(
            egui::Rect::from_min_size(bar.min, vec2(width, 5.0)),
            egui::Rounding::same(3.0),
            color,
        );
    }
    ui.painter().text(
        egui::pos2(bar.right() + 8.0, bar.center().y),
        egui::Align2::LEFT_CENTER,
        label_text,
        egui::FontId::proportional(10.0),
        color,
    );
    ui.add_space(2.0);
}

fn tag_chip(ui: &mut egui::Ui, theme: &Theme, text: &str) -> egui::Response {
    let galley = ui.fonts(|fonts| {
        fonts.layout_no_wrap(text.to_string(), egui::FontId::proportional(10.0), theme.text_muted())
    });
    let size = galley.size() + vec2(16.0, 6.0);
    let (rect, response) = ui.allocate_exact_size(size, Sense::click());
    ui.painter().rect_filled(rect, egui::Rounding::same(999.0), theme.plate(1.1));
    ui.painter().text(
        rect.center(),
        egui::Align2::CENTER_CENTER,
        text,
        egui::FontId::proportional(10.0),
        theme.text_muted(),
    );
    response
}

fn icon_button(ui: &mut egui::Ui, theme: &Theme, icon: &str, active: bool) -> egui::Response {
    let (rect, response) = ui.allocate_exact_size(vec2(28.0, 28.0), Sense::click());
    let bg = if active {
        theme.accent_soft()
    } else if response.hovered() {
        theme.plate(1.4)
    } else {
        Color32::TRANSPARENT
    };
    ui.painter().rect_filled(rect, theme.radius(7.0), bg);
    icon_draw(
        ui.painter(),
        icon,
        egui::Rect::from_center_size(rect.center(), vec2(13.0, 13.0)),
        if active { theme.accent_text() } else { theme.text_muted() },
        1.4,
    );
    response
}

fn icon_close(ui: &mut egui::Ui, theme: &Theme) -> egui::Response {
    let (rect, response) = ui.allocate_exact_size(vec2(28.0, 28.0), Sense::click());
    if response.hovered() {
        ui.painter().rect_filled(rect, theme.radius(8.0), theme.plate(1.4));
    }
    icon_draw(
        ui.painter(),
        "close",
        egui::Rect::from_center_size(rect.center(), vec2(12.0, 12.0)),
        theme.text_muted(),
        1.5,
    );
    response
}
