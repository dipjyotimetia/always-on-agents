//! Always-on agents runtime (Rust port).

pub mod agent;
pub mod budgets;
pub mod config;
pub mod db;
pub mod evals;
pub mod http;
pub mod inbox;
pub mod memory;
pub mod ops;
pub mod outbox;
pub mod permissions;
pub mod runtime;
pub mod stop;
pub mod timers;
pub mod ui;
pub mod worker;

pub use agent::{compact_messages, create_brain, run_agent, Brain, CreateBrainOptions, TokenUsage};
pub use config::{load_config, Config, ConfigOverrides};
pub use db::{now_iso, open_db, with_transaction, Db, SCHEMA};
pub use runtime::{create_runtime, CreateRuntimeOptions, Runtime};
pub use stop::is_stopped;
pub use worker::WakeBus;