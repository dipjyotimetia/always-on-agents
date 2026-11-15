import type { Db } from "../db.js";

/** Fixed-window rate limiter stored in SQLite. */
export function checkRateLimit(
  db: Db,
  bucket: string,
  limitPerMinute: number,
): { allowed: boolean; remaining: number } {
  const window = Math.floor(Date.now() / 60_000);
  const row = db
    .prepare(`SELECT window_start, count FROM rate_limits WHERE bucket = ?`)
    .get(bucket) as { window_start: number; count: number } | undefined;

  if (!row || row.window_start !== window) {
    db.prepare(
      `INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT(bucket) DO UPDATE SET window_start = excluded.window_start, count = 1`,
    ).run(bucket, window);
    return { allowed: true, remaining: limitPerMinute - 1 };
  }

  if (row.count >= limitPerMinute) {
    return { allowed: false, remaining: 0 };
  }

  db.prepare(
    `UPDATE rate_limits SET count = count + 1 WHERE bucket = ? AND window_start = ?`,
  ).run(bucket, window);
  return { allowed: true, remaining: limitPerMinute - row.count - 1 };
}
