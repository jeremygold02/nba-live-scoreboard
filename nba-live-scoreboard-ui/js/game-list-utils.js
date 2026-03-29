import { getGameSectionKey } from "./game-status.js";

export function getTipoffTimestamp(game) {
  if (!game || !game.startTimeUTC) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(game.startTimeUTC);
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

export function isFavoriteGame(game, favoriteTeams) {
  if (!game || !favoriteTeams) return false;
  const away = (game.away || {}).tricode;
  const home = (game.home || {}).tricode;
  return (away && favoriteTeams.has(away)) || (home && favoriteTeams.has(home));
}

export function getGameImportanceRank(game, favoriteTeams) {
  const sectionKey = getGameSectionKey(game);
  const favorite = isFavoriteGame(game, favoriteTeams);
  if (favorite && sectionKey === "live") return 0;
  if (sectionKey === "live") return 1;
  if (favorite && sectionKey === "scheduled") return 2;
  if (sectionKey === "scheduled") return 3;
  if (favorite && sectionKey === "finished") return 4;
  return 5;
}

export function matchesGameSearch(game, gameSearchTerm) {
  if (!gameSearchTerm) return true;
  const away = game.away || {};
  const home = game.home || {};
  const haystack = [
    game.matchup,
    away.city,
    away.name,
    away.tricode,
    home.city,
    home.name,
    home.tricode,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(gameSearchTerm);
}

export function matchesGameFilter(game, gameFilter, favoriteTeams) {
  if (gameFilter === "all") return true;
  if (gameFilter === "favorites") return isFavoriteGame(game, favoriteTeams);
  return getGameSectionKey(game) === gameFilter;
}

export function sortGamesForList(games, gameSort, favoriteTeams) {
  const withIndex = games.map((game, index) => ({ game, index }));
  withIndex.sort((a, b) => {
    if (gameSort === "tipoff") {
      const tipoffDiff = getTipoffTimestamp(a.game) - getTipoffTimestamp(b.game);
      if (tipoffDiff !== 0) return tipoffDiff;
      const importanceDiff =
        getGameImportanceRank(a.game, favoriteTeams) - getGameImportanceRank(b.game, favoriteTeams);
      if (importanceDiff !== 0) return importanceDiff;
      return a.index - b.index;
    }

    const importanceDiff =
      getGameImportanceRank(a.game, favoriteTeams) - getGameImportanceRank(b.game, favoriteTeams);
    if (importanceDiff !== 0) return importanceDiff;
    const tipoffDiff = getTipoffTimestamp(a.game) - getTipoffTimestamp(b.game);
    if (tipoffDiff !== 0) return tipoffDiff;
    return a.index - b.index;
  });
  return withIndex.map(({ game }) => game);
}

export function getEmptyGameListMessage(hasGames, gameSearchQuery, gameFilter) {
  if (!hasGames) {
    return "No NBA games are on today's board.";
  }
  if (gameSearchQuery) {
    return `No games match "${gameSearchQuery}".`;
  }
  if (gameFilter === "favorites") {
    return "No favorite games match the current filter.";
  }
  return "No games match the current filters.";
}
