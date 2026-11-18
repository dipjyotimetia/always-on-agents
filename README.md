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

Requires Bun 1.4.4 or later. The runtime uses Bun’s native SQLite driver and opens existing SQLite data directories in place. Stop the old process before upgrading.

```bash
bun install --frozen-lockfile
bun run test
bun run build

bun run start once
bun run start serve
```

`BRAIN=auto` (the default) picks a live model in this order: Anthropic when `ANTHROPIC_API_KEY` is set, otherwise OpenAI when `OPENAI_API_KEY` is set, otherwise Gemini when `GEMINI_API_KEY` or `GOOGLE_API_KEY` is set. Calls go through the official SDKs (`@anthropic-ai/sdk`, `openai`, `@google/genai`). Anthropic caches the stable memory prefix (instructions and index) with a prompt-cache breakpoint. With no key, the deterministic mock brain runs offline. `BRAIN=mock|anthropic|openai|gemini` forces one brain and fails at startup if that key is missing.

### Ops UI (optional)

With `ENABLE_UI=true` (default), open **http://127.0.0.1:8787/ui** for a zero-dependency dashboard: backlog metrics, pending approvals, ingest, STOP/resume, recent events/runs/outbox/timers. Set `APPROVAL_SECRET` before starting, then enter it in the page to view operational data, review stored arguments, approve actions, or toggle STOP. Without an explicit secret the process generates an ephemeral token for programmatic use. Non-loopback binding requires an explicit operator secret of at least 24 characters and a webhook secret. Use HTTPS at the ingress proxy for remote access. Disable with `ENABLE_UI=false`.

```bash
curl -s localhost:8787/events -H 'content-type: application/json' \
  -d '{"source":"webhook","sourceId":"deliv-1","sessionKey":"thread-1","payload":{"text":"hello"}}'

# Approve a deferred action (executes stored args, does not regenerate them)
curl -s localhost:8787/events/approval -H 'content-type: application/json' \
  -H "x-approval-secret: ${APPROVAL_SECRET}" \
  -d '{"deferredId":"<uuid>","decision":"approved"}'

curl -s localhost:8787/metrics
bun run start stop    # kill switch
bun run start resume
bun run start silences
```

## Routines and delivery

Give the runtime a name with `AGENT_NAME`. Save a named routine with an operator-authored instruction, then run it on a fixed interval or trigger a test. Saving an existing name edits its instruction and interval and preserves its paused state.

```bash
bun run start routine save release-digest 3600 "Review release notes and report actionable changes."
bun run start routine test release-digest
bun run start once
bun run start routine history release-digest
bun run start routine pause release-digest
bun run start routine resume release-digest
bun run start routine list
```

Set `DELIVERY_WEBHOOK_URL` to a trusted receiver. The runtime POSTs JSON with message ID, inbox, channel, body, metadata and a stable `Idempotency-Key` header. The receiver should deduplicate by that key and return 2xx after accepting the message. Approval notifications omit stored tool arguments. The authenticated dashboard shows the arguments for review. Approved external requests are passed to the receiver as `external` messages. The receiver owns final delivery to the destination.

Without a receiver, new messages stay queued. Existing `sent` rows from earlier versions may represent console output. STOP blocks new work and signals in-flight calls. A receiver that already accepted a request can still complete it.

## Security model

- Webhook signatures are verified over the **raw body** (not re-serialized JSON).
- For credentialed requests, set `AOA_SECRET_<NAME>`, `AOA_ENDPOINT_<NAME>` and `AOA_METHODS_<NAME>`. The runtime enforces the exact HTTPS URL and allowed methods, blocks redirects, and returns only the response status. If a request is interrupted after it starts, verify the result at the service before authorizing another attempt.
- High-risk tools defer. Approval and the wake-up event are saved together. The worker executes the stored arguments and resumes the saved session with the result.
- Untrusted inbox payloads are wrapped and screened for injection during the run.

## License

MIT
