use anyhow::Result;
use chrono::Utc;
use std::collections::HashMap;

use crate::config::Config;
use crate::db::{Db, with_conn};
use crate::inbox::store::count_by_status;
use crate::stop::is_stopped;

#[derive(Debug, Clone, serde::Serialize)]
pub struct BacklogMetrics {
    pub stopped: bool,
    pub stop_path: String,
    pub events: HashMap<String, u32>,
    pub outbox_pending: u32,
    pub outbox_sending: u32,
    pub deferred_pending: u32,
    pub deferred_expired: u32,
    pub active_followups: u32,
    pub runs_today: u32,
    pub tokens_today: u32,
}

pub fn get_backlog_metrics(db: &Db, config: &Config, inbox_id: &str) -> Result<BacklogMetrics> {
    let events = count_by_status(db, inbox_id)?;

    let (outbox_pending, outbox_sending, deferred_pending, deferred_expired, active_followups) =
        with_conn(db, |conn| {
            let outbox_pending: i64 = conn.query_row(
                "SELECT COUNT(*) AS c FROM outbox WHERE status = 'pending'",
                [],
                |row| row.get(0),
            )?;
            let outbox_sending: i64 = conn.query_row(
                "SELECT COUNT(*) AS c FROM outbox WHERE status = 'sending'",
                [],
                |row| row.get(0),
            )?;
            let deferred_pending: i64 = conn.query_row(
                "SELECT COUNT(*) AS c FROM deferred_calls WHERE status = 'pending'",
                [],
                |row| row.get(0),
            )?;
            let deferred_expired: i64 = conn.query_row(
                "SELECT COUNT(*) AS c FROM deferred_calls WHERE status = 'expired'",
                [],
                |row| row.get(0),
            )?;
            let active_followups: i64 = conn.query_row(
                "SELECT COUNT(*) AS c FROM timers WHERE kind = 'followup' AND status = 'active'",
                [],
                |row| row.get(0),
            )?;
            Ok((
                outbox_pending as u32,
                outbox_sending as u32,
                deferred_pending as u32,
                deferred_expired as u32,
                active_followups as u32,
            ))
        })?;

    let day = Utc::now().format("%Y-%m-%d").to_string();
    let (runs_today, tokens_today) = with_conn(db, |conn| {
        let budget: Option<(i64, i64)> = conn
            .query_row(
                "SELECT runs, tokens FROM daily_budget WHERE day = ? AND inbox_id = ?",
                rusqlite::params![day, inbox_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok();
        Ok(match budget {
            Some((r, t)) => (r as u32, t as u32),
            None => (0, 0),
        })
    })?;

    Ok(BacklogMetrics {
        stopped: is_stopped(config),
        stop_path: config.stop_path.to_string_lossy().to_string(),
        events,
        outbox_pending,
        outbox_sending,
        deferred_pending,
        deferred_expired,
        active_followups,
        runs_today,
        tokens_today,
    })
}
