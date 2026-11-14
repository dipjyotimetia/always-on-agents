import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { underDailyBudget, incrementRunsToday } from "../budgets.js";
import {
  claimPendingBatch,
  groupBySessionKey,
  markEventsDone,
  markEventsFailed,
  reclaimStaleRunning,
  type InboxEvent,
} from "../inbox/store.js";
import { isStopped } from "../stop.js";
import type { Brain } from "../agent/types.js";
import { runAgent } from "../agent/loop.js";
import { acquireLease, heartbeatLease, releaseLease, type Lease } from "./lease.js";
import { getDeferredCall } from "../permissions/defer.js";

export type WorkerOptions = {
  db: Db;
  config: Config;
  brain: Brain;
  inboxId?: string;
  /** When true, process one batch and return (for tests). */
  once?: boolean;
  signal?: AbortSignal;
};

export async function runWorker(opts: WorkerOptions): Promise<{ batches: number }> {
  const inboxId = opts.inboxId ?? "default";
  const lease = acquireLease(opts.db, inboxId);
  if (!lease) {
    throw new Error(`inbox ${inboxId} already leased by another worker`);
  }

  reclaimStaleRunning(opts.db, inboxId);
  let batches = 0;

  try {
    if (opts.once) {
      batches += (await processOnce(opts, lease, inboxId)) ? 1 : 0;
      return { batches };
    }

    while (!opts.signal?.aborted) {
      if (isStopped(opts.config)) {
        await sleep(opts.config.workerIdleMs);
        continue;
      }
      heartbeatLease(opts.db, lease);
      const did = await processOnce(opts, lease, inboxId);
      if (did) batches += 1;
      else await sleep(opts.config.workerIdleMs);
    }
  } finally {
    releaseLease(opts.db, lease);
  }

  return { batches };
}

async function processOnce(
  opts: WorkerOptions,
  lease: Lease,
  inboxId: string,
): Promise<boolean> {
  if (isStopped(opts.config)) return false;
  if (!underDailyBudget(opts.db, inboxId, opts.config.maxRunsPerDay)) {
    return false;
  }

  const pending = claimPendingBatch(opts.db, inboxId);
  if (pending.length === 0) return false;

  heartbeatLease(opts.db, lease);
  const groups = groupBySessionKey(pending);

  for (const [sessionKey, events] of groups) {
    try {
      const enriched = enrichApprovalEvents(opts.db, events);
      incrementRunsToday(opts.db, inboxId);
      await runAgent({
        db: opts.db,
        config: opts.config,
        brain: opts.brain,
        inboxId,
        sessionKey,
        events: enriched,
      });
      markEventsDone(opts.db, events.map((e) => e.id));
    } catch (err) {
      markEventsFailed(
        opts.db,
        events.map((e) => e.id),
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return true;
}

/**
 * For approval events, attach the stored deferred-call arguments so the brain
 * resumes the *original* tool args, not a regenerated call.
 */
function enrichApprovalEvents(db: Db, events: InboxEvent[]): InboxEvent[] {
  return events.map((event) => {
    if (event.source !== "approval") return event;
    const payload = JSON.parse(event.payload) as {
      deferredId?: string;
      decision?: string;
    };
    if (!payload.deferredId) return event;
    const deferred = getDeferredCall(db, payload.deferredId);
    if (!deferred) return event;
    return {
      ...event,
      payload: JSON.stringify({
        ...payload,
        type: "approval",
        storedToolName: deferred.tool_name,
        storedArguments: JSON.parse(deferred.arguments_json),
        deferredStatus: deferred.status,
      }),
    };
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
