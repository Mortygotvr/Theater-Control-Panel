//! Every webview this plugin owns, by label, and what they share.
//!
//! All of this lives on OBS's UI thread. Creating a WebView2 runs a nested
//! message loop until it's ready, so webviews are built one at a time from the
//! UI task queue (`create`), never inside an OBS callback, a WebView2 event
//! handler or another build. `STATE` is only borrowed briefly: never across a
//! build, and never while dropping a webview.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::collections::HashMap;
use std::num::NonZeroIsize;
use std::rc::Rc;

use raw_window_handle::{HandleError, HasWindowHandle, RawWindowHandle, Win32WindowHandle, WindowHandle};
use serde_json::Value;
use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Environment;
use windows::Win32::UI::WindowsAndMessaging::{DestroyWindow, IsWindow};
use wry::{WebView, WebViewBuilder, WebViewBuilderExtWindows, WebViewExtWindows};

use crate::app::App;
use crate::{env, ui, win32};

#[derive(Clone, Copy, PartialEq)]
pub enum Kind {
    Dock,
    /// Fills a top-level window this plugin created; the window goes with it.
    Window,
    /// Placed inside another view's window (a Control Panel web tab).
    Child,
}

pub struct View {
    pub webview: WebView,
    /// The window the webview lives in.
    pub parent: isize,
    pub kind: Kind,
    /// Set for pages served from an app folder: they get the Tauri bridge and events.
    pub app: Option<Rc<App>>,
}

/// Where a new webview goes and what it becomes once built.
pub struct Spec {
    pub label: String,
    pub parent: isize,
    /// At the builder's bounds inside `parent`, instead of filling it.
    pub as_child: bool,
    pub kind: Kind,
    pub app: Option<Rc<App>>,
}

type Configure = Box<dyn for<'b> FnOnce(WebViewBuilder<'b>) -> WebViewBuilder<'b>>;
type Done = Box<dyn FnOnce(Result<(), String>)>;

struct Job {
    spec: Spec,
    configure: Configure,
    done: Done,
}

#[derive(Default)]
struct State {
    views: HashMap<String, View>,
    /// Labels queued or being built; `close` cancels by removing them.
    pending: HashMap<String, Kind>,
    queue: VecDeque<Job>,
    building: bool,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::default();
}

struct ParentWindow(NonZeroIsize);

impl HasWindowHandle for ParentWindow {
    fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
        let raw = RawWindowHandle::Win32(Win32WindowHandle::new(self.0));
        // Checked with IsWindow right before the build.
        Ok(unsafe { WindowHandle::borrow_raw(raw) })
    }
}

/// Queues a webview. `done` runs once it's registered under `spec.label`, or
/// with the error if it couldn't be built or was closed first.
pub fn create(
    spec: Spec,
    configure: impl for<'b> FnOnce(WebViewBuilder<'b>) -> WebViewBuilder<'b> + 'static,
    done: impl FnOnce(Result<(), String>) + 'static,
) {
    if ui::shutting_down() {
        return done(Err("OBS is shutting down".into()));
    }
    STATE.with_borrow_mut(|s| {
        s.pending.insert(spec.label.clone(), spec.kind);
        s.queue.push_back(Job { spec, configure: Box::new(configure), done: Box::new(done) });
    });
    ui::post(build_next);
}

fn build_next() {
    if STATE.with_borrow(|s| s.building || s.queue.is_empty()) {
        return;
    }
    // The shared environment first; it's created asynchronously on first use.
    let environment = match env::get() {
        Some(environment) => environment,
        None => return env::with(|_| ui::post(build_next)),
    };
    let job = STATE.with_borrow_mut(|s| {
        let job = s.queue.pop_front();
        s.building = job.is_some();
        job
    });
    let Some(Job { spec, configure, done }) = job else { return };

    let built = environment.and_then(|environment| build(spec.parent, spec.as_child, environment, configure));
    let wanted = STATE.with_borrow_mut(|s| {
        s.building = false;
        s.pending.remove(&spec.label).is_some()
    });
    let result = match built {
        Ok(webview) if wanted && !ui::shutting_down() => {
            let view = View { webview, parent: spec.parent, kind: spec.kind, app: spec.app };
            insert(spec.label, view);
            Ok(())
        }
        Ok(webview) => {
            drop(webview);
            Err("closed before it finished loading".into())
        }
        Err(e) => Err(e),
    };
    done(result);

    if STATE.with_borrow(|s| !s.queue.is_empty()) {
        ui::post(build_next);
    }
}

fn build(
    parent: isize,
    as_child: bool,
    environment: ICoreWebView2Environment,
    configure: Configure,
) -> Result<WebView, String> {
    if ui::shutting_down() {
        return Err("OBS is shutting down".into());
    }
    if !unsafe { IsWindow(Some(win32::hwnd(parent))) }.as_bool() {
        return Err("its window is gone".into());
    }
    let parent = ParentWindow(NonZeroIsize::new(parent).ok_or("no parent window")?);
    let builder = WebViewBuilder::new().with_environment(environment).with_devtools(true);
    let builder = configure(builder);
    let webview = if as_child { builder.build_as_child(&parent) } else { builder.build(&parent) }
        .map_err(|e| e.to_string())?;

    win32::clip_siblings(webview.hwnd());
    Ok(webview)
}

fn insert(label: String, view: View) {
    let replaced = STATE.with_borrow_mut(|s| s.views.insert(label, view));
    if let Some(old) = replaced {
        dispose(old);
    }
}

/// Whether `label` exists or is on its way.
pub fn exists(label: &str) -> bool {
    STATE.with_borrow(|s| s.views.contains_key(label) || s.pending.contains_key(label))
}

pub fn with<R>(label: &str, f: impl FnOnce(&View) -> R) -> Option<R> {
    STATE.with_borrow(|s| s.views.get(label).map(f))
}

/// Like `with`, but only for web tabs: pages can't reach docks or windows
/// through the child webview commands.
pub fn with_child<R>(label: &str, f: impl FnOnce(&View) -> R) -> Option<R> {
    STATE.with_borrow(|s| s.views.get(label).filter(|v| v.kind == Kind::Child).map(f))
}

pub fn close_child(label: &str) {
    let is_child = STATE.with_borrow(|s| match s.views.get(label) {
        Some(view) => view.kind == Kind::Child,
        // A web tab still being built: `close` cancels it.
        None => s.pending.get(label) == Some(&Kind::Child),
    });
    if is_child {
        close(label);
    }
}

pub fn app_of(label: &str) -> Option<Rc<App>> {
    with(label, |v| v.app.clone()).flatten()
}

pub fn labels_of(kind: Kind) -> Vec<String> {
    STATE.with_borrow(|s| s.views.iter().filter(|(_, v)| v.kind == kind).map(|(l, _)| l.clone()).collect())
}

/// The view filling the top-level window `hwnd`.
pub fn window_label(hwnd: isize) -> Option<String> {
    STATE.with_borrow(|s| {
        s.views
            .iter()
            .find(|(_, v)| v.kind == Kind::Window && v.parent == hwnd)
            .map(|(l, _)| l.clone())
    })
}

pub fn eval(label: &str, js: &str) {
    with(label, |v| {
        let _ = v.webview.evaluate_script(js);
    });
}

/// Delivers an event to every app page, like Tauri's global `emit`.
pub fn emit(event: &str, payload: &Value) {
    let event = Value::from(event);
    let js = format!("window.__TAURI_OBS__&&window.__TAURI_OBS__.dispatch({event},{payload})");
    STATE.with_borrow(|s| {
        for view in s.views.values().filter(|v| v.app.is_some()) {
            let _ = view.webview.evaluate_script(&js);
        }
    });
}

/// Closes a view, or cancels it if it's still queued. Closing a dock's or
/// window's view also closes the web tabs inside it, and a window view takes
/// its window along.
pub fn close(label: &str) {
    let view = STATE.with_borrow_mut(|s| {
        s.pending.remove(label);
        s.views.remove(label)
    });
    let Some(view) = view else { return };
    if view.kind != Kind::Child {
        drop(take_children(view.parent));
    }
    dispose(view);
}

/// Removes the web tabs inside window `parent` (to be dropped outside the borrow).
fn take_children(parent: isize) -> Vec<View> {
    STATE.with_borrow_mut(|s| {
        let labels: Vec<String> = s
            .views
            .iter()
            .filter(|(_, v)| v.kind == Kind::Child && v.parent == parent)
            .map(|(l, _)| l.clone())
            .collect();
        labels.iter().filter_map(|l| s.views.remove(l)).collect()
    })
}

/// Closes the web tabs of the view `label`: its page is loading a new
/// document (reload, navigation), which knows nothing of the old page's tabs.
/// Left open, they stayed on screen, no longer moved, resized or switched by
/// the page, and blocked the new page from creating tabs of the same name.
pub fn close_children_of(label: &str) {
    let Some(parent) = with(label, |v| (v.kind != Kind::Child).then_some(v.parent)).flatten() else { return };
    drop(take_children(parent));
}

/// Closes everything and drops queued webviews. Runs on OBS exit, before Qt
/// tears its windows down.
pub fn close_all() {
    let (views, queue) = STATE.with_borrow_mut(|s| {
        s.pending.clear();
        (std::mem::take(&mut s.views), std::mem::take(&mut s.queue))
    });
    drop(queue);
    let (children, others): (Vec<View>, Vec<View>) = views.into_values().partition(|v| v.kind == Kind::Child);
    drop(children);
    others.into_iter().for_each(dispose);
}

fn dispose(view: View) {
    let window = (view.kind == Kind::Window).then_some(view.parent);
    drop(view);
    if let Some(hwnd) = window {
        unsafe {
            let _ = DestroyWindow(win32::hwnd(hwnd));
        }
    }
}
