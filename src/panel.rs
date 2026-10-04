//! The Control Panel (served from the plugin's data folder with the
//! `window.__TAURI__` bridge) and its items in the shared Theater menu
//! (src/menu.rs). It's two pages of the same frontend:
//! - the dock (`?view=dock`): the button grid and web tabs;
//! - the settings window (`?view=settings`): Control Deck, Global Variables and
//!   Modules. It's where the modules, triggers and connections run, so it's
//!   created hidden when OBS starts and closing it only hides it.
//!
//! Like obs-browser's QCefWidget on Windows, the dock's browser window is a
//! native child of the dock's widget.

use std::cell::RefCell;
use std::ffi::{CStr, c_void};
use std::path::Path;
use std::rc::Rc;

use crate::app::{self, App};
use crate::obs::{self, log_info, log_warn};
use crate::views::{self, Kind, Spec};
use crate::menu::PluginMenu;
use crate::{qt, toplevel, win32};

/// Also the app's data folder name (plugin_config\theater-control-panel\apps\control_panel).
const ID: &str = "control_panel";
/// OBS saves the dock's position under this id.
const DOCK_ID: &CStr = c"theater_control_panel";
const TITLE: &CStr = c"Control Panel";
/// The frontend's folder inside the plugin's data folder.
const FOLDER: &str = "control-panel";
/// The app's icon, in its folder; also the icon of its menu items.
const ICON: &str = "icon.png";
const DOCK_PAGE: &str = "control_panel.html?view=dock";
const DOCK_LABEL: &str = "dock:control_panel";
const SETTINGS_PAGE: &str = "control_panel.html?view=settings";
const SETTINGS_LABEL: &str = "settings:control_panel";
const SETTINGS_TITLE: &str = "Control Panel Settings";

struct Panel {
    /// The dock's content widget; owned by OBS once registered.
    widget: *mut c_void,
    app: Rc<App>,
}

thread_local! {
    static PANEL: RefCell<Option<Panel>> = const { RefCell::new(None) };
}

/// Registers the dock and the menu. Runs from obs_module_load, so OBS can
/// restore the dock's saved layout; the webview comes later, in `attach_webview`.
pub fn register() {
    let Some(root) = obs::module_file(FOLDER) else {
        return log_warn!("'{FOLDER}' is missing from the plugin's data folder; no Control Panel");
    };
    let icon = root.join(ICON);
    let Some(app) = App::new(ID, root) else {
        return log_warn!("no plugin config path; no Control Panel");
    };
    let main_window = unsafe { obs::obs_frontend_get_main_window() };
    if main_window.is_null() {
        return log_warn!("OBS main window not available; no Control Panel");
    }
    let widget = unsafe { qt::control_panel_qt_create_dock_widget(main_window, DOCK_ID.as_ptr()) };
    if widget.is_null() {
        return;
    }
    if !unsafe { obs::obs_frontend_add_dock_by_id(DOCK_ID.as_ptr(), TITLE.as_ptr(), widget) } {
        unsafe { qt::control_panel_qt_delete_widget(widget) };
        return log_warn!("the Control Panel dock id is already in use");
    }
    add_menu(main_window, &icon);
    PANEL.set(Some(Panel { widget, app: Rc::new(app) }));
    log_info!("registered the Control Panel");
}

/// Queues the dock's webview and the hidden settings window. Runs once OBS has
/// finished loading, from its startup code, so it only takes the dock's window
/// handle here: the builds run later from the UI task queue.
pub fn attach_webview() {
    open_views(false);
}

/// Queues whichever of the dock's webview and the settings window isn't there;
/// `show_settings`: show the settings window once it's built.
fn open_views(show_settings: bool) {
    let Some((widget, app)) = PANEL.with_borrow(|p| p.as_ref().map(|p| (p.widget, p.app.clone()))) else {
        return;
    };
    if !views::exists(DOCK_LABEL) {
        let hwnd = unsafe { qt::control_panel_qt_native_handle(widget) } as isize;
        if hwnd == 0 {
            log_warn!("the Control Panel dock has no native window");
        } else {
            win32::clip_children(win32::hwnd(hwnd));
            let url = app.url(DOCK_PAGE);
            let dock_app = app.clone();
            let spec = Spec { label: DOCK_LABEL.into(), parent: hwnd, as_child: false, kind: Kind::Dock, app: Some(app.clone()) };
            views::create(
                spec,
                move |b| app::configure(b.with_url(url), &dock_app, DOCK_LABEL),
                |result| match result {
                    Ok(()) => log_info!("Control Panel dock loaded"),
                    Err(e) => log_warn!("can't create the Control Panel dock's webview: {e}"),
                },
            );
        }
    }
    toplevel::open_app_window(SETTINGS_LABEL, SETTINGS_TITLE, app, SETTINGS_PAGE, move |result| match result {
        Ok(()) => {
            log_info!("Control Panel settings loaded");
            if show_settings {
                toplevel::show(SETTINGS_LABEL);
            }
        }
        Err(e) => log_warn!("can't create the Control Panel settings window: {e}"),
    });
}

/// The whole Control Panel again, as at OBS start: its dock page, its settings
/// window (where the modules, triggers and connections run) and every web tab
/// are closed and built anew. A page reload left the web tabs behind, and
/// didn't help once the dock had stopped following the page.
fn reload() {
    let settings_shown = toplevel::is_visible(SETTINGS_LABEL);
    views::close(DOCK_LABEL);
    views::close(SETTINGS_LABEL);
    log_info!("reloading the Control Panel");
    open_views(settings_shown);
}

// Menu items; the value is the item's user data.
const SHOW: usize = 1;
const SETTINGS: usize = 2;
const RELOAD: usize = 3;
const CONVERT: usize = 4;

fn add_menu(main_window: *mut c_void, icon: &Path) {
    let Some(menu) = PluginMenu::new(main_window, icon) else {
        return log_warn!("couldn't add the Control Panel to the Theater menu");
    };
    let add_item = |text: &CStr, action: usize| {
        if !menu.add_item(text, on_menu_item, action as *mut c_void) {
            log_warn!("couldn't connect the '{}' menu item", text.to_string_lossy());
        }
    };
    add_item(c"Show Control Panel", SHOW);
    add_item(c"Settings…", SETTINGS);
    menu.add_separator();
    add_item(c"Reload", RELOAD);
    add_item(c"Convert Browser Sources…", CONVERT);
}

unsafe extern "C" fn on_menu_item(user_data: *mut c_void) {
    crate::guard("Control Panel menu", || match user_data as usize {
        SHOW => {
            if let Some(widget) = PANEL.with_borrow(|p| p.as_ref().map(|p| p.widget)) {
                unsafe { qt::control_panel_qt_show_dock(obs::obs_frontend_get_main_window(), widget) };
            }
        }
        SETTINGS if !toplevel::show(SETTINGS_LABEL) => {
            log_warn!("the Control Panel settings window isn't available");
        }
        // Everything from scratch: modules restart and the Startup trigger fires again.
        RELOAD => reload(),
        CONVERT => crate::convert::run(),
        _ => {}
    });
}
