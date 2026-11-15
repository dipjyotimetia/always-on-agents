use anyhow::Result;
use chrono::{DateTime, Utc};
use rusqlite::{Connection, Row, params};
use serde_json::Value;
use std::collections::HashMap;

use crate::db::{Db, OptionalExt, now_iso, with_conn, with_transaction};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EventStatus {
    Pending,
    Running,
    Done,
    Failed,
    Dead,
}

impl EventStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Running => "running",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Dead => "dead",
        }
    }

    fn parse(s: &str) -> Self {
        match s {
            "running" => Self::Running,
            "done" => Self::Done,
            "failed" => Self::Failed,
            "dead" => Self::Dead,
            _ => Self::Pending,
        }
    }
}

#[derive(Debug, Clone)]
pub struct InboxEvent {
    pub id: i64,
    pub inbox_id: String,
    pub source: String,
    pub source_id: String,
    pub session_key: Option<String>,
    pub payload: String,
    pub status: EventStatus,
    pub attempts: i32,
    pub max_attempts: i32,
    pub next_attempt_at: Option<String>,
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

fn row_to_event(row: &Row<'_>) -> rusqlite::Result<InboxEvent> {
    Ok(InboxEvent {
        id: row.get(0)?,
        inbox_id: row.get(1)?,
        source: row.get(2)?,
        source_id: row.get(3)?,
        session_key: row.get(4)?,
        payload: row.get(5)?,
        status: EventStatus::parse(row.get::<_, String>(6)?.as_str()),
        attempts: row.get(7)?,
        max_attempts: row.get(8)?,
        next_attempt_at: row.get(9)?,
        last_error: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

const EVENT_COLUMNS: &str = "id, inbox_id, source, source_id, session_key, payload, status, attempts, max_attempts, next_attempt_at, last_error, created_at, updated_at";

fn fetch_event(
    conn: &Connection,
    inbox_id: &str,
    source: &str,
    source_id: &str,
) -> Result<Option<InboxEvent>> {
    let sql = format!(
        "SELECT {EVENT_COLUMNS} FROM events WHERE inbox_id = ? AND source = ? AND source_id = ?"
    );
    let mut stmt = conn.prepare(&sql)?;
    let event = stmt
        .query_row(params![inbox_id, source, source_id], row_to_event)
        .optional()?;
    Ok(event)
}

pub struct InsertEventInput<'a> {
    pub inbox_id: Option<&'a str>,
    pub source: &'a str,
    pub source_id: &'a str,
    pub session_key: Option<String>,
    pub payload: Value,
    pub max_attempts: Option<i32>,
}

pub struct InsertEventResult {
    pub inserted: bool,
    pub event: Option<InboxEvent>,
}

pub fn insert_event(db: &Db, input: InsertEventInput<'_>) -> Result<InsertEventResult> {
    let inbox_id = input.inbox_id.unwrap_or("default");
    let payload = match &input.payload {
        Value::String(s) => s.clone(),
        other => serde_json::to_string(other)?,
    };
    let max_attempts = input.max_attempts.unwrap_or(3);

    with_conn(db, |conn| {
        let changes = conn.execute(
            "INSERT OR IGNORE INTO events
                (inbox_id, source, source_id, session_key, payload, max_attempts)
             VALUES (?, ?, ?, ?, ?, ?)",
            params![
                inbox_id,
                input.source,
                input.source_id,
                input.session_key,
                payload,
                max_attempts
            ],
        )?;

        if changes == 0 {
            let existing = fetch_event(conn, inbox_id, input.source, input.source_id)?;
            return Ok(InsertEventResult {
                inserted: false,
                event: existing,
            });
        }

        let event = fetch_event(conn, inbox_id, input.source, input.source_id)?;
        Ok(InsertEventResult {
            inserted: true,
            event,
        })
    })
}

/// Reclaim running events whose `updated_at` is older than `older_than_ms`.
/// Fresh claims stay owned by the worker that is still heartbeating the lease.
pub fn reclaim_stale_running(db: &Db, inbox_id: &str, older_than_ms: u64) -> Result<u32> {
    with_transaction(db, |conn| {
        let now = now_iso();
        let sql =
            format!("SELECT {EVENT_COLUMNS} FROM events WHERE inbox_id = ? AND status = 'running'");
        let mut stmt = conn.prepare(&sql)?;
        let mapped = stmt.query_map([inbox_id], row_to_event)?;
        let mut stale = Vec::new();
        for row in mapped {
            let event = row?;
            if event_is_stale(&event, older_than_ms) {
                stale.push(event);
            }
        }

        let mut n = 0u32;
        for event in stale {
            if event.attempts >= event.max_attempts {
                conn.execute(
                    "UPDATE events
                     SET status = 'dead',
                         last_error = COALESCE(last_error, 'exceeded max attempts'),
                         updated_at = ?
                     WHERE id = ?",
                    params![now, event.id],
                )?;
            } else {
                conn.execute(
                    "UPDATE events
                     SET status = 'pending',
                         next_attempt_at = NULL,
                         last_error = 'reclaimed after worker crash',
                         updated_at = ?
                     WHERE id = ?",
                    params![now, event.id],
                )?;
            }
            n += 1;
        }
        Ok(n)
    })
}

/// Atomically claim a batch of ready pending events (BEGIN IMMEDIATE).
/// Increments attempts on claim.
pub fn claim_pending_batch(db: &Db, inbox_id: &str, limit: u32) -> Result<Vec<InboxEvent>> {
    with_transaction(db, |conn| {
        let now = now_iso();
        let sql = format!(
            "SELECT {EVENT_COLUMNS} FROM events
             WHERE inbox_id = ?
               AND status = 'pending'
               AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
             ORDER BY created_at ASC
             LIMIT ?"
        );
        let mut stmt = conn.prepare(&sql)?;
        let pending: Vec<InboxEvent> = stmt
            .query_map(params![inbox_id, now, limit], row_to_event)?
            .collect::<Result<_, _>>()?;

        if pending.is_empty() {
            return Ok(vec![]);
        }

        let ids: Vec<i64> = pending.iter().map(|e| e.id).collect();
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let update_sql = format!(
            "UPDATE events
             SET status = 'running',
                 attempts = attempts + 1,
                 updated_at = ?
             WHERE id IN ({placeholders})"
        );
        let mut update_params: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(now.clone())];
        for id in &ids {
            update_params.push(Box::new(*id));
        }
        conn.execute(
            &update_sql,
            rusqlite::params_from_iter(
                update_params
                    .iter()
                    .map(|b| b.as_ref() as &dyn rusqlite::ToSql),
            ),
        )?;

        let select_sql = format!("SELECT {EVENT_COLUMNS} FROM events WHERE id IN ({placeholders})");
        let mut select_stmt = conn.prepare(&select_sql)?;
        let claimed: Vec<InboxEvent> = select_stmt
            .query_map(rusqlite::params_from_iter(ids.iter()), row_to_event)?
            .collect::<Result<_, _>>()?;
        Ok(claimed)
    })
}

pub fn mark_events_done(db: &Db, ids: &[i64]) -> Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "UPDATE events SET status = 'done', updated_at = ?, next_attempt_at = NULL
         WHERE id IN ({placeholders})"
    );
    with_conn(db, |conn| {
        let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(now_iso())];
        for id in ids {
            params.push(Box::new(*id));
        }
        conn.execute(
            &sql,
            rusqlite::params_from_iter(params.iter().map(|p| p.as_ref() as &dyn rusqlite::ToSql)),
        )?;
        Ok(())
    })
}

/// Soft-fail with backoff; dead-letter after max attempts.
pub fn mark_events_failed(db: &Db, ids: &[i64], error: &str) -> Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let now = now_iso();
    with_conn(db, |conn| {
        for id in ids {
            let sql = format!("SELECT {EVENT_COLUMNS} FROM events WHERE id = ?");
            let row = conn.query_row(&sql, [id], row_to_event).optional()?;
            let Some(event) = row else {
                continue;
            };
            if event.attempts >= event.max_attempts {
                conn.execute(
                    "UPDATE events
                     SET status = 'dead', last_error = ?, updated_at = ?, next_attempt_at = NULL
                     WHERE id = ?",
                    params![error, now, id],
                )?;
            } else {
                let backoff_sec = std::cmp::min(300, 2_i64.pow(event.attempts as u32));
                let next = chrono::Utc::now() + chrono::Duration::seconds(backoff_sec);
                let next_iso = next.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                conn.execute(
                    "UPDATE events
                     SET status = 'pending',
                         last_error = ?,
                         next_attempt_at = ?,
                         updated_at = ?
                     WHERE id = ?",
                    params![error, next_iso, now, id],
                )?;
            }
        }
        Ok(())
    })
}

pub fn reopen_dead(db: &Db, id: i64) -> Result<()> {
    with_conn(db, |conn| {
        conn.execute(
            "UPDATE events
             SET status = 'pending', attempts = 0, next_attempt_at = NULL,
                 last_error = NULL, updated_at = ?
             WHERE id = ? AND status = 'dead'",
            params![now_iso(), id],
        )?;
        Ok(())
    })
}

pub fn count_by_status(db: &Db, inbox_id: &str) -> Result<HashMap<String, u32>> {
    with_conn(db, |conn| {
        let mut stmt = conn.prepare(
            "SELECT status, COUNT(*) AS c FROM events WHERE inbox_id = ? GROUP BY status",
        )?;
        let rows = stmt.query_map([inbox_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as u32))
        })?;
        let mut out = HashMap::new();
        for r in rows {
            let (status, c) = r?;
            out.insert(status, c);
        }
        Ok(out)
    })
}

fn event_is_stale(event: &InboxEvent, older_than_ms: u64) -> bool {
    let Ok(updated) = DateTime::parse_from_rfc3339(&event.updated_at) else {
        return true;
    };
    let age_ms = Utc::now()
        .signed_duration_since(updated.with_timezone(&Utc))
        .num_milliseconds();
    age_ms >= i64::try_from(older_than_ms).unwrap_or(i64::MAX)
}

pub fn group_by_session_key(events: &[InboxEvent]) -> HashMap<String, Vec<InboxEvent>> {
    let mut groups: HashMap<String, Vec<InboxEvent>> = HashMap::new();
    for event in events {
        let key = event
            .session_key
            .clone()
            .unwrap_or_else(|| format!("ephemeral:{}", event.id));
        groups.entry(key).or_default().push(event.clone());
    }
    groups
}
