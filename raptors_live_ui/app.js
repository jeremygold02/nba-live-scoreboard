const REFRESH_MS = 15000;
let refreshTimer = null;

const updatedEl = document.getElementById("updated");
const statusEl = document.getElementById("status");
const awayCard = document.getElementById("away-card");
const homeCard = document.getElementById("home-card");
const centerCard = document.getElementById("game-center");
const detailsEl = document.getElementById("game-details");
const periodsEl = document.getElementById("periods");
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
const fallbackEl = document.getElementById("fallback");
const scoreboardEl = document.getElementById("scoreboard");
const toggleBtn = document.getElementById("scoreboard-toggle");
const zoomSelect = document.getElementById("zoom-select");
const appRoot = document.getElementById("app");
let activeCell = null;
let selectedGameId = localStorage.getItem("nba-selected-game") || "";

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

function formatStatLine(team) {
  if (!team || !team.stats) return "";
  const stats = team.stats;
  const ts = formatPct(stats.tsPct);
  const efg = formatPct(stats.efgPct);
  const fgPct = formatShotPct(stats.fgm, stats.fga);
  const tpPct = formatShotPct(stats.tpm, stats.tpa);
  const ftPct = formatShotPct(stats.ftm, stats.fta);
  return `${stats.fgm}-${stats.fga} FG (${fgPct}) | ${stats.tpm}-${stats.tpa} 3PT (${tpPct}) | ${stats.ftm}-${stats.fta} FT (${ftPct}) | ${stats.rebounds} REB | ${stats.assists} AST | ${ts} TS | ${efg} eFG`;
}

function setText(el, text) {
  el.textContent = text;
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

function renderTeamCard(container, team) {
  container.className = "team-card";
  container.innerHTML = "";

  const name = document.createElement("div");
  name.className = "team-name";
  name.textContent = team.city;

  const title = document.createElement("div");
  title.className = "team-title";
  title.textContent = `${team.name} (${team.tricode})`;

  const score = document.createElement("div");
  score.className = "team-score";
  score.textContent = team.score ?? "-";

  const record = document.createElement("div");
  record.className = "team-record";
  record.textContent = formatRecord(team);

  container.append(name, title, score, record);
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

function buildTable(team) {
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

  team.players.forEach((player) => {
    const row = document.createElement("tr");
    if (player.status && player.status !== "ACTIVE") {
      row.classList.add("player-inactive");
    }
    if (hasNotEntered(player.minutes)) {
      row.classList.add("player-dnp");
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
  if (team.stats && team.stats.points !== undefined) {
    const tfoot = document.createElement("tfoot");
    const totalRow = document.createElement("tr");
    totalRow.className = "total-row";

    const totalLabel = document.createElement("td");
    totalLabel.textContent = "TEAM TOTAL";
    totalRow.appendChild(totalLabel);

    totalRow.appendChild(cell(""));
    totalRow.appendChild(cell(team.stats.points));
    totalRow.appendChild(cell(team.stats.rebounds));
    totalRow.appendChild(cell(team.stats.assists));
    totalRow.appendChild(cell(team.stats.steals));
    totalRow.appendChild(cell(team.stats.blocks));
    totalRow.appendChild(cell(team.stats.turnovers));
    totalRow.appendChild(cell(team.stats.fouls));
    totalRow.appendChild(cell(`${team.stats.fgm}-${team.stats.fga}`));
    totalRow.appendChild(cell(`${team.stats.tpm}-${team.stats.tpa}`));
    totalRow.appendChild(cell(`${team.stats.ftm}-${team.stats.fta}`));
    totalRow.appendChild(cell(formatPct(team.stats.tsPct)));
    totalRow.appendChild(cell(formatPct(team.stats.efgPct)));
    totalRow.appendChild(cell(""));

    tfoot.appendChild(totalRow);
    table.appendChild(tfoot);
  }
  wrapper.appendChild(table);
  return wrapper;
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
  awayTitle.textContent = `${away.name} (${away.tricode})`;

  const awaySub = document.createElement("div");
  awaySub.className = "table-subtitle";
  awaySub.textContent = formatStatLine(away);

  awayHeader.append(awayTitle, awaySub);

  const homeTitle = document.createElement("div");
  homeTitle.className = "table-title";
  homeTitle.textContent = `${home.name} (${home.tricode})`;

  const homeSub = document.createElement("div");
  homeSub.className = "table-subtitle";
  homeSub.textContent = formatStatLine(home);

  homeHeader.append(homeTitle, homeSub);
}

function renderFallback(message) {
  fallbackEl.textContent = message;
}

function clearFallback() {
  fallbackEl.textContent = "";
}

function renderPeriods(periods, home, away) {
  periodsEl.innerHTML = "";
  if (!periods || !periods.length) {
    return;
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

function fallbackForStatus(status) {
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
    return "Tipoff hasn't happened yet. Live box score will appear once the game starts.";
  }
  return "Waiting for game data...";
}

function clearGameUI() {
  awayCard.innerHTML = "";
  homeCard.innerHTML = "";
  centerCard.innerHTML = "";
  detailsEl.innerHTML = "";
  periodsEl.innerHTML = "";
  awayHeader.innerHTML = "";
  homeHeader.innerHTML = "";
  awayTable.innerHTML = "";
  homeTable.innerHTML = "";
}

function formatGameStatus(game) {
  const status = Number.isFinite(game.status) ? game.status : Number(game.status);
  if (status === 1) return "Scheduled";
  if (status === 2) return "Live";
  if (status === 3) return "Final";
  return game.statusText || "Unknown";
}

function formatTipoff(value) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    return value;
  }
  return parsed.toLocaleString();
}

function renderGameList(games) {
  if (!gamesEl) return;
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

  games.forEach((game) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "game-item";
    button.dataset.gameId = game.gameId;

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
    title.textContent = `${away.city || ""} ${away.name || ""} vs ${home.city || ""} ${home.name || ""}`.trim();

    const subtitle = document.createElement("div");
    subtitle.className = "game-item__subtitle";
    subtitle.textContent = `${away.tricode || "--"} @ ${home.tricode || "--"}`;

    const meta = document.createElement("div");
    meta.className = "game-item__meta";
    const status = formatGameStatus(game);
    const tipoff = formatTipoff(game.startTimeUTC);
    const clock = formatClock(game.clock);
    const period = game.period ? `P${game.period}` : "";
    const shouldShowScore = status === "Live" || status === "Final";
    const score = shouldShowScore ? `${away.score ?? "-"} - ${home.score ?? "-"}` : "";
    meta.textContent = [status, clock, period, tipoff, score].filter(Boolean).join(" | ");

    button.append(title, subtitle, meta);
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
      updated: new Date().toLocaleTimeString(),
      error: `API fetch failed: ${err}`,
    };
  }
  return {
    status: "error",
    updated: new Date().toLocaleTimeString(),
    error: "pywebview API not available. Run raptors_live.py.",
  };
}

async function refresh() {
  let state;
  try {
    state = await getState();
  } catch (err) {
    statusEl.textContent = "error";
    renderFallback(`API error: ${err}`);
    return;
  }

  setText(updatedEl, `Updated ${state.updated || "--"}`);

  if (state.games && gamesEl) {
    renderGameList(state.games);
  }

  if (state.status !== "ok" && state.status !== "scheduled") {
    statusEl.textContent = state.status.replace(/_/g, " ");
    renderFallback(state.error || fallbackForStatus(state.status));
    if (state.status === "game_not_found") {
      selectedGameId = "";
      localStorage.removeItem("nba-selected-game");
      showListView();
    }
    if (state.status === "select_game") {
      showListView();
    }
    clearGameUI();
    return;
  }

  if (state.status === "scheduled") {
    renderFallback(fallbackForStatus(state.status));
  } else {
    clearFallback();
  }
  statusEl.textContent = state.game.statusText || state.game.status;
  showGameView();

  const home = state.home;
  const away = state.away;

  renderTeamCard(awayCard, away);
  renderTeamCard(homeCard, home);
  renderCenter(state.game);
  renderDetails(state.game);
  renderHeaders(home, away);
  renderPeriods(state.periods, home, away);

  awayTable.innerHTML = "";
  homeTable.innerHTML = "";
  awayTable.appendChild(buildTable(away));
  homeTable.appendChild(buildTable(home));
}

function startPolling() {
  if (refreshTimer) {
    return;
  }
  refresh();
  refreshTimer = setInterval(refresh, REFRESH_MS);
}

window.addEventListener("DOMContentLoaded", () => {
  setText(updatedEl, `Updated ${new Date().toLocaleTimeString()}`);
  statusEl.textContent = "Connecting";
  renderFallback("Connecting to live data...");

  startPolling();
  setupScrollbars();

  if (zoomSelect) {
    const savedZoom = localStorage.getItem("nba-zoom") || localStorage.getItem("raptors-zoom") || "1";
    zoomSelect.value = savedZoom;
    document.body.style.zoom = savedZoom;
    zoomSelect.addEventListener("change", () => {
      const value = zoomSelect.value || "1";
      document.body.style.zoom = value;
      localStorage.setItem("nba-zoom", value);
    });
  }

  if (toggleBtn && scoreboardEl) {
    const states = ["full", "compact", "hidden"];
    let stateIndex = 2;

    const applyState = () => {
      const state = states[stateIndex];
      scoreboardEl.classList.toggle("is-collapsed", state === "compact");
      scoreboardEl.classList.toggle("is-hidden", state === "hidden");
      toggleBtn.textContent = `View: ${state[0].toUpperCase()}${state.slice(1)}`;
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
