# Rust application

This is the Windows application for NBA Live Scoreboard. Rust handles
NBA data, caching, settings, and the Tauri desktop shell; the interface uses the
HTML, CSS, JavaScript, and team logos in `ui/`. The previous Python implementation
remains in the repository for reference and settings migration.

Windows needs the WebView2 runtime to display the app. Python is required only
for the optional browser-based tests.

## Build and run

From the repository root, with Rust and Windows C++ build tools installed:

```powershell
cargo build --locked --release --manifest-path rust-app/src-tauri/Cargo.toml --bin nba-live-scoreboard-rust
.\rust-app\src-tauri\target\release\nba-live-scoreboard-rust.exe
```

The release executable embeds the interface assets. Favorites and preferences
are stored under `%APPDATA%\com.nbalivescoreboard.app`. On first launch, missing
settings are imported from the Rust prototype or from the original Python
source settings when available; existing destination files are not replaced.

## Verification

Run the Rust unit tests:

```powershell
cargo test --locked --manifest-path rust-app/src-tauri/Cargo.toml
```

With Python Playwright and its Chromium browser installed, run the existing UI
regressions against the Tauri bridge adapter:

```powershell
python rust-app/tests/run_ui_regressions.py
```

To exercise the real Tauri window on a separate, non-displayed desktop, install
Python Playwright and psutil, build the debug EXE, and run:

```powershell
cargo build --locked --manifest-path rust-app/src-tauri/Cargo.toml --bin nba-live-scoreboard-rust
python rust-app/tests/test_desktop_headless.py
```

The desktop test uses isolated settings and WebView2 data and requires network
access and a recent completed NBA game. It does not switch the visible desktop.

For a JSON report from the Rust data services without opening a desktop window:

```powershell
cargo run --locked --manifest-path rust-app/src-tauri/Cargo.toml -- --headless-report rust-app/src-tauri/target/headless-report.json
```

An optional date (`YYYY-MM-DD`) and game ID may follow the report path.
