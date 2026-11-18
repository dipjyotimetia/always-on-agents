import type { Db } from "../db.js";
import type { CredentialStore } from "./proxy.js";
import { proxiedFetch } from "./proxy.js";
import {
  getDeferredCall,
  markDeferredExecuted,
  markDeferredFailed,
} from "./defer.js";
import { enqueueOutbox } from "../outbox/store.js";
import { createHash } from "node:crypto";

/**
 * Execute an approved deferred call using the *stored* arguments only.
 * Never regenerates args from the model.
 */
export async function executeApprovedCall(opts: {
  db: Db;
  inboxId: string;
  sessionKey: string;
  signal: AbortSignal;
  guard: <T>(work: () => T) => T;
  credentials: CredentialStore;
  deferredId: string;
}): Promise<{ ok: boolean; result: unknown }> {
  const row = getDeferredCall(opts.db, opts.deferredId);
  if (!row || row.inbox_id !== opts.inboxId || row.session_key !== opts.sessionKey) throw new Error(`unknown deferred call: ${opts.deferredId}`);
  if (row.status === "executed" || row.status === "failed") {
    return { ok: row.status === "executed", result: JSON.parse(row.result_json ?? "null") as unknown };
  }
  if (row.status !== "approved") {
    throw new Error(`deferred call ${opts.deferredId} is ${row.status}, not approved`);
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    opts.guard(() => markDeferredFailed(opts.db, row.id, "expired before execution"));
    return { ok: false, result: { error: "expired before execution" } };
  }

  const args = JSON.parse(row.arguments_json) as Record<string, unknown>;
  const idemKey = createHash("sha256")
    .update(`${row.id}:${row.tool_name}:${row.arguments_json}`)
    .digest("hex")
    .slice(0, 24);

  try {
    let result: unknown;
    switch (row.tool_name) {
      case "send_external": {
        const to = String(args.to ?? "");
        const subject = String(args.subject ?? "");
        const body = String(args.body ?? args.text ?? subject);
        // Deliver via outbox — credentials injected only if channel needs them later
        result = { queued: true, to, subject };
        opts.guard(() => {
          enqueueOutbox(opts.db, {
            inboxId: row.inbox_id,
            channel: "external",
            body: `To: ${to}\nSubject: ${subject}\n\n${body}`,
            meta: { deferredId: row.id, to, subject },
            idempotencyKey: `exec:${idemKey}`,
          });
          markDeferredExecuted(opts.db, row.id, result);
        });
        return { ok: true, result };
      }
      case "proxied_request": {
        const credential = String(args.credential ?? "api");
        const url = String(args.url ?? "");
        const claim = opts.guard(() => opts.db.prepare(
          "INSERT OR IGNORE INTO deferred_execution_attempts (deferred_id) VALUES (?)",
        ).run(row.id).changes);
        if (!claim) throw new Error("previous request outcome unknown; verify at the service");
        const response = await proxiedFetch(opts.credentials, {
          credential,
          url,
          method: String(args.method ?? "POST"),
          idempotencyKey: idemKey,
          signal: opts.signal,
          body: args.body ? String(args.body) : undefined,
        });
        result = response;
        break;
      }
      default:
        throw new Error("unsupported approved action");
    }
    opts.guard(() => markDeferredExecuted(opts.db, row.id, result));
    return { ok: true, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    opts.guard(() => markDeferredFailed(opts.db, row.id, message));
    return { ok: false, result: { error: message } };
  }
}
