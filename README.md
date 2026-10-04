# Theater Control Panel

The Theater Control Panel inside OBS Studio. The Control Panel's frontend (`control-panel/`) runs in an OBS dock on WebView2 (through wry), and this plugin serves its commands through a `window.__TAURI__` bridge. The same frontend also runs as a standalone Tauri app.

It also adds:

- **Theater Web Source:** a web page or local HTML file as an OBS source, like OBS's Browser Source, with transparency and optional audio through OBS.
- **Convert Browser Sources…:** turns existing Browser Sources into Theater Web Sources. Only their type changes; everything else stays. A backup of each scene collection file is kept.

Its menu items are in the shared **🎭 Theater** menu: Show Control Panel, Settings…, Reload, and Convert Browser Sources…. It talks to [Theater Scene](https://github.com/Mortygotvr/Theater-Scene) and [Theater Reader](https://github.com/Mortygotvr/Theater-Reader) through OBS's own procedures and signals (the `theater_` ones), with no network involved.

## Building (Windows only)

You need Rust, the MSVC build tools and OBS Studio 30 or newer.

1. `cargo build --release`. `build.rs` compiles the Qt shim (`qt/control_panel_qt.cpp`) and makes import libraries from your OBS install's Qt DLLs. If OBS isn't installed in the default place, set `OBS_BIN_DIR`.
2. Close OBS, then run `.\scripts\deploy.ps1`. It copies the plugin into `C:\ProgramData\obs-studio\plugins\theater-control-panel`. With OBS running, `-DataOnly` refreshes just the Control Panel's files; then use Reload.

Its own data (the Control Panel's settings, browser profiles, ⚡ Performance options) is kept in `%APPDATA%\obs-studio\plugin_config\theater-control-panel\`.

## Notes

- [docs/shared-menu.md](docs/shared-menu.md) describes the shared 🎭 Theater menu every Theater plugin joins.
- Configuration `.json` files, `.env` files and proxy scripts are never tracked (see `control-panel/.clinerules`).

## License

GPL-2.0-or-later (see [LICENSE](LICENSE)), like OBS Studio.
