import type { Server } from "node:http";
import { loadConfig, type Config } from "./config.js";
import { openDb, type Db } from "./db.js";
import { ensureMemoryLayout } from "./memory/store.js";
import { createMockBrain } from "./agent/mock-brain.js";
import type { Brain } from "./agent/types.js";
import { createIngressServer } from "./http/handler.js";
import { runWorker } from "./worker/worker.js";
import { runScheduler } from "./timers/scheduler.js";
import { runDispatcher } from "./outbox/dispatcher.js";

export type Runtime = {
  config: Config;
  db: Db;
  brain: Brain;
  startHttp(): Server;
  runOnce(): Promise<void>;
  startAll(signal?: AbortSignal): Promise<void>;
  close(): void;
};

export function createRuntime(opts: {
  config?: Partial<Config>;
  brain?: Brain;
} = {}): Runtime {
  const config = loadConfig(opts.config ?? {});
  ensureMemoryLayout(config.memoryDir);
  const db = openDb(config.dbPath);
  const brain = opts.brain ?? createMockBrain();

  return {
    config,
    db,
    brain,
    startHttp() {
      return createIngressServer({ db, config });
    },
    async runOnce() {
      await runScheduler({ db, config, once: true });
      await runWorker({ db, config, brain, once: true });
      await runDispatcher({ db, config, once: true });
    },
    async startAll(signal) {
      const server = createIngressServer({ db, config });
      await new Promise<void>((resolve) => {
        server.listen(config.port, config.host, () => resolve());
      });
      console.log(
        JSON.stringify({
          type: "runtime.listening",
          host: config.host,
          port: config.port,
        }),
      );

      await Promise.all([
        runWorker({ db, config, brain, signal }),
        runScheduler({ db, config, signal }),
        runDispatcher({ db, config, signal }),
        waitAbort(signal).finally(() => server.close()),
      ]);
    },
    close() {
      db.close();
    },
  };
}

function waitAbort(signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise(() => undefined);
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
