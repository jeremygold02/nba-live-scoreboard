import importlib.util
import json
from pathlib import Path
import unittest
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
                      app.PBP_CACHE, app.PBP_BACKOFF, app.REQUEST_HEALTH):
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

    @patch.object(app.requests, "get")
    def test_blocked_scoreboard_uses_stats_and_recovers_health(self, get):
        get.side_effect = [response("Access Denied", 403), response(self.board)]
        state = app.build_scoreboard_state()
        self.assertEqual(state["status"], "ok")
        self.assertEqual(state["games"][0]["gameId"], self.game_id)
        self.assertEqual(state["games"][0]["clock"], "PT04M30.00S")
        self.assertTrue(state["hasLiveGames"])
        self.assertEqual(get.call_args.args[0], app.STATS_DATA_BASE_URL + "/scoreboardv3")
        self.assertEqual(get.call_args.kwargs["params"]["GameDate"], state["scoreboardDate"])
        self.assertEqual(app.REQUEST_HEALTH["scoreboard"]["failureStreak"], 0)

    @patch.object(app.requests, "get")
    def test_working_live_feed_does_not_call_fallback(self, get):
        get.return_value = response(self.board)
        self.assertEqual(app.build_scoreboard_state()["status"], "ok")
        get.assert_called_once()
        self.assertTrue(get.call_args.args[0].startswith(app.LIVE_DATA_BASE_URL))

    @patch.object(app.requests, "get")
    def test_both_feeds_failing_keeps_an_explicit_error(self, get):
        get.side_effect = [response("Blocked", 403), response("Unavailable", 503)]
        with self.assertLogs(app.LOG, level="ERROR"):
            state = app.build_scoreboard_state()
        self.assertEqual(state["status"], "error")
        self.assertIn("503", state["error"])
        self.assertEqual(state["games"], [])

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
        get.side_effect = [response("Blocked", 403), response(self.board),
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


if __name__ == "__main__":
    unittest.main()
