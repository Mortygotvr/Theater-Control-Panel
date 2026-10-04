//! Lets app pages call OBS procedures and hear OBS signals: how plugins talk to
//! each other inside OBS, with no network. The Control Panel uses it to reach
//! Theater Scene (theater_scene_list, theater_scene_fire, and the
//! theater_scene_list_changed signal), and to hear Theater's chat reader
//! (the theater_reader_event signal, whose `json` it reads). Only names
//! starting with `theater_` are allowed, so a page can't reach other
//! plugins' procedures.

use std::cell::RefCell;
use std::collections::HashSet;
use std::ffi::{CStr, c_char, c_void};

use serde::Deserialize;
use serde_json::{Map, Value};

use crate::obs::{self, Calldata, cstring, log_info};
use crate::{ui, views};

const ALLOWED_PREFIX: &str = "theater_";

#[derive(Deserialize)]
pub struct CallArgs {
    name: String,
    /// Input parameters: strings, booleans and numbers.
    #[serde(default)]
    args: Map<String, Value>,
    /// Output parameters to read back, by name: "string", "bool", "int" or "float".
    #[serde(default)]
    returns: Map<String, Value>,
}

#[derive(Deserialize)]
pub struct SignalArgs {
    name: String,
    /// The signal's parameters to hand on, by name: "string", "bool", "int"
    /// or "float". The page's event then carries them as an object (else null).
    #[serde(default)]
    args: Map<String, Value>,
}

/// A forwarded signal: its name, and the parameters it hands on
struct Forward {
    name: String,
    args: Vec<(std::ffi::CString, String, String)>,
}

thread_local! {
    /// Signals already forwarded to the pages.
    static FORWARDED: RefCell<HashSet<String>> = RefCell::new(HashSet::new());
}

fn check(name: &str) -> Result<(), String> {
    if name.starts_with(ALLOWED_PREFIX) {
        Ok(())
    } else {
        Err(format!("{name}: only names starting with {ALLOWED_PREFIX} are allowed"))
    }
}

fn set<T>(cd: &mut Calldata, name: &CStr, value: *const T, size: usize) {
    unsafe { obs::calldata_set_data(cd, name.as_ptr(), value as *const c_void, size) };
}

fn get<T: Default>(cd: &Calldata, name: &CStr) -> Option<T> {
    let mut value = T::default();
    unsafe { obs::calldata_get_data(cd, name.as_ptr(), &mut value as *mut T as *mut c_void, size_of::<T>()) }.then_some(value)
}

/// Reads parameters of calldata by name and type into an object.
fn read(cd: &Calldata, key: &str, ckey: &CStr, kind: &str) -> Result<Value, String> {
    Ok(match kind {
        "string" => {
            let mut s: *const c_char = std::ptr::null();
            if unsafe { obs::calldata_get_string(cd, ckey.as_ptr(), &mut s) } && !s.is_null() {
                Value::from(unsafe { CStr::from_ptr(s) }.to_string_lossy().into_owned())
            } else {
                Value::Null
            }
        }
        "bool" => get::<bool>(cd, ckey).map_or(Value::Null, Value::from),
        "int" => get::<i64>(cd, ckey).map_or(Value::Null, Value::from),
        "float" => get::<f64>(cd, ckey).map_or(Value::Null, Value::from),
        _ => return Err(format!("{key}: the type must be string, bool, int or float")),
    })
}

/// Calls an OBS procedure; returns its output parameters as an object.
pub fn call(a: CallArgs) -> Result<Value, String> {
    check(&a.name)?;
    let mut cd = Calldata::new();
    for (key, value) in &a.args {
        let ckey = cstring(key);
        match value {
            Value::String(s) => {
                let s = cstring(s);
                let bytes = s.as_bytes_with_nul();
                set(&mut cd, &ckey, bytes.as_ptr(), bytes.len());
            }
            Value::Bool(b) => set(&mut cd, &ckey, b, size_of::<bool>()),
            Value::Number(n) if n.is_i64() => set(&mut cd, &ckey, &n.as_i64().unwrap_or(0), size_of::<i64>()),
            Value::Number(n) => set(&mut cd, &ckey, &n.as_f64().unwrap_or(0.0), size_of::<f64>()),
            _ => return Err(format!("argument {key}: only strings, booleans and numbers")),
        }
    }

    let name = cstring(&a.name);
    if !unsafe { obs::proc_handler_call(obs::obs_get_proc_handler(), name.as_ptr(), &mut cd) } {
        return Err(format!("OBS procedure {} not found", a.name));
    }

    let mut out = Map::new();
    for (key, kind) in &a.returns {
        let value = read(&cd, key, &cstring(key), kind.as_str().unwrap_or("")).map_err(|e| format!("return {e}"))?;
        out.insert(key.clone(), value);
    }
    Ok(Value::Object(out))
}

/// Forwards an OBS signal (from OBS's global signal handler) to the app pages,
/// as an event with the same name, carrying the parameters `args` names.
/// Once per signal (the first call's `args`); it stays connected.
pub fn forward_signal(a: SignalArgs) -> Result<(), String> {
    check(&a.name)?;
    let mut args = Vec::new();
    for (key, kind) in &a.args {
        let kind = kind.as_str().unwrap_or("").to_string();
        if !matches!(kind.as_str(), "string" | "bool" | "int" | "float") {
            return Err(format!("{key}: the type must be string, bool, int or float"));
        }
        args.push((cstring(key), key.clone(), kind));
    }
    if !FORWARDED.with_borrow_mut(|f| f.insert(a.name.clone())) {
        return Ok(());
    }
    // Lives as long as OBS: the connection is never removed (the DLL is pinned).
    let data = Box::into_raw(Box::new(Forward { name: a.name.clone(), args })) as *mut c_void;
    let name = cstring(&a.name);
    unsafe { obs::signal_handler_connect(obs::obs_get_signal_handler(), name.as_ptr(), on_signal, data) };
    log_info!("forwarding OBS signal {} to the app pages", a.name);
    Ok(())
}

/// Any thread: reads the parameters (the calldata lives only during the
/// call), then hands the signal to the UI thread, which owns the webviews.
unsafe extern "C" fn on_signal(data: *mut c_void, cd: *mut Calldata) {
    let forward = unsafe { &*(data as *const Forward) };
    let name = forward.name.clone();
    let payload = if forward.args.is_empty() || cd.is_null() {
        Value::Null
    } else {
        let cd = unsafe { &*cd };
        let mut out = Map::new();
        for (ckey, key, kind) in &forward.args {
            out.insert(key.clone(), read(cd, key, ckey, kind).unwrap_or(Value::Null));
        }
        Value::Object(out)
    };
    ui::post(move || {
        if !ui::shutting_down() {
            views::emit(&name, &payload);
        }
    });
}
