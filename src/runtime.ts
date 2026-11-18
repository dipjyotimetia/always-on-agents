import { setTimeout as delay } from "node:timers/promises";
import type { Server } from "node:http";
import { loadConfig, type Config } from "./config.js";
import { openDb, type Db } from "./db.js";
import { ensureMemoryLayout } from "./memory/store.js";
import { brainLabel, createBrain } from "./agent/factory.js";
import type { Brain } from "./agent/types.js";
import { createIngressServer } from "./http/handler.js";
import { runWorker } from "./worker/worker.js";
import { runScheduler } from "./timers/scheduler.js";
import { createWebhookDelivery, runDispatcher, type DeliverFn } from "./outbox/dispatcher.js";
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
  deliver?: DeliverFn;
} = {}): Runtime {
  const config = loadConfig(opts.config ?? {});
  ensureMemoryLayout(config.memoryDir);
  const deliver = opts.deliver ?? (config.deliveryWebhookUrl
    ? createWebhookDelivery(config.deliveryWebhookUrl) : undefined);
  const brain = opts.brain ?? createBrain(config);
  const db = openDb(config.dbPath);
  const credentials = opts.credentials ?? createCredentialStore();
  const wake = new WakeBus();

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
      await runDispatcher({ db, config, deliver, once: true });
    },
    async startAll(signal) {
      const server = createIngressServer({
        db,
        config,
        onEvent: () => wake.signal(),
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      console.log(JSON.stringify({
        type: "runtime.listening", host: config.host, port: config.port,
        brain: label.brain, model: label.model,
      }));

      const shutdown = new AbortController();
      const serviceSignal = signal ? AbortSignal.any([signal, shutdown.signal]) : shutdown.signal;
      const jobs = [
        runWorker({ db, config, brain, credentials, signal: serviceSignal, wake }),
        runScheduler({ db, config, signal: serviceSignal, onFire: () => wake.signal() }),
        runDispatcher({ db, config, deliver, signal: serviceSignal }),
        sweepApprovals(db, config, serviceSignal),
      ];
      try {
        await Promise.all(jobs);
      } finally {
        shutdown.abort();
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        server.closeAllConnections();
        await Promise.allSettled([...jobs, closed]);
      }
    },
    close() {
      db.close();
    },
  };
}

async function sweepApprovals(db: Db, config: Config, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    expireDeferredCalls(db);
    await delay(Math.max(config.schedulerIntervalMs, 5_000), undefined, { signal })
      .catch((error: unknown) => { if (!signal.aborted) throw error; });
  }
}
