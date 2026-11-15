import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import type { GenerateContentParameters } from "@google/genai";
import { createAnthropicBrain } from "../src/agent/anthropic-brain.js";
import { createGeminiBrain } from "../src/agent/gemini-brain.js";
import { createOpenAiBrain } from "../src/agent/openai-brain.js";
import { resolveBrainKind } from "../src/agent/factory.js";
import { TOOL_DEFS } from "../src/agent/tools.js";
import type { AgentMessage } from "../src/agent/types.js";
import { loadConfig } from "../src/config.js";
import { getTokensToday } from "../src/budgets.js";
import { insertEvent } from "../src/inbox/store.js";
import { createRuntime } from "../src/runtime.js";

const PREFIX = "# Agent instructions\n\nlayout stable";
const messages: AgentMessage[] = [
  { role: "system", content: "--- reported.md ---\nalready told the user" },
  { role: "user", content: "hello" },
  {
    role: "assistant",
    content: "working",
    toolCalls: [
      { id: "c1", name: "read_memory", arguments: { path: "index.md" } },
      { id: "c2", name: "record_silence", arguments: { reason: "done" } },
    ],
  },
  { role: "tool", toolCallId: "c1", content: "file" },
  { role: "tool", toolCallId: "c2", content: "silence:done" },
];

describe("official SDK brains", () => {
  it("sends Anthropic tool schemas, a cached prefix, and merged tool results", async () => {
    let body: Anthropic.MessageCreateParamsNonStreaming | undefined;
    const brain = createAnthropicBrain({
      model: "claude-sonnet-4-5",
      client: {
        messages: {
          async create(params) {
            body = params;
            return {
              id: "msg_1",
              type: "message",
              role: "assistant",
              model: "claude-sonnet-4-5",
              stop_reason: "tool_use",
              stop_sequence: null,
              content: [
                { type: "tool_use", id: "toolu_1", name: "notify_user", input: { text: "hi" } },
              ],
              usage: {
                input_tokens: 3,
                cache_creation_input_tokens: 2,
                cache_read_input_tokens: 10,
                output_tokens: 4,
              },
            } as Anthropic.Message;
          },
        },
      },
    });

    const output = await brain.complete({
      messages,
      tools: TOOL_DEFS,
      cacheableSystemPrefix: PREFIX,
    });

    expect(body?.tools?.[0]?.input_schema.properties).toMatchObject({
      path: { type: "string" },
    });
    expect(body?.tools?.map((tool) => tool.name)).toContain("proxied_request");
    const proxied = body?.tools?.find((tool) => tool.name === "proxied_request");
    expect(proxied?.input_schema.required).toContain("url");

    const system = body?.system;
    expect(Array.isArray(system)).toBe(true);
    if (!Array.isArray(system)) throw new Error("system blocks missing");
    expect(system[0]).toMatchObject({
      type: "text",
      text: PREFIX,
      cache_control: { type: "ephemeral" },
    });
    expect(system[1]).toMatchObject({ type: "text" });
    expect(JSON.stringify(system[1])).not.toContain("cache_control");
    expect(String(system[1]?.text)).toContain("already told the user");
    expect(String(system[1]?.text)).not.toContain(PREFIX);

    expect(body?.messages).toHaveLength(3);
    const toolResult = body?.messages[2];
    expect(toolResult?.role).toBe("user");
    expect(Array.isArray(toolResult?.content)).toBe(true);
    if (!Array.isArray(toolResult?.content)) throw new Error("tool results not merged");
    expect(toolResult.content).toHaveLength(2);
    expect(toolResult.content.every((part) => part.type === "tool_result")).toBe(true);

    expect(output).toMatchObject({
      type: "tool_calls",
      usage: { inputTokens: 15, outputTokens: 4 },
    });
  });

  it("sends OpenAI tool schemas with the stable prefix first", async () => {
    let body: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming | undefined;
    const brain = createOpenAiBrain({
      model: "gpt-5.5",
      client: {
        chat: {
          completions: {
            async create(params) {
              body = params;
              return {
                id: "chat_1",
                object: "chat.completion",
                created: 0,
                model: "gpt-5.5",
                choices: [
                  {
                    index: 0,
                    finish_reason: "stop",
                    message: { role: "assistant", content: "quiet", refusal: null },
                  },
                ],
                usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
              } as OpenAI.Chat.ChatCompletion;
            },
          },
        },
      },
    });

    const output = await brain.complete({
      messages,
      tools: TOOL_DEFS,
      cacheableSystemPrefix: PREFIX,
    });

    expect(body?.messages[0]).toEqual({ role: "system", content: PREFIX });
    expect(body?.messages[1]).toMatchObject({
      role: "system",
      content: expect.stringContaining("already told the user"),
    });
    const assistant = body?.messages[3];
    expect(assistant).toMatchObject({ role: "assistant" });
    if (!assistant || assistant.role !== "assistant") throw new Error("missing assistant");
    expect(assistant.tool_calls).toHaveLength(2);
    expect(body?.messages[4]).toMatchObject({ role: "tool", tool_call_id: "c1" });
    expect(body?.messages[5]).toMatchObject({ role: "tool", tool_call_id: "c2" });

    const readMemory = body?.tools?.find((tool) => tool.type === "function" && tool.function.name === "read_memory");
    expect(readMemory && readMemory.type === "function" ? readMemory.function.parameters : {}).toMatchObject({
      properties: { path: { type: "string" } },
      required: ["path"],
    });
    expect(output).toMatchObject({
      type: "message",
      content: "quiet",
      usage: { inputTokens: 9, outputTokens: 2 },
    });
  });

  it("sends Gemini function declarations and disables automatic function calling", async () => {
    let body: GenerateContentParameters | undefined;
    const brain = createGeminiBrain({
      model: "gemini-3.8-flash",
      client: {
        models: {
          async generateContent(params) {
            body = params;
            return {
              text: "",
              functionCalls: [{ id: "g1", name: "record_silence", args: { reason: "noop" } }],
              usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 1 },
              candidates: [],
            };
          },
        },
      },
    });

    const output = await brain.complete({
      messages,
      tools: TOOL_DEFS,
      cacheableSystemPrefix: PREFIX,
    });

    expect(String(body?.config?.systemInstruction).startsWith(PREFIX)).toBe(true);
    expect(String(body?.config?.systemInstruction)).toContain("already told the user");
    expect(body?.config?.automaticFunctionCalling).toEqual({ disable: true });
    const declarations = body?.config?.tools?.[0]?.functionDeclarations ?? [];
    const readMemory = declarations.find((decl) => decl.name === "read_memory");
    expect(readMemory?.parametersJsonSchema).toMatchObject({
      properties: { path: { type: "string" } },
    });

    const contents = body?.contents;
    expect(Array.isArray(contents)).toBe(true);
    if (!Array.isArray(contents)) throw new Error("contents missing");
    expect(contents).toHaveLength(3);
    const results = contents[2];
    expect(results && typeof results === "object" && "role" in results ? results.role : "").toBe("user");
    const parts =
      results && typeof results === "object" && "parts" in results && Array.isArray(results.parts)
        ? results.parts
        : [];
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({
      functionResponse: { id: "c1", name: "read_memory" },
    });
    expect(parts[1]).toMatchObject({
      functionResponse: { id: "c2", name: "record_silence" },
    });

    expect(output).toMatchObject({
      type: "tool_calls",
      usage: { inputTokens: 6, outputTokens: 1 },
      toolCalls: [{ name: "record_silence", arguments: { reason: "noop" } }],
    });
  });

  it("selects auto brains by key and rejects an explicit brain with no key", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "aoa-brain-"));
    try {
      const blank = {
        dataDir: dir,
        anthropicApiKey: "",
        openaiApiKey: "",
        geminiApiKey: "",
      };
      expect(resolveBrainKind(loadConfig({ ...blank, brain: "auto" }))).toBe("mock");
      expect(
        resolveBrainKind(loadConfig({ ...blank, brain: "auto", openaiApiKey: "sk-openai" })),
      ).toBe("openai");
      expect(
        resolveBrainKind(
          loadConfig({
            ...blank,
            brain: "auto",
            anthropicApiKey: "sk-ant",
            openaiApiKey: "sk-openai",
            geminiApiKey: "gem",
          }),
        ),
      ).toBe("anthropic");
      expect(() => resolveBrainKind(loadConfig({ ...blank, brain: "gemini" }))).toThrow(
        /GEMINI_API_KEY/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("provider usage", () => {
  let dir: string;

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("records returned usage once in the run log and the daily budget", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "aoa-usage-"));
    const runtime = createRuntime({
      config: {
        dataDir: dir,
        minFollowupSeconds: 0,
        workerIdleMs: 10,
        schedulerIntervalMs: 10,
        dispatcherIntervalMs: 10,
        autoNotifyBareText: false,
      },
      brain: {
        async complete() {
          return {
            type: "message",
            content: "",
            usage: { inputTokens: 11, outputTokens: 7 },
          };
        },
      },
    });

    try {
      insertEvent(runtime.db, {
        source: "user",
        sourceId: "usage-1",
        sessionKey: "s-usage",
        payload: { text: "hi" },
      });
      await runtime.runOnce();
      const run = runtime.db
        .prepare(`SELECT tokens_in, tokens_out FROM run_log ORDER BY id DESC LIMIT 1`)
        .get() as { tokens_in: number; tokens_out: number };
      expect(run).toEqual({ tokens_in: 11, tokens_out: 7 });
      expect(getTokensToday(runtime.db, "default")).toBe(18);
    } finally {
      runtime.close();
    }
  });
});
