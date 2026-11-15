use anyhow::{Context, Result};
use serde::Deserialize;
use std::env;
use std::path::{Path, PathBuf};

fn env_int(name: &str, fallback: i64) -> i64 {
    match env::var(name) {
        Ok(raw) if !raw.is_empty() => raw.parse().unwrap_or(fallback),
        _ => fallback,
    }
}

fn env_bool(name: &str, fallback: bool) -> bool {
    match env::var(name) {
        Ok(raw) if !raw.is_empty() => {
            matches!(
                raw.to_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        }
        _ => fallback,
    }
}

fn env_opt_string(name: &str) -> Option<String> {
    env::var(name).ok().filter(|s| !s.is_empty())
}

#[derive(Debug, Clone)]
pub struct Config {
    pub data_dir: PathBuf,
    pub db_path: PathBuf,
    pub memory_dir: PathBuf,
    pub transcripts_dir: PathBuf,
    pub stop_path: PathBuf,
    pub host: String,
    pub port: u16,
    pub webhook_secret: String,
    pub require_webhook_secret: bool,
    pub approval_secret: String,
    pub anthropic_api_key: Option<String>,
    pub anthropic_model: String,
    pub anthropic_base_url: String,
    /// Model-agnostic brain selection (`auto`, `mock`, `anthropic`, `openai`, `gemini`, …).
    pub brain_provider: String,
    pub llm_model: String,
    pub llm_base_url: String,
    pub llm_max_tokens: u32,
    pub openai_api_key: Option<String>,
    pub openai_model: String,
    pub openai_base_url: String,
    pub gemini_api_key: Option<String>,
    pub gemini_model: String,
    pub gemini_base_url: String,
    pub max_turns_per_run: u32,
    pub max_tokens_per_run: u32,
    pub max_wall_ms_per_run: u64,
    pub max_runs_per_day: u32,
    pub max_tokens_per_day: u32,
    pub scheduler_interval_ms: u64,
    pub dispatcher_interval_ms: u64,
    pub worker_idle_ms: u64,
    pub min_followup_seconds: u64,
    pub max_active_followups: u32,
    pub max_body_bytes: usize,
    pub rate_limit_per_minute: u32,
    pub session_max_messages: u32,
    pub session_keep_recent: u32,
    pub event_max_attempts: u32,
    pub lease_ttl_ms: u64,
    pub auto_notify_bare_text: bool,
    /// Serve the lightweight ops dashboard at `/ui` (and `/`).
    pub enable_ui: bool,
}

#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ConfigOverrides {
    pub data_dir: Option<PathBuf>,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub webhook_secret: Option<String>,
    pub require_webhook_secret: Option<bool>,
    pub approval_secret: Option<String>,
    pub anthropic_api_key: Option<String>,
    pub anthropic_model: Option<String>,
    pub anthropic_base_url: Option<String>,
    pub brain_provider: Option<String>,
    pub llm_model: Option<String>,
    pub llm_base_url: Option<String>,
    pub llm_max_tokens: Option<u32>,
    pub openai_api_key: Option<String>,
    pub openai_model: Option<String>,
    pub openai_base_url: Option<String>,
    pub gemini_api_key: Option<String>,
    pub gemini_model: Option<String>,
    pub gemini_base_url: Option<String>,
    pub max_turns_per_run: Option<u32>,
    pub max_tokens_per_run: Option<u32>,
    pub max_wall_ms_per_run: Option<u64>,
    pub max_runs_per_day: Option<u32>,
    pub max_tokens_per_day: Option<u32>,
    pub scheduler_interval_ms: Option<u64>,
    pub dispatcher_interval_ms: Option<u64>,
    pub worker_idle_ms: Option<u64>,
    pub min_followup_seconds: Option<u64>,
    pub max_active_followups: Option<u32>,
    pub max_body_bytes: Option<usize>,
    pub rate_limit_per_minute: Option<u32>,
    pub session_max_messages: Option<u32>,
    pub session_keep_recent: Option<u32>,
    pub event_max_attempts: Option<u32>,
    pub lease_ttl_ms: Option<u64>,
    pub auto_notify_bare_text: Option<bool>,
    pub enable_ui: Option<bool>,
}

pub fn load_config(overrides: ConfigOverrides) -> Result<Config> {
    let data_dir = overrides
        .data_dir
        .or_else(|| env::var("DATA_DIR").ok().map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("./data"));
    let data_dir = std::fs::canonicalize(&data_dir).unwrap_or_else(|_| {
        let resolved = if data_dir.is_absolute() {
            data_dir.clone()
        } else {
            env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(&data_dir)
        };
        resolved
    });

    std::fs::create_dir_all(&data_dir).context("create data_dir")?;
    std::fs::create_dir_all(data_dir.join("memory")).context("create memory dir")?;
    std::fs::create_dir_all(data_dir.join("transcripts")).context("create transcripts dir")?;

    let port = overrides
        .port
        .unwrap_or_else(|| env_int("PORT", 8787) as u16);

    Ok(Config {
        data_dir: data_dir.clone(),
        db_path: data_dir.join("runtime.db"),
        memory_dir: data_dir.join("memory"),
        transcripts_dir: data_dir.join("transcripts"),
        stop_path: data_dir.join("STOP"),
        host: overrides
            .host
            .or_else(|| env::var("HOST").ok())
            .unwrap_or_else(|| "127.0.0.1".to_string()),
        port,
        webhook_secret: overrides
            .webhook_secret
            .or_else(|| env::var("WEBHOOK_SECRET").ok())
            .unwrap_or_default(),
        require_webhook_secret: overrides
            .require_webhook_secret
            .unwrap_or_else(|| env_bool("REQUIRE_WEBHOOK_SECRET", false)),
        approval_secret: overrides
            .approval_secret
            .or_else(|| env::var("APPROVAL_SECRET").ok())
            .unwrap_or_else(|| "dev-approval-secret".to_string()),
        anthropic_api_key: overrides
            .anthropic_api_key
            .or_else(|| env_opt_string("ANTHROPIC_API_KEY")),
        anthropic_model: overrides
            .anthropic_model
            .or_else(|| env::var("ANTHROPIC_MODEL").ok())
            .unwrap_or_else(|| "claude-sonnet-4-5".to_string()),
        anthropic_base_url: overrides
            .anthropic_base_url
            .or_else(|| env::var("ANTHROPIC_BASE_URL").ok())
            .unwrap_or_else(|| "https://api.anthropic.com".to_string()),
        brain_provider: overrides
            .brain_provider
            .or_else(|| env::var("BRAIN_PROVIDER").ok())
            .unwrap_or_else(|| "auto".to_string()),
        llm_model: overrides
            .llm_model
            .or_else(|| env::var("LLM_MODEL").ok())
            .unwrap_or_else(|| "claude-sonnet-4-5".to_string()),
        llm_base_url: overrides
            .llm_base_url
            .or_else(|| env::var("LLM_BASE_URL").ok())
            .unwrap_or_else(|| "https://api.anthropic.com".to_string()),
        llm_max_tokens: overrides
            .llm_max_tokens
            .unwrap_or_else(|| env_int("LLM_MAX_TOKENS", 8_000) as u32),
        openai_api_key: overrides
            .openai_api_key
            .or_else(|| env_opt_string("OPENAI_API_KEY")),
        openai_model: overrides
            .openai_model
            .or_else(|| env::var("OPENAI_MODEL").ok())
            .unwrap_or_else(|| "gpt-4o".to_string()),
        openai_base_url: overrides
            .openai_base_url
            .or_else(|| env::var("OPENAI_BASE_URL").ok())
            .unwrap_or_else(|| "https://api.openai.com/v1".to_string()),
        gemini_api_key: overrides
            .gemini_api_key
            .or_else(|| env_opt_string("GEMINI_API_KEY"))
            .or_else(|| env_opt_string("GOOGLE_API_KEY")),
        gemini_model: overrides
            .gemini_model
            .or_else(|| env::var("GEMINI_MODEL").ok())
            .unwrap_or_else(|| "gemini-2.0-flash".to_string()),
        gemini_base_url: overrides
            .gemini_base_url
            .or_else(|| env::var("GEMINI_BASE_URL").ok())
            .unwrap_or_else(|| "https://generativelanguage.googleapis.com".to_string()),
        max_turns_per_run: overrides
            .max_turns_per_run
            .unwrap_or_else(|| env_int("MAX_TURNS_PER_RUN", 12) as u32),
        max_tokens_per_run: overrides
            .max_tokens_per_run
            .unwrap_or_else(|| env_int("MAX_TOKENS_PER_RUN", 8_000) as u32),
        max_wall_ms_per_run: overrides
            .max_wall_ms_per_run
            .unwrap_or_else(|| env_int("MAX_WALL_MS_PER_RUN", 120_000) as u64),
        max_runs_per_day: overrides
            .max_runs_per_day
            .unwrap_or_else(|| env_int("MAX_RUNS_PER_DAY", 200) as u32),
        max_tokens_per_day: overrides
            .max_tokens_per_day
            .unwrap_or_else(|| env_int("MAX_TOKENS_PER_DAY", 500_000) as u32),
        scheduler_interval_ms: overrides
            .scheduler_interval_ms
            .unwrap_or_else(|| env_int("SCHEDULER_INTERVAL_MS", 5_000) as u64),
        dispatcher_interval_ms: overrides
            .dispatcher_interval_ms
            .unwrap_or_else(|| env_int("DISPATCHER_INTERVAL_MS", 2_000) as u64),
        worker_idle_ms: overrides
            .worker_idle_ms
            .unwrap_or_else(|| env_int("WORKER_IDLE_MS", 1_500) as u64),
        min_followup_seconds: overrides
            .min_followup_seconds
            .unwrap_or_else(|| env_int("MIN_FOLLOWUP_SECONDS", 60) as u64),
        max_active_followups: overrides
            .max_active_followups
            .unwrap_or_else(|| env_int("MAX_ACTIVE_FOLLOWUPS", 20) as u32),
        max_body_bytes: overrides
            .max_body_bytes
            .unwrap_or_else(|| env_int("MAX_BODY_BYTES", 256_000) as usize),
        rate_limit_per_minute: overrides
            .rate_limit_per_minute
            .unwrap_or_else(|| env_int("RATE_LIMIT_PER_MINUTE", 120) as u32),
        session_max_messages: overrides
            .session_max_messages
            .unwrap_or_else(|| env_int("SESSION_MAX_MESSAGES", 40) as u32),
        session_keep_recent: overrides
            .session_keep_recent
            .unwrap_or_else(|| env_int("SESSION_KEEP_RECENT", 12) as u32),
        event_max_attempts: overrides
            .event_max_attempts
            .unwrap_or_else(|| env_int("EVENT_MAX_ATTEMPTS", 3) as u32),
        lease_ttl_ms: overrides
            .lease_ttl_ms
            .unwrap_or_else(|| env_int("LEASE_TTL_MS", 30_000) as u64),
        auto_notify_bare_text: overrides
            .auto_notify_bare_text
            .unwrap_or_else(|| env_bool("AUTO_NOTIFY_BARE_TEXT", false)),
        enable_ui: overrides
            .enable_ui
            .unwrap_or_else(|| env_bool("ENABLE_UI", true)),
    })
}

impl Config {
    pub fn data_dir_str(&self) -> String {
        self.data_dir.to_string_lossy().into_owned()
    }

    pub fn stop_path_str(&self) -> String {
        self.stop_path.to_string_lossy().into_owned()
    }
}

pub fn mkdir_config_dirs(cfg: &Config) -> Result<()> {
    std::fs::create_dir_all(&cfg.data_dir)?;
    std::fs::create_dir_all(&cfg.memory_dir)?;
    std::fs::create_dir_all(&cfg.transcripts_dir)?;
    Ok(())
}

pub fn join_path(base: &Path, rel: &str) -> PathBuf {
    base.join(rel)
}