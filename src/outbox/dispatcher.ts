import { setTimeout as delay } from "node:timers/promises";
import { abortable } from "../abort.js";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { isStopped } from "../stop.js";
import { claimPendingOutbox, finishOutboxAttempt, reclaimStaleSending } from "./store.js";

export type Delivery = {
  id: number;
  inboxId: string;
  channel: string;
  body: string;
  meta: Record<string, unknown>;
  idempotencyKey: string;
};

export type DeliverFn = (message: Delivery, signal: AbortSignal) => Promise<void> | void;

export function createWebhookDelivery(endpoint: string): DeliverFn {
  const url = new URL(endpoint);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username || url.password || url.hash) {
    throw new Error("Delivery endpoint must be HTTPS or a loopback HTTP URL");
  }
  return async (message, signal) => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": message.idempotencyKey,
      },
      body: JSON.stringify(message),
      redirect: "error",
      signal,
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`delivery returned HTTP ${response.status}`);
  };
}

export async function runDispatcher(opts: {
  db: Db;
  config: Config;
  deliver?: DeliverFn;
  once?: boolean;
  signal?: AbortSignal;
}): Promise<number> {
  const { db, config, signal, deliver } = opts;
  if (!deliver) return 0;
  const instance = db.query<{ value: string }, []>(
    "SELECT value FROM schema_meta WHERE key = 'instance_id'",
  ).get();
  if (!instance) throw new Error("missing outbox instance id");
  let sent = 0;
  const canDeliver = () => !signal?.aborted && !isStopped(config);
  do {
    if (canDeliver()) {
      reclaimStaleSending(db, Math.max(60_000, config.deliveryTimeoutMs * 2));
      for (let count = 0; count < 20 && canDeliver(); count++) {
        const [row] = claimPendingOutbox(db, 1);
        if (!row) break;
        if (!row.body.trim()) {
          finishOutboxAttempt(db, row, { type: "suppressed", reason: "empty body" });
          continue;
        }
        const timeout = AbortSignal.timeout(config.deliveryTimeoutMs);
        const stop = new AbortController();
        const deliverySignal = AbortSignal.any(signal
          ? [signal, timeout, stop.signal] : [timeout, stop.signal]);
        const watcher = setInterval(() => {
          if (isStopped(config)) stop.abort(new Error("runtime stopped"));
        }, 100);
        try {
          const parsed: unknown = JSON.parse(row.meta);
          const meta = parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed as Record<string, unknown> : {};
          // The detailed approval remains in the authenticated operator UI.
          const deliveryMeta = { ...meta };
          if (row.channel === "approval") delete deliveryMeta.arguments;
          await abortable(deliverySignal, async () => deliver({
            id: row.id,
            inboxId: row.inbox_id,
            channel: row.channel,
            body: row.body,
            meta: deliveryMeta,
            idempotencyKey: `aoa:${instance.value}:${row.id}`,
          }, deliverySignal));
          if (finishOutboxAttempt(db, row, { type: "sent" })) sent++;
        } catch (error) {
          const reason = error instanceof Error ? error.message : "delivery failed";
          finishOutboxAttempt(db, row, { type: "failed", reason });
        } finally {
          clearInterval(watcher);
        }
      }
    }
    if (!opts.once && !signal?.aborted) {
      await delay(config.dispatcherIntervalMs, undefined, { signal }).catch((error: unknown) => {
        if (!signal?.aborted) throw error;
      });
    }
  } while (!opts.once && !signal?.aborted);
  return sent;
}
