//! This plugin's group of items in the "Theater" menu that all our plugins
//! share: one top-level menu in OBS's menu bar, found by object name, where each
//! plugin adds its items directly, in a group of its own after a separator. The
//! contract every plugin follows is in docs/shared-menu.md; these names must
//! match it exactly.

use std::ffi::{CStr, CString, c_void};
use std::path::Path;
use std::ptr;

use crate::obs::cstring;
use crate::qt::{self, MenuCallback};

/// Object name of the shared top-level menu.
const SHARED_MENU_NAME: &CStr = c"theater_menu";
/// Its title, set by whichever plugin creates it first.
const SHARED_MENU_TITLE: &CStr = c"🎭 Theater";
/// Object name of each of this plugin's items.
const PLUGIN_NAME: &CStr = c"theater-control-panel";

/// This plugin's group in the shared menu.
pub struct PluginMenu {
    menu: *mut c_void,
    /// The image every item of the group shows as its icon.
    icon: Option<CString>,
}

impl PluginMenu {
    /// Starts this plugin's group, after removing its items from an earlier
    /// registration; its items show the image at `icon` (if it exists) as their
    /// icon. UI thread only.
    pub fn new(main_window: *mut c_void, icon: &Path) -> Option<PluginMenu> {
        let menu = unsafe {
            qt::control_panel_qt_plugin_menu(
                main_window,
                SHARED_MENU_NAME.as_ptr(),
                SHARED_MENU_TITLE.as_ptr(),
                PLUGIN_NAME.as_ptr(),
            )
        };
        let icon = icon.is_file().then(|| cstring(&icon.to_string_lossy()));
        (!menu.is_null()).then_some(PluginMenu { menu, icon })
    }

    /// Adds an item that calls `callback(user_data)` when clicked.
    pub fn add_item(&self, text: &CStr, callback: MenuCallback, user_data: *mut c_void) -> bool {
        let icon = self.icon.as_deref().map_or(ptr::null(), CStr::as_ptr);
        unsafe {
            qt::control_panel_qt_add_menu_item(self.menu, PLUGIN_NAME.as_ptr(), text.as_ptr(), icon, callback, user_data)
        }
    }

    pub fn add_separator(&self) {
        unsafe { qt::control_panel_qt_add_menu_separator(self.menu, PLUGIN_NAME.as_ptr()) };
    }
}
