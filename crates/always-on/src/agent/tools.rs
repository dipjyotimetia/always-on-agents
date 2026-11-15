use super::types::{ToolCall, ToolDef, ToolName, ToolResult};
use crate::config::Config;
use crate::db::Db;
use crate::memory::store::{
    MemoryProvenance, WriteMemoryOptions, already_reported, append_reported, read_memory_file,
    write_memory_file,
};
use crate::memory::verify::verify_progress_file;
use crate::outbox::store::{EnqueueOutboxOpts, enqueue_outbox};
use crate::permissions::defer::{CreateDeferredCallOpts, classify_risk, create_deferred_call};
use crate::permissions::proxy::CredentialStore;
use crate::timers::store::{CreateFollowupOpts, create_followup};
use chrono::{Duration, Utc};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Arc;

pub struct ToolContext {
    pub db: Db,
    pub config: Arc<Config>,
    pub inbox_id: String,
    pub session_key: String,
    pub credentials: CredentialStore,
}

pub const TOOL_DEFS: &[ToolDef] = &[
    ToolDef {
        name: ToolName::ReadMemory,
        description: "Read a memory file relative to the memory directory.",
    },
    ToolDef {
        name: ToolName::WriteMemory,
        description: "Write a memory file (not instructions.md). Set provenance: user|agent|inferred_untrusted|verified.",
    },
    ToolDef {
        name: ToolName::SetFollowup,
        description: "Schedule a one-shot follow-up that wakes via the inbox.",
    },
    ToolDef {
        name: ToolName::NotifyUser,
        description: "Enqueue a user-visible message through the outbox.",
    },
    ToolDef {
        name: ToolName::RequestApproval,
        description: "Defer a high-risk action until an authenticated approval event arrives. Stored args are executed later — not regenerated.",
    },
    ToolDef {
        name: ToolName::RecordSilence,
        description: "Explicitly choose not to message the user; records a reason.",
    },
    ToolDef {
        name: ToolName::MarkProgressComplete,
        description: "Mark a progress file complete only if the verifier passes (evidence required).",
    },
    ToolDef {
        name: ToolName::ProxiedRequest,
        description: "Request an outbound HTTPS call via credential proxy (always deferred for approval).",
    },
];

pub fn execute_tool(ctx: &ToolContext, call: &ToolCall) -> ToolResult {
    let idempotency_key = call
        .arguments
        .get("idempotencyKey")
        .or_else(|| call.arguments.get("idempotency_key"))
        .and_then(|v| v.as_str())
        .map(String::from);

    if let Some(ref key) = idempotency_key
        && let Ok(cached) = lookup_idempotency(&ctx.db, key)
        && let Ok(result) = serde_json::from_str::<ToolResult>(&cached)
    {
        return result;
    }

    let result = match execute_tool_inner(ctx, call) {
        Ok(r) => r,
        Err(e) => fail(&call.id, &e.to_string()),
    };

    if let Some(ref key) = idempotency_key
        && result.ok
    {
        let _ = store_idempotency(&ctx.db, key, call.name.as_str(), &result);
    }
    result
}

fn lookup_idempotency(db: &Db, key: &str) -> anyhow::Result<String> {
    crate::db::with_conn(db, |conn| {
        conn.query_row(
            "SELECT result_json FROM tool_idempotency WHERE key = ?",
            [key],
            |row| row.get(0),
        )
        .map_err(Into::into)
    })
}

fn store_idempotency(
    db: &Db,
    key: &str,
    tool_name: &str,
    result: &ToolResult,
) -> anyhow::Result<()> {
    let json = serde_json::to_string(result)?;
    crate::db::with_conn(db, |conn| {
        conn.execute(
            "INSERT OR IGNORE INTO tool_idempotency (key, tool_name, result_json) VALUES (?, ?, ?)",
            rusqlite::params![key, tool_name, json],
        )?;
        Ok(())
    })
}

fn execute_tool_inner(ctx: &ToolContext, call: &ToolCall) -> anyhow::Result<ToolResult> {
    match call.name {
        ToolName::ReadMemory => {
            let rel = arg_string(&call.arguments, "path");
            let content = read_memory_file(&ctx.config.memory_dir, &rel)?;
            Ok(ok(&call.id, &content))
        }
        ToolName::WriteMemory => {
            let rel = arg_string(&call.arguments, "path");
            let content = arg_string(&call.arguments, "content");
            let provenance = parse_provenance(&call.arguments);
            let risk = classify_risk(
                "write_memory",
                &value_to_map(&json!({
                    "path": rel,
                    "provenance": provenance.as_str(),
                })),
            );
            if risk == "block" {
                return Ok(fail(&call.id, "blocked by classifier"));
            }
            write_memory_file(
                &ctx.config.memory_dir,
                &rel,
                &content,
                WriteMemoryOptions {
                    allow_instructions: false,
                    provenance: Some(provenance),
                },
            )?;
            Ok(ok(
                &call.id,
                &format!("wrote {rel} (provenance={})", provenance.as_str()),
            ))
        }
        ToolName::SetFollowup => {
            let in_seconds = call
                .arguments
                .get("inSeconds")
                .or_else(|| call.arguments.get("in_seconds"))
                .and_then(value_as_f64)
                .unwrap_or(300.0);
            let note = arg_string(&call.arguments, "note");
            let note = if note.is_empty() {
                "follow-up"
            } else {
                note.as_str()
            };
            let due_at = Utc::now() + Duration::seconds(in_seconds.max(0.0) as i64);
            let timer = create_followup(
                &ctx.db,
                CreateFollowupOpts {
                    inbox_id: Some(ctx.inbox_id.as_str()),
                    due_at,
                    session_key: Some(ctx.session_key.clone()),
                    note,
                    min_followup_seconds: ctx.config.min_followup_seconds,
                    max_active_followups: ctx.config.max_active_followups,
                },
            )?;
            Ok(ok(
                &call.id,
                &format!("follow-up {} due {}", timer.id, timer.due_at),
            ))
        }
        ToolName::NotifyUser => {
            let text = arg_string(&call.arguments, "text").trim().to_string();
            if text.is_empty() {
                return Ok(fail(&call.id, "empty notification"));
            }
            if already_reported(&ctx.config.memory_dir, &text)? {
                return Ok(ok(&call.id, "suppressed: already reported"));
            }
            let mut hasher = Sha256::new();
            hasher.update(text.as_bytes());
            let hash = format!("{:x}", hasher.finalize());
            let hash = hash.chars().take(16).collect::<String>();
            let mut meta = HashMap::new();
            meta.insert("sessionKey".to_string(), json!(ctx.session_key));
            enqueue_outbox(
                &ctx.db,
                EnqueueOutboxOpts {
                    inbox_id: Some(ctx.inbox_id.as_str()),
                    channel: None,
                    body: &text,
                    meta: Some(meta),
                    idempotency_key: Some(&format!("notify:{}:{}", ctx.session_key, hash)),
                },
            )?;
            append_reported(&ctx.config.memory_dir, &text)?;
            Ok(ok(&call.id, "enqueued"))
        }
        ToolName::RequestApproval | ToolName::ProxiedRequest => {
            let (action, args) = if call.name == ToolName::ProxiedRequest {
                ("proxied_request".to_string(), call.arguments.clone())
            } else {
                let action = arg_string(&call.arguments, "action");
                let action = if action.is_empty() {
                    "send_external".to_string()
                } else {
                    action
                };
                let args = call
                    .arguments
                    .get("args")
                    .cloned()
                    .unwrap_or_else(|| call.arguments.clone());
                (action, args)
            };
            let risk = classify_risk(&action, &value_to_map(&args));
            if risk == "block" {
                return Ok(fail(&call.id, "blocked by auto-mode classifier"));
            }
            let deferred = create_deferred_call(
                &ctx.db,
                CreateDeferredCallOpts {
                    inbox_id: Some(ctx.inbox_id.as_str()),
                    session_key: &ctx.session_key,
                    tool_name: &action,
                    args: args.clone(),
                    ttl_ms: None,
                },
            )?;
            let reason = arg_string(&call.arguments, "reason");
            let mut meta = HashMap::new();
            meta.insert("deferredId".to_string(), json!(deferred.id));
            meta.insert("toolName".to_string(), json!(action));
            meta.insert("arguments".to_string(), args);
            enqueue_outbox(
                &ctx.db,
                EnqueueOutboxOpts {
                    inbox_id: Some(ctx.inbox_id.as_str()),
                    channel: Some("approval"),
                    body: &format!(
                        "Approval required for {} ({}): {}",
                        action, deferred.id, reason
                    ),
                    meta: Some(meta),
                    idempotency_key: Some(&format!("approval:{}", deferred.id)),
                },
            )?;
            Ok(ToolResult {
                tool_call_id: call.id.clone(),
                ok: true,
                content: format!("deferred:{}", deferred.id),
                deferred: Some(true),
                deferred_id: Some(deferred.id),
            })
        }
        ToolName::RecordSilence => {
            let reason = arg_string(&call.arguments, "reason");
            let reason = if reason.is_empty() {
                "unspecified".to_string()
            } else {
                reason
            };
            Ok(ok(&call.id, &format!("silence:{reason}")))
        }
        ToolName::Unknown => {
            let raw = arg_string(&call.arguments, "_rejected_name");
            let label = if raw.is_empty() {
                "unknown".to_string()
            } else {
                raw
            };
            Ok(fail(&call.id, &format!("unknown tool: {label}")))
        }
        ToolName::MarkProgressComplete => {
            let rel = arg_string(&call.arguments, "path");
            let verified = verify_progress_file(&ctx.config.memory_dir, &rel)?;
            if !verified.ok {
                return Ok(fail(
                    &call.id,
                    &format!("verifier rejected: {}", verified.reasons.join("; ")),
                ));
            }
            let existing = read_memory_file(&ctx.config.memory_dir, &rel)?;
            let stamped = format!(
                "{}\n\nverified: {}\nstatus: complete\n",
                existing.trim_end(),
                Utc::now().to_rfc3339()
            );
            write_memory_file(
                &ctx.config.memory_dir,
                &rel,
                &stamped,
                WriteMemoryOptions {
                    allow_instructions: false,
                    provenance: Some(MemoryProvenance::Verified),
                },
            )?;
            Ok(ok(&call.id, &format!("verified complete: {rel}")))
        }
    }
}

fn value_to_map(value: &Value) -> HashMap<String, Value> {
    match value {
        Value::Object(map) => map.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        _ => HashMap::new(),
    }
}

fn parse_provenance(args: &Value) -> MemoryProvenance {
    let raw = arg_string(args, "provenance");
    MemoryProvenance::parse(&raw).unwrap_or(MemoryProvenance::Agent)
}

fn arg_string(args: &Value, key: &str) -> String {
    args.get(key)
        .map(|v| match v {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        })
        .unwrap_or_default()
}

fn value_as_f64(v: &Value) -> Option<f64> {
    v.as_f64().or_else(|| v.as_i64().map(|i| i as f64))
}

fn ok(tool_call_id: &str, content: &str) -> ToolResult {
    ToolResult {
        tool_call_id: tool_call_id.to_string(),
        ok: true,
        content: content.to_string(),
        deferred: None,
        deferred_id: None,
    }
}

fn fail(tool_call_id: &str, content: &str) -> ToolResult {
    ToolResult {
        tool_call_id: tool_call_id.to_string(),
        ok: false,
        content: content.to_string(),
        deferred: None,
        deferred_id: None,
    }
}
