use super::types::{
    AgentMessage, Brain, BrainInput, BrainOutput, TokenUsage, ToolCall, ToolName,
};
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use uuid::Uuid;

pub struct OpenAiBrainOptions {
    pub api_key: String,
    pub model: String,
    pub base_url: Option<String>,
    pub client: Option<reqwest::Client>,
    pub on_usage: Option<Arc<dyn Fn(TokenUsage) + Send + Sync>>,
}

pub fn create_openai_brain(opts: OpenAiBrainOptions) -> Arc<dyn Brain> {
    let base_url = opts
        .base_url
        .unwrap_or_else(|| "https://api.openai.com".into())
        .trim_end_matches('/')
        .to_string();
    Arc::new(OpenAiBrain {
        api_key: opts.api_key,
        model: opts.model,
        base_url,
        client: opts.client.unwrap_or_else(reqwest::Client::new),
        on_usage: opts.on_usage,
    })
}

struct OpenAiBrain {
    api_key: String,
    model: String,
    base_url: String,
    client: reqwest::Client,
    on_usage: Option<Arc<dyn Fn(TokenUsage) + Send + Sync>>,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionResponse {
    choices: Option<Vec<ChatChoice>>,
    usage: Option<OpenAiUsage>,
}

#[derive(Debug, Deserialize)]
struct ChatChoice {
    message: Option<ChatMessage>,
}

#[derive(Debug, Deserialize)]
struct ChatMessage {
    content: Option<String>,
    tool_calls: Option<Vec<OpenAiToolCall>>,
}

#[derive(Debug, Deserialize)]
struct OpenAiToolCall {
    id: Option<String>,
    function: Option<OpenAiFunction>,
}

#[derive(Debug, Deserialize)]
struct OpenAiFunction {
    name: Option<String>,
    arguments: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpenAiUsage {
    prompt_tokens: Option<u64>,
    completion_tokens: Option<u64>,
}

#[async_trait]
impl Brain for OpenAiBrain {
    async fn complete(&self, input: BrainInput) -> anyhow::Result<BrainOutput> {
        let messages = to_openai_messages(&input.messages);
        let tools: Vec<Value> = input
            .tools
            .iter()
            .map(|t| {
                json!({
                    "type": "function",
                    "function": {
                        "name": t.name.as_str(),
                        "description": t.description,
                        "parameters": {
                            "type": "object",
                            "properties": {},
                            "additionalProperties": true,
                        },
                    },
                })
            })
            .collect();

        let body = json!({
            "model": self.model,
            "messages": messages,
            "tools": tools,
        });

        let url = if self.base_url.ends_with("/v1") {
            format!("{}/chat/completions", self.base_url)
        } else {
            format!("{}/v1/chat/completions", self.base_url)
        };

        let res = self
            .client
            .post(url)
            .header("content-type", "application/json")
            .bearer_auth(&self.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("OpenAI request failed: {e}"))?;

        let status = res.status();
        if !status.is_success() {
            let err_text = res.text().await.unwrap_or_default();
            let snippet: String = err_text.chars().take(500).collect();
            anyhow::bail!("OpenAI API {status}: {snippet}");
        }

        let data: ChatCompletionResponse = res
            .json()
            .await
            .map_err(|e| anyhow::anyhow!("OpenAI response parse failed: {e}"))?;

        let usage = data.usage.as_ref().map(|u| {
            let usage = TokenUsage {
                input_tokens: u.prompt_tokens.unwrap_or(0) as u32,
                output_tokens: u.completion_tokens.unwrap_or(0) as u32,
            };
            if let Some(ref hook) = self.on_usage {
                hook(usage);
            }
            usage
        });

        let message = data
            .choices
            .as_ref()
            .and_then(|c| c.first())
            .and_then(|c| c.message.as_ref());

        let tool_calls = message
            .and_then(|m| m.tool_calls.as_ref())
            .map(|calls| {
                calls
                    .iter()
                    .filter_map(|c| {
                        let name = c.function.as_ref()?.name.as_deref()?;
                        let args_raw = c
                            .function
                            .as_ref()?
                            .arguments
                            .as_deref()
                            .unwrap_or("{}");
                        let arguments: Value =
                            serde_json::from_str(args_raw).unwrap_or(json!({}));
                        Some(ToolCall {
                            id: c
                                .id
                                .clone()
                                .unwrap_or_else(|| Uuid::new_v4().to_string()),
                            name: parse_tool_name(name),
                            arguments,
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        if !tool_calls.is_empty() {
            return Ok(BrainOutput::ToolCalls {
                content: message.and_then(|m| m.content.clone()),
                tool_calls,
                usage,
            });
        }

        Ok(BrainOutput::Message {
            content: message
                .and_then(|m| m.content.clone())
                .unwrap_or_default(),
            usage,
        })
    }
}

fn parse_tool_name(name: &str) -> ToolName {
    match name {
        "read_memory" => ToolName::ReadMemory,
        "write_memory" => ToolName::WriteMemory,
        "set_followup" => ToolName::SetFollowup,
        "notify_user" => ToolName::NotifyUser,
        "request_approval" => ToolName::RequestApproval,
        "record_silence" => ToolName::RecordSilence,
        "mark_progress_complete" => ToolName::MarkProgressComplete,
        "proxied_request" => ToolName::ProxiedRequest,
        _ => ToolName::RecordSilence,
    }
}

fn to_openai_messages(messages: &[AgentMessage]) -> Vec<Value> {
    let mut out = Vec::new();
    for m in messages {
        match m {
            AgentMessage::System { content } => {
                out.push(json!({ "role": "system", "content": content }));
            }
            AgentMessage::User { content } => {
                out.push(json!({ "role": "user", "content": content }));
            }
            AgentMessage::Assistant {
                content,
                tool_calls,
            } => {
                let mut msg = json!({ "role": "assistant", "content": content });
                if let Some(calls) = tool_calls {
                    let mapped: Vec<Value> = calls
                        .iter()
                        .map(|tc| {
                            json!({
                                "id": tc.id,
                                "type": "function",
                                "function": {
                                    "name": tc.name.as_str(),
                                    "arguments": tc.arguments.to_string(),
                                },
                            })
                        })
                        .collect();
                    msg["tool_calls"] = json!(mapped);
                }
                out.push(msg);
            }
            AgentMessage::Tool {
                tool_call_id,
                content,
            } => {
                out.push(json!({
                    "role": "tool",
                    "tool_call_id": tool_call_id,
                    "content": content,
                }));
            }
        }
    }
    out
}