import type { Server } from "node:http";
import { loadConfig, type Config } from "./config.js";
import { openDb, type Db } from "./db.js";
import { ensureMemoryLayout } from "./memory/store.js";
import { brainLabel, createBrain } from "./agent/factory.js";
import type { Brain } from "./agent/types.js";
import { createIngressServer } from "./http/handler.js";
import { runWorker } from "./worker/worker.js";
import { runScheduler } from "./timers/scheduler.js";
import { runDispatcher } from "./outbox/dispatcher.js";
import { createCredentialStore, type CredentialStore } from "./permissions/proxy.js";
import { expireDeferredCalls } from "./permissions/defer.js";
import { WakeBus } from "./worker/wake.js";

export type Runtime = {
  config: Config;
  db: Db;
  brain: Brain;
  credentials: CredentialStore;
  wake: WakeBus;
  startHttp(): Server;
  runOnce(): Promise<void>;
  startAll(signal?: AbortSignal): Promise<void>;
  close(): void;
};

export function createRuntime(opts: {
  config?: Partial<Config>;
  brain?: Brain;
  credentials?: CredentialStore;
} = {}): Runtime {
  const config = loadConfig(opts.config ?? {});
  ensureMemoryLayout(config.memoryDir);
  const db = openDb(config.dbPath);
  const credentials = opts.credentials ?? createCredentialStore();
  const wake = new WakeBus();

  const brain = opts.brain ?? createBrain(config);
  const label = brainLabel(config);

  return {
    config,
    db,
    brain,
    credentials,
    wake,
    startHttp() {
      return createIngressServer({
        db,
        config,
        onEvent: () => wake.signal(),
      });
    },
    async runOnce() {
      expireDeferredCalls(db);
      await runScheduler({ db, config, once: true });
      await runWorker({ db, config, brain, credentials, once: true, wake });
      await runDispatcher({ db, config, once: true });
    },
    async startAll(signal) {
      const server = createIngressServer({
        db,
        config,
        onEvent: () => wake.signal(),
      });
      await new Promise<void>((resolve) => {
        server.listen(config.port, config.host, () => resolve());
      });
      console.log(
        JSON.stringify({
          type: "runtime.listening",
          host: config.host,
          port: config.port,
          brain: label.brain,
          model: label.model,
        }),
      );

      const sweeper = setInterval(() => {
        if (signal?.aborted) return;
        expireDeferredCalls(db);
      }, Math.max(config.schedulerIntervalMs, 5_000));

      await Promise.all([
        runWorker({ db, config, brain, credentials, signal, wake }),
        runScheduler({ db, config, signal }),
        runDispatcher({ db, config, signal }),
        waitAbort(signal).finally(() => {
          clearInterval(sweeper);
          server.close();
        }),
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
