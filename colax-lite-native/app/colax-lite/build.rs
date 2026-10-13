fn main() {
    slint_build::compile("ui/main.slint").expect("failed to compile Slint UI");

    // Embed the same icon the Tauri build used, so the taskbar, the tray and
    // the installer all show the one mark. Needs the Windows SDK's rc.exe,
    // which is on the same PATH cargo already needs for the MSVC toolchain.
    winres::WindowsResource::new()
        .set_icon("assets/icon.ico")
        .set("ProductName", "Colax Lite")
        .set("FileDescription", "Colax Lite")
        .compile()
        .expect("failed to embed exe icon");
}
