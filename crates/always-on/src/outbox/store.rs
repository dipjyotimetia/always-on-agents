use anyhow::Result;
use rusqlite::{Connection, Row, params};
use serde_json::{Value, json};
use std::collections::HashMap;

use crate::db::{Db, OptionalExt, now_iso, with_conn, with_transaction};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OutboxStatus {
    Pending,
    Sending,
    Sent,
    Failed,
    Suppressed,
}

impl OutboxStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Sending => "sending",
            Self::Sent => "sent",
            Self::Failed => "failed",
            Self::Suppressed => "suppressed",
        }
    }

    fn parse(s: &str) -> Self {
        match s {
            "sending" => Self::Sending,
            "sent" => Self::Sent,
            "failed" => Self::Failed,
            "suppressed" => Self::Suppressed,
            _ => Self::Pending,
        }
    }
}

#[derive(Debug, Clone)]
pub struct OutboxMessage {
    pub id: i64,
    pub inbox_id: String,
    pub channel: String,
    pub body: String,
    pub meta: String,
    pub idempotency_key: Option<String>,
    pub status: OutboxStatus,
    pub attempts: i32,
    pub created_at: String,
    pub updated_at: String,
    pub sent_at: Option<String>,
}

fn row_to_outbox(row: &Row<'_>) -> rusqlite::Result<OutboxMessage> {
    Ok(OutboxMessage {
        id: row.get(0)?,
        inbox_id: row.get(1)?,
        channel: row.get(2)?,
        body: row.get(3)?,
        meta: row.get(4)?,
        idempotency_key: row.get(5)?,
        status: OutboxStatus::parse(row.get::<_, String>(6)?.as_str()),
        attempts: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
        sent_at: row.get(10)?,
    })
}

const OUTBOX_COLUMNS: &str = "id, inbox_id, channel, body, meta, idempotency_key, status, attempts, created_at, updated_at, sent_at";

fn fetch_outbox_by_id(conn: &Connection, id: i64) -> Result<OutboxMessage> {
    let sql = format!("SELECT {OUTBOX_COLUMNS} FROM outbox WHERE id = ?");
    let msg = conn.query_row(&sql, [id], row_to_outbox)?;
    Ok(msg)
}

pub struct EnqueueOutboxOpts<'a> {
    pub inbox_id: Option<&'a str>,
    pub channel: Option<&'a str>,
    pub body: &'a str,
    pub meta: Option<HashMap<String, Value>>,
    pub idempotency_key: Option<&'a str>,
}

pub fn enqueue_outbox(db: &Db, opts: EnqueueOutboxOpts<'_>) -> Result<OutboxMessage> {
    let inbox_id = opts.inbox_id.unwrap_or("default");
    let key = opts.idempotency_key;

    with_conn(db, |conn| {
        if let Some(k) = key {
            let existing: Option<OutboxMessage> = conn
                .query_row(
                    &format!("SELECT {OUTBOX_COLUMNS} FROM outbox WHERE inbox_id = ? AND idempotency_key = ?"),
                    params![inbox_id, k],
                    row_to_outbox,
                )
                .optional()?;
            if let Some(msg) = existing {
                return Ok(msg);
            }
        }

        let meta = serde_json::to_string(&opts.meta.unwrap_or_default())?;
        conn.execute(
            "INSERT INTO outbox (inbox_id, channel, body, meta, idempotency_key)
             VALUES (?, ?, ?, ?, ?)",
            params![
                inbox_id,
                opts.channel.unwrap_or("log"),
                opts.body,
                meta,
                key
            ],
        )?;
        let id = conn.last_insert_rowid();
        fetch_outbox_by_id(conn, id)
    })
}

/// Atomically claim pending messages by moving them to `sending`.
pub fn claim_pending_outbox(db: &Db, limit: u32) -> Result<Vec<OutboxMessage>> {
    with_transaction(db, |conn| {
        let sql = format!(
            "SELECT {OUTBOX_COLUMNS} FROM outbox WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?"
        );
        let mut stmt = conn.prepare(&sql)?;
        let pending: Vec<OutboxMessage> = stmt
            .query_map([limit], row_to_outbox)?
            .collect::<Result<_, _>>()?;

        if pending.is_empty() {
            return Ok(vec![]);
        }

        let ids: Vec<i64> = pending.iter().map(|m| m.id).collect();
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let now = now_iso();
        let update_sql = format!(
            "UPDATE outbox
             SET status = 'sending', attempts = attempts + 1, updated_at = ?
             WHERE id IN ({placeholders})"
        );
        let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(now)];
        for id in &ids {
            params.push(Box::new(*id));
        }
        conn.execute(
            &update_sql,
            rusqlite::params_from_iter(params.iter().map(|p| p.as_ref() as &dyn rusqlite::ToSql)),
        )?;

        let select_sql =
            format!("SELECT {OUTBOX_COLUMNS} FROM outbox WHERE id IN ({placeholders})");
        let mut stmt = conn.prepare(&select_sql)?;
        let claimed: Vec<OutboxMessage> = stmt
            .query_map(rusqlite::params_from_iter(ids.iter()), row_to_outbox)?
            .collect::<Result<_, _>>()?;
        Ok(claimed)
    })
}

/// Reclaim stuck sending rows (dispatcher crash).
pub fn reclaim_stale_sending(db: &Db, older_than_ms: u64) -> Result<u32> {
    let cutoff = (chrono::Utc::now() - chrono::Duration::milliseconds(older_than_ms as i64))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    with_conn(db, |conn| {
        let n = conn.execute(
            "UPDATE outbox
             SET status = 'pending', updated_at = ?
             WHERE status = 'sending' AND updated_at < ?",
            params![now_iso(), cutoff],
        )?;
        Ok(n as u32)
    })
}

pub fn mark_outbox_sent(db: &Db, id: i64) -> Result<()> {
    with_conn(db, |conn| {
        conn.execute(
            "UPDATE outbox SET status = 'sent', sent_at = ? WHERE id = ?",
            params![now_iso(), id],
        )?;
        Ok(())
    })
}

pub fn mark_outbox_suppressed(db: &Db, id: i64, reason: &str) -> Result<()> {
    with_conn(db, |conn| {
        let meta_raw: Option<String> = conn
            .query_row("SELECT meta FROM outbox WHERE id = ?", [id], |r| r.get(0))
            .optional()?;
        let mut meta = safe_meta(meta_raw.as_deref());
        meta.insert("suppressReason".to_string(), json!(reason));
        conn.execute(
            "UPDATE outbox SET status = 'suppressed', meta = ? WHERE id = ?",
            params![serde_json::to_string(&meta)?, id],
        )?;
        Ok(())
    })
}

pub fn mark_outbox_failed(db: &Db, id: i64, error: &str) -> Result<()> {
    with_conn(db, |conn| {
        let row: Option<(String, i32)> = conn
            .query_row(
                "SELECT meta, attempts FROM outbox WHERE id = ?",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((meta_raw, attempts)) = row else {
            return Ok(());
        };
        let mut meta = safe_meta(Some(&meta_raw));
        meta.insert("error".to_string(), json!(error));
        let status = if attempts >= 5 {
            OutboxStatus::Failed.as_str()
        } else {
            OutboxStatus::Pending.as_str()
        };
        conn.execute(
            "UPDATE outbox SET status = ?, meta = ? WHERE id = ?",
            params![status, serde_json::to_string(&meta)?, id],
        )?;
        Ok(())
    })
}

fn safe_meta(raw: Option<&str>) -> HashMap<String, Value> {
    match raw {
        Some(s) => serde_json::from_str(s).unwrap_or_default(),
        None => HashMap::new(),
    }
}
