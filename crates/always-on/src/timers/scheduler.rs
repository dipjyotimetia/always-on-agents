use anyhow::Result;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::config::Config;
use crate::db::Db;
use crate::stop::is_stopped;

use super::store::fire_due_timers;

pub struct SchedulerOptions {
    pub db: Db,
    pub config: Arc<Config>,
    pub once: bool,
    pub shutdown: Option<Arc<AtomicBool>>,
    pub on_fire: Option<Arc<dyn Fn(u32) + Send + Sync>>,
}

pub async fn run_scheduler(opts: SchedulerOptions) -> Result<u32> {
    let mut total = 0u32;

    let tick = || {
        if is_stopped(&opts.config) {
            return Ok(0u32);
        }
        let n = fire_due_timers(&opts.db, chrono::Utc::now())?;
        if n > 0
            && let Some(ref cb) = opts.on_fire
        {
            cb(n);
        }
        Ok(n)
    };

    if opts.once {
        return tick();
    }

    while !opts
        .shutdown
        .as_ref()
        .map(|s| s.load(Ordering::Relaxed))
        .unwrap_or(false)
    {
        total += tick()?;
        tokio::time::sleep(tokio::time::Duration::from_millis(
            opts.config.scheduler_interval_ms,
        ))
        .await;
    }
    Ok(total)
}
