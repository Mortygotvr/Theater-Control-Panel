//! Compiles the header-free Qt shim (qt/control_panel_qt.cpp) and generates import
//! libraries for the Qt DLLs it links against, straight from the DLLs of the
//! local OBS install. This replaces Trust's gen_libs.ps1 + dumpbin step, so a
//! plain `cargo build` is enough.
//!
//! OBS install location: `OBS_BIN_DIR`, default `C:\Program Files\obs-studio\bin\64bit`.
//! obs.dll and obs-frontend-api.dll need no import libs: they're plain C APIs,
//! linked with `raw-dylib` in src/obs.rs.

use std::env;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use object::{NameOrOrdinal, Object};

const QT_DLLS: &[&str] = &["Qt6Core", "Qt6Gui", "Qt6Widgets"];

fn main() {
    println!("cargo:rerun-if-changed=qt/control_panel_qt.cpp");
    println!("cargo:rerun-if-env-changed=OBS_BIN_DIR");

    let target = env::var("TARGET").unwrap();
    if !target.contains("windows-msvc") {
        panic!("The Theater Control Panel currently targets Windows MSVC only (got {target})");
    }

    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let obs_bin = env::var("OBS_BIN_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(r"C:\Program Files\obs-studio\bin\64bit"));

    let lib_exe = cc::windows_registry::find_tool(&target, "lib.exe")
        .expect("lib.exe not found - install the MSVC build tools");

    for dll in QT_DLLS {
        let dll_path = obs_bin.join(format!("{dll}.dll"));
        generate_import_lib(&dll_path, dll, &out_dir, lib_exe.to_command());
        println!("cargo:rerun-if-changed={}", dll_path.display());
        println!("cargo:rustc-link-lib=dylib={dll}");
    }
    println!("cargo:rustc-link-search=native={}", out_dir.display());

    cc::Build::new()
        .cpp(true)
        .file("qt/control_panel_qt.cpp")
        .flag("/EHsc")
        .flag("/utf-8")
        .compile("control_panel_qt");
}

fn generate_import_lib(dll_path: &Path, name: &str, out_dir: &Path, mut lib_cmd: Command) {
    let data = fs::read(dll_path).unwrap_or_else(|e| {
        panic!(
            "can't read {} ({e}). Set OBS_BIN_DIR to OBS's bin\\64bit folder.",
            dll_path.display()
        )
    });
    let file = object::File::parse(&*data)
        .unwrap_or_else(|e| panic!("can't parse {}: {e}", dll_path.display()));

    let mut def = format!("LIBRARY {name}.dll\nEXPORTS\n");
    let mut count = 0;
    for export in file.exports().expect("can't read export table") {
        let export = export.expect("bad export table entry");
        if let NameOrOrdinal::Name(name) = export.name()
            && let Ok(sym) = std::str::from_utf8(name)
        {
            let _ = writeln!(def, "    {sym}");
            count += 1;
        }
    }
    if count == 0 {
        panic!("{} exports no symbols", dll_path.display());
    }

    let def_path = out_dir.join(format!("{name}.def"));
    let lib_path = out_dir.join(format!("{name}.lib"));
    fs::write(&def_path, def).unwrap();

    let status = lib_cmd
        .arg("/nologo")
        .arg(format!("/def:{}", def_path.display()))
        .arg("/machine:x64")
        .arg(format!("/out:{}", lib_path.display()))
        .status()
        .expect("failed to run lib.exe");
    if !status.success() {
        panic!("lib.exe failed for {name}");
    }
}
