import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:http";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { insertEvent } from "../inbox/store.js";
import { resolveDeferredCall } from "../permissions/defer.js";

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

    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/events") {
      const body = await readJson(req);
      if (deps.config.webhookSecret) {
        const sig = String(req.headers["x-signature"] ?? "");
        if (!verifySignature(deps.config.webhookSecret, JSON.stringify(body), sig)) {
          return json(res, 401, { error: "invalid signature" });
        }
      }

      const source = String(body.source ?? "webhook");
      const sourceId = String(body.sourceId ?? body.id ?? "");
      if (!sourceId) return json(res, 400, { error: "sourceId required" });

      const result = insertEvent(deps.db, {
        inboxId: String(body.inboxId ?? "default"),
        source,
        sourceId,
        sessionKey: body.sessionKey ? String(body.sessionKey) : null,
        payload: body.payload ?? body,
      });

      deps.onEvent?.();
      return json(res, 200, {
        ok: true,
        inserted: result.inserted,
        eventId: result.event?.id ?? null,
      });
    }

    if (req.method === "POST" && url.pathname === "/events/approval") {
      const body = await readJson(req);
      const secret = String(body.secret ?? req.headers["x-approval-secret"] ?? "");
      if (!secretsEqual(secret, deps.config.approvalSecret)) {
        return json(res, 401, { error: "invalid approval secret" });
      }

      const deferredId = String(body.deferredId ?? "");
      const decision = body.decision === "denied" ? "denied" : "approved";
      if (!deferredId) return json(res, 400, { error: "deferredId required" });

      const deferred = resolveDeferredCall(deps.db, { id: deferredId, decision });
      const result = insertEvent(deps.db, {
        inboxId: deferred.inbox_id,
        source: "approval",
        sourceId: `${deferredId}:${decision}`,
        sessionKey: deferred.session_key,
        payload: {
          type: "approval",
          deferredId,
          decision,
        },
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
    json(res, 500, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function verifySignature(secret: string, body: string, header: string): boolean {
  const expected = createHmac("sha256", secret).update(body).digest("hex");
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
