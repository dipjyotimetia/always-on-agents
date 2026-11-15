use always_on::config::ConfigOverrides;
use always_on::evals::{list_silences, silence_stats};
use always_on::inbox::store::{InsertEventInput, insert_event};
use always_on::ops::get_backlog_metrics;
use always_on::runtime::{CreateRuntimeOptions, create_runtime};
use always_on::timers::store::{
    CreateFollowupOpts, CreateScheduleOpts, create_followup, create_schedule,
};
use anyhow::Result;
use chrono::{Duration, Utc};
use clap::{Parser, Subcommand};
use serde_json::{Value, json};
use std::fs;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Parser)]
#[command(name = "always-on", about = "Always-on agents runtime")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Start HTTP + worker + scheduler + dispatcher
    Serve,
    /// Fire timers, process one worker batch, drain outbox
    Once,
    /// Insert an inbox event (JSON object)
    Ingest {
        /// JSON object for the event body
        json: Option<String>,
    },
    /// Create a follow-up timer after N seconds
    Followup {
        secs: Option<u64>,
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        note: Vec<String>,
    },
    /// Create recurring schedule every N seconds
    Schedule { every: Option<u64> },
    /// Create STOP kill switch
    Stop,
    /// Remove STOP kill switch
    Resume,
    /// Print backlog / STOP / budget metrics
    Metrics,
    /// Export recent silence outcomes for eval labeling
    Silences,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let runtime = create_runtime(CreateRuntimeOptions {
        config: ConfigOverrides::default(),
        brain: None,
        credentials: None,
    })?;

    let shutdown = Arc::new(AtomicBool::new(false));
    let shutdown_flag = shutdown.clone();
    tokio::spawn(async move {
        let _ = tokio::signal::ctrl_c().await;
        shutdown_flag.store(true, Ordering::Relaxed);
    });

    match cli.command {
        Commands::Serve => {
            runtime.start_all(shutdown).await?;
        }
        Commands::Once => {
            runtime.run_once().await?;
        }
        Commands::Ingest { json } => {
            let raw = json.unwrap_or_else(|| "{}".to_string());
            let body: Value = serde_json::from_str(&raw)?;
            let source = body
                .get("source")
                .and_then(|v| v.as_str())
                .unwrap_or("cli")
                .to_string();
            let source_id = body
                .get("sourceId")
                .or_else(|| body.get("source_id"))
                .or_else(|| body.get("id"))
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| format!("cli-{}", Utc::now().timestamp_millis()));
            let session_key = body
                .get("sessionKey")
                .or_else(|| body.get("session_key"))
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let payload = body.get("payload").cloned().unwrap_or(body);
            let result = insert_event(
                &runtime.db,
                InsertEventInput {
                    inbox_id: None,
                    source: &source,
                    source_id: &source_id,
                    session_key,
                    payload,
                    max_attempts: None,
                },
            )?;
            runtime.wake.signal();
            let event = result.event.as_ref().map(|e| {
                json!({
                    "id": e.id,
                    "source": e.source,
                    "source_id": e.source_id,
                    "status": format!("{:?}", e.status),
                })
            });
            println!(
                "{}",
                json!({
                    "inserted": result.inserted,
                    "event": event,
                })
            );
        }
        Commands::Followup { secs, note } => {
            let secs = secs.unwrap_or(60);
            let note = if note.is_empty() {
                "cli follow-up".to_string()
            } else {
                note.join(" ")
            };
            let timer = create_followup(
                &runtime.db,
                CreateFollowupOpts {
                    inbox_id: None,
                    due_at: Utc::now() + Duration::seconds(secs as i64),
                    session_key: None,
                    note: &note,
                    min_followup_seconds: runtime.config.min_followup_seconds,
                    max_active_followups: runtime.config.max_active_followups,
                },
            )?;
            println!(
                "{}",
                serde_json::to_string(&json!({
                    "id": timer.id,
                    "due_at": timer.due_at,
                    "kind": "followup",
                }))?
            );
        }
        Commands::Schedule { every } => {
            let every = every.unwrap_or(3600);
            let timer = create_schedule(
                &runtime.db,
                CreateScheduleOpts {
                    inbox_id: None,
                    due_at: Utc::now() + Duration::seconds(every as i64),
                    every_s: every,
                    session_key: None,
                    payload: json!({ "note": "cli schedule" }),
                },
            )?;
            println!(
                "{}",
                json!({
                    "id": timer.id,
                    "kind": timer.kind.as_str(),
                    "due_at": timer.due_at,
                    "every_s": timer.every_s,
                })
            );
        }
        Commands::Stop => {
            let stamp = Utc::now().to_rfc3339();
            fs::write(&runtime.config.stop_path, format!("stopped at {stamp}\n"))?;
            println!(
                "{}",
                json!({
                    "stop": true,
                    "path": runtime.config.stop_path,
                })
            );
        }
        Commands::Resume => {
            if runtime.config.stop_path.exists() {
                fs::remove_file(&runtime.config.stop_path)?;
            }
            println!("{}", json!({ "stop": false }));
        }
        Commands::Metrics => {
            let metrics = get_backlog_metrics(&runtime.db, &runtime.config, "default")?;
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({
                    "stopped": metrics.stopped,
                    "stopPath": metrics.stop_path,
                    "events": metrics.events,
                    "outboxPending": metrics.outbox_pending,
                    "outboxSending": metrics.outbox_sending,
                    "deferredPending": metrics.deferred_pending,
                    "deferredExpired": metrics.deferred_expired,
                    "activeFollowups": metrics.active_followups,
                    "runsToday": metrics.runs_today,
                    "tokensToday": metrics.tokens_today,
                }))?
            );
        }
        Commands::Silences => {
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({
                    "stats": silence_stats(&runtime.db, "default")?,
                    "recent": list_silences(&runtime.db, 20, None)?,
                }))?
            );
        }
    }

    Ok(())
}
