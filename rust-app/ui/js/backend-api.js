export function canUseDesktopBackend() {
  return typeof window.__TAURI__?.core?.invoke === "function";
}

function invoke(command, args) {
  return window.__TAURI__.core.invoke(command, args);
}

export async function fetchPreferences() {
  return canUseDesktopBackend() ? invoke("get_preferences") : null;
}

export async function persistPreferences(preferences) {
  return canUseDesktopBackend() ? invoke("set_preferences", { preferences }) : null;
}

export async function fetchFavorites() {
  return canUseDesktopBackend() ? invoke("get_favorites") : [];
}

export async function persistFavorites(favorites) {
  return canUseDesktopBackend() ? invoke("set_favorites", { favorites }) : null;
}

export async function fetchScoreboardState({ selectedGameId, view, scoreboardDate }) {
  if (!canUseDesktopBackend()) {
    return {
      status: "error",
      updated: new Date().toISOString(),
      error: "The desktop connection is unavailable.",
    };
  }
  return invoke("get_scoreboard", {
    selectedGameId: selectedGameId || null,
    viewMode: view,
    scoreboardDate: scoreboardDate || null,
  });
}

export async function fetchDetailState({ selectedGameId, view, scoreboardDate }) {
  if (!canUseDesktopBackend()) {
    return {
      status: "error",
      updated: new Date().toISOString(),
      error: "The desktop connection is unavailable.",
    };
  }
  return invoke("get_state", {
    gameId: selectedGameId || null,
    viewMode: view,
    scoreboardDate: scoreboardDate || null,
  });
}
