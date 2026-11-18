import { randomUUID } from "node:crypto";
import {
  GoogleGenAI,
  type Content,
  type GenerateContentParameters,
  type GenerateContentResponse,
} from "@google/genai";
import type {
  AgentMessage,
  Brain,
  BrainInput,
  BrainOutput,
  ToolCall,
} from "./types.js";

export type GeminiBrainOptions = {
  apiKey?: string;
  model: string;
  baseUrl?: string;
  /** Injected for tests. Production builds an official Google GenAI client. */
  client?: GeminiGenerateClient;
};

export type GeminiGenerateClient = {
  models: {
    generateContent: (
      params: GenerateContentParameters,
    ) => Promise<
      Pick<
        GenerateContentResponse,
        "text" | "functionCalls" | "usageMetadata" | "candidates"
      >
    >;
  };
};

/**
 * Brain backed by the official Google GenAI SDK.
 * Function declarations are data only: automatic function calling is disabled
 * so this runtime executes tools itself.
 * The stable memory prefix leads the system instruction, where Gemini applies automatic prefix caching.
 */
export function createGeminiBrain(opts: GeminiBrainOptions): Brain {
  const client = opts.client ?? createOfficialClient(opts);

  return {
    async complete(input: BrainInput): Promise<BrainOutput> {
      const systemInstruction = geminiSystem(input);
      const response = await client.models.generateContent({
        model: opts.model,
        contents: toGeminiContents(input.messages),
        config: {
          ...(systemInstruction ? { systemInstruction } : {}),
          abortSignal: input.signal,
          automaticFunctionCalling: { disable: true },
          tools: [
            {
              functionDeclarations: input.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                parametersJsonSchema: tool.inputSchema,
              })),
            },
          ],
        },
      });

      const usage = {
        inputTokens: response.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
      };
      const calls = response.functionCalls ?? [];
      const toolCalls: ToolCall[] = calls.flatMap((call) => {
        const tool = input.tools.find((item) => item.name === call.name);
        if (!tool) return [];
        return [
          {
            id: call.id || randomUUID(),
            name: tool.name,
            arguments: asRecord(call.args),
          },
        ];
      });
      const content = geminiText(response);
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

function createOfficialClient(opts: GeminiBrainOptions): GeminiGenerateClient {
  if (!opts.apiKey) {
    throw new Error("GEMINI_API_KEY is required for the Gemini brain");
  }
  const sdk = new GoogleGenAI({
    apiKey: opts.apiKey,
    ...(opts.baseUrl ? { httpOptions: { baseUrl: opts.baseUrl } } : {}),
  });
  return {
    models: {
      generateContent: (params) => sdk.models.generateContent(params),
    },
  };
}

function geminiSystem(input: BrainInput): string {
  const parts = [
    input.cacheableSystemPrefix?.trim() ?? "",
    ...input.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content.trim()),
  ].filter(Boolean);
  return parts.join("\n\n");
}

function toGeminiContents(messages: AgentMessage[]): Content[] {
  const contents: Content[] = [];

  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      contents.push({ role: "user", parts: [{ text: message.content }] });
      continue;
    }
    if (message.role === "assistant") {
      const parts: NonNullable<Content["parts"]> = [];
      if (message.content) parts.push({ text: message.content });
      for (const call of message.toolCalls ?? []) {
        parts.push({
          functionCall: { id: call.id, name: call.name, args: call.arguments },
        });
      }
      contents.push({
        role: "model",
        parts: parts.length > 0 ? parts : [{ text: "" }],
      });
      continue;
    }

    const part = {
      functionResponse: {
        id: message.toolCallId,
        name: toolName(messages, message.toolCallId),
        response: { output: message.content },
      },
    };
    const last = contents[contents.length - 1];
    const lastParts = last?.parts;
    if (last?.role === "user" && lastParts?.some((item) => item.functionResponse)) {
      lastParts.push(part);
    } else {
      contents.push({ role: "user", parts: [part] });
    }
  }

  return contents;
}

function toolName(messages: AgentMessage[], toolCallId: string): string {
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const call = message.toolCalls?.find((item) => item.id === toolCallId);
    if (call) return call.name;
  }
  return "tool";
}

function geminiText(
  response: Pick<GenerateContentResponse, "candidates">,
): string {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  return parts
    .map((part) => part.text ?? "")
    .filter(Boolean)
    .join("\n");
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}
