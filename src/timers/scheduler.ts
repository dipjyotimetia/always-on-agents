import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { isStopped } from "../stop.js";
import { fireDueTimers } from "./store.js";

export async function runScheduler(opts: {
  db: Db;
  config: Config;
  once?: boolean;
  signal?: AbortSignal;
  onFire?: (count: number) => void;
}): Promise<number> {
  let total = 0;

  const tick = () => {
    if (isStopped(opts.config)) return 0;
    const n = fireDueTimers(opts.db);
    if (n > 0) opts.onFire?.(n);
    return n;
  };

  if (opts.once) {
    return tick();
  }

  while (!opts.signal?.aborted) {
    total += tick();
    await sleep(opts.config.schedulerIntervalMs);
  }
  return total;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
