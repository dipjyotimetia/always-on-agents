use super::ratelimit::check_rate_limit;
use crate::config::Config;
use crate::db::Db;
use crate::inbox::store::insert_event;
use crate::ops::metrics::get_backlog_metrics;
use crate::permissions::defer::resolve_deferred_call;
use crate::ui::page::render_dashboard_page;
use crate::ui::snapshot::get_dashboard_snapshot;
use axum::{
    Json, Router,
    body::Bytes,
    extract::{ConnectInfo, State},
    http::{HeaderMap, StatusCode},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;
use std::fs;
use std::net::SocketAddr;
use std::sync::Arc;
use subtle::ConstantTimeEq;

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone)]
pub struct HandlerDeps {
    pub db: Db,
    pub config: Arc<Config>,
    pub on_event: Option<Arc<dyn Fn() + Send + Sync>>,
}

pub fn create_router(deps: HandlerDeps) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/", get(ui_page))
        .route("/ui", get(ui_page))
        .route("/api/dashboard", get(api_dashboard))
        .route("/api/control/stop", post(api_control_stop))
        .route("/metrics", get(metrics))
        .route("/events", post(events))
        .route("/events/approval", post(events_approval))
        .fallback(not_found)
        .with_state(Arc::new(deps))
}

async fn not_found() -> impl IntoResponse {
    json_error(StatusCode::NOT_FOUND, "not found")
}

async fn health() -> Json<Value> {
    Json(json!({ "ok": true }))
}

async fn ui_page(State(deps): State<Arc<HandlerDeps>>) -> impl IntoResponse {
    if !deps.config.enable_ui {
        return StatusCode::NOT_FOUND.into_response();
    }
    Html(render_dashboard_page()).into_response()
}

async fn api_dashboard(
    State(deps): State<Arc<HandlerDeps>>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if !deps.config.enable_ui {
        return StatusCode::NOT_FOUND.into_response();
    }
    let secret = headers
        .get("x-approval-secret")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !secrets_equal(secret, &deps.config.approval_secret) {
        return json_error(StatusCode::UNAUTHORIZED, "invalid approval secret");
    }
    match get_dashboard_snapshot(&deps.db, deps.config.as_ref()) {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

async fn api_control_stop(
    State(deps): State<Arc<HandlerDeps>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !deps.config.enable_ui {
        return StatusCode::NOT_FOUND.into_response();
    }
    match control_stop_inner(&deps, &headers, &body).await {
        Ok(payload) => Json(payload).into_response(),
        Err((status, msg)) => json_error(status, &msg),
    }
}

async fn control_stop_inner(
    deps: &HandlerDeps,
    headers: &HeaderMap,
    body: &Bytes,
) -> Result<Value, (StatusCode, String)> {
    if body.len() > deps.config.max_body_bytes {
        return Err((StatusCode::PAYLOAD_TOO_LARGE, "body too large".into()));
    }
    let body_json: Value = if body.is_empty() {
        json!({})
    } else {
        serde_json::from_slice(body)
            .map_err(|e| (StatusCode::BAD_REQUEST, format!("invalid json: {e}")))?
    };
    let header_secret = headers
        .get("x-approval-secret")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let secret = body_json
        .get("secret")
        .and_then(|v| v.as_str())
        .unwrap_or(header_secret);
    if !secrets_equal(secret, &deps.config.approval_secret) {
        return Err((StatusCode::UNAUTHORIZED, "invalid approval secret".into()));
    }
    let stop = !matches!(
        body_json.get("stop").and_then(|v| v.as_str()),
        Some("false")
    ) && body_json.get("stop").and_then(|v| v.as_bool()) != Some(false);
    if stop {
        let stamped = format!("stopped via ui at {}\n", chrono::Utc::now().to_rfc3339());
        fs::write(deps.config.stop_path.as_path(), stamped)
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    } else if deps.config.stop_path.exists() {
        fs::remove_file(deps.config.stop_path.as_path()).ok();
    }
    if let Some(ref hook) = deps.on_event {
        hook();
    }
    Ok(json!({ "ok": true, "stopped": stop }))
}

async fn metrics(State(deps): State<Arc<HandlerDeps>>) -> Response {
    match get_backlog_metrics(&deps.db, deps.config.as_ref(), "default") {
        Ok(metrics) => Json(serde_json::to_value(metrics).unwrap_or(json!({}))).into_response(),
        Err(e) => json_error(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

async fn events(
    State(deps): State<Arc<HandlerDeps>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    match events_inner(&deps, &addr, &headers, &body).await {
        Ok(payload) => Json(payload).into_response(),
        Err((status, msg)) => json_error(status, &msg),
    }
}

async fn events_inner(
    deps: &HandlerDeps,
    addr: &SocketAddr,
    headers: &HeaderMap,
    body: &Bytes,
) -> Result<Value, (StatusCode, String)> {
    if body.len() > deps.config.max_body_bytes {
        return Err((StatusCode::PAYLOAD_TOO_LARGE, "body too large".into()));
    }
    let client = addr.ip().to_string();
    let rl = check_rate_limit(
        &deps.db,
        &format!("events:{client}"),
        deps.config.rate_limit_per_minute,
    );
    if !rl.allowed {
        return Err((StatusCode::TOO_MANY_REQUESTS, "rate limit exceeded".into()));
    }

    if deps.config.require_webhook_secret && deps.config.webhook_secret.is_empty() {
        return Err((
            StatusCode::INTERNAL_SERVER_ERROR,
            "webhook secret not configured".into(),
        ));
    }

    let raw = std::str::from_utf8(body).unwrap_or("");
    if !deps.config.webhook_secret.is_empty() {
        let sig = headers
            .get("x-signature")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if !verify_signature(&deps.config.webhook_secret, raw, sig) {
            return Err((StatusCode::UNAUTHORIZED, "invalid signature".into()));
        }
    }

    let body_json: Value = if raw.is_empty() {
        json!({})
    } else {
        serde_json::from_str(raw)
            .map_err(|e| (StatusCode::BAD_REQUEST, format!("invalid json: {e}")))?
    };

    let source = body_json
        .get("source")
        .and_then(|v| v.as_str())
        .unwrap_or("webhook")
        .to_string();
    let source_id = body_json
        .get("sourceId")
        .or_else(|| body_json.get("id"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if source_id.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "sourceId required".into()));
    }

    let payload = body_json
        .get("payload")
        .cloned()
        .unwrap_or_else(|| body_json.clone());

    let session_key = body_json
        .get("sessionKey")
        .and_then(|v| v.as_str())
        .map(String::from);
    let inbox_id = body_json.get("inboxId").and_then(|v| v.as_str());

    let result = insert_event(
        &deps.db,
        crate::inbox::store::InsertEventInput {
            inbox_id,
            source: &source,
            source_id: &source_id,
            session_key,
            payload,
            max_attempts: Some(deps.config.event_max_attempts as i32),
        },
    )
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if let Some(ref hook) = deps.on_event {
        hook();
    }

    Ok(json!({
        "ok": true,
        "inserted": result.inserted,
        "eventId": result.event.as_ref().map(|e| e.id),
    }))
}

async fn events_approval(
    State(deps): State<Arc<HandlerDeps>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    match events_approval_inner(&deps, &addr, &headers, &body).await {
        Ok(payload) => Json(payload).into_response(),
        Err((status, msg)) => json_error(status, &msg),
    }
}

async fn events_approval_inner(
    deps: &HandlerDeps,
    addr: &SocketAddr,
    headers: &HeaderMap,
    body: &Bytes,
) -> Result<Value, (StatusCode, String)> {
    if body.len() > deps.config.max_body_bytes {
        return Err((StatusCode::PAYLOAD_TOO_LARGE, "body too large".into()));
    }
    let client = addr.ip().to_string();
    let rl = check_rate_limit(
        &deps.db,
        &format!("approval:{client}"),
        deps.config.rate_limit_per_minute,
    );
    if !rl.allowed {
        return Err((StatusCode::TOO_MANY_REQUESTS, "rate limit exceeded".into()));
    }

    let body_json: Value = if body.is_empty() {
        json!({})
    } else {
        serde_json::from_slice(body)
            .map_err(|e| (StatusCode::BAD_REQUEST, format!("invalid json: {e}")))?
    };

    let header_secret = headers
        .get("x-approval-secret")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let secret = body_json
        .get("secret")
        .and_then(|v| v.as_str())
        .unwrap_or(header_secret);
    if !secrets_equal(secret, &deps.config.approval_secret) {
        return Err((StatusCode::UNAUTHORIZED, "invalid approval secret".into()));
    }

    let deferred_id = body_json
        .get("deferredId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if deferred_id.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "deferredId required".into()));
    }

    let decision = match body_json.get("decision").and_then(|v| v.as_str()) {
        Some("denied") => "denied",
        _ => "approved",
    };

    let deferred = resolve_deferred_call(&deps.db, &deferred_id, decision)
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?;

    let source_id = format!("{deferred_id}:{decision}");
    let result = insert_event(
        &deps.db,
        crate::inbox::store::InsertEventInput {
            inbox_id: Some(deferred.inbox_id.as_str()),
            source: "approval",
            source_id: &source_id,
            session_key: Some(deferred.session_key.clone()),
            payload: json!({
                "type": "approval",
                "deferredId": deferred_id,
                "decision": decision,
            }),
            max_attempts: None,
        },
    )
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if let Some(ref hook) = deps.on_event {
        hook();
    }

    Ok(json!({
        "ok": true,
        "inserted": result.inserted,
        "status": deferred.status,
        "eventId": result.event.as_ref().map(|e| e.id),
    }))
}

fn json_error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}

/// HMAC over the raw request body (not re-serialized JSON).
fn verify_signature(secret: &str, raw_body: &str, header: &str) -> bool {
    let provided = header.strip_prefix("sha256=").unwrap_or(header);
    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC can take key of any size");
    mac.update(raw_body.as_bytes());
    let expected = hex::encode(mac.finalize().into_bytes());
    constant_time_eq(expected.as_bytes(), provided.as_bytes())
}

fn secrets_equal(a: &str, b: &str) -> bool {
    constant_time_eq(a.as_bytes(), b.as_bytes())
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.ct_eq(b).into()
}
