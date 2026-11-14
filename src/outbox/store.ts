import type { Db } from "../db.js";
import { nowIso } from "../db.js";

export type OutboxMessage = {
  id: number;
  inbox_id: string;
  channel: string;
  body: string;
  meta: string;
  status: "pending" | "sent" | "failed" | "suppressed";
  attempts: number;
  created_at: string;
  sent_at: string | null;
};

export function enqueueOutbox(
  db: Db,
  opts: {
    inboxId?: string;
    channel?: string;
    body: string;
    meta?: Record<string, unknown>;
  },
): OutboxMessage {
  const result = db
    .prepare(
      `INSERT INTO outbox (inbox_id, channel, body, meta) VALUES (?, ?, ?, ?)`,
    )
    .run(
      opts.inboxId ?? "default",
      opts.channel ?? "log",
      opts.body,
      JSON.stringify(opts.meta ?? {}),
    );
  return db
    .prepare(`SELECT * FROM outbox WHERE id = ?`)
    .get(Number(result.lastInsertRowid)) as OutboxMessage;
}

export function claimPendingOutbox(db: Db, limit = 20): OutboxMessage[] {
  return db
    .prepare(
      `SELECT * FROM outbox WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?`,
    )
    .all(limit) as OutboxMessage[];
}

export function markOutboxSent(db: Db, id: number): void {
  db.prepare(
    `UPDATE outbox SET status = 'sent', sent_at = ?, attempts = attempts + 1 WHERE id = ?`,
  ).run(nowIso(), id);
}

export function markOutboxSuppressed(db: Db, id: number, reason: string): void {
  db.prepare(
    `UPDATE outbox
     SET status = 'suppressed',
         meta = json_set(COALESCE(meta, '{}'), '$.suppressReason', ?),
         attempts = attempts + 1
     WHERE id = ?`,
  ).run(reason, id);
}

export function markOutboxFailed(db: Db, id: number, error: string): void {
  db.prepare(
    `UPDATE outbox
     SET status = 'failed',
         meta = json_set(COALESCE(meta, '{}'), '$.error', ?),
         attempts = attempts + 1
     WHERE id = ?`,
  ).run(error, id);
}
