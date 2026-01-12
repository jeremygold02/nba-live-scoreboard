import json
import logging
import threading
from datetime import datetime
from http.server import SimpleHTTPRequestHandler
from urllib.parse import parse_qs, urlparse
from pathlib import Path
from socketserver import TCPServer

import webview
from nba_api.live.nba.endpoints import scoreboard, boxscore

REFRESH_SECONDS = 10
LOG = logging.getLogger("raptors_live")


def _safe_stat(stats, key, default=0):
    value = stats.get(key)
    return default if value is None else value


def _parse_minutes(value):
    if value is None:
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip()
    if ":" in text:
        parts = text.split(":")
        if len(parts) == 2:
            try:
                minutes = int(parts[0])
                seconds = int(parts[1])
                return minutes + seconds / 60.0
            except ValueError:
                return 0.0
    try:
        return float(text)
    except ValueError:
        return 0.0


def _calc_ts(points, fga, fta):
    denom = 2 * (fga + 0.44 * fta)
    if denom <= 0:
        return None
    return round((points / denom) * 100, 1)


def _calc_efg(fgm, tpm, fga):
    if fga <= 0:
        return None
    return round(((fgm + 0.5 * tpm) / fga) * 100, 1)


def _build_player(player, team_stats, team_minutes):
    stats = player.get("statistics") or {}
    first = player.get("firstName") or ""
    last = player.get("familyName") or ""
    name = f"{first} {last}".strip()

    minutes = stats.get("minutes") or player.get("minutes") or ""
    minutes_value = _parse_minutes(minutes)

    points = _safe_stat(stats, "points")
    fgm = _safe_stat(stats, "fieldGoalsMade")
    fga = _safe_stat(stats, "fieldGoalsAttempted")
    tpm = _safe_stat(stats, "threePointersMade")
    tpa = _safe_stat(stats, "threePointersAttempted")
    ftm = _safe_stat(stats, "freeThrowsMade")
    fta = _safe_stat(stats, "freeThrowsAttempted")
    tov = _safe_stat(stats, "turnovers")

    team_fga = _safe_stat(team_stats, "fieldGoalsAttempted")
    team_fta = _safe_stat(team_stats, "freeThrowsAttempted")
    ts_pct = _calc_ts(points, fga, fta)
    efg_pct = _calc_efg(fgm, tpm, fga)

    return {
        "personId": player.get("personId"),
        "name": name,
        "jerseyNum": player.get("jerseyNum") or "",
        "position": player.get("position") or "",
        "starter": bool(player.get("starter")),
        "status": player.get("status") or "",
        "minutes": minutes,
        "points": points,
        "rebounds": _safe_stat(stats, "reboundsTotal"),
        "assists": _safe_stat(stats, "assists"),
        "steals": _safe_stat(stats, "steals"),
        "blocks": _safe_stat(stats, "blocks"),
        "turnovers": tov,
        "fouls": _safe_stat(stats, "foulsPersonal"),
        "plusMinus": _safe_stat(stats, "plusMinusPoints"),
        "fgm": fgm,
        "fga": fga,
        "tpm": tpm,
        "tpa": tpa,
        "ftm": ftm,
        "fta": fta,
        "tsPct": ts_pct,
        "efgPct": efg_pct,
    }


def _team_from_scoreboard(team):
    return {
        "id": team.get("teamId"),
        "city": team.get("teamCity") or "",
        "name": team.get("teamName") or "",
        "tricode": team.get("teamTricode") or "",
        "score": team.get("score") or 0,
        "wins": team.get("wins") or 0,
        "losses": team.get("losses") or 0,
        "timeoutsRemaining": team.get("timeoutsRemaining"),
        "inBonus": team.get("inBonus"),
    }


def _team_from_boxscore(box_team, fallback, period_count):
    stats = box_team.get("statistics") or {}
    players_raw = box_team.get("players") or []
    team_minutes = sum(_parse_minutes((p.get("statistics") or {}).get("minutes") or p.get("minutes")) for p in players_raw)
    if team_minutes <= 0:
        team_minutes = 240 if period_count <= 4 else 240 + (period_count - 4) * 25

    players = [_build_player(p, stats, team_minutes) for p in players_raw]
    ts_pct = _calc_ts(
        _safe_stat(stats, "points"),
        _safe_stat(stats, "fieldGoalsAttempted"),
        _safe_stat(stats, "freeThrowsAttempted"),
    )
    efg_pct = _calc_efg(
        _safe_stat(stats, "fieldGoalsMade"),
        _safe_stat(stats, "threePointersMade"),
        _safe_stat(stats, "fieldGoalsAttempted"),
    )

    return {
        **fallback,
        "stats": {
            "points": _safe_stat(stats, "points"),
            "rebounds": _safe_stat(stats, "reboundsTotal"),
            "assists": _safe_stat(stats, "assists"),
            "steals": _safe_stat(stats, "steals"),
            "blocks": _safe_stat(stats, "blocks"),
            "turnovers": _safe_stat(stats, "turnovers"),
            "fouls": _safe_stat(stats, "foulsPersonal"),
            "fgm": _safe_stat(stats, "fieldGoalsMade"),
            "fga": _safe_stat(stats, "fieldGoalsAttempted"),
            "tpm": _safe_stat(stats, "threePointersMade"),
            "tpa": _safe_stat(stats, "threePointersAttempted"),
            "ftm": _safe_stat(stats, "freeThrowsMade"),
            "fta": _safe_stat(stats, "freeThrowsAttempted"),
            "tsPct": ts_pct,
            "efgPct": efg_pct,
        },
        "players": players,
    }


def _summarize_game(game):
    home = game.get("homeTeam") or {}
    away = game.get("awayTeam") or {}
    matchup = f"{away.get('teamTricode', '')} @ {home.get('teamTricode', '')}".strip()
    return {
        "gameId": game.get("gameId"),
        "matchup": matchup,
        "statusText": game.get("gameStatusText") or "",
        "status": game.get("gameStatus"),
        "clock": game.get("gameClock") or "",
        "period": game.get("period"),
        "startTimeUTC": game.get("gameTimeUTC") or "",
        "home": _team_from_scoreboard(home),
        "away": _team_from_scoreboard(away),
    }


def _map_status(game_status, status_text):
    if game_status == 1:
        return "Scheduled"
    if game_status == 2:
        return "Live"
    if game_status == 3:
        return "Final"
    return status_text or "Unknown"


def build_state(game_id=None):
    updated = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    LOG.info("build_state start")
    try:
        board = scoreboard.ScoreBoard()
        games = board.games.get_dict()
        LOG.info("scoreboard returned %s games", len(games))
    except Exception as exc:
        LOG.exception("scoreboard error")
        return {
            "status": "error",
            "updated": updated,
            "error": str(exc),
            "games": [],
        }

    summaries = [_summarize_game(g) for g in games]

    if not games:
        return {
            "status": "no_games",
            "updated": updated,
            "games": [],
        }

    if not game_id:
        return {
            "status": "select_game",
            "updated": updated,
            "games": summaries,
        }

    selected_game = next((g for g in games if g.get("gameId") == game_id), None)
    if not selected_game:
        LOG.info("game id %s not found in scoreboard", game_id)
        return {
            "status": "game_not_found",
            "updated": updated,
            "games": summaries,
        }

    game_status = selected_game.get("gameStatus")
    status_text = selected_game.get("gameStatusText") or ""

    base_game = {
        "gameId": selected_game.get("gameId"),
        "status": _map_status(game_status, status_text),
        "statusText": status_text,
        "period": selected_game.get("period"),
        "clock": selected_game.get("gameClock") or "",
        "startTimeUTC": selected_game.get("gameTimeUTC") or "",
        "arena": {
            "name": selected_game.get("arenaName") or "",
            "city": selected_game.get("arenaCity") or "",
            "state": selected_game.get("arenaState") or "",
        },
    }

    home_fallback = _team_from_scoreboard(selected_game.get("homeTeam") or {})
    away_fallback = _team_from_scoreboard(selected_game.get("awayTeam") or {})

    if game_status not in (2, 3):
        return {
            "status": "scheduled",
            "updated": updated,
            "game": base_game,
            "games": summaries,
            "periods": [],
            "home": {**home_fallback, "stats": {}, "players": []},
            "away": {**away_fallback, "stats": {}, "players": []},
            "error": None,
        }

    error = None
    try:
        LOG.info("fetching boxscore for %s", base_game["gameId"])
        box = boxscore.BoxScore(base_game["gameId"]).get_dict()
        LOG.info("boxscore received")
    except Exception as exc:
        LOG.exception("boxscore error")
        box = {}
        error = str(exc)

    game_data = box.get("game") or {}
    period_count = int(game_data.get("period") or base_game.get("period") or 0)
    if period_count <= 0:
        period_count = 4

    home_box = game_data.get("homeTeam") or {}
    away_box = game_data.get("awayTeam") or {}
    home_periods = home_box.get("periods") or []
    away_periods = away_box.get("periods") or []
    period_count = max(len(home_periods), len(away_periods), period_count)

    periods = []
    for idx in range(period_count):
        home_period = home_periods[idx] if idx < len(home_periods) else {}
        away_period = away_periods[idx] if idx < len(away_periods) else {}
        number = home_period.get("period") or away_period.get("period") or (idx + 1)
        label = f"Q{number}" if number <= 4 else f"OT{number - 4}"
        periods.append(
            {
                "label": label,
                "home": home_period.get("score") or 0,
                "away": away_period.get("score") or 0,
            }
        )

    home = _team_from_boxscore(home_box, home_fallback, period_count) if home_box else {**home_fallback, "stats": {}, "players": []}
    away = _team_from_boxscore(away_box, away_fallback, period_count) if away_box else {**away_fallback, "stats": {}, "players": []}

    LOG.info("build_state ok")
    return {
        "status": "ok",
        "updated": updated,
        "game": base_game,
        "games": summaries,
        "periods": periods,
        "home": home,
        "away": away,
        "error": error,
    }


class RaptorsLiveAPI:
    def __init__(self):
        self._lock = threading.Lock()
        self._last_state = {
            "status": "loading",
            "updated": None,
            "game": None,
        }

    def get_state(self, game_id=None):
        LOG.info("js->get_state called")
        state = build_state(game_id)
        with self._lock:
            self._last_state = state
        LOG.info("js->get_state returning %s", state.get("status"))
        return state

    def get_last_state(self):
        LOG.info("js->get_last_state called")
        with self._lock:
            return self._last_state


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    root = Path(__file__).resolve().parent
    ui_dir = root / "raptors_live_ui"

    api = RaptorsLiveAPI()

    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(ui_dir), **kwargs)

        def do_GET(self):
            parsed = urlparse(self.path)
            if parsed.path == "/api/ping":
                LOG.info("http /api/ping requested")
                payload = b'{"status":"ok"}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            if parsed.path == "/api/log":
                query = parse_qs(parsed.query)
                msg = (query.get("msg") or [""])[0]
                LOG.info("http /api/log %s", msg)
                payload = b'{"status":"ok"}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            if parsed.path == "/api/state":
                LOG.info("http /api/state requested")
                query = parse_qs(parsed.query)
                game_id = (query.get("gameId") or [""])[0] or None
                state = build_state(game_id)
                payload = json.dumps(state).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            super().do_GET()

        def log_message(self, format, *args):
            LOG.info("http %s", format % args)

    server = TCPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    LOG.info("local server running on http://127.0.0.1:%s", port)

    LOG.info("starting webview")
    window = webview.create_window(
        "NBA Live Game Center",
        url=f"http://127.0.0.1:{port}/index.html",
        width=1280,
        height=800,
        maximized=True,
        js_api=api,
    )
    webview.start()
