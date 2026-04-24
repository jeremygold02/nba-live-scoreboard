import {
  API_THROTTLE_MS,
  columns,
  DETAIL_IDLE_REFRESH_MS,
  DETAIL_LIVE_REFRESH_MS,
  SCOREBOARD_IDLE_REFRESH_MS,
  SCOREBOARD_LIVE_REFRESH_MS,
} from "./js/config.js";
import {
  canUsePywebview,
  fetchDetailState,
  fetchFavorites,
  fetchPreferences,
  fetchScoreboardState,
  persistFavorites,
  persistPreferences,
} from "./js/backend-api.js";
import {
  appRoot,
  awayCard,
  awayHeader,
  awayLineupEl,
  awayLineupTitleEl,
  awayTable,
  backBtn,
  centerCard,
  clearSelectionBtn,
  comparisonBodyEl,
  comparisonEl,
  comparisonToggleBtn,
  dataBannerEl,
  detailsEl,
  fallbackEl,
  gameFiltersEl,
  gameListDateLabelEl,
  gameSearchInput,
  gameSortSelect,
  gameViewEl,
  gamesEl,
  homeCard,
  homeHeader,
  homeLineupEl,
  homeLineupTitleEl,
  homeTable,
  lastPlayEl,
  lineupsEl,
  listViewEl,
  periodsEl,
  periodsToggleBtn,
  refreshBtn,
  refreshLabel,
  scoreboardEl,
  scoreboardDateInput,
  scoreboardDateNextBtn,
  scoreboardDatePrevBtn,
  scoreboardDateTodayBtn,
  selectedGameEl,
  selectedGameViewEl,
  statFlashToggleBtn,
  statusEl,
  tableToggleBtn,
  toggleBtn,
  updatedEl,
  zoomSelect,
} from "./js/dom.js";
import {
  formatLivePhaseText,
  formatPeriodText,
  formatPeriodChip,
  formatTipoff,
  getGameSectionKey,
  getGameSectionTitle,
  getGameStatusKey,
  getGameStatusLabel,
  getNonTimeStatusText,
  shouldShowPhase,
} from "./js/game-status.js";
import {
  getEmptyGameListMessage as getBaseEmptyGameListMessage,
  isFavoriteGame,
  matchesGameFilter,
  matchesGameSearch,
  sortGamesForList,
} from "./js/game-list-utils.js";
import { createGameDetailRenderer } from "./js/game-detail-renderer.js";
import { createGameListRenderer } from "./js/game-list-renderer.js";
import {
  createGameViewController,
  fallbackForStatus,
  formatSelectedGameLabel,
} from "./js/game-view-helpers.js";
import {
  calcEfg,
  calcShotPct,
  calcTrueShooting,
  formatClock,
  formatPct,
  formatShotPct,
  hasNotEntered,
  normalizeStatValue,
} from "./js/stats-utils.js";
import {
  buildHeartIcon,
  buildLogoBadge,
  buildScoreBadge,
  formatRecord,
  getTeamColor,
  setText,
  toRgba,
} from "./js/team-fragments.js";

let scoreboardRefreshTimer = null;
let detailRefreshTimer = null;
let isScoreboardRefreshing = false;
let isDetailRefreshing = false;
let lastScoreboardRefreshAt = 0;
let lastDetailRefreshAt = 0;
let pywebviewReady = false;
let activeCell = null;
let selectedGameId = "";
let lastUpdatedAt = null;
let updatedTimer = null;
let lastGames = [];
const favoriteTeams = new Set();
let statFlashEnabled = true;
let scoreboardView = "hidden";
let tableView = "expanded";
let zoomLevel = "1";
let gameFilter = "all";
let gameSearchQuery = "";
let gameSearchTerm = "";
let gameSort = "importance";
let scoreboardDate = getTodayIsoDate();
let gameListEmptyMessageOverride = "";
let startupPromise = null;
let startupHydrated = false;

function padDatePart(value) {
  return String(value).padStart(2, "0");
}

function getTodayIsoDate() {
  const now = new Date();
  return `${now.getFullYear()}-${padDatePart(now.getMonth() + 1)}-${padDatePart(now.getDate())}`;
}

function normalizeScoreboardDate(value) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    return value.trim();
  }
  return getTodayIsoDate();
}

function isTodayScoreboardDate(value = scoreboardDate) {
  return normalizeScoreboardDate(value) === getTodayIsoDate();
}

function shiftScoreboardDate(value, offsetDays) {
  const normalized = normalizeScoreboardDate(value);
  const [year, month, day] = normalized.split("-").map(Number);
  const next = new Date(year, month - 1, day);
  next.setDate(next.getDate() + offsetDays);
  return `${next.getFullYear()}-${padDatePart(next.getMonth() + 1)}-${padDatePart(next.getDate())}`;
}

function formatScoreboardDateLabel(value = scoreboardDate) {
  const normalized = normalizeScoreboardDate(value);
  if (normalized === getTodayIsoDate()) return "Today";
  const [year, month, day] = normalized.split("-").map(Number);
  const parsed = new Date(year, month - 1, day);
  return parsed.toLocaleDateString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function updateScoreboardDateUI() {
  const normalized = normalizeScoreboardDate(scoreboardDate);
  scoreboardDate = normalized;
  if (scoreboardDateInput) {
    scoreboardDateInput.value = normalized;
  }
  if (gameListDateLabelEl) {
    gameListDateLabelEl.textContent = formatScoreboardDateLabel(normalized);
  }
}

function getEmptyGameListMessage(hasGames, gameSearchQuery, gameFilter) {
  if (gameListEmptyMessageOverride && !hasGames) {
    return gameListEmptyMessageOverride;
  }
  if (!hasGames) {
    if (isTodayScoreboardDate()) {
      return "No NBA games are on today's board.";
    }
    return `No NBA games are on ${formatScoreboardDateLabel(scoreboardDate)}.`;
  }
  return getBaseEmptyGameListMessage(hasGames, gameSearchQuery, gameFilter);
}

function formatStatLine(team) {
  if (!team || !team.stats) return "";
  const stats = team.stats;
  const hasAny =
    Number.isFinite(stats.fgm) ||
    Number.isFinite(stats.fga) ||
    Number.isFinite(stats.tpm) ||
    Number.isFinite(stats.tpa) ||
    Number.isFinite(stats.ftm) ||
    Number.isFinite(stats.fta) ||
    Number.isFinite(stats.tsPct) ||
    Number.isFinite(stats.efgPct);
  if (!hasAny) return "";
  const safe = (value) => (Number.isFinite(value) ? value : 0);
  const ts = formatPct(stats.tsPct);
  const efg = formatPct(stats.efgPct);
  const fgm = safe(stats.fgm);
  const fga = safe(stats.fga);
  const tpm = safe(stats.tpm);
  const tpa = safe(stats.tpa);
  const ftm = safe(stats.ftm);
  const fta = safe(stats.fta);
  const fgPct = formatShotPct(fgm, fga);
  const tpPct = formatShotPct(tpm, tpa);
  const ftPct = formatShotPct(ftm, fta);
  return `FG% ${fgPct} | 3PT% ${tpPct} | FT% ${ftPct} | TS% ${ts} | eFG% ${efg}`;
}

function parseUpdated(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.valueOf())) {
    return parsed.valueOf();
  }
  const fallback = Date.parse(String(value).replace(" ", "T"));
  return Number.isNaN(fallback) ? null : fallback;
}

function formatRelativeTime(seconds) {
  if (seconds < 1) return "just now";
  if (seconds < 60) return `${Math.floor(seconds)}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function updateUpdatedLabel() {
  if (!lastUpdatedAt) return;
  const diffSeconds = Math.max(0, (Date.now() - lastUpdatedAt) / 1000);
  setText(updatedEl, `Updated ${formatRelativeTime(diffSeconds)}`);
}

function setUpdatedTime(value) {
  const parsed = parseUpdated(value);
  lastUpdatedAt = parsed || Date.now();
  updateUpdatedLabel();
  if (!updatedTimer) {
    updatedTimer = setInterval(updateUpdatedLabel, 1000);
  }
}

async function saveUIPreferences() {
  const payload = getUIPreferencesPayload();
  return persistPreferences(payload);
}

function toggleFavoriteTeam(tricode) {
  if (!tricode) return;
  if (favoriteTeams.has(tricode)) {
    favoriteTeams.delete(tricode);
  } else {
    favoriteTeams.add(tricode);
  }
  saveFavoriteTeams();
  renderGameList(lastGames);
}

async function saveFavoriteTeams() {
  const payload = [...favoriteTeams];
  return persistFavorites(payload);
}

const gameListRenderer = createGameListRenderer({
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
  getGameFilter: () => gameFilter,
  getGameSearchQuery: () => gameSearchQuery,
  getGameSearchTerm: () => gameSearchTerm,
  getGameSort: () => gameSort,
  getGameSectionKey,
  getGameSectionTitle,
  getGameStatusKey,
  getGameStatusLabel,
  getSelectedGameId: () => selectedGameId,
  isFavoriteGame,
  matchesGameFilter,
  matchesGameSearch,
  selectedGameEl,
  selectedGameViewEl,
  setSelectedGameId,
  sortGamesForList,
  toggleFavoriteTeam,
});
const detailRenderer = createGameDetailRenderer({
  awayHeader,
  awayLineupEl,
  awayLineupTitleEl,
  buildLogoBadge,
  calcEfg,
  calcShotPct,
  calcTrueShooting,
  columns,
  comparisonBodyEl,
  comparisonEl,
  comparisonToggleBtn,
  dataBannerEl,
  detailsEl,
  formatClock,
  formatPct,
  formatPeriodText,
  formatRecord,
  formatRelativeTime,
  formatShotPct,
  formatStatLine,
  getGameStatusLabel,
  getStatFlashEnabled: () => statFlashEnabled,
  getTeamColor,
  hasNotEntered,
  homeHeader,
  homeLineupEl,
  homeLineupTitleEl,
  lineupsEl,
  lastPlayEl,
  normalizeStatValue,
  parseUpdated,
  periodsEl,
  periodsToggleBtn,
  shouldShowPhase,
  toRgba,
});
const { applyMatchupTheme, clearGameUI, clearMatchupTheme, showGameView, showListView } = createGameViewController({
  awayCard,
  awayHeader,
  awayLineupEl,
  awayTable,
  backBtn,
  centerCard,
  clearDataBanner: detailRenderer.clearDataBanner,
  comparisonBodyEl,
  detailsEl,
  gameViewEl,
  getTeamColor,
  homeCard,
  homeHeader,
  homeLineupEl,
  homeTable,
  lastPlayEl,
  lineupsEl,
  listViewEl,
  periodsEl,
  toRgba,
});

async function hydrateFavorites() {
  const favorites = await fetchFavorites();
  favoriteTeams.clear();
  favorites.forEach((team) => favoriteTeams.add(team));
  renderGameList(lastGames);
}

async function hydratePreferences() {
  const preferences = await fetchPreferences();
  if (!preferences) return;
  if (preferences.scoreboardView) {
    setScoreboardView(preferences.scoreboardView);
  }
  if (preferences.tableView) {
    setTableView(preferences.tableView);
  }
  if (Object.prototype.hasOwnProperty.call(preferences, "statFlashEnabled")) {
    setStatFlash(preferences.statFlashEnabled);
  }
  const nextZoom = String(preferences.zoomLevel || "1");
  zoomLevel = nextZoom;
  if (zoomSelect) {
    zoomSelect.value = nextZoom;
  }
  document.body.style.zoom = nextZoom;
}

function setStatFlash(enabled) {
  statFlashEnabled = Boolean(enabled);
  if (statFlashToggleBtn) {
    statFlashToggleBtn.textContent = statFlashEnabled ? "Stat Flash: On" : "Stat Flash: Off";
  }
}

function renderFallback(message) {
  if (!fallbackEl) return;
  const text = message ? String(message).trim() : "";
  fallbackEl.textContent = text;
  fallbackEl.hidden = !text;
}

function clearFallback() {
  if (!fallbackEl) return;
  fallbackEl.textContent = "";
  fallbackEl.hidden = true;
}

function setSelectedGameId(gameId) {
  const previousGameId = selectedGameId;
  selectedGameId = gameId || "";
  const changed = previousGameId !== selectedGameId;
  renderGameList(lastGames);
  if (selectedGameId) {
    if (changed) {
      clearGameUI();
    }
    showGameView();
    refreshDetail({ bypassThrottle: changed });
  } else {
    showListView();
    clearDetailRefreshTimer();
  }
}

function setScoreboardDate(nextDate, options = {}) {
  const normalized = normalizeScoreboardDate(nextDate);
  const changed = normalized !== scoreboardDate;
  scoreboardDate = normalized;
  updateScoreboardDateUI();
  if (!changed && !options.forceRefresh) {
    return;
  }
  if (selectedGameId) {
    setSelectedGameId("");
  }
  statusEl.textContent = "Loading";
  refreshScoreboard({ bypassThrottle: true });
}

function renderGameList(games) {
  lastGames = games || [];
  gameListRenderer.renderGameList(lastGames);
}

function updateGameFilterUI() {
  gameListRenderer.updateGameFilterUI();
}

function getUIPreferencesPayload() {
  return {
    scoreboardView,
    tableView,
    zoomLevel,
    statFlashEnabled,
  };
}

function setScoreboardView(mode) {
  const next = mode === "full" || mode === "compact" || mode === "hidden" ? mode : "hidden";
  scoreboardView = next;
  if (scoreboardEl) {
    scoreboardEl.classList.toggle("is-collapsed", next === "compact");
    scoreboardEl.classList.toggle("is-hidden", next === "hidden");
  }
  if (toggleBtn) {
    const label = next === "hidden" ? "No Spoilers" : `${next[0].toUpperCase()}${next.slice(1)}`;
    toggleBtn.textContent = `View: ${label}`;
  }
}

function setTableView(mode) {
  const compact = mode === "compact";
  tableView = compact ? "compact" : "expanded";
  document.body.classList.toggle("table-compact", compact);
  if (tableToggleBtn) {
    tableToggleBtn.textContent = compact ? "Stats: Compact" : "Stats: Expanded";
  }
}

function getScoreboardView() {
  return scoreboardView;
}

async function getScoreboardState() {
  return fetchScoreboardState({
    selectedGameId,
    view: getScoreboardView(),
    scoreboardDate,
  });
}

async function getDetailState() {
  return fetchDetailState({
    selectedGameId,
    view: getScoreboardView(),
    scoreboardDate,
  });
}

function setRefreshButtonBusy(isBusy) {
  if (!refreshBtn) return;
  refreshBtn.disabled = Boolean(isBusy);
  refreshBtn.textContent = isBusy ? "Refreshing..." : refreshLabel;
}

function clearScoreboardRefreshTimer() {
  if (!scoreboardRefreshTimer) return;
  clearTimeout(scoreboardRefreshTimer);
  scoreboardRefreshTimer = null;
}

function clearDetailRefreshTimer() {
  if (!detailRefreshTimer) return;
  clearTimeout(detailRefreshTimer);
  detailRefreshTimer = null;
}

function getRefreshDelay(state, fallbackMs) {
  const value = Number(state && state.polling && state.polling.refreshMs);
  if (!Number.isFinite(value)) {
    return fallbackMs;
  }
  return Math.max(API_THROTTLE_MS, Math.round(value));
}

function scheduleScoreboardRefresh(delay) {
  clearScoreboardRefreshTimer();
  if (document.hidden || !startupHydrated) return;
  scoreboardRefreshTimer = setTimeout(() => {
    scoreboardRefreshTimer = null;
    refreshScoreboard();
  }, Math.max(0, delay));
}

function scheduleDetailRefresh(delay) {
  clearDetailRefreshTimer();
  if (document.hidden || !startupHydrated || !selectedGameId) return;
  detailRefreshTimer = setTimeout(() => {
    detailRefreshTimer = null;
    refreshDetail();
  }, Math.max(0, delay));
}

function getVisibleGames() {
  return sortGamesForList(lastGames.filter((game) => matchesGameFilter(game) && matchesGameSearch(game)));
}

function getGameById(gameId) {
  return lastGames.find((game) => game.gameId === gameId) || null;
}

function getScoreboardStatusText(state) {
  if (!state) return formatScoreboardDateLabel();
  if (state.status === "no_games") return "No games";
  if (state.hasLiveGames) return "Live games";
  return formatScoreboardDateLabel(state.scoreboardDate || scoreboardDate);
}

function moveSelectedGame(direction) {
  const visibleGames = getVisibleGames();
  if (!visibleGames.length) return;
  const currentIndex = visibleGames.findIndex((game) => game.gameId === selectedGameId);
  if (currentIndex < 0) {
    const nextIndex = direction > 0 ? 0 : visibleGames.length - 1;
    setSelectedGameId(visibleGames[nextIndex].gameId);
    return;
  }
  const nextIndex = Math.min(visibleGames.length - 1, Math.max(0, currentIndex + direction));
  if (nextIndex !== currentIndex) {
    setSelectedGameId(visibleGames[nextIndex].gameId);
  }
}

function toggleFavoriteForSelectedGame() {
  const game = getGameById(selectedGameId);
  if (!game) return;
  const away = (game.away || {}).tricode;
  const home = (game.home || {}).tricode;
  if (home && favoriteTeams.has(home) && (!away || !favoriteTeams.has(away))) {
    toggleFavoriteTeam(home);
    return;
  }
  if (away && favoriteTeams.has(away) && (!home || !favoriteTeams.has(home))) {
    toggleFavoriteTeam(away);
    return;
  }
  if (home) {
    toggleFavoriteTeam(home);
    return;
  }
  if (away) {
    toggleFavoriteTeam(away);
  }
}

function shouldIgnoreShortcut(event) {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) {
    return true;
  }
  const target = event.target;
  if (!target) return false;
  const tagName = target.tagName;
  if (target.isContentEditable) return true;
  return tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT";
}

async function manualRefresh() {
  setRefreshButtonBusy(true);
  try {
    await Promise.all([
      refreshScoreboard({ bypassThrottle: true }),
      selectedGameId ? refreshDetail({ bypassThrottle: true }) : Promise.resolve(),
    ]);
  } finally {
    setRefreshButtonBusy(false);
  }
}

function handleGlobalShortcut(event) {
  if (shouldIgnoreShortcut(event)) return;
  const key = String(event.key || "").toLowerCase();
  if (key === "r") {
    event.preventDefault();
    manualRefresh();
    return;
  }
  if (key === "escape" && selectedGameId) {
    event.preventDefault();
    setSelectedGameId("");
    return;
  }
  if ((key === "arrowleft" || key === "arrowup") && getVisibleGames().length) {
    event.preventDefault();
    moveSelectedGame(-1);
    return;
  }
  if ((key === "arrowright" || key === "arrowdown") && getVisibleGames().length) {
    event.preventDefault();
    moveSelectedGame(1);
    return;
  }
  if (key === "f" && selectedGameId) {
    event.preventDefault();
    toggleFavoriteForSelectedGame();
  }
}

async function refreshScoreboard(options = {}) {
  if (isScoreboardRefreshing) {
    return;
  }
  if (!canUsePywebview()) {
    statusEl.textContent = "Waiting";
    renderFallback("Waiting for pywebview...");
    return;
  }
  const bypassThrottle = options && options.bypassThrottle;
  const now = Date.now();
  if (!bypassThrottle && lastScoreboardRefreshAt && now - lastScoreboardRefreshAt < API_THROTTLE_MS) {
    scheduleScoreboardRefresh(API_THROTTLE_MS - (now - lastScoreboardRefreshAt));
    return;
  }
  isScoreboardRefreshing = true;
  lastScoreboardRefreshAt = Date.now();
  try {
    let state;
    try {
      state = await getScoreboardState();
    } catch (err) {
      if (!selectedGameId) {
        statusEl.textContent = "error";
        renderFallback(`API error: ${err}`);
      }
      scheduleScoreboardRefresh(SCOREBOARD_IDLE_REFRESH_MS);
      return;
    }
    if (state.scoreboardDate) {
      scoreboardDate = normalizeScoreboardDate(state.scoreboardDate);
      updateScoreboardDateUI();
    }

    if (state.status === "error") {
      gameListEmptyMessageOverride =
        state.error || `Could not load games for ${formatScoreboardDateLabel(state.scoreboardDate || scoreboardDate)}.`;
      if (!selectedGameId) {
        statusEl.textContent = "Error";
        renderGameList([]);
        showListView();
      }
      scheduleScoreboardRefresh(getRefreshDelay(state, SCOREBOARD_IDLE_REFRESH_MS));
      return;
    }

    gameListEmptyMessageOverride = "";

    if (state.games && gamesEl) {
      renderGameList(state.games);
      if (selectedGameId && !state.games.some((game) => game.gameId === selectedGameId)) {
        setSelectedGameId("");
        return;
      }
    }

    if (!selectedGameId) {
      setUpdatedTime(state.updated);
      statusEl.textContent = getScoreboardStatusText(state);
    }

    if (state.status === "no_games" && !selectedGameId) {
      showListView();
      clearGameUI();
    }

    const nextInterval = getRefreshDelay(
      state,
      state.hasLiveGames ? SCOREBOARD_LIVE_REFRESH_MS : SCOREBOARD_IDLE_REFRESH_MS,
    );
    scheduleScoreboardRefresh(nextInterval);
  } finally {
    isScoreboardRefreshing = false;
  }
}

async function refreshDetail(options = {}) {
  if (!selectedGameId) {
    clearDetailRefreshTimer();
    return;
  }
  if (isDetailRefreshing) {
    return;
  }
  if (!canUsePywebview()) {
    statusEl.textContent = "Waiting";
    renderFallback("Waiting for pywebview...");
    return;
  }
  const bypassThrottle = options && options.bypassThrottle;
  const now = Date.now();
  if (!bypassThrottle && lastDetailRefreshAt && now - lastDetailRefreshAt < API_THROTTLE_MS) {
    scheduleDetailRefresh(API_THROTTLE_MS - (now - lastDetailRefreshAt));
    return;
  }
  isDetailRefreshing = true;
  lastDetailRefreshAt = Date.now();
  const requestedGameId = selectedGameId;
  try {
    let state;
    try {
      state = await getDetailState();
    } catch (err) {
      statusEl.textContent = "error";
      detailRenderer.clearDataBanner();
      renderFallback(`API error: ${err}`);
      scheduleDetailRefresh(DETAIL_IDLE_REFRESH_MS);
      return;
    }

    if (requestedGameId !== selectedGameId) {
      return;
    }
    if (state.scoreboardDate) {
      scoreboardDate = normalizeScoreboardDate(state.scoreboardDate);
      updateScoreboardDateUI();
    }

    setUpdatedTime(state.dataUpdated || state.updated);

    if (state.games && gamesEl) {
      renderGameList(state.games);
    }

    if (state.status !== "ok" && state.status !== "scheduled" && state.status !== "postgame" && state.status !== "live_no_data") {
      statusEl.textContent = state.status.replace(/_/g, " ");
      detailRenderer.clearDataBanner();
      renderFallback(
        state.error || fallbackForStatus(state.status, state.game && state.game.statusText, getNonTimeStatusText),
      );
      if (state.status === "game_not_found") {
        setSelectedGameId("");
      }
      if (state.status === "select_game") {
        showListView();
      }
      clearGameUI();
      if (state.status === "error") {
        scheduleDetailRefresh(getRefreshDelay(state, DETAIL_IDLE_REFRESH_MS));
      } else {
        clearDetailRefreshTimer();
      }
      return;
    }

    if (state.status === "scheduled" || state.status === "postgame" || state.status === "live_no_data") {
      renderFallback(fallbackForStatus(state.status, state.game && state.game.statusText, getNonTimeStatusText));
    } else {
      clearFallback();
    }
    detailRenderer.renderDataBanner(state.dataStatus);
    statusEl.textContent = state.game.statusText || getGameStatusLabel(state.game);
    showGameView();
    const home = state.home;
    const away = state.away;

    detailRenderer.renderTeamCard(awayCard, away);
    detailRenderer.renderTeamCard(homeCard, home);
    detailRenderer.renderCenter(centerCard, state.game);
    detailRenderer.renderDetails(state.game);
    detailRenderer.renderRecentPlays(state.recentPlays, home, away);
    detailRenderer.renderHeaders(home, away);
    detailRenderer.renderPeriods(state.periods, home, away);
    detailRenderer.renderComparison(home, away);
    detailRenderer.renderLineups(home, away, state.status === "ok");
    applyMatchupTheme(home, away);

    const showTotals = state.status === "ok";
    const hidePoints = scoreboardEl && scoreboardEl.classList.contains("is-hidden");
    const awayCount = Array.isArray(away.players) ? away.players.length : 0;
    const homeCount = Array.isArray(home.players) ? home.players.length : 0;
    const targetRows = Math.max(awayCount, homeCount);
    detailRenderer.renderTeamTable(
      awayTable,
      away,
      `away-${away.id || away.tricode || "team"}`,
      showTotals,
      hidePoints,
      targetRows,
    );
    detailRenderer.renderTeamTable(
      homeTable,
      home,
      `home-${home.id || home.tricode || "team"}`,
      showTotals,
      hidePoints,
      targetRows,
    );
    const isLive = state.game && state.game.statusKey === "live";
    scheduleDetailRefresh(
      getRefreshDelay(state, isLive ? DETAIL_LIVE_REFRESH_MS : DETAIL_IDLE_REFRESH_MS),
    );
  } finally {
    isDetailRefreshing = false;
  }
}

function startPolling() {
  refreshScoreboard({ bypassThrottle: true });
  if (selectedGameId) {
    refreshDetail({ bypassThrottle: true });
  }
}

function startPollingIfReady() {
  if (!canUsePywebview()) {
    return;
  }
  if (!pywebviewReady) {
    pywebviewReady = true;
  }
  if (!startupPromise) {
    startupPromise = Promise.all([hydrateFavorites(), hydratePreferences()])
      .catch((error) => {
        renderFallback(`Startup sync failed: ${error}`);
      })
      .finally(() => {
        startupHydrated = true;
        startPolling();
      });
    return;
  }
  if (startupHydrated) {
    startPolling();
  }
}

function stopPolling() {
  clearScoreboardRefreshTimer();
  clearDetailRefreshTimer();
}

window.addEventListener("DOMContentLoaded", () => {
  setUpdatedTime(new Date().toISOString());
  statusEl.textContent = "Waiting";
  renderFallback("Waiting for pywebview...");
  updateScoreboardDateUI();
  setScoreboardView(scoreboardView);
  setTableView(tableView);
  setStatFlash(statFlashEnabled);
  if (zoomSelect) {
    zoomSelect.value = zoomLevel;
    document.body.style.zoom = zoomLevel;
  }
  if (gameSortSelect) {
    gameSortSelect.value = gameSort;
  }
  if (gameSearchInput) {
    gameSearchInput.value = gameSearchQuery;
  }
  updateGameFilterUI();

  startPollingIfReady();
  setupScrollbars();

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopPolling();
    } else {
      startPollingIfReady();
    }
  });

  if (zoomSelect) {
    zoomSelect.addEventListener("change", () => {
      zoomLevel = zoomSelect.value || "1";
      document.body.style.zoom = zoomLevel;
      saveUIPreferences();
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      manualRefresh();
    });
  }

  if (scoreboardDateInput) {
    scoreboardDateInput.addEventListener("change", () => {
      setScoreboardDate(scoreboardDateInput.value || getTodayIsoDate());
    });
  }

  if (scoreboardDatePrevBtn) {
    scoreboardDatePrevBtn.addEventListener("click", () => {
      setScoreboardDate(shiftScoreboardDate(scoreboardDate, -1));
    });
  }

  if (scoreboardDateTodayBtn) {
    scoreboardDateTodayBtn.addEventListener("click", () => {
      setScoreboardDate(getTodayIsoDate(), { forceRefresh: true });
    });
  }

  if (scoreboardDateNextBtn) {
    scoreboardDateNextBtn.addEventListener("click", () => {
      setScoreboardDate(shiftScoreboardDate(scoreboardDate, 1));
    });
  }

  if (gameFiltersEl) {
    gameFiltersEl.addEventListener("click", (event) => {
      const button = event.target.closest("[data-filter]");
      if (!button) return;
      gameFilter = button.dataset.filter || "all";
      updateGameFilterUI();
      renderGameList(lastGames);
    });
  }

  if (gameSearchInput) {
    gameSearchInput.addEventListener("input", () => {
      gameSearchQuery = String(gameSearchInput.value || "").trim();
      gameSearchTerm = gameSearchQuery.toLowerCase();
      renderGameList(lastGames);
    });
  }

  if (gameSortSelect) {
    gameSortSelect.addEventListener("change", () => {
      gameSort = gameSortSelect.value === "tipoff" ? "tipoff" : "importance";
      renderGameList(lastGames);
    });
  }

  if (toggleBtn && scoreboardEl) {
    toggleBtn.addEventListener("click", () => {
      const states = ["full", "compact", "hidden"];
      const currentIndex = states.indexOf(scoreboardView);
      const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % states.length;
      setScoreboardView(states[nextIndex]);
      saveUIPreferences();
    });
  }

  if (clearSelectionBtn) {
    clearSelectionBtn.addEventListener("click", () => {
      setSelectedGameId("");
    });
  }

  if (backBtn) {
    backBtn.addEventListener("click", () => {
      setSelectedGameId("");
    });
  }

  if (periodsToggleBtn) {
    detailRenderer.setPeriodsOpen(false);
    periodsToggleBtn.addEventListener("click", () => {
      detailRenderer.setPeriodsOpen(!detailRenderer.isPeriodsOpen());
    });
  }

  if (comparisonToggleBtn) {
    detailRenderer.setComparisonOpen(false);
    comparisonToggleBtn.addEventListener("click", () => {
      detailRenderer.setComparisonOpen(!detailRenderer.isComparisonOpen());
    });
  }

  if (tableToggleBtn) {
    tableToggleBtn.addEventListener("click", () => {
      const next = document.body.classList.contains("table-compact") ? "expanded" : "compact";
      setTableView(next);
      saveUIPreferences();
    });
  }

  if (statFlashToggleBtn) {
    statFlashToggleBtn.addEventListener("click", () => {
      setStatFlash(!statFlashEnabled);
      saveUIPreferences();
    });
  }

  if (appRoot) {
    appRoot.addEventListener("mouseover", handleTableHover);
    appRoot.addEventListener("mouseout", clearTableHover);
  }

  document.addEventListener("keydown", handleGlobalShortcut);

  if (selectedGameId) {
    showGameView();
  } else {
    showListView();
  }
});

window.addEventListener("pywebviewready", () => {
  startPollingIfReady();
});

function setupScrollbars() {
  const bodies = document.querySelectorAll(".table-card__body");
  bodies.forEach((body) => {
    let timerId = null;
    const activate = () => {
      body.classList.add("scroll-active");
      if (timerId) {
        clearTimeout(timerId);
      }
      timerId = setTimeout(() => {
        body.classList.remove("scroll-active");
      }, 1000);
    };
    body.addEventListener("scroll", activate);
    body.addEventListener("mouseenter", activate);
    body.addEventListener("mousemove", activate);
    body.addEventListener("mouseleave", () => {
      body.classList.remove("scroll-active");
    });
  });
}

function handleTableHover(event) {
  const cell = event.target.closest("td, th");
  if (!cell) return;
  const table = cell.closest(".stats-table");
  if (!table) return;

  if (activeCell === cell) {
    return;
  }

  clearTableHighlights(table);
  activeCell = cell;

  const row = cell.parentElement;
  if (row && row.tagName === "TR") {
    row.classList.add("row-highlight");
  }

  const cellIndex = Array.from(row.children).indexOf(cell);
  if (cellIndex >= 0) {
    table.querySelectorAll("thead tr, tbody tr").forEach((tr) => {
      const target = tr.children[cellIndex];
      if (target) {
        target.classList.add("col-highlight");
      }
    });
  }
}

function clearTableHover(event) {
  const related = event.relatedTarget;
  if (related && related.closest && related.closest(".stats-table")) {
    return;
  }
  const tables = document.querySelectorAll(".stats-table");
  tables.forEach(clearTableHighlights);
  activeCell = null;
}

function clearTableHighlights(table) {
  table.querySelectorAll(".row-highlight").forEach((row) => {
    row.classList.remove("row-highlight");
  });
  table.querySelectorAll(".col-highlight").forEach((cell) => {
    cell.classList.remove("col-highlight");
  });
}
