export function canUsePywebview() {
  return Boolean(window.pywebview && window.pywebview.api && window.pywebview.api.get_state);
}

export async function fetchPreferences() {
  if (window.pywebview && window.pywebview.api && window.pywebview.api.get_preferences) {
    return window.pywebview.api.get_preferences();
  }
  return null;
}

export async function persistPreferences(payload) {
  if (window.pywebview && window.pywebview.api && window.pywebview.api.set_preferences) {
    return window.pywebview.api.set_preferences(payload);
  }
  return null;
}

export async function fetchFavorites() {
  if (window.pywebview && window.pywebview.api && window.pywebview.api.get_favorites) {
    return window.pywebview.api.get_favorites();
  }
  return [];
}

export async function persistFavorites(payload) {
  if (window.pywebview && window.pywebview.api && window.pywebview.api.set_favorites) {
    return window.pywebview.api.set_favorites(payload);
  }
  return null;
}

export async function fetchScoreboardState({ selectedGameId, view, scoreboardDate }) {
  if (canUsePywebview() && window.pywebview.api.get_scoreboard) {
    return window.pywebview.api.get_scoreboard(selectedGameId || null, view, scoreboardDate || null);
  }
  if (canUsePywebview()) {
    return window.pywebview.api.get_state(null, view, scoreboardDate || null);
  }
  return {
    status: "error",
    updated: new Date().toISOString(),
    error: "pywebview API not available. Run nba-live-scoreboard.py.",
  };
}

export async function fetchDetailState({ selectedGameId, view, scoreboardDate }) {
  if (canUsePywebview()) {
    return window.pywebview.api.get_state(selectedGameId || null, view, scoreboardDate || null);
  }
  return {
    status: "error",
    updated: new Date().toISOString(),
    error: "pywebview API not available. Run nba-live-scoreboard.py.",
  };
}
