import importlib.util
import json
import socket
import threading
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler
from pathlib import Path
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

import requests


spec = importlib.util.spec_from_file_location(
    "scoreboard", Path(__file__).resolve().parents[1] / "nba-live-scoreboard.py"
)
app = importlib.util.module_from_spec(spec)
spec.loader.exec_module(app)


def response(payload, status=200):
    result = requests.Response()
    result.status_code = status
    result.url = "https://nba.com/test"
    result.encoding = "utf-8"
    result._content = (payload if isinstance(payload, str) else json.dumps(payload)).encode()
    return result


class DataFallbackTests(unittest.TestCase):
    def setUp(self):
        for cache in (app.GAME_PAGE_CACHE, app.BOX_CACHE, app.BOX_BACKOFF,
                      app.PBP_CACHE, app.PBP_BACKOFF, app.REQUEST_HEALTH,
                      app.SCHEDULE_STATUS_CACHE, app.SCHEDULE_STATUS_PENDING,
                      app.RATE_LIMITS, app.SCOREBOARD_CACHE, app.SCOREBOARD_REQUEST_LOCKS):
            cache.clear()
        self.game_id = "0012600046"
        self.game = {
            "gameId": self.game_id, "gameStatus": 2, "gameStatusText": "1st Qtr",
            "period": 1, "gameClock": "PT04M30.00S",
            "gameTimeUTC": "2026-10-13T23:00:00Z",
            "homeTeam": {"teamId": 1, "teamTricode": "TOR", "score": 7},
            "awayTeam": {"teamId": 2, "teamTricode": "NYK", "score": 3},
        }
        self.board = {"scoreboard": {"games": [self.game]}}

    def page(self, game=None, playbyplay=None):
        props = {"game": game if game is not None else self.game,
                 "playByPlay": playbyplay}
        payload = json.dumps({"props": {"pageProps": props}})
        return '<script>{"unrelated":true}</script><script id="__NEXT_DATA__">' + payload + '</script>'

    def games_page(self, date, games):
        cards = [{"cardType": "game", "cardData": game} for game in games]
        props = {"selectedDate": date, "hasError": False,
                 "gameCardFeed": {"modules": [{"cards": cards}]}}
        return '<script id="__NEXT_DATA__">' + json.dumps({"props": {"pageProps": props}}) + '</script>'

    @patch.object(app.requests, "get")
    def test_blocked_scoreboard_uses_games_page_and_recovers_health(self, get):
        get.side_effect = [response("Access Denied", 403),
                           response(self.games_page(app._local_today_iso(), [self.game]))]
        state = app.build_scoreboard_state()
        self.assertEqual(state["status"], "ok")
        self.assertEqual(state["games"][0]["gameId"], self.game_id)
        self.assertEqual(state["games"][0]["clock"], "PT04M30.00S")
        self.assertTrue(state["hasLiveGames"])
        self.assertEqual(get.call_args.args[0], "https://www.nba.com/games")
        self.assertEqual(get.call_args.kwargs["params"]["date"], state["scoreboardDate"])
        self.assertEqual(app.REQUEST_HEALTH["scoreboard"]["failureStreak"], 0)

    @patch.object(app.requests, "get")
    def test_working_live_feed_does_not_call_fallback(self, get):
        get.return_value = response(self.board)
        self.assertEqual(app.build_scoreboard_state()["status"], "ok")
        get.assert_called_once()
        self.assertTrue(get.call_args.args[0].startswith(app.LIVE_DATA_BASE_URL))

    @patch.object(app.requests, "get")
    def test_both_feeds_failing_keeps_an_explicit_error(self, get):
        get.side_effect = [response("Blocked", 403), response("Unavailable", 503),
                           response("Unavailable", 503)]
        with self.assertLogs(app.LOG, level="ERROR"):
            state = app.build_scoreboard_state()
        self.assertEqual(state["status"], "error")
        self.assertIn("503", state["error"])
        self.assertEqual(state["games"], [])

    @patch.object(app.requests, "get")
    def test_dated_games_page_preserves_game_ids_teams_and_tipoff(self, get):
        date = "2026-10-30"
        game = {**self.game, "gameStatus": 1, "gameStatusText": "7:00 pm ET",
                "gameTimeUtc": "2026-10-30T23:00:00Z",
                "homeTeam": {"teamId": 1610612764, "teamName": "Wizards", "teamTricode": "WAS", "score": 0},
                "awayTeam": {"teamId": 1610612766, "teamName": "Hornets", "teamTricode": "CHA", "score": 0}}
        game.pop("gameTimeUTC", None)
        get.return_value = response(self.games_page(date, [game]))
        with patch.object(app, "_is_today_scoreboard_date", return_value=False):
            state = app.build_scoreboard_state(date)
        self.assertEqual(state["status"], "ok")
        self.assertEqual(state["games"][0]["gameId"], self.game_id)
        self.assertEqual(state["games"][0]["home"]["city"], "Washington")
        self.assertEqual(state["games"][0]["away"]["city"], "Charlotte")
        self.assertEqual(state["games"][0]["startTimeUTC"], "2026-10-30T23:00:00Z")
        self.assertEqual(get.call_args.kwargs["params"], {"date": date})

    @patch.object(app.requests, "get")
    def test_dated_games_page_empty_is_not_an_error(self, get):
        date = "2030-10-30"
        get.return_value = response(self.games_page(date, []))
        with patch.object(app, "_is_today_scoreboard_date", return_value=False):
            state = app.build_scoreboard_state(date)
        self.assertEqual(state["status"], "no_games")
        self.assertEqual(state["games"], [])

    @patch.object(app.requests, "get")
    def test_dated_page_wrong_date_uses_stats_fallback(self, get):
        date = "2026-10-30"
        get.side_effect = [response(self.games_page("2026-10-29", [self.game])), response(self.board)]
        with patch.object(app, "_is_today_scoreboard_date", return_value=False):
            state = app.build_scoreboard_state(date)
        self.assertEqual(state["status"], "ok")
        self.assertEqual(get.call_args.args[0], app.STATS_DATA_BASE_URL + "/scoreboardv3")
        self.assertEqual(get.call_args.kwargs["params"]["GameDate"], date)

    @patch.object(app.requests, "get")
    def test_invalid_dated_responses_produce_readable_error(self, get):
        get.side_effect = [response("not a page"), response("not json")]
        with patch.object(app, "_is_today_scoreboard_date", return_value=False):
            with self.assertLogs(app.LOG, level="ERROR"):
                state = app.build_scoreboard_state("2026-10-30")
        self.assertEqual(state["status"], "error")
        self.assertIn("invalid response", state["error"])
        self.assertNotIn("Expecting value", state["error"])

    @patch.object(app.requests, "get")
    def test_invalid_scoreboard_shape_is_not_mistaken_for_no_games(self, get):
        get.side_effect = [response("not a page"), response({"message": "feed unavailable"})]
        with patch.object(app, "_is_today_scoreboard_date", return_value=False):
            with self.assertLogs(app.LOG, level="ERROR"):
                state = app.build_scoreboard_state("2026-10-30")
        self.assertEqual(state["status"], "error")

    @patch.object(app.requests, "get")
    def test_rate_limit_honors_retry_after_without_immediate_fallback(self, get):
        limited = response("Too many requests", 429)
        limited.headers["Retry-After"] = "120"
        get.return_value = limited
        with patch.object(app, "_fetch_games_page_scoreboard") as fallback:
            for _ in range(2):
                with self.assertRaises(app.RateLimitError):
                    app._fetch_live_json("scoreboard/todaysScoreboard_00.json", "scoreboard", fallback=fallback)
        self.assertEqual(get.call_count, 1)
        fallback.assert_not_called()
        self.assertGreater(app.RATE_LIMITS["cdn.nba.com"] - app.time.monotonic(), 110)
        polling = app._scoreboard_polling_state("error", False)
        self.assertGreater(polling["refreshMs"], 110000)

    def test_retry_after_accepts_http_dates_and_invalid_values(self):
        from email.utils import format_datetime
        future = datetime.now(timezone.utc) + timedelta(seconds=120)
        self.assertGreater(app._retry_after_seconds(format_datetime(future, usegmt=True)), 115)
        self.assertEqual(app._retry_after_seconds("nonsense"), 60)
        self.assertEqual(app._retry_after_seconds("inf"), 60)

    def test_box_and_playbyplay_backoffs_are_independent(self):
        app._set_backoff(self.game_id, app.PBP_BACKOFF)
        self.assertIn(self.game_id, app.PBP_BACKOFF)
        self.assertNotIn(self.game_id, app.BOX_BACKOFF)
        app._set_backoff(self.game_id, app.BOX_BACKOFF)
        app._clear_backoff(self.game_id, app.PBP_BACKOFF)
        self.assertIn(self.game_id, app.BOX_BACKOFF)
        self.assertNotIn(self.game_id, app.PBP_BACKOFF)

    @patch.object(app.requests, "get")
    def test_rate_limit_is_scoped_to_the_origin(self, get):
        limited = response("Too many requests", 429)
        limited.headers["Retry-After"] = "120"
        get.side_effect = [limited, response({"ok": True})]
        with self.assertRaises(app.RateLimitError):
            app._fetch_json("https://cdn.nba.com/test", "test", {})
        self.assertEqual(app._fetch_json("https://www.nba.com/test", "test", {}), {"ok": True})
        self.assertEqual(get.call_count, 2)

    def test_playbyplay_backoff_without_cache_skips_request(self):
        app._set_backoff(self.game_id, app.PBP_BACKOFF)
        with patch.object(app, "_fetch_live_json") as fetch:
            result = app._build_playbyplay_state(self.game_id, {"players": []}, {"players": []})
        fetch.assert_not_called()
        self.assertEqual(result["recentPlays"]["state"], "missing")

    def test_boxscore_backoff_without_cache_skips_box_request(self):
        app._set_backoff(self.game_id, app.BOX_BACKOFF)
        with patch.object(app, "_load_scoreboard_snapshot", return_value=(
                "updated", [self.game], [], None, app._local_today_iso(), True)), \
                patch.object(app, "_build_playbyplay_state", return_value={}) as plays, \
                patch.object(app, "_fetch_live_json") as fetch:
            state = app.build_state(self.game_id)
        fetch.assert_not_called()
        plays.assert_called_once()
        self.assertEqual(state["status"], "live_no_data")
        self.assertEqual(state["dataStatus"]["level"], "pending")

    def test_scoreboard_snapshot_is_shared_between_concurrent_requests(self):
        started = threading.Event()
        release = threading.Event()
        def load(date):
            started.set()
            self.assertTrue(release.wait(3))
            return ("updated", [self.game], [], None, date, False)
        with patch.object(app, "_is_today_scoreboard_date", return_value=False), \
                patch.object(app, "_load_uncached_scoreboard_snapshot", side_effect=load) as fetch:
            with ThreadPoolExecutor(max_workers=2) as pool:
                first = pool.submit(app._load_scoreboard_snapshot, "2026-10-30")
                self.assertTrue(started.wait(3))
                second = pool.submit(app._load_scoreboard_snapshot, "2026-10-30")
                release.set()
                self.assertEqual(first.result(), second.result())
            self.assertEqual(fetch.call_count, 1)

    def test_scoreboard_cache_expires_and_keeps_dates_separate(self):
        def load(date):
            return ("updated", [self.game], [], None, date, False)
        with patch.object(app, "_is_today_scoreboard_date", return_value=False), \
                patch.object(app, "_load_uncached_scoreboard_snapshot", side_effect=load) as fetch:
            app._load_scoreboard_snapshot("2026-10-30")
            app._load_scoreboard_snapshot("2026-10-30")
            app._load_scoreboard_snapshot("2026-10-31")
            self.assertEqual(fetch.call_count, 2)
            app.SCOREBOARD_CACHE[("2026-10-30", False)]["fetched"] -= app.SCOREBOARD_CACHE_SECONDS + 1
            app._load_scoreboard_snapshot("2026-10-30")
            self.assertEqual(fetch.call_count, 3)

    @patch.object(app.requests, "get")
    def test_game_page_is_shared_between_boxscore_and_playbyplay(self, get):
        plays = {"gameId": self.game_id, "actions": []}
        get.return_value = response(self.page(playbyplay=plays))
        app._fetch_game_page(self.game_id)
        self.assertEqual(app._fetch_game_page_playbyplay(self.game_id), {"game": plays})
        get.assert_called_once()
        app.GAME_PAGE_CACHE[self.game_id]["fetched"] -= 16
        app._fetch_game_page(self.game_id)
        self.assertEqual(get.call_count, 2)

    @patch.object(app.requests, "get")
    def test_game_page_rejects_wrong_game_and_missing_payload(self, get):
        get.return_value = response(self.page(game={"gameId": "another_game"}))
        with self.assertRaisesRegex(ValueError, "different game"):
            app._fetch_game_page(self.game_id)
        get.return_value = response("<html>Access denied</html>")
        with self.assertRaisesRegex(ValueError, "did not include game data"):
            app._fetch_game_page(self.game_id)
        self.assertEqual(app.GAME_PAGE_CACHE, {})

    @patch.object(app.requests, "get")
    def test_blocked_game_feeds_preserve_stats_periods_and_substitutions(self, get):
        player = {"personId": 10, "firstName": "Starter", "familyName": "Home",
                  "starter": "1", "statistics": {"points": 7, "minutes": "PT05M00S"}}
        bench = {"personId": 11, "firstName": "Bench", "familyName": "Home", "starter": "0"}
        self.game["homeTeam"].update({"players": [player, bench],
                                     "statistics": {"points": 7},
                                     "periods": [{"period": 1, "score": 7}]})
        self.game["awayTeam"].update({"players": [{**player, "personId": 20}],
                                     "statistics": {"points": 3},
                                     "periods": [{"period": 1, "score": 3}]})
        box_game = json.loads(json.dumps(self.game))
        box_game["gameClock"] = "PT03M00.00S"
        box_game["homeTeam"]["score"] = 9
        plays = {"gameId": self.game_id, "actions": [
            {"actionNumber": 1, "orderNumber": 1, "actionType": "substitution",
             "subType": "out", "personId": 10, "teamId": 1},
            {"actionNumber": 2, "orderNumber": 2, "actionType": "substitution",
             "subType": "in", "personId": 11, "teamId": 1},
            {"actionNumber": 3, "orderNumber": 3, "description": "Home scores",
             "actionType": "2pt", "period": 1, "scoreHome": "7", "scoreAway": "3"},
        ]}
        get.side_effect = [response("Blocked", 403), response(self.games_page(app._local_today_iso(), [self.game])),
                           response("Blocked", 403), response(self.page(game=box_game, playbyplay=plays)),
                           response("Blocked", 403)]
        state = app.build_state(self.game_id)
        self.assertEqual(state["status"], "ok")
        self.assertIsNone(state["error"])
        self.assertEqual(state["home"]["players"][0]["points"], 7)
        self.assertEqual(state["home"]["score"], 9)
        self.assertEqual(state["game"]["clock"], "PT03M00.00S")
        self.assertFalse(state["home"]["players"][1]["starter"])
        self.assertEqual(state["home"]["onCourt"], [11])
        self.assertEqual(state["periods"][0], {"label": "Q1", "home": 7, "away": 3})
        self.assertEqual(state["recentPlays"]["plays"][0]["scoreHome"], 7)
        self.assertEqual(get.call_count, 5)

    def test_game_page_plays_keep_order_formatting_and_running_score(self):
        home = {"id": 1, "tricode": "TOR", "city": "Toronto", "name": "Raptors"}
        away = {"id": 2, "tricode": "ORL", "city": "Orlando", "name": "Magic"}
        common = {"period": 4, "scoreHome": "", "scoreAway": ""}
        actions = [
            {**common, "actionId": 1, "actionNumber": 3, "clock": "PT02M00.00S",
             "actionType": "Made Shot", "description": "Carter 3PT Jump Shot (6 PTS) (Bitadze 1 AST)",
             "playerName": "Carter", "playerNameI": "W. Carter", "teamTricode": "ORL",
             "scoreHome": "99", "scoreAway": "89"},
            {**common, "actionId": 2, "actionNumber": 9, "clock": "PT01M18.00S",
             "actionType": "Missed Shot", "description": "MISS Cain 5' Tip Layup Shot",
             "playerName": "Cain", "playerNameI": "J. Cain", "teamTricode": "ORL"},
            {**common, "actionId": 3, "actionNumber": 9, "clock": "PT01M18.00S",
             "actionType": "Rebound", "subType": "Unknown", "description": "Martin REBOUND (Off:0 Def:1)",
             "playerName": "Martin", "playerNameI": "C. Martin", "teamTricode": "TOR"},
            {**common, "actionId": 4, "actionNumber": 4, "clock": "PT00M06.00S",
             "actionType": "Free Throw", "description": "Martin Free Throw 1 of 1 (1 PTS)",
             "playerName": "Martin", "teamTricode": "TOR", "scoreHome": "100", "scoreAway": "89"},
        ]
        payload = {"game": {"source": "hanaV3", "actions": actions}}
        with patch.object(app, "_fetch_live_json", return_value=payload):
            plays = app._build_playbyplay_state(self.game_id, home, away)["recentPlays"]["data"]
            self.assertEqual(len(plays), 4)
            self.assertEqual([p["actionNumber"] for p in plays], [4, 9, 9, 3])
            self.assertIn("Martin makes free throw", plays[0]["description"])
            self.assertIn("Martin rebound (1 rebound; 0 offensive, 1 defensive)", plays[1]["description"])
            self.assertIn("Cain misses 5-foot tip layup", plays[2]["description"])
            self.assertIn("Carter makes three-pointer", plays[3]["description"])
            self.assertIn("Bitadze 1 assist", plays[3]["description"])
            self.assertEqual([(p["scoreHome"], p["scoreAway"]) for p in plays],
                             [(100, 89), (99, 89), (99, 89), (99, 89)])
            self.assertEqual(app._build_playbyplay_state(self.game_id, home, away)["recentPlays"]["data"], plays)

    def test_game_page_plays_do_not_guess_missing_early_scores(self):
        actions = [{"actionId": 1, "actionNumber": 1, "actionType": "Jump Ball",
                    "description": "Jump Ball", "scoreHome": "", "scoreAway": ""}]
        with patch.object(app, "_fetch_live_json", return_value={"game": {"source": "hanaV3", "actions": actions}}):
            play = app._build_playbyplay_state(self.game_id, {}, {})["recentPlays"]["data"][0]
        self.assertIsNone(play["scoreHome"])
        self.assertIsNone(play["scoreAway"])

    def test_homepage_updates_all_due_games_without_blocking_or_a_selection(self):
        tipoff = (datetime.now(timezone.utc) - timedelta(minutes=20)).isoformat()
        games = [dict(self.game, gameId=f"game{index}", gameStatus=1, gameTimeUTC=tipoff)
                 for index in range(2)]
        board = {"scoreboard": {"games": games}}
        with patch.object(app, "_fetch_live_json", return_value=board), \
                patch.object(app.threading, "Thread") as thread, \
                patch.object(app, "_fetch_game_page") as page:
            first = app.build_scoreboard_state()
            self.assertEqual([g["statusKey"] for g in first["games"]], ["scheduled", "scheduled"])
            self.assertEqual(thread.call_count, 2)
            page.assert_not_called()
            page.side_effect = lambda game_id: {"game": dict(self.game, gameId=game_id)}
            for call in thread.call_args_list:
                call.kwargs["target"](*call.kwargs["args"])
            games[0]["homeTeam"] = {**games[0]["homeTeam"], "teamCity": "Fresh City", "wins": 3}
            refreshed = app.build_scoreboard_state()
            self.assertEqual([g["statusKey"] for g in refreshed["games"]], ["live", "live"])
            self.assertTrue(refreshed["hasLiveGames"])
            self.assertEqual(refreshed["games"][0]["home"]["city"], "Fresh City")
            self.assertEqual(refreshed["games"][0]["home"]["wins"], 3)
            self.assertEqual(thread.call_count, 2)

    def test_status_checks_skip_future_games_and_historical_scoreboards(self):
        future = dict(self.game, gameStatus=1, gameTimeUTC="2099-01-01T00:00:00Z")
        past = dict(self.game, gameStatus=1, gameTimeUTC="2000-01-01T00:00:00Z")
        with patch.object(app.threading, "Thread") as thread:
            self.assertEqual(app._reconcile_scoreboard_games([future], "2099-01-01", True), [future])
            self.assertEqual(app._reconcile_scoreboard_games([past], "2000-01-01", False), [past])
            thread.assert_not_called()

    def test_status_checks_are_bounded_and_cool_down(self):
        games = [dict(self.game, gameId=f"game{index}", gameStatus=1,
                      gameTimeUTC="2000-01-01T00:00:00Z") for index in range(6)]
        with patch.object(app.threading, "Thread") as thread, \
                patch.object(app, "_fetch_game_page", return_value={"game": {"gameStatus": 1}}):
            app._reconcile_scoreboard_games(games, app._local_today_iso(), True)
            self.assertEqual(thread.call_count, app.SCHEDULE_STATUS_MAX_PENDING)
            app._reconcile_scoreboard_games(games, app._local_today_iso(), True)
            self.assertEqual(thread.call_count, app.SCHEDULE_STATUS_MAX_PENDING)
            for call in list(thread.call_args_list):
                call.kwargs["target"](*call.kwargs["args"])
            app._reconcile_scoreboard_games(games, app._local_today_iso(), True)
            self.assertEqual(thread.call_count, 6)

    def test_failed_check_keeps_known_live_status_and_does_not_retry_each_poll(self):
        game = dict(self.game, gameStatus=1, gameTimeUTC="2000-01-01T00:00:00Z")
        app.SCHEDULE_STATUS_CACHE[self.game_id] = {"checked": 0, "game": self.game}
        with patch.object(app, "_fetch_game_page", side_effect=requests.Timeout("offline")) as page:
            with self.assertLogs(app.LOG, level="WARNING"):
                app._refresh_scheduled_game(game, app._local_today_iso(), True)
            with patch.object(app.threading, "Thread") as thread:
                result = app._reconcile_scoreboard_games([game], app._local_today_iso(), True)
                self.assertEqual(result[0]["gameStatus"], 2)
                thread.assert_not_called()
            page.assert_called_once()

    @patch.object(app.requests, "get")
    def test_concurrent_game_page_consumers_share_one_request(self, get):
        entered = threading.Event()
        release = threading.Event()
        results = []
        errors = []

        def fetch(*args, **kwargs):
            entered.set()
            if not release.wait(2):
                raise RuntimeError("Timed out waiting for the second consumer")
            return response(self.page())

        def consume():
            try:
                results.append(app._fetch_game_page(self.game_id))
            except Exception as exc:
                errors.append(exc)

        get.side_effect = fetch
        first = threading.Thread(target=consume)
        second = threading.Thread(target=consume)
        first.start()
        try:
            self.assertTrue(entered.wait(1))
            second.start()
        finally:
            release.set()
            first.join(2)
            if second.ident is not None:
                second.join(2)
        self.assertEqual(errors, [])
        self.assertEqual(len(results), 2)
        get.assert_called_once()

    def test_local_server_serves_requests_while_a_browser_preconnect_is_idle(self):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                payload = b"ready"
                self.send_response(200)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args):
                pass

        server = app.ScoreboardHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        worker.start()
        idle = socket.create_connection(server.server_address, timeout=1)
        try:
            loaded = requests.get(f"http://127.0.0.1:{server.server_port}/app.js", timeout=1)
            self.assertEqual(loaded.status_code, 200)
            self.assertEqual(loaded.text, "ready")
        finally:
            idle.close()
            server.shutdown()
            server.server_close()
            worker.join(1)


if __name__ == "__main__":
    unittest.main()
