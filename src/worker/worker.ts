import { setTimeout as delay } from "node:timers/promises";
import type { Config } from "../config.js";
import { withTransaction, type Db } from "../db.js";
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
  assertFence,
  heartbeatLease,
  releaseLease,
} from "./lease.js";
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
  const acquired = acquireLease(opts.db, inboxId, {
    ttlMs: opts.config.leaseTtlMs,
  });
  if (!acquired) {
    throw new Error(`inbox ${inboxId} already leased by another worker`);
  }

  const lease = acquired;
  const ownership = new AbortController();
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, ownership.signal])
    : ownership.signal;
  const heartbeat = () => {
    try {
      if (!heartbeatLease(opts.db, lease, opts.config.leaseTtlMs)) {
        throw new Error("lost lease fence");
      }
    } catch (error) {
      ownership.abort(error);
    }
  };
  const renewal = setInterval(heartbeat, Math.max(1, Math.floor(opts.config.leaseTtlMs / 3)));
  let batches = 0;
  try {
    fenced(() => reclaimStaleRunning(opts.db, inboxId));
    do {
      if (signal.aborted) break;
      const did = await processOnce({ ...opts, signal }, inboxId, fenced);
      if (did) batches += 1;
      else if (!opts.once) await idle({ ...opts, signal });
    } while (!opts.once);
    ownership.signal.throwIfAborted();
  } finally {
    clearInterval(renewal);
    releaseLease(opts.db, lease);
  }

  function fenced<T>(work: () => T): T {
    return withTransaction(opts.db, () => {
      assertFence(opts.db, lease);
      return work();
    });
  }

  return { batches };
}

async function processOnce(
  opts: WorkerOptions & { signal: AbortSignal },
  inboxId: string,
  fenced: <T>(work: () => T) => T,
): Promise<boolean> {
  const { db, config, signal } = opts;
  const canRun = () => !signal.aborted && !isStopped(config);
  const withinBudget = () => underDailyBudget(
    db, inboxId, config.maxRunsPerDay, config.maxTokensPerDay,
  );
  if (!canRun() || !withinBudget()) return false;

  const pending = fenced(() => claimPendingBatch(db, inboxId));
  if (pending.length === 0) return false;
  const unprocessed = new Set(pending.map((event) => event.id));
  const stop = new AbortController();
  const runSignal = AbortSignal.any([signal, stop.signal]);
  const watchStop = setInterval(() => {
    if (isStopped(config)) stop.abort(new Error("runtime stopped"));
  }, 100);

  try {
    for (const [sessionKey, events] of groupBySessionKey(pending)) {
      for (const batch of splitControlEvents(events)) {
        if (!canRun() || !withinBudget()) return true;
        const ids = batch.map((event) => event.id);
        const guard = <T>(work: () => T) => fenced(() => {
          runSignal.throwIfAborted();
          if (isStopped(config)) {
            stop.abort(new Error("runtime stopped"));
            runSignal.throwIfAborted();
          }
          return work();
        });
        try {
          guard(() => incrementRunsToday(db, inboxId));
          await runAgent({
            db, config, brain: opts.brain, credentials: opts.credentials,
            inboxId, sessionKey, events: batch, signal: runSignal, guard,
            onCommit: (outcome) => {
              if (outcome.type === "error") markEventsFailed(db, ids, outcome.error);
              else markEventsDone(db, ids);
            },
            onUsage: (usage) => fenced(() =>
              addTokensToday(db, inboxId, usage.inputTokens + usage.outputTokens)),
          });
        } catch (error) {
          if (runSignal.aborted) return true;
          fenced(() => markEventsFailed(
            db, ids, error instanceof Error ? error.message : String(error),
          ));
        }
        for (const id of ids) unprocessed.delete(id);
      }
    }
    return true;
  } finally {
    clearInterval(watchStop);
    if (unprocessed.size > 0) {
      fenced(() => {
        const reset = db.prepare(
          "UPDATE events SET status = 'pending', attempts = attempts - 1 WHERE id = ? AND status = 'running'",
        );
        for (const id of unprocessed) reset.run(id);
      });
    }
  }
}

function splitControlEvents(events: InboxEvent[]): InboxEvent[][] {
  const batches: InboxEvent[][] = [];
  let regular: InboxEvent[] = [];
  for (const event of events) {
    if (event.source === "approval" || event.source === "routine") {
      if (regular.length > 0) batches.push(regular);
      batches.push([event]);
      regular = [];
    } else {
      regular.push(event);
    }
  }
  if (regular.length > 0) batches.push(regular);
  return batches;
}

async function idle(opts: WorkerOptions): Promise<void> {
  if (opts.wake) {
    await opts.wake.wait(opts.config.workerIdleMs, opts.signal);
    return;
  }
  await delay(opts.config.workerIdleMs, undefined, { signal: opts.signal })
    .catch((error: unknown) => { if (!opts.signal?.aborted) throw error; });
}
