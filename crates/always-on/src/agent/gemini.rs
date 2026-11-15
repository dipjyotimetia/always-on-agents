use super::types::{
    AgentMessage, Brain, BrainInput, BrainOutput, TokenUsage, tool_call_from_model,
};
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;
use uuid::Uuid;

pub struct GeminiBrainOptions {
    pub api_key: String,
    pub model: String,
    pub base_url: Option<String>,
    pub client: Option<reqwest::Client>,
    pub on_usage: Option<Arc<dyn Fn(TokenUsage) + Send + Sync>>,
}

pub fn create_gemini_brain(opts: GeminiBrainOptions) -> Arc<dyn Brain> {
    let base_url = opts
        .base_url
        .unwrap_or_else(|| "https://generativelanguage.googleapis.com".into())
        .trim_end_matches('/')
        .to_string();
    Arc::new(GeminiBrain {
        api_key: opts.api_key,
        model: opts.model,
        base_url,
        client: opts.client.unwrap_or_default(),
        on_usage: opts.on_usage,
    })
}

struct GeminiBrain {
    api_key: String,
    model: String,
    base_url: String,
    client: reqwest::Client,
    on_usage: Option<Arc<dyn Fn(TokenUsage) + Send + Sync>>,
}

#[derive(Debug, Deserialize)]
struct GeminiResponse {
    candidates: Option<Vec<GeminiCandidate>>,
    usage_metadata: Option<GeminiUsage>,
}

#[derive(Debug, Deserialize)]
struct GeminiCandidate {
    content: Option<GeminiContent>,
}

#[derive(Debug, Deserialize)]
struct GeminiContent {
    parts: Option<Vec<GeminiPart>>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum GeminiPart {
    #[serde(alias = "text")]
    Text {
        #[serde(default)]
        text: String,
    },
    FunctionCall {
        function_call: Option<GeminiFunctionCall>,
    },
    #[serde(other)]
    Other,
}

#[derive(Debug, Deserialize)]
struct GeminiFunctionCall {
    name: Option<String>,
    args: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct GeminiUsage {
    prompt_token_count: Option<u64>,
    candidates_token_count: Option<u64>,
}

#[async_trait]
impl Brain for GeminiBrain {
    async fn complete(&self, input: BrainInput) -> anyhow::Result<BrainOutput> {
        let (system_instruction, contents) = to_gemini_contents(&input.messages);
        let tools = json!({
            "function_declarations": input.tools.iter().map(|t| json!({
                "name": t.name.as_str(),
                "description": t.description,
                "parameters": {
                    "type": "OBJECT",
                    "properties": {},
                },
            })).collect::<Vec<_>>(),
        });

        let mut body = json!({
            "contents": contents,
            "tools": [tools],
        });
        if let Some(sys) = system_instruction {
            body["systemInstruction"] = json!({ "parts": [{ "text": sys }] });
        }

        let url = format!(
            "{}/v1beta/models/{}:generateContent?key={}",
            self.base_url, self.model, self.api_key
        );

        let res = self
            .client
            .post(url)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("Gemini request failed: {e}"))?;

        let status = res.status();
        if !status.is_success() {
            let err_text = res.text().await.unwrap_or_default();
            let snippet: String = err_text.chars().take(500).collect();
            anyhow::bail!("Gemini API {status}: {snippet}");
        }

        let data: GeminiResponse = res
            .json()
            .await
            .map_err(|e| anyhow::anyhow!("Gemini response parse failed: {e}"))?;

        let usage = data.usage_metadata.as_ref().map(|u| {
            let usage = TokenUsage {
                input_tokens: u.prompt_token_count.unwrap_or(0) as u32,
                output_tokens: u.candidates_token_count.unwrap_or(0) as u32,
            };
            if let Some(ref hook) = self.on_usage {
                hook(usage);
            }
            usage
        });

        let parts = data
            .candidates
            .as_ref()
            .and_then(|c| c.first())
            .and_then(|c| c.content.as_ref())
            .and_then(|c| c.parts.as_deref());

        let mut texts = Vec::new();
        let mut tool_calls = Vec::new();
        for part in parts.into_iter().flatten() {
            match part {
                GeminiPart::Text { text } if !text.is_empty() => texts.push(text.to_string()),
                GeminiPart::Text { .. } => {}
                GeminiPart::FunctionCall { function_call } => {
                    if let Some(fc) = function_call {
                        let name = fc.name.as_deref().unwrap_or("");
                        tool_calls.push(tool_call_from_model(
                            Uuid::new_v4().to_string(),
                            name,
                            fc.args.clone().unwrap_or(json!({})),
                        ));
                    }
                }
                GeminiPart::Other => {}
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

fn to_gemini_contents(messages: &[AgentMessage]) -> (Option<String>, Vec<Value>) {
    let system: String = messages
        .iter()
        .filter_map(|m| match m {
            AgentMessage::System { content } => Some(content.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let system_instruction = if system.is_empty() {
        None
    } else {
        Some(system)
    };

    let mut contents = Vec::new();
    for m in messages {
        match m {
            AgentMessage::System { .. } => {}
            AgentMessage::User { content } => {
                contents.push(json!({
                    "role": "user",
                    "parts": [{ "text": content }],
                }));
            }
            AgentMessage::Assistant {
                content,
                tool_calls,
            } => {
                let mut parts = vec![json!({ "text": content })];
                if let Some(calls) = tool_calls {
                    for tc in calls {
                        parts.push(json!({
                            "functionCall": {
                                "name": tc.name.as_str(),
                                "args": tc.arguments,
                            },
                        }));
                    }
                }
                contents.push(json!({ "role": "model", "parts": parts }));
            }
            AgentMessage::Tool {
                tool_call_id: _,
                content,
            } => {
                contents.push(json!({
                    "role": "user",
                    "parts": [{
                        "functionResponse": {
                            "name": "tool",
                            "response": { "content": content },
                        },
                    }],
                }));
            }
        }
    }
    (system_instruction, contents)
}
