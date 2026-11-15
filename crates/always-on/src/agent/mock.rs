use super::types::{AgentMessage, Brain, BrainInput, BrainOutput, ToolCall, ToolName};
use async_trait::async_trait;
use regex::Regex;
use serde_json::{Value, json};
use std::sync::Arc;
use uuid::Uuid;

/// Deterministic brain for tests and offline runs.
pub fn create_mock_brain() -> Arc<dyn Brain> {
    Arc::new(MockBrain)
}

struct MockBrain;

#[async_trait]
impl Brain for MockBrain {
    async fn complete(&self, input: BrainInput) -> anyhow::Result<BrainOutput> {
        let last_user = input
            .messages
            .iter()
            .rev()
            .find_map(|m| match m {
                AgentMessage::User { content } => Some(content.as_str()),
                _ => None,
            })
            .unwrap_or("");

        if Regex::new(r"(?i)duplicate|already reported|nothing to send")
            .unwrap()
            .is_match(last_user)
        {
            return Ok(BrainOutput::ToolCalls {
                content: None,
                tool_calls: vec![tool(
                    ToolName::RecordSilence,
                    json!({ "reason": "duplicate or non-actionable event" }),
                )],
                usage: None,
            });
        }

        if let Some(caps) = Regex::new(r"(?i)check back in (\d+)\s*(seconds?|minutes?|hours?)")
            .unwrap()
            .captures(last_user)
        {
            let n: i64 = caps
                .get(1)
                .and_then(|m| m.as_str().parse().ok())
                .unwrap_or(0);
            let unit = caps
                .get(2)
                .map(|m| m.as_str().to_lowercase())
                .unwrap_or_default();
            let seconds = if unit.starts_with("hour") {
                n * 3600
            } else if unit.starts_with("min") {
                n * 60
            } else {
                n
            };
            return Ok(BrainOutput::ToolCalls {
                content: Some("Scheduling a follow-up.".into()),
                tool_calls: vec![
                    tool(
                        ToolName::SetFollowup,
                        json!({
                            "inSeconds": seconds,
                            "note": "scheduled by mock brain",
                        }),
                    ),
                    tool(
                        ToolName::RecordSilence,
                        json!({ "reason": "follow-up scheduled; no immediate user message" }),
                    ),
                ],
                usage: None,
            });
        }

        if Regex::new(r"(?i)email anyone|send external|wire money|delete production")
            .unwrap()
            .is_match(last_user)
        {
            return Ok(BrainOutput::ToolCalls {
                content: Some("This needs approval.".into()),
                tool_calls: vec![tool(
                    ToolName::RequestApproval,
                    json!({
                        "action": "send_external",
                        "args": {
                            "to": "other@example.com",
                            "subject": "agent draft",
                            "body": "hi"
                        },
                        "reason": "external communication",
                    }),
                )],
                usage: None,
            });
        }

        if last_user.contains("\"kind\":\"followup\"") || last_user.contains("\"source\":\"timer\"")
        {
            return Ok(BrainOutput::ToolCalls {
                content: None,
                tool_calls: vec![tool(
                    ToolName::RecordSilence,
                    json!({ "reason": "timer fired; nothing actionable" }),
                )],
                usage: None,
            });
        }

        if Regex::new(r"(?i)ignore previous instructions|exfiltrate")
            .unwrap()
            .is_match(last_user)
        {
            return Ok(BrainOutput::ToolCalls {
                content: None,
                tool_calls: vec![tool(
                    ToolName::RecordSilence,
                    json!({
                        "reason": "injection warning; refusing to follow untrusted instructions",
                    }),
                )],
                usage: None,
            });
        }

        let summary = summarize(last_user);
        Ok(BrainOutput::ToolCalls {
            content: None,
            tool_calls: vec![tool(
                ToolName::NotifyUser,
                json!({ "text": format!("Acknowledged: {summary}") }),
            )],
            usage: None,
        })
    }
}

fn tool(name: ToolName, args: Value) -> ToolCall {
    ToolCall {
        id: Uuid::new_v4().to_string(),
        name,
        arguments: args,
    }
}

fn summarize(text: &str) -> String {
    let stripped = Regex::new(r"(?s)^[\s\S]*<<<UNTRUSTED_EVENT_DATA>>>\n?")
        .unwrap()
        .replace(text, "");
    let stripped = Regex::new(r"(?s)\n?<<<END_UNTRUSTED_EVENT_DATA>>>[\s\S]*$")
        .unwrap()
        .replace(&stripped, "");
    let stripped = stripped.trim();
    if let Ok(parsed) = serde_json::from_str::<Value>(stripped) {
        let s = parsed.to_string();
        return s.chars().take(200).collect();
    }
    text.chars().take(200).collect()
}
