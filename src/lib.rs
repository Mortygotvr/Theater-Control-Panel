//! Theater Control Panel: the Control Panel inside OBS Studio. The Control Panel's
//! Tauri frontend runs in an OBS dock on wry/WebView2 (obs-browser uses CEF),
//! with its Tauri commands served by this plugin through a `window.__TAURI__`
//! bridge.

mod app;
mod audio;
mod bridge;
mod child;
mod commands;
mod convert;
mod dock_layout;
mod env;
mod menu;
mod obs;
mod panel;
mod perf;
mod procs;
mod qt;
mod source;
mod toplevel;
mod ui;
mod views;
mod win32;

use std::ffi::{c_char, c_int, c_void};
use std::panic::{self, AssertUnwindSafe};
use std::ptr;

/// Panicking across the FFI boundary would abort OBS: log the panic instead.
pub(crate) fn guard<R>(what: &str, f: impl FnOnce() -> R) -> Option<R> {
    panic::catch_unwind(AssertUnwindSafe(f))
        .map_err(|_| obs::log(obs::LOG_ERROR, &format!("{what} failed (panic)")))
        .ok()
}

#[unsafe(no_mangle)]
pub extern "C" fn obs_module_set_pointer(module: *mut c_void) {
    obs::set_module(module);
}

/// LIBOBS_API_VER 30.0.0: obs_frontend_add_dock_by_id needs OBS 30 or newer.
#[unsafe(no_mangle)]
pub extern "C" fn obs_module_ver() -> u32 {
    30 << 24
}

#[unsafe(no_mangle)]
pub extern "C" fn obs_module_name() -> *const c_char {
    c"Theater Control Panel".as_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn obs_module_description() -> *const c_char {
    c"The Theater Control Panel in an OBS dock, on WebView2 (wry) with a Tauri API bridge.".as_ptr()
}

#[unsafe(no_mangle)]
pub extern "C" fn obs_module_load() -> bool {
    panic::set_hook(Box::new(|info| obs::log(obs::LOG_ERROR, &format!("panic: {info}"))));
    ui::init();
    win32::pin_module();
    guard("obs_module_load", || {
        // First: everything below reads the config folder
        obs::move_old_config_folder();
        unsafe { obs::obs_frontend_add_event_callback(on_frontend_event, ptr::null_mut()) };
        // Before OBS saves a new layout, and before panel::register adds the dock
        // Before OBS loads its scene collection
        convert::at_load();
        dock_layout::remember();
        panel::register();
        source::register();
    });
    true
}

#[unsafe(no_mangle)]
pub extern "C" fn obs_module_unload() {
    guard("obs_module_unload", || {
        unsafe { obs::obs_frontend_remove_event_callback(on_frontend_event, ptr::null_mut()) };
        shut_down();
        ui::cleanup();
    });
}

/// Closes every webview while Qt's windows still exist.
fn shut_down() {
    ui::begin_shutdown();
    views::close_all();
    source::close_all();
    env::release();
}

unsafe extern "C" fn on_frontend_event(event: c_int, _private_data: *mut c_void) {
    guard("frontend event", || match event {
        obs::OBS_FRONTEND_EVENT_FINISHED_LOADING => {
            panel::attach_webview();
            dock_layout::restore();
        }
        obs::OBS_FRONTEND_EVENT_EXIT => shut_down(),
        _ => {}
    });
}
