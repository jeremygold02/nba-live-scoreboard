"""Headless UI regressions; skipped when Playwright or Chromium is unavailable."""

import functools
import http.server
import importlib.util
import json
from pathlib import Path
import threading
import unittest


UI_DIR = Path(__file__).resolve().parents[1] / "ui"
HAS_PLAYWRIGHT = importlib.util.find_spec("playwright") is not None


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


class TestServer(http.server.ThreadingHTTPServer):
    request_queue_size = 32


@unittest.skipUnless(HAS_PLAYWRIGHT, "Python Playwright is not installed")
class ScoreboardUIRegressionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from playwright.sync_api import Error, sync_playwright

        cls.playwright = sync_playwright().start()
        try:
            cls.browser = cls.playwright.chromium.launch(headless=True)
        except Error as exc:
            cls.playwright.stop()
            if "Executable doesn't exist" in str(exc):
                raise unittest.SkipTest("Playwright Chromium is not installed") from exc
            raise
        handler = functools.partial(QuietHandler, directory=str(UI_DIR))
        cls.server = TestServer(("127.0.0.1", 0), handler)
        cls.server_thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.server_thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.server_thread.join()
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.context = self.browser.new_context(viewport={"width": 1440, "height": 900})
        self.addCleanup(self.context.close)
        self.page = self.context.new_page()
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        away = {"id": 1610612753, "tricode": "ORL", "city": "Orlando", "name": "Magic", "score": 48}
        home = {"id": 1610612761, "tricode": "TOR", "city": "Toronto", "name": "Raptors", "score": 52}
        game = {
            "gameId": "fixture-1", "statusKey": "live", "statusText": "2nd Quarter",
            "period": 2, "clock": "PT06M46.00S", "away": away, "home": home,
        }
        player = {
            "personId": "1", "name": "Test Player", "position": "G", "jerseyNum": "1",
            "minutes": "PT12M00.00S", "status": "ACTIVE", "points": 8, "rebounds": 3,
            "assists": 2, "steals": 1, "blocks": 0, "turnovers": 1, "fouls": 1,
            "fgm": 3, "fga": 7, "tpm": 1, "tpa": 3, "ftm": 1, "fta": 1,
            "tsPct": 50, "efgPct": 50, "plusMinus": 1,
        }
        board = {"status": "ok", "games": [game], "hasLiveGames": True}
        detail = {
            "status": "ok", "game": game, "games": [game], "periods": [],
            "away": {**away, "players": [player], "stats": {}},
            "home": {**home, "players": [player], "stats": {}},
            "recentPlays": {"plays": []},
        }
        bridge = """
            window.fixture = {board: BOARD, detail: DETAIL, fail: false, favorites: [], delay: 0, dates: []};
            window.__TAURI__ = {core: {invoke: async (command, args = {}) => {
                switch (command) {
                    case 'get_state': return window.fixture.details?.[args.gameId] || window.fixture.detail;
                    case 'get_scoreboard':
                        window.fixture.dates.push(args.scoreboardDate);
                        if (window.fixture.delay) await new Promise(resolve => setTimeout(resolve, window.fixture.delay));
                        if (window.fixture.fail) throw new Error('simulated outage');
                        return {...window.fixture.board, scoreboardDate: args.scoreboardDate};
                    case 'get_favorites': return window.fixture.favorites;
                    case 'set_favorites': window.fixture.favorites = args.favorites; return null;
                    case 'get_preferences': return {};
                    case 'set_preferences': return null;
                    default: throw new Error('Unexpected Tauri command: ' + command);
                }
            }}};
        """.replace("BOARD", json.dumps(board)).replace("DETAIL", json.dumps(detail))
        self.page.add_init_script(bridge)
        self.page.goto(f"http://127.0.0.1:{self.server.server_port}/index.html", wait_until="networkidle")
        self.page.wait_for_selector(".game-item")

    def tearDown(self):
        self.assertEqual(self.errors, [], "uncaught browser errors")

    def test_scheduled_countdown_ticks_and_updated_shows_local_clock_time(self):
        page = self.page
        page.evaluate("""() => {
            window.clockNow = Date.now();
            Date.now = () => window.clockNow;
            Object.assign(window.fixture.detail.game, {
                statusKey: 'scheduled', statusText: '8:00 pm ET', period: 0,
                startTimeUTC: new Date(window.clockNow + 3661000).toISOString(),
            });
            window.fixture.detail.status = 'scheduled';
            window.fixture.detail.dataUpdated = new Date(window.clockNow - 123000).toISOString();
        }""")
        page.locator(".game-item__select").click()
        page.wait_for_function("document.querySelector('#status').textContent === 'Tip-off in 1:01:01'")
        expected = page.evaluate("""() => 'Updated ' + new Date(window.fixture.detail.dataUpdated)
            .toLocaleTimeString([], {hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true})""")
        self.assertEqual(page.locator("#updated").inner_text(), expected)
        page.evaluate("window.clockNow += 61000")
        page.wait_for_function("document.querySelector('#status').textContent === 'Tip-off in 1:00:00'")
        self.assertEqual(page.locator("#updated").inner_text(), expected)
        page.evaluate("window.clockNow += 3600000")
        page.wait_for_function("document.querySelector('#status').textContent === 'Tip-off expected shortly'")

    def test_halftime_countdown_when_watching_reopening_and_resuming(self):
        page = self.page
        page.evaluate("""() => { window.clockNow = Date.now(); Date.now = () => window.clockNow; }""")
        page.locator(".game-item__select").click()
        page.wait_for_selector("#home-table .stats-table")
        page.evaluate("""() => {
            Object.assign(window.fixture.detail.game, {
                statusText: 'Halftime', clock: 'PT00M00.00S',
                halftimeStartedAt: new Date(window.clockNow - 300000).toISOString(),
            });
        }""")
        page.locator("#refresh-now").click()
        page.wait_for_function("document.querySelector('#status').textContent === 'Second half begins in ~10:00'")
        page.locator("#back-to-list").click()
        page.locator(".game-item__select").click()
        page.wait_for_function("document.querySelector('#status').textContent === 'Second half begins in ~10:00'")
        page.evaluate("window.clockNow += 599000")
        page.wait_for_function("document.querySelector('#status').textContent === 'Second half begins in ~0:01'")
        page.evaluate("window.clockNow += 1000")
        page.wait_for_function("document.querySelector('#status').textContent === 'Second half will begin shortly'")
        page.evaluate("window.fixture.detail.game.statusText = '3rd Quarter'")
        page.locator("#refresh-now").click()
        page.wait_for_function("document.querySelector('#status').textContent === '3rd Quarter'")

    def test_missing_halftime_time_and_postponed_game_keep_their_status(self):
        page = self.page
        page.evaluate("window.fixture.detail.game.statusText = 'Half'")
        page.locator(".game-item__select").click()
        page.wait_for_function("document.querySelector('#status').textContent === 'Half'")
        page.evaluate("""() => {
            Object.assign(window.fixture.detail.game, {
                statusKey: 'scheduled', statusText: 'Postponed',
                startTimeUTC: new Date(Date.now() + 3600000).toISOString(),
            });
            window.fixture.detail.status = 'scheduled';
        }""")
        page.locator("#refresh-now").click()
        page.wait_for_function("document.querySelector('#status').textContent === 'Postponed'")

    def test_favorite_keyboard_focus_survives_regrouping(self):
        page = self.page
        page.locator(".team-fav--away").focus()
        page.keyboard.press("Space")
        favorite = page.locator(".team-fav--away")
        self.assertEqual(favorite.get_attribute("aria-pressed"), "true")
        self.assertTrue(favorite.evaluate("element => element === document.activeElement"))

        page.locator('[data-filter="favorites"]').click()
        favorite.focus()
        page.keyboard.press("Space")
        self.assertEqual(page.locator(".game-item").count(), 0)
        self.assertTrue(page.locator('[data-filter="favorites"]').evaluate(
            "element => element === document.activeElement"
        ))

    def test_keyboard_focus_moves_to_game_and_back_to_selected_row(self):
        page = self.page
        page.locator(".game-item__select").focus()
        page.keyboard.press("Enter")
        page.wait_for_selector("#game-view:not([hidden])")
        self.assertEqual(page.evaluate("document.activeElement.id"), "back-to-list")
        page.keyboard.press("Escape")
        self.assertTrue(page.locator(".game-item__select").evaluate(
            "element => element === document.activeElement"
        ))

    def test_reopening_same_game_restores_player_tables_without_false_flash(self):
        page = self.page
        page.locator(".game-item__select").click()
        page.wait_for_selector("#home-table .stats-table")
        page.locator("#back-to-list").click()
        page.locator(".game-item__select").click()
        page.wait_for_selector("#home-table .stats-table", timeout=5000)
        self.assertEqual(page.locator("#home-table tbody tr").count(), 1)
        self.assertEqual(page.locator(".stat-bump").count(), 0)

    def test_same_team_in_different_game_does_not_flash_initial_stats(self):
        page = self.page
        page.evaluate("""() => {
            const secondGame = structuredClone(window.fixture.board.games[0]);
            secondGame.gameId = 'fixture-2';
            window.fixture.board.games.push(secondGame);
            const secondDetail = structuredClone(window.fixture.detail);
            secondDetail.game = secondGame;
            secondDetail.games = window.fixture.board.games;
            secondDetail.home.players[0].points = 15;
            secondDetail.home.score = 60;
            window.fixture.details = {'fixture-2': secondDetail};
        }""")
        page.locator("#refresh-now").click()
        page.wait_for_function("document.querySelectorAll('.game-item').length === 2")
        page.locator("#scoreboard-toggle").click()
        page.locator(".game-item__select").first.click()
        page.wait_for_selector("#home-table .stats-table")
        page.locator("#back-to-list").click()
        page.locator(".game-item__select").nth(1).click()
        page.wait_for_function("document.querySelector('#home-table tbody tr td:nth-child(3)')?.textContent === '15'")
        self.assertEqual(page.locator(".stat-bump, .score-bump").count(), 0)

    def test_scoreboard_exception_is_visible_and_clears_on_recovery(self):
        page = self.page
        page.evaluate("window.fixture.fail = true")
        page.locator("#refresh-now").click()
        page.wait_for_selector("#game-list-error:not([hidden])")
        self.assertIn("simulated outage", page.locator("#game-list-error").inner_text())
        self.assertEqual(page.locator(".game-item").count(), 1)
        page.evaluate("window.fixture.fail = false")
        page.locator("#refresh-now").click()
        page.wait_for_selector("#game-list-error[hidden]", state="attached")
        self.assertTrue(page.locator("#game-list-error").is_hidden())
        self.assertEqual(page.locator(".game-item").count(), 1)

    def test_unchanged_refresh_preserves_list_and_feed_nodes(self):
        page = self.page
        page.evaluate("window.fixture.detail.recentPlays.plays = [{description:'Example play', period:2}]")
        page.locator(".game-item__select").click()
        page.wait_for_selector(".last-play__item")
        page.evaluate("""() => {
            window.listNode = document.querySelector('.game-item');
            window.feedNode = document.querySelector('.last-play__item');
        }""")
        page.locator("#refresh-now").click()
        page.wait_for_function("!document.querySelector('#refresh-now').disabled")
        self.assertTrue(page.evaluate("window.listNode === document.querySelector('.game-item')"))
        self.assertTrue(page.evaluate("window.feedNode === document.querySelector('.last-play__item')"))

    def test_play_scores_hide_missing_values_but_display_real_zero(self):
        page = self.page
        page.evaluate("""() => { window.fixture.detail.recentPlays.plays = [
            {description: 'Unknown score', scoreHome: null, scoreAway: null},
            {description: 'Blank score', scoreHome: '', scoreAway: ''},
            {description: 'Opening score', scoreHome: 0, scoreAway: 0}
        ]; }""")
        page.locator(".game-item__select").click()
        page.wait_for_selector(".last-play__item")
        rows = page.locator(".last-play__item")
        self.assertEqual(rows.count(), 3)
        self.assertEqual(rows.nth(0).locator(".last-play__chip--score").count(), 0)
        self.assertEqual(rows.nth(1).locator(".last-play__chip--score").count(), 0)
        self.assertEqual(rows.nth(2).locator(".last-play__score-value").all_text_contents(), ["0", "0"])

    def test_game_tables_recover_after_detail_error(self):
        page = self.page
        page.locator(".game-item__select").click()
        page.wait_for_selector("#home-table .stats-table")
        page.evaluate("window.fixture.detail.status = 'error'")
        page.locator("#refresh-now").click()
        page.wait_for_function("document.querySelector('#status').textContent === 'error'")
        self.assertEqual(page.locator("#home-table .stats-table").count(), 0)
        page.evaluate("window.fixture.detail.status = 'ok'")
        page.locator("#refresh-now").click()
        page.wait_for_selector("#home-table .stats-table", timeout=5000)
        self.assertEqual(page.locator("#home-table tbody tr").count(), 1)

    def test_date_change_during_refresh_uses_latest_date(self):
        page = self.page
        page.evaluate("window.fixture.delay = 400")
        page.locator("#refresh-now").click()
        page.locator("#scoreboard-date-next").click()
        desired = page.locator("#scoreboard-date").input_value()
        page.wait_for_function("date => window.fixture.dates.includes(date)", arg=desired)
        page.wait_for_timeout(500)
        self.assertEqual(page.locator("#scoreboard-date").input_value(), desired)

    def test_stat_flash_clears_without_hover_and_ignores_unchanged_values(self):
        page = self.page
        page.locator(".game-item__select").click()
        page.wait_for_selector("#home-table .stats-table")
        page.evaluate("window.fixture.detail.home.players[0].points = 9")
        page.locator("#refresh-now").click()
        page.wait_for_selector("#home-table td.stat-bump")
        self.assertEqual(page.locator("#home-table td.stat-bump").count(), 1)
        self.assertEqual(page.locator("#home-table td.stat-bump").inner_text(), "9")
        page.wait_for_function("document.querySelectorAll('.stat-bump').length === 0")
        self.assertEqual(page.locator(".stat-bump").count(), 0)
        self.assertEqual(page.locator(".row-highlight, .col-highlight").count(), 0)

    def test_stat_flash_disabled_and_focus_loss_cleanup(self):
        page = self.page
        page.locator(".game-item__select").click()
        page.wait_for_selector("#home-table .stats-table")
        page.evaluate("window.fixture.detail.home.players[0].points = 9")
        page.locator("#refresh-now").click()
        page.wait_for_selector("#home-table td.stat-bump")
        page.evaluate("window.dispatchEvent(new Event('blur'))")
        self.assertEqual(page.locator(".stat-bump").count(), 0)
        page.evaluate("window.dispatchEvent(new Event('focus'))")
        page.locator("#stat-flash-toggle").click()
        page.evaluate("window.fixture.detail.home.players[0].points = 10")
        page.locator("#refresh-now").click()
        page.wait_for_function("document.querySelector('#home-table tbody tr td:nth-child(3)').textContent === '10'")
        self.assertEqual(page.locator(".stat-bump").count(), 0)

    def test_stat_flash_clears_when_animation_is_cancelled(self):
        page = self.page
        page.locator(".game-item__select").click()
        page.wait_for_selector("#home-table .stats-table")
        page.evaluate("window.fixture.detail.home.players[0].points = 9")
        page.locator("#refresh-now").click()
        page.wait_for_selector("#home-table td.stat-bump")
        page.locator("#home-table td.stat-bump").evaluate("element => element.style.animation = 'none'")
        page.wait_for_function("document.querySelectorAll('.stat-bump').length === 0")
        self.assertEqual(page.locator(".stat-bump").count(), 0)

    def test_stat_flash_timer_cleans_up_without_animation_events(self):
        page = self.page
        page.locator(".game-item__select").click()
        page.wait_for_selector("#home-table .stats-table")
        page.add_style_tag(content=".stats-table td.stat-bump { animation: none !important; }")
        page.evaluate("window.fixture.detail.home.players[0].points = 9")
        page.locator("#refresh-now").click()
        page.wait_for_selector("#home-table td.stat-bump")
        page.wait_for_timeout(100)
        self.assertEqual(page.locator("#home-table td.stat-bump").count(), 1)
        page.wait_for_function("document.querySelectorAll('.stat-bump').length === 0")

    def test_score_animation_clears_without_hover(self):
        page = self.page
        page.locator("#scoreboard-toggle").click()
        page.locator(".game-item__select").click()
        page.wait_for_selector("#home-table .stats-table")
        page.evaluate("window.fixture.detail.home.score = 55")
        page.locator("#refresh-now").click()
        page.wait_for_selector("#home-card .score-bump")
        self.assertEqual(page.locator("#home-card .team-score").inner_text(), "55")
        page.wait_for_function("document.querySelectorAll('.score-bump').length === 0")

    def test_stat_update_while_hidden_does_not_leave_a_flash(self):
        page = self.page
        page.locator(".game-item__select").click()
        page.wait_for_selector("#home-table .stats-table")
        page.evaluate("""() => {
            Object.defineProperty(document, 'hidden', {configurable:true, value:true});
            document.dispatchEvent(new Event('visibilitychange'));
            window.fixture.detail.home.players[0].points = 9;
            document.querySelector('#refresh-now').click();
        }""")
        page.wait_for_function("document.querySelector('#home-table tbody tr td:nth-child(3)').textContent === '9'")
        self.assertEqual(page.locator(".stat-bump").count(), 0)
        page.evaluate("""() => {
            delete document.hidden;
            document.dispatchEvent(new Event('visibilitychange'));
        }""")
        self.assertEqual(page.locator(".stat-bump").count(), 0)


if __name__ == "__main__":
    unittest.main()
