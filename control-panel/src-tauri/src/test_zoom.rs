
#[tauri::command]
pub fn test_zoom(app: tauri::AppHandle) {
    if let Some(w) = app.get_webview_window(\
main\) {
        let _z = w.zoom().unwrap_or(1.0);
        let _ = w.set_zoom(1.5);
    }
}

