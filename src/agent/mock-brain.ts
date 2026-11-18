import { randomUUID } from "node:crypto";
import type { Brain, BrainInput, BrainOutput, ToolCall } from "./types.js";

/**
 * Deterministic brain for tests and offline runs.
 * Interprets structured user payloads without calling an LLM.
 */
export function createMockBrain(): Brain {
  return {
    async complete(input: BrainInput): Promise<BrainOutput> {
      const lastUser = [...input.messages].reverse().find((m) => m.role === "user");
      const text = lastUser && lastUser.role === "user" ? lastUser.content : "";

      if (input.messages.some((message) => message.role === "system" && message.content.startsWith("You are") && message.content.includes("An operator decision and action result are present."))) return { type: "message", content: "" };

      if (/duplicate|already reported|nothing to send/i.test(text)) {
        return {
          type: "tool_calls",
          toolCalls: [
            tool("record_silence", {
              reason: "duplicate or non-actionable event",
            }),
          ],
        };
      }

      const followupMatch = text.match(
        /check back in (\d+)\s*(seconds?|minutes?|hours?)/i,
      );
      if (followupMatch) {
        const n = Number(followupMatch[1]);
        const unit = followupMatch[2]!.toLowerCase();
        const seconds = unit.startsWith("hour")
          ? n * 3600
          : unit.startsWith("min")
            ? n * 60
            : n;
        return {
          type: "tool_calls",
          content: "Scheduling a follow-up.",
          toolCalls: [
            tool("set_followup", {
              inSeconds: seconds,
              note: "scheduled by mock brain",
            }),
            tool("record_silence", {
              reason: "follow-up scheduled; no immediate user message",
            }),
          ],
        };
      }

      if (/email anyone|send external|wire money|delete production/i.test(text)) {
        return {
          type: "tool_calls",
          content: "This needs approval.",
          toolCalls: [
            tool("request_approval", {
              action: "send_external",
              args: { to: "other@example.com", subject: "agent draft", body: "hi" },
              reason: "external communication",
            }),
          ],
        };
      }

      if (text.includes('"kind":"followup"') || text.includes('"source":"timer"')) {
        return {
          type: "tool_calls",
          toolCalls: [
            tool("record_silence", {
              reason: "timer fired; nothing actionable",
            }),
          ],
        };
      }

      if (/ignore previous instructions|exfiltrate/i.test(text)) {
        return {
          type: "tool_calls",
          toolCalls: [
            tool("record_silence", {
              reason: "injection warning; refusing to follow untrusted instructions",
            }),
          ],
        };
      }

      const summary = summarize(text);
      return {
        type: "tool_calls",
        toolCalls: [
          tool("notify_user", {
            text: `Acknowledged: ${summary}`,
          }),
        ],
      };
    },
  };
}

function tool(name: ToolCall["name"], args: Record<string, unknown>): ToolCall {
  return { id: randomUUID(), name, arguments: args };
}

function summarize(text: string): string {
  try {
    const parsed = JSON.parse(
      text.replace(/^[\s\S]*<<<UNTRUSTED_EVENT_DATA>>>\n?/, "").replace(/\n?<<<END_UNTRUSTED_EVENT_DATA>>>[\s\S]*$/, ""),
    ) as unknown;
    return JSON.stringify(parsed).slice(0, 200);
  } catch {
    return text.slice(0, 200);
  }
}
