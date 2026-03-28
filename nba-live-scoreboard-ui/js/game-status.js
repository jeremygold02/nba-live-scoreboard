export function getGameStatusKey(game) {
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

export function getGameStatusLabel(game) {
  if (!game) return "Unknown";
  if (game.status) return String(game.status);
  const statusKey = getGameStatusKey(game);
  if (statusKey === "live") return "Live";
  if (statusKey === "final") return "Final";
  return "Scheduled";
}

export function isTimeStatusText(text) {
  if (!text) return false;
  const trimmed = String(text).trim();
  if (!trimmed) return false;
  if (/[0-9]/.test(trimmed) && /:/.test(trimmed)) return true;
  if (/\b(am|pm)\b/i.test(trimmed)) return true;
  if (/\b(et|ct|mt|pt)\b/i.test(trimmed) && /[0-9]/.test(trimmed)) return true;
  return false;
}

export function getNonTimeStatusText(text) {
  if (!text) return "";
  const trimmed = String(text).trim();
  if (!trimmed || isTimeStatusText(trimmed)) return "";
  return trimmed;
}

export function formatPeriodText(game) {
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

export function shouldShowPhase(game, clockText) {
  if (!game || !game.statusText) return false;
  if (!clockText) return true;
  if (clockText === "0:00") return true;
  if (game.statusText.toLowerCase() === "halftime") return true;
  return false;
}

export function formatGameStatus(game) {
  const statusKey = getGameStatusKey(game);
  if (statusKey === "scheduled") {
    const special = getNonTimeStatusText(game && game.statusText);
    return special || getGameStatusLabel(game);
  }
  if (statusKey === "live") return "Live <span class=\"status-live\">&#9679;</span>";
  if (statusKey === "final") return getGameStatusLabel(game);
  return getGameStatusLabel(game);
}

export function formatLivePhaseText(game, clockText) {
  if (!shouldShowPhase(game, clockText)) return "";
  const phase = formatPeriodText(game);
  return phase && phase !== getGameStatusLabel(game) ? phase : "";
}

export function formatTipoff(value) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return String(value);
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

export function formatPeriodChip(game) {
  if (!game || !game.period) return "";
  const period = Number.isFinite(game.period) ? game.period : Number(game.period);
  if (!Number.isFinite(period) || period <= 0) return "";
  if (period <= 4) return `Q${period}`;
  const ot = period - 4;
  return ot === 1 ? "OT" : `${ot}OT`;
}

export function getGameSectionKey(game) {
  const statusKey = getGameStatusKey(game);
  if (statusKey === "live") return "live";
  if (statusKey === "final") return "finished";
  return "scheduled";
}

export function getGameSectionTitle(sectionKey) {
  if (sectionKey === "live") return "Live Games";
  if (sectionKey === "finished") return "Finished Games";
  return "Scheduled Games";
}
