import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:http";
import type { Config } from "../config.js";
import { withTransaction, type Db } from "../db.js";
import { insertEvent } from "../inbox/store.js";
import { ApprovalConflict, resolveDeferredCall } from "../permissions/defer.js";
import { renderDashboardPage } from "../ui/page.js";
import { getDashboardSnapshot } from "../ui/snapshot.js";
import { checkRateLimit } from "./ratelimit.js";

export type HandlerDeps = {
  db: Db;
  config: Config;
  /** Optional wake hook after ingest */
  onEvent?: () => void;
};

export function createIngressServer(deps: HandlerDeps): Server {
  return createServer((req, res) => {
    void handle(deps, req, res);
  });
}

async function handle(
  deps: HandlerDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const client = String(req.socket.remoteAddress ?? "unknown");

    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { ok: true });
    }

    if (
      deps.config.enableUi &&
      req.method === "GET" &&
      (url.pathname === "/" || url.pathname === "/ui")
    ) {
      return html(res, 200, renderDashboardPage());
    }

    if (deps.config.enableUi && req.method === "GET" && url.pathname === "/api/dashboard") {
      if (!secretsEqual(String(req.headers["x-approval-secret"] ?? ""), deps.config.approvalSecret)) {
        return json(res, 401, { error: "operator authentication required" });
      }
      return json(res, 200, getDashboardSnapshot(deps.db, deps.config));
    }

    if (deps.config.enableUi && req.method === "POST" && url.pathname === "/api/control/stop") {
      const raw = await readRawBody(req, deps.config.maxBodyBytes);
      const body = parseBody(raw);
      const secret = String(body.secret ?? req.headers["x-approval-secret"] ?? "");
      if (!secretsEqual(secret, deps.config.approvalSecret)) {
        return json(res, 401, { error: "invalid approval secret" });
      }
      const stop = body.stop !== false && body.stop !== "false";
      if (stop) {
        writeFileSync(
          deps.config.stopPath,
          `stopped via ui at ${new Date().toISOString()}\n`,
        );
      } else if (existsSync(deps.config.stopPath)) {
        unlinkSync(deps.config.stopPath);
      }
      deps.onEvent?.();
      return json(res, 200, { ok: true, stopped: stop });
    }

    if (req.method === "GET" && url.pathname === "/metrics") {
      const { getBacklogMetrics } = await import("../ops/metrics.js");
      return json(res, 200, getBacklogMetrics(deps.db, deps.config));
    }

    if (req.method === "POST" && url.pathname === "/events") {
      const rl = checkRateLimit(
        deps.db,
        `events:${client}`,
        deps.config.rateLimitPerMinute,
      );
      if (!rl.allowed) return json(res, 429, { error: "rate limit exceeded" });

      const raw = await readRawBody(req, deps.config.maxBodyBytes);
      if (deps.config.requireWebhookSecret && !deps.config.webhookSecret) {
        return json(res, 500, { error: "webhook secret not configured" });
      }
      const operator = secretsEqual(String(req.headers["x-approval-secret"] ?? ""), deps.config.approvalSecret);
      if (deps.config.webhookSecret && !operator) {
        const sig = String(req.headers["x-signature"] ?? "");
        if (!verifySignature(deps.config.webhookSecret, raw, sig)) {
          return json(res, 401, { error: "invalid signature" });
        }
      }

      const body = parseBody(raw);
      const source = String(body.source ?? "webhook");
      if (source === "approval" || source === "timer" || source === "routine") {
        return json(res, 400, { error: "reserved event source" });
      }
      const sourceId = String(body.sourceId ?? body.id ?? "");
      if (!sourceId) return json(res, 400, { error: "sourceId required" });

      const sessionKey = typeof body.sessionKey === "string" && body.sessionKey ? body.sessionKey : null;
      if (sessionKey?.startsWith("routine:") || sessionKey?.startsWith("ephemeral:")) {
        return json(res, 400, { error: "reserved session key" });
      }
      const result = insertEvent(deps.db, {
        inboxId: String(body.inboxId ?? "default"),
        source,
        sourceId,
        sessionKey,
        payload: body.payload ?? body,
        maxAttempts: deps.config.eventMaxAttempts,
      });

      deps.onEvent?.();
      return json(res, 200, {
        ok: true,
        inserted: result.inserted,
        eventId: result.event?.id ?? null,
      });
    }

    if (req.method === "POST" && url.pathname === "/events/approval") {
      const rl = checkRateLimit(
        deps.db,
        `approval:${client}`,
        deps.config.rateLimitPerMinute,
      );
      if (!rl.allowed) return json(res, 429, { error: "rate limit exceeded" });

      const raw = await readRawBody(req, deps.config.maxBodyBytes);
      const body = parseBody(raw);
      const secret = String(body.secret ?? req.headers["x-approval-secret"] ?? "");
      if (!secretsEqual(secret, deps.config.approvalSecret)) {
        return json(res, 401, { error: "invalid approval secret" });
      }

      const deferredId = String(body.deferredId ?? "");
      const decision = body.decision;
      if (decision !== "approved" && decision !== "denied") {
        return json(res, 400, { error: "decision must be approved or denied" });
      }
      if (!deferredId) return json(res, 400, { error: "deferredId required" });

      const { deferred, result } = withTransaction(deps.db, () => {
        const deferred = resolveDeferredCall(deps.db, { id: deferredId, decision });
        const result = insertEvent(deps.db, {
          inboxId: deferred.inbox_id,
          source: "approval",
          sourceId: `${deferredId}:${decision}`,
          sessionKey: deferred.session_key,
          payload: { type: "approval", deferredId, decision },
        });
        return { deferred, result };
      });

      deps.onEvent?.();
      return json(res, 200, {
        ok: true,
        inserted: result.inserted,
        status: deferred.status,
        eventId: result.event?.id ?? null,
      });
    }

    json(res, 404, { error: "not found" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof SyntaxError ? 400 : message === "body too large" ? 413
      : err instanceof ApprovalConflict ? 409 : 500;
    json(res, status, { error: status === 500 ? "internal server error" : message });
  }
}

async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > maxBytes) throw new Error("body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function parseBody(raw: Buffer): Record<string, unknown> {
  const parsed: unknown = raw.length ? JSON.parse(raw.toString("utf8")) : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SyntaxError("expected a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

/** HMAC over the raw request body (not re-serialized JSON). */
function verifySignature(secret: string, rawBody: Buffer, header: string): boolean {
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const provided = header.replace(/^sha256=/, "");
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
  } catch {
    return false;
  }
}

function secretsEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
