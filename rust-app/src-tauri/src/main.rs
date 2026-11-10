#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod detail;
mod plays;
mod scoreboard;

use serde_json::{json, Value};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{Manager, State, WindowEvent};

struct Settings {
    favorites: Vec<Value>,
    preferences: Value,
}

struct AppState {
    scoreboard: Arc<scoreboard::ScoreboardService>,
    detail: Arc<detail::DetailService>,
    settings: Mutex<Settings>,
    data_dir: PathBuf,
}

fn default_preferences() -> Value {
    json!({
        "scoreboardView": "hidden",
        "tableView": "expanded",
        "zoomLevel": "1",
        "statFlashEnabled": true
    })
}

fn normalize_preferences(input: &Value) -> Value {
    let mut result = default_preferences();
    if let Some(value) = input.get("scoreboardView").and_then(Value::as_str) {
        if ["full", "compact", "hidden"].contains(&value) {
            result["scoreboardView"] = json!(value);
        }
    }
    if input.get("tableView").and_then(Value::as_str) == Some("compact") {
        result["tableView"] = json!("compact");
    }
    if let Some(value) = input.get("zoomLevel").and_then(Value::as_str) {
        if ["0.8", "0.9", "1", "1.1", "1.2"].contains(&value) {
            result["zoomLevel"] = json!(value);
        }
    }
    if let Some(value) = input.get("statFlashEnabled").and_then(Value::as_bool) {
        result["statFlashEnabled"] = json!(value);
    }
    result
}

fn read_json(path: &Path) -> Option<Value> {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    let parent = path.parent().ok_or("Invalid settings path")?;
    if !parent.as_os_str().is_empty() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let data = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    fs::write(path, data).map_err(|error| error.to_string())
}

fn read_or_migrate_json(
    data_dir: &Path,
    name: &str,
    source_dirs: &[PathBuf],
    valid: fn(&Value) -> bool,
) -> Option<Value> {
    let destination = data_dir.join(name);
    if destination.exists() {
        return read_json(&destination).filter(valid);
    }
    for source in source_dirs {
        if let Some(value) = read_json(&source.join(name)).filter(valid) {
            let result = (|| -> io::Result<()> {
                fs::create_dir_all(data_dir)?;
                let mut file = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&destination)?;
                let bytes = serde_json::to_vec_pretty(&value)?;
                file.write_all(&bytes)
            })();
            if let Err(error) = result {
                if error.kind() == io::ErrorKind::AlreadyExists {
                    return read_json(&destination).filter(valid);
                }
                eprintln!("Could not migrate {name}: {error}");
            }
            return Some(value);
        }
    }
    None
}

fn migration_sources(data_dir: &Path, executable: Option<&Path>) -> Vec<PathBuf> {
    let mut sources = Vec::new();
    if let Some(parent) = data_dir.parent() {
        sources.push(parent.join("com.nbalivescoreboard.rustprototype"));
    }
    if let Some(directory) = executable.and_then(Path::parent) {
        sources.push(directory.join("nba-live-scoreboard-ui").join("resources"));
        let name_is = |path: &Path, expected: &str| {
            path.file_name()
                .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case(expected))
        };
        let app_dir = if name_is(directory, "rust-app") || name_is(directory, "rust-prototype") {
            Some(directory)
        } else if (name_is(directory, "release") || name_is(directory, "debug"))
            && directory
                .parent()
                .is_some_and(|path| name_is(path, "target"))
            && directory
                .parent()
                .and_then(Path::parent)
                .is_some_and(|path| name_is(path, "src-tauri"))
        {
            directory
                .parent()
                .and_then(Path::parent)
                .and_then(Path::parent)
                .filter(|path| name_is(path, "rust-app") || name_is(path, "rust-prototype"))
        } else {
            None
        };
        if let Some(root) = app_dir.and_then(Path::parent) {
            sources.push(root.join("nba-live-scoreboard-ui").join("resources"));
        }
    }
    sources
}

impl AppState {
    fn new(data_dir: PathBuf, migrate: bool) -> Self {
        let executable = std::env::current_exe().ok();
        let sources = if migrate {
            migration_sources(&data_dir, executable.as_deref())
        } else {
            Vec::new()
        };
        let favorites =
            read_or_migrate_json(&data_dir, "favorites.json", &sources, Value::is_array)
                .and_then(|value| value.as_array().cloned())
                .unwrap_or_default();
        let preferences =
            read_or_migrate_json(&data_dir, "ui-preferences.json", &sources, Value::is_object)
                .map(|value| normalize_preferences(&value))
                .unwrap_or_else(default_preferences);
        Self {
            scoreboard: Arc::new(scoreboard::ScoreboardService::new()),
            detail: Arc::new(detail::DetailService::new()),
            settings: Mutex::new(Settings {
                favorites,
                preferences,
            }),
            data_dir,
        }
    }
}

#[tauri::command]
async fn get_scoreboard(
    state: State<'_, AppState>,
    selected_game_id: Option<String>,
    view_mode: Option<String>,
    scoreboard_date: Option<String>,
) -> Result<Value, String> {
    let scoreboard = Arc::clone(&state.scoreboard);
    let _ = view_mode;
    tauri::async_runtime::spawn_blocking(move || {
        scoreboard.state(scoreboard_date.as_deref(), selected_game_id.as_deref())
    })
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn get_state(
    state: State<'_, AppState>,
    game_id: Option<String>,
    view_mode: Option<String>,
    scoreboard_date: Option<String>,
) -> Result<Value, String> {
    let scoreboard = Arc::clone(&state.scoreboard);
    let detail = Arc::clone(&state.detail);
    let _ = view_mode;
    tauri::async_runtime::spawn_blocking(move || {
        detail.state(&scoreboard, scoreboard_date.as_deref(), game_id.as_deref())
    })
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_favorites(state: State<'_, AppState>) -> Result<Vec<Value>, String> {
    let settings = state.settings.lock().map_err(|error| error.to_string())?;
    Ok(settings.favorites.clone())
}

#[tauri::command]
fn set_favorites(state: State<'_, AppState>, favorites: Vec<Value>) -> Result<Value, String> {
    let mut settings = state.settings.lock().map_err(|error| error.to_string())?;
    write_json(&state.data_dir.join("favorites.json"), &json!(favorites))?;
    settings.favorites = favorites;
    Ok(json!({"status": "ok"}))
}

#[tauri::command]
fn get_preferences(state: State<'_, AppState>) -> Result<Value, String> {
    let settings = state.settings.lock().map_err(|error| error.to_string())?;
    Ok(settings.preferences.clone())
}

#[tauri::command]
fn set_preferences(state: State<'_, AppState>, preferences: Value) -> Result<Value, String> {
    let incoming = preferences
        .as_object()
        .ok_or("Preferences must be an object")?;
    let mut settings = state.settings.lock().map_err(|error| error.to_string())?;
    let mut merged = settings.preferences.clone();
    if let Some(object) = merged.as_object_mut() {
        object.extend(incoming.clone());
    }
    let normalized = normalize_preferences(&merged);
    write_json(&state.data_dir.join("ui-preferences.json"), &normalized)?;
    settings.preferences = normalized.clone();
    Ok(json!({"status": "ok", "preferences": normalized}))
}

fn write_headless_report(arguments: &[String]) -> Result<bool, String> {
    if arguments.get(1).map(String::as_str) != Some("--headless-report") {
        return Ok(false);
    }
    let output = arguments
        .get(2)
        .ok_or("Provide a path for the headless report")?;
    let date = arguments.get(3).filter(|value| value.as_str() != "-");
    let requested_game = arguments.get(4);
    let scoreboard = scoreboard::ScoreboardService::new();
    let list = scoreboard.state(date.map(String::as_str), None);
    let selected_game = requested_game.cloned().or_else(|| {
        let games = list.get("games")?.as_array()?;
        games
            .iter()
            .find(|game| matches!(game["statusKey"].as_str(), Some("live" | "final")))
            .or_else(|| games.first())?
            .get("gameId")?
            .as_str()
            .map(str::to_owned)
    });
    let detail = selected_game.as_ref().map(|game_id| {
        detail::DetailService::new().state(&scoreboard, date.map(String::as_str), Some(game_id))
    });
    write_json(
        Path::new(output),
        &json!({
            "scoreboard": list,
            "selectedGameId": selected_game,
            "detail": detail
        }),
    )?;
    Ok(true)
}

fn main() {
    match write_headless_report(&std::env::args().collect::<Vec<_>>()) {
        Ok(true) => return,
        Ok(false) => {}
        Err(error) => {
            eprintln!("Headless report failed: {error}");
            std::process::exit(2);
        }
    }
    // Keep live refreshes running while the scoreboard is minimized.
    let key = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
    let mut arguments = std::env::var(key).unwrap_or_default();
    for flag in [
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
    ] {
        if !arguments
            .split_whitespace()
            .any(|argument| argument == flag)
        {
            arguments.push(' ');
            arguments.push_str(flag);
        }
    }
    std::env::set_var(key, arguments.trim());
    tauri::Builder::default()
        .setup(|app| {
            let (data_dir, migrate) = match std::env::var_os("NBA_SCOREBOARD_DATA_DIR") {
                Some(path) => {
                    let path = PathBuf::from(path);
                    if !path.is_absolute() {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidInput,
                            "NBA_SCOREBOARD_DATA_DIR must be an absolute path",
                        )
                        .into());
                    }
                    (path, false)
                }
                None => (app.path().app_data_dir()?, true),
            };
            app.manage(AppState::new(data_dir, migrate));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Focused(focused) = event {
                if let Some(webview) = window.get_webview_window(window.label()) {
                    let name = if *focused { "focus" } else { "blur" };
                    let _ = webview.eval(format!("window.dispatchEvent(new Event('{name}'))"));
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_scoreboard,
            get_state,
            get_favorites,
            set_favorites,
            get_preferences,
            set_preferences
        ])
        .run(tauri::generate_context!())
        .expect("failed to run NBA Live Scoreboard");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_directory() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "nba-scoreboard-migration-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir(&path).unwrap();
        path
    }

    #[test]
    fn preferences_keep_valid_values_and_replace_invalid_ones() {
        let preferences = normalize_preferences(&json!({
            "scoreboardView": "compact",
            "tableView": "invalid",
            "zoomLevel": "1.2",
            "statFlashEnabled": false
        }));
        assert_eq!(preferences["scoreboardView"], "compact");
        assert_eq!(preferences["tableView"], "expanded");
        assert_eq!(preferences["zoomLevel"], "1.2");
        assert_eq!(preferences["statFlashEnabled"], false);
    }

    #[test]
    fn migrates_existing_settings_once_without_changing_the_source() {
        let root = test_directory();
        let prototype = root.join("prototype");
        let legacy = root.join("legacy");
        let current = root.join("current");
        fs::create_dir(&prototype).unwrap();
        fs::create_dir(&legacy).unwrap();
        write_json(&prototype.join("favorites.json"), &json!(["TOR"])).unwrap();
        write_json(&legacy.join("favorites.json"), &json!(["LAL"])).unwrap();
        let sources = vec![prototype.clone(), legacy.clone()];

        let migrated = read_or_migrate_json(&current, "favorites.json", &sources, Value::is_array);
        assert_eq!(migrated, Some(json!(["TOR"])));
        assert_eq!(
            read_json(&current.join("favorites.json")),
            Some(json!(["TOR"]))
        );
        assert_eq!(
            read_json(&prototype.join("favorites.json")),
            Some(json!(["TOR"]))
        );
        assert_eq!(
            read_json(&legacy.join("favorites.json")),
            Some(json!(["LAL"]))
        );

        write_json(&current.join("favorites.json"), &json!(["BOS"])).unwrap();
        assert_eq!(
            read_or_migrate_json(&current, "favorites.json", &sources, Value::is_array),
            Some(json!(["BOS"]))
        );

        for directory in [&current, &prototype, &legacy] {
            fs::remove_file(directory.join("favorites.json")).unwrap();
            fs::remove_dir(directory).unwrap();
        }
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn legacy_settings_are_used_when_prototype_settings_are_missing() {
        let root = test_directory();
        let legacy = root.join("legacy");
        let current = root.join("current");
        fs::create_dir(&legacy).unwrap();
        write_json(
            &legacy.join("ui-preferences.json"),
            &json!({"scoreboardView": "full"}),
        )
        .unwrap();

        let result = read_or_migrate_json(
            &current,
            "ui-preferences.json",
            &[root.join("missing"), legacy.clone()],
            Value::is_object,
        );
        assert_eq!(result, Some(json!({"scoreboardView": "full"})));
        assert_eq!(read_json(&legacy.join("ui-preferences.json")), result);
        assert_eq!(read_json(&current.join("ui-preferences.json")), result);

        fs::remove_file(legacy.join("ui-preferences.json")).unwrap();
        fs::remove_file(current.join("ui-preferences.json")).unwrap();
        fs::remove_dir(legacy).unwrap();
        fs::remove_dir(current).unwrap();
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn finds_legacy_settings_for_a_repo_build() {
        let root = test_directory();
        for directory in ["rust-app", "rust-prototype"] {
            let executable = root
                .join(directory)
                .join("src-tauri")
                .join("target")
                .join("release")
                .join("nba-live-scoreboard-rust.exe");
            let sources = migration_sources(&root.join("app-data"), Some(&executable));
            assert!(sources.contains(&root.join("nba-live-scoreboard-ui").join("resources")));
        }
        fs::remove_dir(root).unwrap();
    }

    #[test]
    fn existing_invalid_settings_are_not_overwritten_during_migration() {
        let root = test_directory();
        let legacy = root.join("legacy");
        let current = root.join("current");
        fs::create_dir(&legacy).unwrap();
        fs::create_dir(&current).unwrap();
        write_json(&legacy.join("favorites.json"), &json!(["TOR"])).unwrap();
        let destination = current.join("favorites.json");
        fs::write(&destination, b"invalid json").unwrap();

        assert_eq!(
            read_or_migrate_json(
                &current,
                "favorites.json",
                &[legacy.clone()],
                Value::is_array
            ),
            None
        );
        assert_eq!(fs::read(&destination).unwrap(), b"invalid json");
        assert_eq!(
            read_json(&legacy.join("favorites.json")),
            Some(json!(["TOR"]))
        );

        fs::remove_file(legacy.join("favorites.json")).unwrap();
        fs::remove_file(destination).unwrap();
        fs::remove_dir(legacy).unwrap();
        fs::remove_dir(current).unwrap();
        fs::remove_dir(root).unwrap();
    }
}
