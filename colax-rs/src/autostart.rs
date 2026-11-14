//! Launching Colax when the user signs in.
//!
//! The per-user `Run` key is deliberately used instead of a scheduled task or a
//! service: it needs no elevation, the uninstaller can remove it, and it is the
//! one autostart mechanism a normal user can see and delete in Task Manager.

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
#[cfg(windows)]
/// Deliberately not "Colax": the Electron build's sign-in entry already uses
/// `electron.app.Colax`, and an uninstall here must never remove that one.
const VALUE_NAME: &str = "ColaxNative";
/// `CREATE_NO_WINDOW`: `reg.exe` must not flash a console behind the app.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Adds or removes the sign-in entry, and is called on every launch while the
/// setting is on so that reinstalling to a new folder repairs a stale path.
#[cfg(windows)]
pub fn apply(enabled: bool) -> Result<(), String> {
    let mut command = std::process::Command::new("reg");
    if enabled {
        let exe = std::env::current_exe()
            .map_err(|error| format!("could not find the app's own path: {error}"))?;
        command.args([
            "add",
            RUN_KEY,
            "/v",
            VALUE_NAME,
            "/t",
            "REG_SZ",
            "/d",
            &format!("\"{}\"", exe.display()),
            "/f",
        ]);
    } else {
        command.args(["delete", RUN_KEY, "/v", VALUE_NAME, "/f"]);
    }
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command
        .output()
        .map_err(|error| format!("could not reach the registry: {error}"))?;
    // Removing an entry that was never there is the state the caller asked for.
    if output.status.success() || !enabled {
        Ok(())
    } else {
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if message.is_empty() { "the registry refused the change".into() } else { message })
    }
}

#[cfg(not(windows))]
pub fn apply(_enabled: bool) -> Result<(), String> {
    Err("launching at sign-in is only wired up on Windows".into())
}
