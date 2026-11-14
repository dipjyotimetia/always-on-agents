import type { Db } from "./db.js";

export function dayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function getRunsToday(db: Db, inboxId: string): number {
  const row = db
    .prepare(`SELECT runs FROM daily_budget WHERE day = ? AND inbox_id = ?`)
    .get(dayKey(), inboxId) as { runs: number } | undefined;
  return row?.runs ?? 0;
}

export function incrementRunsToday(db: Db, inboxId: string): number {
  const day = dayKey();
  db.prepare(
    `INSERT INTO daily_budget (day, inbox_id, runs) VALUES (?, ?, 1)
     ON CONFLICT(day, inbox_id) DO UPDATE SET runs = runs + 1`,
  ).run(day, inboxId);
  return getRunsToday(db, inboxId);
}

export function underDailyBudget(
  db: Db,
  inboxId: string,
  maxRunsPerDay: number,
): boolean {
  return getRunsToday(db, inboxId) < maxRunsPerDay;
}
