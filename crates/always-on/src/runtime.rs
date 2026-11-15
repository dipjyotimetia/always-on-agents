use anyhow::Result;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::agent::{Brain, CreateBrainOptions, create_brain};
use crate::config::{Config, ConfigOverrides, load_config};
use crate::db::{Db, open_db};
use crate::http::{HandlerDeps, serve_ingress};
use crate::memory::ensure_memory_layout;
use crate::outbox::dispatcher::{DispatcherOptions, run_dispatcher};
use crate::permissions::defer::expire_deferred_calls;
use crate::permissions::proxy::CredentialStore;
use crate::timers::scheduler::{SchedulerOptions, run_scheduler};
use crate::worker::wake::WakeBus;
use crate::worker::worker::{WorkerOptions, run_worker};

pub struct Runtime {
    pub config: Config,
    pub db: Db,
    pub brain: Arc<dyn Brain>,
    pub credentials: CredentialStore,
    pub wake: Arc<WakeBus>,
}

pub struct CreateRuntimeOptions {
    pub config: ConfigOverrides,
    pub brain: Option<Arc<dyn Brain>>,
    pub credentials: Option<CredentialStore>,
}

impl Runtime {
    pub async fn run_once(&self) -> Result<()> {
        expire_deferred_calls(&self.db)?;
        run_scheduler(SchedulerOptions {
            db: self.db.clone(),
            config: Arc::new(self.config.clone()),
            once: true,
            shutdown: None,
            on_fire: None,
        })
        .await?;
        run_worker(WorkerOptions {
            db: self.db.clone(),
            config: Arc::new(self.config.clone()),
            brain: self.brain.clone(),
            credentials: self.credentials.clone(),
            inbox_id: None,
            once: true,
            shutdown: None,
            wake: Some(self.wake.clone()),
        })
        .await?;
        run_dispatcher(DispatcherOptions {
            db: self.db.clone(),
            config: Arc::new(self.config.clone()),
            deliver: None,
            once: true,
            shutdown: None,
        })
        .await?;
        Ok(())
    }

    pub async fn start_all(&self, shutdown: Arc<AtomicBool>) -> Result<()> {
        let config = Arc::new(self.config.clone());
        let brain_label = resolved_brain_label(&self.config);

        let http_shutdown = shutdown.clone();
        let http_db = self.db.clone();
        let http_config = config.clone();
        let wake = self.wake.clone();
        let http_handle = tokio::spawn(async move {
            if let Err(err) = serve_ingress(
                HandlerDeps {
                    db: http_db,
                    config: http_config.clone(),
                    on_event: Some(Arc::new(move || wake.signal())),
                },
                http_shutdown,
            )
            .await
            {
                eprintln!("http ingress error: {err}");
            }
        });

        println!(
            "{}",
            serde_json::json!({
                "type": "runtime.listening",
                "host": config.host,
                "port": config.port,
                "brain": brain_label,
            })
        );

        let sweeper_db = self.db.clone();
        let sweeper_shutdown = shutdown.clone();
        let sweep_ms = config.scheduler_interval_ms.max(5_000);
        let sweeper = tokio::spawn(async move {
            while !sweeper_shutdown.load(Ordering::Relaxed) {
                let _ = expire_deferred_calls(&sweeper_db);
                tokio::time::sleep(tokio::time::Duration::from_millis(sweep_ms)).await;
            }
        });

        let worker_opts = WorkerOptions {
            db: self.db.clone(),
            config: config.clone(),
            brain: self.brain.clone(),
            credentials: self.credentials.clone(),
            inbox_id: None,
            once: false,
            shutdown: Some(shutdown.clone()),
            wake: Some(self.wake.clone()),
        };
        let scheduler_opts = SchedulerOptions {
            db: self.db.clone(),
            config: config.clone(),
            once: false,
            shutdown: Some(shutdown.clone()),
            on_fire: Some(Arc::new({
                let wake = self.wake.clone();
                move |_n| wake.signal()
            })),
        };
        let dispatcher_opts = DispatcherOptions {
            db: self.db.clone(),
            config: config.clone(),
            deliver: None,
            once: false,
            shutdown: Some(shutdown.clone()),
        };

        tokio::try_join!(
            async { run_worker(worker_opts).await.map(|_| ()) },
            async { run_scheduler(scheduler_opts).await.map(|_| ()) },
            async { run_dispatcher(dispatcher_opts).await.map(|_| ()) },
        )?;

        sweeper.abort();
        http_handle.abort();
        Ok(())
    }
}

fn resolved_brain_label(config: &Config) -> &'static str {
    let p = config.brain_provider.trim().to_lowercase();
    match p.as_str() {
        "mock" => "mock",
        "anthropic" => "anthropic",
        "openai" | "openai_compat" => "openai",
        "gemini" => "gemini",
        _ => {
            if config
                .anthropic_api_key
                .as_ref()
                .is_some_and(|k| !k.is_empty())
            {
                "anthropic"
            } else if config
                .openai_api_key
                .as_ref()
                .is_some_and(|k| !k.is_empty())
            {
                "openai"
            } else if config
                .gemini_api_key
                .as_ref()
                .is_some_and(|k| !k.is_empty())
            {
                "gemini"
            } else {
                "mock"
            }
        }
    }
}

pub fn create_runtime(opts: CreateRuntimeOptions) -> Result<Runtime> {
    let config = load_config(opts.config)?;
    ensure_memory_layout(&config.memory_dir)?;
    let db = open_db(
        config
            .db_path
            .to_str()
            .expect("db_path must be valid UTF-8"),
    )?;
    let credentials = opts.credentials.unwrap_or_default();
    let wake = Arc::new(WakeBus::new());

    let config_arc = Arc::new(config.clone());
    // Daily tokens are recorded once from the run total in the worker.
    // Provider `on_usage` hooks must not also call `add_tokens_today`.
    let brain = opts.brain.unwrap_or_else(|| {
        create_brain(CreateBrainOptions {
            config: config_arc.clone(),
            on_usage: None,
        })
    });

    Ok(Runtime {
        config,
        db,
        brain,
        credentials,
        wake,
    })
}
