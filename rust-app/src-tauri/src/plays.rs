use regex::Regex;
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashSet};
use std::sync::OnceLock;

fn field<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn integer(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().and_then(|n| i64::try_from(n).ok()))
        .or_else(|| value.as_str().and_then(|s| s.trim().parse().ok()))
}

fn number(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(integer)
}

fn normalized_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn first_field<'a>(value: &'a Value, keys: &[&str]) -> &'a str {
    keys.iter()
        .map(|key| field(value, key).trim())
        .find(|value| !value.is_empty())
        .unwrap_or("")
}

fn ordinal(number: i64) -> String {
    let suffix = if (11..=13).contains(&(number % 100)) {
        "th"
    } else {
        match number % 10 {
            1 => "st",
            2 => "nd",
            3 => "rd",
            _ => "th",
        }
    };
    format!("{number}{suffix}")
}

fn team_for_action<'a>(action: &Value, home: &'a Value, away: &'a Value) -> Option<&'a Value> {
    let action_id = number(action, "teamId");
    let code = field(action, "teamTricode").trim();
    [home, away].into_iter().find(|team| {
        let team_id = number(team, "id").or_else(|| number(team, "teamId"));
        let team_code = first_field(team, &["tricode", "teamTricode"]);
        (action_id.is_some() && action_id == team_id)
            || (!code.is_empty() && code.eq_ignore_ascii_case(team_code))
    })
}

fn team_name(team: Option<&Value>) -> &str {
    team.map(|value| first_field(value, &["name", "teamName", "city", "teamCity"]))
        .unwrap_or("")
}

fn apply_rules(mut text: String, rules: &[(Regex, &'static str)]) -> String {
    for (pattern, replacement) in rules {
        text = pattern.replace_all(&text, *replacement).into_owned();
    }
    text
}

fn rules(specifications: &[(&'static str, &'static str)]) -> Vec<(Regex, &'static str)> {
    specifications
        .iter()
        .map(|(pattern, replacement)| {
            (
                Regex::new(pattern).expect("valid play format pattern"),
                *replacement,
            )
        })
        .collect()
}

fn normalize_stats(text: &str) -> String {
    static RULES: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    apply_rules(
        text.to_string(),
        RULES.get_or_init(|| {
            rules(&[
                (r"(?i)\b1 PTS\b", "1 point"),
                (r"(?i)\b(\d+) PTS\b", "$1 points"),
                (r"(?i)\b1 AST\b", "1 assist"),
                (r"(?i)\b(\d+) AST\b", "$1 assists"),
                (r"(?i)\b1 STL\b", "1 steal"),
                (r"(?i)\b(\d+) STL\b", "$1 steals"),
                (r"(?i)\b1 PF\b", "1 foul"),
                (r"(?i)\b(\d+) PF\b", "$1 fouls"),
                (r"(?i)\b1 BLK\b", "1 block"),
                (r"(?i)\b(\d+) BLK\b", "$1 blocks"),
                (r"(?i)\b1 TO\b", "1 turnover"),
                (r"(?i)\b(\d+) TO\b", "$1 turnovers"),
            ])
        }),
    )
}

fn normalize_shot(text: &str) -> String {
    static RULES: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    let value = apply_rules(
        normalized_text(text),
        RULES.get_or_init(|| {
            rules(&[
                (r"(\d+)'", "${1}-foot"),
                (
                    r"(?i)\b(\d+-foot)\s+3PT\s+pullup\b",
                    "$1 pull-up three-pointer",
                ),
                (
                    r"(?i)\b(\d+-foot)\s+3PT\s+step back\b",
                    "$1 step-back three-pointer",
                ),
                (
                    r"(?i)\b(\d+-foot)\s+3PT\b(?:\s+(?:driving|floating|bank|running|cutting))+",
                    "$1 three-pointer",
                ),
                (r"(?i)\b3PT pullup\b", "pull-up three-pointer"),
                (r"(?i)\b3PT step back\b", "step-back three-pointer"),
                (r"(?i)\b3PT\b", "three-pointer"),
                (r"(?i)\bstep back\b", "step-back"),
                (r"(?i)\bpullup\b", "pull-up"),
                (r"(?i)\bfinger roll\b", "finger-roll"),
                (r"(?i)\bJump Shot\b", "jumper"),
                (r"(?i)\bLayup(?:\s+Shot)?\b", "layup"),
                (r"\bDriving\b", "driving"),
                (r"\bFloating\b", "floating"),
                (r"\bRunning\b", "running"),
                (r"\bCutting\b", "cutting"),
                (r"\bTip\b", "tip"),
                (r"(?i)\bDunk\b", "dunk"),
                (r"(?i)\bfadeaway Shot\b", "fadeaway jumper"),
                (r"(?i)\bpull-up Shot\b", "pull-up jumper"),
                (r"(?i)\bstep-back Shot\b", "step-back jumper"),
                (r"(?i)\bShot\b", "jumper"),
                (r"(?i)\bthree-pointer jumper\b", "three-pointer"),
            ])
        }),
    );
    normalize_stats(&value)
}

fn replace_player_prefix(text: &str, player: &str, verb: &str) -> String {
    if player.is_empty() {
        return verb.trim().to_string();
    }
    if let Some(suffix) = text.strip_prefix(player) {
        if suffix.is_empty() || suffix.starts_with(char::is_whitespace) {
            return format!("{player} {verb}{suffix}").trim().to_string();
        }
    }
    format!("{player} {verb} {text}").trim().to_string()
}

fn format_play(action: &Value, home: &Value, away: &Value) -> String {
    static REBOUND: OnceLock<Regex> = OnceLock::new();
    static FOUL_SHOTS: OnceLock<Regex> = OnceLock::new();
    static FOUL_RULES: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    static FALLBACK_RULES: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();

    let mut description = normalized_text(field(action, "description"));
    if description.is_empty() {
        return description;
    }
    let kind = field(action, "actionType").trim().to_lowercase();
    let subtype = field(action, "subType").trim().to_lowercase();
    let team_code = field(action, "teamTricode").trim().to_uppercase();
    let team = team_name(team_for_action(action, home, away));
    let upper = description.to_uppercase();
    let player = first_field(action, &["playerNameI", "playerName"]);
    match upper.as_str() {
        "PERIOD START" | "PERIOD END" => {
            let start = if upper == "PERIOD START" {
                "Start"
            } else {
                "End"
            };
            return match number(action, "period") {
                Some(p) if p > 0 && p <= 4 => format!("{start} of {} quarter", ordinal(p)),
                Some(p) if p > 4 => format!("{start} of {} overtime", ordinal(p - 4)),
                _ => format!("{start} of period"),
            };
        }
        "GAME END" => return "Final".to_string(),
        _ => {}
    }
    if kind == "jumpball" {
        if upper.starts_with("JUMP BALL") {
            description.replace_range(..9, "Jump ball");
        }
        return description.replace(": Tip to", ", tip to");
    }
    if !team.is_empty() && (kind == "timeout" || kind == "heave") {
        return format!("{team} {kind}");
    }
    if upper.starts_with("TEAM ") && !team.is_empty() {
        if kind == "rebound" && (subtype == "offensive" || subtype == "defensive") {
            return format!("{team} {subtype} rebound");
        }
        description = format!("{team} {}", description[5..].trim());
    }
    if upper.contains(" TEAM TURNOVER") && !team.is_empty() {
        if upper.contains("SHOT CLOCK") {
            return format!("{team} shot-clock violation");
        }
        if upper.contains("5-SECOND-VIOLATION") {
            return format!("{team} 5-second violation");
        }
        description = description.replace("Team TURNOVER", "turnover");
    }
    if kind == "freethrow" || kind == "2pt" || kind == "3pt" {
        let missed = upper.starts_with("MISS ");
        let raw = if missed {
            description.get(5..).unwrap_or("").trim()
        } else {
            &description
        };
        let text = if kind == "freethrow" {
            static FREE_THROW: OnceLock<Regex> = OnceLock::new();
            normalize_stats(
                &FREE_THROW
                    .get_or_init(|| Regex::new(r"(?i)\bFree Throw\b").unwrap())
                    .replace_all(raw, "free throw"),
            )
        } else {
            normalize_shot(raw)
        };
        return replace_player_prefix(&text, player, if missed { "misses" } else { "makes" });
    }
    if kind == "rebound" {
        let subject = if !player.is_empty() {
            player
        } else if !team.is_empty() {
            team
        } else {
            &team_code
        };
        if !subject.is_empty() {
            let rebound_kind = if subtype == "offensive" || subtype == "defensive" {
                format!("{subtype} ")
            } else {
                String::new()
            };
            let mut result = format!("{subject} {rebound_kind}rebound");
            if let Some(caps) = REBOUND
                .get_or_init(|| Regex::new(r"\(Off:(\d+)\s+Def:(\d+)\)").unwrap())
                .captures(&description)
            {
                let off = caps[1].parse::<u32>().unwrap_or(0);
                let def = caps[2].parse::<u32>().unwrap_or(0);
                let total = off + def;
                let plural = if total == 1 { "" } else { "s" };
                if rebound_kind.is_empty() {
                    result.push_str(&format!(
                        " ({total} rebound{plural}; {off} offensive, {def} defensive)"
                    ));
                } else {
                    result.push_str(&format!(" ({total} rebound{plural})"));
                }
            }
            return result;
        }
    }
    if kind == "foul" {
        description = apply_rules(
            description,
            FOUL_RULES.get_or_init(|| {
                rules(&[
                    (r"(?i)\bloose ball personal FOUL\b", "loose-ball foul"),
                    (r"(?i)\btake personal FOUL\b", "take foul"),
                    (r"(?i)\bshooting personal FOUL\b", "shooting foul"),
                    (r"(?i)\bpersonal FOUL\b", "personal foul"),
                    (r"(?i)\boffensive FOUL\b", "offensive foul"),
                ])
            }),
        );
        description = FOUL_SHOTS
            .get_or_init(|| Regex::new(r"(?i)\(([^()]+?)\s+(\d+)\s+FT\)").unwrap())
            .replace_all(&description, |caps: &regex::Captures<'_>| {
                let count = &caps[2];
                let plural = if count == "1" { "" } else { "s" };
                format!("({} to shoot {count} free throw{plural})", caps[1].trim())
            })
            .into_owned();
        return normalize_stats(&description);
    }
    if kind == "turnover" && !player.is_empty() {
        static TURNOVER: OnceLock<Regex> = OnceLock::new();
        static STATS: OnceLock<Regex> = OnceLock::new();
        let details = description
            .strip_prefix(player)
            .unwrap_or(&description)
            .trim();
        let details = TURNOVER
            .get_or_init(|| Regex::new(r"(?i)\bTURNOVER\b").unwrap())
            .replace(details, "");
        let mut details = details
            .trim()
            .replace("out-of-bounds", "out of bounds")
            .replace("5-second-violation", "5-second violation");
        let stats = STATS
            .get_or_init(|| Regex::new(r"\([^)]*\)\s*$").unwrap())
            .find(&details)
            .map(|m| (m.start(), normalize_stats(m.as_str())));
        let suffix = if let Some((start, stats)) = stats {
            details.truncate(start);
            format!(" {stats}")
        } else {
            String::new()
        };
        let details = details.trim_matches(|c: char| c.is_whitespace() || ":;,-".contains(c));
        return if details.is_empty() {
            format!("{player} turnover{suffix}")
        } else {
            format!("{player} turnover: {details}{suffix}")
        };
    }
    if kind == "turnover"
        && !team.is_empty()
        && !team_code.is_empty()
        && description.starts_with(&team_code)
    {
        description.replace_range(..team_code.len(), team);
    }
    description = apply_rules(
        description,
        FALLBACK_RULES.get_or_init(|| {
            rules(&[
                (r"(?i)\bJump Ball\b", "Jump ball"),
                (r"(?i)\bFOUL\b", "foul"),
                (r"(?i)\bTURNOVER\b", "turnover"),
                (r"(?i)\bSTEAL\b", "steal"),
                (r"(?i)\bBLOCK\b", "block"),
                (r"(?i)\bVIOLATION\b", "violation"),
                (r"(?i)\bTimeout\b", "timeout"),
                (r"(?i)\bout-of-bounds\b", "out of bounds"),
                (r"(?i)\b5-second-violation\b", "5-second violation"),
            ])
        }),
    );
    normalize_stats(&description)
}

fn normalize_play(action: &Value, home: &Value, away: &Value) -> Option<Value> {
    let description = format_play(action, home, away);
    if description.is_empty() {
        return None;
    }
    let action_number = number(action, "actionNumber");
    let team_code = field(action, "teamTricode").trim().to_uppercase();
    let possession_id = number(action, "possession");
    let possession_code = [home, away]
        .into_iter()
        .find(|team| possession_id.is_some() && possession_id == number(team, "id"))
        .map(|team| field(team, "tricode"))
        .unwrap_or("");
    Some(json!({
        "actionNumber": action_number,
        "sourceActionNumbers": action_number.into_iter().collect::<Vec<_>>(),
        "orderNumber": number(action, "orderNumber"),
        "description": description,
        "actionType": field(action, "actionType"),
        "subType": field(action, "subType"),
        "teamTricode": team_code,
        "possessionTricode": possession_code,
        "personId": number(action, "personId"),
        "playerName": first_field(action, &["playerNameI", "playerName"]),
        "clock": field(action, "clock"),
        "period": number(action, "period"),
        "scoreHome": number(action, "scoreHome"),
        "scoreAway": number(action, "scoreAway"),
    }))
}

fn meaningful(action: &Value) -> bool {
    let kind = field(action, "actionType").trim().to_lowercase();
    let descriptor = field(action, "descriptor").trim().to_lowercase();
    kind != "substitution"
        && kind != "instantreplay"
        && descriptor != "startperiod"
        && descriptor != "endperiod"
}

fn source_numbers(play: &Value) -> Vec<i64> {
    let mut values = play
        .get("sourceActionNumbers")
        .and_then(Value::as_array)
        .map(|array| array.iter().filter_map(integer).collect::<Vec<_>>())
        .unwrap_or_default();
    if values.is_empty() {
        values.extend(number(play, "actionNumber"));
    }
    values
}

fn same_window(newer: &Value, older: &Value) -> bool {
    if number(newer, "period").unwrap_or(0) != number(older, "period").unwrap_or(0)
        || field(newer, "clock") != field(older, "clock")
        || number(newer, "scoreHome") != number(older, "scoreHome")
        || number(newer, "scoreAway") != number(older, "scoreAway")
    {
        return false;
    }
    if let (Some(a), Some(b)) = (number(newer, "orderNumber"), number(older, "orderNumber")) {
        return (1..=40_000).contains(&(a - b));
    }
    if let (Some(a), Some(b)) = (number(newer, "actionNumber"), number(older, "actionNumber")) {
        return (1..=3).contains(&(a - b));
    }
    false
}

fn same_person(first: &Value, second: &Value) -> bool {
    match (number(first, "personId"), number(second, "personId")) {
        (Some(a), Some(b)) => a == b,
        _ => {
            let name = field(first, "playerName").trim();
            !name.is_empty() && name.eq_ignore_ascii_case(field(second, "playerName").trim())
        }
    }
}

fn split_stats(description: &str) -> (String, String) {
    static SUFFIX: OnceLock<Regex> = OnceLock::new();
    let value = normalized_text(description);
    if let Some(found) = SUFFIX.get_or_init(|| Regex::new(r"(?i)\((\d+)\s+(?:points?|assists?|steals?|fouls?|blocks?|turnovers?|rebounds?)\)\s*$").unwrap()).find(&value) {
        return (value[..found.start()].trim_end().to_string(), found.as_str().trim().to_string());
    }
    (value, String::new())
}

fn with_suffix(base: &str, suffix: &str) -> String {
    if suffix.is_empty() {
        base.trim().to_string()
    } else {
        format!("{} {}", base.trim(), suffix.trim())
    }
}

fn join_stats(first: &str, second: &str) -> String {
    let mut parts = Vec::new();
    for part in [first, second] {
        let value = part
            .trim()
            .trim_start_matches('(')
            .trim_end_matches(')')
            .trim();
        if !value.is_empty() && !parts.iter().any(|p: &&str| p.eq_ignore_ascii_case(value)) {
            parts.push(value);
        }
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!("({})", parts.join(", "))
    }
}

fn combined_play(
    newer: &Value,
    older: &Value,
    description: String,
    kind: &str,
    subtype: &str,
    team: &str,
    possession: &str,
) -> Value {
    let mut numbers = source_numbers(newer);
    numbers.extend(source_numbers(older));
    numbers.sort_unstable_by(|a, b| b.cmp(a));
    numbers.dedup();
    let order = [number(newer, "orderNumber"), number(older, "orderNumber")]
        .into_iter()
        .flatten()
        .max();
    json!({
        "actionNumber": numbers.first().copied().or_else(|| number(newer, "actionNumber")),
        "sourceActionNumbers": numbers,
        "orderNumber": order,
        "description": description,
        "actionType": kind,
        "subType": subtype,
        "teamTricode": team,
        "possessionTricode": possession,
        "personId": number(older, "personId").or_else(|| number(newer, "personId")),
        "playerName": first_field(older, &["playerName"]).to_string() + if field(older, "playerName").is_empty() { field(newer, "playerName") } else { "" },
        "clock": if field(newer, "clock").is_empty() { field(older, "clock") } else { field(newer, "clock") },
        "period": number(newer, "period").or_else(|| number(older, "period")),
        "scoreHome": number(newer, "scoreHome"),
        "scoreAway": number(newer, "scoreAway"),
    })
}

fn combine_pair(newer: &Value, older: &Value) -> Option<Value> {
    if !same_window(newer, older) {
        return None;
    }
    let new_kind = field(newer, "actionType").trim().to_lowercase();
    let old_kind = field(older, "actionType").trim().to_lowercase();
    let new_subtype = field(newer, "subType").trim().to_lowercase();
    let old_subtype = field(older, "subType").trim().to_lowercase();
    let new_team = field(newer, "teamTricode").trim().to_uppercase();
    let old_team = field(older, "teamTricode").trim().to_uppercase();
    let possession = if field(newer, "possessionTricode").is_empty() {
        field(older, "possessionTricode")
    } else {
        field(newer, "possessionTricode")
    };
    if new_kind == "turnover"
        && new_subtype == "offensive foul"
        && old_kind == "foul"
        && old_subtype == "offensive"
        && same_person(newer, older)
        && (new_team.is_empty() || old_team.is_empty() || new_team == old_team)
    {
        let (base, foul_stats) = split_stats(field(older, "description"));
        let (_, turnover_stats) = split_stats(field(newer, "description"));
        if !base.is_empty() {
            let base = if base.to_lowercase().contains("turnover") {
                base
            } else {
                format!("{base} turnover")
            };
            let team = if old_team.is_empty() {
                &new_team
            } else {
                &old_team
            };
            return Some(combined_play(
                newer,
                older,
                with_suffix(&base, &join_stats(&foul_stats, &turnover_stats)),
                "turnover",
                "offensive foul",
                team,
                possession,
            ));
        }
    }
    if new_kind == "steal"
        && old_kind == "turnover"
        && !new_team.is_empty()
        && !old_team.is_empty()
        && new_team != old_team
    {
        let (old_base, old_stats) = split_stats(field(older, "description"));
        let (new_base, new_stats) = split_stats(field(newer, "description"));
        if !old_base.is_empty() && !new_base.is_empty() {
            let description = format!(
                "{}; {}",
                with_suffix(&old_base, &old_stats),
                with_suffix(&new_base, &new_stats)
            );
            return Some(combined_play(
                newer,
                older,
                description,
                "turnover",
                field(older, "subType"),
                &old_team,
                &new_team,
            ));
        }
    }
    if new_kind == "block"
        && (old_kind == "2pt" || old_kind == "3pt")
        && !new_team.is_empty()
        && !old_team.is_empty()
        && new_team != old_team
    {
        static BLOCKED: OnceLock<Regex> = OnceLock::new();
        let (shot, _) = split_stats(field(older, "description"));
        let (block, stats) = split_stats(field(newer, "description"));
        let shot = BLOCKED
            .get_or_init(|| Regex::new(r"(?i)\s*-\s*blocked\b").unwrap())
            .replace(&shot, "");
        if !shot.trim().is_empty() && !block.is_empty() {
            let description = format!("{}; {}", shot.trim(), with_suffix(&block, &stats));
            return Some(combined_play(
                newer,
                older,
                description,
                "block",
                field(newer, "subType"),
                &new_team,
                field(newer, "possessionTricode"),
            ));
        }
    }
    None
}

fn combine_adjacent(plays: Vec<Value>) -> Vec<Value> {
    let mut combined = Vec::new();
    let mut index = 0;
    while index < plays.len() {
        if let Some(merged) = plays
            .get(index + 1)
            .and_then(|older| combine_pair(&plays[index], older))
        {
            combined.push(merged);
            index += 2;
        } else {
            combined.push(plays[index].clone());
            index += 1;
        }
    }
    combined
}

fn merge_plays(current: Vec<Value>, cached: &[Value]) -> Vec<Value> {
    let mut numbers = HashSet::new();
    let mut descriptions = HashSet::new();
    let mut merged = Vec::new();
    for play in current.into_iter().chain(cached.iter().cloned()) {
        let source = source_numbers(&play);
        if source.is_empty() {
            let key = (
                field(&play, "description").to_owned(),
                field(&play, "clock").to_owned(),
                number(&play, "period"),
                field(&play, "teamTricode").to_owned(),
            );
            if !descriptions.insert(key) {
                continue;
            }
        } else {
            if source.iter().any(|value| numbers.contains(value)) {
                continue;
            }
            numbers.extend(source);
        }
        merged.push(play);
    }
    merged
}

fn starter_ids(team: &Value) -> BTreeSet<i64> {
    team.get("players")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|player| !field(player, "position").is_empty())
        .filter_map(|player| number(player, "personId"))
        .collect()
}

fn result(data: Value, state: &str, message: Option<&str>) -> Value {
    json!({"data": data, "state": state, "message": message})
}

/// Convert an NBA play-by-play payload into UI data and derive lineups.
///
/// `cached` is the previous return value. The caller owns fetching, backoff, and
/// deciding whether to return stale data on a failed request.
pub fn build_playbyplay(
    payload: &Value,
    home: &Value,
    away: &Value,
    include_on_court: bool,
    cached: Option<&Value>,
) -> Value {
    let game = payload.get("game").unwrap_or(&Value::Null);
    let page_feed = field(game, "source") == "hanaV3";
    let mut actions = game
        .get("actions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if page_feed {
        let mut score_home = None;
        let mut score_away = None;
        for action in &mut actions {
            let kind = field(action, "actionType").trim().to_lowercase();
            let mapped_kind = match kind.as_str() {
                "made shot" | "missed shot" => Some(
                    if field(action, "description").to_uppercase().contains("3PT") {
                        "3pt"
                    } else {
                        "2pt"
                    },
                ),
                "free throw" => Some("freethrow"),
                "jump ball" => Some("jumpball"),
                "instant replay" => Some("instantreplay"),
                _ => None,
            };
            let player = field(action, "playerName").to_string();
            score_home = number(action, "scoreHome").or(score_home);
            score_away = number(action, "scoreAway").or(score_away);
            if let Some(map) = action.as_object_mut() {
                if let Some(kind) = mapped_kind {
                    map.insert("actionType".into(), json!(kind));
                }
                if !player.is_empty() {
                    map.insert("playerNameI".into(), json!(player));
                }
                map.insert("scoreHome".into(), json!(score_home));
                map.insert("scoreAway".into(), json!(score_away));
            }
        }
    } else if !actions.is_empty()
        && actions
            .iter()
            .all(|action| number(action, "orderNumber").is_some())
    {
        actions.sort_by_key(|action| number(action, "orderNumber"));
    }

    let halftime_started_at = actions
        .iter()
        .filter(|action| {
            number(action, "period") == Some(2)
                && ((field(action, "actionType").eq_ignore_ascii_case("period")
                    && field(action, "subType").eq_ignore_ascii_case("end"))
                    || field(action, "descriptor").eq_ignore_ascii_case("endperiod"))
        })
        .filter_map(|action| {
            let value = field(action, "timeActual").trim();
            chrono::DateTime::parse_from_rfc3339(value)
                .ok()
                .map(|time| (time, value))
        })
        .max_by(|(first, _), (second, _)| first.cmp(second))
        .map(|(_, value)| value.to_owned())
        .or_else(|| {
            cached
                .and_then(|old| old["halftimeStartedAt"].as_str())
                .map(str::to_owned)
        });

    let mut fallback = Vec::new();
    let mut extracted = Vec::new();
    for action in actions.iter().rev() {
        if let Some(play) = normalize_play(action, home, away) {
            fallback.push(play.clone());
            if meaningful(action) {
                extracted.push(play);
            }
        }
    }
    if extracted.is_empty() {
        extracted = fallback;
    }
    let extracted = combine_adjacent(extracted);
    let cached_plays = cached
        .filter(|old| {
            !old.get("pageFeed")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .and_then(|old| old.get("recentPlays"))
        .and_then(|state| state.get("data"))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let recent = if page_feed {
        extracted
    } else {
        merge_plays(extracted, cached_plays)
    };

    let can_track = include_on_court
        && home
            .get("players")
            .and_then(Value::as_array)
            .map_or(false, |players| !players.is_empty())
        && away
            .get("players")
            .and_then(Value::as_array)
            .map_or(false, |players| !players.is_empty());
    let mut home_on = if can_track {
        starter_ids(home)
    } else {
        BTreeSet::new()
    };
    let mut away_on = if can_track {
        starter_ids(away)
    } else {
        BTreeSet::new()
    };
    if can_track {
        for action in &actions {
            if field(action, "actionType") != "substitution" {
                continue;
            }
            let Some(person_id) = number(action, "personId") else {
                continue;
            };
            let action_id = number(action, "teamId");
            let action_code = field(action, "teamTricode");
            let is_team = |team: &Value| {
                (action_id.is_some() && action_id == number(team, "id"))
                    || (!action_code.is_empty() && action_code == field(team, "tricode"))
            };
            let target = if is_team(home) {
                &mut home_on
            } else if is_team(away) {
                &mut away_on
            } else {
                continue;
            };
            match field(action, "subType") {
                "in" => {
                    target.insert(person_id);
                }
                "out" => {
                    target.remove(&person_id);
                }
                _ => {}
            }
        }
    }
    let court = if can_track && (!home_on.is_empty() || !away_on.is_empty()) {
        result(json!({"home": home_on, "away": away_on}), "fresh", None)
    } else if can_track {
        match cached
            .and_then(|old| old.get("onCourt"))
            .and_then(|state| state.get("data"))
            .filter(|data| !data.is_null())
        {
            Some(data) => result(
                data.clone(),
                "stale",
                Some(
                    "Using last known on-court lineups because live substitutions are unavailable.",
                ),
            ),
            None => result(
                Value::Null,
                "missing",
                Some("On-court lineups are unavailable for this game right now."),
            ),
        }
    } else {
        result(Value::Null, "missing", None)
    };
    let recent = if recent.is_empty() {
        result(Value::Null, "missing", None)
    } else {
        result(json!(recent), "fresh", None)
    };
    json!({"onCourt": court, "recentPlays": recent, "pageFeed": page_feed, "halftimeStartedAt": halftime_started_at})
}

#[cfg(test)]
mod tests {
    use super::build_playbyplay;
    use serde_json::{json, Value};

    #[test]
    fn halftime_uses_the_second_period_end_event_time_and_keeps_it_on_empty_updates() {
        let payload = json!({"game":{"actions":[
            {"period":1,"actionType":"period","subType":"end","timeActual":"2026-11-12T00:00:00Z"},
            {"period":2,"actionType":"2pt","timeActual":"2026-11-12T00:59:59Z"},
            {"period":2,"actionType":"period","subType":"end","timeActual":"2026-11-12T01:00:00Z"},
            {"period":3,"actionType":"period","subType":"start","timeActual":"2026-11-12T01:15:00Z"}
        ]}});
        let result = build_playbyplay(&payload, &json!({}), &json!({}), false, None);
        assert_eq!(result["halftimeStartedAt"], "2026-11-12T01:00:00Z");

        let empty = build_playbyplay(
            &json!({"game":{"actions":[]}}),
            &json!({}),
            &json!({}),
            false,
            Some(&result),
        );
        assert_eq!(empty["halftimeStartedAt"], "2026-11-12T01:00:00Z");
    }

    #[test]
    fn halftime_requires_a_valid_end_event_timestamp() {
        let invalid = json!({"game":{"actions":[
            {"period":2,"actionType":"period","subType":"end","timeActual":"invalid"},
            {"period":1,"descriptor":"endperiod","timeActual":"2026-11-12T00:00:00Z"},
            {"period":2,"actionType":"period","subType":"start","timeActual":"2026-11-12T00:30:00Z"}
        ]}});
        let result = build_playbyplay(&invalid, &json!({}), &json!({}), false, None);
        assert!(result["halftimeStartedAt"].is_null());

        let page = json!({"game":{"source":"hanaV3","actions":[
            {"period":2,"descriptor":"endperiod","timeActual":"2026-11-12T01:00:00Z"}
        ]}});
        let result = build_playbyplay(&page, &json!({}), &json!({}), false, None);
        assert_eq!(result["halftimeStartedAt"], "2026-11-12T01:00:00Z");
    }

    #[test]
    fn page_feed_preserves_order_duplicate_action_numbers_and_running_scores() {
        let home = json!({"id":1,"tricode":"TOR","name":"Raptors"});
        let away = json!({"id":2,"tricode":"ORL","name":"Magic"});
        let payload = json!({"game":{"source":"hanaV3","actions":[
            {"actionId":1,"actionNumber":3,"clock":"PT02M00.00S","actionType":"Made Shot","description":"Carter 3PT Jump Shot (6 PTS) (Bitadze 1 AST)","playerName":"Carter","playerNameI":"W. Carter","teamTricode":"ORL","period":4,"scoreHome":"99","scoreAway":"89"},
            {"actionId":2,"actionNumber":9,"clock":"PT01M18.00S","actionType":"Missed Shot","description":"MISS Cain 5' Tip Layup Shot","playerName":"Cain","teamTricode":"ORL","period":4,"scoreHome":"","scoreAway":""},
            {"actionId":3,"actionNumber":9,"clock":"PT01M18.00S","actionType":"Rebound","subType":"Unknown","description":"Martin REBOUND (Off:0 Def:1)","playerName":"Martin","teamTricode":"TOR","period":4,"scoreHome":"","scoreAway":""},
            {"actionId":4,"actionNumber":4,"clock":"PT00M06.00S","actionType":"Free Throw","description":"Martin Free Throw 1 of 1 (1 PTS)","playerName":"Martin","teamTricode":"TOR","period":4,"scoreHome":"100","scoreAway":"89"}
        ]}});
        let result = build_playbyplay(&payload, &home, &away, false, None);
        let plays = result["recentPlays"]["data"].as_array().unwrap();
        assert_eq!(
            plays
                .iter()
                .map(|play| play["actionNumber"].as_i64().unwrap())
                .collect::<Vec<_>>(),
            vec![4, 9, 9, 3]
        );
        assert!(plays[0]["description"]
            .as_str()
            .unwrap()
            .contains("Martin makes free throw"));
        assert!(plays[1]["description"]
            .as_str()
            .unwrap()
            .contains("Martin rebound (1 rebound; 0 offensive, 1 defensive)"));
        assert!(plays[2]["description"]
            .as_str()
            .unwrap()
            .contains("Cain misses 5-foot tip layup"));
        assert!(plays[3]["description"]
            .as_str()
            .unwrap()
            .contains("Carter makes three-pointer"));
        assert!(plays[3]["description"]
            .as_str()
            .unwrap()
            .contains("Bitadze 1 assist"));
        assert_eq!(
            plays
                .iter()
                .map(|play| (play["scoreHome"].as_i64(), play["scoreAway"].as_i64()))
                .collect::<Vec<_>>(),
            vec![
                (Some(100), Some(89)),
                (Some(99), Some(89)),
                (Some(99), Some(89)),
                (Some(99), Some(89))
            ]
        );
    }

    #[test]
    fn missing_page_scores_stay_unknown() {
        let payload = json!({"game":{"source":"hanaV3","actions":[{"actionNumber":1,"actionType":"Jump Ball","description":"Jump Ball","scoreHome":"","scoreAway":""}]}});
        let result = build_playbyplay(&payload, &json!({}), &json!({}), false, None);
        assert_eq!(result["recentPlays"]["data"][0]["scoreHome"], Value::Null);
        assert_eq!(result["recentPlays"]["data"][0]["scoreAway"], Value::Null);
    }

    #[test]
    fn substitutions_use_chronological_order_and_team_identity() {
        let home = json!({"id":1,"tricode":"TOR","players":[{"personId":10,"position":"G"},{"personId":11,"position":""}]});
        let away = json!({"id":2,"tricode":"ORL","players":[{"personId":20,"position":"F"}]});
        let payload = json!({"game":{"actions":[
            {"actionNumber":2,"orderNumber":2,"actionType":"substitution","subType":"in","personId":11,"teamId":1},
            {"actionNumber":1,"orderNumber":1,"actionType":"substitution","subType":"out","personId":10,"teamId":1},
            {"actionNumber":3,"orderNumber":3,"description":"Home scores","actionType":"2pt","period":1,"scoreHome":"7","scoreAway":"3"}
        ]}});
        let result = build_playbyplay(&payload, &home, &away, true, None);
        assert_eq!(result["onCourt"]["data"], json!({"home":[11],"away":[20]}));
        assert_eq!(result["recentPlays"]["data"][0]["scoreHome"], 7);
    }

    #[test]
    fn live_feed_merges_cached_events_without_repeating_action_numbers() {
        let first = json!({"game":{"actions":[{"actionNumber":1,"orderNumber":1,"description":"Player scores","actionType":"2pt","period":1}]}});
        let second = json!({"game":{"actions":[{"actionNumber":2,"orderNumber":2,"description":"Another scores","actionType":"2pt","period":1}]}});
        let old = build_playbyplay(&first, &json!({}), &json!({}), false, None);
        let next = build_playbyplay(&second, &json!({}), &json!({}), false, Some(&old));
        let repeated = build_playbyplay(&second, &json!({}), &json!({}), false, Some(&next));
        assert_eq!(repeated["recentPlays"]["data"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn adjacent_turnover_and_steal_become_one_play() {
        let payload = json!({"game":{"actions":[
            {"actionNumber":10,"orderNumber":10000,"actionType":"turnover","subType":"bad pass","description":"Smith Bad Pass TURNOVER (1 TO)","playerNameI":"Smith","personId":1,"teamTricode":"TOR","period":2,"clock":"PT01M00.00S","scoreHome":20,"scoreAway":21},
            {"actionNumber":11,"orderNumber":20000,"actionType":"steal","description":"Jones STEAL (1 STL)","playerNameI":"Jones","personId":2,"teamTricode":"ORL","period":2,"clock":"PT01M00.00S","scoreHome":20,"scoreAway":21}
        ]}});
        let result = build_playbyplay(&payload, &json!({}), &json!({}), false, None);
        let plays = result["recentPlays"]["data"].as_array().unwrap();
        assert_eq!(plays.len(), 1);
        assert_eq!(plays[0]["sourceActionNumbers"], json!([11, 10]));
        assert_eq!(plays[0]["teamTricode"], "TOR");
        assert_eq!(plays[0]["possessionTricode"], "ORL");
        assert!(plays[0]["description"]
            .as_str()
            .unwrap()
            .contains("Smith turnover: Bad Pass (1 turnover); Jones steal (1 steal)"));
    }

    #[test]
    fn live_feed_does_not_deduplicate_against_previous_page_feed() {
        let page = json!({"game":{"source":"hanaV3","actions":[{"actionNumber":5,"actionType":"Rebound","description":"Page rebound","period":1}]}});
        let live = json!({"game":{"actions":[{"actionNumber":5,"actionType":"rebound","description":"Live rebound","period":1}]}});
        let old = build_playbyplay(&page, &json!({}), &json!({}), false, None);
        let result = build_playbyplay(&live, &json!({}), &json!({}), false, Some(&old));
        let plays = result["recentPlays"]["data"].as_array().unwrap();
        assert_eq!(plays.len(), 1);
        assert!(plays[0]["description"]
            .as_str()
            .unwrap()
            .contains("Live rebound"));
    }

    #[test]
    fn missing_starters_keep_cached_lineup_marked_stale() {
        let teams = json!({"home":{"id":1,"players":[{"personId":10,"position":""}]},"away":{"id":2,"players":[{"personId":20,"position":""}]}});
        let old =
            json!({"onCourt":{"data":{"home":[11],"away":[20]},"state":"fresh","message":null}});
        let result = build_playbyplay(
            &json!({"game":{"actions":[]}}),
            &teams["home"],
            &teams["away"],
            true,
            Some(&old),
        );
        assert_eq!(result["onCourt"]["state"], "stale");
        assert_eq!(result["onCourt"]["data"], json!({"home":[11],"away":[20]}));
    }
}
