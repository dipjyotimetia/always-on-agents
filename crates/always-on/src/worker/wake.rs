use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::Notify;
use tokio::time::{sleep, Duration, Instant};

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
        if shutdown
            .map(|s| s.load(Ordering::Relaxed))
            .unwrap_or(false)
        {
            return;
        }

        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            if shutdown
                .map(|s| s.load(Ordering::Relaxed))
                .unwrap_or(false)
            {
                return;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return;
            }

            tokio::select! {
                _ = self.notify.notified() => return,
                _ = sleep(remaining) => return,
            }
        }
    }
}