import type { Db } from "../db.js";
import { nowIso } from "../db.js";

export type EventStatus = "pending" | "running" | "done" | "failed";

export type InboxEvent = {
  id: number;
  inbox_id: string;
  source: string;
  source_id: string;
  session_key: string | null;
  payload: string;
  status: EventStatus;
  attempts: number;
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
      `INSERT OR IGNORE INTO events (inbox_id, source, source_id, session_key, payload)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(inboxId, input.source, input.sourceId, input.sessionKey ?? null, payload);

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

export function reclaimStaleRunning(db: Db, inboxId: string, maxAttempts = 3): number {
  const now = nowIso();
  const failed = db
    .prepare(
      `UPDATE events
       SET status = 'failed',
           last_error = COALESCE(last_error, 'exceeded max attempts after crash'),
           updated_at = ?
       WHERE inbox_id = ? AND status = 'running' AND attempts >= ?`,
    )
    .run(now, inboxId, maxAttempts);

  const reset = db
    .prepare(
      `UPDATE events
       SET status = 'pending',
           attempts = attempts + 1,
           updated_at = ?,
           last_error = 'reclaimed after worker crash'
       WHERE inbox_id = ? AND status = 'running' AND attempts < ?`,
    )
    .run(now, inboxId, maxAttempts);

  return Number(failed.changes) + Number(reset.changes);
}

export function claimPendingBatch(
  db: Db,
  inboxId: string,
  limit = 50,
): InboxEvent[] {
  const pending = db
    .prepare(
      `SELECT * FROM events
       WHERE inbox_id = ? AND status = 'pending'
       ORDER BY created_at ASC
       LIMIT ?`,
    )
    .all(inboxId, limit) as InboxEvent[];

  if (pending.length === 0) return [];

  const now = nowIso();
  const ids = pending.map((e) => e.id);
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(
    `UPDATE events SET status = 'running', updated_at = ? WHERE id IN (${placeholders})`,
  ).run(now, ...ids);

  return db
    .prepare(`SELECT * FROM events WHERE id IN (${placeholders})`)
    .all(...ids) as InboxEvent[];
}

export function markEventsDone(db: Db, ids: number[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(
    `UPDATE events SET status = 'done', updated_at = ? WHERE id IN (${placeholders})`,
  ).run(nowIso(), ...ids);
}

export function markEventsFailed(db: Db, ids: number[], error: string): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  db.prepare(
    `UPDATE events
     SET status = 'failed', last_error = ?, updated_at = ?
     WHERE id IN (${placeholders})`,
  ).run(error, nowIso(), ...ids);
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
