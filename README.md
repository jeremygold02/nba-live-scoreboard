# NBA Live Scoreboard

NBA Live Scoreboard is a desktop scoreboard for live NBA games, built with Rust and Tauri.

## Requirements

- Rust toolchain and Windows C++ build tools to build the app locally.
- Microsoft Edge WebView2 Runtime to run the Windows app.

## Build and run

From the repository root, run:

```powershell
cargo build --locked --release --manifest-path rust-app/src-tauri/Cargo.toml --bin nba-live-scoreboard-rust
.\rust-app\src-tauri\target\release\nba-live-scoreboard-rust.exe
```

The Windows release asset is named `nba-live-scoreboard.exe`. It is the Rust/Tauri app; Python is not needed to run it. The app uses the installed WebView2 Runtime and is currently distributed as an executable rather than an installer.

## Automated tests

Run the Rust tests with:

```powershell
cargo test --locked --manifest-path rust-app/src-tauri/Cargo.toml
```

Run the UI regression cases with `python rust-app/tests/run_ui_regressions.py` after installing Python Playwright and Chromium (`python -m pip install playwright` and `python -m playwright install chromium`). These optional tests use a headless browser and a mocked Tauri bridge; they do not exercise the native window or WebView2 integration.

For the real Tauri integration check, build a debug EXE and run `python rust-app/tests/test_desktop_headless.py`. This optional Windows test needs Python Playwright, psutil, network access, and a recent completed game. It uses isolated settings and a non-displayed desktop.

## Windows release builds

GitHub pushes to `main` build and publish the Rust/Tauri `nba-live-scoreboard.exe` through `.github/workflows/windows-release.yml`. The same executable is also available in the `nba-live-scoreboard-windows` workflow artifact.

## Features
### Game list and navigation
- Home page game list split into favorites, live, scheduled, and finished sections.
- Filter buttons, team search, and importance/tipoff sorting for faster game selection.
- Each game card shows clearer status chips for live/final/scheduled state, clock, period, and tipoff time.
- Favorite any team with a heart toggle; favorites carry across sessions.
- Selected game stays highlighted while the app is running.
- Clear or back buttons return to the list without a full reload.

### Scoreboard and game header
- Team cards with logos, records, and bright scores that pop on updates.
- Center status with clock and period formatted as "1st Quarter", "2nd Quarter", or OT.
- The header shows the local time of the last update, a countdown to scheduled tipoff, and an estimated second-half countdown during halftime when the play-by-play provides the end-of-quarter time.
- Arena and tipoff details shown beneath the scoreboard.
- Team color gradients tint the header and background for the active matchup.
- Period-by-period scoring table with a show/hide toggle.

### Player tables and lineups
- Side-by-side box score tables with sticky headers and totals rows.
- Columns include MIN, PTS, REB, AST, STL, BLK, TO, PF, FG, 3PT, FT, TS%, eFG%, and +/-.
- Compact stats mode hides STL, BLK, TO, PF, TS%, and eFG% for faster scanning.
- Player rows show position and jersey number, plus starter and inactive indicators.
- On-court players are highlighted using play-by-play substitution tracking, with stronger row emphasis for live lineups.
- Sortable player columns for PLAYER, MIN, PTS, REB, AST, STL, BLK, TO, PF, and +/-.
- Stat changes flash per cell on update, excluding TS%, eFG%, and +/-.
- Padding rows keep both team tables the same height.
- Starters list appears pregame when starters are available.

### Views and controls
- View toggle cycles Full, Compact, and No Spoilers; default is No Spoilers.
- No Spoilers hides the scoreboard and team total points in the box score.
- Stats view toggle switches Expanded and Compact; default is Expanded.
- Zoom control, manual refresh button, and split list/detail auto refresh scheduling.
- UI view, zoom, and stat flash preferences persist across app launches.
- Keyboard shortcuts: `R` refreshes, arrow keys cycle games, `Esc` returns to the list, and `F` toggles the selected matchup's primary favorite.
- Row and column hover highlighting for quick reading.
- Scrollbars appear on interaction and fade when idle.

### Favorites
- Favorites carry across launches in the Rust app.

### Data and reliability
- Uses NBA live JSON feeds for the scoreboard, box scores, and play-by-play.
- If today's live scoreboard feed is blocked or unavailable, the app falls back to the NBA games page and then the Stats API. Other dates use the NBA games page with the Stats API as a fallback; game details fall back to the official NBA game page.
- Rechecks games after tipoff against their NBA game pages when the stats schedule still says "scheduled", including games on the homepage. Checks run in the background with a bounded number of requests and a cooldown.
- Cached box score and on-court data with exponential backoff on API errors.
- List and detail requests share a short-lived scoreboard snapshot. HTTP 429 responses honor the server's `Retry-After` cooldown, or a default cooldown if none is provided.
- Falls back to cached data during backoff and surfaces explicit stale/partial-data banners in the UI.
- Auto refresh interval adapts for live vs idle games and continues while the app is in the background or minimized.
- Temporary stat and hover highlights clear when focus changes; similar matchup colors use a contrasting away-team accent.

## Controls and views
- Zoom: change UI scale from the header.
- View: Full, Compact, or No Spoilers.
- Stats: Expanded or Compact table view.
- Stat flash: toggle per-stat change animation.
- Back to games: return to the list without reloading.
- Quarters and Comparison: toggle visibility in the game view.
- Refresh: request an immediate update; a scoreboard fetched in the past two seconds may be reused.

## Persistence

The Rust app saves favorites and UI preferences in `%APPDATA%\com.nbalivescoreboard.app\favorites.json` and `%APPDATA%\com.nbalivescoreboard.app\ui-preferences.json`. On first launch, it imports each missing file from the previous prototype directory (`%APPDATA%\com.nbalivescoreboard.rustprototype`) or from the former Python app's `nba-live-scoreboard-ui\resources` when present beside the executable or in the repository for a standard Cargo build. Existing destination files take precedence, and migration leaves the source files in place.

The former Python source stored settings under `nba-live-scoreboard-ui/resources/`, using `favorites.json` and `ui-preferences.json`. Its older single-file executable stored those files in its temporary extraction directory, so changes there may not have survived a restart.

## Project structure
- `rust-app/`: Rust/Tauri desktop app, NBA data services, and embedded UI.
- `rust-app/ui/`: front-end assets, controls, styling, and team logos.
- `rust-app/tests/`: optional headless UI and desktop integration checks.

## Notes
- On-court tracking is derived from play-by-play substitutions. If play-by-play is unavailable, the last known lineup is reused.
- Starter indicators depend on the position field returned by the API (positions are typically only present for starters).
