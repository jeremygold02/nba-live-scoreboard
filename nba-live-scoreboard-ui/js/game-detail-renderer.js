export function createGameDetailRenderer({
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
  getStatFlashEnabled,
  getTeamColor,
  hasNotEntered,
  homeHeader,
  homeLineupEl,
  homeLineupTitleEl,
  lineupsEl,
  normalizeStatValue,
  parseUpdated,
  periodsEl,
  periodsToggleBtn,
  shouldShowPhase,
  toRgba,
}) {
  const lastScores = new Map();
  const tableCache = new Map();
  const lastPlayerStats = new Map();
  let periodsOpen = false;
  let comparisonOpen = false;

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

  function renderCenter(container, game) {
    container.innerHTML = "";

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
      container.append(status, clock, period, phase);
      return;
    }

    container.append(status, clock, period);
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

  function cell(value) {
    const td = document.createElement("td");
    td.textContent = value ?? "-";
    return td;
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
    const statFlashEnabled = getStatFlashEnabled();

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
    container.appendChild(buildTable(team, showTotals, hidePoints, targetRows, cacheKey));
    tableCache.set(cacheKey, { hash });
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
    periodsEl.classList.toggle("is-collapsed", !periodsOpen);
    periodsToggleBtn.textContent = periodsOpen ? "Quarters: Hide" : "Quarters: Show";
  }

  function isPeriodsOpen() {
    return periodsOpen;
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

  function setComparisonOpen(open) {
    if (!comparisonEl || !comparisonToggleBtn) return;
    comparisonOpen = Boolean(open);
    comparisonEl.classList.toggle("is-collapsed", !comparisonOpen);
    comparisonToggleBtn.textContent = comparisonOpen ? "Comparison: Hide" : "Comparison: Show";
  }

  function isComparisonOpen() {
    return comparisonOpen;
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

  return {
    clearDataBanner,
    isComparisonOpen,
    isPeriodsOpen,
    renderCenter,
    renderComparison,
    renderDataBanner,
    renderDetails,
    renderHeaders,
    renderLineups,
    renderPeriods,
    renderTeamCard,
    renderTeamTable,
    setComparisonOpen,
    setPeriodsOpen,
  };
}
