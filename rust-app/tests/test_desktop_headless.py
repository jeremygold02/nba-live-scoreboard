"""Exercise the real Tauri app without switching to the user's desktop.

Run on Windows with Python Playwright, Chromium, and psutil installed:
    python rust-app/tests/test_desktop_headless.py [--exe PATH]

The selected EXE must support NBA_SCOREBOARD_DATA_DIR. All application settings
and WebView2 data are isolated under a new temporary directory in the build
target directory. The test uses real NBA feeds and can fail if they are down.
"""

import argparse
import copy
import ctypes
from ctypes import wintypes
from datetime import date, timedelta
import json
import os
from pathlib import Path
import shutil
import socket
import tempfile
import time
import urllib.request
import uuid

import psutil
from playwright.sync_api import sync_playwright


PROJECT = Path(__file__).resolve().parents[2]
APP_ROOT = PROJECT / "rust-app"
DEFAULT_EXE = APP_ROOT / "src-tauri/target/debug/nba-live-scoreboard-rust.exe"


class StartupInfo(ctypes.Structure):
    _fields_ = [
        ("cb", wintypes.DWORD), ("lpReserved", wintypes.LPWSTR),
        ("lpDesktop", wintypes.LPWSTR), ("lpTitle", wintypes.LPWSTR),
        ("dwX", wintypes.DWORD), ("dwY", wintypes.DWORD),
        ("dwXSize", wintypes.DWORD), ("dwYSize", wintypes.DWORD),
        ("dwXCountChars", wintypes.DWORD), ("dwYCountChars", wintypes.DWORD),
        ("dwFillAttribute", wintypes.DWORD), ("dwFlags", wintypes.DWORD),
        ("wShowWindow", wintypes.WORD), ("cbReserved2", wintypes.WORD),
        ("lpReserved2", ctypes.POINTER(ctypes.c_byte)),
        ("hStdInput", wintypes.HANDLE), ("hStdOutput", wintypes.HANDLE),
        ("hStdError", wintypes.HANDLE),
    ]


class ProcessInformation(ctypes.Structure):
    _fields_ = [
        ("hProcess", wintypes.HANDLE), ("hThread", wintypes.HANDLE),
        ("dwProcessId", wintypes.DWORD), ("dwThreadId", wintypes.DWORD),
    ]


user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
user32.CreateDesktopW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.LPVOID,
                                 wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID]
user32.CreateDesktopW.restype = wintypes.HANDLE
user32.CloseDesktop.argtypes = [wintypes.HANDLE]
user32.CloseDesktop.restype = wintypes.BOOL
WindowEnumProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
user32.EnumDesktopWindows.argtypes = [wintypes.HANDLE, WindowEnumProc, wintypes.LPARAM]
user32.EnumDesktopWindows.restype = wintypes.BOOL
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user32.GetWindowThreadProcessId.restype = wintypes.DWORD
user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
user32.GetWindowTextW.restype = ctypes.c_int
user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
user32.ShowWindow.restype = wintypes.BOOL
user32.IsIconic.argtypes = [wintypes.HWND]
user32.IsIconic.restype = wintypes.BOOL
kernel32.CreateProcessW.argtypes = [
    wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.LPVOID, wintypes.LPVOID,
    wintypes.BOOL, wintypes.DWORD, wintypes.LPVOID, wintypes.LPCWSTR,
    ctypes.POINTER(StartupInfo), ctypes.POINTER(ProcessInformation),
]
kernel32.CreateProcessW.restype = wintypes.BOOL
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
kernel32.CloseHandle.restype = wintypes.BOOL


def free_port():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def owned_processes(root_pid, profile):
    processes = {}
    try:
        root = psutil.Process(root_pid)
        for process in [root] + root.children(recursive=True):
            processes[process.pid] = process
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        pass
    profile_name = str(profile).lower()
    for process in psutil.process_iter(["pid", "name", "cmdline"]):
        try:
            if (process.info["name"] or "").lower() != "msedgewebview2.exe":
                continue
            if not any(profile_name in arg.lower() for arg in (process.info["cmdline"] or [])):
                continue
            processes[process.pid] = process
            for child in process.children(recursive=True):
                processes[child.pid] = child
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            pass
    return list(processes.values())


class IsolatedDesktopApp:
    def __init__(self, playwright, executable, data_dir, profile):
        self.playwright = playwright
        self.executable = executable
        self.data_dir = data_dir
        self.profile = profile
        self.port = free_port()
        self.desktop = None
        self.pid = None
        self.browser = None
        self.page = None

    def start(self):
        name = "ScoreboardQA_" + uuid.uuid4().hex
        self.desktop = user32.CreateDesktopW(name, None, None, 0, 0x000F01FF, None)
        if not self.desktop:
            raise ctypes.WinError(ctypes.get_last_error())

        environment = os.environ.copy()
        environment["NBA_SCOREBOARD_DATA_DIR"] = str(self.data_dir)
        environment["WEBVIEW2_USER_DATA_FOLDER"] = str(self.profile)
        existing_flags = environment.get("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "")
        environment["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = (
            existing_flags + f" --remote-debugging-port={self.port}"
        ).strip()
        block = "\0".join(
            f"{key}={value}" for key, value in sorted(environment.items(), key=lambda item: item[0].upper())
        ) + "\0\0"
        environment_block = ctypes.create_unicode_buffer(block)
        command_line = ctypes.create_unicode_buffer(f'"{self.executable}"')
        startup = StartupInfo()
        startup.cb = ctypes.sizeof(startup)
        startup.lpDesktop = name
        startup.dwFlags = 1  # STARTF_USESHOWWINDOW
        startup.wShowWindow = 5  # Shown only on the separate, never-switched desktop.
        info = ProcessInformation()
        # Inherit no desktop handles; lpDesktop always selects this private desktop.
        created = kernel32.CreateProcessW(
            str(self.executable), command_line, None, None, False, 0x400,
            ctypes.cast(environment_block, wintypes.LPVOID), str(PROJECT),
            ctypes.byref(startup), ctypes.byref(info),
        )
        if not created:
            raise ctypes.WinError(ctypes.get_last_error())
        self.pid = info.dwProcessId
        kernel32.CloseHandle(info.hThread)
        kernel32.CloseHandle(info.hProcess)

        deadline = time.monotonic() + 90
        last_error = ""
        while time.monotonic() < deadline:
            if not psutil.pid_exists(self.pid):
                raise RuntimeError("Desktop app exited before its UI was ready")
            try:
                if not any(p.name().lower() == "msedgewebview2.exe" for p in owned_processes(self.pid, self.profile)):
                    time.sleep(1)
                    continue
                with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/json/version", timeout=1) as response:
                    json.load(response)
                if self.browser is None:
                    self.browser = self.playwright.chromium.connect_over_cdp(
                        f"http://127.0.0.1:{self.port}", timeout=3000
                    )
                for context in self.browser.contexts:
                    for page in context.pages:
                        if "NBA Live Scoreboard" in page.title():
                            self.page = page
                            page.wait_for_function(
                                "document.querySelectorAll('.game-item').length > 0", timeout=60000
                            )
                            return page
            except Exception as error:
                last_error = str(error)
            time.sleep(1)
        raise RuntimeError(f"Could not load the scoreboard on the isolated desktop: {last_error[:300]}")

    def stop(self):
        if self.pid is not None:
            processes = owned_processes(self.pid, self.profile)
            if self.browser is not None:
                try:
                    self.browser.close()
                except Exception:
                    pass
            processes += owned_processes(self.pid, self.profile)
            processes = list({process.pid: process for process in processes}.values())
            for process in processes:
                try:
                    if process.is_running():
                        process.terminate()
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass
            _, alive = psutil.wait_procs(processes, timeout=5)
            for process in alive:
                try:
                    if process.is_running():
                        process.kill()
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass
            psutil.wait_procs(alive, timeout=5)
        if self.desktop:
            user32.CloseDesktop(self.desktop)
            self.desktop = None

    def app_window(self):
        windows = []

        @WindowEnumProc
        def inspect(window, _parameter):
            owner_pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(window, ctypes.byref(owner_pid))
            if owner_pid.value == self.pid:
                title = ctypes.create_unicode_buffer(512)
                user32.GetWindowTextW(window, title, len(title))
                if "NBA Live Scoreboard" in title.value:
                    windows.append(window)
            return True

        if not user32.EnumDesktopWindows(self.desktop, inspect, 0):
            raise ctypes.WinError(ctypes.get_last_error())
        if len(windows) != 1:
            raise AssertionError(f"Expected one isolated app window, found {len(windows)}")
        return windows[0]


def invoke(page, command, args=None):
    return page.evaluate(
        "async ({command, args}) => window.__TAURI__.core.invoke(command, args)",
        {"command": command, "args": args or {}},
    )


def wait_until(predicate, description, timeout=15):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.2)
    raise AssertionError(f"Timed out waiting for {description}")


def completed_game(page):
    today = date.fromisoformat(page.locator("#scoreboard-date").input_value())
    for days_ago in range(1, 8):
        game_date = (today - timedelta(days=days_ago)).isoformat()
        state = invoke(page, "get_scoreboard", {
            "selectedGameId": None, "viewMode": "full", "scoreboardDate": game_date,
        })
        for game in state.get("games", []):
            if game.get("statusKey") == "final":
                return game_date, game, state
    raise AssertionError("No completed NBA game found in the last seven days")


def click_dom(locator):
    locator.evaluate("element => element.click()")


def check_simulated_live_update(page, game, board, detail):
    # Adapt a real backend response; intercept only this WebView's bridge module.
    # Settings calls continue through the real Tauri bridge.
    bridge_path = APP_ROOT / "ui/js/backend-api.js"
    bridge = bridge_path.read_text(encoding="utf-8")
    scoreboard_entry = "export async function fetchScoreboardState({ selectedGameId, view, scoreboardDate }) {"
    detail_entry = "export async function fetchDetailState({ selectedGameId, view, scoreboardDate }) {"
    if bridge.count(scoreboard_entry) != 1 or bridge.count(detail_entry) != 1:
        raise AssertionError("Desktop bridge format changed; update the simulation wrapper")
    bridge = bridge.replace(scoreboard_entry, scoreboard_entry + """
      if (window.__desktopQaSimulation) {
        const fixture = window.__desktopQaSimulation;
        return structuredClone(fixture.boards[fixture.stage]);
      }
    """, 1)
    bridge = bridge.replace(detail_entry, detail_entry + """
      if (window.__desktopQaSimulation) {
        const fixture = window.__desktopQaSimulation;
        return structuredClone(fixture.details[fixture.stage]);
      }
    """, 1)
    bridge += "\nwindow.__desktopQaBridgeIntercepted = true;\n"
    page.route("**/js/backend-api.js", lambda route: route.fulfill(
        status=200, content_type="text/javascript", body=bridge,
    ))
    page.reload(wait_until="domcontentloaded")
    page.wait_for_function("window.__desktopQaBridgeIntercepted === true", timeout=30000)
    page.wait_for_selector(".game-item", timeout=60000)
    today = page.locator("#scoreboard-date").input_value()

    first_game = copy.deepcopy(game)
    first_game.update({"statusKey": "live", "status": "Live", "statusText": "3rd Quarter",
                       "period": 3, "clock": "PT06M45.00S"})
    first_board = copy.deepcopy(board)
    first_board.update({"games": [first_game], "scoreboardDate": today, "isToday": True,
                        "hasLiveGames": True, "polling": {"refreshMs": 12000, "mode": "live"}})
    first_detail = copy.deepcopy(detail)
    first_detail.update({"games": [first_game], "scoreboardDate": today, "isToday": True,
                         "dataStatus": None, "polling": {"refreshMs": 8000, "mode": "live"}})
    first_detail["game"].update({"statusKey": "live", "status": "Live", "statusText": "3rd Quarter",
                                 "period": 3, "clock": "PT06M45.00S"})
    if not first_detail.get("recentPlays", {}).get("plays") or not first_detail["home"]["players"]:
        raise AssertionError("Real backend fixture did not contain a player and a play")

    next_board = copy.deepcopy(first_board)
    next_detail = copy.deepcopy(first_detail)
    next_score = int(first_detail["home"]["score"]) + 2
    next_points = int(first_detail["home"]["players"][0]["points"]) + 2
    next_board["games"][0]["home"]["score"] = next_score
    next_detail["games"][0]["home"]["score"] = next_score
    next_detail["home"]["score"] = next_score
    next_detail["home"]["players"][0]["points"] = next_points
    next_detail["game"]["clock"] = "PT06M30.00S"
    new_play = copy.deepcopy(next_detail["recentPlays"]["plays"][0])
    new_play["description"] = "Simulated scoring update for desktop validation"
    new_play["actionNumber"] = 9999999
    new_play["sourceActionNumbers"] = [9999999]
    next_detail["recentPlays"]["plays"].insert(0, new_play)

    page.evaluate("fixture => { window.__desktopQaSimulation = fixture; }", {
        "stage": 0, "boards": [first_board, next_board], "details": [first_detail, next_detail],
    })
    click_dom(page.locator("#refresh-now"))
    game_id = game["gameId"]
    page.wait_for_function(
        "gameId => [...document.querySelectorAll('.game-item')].some(row => row.dataset.gameId === gameId)",
        arg=game_id, timeout=30000,
    )
    click_dom(page.locator(f'.game-item[data-game-id="{game_id}"] .game-item__select'))
    page.wait_for_selector("#home-table .stats-table", timeout=30000)
    assert page.locator("#home-card .team-score").inner_text() == str(first_detail["home"]["score"])
    page.evaluate("window.__desktopQaSimulation.stage = 1")
    click_dom(page.locator("#refresh-now"))
    page.wait_for_function("""expected =>
      document.querySelector('#home-card .team-score')?.textContent === String(expected.score)
      && document.querySelector('#home-table tbody tr td:nth-child(3)')?.textContent === String(expected.points)
      && document.querySelector('#last-play .last-play__description')?.textContent.includes('Simulated scoring update')
    """, arg={"score": next_score, "points": next_points}, timeout=30000)
    print("PASS: simulated live score, player stat, and play updates rendered in the Tauri WebView", flush=True)


def check_minimized_refresh(app, page):
    click_dom(page.locator("#refresh-now"))
    page.wait_for_function("!document.querySelector('#refresh-now').disabled", timeout=60000)
    page.evaluate("""() => {
      const label = document.querySelector('#updated');
      window.__desktopQaStarted = performance.now();
      window.__desktopQaResets = [];
      let previous = label.textContent.trim();
      new MutationObserver(() => {
        const elapsed = performance.now() - window.__desktopQaStarted;
        const current = label.textContent.trim();
        if (elapsed > 12000 && current.startsWith('Updated ') && current !== previous) {
          window.__desktopQaResets.push(elapsed);
        }
        previous = current;
      }).observe(label, {childList: true, characterData: true, subtree: true});
    }""")
    window = app.app_window()
    user32.ShowWindow(window, 6)  # SW_MINIMIZE on the isolated desktop only.
    wait_until(lambda: bool(user32.IsIconic(window)), "isolated window to minimize")
    wait_until(
        lambda: page.evaluate("window.__desktopQaResets.length") > 0,
        "automatic scoreboard refresh while minimized", timeout=55,
    )
    user32.ShowWindow(window, 9)  # SW_RESTORE; the desktop is never switched to.
    wait_until(lambda: not user32.IsIconic(window), "isolated window to restore")
    print("PASS: scoreboard polling continued while minimized and the window restored", flush=True)


def run_checks(playwright, executable, data_dir, profile):
    first = IsolatedDesktopApp(playwright, executable, data_dir, profile)
    try:
        page = first.start()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        game_date, game, board = completed_game(page)
        game_id = game["gameId"]
        away_tricode = game["away"]["tricode"]
        page.locator("#scoreboard-date").fill(game_date)
        page.wait_for_function(
            "gameId => [...document.querySelectorAll('.game-item')].some(row => row.dataset.gameId === gameId)",
            arg=game_id, timeout=60000,
        )
        row = page.locator(f'.game-item[data-game-id="{game_id}"]')
        click_dom(row.locator(".team-fav--away"))
        wait_until(lambda: away_tricode in invoke(page, "get_favorites"), "favorite to persist")

        page.locator("#zoom-select").select_option("1.1")
        click_dom(page.locator("#scoreboard-toggle"))  # Default no-spoilers -> full.
        wait_until(
            lambda: (prefs := invoke(page, "get_preferences")).get("zoomLevel") == "1.1"
            and prefs.get("scoreboardView") == "full",
            "view and zoom preferences to persist",
        )
        click_dom(row.locator(".game-item__select"))
        page.wait_for_selector("#game-view:not([hidden])", timeout=30000)
        page.wait_for_selector("#home-table .stats-table", timeout=60000)
        page.wait_for_selector("#away-table .stats-table", timeout=60000)
        page.wait_for_selector("#last-play .last-play__item", timeout=60000)
        assert page.locator("#home-table tbody tr").count() > 0
        assert page.locator("#away-table tbody tr").count() > 0
        assert page.locator("#last-play .last-play__item").count() > 0
        assert not errors, f"Browser errors: {errors}"
        print(f"PASS: real Tauri bridge loaded completed game {game_id}, player tables, and plays", flush=True)
        detail = invoke(page, "get_state", {
            "gameId": game_id, "viewMode": "full", "scoreboardDate": game_date,
        })
        check_simulated_live_update(page, game, board, detail)
        assert not errors, f"Browser errors: {errors}"
    finally:
        first.stop()

    second = IsolatedDesktopApp(playwright, executable, data_dir, profile)
    try:
        page = second.start()
        assert away_tricode in invoke(page, "get_favorites")
        preferences = invoke(page, "get_preferences")
        assert preferences["zoomLevel"] == "1.1"
        assert preferences["scoreboardView"] == "full"
        assert page.locator("#zoom-select").input_value() == "1.1"
        assert "Full" in page.locator("#scoreboard-toggle").inner_text()
        print("PASS: favorite and view/zoom preferences survived restart", flush=True)
        check_minimized_refresh(second, page)
    finally:
        second.stop()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe", type=Path, default=DEFAULT_EXE)
    arguments = parser.parse_args()
    executable = arguments.exe.resolve(strict=True)
    if executable.suffix.lower() != ".exe":
        raise ValueError("Expected a Windows executable")
    base = (APP_ROOT / "src-tauri/target/desktop-integration").resolve()
    base.mkdir(parents=True, exist_ok=True)
    run_dir = Path(tempfile.mkdtemp(prefix="desktop-qa-", dir=base)).resolve()
    if run_dir.parent != base or not run_dir.name.startswith("desktop-qa-"):
        raise RuntimeError("Unsafe temporary directory")
    try:
        with sync_playwright() as playwright:
            run_checks(playwright, executable, run_dir / "app-data", run_dir / "webview-profile")
    finally:
        # Delete only this test's new, verified directory within the build target.
        if run_dir.exists() and run_dir.resolve().parent == base and run_dir.name.startswith("desktop-qa-"):
            shutil.rmtree(run_dir)
        try:
            base.rmdir()
        except OSError:
            pass


if __name__ == "__main__":
    main()
