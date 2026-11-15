use crate::config::Config;

/// Human-only kill switch. Agent tools must never create/clear this file.
pub fn is_stopped(config: &Config) -> bool {
    config.stop_path.exists()
}
