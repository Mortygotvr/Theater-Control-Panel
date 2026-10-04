use std::fs;
use std::process::Command;
// Force rebuild 1
use std::io::{Read, Write};
use std::time::Duration;
use tokio::process::Command as AsyncCommand;
use tauri::{Emitter, Manager, WebviewUrl};
use tauri::webview::WebviewWindowBuilder;



fn get_base_dir() -> Result<std::path::PathBuf, String> {
  if cfg!(debug_assertions) {
    let mut path = std::env::current_dir().map_err(|e| e.to_string())?;
    if path.ends_with("src-tauri") {
        path.pop();
    }
    Ok(path)
  } else {
    let mut path = std::env::current_exe().map_err(|e| e.to_string())?;
    path.pop(); // Remove the executable filename
    Ok(path)
  }
}

#[tauri::command]
fn save_config_file(filename: String, content: String) -> Result<String, String> {
  let mut path = get_base_dir()?;
  path.push(&filename);
  fs::write(&path, &content).map_err(|e| e.to_string())?;
  println!("save_config_file ({}): {}", filename, content);
  Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn read_config_file(filename: String) -> Result<String, String> {
  let mut path = get_base_dir()?;
  path.push(&filename);
  let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
  println!("read_config_file ({}): {}", filename, content);
  Ok(content)
}

#[tauri::command]
async fn run_external_command(program: String, args: Vec<String>) -> Result<String, String> {
  let mut cmd = AsyncCommand::new(&program);
  cmd.args(&args);
  #[cfg(target_os = "windows")]
  {
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
  }
  let output = cmd.output().await.map_err(|e| e.to_string())?;
  if output.status.success() {
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
  } else {
    Err(String::from_utf8_lossy(&output.stderr).into_owned())
  }
}

#[allow(dead_code)]
#[derive(Clone, Copy)]
struct ActiveWebviewRect {
  x: f64,
  y: f64,
  width: f64,
  height: f64,
}

struct ActiveWebviewsState(std::sync::Mutex<std::collections::HashMap<String, ActiveWebviewRect>>);

#[tauri::command]
async fn open_oauth_window(
  app: tauri::AppHandle,
  url: String,
  redirect_uri_prefix: String,
  event_name: String,
) -> Result<(), String> {
  let label = "oauth_flow";

  // Close any existing oauth window if it exists to avoid overlapping
  if let Some(existing_win) = app.get_webview_window(label) {
    let _ = existing_win.close();
  }

  let handle = app.app_handle().clone();
  let _auth_window = WebviewWindowBuilder::new(
    &app,
    label,
    WebviewUrl::External(url.parse().map_err(|e| format!("Invalid URL: {}", e))?)
  )
  .title("Authorization")
  .inner_size(600.0, 700.0)
  .resizable(true)
  .always_on_top(true)
  .on_navigation(move |url| {
    let url_str = url.as_str();
    if url_str.starts_with(&redirect_uri_prefix) {
      let _ = handle.emit(&event_name, url_str.to_string());

      let inner_handle = handle.clone();
      tauri::async_runtime::spawn(async move {
        if let Some(win) = inner_handle.get_webview_window(label) {
          let _ = win.close();
        }
      });

      false
    } else {
      true
    }
  })
  .build()
  .map_err(|e| e.to_string())?;

  Ok(())
}

#[tauri::command]
fn start_loopback_listener(app: tauri::AppHandle, port: u16, event_name: String) -> Result<(), String> {
  let handle = app.app_handle().clone();
  
  std::thread::spawn(move || {
    let addr = format!("127.0.0.1:{}", port);
    if let Ok(listener) = std::net::TcpListener::bind(&addr) {
      if let Ok((mut stream, _)) = listener.accept() {
        let mut buffer = [0; 2048];
        if let Ok(bytes_read) = stream.read(&mut buffer) {
          let request = String::from_utf8_lossy(&buffer[..bytes_read]);
          
          if let Some(get_line) = request.lines().next() {
            let parts: Vec<&str> = get_line.split_whitespace().collect();
            if parts.len() >= 2 {
              let path = parts[1];
              use tauri::Emitter;
              let _ = handle.emit(&event_name, path.to_string());
            }
          }
        }
        
        let response = "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n\
        <html>\
          <head>\
            <title>Authorization Successful</title>\
            <style>\
              body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #121212; color: #ffffff; text-align: center; padding-top: 100px; }\
              .container { max-width: 500px; margin: 0 auto; padding: 40px; background: #1e1e1e; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.5); }\
              h1 { color: #4caf50; }\
              p { color: #b0b0b0; font-size: 1.1em; }\
            </style>\
          </head>\
          <body>\
            <div class='container'>\
              <h1>Setup Successful!</h1>\
              <p>Theater has captured your authorization key.</p>\
              <p>You can safely close this browser window now.</p>\
            </div>\
          </body>\
        </html>";
        let _ = stream.write_all(response.as_bytes());
        let _ = stream.flush();
      }
    }
  });

  Ok(())
}

#[tauri::command]
fn open_in_browser(url: String) -> Result<(), String> {
  #[cfg(target_os = "windows")]
  {
    use std::os::windows::process::CommandExt;
    Command::new("rundll32")
      .args(["url.dll,FileProtocolHandler", &url])
      .creation_flags(0x08000000) // CREATE_NO_WINDOW
      .spawn()
      .map_err(|e| e.to_string())?;
  }

  #[cfg(target_os = "macos")]
  Command::new("open")
    .arg(&url)
    .spawn()
    .map_err(|e| e.to_string())?;

  #[cfg(target_os = "linux")]
  Command::new("xdg-open")
    .arg(&url)
    .spawn()
    .map_err(|e| e.to_string())?;

  Ok(())
}

#[tauri::command]
async fn open_service_login(app: tauri::AppHandle, url: String, title: String) -> Result<(), String> {
  let label = "service_login";
  if let Some(win) = app.get_webview_window(label) {
    let _ = win.show();
    let _ = win.set_focus();
  } else {
    let _auth_window = WebviewWindowBuilder::new(
      &app,
      label,
      WebviewUrl::External(url.parse().map_err(|e| format!("Invalid URL: {}", e))?)
    )
    .title(title)
    .inner_size(800.0, 700.0)
    .resizable(true)
    .always_on_top(true)
    .build()
    .map_err(|e| e.to_string())?;
  }
  Ok(())
}

pub struct WebviewLock {
  pub lock: tokio::sync::Mutex<()>,
}

#[tauri::command]
async fn open_hidden_webview(
  app: tauri::AppHandle,
  state: tauri::State<'_, WebviewLock>,
  url: String,
  js: String,
  delay_ms: u64,
  close_delay_ms: u64,
) -> Result<(), String> {
  let _lock = state.lock.lock().await;

  let timestamp = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .unwrap_or_default()
    .as_millis();
  static WEBVIEW_COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
  let count = WEBVIEW_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
  let label = format!("hidden_webview_{}_{}", timestamp, count);
  
  let handle = app.app_handle().clone();
  let win_label = label.clone();

  // Capture the currently focused window BEFORE creating the automation webview.
  // Store as isize (which is Send) rather than HWND (which is not Send) so it
  // can safely exist across the .await boundary below.
  #[cfg(windows)]
  let prev_foreground_raw: isize = unsafe {
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    GetForegroundWindow().0 as isize
  };

  let _webview = WebviewWindowBuilder::new(
    &app,
    &label,
    WebviewUrl::External(url.parse().map_err(|e| format!("Invalid URL: {}", e))?)
  )
  .visible(false)
  .skip_taskbar(true)
  .focused(false)
  .transparent(true)
  .decorations(false)
  .inner_size(100.0, 100.0)
  .build()
  .map_err(|e| e.to_string())?;

  #[cfg(windows)]
  {
    if let Ok(hwnd) = _webview.hwnd() {
      unsafe {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
          GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, SetForegroundWindow,
          GWL_EXSTYLE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
          SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SWP_NOACTIVATE, SWP_HIDEWINDOW,
        };
        let hwnd_ptr: *mut std::ffi::c_void = std::mem::transmute(hwnd);
        let hwnd = HWND(hwnd_ptr);
        // Stamp WS_EX_NOACTIVATE so the window can never steal focus in the future
        let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(
          hwnd,
          GWL_EXSTYLE,
          ex_style | WS_EX_NOACTIVATE.0 as isize | WS_EX_TOOLWINDOW.0 as isize,
        );
        // Hide the window at its current position â€” no move needed
        let _ = SetWindowPos(
          hwnd,
          None,
          0, 0, 0, 0,
          SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_HIDEWINDOW,
        );
        // Immediately restore focus to whatever window had it before
        if prev_foreground_raw != 0 {
          use windows::Win32::Foundation::HWND;
          let _ = SetForegroundWindow(HWND(prev_foreground_raw as *mut _));
        }
      }
    }
  }

  // We must drop the WebviewWindow handle here because it is not `Send`
  // and cannot be held across the upcoming `.await` point.
  drop(_webview);

  tokio::time::sleep(Duration::from_millis(delay_ms)).await;
  if let Some(w) = handle.get_webview_window(&win_label) {
    let _ = w.eval(&js);
  }

  tokio::time::sleep(Duration::from_millis(close_delay_ms)).await;
  if let Some(w) = handle.get_webview_window(&win_label) {
    let _ = w.close();
  }
  
  Ok(())
}

#[tauri::command]
async fn open_automated_webview(
  app: tauri::AppHandle,
  url: String,
  js: String,
) -> Result<(), String> {
  let timestamp = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .unwrap_or_default()
    .as_millis();
  static WEBVIEW_COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
  let count = WEBVIEW_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
  let label = format!("auto_webview_{}_{}", timestamp, count);

  // Capture focused window before creation â€” stored as isize (Send-safe).
  #[cfg(windows)]
  let prev_foreground_raw: isize = unsafe {
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    GetForegroundWindow().0 as isize
  };

  let _webview = WebviewWindowBuilder::new(
    &app,
    &label,
    WebviewUrl::External(url.parse().map_err(|e| format!("Invalid URL: {}", e))?)
  )
  .title("Automated Webview")
  .resizable(false)
  .visible(false)
  .skip_taskbar(true)
  .focused(false)
  .transparent(true)
  .decorations(false)
  .inner_size(100.0, 100.0)
  .initialization_script(&js)
  .build()
  .map_err(|e| e.to_string())?;

  #[cfg(windows)]
  {
    if let Ok(hwnd) = _webview.hwnd() {
      unsafe {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
          GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, SetForegroundWindow,
          GWL_EXSTYLE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
          SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SWP_NOACTIVATE, SWP_HIDEWINDOW,
        };
        let hwnd_ptr: *mut std::ffi::c_void = std::mem::transmute(hwnd);
        let hwnd = HWND(hwnd_ptr);
        let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        SetWindowLongPtrW(
          hwnd,
          GWL_EXSTYLE,
          ex_style | WS_EX_NOACTIVATE.0 as isize | WS_EX_TOOLWINDOW.0 as isize,
        );
        let _ = SetWindowPos(
          hwnd,
          None,
          0, 0, 0, 0,
          SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_HIDEWINDOW,
        );
        // Restore focus to the previously active window
        if prev_foreground_raw != 0 {
          use windows::Win32::Foundation::HWND;
          let _ = SetForegroundWindow(HWND(prev_foreground_raw as *mut _));
        }
      }
    }
  }
  
  Ok(())
}

#[allow(dead_code)]
struct SafeHandler(webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2ZoomFactorChangedEventHandler);
unsafe impl Send for SafeHandler {}
unsafe impl Sync for SafeHandler {}

fn get_handlers() -> &'static std::sync::Mutex<std::collections::HashMap<String, SafeHandler>> {
  static HANDLERS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, SafeHandler>>> = std::sync::OnceLock::new();
  HANDLERS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

#[tauri::command]
async fn create_child_webview(
  app: tauri::AppHandle,
  state: tauri::State<'_, ActiveWebviewsState>,
  label: String,
  url: String,
  x: f64,
  y: f64,
  width: f64,
  height: f64,
  zoom: Option<f64>,
  visible: Option<bool>,
  muted: Option<bool>,
) -> Result<(), String> {
  match create_child_webview_impl(app, state, label, url, x, y, width, height, zoom, visible.unwrap_or(true), muted.unwrap_or(false)).await {
    Ok(_) => Ok(()),
    Err(e) => {
      println!("ERROR in create_child_webview: {}", e);
      Err(e)
    }
  }
}

async fn create_child_webview_impl(
  app: tauri::AppHandle,
  state: tauri::State<'_, ActiveWebviewsState>,
  label: String,
  url: String,
  x: f64,
  y: f64,
  width: f64,
  height: f64,
  zoom: Option<f64>,
  visible: bool,
  muted: bool,
) -> Result<(), String> {
  // Register initial coordinates in state map so it follows the parent window
  if let Ok(mut map) = state.0.lock() {
    map.insert(label.clone(), ActiveWebviewRect { x, y, width, height });
    println!("Saved initial webview {} bounds to map: x:{}, y:{}, w:{}, h:{}", label, x, y, width, height);
  }

  let main_win = app.get_webview_window("main")
    .ok_or_else(|| "Main window not found".to_string())?;

  let scale_factor = main_win.scale_factor().unwrap_or(1.0);
  
  let physical_x = x * scale_factor;
  let physical_y = y * scale_factor;
  let physical_width = width * scale_factor;
  let physical_height = height * scale_factor;

  let x_val = if physical_x.is_finite() { physical_x as i32 } else { 0 };
  let y_val = if physical_y.is_finite() { physical_y as i32 } else { 0 };
  let mut w_val = if physical_width.is_finite() && physical_width > 0.0 { physical_width as u32 } else { 0 };
  let mut h_val = if physical_height.is_finite() && physical_height > 0.0 { physical_height as u32 } else { 0 };

  if w_val < 100 {
    w_val = 100;
  }
  if h_val < 100 {
    h_val = 100;
  }

  let mut screen_x = x_val;
  let mut screen_y = y_val;

  #[cfg(windows)]
  {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Gdi::MapWindowPoints;
    use windows::Win32::Foundation::POINT;

    if let Ok(main_hwnd) = main_win.hwnd() {
      unsafe {
        let hwnd_ptr: *mut std::ffi::c_void = std::mem::transmute(main_hwnd);
        let pt = POINT { x: x_val, y: y_val };
        let mut points = [pt];
        MapWindowPoints(Some(HWND(hwnd_ptr)), None, &mut points);
        screen_x = points[0].x;
        screen_y = points[0].y;
      }
    }
  }

  let mut builder = tauri::webview::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::External(url.parse().map_err(|e| format!("Invalid URL: {}", e))?));
  
  #[cfg(windows)]
  if let Some(main_win_check) = app.get_webview_window("main") {
    if let Ok(main_hwnd) = main_win_check.hwnd() {
      unsafe {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongW, GWL_EXSTYLE, WS_EX_TOPMOST};
        let hwnd_ptr: *mut std::ffi::c_void = std::mem::transmute(main_hwnd);
        let ex_style = GetWindowLongW(HWND(hwnd_ptr), GWL_EXSTYLE);
        if (ex_style & WS_EX_TOPMOST.0 as i32) != 0 {
          builder = builder.always_on_top(true);
        }
      }
    }
  }

  // Create it hidden initially so it doesn't flash white before we apply transparent layered styles
  builder = builder.visible(false);
  
  println!("Creating webview: {} (active: {}) at x:{} y:{} w:{} h:{} with zoom: {:?}", label, visible, x_val, y_val, w_val, h_val, zoom);

  let fake_fullscreen_js = r#"
(function() {
  let fullscreenElement = null;

  const style = document.createElement('style');
  style.textContent = `
    .tauri-fake-fullscreen {
      position: fixed !important;
      top: 0 !important;
      left: 0 !important;
      width: 100vw !important;
      height: 100vh !important;
      z-index: 2147483647 !important;
      margin: 0 !important;
      padding: 0 !important;
      box-sizing: border-box !important;
      background: black !important;
    }
    .tauri-fake-fullscreen video {
      width: 100% !important;
      height: 100% !important;
      object-fit: contain !important;
    }
  `;
  
  const insertStyle = () => {
    if (document.head || document.documentElement) {
      (document.head || document.documentElement).appendChild(style);
    } else {
      setTimeout(insertStyle, 1);
    }
  };
  insertStyle();

  function triggerFullscreenChange() {
    const event = new Event('fullscreenchange', { bubbles: true, cancelable: true });
    if (typeof document.onfullscreenchange === 'function') {
      try { document.onfullscreenchange(event); } catch(e) {}
    }
    document.dispatchEvent(event);
    ['webkitfullscreenchange', 'mozfullscreenchange', 'MSFullscreenChange'].forEach(eventName => {
      const e = new Event(eventName, { bubbles: true, cancelable: true });
      const onProp = 'on' + eventName.toLowerCase();
      if (typeof document[onProp] === 'function') {
        try { document[onProp](e); } catch(err) {}
      }
      document.dispatchEvent(e);
    });
  }

  Element.prototype.requestFullscreen = function() {
    return new Promise((resolve, reject) => {
      try {
        if (fullscreenElement) {
          document.exitFullscreen();
        }
        fullscreenElement = this;
        this.classList.add('tauri-fake-fullscreen');
        triggerFullscreenChange();
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  };

  Element.prototype.webkitRequestFullscreen = Element.prototype.requestFullscreen;
  Element.prototype.webkitRequestFullScreen = Element.prototype.requestFullscreen;
  Element.prototype.mozRequestFullScreen = Element.prototype.requestFullscreen;
  Element.prototype.msRequestFullscreen = Element.prototype.requestFullscreen;

  Object.defineProperty(document, 'fullscreenElement', {
    get: function() { return fullscreenElement; },
    configurable: true
  });
  Object.defineProperty(document, 'webkitFullscreenElement', {
    get: function() { return fullscreenElement; },
    configurable: true
  });
  Object.defineProperty(document, 'mozFullScreenElement', {
    get: function() { return fullscreenElement; },
    configurable: true
  });
  Object.defineProperty(document, 'msFullscreenElement', {
    get: function() { return fullscreenElement; },
    configurable: true
  });

  Object.defineProperty(document, 'fullscreenEnabled', {
    get: function() { return true; },
    configurable: true
  });
  Object.defineProperty(document, 'webkitFullscreenEnabled', {
    get: function() { return true; },
    configurable: true
  });
  Object.defineProperty(document, 'mozFullScreenEnabled', {
    get: function() { return true; },
    configurable: true
  });
  Object.defineProperty(document, 'msFullscreenEnabled', {
    get: function() { return true; },
    configurable: true
  });

  Object.defineProperty(document, 'fullscreen', {
    get: function() { return !!fullscreenElement; },
    configurable: true
  });
  Object.defineProperty(document, 'webkitIsFullScreen', {
    get: function() { return !!fullscreenElement; },
    configurable: true
  });
  Object.defineProperty(document, 'mozFullScreen', {
    get: function() { return !!fullscreenElement; },
    configurable: true
  });

  document.exitFullscreen = function() {
    return new Promise((resolve, reject) => {
      try {
        if (fullscreenElement) {
          fullscreenElement.classList.remove('tauri-fake-fullscreen');
          fullscreenElement = null;
          triggerFullscreenChange();
        }
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  };

  document.webkitExitFullscreen = document.exitFullscreen;
  document.webkitCancelFullScreen = document.exitFullscreen;
  document.mozCancelFullScreen = document.exitFullscreen;
  document.msExitFullscreen = document.exitFullscreen;

  window.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && fullscreenElement) {
      document.exitFullscreen();
    }
  }, true);
})();
"#;

  let init_script = format!(
    "window.__cpInitialZoom = {zoom};\n{fake_fullscreen_js}",
    zoom = zoom.unwrap_or(1.0),
    fake_fullscreen_js = fake_fullscreen_js
  );

  let _webview = builder
    .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
    .decorations(false)
    .resizable(false)
    .transparent(true)
    .shadow(false)
    .skip_taskbar(true)
    .zoom_hotkeys_enabled(true)
    .initialization_script(&init_script)
    .inner_size(w_val as f64, h_val as f64)
    .build()
    .map_err(|e| format!("Failed to build webview: {}", e))?;

  #[cfg(windows)]
  if muted {
    let _ = _webview.with_webview(|wv| {
      unsafe {
        if let Ok(core) = wv.controller().CoreWebView2() {
          use windows::core::Interface;
          use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_8;
          if let Ok(core8) = core.cast::<ICoreWebView2_8>() {
            let _ = core8.SetIsMuted(true);
          }
        }
      }
    });
  }

  #[cfg(windows)]
  {
    if let Ok(child_hwnd) = _webview.hwnd() {
      unsafe {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongW, SetWindowLongW, GWL_EXSTYLE, WS_EX_TRANSPARENT, WS_EX_LAYERED, SetLayeredWindowAttributes, LWA_ALPHA, SetWindowPos, SWP_SHOWWINDOW, SWP_NOACTIVATE, SWP_FRAMECHANGED, HWND_TOP, GWLP_HWNDPARENT};
        let hwnd_ptr: *mut std::ffi::c_void = std::mem::transmute(child_hwnd);
        let hwnd = HWND(hwnd_ptr);

        let mut ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE);
        
        // Ensure WS_EX_LAYERED is present
        if (ex_style & WS_EX_LAYERED.0 as i32) == 0 {
          SetWindowLongW(hwnd, GWL_EXSTYLE, ex_style | WS_EX_LAYERED.0 as i32);
          ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE);
        }

        // Set opacity to 0 initially to hide the window from the user (zero flash)
        let _ = SetLayeredWindowAttributes(hwnd, windows::Win32::Foundation::COLORREF(0), 0, LWA_ALPHA);

        if !visible {
          SetWindowLongW(hwnd, GWL_EXSTYLE, ex_style | WS_EX_TRANSPARENT.0 as i32);
        }

        // Set main_win as the owner of this top-level webview window
        if let Ok(main_hwnd) = main_win.hwnd() {
          let main_hwnd_ptr: *mut std::ffi::c_void = std::mem::transmute(main_hwnd);
          windows::Win32::UI::WindowsAndMessaging::SetWindowLongPtrW(
            hwnd,
            GWLP_HWNDPARENT,
            main_hwnd_ptr as isize,
          );
        }

        // Move to the correct onscreen coordinates and trigger OS visibility.
        let mut flags = SWP_SHOWWINDOW | SWP_FRAMECHANGED;
        if !visible {
            flags |= SWP_NOACTIVATE;
        }

        SetWindowPos(
          hwnd,
          Some(HWND_TOP),
          screen_x,
          screen_y,
          w_val as i32,
          h_val as i32,
          flags
        ).unwrap_or(());
      }
    }
  }

  // Wake up WebView2 rendering engine and unfreeze pages on initial spawn
  let w_clone = _webview.clone();
    tauri::async_runtime::spawn(async move {
      tokio::time::sleep(std::time::Duration::from_millis(150)).await;
      if visible {
        #[cfg(windows)]
        {
          if let Ok(child_hwnd) = w_clone.hwnd() {
            unsafe {
              use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongW, SetWindowLongW, GWL_EXSTYLE, WS_EX_TRANSPARENT, SetLayeredWindowAttributes, LWA_ALPHA};
              let hwnd_ptr: *mut std::ffi::c_void = std::mem::transmute(child_hwnd);
              let hwnd = windows::Win32::Foundation::HWND(hwnd_ptr);
              
              // Clear click-through and set opacity to 255
              let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE);
              SetWindowLongW(hwnd, GWL_EXSTYLE, ex_style & !WS_EX_TRANSPARENT.0 as i32);
              let _ = SetLayeredWindowAttributes(hwnd, windows::Win32::Foundation::COLORREF(0), 255, LWA_ALPHA);
            }
          }
        }
        let _ = w_clone.set_focus();
      }
      #[cfg(windows)]
      {
        let hwnd_isize: Option<isize> = w_clone.hwnd().ok().map(|h| unsafe {
          let ptr: *mut std::ffi::c_void = std::mem::transmute(h);
          ptr as isize
        });
        let _ = w_clone.with_webview(move |wv| {
          use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC;
          unsafe {
            let _ = wv.controller().SetIsVisible(true);
            let _ = wv.controller().MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
            let _ = wv.controller().NotifyParentWindowPositionChanged();
            if muted {
              if let Ok(core) = wv.controller().CoreWebView2() {
                use windows::core::Interface;
                use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_8;
                if let Ok(core8) = core.cast::<ICoreWebView2_8>() {
                  let _ = core8.SetIsMuted(true);
                }
              }
            }
          }

          if let Some(h_isize) = hwnd_isize {
            unsafe {
              let hwnd = windows::Win32::Foundation::HWND(h_isize as *mut std::ffi::c_void);

              // Wake up Chrome rendering host via native event
              let mut render_hwnd = windows::Win32::Foundation::HWND::default();
              let _ = windows::Win32::UI::WindowsAndMessaging::EnumChildWindows(
                Some(hwnd),
                Some(find_render_widget_hwnd),
                windows::Win32::Foundation::LPARAM(&mut render_hwnd as *mut windows::Win32::Foundation::HWND as isize),
              );

              let target = if !render_hwnd.0.is_null() { render_hwnd } else { hwnd };
              let click_lparam = windows::Win32::Foundation::LPARAM(((1i32 << 16) | 1i32) as isize);
              let _ = windows::Win32::UI::WindowsAndMessaging::SendMessageW(target, 0x0201u32, Some(windows::Win32::Foundation::WPARAM(0x0001)), Some(click_lparam));
              let _ = windows::Win32::UI::WindowsAndMessaging::SendMessageW(target, 0x0202u32, Some(windows::Win32::Foundation::WPARAM(0)),      Some(click_lparam));
            }
          }
        });
      }
      if let Some(z) = zoom {
        let res = w_clone.set_zoom(z);
        println!("delayed (150ms) set_zoom result: {:?}", res);
      }
  });

  // Secondary settlement pass after 1000ms
  let w_clone2 = _webview.clone();
  tauri::async_runtime::spawn(async move {
      tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
      #[cfg(windows)]
      {
        let hwnd_isize2: Option<isize> = w_clone2.hwnd().ok().map(|h| unsafe {
          let ptr: *mut std::ffi::c_void = std::mem::transmute(h);
          ptr as isize
        });
        let _ = w_clone2.with_webview(move |wv| {
          unsafe {
            let _ = wv.controller().SetIsVisible(true);
            let _ = wv.controller().NotifyParentWindowPositionChanged();
            if muted {
              if let Ok(core) = wv.controller().CoreWebView2() {
                use windows::core::Interface;
                use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_8;
                if let Ok(core8) = core.cast::<ICoreWebView2_8>() {
                  let _ = core8.SetIsMuted(true);
                }
              }
            }
          }

          if let Some(h_isize) = hwnd_isize2 {
            unsafe {
              let hwnd = windows::Win32::Foundation::HWND(h_isize as *mut std::ffi::c_void);

              let mut render_hwnd = windows::Win32::Foundation::HWND::default();
              let _ = windows::Win32::UI::WindowsAndMessaging::EnumChildWindows(
                Some(hwnd),
                Some(find_render_widget_hwnd),
                windows::Win32::Foundation::LPARAM(&mut render_hwnd as *mut windows::Win32::Foundation::HWND as isize),
              );

              let target = if !render_hwnd.0.is_null() { render_hwnd } else { hwnd };
              let click_lparam = windows::Win32::Foundation::LPARAM(((1i32 << 16) | 1i32) as isize);
              let _ = windows::Win32::UI::WindowsAndMessaging::SendMessageW(target, 0x0201u32, Some(windows::Win32::Foundation::WPARAM(0x0001)), Some(click_lparam));
              let _ = windows::Win32::UI::WindowsAndMessaging::SendMessageW(target, 0x0202u32, Some(windows::Win32::Foundation::WPARAM(0)),      Some(click_lparam));
            }
          }
        });
      }
      if let Some(z) = zoom {
        let res = w_clone2.set_zoom(z);
        println!("delayed (1000ms) set_zoom result: {:?}", res);
      }
  });

  // Subscribe to native WebView2 ZoomFactorChanged event.
  // We must do this on the webview's thread via with_webview().
  // ZoomFactorChanged fires whenever the user Ctrl+scrolls (even before JS sees it).
  #[cfg(windows)]
  {
    use webview2_com::ZoomFactorChangedEventHandler;

    let app_for_zoom = app.clone();
    let label_for_zoom = label.clone();

    let _ = _webview.with_webview(move |wv| {
      let controller = wv.controller();
      let app_inner = app_for_zoom.clone();
      let label_inner = label_for_zoom.clone();
      let label_inner_for_map = label_for_zoom.clone();
      let handler = ZoomFactorChangedEventHandler::create(Box::new(move |ctrl, _args| {
        if let Some(ctrl) = ctrl {
          let mut zoom_val: f64 = 1.0;
            if unsafe { ctrl.ZoomFactor(&mut zoom_val) }.is_ok() {
              println!("Native ZoomFactorChanged triggered for webview: {}, zoom: {}", label_inner, zoom_val);
              let _ = app_inner.emit(
                "child-zoom-changed",
                serde_json::json!({"label": label_inner, "zoom": zoom_val})
              );
            }
        }
        Ok(())
      }));
      let mut token: i64 = 0;
      let _ = unsafe { controller.add_ZoomFactorChanged(&handler, &mut token) };
      get_handlers().lock().unwrap().insert(label_inner_for_map, SafeHandler(handler));
    });
  }

  Ok(())
}

// Callback for EnumChildWindows to find the Chrome_RenderWidgetHostHWND inside WebView2
unsafe extern "system" fn find_render_widget_hwnd(
  child: windows::Win32::Foundation::HWND,
  lparam: windows::Win32::Foundation::LPARAM,
) -> windows::core::BOOL {
  use windows::Win32::UI::WindowsAndMessaging::GetClassNameW;
  let mut buf = [0u16; 256];
  let len = GetClassNameW(child, &mut buf);
  if len > 0 {
    let class = String::from_utf16_lossy(&buf[..len as usize]);
    if class == "Chrome_RenderWidgetHostHWND" {
      let out = lparam.0 as *mut windows::Win32::Foundation::HWND;
      *out = child;
      return windows::core::BOOL(0); // stop enumeration
    }
  }
  windows::core::BOOL(1) // continue
}

#[tauri::command]
fn update_child_webview(
  app: tauri::AppHandle,
  state: tauri::State<'_, ActiveWebviewsState>,
  label: String,
  x: f64,
  y: f64,
  width: f64,
  height: f64,
  focus: Option<bool>,
) -> Result<(), String> {
  // Save active coordinates to global state so we can track and move window natively during parent drag/moved events
  {
    if let Ok(mut map) = state.0.lock() {
      map.insert(label.clone(), ActiveWebviewRect { x, y, width, height });
      println!("Saved active webview {} bounds to map: x:{}, y:{}, w:{}, h:{}", label, x, y, width, height);
    }
  }

  if let Some(webview) = app.get_webview_window(&label) {
    let main_win = app.get_webview_window("main").unwrap();
    let scale_factor = main_win.scale_factor().unwrap_or(1.0);
    
    let physical_x = x * scale_factor;
    let physical_y = y * scale_factor;
    let physical_width = width * scale_factor;
    let physical_height = height * scale_factor;

    let x_val = if physical_x.is_finite() { physical_x as i32 } else { 0 };
    let y_val = if physical_y.is_finite() { physical_y as i32 } else { 0 };
    let mut w_val = if physical_width.is_finite() && physical_width > 0.0 { physical_width as u32 } else { 0 };
    let mut h_val = if physical_height.is_finite() && physical_height > 0.0 { physical_height as u32 } else { 0 };

    if w_val < 100 {
      w_val = 100;
    }
    if h_val < 100 {
      h_val = 100;
    }

    let mut screen_x = x_val;
    let mut screen_y = y_val;

    #[cfg(windows)]
    {
      use windows::Win32::Foundation::HWND;
      use windows::Win32::Graphics::Gdi::MapWindowPoints;
      use windows::Win32::Foundation::POINT;

      if let Ok(main_hwnd) = main_win.hwnd() {
        unsafe {
          let hwnd_ptr: *mut std::ffi::c_void = std::mem::transmute(main_hwnd);
          let pt = POINT { x: x_val, y: y_val };
          let mut points = [pt];
          MapWindowPoints(Some(HWND(hwnd_ptr)), None, &mut points);
          screen_x = points[0].x;
          screen_y = points[0].y;
        }
      }
    }

    #[cfg(windows)]
    {
      if let Ok(child_hwnd) = webview.hwnd() {
        unsafe {
          let hwnd_ptr: *mut std::ffi::c_void = std::mem::transmute(child_hwnd);
          let hwnd = windows::Win32::Foundation::HWND(hwnd_ptr);
          
          use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongW, SetWindowLongW, GWL_EXSTYLE, WS_EX_TRANSPARENT, SetLayeredWindowAttributes, LWA_ALPHA};
          // Clear click-through style and make fully opaque
          let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE);
          SetWindowLongW(hwnd, GWL_EXSTYLE, ex_style & !WS_EX_TRANSPARENT.0 as i32);
          let _ = SetLayeredWindowAttributes(hwnd, windows::Win32::Foundation::COLORREF(0), 255, LWA_ALPHA);

          // Re-ensure main_win is the parent/owner window on every update
          if let Ok(main_hwnd) = main_win.hwnd() {
            let main_hwnd_ptr: *mut std::ffi::c_void = std::mem::transmute(main_hwnd);
            let current_owner = windows::Win32::UI::WindowsAndMessaging::GetWindowLongPtrW(hwnd, windows::Win32::UI::WindowsAndMessaging::GWLP_HWNDPARENT);
            if current_owner != main_hwnd_ptr as isize {
              windows::Win32::UI::WindowsAndMessaging::SetWindowLongPtrW(
                hwnd,
                windows::Win32::UI::WindowsAndMessaging::GWLP_HWNDPARENT,
                main_hwnd_ptr as isize,
              );
            }
          }

          if focus.unwrap_or(false) {
            let _ = windows::Win32::UI::WindowsAndMessaging::ShowWindow(hwnd, windows::Win32::UI::WindowsAndMessaging::SW_SHOW);
            let _ = webview.set_focus();
          } else {
            let _ = windows::Win32::UI::WindowsAndMessaging::ShowWindow(hwnd, windows::Win32::UI::WindowsAndMessaging::SW_SHOWNOACTIVATE);
          }
          
          windows::Win32::UI::WindowsAndMessaging::SetWindowPos(
            hwnd,
            Some(windows::Win32::UI::WindowsAndMessaging::HWND_TOP),
            screen_x,
            screen_y,
            w_val as i32,
            h_val as i32,
            windows::Win32::UI::WindowsAndMessaging::SWP_SHOWWINDOW | windows::Win32::UI::WindowsAndMessaging::SWP_FRAMECHANGED
          ).unwrap_or(());

          let hwnd_isize = hwnd.0 as isize;

          // Tell WebView2 the view is visible — resumes JS timers, animations, and compositor
          let _ = webview.with_webview(move |wv| {
            let _ = wv.controller().SetIsVisible(true);
            if focus.unwrap_or(false) {
              use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC;
              let _ = wv.controller().MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);

              // Reconstruct HWND from isize
              let hwnd = windows::Win32::Foundation::HWND(hwnd_isize as *mut std::ffi::c_void);

              // Send a single native click to Chrome_RenderWidgetHostHWND (0, 0)
              // to wake up page HTML rendering/interactions on show
              let mut render_hwnd = windows::Win32::Foundation::HWND::default();
              let _ = windows::Win32::UI::WindowsAndMessaging::EnumChildWindows(
                Some(hwnd),
                Some(find_render_widget_hwnd),
                windows::Win32::Foundation::LPARAM(&mut render_hwnd as *mut windows::Win32::Foundation::HWND as isize),
              );

              let target = if !render_hwnd.0.is_null() { render_hwnd } else { hwnd };
              let click_lparam = windows::Win32::Foundation::LPARAM(((1i32 << 16) | 1i32) as isize); // coordinates (1, 1)
              let _ = windows::Win32::UI::WindowsAndMessaging::SendMessageW(target, 0x0201u32, Some(windows::Win32::Foundation::WPARAM(0x0001)), Some(click_lparam)); // WM_LBUTTONDOWN
              let _ = windows::Win32::UI::WindowsAndMessaging::SendMessageW(target, 0x0202u32, Some(windows::Win32::Foundation::WPARAM(0)),      Some(click_lparam)); // WM_LBUTTONUP
            }
            let _ = wv.controller().NotifyParentWindowPositionChanged();
          });
        }
      }
    }
  }
  Ok(())
}

#[tauri::command]
fn destroy_child_webview(
  app: tauri::AppHandle,
  state: tauri::State<'_, ActiveWebviewsState>,
  label: String,
) -> Result<(), String> {
  {
    if let Ok(mut map) = state.0.lock() {
      map.remove(&label);
    }
  }
  {
    if let Ok(mut handlers) = get_handlers().lock() {
      handlers.remove(&label);
    }
  }
  if let Some(webview) = app.get_webview_window(&label) {
    #[cfg(windows)]
    if let Ok(child_hwnd) = webview.hwnd() {
      unsafe {
        use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, DestroyWindow, SW_HIDE};
        let hwnd_ptr: *mut std::ffi::c_void = std::mem::transmute(child_hwnd);
        let hwnd = windows::Win32::Foundation::HWND(hwnd_ptr);
        let _ = ShowWindow(hwnd, SW_HIDE);
        let _ = DestroyWindow(hwnd);
      }
    }
    let _ = webview.destroy();
    let _ = webview.close();
  }
  Ok(())
}

#[tauri::command]
fn reload_child_webview(app: tauri::AppHandle, label: String) -> Result<(), String> {
  if let Some(webview) = app.get_webview_window(&label) {
    let _ = webview.eval("window.location.reload();");
  }
  Ok(())
}

#[tauri::command]
fn navigate_child_webview_back(app: tauri::AppHandle, label: String) -> Result<(), String> {
  if let Some(webview) = app.get_webview_window(&label) {
    let _ = webview.eval("window.history.back();");
  }
  Ok(())
}

#[tauri::command]
fn navigate_child_webview_forward(app: tauri::AppHandle, label: String) -> Result<(), String> {
  if let Some(webview) = app.get_webview_window(&label) {
    let _ = webview.eval("window.history.forward();");
  }
  Ok(())
}

#[tauri::command]
fn navigate_child_webview_url(app: tauri::AppHandle, label: String, url: String) -> Result<(), String> {
  if let Some(webview) = app.get_webview_window(&label) {
    let _ = webview.navigate(url.parse().map_err(|e| format!("Invalid URL: {}", e))?);
  }
  Ok(())
}

#[tauri::command]
fn set_child_webview_zoom(app: tauri::AppHandle, label: String, zoom: f64) -> Result<(), String> {
  if let Some(webview) = app.get_webview_window(&label) {
    let _ = webview.set_zoom(zoom);
  }
  Ok(())
}

#[tauri::command]
fn toggle_child_webview_mute(app: tauri::AppHandle, label: String, muted: bool) -> Result<(), String> {
  if let Some(webview) = app.get_webview_window(&label) {
    #[cfg(windows)]
    {
      let _ = webview.with_webview(move |wv| {
        unsafe {
          if let Ok(core) = wv.controller().CoreWebView2() {
            use windows::core::Interface;
            use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_8;
            if let Ok(core8) = core.cast::<ICoreWebView2_8>() {
              let _ = core8.SetIsMuted(muted);
            }
          }
        }
      });
    }
  }
  Ok(())
}

#[tauri::command]
fn toggle_global_mute(app: tauri::AppHandle, state: tauri::State<'_, ActiveWebviewsState>, muted: bool) -> Result<(), String> {
  let labels: Vec<String> = match state.0.lock() {
    Ok(map) => map.keys().cloned().collect(),
    Err(_) => Vec::new(),
  };
  for label in labels {
    let _ = toggle_child_webview_mute(app.clone(), label, muted);
  }
  Ok(())
}

/// We keep the WebView2 renderer fully alive by leaving it visible at the OS level
/// but clipping its display region to 0x0. This makes it completely invisible to the
/// user and ignores mouse clicks, but prevents WebView2 from suspending its rendering.
#[tauri::command]
fn hide_child_webview(
  app: tauri::AppHandle,
  _state: tauri::State<'_, ActiveWebviewsState>,
  label: String,
) -> Result<(), String> {
  #[cfg(windows)]
  if let Some(webview) = app.get_webview_window(&label) {
    if let Ok(child_hwnd) = webview.hwnd() {
      unsafe {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongW, SetWindowLongW, GWL_EXSTYLE, WS_EX_TRANSPARENT, SetLayeredWindowAttributes, LWA_ALPHA};
        let hwnd_ptr: *mut std::ffi::c_void = std::mem::transmute(child_hwnd);
        let hwnd = HWND(hwnd_ptr);

        // Turn on click-through and fade out completely
        let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE);
        SetWindowLongW(hwnd, GWL_EXSTYLE, ex_style | WS_EX_TRANSPARENT.0 as i32);
        let _ = SetLayeredWindowAttributes(hwnd, windows::Win32::Foundation::COLORREF(0), 0, LWA_ALPHA);
      }
    }
  }
  Ok(())
}

#[tauri::command]
fn set_always_on_top(app: tauri::AppHandle, state: tauri::State<'_, ActiveWebviewsState>, always_on_top: bool) -> Result<(), String> {
  if let Some(main_win) = app.get_webview_window("main") {
    let _ = main_win.set_always_on_top(always_on_top);
  }
  
  if let Ok(map) = state.0.lock() {
    for (label, _) in map.iter() {
      if let Some(wv) = app.get_webview_window(label) {
        let _ = wv.set_always_on_top(always_on_top);
        #[cfg(windows)]
        if let Ok(child_hwnd) = wv.hwnd() {
          unsafe {
            use windows::Win32::Foundation::HWND;
            use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, HWND_TOPMOST, HWND_NOTOPMOST, SWP_NOMOVE, SWP_NOSIZE, SWP_NOACTIVATE};
            let hwnd_ptr: *mut std::ffi::c_void = std::mem::transmute(child_hwnd);
            let hwnd = HWND(hwnd_ptr);
            let target_top = if always_on_top { HWND_TOPMOST } else { HWND_NOTOPMOST };
            let _ = SetWindowPos(hwnd, Some(target_top), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
          }
        }
      }
    }
  }
  
  Ok(())
}

#[tauri::command]
fn toggle_window_lock(app: tauri::AppHandle, locked: bool) -> Result<(), String> {
  if let Some(window) = app.get_webview_window("main") {
    let _ = window.set_resizable(!locked);
    let _ = window.set_decorations(!locked);
  }
  Ok(())
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  std::env::set_var(
    "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
    "--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,ThrottleDisplayNoneAndVisibilityHiddenCrossOriginIframes,ThrottleScriptExecutionOnOccludedWindows --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling"
  );

  std::panic::set_hook(Box::new(|panic_info| {
    let mut message = format!("Panic occurred: \n");
    if let Some(s) = panic_info.payload().downcast_ref::<&str>() {
      message.push_str(&format!("Payload: {}\n", s));
    } else if let Some(s) = panic_info.payload().downcast_ref::<String>() {
      message.push_str(&format!("Payload: {}\n", s));
    } else {
      message.push_str("Payload: Unknown\n");
    }
    if let Some(location) = panic_info.location() {
      message.push_str(&format!("Location: file '{}', line {}\n", location.file(), location.line()));
    }
    let mut path = get_base_dir().unwrap_or_default();
    path.push("crash.log");
    let _ = fs::write(path, message);
  }));

  tauri::Builder::default()
    .plugin(tauri_plugin_window_state::Builder::default().build())
    .manage(WebviewLock {
      lock: tokio::sync::Mutex::new(()),
    })
    .manage(ActiveWebviewsState(std::sync::Mutex::new(std::collections::HashMap::new())))
    .invoke_handler(tauri::generate_handler![
      save_config_file,
      read_config_file,
      run_external_command,
      open_oauth_window,
      start_loopback_listener,
      open_in_browser,
      open_service_login,
      open_hidden_webview,
      open_automated_webview,
      create_child_webview,
      update_child_webview,
      destroy_child_webview,
      hide_child_webview,
      reload_child_webview,
      navigate_child_webview_back,
      navigate_child_webview_forward,
      navigate_child_webview_url,
      set_child_webview_zoom,
      toggle_child_webview_mute,
      toggle_global_mute,
      toggle_window_lock,
      set_always_on_top,
      report_zoom,
      apply_zoom
    ])
    .on_window_event(|window, event| {
      if window.label() == "main" {
        match event {
          tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
            let app = window.app_handle();
            let state = app.state::<ActiveWebviewsState>();
            let rects: Vec<(String, ActiveWebviewRect)> = match state.0.lock() {
              Ok(map) => map.iter().map(|(k, v)| (k.clone(), *v)).collect(),
              Err(_) => Vec::new(),
            };
            if !rects.is_empty() {
              if let Some(main_win) = app.get_webview_window("main") {
                let scale_factor = main_win.scale_factor().unwrap_or(1.0);
                #[cfg(windows)]
                if let Ok(main_hwnd) = main_win.hwnd() {
                  use windows::Win32::Foundation::{HWND, POINT};
                  use windows::Win32::Graphics::Gdi::MapWindowPoints;
                  use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, HWND_TOP, SWP_NOACTIVATE, SWP_NOZORDER};
                  
                  let hwnd_ptr: *mut std::ffi::c_void = unsafe { std::mem::transmute(main_hwnd) };
                  
                  for (label, rect) in rects {
                    if let Some(child_wv) = app.get_webview_window(&label) {
                      #[cfg(windows)]
                      if let Ok(child_hwnd) = child_wv.hwnd() {
                        unsafe {
                          let child_hwnd_ptr: *mut std::ffi::c_void = std::mem::transmute(child_hwnd);
                          let physical_x = rect.x * scale_factor;
                          let physical_y = rect.y * scale_factor;
                          let physical_w = rect.width * scale_factor;
                          let physical_h = rect.height * scale_factor;

                          let pt = POINT { x: physical_x as i32, y: physical_y as i32 };
                          let mut points = [pt];
                          MapWindowPoints(Some(HWND(hwnd_ptr)), None, &mut points);
                          let screen_x = points[0].x;
                          let screen_y = points[0].y;

                          let _ = SetWindowPos(
                            HWND(child_hwnd_ptr),
                            Some(HWND_TOP),
                            screen_x,
                            screen_y,
                            physical_w as i32,
                            physical_h as i32,
                            SWP_NOACTIVATE | SWP_NOZORDER
                          );
                        }
                      }
                    }
                  }
                }
              }
            }
          }
          _ => {}
        }
      }
    })
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      if let Some(main_win) = app.get_webview_window("main") {
        if let Some(icon) = app.default_window_icon() {
          let _ = main_win.set_icon(icon.clone());
        }

        #[cfg(windows)]
        {
          if let Ok(hwnd_raw) = main_win.hwnd() {
            unsafe {
              use windows::Win32::Foundation::{HWND, WPARAM, LPARAM};
              use windows::Win32::UI::WindowsAndMessaging::{
                SendMessageW, WM_SETICON, ICON_BIG, ICON_SMALL,
                CreateIconFromResourceEx, LR_DEFAULTCOLOR,
                SetClassLongPtrW, GCLP_HICON, GCLP_HICONSM
              };
              let hwnd_ptr: *mut std::ffi::c_void = std::mem::transmute(hwnd_raw);
              let hwnd = HWND(hwnd_ptr);
              let png_bytes = include_bytes!("../icons/128x128@2x.png");
              
              // Create native high-DPI 32-bit HICON directly from 256x256 PNG for Taskbar & Alt-Tab
              if let Ok(hicon) = CreateIconFromResourceEx(
                png_bytes,
                true,
                0x00030000,
                0,
                0,
                LR_DEFAULTCOLOR,
              ) {
                let _ = SendMessageW(hwnd, WM_SETICON, Some(WPARAM(ICON_BIG as usize)), Some(LPARAM(hicon.0 as isize)));
                let _ = SendMessageW(hwnd, WM_SETICON, Some(WPARAM(ICON_SMALL as usize)), Some(LPARAM(hicon.0 as isize)));
                SetClassLongPtrW(hwnd, GCLP_HICON, hicon.0 as isize);
                SetClassLongPtrW(hwnd, GCLP_HICONSM, hicon.0 as isize);
                println!("Native Win32 high-DPI HICON bound to Taskbar & Window Class!");
              }
            }
          }
        }
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

#[tauri::command]
fn report_zoom(webview: tauri::Webview, zoom: f64) {
    let label = webview.label().to_string();
    let _ = webview.app_handle().emit("webview_zoom_changed", serde_json::json!({ "label": label, "zoom": zoom }));
}

#[tauri::command]
fn apply_zoom(webview: tauri::Webview, zoom: f64) {
    let _ = webview.set_zoom(zoom);
}