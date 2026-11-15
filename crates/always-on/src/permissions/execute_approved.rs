use anyhow::{Result, bail};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

use crate::config::Config;
use crate::db::Db;
use crate::outbox::store::{EnqueueOutboxOpts, enqueue_outbox};

use super::defer::{get_deferred_call, mark_deferred_executed, mark_deferred_failed};
use super::proxy::{CredentialStore, ProxiedFetchOptions, proxied_fetch};

/// Execute an approved deferred call using the *stored* arguments only.
/// Never regenerates args from the model.
pub async fn execute_approved_call(
    db: &Db,
    _config: &Config,
    credentials: &CredentialStore,
    deferred_id: &str,
) -> Result<ExecuteApprovedResult> {
    let row = get_deferred_call(db, deferred_id)?;
    let Some(row) = row else {
        bail!("unknown deferred call: {deferred_id}");
    };
    if row.status != "approved" {
        bail!(
            "deferred call {deferred_id} is {}, not approved",
            row.status
        );
    }
    if chrono::DateTime::parse_from_rfc3339(&row.expires_at)
        .map(|d| d.timestamp_millis() <= chrono::Utc::now().timestamp_millis())
        .unwrap_or(true)
    {
        mark_deferred_failed(db, &row.id, "expired before execution")?;
        bail!("deferred call {deferred_id} expired");
    }

    let args: HashMap<String, Value> =
        serde_json::from_str(&row.arguments_json).unwrap_or_default();
    let idem_input = format!("{}:{}:{}", row.id, row.tool_name, row.arguments_json);
    let idem_hash = hex::encode(Sha256::digest(idem_input.as_bytes()));
    let idem_key = idem_hash[..24.min(idem_hash.len())].to_string();

    let exec_result = async {
        let result: Value = match row.tool_name.as_str() {
            "send_external" => {
                let to = arg_string(&args, "to");
                let subject = arg_string(&args, "subject");
                let body = args
                    .get("body")
                    .or_else(|| args.get("text"))
                    .and_then(|v| v.as_str())
                    .unwrap_or(&subject)
                    .to_string();
                enqueue_outbox(
                    db,
                    EnqueueOutboxOpts {
                        inbox_id: Some(&row.inbox_id),
                        channel: Some("external"),
                        body: &format!("To: {to}\nSubject: {subject}\n\n{body}"),
                        meta: Some(HashMap::from([
                            ("deferredId".to_string(), json!(row.id)),
                            ("to".to_string(), json!(to)),
                            ("subject".to_string(), json!(subject)),
                            (
                                "credentialLabel".to_string(),
                                json!(
                                    credentials
                                        .has("external_mail")
                                        .then(|| credentials.label("external_mail"))
                                ),
                            ),
                        ])),
                        idempotency_key: Some(&format!("exec:{idem_key}")),
                    },
                )?;
                json!({
                    "delivered": "outbox",
                    "to": to,
                    "subject": subject,
                    "idempotencyKey": idem_key,
                })
            }
            "proxied_request" => {
                let credential = arg_string(&args, "credential");
                let credential = if credential.is_empty() {
                    "api".to_string()
                } else {
                    credential
                };
                let url = arg_string(&args, "url");
                if !url.starts_with("https://") {
                    bail!("proxied_request only allows https URLs");
                }
                let headers: HashMap<String, String> = args
                    .get("headers")
                    .and_then(|v| serde_json::from_value(v.clone()).ok())
                    .unwrap_or_default();
                let method = args.get("method").and_then(|v| v.as_str());
                let body = args.get("body").and_then(|v| v.as_str());
                let response = proxied_fetch(
                    credentials,
                    ProxiedFetchOptions {
                        credential: &credential,
                        url: &url,
                        method,
                        headers,
                        body,
                    },
                )
                .await?;
                json!({ "status": response.status, "body": response.body })
            }
            _ => {
                enqueue_outbox(
                    db,
                    EnqueueOutboxOpts {
                        inbox_id: Some(&row.inbox_id),
                        channel: Some("log"),
                        body: &format!(
                            "Executed approved action {} with stored args.",
                            row.tool_name
                        ),
                        meta: Some(HashMap::from([
                            ("deferredId".to_string(), json!(row.id)),
                            ("toolName".to_string(), json!(row.tool_name)),
                            ("args".to_string(), json!(args)),
                        ])),
                        idempotency_key: Some(&format!("exec:{idem_key}")),
                    },
                )?;
                json!({ "executed": row.tool_name, "args": args })
            }
        };
        mark_deferred_executed(db, &row.id, &result)?;
        Ok(ExecuteApprovedResult { ok: true, result })
    }
    .await;

    match exec_result {
        Ok(r) => Ok(r),
        Err(err) => {
            let message = err.to_string();
            // Keep status `approved` so a later retry can execute the stored args.
            // Expired calls are already marked failed before this arm.
            Ok(ExecuteApprovedResult {
                ok: false,
                result: json!({ "error": message }),
            })
        }
    }
}

fn arg_string(args: &HashMap<String, Value>, key: &str) -> String {
    args.get(key)
        .map(|v| match v {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        })
        .unwrap_or_default()
}

#[derive(Debug)]
pub struct ExecuteApprovedResult {
    pub ok: bool,
    pub result: Value,
}
