import type { Config } from "../config.js";
import type { Db } from "../db.js";
import {
  alreadyReported,
  appendReported,
  readMemoryFile,
  writeMemoryFile,
} from "../memory/store.js";
import { enqueueOutbox } from "../outbox/store.js";
import { classifyRisk, createDeferredCall } from "../permissions/defer.js";
import { createFollowup } from "../timers/store.js";
import type { ToolCall, ToolResult } from "./types.js";

export type ToolContext = {
  db: Db;
  config: Config;
  inboxId: string;
  sessionKey: string;
};

export const TOOL_DEFS = [
  {
    name: "read_memory" as const,
    description: "Read a memory file relative to the memory directory.",
  },
  {
    name: "write_memory" as const,
    description:
      "Write a memory file (not instructions.md). Tag inferred notes with provenance.",
  },
  {
    name: "set_followup" as const,
    description: "Schedule a one-shot follow-up that wakes via the inbox.",
  },
  {
    name: "notify_user" as const,
    description: "Enqueue a user-visible message through the outbox.",
  },
  {
    name: "request_approval" as const,
    description:
      "Defer a high-risk action until an authenticated approval event arrives.",
  },
  {
    name: "record_silence" as const,
    description: "Explicitly choose not to message the user; records a reason.",
  },
];

export function executeTool(ctx: ToolContext, call: ToolCall): ToolResult {
  try {
    switch (call.name) {
      case "read_memory": {
        const rel = String(call.arguments.path ?? "");
        const content = readMemoryFile(ctx.config.memoryDir, rel);
        return ok(call.id, content);
      }
      case "write_memory": {
        const rel = String(call.arguments.path ?? "");
        const content = String(call.arguments.content ?? "");
        writeMemoryFile(ctx.config.memoryDir, rel, content);
        return ok(call.id, `wrote ${rel}`);
      }
      case "set_followup": {
        const inSeconds = Number(call.arguments.inSeconds ?? call.arguments.in_seconds ?? 300);
        const note = String(call.arguments.note ?? "follow-up");
        const dueAt = new Date(Date.now() + Math.max(0, inSeconds) * 1000);
        const timer = createFollowup(ctx.db, {
          inboxId: ctx.inboxId,
          dueAt,
          sessionKey: ctx.sessionKey,
          note,
          minFollowupSeconds: ctx.config.minFollowupSeconds,
          maxActiveFollowups: ctx.config.maxActiveFollowups,
        });
        return ok(call.id, `follow-up ${timer.id} due ${timer.due_at}`);
      }
      case "notify_user": {
        const text = String(call.arguments.text ?? "").trim();
        if (!text) return fail(call.id, "empty notification");
        if (alreadyReported(ctx.config.memoryDir, text)) {
          return ok(call.id, "suppressed: already reported");
        }
        enqueueOutbox(ctx.db, {
          inboxId: ctx.inboxId,
          body: text,
          meta: { sessionKey: ctx.sessionKey },
        });
        appendReported(ctx.config.memoryDir, text);
        return ok(call.id, "enqueued");
      }
      case "request_approval": {
        const action = String(call.arguments.action ?? "send_external");
        const args =
          (call.arguments.args as Record<string, unknown> | undefined) ??
          (call.arguments as Record<string, unknown>);
        const risk = classifyRisk(action, args);
        if (risk === "block") {
          return fail(call.id, "blocked by auto-mode classifier");
        }
        const deferred = createDeferredCall(ctx.db, {
          inboxId: ctx.inboxId,
          sessionKey: ctx.sessionKey,
          toolName: action,
          args,
        });
        enqueueOutbox(ctx.db, {
          inboxId: ctx.inboxId,
          channel: "approval",
          body: `Approval required for ${action} (${deferred.id}): ${String(call.arguments.reason ?? "")}`,
          meta: {
            deferredId: deferred.id,
            toolName: action,
            arguments: args,
          },
        });
        return {
          toolCallId: call.id,
          ok: true,
          content: `deferred:${deferred.id}`,
          deferred: true,
          deferredId: deferred.id,
        };
      }
      case "record_silence": {
        const reason = String(call.arguments.reason ?? "unspecified");
        return ok(call.id, `silence:${reason}`);
      }
      default:
        return fail(call.id, `unknown tool: ${call.name}`);
    }
  } catch (err) {
    return fail(call.id, err instanceof Error ? err.message : String(err));
  }
}

function ok(toolCallId: string, content: string): ToolResult {
  return { toolCallId, ok: true, content };
}

function fail(toolCallId: string, content: string): ToolResult {
  return { toolCallId, ok: false, content };
}
