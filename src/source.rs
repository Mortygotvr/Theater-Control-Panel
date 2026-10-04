//! Theater Web Source: a web page as an OBS source, like obs-browser's Browser Source,
//! transparency included.
//!
//! WebView2 has no offscreen rendering, so each source's page is hosted in
//! composition mode: it draws into a Windows.UI.Composition visual that isn't
//! shown anywhere, and Windows.Graphics.Capture turns that visual into D3D11
//! frames, alpha included, on OBS's own graphics device. video_render copies the
//! newest frame into the source's texture and draws it with premultiplied alpha,
//! as obs-browser does. Frames arrive at the display's refresh rate.
//!
//! The page lives on OBS's UI thread (`Page`, in `PAGES`). OBS calls the source
//! from other threads, so what it hands over goes through `ui::post`, and the
//! capture is shared with the graphics thread behind a mutex.

use std::cell::RefCell;
use std::collections::HashMap;
use std::ffi::{CStr, c_char, c_void};
use std::path::Path;
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde_json::json;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_BOUNDS_MODE_USE_RAW_PIXELS, COREWEBVIEW2_COLOR, COREWEBVIEW2_MOUSE_EVENT_KIND,
    COREWEBVIEW2_MOUSE_EVENT_KIND_HORIZONTAL_WHEEL, COREWEBVIEW2_MOUSE_EVENT_KIND_LEAVE,
    COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_DOUBLE_CLICK, COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_DOWN,
    COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_UP, COREWEBVIEW2_MOUSE_EVENT_KIND_MIDDLE_BUTTON_DOUBLE_CLICK,
    COREWEBVIEW2_MOUSE_EVENT_KIND_MIDDLE_BUTTON_DOWN, COREWEBVIEW2_MOUSE_EVENT_KIND_MIDDLE_BUTTON_UP,
    COREWEBVIEW2_MOUSE_EVENT_KIND_MOVE, COREWEBVIEW2_MOUSE_EVENT_KIND_RIGHT_BUTTON_DOUBLE_CLICK,
    COREWEBVIEW2_MOUSE_EVENT_KIND_RIGHT_BUTTON_DOWN, COREWEBVIEW2_MOUSE_EVENT_KIND_RIGHT_BUTTON_UP,
    COREWEBVIEW2_MOUSE_EVENT_KIND_WHEEL, COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS,
    COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_CONTROL, COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_LEFT_BUTTON,
    COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_MIDDLE_BUTTON, COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_NONE,
    COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_RIGHT_BUTTON, COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_SHIFT, ICoreWebView2,
    ICoreWebView2CompositionController, ICoreWebView2Controller, ICoreWebView2Controller2, ICoreWebView2Controller3,
    ICoreWebView2Environment, ICoreWebView2Environment3,
};
use webview2_com::{
    AddScriptToExecuteOnDocumentCreatedCompletedHandler, CallDevToolsProtocolMethodCompletedHandler,
    CreateCoreWebView2CompositionControllerCompletedHandler, NavigationCompletedEventHandler,
};
use windows::Graphics::Capture::{Direct3D11CaptureFrame, Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Foundation::TimeSpan;
use windows::Graphics::SizeInt32;
use windows::System::{DispatcherQueue, DispatcherQueueController};
use windows::UI::Composition::{Compositor, ContainerVisual, Visual};
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Direct3D11::{D3D11_BOX, D3D11_TEXTURE2D_DESC, ID3D11Device, ID3D11Resource, ID3D11Texture2D};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::WinRT::Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess};
use windows::Win32::System::WinRT::{
    CreateDispatcherQueueController, DQTAT_COM_NONE, DQTYPE_THREAD_CURRENT, DispatcherQueueOptions,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, LWA_ALPHA, RegisterClassExW, SetLayeredWindowAttributes,
    WNDCLASSEXW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TRANSPARENT,
    WS_EX_TOOLWINDOW, WS_POPUP, WS_VISIBLE,
};
use windows::core::{HSTRING, IUnknown, Interface, PCWSTR, w};
use windows_numerics::Vector2;

use crate::obs::{self, log_info, log_warn};
use crate::audio::{AudioCapture, SourcePtr};
use crate::{env, ui};

const ID: &CStr = c"theater_web_source";
/// The id the source had while the plugin was still called obs-tauri: scenes
/// saved then still name it, so it's registered too, hidden from Add Source.
const LEGACY_ID: &CStr = c"obs_tauri_source";
const NAME: &CStr = c"Theater Web Source";
const DEFAULT_URL: &CStr = c"https://obsproject.com/browser-source";
/// Same as obs-browser: transparent page background.
const DEFAULT_CSS: &CStr = c"body { background-color: rgba(0, 0, 0, 0); margin: 0px auto; overflow: hidden; }";
const PIXEL_FORMAT: DirectXPixelFormat = DirectXPixelFormat::B8G8R8A8UIntNormalized;

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

pub fn register() {
    let info = obs::SourceInfo {
        id: ID.as_ptr(),
        type_: obs::OBS_SOURCE_TYPE_INPUT,
        output_flags: obs::OBS_SOURCE_VIDEO
            | obs::OBS_SOURCE_AUDIO
            | obs::OBS_SOURCE_CUSTOM_DRAW
            | obs::OBS_SOURCE_INTERACTION
            | obs::OBS_SOURCE_DO_NOT_DUPLICATE
            | obs::OBS_SOURCE_SRGB,
        get_name: Some(get_name),
        create: Some(create),
        destroy: Some(destroy),
        get_width: Some(get_width),
        get_height: Some(get_height),
        get_defaults: Some(get_defaults),
        get_properties: Some(get_properties),
        update: Some(update),
        activate: None,
        deactivate: None,
        show: Some(on_show),
        hide: Some(on_hide),
        video_tick: None,
        video_render: Some(video_render),
        filter_video: None,
        filter_audio: None,
        enum_active_sources: None,
        save: None,
        load: None,
        mouse_click: Some(mouse_click),
        mouse_move: Some(mouse_move),
        mouse_wheel: Some(mouse_wheel),
        focus: Some(focus),
        key_click: Some(key_click),
    };
    unsafe { obs::obs_register_source_s(&info, size_of::<obs::SourceInfo>()) };
    let legacy = obs::SourceInfo {
        id: LEGACY_ID.as_ptr(),
        output_flags: info.output_flags | obs::OBS_SOURCE_CAP_OBSOLETE,
        ..info
    };
    unsafe { obs::obs_register_source_s(&legacy, size_of::<obs::SourceInfo>()) };
}

// ─── Settings ───────────────────────────────────────────────────────────────

#[derive(Clone, PartialEq)]
struct Settings {
    url: String,
    width: u32,
    height: u32,
    css: String,
    /// "Control audio via OBS" (obs-browser's setting name).
    reroute_audio: bool,
}

impl Settings {
    unsafe fn read(data: *mut obs::Data) -> Settings {
        let string = |name: &CStr| {
            let value = unsafe { obs::obs_data_get_string(data, name.as_ptr()) };
            if value.is_null() { String::new() } else { unsafe { CStr::from_ptr(value) }.to_string_lossy().into_owned() }
        };
        let size = |name: &CStr| unsafe { obs::obs_data_get_int(data, name.as_ptr()) }.clamp(1, 8192) as u32;
        let local = unsafe { obs::obs_data_get_bool(data, c"is_local_file".as_ptr()) };
        Settings {
            url: if local { file_url(Path::new(&string(c"local_file"))) } else { with_scheme(&string(c"url")) },
            width: size(c"width"),
            height: size(c"height"),
            css: string(c"css"),
            reroute_audio: unsafe { obs::obs_data_get_bool(data, c"reroute_audio".as_ptr()) },
        }
    }
}

/// A URL typed without its scheme ("app.hyperate.io/C972"), as the Browser
/// Source accepts them, gets https:// (WebView2 won't navigate without one).
fn with_scheme(url: &str) -> String {
    let url = url.trim();
    let has_scheme = url.contains("://") || ["about:", "data:", "file:", "blob:"].iter().any(|s| url.starts_with(s));
    if url.is_empty() || has_scheme { url.to_string() } else { format!("https://{url}") }
}

fn file_url(path: &Path) -> String {
    let mut url = String::from("file:///");
    for b in path.to_string_lossy().replace('\\', "/").bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' | b':' => url.push(b as char),
            _ => url.push_str(&format!("%{b:02X}")),
        }
    }
    url
}

/// Adds the custom CSS to every page the source loads.
fn css_script(css: &str) -> String {
    let css = serde_json::Value::from(css);
    format!(
        "(() => {{ const add = () => {{ const s = document.createElement('style'); s.textContent = {css}; \
         (document.head || document.documentElement).appendChild(s); }}; \
         if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add); else add(); }})();"
    )
}

// ─── The source, as OBS sees it (called from OBS's threads) ────────────────

/// Shared by OBS's threads and the page on the UI thread.
struct Shared {
    /// For log messages.
    id: u64,
    width: AtomicU32,
    height: AtomicU32,
    /// Whether the current capture has delivered a frame yet (logged once).
    got_frame: AtomicBool,
    /// Set by the UI thread once the page is captured; read by the graphics thread.
    capture: Mutex<Option<Capture>>,
    /// The obs_source_t, for audio output.
    source: SourcePtr,
    /// With "Control audio via OBS", the page runs in its own WebView2
    /// environment on this profile folder, so its sound can be captured alone.
    profile: String,
    audio: Mutex<Option<AudioCapture>>,
    /// Set in destroy, so the UI thread doesn't start audio for a dead source.
    destroyed: AtomicBool,
    /// OBS shows it somewhere: a scene on screen, a projector, a preview
    shown: AtomicBool,
}

struct Capture {
    pool: Direct3D11CaptureFramePool,
    device: IDirect3DDevice,
    size: SizeInt32,
}

// WinRT capture objects are agile (usable from any thread).
unsafe impl Send for Capture {}

impl Shared {
    fn capture(&self) -> MutexGuard<'_, Option<Capture>> {
        self.capture.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn audio(&self) -> MutexGuard<'_, Option<AudioCapture>> {
        self.audio.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Starts sending what browser process `pid` (and its children) plays to OBS.
    fn start_audio(&self, pid: u32) {
        let old = {
            let mut audio = self.audio();
            if self.destroyed.load(Ordering::Acquire) {
                return;
            }
            audio.replace(AudioCapture::start(pid, self.source, self.id))
        };
        drop(old);
    }

    fn stop_audio(&self) {
        let old = self.audio().take();
        drop(old);
    }
}

struct Source {
    id: u64,
    shared: Arc<Shared>,
    /// The OBS texture frames are copied into. Graphics thread only.
    texture: Mutex<Option<Texture>>,
}

struct Texture {
    texture: *mut obs::Texture,
    width: u32,
    height: u32,
}

unsafe impl Send for Texture {}

unsafe extern "C" fn get_name(_type_data: *mut c_void) -> *const c_char {
    NAME.as_ptr()
}

unsafe extern "C" fn get_defaults(settings: *mut obs::Data) {
    unsafe {
        obs::obs_data_set_default_bool(settings, c"is_local_file".as_ptr(), false);
        obs::obs_data_set_default_string(settings, c"url".as_ptr(), DEFAULT_URL.as_ptr());
        obs::obs_data_set_default_int(settings, c"width".as_ptr(), 800);
        obs::obs_data_set_default_int(settings, c"height".as_ptr(), 600);
        obs::obs_data_set_default_string(settings, c"css".as_ptr(), DEFAULT_CSS.as_ptr());
        obs::obs_data_set_default_bool(settings, c"reroute_audio".as_ptr(), false);
    }
}

unsafe extern "C" fn get_properties(_data: *mut c_void) -> *mut obs::Properties {
    unsafe {
        let props = obs::obs_properties_create();
        let local = obs::obs_properties_add_bool(props, c"is_local_file".as_ptr(), c"Local file".as_ptr());
        obs::obs_property_set_modified_callback(local, on_local_file_changed);
        obs::obs_properties_add_path(
            props,
            c"local_file".as_ptr(),
            c"Local file".as_ptr(),
            obs::OBS_PATH_FILE,
            c"HTML files (*.html *.htm);;All files (*.*)".as_ptr(),
            ptr::null(),
        );
        obs::obs_properties_add_text(props, c"url".as_ptr(), c"URL".as_ptr(), obs::OBS_TEXT_DEFAULT);
        obs::obs_properties_add_int(props, c"width".as_ptr(), c"Width".as_ptr(), 1, 8192, 1);
        obs::obs_properties_add_int(props, c"height".as_ptr(), c"Height".as_ptr(), 1, 8192, 1);
        obs::obs_properties_add_bool(props, c"reroute_audio".as_ptr(), c"Control audio via OBS".as_ptr());
        obs::obs_properties_add_text(props, c"css".as_ptr(), c"Custom CSS".as_ptr(), obs::OBS_TEXT_MULTILINE);
        obs::obs_properties_add_button(props, c"refresh".as_ptr(), c"Refresh".as_ptr(), on_refresh);
        props
    }
}

/// Shows the URL or the file picker, whichever "Local file" asks for.
unsafe extern "C" fn on_local_file_changed(props: *mut obs::Properties, _p: *mut obs::Property, settings: *mut obs::Data) -> bool {
    unsafe {
        let local = obs::obs_data_get_bool(settings, c"is_local_file".as_ptr());
        obs::obs_property_set_visible(obs::obs_properties_get(props, c"url".as_ptr()), !local);
        obs::obs_property_set_visible(obs::obs_properties_get(props, c"local_file".as_ptr()), local);
    }
    true
}

/// `data` is the source's data (OBS passes it to buttons of its properties).
unsafe extern "C" fn on_refresh(_props: *mut obs::Properties, _p: *mut obs::Property, data: *mut c_void) -> bool {
    if !data.is_null() {
        let id = unsafe { &*data.cast::<Source>() }.id;
        ui::post(move || reload(id));
    }
    false
}

unsafe extern "C" fn create(settings: *mut obs::Data, source: *mut c_void) -> *mut c_void {
    let settings = unsafe { Settings::read(settings) };
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    // Named after the source's UUID, so its cookies and logins persist.
    let uuid = unsafe { obs::obs_source_get_uuid(source) };
    let profile = if uuid.is_null() {
        format!("webview2-sources/source-{id}")
    } else {
        format!("webview2-sources/{}", unsafe { CStr::from_ptr(uuid) }.to_string_lossy())
    };
    unsafe { obs::obs_source_set_audio_active(source, settings.reroute_audio) };
    let shared = Arc::new(Shared {
        id,
        width: AtomicU32::new(settings.width),
        height: AtomicU32::new(settings.height),
        got_frame: AtomicBool::new(false),
        capture: Mutex::new(None),
        source: SourcePtr(source),
        profile,
        audio: Mutex::new(None),
        destroyed: AtomicBool::new(false),
        shown: AtomicBool::new(false),
    });
    let page_shared = shared.clone();
    ui::post(move || open(id, page_shared, settings));
    Box::into_raw(Box::new(Source { id, shared, texture: Mutex::new(None) })).cast()
}

unsafe extern "C" fn destroy(data: *mut c_void) {
    let source = unsafe { Box::from_raw(data.cast::<Source>()) };
    let id = source.id;
    ui::post(move || close(id));
    // The audio thread uses the obs_source_t: it must be gone before we return.
    let audio = {
        let mut audio = source.shared.audio();
        source.shared.destroyed.store(true, Ordering::Release);
        audio.take()
    };
    drop(audio);
    if let Some(capture) = source.shared.capture().take() {
        let _ = capture.pool.Close();
    }
    let texture = source.texture.lock().unwrap_or_else(PoisonError::into_inner).take();
    if let Some(texture) = texture {
        unsafe {
            obs::obs_enter_graphics();
            obs::gs_texture_destroy(texture.texture);
            obs::obs_leave_graphics();
        }
    }
}

unsafe extern "C" fn update(data: *mut c_void, settings: *mut obs::Data) {
    let source = unsafe { &*data.cast::<Source>() };
    let settings = unsafe { Settings::read(settings) };
    source.shared.width.store(settings.width, Ordering::Relaxed);
    source.shared.height.store(settings.height, Ordering::Relaxed);
    unsafe { obs::obs_source_set_audio_active(source.shared.source.0, settings.reroute_audio) };
    let id = source.id;
    ui::post(move || set_settings(id, settings));
}

unsafe extern "C" fn get_width(data: *mut c_void) -> u32 {
    unsafe { &*data.cast::<Source>() }.shared.width.load(Ordering::Relaxed)
}

unsafe extern "C" fn get_height(data: *mut c_void) -> u32 {
    unsafe { &*data.cast::<Source>() }.shared.height.load(Ordering::Relaxed)
}

// ─── Rendering (graphics thread) ────────────────────────────────────────────

unsafe extern "C" fn on_show(data: *mut c_void) {
    shown(data, true);
}

unsafe extern "C" fn on_hide(data: *mut c_void) {
    shown(data, false);
}

fn shown(data: *mut c_void, on: bool) {
    let source = unsafe { &*data.cast::<Source>() };
    source.shared.shown.store(on, Ordering::Relaxed);
    let id = source.id;
    ui::post(move || apply_rest(id));
}

unsafe extern "C" fn video_render(data: *mut c_void, _effect: *mut c_void) {
    let source = unsafe { &*data.cast::<Source>() };
    crate::guard("Theater Web Source render", || unsafe {
        if let Err(e) = copy_newest_frame(source) {
            log_warn!("Theater Web Source: can't copy a frame: {e}");
        }
        let texture = source.texture.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(texture) = texture.as_ref() {
            draw(texture.texture);
        }
    });
}

/// Copies the newest captured frame, if there's a new one, into the source's texture.
unsafe fn copy_newest_frame(source: &Source) -> windows::core::Result<()> {
    let mut capture = source.shared.capture();
    let Some(capture) = capture.as_mut() else { return Ok(()) };
    let mut newest: Option<Direct3D11CaptureFrame> = None;
    while let Ok(frame) = capture.pool.TryGetNextFrame() {
        if let Some(older) = newest.replace(frame) {
            let _ = older.Close();
        }
    }
    let Some(frame) = newest else { return Ok(()) };

    let size = frame.ContentSize()?;
    if !source.shared.got_frame.swap(true, Ordering::Relaxed) {
        log_info!("Theater Web Source {}: first frame, {}x{}", source.id, size.Width, size.Height);
    }
    let captured: ID3D11Texture2D = unsafe { frame.Surface()?.cast::<IDirect3DDxgiInterfaceAccess>()?.GetInterface()? };
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    unsafe { captured.GetDesc(&mut desc) };
    let width = (size.Width.max(1) as u32).min(desc.Width);
    let height = (size.Height.max(1) as u32).min(desc.Height);

    let mut texture = source.texture.lock().unwrap_or_else(PoisonError::into_inner);
    if texture.as_ref().is_none_or(|t| t.width != width || t.height != height) {
        if let Some(old) = texture.take() {
            unsafe { obs::gs_texture_destroy(old.texture) };
        }
        let created = unsafe { obs::gs_texture_create(width, height, obs::GS_BGRA, 1, ptr::null(), 0) };
        if created.is_null() {
            log_warn!("Theater Web Source {}: can't create a {width}x{height} texture", source.id);
        } else {
            *texture = Some(Texture { texture: created, width, height });
        }
    }
    if let Some(texture) = texture.as_ref() {
        let device_ptr = unsafe { obs::gs_get_device_obj() };
        let texture_ptr = unsafe { obs::gs_texture_get_obj(texture.texture) };
        if let (Some(device), Some(target)) = unsafe {
            (ID3D11Device::from_raw_borrowed(&device_ptr), ID3D11Texture2D::from_raw_borrowed(&texture_ptr))
        } {
            let context = unsafe { device.GetImmediateContext() }?;
            let region = D3D11_BOX { left: 0, top: 0, front: 0, right: width, bottom: height, back: 1 };
            unsafe {
                context.CopySubresourceRegion(
                    &target.cast::<ID3D11Resource>()?,
                    0,
                    0,
                    0,
                    0,
                    &captured.cast::<ID3D11Resource>()?,
                    0,
                    Some(&region),
                )
            };
        }
    }
    frame.Close()?;

    // The page changed size: grow or shrink the capture buffers to match.
    if size.Width != capture.size.Width || size.Height != capture.size.Height {
        capture.pool.Recreate(&capture.device, PIXEL_FORMAT, 2, size)?;
        capture.size = size;
    }
    Ok(())
}

/// Draws the texture with premultiplied alpha, like obs-browser.
unsafe fn draw(texture: *mut obs::Texture) {
    unsafe {
        let effect = obs::obs_get_base_effect(obs::OBS_EFFECT_PREMULTIPLIED_ALPHA);
        let image = obs::gs_effect_get_param_by_name(effect, c"image".as_ptr());
        let previous_srgb = obs::gs_framebuffer_srgb_enabled();
        obs::gs_enable_framebuffer_srgb(true);
        obs::gs_blend_state_push();
        obs::gs_blend_function(obs::GS_BLEND_ONE, obs::GS_BLEND_INVSRCALPHA);
        obs::gs_effect_set_texture_srgb(image, texture);
        while obs::gs_effect_loop(effect, c"Draw".as_ptr()) {
            obs::gs_draw_sprite(texture, 0, 0, 0);
        }
        obs::gs_blend_state_pop();
        obs::gs_enable_framebuffer_srgb(previous_srgb);
    }
}

// ─── Interact (OBS's Interact window → the page) ───────────────────────────
// The mouse goes through the composition controller, made for exactly this.
// A composition-hosted WebView2 has no keyboard injection API, so keys go
// through the DevTools protocol (Input.dispatchKeyEvent), and focus is
// emulated so the page accepts them while Interact has focus.

fn source_id(data: *mut c_void) -> u64 {
    unsafe { &*data.cast::<Source>() }.id
}

fn mouse_keys(modifiers: u32) -> COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS {
    let mut keys = COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_NONE.0;
    for (flag, key) in [
        (obs::INTERACT_MOUSE_LEFT, COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_LEFT_BUTTON),
        (obs::INTERACT_MOUSE_MIDDLE, COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_MIDDLE_BUTTON),
        (obs::INTERACT_MOUSE_RIGHT, COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_RIGHT_BUTTON),
        (obs::INTERACT_SHIFT_KEY, COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_SHIFT),
        (obs::INTERACT_CONTROL_KEY, COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_CONTROL),
    ] {
        if modifiers & flag != 0 {
            keys |= key.0;
        }
    }
    COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS(keys)
}

fn post_mouse(data: *mut c_void, event: obs::MouseEvent, kind: COREWEBVIEW2_MOUSE_EVENT_KIND, mouse_data: i32) {
    let id = source_id(data);
    ui::post(move || {
        with_view(id, |view| unsafe {
            let point = POINT { x: event.x, y: event.y };
            let _ = view.controller.SendMouseInput(kind, mouse_keys(event.modifiers), mouse_data as u32, point);
        })
    });
}

unsafe extern "C" fn mouse_click(data: *mut c_void, event: *const obs::MouseEvent, button: i32, mouse_up: bool, click_count: u32) {
    let double = click_count >= 2 && !mouse_up;
    let kind = match (button, mouse_up, double) {
        (obs::MOUSE_LEFT, true, _) => COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_UP,
        (obs::MOUSE_LEFT, false, true) => COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_DOUBLE_CLICK,
        (obs::MOUSE_LEFT, false, false) => COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_DOWN,
        (obs::MOUSE_MIDDLE, true, _) => COREWEBVIEW2_MOUSE_EVENT_KIND_MIDDLE_BUTTON_UP,
        (obs::MOUSE_MIDDLE, false, true) => COREWEBVIEW2_MOUSE_EVENT_KIND_MIDDLE_BUTTON_DOUBLE_CLICK,
        (obs::MOUSE_MIDDLE, false, false) => COREWEBVIEW2_MOUSE_EVENT_KIND_MIDDLE_BUTTON_DOWN,
        (obs::MOUSE_RIGHT, true, _) => COREWEBVIEW2_MOUSE_EVENT_KIND_RIGHT_BUTTON_UP,
        (obs::MOUSE_RIGHT, false, true) => COREWEBVIEW2_MOUSE_EVENT_KIND_RIGHT_BUTTON_DOUBLE_CLICK,
        (obs::MOUSE_RIGHT, false, false) => COREWEBVIEW2_MOUSE_EVENT_KIND_RIGHT_BUTTON_DOWN,
        _ => return,
    };
    post_mouse(data, unsafe { *event }, kind, 0);
}

unsafe extern "C" fn mouse_move(data: *mut c_void, event: *const obs::MouseEvent, mouse_leave: bool) {
    let kind = if mouse_leave { COREWEBVIEW2_MOUSE_EVENT_KIND_LEAVE } else { COREWEBVIEW2_MOUSE_EVENT_KIND_MOVE };
    post_mouse(data, unsafe { *event }, kind, 0);
}

/// Deltas are in wheel units (120 per notch), as Windows expects.
unsafe extern "C" fn mouse_wheel(data: *mut c_void, event: *const obs::MouseEvent, x_delta: i32, y_delta: i32) {
    let event = unsafe { *event };
    if y_delta != 0 {
        post_mouse(data, event, COREWEBVIEW2_MOUSE_EVENT_KIND_WHEEL, y_delta);
    }
    if x_delta != 0 {
        post_mouse(data, event, COREWEBVIEW2_MOUSE_EVENT_KIND_HORIZONTAL_WHEEL, x_delta);
    }
}

unsafe extern "C" fn focus(data: *mut c_void, focus: bool) {
    let id = source_id(data);
    ui::post(move || devtools(id, "Emulation.setFocusEmulationEnabled", json!({ "enabled": focus })));
}

unsafe extern "C" fn key_click(data: *mut c_void, event: *const obs::KeyEvent, key_up: bool) {
    let event = unsafe { &*event };
    let text = if event.text.is_null() {
        String::new()
    } else {
        unsafe { CStr::from_ptr(event.text) }.to_string_lossy().into_owned()
    };
    let params = key_event(&text, event.native_vkey, event.modifiers, key_up);
    let id = source_id(data);
    ui::post(move || devtools(id, "Input.dispatchKeyEvent", params));
}

/// An Input.dispatchKeyEvent for an OBS key event. Typed characters (and Enter)
/// are sent with their text so the page inserts them; other keys go as raw key
/// presses, which covers shortcuts like Ctrl+A.
fn key_event(text: &str, vkey: u32, modifiers: u32, key_up: bool) -> serde_json::Value {
    let mut cdp_modifiers = 0;
    for (flag, bit) in [
        (obs::INTERACT_ALT_KEY, 1),
        (obs::INTERACT_CONTROL_KEY, 2),
        (obs::INTERACT_COMMAND_KEY, 4),
        (obs::INTERACT_SHIFT_KEY, 8),
    ] {
        if modifiers & flag != 0 {
            cdp_modifiers |= bit;
        }
    }
    let typed = !text.is_empty() && (text == "\r" || !text.chars().any(char::is_control));
    let key = match vkey {
        0x08 => "Backspace",
        0x09 => "Tab",
        0x0D => "Enter",
        0x10 => "Shift",
        0x11 => "Control",
        0x12 => "Alt",
        0x1B => "Escape",
        0x21 => "PageUp",
        0x22 => "PageDown",
        0x23 => "End",
        0x24 => "Home",
        0x25 => "ArrowLeft",
        0x26 => "ArrowUp",
        0x27 => "ArrowRight",
        0x28 => "ArrowDown",
        0x2E => "Delete",
        _ if typed => text,
        _ => "",
    };
    let kind = match (key_up, typed) {
        (true, _) => "keyUp",
        (false, true) => "keyDown",
        (false, false) => "rawKeyDown",
    };
    let mut params = json!({
        "type": kind,
        "modifiers": cdp_modifiers,
        "windowsVirtualKeyCode": vkey,
        "nativeVirtualKeyCode": vkey,
        "key": key,
    });
    if typed && !key_up {
        params["text"] = json!(text);
        params["unmodifiedText"] = json!(text);
    }
    params
}

fn devtools(id: u64, method: &str, params: serde_json::Value) {
    with_view(id, |view| {
        let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(|_result, _json| Ok(())));
        let method = HSTRING::from(method);
        let params = HSTRING::from(params.to_string());
        let _ = unsafe { view.webview.CallDevToolsProtocolMethod(&method, &params, &handler) };
    });
}

fn with_view(id: u64, f: impl FnOnce(&View)) {
    PAGES.with_borrow(|pages| {
        if let Some(view) = pages.get(&id).and_then(|page| page.view.as_ref()) {
            f(view);
        }
    });
}

// ─── The page (UI thread) ───────────────────────────────────────────────────

struct Page {
    shared: Arc<Shared>,
    settings: Settings,
    /// Bumped on every (re)open, so a late controller for an old one is dropped.
    generation: u64,
    view: Option<View>,
    /// Not drawn or captured while OBS shows it nowhere (⚡ Performance)
    rested: bool,
}

/// A loaded page: the WebView2 and what it's drawn into and captured from.
struct View {
    controller: ICoreWebView2CompositionController,
    webview: ICoreWebView2,
    visual: ContainerVisual,
    session: Option<GraphicsCaptureSession>,
}

/// What the pages need once per thread: a DispatcherQueue (required by
/// Windows.UI.Composition), the compositor, and a hidden window to parent the
/// WebView2s (for focus and IME; nothing is drawn in it).
struct Host {
    _queue: Option<DispatcherQueueController>,
    compositor: Compositor,
    window: HWND,
}

thread_local! {
    static PAGES: RefCell<HashMap<u64, Page>> = RefCell::default();
    static HOST: RefCell<Option<Host>> = const { RefCell::new(None) };
}

fn open(id: u64, shared: Arc<Shared>, settings: Settings) {
    PAGES.with_borrow_mut(|pages| pages.insert(id, Page { shared, settings, generation: 0, view: None, rested: false }));
    load(id);
}

/// (Re)creates the page's WebView2. Asynchronous: the controller arrives in
/// `on_controller`.
fn load(id: u64) {
    if ui::shutting_down() {
        return;
    }
    let Some((generation, own_profile)) = PAGES.with_borrow_mut(|pages| {
        pages.get_mut(&id).map(|page| {
            page.generation += 1;
            (page.generation, page.settings.reroute_audio.then(|| page.shared.profile.clone()))
        })
    }) else {
        return;
    };
    let create = move |environment: Result<ICoreWebView2Environment, String>| {
        let result = environment.and_then(|environment| create_controller(id, generation, &environment));
        if let Err(e) = result {
            log_warn!("Theater Web Source: can't create the page: {e}");
        }
    };
    match own_profile {
        Some(folder) => env::with_profile(&folder, create),
        None => env::with(create),
    }
}

fn create_controller(id: u64, generation: u64, environment: &ICoreWebView2Environment) -> Result<(), String> {
    let environment: ICoreWebView2Environment3 = environment.cast().map_err(|e| e.to_string())?;
    let window = host(|host| host.window)?;
    let handler = CreateCoreWebView2CompositionControllerCompletedHandler::create(Box::new(move |result, controller| {
        crate::guard("Theater Web Source page", || {
            let controller = result.map_err(|e| e.to_string()).and_then(|()| controller.ok_or("no controller".to_string()));
            match controller {
                Ok(controller) => on_controller(id, generation, controller),
                Err(e) => log_warn!("Theater Web Source: can't create the page: {e}"),
            }
        });
        Ok(())
    }));
    unsafe { environment.CreateCoreWebView2CompositionController(window, &handler) }.map_err(|e| e.to_string())
}

fn on_controller(id: u64, generation: u64, controller: ICoreWebView2CompositionController) {
    let settings = PAGES.with_borrow(|pages| {
        pages.get(&id).filter(|page| page.generation == generation).map(|page| page.settings.clone())
    });
    let Some(settings) = settings else {
        // Closed or reloaded while this one was being created.
        if let Ok(controller) = controller.cast::<ICoreWebView2Controller>() {
            let _ = unsafe { controller.Close() };
        }
        return;
    };
    match set_up(&controller, &settings) {
        Ok((webview, visual)) => {
            log_info!("Theater Web Source {id}: page created, {}x{}, loading {}", settings.width, settings.height, settings.url);
            report_navigation(id, &webview);
            let session = PAGES.with_borrow(|pages| {
                let page = pages.get(&id)?;
                start_capture(&page.shared, &visual, &settings)
                    .inspect_err(|e| log_warn!("Theater Web Source: can't capture the page: {e}"))
                    .ok()
            });
            if settings.reroute_audio {
                start_audio(id, &webview);
            }
            navigate(&webview, &settings);
            let view = View { controller, webview, visual, session };
            let replaced = PAGES.with_borrow_mut(|pages| {
                pages.get_mut(&id).and_then(|page| {
                    page.rested = false;
                    page.view.replace(view)
                })
            });
            if let Some(old) = replaced {
                close_view(old);
            }
            // Shown nowhere yet, with the option on: it rests from the start
            apply_rest(id);
        }
        Err(e) => {
            log_warn!("Theater Web Source: can't set up the page: {e}");
            if let Ok(controller) = controller.cast::<ICoreWebView2Controller>() {
                let _ = unsafe { controller.Close() };
            }
        }
    }
}

/// Sizes the page, makes its background transparent and points it at a
/// composition visual of the same size.
fn set_up(
    controller: &ICoreWebView2CompositionController,
    settings: &Settings,
) -> windows::core::Result<(ICoreWebView2, ContainerVisual)> {
    let base: ICoreWebView2Controller = controller.cast()?;
    unsafe {
        // One CSS pixel per source pixel, whatever the monitor's scale.
        let raw: ICoreWebView2Controller3 = controller.cast()?;
        raw.SetBoundsMode(COREWEBVIEW2_BOUNDS_MODE_USE_RAW_PIXELS)?;
        raw.SetShouldDetectMonitorScaleChanges(false)?;
        raw.SetRasterizationScale(1.0)?;
        base.cast::<ICoreWebView2Controller2>()?
            .SetDefaultBackgroundColor(COREWEBVIEW2_COLOR { A: 0, R: 0, G: 0, B: 0 })?;
        base.SetBounds(rect(settings))?;
        base.SetIsVisible(true)?;
    }

    let visual = host(|host| host.compositor.CreateContainerVisual())
        .map_err(|e| windows::core::Error::new(windows::Win32::Foundation::E_FAIL, e))??;
    visual.SetSize(Vector2::new(settings.width as f32, settings.height as f32))?;
    unsafe { controller.SetRootVisualTarget(&visual.cast::<IUnknown>()?)? };

    let webview = unsafe { base.CoreWebView2()? };
    unsafe {
        let options = webview.Settings()?;
        options.SetAreDefaultContextMenusEnabled(false)?;
        options.SetIsStatusBarEnabled(false)?;
        options.SetIsZoomControlEnabled(false)?;
    }
    Ok((webview, visual))
}

fn rect(settings: &Settings) -> RECT {
    RECT { left: 0, top: 0, right: settings.width as i32, bottom: settings.height as i32 }
}

/// Logs how each page load ends.
fn report_navigation(id: u64, webview: &ICoreWebView2) {
    let handler = NavigationCompletedEventHandler::create(Box::new(move |_webview, args| {
        if let Some(args) = args {
            let mut success = windows::core::BOOL::default();
            let mut status = Default::default();
            unsafe {
                let _ = args.IsSuccess(&mut success);
                let _ = args.WebErrorStatus(&mut status);
            }
            if success.as_bool() {
                log_info!("Theater Web Source {id}: page loaded");
            } else {
                log_warn!("Theater Web Source {id}: page failed to load (WebView2 error status {})", status.0);
            }
        }
        Ok(())
    }));
    let mut token = 0;
    if let Err(e) = unsafe { webview.add_NavigationCompleted(&handler, &mut token) } {
        log_warn!("Theater Web Source {id}: can't follow page loads: {e}");
    }
}

/// Sends the page's sound to OBS. The page runs in its own environment, so its
/// browser process and children play only this source's audio.
fn start_audio(id: u64, webview: &ICoreWebView2) {
    let mut pid = 0;
    if let Err(e) = unsafe { webview.BrowserProcessId(&mut pid) } {
        return log_warn!("Theater Web Source {id}: can't find the page's browser process for audio: {e}");
    }
    if let Some(shared) = PAGES.with_borrow(|pages| pages.get(&id).map(|page| page.shared.clone())) {
        shared.start_audio(pid);
        log_info!("Theater Web Source {id}: sending its audio to OBS (browser process {pid})");
    }
}

/// Registers the custom CSS, then loads the page once it's in place.
fn navigate(webview: &ICoreWebView2, settings: &Settings) {
    let target = webview.clone();
    let url = HSTRING::from(settings.url.as_str());
    let handler = AddScriptToExecuteOnDocumentCreatedCompletedHandler::create(Box::new(move |result, _id| {
        if let Err(e) = result {
            log_warn!("Theater Web Source: the custom CSS wasn't added: {e}");
        }
        if let Err(e) = unsafe { target.Navigate(&url) } {
            log_warn!("Theater Web Source: can't load {url}: {e}");
        }
        Ok(())
    }));
    let script = HSTRING::from(css_script(&settings.css));
    if let Err(e) = unsafe { webview.AddScriptToExecuteOnDocumentCreated(&script, &handler) } {
        log_warn!("Theater Web Source: can't add the custom CSS: {e}");
        let _ = unsafe { webview.Navigate(&HSTRING::from(settings.url.as_str())) };
    }
}

/// Starts capturing `visual` into a frame pool on OBS's graphics device.
fn start_capture(shared: &Shared, visual: &ContainerVisual, settings: &Settings) -> windows::core::Result<GraphicsCaptureSession> {
    let item = GraphicsCaptureItem::CreateFromVisual(&visual.cast::<Visual>()?)?;
    let size = SizeInt32 { Width: settings.width as i32, Height: settings.height as i32 };
    let (pool, device) = unsafe {
        obs::obs_enter_graphics();
        let result = (|| {
            let device_ptr = obs::gs_get_device_obj();
            let device = ID3D11Device::from_raw_borrowed(&device_ptr)
                .ok_or_else(|| windows::core::Error::new(windows::Win32::Foundation::E_POINTER, "no OBS graphics device"))?;
            let device: IDirect3DDevice = CreateDirect3D11DeviceFromDXGIDevice(&device.cast::<IDXGIDevice>()?)?.cast()?;
            let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(&device, PIXEL_FORMAT, 2, size)?;
            Ok::<_, windows::core::Error>((pool, device))
        })();
        obs::obs_leave_graphics();
        result?
    };
    let session = pool.CreateCaptureSession(&item)?;
    let _ = session.SetIsCursorCaptureEnabled(false);
    let _ = session.SetIsBorderRequired(false);
    set_capture_rate(&session);
    session.StartCapture()?;
    shared.got_frame.store(false, Ordering::Relaxed);
    let item_size = item.Size()?;
    log_info!("Theater Web Source {}: capturing {}x{}", shared.id, item_size.Width, item_size.Height);
    let old = shared.capture().replace(Capture { pool, device, size });
    if let Some(old) = old {
        let _ = old.pool.Close();
    }
    Ok(session)
}

/// The ⚡ Performance capture rate: at most one capture that often. Windows
/// 11 24H2 and later; before, pages are captured at the monitor's rate.
fn set_capture_rate(session: &GraphicsCaptureSession) {
    let _ = session.SetMinUpdateInterval(TimeSpan { Duration: crate::perf::capture_interval() });
}

/// The capture rate option changed: every page's capture follows it.
pub fn apply_capture_rate() {
    PAGES.with_borrow(|pages| {
        for page in pages.values() {
            if let Some(session) = page.view.as_ref().and_then(|view| view.session.as_ref()) {
                set_capture_rate(session);
            }
        }
    });
}

/// The resting option changed: every page follows it.
pub fn apply_rest_all() {
    let ids: Vec<u64> = PAGES.with_borrow(|pages| pages.keys().copied().collect());
    for id in ids {
        apply_rest(id);
    }
}

/// With "rest browser sources shown nowhere" on, a source OBS shows nowhere
/// isn't drawn or captured (its page runs on: scripts, sound, connections),
/// and is again as soon as OBS shows it. UI thread.
fn apply_rest(id: u64) {
    let rest = crate::perf::get().rest_hidden_sources;
    PAGES.with_borrow_mut(|pages| {
        let Some(page) = pages.get_mut(&id) else { return };
        let want = rest && !page.shared.shown.load(Ordering::Relaxed);
        if want == page.rested {
            return;
        }
        // Not loaded yet: on_controller comes back here
        let Some(view) = page.view.as_mut() else { return };
        let controller: Option<ICoreWebView2Controller> = view.controller.cast().ok();
        if want {
            stop_capture(&page.shared, view);
            if let Some(controller) = &controller {
                let _ = unsafe { controller.SetIsVisible(false) };
            }
            log_info!("Theater Web Source {id}: resting (shown nowhere in OBS)");
        } else {
            if let Some(controller) = &controller {
                let _ = unsafe { controller.SetIsVisible(true) };
            }
            view.session = start_capture(&page.shared, &view.visual, &page.settings)
                .inspect_err(|e| log_warn!("Theater Web Source: can't capture the page: {e}"))
                .ok();
            log_info!("Theater Web Source {id}: drawn again");
        }
        page.rested = want;
    });
}

fn stop_capture(shared: &Shared, view: &mut View) {
    if let Some(session) = view.session.take() {
        let _ = session.Close();
    }
    if let Some(capture) = shared.capture().take() {
        let _ = capture.pool.Close();
    }
}

fn close_view(view: View) {
    unsafe {
        if let Ok(controller) = view.controller.cast::<ICoreWebView2Controller>() {
            let _ = controller.Close();
        }
    }
    let _ = view.visual.Close();
}

fn set_settings(id: u64, settings: Settings) {
    let Some((previous, shared)) = PAGES.with_borrow_mut(|pages| {
        let page = pages.get_mut(&id)?;
        Some((std::mem::replace(&mut page.settings, settings.clone()), page.shared.clone()))
    }) else {
        return;
    };
    let audio_changed = previous.reroute_audio != settings.reroute_audio;
    if previous.url != settings.url || previous.css != settings.css || audio_changed {
        // Reload with the new page and CSS, or in the other environment.
        shared.stop_audio();
        let old = PAGES.with_borrow_mut(|pages| {
            let page = pages.get_mut(&id)?;
            let mut view = page.view.take()?;
            stop_capture(&page.shared, &mut view);
            Some(view)
        });
        if let Some(old) = old {
            close_view(old);
        }
        if audio_changed && previous.reroute_audio {
            env::release_profile(&shared.profile);
        }
        load(id);
    } else if previous.width != settings.width || previous.height != settings.height {
        resize(id, &settings);
    }
}

fn resize(id: u64, settings: &Settings) {
    PAGES.with_borrow_mut(|pages| {
        let Some(page) = pages.get_mut(&id) else { return };
        let Some(view) = page.view.as_mut() else { return };
        stop_capture(&page.shared, view);
        let resized = (|| {
            unsafe { view.controller.cast::<ICoreWebView2Controller>()?.SetBounds(rect(settings))? };
            view.visual.SetSize(Vector2::new(settings.width as f32, settings.height as f32))
        })();
        if let Err(e) = resized {
            log_warn!("Theater Web Source: can't resize the page: {e}");
        }
        match start_capture(&page.shared, &view.visual, settings) {
            Ok(session) => view.session = Some(session),
            Err(e) => log_warn!("Theater Web Source: can't capture the page: {e}"),
        }
    });
}

fn reload(id: u64) {
    with_view(id, |view| {
        let _ = unsafe { view.webview.Reload() };
    });
}

fn close(id: u64) {
    let Some(mut page) = PAGES.with_borrow_mut(|pages| pages.remove(&id)) else { return };
    page.shared.stop_audio();
    if let Some(mut view) = page.view.take() {
        stop_capture(&page.shared, &mut view);
        close_view(view);
    }
    if page.settings.reroute_audio {
        env::release_profile(&page.shared.profile);
    }
}

/// Closes every page. Runs on OBS exit, before the WebView2 environment goes.
pub fn close_all() {
    let ids: Vec<u64> = PAGES.with_borrow(|pages| pages.keys().copied().collect());
    ids.into_iter().for_each(close);
    if let Some(host) = HOST.take() {
        unsafe {
            let _ = DestroyWindow(host.window);
        }
    }
}

/// Runs `f` with the host, creating it on first use.
fn host<R>(f: impl FnOnce(&Host) -> R) -> Result<R, String> {
    HOST.with_borrow_mut(|slot| {
        if slot.is_none() {
            *slot = Some(create_host().map_err(|e| e.to_string())?);
        }
        Ok(f(slot.as_ref().unwrap()))
    })
}

fn create_host() -> windows::core::Result<Host> {
    // Windows.UI.Composition needs a DispatcherQueue on this thread; OBS's Qt
    // message loop pumps it.
    let queue = match DispatcherQueue::GetForCurrentThread() {
        Ok(_) => None,
        Err(_) => Some(unsafe {
            CreateDispatcherQueueController(DispatcherQueueOptions {
                dwSize: size_of::<DispatcherQueueOptions>() as u32,
                threadType: DQTYPE_THREAD_CURRENT,
                apartmentType: DQTAT_COM_NONE,
            })?
        }),
    };
    let compositor = Compositor::new()?;

    let instance = unsafe { GetModuleHandleW(None)? };
    let class = WNDCLASSEXW {
        cbSize: size_of::<WNDCLASSEXW>() as u32,
        lpfnWndProc: Some(host_window_proc),
        hInstance: instance.into(),
        lpszClassName: w!("TheaterWebSourceHost"),
        ..Default::default()
    };
    unsafe { RegisterClassExW(&class) };
    // Shown (a hidden parent can make WebView2 stop painting) but off-screen,
    // fully transparent and click-through, with no taskbar button.
    let window = unsafe {
        CreateWindowExW(
            WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_LAYERED | WS_EX_TRANSPARENT,
            w!("TheaterWebSourceHost"),
            PCWSTR::null(),
            WS_POPUP | WS_VISIBLE,
            -32000,
            -32000,
            1,
            1,
            None,
            None,
            Some(instance.into()),
            None,
        )?
    };
    unsafe { SetLayeredWindowAttributes(window, COLORREF(0), 0, LWA_ALPHA)? };
    Ok(Host { _queue: queue, compositor, window })
}

unsafe extern "system" fn host_window_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

#[cfg(test)]
mod tests {
    use super::with_scheme;

    #[test]
    fn urls_without_a_scheme_get_https() {
        assert_eq!(with_scheme("app.hyperate.io/C972"), "https://app.hyperate.io/C972");
        assert_eq!(with_scheme(" https://reactive.fugi.tech/x "), "https://reactive.fugi.tech/x");
        assert_eq!(with_scheme("http://localhost:8080"), "http://localhost:8080");
        assert_eq!(with_scheme("about:blank"), "about:blank");
        assert_eq!(with_scheme(""), "");
    }
}
