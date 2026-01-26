# NBA Live Scoreboard

NBA Live Scoreboard is a local desktop scoreboard that pulls live NBA data and renders a game center UI. It starts a lightweight local server and opens the interface in a pywebview window.

## Requirements
- Python 3.x
- `nba_api`
- `pywebview`
- `plyer`

## Quick start
1. Install dependencies:
```bash
pip install nba_api pywebview plyer
```
2. Run the app:
```bash
python nba-live-scoreboard.py
```

The app starts a local server on a random port and opens a window titled "NBA Live Scoreboard".
For the best experience, run the app in fullscreen.
This UI is designed for pywebview only; browser usage is not supported.

## Features
### Game list and navigation
- Live game list with favorites pinned to the top and labeled sections for favorites and all games.
- Each game card shows live status, tipoff time, clock, period, and live score badges.
- Favorite any team with a heart toggle; favorites carry across sessions.
- Selected game stays highlighted while the app is running.
- Clear or back buttons return to the list without a full reload.

### Scoreboard and game header
- Team cards with logos, records, and bright scores that pop on updates.
- Center status with clock and period formatted as "1st Quarter", "2nd Quarter", or OT.
- Arena and tipoff details shown beneath the scoreboard.
- Team color gradients tint the header and background for the active matchup.
- Period-by-period scoring table with a show/hide toggle.

### Player tables and lineups
- Side-by-side box score tables with sticky headers and totals rows.
- Columns include MIN, PTS, REB, AST, STL, BLK, TO, PF, FG, 3PT, FT, TS%, eFG%, and +/-.
- Compact stats mode hides STL, BLK, TO, PF, TS%, and eFG% for faster scanning.
- Player rows show position and jersey number, plus starter and inactive indicators.
- On-court players are highlighted using play-by-play substitution tracking.
- Stat changes flash per cell on update, excluding TS%, eFG%, and +/-.
- Padding rows keep both team tables the same height.
- Starters list appears pregame when starters are available.

### Views and controls
- View toggle cycles Full, Compact, and No Spoilers; default is No Spoilers.
- No Spoilers hides the scoreboard and team total points in the box score.
- Stats view toggle switches Expanded and Compact; default is Expanded.
- Zoom control, manual refresh button, and auto refresh scheduling.
- Row and column hover highlighting for quick reading.
- Scrollbars appear on interaction and fade when idle.

### Favorites and notifications
- Favorites stored to `nba-live-scoreboard-ui/resources/favorites.json`.
- Desktop notifications (pywebview) for game start/period events via plyer.
- Notifications can be toggled from the game view (default off).

### Data and reliability
- Uses `nba_api.live.nba.endpoints.scoreboard`, `boxscore`, and `playbyplay`.
- Cached box score and on-court data with exponential backoff on API errors.
- Falls back to cached data during backoff and surfaces status messaging in the UI.
- Auto refresh interval adapts for live vs idle games and pauses when the page is hidden.

## Controls and views
- Zoom: change UI scale from the header.
- View: Full, Compact, or No Spoilers.
- Stats: Expanded or Compact table view.
- Stat flash: toggle per-stat change animation.
- Notifications: toggle desktop notifications (default off).
- Back to games: return to the list without reloading.
- Quarters and Comparison: toggle visibility in the game view.
- Refresh: force a manual update.

## Persistence
- Favorites are saved to `nba-live-scoreboard-ui/resources/favorites.json`.
- UI preferences are kept in memory for the current session.

## Project structure
- `nba-live-scoreboard.py`: local server, NBA data fetch, caching/backoff, pywebview window.
- `nba-live-scoreboard-ui/`: front-end assets and UI.
- `nba-live-scoreboard-ui/index.html`: layout and controls.
- `nba-live-scoreboard-ui/app.js`: UI logic, polling, rendering.
- `nba-live-scoreboard-ui/styles.css`: styling and animations.
- `nba-live-scoreboard-ui/resources/logos/`: team logo SVGs.

## Notes
- On-court tracking is derived from play-by-play substitutions. If play-by-play is unavailable, the last known lineup is reused.
- Starter indicators depend on the position field returned by the API (positions are typically only present for starters).
