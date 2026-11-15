use anyhow::Result;
use chrono::Utc;

use crate::db::{with_conn, Db};

pub fn day_key() -> String {
    Utc::now().format("%Y-%m-%d").to_string()
}

pub fn get_runs_today(db: &Db, inbox_id: &str) -> Result<u32> {
    with_conn(db, |conn| {
        let day = day_key();
        let mut stmt =
            conn.prepare("SELECT runs FROM daily_budget WHERE day = ? AND inbox_id = ?")?;
        let runs: Option<i64> = stmt.query_row([&day, inbox_id], |row| row.get(0)).ok();
        Ok(runs.unwrap_or(0) as u32)
    })
}

pub fn get_tokens_today(db: &Db, inbox_id: &str) -> Result<u32> {
    with_conn(db, |conn| {
        let day = day_key();
        let mut stmt =
            conn.prepare("SELECT tokens FROM daily_budget WHERE day = ? AND inbox_id = ?")?;
        let tokens: Option<i64> = stmt.query_row([&day, inbox_id], |row| row.get(0)).ok();
        Ok(tokens.unwrap_or(0) as u32)
    })
}

pub fn increment_runs_today(db: &Db, inbox_id: &str) -> Result<u32> {
    let day = day_key();
    with_conn(db, |conn| {
        conn.execute(
            "INSERT INTO daily_budget (day, inbox_id, runs, tokens) VALUES (?, ?, 1, 0)
             ON CONFLICT(day, inbox_id) DO UPDATE SET runs = runs + 1",
            rusqlite::params![day, inbox_id],
        )?;
        Ok(())
    })?;
    get_runs_today(db, inbox_id)
}

pub fn add_tokens_today(db: &Db, inbox_id: &str, tokens: u32) -> Result<u32> {
    let day = day_key();
    with_conn(db, |conn| {
        conn.execute(
            "INSERT INTO daily_budget (day, inbox_id, runs, tokens) VALUES (?, ?, 0, ?)
             ON CONFLICT(day, inbox_id) DO UPDATE SET tokens = tokens + excluded.tokens",
            rusqlite::params![day, inbox_id, tokens],
        )?;
        Ok(())
    })?;
    get_tokens_today(db, inbox_id)
}

pub fn under_daily_budget(
    db: &Db,
    inbox_id: &str,
    max_runs_per_day: u32,
    max_tokens_per_day: u32,
) -> Result<bool> {
    Ok(get_runs_today(db, inbox_id)? < max_runs_per_day
        && get_tokens_today(db, inbox_id)? < max_tokens_per_day)
}