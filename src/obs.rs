//! The slice of libobs / obs-frontend-api that this plugin uses, plus small helpers.
//!
//! Both are plain C APIs, so they're linked with `raw-dylib`: no headers and no
//! import libraries needed.

use std::ffi::{CStr, CString, c_char, c_int, c_void};
use std::path::PathBuf;
use std::ptr;
use std::sync::atomic::{AtomicPtr, Ordering};

pub const LOG_ERROR: c_int = 100;
pub const LOG_WARNING: c_int = 200;
pub const LOG_INFO: c_int = 300;

// enum obs_frontend_event
pub const OBS_FRONTEND_EVENT_EXIT: c_int = 17;
pub const OBS_FRONTEND_EVENT_FINISHED_LOADING: c_int = 26;

pub type FrontendEventCb = unsafe extern "C" fn(event: c_int, private_data: *mut c_void);

#[link(name = "obs", kind = "raw-dylib")]
unsafe extern "C" {
    pub fn blog(log_level: c_int, format: *const c_char, ...);
    pub fn bfree(ptr: *mut c_void);
    pub fn obs_module_get_config_path(module: *mut c_void, file: *const c_char) -> *mut c_char;
    pub fn obs_find_module_file(module: *mut c_void, file: *const c_char) -> *mut c_char;
    pub fn config_get_string(config: *mut c_void, section: *const c_char, name: *const c_char) -> *const c_char;
    pub fn obs_get_frame_interval_ns() -> u64;
}

// ─── Sources: registration, settings and properties ─────────────────────────

pub const OBS_SOURCE_TYPE_INPUT: c_int = 0;
pub const OBS_SOURCE_VIDEO: u32 = 1 << 0;
pub const OBS_SOURCE_AUDIO: u32 = 1 << 1;
pub const OBS_SOURCE_CUSTOM_DRAW: u32 = 1 << 3;
pub const OBS_SOURCE_INTERACTION: u32 = 1 << 5;
pub const OBS_SOURCE_DO_NOT_DUPLICATE: u32 = 1 << 7;
/// Not offered in Add Source; sources of the type already in scenes still load.
pub const OBS_SOURCE_CAP_OBSOLETE: u32 = 1 << 10;
pub const OBS_SOURCE_SRGB: u32 = 1 << 15;
pub const OBS_TEXT_DEFAULT: c_int = 0;
pub const OBS_TEXT_MULTILINE: c_int = 2;
pub const OBS_PATH_FILE: c_int = 0;

pub type Data = c_void;
pub type Properties = c_void;
pub type Property = c_void;
pub type ClickedCb = unsafe extern "C" fn(props: *mut Properties, property: *mut Property, data: *mut c_void) -> bool;
pub type ModifiedCb = unsafe extern "C" fn(props: *mut Properties, property: *mut Property, settings: *mut Data) -> bool;

// enum obs_mouse_button_type
pub const MOUSE_LEFT: i32 = 0;
pub const MOUSE_MIDDLE: i32 = 1;
pub const MOUSE_RIGHT: i32 = 2;

// enum obs_interaction_flags
pub const INTERACT_SHIFT_KEY: u32 = 1 << 1;
pub const INTERACT_CONTROL_KEY: u32 = 1 << 2;
pub const INTERACT_ALT_KEY: u32 = 1 << 3;
pub const INTERACT_MOUSE_LEFT: u32 = 1 << 4;
pub const INTERACT_MOUSE_MIDDLE: u32 = 1 << 5;
pub const INTERACT_MOUSE_RIGHT: u32 = 1 << 6;
pub const INTERACT_COMMAND_KEY: u32 = 1 << 7;

/// `struct obs_mouse_event`: position in source pixels.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct MouseEvent {
    pub modifiers: u32,
    pub x: i32,
    pub y: i32,
}

/// `struct obs_key_event`.
#[repr(C)]
pub struct KeyEvent {
    pub modifiers: u32,
    pub text: *const c_char,
    pub native_modifiers: u32,
    pub native_scancode: u32,
    pub native_vkey: u32,
}

/// The start of `struct obs_source_info`, up to the callbacks this plugin uses.
/// OBS takes the size, so later fields stay zeroed.
#[repr(C)]
pub struct SourceInfo {
    pub id: *const c_char,
    pub type_: c_int,
    pub output_flags: u32,
    pub get_name: Option<unsafe extern "C" fn(type_data: *mut c_void) -> *const c_char>,
    pub create: Option<unsafe extern "C" fn(settings: *mut Data, source: *mut c_void) -> *mut c_void>,
    pub destroy: Option<unsafe extern "C" fn(data: *mut c_void)>,
    pub get_width: Option<unsafe extern "C" fn(data: *mut c_void) -> u32>,
    pub get_height: Option<unsafe extern "C" fn(data: *mut c_void) -> u32>,
    pub get_defaults: Option<unsafe extern "C" fn(settings: *mut Data)>,
    pub get_properties: Option<unsafe extern "C" fn(data: *mut c_void) -> *mut Properties>,
    pub update: Option<unsafe extern "C" fn(data: *mut c_void, settings: *mut Data)>,
    pub activate: Option<unsafe extern "C" fn(data: *mut c_void)>,
    pub deactivate: Option<unsafe extern "C" fn(data: *mut c_void)>,
    pub show: Option<unsafe extern "C" fn(data: *mut c_void)>,
    pub hide: Option<unsafe extern "C" fn(data: *mut c_void)>,
    pub video_tick: Option<unsafe extern "C" fn(data: *mut c_void, seconds: f32)>,
    pub video_render: Option<unsafe extern "C" fn(data: *mut c_void, effect: *mut c_void)>,
    pub filter_video: Option<unsafe extern "C" fn(data: *mut c_void, frame: *mut c_void) -> *mut c_void>,
    pub filter_audio: Option<unsafe extern "C" fn(data: *mut c_void, audio: *mut c_void) -> *mut c_void>,
    pub enum_active_sources: Option<unsafe extern "C" fn(data: *mut c_void, callback: *mut c_void, param: *mut c_void)>,
    pub save: Option<unsafe extern "C" fn(data: *mut c_void, settings: *mut Data)>,
    pub load: Option<unsafe extern "C" fn(data: *mut c_void, settings: *mut Data)>,
    pub mouse_click: Option<
        unsafe extern "C" fn(data: *mut c_void, event: *const MouseEvent, button: i32, mouse_up: bool, click_count: u32),
    >,
    pub mouse_move: Option<unsafe extern "C" fn(data: *mut c_void, event: *const MouseEvent, mouse_leave: bool)>,
    pub mouse_wheel: Option<unsafe extern "C" fn(data: *mut c_void, event: *const MouseEvent, x_delta: c_int, y_delta: c_int)>,
    pub focus: Option<unsafe extern "C" fn(data: *mut c_void, focus: bool)>,
    pub key_click: Option<unsafe extern "C" fn(data: *mut c_void, event: *const KeyEvent, key_up: bool)>,
}

#[link(name = "obs", kind = "raw-dylib")]
unsafe extern "C" {
    pub fn obs_register_source_s(info: *const SourceInfo, size: usize);

    pub fn obs_data_get_string(data: *mut Data, name: *const c_char) -> *const c_char;
    pub fn obs_data_get_int(data: *mut Data, name: *const c_char) -> i64;
    pub fn obs_data_get_bool(data: *mut Data, name: *const c_char) -> bool;
    pub fn obs_data_set_default_string(data: *mut Data, name: *const c_char, val: *const c_char);
    pub fn obs_data_set_default_int(data: *mut Data, name: *const c_char, val: i64);
    pub fn obs_data_set_default_bool(data: *mut Data, name: *const c_char, val: bool);

    pub fn obs_properties_create() -> *mut Properties;
    pub fn obs_properties_get(props: *mut Properties, name: *const c_char) -> *mut Property;
    pub fn obs_properties_add_bool(props: *mut Properties, name: *const c_char, desc: *const c_char) -> *mut Property;
    pub fn obs_properties_add_int(
        props: *mut Properties,
        name: *const c_char,
        desc: *const c_char,
        min: c_int,
        max: c_int,
        step: c_int,
    ) -> *mut Property;
    pub fn obs_properties_add_text(
        props: *mut Properties,
        name: *const c_char,
        desc: *const c_char,
        text_type: c_int,
    ) -> *mut Property;
    pub fn obs_properties_add_path(
        props: *mut Properties,
        name: *const c_char,
        desc: *const c_char,
        path_type: c_int,
        filter: *const c_char,
        default_path: *const c_char,
    ) -> *mut Property;
    pub fn obs_properties_add_button(
        props: *mut Properties,
        name: *const c_char,
        text: *const c_char,
        callback: ClickedCb,
    ) -> *mut Property;
    pub fn obs_property_set_visible(property: *mut Property, visible: bool);
    pub fn obs_property_set_modified_callback(property: *mut Property, modified: ModifiedCb);
}

// ─── Audio ──────────────────────────────────────────────────────────────────

pub const SPEAKERS_STEREO: c_int = 2;
/// Interleaved 32-bit float.
pub const AUDIO_FORMAT_FLOAT: c_int = 4;

/// `struct obs_source_audio`.
#[repr(C)]
pub struct SourceAudio {
    pub data: [*const u8; 8],
    pub frames: u32,
    pub speakers: c_int,
    pub format: c_int,
    pub samples_per_sec: u32,
    /// Nanoseconds, os_gettime_ns clock.
    pub timestamp: u64,
}

#[link(name = "obs", kind = "raw-dylib")]
unsafe extern "C" {
    pub fn obs_source_output_audio(source: *mut c_void, audio: *const SourceAudio);
    /// Shows or hides the source in the Audio Mixer.
    pub fn obs_source_set_audio_active(source: *mut c_void, show: bool);
    pub fn obs_source_get_uuid(source: *const c_void) -> *const c_char;
    pub fn os_gettime_ns() -> u64;
}

// ─── Procedures and signals (OBS's global handlers) ──────────────────────────

/// libobs's calldata_t. Start zeroed (calldata_init); free `stack` with bfree.
#[repr(C)]
pub struct Calldata {
    pub stack: *mut u8,
    pub size: usize,
    pub capacity: usize,
    pub fixed: bool,
}

impl Calldata {
    pub fn new() -> Calldata {
        Calldata { stack: ptr::null_mut(), size: 0, capacity: 0, fixed: false }
    }
}

impl Drop for Calldata {
    fn drop(&mut self) {
        if !self.fixed && !self.stack.is_null() {
            unsafe { bfree(self.stack as *mut c_void) };
        }
    }
}

pub type SignalCallback = unsafe extern "C" fn(data: *mut c_void, cd: *mut Calldata);

#[link(name = "obs", kind = "raw-dylib")]
unsafe extern "C" {
    pub fn obs_get_proc_handler() -> *mut c_void;
    pub fn obs_get_signal_handler() -> *mut c_void;
    /// False if no procedure is registered under `name`.
    pub fn proc_handler_call(handler: *mut c_void, name: *const c_char, params: *mut Calldata) -> bool;
    pub fn signal_handler_connect(handler: *mut c_void, signal: *const c_char, callback: SignalCallback, data: *mut c_void);
    pub fn calldata_set_data(data: *mut Calldata, name: *const c_char, input: *const c_void, size: usize);
    pub fn calldata_get_data(data: *const Calldata, name: *const c_char, out: *mut c_void, size: usize) -> bool;
    pub fn calldata_get_string(data: *const Calldata, name: *const c_char, out: *mut *const c_char) -> bool;
}

// ─── Graphics (libobs-d3d11 on Windows) ──────────────────────────────────────

pub const OBS_EFFECT_PREMULTIPLIED_ALPHA: c_int = 7;
pub const GS_BGRA: c_int = 5;
pub const GS_BLEND_ONE: c_int = 1;
pub const GS_BLEND_INVSRCALPHA: c_int = 5;

pub type Texture = c_void;
pub type Effect = c_void;
pub type EffectParam = c_void;

#[link(name = "obs", kind = "raw-dylib")]
unsafe extern "C" {
    pub fn obs_enter_graphics();
    pub fn obs_leave_graphics();
    pub fn obs_get_base_effect(effect: c_int) -> *mut Effect;
    /// The ID3D11Device. Only inside the graphics context.
    pub fn gs_get_device_obj() -> *mut c_void;
    pub fn gs_texture_create(
        width: u32,
        height: u32,
        color_format: c_int,
        levels: u32,
        data: *const *const u8,
        flags: u32,
    ) -> *mut Texture;
    pub fn gs_texture_destroy(texture: *mut Texture);
    /// The ID3D11Texture2D.
    pub fn gs_texture_get_obj(texture: *mut Texture) -> *mut c_void;
    pub fn gs_effect_get_param_by_name(effect: *const Effect, name: *const c_char) -> *mut EffectParam;
    pub fn gs_effect_set_texture_srgb(param: *mut EffectParam, texture: *mut Texture);
    pub fn gs_effect_loop(effect: *mut Effect, technique: *const c_char) -> bool;
    pub fn gs_draw_sprite(texture: *mut Texture, flip: u32, width: u32, height: u32);
    pub fn gs_blend_state_push();
    pub fn gs_blend_state_pop();
    pub fn gs_blend_function(src: c_int, dest: c_int);
    pub fn gs_enable_framebuffer_srgb(enable: bool);
    pub fn gs_framebuffer_srgb_enabled() -> bool;
}

#[link(name = "obs-frontend-api", kind = "raw-dylib")]
unsafe extern "C" {
    pub fn obs_frontend_get_main_window() -> *mut c_void;
    /// OBS's user config (user.ini), a config_t.
    pub fn obs_frontend_get_user_config() -> *mut c_void;
    /// The open scene collection's name (bfree it).
    pub fn obs_frontend_get_current_scene_collection() -> *mut c_char;
    /// The main window's HWND.
    pub fn obs_frontend_get_main_window_handle() -> *mut c_void;
    pub fn obs_frontend_add_dock_by_id(id: *const c_char, title: *const c_char, widget: *mut c_void) -> bool;
    pub fn obs_frontend_add_event_callback(callback: FrontendEventCb, private_data: *mut c_void);
    pub fn obs_frontend_remove_event_callback(callback: FrontendEventCb, private_data: *mut c_void);
}

static MODULE: AtomicPtr<c_void> = AtomicPtr::new(ptr::null_mut());

pub fn set_module(module: *mut c_void) {
    MODULE.store(module, Ordering::Release);
}

/// `obs_current_module()` from OBS_DECLARE_MODULE.
pub fn module() -> *mut c_void {
    MODULE.load(Ordering::Acquire)
}

/// Converts `s` to a C string, dropping interior NULs instead of failing.
pub fn cstring(s: &str) -> CString {
    CString::new(s.replace('\0', "")).unwrap()
}

pub fn log(level: c_int, msg: &str) {
    let msg = cstring(&format!("[Control Panel] {msg}"));
    unsafe { blog(level, c"%s".as_ptr(), msg.as_ptr()) };
}

macro_rules! log_info {
    ($($arg:tt)*) => { $crate::obs::log($crate::obs::LOG_INFO, &format!($($arg)*)) };
}
macro_rules! log_warn {
    ($($arg:tt)*) => { $crate::obs::log($crate::obs::LOG_WARNING, &format!($($arg)*)) };
}
pub(crate) use {log_info, log_warn};

/// Takes ownership of a bmalloc'd string returned by libobs.
unsafe fn take_obs_string(s: *mut c_char) -> Option<String> {
    if s.is_null() {
        return None;
    }
    let out = unsafe { CStr::from_ptr(s) }.to_string_lossy().into_owned();
    unsafe { bfree(s.cast()) };
    Some(out)
}

/// `obs_module_config_path(file)`: %APPDATA%\obs-studio\plugin_config\theater-control-panel\<file>.
pub fn module_config_path(file: &str) -> Option<PathBuf> {
    let file = cstring(file);
    unsafe { take_obs_string(obs_module_get_config_path(module(), file.as_ptr())) }.map(PathBuf::from)
}

/// The plugin's config folder while it was still called obs-tauri.
const OLD_CONFIG_FOLDER: &str = "obs-tauri";

/// Moves what the plugin kept under its old name (plugin_config\obs-tauri:
/// the Control Panel's data, the pages' browser profiles, the performance
/// options) into its own config folder, once. Call before anything reads it.
pub fn move_old_config_folder() {
    let Some(new) = module_config_path("") else { return };
    // ("…\theater-control-panel/": without the separator, for parent())
    let new = PathBuf::from(new.to_string_lossy().trim_end_matches(['/', '\\']));
    let Some(old) = new.parent().map(|p| p.join(OLD_CONFIG_FOLDER)) else { return };
    if new.exists() || !old.is_dir() {
        return;
    }
    match std::fs::rename(&old, &new) {
        Ok(()) => log_info!("moved the settings from {} to {}", old.display(), new.display()),
        Err(e) => log_warn!("couldn't move the settings from {} to {}: {e}", old.display(), new.display()),
    }
}

/// `obs_module_file(file)`: a file in the plugin's data folder, if it exists.
pub fn module_file(file: &str) -> Option<PathBuf> {
    let file = cstring(file);
    unsafe { take_obs_string(obs_find_module_file(module(), file.as_ptr())) }.map(PathBuf::from)
}
