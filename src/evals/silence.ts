import type { Db } from "../db.js";

export type SilenceEvalRow = {
  id: number;
  session_key: string | null;
  silence_reason: string | null;
  created_at: string;
  /** Optional human label: good_silence | missed_notify | noisy */
  label?: string;
};

/**
 * Export recent silence outcomes for offline labeling / attention tuning.
 */
export function listSilences(
  db: Db,
  opts: { limit?: number; inboxId?: string } = {},
): SilenceEvalRow[] {
  return db
    .prepare(
      `SELECT id, session_key, silence_reason, created_at
       FROM run_log
       WHERE outcome = 'silence'
         AND (? IS NULL OR inbox_id = ?)
       ORDER BY id DESC
       LIMIT ?`,
    )
    .all(opts.inboxId ?? null, opts.inboxId ?? null, opts.limit ?? 50) as SilenceEvalRow[];
}

export function silenceStats(db: Db, inboxId = "default"): {
  totalRuns: number;
  silences: number;
  notifies: number;
  deferred: number;
  silenceRate: number;
} {
  const rows = db
    .prepare(
      `SELECT outcome, COUNT(*) AS c FROM run_log WHERE inbox_id = ? GROUP BY outcome`,
    )
    .all(inboxId) as Array<{ outcome: string; c: number }>;
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.outcome] = Number(r.c);
  const totalRuns = Object.values(counts).reduce((a, b) => a + b, 0);
  const silences = counts.silence ?? 0;
  return {
    totalRuns,
    silences,
    notifies: counts.notified ?? 0,
    deferred: counts.deferred ?? 0,
    silenceRate: totalRuns === 0 ? 0 : silences / totalRuns,
  };
}
