//! Performance options, set from the Control Panel's ⚡ Performance panel and
//! saved in plugin_config\theater-control-panel\performance.json.
//!
//! Every page keeps running whatever is chosen here (the Control Panel's tabs
//! and the sources' pages are meant to): the options change what drawing and
//! holding them costs, not whether they run.

use std::path::PathBuf;
use std::sync::{Mutex, PoisonError};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::obs;

/// How often a browser source's page is captured.
#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureRate {
    /// Every frame the page draws: the monitor's rate
    Monitor,
    /// OBS's frame rate: OBS can't show more
    Obs,
    /// 30 a second, for sources that needn't be smooth
    Thirty,
}

#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize)]
#[serde(default)]
pub struct Performance {
    /// Parked Control Panel tabs in WebView2's low-memory mode: it lets go of
    /// what it keeps for drawing them (they're redrawn when shown)
    pub parked_tabs_low_memory: bool,
    pub capture_rate: CaptureRate,
    /// A browser source shown nowhere in OBS stops drawing (its page runs on)
    pub rest_hidden_sources: bool,
    /// Pages drawn on the GPU (off: on the CPU). From the next OBS start.
    pub gpu_acceleration: bool,
    /// Video in pages decoded on the GPU. From the next OBS start.
    pub gpu_video_decode: bool,
}

impl Default for Performance {
    fn default() -> Self {
        Performance {
            parked_tabs_low_memory: true,
            capture_rate: CaptureRate::Obs,
            rest_hidden_sources: false,
            gpu_acceleration: true,
            gpu_video_decode: true,
        }
    }
}

static CURRENT: Mutex<Option<Performance>> = Mutex::new(None);
/// What this run's browser processes started with: the GPU options apply
/// from a start only.
static STARTED_WITH: Mutex<Option<Performance>> = Mutex::new(None);

fn file() -> Option<PathBuf> {
    obs::module_config_path("performance.json")
}

pub fn get() -> Performance {
    let mut current = CURRENT.lock().unwrap_or_else(PoisonError::into_inner);
    *current.get_or_insert_with(|| {
        file()
            .and_then(|f| std::fs::read_to_string(f).ok())
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    })
}

/// The Chromium flags the GPU options ask for, for a new WebView2
/// environment. Every environment of a run gets the same ones.
pub fn browser_flags() -> String {
    let started = *STARTED_WITH.lock().unwrap_or_else(PoisonError::into_inner).get_or_insert_with(get);
    let mut flags = String::new();
    if !started.gpu_acceleration {
        flags.push_str(" --disable-gpu --disable-gpu-compositing");
    }
    if !started.gpu_video_decode {
        flags.push_str(" --disable-accelerated-video-decode");
    }
    flags
}

/// The options, and whether a GPU option waits for OBS to restart.
pub fn to_json() -> Value {
    let perf = get();
    let started = *STARTED_WITH.lock().unwrap_or_else(PoisonError::into_inner);
    let restart_needed =
        started.is_some_and(|s| s.gpu_acceleration != perf.gpu_acceleration || s.gpu_video_decode != perf.gpu_video_decode);
    json!({ "settings": perf, "restart_needed": restart_needed })
}

/// New options from the panel: saved, and applied to what's open. UI thread.
pub fn set(new: Performance) -> Result<Value, String> {
    let old = get();
    let path = file().ok_or("no plugin config path")?;
    let text = serde_json::to_string_pretty(&new).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("{}: {e}", path.display()))?;
    *CURRENT.lock().unwrap_or_else(PoisonError::into_inner) = Some(new);
    if old.parked_tabs_low_memory != new.parked_tabs_low_memory {
        crate::child::apply_parked_memory();
    }
    if old.capture_rate != new.capture_rate {
        crate::source::apply_capture_rate();
    }
    if old.rest_hidden_sources != new.rest_hidden_sources {
        crate::source::apply_rest_all();
    }
    Ok(to_json())
}

/// The shortest time between two captures of a page, in 100 ns (0: none).
pub fn capture_interval() -> i64 {
    match get().capture_rate {
        CaptureRate::Monitor => 0,
        // A little under OBS's frame, so a frame drawn just before OBS's isn't
        // skipped for being early
        CaptureRate::Obs => (unsafe { obs::obs_get_frame_interval_ns() } / 100 * 9 / 10) as i64,
        CaptureRate::Thirty => 10_000_000 / 30,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_options_read_back_and_missing_ones_take_their_default() {
        let mine = Performance { rest_hidden_sources: true, capture_rate: CaptureRate::Thirty, ..Default::default() };
        let text = serde_json::to_string(&mine).unwrap();
        assert!(text.contains("\"capture_rate\":\"thirty\""), "{text}");
        assert_eq!(serde_json::from_str::<Performance>(&text).unwrap(), mine);
        // A file from before an option existed
        let old: Performance = serde_json::from_str(r#"{ "gpu_acceleration": false }"#).unwrap();
        assert!(!old.gpu_acceleration);
        assert!(old.parked_tabs_low_memory && old.gpu_video_decode);
        assert_eq!(old.capture_rate, CaptureRate::Obs);
    }
}
