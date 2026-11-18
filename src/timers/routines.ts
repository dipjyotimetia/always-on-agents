import { randomUUID } from "node:crypto";
import { nowIso, withTransaction, type Db } from "../db.js";
import { insertEvent, type InboxEvent } from "../inbox/store.js";
import { createSchedule } from "./store.js";

export type Routine = {
  name: string;
  instruction: string;
  timer_id: number;
  due_at: string;
  every_s: number;
  status: "active" | "cancelled";
};

const selectRoutine = `SELECT r.name, r.instruction, r.timer_id, t.due_at, t.every_s, t.status
  FROM routines r JOIN timers t ON t.id = r.timer_id`;

export function listRoutines(db: Db): Routine[] {
  return db.query<Routine, []>(`${selectRoutine} ORDER BY r.name`).all();
}

function getRoutine(db: Db, name: string): Routine {
  const routine = db.query<Routine, [string]>(`${selectRoutine} WHERE r.name = ?`).get(name);
  if (!routine) throw new Error(`Unknown routine: ${name}`);
  return routine;
}

export function saveRoutine(db: Db, opts: {
  name: string;
  instruction: string;
  everySeconds: number;
}): Routine {
  const { name, everySeconds } = opts;
  const instruction = opts.instruction.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) {
    throw new Error("Routine name must contain 1–64 letters, digits, underscores or hyphens");
  }
  if (!instruction || instruction.length > 8_000) {
    throw new Error("Routine instruction must contain 1–8,000 characters");
  }
  if (!Number.isSafeInteger(everySeconds) || everySeconds < 1 || everySeconds > 31_536_000) {
    throw new Error("Routine interval must be from 1 second to 1 year");
  }
  return withTransaction(db, () => {
    const existing = db.query<{ timer_id: number }, [string]>(
      "SELECT timer_id FROM routines WHERE name = ?",
    ).get(name);
    const dueAt = new Date(Date.now() + everySeconds * 1000);
    if (existing) {
      db.prepare("UPDATE routines SET instruction = ? WHERE name = ?").run(instruction, name);
      db.prepare("UPDATE timers SET due_at = ?, every_s = ?, updated_at = ? WHERE id = ?")
        .run(dueAt.toISOString(), everySeconds, nowIso(), existing.timer_id);
    } else {
      const timer = createSchedule(db, {
        dueAt, everyS: everySeconds, sessionKey: `routine:${name}`, payload: { name },
      });
      db.prepare("INSERT INTO routines (name, instruction, timer_id) VALUES (?, ?, ?)")
        .run(name, instruction, timer.id);
    }
    return getRoutine(db, name);
  });
}

export function setRoutinePaused(db: Db, name: string, paused: boolean): Routine {
  return withTransaction(db, () => {
    const routine = getRoutine(db, name);
    const status = paused ? "cancelled" : "active";
    if (routine.status === status) return routine;
    const due = new Date(Date.now() + routine.every_s * 1000).toISOString();
    db.prepare("UPDATE timers SET status = ?, due_at = ?, updated_at = ? WHERE id = ?")
      .run(status, due, nowIso(), routine.timer_id);
    return getRoutine(db, name);
  });
}

export function testRoutine(db: Db, name: string): InboxEvent {
  const routine = getRoutine(db, name);
  const result = insertEvent(db, {
    source: "routine",
    sourceId: `test:${randomUUID()}`,
    sessionKey: `routine:${routine.name}`,
    payload: { name: routine.name, instruction: routine.instruction, trigger: "test" },
  });
  if (!result.event) throw new Error("Could not queue routine test");
  return result.event;
}

export function listRoutineHistory(db: Db, name: string) {
  const routine = getRoutine(db, name);
  return db.query<{
    event_id: number;
    status: InboxEvent["status"];
    attempts: number;
    last_error: string | null;
    outcome: string | null;
    created_at: string;
  }, [string]>(
    `SELECT e.id AS event_id, e.status, e.attempts, e.last_error, e.created_at,
        (SELECT l.outcome FROM run_log l, json_each(l.event_ids) ids
          WHERE l.session_key = e.session_key AND ids.value = e.id ORDER BY l.id DESC LIMIT 1) AS outcome
     FROM events e WHERE e.source = 'routine' AND e.session_key = ? ORDER BY e.id DESC LIMIT 20`,
  ).all(`routine:${routine.name}`);
}
