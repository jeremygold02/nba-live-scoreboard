export function formatSelectedGameLabel(game) {
  const away = game && game.away ? game.away : {};
  const home = game && game.home ? game.home : {};
  return `${away.tricode || ""} @ ${home.tricode || ""}`.trim() || game.matchup || "Selected game";
}

export function fallbackForStatus(status, statusText, getNonTimeStatusText) {
  if (status === "select_game") {
    return "Select a game to view the live box score.";
  }
  if (status === "game_not_found") {
    return "Selected game is no longer on the board. Pick another game.";
  }
  if (status === "no_games") {
    return "No games on the schedule right now.";
  }
  if (status === "scheduled") {
    const special = getNonTimeStatusText(statusText);
    if (special) {
      const lower = special.toLowerCase();
      if (lower.includes("ppd") || lower.includes("postponed")) {
        return "Game postponed. Updates will appear when it is rescheduled.";
      }
      if (lower.includes("delay")) {
        return "Game delayed. Check back soon for updates.";
      }
      if (lower.includes("suspend")) {
        return "Game suspended. Updates will resume when play restarts.";
      }
      return `${special}. Updates will appear when the game resumes.`;
    }
    return "Tipoff hasn't happened yet. Live box score will appear once the game starts.";
  }
  if (status === "postgame") {
    return "Final just ended. Box score will populate shortly.";
  }
  if (status === "live_no_data") {
    return "Live box score loading. Retry in a moment.";
  }
  return "Waiting for game data...";
}

export function createGameViewController({
  awayCard,
  awayHeader,
  awayLineupEl,
  awayTable,
  backBtn,
  centerCard,
  clearDataBanner,
  comparisonBodyEl,
  detailsEl,
  gameViewEl,
  getTeamColor,
  homeCard,
  homeHeader,
  homeLineupEl,
  homeTable,
  lineupsEl,
  listViewEl,
  periodsEl,
  toRgba,
}) {
  function clearMatchupTheme() {
    if (gameViewEl) {
      gameViewEl.style.removeProperty("--matchup-a");
      gameViewEl.style.removeProperty("--matchup-b");
    }
    if (document.body) {
      document.body.style.removeProperty("--matchup-a");
      document.body.style.removeProperty("--matchup-b");
    }
  }

  function showListView() {
    if (listViewEl) {
      listViewEl.hidden = false;
    }
    if (gameViewEl) {
      gameViewEl.hidden = true;
    }
    if (backBtn) {
      backBtn.disabled = true;
    }
    clearDataBanner();
    clearMatchupTheme();
  }

  function showGameView() {
    if (listViewEl) {
      listViewEl.hidden = true;
    }
    if (gameViewEl) {
      gameViewEl.hidden = false;
    }
    if (backBtn) {
      backBtn.disabled = false;
    }
  }

  function clearGameUI() {
    awayCard.innerHTML = "";
    homeCard.innerHTML = "";
    centerCard.innerHTML = "";
    detailsEl.innerHTML = "";
    periodsEl.innerHTML = "";
    if (comparisonBodyEl) {
      comparisonBodyEl.innerHTML = "";
    }
    if (lineupsEl) {
      lineupsEl.classList.add("is-hidden");
    }
    if (awayLineupEl) {
      awayLineupEl.innerHTML = "";
    }
    if (homeLineupEl) {
      homeLineupEl.innerHTML = "";
    }
    clearDataBanner();
    awayHeader.innerHTML = "";
    homeHeader.innerHTML = "";
    awayTable.innerHTML = "";
    homeTable.innerHTML = "";
  }

  function applyMatchupTheme(home, away) {
    if (!gameViewEl) return;
    const homeColor = getTeamColor(home.tricode);
    const awayColor = getTeamColor(away.tricode);
    const matchupA = toRgba(awayColor, 0.18);
    const matchupB = toRgba(homeColor, 0.18);
    gameViewEl.style.setProperty("--matchup-a", matchupA);
    gameViewEl.style.setProperty("--matchup-b", matchupB);
    if (document.body) {
      document.body.style.setProperty("--matchup-a", matchupA);
      document.body.style.setProperty("--matchup-b", matchupB);
    }
  }

  return {
    applyMatchupTheme,
    clearGameUI,
    clearMatchupTheme,
    showGameView,
    showListView,
  };
}
