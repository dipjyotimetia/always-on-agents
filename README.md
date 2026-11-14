# always-on-agents

Reference implementation of Anthropic’s [Building always-on agents](https://claude.com/resources/articles/building-always-on-agents) architecture.

**Always-on is a UX, not a long-lived model process.** The agent sleeps most of the time. Brief **runs** wake from a durable **inbox**, load **memory**, act under **permissions**, write the **outbox**, and may set **timers** that wake it again later.

## Primitives

| Primitive | Implementation |
| --- | --- |
| Event inbox | SQLite `events` + fast HTTP `POST /events` + single leased worker |
| Timers | SQLite `timers` + scheduler that only inserts inbox events |
| Memory | File store under `data/memory/` (`instructions.md` user-owned) |
| Permissions | Credential-free tools + deferred approvals with bound args |
| Outbox | SQLite `outbox` + dispatcher (default: structured stdout) |

Hardening included: crash reclaim, daily run budgets, human-only `STOP` kill switch, silence logging, transcript replay files, one worker lease per inbox.

## Quick start

```bash
npm install
npm test
npm run build

# One-shot: fire timers → process inbox → drain outbox
npm start -- once

# Long-running HTTP + worker + scheduler + dispatcher
npm start -- serve
```

Ingress (ack fast; no model call in the handler):

```bash
curl -s localhost:8787/events -H 'content-type: application/json' \
  -d '{"source":"webhook","sourceId":"deliv-1","sessionKey":"thread-1","payload":{"text":"hello"}}'
```

Approve a deferred high-risk action (uses stored arguments, not a regenerated call):

```bash
curl -s localhost:8787/events/approval -H 'content-type: application/json' \
  -d '{"secret":"dev-approval-secret","deferredId":"<uuid>","decision":"approved"}'
```

Kill switch (worker + scheduler honor this; the agent cannot clear it):

```bash
npm start -- stop
npm start -- resume
```

## Layout

```
src/
  inbox/          # durable events + dedupe
  timers/         # follow-ups & schedules → inbox
  outbox/         # paced delivery
  worker/         # single lease, batch by session_key
  memory/         # file-backed continuity
  permissions/    # deferred calls + risk classifier
  agent/          # run loop + mock brain (swap for Claude)
  http/           # fast webhook / approval ingress
  budgets.ts      # daily run caps
  stop.ts         # human-only STOP file
```

Without `ANTHROPIC_API_KEY`, the runtime uses a **deterministic mock brain** so architecture tests run offline. Wire your own `Brain` via `createRuntime({ brain })`.

## Acceptance tests

`npm test` covers:

1. Same webhook twice → one row  
2. Kill mid-run / reclaim → retry to done  
3. Follow-up timer → inbox event → run  
4. Three rapid messages → one batched run  
5. Deferred tool → authenticated approval resumes **stored** args  
6. Duplicate content → silence recorded, no notify  
7. `STOP` → worker and scheduler idle  
8. One lease per inbox  

## Design notes

- Handler acknowledges quickly; prompt-injection / deep checks belong in the run.  
- Inbox is the source of truth; mid-run arrivals wait for the next run.  
- Schedule misfires skip to the next slot (no backlog storms).  
- Start quiet: prefer `record_silence` unless the user would act today.  
- Session transcripts are append-only outside the harness process.

## License

MIT
