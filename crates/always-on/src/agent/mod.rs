pub mod anthropic;
pub mod factory;
pub mod gemini;
pub mod injection;
pub mod loop_agent;
pub mod mock;
pub mod openai_compat;
pub mod tools;
pub mod types;

pub use factory::{CreateBrainOptions, create_brain};
pub use injection::{screen_for_injection, wrap_untrusted};
pub use loop_agent::{RunAgentOptions, RunResult, compact_messages, run_agent};
pub use mock::create_mock_brain;
pub use types::*;
