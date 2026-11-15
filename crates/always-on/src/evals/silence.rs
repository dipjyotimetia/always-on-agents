use anyhow::Result;
use rusqlite::Row;

use crate::db::{with_conn, Db};

#[derive(Debug, Clone, serde::Serialize)]
pub struct SilenceEvalRow {
    pub id: i64,
    pub session_key: Option<String>,
    pub silence_reason: Option<String>,
    pub created_at: String,
    /// Optional human label: good_silence | missed_notify | noisy
    pub label: Option<String>,
}

fn row_to_silence(row: &Row<'_>) -> rusqlite::Result<SilenceEvalRow> {
    Ok(SilenceEvalRow {
        id: row.get(0)?,
        session_key: row.get(1)?,
        silence_reason: row.get(2)?,
        created_at: row.get(3)?,
        label: None,
    })
}

/// Export recent silence outcomes for offline labeling / attention tuning.
pub fn list_silences(db: &Db, limit: u32, inbox_id: Option<&str>) -> Result<Vec<SilenceEvalRow>> {
    with_conn(db, |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, session_key, silence_reason, created_at
             FROM run_log
             WHERE outcome = 'silence'
               AND (?1 IS NULL OR inbox_id = ?1)
             ORDER BY id DESC
             LIMIT ?2",
        )?;
        let rows = stmt.query_map(rusqlite::params![inbox_id, limit], row_to_silence)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    })
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SilenceStats {
    pub total_runs: u32,
    pub silences: u32,
    pub notifies: u32,
    pub deferred: u32,
    pub silence_rate: f64,
}

pub fn silence_stats(db: &Db, inbox_id: &str) -> Result<SilenceStats> {
    with_conn(db, |conn| {
        let mut stmt = conn.prepare(
            "SELECT outcome, COUNT(*) AS c FROM run_log WHERE inbox_id = ? GROUP BY outcome",
        )?;
        let rows = stmt.query_map([inbox_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as u32))
        })?;
        let mut counts = std::collections::HashMap::new();
        for r in rows {
            let (outcome, c) = r?;
            counts.insert(outcome, c);
        }
        let total_runs: u32 = counts.values().sum();
        let silences = *counts.get("silence").unwrap_or(&0);
        let notifies = *counts.get("notified").unwrap_or(&0);
        let deferred = *counts.get("deferred").unwrap_or(&0);
        let silence_rate = if total_runs == 0 {
            0.0
        } else {
            silences as f64 / total_runs as f64
        };
        Ok(SilenceStats {
            total_runs,
            silences,
            notifies,
            deferred,
            silence_rate,
        })
    })
}
