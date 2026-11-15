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
import type { ToolCall, ToolDef, ToolInputSchema, ToolResult } from "./types.js";

export type ToolContext = {
  db: Db;
  config: Config;
  inboxId: string;
  sessionKey: string;
  credentials: CredentialStore;
};

const idempotencyKey = {
  type: "string",
  description: "Optional key so a retried call returns the stored result.",
};

function objectSchema(
  properties: Record<string, unknown>,
  required?: string[],
): ToolInputSchema {
  return {
    type: "object",
    properties: { ...properties, idempotencyKey },
    ...(required ? { required } : {}),
    additionalProperties: false,
  };
}

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "read_memory",
    description: "Read a memory file relative to the memory directory.",
    inputSchema: objectSchema(
      {
        path: {
          type: "string",
          description: "Path relative to the memory directory, such as notes/preferences.md.",
        },
      },
      ["path"],
    ),
  },
  {
    name: "write_memory",
    description:
      "Write a memory file (not instructions.md). Set provenance: user|agent|inferred_untrusted|verified.",
    inputSchema: objectSchema(
      {
        path: {
          type: "string",
          description: "Path relative to the memory directory.",
        },
        content: { type: "string", description: "Full file contents to write." },
        provenance: {
          type: "string",
          enum: ["user", "agent", "inferred_untrusted", "verified"],
          description: "Where this memory came from.",
        },
      },
      ["path", "content"],
    ),
  },
  {
    name: "set_followup",
    description: "Schedule a one-shot follow-up that wakes via the inbox.",
    inputSchema: objectSchema({
      inSeconds: {
        type: "number",
        description: "Seconds from now until the follow-up fires.",
      },
      in_seconds: {
        type: "number",
        description: "Alias of inSeconds.",
      },
      note: { type: "string", description: "Why this follow-up exists." },
    }),
  },
  {
    name: "notify_user",
    description: "Enqueue a user-visible message through the outbox.",
    inputSchema: objectSchema(
      {
        text: { type: "string", description: "Message the user should see." },
      },
      ["text"],
    ),
  },
  {
    name: "request_approval",
    description:
      "Defer a high-risk action until an authenticated approval event arrives. Stored args are executed later — not regenerated.",
    inputSchema: objectSchema({
      action: {
        type: "string",
        description: "Tool to run after approval. Defaults to send_external.",
      },
      args: {
        type: "object",
        description:
          "Stored arguments. For send_external include to, subject, and body.",
        additionalProperties: true,
      },
      reason: { type: "string", description: "Why approval is required." },
    }),
  },
  {
    name: "record_silence",
    description: "Explicitly choose not to message the user; records a reason.",
    inputSchema: objectSchema({
      reason: { type: "string", description: "Why nothing was sent." },
    }),
  },
  {
    name: "mark_progress_complete",
    description:
      "Mark a progress file complete only if the verifier passes (evidence required).",
    inputSchema: objectSchema(
      {
        path: {
          type: "string",
          description: "Progress file relative to the memory directory.",
        },
      },
      ["path"],
    ),
  },
  {
    name: "proxied_request",
    description:
      "Request an outbound HTTPS call via credential proxy (always deferred for approval).",
    inputSchema: objectSchema(
      {
        url: {
          type: "string",
          description: "HTTPS URL. Other schemes are rejected.",
        },
        method: { type: "string", description: "HTTP method. Defaults to POST." },
        credential: {
          type: "string",
          description: "Named credential the proxy injects. Defaults to api.",
        },
        headers: {
          type: "object",
          description: "Extra request headers. Authorization is injected by the proxy.",
          additionalProperties: { type: "string" },
        },
        body: { type: "string", description: "Optional request body." },
      },
      ["url"],
    ),
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
