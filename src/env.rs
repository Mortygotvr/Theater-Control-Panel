//! WebView2 environments. Every webview uses the shared one (the docks and
//! windows through wry, and the sources), except Theater Web Sources whose audio goes
//! to OBS: each of those gets its own, so its browser processes, and so its
//! sound, are its own (see audio.rs). All webviews of an environment share its
//! browser processes, and a second environment on the same profile folder but
//! with other options would fail, so they're all created here, asynchronously,
//! on the UI thread.

use std::cell::RefCell;
use std::collections::HashMap;

use webview2_com::CreateCoreWebView2EnvironmentCompletedHandler;
use webview2_com::CoreWebView2EnvironmentOptions;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    CreateCoreWebView2EnvironmentWithOptions, ICoreWebView2Environment, ICoreWebView2EnvironmentOptions,
};
use windows::core::{HSTRING, PCWSTR};

use crate::obs;

/// The shared environment's profile folder, in plugin_config\theater-control-panel.
const SHARED: &str = "webview2";

/// Chromium flags for every webview: wry's defaults plus the Control Panel's,
/// which keep hidden and covered pages (chats, automation, sources) running at
/// full speed.
///
/// `--edge-webview-unique-window-class` is required next to obs-browser: CEF and
/// WebView2 otherwise both register Chrome_WidgetWin_* window classes in OBS's
/// process, and CEF crashes on its next windowed browser (MicrosoftEdge/
/// WebView2Feedback#4343, cefsharp/CefSharp#4702).
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,\
CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,\
ThrottleDisplayNoneAndVisibilityHiddenCrossOriginIframes,ThrottleScriptExecutionOnOccludedWindows \
--disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling \
--edge-webview-unique-window-class";

type Waiter = Box<dyn FnOnce(Result<ICoreWebView2Environment, String>)>;

enum State {
    Creating(Vec<Waiter>),
    Ready(ICoreWebView2Environment),
    Failed(String),
}

thread_local! {
    /// By profile folder.
    static ENVIRONMENTS: RefCell<HashMap<String, State>> = RefCell::default();
}

/// The shared environment, if it's been created.
pub fn get() -> Option<Result<ICoreWebView2Environment, String>> {
    ENVIRONMENTS.with_borrow(|envs| match envs.get(SHARED)? {
        State::Ready(env) => Some(Ok(env.clone())),
        State::Failed(e) => Some(Err(e.clone())),
        State::Creating(_) => None,
    })
}

/// Calls `f` with the shared environment, creating it first if needed.
pub fn with(f: impl FnOnce(Result<ICoreWebView2Environment, String>) + 'static) {
    with_profile(SHARED, f);
}

/// Calls `f` with the environment on `folder` (relative to plugin_config\theater-control-panel),
/// creating it first if needed. `f` runs from the UI thread's message loop, or
/// right away if the environment is ready.
pub fn with_profile(folder: &str, f: impl FnOnce(Result<ICoreWebView2Environment, String>) + 'static) {
    let ready = ENVIRONMENTS.with_borrow(|envs| match envs.get(folder) {
        Some(State::Ready(env)) => Some(Ok(env.clone())),
        Some(State::Failed(e)) => Some(Err(e.clone())),
        _ => None,
    });
    if let Some(result) = ready {
        return f(result);
    }
    let start = ENVIRONMENTS.with_borrow_mut(|envs| match envs.get_mut(folder) {
        Some(State::Creating(waiters)) => {
            waiters.push(Box::new(f));
            false
        }
        _ => {
            envs.insert(folder.to_string(), State::Creating(vec![Box::new(f)]));
            true
        }
    });
    if start && let Err(e) = create(folder) {
        finish(folder, Err(e));
    }
}

/// Drops one environment (its browser processes exit once its webviews are
/// closed too).
pub fn release_profile(folder: &str) {
    let old = ENVIRONMENTS.with_borrow_mut(|envs| envs.remove(folder));
    drop(old);
}

/// Drops every environment. Runs on OBS exit, after every webview is closed.
pub fn release() {
    let old = ENVIRONMENTS.take();
    drop(old);
}

fn create(folder: &str) -> Result<(), String> {
    let data_dir = obs::module_config_path(folder).ok_or("no plugin config path")?;
    let options = CoreWebView2EnvironmentOptions::default();
    // Plus the ⚡ Performance GPU options (the same for every environment of a run)
    unsafe { options.set_additional_browser_arguments(format!("{BROWSER_ARGS}{}", crate::perf::browser_flags())) };
    let key = folder.to_string();
    let handler = CreateCoreWebView2EnvironmentCompletedHandler::create(Box::new(move |result, environment| {
        let environment = result
            .map_err(|e| e.to_string())
            .and_then(|()| environment.ok_or_else(|| "no environment".to_string()));
        crate::guard("WebView2 environment", || finish(&key, environment));
        Ok(())
    }));
    unsafe {
        CreateCoreWebView2EnvironmentWithOptions(
            PCWSTR::null(),
            &HSTRING::from(data_dir.as_os_str()),
            &ICoreWebView2EnvironmentOptions::from(options),
            &handler,
        )
    }
    .map_err(|e| e.to_string())
}

fn finish(folder: &str, result: Result<ICoreWebView2Environment, String>) {
    if let Err(e) = &result {
        obs::log(obs::LOG_ERROR, &format!("can't create the WebView2 environment in {folder}: {e}"));
    }
    let waiters = ENVIRONMENTS.with_borrow_mut(|envs| {
        let state = match &result {
            Ok(env) => State::Ready(env.clone()),
            Err(e) => State::Failed(e.clone()),
        };
        match envs.insert(folder.to_string(), state) {
            Some(State::Creating(waiters)) => waiters,
            _ => Vec::new(),
        }
    });
    for waiter in waiters {
        waiter(result.clone());
    }
}
