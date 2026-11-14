#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Colax, Tauri 2 edition.
//!
//! The frontend is the Electron app's own `dist` build, unmodified: the React
//! code talks to `window.platform` and nothing else, so this shell's whole job
//! is to provide that object and the two OS capabilities the UI can reach.

use tauri::{WebviewUrl, WebviewWindowBuilder};

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![app_version, open_external])
        .setup(|app| {
            let script =
                include_str!("platform.js").replace("__APP_VERSION__", env!("CARGO_PKG_VERSION"));
            WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("Colax")
                .inner_size(1280.0, 840.0)
                .min_inner_size(900.0, 600.0)
                .theme(Some(tauri::Theme::Dark))
                .initialization_script(&script)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Colax");
}

#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Opens a URL in the user's real browser. Only the three schemes the UI ever
/// passes are allowed, so a crafted vault entry cannot launch arbitrary code.
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    let allowed = ["http://", "https://", "mailto:"];
    if !allowed.iter().any(|scheme| url.starts_with(scheme)) {
        return Err(format!("refused to open {url}"));
    }
    open::that(url).map_err(|error| error.to_string())
}
