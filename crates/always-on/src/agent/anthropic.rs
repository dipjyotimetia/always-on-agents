use super::types::{
    AgentMessage, Brain, BrainInput, BrainOutput, TokenUsage, tool_call_from_model,
};
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;
use uuid::Uuid;

pub struct AnthropicBrainOptions {
    pub api_key: String,
    pub model: String,
    pub base_url: Option<String>,
    pub client: Option<reqwest::Client>,
    pub on_usage: Option<Arc<dyn Fn(TokenUsage) + Send + Sync>>,
}

pub fn create_anthropic_brain(opts: AnthropicBrainOptions) -> Arc<dyn Brain> {
    let base_url = opts
        .base_url
        .unwrap_or_else(|| "https://api.anthropic.com".into())
        .trim_end_matches('/')
        .to_string();
    Arc::new(AnthropicBrain {
        api_key: opts.api_key,
        model: opts.model,
        base_url,
        client: opts.client.unwrap_or_default(),
        on_usage: opts.on_usage,
    })
}

struct AnthropicBrain {
    api_key: String,
    model: String,
    base_url: String,
    client: reqwest::Client,
    on_usage: Option<Arc<dyn Fn(TokenUsage) + Send + Sync>>,
}

#[derive(Debug, Deserialize)]
struct AnthropicResponse {
    content: Option<Vec<AnthropicContentBlock>>,
    #[serde(default)]
    usage: Option<AnthropicUsage>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum AnthropicContentBlock {
    Text {
        text: String,
    },
    ToolUse {
        id: Option<String>,
        name: String,
        input: Option<Value>,
    },
}

#[derive(Debug, Deserialize)]
struct AnthropicUsage {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
}

#[async_trait]
impl Brain for AnthropicBrain {
    async fn complete(&self, input: BrainInput) -> anyhow::Result<BrainOutput> {
        let system: String = input
            .messages
            .iter()
            .filter_map(|m| match m {
                AgentMessage::System { content } => Some(content.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n\n");

        let messages = to_anthropic_messages(&input.messages);
        let tools: Vec<Value> = input
            .tools
            .iter()
            .map(|t| {
                json!({
                    "name": t.name.as_str(),
                    "description": t.description,
                    "input_schema": {
                        "type": "object",
                        "properties": {},
                        "additionalProperties": true,
                    },
                })
            })
            .collect();

        let mut body = json!({
            "model": self.model,
            "max_tokens": 4096,
            "messages": messages,
            "tools": tools,
        });
        if !system.is_empty() {
            body["system"] = json!(system);
        }

        let res = self
            .client
            .post(format!("{}/v1/messages", self.base_url))
            .header("content-type", "application/json")
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&body)
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("Anthropic request failed: {e}"))?;

        let status = res.status();
        if !status.is_success() {
            let err_text = res.text().await.unwrap_or_default();
            let snippet: String = err_text.chars().take(500).collect();
            anyhow::bail!("Anthropic API {status}: {snippet}");
        }

        let data: AnthropicResponse = res
            .json()
            .await
            .map_err(|e| anyhow::anyhow!("Anthropic response parse failed: {e}"))?;

        let usage = data.usage.as_ref().map(|u| {
            let usage = TokenUsage {
                input_tokens: u.input_tokens.unwrap_or(0) as u32,
                output_tokens: u.output_tokens.unwrap_or(0) as u32,
            };
            if let Some(ref hook) = self.on_usage {
                hook(usage);
            }
            usage
        });

        let mut tool_calls = Vec::new();
        let mut texts = Vec::new();
        for block in data.content.unwrap_or_default() {
            match block {
                AnthropicContentBlock::Text { text } => texts.push(text),
                AnthropicContentBlock::ToolUse { id, name, input } => {
                    tool_calls.push(tool_call_from_model(
                        id.unwrap_or_else(|| Uuid::new_v4().to_string()),
                        &name,
                        input.unwrap_or(json!({})),
                    ));
                }
            }
        }

        if !tool_calls.is_empty() {
            let content = if texts.is_empty() {
                None
            } else {
                Some(texts.join("\n"))
            };
            return Ok(BrainOutput::ToolCalls {
                content,
                tool_calls,
                usage,
            });
        }

        Ok(BrainOutput::Message {
            content: texts.join("\n"),
            usage,
        })
    }
}

fn to_anthropic_messages(messages: &[AgentMessage]) -> Vec<Value> {
    let mut out = Vec::new();
    for m in messages {
        match m {
            AgentMessage::System { .. } => {}
            AgentMessage::User { content } => {
                out.push(json!({ "role": "user", "content": content }));
            }
            AgentMessage::Assistant {
                content,
                tool_calls,
            } => {
                let mut blocks = Vec::new();
                if !content.is_empty() {
                    blocks.push(json!({ "type": "text", "text": content }));
                }
                if let Some(calls) = tool_calls {
                    for tc in calls {
                        blocks.push(json!({
                            "type": "tool_use",
                            "id": tc.id,
                            "name": tc.name.as_str(),
                            "input": tc.arguments,
                        }));
                    }
                }
                if blocks.is_empty() {
                    blocks.push(json!({ "type": "text", "text": "" }));
                }
                out.push(json!({ "role": "assistant", "content": blocks }));
            }
            AgentMessage::Tool {
                tool_call_id,
                content,
            } => {
                out.push(json!({
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": tool_call_id,
                        "content": content,
                    }],
                }));
            }
        }
    }
    out
}
