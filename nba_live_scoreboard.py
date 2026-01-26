import json
import logging
import threading
from datetime import datetime, timezone, timedelta
from http.server import SimpleHTTPRequestHandler
from urllib.parse import parse_qs, urlparse
from pathlib import Path
from socketserver import TCPServer

import webview
from nba_api.live.nba.endpoints import scoreboard, boxscore, playbyplay

REFRESH_SECONDS = 10
LOG = logging.getLogger("nba_live_scoreboard")
BOX_CACHE = {}
BOX_BACKOFF = {}
MAX_BACKOFF_SECONDS = 60
PBP_BACKOFF = {}
ON_COURT_CACHE = {}
FAVORITES_PATH = Path(__file__).resolve().parent / "nba_live_scoreboard_ui" / "resources" / "favorites.json"


def _now_utc_iso():
    return datetime.now(timezone.utc).isoformat()


def _get_backoff(game_id, backoff_map=None):
    backoff_map = backoff_map or BOX_BACKOFF
    entry = backoff_map.get(game_id)
    if not entry:
        return None
    if datetime.now(timezone.utc) >= entry["nextAllowed"]:
        return None
    return entry


def _set_backoff(game_id, backoff_map=None):
    backoff_map = backoff_map or BOX_BACKOFF
    current = backoff_map.get(game_id)
    delay = current["delay"] if current else 1
    delay = min(delay * 2, MAX_BACKOFF_SECONDS)
    backoff_map[game_id] = {
        "delay": delay,
        "nextAllowed": datetime.now(timezone.utc) + timedelta(seconds=delay),
    }


def _clear_backoff(game_id, backoff_map=None):
    backoff_map = backoff_map or BOX_BACKOFF
    if game_id in backoff_map:
        del backoff_map[game_id]


def _load_favorites():
    try:
        if not FAVORITES_PATH.exists():
            return []
        with FAVORITES_PATH.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
        if isinstance(data, list):
            return data
    except Exception:
        LOG.exception("failed to load favorites")
    return []


def _save_favorites(favorites):
    try:
        FAVORITES_PATH.parent.mkdir(parents=True, exist_ok=True)
        with FAVORITES_PATH.open("w", encoding="utf-8") as handle:
            json.dump(list(favorites), handle)
        return True
    except Exception:
        LOG.exception("failed to save favorites")
        return False


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


def _coerce_person_id(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _starter_ids(players):
    starters = set()
    for player in players:
        if not player.get("position"):
            continue
        person_id = _coerce_person_id(player.get("personId"))
        if person_id is not None:
            starters.add(person_id)
    return starters


def _build_on_court(game_id, home, away):
    if not game_id or not home or not away:
        return None
    home_players = home.get("players") or []
    away_players = away.get("players") or []
    if not home_players or not away_players:
        return None

    home_on = _starter_ids(home_players)
    away_on = _starter_ids(away_players)

    backoff = _get_backoff(game_id, PBP_BACKOFF)
    cached = ON_COURT_CACHE.get(game_id)
    if backoff and cached:
        return cached

    try:
        payload = playbyplay.PlayByPlay(game_id).get_dict()
        _clear_backoff(game_id, PBP_BACKOFF)
    except Exception:
        LOG.exception("playbyplay error")
        _set_backoff(game_id, PBP_BACKOFF)
        return cached

    actions = (payload.get("game") or {}).get("actions") or []
    if actions:
        actions = sorted(actions, key=lambda item: item.get("actionNumber") or 0)

        home_id = home.get("id")
        away_id = away.get("id")
        home_tricode = home.get("tricode")
        away_tricode = away.get("tricode")

        for action in actions:
            if action.get("actionType") != "substitution":
                continue
            person_id = _coerce_person_id(action.get("personId"))
            if person_id is None:
                continue
            team_id = action.get("teamId")
            team_tricode = action.get("teamTricode")
            if team_id == home_id or team_tricode == home_tricode:
                target = home_on
            elif team_id == away_id or team_tricode == away_tricode:
                target = away_on
            else:
                continue
            subtype = action.get("subType")
            if subtype == "in":
                target.add(person_id)
            elif subtype == "out":
                target.discard(person_id)

    if not home_on and not away_on:
        return cached

    result = {"home": sorted(home_on), "away": sorted(away_on)}
    ON_COURT_CACHE[game_id] = result
    return result


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


def _looks_like_tipoff(status_text):
    if not status_text:
        return False
    text = str(status_text).strip()
    if not text:
        return False
    if any(ch.isdigit() for ch in text) and ":" in text:
        return True
    lower = text.lower()
    if " am" in lower or " pm" in lower:
        return True
    if any(zone in lower for zone in (" et", " ct", " mt", " pt")) and any(ch.isdigit() for ch in text):
        return True
    return False


def _map_status(game_status, status_text):
    if game_status == 1:
        if status_text and not _looks_like_tipoff(status_text):
            return status_text
        return "Scheduled"
    if game_status == 2:
        return "Live"
    if game_status == 3:
        return "Final"
    return status_text or "Unknown"


def build_state(game_id=None):
    updated = _now_utc_iso()
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
            "dataUpdated": updated,
            "game": base_game,
            "games": summaries,
            "periods": [],
            "home": {**home_fallback, "stats": {}, "players": [], "onCourt": []},
            "away": {**away_fallback, "stats": {}, "players": [], "onCourt": []},
            "error": None,
        }

    cache = BOX_CACHE.get(base_game["gameId"])
    backoff = _get_backoff(base_game["gameId"])
    if backoff and cache:
        LOG.info("backoff active for %s; using cached boxscore", base_game["gameId"])
        home = cache.get("home", {**home_fallback, "stats": {}, "players": []})
        away = cache.get("away", {**away_fallback, "stats": {}, "players": []})
        on_court = _build_on_court(base_game["gameId"], home, away) if game_status == 2 else None
        if on_court:
            home = {**home, "onCourt": on_court.get("home", [])}
            away = {**away, "onCourt": on_court.get("away", [])}
        else:
            home = {**home, "onCourt": []}
            away = {**away, "onCourt": []}
        return {
            "status": "ok",
            "updated": updated,
            "dataUpdated": cache.get("dataUpdated", updated),
            "game": base_game,
            "games": summaries,
            "periods": cache.get("periods", []),
            "home": home,
            "away": away,
            "error": "Using cached data during API backoff.",
        }

    error = None
    try:
        LOG.info("fetching boxscore for %s", base_game["gameId"])
        box = boxscore.BoxScore(base_game["gameId"]).get_dict()
        LOG.info("boxscore received")
        _clear_backoff(base_game["gameId"])
    except Exception as exc:
        LOG.exception("boxscore error")
        box = {}
        error = str(exc)
        _set_backoff(base_game["gameId"])
        if cache:
            home = cache.get("home", {**home_fallback, "stats": {}, "players": []})
            away = cache.get("away", {**away_fallback, "stats": {}, "players": []})
            on_court = _build_on_court(base_game["gameId"], home, away) if game_status == 2 else None
            if on_court:
                home = {**home, "onCourt": on_court.get("home", [])}
                away = {**away, "onCourt": on_court.get("away", [])}
            else:
                home = {**home, "onCourt": []}
                away = {**away, "onCourt": []}
            return {
                "status": "ok",
                "updated": updated,
                "dataUpdated": cache.get("dataUpdated", updated),
                "game": base_game,
                "games": summaries,
                "periods": cache.get("periods", []),
                "home": home,
                "away": away,
                "error": "Using cached data after boxscore error.",
            }

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
    if home.get("players") and away.get("players"):
        BOX_CACHE[base_game["gameId"]] = {
            "home": home,
            "away": away,
            "periods": periods,
            "dataUpdated": updated,
        }
    on_court = _build_on_court(base_game["gameId"], home, away) if game_status == 2 else None
    if on_court:
        home = {**home, "onCourt": on_court.get("home", [])}
        away = {**away, "onCourt": on_court.get("away", [])}
    else:
        home = {**home, "onCourt": []}
        away = {**away, "onCourt": []}
    return {
        "status": "ok" if (home.get("players") or away.get("players")) else ("postgame" if game_status == 3 else "live_no_data"),
        "updated": updated,
        "dataUpdated": BOX_CACHE.get(base_game["gameId"], {}).get("dataUpdated", updated),
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
        self._favorites = _load_favorites()

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

    def get_favorites(self):
        LOG.info("js->get_favorites called")
        with self._lock:
            return list(self._favorites)

    def set_favorites(self, favorites):
        LOG.info("js->set_favorites called")
        if not isinstance(favorites, list):
            return {"status": "error", "error": "favorites must be a list"}
        with self._lock:
            self._favorites = favorites
        saved = _save_favorites(favorites)
        return {"status": "ok" if saved else "error"}


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    root = Path(__file__).resolve().parent
    ui_dir = root / "nba_live_scoreboard_ui"

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
            if parsed.path == "/api/favorites":
                LOG.info("http /api/favorites requested")
                payload = json.dumps(api.get_favorites()).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            super().do_GET()

        def do_POST(self):
            parsed = urlparse(self.path)
            if parsed.path == "/api/favorites":
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length)
                try:
                    payload = json.loads(body.decode("utf-8") or "[]")
                except json.JSONDecodeError:
                    payload = []
                result = api.set_favorites(payload)
                response = json.dumps(result).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(response)))
                self.end_headers()
                self.wfile.write(response)
                return
            self.send_response(404)
            self.end_headers()

        def log_message(self, format, *args):
            LOG.info("http %s", format % args)

    server = TCPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    LOG.info("local server running on http://127.0.0.1:%s", port)

    LOG.info("starting webview")
    window = webview.create_window(
        "NBA Live Scoreboard",
        url=f"http://127.0.0.1:{port}/index.html",
        width=1280,
        height=800,
        maximized=True,
        js_api=api,
    )
    webview.start()
