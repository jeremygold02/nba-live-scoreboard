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

  function buildMetaChip(text, variant = "") {
    const chip = document.createElement("span");
    chip.className = variant ? `game-chip game-chip--${variant}` : "game-chip";
    chip.textContent = text;
    return chip;
  }

  function buildGameMeta(game) {
    const meta = document.createElement("div");
    meta.className = "game-item__meta";
    const statusKey = getGameStatusKey(game);
    meta.appendChild(buildMetaChip(getGameStatusLabel(game), statusKey));

    const clock = formatClock(game.clock);
    const phase = formatLivePhaseText(game, clock);
    const period = formatPeriodChip(game);
    const tipoff = formatTipoff(game.startTimeUTC);

    if (clock) {
      meta.appendChild(buildMetaChip(clock));
    }
    if (period) {
      meta.appendChild(buildMetaChip(period));
    }
    if (phase) {
      meta.appendChild(buildMetaChip(phase));
    }
    if (tipoff && statusKey !== "live") {
      meta.appendChild(buildMetaChip(tipoff, "scheduled"));
    }

    return meta;
  }

  function buildFavoriteButton(tricode) {
    const favButton = document.createElement("button");
    favButton.type = "button";
    favButton.className = "team-fav";
    const isFavorite = tricode && favoriteTeams.has(tricode);
    if (isFavorite) {
      favButton.classList.add("is-active");
    }
    if (!tricode) {
      favButton.disabled = true;
    }
    favButton.setAttribute("aria-label", isFavorite ? "Unfavorite team" : "Favorite team");
    favButton.title = isFavorite ? "Unfavorite team" : "Favorite team";
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
      homeName: home.name || "",
      homeCity: home.city || "",
      homeTricode: home.tricode || "",
      homeScore: home.score,
      homeId: home.id || "",
      favorite: isFavoriteGame(game, favoriteTeams),
      selected: selectedGameId && game.gameId === selectedGameId,
    });
  }

  function buildGameListItem(game) {
    let button = gameItemNodes.get(game.gameId);
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "game-item";
      button.addEventListener("click", () => {
        setSelectedGameId(button.dataset.gameId);
      });
      gameItemNodes.set(game.gameId, button);
    }

    button.dataset.gameId = game.gameId || "";
    const renderHash = getGameListItemHash(game);
    if (button.dataset.renderHash === renderHash) {
      return button;
    }

    const selectedGameId = getSelectedGameId();
    button.dataset.renderHash = renderHash;
    button.className = "game-item";
    if (isFavoriteGame(game, favoriteTeams)) {
      button.classList.add("game-item--favorite");
    }
    if (selectedGameId && game.gameId === selectedGameId) {
      button.classList.add("is-selected");
    }

    const away = game.away || {};
    const home = game.home || {};
    const title = document.createElement("div");
    title.className = "game-item__title";

    const awayLine = document.createElement("div");
    awayLine.className = "game-item__teamline";
    const awayLeft = document.createElement("div");
    awayLeft.className = "game-item__teamline-left";
    awayLeft.append(
      buildFavoriteButton(away.tricode),
      buildLogoBadge(away),
      document.createTextNode(`${away.city || ""} ${away.name || ""}`.trim()),
      document.createTextNode(" @"),
    );
    awayLine.appendChild(awayLeft);
    const statusKey = getGameStatusKey(game);
    const showScore = statusKey === "live" || statusKey === "final";
    if (showScore) {
      awayLine.appendChild(buildScoreBadge(away.score));
    }

    const homeLine = document.createElement("div");
    homeLine.className = "game-item__teamline";
    const homeLeft = document.createElement("div");
    homeLeft.className = "game-item__teamline-left";
    homeLeft.append(
      buildFavoriteButton(home.tricode),
      buildLogoBadge(home),
      document.createTextNode(`${home.city || ""} ${home.name || ""}`.trim()),
    );
    homeLine.appendChild(homeLeft);
    if (showScore) {
      homeLine.appendChild(buildScoreBadge(home.score));
    }

    title.append(awayLine, homeLine);
    button.replaceChildren(title, buildGameMeta(game));
    return button;
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

    const emptyLabel = allGames.length ? selectedLabel : "No games today";
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
