export function createGameListRenderer({
  buildHeartIcon,
  buildLogoBadge,
  buildScoreBadge,
  clearSelectionBtn,
  favoriteTeams,
  formatClock,
  formatLivePhaseText,
  formatPeriodChip,
  formatSelectedGameLabel,
  formatTipoff,
  gameFiltersEl,
  gamesEl,
  getEmptyGameListMessage,
  getGameFilter,
  getGameSearchQuery,
  getGameSearchTerm,
  getGameSort,
  getGameSectionKey,
  getGameSectionTitle,
  getGameStatusKey,
  getGameStatusLabel,
  getSelectedGameId,
  isFavoriteGame,
  matchesGameFilter,
  matchesGameSearch,
  selectedGameEl,
  selectedGameViewEl,
  setSelectedGameId,
  sortGamesForList,
  toggleFavoriteTeam,
}) {
  const gameItemNodes = new Map();
  const gameSectionNodes = new Map();
  let lastRenderKey = null;

  function buildMetaText(text, variant) {
    const element = document.createElement("span");
    element.className = `game-item__meta-${variant}`;
    element.textContent = text;
    return element;
  }

  function buildGameMeta(game) {
    const meta = document.createElement("div");
    meta.className = "game-item__meta";
    const statusKey = getGameStatusKey(game);
    meta.classList.add(`game-item__meta--${statusKey}`);
    const status = getGameStatusLabel(game);

    const clock = formatClock(game.clock);
    const phase = formatLivePhaseText(game, clock);
    const period = formatPeriodChip(game);
    const tipoff = formatTipoff(game.startTimeUTC);

    if (statusKey === "live") {
      meta.appendChild(buildMetaText(status, "status"));
      const liveDetail = [period, clock].filter(Boolean).join(" · ");
      if (liveDetail) meta.appendChild(buildMetaText(liveDetail, "detail"));
      if (phase) meta.appendChild(buildMetaText(phase, "detail"));
    } else {
      if (tipoff && statusKey === "scheduled") meta.appendChild(buildMetaText(tipoff, "time"));
      meta.appendChild(buildMetaText(status, "status"));
      if (tipoff && statusKey !== "scheduled") meta.appendChild(buildMetaText(tipoff, "detail"));
    }

    return meta;
  }

  function buildFavoriteButton(team, side) {
    const tricode = team.tricode;
    const favButton = document.createElement("button");
    favButton.type = "button";
    favButton.className = `team-fav team-fav--${side}`;
    const isFavorite = tricode && favoriteTeams.has(tricode);
    if (isFavorite) {
      favButton.classList.add("is-active");
    }
    if (!tricode) {
      favButton.disabled = true;
    }
    const teamName = `${team.city || ""} ${team.name || ""}`.trim() || tricode || "team";
    const label = `${isFavorite ? "Unfavorite" : "Favorite"} ${teamName}`;
    favButton.setAttribute("aria-label", label);
    favButton.setAttribute("aria-pressed", Boolean(isFavorite));
    favButton.title = label;
    favButton.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleFavoriteTeam(tricode);
    });
    favButton.appendChild(buildHeartIcon());
    return favButton;
  }

  function getGameListItemHash(game) {
    const away = game.away || {};
    const home = game.home || {};
    const selectedGameId = getSelectedGameId();
    return JSON.stringify({
      status: getGameStatusLabel(game),
      statusKey: getGameStatusKey(game),
      statusText: game.statusText || "",
      clock: game.clock || "",
      period: game.period || "",
      startTimeUTC: game.startTimeUTC || "",
      awayName: away.name || "",
      awayCity: away.city || "",
      awayTricode: away.tricode || "",
      awayScore: away.score,
      awayId: away.id || "",
      awayFavorite: favoriteTeams.has(away.tricode),
      homeName: home.name || "",
      homeCity: home.city || "",
      homeTricode: home.tricode || "",
      homeScore: home.score,
      homeId: home.id || "",
      homeFavorite: favoriteTeams.has(home.tricode),
      favorite: isFavoriteGame(game, favoriteTeams),
      selected: selectedGameId && game.gameId === selectedGameId,
    });
  }

  function buildGameListItem(game) {
    let row = gameItemNodes.get(game.gameId);
    if (!row) {
      row = document.createElement("div");
      row.className = "game-item";
      gameItemNodes.set(game.gameId, row);
    }

    row.dataset.gameId = game.gameId || "";
    const renderHash = getGameListItemHash(game);
    if (row.dataset.renderHash === renderHash) {
      return row;
    }

    const selectedGameId = getSelectedGameId();
    row.dataset.renderHash = renderHash;
    row.className = "game-item";
    if (isFavoriteGame(game, favoriteTeams)) {
      row.classList.add("game-item--favorite");
    }
    if (selectedGameId && game.gameId === selectedGameId) {
      row.classList.add("is-selected");
    }

    const away = game.away || {};
    const home = game.home || {};
    const selectButton = document.createElement("button");
    selectButton.type = "button";
    selectButton.className = "game-item__select";
    selectButton.addEventListener("click", () => {
      setSelectedGameId(row.dataset.gameId);
    });

    function buildTeam(team, side) {
      const teamEl = document.createElement("span");
      teamEl.className = `game-item__team game-item__team--${side}`;
      const name = document.createElement("span");
      name.className = "game-item__team-name";
      name.textContent = `${team.city || ""} ${team.name || ""}`.trim();
      teamEl.append(buildLogoBadge(team), name);
      return teamEl;
    }

    const statusKey = getGameStatusKey(game);
    const showScore = statusKey === "live" || statusKey === "final";
    function buildRowScore(team, side) {
      const score = showScore ? buildScoreBadge(team.score) : document.createElement("span");
      score.classList.add("game-item__score", `game-item__score--${side}`);
      if (!showScore) score.setAttribute("aria-hidden", "true");
      return score;
    }

    selectButton.append(
      buildTeam(away, "away"),
      buildRowScore(away, "away"),
      buildGameMeta(game),
      buildRowScore(home, "home"),
      buildTeam(home, "home"),
    );
    row.replaceChildren(buildFavoriteButton(away, "away"), selectButton, buildFavoriteButton(home, "home"));
    return row;
  }

  function buildGameListSection(sectionKey, titleText, games) {
    let section = gameSectionNodes.get(sectionKey);
    if (!section) {
      section = document.createElement("section");
      section.className = "game-list__group";

      const head = document.createElement("div");
      head.className = "game-list__section-head";

      const title = document.createElement("div");
      title.className = "game-list__section";

      const count = document.createElement("div");
      count.className = "game-list__count";

      head.append(title, count);

      const grid = document.createElement("div");
      grid.className = "game-list__section-grid";

      section.append(head, grid);
      gameSectionNodes.set(sectionKey, section);
    }

    const titleEl = section.querySelector(".game-list__section");
    const countEl = section.querySelector(".game-list__count");
    const gridEl = section.querySelector(".game-list__section-grid");

    if (titleEl) {
      titleEl.textContent = titleText;
    }
    if (countEl) {
      countEl.textContent = `${games.length} game${games.length === 1 ? "" : "s"}`;
    }
    if (gridEl) {
      gridEl.replaceChildren(...games.map((game) => buildGameListItem(game)));
    }

    return section;
  }

  function syncSelectedLabels(allGames) {
    let selectedLabel = "Select a game";
    const selectedGameId = getSelectedGameId();
    allGames.forEach((game) => {
      if (selectedGameId && game.gameId === selectedGameId) {
        selectedLabel = formatSelectedGameLabel(game);
      }
    });

    const emptyLabel = allGames.length ? selectedLabel : "No games on board";
    if (selectedGameEl) {
      selectedGameEl.textContent = emptyLabel;
    }
    if (selectedGameViewEl) {
      selectedGameViewEl.textContent = emptyLabel;
    }
    if (clearSelectionBtn) {
      clearSelectionBtn.disabled = !selectedGameId;
    }

    return selectedLabel;
  }

  function renderGameList(games) {
    if (!gamesEl) return;

    const allGames = games || [];
    const renderKey = JSON.stringify({
      games: allGames,
      selectedGameId: getSelectedGameId(),
      filter: getGameFilter(),
      search: getGameSearchQuery(),
      sort: getGameSort(),
      favorites: [...favoriteTeams].sort(),
      emptyMessage: getEmptyGameListMessage(allGames.length > 0, getGameSearchQuery(), getGameFilter()),
    });
    if (renderKey === lastRenderKey) return;
    lastRenderKey = renderKey;
    const activeGameIds = new Set(allGames.map((game) => game.gameId));
    for (const gameId of gameItemNodes.keys()) {
      if (!activeGameIds.has(gameId)) gameItemNodes.delete(gameId);
    }

    const active = document.activeElement;
    const activeRow = active && gamesEl.contains(active) ? active.closest(".game-item") : null;
    const focusedGameId = activeRow?.dataset.gameId;
    const focusedControl = active?.classList.contains("team-fav--away") ? ".team-fav--away"
      : active?.classList.contains("team-fav--home") ? ".team-fav--home"
        : active?.classList.contains("game-item__select") ? ".game-item__select" : null;
    const restoreFocus = () => {
      if (!focusedGameId || !focusedControl) return;
      const row = [...gamesEl.querySelectorAll(".game-item")].find((item) => item.dataset.gameId === focusedGameId);
      const target = row?.querySelector(focusedControl) || gameFiltersEl?.querySelector(".is-active");
      target?.focus({ preventScroll: true });
    };

    const selectedLabel = syncSelectedLabels(allGames);
    const gameFilter = getGameFilter();
    const gameSearchQuery = getGameSearchQuery();
    const gameSearchTerm = getGameSearchTerm();
    const visibleGames = sortGamesForList(
      allGames.filter(
        (game) => matchesGameFilter(game, gameFilter, favoriteTeams) && matchesGameSearch(game, gameSearchTerm),
      ),
      getGameSort(),
      favoriteTeams,
    );

    if (!visibleGames.length) {
      const empty = document.createElement("div");
      empty.className = "game-list__empty";
      empty.textContent = getEmptyGameListMessage(allGames.length > 0, gameSearchQuery, gameFilter);
      gamesEl.replaceChildren(empty);

      if (!allGames.length) {
        syncSelectedLabels(allGames);
      } else {
        if (selectedGameEl) {
          selectedGameEl.textContent = selectedLabel;
        }
        if (selectedGameViewEl) {
          selectedGameViewEl.textContent = selectedLabel;
        }
      }
      restoreFocus();
      return;
    }

    const favoriteGames = [];
    const sectionOrder = ["live", "scheduled", "finished"];
    const sectionGames = new Map(sectionOrder.map((key) => [key, []]));

    visibleGames.forEach((game) => {
      if (isFavoriteGame(game, favoriteTeams)) {
        favoriteGames.push(game);
        return;
      }
      sectionGames.get(getGameSectionKey(game)).push(game);
    });

    const sections = [];
    if (favoriteGames.length) {
      sections.push(buildGameListSection("favorites", "Favorite Games", favoriteGames));
    }

    sectionOrder.forEach((sectionKey) => {
      const gamesForSection = sectionGames.get(sectionKey);
      if (!gamesForSection || !gamesForSection.length) return;
      sections.push(buildGameListSection(sectionKey, getGameSectionTitle(sectionKey), gamesForSection));
    });

    gamesEl.replaceChildren(...sections);
    restoreFocus();
    if (selectedGameEl) {
      selectedGameEl.textContent = selectedLabel;
    }
    if (selectedGameViewEl) {
      selectedGameViewEl.textContent = selectedLabel;
    }
  }

  function updateGameFilterUI() {
    if (!gameFiltersEl) return;
    const activeFilter = getGameFilter();
    const buttons = gameFiltersEl.querySelectorAll("[data-filter]");
    buttons.forEach((button) => {
      button.classList.toggle("is-active", button.dataset.filter === activeFilter);
    });
  }

  return {
    renderGameList,
    updateGameFilterUI,
  };
}
