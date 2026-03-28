export function formatPct(value) {
  if (typeof value !== "number") return "--";
  return `${value.toFixed(1)}%`;
}

export function formatShotPct(made, attempted) {
  if (!Number.isFinite(made) || !Number.isFinite(attempted) || attempted <= 0) {
    return "--";
  }
  return `${((made / attempted) * 100).toFixed(1)}%`;
}

export function calcShotPct(made, attempted) {
  if (!Number.isFinite(made) || !Number.isFinite(attempted) || attempted <= 0) {
    return null;
  }
  return (made / attempted) * 100;
}

export function calcTrueShooting(points, fga, fta) {
  const denom = 2 * (fga + 0.44 * fta);
  if (!Number.isFinite(points) || !Number.isFinite(denom) || denom <= 0) {
    return null;
  }
  return (points / denom) * 100;
}

export function calcEfg(fgm, tpm, fga) {
  if (!Number.isFinite(fga) || fga <= 0) {
    return null;
  }
  return ((fgm + 0.5 * tpm) / fga) * 100;
}

export function formatClock(value) {
  if (!value) return "";
  const text = String(value);
  const match = text.match(/PT(\d+)M(\d+(?:\.\d+)?)S/);
  if (!match) return text;
  const minutes = match[1].padStart(1, "0");
  const seconds = Math.floor(parseFloat(match[2])).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

export function hasNotEntered(minutesValue) {
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

export function normalizeStatValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    return Number.isNaN(value) ? null : value;
  }
  return String(value);
}
