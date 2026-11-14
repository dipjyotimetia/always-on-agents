import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import { nowIso } from "../db.js";

const LEASE_TTL_MS = 30_000;

export type Lease = {
  inboxId: string;
  owner: string;
};

export function acquireLease(db: Db, inboxId: string, owner = randomUUID()): Lease | null {
  const now = Date.now();
  const expires = new Date(now + LEASE_TTL_MS).toISOString();
  const nowIsoStr = new Date(now).toISOString();

  const existing = db
    .prepare(`SELECT * FROM leases WHERE inbox_id = ?`)
    .get(inboxId) as
    | { inbox_id: string; owner: string; expires_at: string }
    | undefined;

  if (!existing) {
    db.prepare(
      `INSERT INTO leases (inbox_id, owner, heartbeat_at, expires_at) VALUES (?, ?, ?, ?)`,
    ).run(inboxId, owner, nowIsoStr, expires);
    return { inboxId, owner };
  }

  if (existing.owner === owner || new Date(existing.expires_at).getTime() <= now) {
    db.prepare(
      `UPDATE leases SET owner = ?, heartbeat_at = ?, expires_at = ? WHERE inbox_id = ?`,
    ).run(owner, nowIsoStr, expires, inboxId);
    return { inboxId, owner };
  }

  return null;
}

export function heartbeatLease(db: Db, lease: Lease): boolean {
  const expires = new Date(Date.now() + LEASE_TTL_MS).toISOString();
  const result = db
    .prepare(
      `UPDATE leases
       SET heartbeat_at = ?, expires_at = ?
       WHERE inbox_id = ? AND owner = ?`,
    )
    .run(nowIso(), expires, lease.inboxId, lease.owner);
  return Number(result.changes) === 1;
}

export function releaseLease(db: Db, lease: Lease): void {
  db.prepare(`DELETE FROM leases WHERE inbox_id = ? AND owner = ?`).run(
    lease.inboxId,
    lease.owner,
  );
}
