//! The Qt shim compiled from qt/control_panel_qt.cpp by build.rs.

use std::ffi::{c_char, c_void};

pub type MenuCallback = unsafe extern "C" fn(user_data: *mut c_void);

unsafe extern "C" {
    pub fn control_panel_qt_create_dock_widget(main_window: *mut c_void, object_name: *const c_char) -> *mut c_void;
    pub fn control_panel_qt_native_handle(widget: *mut c_void) -> usize;
    pub fn control_panel_qt_delete_widget(widget: *mut c_void);
    pub fn control_panel_qt_plugin_menu(
        main_window: *mut c_void,
        shared_name: *const c_char,
        shared_title: *const c_char,
        plugin_name: *const c_char,
    ) -> *mut c_void;
    pub fn control_panel_qt_add_menu_item(
        menu: *mut c_void,
        object_name: *const c_char,
        text: *const c_char,
        icon_path: *const c_char,
        callback: MenuCallback,
        user_data: *mut c_void,
    ) -> bool;
    pub fn control_panel_qt_add_menu_separator(menu: *mut c_void, object_name: *const c_char);
    pub fn control_panel_qt_show_dock(main_window: *mut c_void, widget: *mut c_void);
    pub fn control_panel_qt_set_dock_minimum_size(main_window: *mut c_void, dock_name: *const c_char, width: i32, height: i32) -> bool;
}
