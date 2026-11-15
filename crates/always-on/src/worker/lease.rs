use anyhow::Result;
use chrono::{DateTime, Utc};
use rusqlite::params;
use uuid::Uuid;

use crate::db::{Db, now_iso, with_transaction};

#[derive(Debug, Clone)]
pub struct Lease {
    pub inbox_id: String,
    pub owner: String,
    pub fence: i32,
}

struct LeaseRow {
    #[allow(dead_code)]
    inbox_id: String,
    owner: String,
    fence: i32,
    expires_at: String,
}

/// Acquire lease with compare-and-swap on expiry and a monotonically increasing fence.
/// All subsequent heartbeats must present the same fence.
pub fn acquire_lease(
    db: &Db,
    inbox_id: &str,
    owner: Option<&str>,
    ttl_ms: Option<u64>,
) -> Result<Option<Lease>> {
    let owner = owner
        .map(str::to_string)
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let ttl_ms = ttl_ms.unwrap_or(30_000);

    with_transaction(db, |conn| {
        let now = Utc::now();
        let expires = (now + chrono::Duration::milliseconds(ttl_ms as i64))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let now_iso_str = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);

        let existing: Option<LeaseRow> = conn
            .query_row(
                "SELECT inbox_id, owner, fence, expires_at FROM leases WHERE inbox_id = ?",
                [inbox_id],
                |row| {
                    Ok(LeaseRow {
                        inbox_id: row.get(0)?,
                        owner: row.get(1)?,
                        fence: row.get(2)?,
                        expires_at: row.get(3)?,
                    })
                },
            )
            .ok();

        if existing.is_none() {
            conn.execute(
                "INSERT INTO leases (inbox_id, owner, fence, heartbeat_at, expires_at)
                 VALUES (?, ?, 1, ?, ?)",
                params![inbox_id, owner, now_iso_str, expires],
            )?;
            return Ok(Some(Lease {
                inbox_id: inbox_id.to_string(),
                owner,
                fence: 1,
            }));
        }

        let existing = existing.unwrap();

        if existing.owner == owner {
            conn.execute(
                "UPDATE leases SET heartbeat_at = ?, expires_at = ?
                 WHERE inbox_id = ? AND owner = ? AND fence = ?",
                params![now_iso_str, expires, inbox_id, owner, existing.fence],
            )?;
            return Ok(Some(Lease {
                inbox_id: inbox_id.to_string(),
                owner,
                fence: existing.fence,
            }));
        }

        let expires_ms = DateTime::parse_from_rfc3339(&existing.expires_at)
            .map(|d| d.timestamp_millis())
            .unwrap_or(0);
        if expires_ms <= now.timestamp_millis() {
            let next_fence = existing.fence + 1;
            let changes = conn.execute(
                "UPDATE leases
                 SET owner = ?, fence = ?, heartbeat_at = ?, expires_at = ?
                 WHERE inbox_id = ? AND fence = ? AND expires_at <= ?",
                params![
                    owner,
                    next_fence,
                    now_iso_str,
                    expires,
                    inbox_id,
                    existing.fence,
                    now_iso_str
                ],
            )?;
            if changes != 1 {
                return Ok(None);
            }
            return Ok(Some(Lease {
                inbox_id: inbox_id.to_string(),
                owner,
                fence: next_fence,
            }));
        }

        Ok(None)
    })
}

pub fn heartbeat_lease(db: &Db, lease: &Lease, ttl_ms: u64) -> Result<bool> {
    let expires = (Utc::now() + chrono::Duration::milliseconds(ttl_ms as i64))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    crate::db::with_conn(db, |conn| {
        let n = conn.execute(
            "UPDATE leases
             SET heartbeat_at = ?, expires_at = ?
             WHERE inbox_id = ? AND owner = ? AND fence = ?",
            params![now_iso(), expires, lease.inbox_id, lease.owner, lease.fence],
        )?;
        Ok(n == 1)
    })
}

pub fn release_lease(db: &Db, lease: &Lease) -> Result<()> {
    crate::db::with_conn(db, |conn| {
        conn.execute(
            "DELETE FROM leases WHERE inbox_id = ? AND owner = ? AND fence = ?",
            params![lease.inbox_id, lease.owner, lease.fence],
        )?;
        Ok(())
    })
}

pub fn assert_fence(db: &Db, lease: &Lease) -> Result<()> {
    crate::db::with_conn(db, |conn| {
        let row: Option<(String, i32)> = conn
            .query_row(
                "SELECT owner, fence FROM leases WHERE inbox_id = ?",
                [&lease.inbox_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok();
        match row {
            Some((owner, fence)) if owner == lease.owner && fence == lease.fence => Ok(()),
            _ => Err(anyhow::anyhow!(
                "stale lease fence for inbox {}",
                lease.inbox_id
            )),
        }
    })
}
