//! Web tabs: webviews an app page places inside its own window
//! (create_child_webview & co). In the Tauri app they're separate top-level
//! windows kept on top of the panel; here they're real child windows of the
//! dock or window, so they move, hide and close with it.

use serde::Deserialize;
use serde_json::json;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL, ICoreWebView2_8,
    ICoreWebView2_19,
};
use webview2_com::ZoomFactorChangedEventHandler;
use windows::core::Interface;
use wry::dpi::{LogicalPosition, LogicalSize};
use wry::{Rect, WebView, WebViewExtWindows};

use crate::views::{self, Kind, Spec};
use crate::win32;

const USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const FAKE_FULLSCREEN_JS: &str = include_str!("fake_fullscreen.js");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateArgs {
    label: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    zoom: Option<f64>,
    visible: Option<bool>,
    muted: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateArgs {
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    focus: Option<bool>,
}

/// Page coordinates (CSS pixels) to bounds in the caller's window.
fn bounds(x: f64, y: f64, width: f64, height: f64) -> Rect {
    Rect {
        position: LogicalPosition::new(x, y).into(),
        size: LogicalSize::new(width.max(1.0), height.max(1.0)).into(),
    }
}

/// Queues the web tab; `done` gets the outcome once it's built.
pub fn create(caller: &str, args: CreateArgs, done: impl FnOnce(Result<(), String>) + 'static) {
    // A web tab of that name is one the page lost track of (it reloaded while
    // the tab was on its way): the new one replaces it
    views::close_child(&args.label);
    if views::exists(&args.label) {
        return done(Err(format!("a webview with label `{}` already exists", args.label)));
    }
    let Some(parent) = views::with(caller, |v| v.parent) else {
        return done(Err("unknown caller".into()));
    };
    let init = format!("window.__cpInitialZoom = {};\n{FAKE_FULLSCREEN_JS}", args.zoom.unwrap_or(1.0));
    let rect = bounds(args.x, args.y, args.width, args.height);
    let (label, visible, muted, zoom) = (args.label, args.visible.unwrap_or(true), args.muted, args.zoom);
    let spec = Spec { label: label.clone(), parent, as_child: true, kind: Kind::Child, app: None };
    let url = args.url;
    views::create(
        spec,
        move |b| {
            b.with_url(url)
                .with_user_agent(USER_AGENT)
                .with_initialization_script(init)
                .with_hotkeys_zoom(true)
                .with_visible(visible)
                .with_focused(false)
                .with_bounds(rect)
        },
        move |result| {
            if result.is_ok() {
                views::with_child(&label, |v| {
                    if muted == Some(true) {
                        set_muted(&v.webview, true);
                    }
                    if let Some(zoom) = zoom {
                        let _ = v.webview.zoom(zoom);
                    }
                    report_zoom_changes(&v.webview, label.clone());
                });
            }
            done(result);
        },
    );
}

pub fn update(args: UpdateArgs) {
    if PARKED.with_borrow_mut(|parked| parked.remove(&args.label)) {
        views::with_child(&args.label, |v| set_low_memory(&v.webview, false));
    }
    views::with_child(&args.label, |v| {
        let _ = v.webview.set_bounds(bounds(args.x, args.y, args.width, args.height));
        let _ = v.webview.set_visible(true);
        win32::raise(v.webview.hwnd());
        if args.focus == Some(true) {
            let _ = v.webview.focus();
        }
    });
}

/// Parks the web tab outside its window instead of hiding it, so the page keeps
/// running (the Tauri app makes the window fully transparent for the same reason).
pub fn hide(label: &str) {
    let low = crate::perf::get().parked_tabs_low_memory;
    views::with_child(label, |v| {
        if let Ok(mut rect) = v.webview.bounds() {
            rect.position = LogicalPosition::new(-32000.0, -32000.0).into();
            let _ = v.webview.set_bounds(rect);
        }
        if low {
            set_low_memory(&v.webview, true);
        }
    });
    PARKED.with_borrow_mut(|parked| parked.insert(label.to_string()));
}

thread_local! {
    /// The web tabs parked outside their window (hide), by label
    static PARKED: std::cell::RefCell<std::collections::HashSet<String>> = std::cell::RefCell::default();
}

/// WebView2's low-memory mode on or off: the page runs on either way, but in
/// it WebView2 lets go of what it keeps for drawing the page (redrawn when
/// it's shown again). Older WebView2 runtimes don't have it: nothing happens.
fn set_low_memory(webview: &WebView, low: bool) {
    if let Ok(core) = webview.webview().cast::<ICoreWebView2_19>() {
        let level = if low { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW } else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL };
        unsafe {
            let _ = core.SetMemoryUsageTargetLevel(level);
        }
    }
}

/// The ⚡ Performance option changed: the parked tabs follow it.
pub fn apply_parked_memory() {
    let low = crate::perf::get().parked_tabs_low_memory;
    let parked: Vec<String> = PARKED.with_borrow(|parked| parked.iter().cloned().collect());
    for label in parked {
        views::with_child(&label, |v| set_low_memory(&v.webview, low));
    }
}

pub fn set_muted(webview: &WebView, muted: bool) {
    if let Ok(core) = webview.webview().cast::<ICoreWebView2_8>() {
        unsafe {
            let _ = core.SetIsMuted(muted);
        }
    }
}

/// Ctrl+wheel / Ctrl+± zoom inside a web tab → "child-zoom-changed", so the
/// panel can remember the tab's zoom.
fn report_zoom_changes(webview: &WebView, label: String) {
    let handler = ZoomFactorChangedEventHandler::create(Box::new(move |controller, _args| {
        let mut zoom = 1.0;
        if let Some(controller) = controller
            && unsafe { controller.ZoomFactor(&mut zoom) }.is_ok()
        {
            views::emit("child-zoom-changed", &json!({ "label": label, "zoom": zoom }));
        }
        Ok(())
    }));
    let mut token = 0;
    unsafe {
        let _ = webview.controller().add_ZoomFactorChanged(&handler, &mut token);
    }
}
