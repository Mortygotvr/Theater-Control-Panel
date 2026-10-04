
#[tauri::command]
pub fn test_apply_zoom(app: tauri::AppHandle, label: String, zoom: f64) {
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.set_zoom(zoom);
        println!(\
Applied
zoom

to

\, zoom, label);
    }
}

