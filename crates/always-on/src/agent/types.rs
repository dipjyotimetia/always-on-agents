use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolName {
    ReadMemory,
    WriteMemory,
    SetFollowup,
    NotifyUser,
    RequestApproval,
    RecordSilence,
    MarkProgressComplete,
    ProxiedRequest,
}

impl ToolName {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ReadMemory => "read_memory",
            Self::WriteMemory => "write_memory",
            Self::SetFollowup => "set_followup",
            Self::NotifyUser => "notify_user",
            Self::RequestApproval => "request_approval",
            Self::RecordSilence => "record_silence",
            Self::MarkProgressComplete => "mark_progress_complete",
            Self::ProxiedRequest => "proxied_request",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ToolDef {
    pub name: ToolName,
    pub description: &'static str,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: ToolName,
    #[serde(default)]
    pub arguments: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResult {
    pub tool_call_id: String,
    pub ok: bool,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deferred: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deferred_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "lowercase")]
pub enum AgentMessage {
    System { content: String },
    User { content: String },
    Assistant {
        content: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        tool_calls: Option<Vec<ToolCall>>,
    },
    Tool {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        content: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RunOutcome {
    Notified { body: String },
    Silence { reason: String },
    Deferred {
        deferred_id: String,
        summary: String,
    },
    ExecutedApproval {
        deferred_id: String,
        result: Value,
    },
    Error { error: String },
}

#[derive(Debug, Clone)]
pub struct BrainInput {
    pub messages: Vec<AgentMessage>,
    pub tools: Vec<ToolDef>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub input_tokens: u32,
    pub output_tokens: u32,
}

#[derive(Debug, Clone)]
pub enum BrainOutput {
    Message {
        content: String,
        usage: Option<TokenUsage>,
    },
    ToolCalls {
        content: Option<String>,
        tool_calls: Vec<ToolCall>,
        usage: Option<TokenUsage>,
    },
}

impl BrainOutput {
    pub fn usage(&self) -> Option<TokenUsage> {
        match self {
            Self::Message { usage, .. } => *usage,
            Self::ToolCalls { usage, .. } => *usage,
        }
    }
}

#[async_trait]
pub trait Brain: Send + Sync {
    async fn complete(&self, input: BrainInput) -> anyhow::Result<BrainOutput>;
}

pub type UsageCallback = std::sync::Arc<dyn Fn(TokenUsage) + Send + Sync>;