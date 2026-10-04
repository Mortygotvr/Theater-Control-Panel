//! Browser Sources (obs-browser, CEF) into Theater Web Sources.
//!
//! The Theater Web Source takes the Browser Source's settings as they are (url,
//! local_file, is_local_file, width, height, css, reroute_audio), so a Browser
//! Source becomes one by changing only its type in the scene collection file:
//! its name, settings, filters, audio settings and its place in every scene
//! stay exactly as they were. A copy of each file is kept first
//! (<name>.json.before-web-source).
//!
//! OBS rewrites the scene collection that's open when it exits, so that one is
//! converted the next time OBS starts, from obs_module_load, before OBS reads
//! it (listed meanwhile in plugin_config\theater-control-panel\convert-browser-sources.txt).
//! The others are converted right away.

use std::ffi::CStr;
use std::fs;
use std::path::{Path, PathBuf};

use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{
    IDYES, MB_ICONINFORMATION, MB_ICONQUESTION, MB_OK, MB_YESNO, MESSAGEBOX_STYLE, MessageBoxW,
};
use windows::core::HSTRING;

use crate::obs::{self, log_info, log_warn};

const BROWSER: &str = "browser_source";
const WEB_SOURCE: &str = "theater_web_source";
const PENDING: &str = "convert-browser-sources.txt";
const BACKUP_SUFFIX: &str = ".before-web-source";

/// The collection file's text with its Browser Sources turned into Tauri
/// Sources, and how many there were. Only the sources' type changes.
pub fn convert_text(json: &str) -> (String, usize) {
    let mut out = json.to_string();
    let mut count = 0;
    for key in ["id", "versioned_id"] {
        for (from, to) in [
            (format!("\"{key}\": \"{BROWSER}\""), format!("\"{key}\": \"{WEB_SOURCE}\"")),
            (format!("\"{key}\":\"{BROWSER}\""), format!("\"{key}\":\"{WEB_SOURCE}\"")),
        ] {
            if key == "id" {
                count += out.matches(&from).count();
            }
            out = out.replace(&from, &to);
        }
    }
    (out, count)
}

/// OBS's scene collection folder (…\obs-studio\basic\scenes), found from this
/// plugin's config folder (…\obs-studio\plugin_config\theater-control-panel).
fn scenes_dir() -> Option<PathBuf> {
    let plugin_config = obs::module_config_path("")?;
    let obs_config = plugin_config.parent()?.parent()?;
    Some(obs_config.join("basic").join("scenes"))
}

struct Collection {
    path: PathBuf,
    name: String,
    browser_sources: usize,
}

fn collections() -> Vec<Collection> {
    let Some(dir) = scenes_dir() else { return Vec::new() };
    let Ok(entries) = fs::read_dir(&dir) else { return Vec::new() };
    let mut out: Vec<Collection> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("json")))
        .filter_map(|path| {
            let text = fs::read_to_string(&path).ok()?;
            let name = serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(str::to_string))
                .unwrap_or_else(|| path.file_stem().unwrap_or_default().to_string_lossy().into_owned());
            Some(Collection { path, name, browser_sources: convert_text(&text).1 })
        })
        .collect();
    out.sort_by_key(|c| c.name.to_lowercase());
    out
}

/// Converts one collection file (a copy kept first); how many it converted.
fn convert_file(path: &Path) -> Result<usize, String> {
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let (converted, count) = convert_text(&text);
    if count == 0 {
        return Ok(0);
    }
    serde_json::from_str::<serde_json::Value>(&converted).map_err(|e| format!("not valid JSON afterwards: {e}"))?;
    let backup = PathBuf::from(format!("{}{BACKUP_SUFFIX}", path.display()));
    if !backup.exists() {
        fs::copy(path, &backup).map_err(|e| format!("can't keep a copy: {e}"))?;
    }
    let temp = path.with_extension("json.converting");
    fs::write(&temp, converted).map_err(|e| e.to_string())?;
    fs::rename(&temp, path).map_err(|e| e.to_string())?;
    Ok(count)
}

fn current_collection() -> Option<String> {
    let name = unsafe { obs::obs_frontend_get_current_scene_collection() };
    if name.is_null() {
        return None;
    }
    let value = unsafe { CStr::from_ptr(name) }.to_string_lossy().into_owned();
    unsafe { obs::bfree(name.cast()) };
    Some(value)
}

/// Converts the collections left for this start. Call from obs_module_load,
/// before OBS loads its scene collection.
pub fn at_load() {
    let Some(pending) = obs::module_config_path(PENDING) else { return };
    let Ok(list) = fs::read_to_string(&pending) else { return };
    let _ = fs::remove_file(&pending);
    for line in list.lines().map(str::trim).filter(|l| !l.is_empty()) {
        match convert_file(Path::new(line)) {
            Ok(n) => log_info!("converted {n} Browser Source(s) to Theater Web Sources in {line}"),
            Err(e) => log_warn!("couldn't convert the Browser Sources in {line}: {e}"),
        }
    }
}

fn message(text: &str, style: MESSAGEBOX_STYLE) -> bool {
    let owner = unsafe { obs::obs_frontend_get_main_window_handle() };
    let owner = (!owner.is_null()).then_some(HWND(owner));
    unsafe { MessageBoxW(owner, &HSTRING::from(text), &HSTRING::from("Convert Browser Sources"), style) == IDYES }
}

/// The menu item: counts the Browser Sources in every scene collection,
/// asks, converts.
pub fn run() {
    let current = current_collection().unwrap_or_default();
    let found: Vec<Collection> = collections().into_iter().filter(|c| c.browser_sources > 0).collect();
    if found.is_empty() {
        message("There are no Browser Sources left in any scene collection.", MB_OK | MB_ICONINFORMATION);
        return;
    }
    let total: usize = found.iter().map(|c| c.browser_sources).sum();
    let lines: Vec<String> = found
        .iter()
        .map(|c| {
            let when = if c.name == current { " (open now: converted when OBS next starts)" } else { "" };
            format!("  • {}: {}{}", c.name, c.browser_sources, when)
        })
        .collect();
    let ask = format!(
        "Convert {total} Browser Source(s) to Theater Web Sources?\n\n{}\n\n\
         Only their type changes: names, settings, filters, audio and their place in the scenes stay as they are. \
         A copy of each scene collection file is kept (.json{BACKUP_SUFFIX}).",
        lines.join("\n")
    );
    if !message(&ask, MB_YESNO | MB_ICONQUESTION) {
        return;
    }

    let mut done = Vec::new();
    let mut later = None;
    for c in &found {
        if c.name == current {
            let Some(pending) = obs::module_config_path(PENDING) else { continue };
            let mut list = fs::read_to_string(&pending).unwrap_or_default();
            let path = c.path.display().to_string();
            if !list.lines().any(|l| l.trim() == path) {
                list.push_str(&format!("{path}\n"));
            }
            match fs::write(&pending, list) {
                Ok(()) => later = Some(c),
                Err(e) => done.push(format!("  • {}: not converted ({e})", c.name)),
            }
            continue;
        }
        match convert_file(&c.path) {
            Ok(n) => {
                log_info!("converted {n} Browser Source(s) to Theater Web Sources in '{}'", c.name);
                done.push(format!("  • {}: {n} converted", c.name));
            }
            Err(e) => {
                log_warn!("couldn't convert the Browser Sources in '{}': {e}", c.name);
                done.push(format!("  • {}: not converted ({e})", c.name));
            }
        }
    }
    let mut result = done.join("\n");
    if let Some(c) = later {
        log_info!("'{}' is open: its {} Browser Source(s) are converted when OBS next starts", c.name, c.browser_sources);
        result.push_str(&format!(
            "\n  • {}: {} converted when OBS next starts — restart OBS to finish.",
            c.name, c.browser_sources
        ));
    }
    message(result.trim_start_matches('\n'), MB_OK | MB_ICONINFORMATION);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_browser_sources_change_type() {
        let json = r#"{
    "name": "Prime",
    "sources": [
        {
            "id": "browser_source",
            "name": "Hyperrate",
            "settings": { "url": "app.hyperate.io/C972", "width": 200, "height": 200 },
            "filters": [ { "id": "crop_filter", "name": "theater_guard_filter", "versioned_id": "crop_filter" } ],
            "versioned_id": "browser_source"
        },
        { "id": "theater_web_source", "name": "Chat", "versioned_id": "theater_web_source" },
        { "id": "image_source", "name": "note: browser_source in text", "versioned_id": "image_source" },
        {"id":"browser_source","name":"compact","versioned_id":"browser_source"}
    ]
}"#;
        let (out, count) = convert_text(json);
        assert_eq!(count, 2);
        assert!(!out.contains(r#""id": "browser_source""#) && !out.contains(r#""id":"browser_source""#));
        assert!(!out.contains(r#""versioned_id": "browser_source""#));
        // Everything else untouched, character for character
        assert_eq!(out.replace(WEB_SOURCE, BROWSER).replace(r#""id": "browser_source", "name": "Chat", "versioned_id": "browser_source""#, r#""id": "theater_web_source", "name": "Chat", "versioned_id": "theater_web_source""#), json);
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["sources"][0]["id"], WEB_SOURCE);
        assert_eq!(v["sources"][0]["settings"]["url"], "app.hyperate.io/C972");
        assert_eq!(v["sources"][0]["filters"][0]["id"], "crop_filter");
        assert_eq!(v["sources"][2]["name"], "note: browser_source in text");
        assert_eq!(v["sources"][3]["versioned_id"], WEB_SOURCE);
    }

    #[test]
    fn nothing_to_convert_leaves_the_text_alone() {
        let json = r#"{"sources": [{"id": "image_source"}]}"#;
        assert_eq!(convert_text(json), (json.to_string(), 0));
    }
}
