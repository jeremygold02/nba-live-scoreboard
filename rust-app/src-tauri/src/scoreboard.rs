use chrono::{DateTime, Local, Timelike, Utc};
use regex::Regex;
use reqwest::blocking::Client;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const LIVE_BASE: &str = "https://cdn.nba.com/static/json/liveData";
const STATS_BASE: &str = "https://stats.nba.com/stats";
const GAMES_URL: &str = "https://www.nba.com/games";
const GAME_BASE: &str = "https://www.nba.com/game";
const RATE_LIMIT_PREFIX: &str = "NBA_RATE_LIMIT:";

#[derive(Clone, Debug)]
pub struct ScoreboardSnapshot {
    pub updated: String,
    pub games: Vec<Value>,
    pub summaries: Vec<Value>,
    pub date: String,
    pub is_today: bool,
    pub error: Option<String>,
}

#[derive(Clone)]
pub struct ScoreboardService {
    inner: Arc<Inner>,
}

struct Inner {
    client: Client,
    limits: Mutex<HashMap<String, Instant>>,
    scoreboard_cache: Mutex<HashMap<(String, bool), (Instant, ScoreboardSnapshot)>>,
    scoreboard_locks: Mutex<HashMap<(String, bool), Arc<Mutex<()>>>>,
    page_cache: Mutex<HashMap<String, (Instant, Value)>>,
    page_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    schedule: Mutex<ScheduleChecks>,
    health: Mutex<RequestHealth>,
    #[cfg(test)]
    test_endpoints: Option<TestEndpoints>,
}

#[cfg(test)]
struct TestEndpoints {
    live: String,
    games: String,
    stats: String,
    game: String,
}

#[derive(Default)]
struct ScheduleChecks {
    checked: HashMap<String, (Instant, Option<Value>)>,
    pending: HashSet<String>,
}

#[derive(Default)]
struct RequestHealth {
    success_streak: u32,
    failure_streak: u32,
}

#[derive(Debug)]
struct FetchError {
    message: String,
    rate_limited: bool,
}

impl FetchError {
    fn other(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            rate_limited: false,
        }
    }

    fn limited(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            rate_limited: true,
        }
    }

    fn public_message(&self) -> String {
        if self.rate_limited {
            format!("{RATE_LIMIT_PREFIX} {}", self.message)
        } else {
            self.message.clone()
        }
    }
}

impl ScoreboardService {
    pub fn new() -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(15))
            .user_agent(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:138.0) Gecko/20100101 Firefox/138.0",
            )
            .build()
            .expect("failed to initialize the HTTP client");
        Self {
            inner: Arc::new(Inner {
                client,
                limits: Mutex::new(HashMap::new()),
                scoreboard_cache: Mutex::new(HashMap::new()),
                scoreboard_locks: Mutex::new(HashMap::new()),
                page_cache: Mutex::new(HashMap::new()),
                page_locks: Mutex::new(HashMap::new()),
                schedule: Mutex::new(ScheduleChecks::default()),
                health: Mutex::new(RequestHealth::default()),
                #[cfg(test)]
                test_endpoints: None,
            }),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_test_server(base: &str) -> Self {
        Self::with_test_servers(base, base)
    }

    #[cfg(test)]
    fn with_test_servers(live: &str, fallback: &str) -> Self {
        let mut service = Self::new();
        let inner = Arc::get_mut(&mut service.inner).expect("new service has one owner");
        inner.test_endpoints = Some(TestEndpoints {
            live: format!("{live}/live"),
            games: format!("{fallback}/games"),
            stats: format!("{fallback}/stats"),
            game: format!("{fallback}/game"),
        });
        service
    }

    fn live_base(&self) -> &str {
        #[cfg(test)]
        if let Some(endpoints) = &self.inner.test_endpoints {
            return &endpoints.live;
        }
        LIVE_BASE
    }

    fn games_url(&self) -> &str {
        #[cfg(test)]
        if let Some(endpoints) = &self.inner.test_endpoints {
            return &endpoints.games;
        }
        GAMES_URL
    }

    fn stats_base(&self) -> &str {
        #[cfg(test)]
        if let Some(endpoints) = &self.inner.test_endpoints {
            return &endpoints.stats;
        }
        STATS_BASE
    }

    fn game_base(&self) -> &str {
        #[cfg(test)]
        if let Some(endpoints) = &self.inner.test_endpoints {
            return &endpoints.game;
        }
        GAME_BASE
    }

    fn request(&self, url: &str, query: &[(&str, &str)]) -> Result<String, FetchError> {
        let parsed_url =
            reqwest::Url::parse(url).map_err(|error| FetchError::other(error.to_string()))?;
        let mut origin = parsed_url.host_str().unwrap_or("").to_ascii_lowercase();
        if let Some(port) = parsed_url.port() {
            origin.push_str(&format!(":{port}"));
        }

        for attempt in 0..3 {
            {
                let limits = self.inner.limits.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(until) = limits.get(&origin) {
                    if *until > Instant::now() {
                        return Err(FetchError::limited(format!("Cooldown active for {origin}")));
                    }
                }
            }

            let response = self
                .inner
                .client
                .get(url)
                .query(query)
                .header("Accept", "application/json, text/plain, */*")
                .header("Accept-Language", "en-US,en;q=0.5")
                .header("Referer", "https://www.nba.com/")
                .header("Origin", "https://www.nba.com")
                .header("Cache-Control", "no-cache")
                .header("Pragma", "no-cache")
                .send();

            let response = match response {
                Ok(response) => response,
                Err(error)
                    if attempt < 2
                        && (error.is_timeout() || error.is_connect() || error.is_body()) =>
                {
                    std::thread::sleep(Duration::from_millis(500 * (attempt + 1)));
                    continue;
                }
                Err(error) => {
                    return Err(FetchError::other(format!(
                        "NBA data connection failed: {error}"
                    )))
                }
            };

            if response.status().as_u16() == 429 {
                let delay = retry_after_seconds(
                    response
                        .headers()
                        .get("Retry-After")
                        .and_then(|v| v.to_str().ok()),
                );
                let duration = Duration::try_from_secs_f64(delay.max(1.0))
                    .unwrap_or(Duration::from_secs(365 * 24 * 60 * 60));
                let until = Instant::now()
                    .checked_add(duration)
                    .unwrap_or_else(|| Instant::now() + Duration::from_secs(365 * 24 * 60 * 60));
                let mut limits = self.inner.limits.lock().unwrap_or_else(|e| e.into_inner());
                let entry = limits.entry(origin.clone()).or_insert(until);
                if *entry < until {
                    *entry = until;
                }
                return Err(FetchError::limited(format!(
                    "{origin} asked to retry after {delay:.0} seconds"
                )));
            }
            let response = response
                .error_for_status()
                .map_err(|error| FetchError::other(format!("NBA data request failed: {error}")))?;
            match response.text() {
                Ok(text) => return Ok(text),
                Err(error)
                    if attempt < 2
                        && (error.is_timeout()
                            || error.is_connect()
                            || error.is_body()
                            || error.is_decode()) =>
                {
                    std::thread::sleep(Duration::from_millis(500 * (attempt + 1)));
                }
                Err(error) => {
                    return Err(FetchError::other(format!(
                        "Unable to read NBA response: {error}"
                    )))
                }
            }
        }
        Err(FetchError::other("Unable to reach the NBA data source"))
    }

    fn request_json(&self, url: &str, query: &[(&str, &str)]) -> Result<Value, FetchError> {
        let text = self.request(url, query)?;
        serde_json::from_str(text.trim_start_matches('\u{feff}').trim())
            .map_err(|_| FetchError::other("The NBA data source returned an invalid response."))
    }

    fn live(&self, path: &str) -> Result<Value, FetchError> {
        self.request_json(
            &format!("{}/{}", self.live_base(), path.trim_start_matches('/')),
            &[],
        )
    }

    pub fn fetch_live(&self, path: &str) -> Result<Value, String> {
        self.live(path).map_err(|error| error.public_message())
    }

    fn dated_scoreboard(&self, date: &str) -> Result<Value, FetchError> {
        let page = self
            .request(self.games_url(), &[("date", date)])
            .and_then(|text| parse_games_page(&text, date));
        match page {
            Ok(board) => Ok(board),
            Err(error) if error.rate_limited => Err(error),
            Err(_) => self.request_json(
                &format!("{}/scoreboardv3", self.stats_base()),
                &[("GameDate", date), ("LeagueID", "00")],
            ),
        }
    }

    fn game_page(&self, game_id: &str) -> Result<Value, FetchError> {
        if game_id.is_empty()
            || game_id.len() > 32
            || !game_id.bytes().all(|c| c.is_ascii_alphanumeric())
        {
            return Err(FetchError::other("Invalid game ID"));
        }
        let page_lock = {
            let mut locks = self
                .inner
                .page_locks
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            locks
                .entry(game_id.to_owned())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        let _guard = page_lock.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((when, data)) = self
            .inner
            .page_cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(game_id)
        {
            if when.elapsed() < Duration::from_secs(15) {
                return Ok(data.clone());
            }
        }
        let html = self.request(&format!("{}/{game_id}/box-score", self.game_base()), &[])?;
        let page = parse_next_data(&html)?;
        let props = &page["props"]["pageProps"];
        let game = &props["game"];
        if game["gameId"].as_str() != Some(game_id) {
            return Err(FetchError::other(
                "NBA game page returned data for a different game.",
            ));
        }
        let result = json!({"game": game, "playByPlay": props["playByPlay"]});
        self.inner
            .page_cache
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(game_id.to_owned(), (Instant::now(), result.clone()));
        Ok(result)
    }

    pub fn fetch_game_page(&self, game_id: &str) -> Result<Value, String> {
        self.game_page(game_id)
            .map_err(|error| error.public_message())
    }

    pub fn rate_limit_remaining_ms(&self) -> u64 {
        let now = Instant::now();
        self.inner
            .limits
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .filter_map(|until| until.checked_duration_since(now))
            .map(|remaining| remaining.as_millis().min(u64::MAX as u128) as u64)
            .max()
            .unwrap_or(0)
    }

    pub(crate) fn failure_streak(&self) -> u32 {
        self.inner
            .health
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .failure_streak
    }

    fn load_snapshot(&self, date: String, is_today: bool) -> ScoreboardSnapshot {
        let updated = Utc::now().to_rfc3339();
        let board = if is_today {
            match self.live("scoreboard/todaysScoreboard_00.json") {
                Ok(value) => Ok(value),
                Err(error) if error.rate_limited => Err(error),
                Err(_) => self.dated_scoreboard(&date),
            }
        } else {
            self.dated_scoreboard(&date)
        };
        let games = board.and_then(|board| {
            board["scoreboard"]["games"]
                .as_array()
                .cloned()
                .ok_or_else(|| {
                    FetchError::other(
                        "The NBA data source returned an invalid scoreboard response.",
                    )
                })
        });
        match games {
            Ok(games) => {
                let mut health = self.inner.health.lock().unwrap_or_else(|e| e.into_inner());
                health.success_streak = (health.success_streak + 1).min(6);
                health.failure_streak = 0;
                ScoreboardSnapshot {
                    updated,
                    games,
                    summaries: Vec::new(),
                    date,
                    is_today,
                    error: None,
                }
            }
            Err(error) => {
                let mut health = self.inner.health.lock().unwrap_or_else(|e| e.into_inner());
                health.success_streak = 0;
                health.failure_streak = (health.failure_streak + 1).min(6);
                let message = if error.rate_limited {
                    "The NBA data source is temporarily rate-limiting the scoreboard. The app will retry after the cooldown.".to_owned()
                } else {
                    error.message
                };
                ScoreboardSnapshot {
                    updated,
                    games: Vec::new(),
                    summaries: Vec::new(),
                    date,
                    is_today,
                    error: Some(message),
                }
            }
        }
    }

    pub fn snapshot(
        &self,
        date: Option<&str>,
        selected_game_id: Option<&str>,
    ) -> ScoreboardSnapshot {
        let date = normalize_date(date);
        let is_today = date == local_today();
        let key = (date.clone(), is_today);
        let request_lock = {
            let mut locks = self
                .inner
                .scoreboard_locks
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            locks
                .entry(key.clone())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        let mut snapshot = {
            let _guard = request_lock.lock().unwrap_or_else(|e| e.into_inner());
            let cached = self
                .inner
                .scoreboard_cache
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(&key)
                .filter(|(time, _)| time.elapsed() < Duration::from_secs(2))
                .map(|(_, snapshot)| snapshot.clone());
            match cached {
                Some(snapshot) => snapshot,
                None => {
                    let snapshot = self.load_snapshot(date.clone(), is_today);
                    if snapshot.error.is_none() {
                        let mut cache = self
                            .inner
                            .scoreboard_cache
                            .lock()
                            .unwrap_or_else(|e| e.into_inner());
                        cache.insert(key, (Instant::now(), snapshot.clone()));
                        if cache.len() > 16 {
                            if let Some(oldest) = cache
                                .iter()
                                .min_by_key(|(_, (when, _))| *when)
                                .map(|(key, _)| key.clone())
                            {
                                cache.remove(&oldest);
                            }
                        }
                    }
                    snapshot
                }
            }
        };

        if snapshot.error.is_none() {
            snapshot.games = self.reconcile_games(snapshot.games, is_today);
            if let Some(game_id) = selected_game_id {
                if let Some(game) = snapshot
                    .games
                    .iter_mut()
                    .find(|game| game["gameId"].as_str() == Some(game_id))
                {
                    if game_due(game, is_today) {
                        if let Some(resolved) = self.resolve_scheduled(game) {
                            *game = resolved;
                        }
                    }
                }
            }
            snapshot.summaries = snapshot.games.iter().map(summarize_game).collect();
        }
        snapshot
    }

    pub fn state(&self, date: Option<&str>, selected_game_id: Option<&str>) -> Value {
        let snapshot = self.snapshot(date, selected_game_id);
        let live = snapshot
            .summaries
            .iter()
            .any(|game| game["statusKey"] == "live");
        let status = if snapshot.error.is_some() {
            "error"
        } else if snapshot.games.is_empty() {
            "no_games"
        } else {
            "ok"
        };
        let polling = self.scoreboard_polling(status, live, snapshot.is_today);
        let mut state = json!({
            "status": status,
            "updated": snapshot.updated,
            "games": snapshot.summaries,
            "hasLiveGames": live,
            "scoreboardDate": snapshot.date,
            "isToday": snapshot.is_today,
            "polling": polling,
        });
        if let Some(error) = snapshot.error {
            state["error"] = json!(error);
        }
        state
    }

    fn scoreboard_polling(&self, status: &str, live: bool, is_today: bool) -> Value {
        let health = self.inner.health.lock().unwrap_or_else(|e| e.into_inner());
        if status == "error" {
            let interval = (30_000 * (1 + health.failure_streak).min(4)).min(60_000);
            return json!({"refreshMs": u64::from(interval).max(self.rate_limit_remaining_ms()), "mode": "error", "reason": "scoreboard_error"});
        }
        if !is_today {
            return json!({"refreshMs": 30_000, "mode": "dated"});
        }
        if live {
            let interval = if health.failure_streak > 0 {
                (12_000 * (1 + health.failure_streak).min(4)).min(60_000)
            } else {
                12_000 - 1_000 * health.success_streak.min(4)
            };
            return json!({"refreshMs": interval, "mode": "live"});
        }
        json!({"refreshMs": 30_000, "mode": "idle"})
    }

    fn resolve_scheduled(&self, game: &Value) -> Option<Value> {
        let game_id = game["gameId"].as_str()?;
        let page = self.game_page(game_id).ok()?;
        let updated = &page["game"];
        if !matches!(int(&updated["gameStatus"]), Some(2 | 3)) {
            return None;
        }
        Some(merge_game(game, updated))
    }

    fn reconcile_games(&self, games: Vec<Value>, is_today: bool) -> Vec<Value> {
        let mut result = Vec::with_capacity(games.len());
        let mut jobs = Vec::new();
        {
            let mut schedule = self
                .inner
                .schedule
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            for game in games {
                let game_id = game["gameId"].as_str().unwrap_or("").to_owned();
                if game_id.is_empty() || !game_due(&game, is_today) {
                    result.push(game);
                    continue;
                }
                let previous = schedule
                    .checked
                    .get(&game_id)
                    .and_then(|(_, value)| value.as_ref())
                    .cloned();
                let due = schedule
                    .checked
                    .get(&game_id)
                    .map_or(true, |(when, _)| when.elapsed() >= Duration::from_secs(30));
                if due && !schedule.pending.contains(&game_id) && schedule.pending.len() < 3 {
                    schedule.pending.insert(game_id.clone());
                    jobs.push((game_id, game.clone()));
                }
                result.push(
                    previous.map_or_else(|| game.clone(), |resolved| merge_game(&game, &resolved)),
                );
            }
        }
        for (game_id, game) in jobs {
            let service = self.clone();
            std::thread::spawn(move || {
                let resolved = service.resolve_scheduled(&game);
                let mut schedule = service
                    .inner
                    .schedule
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                let previous = schedule
                    .checked
                    .get(&game_id)
                    .and_then(|(_, value)| value.clone());
                schedule
                    .checked
                    .insert(game_id.clone(), (Instant::now(), resolved.or(previous)));
                schedule.pending.remove(&game_id);
            });
        }
        result
    }
}

fn retry_after_seconds(value: Option<&str>) -> f64 {
    let Some(value) = value else { return 60.0 };
    if let Ok(seconds) = value.trim().parse::<f64>() {
        return if seconds.is_finite() {
            seconds.max(0.0)
        } else {
            60.0
        };
    }
    DateTime::parse_from_rfc2822(value)
        .map(|date| {
            (date.with_timezone(&Utc) - Utc::now())
                .num_milliseconds()
                .max(0) as f64
                / 1000.0
        })
        .unwrap_or(60.0)
}

fn local_today() -> String {
    let now = Local::now();
    let date = if now.hour() < 6 {
        now.date_naive().pred_opt().unwrap_or(now.date_naive())
    } else {
        now.date_naive()
    };
    date.format("%Y-%m-%d").to_string()
}

fn normalize_date(date: Option<&str>) -> String {
    let date = date.unwrap_or("").trim();
    let bytes = date.as_bytes();
    if bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
    {
        date.to_owned()
    } else {
        local_today()
    }
}

fn parse_next_data(html: &str) -> Result<Value, FetchError> {
    static SCRIPT: OnceLock<Regex> = OnceLock::new();
    let regex = SCRIPT.get_or_init(|| {
        Regex::new(r#"(?is)<script\b[^>]*\bid\s*=\s*["']__NEXT_DATA__["'][^>]*>(.*?)</script\s*>"#)
            .unwrap()
    });
    let content = regex
        .captures(html)
        .and_then(|captures| captures.get(1))
        .ok_or_else(|| FetchError::other("NBA page did not include game data."))?;
    serde_json::from_str(content.as_str())
        .map_err(|_| FetchError::other("The NBA data source returned an invalid response."))
}

fn parse_games_page(html: &str, date: &str) -> Result<Value, FetchError> {
    let page = parse_next_data(html)?;
    let props = &page["props"]["pageProps"];
    if props["hasError"].as_bool() == Some(true) || props["selectedDate"].as_str() != Some(date) {
        return Err(FetchError::other(
            "NBA games page did not return the requested date.",
        ));
    }
    let modules = props["gameCardFeed"]["modules"]
        .as_array()
        .ok_or_else(|| FetchError::other("NBA games page did not include a valid game list."))?;
    let mut games = Vec::new();
    for module in modules {
        let cards = module["cards"]
            .as_array()
            .ok_or_else(|| FetchError::other("NBA games page returned an invalid game list."))?;
        for card in cards {
            if card["cardType"].as_str() != Some("game") {
                continue;
            }
            let game = &card["cardData"];
            if !game.is_object() || game["gameId"].as_str().unwrap_or("").is_empty() {
                return Err(FetchError::other(
                    "NBA games page returned an invalid game.",
                ));
            }
            let mut normalized = game.clone();
            let tipoff = game["gameTimeUtc"]
                .as_str()
                .filter(|s| !s.is_empty())
                .or_else(|| game["gameTimeUTC"].as_str())
                .unwrap_or("");
            normalized["gameTimeUTC"] = json!(tipoff);
            for side in ["homeTeam", "awayTeam"] {
                let team = &game[side];
                if !team.is_object() || int(&team["teamId"]).is_none() {
                    return Err(FetchError::other(
                        "NBA games page returned an invalid team.",
                    ));
                }
                let city = team["teamCity"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .or_else(|| {
                        team_city(
                            int(&team["teamId"])?,
                            team["teamTricode"].as_str().unwrap_or(""),
                        )
                        .map(str::to_owned)
                    })
                    .unwrap_or_default();
                normalized[side]["teamCity"] = json!(city);
            }
            games.push(normalized);
        }
    }
    Ok(json!({"scoreboard": {"games": games}}))
}

fn team_city(id: i64, tricode: &str) -> Option<&'static str> {
    let (expected, city) = match id {
        1610612737 => ("ATL", "Atlanta"),
        1610612738 => ("BOS", "Boston"),
        1610612739 => ("CLE", "Cleveland"),
        1610612740 => ("NOP", "New Orleans"),
        1610612741 => ("CHI", "Chicago"),
        1610612742 => ("DAL", "Dallas"),
        1610612743 => ("DEN", "Denver"),
        1610612744 => ("GSW", "Golden State"),
        1610612745 => ("HOU", "Houston"),
        1610612746 => ("LAC", "Los Angeles"),
        1610612747 => ("LAL", "Los Angeles"),
        1610612748 => ("MIA", "Miami"),
        1610612749 => ("MIL", "Milwaukee"),
        1610612750 => ("MIN", "Minnesota"),
        1610612751 => ("BKN", "Brooklyn"),
        1610612752 => ("NYK", "New York"),
        1610612753 => ("ORL", "Orlando"),
        1610612754 => ("IND", "Indiana"),
        1610612755 => ("PHI", "Philadelphia"),
        1610612756 => ("PHX", "Phoenix"),
        1610612757 => ("POR", "Portland"),
        1610612758 => ("SAC", "Sacramento"),
        1610612759 => ("SAS", "San Antonio"),
        1610612760 => ("OKC", "Oklahoma City"),
        1610612761 => ("TOR", "Toronto"),
        1610612762 => ("UTA", "Utah"),
        1610612763 => ("MEM", "Memphis"),
        1610612764 => ("WAS", "Washington"),
        1610612765 => ("DET", "Detroit"),
        1610612766 => ("CHA", "Charlotte"),
        _ => return None,
    };
    (tricode == expected).then_some(city)
}

fn int(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| value.as_str()?.parse().ok())
}

fn value_or(value: &Value, key: &str, default: Value) -> Value {
    let value = &value[key];
    if value.is_null() || value.as_str() == Some("") {
        default
    } else {
        value.clone()
    }
}

fn team_summary(team: &Value) -> Value {
    json!({
        "id": team["teamId"], "city": value_or(team, "teamCity", json!("")),
        "name": value_or(team, "teamName", json!("")), "tricode": value_or(team, "teamTricode", json!("")),
        "score": value_or(team, "score", json!(0)), "wins": value_or(team, "wins", json!(0)),
        "losses": value_or(team, "losses", json!(0)), "timeoutsRemaining": team["timeoutsRemaining"], "inBonus": team["inBonus"]
    })
}

fn status_key(status: Option<i64>) -> &'static str {
    match status {
        Some(2) => "live",
        Some(3) => "final",
        _ => "scheduled",
    }
}

fn status_label(status: Option<i64>, text: &str) -> String {
    match status {
        Some(1) if !text.is_empty() && !looks_like_tipoff(text) => text.to_owned(),
        Some(1) => "Scheduled".into(),
        Some(2) => "Live".into(),
        Some(3) => "Final".into(),
        _ if !text.is_empty() => text.to_owned(),
        _ => "Unknown".into(),
    }
}

fn looks_like_tipoff(text: &str) -> bool {
    let lower = text.trim().to_ascii_lowercase();
    let digit = lower.chars().any(|character| character.is_ascii_digit());
    (digit && lower.contains(':'))
        || lower.contains(" am")
        || lower.contains(" pm")
        || (digit
            && [" et", " ct", " mt", " pt"]
                .iter()
                .any(|zone| lower.contains(zone)))
}

fn summarize_game(game: &Value) -> Value {
    let home = &game["homeTeam"];
    let away = &game["awayTeam"];
    let status = int(&game["gameStatus"]);
    let text = game["gameStatusText"].as_str().unwrap_or("");
    json!({
        "gameId": game["gameId"],
        "matchup": format!("{} @ {}", away["teamTricode"].as_str().unwrap_or(""), home["teamTricode"].as_str().unwrap_or("")).trim(),
        "statusText": text, "status": status_label(status, text), "statusKey": status_key(status),
        "clock": value_or(game, "gameClock", json!("")), "period": game["period"],
        "startTimeUTC": value_or(game, "gameTimeUTC", json!("")),
        "home": team_summary(home), "away": team_summary(away),
    })
}

fn game_due(game: &Value, is_today: bool) -> bool {
    if !is_today || int(&game["gameStatus"]) != Some(1) {
        return false;
    }
    let Some(tipoff) = game["gameTimeUTC"].as_str() else {
        return false;
    };
    DateTime::parse_from_rfc3339(tipoff)
        .map(|time| time.with_timezone(&Utc) <= Utc::now())
        .unwrap_or(false)
}

fn merge_game(game: &Value, updated: &Value) -> Value {
    let mut result = game.clone();
    for key in [
        "gameStatus",
        "gameStatusText",
        "period",
        "gameClock",
        "gameTimeUTC",
    ] {
        if !updated[key].is_null() {
            result[key] = updated[key].clone();
        }
    }
    for side in ["homeTeam", "awayTeam"] {
        if let Some(fields) = updated[side].as_object() {
            if !result[side].is_object() {
                result[side] = json!({});
            }
            for (key, value) in fields {
                result[side][key] = value.clone();
            }
            if !updated[side]["teamWins"].is_null() {
                result[side]["wins"] = updated[side]["teamWins"].clone();
            }
            if !updated[side]["teamLosses"].is_null() {
                result[side]["losses"] = updated[side]["teamLosses"].clone();
            }
        }
    }
    result
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::thread::{self, JoinHandle};
    use std::time::Duration;

    pub(crate) struct FixtureServer {
        pub base: String,
        paths: Arc<Mutex<Vec<String>>>,
        stop: Arc<AtomicBool>,
        worker: Option<JoinHandle<()>>,
    }

    impl FixtureServer {
        pub(crate) fn new(handler: impl Fn(&str) -> (u16, String) + Send + 'static) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let paths = Arc::new(Mutex::new(Vec::new()));
            let stop = Arc::new(AtomicBool::new(false));
            let captured = Arc::clone(&paths);
            let stopped = Arc::clone(&stop);
            let worker = thread::spawn(move || {
                while !stopped.load(Ordering::Relaxed) {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                            let mut request = [0_u8; 4096];
                            let Ok(read) = stream.read(&mut request) else {
                                continue;
                            };
                            let request = String::from_utf8_lossy(&request[..read]);
                            let path = request
                                .lines()
                                .next()
                                .and_then(|line| line.split_whitespace().nth(1))
                                .unwrap_or("");
                            captured.lock().unwrap().push(path.to_owned());
                            let (status, body) = handler(path);
                            let retry = if status == 429 {
                                "Retry-After: 120\r\n"
                            } else {
                                ""
                            };
                            let response = format!("HTTP/1.1 {status} test\r\n{retry}Content-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                            let _ = stream.write_all(response.as_bytes());
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(5))
                        }
                        Err(_) => break,
                    }
                }
            });
            Self {
                base,
                paths,
                stop,
                worker: Some(worker),
            }
        }

        pub(crate) fn paths(&self) -> Vec<String> {
            self.paths.lock().unwrap().clone()
        }
    }

    impl Drop for FixtureServer {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
            if let Some(worker) = self.worker.take() {
                worker.join().unwrap();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::FixtureServer;
    use super::*;

    #[test]
    fn blocked_live_scoreboard_uses_games_page_fallback() {
        let date = "2026-11-10";
        let game = json!({"gameId":"0022600211", "gameTimeUtc":"2026-11-11T00:30:00Z",
            "homeTeam":{"teamId":1610612752,"teamTricode":"NYK"},
            "awayTeam":{"teamId":1610612749,"teamTricode":"MIL"}});
        let page = json!({"props":{"pageProps":{"selectedDate":date,"hasError":false,
            "gameCardFeed":{"modules":[{"cards":[{"cardType":"game","cardData":game}]}]}}}});
        let html = format!("<script id=\"__NEXT_DATA__\">{page}</script>");
        let server = FixtureServer::new(move |path| {
            if path.starts_with("/live/scoreboard/") {
                (403, String::new())
            } else if path.starts_with("/games?") {
                (200, html.clone())
            } else {
                (500, String::new())
            }
        });
        let service = ScoreboardService::with_test_server(&server.base);
        let snapshot = service.load_snapshot(date.to_owned(), true);
        assert!(snapshot.error.is_none(), "{:?}", snapshot.error);
        assert_eq!(snapshot.games[0]["gameId"], "0022600211");
        let paths = server.paths();
        assert_eq!(paths.len(), 2);
        assert!(paths[0].starts_with("/live/scoreboard/"));
        assert!(paths[1].starts_with("/games?date="));
    }

    #[test]
    fn live_scoreboard_rate_limit_does_not_attempt_a_different_origin() {
        let live = FixtureServer::new(|_| (429, String::new()));
        let fallback = FixtureServer::new(|_| (500, String::new()));
        let service = ScoreboardService::with_test_servers(&live.base, &fallback.base);
        let snapshot = service.load_snapshot("2026-11-10".to_owned(), true);
        assert!(snapshot.error.unwrap().contains("rate-limiting"));
        assert!(service.rate_limit_remaining_ms() > 110_000);
        assert_eq!(live.paths().len(), 1);
        assert!(fallback.paths().is_empty());
    }

    #[test]
    fn games_page_preserves_tipoff_and_fills_matching_team_cities() {
        let game = json!({"gameId":"0012600046", "gameTimeUtc":"2026-10-30T23:00:00Z", "gameStatus":1,
            "homeTeam":{"teamId":1610612764,"teamTricode":"WAS"},
            "awayTeam":{"teamId":1610612766,"teamTricode":"CHA"}});
        let page = json!({"props":{"pageProps":{"selectedDate":"2026-10-30","hasError":false,
            "gameCardFeed":{"modules":[{"cards":[{"cardType":"game","cardData":game}]}]}}}});
        let html = format!("<script id=\"__NEXT_DATA__\">{page}</script>");
        let board = parse_games_page(&html, "2026-10-30").unwrap();
        let game = &board["scoreboard"]["games"][0];
        assert_eq!(game["homeTeam"]["teamCity"], "Washington");
        assert_eq!(game["awayTeam"]["teamCity"], "Charlotte");
        assert_eq!(game["gameTimeUTC"], "2026-10-30T23:00:00Z");
        assert!(parse_games_page(&html, "2026-10-31").is_err());
    }

    #[test]
    fn rate_limit_parses_seconds_dates_and_bad_values() {
        assert_eq!(retry_after_seconds(Some("120")), 120.0);
        assert_eq!(retry_after_seconds(Some("inf")), 60.0);
        assert_eq!(retry_after_seconds(Some("oops")), 60.0);
        let date = (Utc::now() + chrono::Duration::seconds(120)).to_rfc2822();
        assert!(retry_after_seconds(Some(&date)) > 115.0);
    }

    #[test]
    fn rate_limit_cooldown_prevents_a_second_request() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut buffer = [0_u8; 2048];
            let _ = stream.read(&mut buffer).unwrap();
            stream.write_all(b"HTTP/1.1 429 Too Many Requests\r\nRetry-After: 120\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        });
        let service = ScoreboardService::new();
        let url = format!("http://{address}/scoreboard");
        let first = service.request(&url, &[]).unwrap_err();
        let second = service.request(&url, &[]).unwrap_err();
        assert!(first.rate_limited && second.rate_limited);
        assert!(service.rate_limit_remaining_ms() > 110_000);
        server.join().unwrap();
    }

    #[test]
    fn retries_a_truncated_response_body_before_returning_data() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut attempts = 0;
            while attempts < 2 && Instant::now() < deadline {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let mut buffer = [0_u8; 2048];
                        stream
                            .set_read_timeout(Some(Duration::from_secs(2)))
                            .unwrap();
                        stream.read(&mut buffer).unwrap();
                        attempts += 1;
                        if attempts == 1 {
                            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 12\r\nConnection: close\r\n\r\nshort").unwrap();
                        } else {
                            stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok").unwrap();
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Err(error) => panic!("loopback server failed: {error}"),
                }
            }
            attempts
        });
        let service = ScoreboardService::new();
        let result = service.request(&format!("http://{address}/scoreboard"), &[]);
        let attempts = server.join().unwrap();
        assert_eq!(result.unwrap(), "ok");
        assert_eq!(attempts, 2);
    }

    #[test]
    fn summaries_keep_status_team_scores_and_requested_date() {
        let game = json!({"gameId":"001", "gameStatus":2, "gameStatusText":"1st Qtr", "period":1,
            "gameClock":"PT04M30.00S", "gameTimeUTC":"2026-10-13T23:00:00Z",
            "homeTeam":{"teamId":1,"teamTricode":"TOR","score":7},
            "awayTeam":{"teamId":2,"teamTricode":"NYK","score":3}});
        let summary = summarize_game(&game);
        assert_eq!(summary["gameId"], "001");
        assert_eq!(summary["statusKey"], "live");
        assert_eq!(summary["matchup"], "NYK @ TOR");
        assert_eq!(summary["home"]["score"], 7);
        assert_eq!(summary["clock"], "PT04M30.00S");
        assert_eq!(normalize_date(Some("2026-10-30")), "2026-10-30");
    }

    #[test]
    fn scheduled_game_merge_keeps_original_team_data() {
        let game = json!({"gameId":"001", "gameStatus":1, "homeTeam":{"teamTricode":"TOR","wins":1}, "awayTeam":{"teamTricode":"NYK"}});
        let update =
            json!({"gameStatus":2, "homeTeam":{"score":7,"teamWins":2}, "awayTeam":{"score":3}});
        let result = merge_game(&game, &update);
        assert_eq!(result["gameStatus"], 2);
        assert_eq!(result["homeTeam"]["teamTricode"], "TOR");
        assert_eq!(result["homeTeam"]["score"], 7);
        assert_eq!(result["homeTeam"]["wins"], 2);
    }
}
