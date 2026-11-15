import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import { nowIso, withTransaction } from "../db.js";

export type Lease = {
  inboxId: string;
  owner: string;
  fence: number;
};

/**
 * Acquire lease with compare-and-swap on expiry and a monotonically increasing fence.
 * All subsequent heartbeats must present the same fence.
 */
export function acquireLease(
  db: Db,
  inboxId: string,
  opts: { owner?: string; ttlMs?: number } = {},
): Lease | null {
  const owner = opts.owner ?? randomUUID();
  const ttlMs = opts.ttlMs ?? 30_000;

  return withTransaction(db, () => {
    const now = Date.now();
    const expires = new Date(now + ttlMs).toISOString();
    const nowIsoStr = new Date(now).toISOString();

    const existing = db
      .prepare(`SELECT * FROM leases WHERE inbox_id = ?`)
      .get(inboxId) as
      | { inbox_id: string; owner: string; fence: number; expires_at: string }
      | undefined;

    if (!existing) {
      db.prepare(
        `INSERT INTO leases (inbox_id, owner, fence, heartbeat_at, expires_at)
         VALUES (?, ?, 1, ?, ?)`,
      ).run(inboxId, owner, nowIsoStr, expires);
      return { inboxId, owner, fence: 1 };
    }

    if (existing.owner === owner) {
      db.prepare(
        `UPDATE leases SET heartbeat_at = ?, expires_at = ? WHERE inbox_id = ? AND owner = ? AND fence = ?`,
      ).run(nowIsoStr, expires, inboxId, owner, existing.fence);
      return { inboxId, owner, fence: existing.fence };
    }

    if (new Date(existing.expires_at).getTime() <= now) {
      const nextFence = existing.fence + 1;
      const result = db
        .prepare(
          `UPDATE leases
           SET owner = ?, fence = ?, heartbeat_at = ?, expires_at = ?
           WHERE inbox_id = ? AND fence = ? AND expires_at <= ?`,
        )
        .run(
          owner,
          nextFence,
          nowIsoStr,
          expires,
          inboxId,
          existing.fence,
          nowIsoStr,
        );
      if (Number(result.changes) !== 1) return null;
      return { inboxId, owner, fence: nextFence };
    }

    return null;
  });
}

export function heartbeatLease(
  db: Db,
  lease: Lease,
  ttlMs = 30_000,
): boolean {
  const expires = new Date(Date.now() + ttlMs).toISOString();
  const result = db
    .prepare(
      `UPDATE leases
       SET heartbeat_at = ?, expires_at = ?
       WHERE inbox_id = ? AND owner = ? AND fence = ?`,
    )
    .run(nowIso(), expires, lease.inboxId, lease.owner, lease.fence);
  return Number(result.changes) === 1;
}

export function releaseLease(db: Db, lease: Lease): void {
  db.prepare(
    `DELETE FROM leases WHERE inbox_id = ? AND owner = ? AND fence = ?`,
  ).run(lease.inboxId, lease.owner, lease.fence);
}

export function assertFence(db: Db, lease: Lease): void {
  const row = db
    .prepare(`SELECT owner, fence FROM leases WHERE inbox_id = ?`)
    .get(lease.inboxId) as { owner: string; fence: number } | undefined;
  if (!row || row.owner !== lease.owner || row.fence !== lease.fence) {
    throw new Error(`stale lease fence for inbox ${lease.inboxId}`);
  }
}
