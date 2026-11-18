import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Brain } from "../src/agent/types.js";
import { insertEvent } from "../src/inbox/store.js";
import type { Delivery } from "../src/outbox/dispatcher.js";
import { createCredentialStore } from "../src/permissions/proxy.js";
import { createRuntime, type Runtime } from "../src/runtime.js";
import { fireDueTimers } from "../src/timers/store.js";
import { listRoutineHistory, saveRoutine, setRoutinePaused, testRoutine } from "../src/timers/routines.js";
import { acquireLease } from "../src/worker/lease.js";

let dataDir: string;
let runtime: Runtime | undefined;

beforeEach(() => { dataDir = mkdtempSync(path.join(tmpdir(), "aoa-reliability-")); });
afterEach(() => {
  runtime?.close();
  runtime = undefined;
  rmSync(dataDir, { recursive: true, force: true });
});

function config() {
  return { dataDir, brain: "mock" as const, approvalSecret: "test-operator-secret" };
}

describe("runtime reliability", () => {
  it("keeps an active lease through a long model call and cancels before a tool call on STOP", async () => {
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => { started = resolve; });
    let runSignal: AbortSignal | undefined;
    let release!: () => void;
    const provider = new Promise<void>((resolve) => { release = resolve; });
    const brain: Brain = {
      async complete({ signal }) {
        runSignal = signal;
        started();
        await provider;
        return { type: "tool_calls", toolCalls: [
          { id: "notify", name: "notify_user", arguments: { text: "should not enqueue" } },
        ] };
      },
    };
    runtime = createRuntime({ config: { ...config(), leaseTtlMs: 250 }, brain });
    insertEvent(runtime.db, { source: "user", sourceId: "stopped", payload: {} });
    const running = runtime.runOnce();
    await inFlight;
    await delay(350);
    expect(acquireLease(runtime.db, "default")).toBeNull();
    writeFileSync(runtime.config.stopPath, "");
    try {
      await running;
      expect(runSignal?.aborted).toBe(true);
    } finally {
      release();
    }
    expect(runtime.db.query<{ status: string }, []>("SELECT status FROM events").get()?.status).toBe("pending");
    expect(runtime.db.query("SELECT id FROM outbox").all()).toEqual([]);
  });

  it("rejects a stale worker after another owner takes over", async () => {
    let started!: () => void;
    let complete!: (value: Awaited<ReturnType<Brain["complete"]>>) => void;
    const inFlight = new Promise<void>((resolve) => { started = resolve; });
    const result = new Promise<Awaited<ReturnType<Brain["complete"]>>>((resolve) => {
      complete = resolve;
    });
    runtime = createRuntime({ config: config(), brain: {
      complete() { started(); return result; },
    } });
    insertEvent(runtime.db, { source: "user", sourceId: "takeover", payload: {} });
    const running = runtime.runOnce();
    await inFlight;
    runtime.db.prepare("UPDATE leases SET expires_at = ? WHERE inbox_id = 'default'")
      .run("2000-01-01T00:00:00.000Z");
    expect(acquireLease(runtime.db, "default", { owner: "replacement" })).not.toBeNull();
    complete({ type: "tool_calls", toolCalls: [
      { id: "notify", name: "notify_user", arguments: { text: "stale work" } },
    ] });
    await expect(running).rejects.toThrow("stale lease fence");
    expect(runtime.db.query("SELECT id FROM outbox").all()).toEqual([]);
    expect(runtime.db.query<{ status: string }, []>("SELECT status FROM events").get()?.status)
      .toBe("running");
  });

  it("times out a provider that ignores cancellation and leaves the event retryable", async () => {
    const brain: Brain = { complete: () => new Promise(() => {}) };
    runtime = createRuntime({ config: { ...config(), maxWallMsPerRun: 40 }, brain });
    insertEvent(runtime.db, { source: "user", sourceId: "timeout", payload: {} });
    await runtime.runOnce();
    const event = runtime.db.query<{ status: string; next_attempt_at: string | null }, []>(
      "SELECT status, next_attempt_at FROM events",
    ).get();
    expect(event?.status).toBe("pending");
    expect(event?.next_attempt_at).toBeTruthy();
  });

  it("scopes credentials to a configured endpoint and method", () => {
    const store = createCredentialStore({ api: "synthetic-test-token" }, {
      api: { url: "https://service.example.test/v1/write", methods: ["POST"] },
    });
    expect(store.allows("api", new URL("https://service.example.test/v1/write"), "POST")).toBe(true);
    expect(store.allows("api", new URL("https://service.example.test/v1/write"), "GET")).toBe(false);
  });

  it("preserves editable routines, pause state and per-routine history", async () => {
    const calls: string[] = [];
    const brain: Brain = {
      async complete({ messages }) {
        calls.push(messages.find((message) => message.role === "system")?.content ?? "");
        return { type: "message", content: "" };
      },
    };
    runtime = createRuntime({ config: { ...config(), agentName: "Operations" }, brain });
    const routine = saveRoutine(runtime.db, { name: "digest", everySeconds: 60, instruction: "Check release status" });
    setRoutinePaused(runtime.db, "digest", true);
    expect(fireDueTimers(runtime.db, new Date(Date.now() + 120_000))).toBe(0);
    const edited = saveRoutine(runtime.db, { name: "digest", everySeconds: 120, instruction: "Review release notes" });
    expect(edited.timer_id).toBe(routine.timer_id);
    expect(edited.status).toBe("cancelled");
    testRoutine(runtime.db, "digest");
    await runtime.runOnce();
    expect(calls[0]).toContain("Operations");
    expect(calls[0]).toContain("Review release notes");
    expect(listRoutineHistory(runtime.db, "digest")[0]?.status).toBe("done");
    setRoutinePaused(runtime.db, "digest", false);
    expect(fireDueTimers(runtime.db, new Date(Date.now() + 180_000))).toBe(1);
  });

  it("delivers approved work through the configured connector and reuses the delivery key on retry", async () => {
    const deliveries: Array<{ key: string | null; message: Delivery }> = [];
    let failFirstExternal = true;
    const connector = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        const message = await request.json() as Delivery;
        deliveries.push({ key: request.headers.get("idempotency-key"), message });
        if (message.channel === "external" && failFirstExternal) {
          failFirstExternal = false;
          return new Response(null, { status: 503 });
        }
        return new Response(null, { status: 204 });
      },
    });
    runtime = createRuntime({ config: { ...config(), deliveryWebhookUrl: connector.url.href } });
    const server = runtime.startHttp();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("HTTP server unavailable");
      const url = `http://127.0.0.1:${address.port}/events/approval`;
      insertEvent(runtime.db, { source: "user", sourceId: "ask", sessionKey: "email",
        payload: { text: "please email anyone" } });
      await runtime.runOnce();
      const deferredId = runtime.db.query<{ id: string }, []>("SELECT id FROM deferred_calls").get()?.id;
      expect(deferredId).toBeTruthy();
      const decision = (value: string) => fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-approval-secret": "test-operator-secret" },
        body: JSON.stringify({ deferredId, decision: value }),
      });
      expect((await decision("typo")).status).toBe(400);
      runtime.db.exec(`CREATE TEMP TRIGGER reject_approval_insert BEFORE INSERT ON events
        WHEN NEW.source = 'approval' BEGIN SELECT RAISE(ABORT, 'test write failure'); END;`);
      expect((await decision("approved")).status).toBe(500);
      expect(runtime.db.query<{ status: string }, []>("SELECT status FROM deferred_calls").get()?.status)
        .toBe("pending");
      runtime.db.exec("DROP TRIGGER reject_approval_insert");
      expect((await decision("approved")).status).toBe(200);
      expect((await decision("approved")).status).toBe(200);
      await runtime.runOnce();
      const state = () => runtime?.db.query<{ status: string }, []>(
        "SELECT status FROM outbox WHERE channel = 'external'",
      ).get()?.status;
      expect(state()).toBe("pending");
      runtime.db.prepare("UPDATE outbox SET updated_at = ? WHERE channel = 'external'")
        .run("2000-01-01T00:00:00.000Z");
      await runtime.runOnce();
      expect(state()).toBe("sent");
      const external = deliveries.filter(({ message }) => message.channel === "external");
      expect(external).toHaveLength(2);
      expect(external[0]?.key).toBeTruthy();
      expect(external[1]?.key).toBe(external[0]?.key);
      expect(deliveries[0]?.message.meta).not.toHaveProperty("arguments");
    } finally {
      await connector.stop(true);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
