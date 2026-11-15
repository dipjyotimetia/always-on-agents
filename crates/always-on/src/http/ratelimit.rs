use crate::db::{Db, OptionalExt, with_conn};

#[derive(Debug, Clone, Copy)]
pub struct RateLimitResult {
    pub allowed: bool,
    pub remaining: u32,
}

/// Fixed-window rate limiter stored in SQLite.
pub fn check_rate_limit(db: &Db, bucket: &str, limit_per_minute: u32) -> RateLimitResult {
    let window = chrono::Utc::now().timestamp_millis() / 60_000;
    let limit = limit_per_minute as i64;

    with_conn(db, |conn| {
        let row: Option<(i64, i64)> = conn
            .query_row(
                "SELECT window_start, count FROM rate_limits WHERE bucket = ?",
                [bucket],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;

        if row.map(|(ws, _)| ws) != Some(window) {
            conn.execute(
                "INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 1)
                 ON CONFLICT(bucket) DO UPDATE SET window_start = excluded.window_start, count = 1",
                rusqlite::params![bucket, window],
            )?;
            return Ok(RateLimitResult {
                allowed: true,
                remaining: limit_per_minute.saturating_sub(1),
            });
        }

        let count = row.map(|(_, c)| c).unwrap_or(0);
        if count >= limit {
            return Ok(RateLimitResult {
                allowed: false,
                remaining: 0,
            });
        }

        conn.execute(
            "UPDATE rate_limits SET count = count + 1 WHERE bucket = ? AND window_start = ?",
            rusqlite::params![bucket, window],
        )?;
        Ok(RateLimitResult {
            allowed: true,
            remaining: limit_per_minute.saturating_sub((count + 1) as u32),
        })
    })
    .unwrap_or(RateLimitResult {
        allowed: false,
        remaining: 0,
    })
}
