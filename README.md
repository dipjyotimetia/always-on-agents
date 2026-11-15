# always-on-agents

Reference implementation of Anthropic’s [Building always-on agents](https://claude.com/resources/articles/building-always-on-agents) architecture.

**Always-on is a UX, not a long-lived model process.** Brief **runs** wake from a durable **inbox**, load **memory**, act under **permissions** (with a credential proxy), write the **outbox**, and may set **timers**.

## Primitives

| Primitive | Implementation |
| --- | --- |
| Event inbox | SQLite `events` + fast `POST /events` (raw-body HMAC) + leased worker with fence |
| Timers | SQLite `timers` + transactional fire → inbox |
| Memory | Versioned file store with provenance stamps |
| Permissions | Deferred approvals execute **stored** args; credential proxy via `AOA_SECRET_*` |
| Outbox | Atomic `pending→sending→sent` claim + idempotency keys |

Hardening: crash reclaim, retry/dead-letter, daily run+token budgets, human-only `STOP`, session compaction, injection screening, progress verifier, `/metrics`, silence eval export.

## Quick start

```bash
pnpm install
pnpm test
pnpm build

pnpm start -- once
pnpm start -- serve
```

`BRAIN=auto` (the default) picks a live model in this order: Anthropic when `ANTHROPIC_API_KEY` is set, otherwise OpenAI when `OPENAI_API_KEY` is set, otherwise Gemini when `GEMINI_API_KEY` or `GOOGLE_API_KEY` is set. Calls go through the official SDKs (`@anthropic-ai/sdk`, `openai`, `@google/genai`). Anthropic caches the stable memory prefix (instructions and index) with a prompt-cache breakpoint. With no key, the deterministic mock brain runs offline. `BRAIN=mock|anthropic|openai|gemini` forces one brain and fails at startup if that key is missing.

### Ops UI (optional)

With `ENABLE_UI=true` (default), open **http://127.0.0.1:8787/ui** for a zero-dependency dashboard: backlog metrics, pending approvals, ingest, STOP/resume, recent events/runs/outbox/timers. Paste `APPROVAL_SECRET` in the page to approve or toggle STOP. Disable with `ENABLE_UI=false`.

```bash
curl -s localhost:8787/events -H 'content-type: application/json' \
  -d '{"source":"webhook","sourceId":"deliv-1","sessionKey":"thread-1","payload":{"text":"hello"}}'

# Approve a deferred action (executes stored args, does not regenerate them)
curl -s localhost:8787/events/approval -H 'content-type: application/json' \
  -d '{"secret":"dev-approval-secret","deferredId":"<uuid>","decision":"approved"}'

curl -s localhost:8787/metrics
pnpm start -- stop    # kill switch
pnpm start -- resume
pnpm start -- silences
```

## Security model

- Webhook signatures are verified over the **raw body** (not re-serialized JSON).
- Tools never see secrets; register `AOA_SECRET_<name>` and use `proxied_request` / approved `send_external`.
- High-risk tools defer; on approval the runtime runs the **stored** arguments only.
- Untrusted inbox payloads are wrapped and screened for injection during the run.

## License

MIT
