//! Appearance: resolve preferences into design tokens and push them into the
//! Slint `Theme` global.
//!
//! Port of `applyAppearance()` in `src/ui/hooks.ts` (L353-415). The web build
//! writes CSS custom properties; this build sets the same values as Slint
//! properties, because Slint has no `hsl()` and no `var()` — every colour is
//! resolved here, from the same formulas `tokens.css` uses (ADR-2).
//!
//! Three jobs, in order:
//!   1. **Resolve** the theme (`system` -> whatever Windows reports) and the
//!      accent (a name -> two hues).
//!   2. **Derive** the palette: each token is `hsl(h s% l% / a)`, evaluated in
//!      Rust, per tokens.css's dark and light blocks.
//!   3. **Push** the scalars too: roundness -> radii, density -> spacing
//!      multiplier, textScale -> ui-scale, plus the motion switches.
//!
//! Nothing here touches the engine; it takes a `&VaultPreferences` so the
//! settings screen can call it live while the user drags a slider.
use colax_core::VaultPreferences;
use slint::ComponentHandle;

use crate::{MainWindow, Theme};

/// The palette this build ships with, before preferences are known. Kept in
/// sync with the defaults in `theme.slint`.
const DARK: Palette = Palette {
    bg: (220.0, 22.0, 7.0, 1.0),
    bg_deep: (220.0, 24.0, 5.0, 1.0),
    card: (220.0, 18.0, 7.0, 1.0),
    surface: (220.0, 18.0, 12.0, 1.0),
    surface_raised: (220.0, 18.0, 15.0, 1.0),
    surface_hover: (220.0, 18.0, 19.0, 1.0),
    plate: (220.0, 14.0, 100.0, 0.05),
    glass: (220.0, 30.0, 100.0, 0.05),
    glass_strong: (220.0, 30.0, 100.0, 0.085),
    text: (220.0, 26.0, 96.0, 1.0),
    muted: (220.0, 12.0, 68.0, 1.0),
    faint: (220.0, 10.0, 50.0, 1.0),
    border: (220.0, 20.0, 100.0, 0.09),
    border_strong: (220.0, 20.0, 100.0, 0.17),
    field: (220.0, 20.0, 100.0, 0.06),
    field_focus: (220.0, 20.0, 100.0, 0.10),
    row_hover: (220.0, 20.0, 100.0, 0.04),
    hairline: (220.0, 20.0, 100.0, 0.063),
    danger: (357.0, 62.0, 68.0, 1.0),
    danger_soft: (357.0, 62.0, 68.0, 0.15),
    warn: (38.0, 76.0, 66.0, 1.0),
    warn_soft: (38.0, 76.0, 66.0, 0.15),
    good: (152.0, 45.0, 60.0, 1.0),
    good_soft: (152.0, 45.0, 60.0, 0.15),
};

const LIGHT: Palette = Palette {
    bg: (210.0, 30.0, 96.0, 1.0),
    bg_deep: (210.0, 26.0, 91.0, 1.0),
    card: (0.0, 0.0, 100.0, 1.0),
    surface: (0.0, 0.0, 100.0, 1.0),
    surface_raised: (0.0, 0.0, 100.0, 1.0),
    surface_hover: (210.0, 30.0, 95.0, 1.0),
    plate: (222.0, 20.0, 12.0, 0.045),
    glass: (0.0, 0.0, 100.0, 0.62),
    glass_strong: (0.0, 0.0, 100.0, 0.80),
    text: (222.0, 30.0, 13.0, 1.0),
    muted: (222.0, 12.0, 44.0, 1.0),
    faint: (222.0, 10.0, 58.0, 1.0),
    border: (210.0, 20.0, 87.0, 1.0),
    border_strong: (210.0, 16.0, 76.0, 1.0),
    field: (222.0, 20.0, 12.0, 0.05),
    field_focus: (222.0, 20.0, 12.0, 0.09),
    row_hover: (210.0, 30.0, 93.0, 1.0),
    hairline: (210.0, 20.0, 87.0, 1.0),
    danger: (357.0, 58.0, 52.0, 1.0),
    danger_soft: (357.0, 58.0, 54.0, 0.10),
    warn: (32.0, 74.0, 44.0, 1.0),
    warn_soft: (32.0, 74.0, 48.0, 0.13),
    good: (152.0, 55.0, 38.0, 1.0),
    good_soft: (152.0, 55.0, 40.0, 0.12),
};

/// One theme's tokens, as `(h, s, l, a)` — the shape `hsl()` is written in.
struct Palette {
    bg: Rgba,
    bg_deep: Rgba,
    card: Rgba,
    surface: Rgba,
    surface_raised: Rgba,
    surface_hover: Rgba,
    plate: Rgba,
    glass: Rgba,
    glass_strong: Rgba,
    text: Rgba,
    muted: Rgba,
    faint: Rgba,
    border: Rgba,
    border_strong: Rgba,
    field: Rgba,
    field_focus: Rgba,
    row_hover: Rgba,
    hairline: Rgba,
    danger: Rgba,
    danger_soft: Rgba,
    warn: Rgba,
    warn_soft: Rgba,
    good: Rgba,
    good_soft: Rgba,
}

type Rgba = (f64, f64, f64, f64);

/// The accent hues, from `tokens.css` L76-L104: the calm set plus the older
/// stored names that map onto it.
fn accent_hues(name: &str) -> (f64, f64) {
    match name {
        "sage" | "mint" => (152.0, 172.0),
        "dusk" | "nebula" | "orchid" => (268.0, 232.0),
        "clay" | "sunset" | "ember" => (28.0, 348.0),
        // "slate" and everything unknown, including "aurora".
        _ => (212.0, 196.0),
    }
}

/// `hsl(h s% l% / a)` as a Slint colour. The same conversion CSS does.
/// `pub(crate)` because the editor's Appearance preview and swatch row need
/// the same conversion, and there is no reason for two of them.
pub(crate) fn hsl(h: f64, s: f64, l: f64, a: f64) -> slint::Color {
    let s = (s / 100.0).clamp(0.0, 1.0);
    let l = (l / 100.0).clamp(0.0, 1.0);
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let hp = ((h % 360.0) + 360.0) % 360.0 / 60.0;
    let x = c * (1.0 - (hp % 2.0 - 1.0).abs());
    let (r1, g1, b1) = match hp as i32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let m = l - c / 2.0;
    slint::Color::from_argb_u8(
        (a.clamp(0.0, 1.0) * 255.0).round() as u8,
        ((r1 + m) * 255.0).round().clamp(0.0, 255.0) as u8,
        ((g1 + m) * 255.0).round().clamp(0.0, 255.0) as u8,
        ((b1 + m) * 255.0).round().clamp(0.0, 255.0) as u8,
    )
}

/// Windows' own light/dark switch, for `theme: 'system'`. Falls back to dark
/// when the key is absent (server SKUs, or a profile that never chose).
fn system_prefers_light() -> bool {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::ERROR_SUCCESS;
        use windows_sys::Win32::System::Registry::{
            RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ,
        };

        const PATH: &str = r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";
        const VALUE: &str = "AppsUseLightTheme";

        let path: Vec<u16> = PATH.encode_utf16().chain(std::iter::once(0)).collect();
        let value: Vec<u16> = VALUE.encode_utf16().chain(std::iter::once(0)).collect();
        let mut key: HKEY = std::ptr::null_mut();
        let open = unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, path.as_ptr(), 0, KEY_READ, &mut key) };
        if open != ERROR_SUCCESS {
            return false;
        }
        let mut ty: u32 = 0;
        let mut size: u32 = 0;
        let mut data: u32 = 0;
        let query = unsafe {
            RegQueryValueExW(
                key,
                value.as_ptr(),
                std::ptr::null_mut(),
                &mut ty,
                (&mut data as *mut u32).cast(),
                &mut size,
            )
        };
        unsafe { RegCloseKey(key) };
        query == ERROR_SUCCESS && size == 4 && data == 1
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// The DENSITY_SCALE table from `hooks.ts` L463.
fn density_scale(name: &str) -> f64 {
    match name {
        "compact" => 0.74,
        "spacious" => 1.24,
        _ => 1.0,
    }
}

/// One chip of the accent grid in the Settings window: `linear-gradient(
/// 135deg, hsl(from 40% 56%), hsl(to 36% 46%))` from `Settings.tsx` L543,
/// resolved through the same hue table the app paints with so the swatch
/// can never drift from the accent it picks. Returns (from, to).
pub(crate) fn accent_chip(id: &str) -> (slint::Color, slint::Color) {
    let (h, h2) = accent_hues(id);
    (hsl(h, 40.0, 56.0, 1.0), hsl(h2, 36.0, 46.0, 1.0))
}

/// `theme: 'system'` -> whatever Windows reports; anything unrecognised is
/// dark, the same fallback `tokens.css` takes for an unknown `[data-theme]`.
fn resolve_theme(pref: &str) -> &'static str {
    match pref {
        "light" => "light",
        "dark" => "dark",
        "system" => {
            if system_prefers_light() {
                "light"
            } else {
                "dark"
            }
        }
        _ => "dark",
    }
}

/// Resolves and pushes every token. Call at boot, and again from the settings
/// screen whenever an appearance preference changes — it is idempotent and
/// cheap (a few hundred arithmetic ops, no I/O except the one registry read).
pub fn apply_appearance(ui: &MainWindow, prefs: &VaultPreferences) {
    let resolved = resolve_theme(&prefs.theme);
    let dark = resolved == "dark";
    let base = if dark { &DARK } else { &LIGHT };
    let (h, h2) = accent_hues(&prefs.accent);

    let theme = ui.global::<Theme>();

    macro_rules! paint {
        ($setter:ident, $token:expr) => {
            theme.$setter(hsl($token.0, $token.1, $token.2, $token.3));
        };
    }

    theme.set_resolved_theme(resolved.into());

    paint!(set_bg, base.bg);
    paint!(set_bg_deep, base.bg_deep);
    paint!(set_card, base.card);
    paint!(set_surface, base.surface);
    paint!(set_surface_raised, base.surface_raised);
    paint!(set_surface_hover, base.surface_hover);
    paint!(set_plate, base.plate);
    paint!(set_glass, base.glass);
    paint!(set_glass_strong, base.glass_strong);
    paint!(set_text, base.text);
    paint!(set_muted, base.muted);
    paint!(set_faint, base.faint);
    paint!(set_border, base.border);
    paint!(set_border_strong, base.border_strong);
    paint!(set_field, base.field);
    paint!(set_field_focus, base.field_focus);
    paint!(set_row_hover, base.row_hover);
    paint!(set_hairline, base.hairline);
    paint!(set_danger, base.danger);
    paint!(set_danger_soft, base.danger_soft);
    paint!(set_warn, base.warn);
    paint!(set_warn_soft, base.warn_soft);
    paint!(set_good, base.good);
    paint!(set_good_soft, base.good_soft);

    // The accent set, on top of whatever the base palette said: hsl(var(--accent-h) ...)
    theme.set_accent(hsl(h, 42.0, 62.0, 1.0));
    theme.set_accent_hover(hsl(h, 46.0, 70.0, 1.0));
    theme.set_accent_strong(hsl(h, 46.0, 70.0, 1.0));
    theme.set_accent_press(hsl(h, 44.0, 52.0, 1.0));
    theme.set_accent_soft(hsl(h, 42.0, 62.0, 0.16));
    theme.set_accent_text(hsl(h, 50.0, if dark { 76.0 } else { 34.0 }, 1.0));
    theme.set_border_focus(hsl(h, if dark { 45.0 } else { 40.0 }, if dark { 66.0 } else { 46.0 }, 1.0));
    theme.set_grad_from(hsl(h, 44.0, if dark { 58.0 } else { 48.0 }, 1.0));
    theme.set_grad_to(hsl(h2, if dark { 40.0 } else { 38.0 }, if dark { 62.0 } else { 52.0 }, 1.0));

    // The ambient mesh's three circles (tokens.css L223-225 dark, L320-322
    // light), and the strength the Background tab's slider asks for. The
    // third circle is the accent shifted 30 degrees, which is what keeps the
    // mesh from reading as one flat tint.
    theme.set_ambient(prefs.ambient as f32);
    if dark {
        theme.set_ambient_1(hsl(h, 55.0, 48.0, 0.42));
        theme.set_ambient_2(hsl(h2, 52.0, 52.0, 0.34));
        theme.set_ambient_3(hsl(h + 30.0, 50.0, 50.0, 0.22));
    } else {
        theme.set_ambient_1(hsl(h, 62.0, 62.0, 0.32));
        theme.set_ambient_2(hsl(h2, 58.0, 64.0, 0.26));
        theme.set_ambient_3(hsl(h + 30.0, 58.0, 62.0, 0.18));
    }

    // -- Scalars ----------------------------------------------------------
    // Radii derive from one scalar so they stay in proportion (hooks.ts L382).
    let round = prefs.roundness;
    theme.set_radius_sm((8.0 * round) as f32);
    theme.set_radius_md((12.0 * round) as f32);
    theme.set_radius_lg((18.0 * round) as f32);
    theme.set_radius_xl((26.0 * round) as f32);
    theme.set_radius_2xl((34.0 * round) as f32);

    theme.set_density(density_scale(&prefs.density) as f32);
    theme.set_ui_scale((prefs.text_scale / 100.0) as f32);
    // motion 0 disables animation entirely; the speed scalar divides every
    // duration. Slint's durations are per-transition, so the widgets read
    // `motion` for on/off and multiply by `motion-speed`.
    theme.set_motion(prefs.motion as f32);
    theme.set_motion_speed(prefs.motion_speed as f32);
    // `microMotion` is the second half of the motion story: the TS's
    // `[data-micro='on']` block (app.css L1682) is what turns a colour swap
    // into a transition at all, and `[data-motion='off']` overrides it back
    // to instant. `Theme.fast`/`Theme.normal` already answer the second
    // half, so only the switch itself is pushed here.
    theme.set_micro(prefs.micro_motion);
    theme.set_card_depth(prefs.card_depth as f32);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rgb(c: slint::Color) -> (u8, u8, u8, u8) {
        (c.red(), c.green(), c.blue(), c.alpha())
    }

    #[test]
    fn hsl_matches_the_css_conversion_at_the_known_stops() {
        // hsl(0 0% 100%) = white, hsl(0 0% 0%) = black, hsl(0 100% 50%) = red.
        assert_eq!(rgb(hsl(0.0, 0.0, 100.0, 1.0)), (255, 255, 255, 255));
        assert_eq!(rgb(hsl(0.0, 0.0, 0.0, 1.0)), (0, 0, 0, 255));
        assert_eq!(rgb(hsl(0.0, 100.0, 50.0, 1.0)), (255, 0, 0, 255));
        // hsl(120 100% 50%) = lime.
        assert_eq!(rgb(hsl(120.0, 100.0, 50.0, 1.0)), (0, 255, 0, 255));
    }

    #[test]
    fn hsl_carries_alpha_as_a_byte() {
        let (_, _, _, a) = rgb(hsl(212.0, 42.0, 62.0, 0.16));
        assert_eq!(a, 41); // 0.16 * 255 rounds to 41
        let (_, _, _, a) = rgb(hsl(212.0, 42.0, 62.0, 1.0));
        assert_eq!(a, 255);
    }

    #[test]
    fn hsl_wraps_hues_outside_the_circle() {
        // 360 and 0 are the same colour; -20 is 340.
        assert_eq!(rgb(hsl(360.0, 100.0, 50.0, 1.0)), rgb(hsl(0.0, 100.0, 50.0, 1.0)));
        assert_eq!(rgb(hsl(-20.0, 100.0, 50.0, 1.0)), rgb(hsl(340.0, 100.0, 50.0, 1.0)));
    }

    #[test]
    fn the_slate_accent_is_the_documented_hue() {
        // tokens.css [data-accent='slate'] -> --accent-h: 212.
        let (h, h2) = accent_hues("slate");
        assert_eq!((h, h2), (212.0, 196.0));
        // The older stored names map onto the calm set.
        assert_eq!(accent_hues("aurora"), (212.0, 196.0));
        assert_eq!(accent_hues("mint"), (152.0, 172.0));
        assert_eq!(accent_hues("orchid"), (268.0, 232.0));
        assert_eq!(accent_hues("ember"), (28.0, 348.0));
        // And an unknown one degrades to slate rather than to nothing.
        assert_eq!(accent_hues("chartreuse"), (212.0, 196.0));
    }

    #[test]
    fn density_matches_the_typescript_table() {
        assert_eq!(density_scale("compact"), 0.74);
        assert_eq!(density_scale("comfortable"), 1.0);
        assert_eq!(density_scale("spacious"), 1.24);
        assert_eq!(density_scale("jammed"), 1.0);
    }

    #[test]
    fn theme_resolution_falls_back_to_dark() {
        assert_eq!(resolve_theme("light"), "light");
        assert_eq!(resolve_theme("dark"), "dark");
        assert_eq!(resolve_theme("neon"), "dark");
        assert_eq!(resolve_theme("system"), resolve_theme("system")); // stable within a run
    }
}
