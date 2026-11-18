import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type {
  Brain,
  BrainInput,
  BrainOutput,
  TokenUsage,
  ToolCall,
} from "./types.js";

export type AnthropicBrainOptions = {
  apiKey?: string;
  model: string;
  baseUrl?: string;
  /** Injected for tests. Production builds an official Anthropic client. */
  client?: AnthropicMessagesClient;
};

export type AnthropicMessagesClient = {
  messages: {
    create: (
      body: Anthropic.MessageCreateParamsNonStreaming,
      options?: { signal?: AbortSignal },
    ) => Promise<Anthropic.Message>;
  };
};

/**
 * Brain backed by the official Anthropic TypeScript SDK.
 * The stable memory prefix is its own system block with a prompt-cache breakpoint.
 */
export function createAnthropicBrain(opts: AnthropicBrainOptions): Brain {
  const client = opts.client ?? createOfficialClient(opts);

  return {
    async complete(input: BrainInput): Promise<BrainOutput> {
      const system = anthropicSystem(input);
      const response = await client.messages.create({
        model: opts.model,
        max_tokens: 4096,
        ...(system.length > 0 ? { system } : {}),
        messages: toAnthropicMessages(input.messages),
        tools: input.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.inputSchema,
        })),
      }, input.signal ? { signal: input.signal } : undefined);

      const usage = anthropicUsage(response.usage);
      const toolCalls: ToolCall[] = [];
      const texts: string[] = [];
      for (const block of response.content) {
        if (block.type === "text") texts.push(block.text);
        if (block.type === "tool_use") {
          const tool = input.tools.find((item) => item.name === block.name);
          if (!tool) continue;
          toolCalls.push({
            id: block.id || randomUUID(),
            name: tool.name,
            arguments: asRecord(block.input),
          });
        }
      }

      const content = texts.join("\n");
      if (toolCalls.length > 0) {
        return {
          type: "tool_calls",
          ...(content ? { content } : {}),
          toolCalls,
          usage,
        };
      }
      return { type: "message", content, usage };
    },
  };
}

function createOfficialClient(opts: AnthropicBrainOptions): AnthropicMessagesClient {
  if (!opts.apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required for the Anthropic brain");
  }
  const sdk = new Anthropic({
    apiKey: opts.apiKey,
    baseURL: opts.baseUrl,
  });
  return {
    messages: {
      create: (body, options) => sdk.messages.create(body, options),
    },
  };
}

/** Total input tokens include cache writes and cache reads. */
export function anthropicUsage(usage: Anthropic.Usage): TokenUsage {
  return {
    inputTokens:
      (usage.input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0),
    outputTokens: usage.output_tokens ?? 0,
  };
}

function anthropicSystem(input: BrainInput): Anthropic.TextBlockParam[] {
  const blocks: Anthropic.TextBlockParam[] = [];
  const prefix = input.cacheableSystemPrefix?.trim();
  if (prefix) {
    blocks.push({
      type: "text",
      text: prefix,
      cache_control: { type: "ephemeral" },
    });
  }
  const rest = input.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n")
    .trim();
  if (rest) blocks.push({ type: "text", text: rest });
  return blocks;
}

type AnthropicMessage = Anthropic.MessageParam;

function toAnthropicMessages(
  messages: BrainInput["messages"],
): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];

  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      out.push({ role: "user", content: message.content });
      continue;
    }
    if (message.role === "assistant") {
      const content: Anthropic.ContentBlockParam[] = [];
      if (message.content) content.push({ type: "text", text: message.content });
      for (const call of message.toolCalls ?? []) {
        content.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: call.arguments,
        });
      }
      out.push({
        role: "assistant",
        content: content.length > 0 ? content : [{ type: "text", text: "" }],
      });
      continue;
    }

    const block: Anthropic.ToolResultBlockParam = {
      type: "tool_result",
      tool_use_id: message.toolCallId,
      content: message.content,
    };
    const last = out[out.length - 1];
    if (
      last?.role === "user" &&
      Array.isArray(last.content) &&
      last.content.every((part) => part.type === "tool_result")
    ) {
      last.content.push(block);
    } else {
      out.push({ role: "user", content: [block] });
    }
  }

  return out;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}
