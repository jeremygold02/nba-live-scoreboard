const DETAIL_LIVE_REFRESH_MS = 10000;
const DETAIL_IDLE_REFRESH_MS = 20000;
const SCOREBOARD_LIVE_REFRESH_MS = 20000;
const SCOREBOARD_IDLE_REFRESH_MS = 30000;
const API_THROTTLE_MS = 5000;
let scoreboardRefreshTimer = null;
let detailRefreshTimer = null;
let isScoreboardRefreshing = false;
let isDetailRefreshing = false;
let lastScoreboardRefreshAt = 0;
let lastDetailRefreshAt = 0;
let pywebviewReady = false;

const updatedEl = document.getElementById("updated");
const statusEl = document.getElementById("status");
const awayCard = document.getElementById("away-card");
const homeCard = document.getElementById("home-card");
const centerCard = document.getElementById("game-center");
const detailsEl = document.getElementById("game-details");
const periodsToggleBtn = document.getElementById("periods-toggle");
const periodsEl = document.getElementById("periods");
const comparisonEl = document.getElementById("comparison");
const comparisonBodyEl = document.getElementById("comparison-body");
const comparisonToggleBtn = document.getElementById("comparison-toggle");
const lineupsEl = document.getElementById("lineups");
const awayLineupTitleEl = document.getElementById("away-lineup-title");
const homeLineupTitleEl = document.getElementById("home-lineup-title");
const awayLineupEl = document.getElementById("away-lineup");
const homeLineupEl = document.getElementById("home-lineup");
const awayHeader = document.getElementById("away-header");
const homeHeader = document.getElementById("home-header");
const awayTable = document.getElementById("away-table");
const homeTable = document.getElementById("home-table");
const gamesEl = document.getElementById("games");
const gameFiltersEl = document.getElementById("game-filters");
const gameSearchInput = document.getElementById("game-search");
const gameSortSelect = document.getElementById("game-sort");
const selectedGameEl = document.getElementById("selected-game");
const selectedGameViewEl = document.getElementById("selected-game-view");
const clearSelectionBtn = document.getElementById("clear-selection");
const listViewEl = document.getElementById("list-view");
const gameViewEl = document.getElementById("game-view");
const backBtn = document.getElementById("back-to-list");
const tableToggleBtn = document.getElementById("table-toggle");
const statFlashToggleBtn = document.getElementById("stat-flash-toggle");
const notificationsToggleBtn = document.getElementById("notifications-toggle");
const fallbackEl = document.getElementById("fallback");
const dataBannerEl = document.getElementById("data-banner");
const scoreboardEl = document.getElementById("scoreboard");
const toggleBtn = document.getElementById("scoreboard-toggle");
const refreshBtn = document.getElementById("refresh-now");
const zoomSelect = document.getElementById("zoom-select");
const appRoot = document.getElementById("app");
const refreshLabel = refreshBtn ? refreshBtn.textContent : "Refresh";
let activeCell = null;
let selectedGameId = "";
let lastUpdatedAt = null;
let updatedTimer = null;
let lastGames = [];
const favoriteTeams = new Set();
const lastScores = new Map();
const tableCache = new Map();
const lastPlayerStats = new Map();
const gameItemNodes = new Map();
const gameSectionNodes = new Map();
let statFlashEnabled = true;
let notificationsEnabled = false;
let scoreboardView = "hidden";
let tableView = "expanded";
let periodsOpen = false;
let comparisonOpen = false;
let zoomLevel = "1";
let gameFilter = "all";
let gameSearchQuery = "";
let gameSearchTerm = "";
let gameSort = "importance";
let startupPromise = null;
let startupHydrated = false;
const teamColors = {
  ATL: "#e03a3e",
  BOS: "#007a33",
  BKN: "#111111",
  CHA: "#1d1160",
  CHI: "#ce1141",
  CLE: "#6f263d",
  DAL: "#00538c",
  DEN: "#0e2240",
  DET: "#c8102e",
  GSW: "#1d428a",
  HOU: "#ce1141",
  IND: "#002d62",
  LAC: "#c8102e",
  LAL: "#552583",
  MEM: "#5d76a9",
  MIA: "#98002e",
  MIL: "#00471b",
  MIN: "#0c2340",
  NOP: "#0c2340",
  NYK: "#006bb6",
  OKC: "#007ac1",
  ORL: "#0077c0",
  PHI: "#006bb6",
  PHX: "#1d1160",
  POR: "#e03a3e",
  SAC: "#5a2d81",
  SAS: "#c4ced4",
  TOR: "#ce1141",
  UTA: "#002b5c",
  WAS: "#002b5c",
};

const columns = [
  "MIN",
  "PTS",
  "REB",
  "AST",
  "STL",
  "BLK",
  "TO",
  "PF",
  "FG",
  "3PT",
  "FT",
  "TS%",
  "eFG%",
  "+/-",
];

function formatRecord(team) {
  if (!team) return "";
  if (team.wins || team.losses) {
    return `${team.wins}-${team.losses}`;
  }
  return "";
}

function getGameStatusKey(game) {
  if (!game) return "scheduled";
  const statusKey = String(game.statusKey || "").trim().toLowerCase();
  if (statusKey === "live" || statusKey === "final" || statusKey === "scheduled") {
    return statusKey;
  }
  const legacyStatus = Number.isFinite(game.status) ? game.status : Number(game.status);
  if (legacyStatus === 2) return "live";
  if (legacyStatus === 3) return "final";
  return "scheduled";
}

function getGameStatusLabel(game) {
  if (!game) return "Unknown";
  if (game.status) return String(game.status);
  const statusKey = getGameStatusKey(game);
  if (statusKey === "live") return "Live";
  if (statusKey === "final") return "Final";
  return "Scheduled";
}

function isTimeStatusText(text) {
  if (!text) return false;
  const trimmed = String(text).trim();
  if (!trimmed) return false;
  if (/[0-9]/.test(trimmed) && /:/.test(trimmed)) return true;
  if (/\b(am|pm)\b/i.test(trimmed)) return true;
  if (/\b(et|ct|mt|pt)\b/i.test(trimmed) && /[0-9]/.test(trimmed)) return true;
  return false;
}

function getNonTimeStatusText(text) {
  if (!text) return "";
  const trimmed = String(text).trim();
  if (!trimmed || isTimeStatusText(trimmed)) return "";
  return trimmed;
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
    Number.isFinite(stats.rebounds) ||
    Number.isFinite(stats.assists);
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
  const rebounds = safe(stats.rebounds);
  const assists = safe(stats.assists);
  return `${fgm}-${fga} FG (${fgPct}) | ${tpm}-${tpa} 3PT (${tpPct}) | ${ftm}-${fta} FT (${ftPct}) | ${rebounds} REB | ${assists} AST | ${ts} TS | ${efg} eFG`;
}

function setText(el, text) {
  el.textContent = text;
}

function toRgba(hex, alpha) {
  if (!hex) return `rgba(255, 255, 255, ${alpha})`;
  const value = hex.replace("#", "");
  if (value.length !== 6) return `rgba(255, 255, 255, ${alpha})`;
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function getTeamColor(tricode) {
  return teamColors[tricode] || "#2e7ac7";
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

function canUsePywebview() {
  return Boolean(window.pywebview && window.pywebview.api && window.pywebview.api.get_state);
}

async function getPreferences() {
  if (window.pywebview && window.pywebview.api && window.pywebview.api.get_preferences) {
    return window.pywebview.api.get_preferences();
  }
  return null;
}

async function saveUIPreferences() {
  const payload = getUIPreferencesPayload();
  if (window.pywebview && window.pywebview.api && window.pywebview.api.set_preferences) {
    return window.pywebview.api.set_preferences(payload);
  }
  return null;
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

async function getFavorites() {
  if (window.pywebview && window.pywebview.api && window.pywebview.api.get_favorites) {
    return window.pywebview.api.get_favorites();
  }
  return [];
}

async function saveFavoriteTeams() {
  const payload = [...favoriteTeams];
  if (window.pywebview && window.pywebview.api && window.pywebview.api.set_favorites) {
    return window.pywebview.api.set_favorites(payload);
  }
  return null;
}

async function hydrateFavorites() {
  const favorites = await getFavorites();
  favoriteTeams.clear();
  favorites.forEach((team) => favoriteTeams.add(team));
  renderGameList(lastGames);
}

async function hydratePreferences() {
  const preferences = await getPreferences();
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
  if (Object.prototype.hasOwnProperty.call(preferences, "notificationsEnabled")) {
    setNotifications(preferences.notificationsEnabled);
  }
  const nextZoom = String(preferences.zoomLevel || "1");
  zoomLevel = nextZoom;
  if (zoomSelect) {
    zoomSelect.value = nextZoom;
  }
  document.body.style.zoom = nextZoom;
}

function formatPct(value) {
  if (typeof value !== "number") return "--";
  return `${value.toFixed(1)}%`;
}

function formatShotPct(made, attempted) {
  if (!Number.isFinite(made) || !Number.isFinite(attempted) || attempted <= 0) {
    return "--";
  }
  return `${((made / attempted) * 100).toFixed(1)}%`;
}

function calcShotPct(made, attempted) {
  if (!Number.isFinite(made) || !Number.isFinite(attempted) || attempted <= 0) {
    return null;
  }
  return (made / attempted) * 100;
}

function calcTrueShooting(points, fga, fta) {
  const denom = 2 * (fga + 0.44 * fta);
  if (!Number.isFinite(points) || !Number.isFinite(denom) || denom <= 0) {
    return null;
  }
  return (points / denom) * 100;
}

function calcEfg(fgm, tpm, fga) {
  if (!Number.isFinite(fga) || fga <= 0) {
    return null;
  }
  return ((fgm + 0.5 * tpm) / fga) * 100;
}

function renderTeamCard(container, team) {
  container.className = "team-card";
  const color = getTeamColor(team.tricode);
  container.style.setProperty("--team-color", color);
  container.style.setProperty("--team-color-soft", toRgba(color, 0.35));
  const teamKey = `${team.id || ""}-${team.tricode || ""}`;
  if (teamKey && container.dataset.teamKey === teamKey && container.querySelector(".team-score")) {
    const name = container.querySelector(".team-name");
    if (name) {
      name.textContent = team.city;
    }
    const title = container.querySelector(".team-title");
    if (title) {
      title.textContent = `${team.name} (${team.tricode})`;
    }
    const score = container.querySelector(".team-score");
    if (score) {
      score.textContent = team.score ?? "-";
      animateScore(score, team);
    }
    const record = container.querySelector(".team-record");
    if (record) {
      record.textContent = formatRecord(team);
    }
    const fallback = container.querySelector(".team-logo-fallback");
    if (fallback) {
      fallback.textContent = team.tricode || "";
    }
    return;
  }

  container.dataset.teamKey = teamKey;
  container.innerHTML = "";

  const header = document.createElement("div");
  header.className = "team-header";

  const nameWrap = document.createElement("div");

  const name = document.createElement("div");
  name.className = "team-name";
  name.textContent = team.city;

  const title = document.createElement("div");
  title.className = "team-title";
  title.textContent = `${team.name} (${team.tricode})`;

  nameWrap.append(name, title);

  const logoWrap = document.createElement("div");
  logoWrap.className = "team-logo-wrap";

  const logo = document.createElement("img");
  logo.className = "team-logo";
  if (team.id) {
    logo.src = `/resources/logos/${team.id}.svg`;
  }
  logo.alt = `${team.name || "Team"} logo`;
  logo.loading = "lazy";
  logo.referrerPolicy = "no-referrer";
  logo.dataset.fallbackTried = "0";
  logo.onload = () => {
    logoWrap.classList.add("is-loaded");
  };
  logo.onerror = () => {
    logo.classList.add("is-hidden");
  };

  const fallback = document.createElement("div");
  fallback.className = "team-logo-fallback";
  fallback.textContent = team.tricode || "";

  logoWrap.append(logo, fallback);
  header.append(nameWrap, logoWrap);

  const score = document.createElement("div");
  score.className = "team-score";
  score.textContent = team.score ?? "-";
  animateScore(score, team);

  const record = document.createElement("div");
  record.className = "team-record";
  record.textContent = formatRecord(team);

  container.append(header, score, record);
}

function renderCenter(game) {
  centerCard.innerHTML = "";

  const status = document.createElement("div");
  status.className = "game-status";
  status.textContent = getGameStatusLabel(game);

  const clock = document.createElement("div");
  clock.className = "game-clock";
  const clockText = formatClock(game.clock);
  clock.textContent = clockText || "--:--";

  const period = document.createElement("div");
  period.className = "game-period";
  period.textContent = formatPeriodText(game);

  if (shouldShowPhase(game, clockText)) {
    const phase = document.createElement("div");
    phase.className = "game-phase";
    phase.textContent = game.statusText;
    centerCard.append(status, clock, period, phase);
    return;
  }

  centerCard.append(status, clock, period);
}

function formatPeriodText(game) {
  if (!game) return "";
  const period = Number.isFinite(game.period) ? game.period : Number(game.period);
  if (!Number.isFinite(period) || period <= 0) {
    return game.statusText || "";
  }
  if (period <= 4) {
    const suffix = period === 1 ? "st" : period === 2 ? "nd" : period === 3 ? "rd" : "th";
    return `${period}${suffix} Quarter`;
  }
  const ot = period - 4;
  return ot === 1 ? "OT" : `${ot}OT`;
}

function formatClock(value) {
  if (!value) return "";
  const text = String(value);
  const match = text.match(/PT(\d+)M(\d+(?:\.\d+)?)S/);
  if (!match) return text;
  const minutes = match[1].padStart(1, "0");
  const seconds = Math.floor(parseFloat(match[2])).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function animateScore(scoreEl, team) {
  const key = team.id || team.tricode || "";
  if (!key) return;
  const current = Number.isFinite(team.score) ? team.score : Number(team.score);
  if (!Number.isFinite(current)) return;
  const prev = lastScores.get(key);
  lastScores.set(key, current);
  if (prev === undefined || current <= prev) return;
  scoreEl.classList.remove("score-bump");
  void scoreEl.offsetWidth;
  scoreEl.classList.add("score-bump");
  setTimeout(() => {
    scoreEl.classList.remove("score-bump");
  }, 700);
}

function shouldShowPhase(game, clockText) {
  if (!game || !game.statusText) return false;
  if (!clockText) return true;
  if (clockText === "0:00") return true;
  if (game.statusText.toLowerCase() === "halftime") return true;
  return false;
}

function hasNotEntered(minutesValue) {
  if (!minutesValue) return true;
  const text = String(minutesValue).trim();
  if (text === "0:00" || text === "0") return true;
  const match = text.match(/PT(\d+)M(\d+(?:\.\d+)?)S/);
  if (match) {
    const minutes = Number(match[1]);
    const seconds = Number(match[2]);
    return minutes === 0 && seconds === 0;
  }
  return false;
}

function renderDetails(game) {
  let arena = "";
  if (game.arena) {
    const arenaParts = [game.arena.name, game.arena.city, game.arena.state].filter(Boolean);
    arena = arenaParts.join(", ");
  }

  let start = "";
  if (game.startTimeUTC) {
    const parsed = new Date(game.startTimeUTC);
    if (!Number.isNaN(parsed.valueOf())) {
      start = `Tipoff: ${parsed.toLocaleString()}`;
    } else {
      start = `Tipoff: ${game.startTimeUTC}`;
    }
  }

  detailsEl.textContent = [arena, start].filter(Boolean).join(" | ");
}

function buildTable(team, showTotals, hidePoints, targetRows, statsKey) {
  const wrapper = document.createElement("div");
  const table = document.createElement("table");
  table.className = "stats-table";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");

  const nameTh = document.createElement("th");
  nameTh.textContent = "PLAYER";
  headRow.appendChild(nameTh);

  columns.forEach((col) => {
    const th = document.createElement("th");
    th.textContent = col;
    headRow.appendChild(th);
  });

  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  const onCourt = new Set((team.onCourt || []).map((value) => String(value)));

  const prevStatsMap = statsKey ? lastPlayerStats.get(statsKey) : null;
  const nextStatsMap = statsKey ? new Map() : null;

  team.players.forEach((player) => {
    const row = document.createElement("tr");
    const personId = player.personId != null ? String(player.personId) : player.name || "";
    const prevStats = prevStatsMap && personId ? prevStatsMap.get(personId) : null;
    const currentStats = {};
    if (player.status && player.status !== "ACTIVE") {
      row.classList.add("player-inactive");
    }
    if (hasNotEntered(player.minutes)) {
      row.classList.add("player-dnp");
    }
    if (personId && onCourt.has(personId)) {
      row.classList.add("player-on-court");
    }

    const nameCell = document.createElement("td");
    const nameWrap = document.createElement("div");
    nameWrap.className = "player-name";

    const nameText = document.createElement("strong");
    nameText.textContent = player.name || "Unknown";

    const meta = document.createElement("span");
    const metaParts = [player.position, player.jerseyNum].filter(Boolean);
    meta.textContent = metaParts.join(" ");

    nameWrap.append(nameText, meta);

    if (player.position) {
      const starter = document.createElement("span");
      starter.className = "player-starter";
      starter.textContent = "S";
      nameWrap.appendChild(starter);
    }

    if (player.status && player.status !== "ACTIVE") {
      const status = document.createElement("span");
      status.className = "player-status";
      status.textContent = player.status;
      nameWrap.appendChild(status);
    }

    nameCell.appendChild(nameWrap);
    row.appendChild(nameCell);

    row.appendChild(cell(formatClock(player.minutes) || "0:00"));
    row.appendChild(buildStatCell(player.points, prevStats, "points", currentStats, statFlashEnabled));
    row.appendChild(buildStatCell(player.rebounds, prevStats, "rebounds", currentStats, statFlashEnabled));
    row.appendChild(buildStatCell(player.assists, prevStats, "assists", currentStats, statFlashEnabled));
    row.appendChild(buildStatCell(player.steals, prevStats, "steals", currentStats, statFlashEnabled));
    row.appendChild(buildStatCell(player.blocks, prevStats, "blocks", currentStats, statFlashEnabled));
    row.appendChild(buildStatCell(player.turnovers, prevStats, "turnovers", currentStats, statFlashEnabled));
    row.appendChild(buildStatCell(player.fouls, prevStats, "fouls", currentStats, statFlashEnabled));
    const fgLine = `${player.fgm}-${player.fga}`;
    const tpLine = `${player.tpm}-${player.tpa}`;
    const ftLine = `${player.ftm}-${player.fta}`;
    row.appendChild(buildStatCell(fgLine, prevStats, "fg", currentStats, statFlashEnabled));
    row.appendChild(buildStatCell(tpLine, prevStats, "tp", currentStats, statFlashEnabled));
    row.appendChild(buildStatCell(ftLine, prevStats, "ft", currentStats, statFlashEnabled));
    row.appendChild(buildStatCell(formatPct(player.tsPct), prevStats, "tsPct", currentStats, false));
    row.appendChild(buildStatCell(formatPct(player.efgPct), prevStats, "efgPct", currentStats, false));
    row.appendChild(buildStatCell(player.plusMinus, prevStats, "plusMinus", currentStats, false));

    if (nextStatsMap && personId) {
      nextStatsMap.set(personId, currentStats);
    }

    tbody.appendChild(row);
  });
  const padTarget = Number.isFinite(targetRows) ? Math.max(0, targetRows) : 0;
  const padCount = Math.max(0, padTarget - team.players.length);
  const spacer = "\u00A0";
  for (let i = 0; i < padCount; i += 1) {
    const row = document.createElement("tr");
    row.className = "player-empty";
    row.setAttribute("aria-hidden", "true");
    const nameCell = document.createElement("td");
    const nameWrap = document.createElement("div");
    nameWrap.className = "player-name";
    const nameText = document.createElement("strong");
    nameText.textContent = spacer;
    const nameMeta = document.createElement("span");
    nameMeta.textContent = spacer;
    nameWrap.append(nameText, nameMeta);
    nameCell.appendChild(nameWrap);
    row.appendChild(nameCell);
    columns.forEach(() => {
      const td = document.createElement("td");
      td.textContent = spacer;
      row.appendChild(td);
    });
    tbody.appendChild(row);
  }

  table.appendChild(tbody);
  if (nextStatsMap && statsKey) {
    lastPlayerStats.set(statsKey, nextStatsMap);
  }
  if (showTotals && Array.isArray(team.players) && team.players.length > 0) {
    const totals = team.players.reduce(
      (acc, player) => {
        acc.points += Number(player.points) || 0;
        acc.rebounds += Number(player.rebounds) || 0;
        acc.assists += Number(player.assists) || 0;
        acc.steals += Number(player.steals) || 0;
        acc.blocks += Number(player.blocks) || 0;
        acc.turnovers += Number(player.turnovers) || 0;
        acc.fouls += Number(player.fouls) || 0;
        acc.fgm += Number(player.fgm) || 0;
        acc.fga += Number(player.fga) || 0;
        acc.tpm += Number(player.tpm) || 0;
        acc.tpa += Number(player.tpa) || 0;
        acc.ftm += Number(player.ftm) || 0;
        acc.fta += Number(player.fta) || 0;
        return acc;
      },
      {
        points: 0,
        rebounds: 0,
        assists: 0,
        steals: 0,
        blocks: 0,
        turnovers: 0,
        fouls: 0,
        fgm: 0,
        fga: 0,
        tpm: 0,
        tpa: 0,
        ftm: 0,
        fta: 0,
      },
    );
    const tsPct = calcTrueShooting(totals.points, totals.fga, totals.fta);
    const efgPct = calcEfg(totals.fgm, totals.tpm, totals.fga);

    const tfoot = document.createElement("tfoot");
    const totalRow = document.createElement("tr");
    totalRow.className = "total-row";

    const totalLabel = document.createElement("td");
    totalLabel.textContent = "TEAM TOTAL";
    totalRow.appendChild(totalLabel);

    totalRow.appendChild(cell(""));
    totalRow.appendChild(cell(hidePoints ? "" : totals.points));
    totalRow.appendChild(cell(totals.rebounds));
    totalRow.appendChild(cell(totals.assists));
    totalRow.appendChild(cell(totals.steals));
    totalRow.appendChild(cell(totals.blocks));
    totalRow.appendChild(cell(totals.turnovers));
    totalRow.appendChild(cell(totals.fouls));
    totalRow.appendChild(cell(`${totals.fgm}-${totals.fga}`));
    totalRow.appendChild(cell(`${totals.tpm}-${totals.tpa}`));
    totalRow.appendChild(cell(`${totals.ftm}-${totals.fta}`));
    totalRow.appendChild(cell(formatPct(tsPct)));
    totalRow.appendChild(cell(formatPct(efgPct)));
    totalRow.appendChild(cell(""));

    tfoot.appendChild(totalRow);
    table.appendChild(tfoot);
  }
  wrapper.appendChild(table);
  return wrapper;
}

function renderTeamTable(container, team, cacheKey, showTotals, hidePoints, targetRows) {
  if (!container) return;
  const hash = JSON.stringify({
    players: team.players,
    stats: team.stats,
    onCourt: team.onCourt,
    showTotals,
    hidePoints,
    targetRows,
  });
  const cached = tableCache.get(cacheKey);
  if (cached && cached.hash === hash) {
    return;
  }
  container.innerHTML = "";
  const hasPlayers = Array.isArray(team.players) && team.players.length > 0;
  if (!hasPlayers) {
    container.classList.remove("is-hidden");
    const empty = document.createElement("div");
    empty.className = "table-placeholder";
    empty.textContent = "Box score pending.";
    container.appendChild(empty);
    lastPlayerStats.delete(cacheKey);
    tableCache.set(cacheKey, { hash });
    return;
  }
  container.classList.remove("is-hidden");
  const statsKey = cacheKey;
  container.appendChild(buildTable(team, showTotals, hidePoints, targetRows, statsKey));
  tableCache.set(cacheKey, { hash });
}

function cell(value) {
  const td = document.createElement("td");
  td.textContent = value ?? "-";
  return td;
}

function normalizeStatValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    return Number.isNaN(value) ? null : value;
  }
  return String(value);
}

function buildStatCell(value, prevStats, statKey, currentStats, allowBump = true) {
  const td = cell(value);
  const normalized = normalizeStatValue(value);
  const hasPrev = prevStats && Object.prototype.hasOwnProperty.call(prevStats, statKey);
  if (allowBump && hasPrev && prevStats[statKey] !== normalized) {
    td.classList.add("stat-bump");
  }
  currentStats[statKey] = normalized;
  return td;
}

function setStatFlash(enabled) {
  statFlashEnabled = Boolean(enabled);
  if (statFlashToggleBtn) {
    statFlashToggleBtn.textContent = statFlashEnabled ? "Stat Flash: On" : "Stat Flash: Off";
  }
}

function setNotifications(enabled) {
  notificationsEnabled = Boolean(enabled);
  if (notificationsToggleBtn) {
    notificationsToggleBtn.textContent = notificationsEnabled ? "Notifications: On" : "Notifications: Off";
  }
}

function clearDataBanner() {
  if (!dataBannerEl) return;
  dataBannerEl.hidden = true;
  dataBannerEl.className = "data-banner";
  dataBannerEl.innerHTML = "";
}

function renderDataBanner(dataStatus) {
  if (!dataBannerEl) return;
  if (!dataStatus || !dataStatus.level || dataStatus.level === "fresh") {
    clearDataBanner();
    return;
  }

  dataBannerEl.hidden = false;
  dataBannerEl.className = `data-banner data-banner--${dataStatus.level}`;
  dataBannerEl.innerHTML = "";

  const title = document.createElement("div");
  title.className = "data-banner__title";
  title.textContent = dataStatus.title || "Data status";

  const message = document.createElement("div");
  message.className = "data-banner__message";
  message.textContent = dataStatus.message || "";

  const meta = document.createElement("div");
  meta.className = "data-banner__meta";
  const metaParts = [];
  const updatedAt = parseUpdated(dataStatus.updated);
  if (updatedAt) {
    metaParts.push(`Last box score ${formatRelativeTime(Math.max(0, (Date.now() - updatedAt) / 1000))}`);
  }
  if (Array.isArray(dataStatus.issues) && dataStatus.issues.length) {
    metaParts.push(dataStatus.issues.join(" | "));
  }
  meta.textContent = metaParts.join(" | ");

  dataBannerEl.append(title, message);
  if (meta.textContent) {
    dataBannerEl.appendChild(meta);
  }
}

function renderHeaders(home, away) {
  awayHeader.innerHTML = "";
  homeHeader.innerHTML = "";

  const awayTitle = document.createElement("div");
  awayTitle.className = "table-title";
  awayTitle.append(buildLogoBadge(away), document.createTextNode(`${away.name} (${away.tricode})`));

  const awaySub = document.createElement("div");
  awaySub.className = "table-subtitle";
  awaySub.textContent = formatStatLine(away);

  awayHeader.append(awayTitle, awaySub);

  const homeTitle = document.createElement("div");
  homeTitle.className = "table-title";
  homeTitle.append(buildLogoBadge(home), document.createTextNode(`${home.name} (${home.tricode})`));

  const homeSub = document.createElement("div");
  homeSub.className = "table-subtitle";
  homeSub.textContent = formatStatLine(home);

  homeHeader.append(homeTitle, homeSub);
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

function renderPeriods(periods, home, away) {
  periodsEl.innerHTML = "";
  if (!periods || !periods.length) {
    if (periodsToggleBtn) {
      periodsToggleBtn.disabled = true;
    }
    return;
  }
  if (periodsToggleBtn) {
    periodsToggleBtn.disabled = false;
  }

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");

  const labelTh = document.createElement("th");
  labelTh.textContent = "Period";
  headRow.appendChild(labelTh);

  periods.forEach((period) => {
    const th = document.createElement("th");
    th.textContent = period.label;
    headRow.appendChild(th);
  });

  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  const awayRow = document.createElement("tr");
  const awayLabel = document.createElement("td");
  awayLabel.textContent = `${away.tricode} pts`;
  awayRow.appendChild(awayLabel);

  periods.forEach((period) => {
    awayRow.appendChild(cell(period.away));
  });

  const homeRow = document.createElement("tr");
  const homeLabel = document.createElement("td");
  homeLabel.textContent = `${home.tricode} pts`;
  homeRow.appendChild(homeLabel);

  periods.forEach((period) => {
    homeRow.appendChild(cell(period.home));
  });

  tbody.append(awayRow, homeRow);
  table.appendChild(tbody);
  periodsEl.appendChild(table);
}

function setPeriodsOpen(open) {
  if (!periodsEl || !periodsToggleBtn) return;
  periodsOpen = Boolean(open);
  periodsEl.classList.toggle("is-collapsed", !open);
  periodsToggleBtn.textContent = open ? "Quarters: Hide" : "Quarters: Show";
}

function setComparisonOpen(open) {
  if (!comparisonEl || !comparisonToggleBtn) return;
  comparisonOpen = Boolean(open);
  comparisonEl.classList.toggle("is-collapsed", !open);
  comparisonToggleBtn.textContent = open ? "Comparison: Hide" : "Comparison: Show";
}

function renderComparison(home, away) {
  if (!comparisonEl || !comparisonBodyEl) return;
  if (!home || !away || !home.stats || !away.stats) {
    comparisonBodyEl.innerHTML = "";
    if (comparisonToggleBtn) {
      comparisonToggleBtn.disabled = true;
    }
    return;
  }

  comparisonBodyEl.innerHTML = "";
  comparisonEl.style.setProperty("--away-color", getTeamColor(away.tricode));
  comparisonEl.style.setProperty("--home-color", getTeamColor(home.tricode));
  if (comparisonToggleBtn) {
    comparisonToggleBtn.disabled = false;
  }

  const rows = document.createElement("div");
  rows.className = "comparison__rows";

  const items = [
    {
      label: "FG%",
      awayValue: calcShotPct(away.stats.fgm, away.stats.fga),
      homeValue: calcShotPct(home.stats.fgm, home.stats.fga),
      awayText: formatShotPct(away.stats.fgm, away.stats.fga),
      homeText: formatShotPct(home.stats.fgm, home.stats.fga),
    },
    {
      label: "3PT%",
      awayValue: calcShotPct(away.stats.tpm, away.stats.tpa),
      homeValue: calcShotPct(home.stats.tpm, home.stats.tpa),
      awayText: formatShotPct(away.stats.tpm, away.stats.tpa),
      homeText: formatShotPct(home.stats.tpm, home.stats.tpa),
    },
    {
      label: "FT%",
      awayValue: calcShotPct(away.stats.ftm, away.stats.fta),
      homeValue: calcShotPct(home.stats.ftm, home.stats.fta),
      awayText: formatShotPct(away.stats.ftm, away.stats.fta),
      homeText: formatShotPct(home.stats.ftm, home.stats.fta),
    },
    {
      label: "REB",
      awayValue: away.stats.rebounds,
      homeValue: home.stats.rebounds,
      awayText: away.stats.rebounds ?? "-",
      homeText: home.stats.rebounds ?? "-",
    },
    {
      label: "AST",
      awayValue: away.stats.assists,
      homeValue: home.stats.assists,
      awayText: away.stats.assists ?? "-",
      homeText: home.stats.assists ?? "-",
    },
    {
      label: "TO",
      awayValue: away.stats.turnovers,
      homeValue: home.stats.turnovers,
      awayText: away.stats.turnovers ?? "-",
      homeText: home.stats.turnovers ?? "-",
    },
  ];

  items.forEach((item) => {
    const row = document.createElement("div");
    row.className = "comparison__row";

    const label = document.createElement("div");
    label.className = "comparison__label";
    label.textContent = item.label;

    const values = document.createElement("div");
    values.className = "comparison__values";

    const awayVal = document.createElement("div");
    awayVal.className = "comparison__value comparison__value--away";
    awayVal.textContent = item.awayText;

    const homeVal = document.createElement("div");
    homeVal.className = "comparison__value comparison__value--home";
    homeVal.textContent = item.homeText;

    const bar = document.createElement("div");
    bar.className = "comparison__bar";
    const barFill = document.createElement("div");
    barFill.className = "comparison__bar-fill";
    bar.appendChild(barFill);

    let awayRatio = 0.5;
    if (Number.isFinite(item.awayValue) && Number.isFinite(item.homeValue)) {
      const total = item.awayValue + item.homeValue;
      if (total > 0) {
        awayRatio = item.awayValue / total;
      }
    }
    if (Number.isFinite(item.awayValue) && Number.isFinite(item.homeValue)) {
      const favorAway = item.label === "TO" ? item.awayValue < item.homeValue : item.awayValue > item.homeValue;
      if (favorAway) {
        awayVal.classList.add("is-lead");
      } else if (item.awayValue !== item.homeValue) {
        homeVal.classList.add("is-lead");
      }
    }
    barFill.style.setProperty("--away-ratio", awayRatio);

    values.append(awayVal, bar, homeVal);
    row.append(label, values);
    rows.appendChild(row);
  });

  comparisonBodyEl.appendChild(rows);
}

function renderLineups(home, away, isLive) {
  if (!lineupsEl || !awayLineupEl || !homeLineupEl || !awayLineupTitleEl || !homeLineupTitleEl) return;
  if (isLive) {
    lineupsEl.classList.add("is-hidden");
    awayLineupEl.innerHTML = "";
    homeLineupEl.innerHTML = "";
    return;
  }
  const awayStarters = (away.players || []).filter((player) => player.starter).slice(0, 5);
  const homeStarters = (home.players || []).filter((player) => player.starter).slice(0, 5);

  if (!awayStarters.length && !homeStarters.length) {
    lineupsEl.classList.add("is-hidden");
    awayLineupEl.innerHTML = "";
    homeLineupEl.innerHTML = "";
    return;
  }

  lineupsEl.classList.remove("is-hidden");
  awayLineupTitleEl.textContent = `${away.tricode || ""} Starters`;
  homeLineupTitleEl.textContent = `${home.tricode || ""} Starters`;

  awayLineupEl.innerHTML = "";
  homeLineupEl.innerHTML = "";

  awayStarters.forEach((player) => {
    awayLineupEl.appendChild(buildLineupRow(player));
  });
  homeStarters.forEach((player) => {
    homeLineupEl.appendChild(buildLineupRow(player));
  });
}

function buildLineupRow(player) {
  const row = document.createElement("div");
  row.className = "lineup-row";

  const name = document.createElement("span");
  name.className = "lineup-row__name";
  name.textContent = player.name || "Unknown";

  const meta = document.createElement("span");
  meta.className = "lineup-row__meta";
  const minutes = formatClock(player.minutes) || "0:00";
  const points = Number.isFinite(player.points) ? `${player.points} PTS` : "-- PTS";
  const plusMinus = Number.isFinite(player.plusMinus) ? `+/- ${player.plusMinus}` : "";
  meta.textContent = [player.position || "-", minutes, points, plusMinus].filter(Boolean).join(" | ");

  row.append(name, meta);
  return row;
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

function setSelectedGameId(gameId) {
  const previousGameId = selectedGameId;
  selectedGameId = gameId || "";
  const changed = previousGameId !== selectedGameId;
  renderGameList(lastGames);
  if (selectedGameId) {
    showGameView();
    refreshDetail({ bypassThrottle: changed });
  } else {
    showListView();
    clearDetailRefreshTimer();
  }
}

function fallbackForStatus(status, statusText) {
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

function formatGameStatus(game) {
  const statusKey = getGameStatusKey(game);
  if (statusKey === "scheduled") {
    const special = getNonTimeStatusText(game && game.statusText);
    return special || getGameStatusLabel(game);
  }
  if (statusKey === "live") return "Live <span class=\"status-live\">&#9679;</span>";
  if (statusKey === "final") return getGameStatusLabel(game);
  return getGameStatusLabel(game);
}

function formatLivePhaseText(game, clockText) {
  if (getGameStatusKey(game) !== "live") return "";
  if (!shouldShowPhase(game, clockText)) return "";
  return getNonTimeStatusText(game && game.statusText);
}

function formatTipoff(value) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    return value;
  }
  const now = new Date();
  const sameDay =
    parsed.getFullYear() === now.getFullYear() &&
    parsed.getMonth() === now.getMonth() &&
    parsed.getDate() === now.getDate();
  if (sameDay) {
    return parsed.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  const dateText = parsed.toLocaleDateString([], { month: "short", day: "numeric" });
  const timeText = parsed.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `${dateText}, ${timeText}`;
}

function getGameSectionKey(game) {
  const statusKey = getGameStatusKey(game);
  if (statusKey === "live") return "live";
  if (statusKey === "final") return "finished";
  return "scheduled";
}

function getGameSectionTitle(sectionKey) {
  if (sectionKey === "live") return "Live Games";
  if (sectionKey === "finished") return "Finished Games";
  return "Scheduled Games";
}

function formatSelectedGameLabel(game) {
  const away = game && game.away ? game.away : {};
  const home = game && game.home ? game.home : {};
  return `${away.tricode || ""} @ ${home.tricode || ""}`.trim() || game.matchup || "Selected game";
}

function getTipoffTimestamp(game) {
  if (!game || !game.startTimeUTC) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(game.startTimeUTC);
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

function getGameImportanceRank(game) {
  const sectionKey = getGameSectionKey(game);
  const favorite = isFavoriteGame(game);
  if (favorite && sectionKey === "live") return 0;
  if (sectionKey === "live") return 1;
  if (favorite && sectionKey === "scheduled") return 2;
  if (sectionKey === "scheduled") return 3;
  if (favorite && sectionKey === "finished") return 4;
  return 5;
}

function matchesGameSearch(game) {
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

function matchesGameFilter(game) {
  if (gameFilter === "all") return true;
  if (gameFilter === "favorites") return isFavoriteGame(game);
  return getGameSectionKey(game) === gameFilter;
}

function sortGamesForList(games) {
  const withIndex = games.map((game, index) => ({ game, index }));
  withIndex.sort((a, b) => {
    if (gameSort === "tipoff") {
      const tipoffDiff = getTipoffTimestamp(a.game) - getTipoffTimestamp(b.game);
      if (tipoffDiff !== 0) return tipoffDiff;
      const importanceDiff = getGameImportanceRank(a.game) - getGameImportanceRank(b.game);
      if (importanceDiff !== 0) return importanceDiff;
      return a.index - b.index;
    }

    const importanceDiff = getGameImportanceRank(a.game) - getGameImportanceRank(b.game);
    if (importanceDiff !== 0) return importanceDiff;
    const tipoffDiff = getTipoffTimestamp(a.game) - getTipoffTimestamp(b.game);
    if (tipoffDiff !== 0) return tipoffDiff;
    return a.index - b.index;
  });
  return withIndex.map(({ game }) => game);
}

function buildMetaChip(text, variant = "") {
  const chip = document.createElement("span");
  chip.className = variant ? `game-chip game-chip--${variant}` : "game-chip";
  chip.textContent = text;
  return chip;
}

function formatPeriodChip(game) {
  if (!game || !game.period) return "";
  const period = Number.isFinite(game.period) ? game.period : Number(game.period);
  if (!Number.isFinite(period) || period <= 0) return "";
  if (period <= 4) return `Q${period}`;
  const ot = period - 4;
  return ot === 1 ? "OT" : `${ot}OT`;
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

function getGameListItemHash(game) {
  const away = game.away || {};
  const home = game.home || {};
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
    favorite: isFavoriteGame(game),
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

  button.dataset.renderHash = renderHash;
  button.className = "game-item";
  if (isFavoriteGame(game)) {
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

function getEmptyGameListMessage(hasGames) {
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

function renderGameList(games) {
  if (!gamesEl) return;
  lastGames = games || [];

  let selectedLabel = "Select a game";
  const allGames = games || [];
  allGames.forEach((game) => {
    if (selectedGameId && game.gameId === selectedGameId) {
      selectedLabel = formatSelectedGameLabel(game);
    }
  });

  const visibleGames = sortGamesForList(allGames.filter((game) => matchesGameFilter(game) && matchesGameSearch(game)));

  if (!visibleGames.length) {
    const empty = document.createElement("div");
    empty.className = "game-list__empty";
    empty.textContent = getEmptyGameListMessage(allGames.length > 0);
    gamesEl.replaceChildren(empty);
    if (selectedGameEl) {
      selectedGameEl.textContent = allGames.length ? selectedLabel : "No games today";
    }
    if (selectedGameViewEl) {
      selectedGameViewEl.textContent = allGames.length ? selectedLabel : "No games today";
    }
    if (clearSelectionBtn) {
      clearSelectionBtn.disabled = !selectedGameId;
    }
    return;
  }

  const favoriteGames = [];
  const sectionOrder = ["live", "scheduled", "finished"];
  const sectionGames = new Map(sectionOrder.map((key) => [key, []]));

  visibleGames.forEach((game) => {
    if (isFavoriteGame(game)) {
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
  if (clearSelectionBtn) {
    clearSelectionBtn.disabled = !selectedGameId;
  }
}

function updateGameFilterUI() {
  if (!gameFiltersEl) return;
  const buttons = gameFiltersEl.querySelectorAll("[data-filter]");
  buttons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.filter === gameFilter);
  });
}

function buildLogoBadge(team) {
  const wrap = document.createElement("span");
  wrap.className = "logo-badge";
  if (!team || !team.id) {
    wrap.textContent = team?.tricode || "";
    return wrap;
  }

  const img = document.createElement("img");
  img.src = `/resources/logos/${team.id}.svg`;
  img.alt = `${team.name || "Team"} logo`;
  img.loading = "lazy";

  img.onerror = () => {
    wrap.textContent = team.tricode || "";
    img.remove();
  };

  wrap.appendChild(img);
  return wrap;
}

function buildScoreBadge(score) {
  const badge = document.createElement("span");
  badge.className = "game-item__score";
  badge.textContent = Number.isFinite(score) ? score : score ?? "-";
  return badge;
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

function buildHeartIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute(
    "d",
    "M12 21s-6.4-4.2-9.1-7.4C.8 11.2 1 7.7 3.5 5.6c2-1.7 4.9-1.4 6.7.6L12 8l1.8-1.8c1.8-2 4.7-2.3 6.7-.6 2.5 2.1 2.7 5.6.6 8-2.7 3.2-9.1 7.4-9.1 7.4z",
  );
  svg.appendChild(path);
  return svg;
}

function isFavoriteGame(game) {
  if (!game) return false;
  const away = (game.away || {}).tricode;
  const home = (game.home || {}).tricode;
  return (away && favoriteTeams.has(away)) || (home && favoriteTeams.has(home));
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

function getUIPreferencesPayload() {
  return {
    scoreboardView,
    tableView,
    zoomLevel,
    statFlashEnabled,
    notificationsEnabled,
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
  if (canUsePywebview() && window.pywebview.api.get_scoreboard) {
    const view = getScoreboardView();
    return window.pywebview.api.get_scoreboard(selectedGameId || null, view, notificationsEnabled);
  }
  if (canUsePywebview()) {
    const view = getScoreboardView();
    return window.pywebview.api.get_state(null, view, notificationsEnabled);
  }
  return {
    status: "error",
    updated: new Date().toISOString(),
    error: "pywebview API not available. Run nba-live-scoreboard.py.",
  };
}

async function getDetailState() {
  if (canUsePywebview()) {
    const view = getScoreboardView();
    return window.pywebview.api.get_state(selectedGameId || null, view, notificationsEnabled);
  }
  return {
    status: "error",
    updated: new Date().toISOString(),
    error: "pywebview API not available. Run nba-live-scoreboard.py.",
  };
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

    if (state.games && gamesEl) {
      renderGameList(state.games);
      if (selectedGameId && !state.games.some((game) => game.gameId === selectedGameId)) {
        setSelectedGameId("");
        return;
      }
    }

    if (!selectedGameId) {
      setUpdatedTime(state.updated);
      if (state.status === "no_games") {
        statusEl.textContent = "No games";
      } else if (state.hasLiveGames) {
        statusEl.textContent = "Live games";
      } else {
        statusEl.textContent = "Today";
      }
    }

    if (state.status === "no_games" && !selectedGameId) {
      showListView();
      clearGameUI();
    }

    if (state.status === "error") {
      scheduleScoreboardRefresh(getRefreshDelay(state, SCOREBOARD_IDLE_REFRESH_MS));
      return;
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
  try {
    let state;
    try {
      state = await getDetailState();
    } catch (err) {
      statusEl.textContent = "error";
      clearDataBanner();
      renderFallback(`API error: ${err}`);
      scheduleDetailRefresh(DETAIL_IDLE_REFRESH_MS);
      return;
    }

    setUpdatedTime(state.dataUpdated || state.updated);

    if (state.games && gamesEl) {
      renderGameList(state.games);
    }

    if (state.status !== "ok" && state.status !== "scheduled" && state.status !== "postgame" && state.status !== "live_no_data") {
      statusEl.textContent = state.status.replace(/_/g, " ");
      clearDataBanner();
      renderFallback(state.error || fallbackForStatus(state.status, state.game && state.game.statusText));
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
      renderFallback(fallbackForStatus(state.status, state.game && state.game.statusText));
    } else {
      clearFallback();
    }
    renderDataBanner(state.dataStatus);
    statusEl.textContent = state.game.statusText || getGameStatusLabel(state.game);
    showGameView();
    const home = state.home;
    const away = state.away;

    renderTeamCard(awayCard, away);
    renderTeamCard(homeCard, home);
    renderCenter(state.game);
    renderDetails(state.game);
    renderHeaders(home, away);
    renderPeriods(state.periods, home, away);
    renderComparison(home, away);
    renderLineups(home, away, state.status === "ok");
    applyMatchupTheme(home, away);

    const showTotals = state.status === "ok";
    const hidePoints = scoreboardEl && scoreboardEl.classList.contains("is-hidden");
    const awayCount = Array.isArray(away.players) ? away.players.length : 0;
    const homeCount = Array.isArray(home.players) ? home.players.length : 0;
    const targetRows = Math.max(awayCount, homeCount);
    renderTeamTable(awayTable, away, `away-${away.id || away.tricode || "team"}`, showTotals, hidePoints, targetRows);
    renderTeamTable(homeTable, home, `home-${home.id || home.tricode || "team"}`, showTotals, hidePoints, targetRows);
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
  setScoreboardView(scoreboardView);
  setTableView(tableView);
  setStatFlash(statFlashEnabled);
  setNotifications(notificationsEnabled);
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
    setPeriodsOpen(periodsOpen);
    periodsToggleBtn.addEventListener("click", () => {
      setPeriodsOpen(!periodsOpen);
    });
  }

  if (comparisonToggleBtn) {
    setComparisonOpen(comparisonOpen);
    comparisonToggleBtn.addEventListener("click", () => {
      setComparisonOpen(!comparisonOpen);
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

  if (notificationsToggleBtn) {
    notificationsToggleBtn.addEventListener("click", () => {
      setNotifications(!notificationsEnabled);
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
