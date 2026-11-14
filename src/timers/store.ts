import type { Db } from "../db.js";
import { nowIso } from "../db.js";
import { insertEvent } from "../inbox/store.js";

export type TimerKind = "followup" | "schedule";

export type TimerRow = {
  id: number;
  inbox_id: string;
  kind: TimerKind;
  due_at: string;
  every_s: number | null;
  session_key: string | null;
  payload: string;
  status: "active" | "done" | "cancelled";
  created_at: string;
  updated_at: string;
};

export function countActiveFollowups(db: Db, inboxId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM timers
       WHERE inbox_id = ? AND kind = 'followup' AND status = 'active'`,
    )
    .get(inboxId) as { c: number };
  return Number(row.c);
}

export function createFollowup(
  db: Db,
  opts: {
    inboxId?: string;
    dueAt: Date;
    sessionKey?: string | null;
    note: string;
    minFollowupSeconds: number;
    maxActiveFollowups: number;
  },
): TimerRow {
  const inboxId = opts.inboxId ?? "default";
  const earliest = Date.now() + opts.minFollowupSeconds * 1000;
  const dueMs = Math.max(opts.dueAt.getTime(), earliest);
  if (countActiveFollowups(db, inboxId) >= opts.maxActiveFollowups) {
    throw new Error(`follow-up cap reached (${opts.maxActiveFollowups})`);
  }

  const result = db
    .prepare(
      `INSERT INTO timers (inbox_id, kind, due_at, session_key, payload)
       VALUES (?, 'followup', ?, ?, ?)`,
    )
    .run(
      inboxId,
      new Date(dueMs).toISOString(),
      opts.sessionKey ?? null,
      JSON.stringify({ note: opts.note }),
    );

  return db
    .prepare(`SELECT * FROM timers WHERE id = ?`)
    .get(Number(result.lastInsertRowid)) as TimerRow;
}

export function createSchedule(
  db: Db,
  opts: {
    inboxId?: string;
    dueAt: Date;
    everyS: number;
    sessionKey?: string | null;
    payload: unknown;
  },
): TimerRow {
  const result = db
    .prepare(
      `INSERT INTO timers (inbox_id, kind, due_at, every_s, session_key, payload)
       VALUES (?, 'schedule', ?, ?, ?, ?)`,
    )
    .run(
      opts.inboxId ?? "default",
      opts.dueAt.toISOString(),
      opts.everyS,
      opts.sessionKey ?? null,
      JSON.stringify(opts.payload),
    );
  return db
    .prepare(`SELECT * FROM timers WHERE id = ?`)
    .get(Number(result.lastInsertRowid)) as TimerRow;
}

/**
 * Fire due timers into the inbox. Misfire policy for schedules: skip to next
 * slot after now (no backlog storms).
 */
export function fireDueTimers(db: Db, now = new Date()): number {
  const due = db
    .prepare(
      `SELECT * FROM timers
       WHERE status = 'active' AND due_at <= ?
       ORDER BY due_at ASC
       LIMIT 100`,
    )
    .all(now.toISOString()) as TimerRow[];

  let fired = 0;
  for (const timer of due) {
    const sourceId = `${timer.id}:${timer.due_at}`;
    insertEvent(db, {
      inboxId: timer.inbox_id,
      source: "timer",
      sourceId,
      sessionKey: timer.session_key,
      payload: {
        timerId: timer.id,
        kind: timer.kind,
        dueAt: timer.due_at,
        body: JSON.parse(timer.payload),
      },
    });

    if (timer.kind === "followup") {
      db.prepare(
        `UPDATE timers SET status = 'done', updated_at = ? WHERE id = ?`,
      ).run(nowIso(), timer.id);
    } else {
      const every = timer.every_s ?? 86_400;
      let next = new Date(timer.due_at).getTime() + every * 1000;
      while (next <= now.getTime()) {
        next += every * 1000;
      }
      db.prepare(
        `UPDATE timers SET due_at = ?, updated_at = ? WHERE id = ?`,
      ).run(new Date(next).toISOString(), nowIso(), timer.id);
    }
    fired += 1;
  }
  return fired;
}
