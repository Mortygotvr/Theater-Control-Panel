//! The Control Panel's Tauri commands (Control Panel 1.01, src-tauri/src/lib.rs)
//! ported to run inside OBS. Arguments arrive the way Tauri takes them: camelCase.

use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::net::TcpListener;
use std::os::windows::process::CommandExt;
use std::process::Command;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, PoisonError};
use std::thread;
use std::time::Duration;

use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use crate::app::App;
use crate::bridge::Reply;
use crate::child;
use crate::obs::log_warn;
use crate::toplevel;
use crate::views::{self, Kind};
use crate::{procs, ui, win32};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Deserialize)]
struct SaveArgs {
    filename: String,
    content: String,
}

#[derive(Deserialize)]
struct FileArgs {
    filename: String,
}

#[derive(Deserialize)]
struct UrlArgs {
    url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoopbackArgs {
    port: u16,
    event_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OauthArgs {
    url: String,
    redirect_uri_prefix: String,
    event_name: String,
}

#[derive(Deserialize)]
struct LoginArgs {
    url: String,
    title: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HiddenArgs {
    url: String,
    js: String,
    delay_ms: u64,
    close_delay_ms: u64,
}

#[derive(Deserialize)]
struct AutomatedArgs {
    url: String,
    js: String,
}

#[derive(Deserialize)]
struct ExternalArgs {
    program: String,
    #[serde(default)]
    args: Vec<String>,
}

#[derive(Deserialize)]
struct LabelArgs {
    label: String,
}

#[derive(Deserialize)]
struct NavigateArgs {
    label: String,
    url: String,
}

#[derive(Deserialize)]
struct LabelZoomArgs {
    label: String,
    zoom: f64,
}

#[derive(Deserialize)]
struct LabelMuteArgs {
    label: String,
    muted: bool,
}

#[derive(Deserialize)]
struct MuteArgs {
    muted: bool,
}

#[derive(Deserialize)]
struct ZoomArgs {
    zoom: f64,
}

#[derive(Deserialize)]
struct PerformanceArgs {
    settings: crate::perf::Performance,
}

/// For commands that return nothing (null in JS, like a Tauri command returning ()).
fn null<T>(_: T) -> Value {
    Value::Null
}

fn parse<T: DeserializeOwned>(args: Value) -> Result<T, String> {
    serde_json::from_value(args).map_err(|e| format!("invalid args: {e}"))
}

pub fn invoke(cmd: &str, args: Value, reply: Reply) {
    let caller = reply.caller().to_string();
    let result = match cmd {
        "save_config_file" => parse(args).and_then(|a| save_config_file(&caller, a)),
        "read_config_file" => parse(args).and_then(|a| read_config_file(&caller, a)),
        "open_in_browser" => parse(args).and_then(|a: UrlArgs| {
            win32::shell_open(&a.url).then_some(Value::Null).ok_or(format!("couldn't open {}", a.url))
        }),
        "start_loopback_listener" => parse(args).map(|a: LoopbackArgs| start_loopback_listener(a.port, a.event_name)),
        "update_child_webview" => parse(args).map(child::update).map(null),
        "destroy_child_webview" => parse(args).map(|a: LabelArgs| views::close_child(&a.label)).map(null),
        "hide_child_webview" => parse(args).map(|a: LabelArgs| child::hide(&a.label)).map(null),
        "reload_child_webview" => eval_in(args, "window.location.reload();"),
        "navigate_child_webview_back" => eval_in(args, "window.history.back();"),
        "navigate_child_webview_forward" => eval_in(args, "window.history.forward();"),
        "navigate_child_webview_url" => parse(args)
            .map(|a: NavigateArgs| views::with_child(&a.label, |v| v.webview.load_url(&a.url)))
            .map(null),
        "set_child_webview_zoom" => parse(args)
            .map(|a: LabelZoomArgs| views::with_child(&a.label, |v| v.webview.zoom(a.zoom)))
            .map(null),
        "toggle_child_webview_mute" => parse(args)
            .map(|a: LabelMuteArgs| views::with_child(&a.label, |v| child::set_muted(&v.webview, a.muted)))
            .map(null),
        "toggle_global_mute" => parse(args).map(|a: MuteArgs| {
            for label in views::labels_of(Kind::Child) {
                views::with_child(&label, |v| child::set_muted(&v.webview, a.muted));
            }
            Value::Null
        }),
        // A dock has no window frame to lock; the page locks its own layout.
        "toggle_window_lock" => Ok(Value::Null),
        // Not Control Panel 1.01 commands: plugins' OBS procedures and signals.
        "obs_call_proc" => parse(args).and_then(procs::call),
        "obs_forward_signal" => parse(args).and_then(procs::forward_signal).map(null),
        "report_zoom" => parse(args).map(|a: ZoomArgs| {
            views::emit("webview_zoom_changed", &json!({ "label": caller, "zoom": a.zoom }));
            Value::Null
        }),
        "apply_zoom" => parse(args).map(|a: ZoomArgs| views::with(&caller, |v| v.webview.zoom(a.zoom))).map(null),
        // The ⚡ Performance panel
        "get_performance" => Ok(crate::perf::to_json()),
        "set_performance" => parse(args).and_then(|a: PerformanceArgs| crate::perf::set(a.settings)),
        // These answer later: once their webview is built, or from a worker thread.
        "open_oauth_window" => {
            return later(args, reply, |a: OauthArgs, reply| {
                toplevel::open_oauth(a.url, a.redirect_uri_prefix, a.event_name, answer(reply));
            });
        }
        "open_service_login" => {
            return later(args, reply, |a: LoginArgs, reply| toplevel::open_service_login(a.url, a.title, answer(reply)));
        }
        "open_automated_webview" => {
            return later(args, reply, |a: AutomatedArgs, reply| {
                let label = format!("auto_webview_{}", next_id());
                toplevel::open_hidden(&label, a.url, Some(a.js), answer(reply));
            });
        }
        "create_child_webview" => return later(args, reply, |a, reply| child::create(&caller, a, answer(reply))),
        "run_external_command" => return later(args, reply, run_external_command),
        "open_hidden_webview" => return later(args, reply, open_hidden_webview),
        _ => Err(format!("command {cmd} not found")),
    };
    reply.send(result);
}

/// Starts a command that answers later, or answers now if its args are bad.
fn later<T: DeserializeOwned>(args: Value, reply: Reply, start: impl FnOnce(T, Reply)) {
    match parse(args) {
        Ok(args) => start(args, reply),
        Err(e) => reply.send(Err(e)),
    }
}

/// Sends a finished webview's outcome as the reply (null on success).
fn answer(reply: Reply) -> impl FnOnce(Result<(), String>) + 'static {
    move |result| reply.send(result.map(null))
}

fn eval_in(args: Value, js: &str) -> Result<Value, String> {
    parse(args).map(|a: LabelArgs| {
        views::with_child(&a.label, |v| v.webview.evaluate_script(js));
        Value::Null
    })
}

/// The caller's app, checking `filename` is a plain file name.
fn app_for_file(caller: &str, filename: &str) -> Result<Rc<App>, String> {
    let app = views::app_of(caller).ok_or("config files are only available to app pages")?;
    if filename.is_empty() || filename == "." || filename == ".." || filename.contains(['/', '\\', ':']) {
        return Err(format!("invalid file name: {filename}"));
    }
    Ok(app)
}

fn save_config_file(caller: &str, args: SaveArgs) -> Result<Value, String> {
    let app = app_for_file(caller, &args.filename)?;
    let path = app.data_dir.join(&args.filename);
    fs::create_dir_all(&app.data_dir)
        .and_then(|()| fs::write(&path, &args.content))
        .map_err(|e| e.to_string())?;
    Ok(Value::String(path.to_string_lossy().into_owned()))
}

fn read_config_file(caller: &str, args: FileArgs) -> Result<Value, String> {
    let app = app_for_file(caller, &args.filename)?;
    // Until the app saves its own copy, read the one in the app folder.
    let saved = app.data_dir.join(&args.filename);
    let path = if saved.exists() { saved } else { app.root.join(&args.filename) };
    fs::read_to_string(path).map(Value::String).map_err(|e| e.to_string())
}

fn run_external_command(args: ExternalArgs, reply: Reply) {
    thread::spawn(move || {
        let output = Command::new(&args.program).args(&args.args).creation_flags(CREATE_NO_WINDOW).output();
        reply.send(match output {
            Ok(out) if out.status.success() => Ok(Value::String(String::from_utf8_lossy(&out.stdout).into_owned())),
            Ok(out) => Err(String::from_utf8_lossy(&out.stderr).into_owned()),
            Err(e) => Err(e.to_string()),
        });
    });
}

fn next_id() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

/// Loads `url` in an invisible window, runs `js` after `delay_ms`, and closes it
/// `close_delay_ms` later. One at a time, like the Control Panel's WebviewLock.
fn open_hidden_webview(args: HiddenArgs, reply: Reply) {
    static TURN: Mutex<()> = Mutex::new(());
    thread::spawn(move || {
        let _turn = TURN.lock().unwrap_or_else(PoisonError::into_inner);
        let label = format!("hidden_webview_{}", next_id());

        let (l, url) = (label.clone(), args.url);
        ui::post(move || {
            let shown = url.clone();
            toplevel::open_hidden(&l, url, None, move |result| {
                if let Err(e) = result {
                    log_warn!("hidden webview for {shown}: {e}");
                }
            });
        });
        thread::sleep(Duration::from_millis(args.delay_ms));
        let (l, js) = (label.clone(), args.js);
        ui::post(move || views::eval(&l, &js));
        thread::sleep(Duration::from_millis(args.close_delay_ms));
        ui::post(move || views::close(&label));
        reply.send(Ok(Value::Null));
    });
}

const LOOPBACK_RESPONSE: &str = "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n\
<html><head><title>Authorization Successful</title><style>\
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #121212; color: #ffffff; text-align: center; padding-top: 100px; }\
.container { max-width: 500px; margin: 0 auto; padding: 40px; background: #1e1e1e; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.5); }\
h1 { color: #4caf50; } p { color: #b0b0b0; font-size: 1.1em; }\
</style></head><body><div class='container'><h1>Setup Successful!</h1>\
<p>Theater has captured your authorization key.</p><p>You can safely close this browser window now.</p>\
</div></body></html>";

/// Waits for one OAuth redirect on 127.0.0.1:`port` and emits `event` with its path.
fn start_loopback_listener(port: u16, event: String) -> Value {
    thread::spawn(move || {
        let listener = match TcpListener::bind(("127.0.0.1", port)) {
            Ok(listener) => listener,
            Err(e) => return log_warn!("loopback listener on port {port}: {e}"),
        };
        // Poll so the thread ends when OBS exits instead of waiting forever.
        let _ = listener.set_nonblocking(true);
        let mut stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(e) if e.kind() == ErrorKind::WouldBlock && !ui::shutting_down() => {
                    thread::sleep(Duration::from_millis(100));
                }
                Err(_) => return,
            }
        };
        let _ = stream.set_nonblocking(false);
        let mut buffer = [0; 2048];
        if let Ok(n) = stream.read(&mut buffer) {
            let request = String::from_utf8_lossy(&buffer[..n]);
            if let Some(path) = request.lines().next().and_then(|line| line.split_whitespace().nth(1)) {
                let path = path.to_string();
                ui::post(move || views::emit(&event, &Value::String(path)));
            }
        }
        let _ = stream.write_all(LOOPBACK_RESPONSE.as_bytes());
        let _ = stream.flush();
    });
    Value::Null
}
