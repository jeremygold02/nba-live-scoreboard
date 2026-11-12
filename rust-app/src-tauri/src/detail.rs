use crate::plays;
use crate::scoreboard::{ScoreboardService, ScoreboardSnapshot};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Default)]
struct Backoff {
    delay_seconds: u64,
    until: Option<Instant>,
}

impl Backoff {
    fn remaining_ms(&self) -> u64 {
        self.until
            .and_then(|until| until.checked_duration_since(Instant::now()))
            .map(|remaining| remaining.as_millis().min(u64::MAX as u128) as u64)
            .unwrap_or(0)
    }

    fn failed(&mut self) {
        self.delay_seconds = (self.delay_seconds.max(1) * 2).min(60);
        self.until = Some(Instant::now() + Duration::from_secs(self.delay_seconds));
    }

    fn clear(&mut self) {
        self.delay_seconds = 0;
        self.until = None;
    }
}

#[derive(Clone)]
struct BoxSnapshot {
    home: Value,
    away: Value,
    periods: Value,
    updated: String,
}

#[derive(Default)]
struct GameCache {
    box_score: Option<BoxSnapshot>,
    playbyplay: Option<Value>,
    box_backoff: Backoff,
    playbyplay_backoff: Backoff,
}

#[derive(Clone, Copy, Default)]
struct RequestHealth {
    success_streak: u32,
    failure_streak: u32,
}

impl RequestHealth {
    fn record(&mut self, success: bool) {
        if success {
            self.success_streak = (self.success_streak + 1).min(6);
            self.failure_streak = 0;
        } else {
            self.success_streak = 0;
            self.failure_streak = (self.failure_streak + 1).min(6);
        }
    }
}

#[derive(Clone, Copy, Default)]
struct DetailHealth {
    box_score: RequestHealth,
    playbyplay: RequestHealth,
}

/// Holds independent caches and retry schedules for each game's box score and
/// play-by-play. A per-game lock also coalesces concurrent detail requests.
pub struct DetailService {
    games: Mutex<HashMap<String, Arc<Mutex<GameCache>>>>,
    health: Mutex<DetailHealth>,
}

impl DetailService {
    pub fn new() -> Self {
        Self {
            games: Mutex::new(HashMap::new()),
            health: Mutex::new(DetailHealth::default()),
        }
    }

    fn with_polling(&self, state: Value, backoff_ms: u64, scoreboard_failures: u32) -> Value {
        let health = *self
            .health
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        with_polling(state, backoff_ms, health, scoreboard_failures)
    }

    pub fn state(
        &self,
        scoreboard: &ScoreboardService,
        date: Option<&str>,
        game_id: Option<&str>,
    ) -> Value {
        let snapshot = scoreboard.snapshot(date, game_id);
        if let Some(error) = &snapshot.error {
            return self.with_polling(
                simple_state("error", &snapshot, Some(error)),
                scoreboard.rate_limit_remaining_ms(),
                scoreboard.failure_streak(),
            );
        }
        if snapshot.games.is_empty() {
            return self.with_polling(simple_state("no_games", &snapshot, None), 0, 0);
        }
        let game_id = match game_id.filter(|id| !id.is_empty()) {
            Some(id) => id,
            None => return self.with_polling(simple_state("select_game", &snapshot, None), 0, 0),
        };
        let selected = match snapshot
            .games
            .iter()
            .find(|game| game["gameId"].as_str() == Some(game_id))
        {
            Some(game) => game,
            None => {
                return self.with_polling(simple_state("game_not_found", &snapshot, None), 0, 0)
            }
        };

        let mut game_status = number_i64(&selected["gameStatus"]).unwrap_or(0);
        let mut status_text = string(&selected["gameStatusText"]);
        let mut game = json!({
            "gameId": selected["gameId"],
            "status": map_status(game_status, &status_text),
            "statusKey": status_key(game_status),
            "statusText": status_text,
            "period": selected["period"],
            "clock": string(&selected["gameClock"]),
            "startTimeUTC": string(&selected["gameTimeUTC"]),
            "arena": {
                "name": string(&selected["arenaName"]),
                "city": string(&selected["arenaCity"]),
                "state": string(&selected["arenaState"]),
            },
        });
        let home_fallback = team_from_scoreboard(&selected["homeTeam"]);
        let away_fallback = team_from_scoreboard(&selected["awayTeam"]);
        if game_status != 2 && game_status != 3 {
            let state = json!({
                "status": "scheduled",
                "updated": snapshot.updated,
                "dataUpdated": snapshot.updated,
                "dataStatus": null,
                "game": game,
                "games": snapshot.summaries,
                "recentPlays": null,
                "periods": [],
                "home": empty_team(home_fallback),
                "away": empty_team(away_fallback),
                "error": null,
                "scoreboardDate": snapshot.date,
                "isToday": snapshot.is_today,
            });
            return self.with_polling(state, 0, 0);
        }

        let entry = {
            let mut games = self.games.lock().unwrap_or_else(|err| err.into_inner());
            games
                .entry(game_id.to_owned())
                .or_insert_with(|| Arc::new(Mutex::new(GameCache::default())))
                .clone()
        };
        let mut cache = entry.lock().unwrap_or_else(|err| err.into_inner());

        let mut fetch_error = None;
        let mut using_cached_box = cache.box_backoff.remaining_ms() > 0;
        let box_payload = if using_cached_box {
            None
        } else {
            let (result, used_fallback) = fetch_box(scoreboard, game_id);
            let mut health = self
                .health
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if used_fallback {
                health.box_score.record(false);
            }
            health.box_score.record(result.is_ok());
            drop(health);
            match result {
                Ok(payload) => {
                    cache.box_backoff.clear();
                    Some(payload)
                }
                Err(error) => {
                    cache.box_backoff.failed();
                    fetch_error = Some(if error.starts_with("NBA_RATE_LIMIT:") {
                        "The NBA data source is temporarily rate-limiting the box score. The app will retry after the cooldown."
                            .to_owned()
                    } else {
                        error
                    });
                    using_cached_box = true;
                    None
                }
            }
        };

        let cached_box = if using_cached_box {
            cache.box_score.clone()
        } else {
            None
        };
        let (mut home, mut away, periods, data_updated) = if let Some(cached) = &cached_box {
            (
                cached.home.clone(),
                cached.away.clone(),
                cached.periods.clone(),
                cached.updated.clone(),
            )
        } else if let Some(payload) = box_payload {
            let game_data = &payload["game"];
            if let Some(status) = number_i64(&game_data["gameStatus"]).filter(|value| *value > 0) {
                game_status = status;
            }
            let incoming_text = string(&game_data["gameStatusText"]);
            if !incoming_text.is_empty() {
                status_text = incoming_text;
            }
            game["status"] = json!(map_status(game_status, &status_text));
            game["statusKey"] = json!(status_key(game_status));
            game["statusText"] = json!(status_text);
            if number_i64(&game_data["period"]).unwrap_or(0) > 0 {
                game["period"] = game_data["period"].clone();
            }
            if !game_data["gameClock"].is_null() {
                game["clock"] = json!(string(&game_data["gameClock"]));
            }

            let periods = build_periods(game_data, &game);
            let home = if game_data["homeTeam"].is_object() {
                team_from_boxscore(&game_data["homeTeam"], home_fallback)
            } else {
                empty_team(home_fallback)
            };
            let away = if game_data["awayTeam"].is_object() {
                team_from_boxscore(&game_data["awayTeam"], away_fallback)
            } else {
                empty_team(away_fallback)
            };
            if has_players(&home) && has_players(&away) {
                cache.box_score = Some(BoxSnapshot {
                    home: home.clone(),
                    away: away.clone(),
                    periods: periods.clone(),
                    updated: snapshot.updated.clone(),
                });
            }
            (home, away, periods, snapshot.updated.clone())
        } else {
            (
                empty_team(home_fallback),
                empty_team(away_fallback),
                json!([]),
                snapshot.updated.clone(),
            )
        };

        let include_on_court = game_status == 2 && has_players(&home) && has_players(&away);
        let play_state = fetch_playbyplay(
            scoreboard,
            game_id,
            &home,
            &away,
            include_on_court,
            &mut cache,
            &self.health,
        );
        game["halftimeStartedAt"] = play_state["halftimeStartedAt"].clone();
        apply_on_court(&mut home, &mut away, &play_state["onCourt"]);
        let recent_plays = serialize_recent_plays(&play_state["recentPlays"]);
        let on_court = &play_state["onCourt"];
        let data_status = if cached_box.is_some() {
            let issue = on_court["message"].as_str().unwrap_or("");
            let issues = if issue.is_empty() {
                vec![]
            } else {
                vec![issue]
            };
            data_status(
                "stale",
                "Showing cached box score",
                "The latest box score is temporarily unavailable, so the app is using its last successful snapshot.",
                &data_updated,
                issues,
            )
        } else if using_cached_box {
            data_status(
                "pending",
                "Box score temporarily unavailable",
                "The app will retry the box score after the current backoff.",
                &snapshot.updated,
                vec![],
            )
        } else if game_status == 2 && !has_players(&home) && !has_players(&away) {
            data_status(
                "pending",
                "Live box score pending",
                "The game is live, but player stats have not populated yet.",
                &snapshot.updated,
                vec![],
            )
        } else if game_status == 2
            && matches!(on_court["state"].as_str(), Some("stale" | "missing"))
        {
            let message = on_court["message"]
                .as_str()
                .unwrap_or("On-court lineups are unavailable right now.");
            data_status(
                "partial",
                "Live box score is current",
                message,
                &snapshot.updated,
                vec![message],
            )
        } else {
            Value::Null
        };
        let status = if has_players(&home) || has_players(&away) {
            "ok"
        } else if game_status == 3 {
            "postgame"
        } else {
            "live_no_data"
        };
        let error = if cached_box.is_some() {
            Some("Using cached data after a box score error.".to_owned())
        } else if using_cached_box {
            Some(
                fetch_error
                    .unwrap_or_else(|| "The box score is temporarily unavailable.".to_owned()),
            )
        } else {
            None
        };
        let rate_limit_ms = if matches!(
            data_status["level"].as_str(),
            Some("stale" | "partial" | "pending")
        ) {
            scoreboard.rate_limit_remaining_ms()
        } else {
            0
        };
        let backoff_ms = cache
            .box_backoff
            .remaining_ms()
            .max(cache.playbyplay_backoff.remaining_ms())
            .max(rate_limit_ms);
        self.with_polling(
            json!({
                "status": status,
                "updated": snapshot.updated,
                "dataUpdated": data_updated,
                "dataStatus": data_status,
                "game": game,
                "games": snapshot.summaries,
                "recentPlays": recent_plays,
                "periods": periods,
                "home": home,
                "away": away,
                "error": error,
                "scoreboardDate": snapshot.date,
                "isToday": snapshot.is_today,
            }),
            backoff_ms,
            0,
        )
    }
}

fn fetch_box(scoreboard: &ScoreboardService, game_id: &str) -> (Result<Value, String>, bool) {
    match scoreboard.fetch_live(&format!("boxscore/boxscore_{game_id}.json")) {
        Ok(payload) if payload["game"].is_object() => (Ok(payload), false),
        Ok(_) => (
            Err("The NBA box score did not contain game data.".to_owned()),
            false,
        ),
        Err(error) if error.starts_with("NBA_RATE_LIMIT:") => (Err(error), false),
        Err(_) => {
            let result = scoreboard.fetch_game_page(game_id).and_then(|page| {
                if page["game"].is_object() {
                    Ok(json!({ "game": page["game"] }))
                } else {
                    Err("The NBA game page did not contain a box score.".to_owned())
                }
            });
            (result, true)
        }
    }
}

fn fetch_playbyplay(
    scoreboard: &ScoreboardService,
    game_id: &str,
    home: &Value,
    away: &Value,
    include_on_court: bool,
    cache: &mut GameCache,
    health: &Mutex<DetailHealth>,
) -> Value {
    if cache.playbyplay_backoff.remaining_ms() > 0 {
        return stale_playbyplay(cache.playbyplay.as_ref(), include_on_court);
    }
    let mut used_fallback = false;
    let payload = match scoreboard.fetch_live(&format!("playbyplay/playbyplay_{game_id}.json")) {
        Ok(value) if value["game"]["actions"].is_array() => Ok(value),
        Ok(_) => Err("The NBA play-by-play response did not contain actions.".to_owned()),
        Err(error) if error.starts_with("NBA_RATE_LIMIT:") => Err(error),
        Err(_) => {
            used_fallback = true;
            scoreboard.fetch_game_page(game_id).and_then(|page| {
                let playbyplay = &page["playByPlay"];
                if playbyplay["gameId"].as_str() == Some(game_id)
                    && playbyplay["actions"].is_array()
                {
                    Ok(json!({ "game": playbyplay }))
                } else {
                    Err("The NBA game page did not contain play-by-play for this game.".to_owned())
                }
            })
        }
    };
    let mut health = health.lock().unwrap_or_else(|error| error.into_inner());
    if used_fallback {
        health.playbyplay.record(false);
    }
    health.playbyplay.record(payload.is_ok());
    drop(health);
    match payload {
        Ok(payload) => {
            cache.playbyplay_backoff.clear();
            let result = plays::build_playbyplay(
                &payload,
                home,
                away,
                include_on_court,
                cache.playbyplay.as_ref(),
            );
            let mut cached_result = result.clone();
            if let Some(previous) = &cache.playbyplay {
                // A successful but empty response must not discard the last
                // useful lineup or plays needed by a later failed request.
                for key in ["onCourt", "recentPlays"] {
                    if result[key]["data"].is_null() && !previous[key]["data"].is_null() {
                        cached_result[key] = previous[key].clone();
                    }
                }
            }
            cache.playbyplay = Some(cached_result);
            result
        }
        Err(_) => {
            cache.playbyplay_backoff.failed();
            stale_playbyplay(cache.playbyplay.as_ref(), include_on_court)
        }
    }
}

fn stale_playbyplay(cached: Option<&Value>, include_on_court: bool) -> Value {
    let on_court = cached
        .map(|value| &value["onCourt"]["data"])
        .filter(|data| include_on_court && data.is_object());
    let recent = cached
        .map(|value| &value["recentPlays"]["data"])
        .filter(|data| data.as_array().is_some_and(|plays| !plays.is_empty()));
    json!({
        "halftimeStartedAt": cached.and_then(|value| value["halftimeStartedAt"].as_str()),
        "onCourt": {
            "data": on_court,
            "state": if on_court.is_some() { "stale" } else { "missing" },
            "message": if on_court.is_some() {
                Some("Using cached on-court lineups because play-by-play is unavailable.")
            } else if include_on_court {
                Some("On-court lineups are unavailable because play-by-play data could not be loaded.")
            } else { None },
        },
        "recentPlays": {
            "data": recent,
            "state": if recent.is_some() { "stale" } else { "missing" },
            "message": if recent.is_some() {
                "Showing cached recent plays because play-by-play is unavailable."
            } else {
                "Recent plays are unavailable because play-by-play data could not be loaded."
            },
        },
    })
}

fn simple_state(status: &str, snapshot: &ScoreboardSnapshot, error: Option<&str>) -> Value {
    let mut state = json!({
        "status": status,
        "updated": snapshot.updated,
        "games": if status == "error" || status == "no_games" { json!([]) } else { json!(snapshot.summaries) },
        "scoreboardDate": snapshot.date,
        "isToday": snapshot.is_today,
    });
    if let Some(error) = error {
        state["error"] = json!(error);
    }
    state
}

fn adaptive_interval(
    base: u64,
    minimum: u64,
    health: DetailHealth,
    scoreboard_failures: u32,
) -> u64 {
    let failures = scoreboard_failures
        .max(health.box_score.failure_streak)
        .max(health.playbyplay.failure_streak);
    if failures > 0 {
        return (base * u64::from((1 + failures).min(4))).clamp(minimum, 60_000);
    }
    let successes = health
        .box_score
        .success_streak
        .max(health.playbyplay.success_streak)
        .min(4);
    base.saturating_sub((base - minimum) * u64::from(successes) / 4)
        .clamp(minimum, 60_000)
}

fn with_polling(
    mut state: Value,
    backoff_ms: u64,
    health: DetailHealth,
    scoreboard_failures: u32,
) -> Value {
    let status = state["status"].as_str().unwrap_or("");
    let game_status = state["game"]["statusKey"].as_str().unwrap_or("");
    let level = state["dataStatus"]["level"].as_str().unwrap_or("");
    let (base, minimum, mode, reason) = if status == "error" {
        (20_000, 20_000, "error", Some("detail_error"))
    } else if game_status != "live" {
        (20_000, 20_000, "idle", None)
    } else if level == "stale" {
        (12_000, 12_000, "backoff", None)
    } else if matches!(level, "partial" | "pending") {
        (12_000, 9_000, "partial", None)
    } else {
        (8_000, 5_000, "live", None)
    };
    let delay = if mode == "idle" {
        base
    } else {
        adaptive_interval(base, minimum, health, scoreboard_failures).max(backoff_ms)
    };
    let mut polling = json!({ "refreshMs": delay, "mode": mode });
    if let Some(reason) = reason {
        polling["reason"] = json!(reason);
    }
    state["polling"] = polling;
    state
}

fn data_status(level: &str, title: &str, message: &str, updated: &str, issues: Vec<&str>) -> Value {
    json!({
        "level": level,
        "title": title,
        "message": message,
        "updated": updated,
        "issues": issues,
    })
}

fn serialize_recent_plays(state: &Value) -> Value {
    if state["data"]
        .as_array()
        .is_some_and(|plays| !plays.is_empty())
    {
        json!({
            "plays": state["data"],
            "state": state["state"].as_str().unwrap_or("fresh"),
            "message": state["message"],
        })
    } else {
        Value::Null
    }
}

fn apply_on_court(home: &mut Value, away: &mut Value, state: &Value) {
    for (team, key) in [(home, "home"), (away, "away")] {
        team["onCourt"] = state["data"][key]
            .as_array()
            .map(|values| json!(values))
            .unwrap_or_else(|| json!([]));
    }
}

fn build_periods(game_data: &Value, game: &Value) -> Value {
    let home = game_data["homeTeam"]["periods"].as_array();
    let away = game_data["awayTeam"]["periods"].as_array();
    let count = number_i64(&game_data["period"])
        .filter(|count| *count > 0)
        .or_else(|| number_i64(&game["period"]).filter(|count| *count > 0))
        .unwrap_or(4) as usize;
    let count = count
        .max(home.map_or(0, Vec::len))
        .max(away.map_or(0, Vec::len));
    let mut periods = Vec::with_capacity(count);
    for index in 0..count {
        let home_period = home
            .and_then(|values| values.get(index))
            .unwrap_or(&Value::Null);
        let away_period = away
            .and_then(|values| values.get(index))
            .unwrap_or(&Value::Null);
        let number = number_i64(&home_period["period"])
            .filter(|number| *number > 0)
            .or_else(|| number_i64(&away_period["period"]).filter(|number| *number > 0))
            .unwrap_or((index + 1) as i64);
        let label = if number <= 4 {
            format!("Q{number}")
        } else {
            format!("OT{}", number - 4)
        };
        periods.push(json!({
            "label": label,
            "home": stat(home_period, "score"),
            "away": stat(away_period, "score"),
        }));
    }
    json!(periods)
}

fn team_from_scoreboard(team: &Value) -> Value {
    json!({
        "id": team["teamId"],
        "city": string(&team["teamCity"]),
        "name": string(&team["teamName"]),
        "tricode": string(&team["teamTricode"]),
        "score": stat(team, "score"),
        "wins": stat(team, "wins"),
        "losses": stat(team, "losses"),
        "timeoutsRemaining": team["timeoutsRemaining"],
        "inBonus": team["inBonus"],
    })
}

fn empty_team(mut team: Value) -> Value {
    team["stats"] = json!({});
    team["players"] = json!([]);
    team["onCourt"] = json!([]);
    team
}

fn team_from_boxscore(team: &Value, mut fallback: Value) -> Value {
    let stats = &team["statistics"];
    let players: Vec<Value> = team["players"]
        .as_array()
        .map(|players| players.iter().map(build_player).collect())
        .unwrap_or_default();
    if !team["score"].is_null() {
        fallback["score"] = team["score"].clone();
    }
    fallback["stats"] = normalized_stats(stats);
    fallback["players"] = json!(players);
    fallback
}

fn build_player(player: &Value) -> Value {
    let stats = &player["statistics"];
    let mut result = normalized_stats(stats);
    let first = string(&player["firstName"]);
    let last = string(&player["familyName"]);
    result["personId"] = player["personId"].clone();
    result["name"] = json!(format!("{first} {last}").trim());
    result["jerseyNum"] = json!(string(&player["jerseyNum"]));
    result["position"] = json!(string(&player["position"]));
    result["starter"] = json!(coerce_bool(&player["starter"]));
    result["status"] = json!(string(&player["status"]));
    result["minutes"] = if !string(&stats["minutes"]).is_empty() {
        stats["minutes"].clone()
    } else if !player["minutes"].is_null() {
        player["minutes"].clone()
    } else {
        json!("")
    };
    result["plusMinus"] = stat(stats, "plusMinusPoints");
    result
}

fn normalized_stats(stats: &Value) -> Value {
    let points = number_f64(&stats["points"]);
    let fgm = number_f64(&stats["fieldGoalsMade"]);
    let fga = number_f64(&stats["fieldGoalsAttempted"]);
    let tpm = number_f64(&stats["threePointersMade"]);
    let fta = number_f64(&stats["freeThrowsAttempted"]);
    let ts_denom = 2.0 * (fga + 0.44 * fta);
    let ts = if ts_denom > 0.0 {
        Some(round_one(points / ts_denom * 100.0))
    } else {
        None
    };
    let efg = if fga > 0.0 {
        Some(round_one((fgm + 0.5 * tpm) / fga * 100.0))
    } else {
        None
    };
    json!({
        "points": stat(stats, "points"),
        "rebounds": stat(stats, "reboundsTotal"),
        "assists": stat(stats, "assists"),
        "steals": stat(stats, "steals"),
        "blocks": stat(stats, "blocks"),
        "turnovers": stat(stats, "turnovers"),
        "fouls": stat(stats, "foulsPersonal"),
        "fgm": stat(stats, "fieldGoalsMade"),
        "fga": stat(stats, "fieldGoalsAttempted"),
        "tpm": stat(stats, "threePointersMade"),
        "tpa": stat(stats, "threePointersAttempted"),
        "ftm": stat(stats, "freeThrowsMade"),
        "fta": stat(stats, "freeThrowsAttempted"),
        "tsPct": ts,
        "efgPct": efg,
    })
}

fn has_players(team: &Value) -> bool {
    team["players"]
        .as_array()
        .is_some_and(|players| !players.is_empty())
}

fn stat(value: &Value, key: &str) -> Value {
    if value[key].is_null() {
        json!(0)
    } else {
        value[key].clone()
    }
}

fn string(value: &Value) -> String {
    match value {
        Value::String(text) => text.to_owned(),
        Value::Number(number) => number.to_string(),
        _ => String::new(),
    }
}

fn number_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
}

fn number_f64(value: &Value) -> f64 {
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
        .unwrap_or(0.0)
}

fn round_one(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

fn coerce_bool(value: &Value) -> bool {
    value.as_bool().unwrap_or_else(|| {
        matches!(
            string(value).to_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

fn status_key(status: i64) -> &'static str {
    match status {
        2 => "live",
        3 => "final",
        _ => "scheduled",
    }
}

fn map_status(status: i64, text: &str) -> String {
    match status {
        1 => {
            let lower = text.to_lowercase();
            let has_digits = text.chars().any(|c| c.is_ascii_digit());
            let looks_like_tipoff = (has_digits && text.contains(':'))
                || lower.contains(" am")
                || lower.contains(" pm")
                || (has_digits
                    && [" et", " ct", " mt", " pt"]
                        .iter()
                        .any(|zone| lower.contains(zone)));
            if !text.is_empty() && !looks_like_tipoff {
                text.to_owned()
            } else {
                "Scheduled".to_owned()
            }
        }
        2 => "Live".to_owned(),
        3 => "Final".to_owned(),
        _ if !text.is_empty() => text.to_owned(),
        _ => "Unknown".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scoreboard::test_support::FixtureServer;
    use std::sync::atomic::{AtomicBool, Ordering};

    #[test]
    fn failed_box_feeds_use_cached_data_and_recover() {
        let game_id = "0022600211";
        let scoreboard = json!({"scoreboard":{"games":[{
            "gameId":game_id, "gameStatus":2, "gameStatusText":"Live", "period":1,
            "homeTeam":{"teamId":1,"teamTricode":"HOM","score":12},
            "awayTeam":{"teamId":2,"teamTricode":"AWY","score":10}
        }]}});
        let box_score = json!({"game":{"gameId":game_id,"gameStatus":2,"period":1,
            "homeTeam":{"score":12,"statistics":{},"players":[{"personId":11,"position":"G","firstName":"Home","familyName":"Player","statistics":{"points":12}}]},
            "awayTeam":{"score":10,"statistics":{},"players":[{"personId":22,"position":"G","firstName":"Away","familyName":"Player","statistics":{"points":10}}]}
        }});
        let playbyplay = json!({"game":{"actions":[]}});
        let fail_box = Arc::new(AtomicBool::new(false));
        let fail_flag = Arc::clone(&fail_box);
        let server = FixtureServer::new(move |path| {
            if path.starts_with("/live/scoreboard/") {
                (200, scoreboard.to_string())
            } else if path.starts_with("/live/boxscore/") {
                if fail_flag.load(Ordering::Relaxed) {
                    (403, String::new())
                } else {
                    (200, box_score.to_string())
                }
            } else if path.starts_with("/live/playbyplay/") {
                (200, playbyplay.to_string())
            } else {
                (403, String::new())
            }
        });
        let scoreboard = ScoreboardService::with_test_server(&server.base);
        let detail = DetailService::new();
        let fresh = detail.state(&scoreboard, None, Some(game_id));
        assert_eq!(
            fresh["status"],
            "ok",
            "state: {fresh}; requests: {:?}",
            server.paths()
        );
        assert_eq!(fresh["home"]["players"][0]["points"], 12);

        fail_box.store(true, Ordering::Relaxed);
        let stale = detail.state(&scoreboard, None, Some(game_id));
        assert_eq!(stale["status"], "ok");
        assert_eq!(stale["dataStatus"]["level"], "stale");
        assert_eq!(stale["home"]["players"][0]["points"], 12);
        assert_eq!(stale["polling"]["refreshMs"], 36_000);
        assert_eq!(detail.health.lock().unwrap().box_score.failure_streak, 2);
        let paths = server.paths();
        assert!(
            paths.iter().any(|path| path.starts_with("/game/")),
            "requests: {paths:?}"
        );

        let during_backoff = detail.state(&scoreboard, None, Some(game_id));
        assert_eq!(during_backoff["dataStatus"]["level"], "stale");
        assert_eq!(detail.health.lock().unwrap().box_score.failure_streak, 2);

        detail
            .games
            .lock()
            .unwrap()
            .get(game_id)
            .unwrap()
            .lock()
            .unwrap()
            .box_backoff
            .clear();
        fail_box.store(false, Ordering::Relaxed);
        let recovered = detail.state(&scoreboard, None, Some(game_id));
        assert_eq!(recovered["status"], "ok");
        assert!(
            recovered["dataStatus"].is_null(),
            "state: {recovered}; requests: {:?}",
            server.paths()
        );
        assert_eq!(detail.health.lock().unwrap().box_score.failure_streak, 0);
    }

    #[test]
    fn normalizes_player_stats_and_zero_attempts() {
        let player = build_player(&json!({
            "personId": 10, "firstName": "Starter", "familyName": "Home",
            "starter": "1", "statistics": {"points": 7, "minutes": "PT05M00S"}
        }));
        assert_eq!(player["name"], "Starter Home");
        assert_eq!(player["starter"], true);
        assert_eq!(player["points"], 7);
        assert_eq!(player["minutes"], "PT05M00S");
        assert!(player["tsPct"].is_null());
        assert!(player["efgPct"].is_null());
    }

    #[test]
    fn calculates_shooting_percentages_and_overtime_periods() {
        let stats = normalized_stats(&json!({
            "points": 12, "fieldGoalsMade": 4, "fieldGoalsAttempted": 8,
            "threePointersMade": 2, "freeThrowsAttempted": 2
        }));
        assert_eq!(stats["efgPct"], 62.5);
        assert_eq!(stats["tsPct"], 67.6);
        let periods = build_periods(
            &json!({
                "period": 5,
                "homeTeam": {"periods": [{"period": 1, "score": 20}]},
                "awayTeam": {"periods": [{"period": 1, "score": 18}]}
            }),
            &json!({}),
        );
        assert_eq!(periods[0], json!({"label":"Q1","home":20,"away":18}));
        assert_eq!(periods[4]["label"], "OT1");
    }

    #[test]
    fn stale_playbyplay_keeps_cached_lineups_and_feed() {
        let result = stale_playbyplay(
            Some(&json!({
                "halftimeStartedAt": "2026-11-12T01:00:00Z",
                "onCourt": {"data": {"home": [11], "away": [20]}},
                "recentPlays": {"data": [{"description": "Basket"}]}
            })),
            true,
        );
        assert_eq!(result["onCourt"]["state"], "stale");
        assert_eq!(result["halftimeStartedAt"], "2026-11-12T01:00:00Z");
        assert_eq!(result["onCourt"]["data"]["home"], json!([11]));
        assert_eq!(
            serialize_recent_plays(&result["recentPlays"])["state"],
            "stale"
        );
        let no_lineups = stale_playbyplay(Some(&result), false);
        assert!(no_lineups["onCourt"]["data"].is_null());
    }

    #[test]
    fn independent_backoffs_can_be_cleared_separately() {
        let mut cache = GameCache::default();
        cache.box_backoff.failed();
        cache.playbyplay_backoff.failed();
        cache.playbyplay_backoff.clear();
        assert!(cache.box_backoff.remaining_ms() > 0);
        assert_eq!(cache.playbyplay_backoff.remaining_ms(), 0);
    }

    #[test]
    fn live_polling_slows_after_failures_and_recovers_after_successes() {
        let pending = json!({"status":"live_no_data", "game":{"statusKey":"live"},
            "dataStatus":{"level":"pending"}});
        let live = json!({"status":"ok", "game":{"statusKey":"live"}, "dataStatus":null});
        let mut health = DetailHealth::default();
        health.box_score.record(false);
        assert_eq!(
            with_polling(pending.clone(), 0, health, 0)["polling"]["refreshMs"],
            24_000
        );
        health.box_score.record(false);
        assert_eq!(
            with_polling(pending, 0, health, 0)["polling"]["refreshMs"],
            36_000
        );
        health.box_score.record(true);
        health.playbyplay.record(true);
        assert_eq!(
            with_polling(live.clone(), 0, health, 0)["polling"]["refreshMs"],
            7_250
        );
        for _ in 0..3 {
            health.box_score.record(true);
            health.playbyplay.record(true);
        }
        assert_eq!(
            with_polling(live, 0, health, 0)["polling"]["refreshMs"],
            5_000
        );
    }

    #[test]
    fn polling_honors_the_rate_limit_and_only_backs_off_live_games() {
        let error = json!({"status":"error"});
        let health = DetailHealth::default();
        assert_eq!(
            with_polling(error, 120_000, health, 1)["polling"]["refreshMs"],
            120_000
        );
        let finished = json!({"status":"postgame", "game":{"statusKey":"final"}});
        assert_eq!(
            with_polling(finished, 60_000, health, 0)["polling"]["refreshMs"],
            20_000
        );
    }

    #[test]
    fn playbyplay_backoff_does_not_count_an_unattempted_request_as_a_failure() {
        let service = ScoreboardService::new();
        let mut cache = GameCache::default();
        cache.playbyplay_backoff.failed();
        let health = Mutex::new(DetailHealth::default());
        fetch_playbyplay(
            &service,
            "game",
            &json!({}),
            &json!({}),
            false,
            &mut cache,
            &health,
        );
        assert_eq!(health.lock().unwrap().playbyplay.failure_streak, 0);
    }
}
