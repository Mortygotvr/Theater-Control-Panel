//! Win32 helpers.

use windows::Win32::Foundation::{HMODULE, HWND};
use windows::Win32::System::LibraryLoader::{
    GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS, GET_MODULE_HANDLE_EX_FLAG_PIN, GetModuleHandleExW,
};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::{
    GWL_STYLE, GetWindowLongPtrW, HWND_TOP, SW_SHOWNORMAL, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    SetWindowLongPtrW, SetWindowPos, WINDOW_STYLE, WS_CLIPCHILDREN, WS_CLIPSIBLINGS,
};
use windows::core::{HSTRING, PCWSTR, w};

pub fn hwnd(raw: isize) -> HWND {
    HWND(raw as *mut _)
}

/// Keeps this DLL loaded until the process exits. Worker threads and window
/// procedures (ours and wry's) may still be around when OBS unloads modules,
/// and must never find their code unmapped.
pub fn pin_module() {
    let mut module = HMODULE::default();
    let flags = GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN;
    unsafe {
        let _ = GetModuleHandleExW(flags, PCWSTR(pin_module as *const u16), &mut module);
    }
}

fn add_style(hwnd: HWND, style: WINDOW_STYLE) {
    unsafe {
        let current = GetWindowLongPtrW(hwnd, GWL_STYLE);
        if current & style.0 as isize == 0 {
            SetWindowLongPtrW(hwnd, GWL_STYLE, current | style.0 as isize);
        }
    }
}

/// Keeps a window from painting over the webviews inside it.
pub fn clip_children(hwnd: HWND) {
    add_style(hwnd, WS_CLIPCHILDREN);
}

/// Keeps a webview from painting over sibling webviews that overlap it.
pub fn clip_siblings(hwnd: HWND) {
    add_style(hwnd, WS_CLIPSIBLINGS);
}

/// Puts a child window above its siblings.
pub fn raise(hwnd: HWND) {
    unsafe {
        let _ = SetWindowPos(hwnd, Some(HWND_TOP), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }
}

/// Opens a URL or file with its associated app.
pub fn shell_open(target: &str) -> bool {
    let result = unsafe {
        ShellExecuteW(None, w!("open"), &HSTRING::from(target), PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL)
    };
    result.0 as isize > 32
}
