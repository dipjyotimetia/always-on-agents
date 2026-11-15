import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { getBacklogMetrics } from "../ops/metrics.js";
import { listSilences, silenceStats } from "../evals/silence.js";

export function getDashboardSnapshot(db: Db, config: Config) {
  const metrics = getBacklogMetrics(db, config);
  const events = db
    .prepare(
      `SELECT id, source, source_id, session_key, status, attempts, last_error, created_at
       FROM events ORDER BY id DESC LIMIT 25`,
    )
    .all();
  const runs = db
    .prepare(
      `SELECT id, session_key, outcome, silence_reason, tokens_in, tokens_out, created_at
       FROM run_log ORDER BY id DESC LIMIT 25`,
    )
    .all();
  const deferred = db
    .prepare(
      `SELECT id, tool_name, status, session_key, arguments_json, expires_at, created_at
       FROM deferred_calls
       WHERE status IN ('pending','approved','executed','failed','denied','expired')
       ORDER BY created_at DESC LIMIT 20`,
    )
    .all();
  const outbox = db
    .prepare(
      `SELECT id, channel, status, substr(body, 1, 160) AS body, created_at, sent_at
       FROM outbox ORDER BY id DESC LIMIT 20`,
    )
    .all();
  const timers = db
    .prepare(
      `SELECT id, kind, due_at, status, session_key, payload
       FROM timers WHERE status = 'active' ORDER BY due_at ASC LIMIT 15`,
    )
    .all();

  return {
    at: new Date().toISOString(),
    brain: config.anthropicApiKey ? "anthropic" : "mock",
    model: config.anthropicModel,
    metrics,
    silence: silenceStats(db),
    recentSilences: listSilences(db, { limit: 10 }),
    events,
    runs,
    deferred,
    outbox,
    timers,
  };
}
