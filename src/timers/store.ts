import type { Db } from "../db.js";
import { nowIso, withTransaction } from "../db.js";
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
 * Fire due timers into the inbox inside one IMMEDIATE transaction per timer.
 * Schedule misfire policy: skip to next slot after now (no backlog storms).
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
    withTransaction(db, () => {
      // Re-read under lock to avoid double-fire
      const fresh = db
        .prepare(`SELECT * FROM timers WHERE id = ?`)
        .get(timer.id) as TimerRow | undefined;
      if (!fresh || fresh.status !== "active") return;
      if (new Date(fresh.due_at).getTime() > now.getTime()) return;

      const sourceId = `${fresh.id}:${fresh.due_at}`;
      insertEvent(db, {
        inboxId: fresh.inbox_id,
        source: "timer",
        sourceId,
        sessionKey: fresh.session_key,
        payload: {
          timerId: fresh.id,
          kind: fresh.kind,
          dueAt: fresh.due_at,
          body: JSON.parse(fresh.payload),
        },
      });

      if (fresh.kind === "followup") {
        db.prepare(
          `UPDATE timers SET status = 'done', updated_at = ? WHERE id = ?`,
        ).run(nowIso(), fresh.id);
      } else {
        const every = fresh.every_s ?? 86_400;
        let next = new Date(fresh.due_at).getTime() + every * 1000;
        while (next <= now.getTime()) {
          next += every * 1000;
        }
        db.prepare(
          `UPDATE timers SET due_at = ?, updated_at = ? WHERE id = ?`,
        ).run(new Date(next).toISOString(), nowIso(), fresh.id);
      }
      fired += 1;
    });
  }
  return fired;
}
