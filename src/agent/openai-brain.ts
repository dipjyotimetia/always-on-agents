import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import type {
  Brain,
  BrainInput,
  BrainOutput,
  ToolCall,
} from "./types.js";

export type OpenAiBrainOptions = {
  apiKey?: string;
  model: string;
  baseUrl?: string;
  /** Injected for tests. Production builds an official OpenAI client. */
  client?: OpenAiChatClient;
};

export type OpenAiChatClient = {
  chat: {
    completions: {
      create: (
        body: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
      options?: { signal?: AbortSignal },
      ) => Promise<OpenAI.Chat.ChatCompletion>;
    };
  };
};

/**
 * Brain backed by the official OpenAI SDK Chat Completions API.
 * The transcript already stores assistant tool calls and tool results, which this API accepts directly.
 * The stable memory prefix is the first system message so OpenAI's automatic prefix cache can hit it.
 */
export function createOpenAiBrain(opts: OpenAiBrainOptions): Brain {
  const client = opts.client ?? createOfficialClient(opts);

  return {
    async complete(input: BrainInput): Promise<BrainOutput> {
      const response = await client.chat.completions.create({
        model: opts.model,
        messages: toOpenAiMessages(input),
        tools: input.tools.map((tool) => ({
          type: "function" as const,
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        })),
      }, input.signal ? { signal: input.signal } : undefined);

      const choice = response.choices[0]?.message;
      const usage = {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      };
      const toolCalls: ToolCall[] = (choice?.tool_calls ?? []).flatMap((call) => {
        if (call.type !== "function") return [];
        const { name } = call.function;
        const tool = input.tools.find((item) => item.name === name);
        if (!tool) return [];
        return [
          {
            id: call.id || randomUUID(),
            name: tool.name,
            arguments: parseArgs(call.function.arguments),
          },
        ];
      });
      const content = choice?.content ?? "";
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

function createOfficialClient(opts: OpenAiBrainOptions): OpenAiChatClient {
  if (!opts.apiKey) {
    throw new Error("OPENAI_API_KEY is required for the OpenAI brain");
  }
  const sdk = new OpenAI({
    apiKey: opts.apiKey,
    baseURL: opts.baseUrl,
  });
  return {
    chat: {
      completions: {
        create: (body, options) => sdk.chat.completions.create(body, options),
      },
    },
  };
}

function toOpenAiMessages(
  input: BrainInput,
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  const prefix = input.cacheableSystemPrefix?.trim();
  if (prefix) out.push({ role: "system", content: prefix });

  for (const message of input.messages) {
    if (message.role === "system") {
      out.push({ role: "system", content: message.content });
      continue;
    }
    if (message.role === "user") {
      out.push({ role: "user", content: message.content });
      continue;
    }
    if (message.role === "assistant") {
      const toolCalls = (message.toolCalls ?? []).map((call) => ({
        id: call.id,
        type: "function" as const,
        function: {
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        },
      }));
      out.push({
        role: "assistant",
        content: message.content || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    out.push({
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
    });
  }

  return out;
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Model returned non-JSON arguments; the tool executor reports the failure.
  }
  return {};
}
