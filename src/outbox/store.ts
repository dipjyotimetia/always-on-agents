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
  if (key) {
    const existing = db
      .prepare(
        `SELECT * FROM outbox WHERE inbox_id = ? AND idempotency_key = ?`,
      )
      .get(inboxId, key) as OutboxMessage | undefined;
    if (existing) return existing;
  }

  const result = db
    .prepare(
      `INSERT INTO outbox (inbox_id, channel, body, meta, idempotency_key)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      inboxId,
      opts.channel ?? "log",
      opts.body,
      JSON.stringify(opts.meta ?? {}),
      key,
    );
  return db
    .prepare(`SELECT * FROM outbox WHERE id = ?`)
    .get(Number(result.lastInsertRowid)) as OutboxMessage;
}

/** Atomically claim pending messages by moving them to `sending`. */
export function claimPendingOutbox(db: Db, limit = 20): OutboxMessage[] {
  return withTransaction(db, () => {
    const pending = db
      .prepare(
        `SELECT * FROM outbox WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?`,
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
       SET status = 'pending', updated_at = ?
       WHERE status = 'sending' AND updated_at < ?`,
    )
    .run(nowIso(), cutoff);
  return Number(result.changes);
}

export function markOutboxSent(db: Db, id: number): void {
  db.prepare(
    `UPDATE outbox SET status = 'sent', sent_at = ? WHERE id = ?`,
  ).run(nowIso(), id);
}

export function markOutboxSuppressed(db: Db, id: number, reason: string): void {
  const row = db.prepare(`SELECT meta FROM outbox WHERE id = ?`).get(id) as
    | { meta: string }
    | undefined;
  const meta = safeMeta(row?.meta);
  meta.suppressReason = reason;
  db.prepare(
    `UPDATE outbox SET status = 'suppressed', meta = ? WHERE id = ?`,
  ).run(JSON.stringify(meta), id);
}

export function markOutboxFailed(db: Db, id: number, error: string): void {
  const row = db.prepare(`SELECT meta, attempts FROM outbox WHERE id = ?`).get(id) as
    | { meta: string; attempts: number }
    | undefined;
  const meta = safeMeta(row?.meta);
  meta.error = error;
  const attempts = row?.attempts ?? 1;
  // Retry a few times then leave failed
  const status = attempts >= 5 ? "failed" : "pending";
  db.prepare(`UPDATE outbox SET status = ?, meta = ? WHERE id = ?`).run(
    status,
    JSON.stringify(meta),
    id,
  );
}

function safeMeta(raw: string | undefined): Record<string, unknown> {
  try {
    return JSON.parse(raw ?? "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}
