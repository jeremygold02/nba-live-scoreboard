import json
import logging
import re
import threading
import time
from datetime import datetime, timezone, timedelta
from http.server import SimpleHTTPRequestHandler
from urllib.parse import parse_qs, urlparse
from pathlib import Path
from socketserver import TCPServer

import webview
from requests import exceptions as requests_exceptions
from nba_api.live.nba.endpoints import scoreboard, boxscore, playbyplay

try:
    from plyer import notification as plyer_notification
except Exception:
    plyer_notification = None

REFRESH_SECONDS = 10
LIVE_REQUEST_TIMEOUT_SECONDS = 15
LIVE_REQUEST_RETRY_ATTEMPTS = 3
LIVE_REQUEST_RETRY_BACKOFF_SECONDS = 0.5
SCOREBOARD_LIVE_BASE_POLL_MS = 12000
SCOREBOARD_LIVE_MIN_POLL_MS = 8000
SCOREBOARD_IDLE_POLL_MS = 30000
SCOREBOARD_MAX_POLL_MS = 60000
DETAIL_LIVE_BASE_POLL_MS = 8000
DETAIL_LIVE_MIN_POLL_MS = 5000
DETAIL_PARTIAL_POLL_MS = 12000
DETAIL_IDLE_POLL_MS = 20000
DETAIL_MAX_POLL_MS = 60000
LOG = logging.getLogger("nba_live_scoreboard")
BOX_CACHE = {}
BOX_BACKOFF = {}
MAX_BACKOFF_SECONDS = 60
PBP_BACKOFF = {}
ON_COURT_CACHE = {}
REQUEST_HEALTH = {}
FAVORITES_PATH = Path(__file__).resolve().parent / "nba-live-scoreboard-ui" / "resources" / "favorites.json"
UI_PREFERENCES_PATH = Path(__file__).resolve().parent / "nba-live-scoreboard-ui" / "resources" / "ui-preferences.json"
DEFAULT_UI_PREFERENCES = {
    "scoreboardView": "hidden",
    "tableView": "expanded",
    "zoomLevel": "1",
    "statFlashEnabled": True,
    "notificationsEnabled": False,
}

TRANSIENT_REQUEST_PATTERNS = (
    "connection aborted",
    "remote end closed connection without response",
    "remotedisconnected",
    "connection reset by peer",
    "connection broken",
    "read timed out",
    "temporarily unavailable",
)


def _request_health_defaults():
    return {
        "successStreak": 0,
        "failureStreak": 0,
        "lastSuccess": None,
        "lastFailure": None,
        "lastError": None,
    }


def _now_utc_iso():
    return datetime.now(timezone.utc).isoformat()


def _is_transient_request_error(exc):
    if isinstance(
        exc,
        (
            requests_exceptions.ConnectionError,
            requests_exceptions.Timeout,
            requests_exceptions.ChunkedEncodingError,
        ),
    ):
        return True
    text = str(exc).strip().lower()
    return any(pattern in text for pattern in TRANSIENT_REQUEST_PATTERNS)


def _friendly_request_error(context, exc):
    if _is_transient_request_error(exc):
        return f"The NBA live data connection dropped while loading {context}. The app will retry automatically."
    text = str(exc).strip()
    if text:
        return text
    return f"Unable to load {context} from the NBA live API right now."


def _get_request_health(name):
    state = REQUEST_HEALTH.get(name)
    if state is None:
        state = _request_health_defaults()
        REQUEST_HEALTH[name] = state
    return state


def _mark_request_success(name):
    if not name:
        return
    state = _get_request_health(name)
    state["successStreak"] = min(state["successStreak"] + 1, 6)
    state["failureStreak"] = 0
    state["lastSuccess"] = _now_utc_iso()
    state["lastError"] = None


def _mark_request_failure(name, exc):
    if not name:
        return
    state = _get_request_health(name)
    state["successStreak"] = 0
    state["failureStreak"] = min(state["failureStreak"] + 1, 6)
    state["lastFailure"] = _now_utc_iso()
    state["lastError"] = str(exc).strip() or exc.__class__.__name__


def _adaptive_interval_ms(base_ms, min_ms, max_ms, request_keys=None):
    keys = [key for key in (request_keys or []) if key]
    failure_streak = max((_get_request_health(key)["failureStreak"] for key in keys), default=0)
    success_streak = max((_get_request_health(key)["successStreak"] for key in keys), default=0)

    if failure_streak > 0:
        multiplier = min(1 + failure_streak, 4)
        return min(max_ms, max(min_ms, int(base_ms * multiplier)))

    if min_ms >= base_ms or success_streak <= 0:
        return min(max_ms, max(min_ms, base_ms))

    steps = min(success_streak, 4)
    reduction = int(((base_ms - min_ms) * steps) / 4)
    return min(max_ms, max(min_ms, base_ms - reduction))


def _backoff_remaining_ms(entry):
    if not entry:
        return 0
    remaining = (entry["nextAllowed"] - datetime.now(timezone.utc)).total_seconds()
    return max(0, int(remaining * 1000))


def _build_polling_state(refresh_ms, mode, reason=None):
    result = {
        "refreshMs": int(max(1000, refresh_ms)),
        "mode": mode,
    }
    if reason:
        result["reason"] = reason
    return result


def _scoreboard_polling_state(status, has_live_games):
    if status == "error":
        refresh_ms = _adaptive_interval_ms(
            SCOREBOARD_IDLE_POLL_MS,
            SCOREBOARD_IDLE_POLL_MS,
            SCOREBOARD_MAX_POLL_MS,
            ("scoreboard",),
        )
        return _build_polling_state(refresh_ms, "error", "scoreboard_error")

    if has_live_games:
        refresh_ms = _adaptive_interval_ms(
            SCOREBOARD_LIVE_BASE_POLL_MS,
            SCOREBOARD_LIVE_MIN_POLL_MS,
            SCOREBOARD_MAX_POLL_MS,
            ("scoreboard",),
        )
        return _build_polling_state(refresh_ms, "live")

    return _build_polling_state(SCOREBOARD_IDLE_POLL_MS, "idle")


def _detail_polling_state(status, game=None, data_status=None):
    game = game or {}
    game_status_key = game.get("statusKey")
    game_id = game.get("gameId")

    if status == "error":
        refresh_ms = _adaptive_interval_ms(
            DETAIL_IDLE_POLL_MS,
            DETAIL_IDLE_POLL_MS,
            DETAIL_MAX_POLL_MS,
            ("scoreboard", "boxscore", "playbyplay"),
        )
        return _build_polling_state(refresh_ms, "error", "detail_error")

    if game_status_key != "live":
        return _build_polling_state(DETAIL_IDLE_POLL_MS, "idle")

    data_level = (data_status or {}).get("level")
    if data_level == "stale":
        base_ms = DETAIL_PARTIAL_POLL_MS
        min_ms = DETAIL_PARTIAL_POLL_MS
        mode = "backoff"
    elif data_level in ("partial", "pending"):
        base_ms = DETAIL_PARTIAL_POLL_MS
        min_ms = 9000
        mode = "partial"
    else:
        base_ms = DETAIL_LIVE_BASE_POLL_MS
        min_ms = DETAIL_LIVE_MIN_POLL_MS
        mode = "live"

    refresh_ms = _adaptive_interval_ms(
        base_ms,
        min_ms,
        DETAIL_MAX_POLL_MS,
        ("boxscore", "playbyplay"),
    )

    if game_id:
        refresh_ms = max(
            refresh_ms,
            _backoff_remaining_ms(_get_backoff(game_id, BOX_BACKOFF)),
            _backoff_remaining_ms(_get_backoff(game_id, PBP_BACKOFF)),
        )

    return _build_polling_state(refresh_ms, mode)


def _apply_scoreboard_polling(state):
    state["polling"] = _scoreboard_polling_state(
        state.get("status"),
        bool(state.get("hasLiveGames")),
    )
    return state


def _apply_detail_polling(state):
    state["polling"] = _detail_polling_state(
        state.get("status"),
        state.get("game"),
        state.get("dataStatus"),
    )
    return state


def _fetch_live_data(context, factory, request_key=None):
    last_exc = None
    for attempt in range(1, LIVE_REQUEST_RETRY_ATTEMPTS + 1):
        try:
            result = factory()
            _mark_request_success(request_key)
            return result
        except Exception as exc:
            last_exc = exc
            transient = _is_transient_request_error(exc)
            if not transient or attempt >= LIVE_REQUEST_RETRY_ATTEMPTS:
                _mark_request_failure(request_key, exc)
                raise
            delay = LIVE_REQUEST_RETRY_BACKOFF_SECONDS * attempt
            LOG.warning(
                "%s request failed on attempt %s/%s: %s; retrying in %.1fs",
                context,
                attempt,
                LIVE_REQUEST_RETRY_ATTEMPTS,
                exc,
                delay,
            )
            time.sleep(delay)
    raise last_exc


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


def _coerce_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _coerce_bool(value):
    if isinstance(value, bool):
        return value
    if value is None:
        return None
    text = str(value).strip().lower()
    if text in ("1", "true", "yes", "on"):
        return True
    if text in ("0", "false", "no", "off"):
        return False
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


def _on_court_result(data=None, state="missing", message=None):
    return {
        "data": data,
        "state": state,
        "message": message,
    }


def _build_on_court(game_id, home, away):
    if not game_id or not home or not away:
        return _on_court_result()
    home_players = home.get("players") or []
    away_players = away.get("players") or []
    if not home_players or not away_players:
        return _on_court_result()

    home_on = _starter_ids(home_players)
    away_on = _starter_ids(away_players)

    backoff = _get_backoff(game_id, PBP_BACKOFF)
    cached = ON_COURT_CACHE.get(game_id)
    if backoff and cached:
        return _on_court_result(
            cached,
            state="stale",
            message="Using cached on-court lineups during play-by-play backoff.",
        )

    try:
        payload = _fetch_live_data(
            "play-by-play",
            lambda: playbyplay.PlayByPlay(
                game_id,
                timeout=LIVE_REQUEST_TIMEOUT_SECONDS,
            ).get_dict(),
            request_key="playbyplay",
        )
        _clear_backoff(game_id, PBP_BACKOFF)
    except Exception:
        LOG.exception("playbyplay error")
        _set_backoff(game_id, PBP_BACKOFF)
        if cached:
            return _on_court_result(
                cached,
                state="stale",
                message="Using cached on-court lineups because play-by-play is unavailable.",
            )
        return _on_court_result(
            None,
            state="missing",
            message="On-court lineups are unavailable because play-by-play data could not be loaded.",
        )

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
        if cached:
            return _on_court_result(
                cached,
                state="stale",
                message="Using last known on-court lineups because live substitutions are unavailable.",
            )
        return _on_court_result(
            None,
            state="missing",
            message="On-court lineups are unavailable for this game right now.",
        )

    result = {"home": sorted(home_on), "away": sorted(away_on)}
    ON_COURT_CACHE[game_id] = result
    return _on_court_result(result, state="fresh")


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
    game_status = game.get("gameStatus")
    status_text = game.get("gameStatusText") or ""
    return {
        "gameId": game.get("gameId"),
        "matchup": matchup,
        "statusText": status_text,
        "status": _map_status(game_status, status_text),
        "statusKey": _game_status_key(game_status),
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


def _game_status_key(game_status):
    if game_status == 2:
        return "live"
    if game_status == 3:
        return "final"
    return "scheduled"


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


def _ordinal(value):
    if value % 100 in (11, 12, 13):
        suffix = "th"
    else:
        suffix = {1: "st", 2: "nd", 3: "rd"}.get(value % 10, "th")
    return f"{value}{suffix}"


def _format_ot_label(period):
    ot_number = period - 4
    if ot_number <= 1:
        return "OT"
    return f"{ot_number}OT"


def _format_period_start(period):
    if period is None or period <= 0:
        return None
    if period <= 4:
        return f"{_ordinal(period)} Quarter Started"
    return f"{_format_ot_label(period)} Started"


def _format_period_end(period):
    if period is None or period <= 0:
        return None
    if period <= 4:
        return f"{_ordinal(period)} Quarter Ended"
    return f"{_format_ot_label(period)} Ended"


def _normalize_view_mode(value):
    if value in ("full", "compact", "hidden"):
        return value
    return None


def _normalize_zoom_level(value):
    text = str(value).strip()
    if text in {"0.8", "0.9", "1", "1.1", "1.2"}:
        return text
    return None


def _normalize_ui_preferences(preferences):
    result = dict(DEFAULT_UI_PREFERENCES)
    if not isinstance(preferences, dict):
        return result

    normalized_view = _normalize_view_mode(preferences.get("scoreboardView"))
    if normalized_view:
        result["scoreboardView"] = normalized_view

    result["tableView"] = "compact" if preferences.get("tableView") == "compact" else "expanded"

    normalized_zoom = _normalize_zoom_level(preferences.get("zoomLevel"))
    if normalized_zoom:
        result["zoomLevel"] = normalized_zoom

    stat_flash = _coerce_bool(preferences.get("statFlashEnabled"))
    if stat_flash is not None:
        result["statFlashEnabled"] = stat_flash

    notifications_enabled = _coerce_bool(preferences.get("notificationsEnabled"))
    if notifications_enabled is not None:
        result["notificationsEnabled"] = notifications_enabled

    return result


def _load_ui_preferences():
    try:
        if not UI_PREFERENCES_PATH.exists():
            return dict(DEFAULT_UI_PREFERENCES)
        with UI_PREFERENCES_PATH.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
        return _normalize_ui_preferences(data)
    except Exception:
        LOG.exception("failed to load ui preferences")
        return dict(DEFAULT_UI_PREFERENCES)


def _save_ui_preferences(preferences):
    try:
        UI_PREFERENCES_PATH.parent.mkdir(parents=True, exist_ok=True)
        normalized = _normalize_ui_preferences(preferences)
        with UI_PREFERENCES_PATH.open("w", encoding="utf-8") as handle:
            json.dump(normalized, handle)
        return True
    except Exception:
        LOG.exception("failed to save ui preferences")
        return False


def _format_matchup_title(home, away):
    away_code = (away.get("tricode") or "").strip()
    home_code = (home.get("tricode") or "").strip()
    if away_code and home_code:
        return f"{away_code} @ {home_code}"
    return "NBA Live Scoreboard"


def _format_score_line(home, away):
    away_code = (away.get("tricode") or "").strip()
    home_code = (home.get("tricode") or "").strip()
    away_score = away.get("score")
    home_score = home.get("score")
    away_text = str(away_score) if away_score is not None else "-"
    home_text = str(home_score) if home_score is not None else "-"
    if away_code and home_code:
        return f"{away_code} {away_text} - {home_text} {home_code}"
    return ""


def _apply_on_court_state(home, away, on_court_state):
    data = (on_court_state or {}).get("data") or {}
    if data:
        return (
            {**home, "onCourt": data.get("home", [])},
            {**away, "onCourt": data.get("away", [])},
        )
    return (
        {**home, "onCourt": []},
        {**away, "onCourt": []},
    )


def _build_data_status(level, title, message, updated, issues=None):
    return {
        "level": level,
        "title": title,
        "message": message,
        "updated": updated,
        "issues": issues or [],
    }


def _clock_to_seconds(value):
    if not value:
        return None
    text = str(value)
    iso_match = re.match(r"PT(\d+)M(\d+(?:\.\d+)?)S", text)
    if iso_match:
        minutes = int(iso_match.group(1))
        seconds = float(iso_match.group(2))
        return int(minutes * 60 + seconds)
    simple_match = re.match(r"(\d+):(\d{2})", text)
    if simple_match:
        return int(simple_match.group(1)) * 60 + int(simple_match.group(2))
    return None


def _has_favorite_team(game, favorite_tricodes):
    if not game or not favorite_tricodes:
        return False
    home = (game.get("home") or {}).get("tricode")
    away = (game.get("away") or {}).get("tricode")
    return home in favorite_tricodes or away in favorite_tricodes


class GameEventNotifier:
    def __init__(self):
        self._last_state = {}
        self._sent_events = {}

    def _send(self, game_id, event_key, title, message):
        if not plyer_notification:
            return
        sent = self._sent_events.setdefault(game_id, set())
        if event_key in sent:
            return
        try:
            plyer_notification.notify(
                title=title,
                message=message,
                app_name="NBA Live Scoreboard",
                timeout=6,
            )
            sent.add(event_key)
        except Exception:
            LOG.exception("notification error")

    def maybe_notify_games(self, games, favorite_tricodes, selected_game_id, view_mode, enabled=True):
        for game in games or []:
            game_id = game.get("gameId")
            if not game_id:
                continue

            status_key = game.get("statusKey") or "scheduled"
            period = _coerce_int(game.get("period"))
            home = game.get("home") or {}
            away = game.get("away") or {}
            home_score = _coerce_int(home.get("score")) or 0
            away_score = _coerce_int(away.get("score")) or 0
            clock_seconds = _clock_to_seconds(game.get("clock"))
            tracked = bool(selected_game_id and game_id == selected_game_id) or _has_favorite_team(game, favorite_tricodes)

            prev = self._last_state.get(game_id)
            self._last_state[game_id] = {
                "statusKey": status_key,
                "period": period,
                "homeScore": home_score,
                "awayScore": away_score,
                "clockSeconds": clock_seconds,
            }

            if not prev or not enabled or not plyer_notification or not tracked:
                continue

            prev_status = prev.get("statusKey")
            prev_period = prev.get("period")
            period_bumped = bool(prev_period and period and period > prev_period)
            margin = abs(home_score - away_score)
            include_score = _normalize_view_mode(view_mode) in ("full", "compact")
            title = _format_matchup_title(home, away)
            score_line = _format_score_line(home, away)
            is_selected = bool(selected_game_id and game_id == selected_game_id)
            events = []

            if prev_status != "live" and status_key == "live":
                events.append(("game_start", "Game Started"))

            if is_selected and period_bumped:
                end_label = _format_period_end(prev_period)
                if end_label:
                    events.append((f"period_end_{prev_period}", end_label))
                start_label = _format_period_start(period)
                if start_label and period and period > 1:
                    events.append((f"period_start_{period}", start_label))

            if status_key == "live" and period and period > 4:
                if prev_period is None or prev_period < period:
                    events.append((f"overtime_{period}", f"{_format_ot_label(period)} Started"))

            if (
                status_key == "live"
                and period
                and period >= 4
                and clock_seconds is not None
                and clock_seconds <= 300
                and margin <= 5
            ):
                events.append((f"close_game_{period}", "Close Game"))

            if prev_status == "live" and status_key == "final":
                if is_selected and period and not period_bumped:
                    end_label = _format_period_end(period)
                    if end_label:
                        events.append((f"period_end_{period}", end_label))
                events.append(("game_final", "Final"))

            for event_key, message in events:
                if include_score and score_line:
                    body = f"{message} | {score_line}"
                else:
                    body = message
                self._send(game_id, event_key, title, body)


def _load_scoreboard_snapshot():
    updated = _now_utc_iso()
    LOG.info("scoreboard snapshot start")
    try:
        board = _fetch_live_data(
            "today's scoreboard",
            lambda: scoreboard.ScoreBoard(timeout=LIVE_REQUEST_TIMEOUT_SECONDS),
            request_key="scoreboard",
        )
        games = board.games.get_dict()
        LOG.info("scoreboard returned %s games", len(games))
    except Exception as exc:
        LOG.exception("scoreboard error")
        return updated, None, [], _friendly_request_error("today's scoreboard", exc)

    summaries = [_summarize_game(g) for g in games]
    return updated, games, summaries, None


def build_scoreboard_state():
    updated, games, summaries, error = _load_scoreboard_snapshot()
    if error:
        return _apply_scoreboard_polling({
            "status": "error",
            "updated": updated,
            "error": error,
            "games": [],
            "hasLiveGames": False,
        })

    if not games:
        return _apply_scoreboard_polling({
            "status": "no_games",
            "updated": updated,
            "games": [],
            "hasLiveGames": False,
        })

    return _apply_scoreboard_polling({
        "status": "ok",
        "updated": updated,
        "games": summaries,
        "hasLiveGames": any(game.get("statusKey") == "live" for game in summaries),
    })


def build_state(game_id=None):
    updated, games, summaries, error = _load_scoreboard_snapshot()
    if error:
        return _apply_detail_polling({
            "status": "error",
            "updated": updated,
            "error": error,
            "games": [],
        })

    LOG.info("build_state start")

    if not games:
        return _apply_detail_polling({
            "status": "no_games",
            "updated": updated,
            "games": [],
        })

    if not game_id:
        return _apply_detail_polling({
            "status": "select_game",
            "updated": updated,
            "games": summaries,
        })

    selected_game = next((g for g in games if g.get("gameId") == game_id), None)
    if not selected_game:
        LOG.info("game id %s not found in scoreboard", game_id)
        return _apply_detail_polling({
            "status": "game_not_found",
            "updated": updated,
            "games": summaries,
        })

    game_status = selected_game.get("gameStatus")
    status_text = selected_game.get("gameStatusText") or ""

    base_game = {
        "gameId": selected_game.get("gameId"),
        "status": _map_status(game_status, status_text),
        "statusKey": _game_status_key(game_status),
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
        return _apply_detail_polling({
            "status": "scheduled",
            "updated": updated,
            "dataUpdated": updated,
            "dataStatus": None,
            "game": base_game,
            "games": summaries,
            "periods": [],
            "home": {**home_fallback, "stats": {}, "players": [], "onCourt": []},
            "away": {**away_fallback, "stats": {}, "players": [], "onCourt": []},
            "error": None,
        })

    cache = BOX_CACHE.get(base_game["gameId"])
    backoff = _get_backoff(base_game["gameId"])
    if backoff and cache:
        LOG.info("backoff active for %s; using cached boxscore", base_game["gameId"])
        home = cache.get("home", {**home_fallback, "stats": {}, "players": []})
        away = cache.get("away", {**away_fallback, "stats": {}, "players": []})
        on_court_state = _build_on_court(base_game["gameId"], home, away) if game_status == 2 else _on_court_result()
        home, away = _apply_on_court_state(home, away, on_court_state)
        issues = []
        if on_court_state.get("message"):
            issues.append(on_court_state["message"])
        return _apply_detail_polling({
            "status": "ok",
            "updated": updated,
            "dataUpdated": cache.get("dataUpdated", updated),
            "dataStatus": _build_data_status(
                "stale",
                "Showing cached box score",
                "Live updates are temporarily behind because the NBA API is in backoff.",
                cache.get("dataUpdated", updated),
                issues,
            ),
            "game": base_game,
            "games": summaries,
            "periods": cache.get("periods", []),
            "home": home,
            "away": away,
            "error": "Using cached data during API backoff.",
        })

    error = None
    try:
        LOG.info("fetching boxscore for %s", base_game["gameId"])
        box = _fetch_live_data(
            "the box score",
            lambda: boxscore.BoxScore(
                base_game["gameId"],
                timeout=LIVE_REQUEST_TIMEOUT_SECONDS,
            ).get_dict(),
            request_key="boxscore",
        )
        LOG.info("boxscore received")
        _clear_backoff(base_game["gameId"])
    except Exception as exc:
        LOG.exception("boxscore error")
        box = {}
        error = _friendly_request_error("the box score", exc)
        _set_backoff(base_game["gameId"])
        if cache:
            home = cache.get("home", {**home_fallback, "stats": {}, "players": []})
            away = cache.get("away", {**away_fallback, "stats": {}, "players": []})
            on_court_state = _build_on_court(base_game["gameId"], home, away) if game_status == 2 else _on_court_result()
            home, away = _apply_on_court_state(home, away, on_court_state)
            issues = []
            if on_court_state.get("message"):
                issues.append(on_court_state["message"])
            return _apply_detail_polling({
                "status": "ok",
                "updated": updated,
                "dataUpdated": cache.get("dataUpdated", updated),
                "dataStatus": _build_data_status(
                    "stale",
                    "Showing cached box score",
                    "The latest box score request failed, so the app is using the last successful snapshot.",
                    cache.get("dataUpdated", updated),
                    issues,
                ),
                "game": base_game,
                "games": summaries,
                "periods": cache.get("periods", []),
                "home": home,
                "away": away,
                "error": "Using cached data after boxscore error.",
            })

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
    on_court_state = _build_on_court(base_game["gameId"], home, away) if game_status == 2 else _on_court_result()
    home, away = _apply_on_court_state(home, away, on_court_state)

    data_status = None
    if on_court_state.get("state") in ("stale", "missing"):
        message = on_court_state.get("message") or "On-court lineups are unavailable right now."
        data_status = _build_data_status(
            "partial",
            "Live box score is current",
            message,
            updated,
            [message],
        )
    elif game_status == 2 and not (home.get("players") or away.get("players")):
        data_status = _build_data_status(
            "pending",
            "Live box score pending",
            "The game is live, but player stats have not populated yet.",
            updated,
        )

    return _apply_detail_polling({
        "status": "ok" if (home.get("players") or away.get("players")) else ("postgame" if game_status == 3 else "live_no_data"),
        "updated": updated,
        "dataUpdated": BOX_CACHE.get(base_game["gameId"], {}).get("dataUpdated", updated),
        "dataStatus": data_status,
        "game": base_game,
        "games": summaries,
        "periods": periods,
        "home": home,
        "away": away,
        "error": error,
    })


class RaptorsLiveAPI:
    def __init__(self):
        self._lock = threading.Lock()
        self._last_state = {
            "status": "loading",
            "updated": None,
            "game": None,
        }
        self._last_scoreboard_state = {
            "status": "loading",
            "updated": None,
            "games": [],
        }
        self._favorites = _load_favorites()
        self._preferences = _load_ui_preferences()
        self._notifier = GameEventNotifier()
        self._view_mode = self._preferences.get("scoreboardView", "hidden")
        self._notifications_enabled = bool(self._preferences.get("notificationsEnabled"))

    def _sync_runtime_options(self, view_mode=None, notifications_enabled=None):
        normalized_view = _normalize_view_mode(view_mode)
        if normalized_view:
            self._view_mode = normalized_view
        normalized_notify = _coerce_bool(notifications_enabled)
        if normalized_notify is not None:
            self._notifications_enabled = normalized_notify

    def get_state(self, game_id=None, view_mode=None, notifications_enabled=None):
        LOG.info("js->get_state called")
        self._sync_runtime_options(view_mode, notifications_enabled)
        state = build_state(game_id)
        with self._lock:
            self._last_state = state
        LOG.info("js->get_state returning %s", state.get("status"))
        return state

    def get_scoreboard(self, selected_game_id=None, view_mode=None, notifications_enabled=None):
        LOG.info("js->get_scoreboard called")
        self._sync_runtime_options(view_mode, notifications_enabled)
        state = build_scoreboard_state()
        self._notifier.maybe_notify_games(
            state.get("games") or [],
            set(self._favorites),
            selected_game_id,
            self._view_mode,
            self._notifications_enabled,
        )
        with self._lock:
            self._last_scoreboard_state = state
        LOG.info("js->get_scoreboard returning %s", state.get("status"))
        return state

    def get_last_state(self):
        LOG.info("js->get_last_state called")
        with self._lock:
            return self._last_state

    def get_last_scoreboard_state(self):
        LOG.info("js->get_last_scoreboard_state called")
        with self._lock:
            return self._last_scoreboard_state

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

    def get_preferences(self):
        LOG.info("js->get_preferences called")
        with self._lock:
            return dict(self._preferences)

    def set_preferences(self, preferences):
        LOG.info("js->set_preferences called")
        if not isinstance(preferences, dict):
            return {"status": "error", "error": "preferences must be an object"}

        with self._lock:
            merged = dict(self._preferences)
            merged.update(preferences)
            normalized = _normalize_ui_preferences(merged)
            self._preferences = normalized
            self._view_mode = normalized.get("scoreboardView", self._view_mode)
            self._notifications_enabled = bool(normalized.get("notificationsEnabled"))

        saved = _save_ui_preferences(normalized)
        return {
            "status": "ok" if saved else "error",
            "preferences": normalized,
        }


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    root = Path(__file__).resolve().parent
    ui_dir = root / "nba-live-scoreboard-ui"

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
                view_mode = (query.get("view") or [""])[0] or None
                notify = (query.get("notify") or [""])[0] or None
                state = api.get_state(game_id, view_mode, notify)
                payload = json.dumps(state).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                return
            if parsed.path == "/api/scoreboard":
                LOG.info("http /api/scoreboard requested")
                query = parse_qs(parsed.query)
                selected_game_id = (query.get("selectedGameId") or [""])[0] or None
                view_mode = (query.get("view") or [""])[0] or None
                notify = (query.get("notify") or [""])[0] or None
                state = api.get_scoreboard(selected_game_id, view_mode, notify)
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
            if parsed.path == "/api/preferences":
                LOG.info("http /api/preferences requested")
                payload = json.dumps(api.get_preferences()).encode("utf-8")
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
            if parsed.path == "/api/preferences":
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length)
                try:
                    payload = json.loads(body.decode("utf-8") or "{}")
                except json.JSONDecodeError:
                    payload = {}
                result = api.set_preferences(payload)
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
