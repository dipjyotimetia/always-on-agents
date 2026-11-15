#!/usr/bin/env node
import { createRuntime } from "./runtime.js";
import { insertEvent } from "./inbox/store.js";
import { createFollowup, createSchedule } from "./timers/store.js";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { getBacklogMetrics } from "./ops/metrics.js";
import { listSilences, silenceStats } from "./evals/silence.js";

function usage(): never {
  console.log(`always-on-agents

Usage:
  always-on serve              Start HTTP + worker + scheduler + dispatcher
  always-on once               Fire timers, process one worker batch, drain outbox
  always-on ingest <json>      Insert an inbox event (JSON object)
  always-on followup <secs> [note]
  always-on schedule <secs>    Create recurring schedule every <secs>
  always-on stop               Create STOP kill switch
  always-on resume             Remove STOP kill switch
  always-on metrics            Print backlog / STOP / budget metrics
  always-on silences           Export recent silence outcomes for eval labeling

Env: see .env.example
`);
  process.exit(1);
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd) usage();

  const runtime = createRuntime();
  const ac = new AbortController();
  const shutdown = () => ac.abort();
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    switch (cmd) {
      case "serve":
        await runtime.startAll(ac.signal);
        break;
      case "once":
        await runtime.runOnce();
        break;
      case "ingest": {
        const raw = args[0] ?? "{}";
        const body = JSON.parse(raw) as Record<string, unknown>;
        const result = insertEvent(runtime.db, {
          source: String(body.source ?? "cli"),
          sourceId: String(body.sourceId ?? body.id ?? `cli-${Date.now()}`),
          sessionKey: body.sessionKey ? String(body.sessionKey) : null,
          payload: body.payload ?? body,
        });
        runtime.wake.signal();
        console.log(JSON.stringify({ inserted: result.inserted, event: result.event }));
        break;
      }
      case "followup": {
        const secs = Number(args[0] ?? 60);
        const note = args.slice(1).join(" ") || "cli follow-up";
        const timer = createFollowup(runtime.db, {
          dueAt: new Date(Date.now() + secs * 1000),
          note,
          minFollowupSeconds: runtime.config.minFollowupSeconds,
          maxActiveFollowups: runtime.config.maxActiveFollowups,
        });
        console.log(JSON.stringify(timer));
        break;
      }
      case "schedule": {
        const every = Number(args[0] ?? 3600);
        const timer = createSchedule(runtime.db, {
          dueAt: new Date(Date.now() + every * 1000),
          everyS: every,
          payload: { note: "cli schedule" },
        });
        console.log(JSON.stringify(timer));
        break;
      }
      case "stop":
        writeFileSync(runtime.config.stopPath, `stopped at ${new Date().toISOString()}\n`);
        console.log(JSON.stringify({ stop: true, path: runtime.config.stopPath }));
        break;
      case "resume":
        if (existsSync(runtime.config.stopPath)) unlinkSync(runtime.config.stopPath);
        console.log(JSON.stringify({ stop: false }));
        break;
      case "metrics":
        console.log(JSON.stringify(getBacklogMetrics(runtime.db, runtime.config), null, 2));
        break;
      case "silences":
        console.log(
          JSON.stringify(
            {
              stats: silenceStats(runtime.db),
              recent: listSilences(runtime.db, { limit: 20 }),
            },
            null,
            2,
          ),
        );
        break;
      default:
        usage();
    }
  } finally {
    runtime.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
