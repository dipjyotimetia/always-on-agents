import type { Db } from "../db.js";
import type { Config } from "../config.js";
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
  config: Config;
  credentials: CredentialStore;
  deferredId: string;
}): Promise<{ ok: boolean; result: unknown }> {
  const row = getDeferredCall(opts.db, opts.deferredId);
  if (!row) throw new Error(`unknown deferred call: ${opts.deferredId}`);
  if (row.status !== "approved") {
    throw new Error(`deferred call ${opts.deferredId} is ${row.status}, not approved`);
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    markDeferredFailed(opts.db, row.id, "expired before execution");
    throw new Error(`deferred call ${opts.deferredId} expired`);
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
        enqueueOutbox(opts.db, {
          inboxId: row.inbox_id,
          channel: "external",
          body: `To: ${to}\nSubject: ${subject}\n\n${body}`,
          meta: {
            deferredId: row.id,
            to,
            subject,
            credentialLabel: opts.credentials.has("external_mail")
              ? opts.credentials.label("external_mail")
              : null,
          },
          idempotencyKey: `exec:${idemKey}`,
        });
        result = { delivered: "outbox", to, subject, idempotencyKey: idemKey };
        break;
      }
      case "proxied_request": {
        const credential = String(args.credential ?? "api");
        const url = String(args.url ?? "");
        if (!url.startsWith("https://")) {
          throw new Error("proxied_request only allows https URLs");
        }
        const response = await proxiedFetch(opts.credentials, {
          credential,
          url,
          method: String(args.method ?? "POST"),
          headers: (args.headers as Record<string, string> | undefined) ?? {},
          body: args.body ? String(args.body) : undefined,
        });
        result = response;
        break;
      }
      default: {
        // Generic: record that stored args were accepted; no freeform shell
        enqueueOutbox(opts.db, {
          inboxId: row.inbox_id,
          channel: "log",
          body: `Executed approved action ${row.tool_name} with stored args.`,
          meta: { deferredId: row.id, toolName: row.tool_name, args },
          idempotencyKey: `exec:${idemKey}`,
        });
        result = { executed: row.tool_name, args };
      }
    }

    markDeferredExecuted(opts.db, row.id, result);
    return { ok: true, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    markDeferredFailed(opts.db, row.id, message);
    return { ok: false, result: { error: message } };
  }
}
