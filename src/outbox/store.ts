import type { Db } from "../db.js";
import { nowIso, withTransaction } from "../db.js";

export type OutboxMessage = {
  id: number;
  inbox_id: string;
  channel: string;
  body: string;
  meta: string;
  idempotency_key: string | null;
  status: "pending" | "sending" | "sent" | "failed" | "suppressed";
  attempts: number;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
};

export function enqueueOutbox(
  db: Db,
  opts: {
    inboxId?: string;
    channel?: string;
    body: string;
    meta?: Record<string, unknown>;
    idempotencyKey?: string;
  },
): OutboxMessage {
  const inboxId = opts.inboxId ?? "default";
  const key = opts.idempotencyKey ?? null;
  const result = db
    .prepare(
      `INSERT INTO outbox (inbox_id, channel, body, meta, idempotency_key)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT(inbox_id, idempotency_key) DO NOTHING`,
    )
    .run(
      inboxId,
      opts.channel ?? "log",
      opts.body,
      JSON.stringify(opts.meta ?? {}),
      key,
    );
  if (result.changes === 0) {
    return db.query<OutboxMessage, [string, string | null]>(
      "SELECT * FROM outbox WHERE inbox_id = ? AND idempotency_key = ?",
    ).get(inboxId, key)!;
  }
  return db
    .prepare(`SELECT * FROM outbox WHERE id = ?`)
    .get(Number(result.lastInsertRowid)) as OutboxMessage;
}

/** Atomically claim pending messages by moving them to `sending`. */
export function claimPendingOutbox(db: Db, limit = 20): OutboxMessage[] {
  return withTransaction(db, () => {
    const pending = db
      .prepare(
        `SELECT * FROM outbox WHERE status = 'pending'
         AND (attempts = 0 OR julianday(updated_at) + (1 << MIN(attempts, 8)) / 86400.0 <= julianday('now'))
         ORDER BY id ASC LIMIT ?`,
      )
      .all(limit) as OutboxMessage[];
    if (pending.length === 0) return [];

    const ids = pending.map((m) => m.id);
    const placeholders = ids.map(() => "?").join(",");
    const now = nowIso();
    db.prepare(
      `UPDATE outbox
       SET status = 'sending', attempts = attempts + 1, updated_at = ?
       WHERE id IN (${placeholders})`,
    ).run(now, ...ids);

    return db
      .prepare(`SELECT * FROM outbox WHERE id IN (${placeholders})`)
      .all(...ids) as OutboxMessage[];
  });
}

/** Reclaim stuck sending rows (dispatcher crash). */
export function reclaimStaleSending(db: Db, olderThanMs = 60_000): number {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  const result = db
    .prepare(
      `UPDATE outbox
       SET status = CASE WHEN attempts >= 5 THEN 'failed' ELSE 'pending' END, updated_at = ?
       WHERE status = 'sending' AND updated_at < ?`,
    )
    .run(nowIso(), cutoff);
  return Number(result.changes);
}

export function finishOutboxAttempt(
  db: Db,
  row: OutboxMessage,
  result: { type: "sent" } | { type: "suppressed"; reason: string } | { type: "failed"; reason: string },
): boolean {
  const now = nowIso();
  const status = result.type === "failed" && row.attempts < 5 ? "pending" : result.type;
  let meta: unknown;
  try {
    meta = JSON.parse(row.meta);
  } catch {
    meta = {};
  }
  const updated = db.prepare(
    `UPDATE outbox SET status = ?, updated_at = ?, sent_at = ?, meta = ?
     WHERE id = ? AND status = 'sending' AND attempts = ? AND updated_at = ?`,
  ).run(status, now, result.type === "sent" ? now : null,
    result.type === "sent" ? row.meta : JSON.stringify({ ...asObject(meta), error: result.reason }),
    row.id, row.attempts, row.updated_at);
  return updated.changes === 1;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
