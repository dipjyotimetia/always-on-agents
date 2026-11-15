use anyhow::Result;
use serde_json::Value;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::config::Config;
use crate::db::Db;
use crate::stop::is_stopped;

use super::store::{
    claim_pending_outbox, mark_outbox_failed, mark_outbox_sent, mark_outbox_suppressed,
    reclaim_stale_sending,
};

#[derive(Debug, Clone)]
pub struct DeliverPayload {
    pub id: i64,
    pub channel: String,
    pub body: String,
    pub meta: HashMap<String, Value>,
}

pub type DeliverFn = Arc<
    dyn Fn(DeliverPayload) -> Pin<Box<dyn Future<Output = Result<()>> + Send>> + Send + Sync,
>;

fn default_deliver() -> DeliverFn {
    Arc::new(|msg| {
        Box::pin(async move {
            println!(
                "{}",
                serde_json::json!({
                    "type": "outbox.delivery",
                    "id": msg.id,
                    "channel": msg.channel,
                    "body": msg.body,
                    "meta": msg.meta,
                })
            );
            Ok(())
        })
    })
}

pub struct DispatcherOptions {
    pub db: Db,
    pub config: Arc<Config>,
    pub deliver: Option<DeliverFn>,
    pub once: bool,
    pub shutdown: Option<Arc<AtomicBool>>,
}

pub async fn run_dispatcher(opts: DispatcherOptions) -> Result<u32> {
    let deliver = opts.deliver.unwrap_or_else(default_deliver);
    let mut sent = 0u32;

    async fn tick(
        db: &Db,
        config: &Config,
        deliver: &DeliverFn,
    ) -> Result<u32> {
        if is_stopped(config) {
            return Ok(0);
        }
        reclaim_stale_sending(db, 60_000)?;
        let pending = claim_pending_outbox(db, 20)?;
        let mut n = 0u32;
        for row in pending {
            let meta: HashMap<String, Value> = serde_json::from_str(&row.meta).unwrap_or_default();
            if row.body.trim().is_empty() {
                mark_outbox_suppressed(db, row.id, "empty body")?;
                continue;
            }
            let payload = DeliverPayload {
                id: row.id,
                channel: row.channel.clone(),
                body: row.body.clone(),
                meta,
            };
            match deliver(payload).await {
                Ok(()) => {
                    mark_outbox_sent(db, row.id)?;
                    n += 1;
                }
                Err(err) => {
                    mark_outbox_failed(db, row.id, &err.to_string())?;
                }
            }
        }
        Ok(n)
    }

    if opts.once {
        return tick(&opts.db, &opts.config, &deliver).await;
    }

    while !opts
        .shutdown
        .as_ref()
        .map(|s| s.load(Ordering::Relaxed))
        .unwrap_or(false)
    {
        sent += tick(&opts.db, &opts.config, &deliver).await?;
        tokio::time::sleep(tokio::time::Duration::from_millis(
            opts.config.dispatcher_interval_ms,
        ))
        .await;
    }
    Ok(sent)
}