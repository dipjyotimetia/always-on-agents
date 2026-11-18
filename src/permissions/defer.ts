import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import { nowIso } from "../db.js";

export type DeferredCall = {
  id: string;
  inbox_id: string;
  session_key: string;
  tool_name: string;
  arguments_json: string;
  status:
    | "pending"
    | "approved"
    | "denied"
    | "expired"
    | "executed"
    | "failed";
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
  executed_at: string | null;
  result_json: string | null;
};

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export function createDeferredCall(
  db: Db,
  opts: {
    inboxId?: string;
    sessionKey: string;
    toolName: string;
    args: unknown;
    ttlMs?: number;
  },
): DeferredCall {
  const id = randomUUID();
  const expires = new Date(Date.now() + (opts.ttlMs ?? DEFAULT_TTL_MS)).toISOString();
  db.prepare(
    `INSERT INTO deferred_calls
      (id, inbox_id, session_key, tool_name, arguments_json, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.inboxId ?? "default",
    opts.sessionKey,
    opts.toolName,
    JSON.stringify(opts.args),
    expires,
  );
  return db.prepare(`SELECT * FROM deferred_calls WHERE id = ?`).get(id) as DeferredCall;
}

export function getDeferredCall(db: Db, id: string): DeferredCall | null {
  return (
    (db.prepare(`SELECT * FROM deferred_calls WHERE id = ?`).get(id) as
      | DeferredCall
      | undefined) ?? null
  );
}

export class ApprovalConflict extends Error {}

export function resolveDeferredCall(
  db: Db,
  opts: { id: string; decision: "approved" | "denied" },
): DeferredCall {
  const row = getDeferredCall(db, opts.id);
  if (!row) throw new ApprovalConflict("unknown deferred call");
  if (row.status === opts.decision ||
      (opts.decision === "approved" && (row.status === "executed" || row.status === "failed"))) {
    return row;
  }
  const now = nowIso();
  const result = db.prepare(
    `UPDATE deferred_calls SET status = ?, resolved_at = ?
     WHERE id = ? AND status = 'pending' AND expires_at > ?`,
  ).run(opts.decision, now, opts.id, now);
  if (result.changes !== 1) throw new ApprovalConflict("deferred call is no longer pending");
  return getDeferredCall(db, opts.id)!;
}

export function markDeferredExecuted(
  db: Db,
  id: string,
  result: unknown,
): void {
  db.prepare(
    `UPDATE deferred_calls
     SET status = 'executed', executed_at = ?, result_json = ?
     WHERE id = ?`,
  ).run(nowIso(), JSON.stringify(result), id);
}

export function markDeferredFailed(db: Db, id: string, error: string): void {
  db.prepare(
    `UPDATE deferred_calls
     SET status = 'failed', executed_at = ?, result_json = ?
     WHERE id = ?`,
  ).run(nowIso(), JSON.stringify({ error }), id);
}

/** Expire pending deferred calls past expires_at. */
export function expireDeferredCalls(db: Db): number {
  const result = db
    .prepare(
      `UPDATE deferred_calls
       SET status = 'expired', resolved_at = ?
       WHERE status = 'pending' AND expires_at <= ?`,
    )
    .run(nowIso(), nowIso());
  return Number(result.changes);
}

/** Dangerous-action classifier (auto mode stand-in). */
export function classifyRisk(
  toolName: string,
  args: Record<string, unknown>,
): "allow" | "block" | "defer" {
  if (
    toolName === "request_approval" ||
    toolName === "send_external" ||
    toolName === "proxied_request"
  ) {
    return "defer";
  }
  if (toolName === "mark_progress_complete") {
    return "allow";
  }
  if (toolName === "shell" || toolName === "bash") {
    const cmd = String(args.command ?? "");
    if (
      /\b(rm\s+-rf|mkfs|dd\s+if=|curl\s+[^\n]*\|\s*(ba)?sh|wget\s+[^\n]*\|\s*(ba)?sh|chmod\s+777)\b/i.test(
        cmd,
      )
    ) {
      return "block";
    }
    if (/\b(curl|wget|nc|ncat|ssh|scp)\b/i.test(cmd)) {
      return "defer";
    }
  }
  if (toolName === "write_memory") {
    const prov = String(args.provenance ?? "");
    const p = String(args.path ?? "");
    if (p === "instructions.md") return "block";
    if (prov === "user" && !p.startsWith("notes/preferences")) return "defer";
  }
  return "allow";
}
