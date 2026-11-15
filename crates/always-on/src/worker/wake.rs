use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::Notify;
use tokio::time::{Duration, sleep};

/// In-process wake channel: ingress signals the worker to skip idle sleep.
#[derive(Debug, Default)]
pub struct WakeBus {
    notify: Notify,
}

impl WakeBus {
    pub fn new() -> Self {
        Self {
            notify: Notify::new(),
        }
    }

    pub fn signal(&self) {
        self.notify.notify_waiters();
    }

    pub async fn wait(&self, timeout_ms: u64, shutdown: Option<&Arc<AtomicBool>>) {
        if shutdown.map(|s| s.load(Ordering::Relaxed)).unwrap_or(false) {
            return;
        }

        if shutdown.map(|s| s.load(Ordering::Relaxed)).unwrap_or(false) {
            return;
        }
        let remaining = Duration::from_millis(timeout_ms);
        if remaining.is_zero() {
            return;
        }

        tokio::select! {
            _ = self.notify.notified() => {}
            _ = sleep(remaining) => {}
        }
    }
}
