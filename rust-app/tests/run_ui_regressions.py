"""Run the Rust app's UI regressions against a mocked Tauri bridge.

From the repository root: python rust-app/tests/run_ui_regressions.py
This exercises a headless browser, not the Tauri desktop runtime.
"""

import sys
import unittest

from test_scoreboard_ui import ScoreboardUIRegressionTests


if __name__ == "__main__":
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(ScoreboardUIRegressionTests)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    sys.exit(0 if result.wasSuccessful() and result.testsRun > len(result.skipped) else 1)
