import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { isStopped } from "../stop.js";
import {
  claimPendingOutbox,
  markOutboxFailed,
  markOutboxSent,
  markOutboxSuppressed,
  reclaimStaleSending,
} from "./store.js";

export type DeliverFn = (msg: {
  id: number;
  channel: string;
  body: string;
  meta: Record<string, unknown>;
}) => Promise<void> | void;

export async function runDispatcher(opts: {
  db: Db;
  config: Config;
  deliver?: DeliverFn;
  once?: boolean;
  signal?: AbortSignal;
}): Promise<number> {
  const deliver =
    opts.deliver ??
    ((msg) => {
      console.log(
        JSON.stringify({
          type: "outbox.delivery",
          id: msg.id,
          channel: msg.channel,
          body: msg.body,
          meta: msg.meta,
        }),
      );
    });

  let sent = 0;

  const tick = async () => {
    if (isStopped(opts.config)) return 0;
    reclaimStaleSending(opts.db);
    const pending = claimPendingOutbox(opts.db);
    let n = 0;
    for (const row of pending) {
      try {
        const meta = JSON.parse(row.meta) as Record<string, unknown>;
        if (!row.body.trim()) {
          markOutboxSuppressed(opts.db, row.id, "empty body");
          continue;
        }
        await deliver({
          id: row.id,
          channel: row.channel,
          body: row.body,
          meta,
        });
        markOutboxSent(opts.db, row.id);
        n += 1;
      } catch (err) {
        markOutboxFailed(
          opts.db,
          row.id,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    return n;
  };

  if (opts.once) return tick();

  while (!opts.signal?.aborted) {
    sent += await tick();
    await sleep(opts.config.dispatcherIntervalMs);
  }
  return sent;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
