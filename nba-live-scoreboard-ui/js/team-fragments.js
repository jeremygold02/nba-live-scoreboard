import { teamColors } from "./config.js";

export function formatRecord(team) {
  if (!team) return "";
  if (team.wins || team.losses) {
    return `${team.wins}-${team.losses}`;
  }
  return "";
}

export function setText(el, text) {
  el.textContent = text;
}

export function toRgba(hex, alpha) {
  if (!hex) return `rgba(255, 255, 255, ${alpha})`;
  const value = hex.replace("#", "");
  if (value.length !== 6) return `rgba(255, 255, 255, ${alpha})`;
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function getTeamColor(tricode) {
  return teamColors[tricode] || "#2e7ac7";
}

export function buildLogoBadge(team) {
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

export function buildScoreBadge(score) {
  const badge = document.createElement("span");
  badge.className = "game-item__score";
  badge.textContent = Number.isFinite(score) ? score : score ?? "-";
  return badge;
}

export function buildHeartIcon() {
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
