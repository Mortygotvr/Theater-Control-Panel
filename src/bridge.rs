//! The Rust end of bridge.js: invoke/emit messages from app pages, and the
//! replies and events that go back as scripts evaluated in the page.

use serde::Deserialize;
use serde_json::Value;

use crate::obs::log_warn;
use crate::{commands, ui, views};

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum Message {
    Invoke {
        id: u64,
        cmd: String,
        #[serde(default)]
        args: Value,
    },
    Emit {
        event: String,
        #[serde(default)]
        payload: Value,
    },
}

/// Handles a message from the app page labelled `label`.
///
/// Runs inside WebView2's WebMessageReceived event, where WebView2 can't deliver
/// other events. Commands can create webviews, which wait for such events, so
/// they run afterwards from OBS's UI queue (Tauri also runs commands outside the
/// event handler).
pub fn handle(label: &str, body: &str) {
    let message = match serde_json::from_str(body) {
        Ok(message) => message,
        Err(e) => return log_warn!("bad bridge message from '{label}': {e}"),
    };
    let label = label.to_string();
    ui::post(move || match message {
        Message::Invoke { id, cmd, args } => commands::invoke(&cmd, args, Reply { label, id }),
        Message::Emit { event, payload } => views::emit(&event, &payload),
    });
}

/// Answers one `invoke` call. Can be sent from any thread.
pub struct Reply {
    label: String,
    id: u64,
}

impl Reply {
    /// Label of the view that made the call.
    pub fn caller(&self) -> &str {
        &self.label
    }

    pub fn send(self, result: Result<Value, String>) {
        let (ok, value) = match result {
            Ok(value) => (true, value),
            Err(e) => (false, Value::String(e)),
        };
        let js = format!("window.__TAURI_OBS__&&window.__TAURI_OBS__.resolve({},{ok},{value})", self.id);
        let label = self.label;
        if ui::is_ui_thread() {
            views::eval(&label, &js);
        } else {
            ui::post(move || views::eval(&label, &js));
        }
    }
}
