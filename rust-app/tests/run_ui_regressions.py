"""Run the original UI regressions against the Rust app's mocked Tauri bridge.

From the repository root: python rust-app/tests/run_ui_regressions.py
This exercises a headless browser, not the Tauri desktop runtime.
"""

import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

try:
    from playwright.sync_api import Page
except ImportError:
    sys.exit("Python Playwright is required to run the UI regression tests.")


APP_ROOT = Path(__file__).resolve().parents[1]
PROJECT_ROOT = APP_ROOT.parent
TEST_FILE = PROJECT_ROOT / "tests" / "test_scoreboard_ui.py"

TAURI_BRIDGE = """
window.__TAURI__ = {core: {invoke: (command, args = {}) => {
  const api = window.pywebview.api;
  switch (command) {
    case "get_state": return api.get_state(args.gameId, args.viewMode, args.scoreboardDate);
    case "get_scoreboard": return api.get_scoreboard(args.selectedGameId, args.viewMode, args.scoreboardDate);
    case "get_favorites": return api.get_favorites();
    case "set_favorites": return api.set_favorites(args.favorites);
    case "get_preferences": return api.get_preferences();
    case "set_preferences": return api.set_preferences(args.preferences);
    default: throw new Error("Unexpected Tauri command: " + command);
  }
}}};
"""


def main():
    spec = importlib.util.spec_from_file_location("rust_ui_regressions", TEST_FILE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.UI_DIR = APP_ROOT / "ui"

    original_add_init_script = Page.add_init_script

    def add_tauri_bridge(page, script=None, path=None):
        if script and "window.pywebview = {api:" in script:
            script += TAURI_BRIDGE
        return original_add_init_script(page, script=script, path=path)

    suite = unittest.defaultTestLoader.loadTestsFromTestCase(module.ScoreboardUIRegressionTests)
    with patch.object(Page, "add_init_script", add_tauri_bridge):
        result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() and result.testsRun > len(result.skipped) else 1


if __name__ == "__main__":
    sys.exit(main())
