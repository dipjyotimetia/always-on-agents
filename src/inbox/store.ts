import type { Db } from "../db.js";
import { nowIso, withTransaction } from "../db.js";

export type EventStatus = "pending" | "running" | "done" | "failed" | "dead";

export type InboxEvent = {
  id: number;
  inbox_id: string;
  source: string;
  source_id: string;
  session_key: string | null;
  payload: string;
  status: EventStatus;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export type InsertEventInput = {
  inboxId?: string;
  source: string;
  sourceId: string;
  sessionKey?: string | null;
  payload: unknown;
  maxAttempts?: number;
};

export function insertEvent(
  db: Db,
  input: InsertEventInput,
): { inserted: boolean; event: InboxEvent | null } {
  const inboxId = input.inboxId ?? "default";
  const payload =
    typeof input.payload === "string" ? input.payload : JSON.stringify(input.payload);

  const result = db
    .prepare(
      `INSERT OR IGNORE INTO events
        (inbox_id, source, source_id, session_key, payload, max_attempts)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      inboxId,
      input.source,
      input.sourceId,
      input.sessionKey ?? null,
      payload,
      input.maxAttempts ?? 3,
    );

  if (result.changes === 0) {
    const existing = db
      .prepare(
        `SELECT * FROM events WHERE inbox_id = ? AND source = ? AND source_id = ?`,
      )
      .get(inboxId, input.source, input.sourceId) as InboxEvent | undefined;
    return { inserted: false, event: existing ?? null };
  }

  const event = db
    .prepare(
      `SELECT * FROM events WHERE inbox_id = ? AND source = ? AND source_id = ?`,
    )
    .get(inboxId, input.source, input.sourceId) as InboxEvent;
  return { inserted: true, event };
}

/** Reclaim stale running events into pending with backoff, or dead-letter. */
export function reclaimStaleRunning(db: Db, inboxId: string): number {
  return withTransaction(db, () => {
    const now = nowIso();
    const stale = db
      .prepare(
        `SELECT * FROM events WHERE inbox_id = ? AND status = 'running'`,
      )
      .all(inboxId) as InboxEvent[];

    let n = 0;
    for (const event of stale) {
      if (event.attempts >= event.max_attempts) {
        db.prepare(
          `UPDATE events
           SET status = 'dead',
               last_error = COALESCE(last_error, 'exceeded max attempts'),
               updated_at = ?
           WHERE id = ?`,
        ).run(now, event.id);
      } else {
        // Crash reclaim is immediate; soft-fail backoff is applied in markEventsFailed.
        db.prepare(
          `UPDATE events
           SET status = 'pending',
               next_attempt_at = NULL,
               last_error = 'reclaimed after worker crash',
               updated_at = ?
           WHERE id = ?`,
        ).run(now, event.id);
      }
      n += 1;
    }
    return n;
  });
}

/**
 * Atomically claim a batch of ready pending events (BEGIN IMMEDIATE).
 * Increments attempts on claim.
 */
export function claimPendingBatch(
  db: Db,
  inboxId: string,
  limit = 50,
): InboxEvent[] {
  return withTransaction(db, () => {
    const now = nowIso();
    const pending = db
      .prepare(
        `SELECT * FROM events
         WHERE inbox_id = ?
           AND status = 'pending'
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY created_at ASC, id ASC
         LIMIT ?`,
      )
      .all(inboxId, now, limit) as InboxEvent[];

    if (pending.length === 0) return [];

    const ids = pending.map((e) => e.id);
    const placeholders = ids.map(() => "?").join(",");
    db.prepare(
      `UPDATE events
       SET status = 'running',
           attempts = attempts + 1,
           updated_at = ?
       WHERE id IN (${placeholders})`,
    ).run(now, ...ids);

    return db
      .prepare(`SELECT * FROM events WHERE id IN (${placeholders}) ORDER BY created_at ASC, id ASC`)
      .all(...ids) as InboxEvent[];
  });
}

export function markEventsDone(db: Db, ids: number[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(
    `UPDATE events SET status = 'done', updated_at = ?, next_attempt_at = NULL
     WHERE id IN (${placeholders})`,
  ).run(nowIso(), ...ids);
}

/** Soft-fail with backoff; dead-letter after max attempts. */
export function markEventsFailed(db: Db, ids: number[], error: string): void {
  if (ids.length === 0) return;
  const now = nowIso();
  for (const id of ids) {
    const row = db.prepare(`SELECT * FROM events WHERE id = ?`).get(id) as
      | InboxEvent
      | undefined;
    if (!row) continue;
    if (row.attempts >= row.max_attempts) {
      db.prepare(
        `UPDATE events
         SET status = 'dead', last_error = ?, updated_at = ?, next_attempt_at = NULL
         WHERE id = ?`,
      ).run(error, now, id);
    } else {
      const backoffSec = Math.min(300, 2 ** row.attempts);
      const next = new Date(Date.now() + backoffSec * 1000).toISOString();
      db.prepare(
        `UPDATE events
         SET status = 'pending',
             last_error = ?,
             next_attempt_at = ?,
             updated_at = ?
         WHERE id = ?`,
      ).run(error, next, now, id);
    }
  }
}

export function reopenDead(db: Db, id: number): void {
  db.prepare(
    `UPDATE events
     SET status = 'pending', attempts = 0, next_attempt_at = NULL,
         last_error = NULL, updated_at = ?
     WHERE id = ? AND status = 'dead'`,
  ).run(nowIso(), id);
}

export function countByStatus(db: Db, inboxId: string): Record<string, number> {
  const rows = db
    .prepare(
      `SELECT status, COUNT(*) AS c FROM events WHERE inbox_id = ? GROUP BY status`,
    )
    .all(inboxId) as Array<{ status: string; c: number }>;
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = Number(r.c);
  return out;
}

export function groupBySessionKey(events: InboxEvent[]): Map<string, InboxEvent[]> {
  const groups = new Map<string, InboxEvent[]>();
  for (const event of events) {
    const key = event.session_key ?? `ephemeral:${event.id}`;
    const list = groups.get(key) ?? [];
    list.push(event);
    groups.set(key, list);
  }
  return groups;
}
