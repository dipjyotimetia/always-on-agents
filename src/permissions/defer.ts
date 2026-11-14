import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import { nowIso } from "../db.js";

export type DeferredCall = {
  id: string;
  inbox_id: string;
  session_key: string;
  tool_name: string;
  arguments_json: string;
  status: "pending" | "approved" | "denied" | "expired";
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
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

/**
 * Resolve an approval against the *stored* arguments (never regenerate).
 * Expires stale pending calls.
 */
export function resolveDeferredCall(
  db: Db,
  opts: { id: string; decision: "approved" | "denied" },
): DeferredCall {
  const row = getDeferredCall(db, opts.id);
  if (!row) throw new Error(`unknown deferred call: ${opts.id}`);
  if (row.status !== "pending") {
    throw new Error(`deferred call ${opts.id} already ${row.status}`);
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    db.prepare(
      `UPDATE deferred_calls SET status = 'expired', resolved_at = ? WHERE id = ?`,
    ).run(nowIso(), opts.id);
    throw new Error(`deferred call ${opts.id} expired`);
  }
  db.prepare(
    `UPDATE deferred_calls SET status = ?, resolved_at = ? WHERE id = ?`,
  ).run(opts.decision, nowIso(), opts.id);
  return getDeferredCall(db, opts.id)!;
}

/** Dangerous-action heuristic classifier (auto mode stand-in). */
export function classifyRisk(
  toolName: string,
  args: Record<string, unknown>,
): "allow" | "block" | "defer" {
  if (toolName === "request_approval" || toolName === "send_external") {
    return "defer";
  }
  if (toolName === "shell") {
    const cmd = String(args.command ?? "");
    if (/\b(rm\s+-rf|mkfs|dd\s+if=|curl\s+[^\n]*\|\s*sh)\b/i.test(cmd)) {
      return "block";
    }
  }
  return "allow";
}
