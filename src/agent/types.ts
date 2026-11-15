export type ToolName =
  | "read_memory"
  | "write_memory"
  | "set_followup"
  | "notify_user"
  | "request_approval"
  | "record_silence"
  | "mark_progress_complete"
  | "proxied_request";

export type ToolCall = {
  id: string;
  name: ToolName;
  arguments: Record<string, unknown>;
};

export type ToolResult = {
  toolCallId: string;
  ok: boolean;
  content: string;
  deferred?: boolean;
  deferredId?: string;
};

export type AgentMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export type RunOutcome =
  | { type: "notified"; body: string }
  | { type: "silence"; reason: string }
  | { type: "deferred"; deferredId: string; summary: string }
  | { type: "executed_approval"; deferredId: string; result: unknown }
  | { type: "error"; error: string };

export type BrainInput = {
  messages: AgentMessage[];
  tools: Array<{ name: ToolName; description: string }>;
};

export type BrainOutput =
  | { type: "message"; content: string }
  | { type: "tool_calls"; content?: string; toolCalls: ToolCall[] };

export type Brain = {
  complete(input: BrainInput): Promise<BrainOutput>;
};

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
};
