use anyhow::{bail, Result};
use chrono::{DateTime, Utc};
use rusqlite::{params, Row};
use serde_json::Value;

use crate::db::{now_iso, with_conn, with_transaction, Db};
use crate::inbox::store::{insert_event, InsertEventInput};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimerKind {
    Followup,
    Schedule,
}

impl TimerKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Followup => "followup",
            Self::Schedule => "schedule",
        }
    }

    fn parse(s: &str) -> Self {
        if s == "schedule" {
            Self::Schedule
        } else {
            Self::Followup
        }
    }
}

#[derive(Debug, Clone)]
pub struct TimerRow {
    pub id: i64,
    pub inbox_id: String,
    pub kind: TimerKind,
    pub due_at: String,
    pub every_s: Option<i32>,
    pub session_key: Option<String>,
    pub payload: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

fn row_to_timer(row: &Row<'_>) -> rusqlite::Result<TimerRow> {
    Ok(TimerRow {
        id: row.get(0)?,
        inbox_id: row.get(1)?,
        kind: TimerKind::parse(row.get::<_, String>(2)?.as_str()),
        due_at: row.get(3)?,
        every_s: row.get(4)?,
        session_key: row.get(5)?,
        payload: row.get(6)?,
        status: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

const TIMER_COLUMNS: &str =
    "id, inbox_id, kind, due_at, every_s, session_key, payload, status, created_at, updated_at";

pub fn count_active_followups(db: &Db, inbox_id: &str) -> Result<u32> {
    with_conn(db, |conn| {
        let c: i64 = conn.query_row(
            "SELECT COUNT(*) AS c FROM timers
             WHERE inbox_id = ? AND kind = 'followup' AND status = 'active'",
            [inbox_id],
            |row| row.get(0),
        )?;
        Ok(c as u32)
    })
}

pub struct CreateFollowupOpts<'a> {
    pub inbox_id: Option<&'a str>,
    pub due_at: DateTime<Utc>,
    pub session_key: Option<String>,
    pub note: &'a str,
    pub min_followup_seconds: u64,
    pub max_active_followups: u32,
}

pub fn create_followup(db: &Db, opts: CreateFollowupOpts<'_>) -> Result<TimerRow> {
    let inbox_id = opts.inbox_id.unwrap_or("default");
    let earliest_ms = Utc::now().timestamp_millis() + (opts.min_followup_seconds * 1000) as i64;
    let due_ms = std::cmp::max(opts.due_at.timestamp_millis(), earliest_ms);

    if count_active_followups(db, inbox_id)? >= opts.max_active_followups {
        bail!(
            "follow-up cap reached ({})",
            opts.max_active_followups
        );
    }

    let due_iso = DateTime::<Utc>::from_timestamp_millis(due_ms)
        .unwrap_or_else(Utc::now)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let payload = serde_json::json!({ "note": opts.note });

    with_conn(db, |conn| {
        conn.execute(
            "INSERT INTO timers (inbox_id, kind, due_at, session_key, payload)
             VALUES (?, 'followup', ?, ?, ?)",
            params![
                inbox_id,
                due_iso,
                opts.session_key,
                payload.to_string()
            ],
        )?;
        let id = conn.last_insert_rowid();
        let sql = format!("SELECT {TIMER_COLUMNS} FROM timers WHERE id = ?");
        conn.query_row(&sql, [id], row_to_timer)
            .map_err(Into::into)
    })
}

pub struct CreateScheduleOpts<'a> {
    pub inbox_id: Option<&'a str>,
    pub due_at: DateTime<Utc>,
    pub every_s: u64,
    pub session_key: Option<String>,
    pub payload: Value,
}

pub fn create_schedule(db: &Db, opts: CreateScheduleOpts<'_>) -> Result<TimerRow> {
    let inbox_id = opts.inbox_id.unwrap_or("default");
    let due_iso = opts
        .due_at
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    with_conn(db, |conn| {
        conn.execute(
            "INSERT INTO timers (inbox_id, kind, due_at, every_s, session_key, payload)
             VALUES (?, 'schedule', ?, ?, ?, ?)",
            params![
                inbox_id,
                due_iso,
                opts.every_s as i32,
                opts.session_key,
                opts.payload.to_string()
            ],
        )?;
        let id = conn.last_insert_rowid();
        let sql = format!("SELECT {TIMER_COLUMNS} FROM timers WHERE id = ?");
        conn.query_row(&sql, [id], row_to_timer)
            .map_err(Into::into)
    })
}

/// Fire due timers into the inbox inside one IMMEDIATE transaction per timer.
/// Schedule misfire policy: skip to next slot after now (no backlog storms).
pub fn fire_due_timers(db: &Db, now: DateTime<Utc>) -> Result<u32> {
    let now_cutoff = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let due: Vec<TimerRow> = with_conn(db, |conn| {
        let sql = format!(
            "SELECT {TIMER_COLUMNS} FROM timers
             WHERE status = 'active' AND due_at <= ?
             ORDER BY due_at ASC
             LIMIT 100"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt
            .query_map([&now_cutoff], row_to_timer)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })?;

    let mut fired = 0u32;
    for timer in due {
        let did_fire = with_transaction(db, |conn| {
            let sql = format!("SELECT {TIMER_COLUMNS} FROM timers WHERE id = ?");
            let fresh: Option<TimerRow> = conn.query_row(&sql, [timer.id], row_to_timer).ok();
            let Some(fresh) = fresh else {
                return Ok(false);
            };
            if fresh.status != "active" {
                return Ok(false);
            }
            let fresh_due = DateTime::parse_from_rfc3339(&fresh.due_at)
                .map(|d| d.with_timezone(&Utc))
                .unwrap_or(now);
            if fresh_due > now {
                return Ok(false);
            }

            let source_id = format!("{}:{}", fresh.id, fresh.due_at);
            let body: Value =
                serde_json::from_str(&fresh.payload).unwrap_or(Value::Null);

            // insert_event needs Connection - inline the insert within transaction
            let payload = serde_json::json!({
                "timerId": fresh.id,
                "kind": fresh.kind.as_str(),
                "dueAt": fresh.due_at,
                "body": body,
            });
            conn.execute(
                "INSERT OR IGNORE INTO events
                    (inbox_id, source, source_id, session_key, payload, max_attempts)
                 VALUES (?, 'timer', ?, ?, ?, 3)",
                params![
                    fresh.inbox_id,
                    source_id,
                    fresh.session_key,
                    payload.to_string()
                ],
            )?;

            if fresh.kind == TimerKind::Followup {
                conn.execute(
                    "UPDATE timers SET status = 'done', updated_at = ? WHERE id = ?",
                    params![now_iso(), fresh.id],
                )?;
            } else {
                let every = fresh.every_s.unwrap_or(86_400) as i64;
                let mut next = fresh_due.timestamp_millis() + every * 1000;
                let now_ms = now.timestamp_millis();
                while next <= now_ms {
                    next += every * 1000;
                }
                let next_iso = DateTime::<Utc>::from_timestamp_millis(next)
                    .unwrap_or(now)
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
                conn.execute(
                    "UPDATE timers SET due_at = ?, updated_at = ? WHERE id = ?",
                    params![next_iso, now_iso(), fresh.id],
                )?;
            }
            Ok(true)
        })?;
        if did_fire {
            fired += 1;
        }
    }
    Ok(fired)
}

/// Convenience wrapper using `insert_event` API (for external callers); timer firing uses inline SQL above.
#[allow(dead_code)]
pub fn fire_timer_as_event(db: &Db, fresh: &TimerRow, body: Value) -> Result<()> {
    let source_id = format!("{}:{}", fresh.id, fresh.due_at);
    insert_event(
        db,
        InsertEventInput {
            inbox_id: Some(&fresh.inbox_id),
            source: "timer",
            source_id: &source_id,
            session_key: fresh.session_key.clone(),
            payload: serde_json::json!({
                "timerId": fresh.id,
                "kind": fresh.kind.as_str(),
                "dueAt": fresh.due_at,
                "body": body,
            }),
            max_attempts: None,
        },
    )?;
    Ok(())
}