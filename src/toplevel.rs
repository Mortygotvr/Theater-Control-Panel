//! Top-level windows owned by OBS's main window: OAuth and login popups,
//! hidden automation pages, and app windows (the Control Panel settings).

use std::rc::Rc;
use std::sync::Once;

use serde_json::Value;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::HiDpi::GetDpiForWindow;
use windows::Win32::UI::WindowsAndMessaging::{
    CW_USEDEFAULT, CreateWindowExW, DefWindowProcW, DestroyWindow, GWLP_USERDATA, GetWindowLongPtrW, IDC_ARROW,
    IsIconic, IsWindow, IsWindowVisible, LoadCursorW, RegisterClassExW, SW_HIDE, SW_RESTORE, SW_SHOW, SetForegroundWindow,
    SetWindowLongPtrW, ShowWindow, WINDOW_EX_STYLE, WM_CLOSE, WNDCLASSEXW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    WS_EX_TOPMOST, WS_OVERLAPPEDWINDOW, WS_VISIBLE,
};
use windows::core::{HSTRING, PCWSTR, w};
use wry::WebViewBuilder;

use crate::app::{self, App};
use crate::views::{self, Kind, Spec};
use crate::{obs, ui, win32};

const CLASS_NAME: PCWSTR = w!("TheaterControlPanelWindow");
/// GWLP_USERDATA marker for windows that hide instead of closing.
const KEEP: isize = 1;

#[derive(Clone, Copy, PartialEq)]
enum Style {
    /// A normal window, shown right away.
    Shown,
    /// A normal window created hidden; closing it only hides it again.
    Kept,
    /// Invisible, and never shows up anywhere (automation pages).
    Hidden,
}

struct Options<'a> {
    title: &'a str,
    /// Logical pixels.
    width: i32,
    height: i32,
    style: Style,
    on_top: bool,
}

/// OAuth popup: closes itself and emits `event` (with the URL) as soon as it
/// navigates to `redirect_prefix`.
pub fn open_oauth(url: String, redirect_prefix: String, event: String, done: impl FnOnce(Result<(), String>) + 'static) {
    const LABEL: &str = "oauth_flow";
    views::close(LABEL);
    let options = Options { title: "Authorization", width: 600, height: 700, style: Style::Shown, on_top: true };
    open(
        LABEL,
        url,
        options,
        None,
        move |b| {
            b.with_navigation_handler(move |target| {
                if !target.starts_with(&redirect_prefix) {
                    return true;
                }
                // Deferred: the webview can't be closed from inside its own callback.
                let event = event.clone();
                ui::post(move || {
                    views::emit(&event, &Value::String(target));
                    views::close(LABEL);
                });
                false
            })
        },
        done,
    );
}

/// A login popup for a service whose cookies automation pages rely on.
pub fn open_service_login(url: String, title: String, done: impl FnOnce(Result<(), String>) + 'static) {
    const LABEL: &str = "service_login";
    if show(LABEL) {
        return done(Ok(()));
    }
    let options = Options { title: &title, width: 800, height: 700, style: Style::Shown, on_top: true };
    open(LABEL, url, options, None, |b| b, done);
}

/// An invisible page for automation; `init_js` runs in every document it loads.
pub fn open_hidden(label: &str, url: String, init_js: Option<String>, done: impl FnOnce(Result<(), String>) + 'static) {
    let options = Options { title: "", width: 100, height: 100, style: Style::Hidden, on_top: false };
    open(
        label,
        url,
        options,
        None,
        move |b| match init_js {
            Some(js) => b.with_initialization_script(js),
            None => b,
        },
        done,
    );
}

/// A window showing `page` of `app`, with the Tauri bridge. It starts hidden,
/// and closing it only hides it: the page keeps running until OBS exits.
pub fn open_app_window(label: &str, title: &str, app: Rc<App>, page: &str, done: impl FnOnce(Result<(), String>) + 'static) {
    if views::exists(label) {
        return done(Ok(()));
    }
    let url = app.url(page);
    let options = Options { title, width: 1000, height: 750, style: Style::Kept, on_top: false };
    let (bridge_app, bridge_label) = (app.clone(), label.to_string());
    open(label, url, options, Some(app), move |b| app::configure(b, &bridge_app, &bridge_label), done);
}

/// Whether the window under `label` is on screen.
pub fn is_visible(label: &str) -> bool {
    views::with(label, |v| unsafe { IsWindowVisible(win32::hwnd(v.parent)) }.as_bool()).unwrap_or(false)
}

/// Shows the window under `label` and brings it to the front. False if there's
/// none, open or on its way.
pub fn show(label: &str) -> bool {
    if let Some(hwnd) = views::with(label, |v| v.parent) {
        let hwnd = win32::hwnd(hwnd);
        unsafe {
            let restore = if IsIconic(hwnd).as_bool() { SW_RESTORE } else { SW_SHOW };
            let _ = ShowWindow(hwnd, restore);
            let _ = SetForegroundWindow(hwnd);
        }
    }
    views::exists(label)
}

fn open(
    label: &str,
    url: String,
    options: Options,
    app: Option<Rc<App>>,
    configure: impl for<'b> FnOnce(WebViewBuilder<'b>) -> WebViewBuilder<'b> + 'static,
    done: impl FnOnce(Result<(), String>) + 'static,
) {
    let hwnd = match create_window(&options) {
        Ok(hwnd) => hwnd,
        Err(e) => return done(Err(e)),
    };
    let parent = hwnd.0 as isize;
    let focused = options.style == Style::Shown;
    let spec = Spec { label: label.to_string(), parent, as_child: false, kind: Kind::Window, app };
    views::create(spec, move |b| configure(b.with_url(url).with_focused(focused)), move |result| {
        if result.is_err() {
            unsafe {
                if IsWindow(Some(hwnd)).as_bool() {
                    let _ = DestroyWindow(hwnd);
                }
            }
        }
        done(result);
    });
}

fn create_window(options: &Options) -> Result<HWND, String> {
    let instance = unsafe { GetModuleHandleW(None) }.map_err(|e| e.to_string())?;
    static REGISTER: Once = Once::new();
    REGISTER.call_once(|| unsafe {
        let class = WNDCLASSEXW {
            cbSize: size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(window_proc),
            hInstance: instance.into(),
            hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
            lpszClassName: CLASS_NAME,
            ..Default::default()
        };
        RegisterClassExW(&class);
    });

    let owner = win32::hwnd(unsafe { obs::obs_frontend_get_main_window_handle() } as isize);
    let dpi = match unsafe { GetDpiForWindow(owner) } {
        0 => 96,
        dpi => dpi,
    };
    let scale = |logical: i32| logical * dpi as i32 / 96;

    let mut ex_style = WINDOW_EX_STYLE::default();
    if options.on_top {
        ex_style |= WS_EX_TOPMOST;
    }
    if options.style == Style::Hidden {
        ex_style |= WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
    }
    let mut style = WS_OVERLAPPEDWINDOW;
    if options.style == Style::Shown {
        style |= WS_VISIBLE;
    }
    let hwnd = unsafe {
        CreateWindowExW(
            ex_style,
            CLASS_NAME,
            &HSTRING::from(options.title),
            style,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            scale(options.width),
            scale(options.height),
            (!owner.is_invalid()).then_some(owner),
            None,
            Some(instance.into()),
            None,
        )
    }
    .map_err(|e| e.to_string())?;
    if options.style == Style::Kept {
        unsafe { SetWindowLongPtrW(hwnd, GWLP_USERDATA, KEEP) };
    }
    Ok(hwnd)
}

unsafe extern "system" fn window_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if msg == WM_CLOSE {
        if unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) } == KEEP {
            unsafe {
                let _ = ShowWindow(hwnd, SW_HIDE);
            }
            return LRESULT(0);
        }
        crate::guard("closing window", || match views::window_label(hwnd.0 as isize) {
            Some(label) => views::close(&label),
            None => unsafe {
                let _ = DestroyWindow(hwnd);
            },
        });
        return LRESULT(0);
    }
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}
