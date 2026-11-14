import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../src/runtime.js";
import { insertEvent } from "../src/inbox/store.js";
import { createFollowup, fireDueTimers } from "../src/timers/store.js";
import { resolveDeferredCall } from "../src/permissions/defer.js";
import { acquireLease } from "../src/worker/lease.js";

let dir: string;
let runtime: Runtime;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "aoa-"));
  runtime = createRuntime({
    config: {
      dataDir: dir,
      minFollowupSeconds: 0,
      workerIdleMs: 10,
      schedulerIntervalMs: 10,
      dispatcherIntervalMs: 10,
      maxRunsPerDay: 1000,
    },
  });
});

afterEach(() => {
  runtime.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("always-on architecture acceptance", () => {
  it("dedupes the same webhook twice into one inbox row", () => {
    const a = insertEvent(runtime.db, {
      source: "webhook",
      sourceId: "delivery-1",
      payload: { hello: true },
    });
    const b = insertEvent(runtime.db, {
      source: "webhook",
      sourceId: "delivery-1",
      payload: { hello: true },
    });
    expect(a.inserted).toBe(true);
    expect(b.inserted).toBe(false);
    expect(b.event?.id).toBe(a.event?.id);

    const count = runtime.db
      .prepare(`SELECT COUNT(*) AS c FROM events`)
      .get() as { c: number };
    expect(count.c).toBe(1);
  });

  it("reclaims a crashed running event and retries", async () => {
    const { event } = insertEvent(runtime.db, {
      source: "webhook",
      sourceId: "crash-1",
      sessionKey: "s-crash",
      payload: { text: "please acknowledge this" },
    });
    runtime.db
      .prepare(`UPDATE events SET status = 'running', attempts = 1 WHERE id = ?`)
      .run(event!.id);

    await runtime.runOnce();

    const row = runtime.db
      .prepare(`SELECT status, attempts FROM events WHERE id = ?`)
      .get(event!.id) as { status: string; attempts: number };
    expect(row.status).toBe("done");
    expect(row.attempts).toBeGreaterThanOrEqual(1);
  });

  it("follow-up timer becomes an inbox event then a run", async () => {
    createFollowup(runtime.db, {
      dueAt: new Date(Date.now() - 1000),
      note: "check back",
      sessionKey: "s-timer",
      minFollowupSeconds: 0,
      maxActiveFollowups: 20,
    });

    const fired = fireDueTimers(runtime.db);
    expect(fired).toBe(1);

    const pending = runtime.db
      .prepare(`SELECT * FROM events WHERE source = 'timer' AND status = 'pending'`)
      .all();
    expect(pending.length).toBe(1);

    await runtime.runOnce();
    const done = runtime.db
      .prepare(`SELECT status FROM events WHERE source = 'timer'`)
      .get() as { status: string };
    expect(done.status).toBe("done");
  });

  it("batches three rapid messages into one session run", async () => {
    for (const id of ["m1", "m2", "m3"]) {
      insertEvent(runtime.db, {
        source: "user",
        sourceId: id,
        sessionKey: "thread-1",
        payload: { text: `message ${id}` },
      });
    }

    await runtime.runOnce();

    const runs = runtime.db
      .prepare(`SELECT * FROM run_log WHERE session_key = 'thread-1'`)
      .all() as Array<{ event_ids: string }>;
    expect(runs.length).toBe(1);
    expect(JSON.parse(runs[0]!.event_ids)).toEqual([1, 2, 3]);
  });

  it("defers high-risk action and resumes with stored args after approval", async () => {
    insertEvent(runtime.db, {
      source: "user",
      sourceId: "risk-1",
      sessionKey: "s-risk",
      payload: { text: "please email anyone about the launch" },
    });

    await runtime.runOnce();

    const deferred = runtime.db
      .prepare(`SELECT * FROM deferred_calls`)
      .get() as { id: string; status: string; arguments_json: string };
    expect(deferred.status).toBe("pending");

    const approvalMsgs = runtime.db
      .prepare(`SELECT * FROM outbox WHERE channel = 'approval'`)
      .all() as Array<{ status: string }>;
    expect(approvalMsgs.length).toBeGreaterThan(0);
    // runOnce drains the dispatcher, so the approval request is already sent
    expect(approvalMsgs.some((m) => m.status === "sent")).toBe(true);

    resolveDeferredCall(runtime.db, { id: deferred.id, decision: "approved" });
    insertEvent(runtime.db, {
      source: "approval",
      sourceId: `${deferred.id}:approved`,
      sessionKey: "s-risk",
      payload: { type: "approval", deferredId: deferred.id, decision: "approved" },
    });

    await runtime.runOnce();

    const notified = runtime.db
      .prepare(`SELECT body, status FROM outbox WHERE channel = 'log'`)
      .all() as Array<{ body: string; status: string }>;
    expect(
      notified.some(
        (m) =>
          /Approved action completed/i.test(m.body) &&
          (m.status === "sent" || m.status === "pending"),
      ),
    ).toBe(true);

    // Stored args were what we deferred with
    expect(JSON.parse(deferred.arguments_json)).toMatchObject({
      to: "other@example.com",
    });
  });

  it("records silence for duplicate / non-actionable content", async () => {
    insertEvent(runtime.db, {
      source: "news",
      sourceId: "n1",
      sessionKey: "s-news",
      payload: { text: "duplicate headline already reported" },
    });
    await runtime.runOnce();

    const run = runtime.db
      .prepare(`SELECT outcome, silence_reason FROM run_log ORDER BY id DESC LIMIT 1`)
      .get() as { outcome: string; silence_reason: string };
    expect(run.outcome).toBe("silence");
    expect(run.silence_reason.length).toBeGreaterThan(0);

    const logMsgs = runtime.db
      .prepare(`SELECT COUNT(*) AS c FROM outbox WHERE channel = 'log'`)
      .get() as { c: number };
    expect(logMsgs.c).toBe(0);
  });

  it("honors STOP kill switch for worker and scheduler", async () => {
    writeFileSync(runtime.config.stopPath, "stop\n");
    expect(existsSync(runtime.config.stopPath)).toBe(true);

    insertEvent(runtime.db, {
      source: "user",
      sourceId: "stopped-1",
      payload: { text: "should not run" },
    });
    createFollowup(runtime.db, {
      dueAt: new Date(Date.now() - 1000),
      note: "should not fire into processing while stopped — scheduler also checks STOP",
      minFollowupSeconds: 0,
      maxActiveFollowups: 20,
    });

    await runtime.runOnce();

    const event = runtime.db
      .prepare(`SELECT status FROM events WHERE source_id = 'stopped-1'`)
      .get() as { status: string };
    expect(event.status).toBe("pending");

    // Scheduler skips while STOP is set, so timer stays active and no timer event
    const timerEvents = runtime.db
      .prepare(`SELECT COUNT(*) AS c FROM events WHERE source = 'timer'`)
      .get() as { c: number };
    expect(timerEvents.c).toBe(0);
  });

  it("allows only one active worker lease per inbox", () => {
    const a = acquireLease(runtime.db, "default", "worker-a");
    const b = acquireLease(runtime.db, "default", "worker-b");
    expect(a).not.toBeNull();
    expect(b).toBeNull();
  });
});
