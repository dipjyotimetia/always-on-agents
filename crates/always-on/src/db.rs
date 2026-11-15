use anyhow::{Context, Result};
use parking_lot::Mutex;
use rusqlite::Connection;
use std::sync::Arc;

pub const SCHEMA: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inbox_id TEXT NOT NULL DEFAULT 'default',
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  session_key TEXT,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','done','failed','dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (inbox_id, source, source_id)
);

CREATE INDEX IF NOT EXISTS idx_events_pending
  ON events (inbox_id, status, COALESCE(next_attempt_at, created_at));

CREATE TABLE IF NOT EXISTS timers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inbox_id TEXT NOT NULL DEFAULT 'default',
  kind TEXT NOT NULL CHECK (kind IN ('followup','schedule')),
  due_at TEXT NOT NULL,
  every_s INTEGER,
  session_key TEXT,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','done','cancelled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_timers_due
  ON timers (status, due_at);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inbox_id TEXT NOT NULL DEFAULT 'default',
  channel TEXT NOT NULL DEFAULT 'log',
  body TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',
  idempotency_key TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','sending','sent','failed','suppressed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_at TEXT,
  UNIQUE (inbox_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending
  ON outbox (status, created_at);

CREATE TABLE IF NOT EXISTS leases (
  inbox_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  fence INTEGER NOT NULL DEFAULT 1,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deferred_calls (
  id TEXT PRIMARY KEY,
  inbox_id TEXT NOT NULL DEFAULT 'default',
  session_key TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','denied','expired','executed','failed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT NOT NULL,
  resolved_at TEXT,
  executed_at TEXT,
  result_json TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  session_key TEXT PRIMARY KEY,
  inbox_id TEXT NOT NULL DEFAULT 'default',
  transcript_json TEXT NOT NULL DEFAULT '[]',
  compact_summary TEXT,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','closed')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS run_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inbox_id TEXT NOT NULL,
  session_key TEXT,
  event_ids TEXT NOT NULL,
  outcome TEXT NOT NULL,
  silence_reason TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS daily_budget (
  day TEXT NOT NULL,
  inbox_id TEXT NOT NULL,
  runs INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, inbox_id)
);

CREATE TABLE IF NOT EXISTS tool_idempotency (
  key TEXT PRIMARY KEY,
  tool_name TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0
);
"#;

pub type Db = Arc<Mutex<Connection>>;

pub fn open_db(db_path: &str) -> Result<Db> {
    let conn = Connection::open(db_path).context("open sqlite database")?;
    conn.execute_batch(SCHEMA)
        .context("apply database schema")?;
    conn.execute(
        "INSERT INTO schema_meta (key, value) VALUES ('version', '2')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [],
    )?;
    Ok(Arc::new(Mutex::new(conn)))
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Run `fn` inside an IMMEDIATE transaction.
pub fn with_transaction<T, F>(db: &Db, f: F) -> Result<T>
where
    F: FnOnce(&Connection) -> Result<T>,
{
    let conn = db.lock();
    conn.execute_batch("BEGIN IMMEDIATE")
        .context("begin immediate transaction")?;
    match f(&conn) {
        Ok(result) => {
            conn.execute_batch("COMMIT").context("commit transaction")?;
            Ok(result)
        }
        Err(err) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(err)
        }
    }
}

/// Execute `f` with the database connection locked (no transaction).
pub fn with_conn<T, F>(db: &Db, f: F) -> Result<T>
where
    F: FnOnce(&Connection) -> Result<T>,
{
    let conn = db.lock();
    f(&conn)
}

/// Map `QueryReturnedNoRows` to `Ok(None)` for single-row lookups.
pub trait OptionalExt<T> {
    fn optional(self) -> rusqlite::Result<Option<T>>;
}

impl<T> OptionalExt<T> for rusqlite::Result<T> {
    fn optional(self) -> rusqlite::Result<Option<T>> {
        match self {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }
}