import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { countByStatus } from "../inbox/store.js";
import { isStopped } from "../stop.js";

export type BacklogMetrics = {
  stopped: boolean;
  stopPath: string;
  events: Record<string, number>;
  outboxPending: number;
  outboxSending: number;
  deferredPending: number;
  deferredExpired: number;
  activeFollowups: number;
  runsToday: number;
  tokensToday: number;
};

export function getBacklogMetrics(
  db: Db,
  config: Config,
  inboxId = "default",
): BacklogMetrics {
  const events = countByStatus(db, inboxId);
  const outboxPending = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM outbox WHERE status = 'pending'`)
      .get() as { c: number }
  ).c;
  const outboxSending = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM outbox WHERE status = 'sending'`)
      .get() as { c: number }
  ).c;
  const deferredPending = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM deferred_calls WHERE status = 'pending'`,
      )
      .get() as { c: number }
  ).c;
  const deferredExpired = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM deferred_calls WHERE status = 'expired'`,
      )
      .get() as { c: number }
  ).c;
  const activeFollowups = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM timers WHERE kind = 'followup' AND status = 'active'`,
      )
      .get() as { c: number }
  ).c;
  const day = new Date().toISOString().slice(0, 10);
  const budget = db
    .prepare(`SELECT runs, tokens FROM daily_budget WHERE day = ? AND inbox_id = ?`)
    .get(day, inboxId) as { runs: number; tokens: number } | undefined;

  return {
    stopped: isStopped(config),
    stopPath: config.stopPath,
    events,
    outboxPending: Number(outboxPending),
    outboxSending: Number(outboxSending),
    deferredPending: Number(deferredPending),
    deferredExpired: Number(deferredExpired),
    activeFollowups: Number(activeFollowups),
    runsToday: budget?.runs ?? 0,
    tokensToday: budget?.tokens ?? 0,
  };
}
