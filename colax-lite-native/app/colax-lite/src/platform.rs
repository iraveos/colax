//! The handful of Win32 calls the vault UI needs directly.
//!
//! Clipboard and the file-open dialog are the two places where the OS, not
//! the engine, owns the data: neither belongs in `colax-core` (which stays
//! UI-free) nor in the shell's autostart/window code.
//!
//! windows-sys 0.61 carries the clipboard but not the classic common
//! dialogs, so `GetOpenFileNameW` is resolved from comdlg32 at runtime
//! against a hand-written `OPENFILENAMEW` -- the struct has been frozen
//! since Windows 2000, and the alternative would be pulling in the whole
//! `windows` crate for one dialog.

use std::path::PathBuf;
use std::time::Duration;

/// Puts UTF-16 text on the system clipboard.
///
/// Retries a few times because another process can hold the clipboard open
/// for a moment; `OpenClipboard` failing is the common transient case, not
/// an error worth surfacing on its own.
pub fn copy_text(text: &str) -> bool {
    use windows_sys::Win32::Foundation::GlobalFree;
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
    };
    use windows_sys::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE,
    };
    use windows_sys::Win32::System::Ole::CF_UNICODETEXT;

    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let bytes = wide.len() * std::mem::size_of::<u16>();

    for attempt in 0..5 {
        if attempt > 0 {
            std::thread::sleep(Duration::from_millis(10));
        }
        // SAFETY: `wide` outlives every call below; ownership of the allocated
        // block transfers to the system only on the successful SetClipboardData
        // path, and every early exit frees it again.
        unsafe {
            if OpenClipboard(std::ptr::null_mut()) == 0 {
                continue;
            }

            let mut success = false;
            EmptyClipboard();

            let block = GlobalAlloc(GMEM_MOVEABLE, bytes);
            if !block.is_null() {
                let ptr = GlobalLock(block);
                if !ptr.is_null() {
                    std::ptr::copy_nonoverlapping(
                        wide.as_ptr() as *const u8,
                        ptr as *mut u8,
                        bytes,
                    );
                    GlobalUnlock(block);
                    // On success the system owns `block`; on failure we do.
                    success = !SetClipboardData(CF_UNICODETEXT as u32, block).is_null();
                    if !success {
                        GlobalFree(block);
                    }
                } else {
                    GlobalFree(block);
                }
            }

            CloseClipboard();
            if success {
                return true;
            }
        }
    }
    false
}

/// Reads UTF-16 text off the system clipboard, or `None` when the
/// clipboard holds no text at all (empty, a picture, or unopenable).
///
/// The auto-clear checks this before wiping: at the deadline the clipboard
/// must still hold *our* text, so a password copied elsewhere in the
/// meantime is left alone rather than destroyed (Task 6.4). `None` reads
/// as "not ours" there, which is the safe direction.
pub fn read_text() -> Option<String> {
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, OpenClipboard,
    };
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
    use windows_sys::Win32::System::Ole::CF_UNICODETEXT;

    for attempt in 0..5 {
        if attempt > 0 {
            std::thread::sleep(Duration::from_millis(10));
        }
        // SAFETY: the handle belongs to the system while the clipboard is
        // open and is never freed here; the lock is taken only to read and
        // released again below, and the bytes are copied out into an owned
        // `String` before the clipboard closes.
        unsafe {
            if OpenClipboard(std::ptr::null_mut()) == 0 {
                continue; // another process has it: the common transient case
            }
            let mut text = None;
            let handle = GetClipboardData(CF_UNICODETEXT as u32);
            if !handle.is_null() {
                let ptr = GlobalLock(handle);
                if !ptr.is_null() {
                    // The NUL walk is bounded by the block's real size, so
                    // a clipboard written without its terminator must not
                    // be read past its end.
                    let capacity = GlobalSize(handle) / std::mem::size_of::<u16>();
                    let wide = ptr as *const u16;
                    let mut len = 0usize;
                    while len < capacity && *wide.add(len) != 0 {
                        len += 1;
                    }
                    text = Some(String::from_utf16_lossy(std::slice::from_raw_parts(
                        wide, len,
                    )));
                    GlobalUnlock(handle);
                }
            }
            CloseClipboard();
            // Opened successfully means the answer is this one -- `None`
            // for "no text on it", not "try again".
            return text;
        }
    }
    None
}

/// The Win32 `OPENFILENAMEW`, x64 layout (`comdlg.h`; stable since 2000).
///
/// Field-for-field with the C struct: the padding after the leading `DWORD`
/// and between the `WORD` pair and the next pointer is the platform's own
/// alignment, which `#[repr(C)]` reproduces.
#[repr(C)]
#[derive(Default)]
struct OpenFileNameW {
    l_struct_size: u32,
    hwnd_owner: isize,
    h_instance: isize,
    lpstr_filter: *const u16,
    lpstr_custom_filter: *mut u16,
    n_max_custom_filter: u32,
    n_filter_index: u32,
    lpstr_file: *mut u16,
    n_max_file: u32,
    lpstr_file_title: *mut u16,
    n_max_file_title: u32,
    lpstr_initial_dir: *const u16,
    lpstr_title: *const u16,
    flags: u32,
    n_file_offset: u16,
    n_file_extension: u16,
    lpstr_def_ext: *const u16,
    l_cust_data: isize,
    lpfn_hook: isize,
    lp_template_name: *const u16,
    pv_reserved: *mut std::ffi::c_void,
    dw_reserved: u32,
    flags_ex: u32,
}

type GetOpenFileNameWFn = unsafe extern "system" fn(*mut OpenFileNameW) -> i32;
type GetSaveFileNameWFn = unsafe extern "system" fn(*mut OpenFileNameW) -> i32;

// OFN_* from <comdlg.h>.
const OFN_OVERWRITEPROMPT: u32 = 0x0000_0002;
const OFN_NOCHANGEDIR: u32 = 0x0000_0008;
const OFN_PATHMUSTEXIST: u32 = 0x0000_0800;
const OFN_FILEMUSTEXIST: u32 = 0x0000_1000;
const OFN_EXPLORER: u32 = 0x0008_0000;

/// Modal "open file" dialog, restricted to backups, returning the chosen path.
///
/// Blocking on purpose: the dialog runs its own message loop, and the UI has
/// nothing to do meanwhile -- the pick *is* the next step of the import flow.
pub fn pick_backup_file(owner: isize) -> Option<PathBuf> {
    pick_file(owner, "Colax backups (*.json)\0*.json\0All files (*.*)\0*.*\0\0")
}

/// The same dialog for a sound file: Settings › Alarms' "Import sound",
/// whose picker is `accept="audio/*"` (AlarmsPanel.tsx L153-159).
pub fn pick_sound_file(owner: isize) -> Option<PathBuf> {
    pick_file(
        owner,
        "Sound files (*.wav;*.mp3;*.ogg;*.flac;*.m4a)\0*.wav;*.mp3;*.ogg;*.flac;*.m4a\0All files (*.*)\0*.*\0\0",
    )
}

/// The same dialog filtered to CSV: Settings › Data's "Import from CSV",
/// whose picker is `accept="text/csv,.csv"` (Settings.tsx L1485).
pub fn pick_csv_file(owner: isize) -> Option<PathBuf> {
    pick_file(owner, "CSV files (*.csv)\0*.csv\0All files (*.*)\0*.*\0\0")
}

/// Modal "save file" dialog, pre-named and restricted to the caller's
/// filter, returning the chosen path. The write counterpart of `pick_file`:
/// the Data tab's CSV export and the Backup tab's export both hand the user
/// a download in the TS, and a file with a sensible name here.
pub fn save_file(
    owner: isize,
    filter: &str,
    default_name: &str,
    default_ext: &str,
) -> Option<PathBuf> {
    use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};

    // SAFETY: comdlg32 is a system DLL that lives for the process; a failed
    // load or a missing export means no dialog, not UB.
    let get_save_file_name: GetSaveFileNameWFn = unsafe {
        let module = LoadLibraryW(windows_sys::core::w!("comdlg32.dll"));
        if module.is_null() {
            return None;
        }
        let proc = GetProcAddress(module, c"GetSaveFileNameW".as_ptr().cast())?;
        std::mem::transmute(proc)
    };

    let filter: Vec<u16> = filter.encode_utf16().collect();
    let ext: Vec<u16> = default_ext
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let mut buffer = vec![0u16; 4096];
    // The dialog opens with the default name already in the box; the user
    // only has to pick a folder (or edit it). The 4096 slots bound the copy.
    for (slot, ch) in buffer.iter_mut().zip(default_name.encode_utf16()) {
        *slot = ch;
    }

    // SAFETY: every pointer below points at a local that outlives the call;
    // the struct is zeroed first so fields left unset (no hook, no title)
    // are documented nulls rather than stack garbage. The call runs the
    // dialog's own modal loop and returns with the buffer filled or the
    // user having cancelled.
    unsafe {
        let mut dialog = OpenFileNameW {
            l_struct_size: std::mem::size_of::<OpenFileNameW>() as u32,
            hwnd_owner: owner,
            lpstr_filter: filter.as_ptr(),
            lpstr_file: buffer.as_mut_ptr(),
            n_max_file: buffer.len() as u32,
            lpstr_def_ext: ext.as_ptr(),
            flags: OFN_EXPLORER | OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR,
            ..Default::default()
        };

        if get_save_file_name(&mut dialog) == 0 {
            return None; // cancelled, or the common-dialog error path
        }
    }

    let len = buffer.iter().position(|&c| c == 0)?;
    Some(PathBuf::from(String::from_utf16_lossy(&buffer[..len])))
}

/// `save_file` with the two filters this app writes: the CSV export and the
/// JSON backup download.
pub fn save_csv_file(owner: isize, default_name: &str) -> Option<PathBuf> {
    save_file(
        owner,
        "CSV files (*.csv)\0*.csv\0All files (*.*)\0*.*\0\0",
        default_name,
        "csv",
    )
}

pub fn save_backup_file(owner: isize, default_name: &str) -> Option<PathBuf> {
    save_file(
        owner,
        "Colax backups (*.json)\0*.json\0All files (*.*)\0*.*\0\0",
        default_name,
        "json",
    )
}

/// One run of comdlg32's `GetOpenFileNameW`, with the caller's filter string
/// (already double-NUL terminated: "label\0pattern\0…\0\0").
fn pick_file(owner: isize, filter: &str) -> Option<PathBuf> {
    use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};

    // SAFETY: comdlg32 is a system DLL that lives for the process; a failed
    // load or a missing export means no dialog, not UB.
    let get_open_file_name: GetOpenFileNameWFn = unsafe {
        let module = LoadLibraryW(windows_sys::core::w!("comdlg32.dll"));
        if module.is_null() {
            return None;
        }
        let proc = GetProcAddress(module, c"GetOpenFileNameW".as_ptr().cast())?;
        std::mem::transmute(proc)
    };

    let filter: Vec<u16> = filter.encode_utf16().collect();
    let mut buffer = vec![0u16; 4096];

    // SAFETY: every pointer below points at a local that outlives the call;
    // the struct is zeroed first so fields left unset (no hook, no title)
    // are documented nulls rather than stack garbage. The call runs the
    // dialog's own modal loop and returns with the buffer filled or the
    // user having cancelled.
    unsafe {
        let mut dialog = OpenFileNameW {
            l_struct_size: std::mem::size_of::<OpenFileNameW>() as u32,
            hwnd_owner: owner,
            lpstr_filter: filter.as_ptr(),
            lpstr_file: buffer.as_mut_ptr(),
            n_max_file: buffer.len() as u32,
            flags: OFN_EXPLORER | OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR,
            ..Default::default()
        };

        if get_open_file_name(&mut dialog) == 0 {
            return None; // cancelled, or the common-dialog error path
        }
    }

    let len = buffer.iter().position(|&c| c == 0)?;
    Some(PathBuf::from(String::from_utf16_lossy(&buffer[..len])))
}
