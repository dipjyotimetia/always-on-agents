//! HTTP ingress (axum).

pub mod handler;
pub mod ratelimit;

pub use handler::{create_router, HandlerDeps};

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tokio::net::TcpListener;

/// Start the ingress HTTP server until `shutdown` is set.
pub async fn serve_ingress(deps: HandlerDeps, shutdown: Arc<AtomicBool>) -> anyhow::Result<()> {
    let host = deps.config.host.clone();
    let port = deps.config.port;
    let app = create_router(deps);
    let addr = format!("{host}:{port}");
    let listener = TcpListener::bind(&addr).await?;

    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        while !shutdown.load(Ordering::Relaxed) {
            tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
        }
    })
    .await?;
    Ok(())
}

pub fn create_ingress_router(deps: HandlerDeps) -> axum::Router {
    create_router(deps)
}