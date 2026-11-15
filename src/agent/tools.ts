import { createHash } from "node:crypto";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import {
  alreadyReported,
  appendReported,
  readMemoryFile,
  writeMemoryFile,
  type MemoryProvenance,
} from "../memory/store.js";
import { verifyProgressFile } from "../memory/verify.js";
import { enqueueOutbox } from "../outbox/store.js";
import { classifyRisk, createDeferredCall } from "../permissions/defer.js";
import type { CredentialStore } from "../permissions/proxy.js";
import { createFollowup } from "../timers/store.js";
import type { ToolCall, ToolResult } from "./types.js";

export type ToolContext = {
  db: Db;
  config: Config;
  inboxId: string;
  sessionKey: string;
  credentials: CredentialStore;
};

export const TOOL_DEFS = [
  {
    name: "read_memory" as const,
    description: "Read a memory file relative to the memory directory.",
  },
  {
    name: "write_memory" as const,
    description:
      "Write a memory file (not instructions.md). Set provenance: user|agent|inferred_untrusted|verified.",
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
      "Defer a high-risk action until an authenticated approval event arrives. Stored args are executed later — not regenerated.",
  },
  {
    name: "record_silence" as const,
    description: "Explicitly choose not to message the user; records a reason.",
  },
  {
    name: "mark_progress_complete" as const,
    description:
      "Mark a progress file complete only if the verifier passes (evidence required).",
  },
  {
    name: "proxied_request" as const,
    description:
      "Request an outbound HTTPS call via credential proxy (always deferred for approval).",
  },
];

export function executeTool(ctx: ToolContext, call: ToolCall): ToolResult {
  try {
    const idempotencyKey =
      typeof call.arguments.idempotencyKey === "string"
        ? call.arguments.idempotencyKey
        : undefined;

    if (idempotencyKey) {
      const cached = ctx.db
        .prepare(`SELECT result_json FROM tool_idempotency WHERE key = ?`)
        .get(idempotencyKey) as { result_json: string } | undefined;
      if (cached) {
        return JSON.parse(cached.result_json) as ToolResult;
      }
    }

    const result = executeToolInner(ctx, call);

    if (idempotencyKey && result.ok) {
      ctx.db
        .prepare(
          `INSERT OR IGNORE INTO tool_idempotency (key, tool_name, result_json) VALUES (?, ?, ?)`,
        )
        .run(idempotencyKey, call.name, JSON.stringify(result));
    }
    return result;
  } catch (err) {
    return fail(call.id, err instanceof Error ? err.message : String(err));
  }
}

function executeToolInner(ctx: ToolContext, call: ToolCall): ToolResult {
  switch (call.name) {
    case "read_memory": {
      const rel = String(call.arguments.path ?? "");
      const content = readMemoryFile(ctx.config.memoryDir, rel);
      return ok(call.id, content);
    }
    case "write_memory": {
      const rel = String(call.arguments.path ?? "");
      const content = String(call.arguments.content ?? "");
      const provenance = (String(
        call.arguments.provenance ?? "agent",
      ) || "agent") as MemoryProvenance;
      const risk = classifyRisk("write_memory", {
        path: rel,
        provenance,
      });
      if (risk === "block") return fail(call.id, "blocked by classifier");
      writeMemoryFile(ctx.config.memoryDir, rel, content, { provenance });
      return ok(call.id, `wrote ${rel} (provenance=${provenance})`);
    }
    case "set_followup": {
      const inSeconds = Number(
        call.arguments.inSeconds ?? call.arguments.in_seconds ?? 300,
      );
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
      const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
      enqueueOutbox(ctx.db, {
        inboxId: ctx.inboxId,
        body: text,
        meta: { sessionKey: ctx.sessionKey },
        idempotencyKey: `notify:${ctx.sessionKey}:${hash}`,
      });
      appendReported(ctx.config.memoryDir, text);
      return ok(call.id, "enqueued");
    }
    case "request_approval":
    case "proxied_request": {
      const action =
        call.name === "proxied_request"
          ? "proxied_request"
          : String(call.arguments.action ?? "send_external");
      const args =
        call.name === "proxied_request"
          ? call.arguments
          : ((call.arguments.args as Record<string, unknown> | undefined) ??
            (call.arguments as Record<string, unknown>));
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
        idempotencyKey: `approval:${deferred.id}`,
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
    case "mark_progress_complete": {
      const rel = String(call.arguments.path ?? "");
      const verified = verifyProgressFile(ctx.config.memoryDir, rel);
      if (!verified.ok) {
        return fail(
          call.id,
          `verifier rejected: ${verified.reasons.join("; ")}`,
        );
      }
      const existing = readMemoryFile(ctx.config.memoryDir, rel);
      writeMemoryFile(
        ctx.config.memoryDir,
        rel,
        `${existing.trimEnd()}\n\nverified: ${new Date().toISOString()}\nstatus: complete\n`,
        { provenance: "verified" },
      );
      return ok(call.id, `verified complete: ${rel}`);
    }
    default:
      return fail(call.id, `unknown tool: ${call.name}`);
  }
}

function ok(toolCallId: string, content: string): ToolResult {
  return { toolCallId, ok: true, content };
}

function fail(toolCallId: string, content: string): ToolResult {
  return { toolCallId, ok: false, content };
}
