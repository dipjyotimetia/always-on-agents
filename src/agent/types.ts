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
  | { type: "executed_approval" | "failed_approval"; deferredId: string; result: unknown }
  | { type: "error"; error: string };

/** JSON Schema object passed to official provider SDKs as the tool input schema. */
export type ToolInputSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

export type ToolDef = {
  name: ToolName;
  description: string;
  inputSchema: ToolInputSchema;
};

export type BrainInput = {
  messages: AgentMessage[];
  tools: ToolDef[];
  signal?: AbortSignal;
  /**
   * Instructions and memory index loaded on every run.
   * Anthropic caches this block; other providers keep it at the front of the prompt.
   */
  cacheableSystemPrefix?: string;
};

export type BrainOutput =
  | { type: "message"; content: string; usage?: TokenUsage }
  | { type: "tool_calls"; content?: string; toolCalls: ToolCall[]; usage?: TokenUsage };

export type Brain = {
  complete(input: BrainInput): Promise<BrainOutput>;
};

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
};
