//! Our docks come back at the size OBS saved for them.
//!
//! OBS saves its dock layout (QMainWindow::saveState, "DockState" in its user
//! config) correctly, but restores it while its window still has its
//! non-maximized size: Qt squeezes the docked sides to fit, and when the
//! window then maximizes the extra room goes to the preview. So a dock always
//! came back at the same, smaller width (the Control Panel: saved 673 px,
//! back at 429).
//!
//! The saved layout is read at module load (before OBS writes a new one), and
//! once OBS has finished loading, each of our docks that was docked is held at
//! least as wide (left/right) or tall (top/bottom) as its side was saved, just
//! long enough for Qt to lay it out, then let go, so it can be resized again.
//! Our docks: the Control Panel, and Theater Scene's two docks (same plugin
//! family). Floating docks keep their saved geometry without help.

use std::cell::RefCell;
use std::ffi::{CStr, CString};
use std::time::Duration;

use crate::obs::{self, log_info};
use crate::{qt, ui};

const DOCKS: [&str; 3] = ["theater_control_panel", "theater_scene_dock", "theater_redeem_dock"];

/// How long a dock is held at its saved size before it's let go.
const HOLD: Duration = Duration::from_millis(750);

// QDockAreaLayout's saveState markers
const DOCK_WIDGET_STATE_MARKER: u8 = 0xfd;
const SEQUENCE_MARKER: u8 = 0xfc;
const WIDGET_MARKER: u8 = 0xfb;
const TAB_MARKER: u8 = 0xfa;
const FLAG_VISIBLE: u8 = 1;
const FLAG_FLOATING: u8 = 2;

/// A dock docked on a side of the window, and that side's saved size.
#[derive(Debug, PartialEq)]
pub struct Docked {
    pub name: String,
    /// Qt::DockWidgetArea order in the state: 0 left, 1 right, 2 top, 3 bottom.
    pub area: i32,
    pub width: i32,
    pub height: i32,
}

impl Docked {
    /// The minimum size that holds it at its side's saved size: the width on
    /// the left or right, the height at the top or bottom.
    fn hold(&self) -> (i32, i32) {
        if self.area <= 1 { (self.width, 0) } else { (0, self.height) }
    }
}

thread_local! {
    static SAVED: RefCell<Vec<Docked>> = const { RefCell::new(Vec::new()) };
}

struct Reader<'a> {
    b: &'a [u8],
    i: usize,
}

impl Reader<'_> {
    fn u8(&mut self) -> Option<u8> {
        let v = *self.b.get(self.i)?;
        self.i += 1;
        Some(v)
    }

    fn i32(&mut self) -> Option<i32> {
        let v = self.b.get(self.i..self.i + 4)?;
        self.i += 4;
        Some(i32::from_be_bytes([v[0], v[1], v[2], v[3]]))
    }

    /// A QString: its UTF-16 byte length (0xffffffff: null), then UTF-16BE.
    fn string(&mut self) -> Option<String> {
        let len = self.i32()?;
        if len == -1 {
            return Some(String::new());
        }
        let bytes = self.b.get(self.i..self.i + len as usize)?;
        self.i += len as usize;
        let units: Vec<u16> = bytes.chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
        Some(String::from_utf16_lossy(&units))
    }

    /// One QDockAreaLayoutInfo, collecting its visible docked widgets.
    fn info(&mut self, area: i32, size: (i32, i32), out: &mut Vec<Docked>) -> Option<()> {
        match self.u8()? {
            TAB_MARKER => {
                self.i32()?;
            }
            SEQUENCE_MARKER => {}
            _ => return None,
        }
        let _orientation = self.u8()?;
        let count = self.i32()?;
        for _ in 0..count {
            match self.u8()? {
                WIDGET_MARKER => {
                    let name = self.string()?;
                    let flags = self.u8()?;
                    for _ in 0..4 {
                        self.i32()?;
                    }
                    if flags & FLAG_VISIBLE != 0 && flags & FLAG_FLOATING == 0 {
                        out.push(Docked { name, area, width: size.0, height: size.1 });
                    }
                }
                SEQUENCE_MARKER => {
                    for _ in 0..4 {
                        self.i32()?;
                    }
                    self.info(area, size, out)?;
                }
                _ => return None,
            }
        }
        Some(())
    }
}

/// The docks docked (and shown) in a saved QMainWindow state, with their side's
/// size. Empty if it isn't one it can read.
pub fn docked(state: &[u8]) -> Vec<Docked> {
    let mut r = Reader { b: state, i: 0 };
    let mut out = Vec::new();
    let read = (|| {
        r.i32()?; // version marker
        r.i32()?; // version
        if r.u8()? != DOCK_WIDGET_STATE_MARKER {
            return None;
        }
        for _ in 0..r.i32()? {
            let area = r.i32()?;
            let size = (r.i32()?, r.i32()?);
            r.info(area, size, &mut out)?;
        }
        Some(())
    })();
    if read.is_none() {
        out.clear();
    }
    out
}

fn base64_decode(s: &str) -> Option<Vec<u8>> {
    let value = |c: u8| match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    };
    let digits: Vec<u8> = s.trim().bytes().take_while(|&c| c != b'=').map(value).collect::<Option<_>>()?;
    let mut out = Vec::with_capacity(digits.len() * 3 / 4);
    for chunk in digits.chunks(4) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (k, &d)| n | (d as u32) << (18 - 6 * k));
        let bytes = [(n >> 16) as u8, (n >> 8) as u8, n as u8];
        out.extend_from_slice(&bytes[..chunk.len().saturating_sub(1)]);
    }
    Some(out)
}

/// Reads OBS's saved dock layout. Call from obs_module_load, before OBS saves
/// a new one.
pub fn remember() {
    let state = unsafe {
        let config = obs::obs_frontend_get_user_config();
        if config.is_null() {
            return;
        }
        let s = obs::config_get_string(config, c"BasicWindow".as_ptr(), c"DockState".as_ptr());
        if s.is_null() {
            return;
        }
        CStr::from_ptr(s).to_string_lossy().into_owned()
    };
    let Some(bytes) = base64_decode(&state) else { return };
    let ours: Vec<Docked> = docked(&bytes).into_iter().filter(|d| DOCKS.contains(&d.name.as_str())).collect();
    SAVED.set(ours);
}

/// Holds our docked docks at their saved sizes, then lets them go. Call once
/// OBS has finished loading.
pub fn restore() {
    let docks = SAVED.take();
    if docks.is_empty() {
        return;
    }
    let main_window = unsafe { obs::obs_frontend_get_main_window() };
    let mut held = Vec::new();
    for dock in &docks {
        let (w, h) = dock.hold();
        let Ok(name) = CString::new(dock.name.as_str()) else { continue };
        if unsafe { qt::control_panel_qt_set_dock_minimum_size(main_window, name.as_ptr(), w, h) } {
            log_info!("dock {} back at its saved size ({}x{})", dock.name, w, h);
            held.push(name);
        }
    }
    if held.is_empty() {
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(HOLD);
        ui::post(move || {
            let main_window = unsafe { obs::obs_frontend_get_main_window() };
            for name in &held {
                unsafe { qt::control_panel_qt_set_dock_minimum_size(main_window, name.as_ptr(), 0, 0) };
            }
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn int(b: &mut Vec<u8>, v: i32) {
        b.extend_from_slice(&v.to_be_bytes());
    }

    fn widget(b: &mut Vec<u8>, name: &str, flags: u8, fields: [i32; 4]) {
        b.push(WIDGET_MARKER);
        let utf16: Vec<u8> = name.encode_utf16().flat_map(|u| u.to_be_bytes()).collect();
        int(b, utf16.len() as i32);
        b.extend_from_slice(&utf16);
        b.push(flags);
        fields.iter().for_each(|&v| int(b, v));
    }

    /// Shaped like this machine's layout: the Control Panel docked on the left
    /// with a tabbed group under it, floating docks, and Theater's Scene
    /// Switching dock floating at the bottom.
    fn layout() -> Vec<u8> {
        let mut b = Vec::new();
        int(&mut b, 0xff);
        int(&mut b, 0);
        b.push(DOCK_WIDGET_STATE_MARKER);
        int(&mut b, 2);
        // Left side, 673x828: welcome (floating, hidden), the Control Panel, a tabbed group
        [0, 673, 828].iter().for_each(|&v| int(&mut b, v));
        b.push(SEQUENCE_MARKER);
        b.push(2);
        int(&mut b, 3);
        widget(&mut b, "theater_control_panel_welcome", FLAG_FLOATING, [832, 448, 100, 30]);
        widget(&mut b, "theater_control_panel", FLAG_VISIBLE, [27, 828, 0, 0]);
        b.push(SEQUENCE_MARKER);
        [741, 114, 0, 0].iter().for_each(|&v| int(&mut b, v));
        b.push(TAB_MARKER);
        int(&mut b, 1);
        b.push(1);
        int(&mut b, 2);
        widget(&mut b, "youtube.com_extraBrowser", 0, [0, -1, 0, 0]);
        widget(&mut b, "twitchChat", FLAG_VISIBLE, [0, 200, 0, 0]);
        // Bottom side, 743x262: the mixer, Theater's dock floating
        [3, 743, 262].iter().for_each(|&v| int(&mut b, v));
        b.push(SEQUENCE_MARKER);
        b.push(1);
        int(&mut b, 2);
        widget(&mut b, "mixerDock", FLAG_VISIBLE, [677, 743, 0, 0]);
        widget(&mut b, "theater_scene_dock", FLAG_VISIBLE | FLAG_FLOATING, [948, 456, 200, 140]);
        b
    }

    #[test]
    fn base64_matches_known_values() {
        assert_eq!(base64_decode("TWFu").unwrap(), b"Man");
        assert_eq!(base64_decode("TWE=").unwrap(), b"Ma");
        assert_eq!(base64_decode("TQ==").unwrap(), b"M");
        assert!(base64_decode("T!==").is_none());
    }

    #[test]
    fn reads_the_docked_docks_and_their_side() {
        let docks = docked(&layout());
        let names: Vec<&str> = docks.iter().map(|d| d.name.as_str()).collect();
        // Floating or hidden docks aren't held; tabbed ones are
        assert_eq!(names, ["theater_control_panel", "twitchChat", "mixerDock"]);
        assert_eq!(docks[0], Docked { name: "theater_control_panel".into(), area: 0, width: 673, height: 828 });
        // Left side: held by its width; bottom: by its height
        assert_eq!(docks[0].hold(), (673, 0));
        assert_eq!(docks[2].hold(), (0, 262));
    }

    /// This machine's own saved layout, when there is one.
    #[test]
    fn reads_obs_saved_layout() {
        let Ok(appdata) = std::env::var("APPDATA") else { return };
        let Ok(ini) = std::fs::read_to_string(std::path::Path::new(&appdata).join(r"obs-studio\user.ini")) else { return };
        let Some(line) = ini.lines().find_map(|l| l.strip_prefix("DockState=")) else { return };
        let docks = docked(&base64_decode(line).unwrap());
        assert!(!docks.is_empty(), "couldn't read OBS's DockState");
    }

    #[test]
    fn a_bottom_dock_is_held_by_its_height_and_garbage_gives_nothing() {
        let d = Docked { name: "x".into(), area: 3, width: 743, height: 262 };
        assert_eq!(d.hold(), (0, 262));
        assert!(docked(b"not a layout").is_empty());
        assert!(docked(&[]).is_empty());
    }
}
