//! Apps: a frontend folder served at http://tauri.localhost/ (the origin Tauri
//! itself uses on Windows) whose pages get the `window.__TAURI__` bridge. This
//! is how a Tauri frontend such as the Control Panel runs inside OBS unchanged.
//! The folder is only ever read.

use std::borrow::Cow;
use std::fs;
use std::path::{Path, PathBuf};

use wry::http::Response;
use wry::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use wry::{PageLoadEvent, WebViewBuilder};

use crate::{bridge, obs, ui, views};

const SCHEME: &str = "tauri";
const HOST: &str = "tauri.localhost";
const BRIDGE_JS: &str = include_str!("bridge.js");

pub struct App {
    pub root: PathBuf,
    /// Where the app's own files go (save_config_file / read_config_file):
    /// plugin_config\theater-control-panel\apps\<id>.
    pub data_dir: PathBuf,
}

impl App {
    pub fn new(id: &str, root: PathBuf) -> Option<App> {
        let data_dir = obs::module_config_path(&format!("apps/{id}"))?;
        Some(App { root, data_dir })
    }

    pub fn url(&self, page: &str) -> String {
        format!("http://{HOST}/{}", page.trim_start_matches('/'))
    }
}

/// Serves `app` to the webview being built and connects its bridge. `label` is
/// the webview's label in `views`, which commands use to find their caller.
pub fn configure<'b>(builder: WebViewBuilder<'b>, app: &App, label: &str) -> WebViewBuilder<'b> {
    let root = app.root.clone();
    let label = label.to_string();
    let loading_label = label.clone();
    builder
        .with_initialization_script(BRIDGE_JS)
        // A new document (reload, navigation) starts without the old page's web
        // tabs. Raised before any of its scripts run, so the old tabs are gone
        // before the new page asks for its own.
        .with_on_page_load_handler(move |event, _url| {
            if matches!(event, PageLoadEvent::Started) {
                let label = loading_label.clone();
                ui::post(move || views::close_children_of(&label));
            }
        })
        .with_custom_protocol(SCHEME.into(), move |_id, request| serve(&root, request.uri().path()))
        .with_ipc_handler(move |request| {
            // Only the app's own pages may call commands, not sites it navigates to.
            let uri = request.uri();
            if uri.scheme_str() == Some("http") && uri.host() == Some(HOST) {
                bridge::handle(&label, request.body());
            }
        })
}

fn serve(root: &Path, path: &str) -> Response<Cow<'static, [u8]>> {
    let relative = percent_decode(path.trim_start_matches('/'));
    let allowed = !relative.is_empty()
        && !relative.contains(':')
        && !relative.split(['/', '\\']).any(|part| part == "..");
    match allowed.then(|| fs::read(root.join(&relative))) {
        Some(Ok(bytes)) => respond(200, content_type(&relative), Cow::Owned(bytes)),
        _ => respond(404, "text/plain", Cow::Borrowed(b"Not found")),
    }
}

fn respond(status: u16, content_type: &str, body: Cow<'static, [u8]>) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, content_type)
        // Serve edits to the app folder right away.
        .header(CACHE_CONTROL, "no-store")
        .body(body)
        .unwrap()
}

fn content_type(path: &str) -> &'static str {
    let ext = Path::new(path).extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" | "tcp" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "txt" | "md" | "log" => "text/plain; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        _ => "application/octet-stream",
    }
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = bytes.get(i + 1..i + 3).and_then(|h| std::str::from_utf8(h).ok());
        match (bytes[i], hex.and_then(|h| u8::from_str_radix(h, 16).ok())) {
            (b'%', Some(byte)) => {
                out.push(byte);
                i += 3;
            }
            (byte, _) => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}
