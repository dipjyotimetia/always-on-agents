use crate::config::Config;
use crate::db::{with_conn, Db};
use crate::evals::silence::{list_silences, silence_stats};
use crate::ops::metrics::get_backlog_metrics;
use serde::Serialize;
use serde_json::{json, Value};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardSnapshot {
    pub at: String,
    pub brain: String,
    pub model: String,
    pub metrics: Value,
    pub silence: Value,
    #[serde(rename = "recentSilences")]
    pub recent_silences: Value,
    pub events: Vec<Value>,
    pub runs: Vec<Value>,
    pub deferred: Vec<Value>,
    pub outbox: Vec<Value>,
    pub timers: Vec<Value>,
}

pub fn get_dashboard_snapshot(db: &Db, config: &Config) -> Result<DashboardSnapshot, String> {
    const INBOX: &str = "default";
    let metrics = get_backlog_metrics(db, config, INBOX).map_err(|e| e.to_string())?;

    let (events, runs, deferred, outbox, timers) = with_conn(db, |conn| {
        Ok((
            query_rows(
                conn,
                "SELECT id, source, source_id, session_key, status, attempts, last_error, created_at
                 FROM events ORDER BY id DESC LIMIT 25",
            )?,
            query_rows(
                conn,
                "SELECT id, session_key, outcome, silence_reason, tokens_in, tokens_out, created_at
                 FROM run_log ORDER BY id DESC LIMIT 25",
            )?,
            query_rows(
                conn,
                "SELECT id, tool_name, status, session_key, arguments_json, expires_at, created_at
                 FROM deferred_calls
                 WHERE status IN ('pending','approved','executed','failed','denied','expired')
                 ORDER BY created_at DESC LIMIT 20",
            )?,
            query_rows(
                conn,
                "SELECT id, channel, status, substr(body, 1, 160) AS body, created_at, sent_at
                 FROM outbox ORDER BY id DESC LIMIT 20",
            )?,
            query_rows(
                conn,
                "SELECT id, kind, due_at, status, session_key, payload
                 FROM timers WHERE status = 'active' ORDER BY due_at ASC LIMIT 15",
            )?,
        ))
    })
    .map_err(|e| e.to_string())?;

    let (brain, model) = resolve_brain_display(config);

    Ok(DashboardSnapshot {
        at: chrono::Utc::now().to_rfc3339(),
        brain,
        model,
        metrics: serde_json::to_value(metrics).unwrap_or(Value::Null),
        silence: serde_json::to_value(silence_stats(db, INBOX).map_err(|e| e.to_string())?)
            .unwrap_or(Value::Null),
        recent_silences: serde_json::to_value(
            list_silences(db, 10, None).map_err(|e| e.to_string())?,
        )
        .unwrap_or(Value::Null),
        events,
        runs,
        deferred,
        outbox,
        timers,
    })
}

fn resolve_brain_display(config: &Config) -> (String, String) {
    let p = config.brain_provider.trim().to_lowercase();
    match p.as_str() {
        "mock" => ("mock".into(), "mock".into()),
        "anthropic" => ("anthropic".into(), config.anthropic_model.clone()),
        "openai" | "openai_compat" => ("openai".into(), config.openai_model.clone()),
        "gemini" => ("gemini".into(), config.gemini_model.clone()),
        _ => {
            if config
                .anthropic_api_key
                .as_ref()
                .is_some_and(|k| !k.is_empty())
            {
                ("anthropic".into(), config.anthropic_model.clone())
            } else if config
                .openai_api_key
                .as_ref()
                .is_some_and(|k| !k.is_empty())
            {
                ("openai".into(), config.openai_model.clone())
            } else if config
                .gemini_api_key
                .as_ref()
                .is_some_and(|k| !k.is_empty())
            {
                ("gemini".into(), config.gemini_model.clone())
            } else {
                ("mock".into(), "mock".into())
            }
        }
    }
}

fn query_rows(conn: &rusqlite::Connection, sql: &str) -> rusqlite::Result<Vec<Value>> {
    let mut stmt = conn.prepare(sql)?;
    let names: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let mut rows = stmt.query([])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        let mut obj = serde_json::Map::new();
        for (i, name) in names.iter().enumerate() {
            let value: rusqlite::types::Value = row.get(i)?;
            obj.insert(name.clone(), sqlite_value_to_json(value));
        }
        out.push(Value::Object(obj));
    }
    Ok(out)
}

fn sqlite_value_to_json(value: rusqlite::types::Value) -> Value {
    match value {
        rusqlite::types::Value::Null => Value::Null,
        rusqlite::types::Value::Integer(i) => json!(i),
        rusqlite::types::Value::Real(f) => serde_json::Number::from_f64(f)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        rusqlite::types::Value::Text(s) => Value::String(s),
        rusqlite::types::Value::Blob(b) => Value::String(String::from_utf8_lossy(&b).into_owned()),
    }
}
