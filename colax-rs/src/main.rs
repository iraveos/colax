//! Colax, native edition.
//!
//! The Electron app in the folder above is the reference; this crate ports its
//! shell, editor, settings groups, docks, roadmap and data exchange to Rust with
//! egui. The vault file is separate from the Electron one, and a password on it
//! is Argon2id + AES-256-GCM rather than the browser build's WebCrypto envelope.

mod app;
mod autostart;
mod editor;
mod icon;
mod io;
mod model;
mod roadmap;
mod settings;
mod theme;
mod totp;
mod views;

fn main() -> eframe::Result<()> {
    // `--screenshot`, `--view`, `--scope` and `--size` are the UI review
    // harness; with no flags the app opens normally.
    let launch = app::Launch::parse(std::env::args().skip(1));
    let size = launch.size.unwrap_or((1280.0, 840.0));
    // The window icon is the same PNG the installer and shortcut use, so the
    // taskbar entry and the Start menu entry look like one product.
    let icon = eframe::icon_data::from_png_bytes(include_bytes!("../assets/icon.png"))
        .expect("assets/icon.png is a valid PNG");
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([size.0, size.1])
            .with_min_inner_size([980.0, 640.0])
            // "Colax Native", not "Colax": the installer finds this window by its
            // exact title to close a running copy before an upgrade, and it must
            // never match the Electron app's window.
            .with_title(format!("{} Native", app::APP_NAME))
            .with_icon(std::sync::Arc::new(icon)),
        ..Default::default()
    };
    eframe::run_native(
        "Colax",
        options,
        Box::new(move |cc| Ok(Box::new(app::App::new(cc, launch)))),
    )
}
