const LIVE_REFRESH_MS = 10000;
const IDLE_REFRESH_MS = 20000;
let refreshTimer = null;
let refreshIntervalMs = LIVE_REFRESH_MS;
let isRefreshing = false;

const updatedEl = document.getElementById("updated");
const statusEl = document.getElementById("status");
const awayCard = document.getElementById("away-card");
const homeCard = document.getElementById("home-card");
const centerCard = document.getElementById("game-center");
const statusRibbonEl = document.getElementById("status-ribbon");
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
const selectedGameEl = document.getElementById("selected-game");
const selectedGameViewEl = document.getElementById("selected-game-view");
const clearSelectionBtn = document.getElementById("clear-selection");
const listViewEl = document.getElementById("list-view");
const gameViewEl = document.getElementById("game-view");
const backBtn = document.getElementById("back-to-list");
const tableToggleBtn = document.getElementById("table-toggle");
const fallbackEl = document.getElementById("fallback");
const scoreboardEl = document.getElementById("scoreboard");
const toggleBtn = document.getElementById("scoreboard-toggle");
const refreshBtn = document.getElementById("refresh-now");
const zoomSelect = document.getElementById("zoom-select");
const appRoot = document.getElementById("app");
const refreshLabel = refreshBtn ? refreshBtn.textContent : "Refresh";
let activeCell = null;
let selectedGameId = localStorage.getItem("nba-selected-game") || "";
let lastUpdatedAt = null;
let updatedTimer = null;
let lastGames = [];
const favoriteTeams = new Set();
const lastScores = new Map();
const notifiedGames = new Set(loadNotifiedGames());
const lastGameStatuses = new Map();
const tableCache = new Map();
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

function getStatusCode(game) {
  if (!game) return null;
  const status = Number.isFinite(game.status) ? game.status : Number(game.status);
  return Number.isNaN(status) ? null : status;
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

function loadFavoriteTeamsFromStorage() {
  try {
    const raw = localStorage.getItem("nba-favorite-teams");
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function saveFavoriteTeamsToStorage() {
  localStorage.setItem("nba-favorite-teams", JSON.stringify([...favoriteTeams]));
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
  if (favoriteTeams.size && window.Notification && Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
}

async function getFavorites() {
  if (window.pywebview && window.pywebview.api && window.pywebview.api.get_favorites) {
    return window.pywebview.api.get_favorites();
  }
  try {
    const response = await fetch("/api/favorites", { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response.json();
  } catch (err) {
    return loadFavoriteTeamsFromStorage();
  }
}

async function saveFavoriteTeams() {
  const payload = [...favoriteTeams];
  saveFavoriteTeamsToStorage();
  if (window.pywebview && window.pywebview.api && window.pywebview.api.set_favorites) {
    return window.pywebview.api.set_favorites(payload);
  }
  try {
    await fetch("/api/favorites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    // Ignore save failures; localStorage will persist for this origin.
  }
}

async function hydrateFavorites() {
  const favorites = await getFavorites();
  favoriteTeams.clear();
  favorites.forEach((team) => favoriteTeams.add(team));
  renderGameList(lastGames);
}

function loadNotifiedGames() {
  try {
    const raw = localStorage.getItem("nba-notified-games");
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function saveNotifiedGames() {
  localStorage.setItem("nba-notified-games", JSON.stringify([...notifiedGames]));
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
  status.textContent = game.status;

  const clock = document.createElement("div");
  clock.className = "game-clock";
  const clockText = formatClock(game.clock);
  clock.textContent = clockText || "--:--";

  const period = document.createElement("div");
  period.className = "game-period";
  period.textContent = game.period ? `Period ${game.period}` : game.statusText;

  if (shouldShowPhase(game, clockText)) {
    const phase = document.createElement("div");
    phase.className = "game-phase";
    phase.textContent = game.statusText;
    centerCard.append(status, clock, period, phase);
    return;
  }

  centerCard.append(status, clock, period);
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

function buildTable(team, showTotals, hidePoints) {
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

  team.players.forEach((player) => {
    const row = document.createElement("tr");
    const personId = player.personId != null ? String(player.personId) : "";
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
    meta.textContent = `${player.position || "-"} ${player.jerseyNum || ""}`.trim();

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
    row.appendChild(cell(player.points));
    row.appendChild(cell(player.rebounds));
    row.appendChild(cell(player.assists));
    row.appendChild(cell(player.steals));
    row.appendChild(cell(player.blocks));
    row.appendChild(cell(player.turnovers));
    row.appendChild(cell(player.fouls));
    row.appendChild(cell(`${player.fgm}-${player.fga}`));
    row.appendChild(cell(`${player.tpm}-${player.tpa}`));
    row.appendChild(cell(`${player.ftm}-${player.fta}`));
    row.appendChild(cell(formatPct(player.tsPct)));
    row.appendChild(cell(formatPct(player.efgPct)));
    row.appendChild(cell(player.plusMinus));

    tbody.appendChild(row);
  });

  table.appendChild(tbody);
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

function renderTeamTable(container, team, cacheKey, showTotals, hidePoints) {
  if (!container) return;
  const hash = JSON.stringify({ players: team.players, stats: team.stats, onCourt: team.onCourt, showTotals, hidePoints });
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
    tableCache.set(cacheKey, { hash });
    return;
  }
  container.classList.remove("is-hidden");
  container.appendChild(buildTable(team, showTotals, hidePoints));
  tableCache.set(cacheKey, { hash });
}

function cell(value) {
  const td = document.createElement("td");
  td.textContent = value ?? "-";
  return td;
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
  periodsEl.classList.toggle("is-collapsed", !open);
  periodsToggleBtn.textContent = open ? "Quarters: Hide" : "Quarters: Show";
  localStorage.setItem("nba-periods-open", open ? "1" : "0");
}

function setComparisonOpen(open) {
  if (!comparisonEl || !comparisonToggleBtn) return;
  comparisonEl.classList.toggle("is-collapsed", !open);
  comparisonToggleBtn.textContent = open ? "Comparison: Hide" : "Comparison: Show";
  localStorage.setItem("nba-comparison-open", open ? "1" : "0");
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
  selectedGameId = gameId || "";
  if (selectedGameId) {
    localStorage.setItem("nba-selected-game", selectedGameId);
    showGameView();
  } else {
    localStorage.removeItem("nba-selected-game");
    showListView();
  }
  refresh();
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
  awayHeader.innerHTML = "";
  homeHeader.innerHTML = "";
  awayTable.innerHTML = "";
  homeTable.innerHTML = "";
}

function formatGameStatus(game) {
  const status = getStatusCode(game);
  if (status === 1) {
    const special = getNonTimeStatusText(game && game.statusText);
    return special || "Scheduled";
  }
  if (status === 2) return "Live <span class=\"status-live\">&#9679;</span>";
  if (status === 3) return "Final";
  return game.statusText || "Unknown";
}

function formatLivePhaseText(game, clockText) {
  if (getStatusCode(game) !== 2) return "";
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

function renderGameList(games) {
  if (!gamesEl) return;
  lastGames = games || [];
  gamesEl.innerHTML = "";

  if (!games || !games.length) {
    const empty = document.createElement("div");
    empty.className = "game-list__empty";
    empty.textContent = "No games found.";
    gamesEl.appendChild(empty);
    if (selectedGameEl) {
      selectedGameEl.textContent = "No games today";
    }
    if (selectedGameViewEl) {
      selectedGameViewEl.textContent = "No games today";
    }
    if (clearSelectionBtn) {
      clearSelectionBtn.disabled = true;
    }
    return;
  }

  let selectedLabel = "Select a game";

  const withIndex = games.map((game, index) => ({ game, index }));
  withIndex.sort((a, b) => {
    const aFav = isFavoriteGame(a.game);
    const bFav = isFavoriteGame(b.game);
    if (aFav !== bFav) return aFav ? -1 : 1;
    return a.index - b.index;
  });

  const hasFavorites = withIndex.some(({ game }) => isFavoriteGame(game));
  let favoritesLabelShown = false;
  let allLabelShown = false;

  withIndex.forEach(({ game }) => {
    if (hasFavorites && isFavoriteGame(game) && !favoritesLabelShown) {
      const label = document.createElement("div");
      label.className = "game-list__section";
      label.textContent = "Favorites";
      gamesEl.appendChild(label);
      favoritesLabelShown = true;
    }
    if (hasFavorites && !isFavoriteGame(game) && !allLabelShown) {
      const label = document.createElement("div");
      label.className = "game-list__section";
      label.textContent = "All games";
      gamesEl.appendChild(label);
      allLabelShown = true;
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "game-item";
    button.dataset.gameId = game.gameId;
    if (isFavoriteGame(game)) {
      button.classList.add("game-item--favorite");
    }

    if (selectedGameId && game.gameId === selectedGameId) {
      button.classList.add("is-selected");
      const away = game.away || {};
      const home = game.home || {};
      selectedLabel = `${away.tricode || ""} @ ${home.tricode || ""}`.trim() || game.matchup || "Selected game";
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
    const statusCode = getStatusCode(game);
    const showScore = statusCode === 2 || statusCode === 3;
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

    const meta = document.createElement("div");
    meta.className = "game-item__meta";
    const statusHtml = formatGameStatus(game);
    const tipoff = formatTipoff(game.startTimeUTC);
    const clock = formatClock(game.clock);
    const period = game.period ? `P${game.period}` : "";
    const phase = formatLivePhaseText(game, clock);
    meta.innerHTML = [statusHtml, clock, period, phase, tipoff].filter(Boolean).join(" | ");

    button.append(title, meta);
    button.addEventListener("click", () => {
      setSelectedGameId(game.gameId);
    });

    gamesEl.appendChild(button);
  });

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

function renderStatusRibbon(state) {
  if (!statusRibbonEl || !state || !state.game) return;
  let text = state.game.statusText || state.game.status;
  if (state.status === "scheduled") {
    text = state.game.statusText || "Scheduled";
  } else if (state.status === "postgame") {
    text = "Final - box score pending";
  } else if (state.status === "live_no_data") {
    text = "Live - box score loading";
  }
  if (!text) {
    statusRibbonEl.textContent = "";
    statusRibbonEl.classList.remove("is-visible");
    return;
  }
  statusRibbonEl.textContent = text;
  statusRibbonEl.classList.add("is-visible");
}

function applyMatchupTheme(home, away) {
  if (!gameViewEl) return;
  const homeColor = getTeamColor(home.tricode);
  const awayColor = getTeamColor(away.tricode);
  gameViewEl.style.setProperty("--matchup-a", toRgba(awayColor, 0.18));
  gameViewEl.style.setProperty("--matchup-b", toRgba(homeColor, 0.18));
}

function maybeNotifyGameStart(games) {
  if (!games || !games.length) return;
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;

  games.forEach((game) => {
    if (!isFavoriteGame(game)) return;
    const statusCode = getStatusCode(game);
    const prevStatus = lastGameStatuses.get(game.gameId);
    lastGameStatuses.set(game.gameId, statusCode);

    if (prevStatus && prevStatus !== 2 && statusCode === 2 && !notifiedGames.has(game.gameId)) {
      const away = game.away || {};
      const home = game.home || {};
      const title = "Favorite game is live";
      const body = `${away.tricode || "--"} @ ${home.tricode || "--"} just started.`;
      try {
        new Notification(title, { body });
        notifiedGames.add(game.gameId);
        saveNotifiedGames();
      } catch (err) {
        // Ignore notification errors.
      }
    }
  });
}

function setTableView(mode) {
  const compact = mode === "compact";
  document.body.classList.toggle("table-compact", compact);
  if (tableToggleBtn) {
    tableToggleBtn.textContent = compact ? "Stats: Compact" : "Stats: Expanded";
  }
  localStorage.setItem("nba-table-view", compact ? "compact" : "expanded");
}

async function getState() {
  const query = selectedGameId ? `?gameId=${encodeURIComponent(selectedGameId)}` : "";
  if (window.pywebview && window.pywebview.api && window.pywebview.api.get_state) {
    return window.pywebview.api.get_state(selectedGameId || null);
  }
  try {
    const response = await fetch(`/api/state${query}`, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return response.json();
  } catch (err) {
    return {
      status: "error",
      updated: new Date().toISOString(),
      error: `API fetch failed: ${err}`,
    };
  }
  return {
    status: "error",
    updated: new Date().toISOString(),
    error: "pywebview API not available. Run nba_live.py.",
  };
}

async function refresh(options = {}) {
  if (isRefreshing) {
    return;
  }
  isRefreshing = true;
  const manual = options && options.manual;
  if (manual && refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.textContent = "Refreshing...";
  }

  try {
    let state;
    try {
      state = await getState();
    } catch (err) {
      statusEl.textContent = "error";
      renderFallback(`API error: ${err}`);
      return;
    }

    const isLive = state.status === "ok";
    const nextInterval = isLive ? LIVE_REFRESH_MS : IDLE_REFRESH_MS;
    if (nextInterval !== refreshIntervalMs) {
      refreshIntervalMs = nextInterval;
      if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = setInterval(refresh, refreshIntervalMs);
      }
    }

    setUpdatedTime(state.dataUpdated || state.updated);

    if (state.games && gamesEl) {
      renderGameList(state.games);
    }
    if (state.games) {
      maybeNotifyGameStart(state.games);
    }

    if (state.status !== "ok" && state.status !== "scheduled" && state.status !== "postgame" && state.status !== "live_no_data") {
      statusEl.textContent = state.status.replace(/_/g, " ");
      renderFallback(state.error || fallbackForStatus(state.status, state.game && state.game.statusText));
      if (state.status === "game_not_found") {
        selectedGameId = "";
        localStorage.removeItem("nba-selected-game");
        showListView();
      }
      if (state.status === "select_game") {
        showListView();
      }
      renderStatusRibbon(state);
      clearGameUI();
      return;
    }

    if (state.status === "scheduled" || state.status === "postgame" || state.status === "live_no_data") {
      renderFallback(fallbackForStatus(state.status, state.game && state.game.statusText));
    } else {
      clearFallback();
    }
    statusEl.textContent = state.game.statusText || state.game.status;
    showGameView();
    renderStatusRibbon(state);

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
    renderTeamTable(awayTable, away, `away-${away.id || away.tricode || "team"}`, showTotals, hidePoints);
    renderTeamTable(homeTable, home, `home-${home.id || home.tricode || "team"}`, showTotals, hidePoints);
  } finally {
    if (manual && refreshBtn) {
      refreshBtn.disabled = false;
      refreshBtn.textContent = refreshLabel;
    }
    isRefreshing = false;
  }
}

function startPolling() {
  if (refreshTimer) {
    return;
  }
  refresh();
  refreshTimer = setInterval(refresh, refreshIntervalMs);
}

function stopPolling() {
  if (!refreshTimer) {
    return;
  }
  clearInterval(refreshTimer);
  refreshTimer = null;
}

window.addEventListener("DOMContentLoaded", () => {
  setUpdatedTime(new Date().toISOString());
  statusEl.textContent = "Connecting";
  renderFallback("Connecting to live data...");

  hydrateFavorites();

  startPolling();
  setupScrollbars();

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopPolling();
    } else {
      startPolling();
    }
  });

  if (zoomSelect) {
    const savedZoom = localStorage.getItem("nba-zoom") || "1";
    zoomSelect.value = savedZoom;
    document.body.style.zoom = savedZoom;
    zoomSelect.addEventListener("change", () => {
      const value = zoomSelect.value || "1";
      document.body.style.zoom = value;
      localStorage.setItem("nba-zoom", value);
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      refresh({ manual: true });
    });
  }

  if (toggleBtn && scoreboardEl) {
    const states = ["full", "compact", "hidden"];
    const savedView = localStorage.getItem("nba-scoreboard-view");
    let stateIndex = states.indexOf(savedView);
    if (stateIndex < 0) {
      stateIndex = 2;
    }

    const applyState = () => {
      const state = states[stateIndex];
      scoreboardEl.classList.toggle("is-collapsed", state === "compact");
      scoreboardEl.classList.toggle("is-hidden", state === "hidden");
      toggleBtn.textContent = `View: ${state[0].toUpperCase()}${state.slice(1)}`;
      localStorage.setItem("nba-scoreboard-view", state);
    };

    applyState();
    toggleBtn.addEventListener("click", () => {
      stateIndex = (stateIndex + 1) % states.length;
      applyState();
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
    const open = localStorage.getItem("nba-periods-open") === "1";
    setPeriodsOpen(open);
    periodsToggleBtn.addEventListener("click", () => {
      const next = periodsEl && periodsEl.classList.contains("is-collapsed");
      setPeriodsOpen(next);
    });
  }

  if (comparisonToggleBtn) {
    const open = localStorage.getItem("nba-comparison-open") === "1";
    setComparisonOpen(open);
    comparisonToggleBtn.addEventListener("click", () => {
      const next = comparisonEl && comparisonEl.classList.contains("is-collapsed");
      setComparisonOpen(next);
    });
  }

  if (tableToggleBtn) {
    const saved = localStorage.getItem("nba-table-view") || "expanded";
    setTableView(saved);
    tableToggleBtn.addEventListener("click", () => {
      const next = document.body.classList.contains("table-compact") ? "expanded" : "compact";
      setTableView(next);
    });
  }

  if (appRoot) {
    appRoot.addEventListener("mouseover", handleTableHover);
    appRoot.addEventListener("mouseout", clearTableHover);
  }

  if (selectedGameId) {
    showGameView();
  } else {
    showListView();
  }
});

window.addEventListener("pywebviewready", () => {
  startPolling();
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
