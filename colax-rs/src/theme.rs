//! Design tokens, ported from the Electron app's `tokens.css`.
//!
//! Every colour is computed the same way the stylesheet computes it: a neutral
//! ramp plus two accent hues, one light/dark switch, and the same calm accent
//! presets. Components only ever ask for a named colour, never for a theme
//! branch, which is what keeps the two editions looking like one product.

use egui::{Color32, Rounding, Stroke};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ThemeMode {
    System,
    Light,
    Dark,
}

impl From<crate::model::ThemeSetting> for ThemeMode {
    fn from(setting: crate::model::ThemeSetting) -> Self {
        match setting {
            crate::model::ThemeSetting::Light => ThemeMode::Light,
            crate::model::ThemeSetting::Dark => ThemeMode::Dark,
            // "System" is resolved by the caller through the window's dark flag;
            // this conversion is the fallback when it is not known.
            crate::model::ThemeSetting::System => ThemeMode::System,
        }
    }
}

impl ThemeMode {
    /// Resolves `system` against the OS preference egui reports.
    pub fn is_dark(self, system_dark: bool) -> bool {
        match self {
            ThemeMode::Dark => true,
            ThemeMode::Light => false,
            ThemeMode::System => system_dark,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Accent {
    Slate,
    Sage,
    Dusk,
    Clay,
}

impl Accent {
    pub const ALL: [Accent; 4] = [Accent::Slate, Accent::Sage, Accent::Dusk, Accent::Clay];

    pub fn label(self) -> &'static str {
        match self {
            Accent::Slate => "Slate",
            Accent::Sage => "Sage",
            Accent::Dusk => "Dusk",
            Accent::Clay => "Clay",
        }
    }

    /// The pair of hues that drives gradients, exactly as `--accent-h` and
    /// `--accent-h-2` do in the stylesheet.
    pub fn hues(self) -> (f32, f32) {
        match self {
            Accent::Slate => (212.0, 196.0),
            Accent::Sage => (152.0, 172.0),
            Accent::Dusk => (268.0, 232.0),
            Accent::Clay => (28.0, 348.0),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Density {
    Compact,
    Comfortable,
    Spacious,
}

impl Density {
    pub fn scale(self) -> f32 {
        match self {
            Density::Compact => 0.78,
            Density::Comfortable => 1.0,
            Density::Spacious => 1.22,
        }
    }
}

/// `hsl(h s% l% / a)`: the translucent channel tints in the token sheet.
pub fn hsl_alpha(hue: f32, saturation: f32, lightness: f32, alpha: f32) -> Color32 {
    let opaque = hsl(hue, saturation, lightness);
    // `mix` drops alpha at its `from_rgb`, so it cannot build a translucent
    // tint: the chip came out opaque near-black instead of a 14% wash.
    Color32::from_rgba_unmultiplied(
        opaque.r(),
        opaque.g(),
        opaque.b(),
        (alpha.clamp(0.0, 1.0) * 255.0).round() as u8,
    )
}

/// HSL to RGB, matching the CSS `hsl(h s% l%)` values in the token sheet.
pub fn hsl(hue: f32, saturation: f32, lightness: f32) -> Color32 {
    let h = ((hue % 360.0) + 360.0) % 360.0 / 360.0;
    let s = (saturation / 100.0).clamp(0.0, 1.0);
    let l = (lightness / 100.0).clamp(0.0, 1.0);
    if s == 0.0 {
        let v = (l * 255.0).round() as u8;
        return Color32::from_rgb(v, v, v);
    }
    let q = if l < 0.5 { l * (1.0 + s) } else { l + s - l * s };
    let p = 2.0 * l - q;
    let channel = |t: f32| -> u8 {
        let mut t = t;
        if t < 0.0 {
            t += 1.0;
        }
        if t > 1.0 {
            t -= 1.0;
        }
        let value = if t < 1.0 / 6.0 {
            p + (q - p) * 6.0 * t
        } else if t < 1.0 / 2.0 {
            q
        } else if t < 2.0 / 3.0 {
            p + (q - p) * (2.0 / 3.0 - t) * 6.0
        } else {
            p
        };
        (value * 255.0).round().clamp(0.0, 255.0) as u8
    };
    Color32::from_rgb(channel(h + 1.0 / 3.0), channel(h), channel(h - 1.0 / 3.0))
}

fn alpha(color: Color32, factor: f32) -> Color32 {
    Color32::from_rgba_unmultiplied(color.r(), color.g(), color.b(), (255.0 * factor).round() as u8)
}

/// Mixes two colours, for the soft gradients the cards and rails use.
pub fn mix(from: Color32, to: Color32, t: f32) -> Color32 {
    let t = t.clamp(0.0, 1.0);
    let blend = |a: u8, b: u8| (a as f32 + (b as f32 - a as f32) * t).round() as u8;
    Color32::from_rgb(blend(from.r(), to.r()), blend(from.g(), to.g()), blend(from.b(), to.b()))
}

/// The shipped preference set: dark, slate, compact, high contrast — the same
/// defaults the Electron build reads out of `DEFAULT_PREFERENCES`.
#[derive(Clone, Copy)]
pub struct Theme {
    pub dark: bool,
    pub hues: (f32, f32),
    pub density: f32,
    pub roundness: f32,
    pub text_scale: f32,
    pub reduce_transparency: bool,
    pub high_contrast: bool,
    /// `--card-depth`: 0 flat, 1 deep. Drives every lift in the app.
    pub card_depth: f32,
}

impl Default for Theme {
    fn default() -> Self {
        Self {
            dark: true,
            hues: Accent::Slate.hues(),
            density: Density::Compact.scale(),
            roundness: 1.4,
            text_scale: 1.0,
            reduce_transparency: false,
            high_contrast: true,
            card_depth: 0.4,
        }
    }
}

/// The display face for page titles, matching `--font-display`: Georgia on a
/// stock Windows machine, which is in the stylesheet's own fallback stack.
pub fn display() -> egui::FontFamily {
    egui::FontFamily::Name("display".into())
}

/// Loads the same faces the Electron build resolves on Windows: Segoe UI for
/// text, Georgia for display headings, Consolas for mono. egui ships its own
/// fonts, which is why the port looked like a demo instead of this product.
pub fn install_fonts(ctx: &egui::Context) {
    let mut fonts = egui::FontDefinitions::default();
    let load = |name: &str, file: &str| -> Option<egui::FontData> {
        let path = std::path::Path::new("C:\\Windows\\Fonts").join(file);
        std::fs::read(path).ok().map(|bytes| {
            let _ = name;
            egui::FontData::from_owned(bytes)
        })
    };
    if let Some(data) = load("segoe", "segoeui.ttf") {
        fonts.font_data.insert("segoe".into(), data);
        fonts
            .families
            .entry(egui::FontFamily::Proportional)
            .or_default()
            .insert(0, "segoe".into());
    }
    if let Some(data) = load("georgia", "georgia.ttf") {
        fonts.font_data.insert("georgia".into(), data);
        fonts.families.insert(display(), vec!["georgia".into()]);
        // Display headings fall back to the body face rather than egui's own.
        fonts
            .families
            .entry(display())
            .or_default()
            .push("segoe".into());
    }
    if let Some(data) = load("consolas", "consola.ttf") {
        fonts.font_data.insert("consolas".into(), data);
        fonts
            .families
            .entry(egui::FontFamily::Monospace)
            .or_default()
            .insert(0, "consolas".into());
    }
    ctx.set_fonts(fonts);
}

impl Theme {
    pub fn build(mode: ThemeMode, accent: Accent, system_dark: bool) -> Self {
        Self {
            dark: mode.is_dark(system_dark),
            hues: accent.hues(),
            ..Default::default()
        }
    }

    /* ---- Surfaces ------------------------------------------------------- */

    pub fn bg(&self) -> Color32 {
        if self.dark {
            hsl(220.0, 22.0, 7.0)
        } else {
            hsl(210.0, 30.0, 96.0)
        }
    }

    pub fn bg_deep(&self) -> Color32 {
        if self.dark {
            hsl(220.0, 24.0, 5.0)
        } else {
            hsl(210.0, 26.0, 91.0)
        }
    }

    pub fn card(&self) -> Color32 {
        if self.dark {
            hsl(220.0, 18.0, 7.0)
        } else {
            hsl(0.0, 0.0, 100.0)
        }
    }

    /// Same linear-blend correction as `glass`: composited over the page so a
    /// 5% plate stays a 5% plate.
    pub fn plate(&self, factor: f32) -> Color32 {
        if self.dark {
            mix(self.bg(), Color32::WHITE, 0.05 * factor)
        } else {
            mix(self.bg(), hsl(222.0, 20.0, 12.0), 0.045 * factor)
        }
    }

    pub fn surface(&self) -> Color32 {
        if self.dark {
            hsl(220.0, 18.0, 12.0)
        } else {
            hsl(0.0, 0.0, 100.0)
        }
    }

    /// `--surface-raised`, the search well in the topbar.
    pub fn surface_raised(&self) -> Color32 {
        if self.dark {
            hsl(220.0, 18.0, 15.0)
        } else {
            hsl(0.0, 0.0, 100.0)
        }
    }

    /// `--glass`: the translucent card surface the ambient gradient reads
    /// through. At 5% white it is barely a tint, which is the point.
    /// Composited, not translucent. This renderer blends in linear space, where
    /// a 5% alpha reads as roughly a quarter white and turned every card into a
    /// grey slab; mixing the same 5% over the page colour in sRGB gives the
    /// colour the stylesheet actually resolves to.
    pub fn glass(&self, strong: bool) -> Color32 {
        if self.reduce_transparency {
            return self.surface();
        }
        let factor = if self.dark {
            if strong { 0.085 } else { 0.05 }
        } else if strong {
            0.8
        } else {
            0.62
        };
        mix(self.bg(), Color32::WHITE, factor)
    }

    /// The four-layer lift `--card-shadow` describes, collapsed to the one
    /// shadow egui draws.
    pub fn card_shadow(&self) -> egui::epaint::Shadow {
        let depth = self.card_depth.clamp(0.0, 1.0);
        egui::epaint::Shadow {
            offset: egui::vec2(0.0, 8.0 * depth),
            blur: 28.0 * depth,
            spread: 0.0,
            color: if self.dark {
                Color32::from_black_alpha((110.0 * depth) as u8)
            } else {
                Color32::from_black_alpha((28.0 * depth) as u8)
            },
        }
    }

    pub fn surface_hover(&self) -> Color32 {
        if self.dark {
            hsl(220.0, 18.0, 19.0)
        } else {
            hsl(210.0, 30.0, 95.0)
        }
    }

    pub fn surface_active(&self) -> Color32 {
        if self.dark {
            hsl(220.0, 18.0, 23.0)
        } else {
            hsl(210.0, 30.0, 91.0)
        }
    }

    pub fn border(&self) -> Color32 {
        if self.dark {
            mix(self.bg(), Color32::WHITE, if self.high_contrast { 0.2 } else { 0.09 })
        } else if self.high_contrast {
            hsl(210.0, 18.0, 74.0)
        } else {
            hsl(210.0, 20.0, 87.0)
        }
    }

    pub fn border_strong(&self) -> Color32 {
        if self.dark {
            mix(self.bg(), Color32::WHITE, if self.high_contrast { 0.34 } else { 0.17 })
        } else {
            hsl(210.0, 16.0, 76.0)
        }
    }

    pub fn hairline(&self) -> Color32 {
        if self.dark {
            mix(self.bg(), Color32::WHITE, 0.08)
        } else {
            mix(self.bg(), hsl(222.0, 20.0, 12.0), 0.1)
        }
    }

    pub fn text(&self) -> Color32 {
        if self.dark {
            hsl(220.0, 26.0, 96.0)
        } else {
            hsl(222.0, 30.0, 13.0)
        }
    }

    pub fn text_muted(&self) -> Color32 {
        if self.dark {
            hsl(220.0, 12.0, if self.high_contrast { 82.0 } else { 68.0 })
        } else {
            hsl(222.0, 12.0, 44.0)
        }
    }

    pub fn text_faint(&self) -> Color32 {
        if self.dark {
            hsl(220.0, 12.0, if self.high_contrast { 66.0 } else { 50.0 })
        } else {
            hsl(222.0, 10.0, 58.0)
        }
    }

    /* ---- Accent --------------------------------------------------------- */

    pub fn accent(&self) -> Color32 {
        let (h, _) = self.hues;
        if self.dark {
            hsl(h, 42.0, 62.0)
        } else {
            hsl(h, 40.0, 44.0)
        }
    }

    pub fn accent_hover(&self) -> Color32 {
        let (h, _) = self.hues;
        if self.dark {
            hsl(h, 46.0, 70.0)
        } else {
            hsl(h, 44.0, 36.0)
        }
    }

    pub fn accent_soft(&self) -> Color32 {
        mix(self.bg(), self.accent(), if self.dark { 0.16 } else { 0.12 })
    }

    /// `--grad-soft`: the wash under the current rail row, from the accent hue
    /// to the second one. Composited for the same reason as `glass`.
    pub fn accent_gradient_soft(&self) -> (Color32, Color32) {
        let (h1, h2) = self.hues;
        let (first, second) = if self.dark { (0.22, 0.10) } else { (0.18, 0.08) };
        (
            mix(self.bg(), hsl(h1, 44.0, 58.0), first),
            mix(self.bg(), hsl(h2, 40.0, 62.0), second),
        )
    }

    pub fn accent_text(&self) -> Color32 {
        let (h, _) = self.hues;
        if self.dark {
            hsl(h, 50.0, 76.0)
        } else {
            hsl(h, 44.0, 34.0)
        }
    }

    pub fn accent_second(&self) -> Color32 {
        let (_, h2) = self.hues;
        if self.dark {
            hsl(h2, 40.0, 62.0)
        } else {
            hsl(h2, 38.0, 52.0)
        }
    }

    pub fn gradient(&self) -> (Color32, Color32) {
        (self.accent(), self.accent_second())
    }

    pub fn accent_wash(&self, factor: f32) -> Color32 {
        alpha(self.accent(), factor)
    }

    pub fn danger(&self) -> Color32 {
        if self.dark {
            hsl(357.0, 62.0, 68.0)
        } else {
            hsl(357.0, 58.0, 52.0)
        }
    }

    pub fn danger_soft(&self) -> Color32 {
        mix(self.bg(), self.danger(), 0.14)
    }

    pub fn warn(&self) -> Color32 {
        if self.dark {
            hsl(38.0, 76.0, 66.0)
        } else {
            hsl(32.0, 74.0, 44.0)
        }
    }

    pub fn warn_soft(&self) -> Color32 {
        mix(self.bg(), self.warn(), 0.14)
    }

    /* ---- Geometry ------------------------------------------------------- */

    /// `--space-N` times the density scale, in pixels.
    pub fn space(&self, steps: f32) -> f32 {
        steps * 16.0 * self.density
    }

    /// Radius tokens: 8 / 12 / 18 / 26 / 34, scaled by the roundness setting.
    pub fn radius(&self, base: f32) -> Rounding {
        Rounding::same((base * self.roundness).clamp(2.0, 40.0))
    }

    pub fn font_size(&self, base: f32) -> f32 {
        base * self.text_scale
    }

    /// Applies the palette to egui so stock widgets (inputs, scrollbars, menus)
    /// look like the ported components around them.
    pub fn apply(&self, ctx: &egui::Context, system_scale: f32) {
        let mut style = (*ctx.style()).clone();
        let mut visuals = if self.dark {
            egui::Visuals::dark()
        } else {
            egui::Visuals::light()
        };
        visuals.panel_fill = self.bg();
        visuals.window_fill = self.surface();
        visuals.window_stroke = Stroke::new(1.0_f32, self.border());
        visuals.extreme_bg_color = self.bg_deep();
        visuals.faint_bg_color = self.plate(1.0);
        visuals.override_text_color = Some(self.text());
        visuals.selection.bg_fill = self.accent_soft();
        visuals.selection.stroke = Stroke::new(1.0_f32, self.accent());
        visuals.hyperlink_color = self.accent();
        visuals.menu_rounding = self.radius(12.0);
        visuals.window_rounding = self.radius(18.0);

        let widgets = &mut visuals.widgets;
        widgets.noninteractive.bg_fill = self.surface();
        widgets.noninteractive.weak_bg_fill = self.plate(1.0);
        widgets.noninteractive.bg_stroke = Stroke::new(1.0_f32, self.hairline());
        widgets.noninteractive.fg_stroke = Stroke::new(1.0_f32, self.text_muted());
        widgets.inactive.bg_fill = self.plate(1.0);
        widgets.inactive.weak_bg_fill = self.plate(1.0);
        widgets.inactive.bg_stroke = Stroke::new(1.0_f32, self.border());
        widgets.inactive.fg_stroke = Stroke::new(1.0_f32, self.text());
        widgets.inactive.rounding = self.radius(10.0);
        widgets.hovered.bg_fill = self.surface_hover();
        widgets.hovered.weak_bg_fill = self.surface_hover();
        widgets.hovered.bg_stroke = Stroke::new(1.0_f32, self.border_strong());
        widgets.hovered.fg_stroke = Stroke::new(1.0_f32, self.text());
        widgets.hovered.rounding = self.radius(10.0);
        widgets.active.bg_fill = self.surface_active();
        widgets.active.weak_bg_fill = self.surface_active();
        widgets.active.bg_stroke = Stroke::new(1.0_f32, self.accent());
        widgets.active.fg_stroke = Stroke::new(1.0_f32, self.text());
        widgets.active.rounding = self.radius(10.0);
        widgets.open.bg_fill = self.surface_active();
        widgets.open.weak_bg_fill = self.surface_active();
        widgets.open.bg_stroke = Stroke::new(1.0_f32, self.border_strong());
        widgets.open.fg_stroke = Stroke::new(1.0_f32, self.text());
        style.visuals = visuals;

        // The Electron type scale, in px: xs 11, sm 13, base 15, lg 17, xl 22,
        // 2xl 32, with display headings in the serif face.
        let body = self.font_size(15.0) * system_scale;
        style.text_styles = [
            (egui::TextStyle::Heading, egui::FontId::new(body * 2.13, display())),
            (egui::TextStyle::Body, egui::FontId::new(body, egui::FontFamily::Proportional)),
            (egui::TextStyle::Button, egui::FontId::new(body, egui::FontFamily::Proportional)),
            (egui::TextStyle::Small, egui::FontId::new(body * 0.73, egui::FontFamily::Proportional)),
            (egui::TextStyle::Monospace, egui::FontId::new(body * 0.87, egui::FontFamily::Monospace)),
        ]
        .into();
        style.spacing.item_spacing = egui::vec2(self.space(0.45), self.space(0.4));
        style.spacing.button_padding = egui::vec2(self.space(0.6), self.space(0.35));
        style.spacing.interact_size.y = self.space(1.9);
        style.animation_time = 0.12;
        ctx.set_style(style);
    }
}
