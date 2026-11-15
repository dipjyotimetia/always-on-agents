# always-on-agents

Rust reference implementation of Anthropic’s [Building always-on agents](https://claude.com/resources/articles/building-always-on-agents) architecture.

**Always-on is a UX, not a long-lived model process.** Brief **runs** wake from a durable **inbox**, load **memory**, act under **permissions** (with a credential proxy), write the **outbox**, and may set **timers**.

The agent loop is **model-agnostic**: a `Brain` trait with adapters for Anthropic, OpenAI-compatible APIs, Gemini, and a deterministic mock.

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
cargo build --release -p always-on
cargo test -p always-on

cargo run -p always-on -- once
cargo run -p always-on -- serve
```

Without an API key (or with `BRAIN_PROVIDER=mock`), the deterministic mock brain runs offline.

### Model providers

| `BRAIN_PROVIDER` | Keys / notes |
| --- | --- |
| `auto` (default) | First of Anthropic → OpenAI → Gemini key; else mock |
| `mock` | Offline deterministic brain |
| `anthropic` | `ANTHROPIC_API_KEY` (+ optional `ANTHROPIC_MODEL` / `ANTHROPIC_BASE_URL`) |
| `openai` | `OPENAI_API_KEY` (+ `OPENAI_BASE_URL` for Azure/Ollama/Groq/etc.) |
| `gemini` | `GEMINI_API_KEY` or `GOOGLE_API_KEY` |

Shared knobs: `LLM_MODEL`, `LLM_BASE_URL`, `LLM_MAX_TOKENS` (see [`.env.example`](.env.example)).

### Ops UI (optional)

With `ENABLE_UI=true` (default), open **http://127.0.0.1:8787/ui** for a zero-dependency dashboard: backlog metrics, pending approvals, ingest, STOP/resume, recent events/runs/outbox/timers. Paste `APPROVAL_SECRET` in the page to approve or toggle STOP. Disable with `ENABLE_UI=false`.

```bash
curl -s localhost:8787/events -H 'content-type: application/json' \
  -d '{"source":"webhook","sourceId":"deliv-1","sessionKey":"thread-1","payload":{"text":"hello"}}'

# Approve a deferred action (executes stored args, does not regenerate them)
curl -s localhost:8787/events/approval -H 'content-type: application/json' \
  -d '{"secret":"dev-approval-secret","deferredId":"<uuid>","decision":"approved"}'

curl -s localhost:8787/metrics
cargo run -p always-on -- stop
cargo run -p always-on -- resume
cargo run -p always-on -- silences
```

## CLI

```
always-on serve              Start HTTP + worker + scheduler + dispatcher
always-on once               Fire timers, process one worker batch, drain outbox
always-on ingest <json>      Insert an inbox event
always-on followup <secs> [note]
always-on schedule <secs>
always-on stop | resume
always-on metrics | silences
```

## Security model

- Webhook signatures are verified over the **raw body** (not re-serialized JSON).
- Tools never see secrets; register `AOA_SECRET_<name>` and use `proxied_request` / approved `send_external`.
- High-risk tools defer; on approval the runtime runs the **stored** arguments only.
- Untrusted inbox payloads are wrapped and screened for injection during the run.

## License

MIT
