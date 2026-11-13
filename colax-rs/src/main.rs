//! Colax, native edition.
//!
//! The Electron app in the folder above is the reference; this crate ports its
//! shell, editor, settings groups, docks, roadmap and data exchange to Rust with
//! egui. The vault file is separate from the Electron one, and a password on it
//! is Argon2id + AES-256-GCM rather than the browser build's WebCrypto envelope.

mod app;
mod editor;
mod icon;
mod io;
mod model;
mod roadmap;
mod settings;
mod theme;
mod views;

fn main() -> eframe::Result<()> {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([1280.0, 840.0])
            .with_min_inner_size([980.0, 640.0])
            .with_title("Colax"),
        ..Default::default()
    };
    eframe::run_native(
        "Colax",
        options,
        Box::new(|cc| Ok(Box::new(app::App::new(cc)))),
    )
}
