use anyhow::Result;
use serde_json::Value;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::agent::{run_agent, Brain, RunAgentOptions};
use crate::budgets::{add_tokens_today, increment_runs_today, under_daily_budget};
use crate::config::Config;
use crate::db::Db;
use crate::inbox::store::{
    claim_pending_batch, group_by_session_key, mark_events_done, mark_events_failed,
    reclaim_stale_running, InboxEvent,
};
use crate::permissions::defer::get_deferred_call;
use crate::permissions::proxy::CredentialStore;
use crate::stop::is_stopped;

use super::lease::{acquire_lease, heartbeat_lease, release_lease, Lease};
use super::wake::WakeBus;

pub struct WorkerOptions {
    pub db: Db,
    pub config: Arc<Config>,
    pub brain: Arc<dyn Brain>,
    pub credentials: CredentialStore,
    pub inbox_id: Option<String>,
    pub once: bool,
    pub shutdown: Option<Arc<AtomicBool>>,
    pub wake: Option<Arc<WakeBus>>,
}

pub struct WorkerRunResult {
    pub batches: u32,
}

pub async fn run_worker(opts: WorkerOptions) -> Result<WorkerRunResult> {
    let inbox_id = opts.inbox_id.clone().unwrap_or_else(|| "default".to_string());
    let lease = acquire_lease(
        &opts.db,
        &inbox_id,
        None,
        Some(opts.config.lease_ttl_ms),
    )?;
    let Some(lease) = lease else {
        return Err(anyhow::anyhow!(
            "inbox {} already leased by another worker",
            inbox_id
        ));
    };

    reclaim_stale_running(&opts.db, &inbox_id)?;
    let mut batches = 0u32;

    let result = async {
        if opts.once {
            if process_once(&opts, &lease, &inbox_id).await? {
                batches = 1;
            }
            return Ok(WorkerRunResult { batches });
        }

        while !opts
            .shutdown
            .as_ref()
            .map(|s| s.load(Ordering::Relaxed))
            .unwrap_or(false)
        {
            if is_stopped(&opts.config) {
                idle(&opts).await;
                continue;
            }
            if !heartbeat_lease(&opts.db, &lease, opts.config.lease_ttl_ms)? {
                return Err(anyhow::anyhow!("lost lease fence"));
            }
            if process_once(&opts, &lease, &inbox_id).await? {
                batches += 1;
            } else {
                idle(&opts).await;
            }
        }
        Ok(WorkerRunResult { batches })
    }
    .await;

    release_lease(&opts.db, &lease)?;
    result
}

async fn process_once(opts: &WorkerOptions, lease: &Lease, inbox_id: &str) -> Result<bool> {
    if is_stopped(&opts.config) {
        return Ok(false);
    }
    if !under_daily_budget(
        &opts.db,
        inbox_id,
        opts.config.max_runs_per_day,
        opts.config.max_tokens_per_day,
    )? {
        return Ok(false);
    }

    let pending = claim_pending_batch(&opts.db, inbox_id, 50)?;
    if pending.is_empty() {
        return Ok(false);
    }

    if !heartbeat_lease(&opts.db, lease, opts.config.lease_ttl_ms)? {
        return Err(anyhow::anyhow!("lost lease fence"));
    }

    let groups = group_by_session_key(&pending);

    for (session_key, events) in groups {
        let enriched = enrich_approval_events(&opts.db, &events)?;
        increment_runs_today(&opts.db, inbox_id)?;
        let event_ids: Vec<i64> = events.iter().map(|e| e.id).collect();
        match run_agent(RunAgentOptions {
            db: opts.db.clone(),
            config: opts.config.clone(),
            brain: opts.brain.clone(),
            credentials: opts.credentials.clone(),
            inbox_id: inbox_id.to_string(),
            session_key,
            events: enriched,
            on_usage: None,
        })
        .await
        {
            Ok(result) => {
                add_tokens_today(
                    &opts.db,
                    inbox_id,
                    result.usage.input_tokens + result.usage.output_tokens,
                )?;
                mark_events_done(&opts.db, &event_ids)?;
                heartbeat_lease(&opts.db, lease, opts.config.lease_ttl_ms)?;
                let _ = result;
            }
            Err(err) => {
                let msg = err.to_string();
                mark_events_failed(&opts.db, &event_ids, &msg)?;
            }
        }
    }

    Ok(true)
}

async fn idle(opts: &WorkerOptions) {
    if let Some(ref wake) = opts.wake {
        wake.wait(opts.config.worker_idle_ms, opts.shutdown.as_ref())
            .await;
        return;
    }
    tokio::time::sleep(tokio::time::Duration::from_millis(opts.config.worker_idle_ms)).await;
}

fn enrich_approval_events(db: &Db, events: &[InboxEvent]) -> Result<Vec<InboxEvent>> {
    let mut out = Vec::with_capacity(events.len());
    for event in events {
        if event.source != "approval" {
            out.push(event.clone());
            continue;
        }
        let payload: Value = serde_json::from_str(&event.payload).unwrap_or(Value::Null);
        let deferred_id = payload
            .get("deferredId")
            .or_else(|| payload.get("deferred_id"))
            .and_then(|v| v.as_str());
        let Some(deferred_id) = deferred_id else {
            out.push(event.clone());
            continue;
        };
        let Some(deferred) = get_deferred_call(db, deferred_id)? else {
            out.push(event.clone());
            continue;
        };
        let stored_args: Value =
            serde_json::from_str(&deferred.arguments_json).unwrap_or(Value::Null);
        let mut enriched = serde_json::Map::new();
        if let Value::Object(m) = payload {
            enriched = m;
        }
        enriched.insert("type".to_string(), Value::String("approval".to_string()));
        enriched.insert(
            "storedToolName".to_string(),
            Value::String(deferred.tool_name.clone()),
        );
        enriched.insert("storedArguments".to_string(), stored_args);
        enriched.insert(
            "deferredStatus".to_string(),
            Value::String(deferred.status.clone()),
        );
        out.push(InboxEvent {
            payload: serde_json::Value::Object(enriched).to_string(),
            ..event.clone()
        });
    }
    Ok(out)
}
