import { randomUUID } from "node:crypto";
import type { Brain, BrainInput, BrainOutput, ToolCall, ToolName } from "./types.js";

export type AnthropicBrainOptions = {
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** Called with usage after each completion */
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
};

type AnthropicContent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

type AnthropicResponse = {
  content: AnthropicContent[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
};

/**
 * Brain backed by the Anthropic Messages API (no SDK dependency).
 */
export function createAnthropicBrain(opts: AnthropicBrainOptions): Brain {
  const baseUrl = (opts.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");

  return {
    async complete(input: BrainInput): Promise<BrainOutput> {
      const system = input.messages
        .filter((m) => m.role === "system")
        .map((m) => m.content)
        .join("\n\n");

      const messages = toAnthropicMessages(input.messages);
      const tools = input.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: {
          type: "object",
          properties: {},
          additionalProperties: true,
        },
      }));

      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": opts.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: opts.model,
          max_tokens: 4096,
          system: system || undefined,
          messages,
          tools,
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Anthropic API ${res.status}: ${errText.slice(0, 500)}`);
      }

      const data = (await res.json()) as AnthropicResponse;
      opts.onUsage?.({
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
      });

      const toolCalls: ToolCall[] = [];
      const texts: string[] = [];
      for (const block of data.content ?? []) {
        if (block.type === "text") texts.push(block.text);
        if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id || randomUUID(),
            name: block.name as ToolName,
            arguments: block.input ?? {},
          });
        }
      }

      if (toolCalls.length > 0) {
        return {
          type: "tool_calls",
          content: texts.join("\n") || undefined,
          toolCalls,
        };
      }
      return { type: "message", content: texts.join("\n") || "" };
    },
  };
}

function toAnthropicMessages(
  messages: BrainInput["messages"],
): Array<{ role: "user" | "assistant"; content: unknown }> {
  const out: Array<{ role: "user" | "assistant"; content: unknown }> = [];

  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      const content: AnthropicContent[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls ?? []) {
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: tc.arguments,
        });
      }
      out.push({
        role: "assistant",
        content: content.length ? content : [{ type: "text", text: "" }],
      });
      continue;
    }
    if (m.role === "tool") {
      // Anthropic expects tool results as user message blocks
      out.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.toolCallId,
            content: m.content,
          },
        ],
      });
    }
  }
  return out;
}
