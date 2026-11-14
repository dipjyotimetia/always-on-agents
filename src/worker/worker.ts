import type { Config } from "../config.js";
import type { Db } from "../db.js";
import {
  underDailyBudget,
  incrementRunsToday,
  addTokensToday,
} from "../budgets.js";
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
import {
  acquireLease,
  heartbeatLease,
  releaseLease,
  type Lease,
} from "./lease.js";
import { getDeferredCall } from "../permissions/defer.js";
import type { CredentialStore } from "../permissions/proxy.js";
import type { WakeBus } from "./wake.js";

export type WorkerOptions = {
  db: Db;
  config: Config;
  brain: Brain;
  credentials: CredentialStore;
  inboxId?: string;
  once?: boolean;
  signal?: AbortSignal;
  wake?: WakeBus;
};

export async function runWorker(opts: WorkerOptions): Promise<{ batches: number }> {
  const inboxId = opts.inboxId ?? "default";
  const lease = acquireLease(opts.db, inboxId, {
    ttlMs: opts.config.leaseTtlMs,
  });
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
        await idle(opts);
        continue;
      }
      if (!heartbeatLease(opts.db, lease, opts.config.leaseTtlMs)) {
        throw new Error("lost lease fence");
      }
      const did = await processOnce(opts, lease, inboxId);
      if (did) batches += 1;
      else await idle(opts);
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
  if (
    !underDailyBudget(
      opts.db,
      inboxId,
      opts.config.maxRunsPerDay,
      opts.config.maxTokensPerDay,
    )
  ) {
    return false;
  }

  const pending = claimPendingBatch(opts.db, inboxId);
  if (pending.length === 0) return false;

  if (!heartbeatLease(opts.db, lease, opts.config.leaseTtlMs)) {
    throw new Error("lost lease fence");
  }
  const groups = groupBySessionKey(pending);

  for (const [sessionKey, events] of groups) {
    try {
      const enriched = enrichApprovalEvents(opts.db, events);
      incrementRunsToday(opts.db, inboxId);
      const result = await runAgent({
        db: opts.db,
        config: opts.config,
        brain: opts.brain,
        credentials: opts.credentials,
        inboxId,
        sessionKey,
        events: enriched,
      });
      addTokensToday(
        opts.db,
        inboxId,
        result.usage.inputTokens + result.usage.outputTokens,
      );
      markEventsDone(
        opts.db,
        events.map((e) => e.id),
      );
      heartbeatLease(opts.db, lease, opts.config.leaseTtlMs);
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

async function idle(opts: WorkerOptions): Promise<void> {
  if (opts.wake) {
    await opts.wake.wait(opts.config.workerIdleMs, opts.signal);
    return;
  }
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, opts.config.workerIdleMs);
    opts.signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

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
