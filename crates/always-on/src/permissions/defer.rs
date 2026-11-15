use anyhow::{Result, bail};
use regex::Regex;
use rusqlite::{Row, params};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::LazyLock;
use uuid::Uuid;

use crate::db::{Db, OptionalExt, now_iso, with_conn};

const DEFAULT_TTL_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone)]
pub struct DeferredCall {
    pub id: String,
    pub inbox_id: String,
    pub session_key: String,
    pub tool_name: String,
    pub arguments_json: String,
    pub status: String,
    pub created_at: String,
    pub expires_at: String,
    pub resolved_at: Option<String>,
    pub executed_at: Option<String>,
    pub result_json: Option<String>,
}

fn row_to_deferred(row: &Row<'_>) -> rusqlite::Result<DeferredCall> {
    Ok(DeferredCall {
        id: row.get(0)?,
        inbox_id: row.get(1)?,
        session_key: row.get(2)?,
        tool_name: row.get(3)?,
        arguments_json: row.get(4)?,
        status: row.get(5)?,
        created_at: row.get(6)?,
        expires_at: row.get(7)?,
        resolved_at: row.get(8)?,
        executed_at: row.get(9)?,
        result_json: row.get(10)?,
    })
}

const DEFERRED_COLUMNS: &str = "id, inbox_id, session_key, tool_name, arguments_json, status, created_at, expires_at, resolved_at, executed_at, result_json";

pub struct CreateDeferredCallOpts<'a> {
    pub inbox_id: Option<&'a str>,
    pub session_key: &'a str,
    pub tool_name: &'a str,
    pub args: Value,
    pub ttl_ms: Option<i64>,
}

pub fn create_deferred_call(db: &Db, opts: CreateDeferredCallOpts<'_>) -> Result<DeferredCall> {
    let id = Uuid::new_v4().to_string();
    let ttl = opts.ttl_ms.unwrap_or(DEFAULT_TTL_MS);
    let expires = (chrono::Utc::now() + chrono::Duration::milliseconds(ttl))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

    with_conn(db, |conn| {
        conn.execute(
            "INSERT INTO deferred_calls
              (id, inbox_id, session_key, tool_name, arguments_json, expires_at)
             VALUES (?, ?, ?, ?, ?, ?)",
            params![
                id,
                opts.inbox_id.unwrap_or("default"),
                opts.session_key,
                opts.tool_name,
                opts.args.to_string(),
                expires
            ],
        )?;
        let sql = format!("SELECT {DEFERRED_COLUMNS} FROM deferred_calls WHERE id = ?");
        conn.query_row(&sql, [&id], row_to_deferred)
            .map_err(Into::into)
    })
}

pub fn get_deferred_call(db: &Db, id: &str) -> Result<Option<DeferredCall>> {
    with_conn(db, |conn| {
        let sql = format!("SELECT {DEFERRED_COLUMNS} FROM deferred_calls WHERE id = ?");
        conn.query_row(&sql, [id], row_to_deferred)
            .optional()
            .map_err(Into::into)
    })
}

pub fn resolve_deferred_call(db: &Db, id: &str, decision: &str) -> Result<DeferredCall> {
    let row = get_deferred_call(db, id)?;
    let Some(row) = row else {
        bail!("unknown deferred call: {id}");
    };
    if row.status != "pending" {
        bail!("deferred call {id} already {}", row.status);
    }
    if chrono::DateTime::parse_from_rfc3339(&row.expires_at)
        .map(|d| d.timestamp_millis() <= chrono::Utc::now().timestamp_millis())
        .unwrap_or(true)
    {
        with_conn(db, |conn| {
            conn.execute(
                "UPDATE deferred_calls SET status = 'expired', resolved_at = ? WHERE id = ?",
                params![now_iso(), id],
            )?;
            Ok(())
        })?;
        bail!("deferred call {id} expired");
    }
    if decision != "approved" && decision != "denied" {
        bail!("invalid decision: {decision}");
    }
    with_conn(db, |conn| {
        conn.execute(
            "UPDATE deferred_calls SET status = ?, resolved_at = ? WHERE id = ?",
            params![decision, now_iso(), id],
        )?;
        Ok(())
    })?;
    get_deferred_call(db, id)?.ok_or_else(|| anyhow::anyhow!("deferred call vanished"))
}

pub fn mark_deferred_executed(db: &Db, id: &str, result: &Value) -> Result<()> {
    with_conn(db, |conn| {
        conn.execute(
            "UPDATE deferred_calls
             SET status = 'executed', executed_at = ?, result_json = ?
             WHERE id = ?",
            params![now_iso(), result.to_string(), id],
        )?;
        Ok(())
    })
}

pub fn mark_deferred_failed(db: &Db, id: &str, error: &str) -> Result<()> {
    let body = serde_json::json!({ "error": error });
    with_conn(db, |conn| {
        conn.execute(
            "UPDATE deferred_calls
             SET status = 'failed', executed_at = ?, result_json = ?
             WHERE id = ?",
            params![now_iso(), body.to_string(), id],
        )?;
        Ok(())
    })
}

/// Expire pending deferred calls past expires_at.
pub fn expire_deferred_calls(db: &Db) -> Result<u32> {
    let now = now_iso();
    with_conn(db, |conn| {
        let n = conn.execute(
            "UPDATE deferred_calls
             SET status = 'expired', resolved_at = ?
             WHERE status = 'pending' AND expires_at <= ?",
            params![now, now],
        )?;
        Ok(n as u32)
    })
}

static SHELL_BLOCK_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\b(rm\s+-rf|mkfs|dd\s+if=|curl\s+[^\n]*\|\s*(ba)?sh|wget\s+[^\n]*\|\s*(ba)?sh|chmod\s+777)\b",
    )
    .expect("shell block regex")
});

static SHELL_DEFER_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(curl|wget|nc|ncat|ssh|scp)\b").expect("shell defer regex")
});

/// Dangerous-action classifier (auto mode stand-in).
pub fn classify_risk(tool_name: &str, args: &HashMap<String, Value>) -> &'static str {
    if matches!(
        tool_name,
        "request_approval" | "send_external" | "proxied_request"
    ) {
        return "defer";
    }
    if tool_name == "mark_progress_complete" {
        return "allow";
    }
    if tool_name == "shell" || tool_name == "bash" {
        let cmd = args.get("command").and_then(|v| v.as_str()).unwrap_or("");
        if SHELL_BLOCK_RE.is_match(cmd) {
            return "block";
        }
        if SHELL_DEFER_RE.is_match(cmd) {
            return "defer";
        }
    }
    if tool_name == "write_memory" {
        let prov = args
            .get("provenance")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let p = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
        if p == "instructions.md" {
            return "block";
        }
        if prov == "user" && !p.starts_with("notes/preferences") {
            return "defer";
        }
    }
    "allow"
}
