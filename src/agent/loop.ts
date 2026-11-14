import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import type { Db } from "../db.js";
import { nowIso } from "../db.js";
import type { InboxEvent } from "../inbox/store.js";
import { loadMemorySnapshot } from "../memory/store.js";
import type { Brain, AgentMessage, RunOutcome } from "./types.js";
import { TOOL_DEFS, executeTool, type ToolContext } from "./tools.js";

export type RunResult = {
  outcome: RunOutcome;
  transcript: AgentMessage[];
  eventIds: number[];
};

export async function runAgent(opts: {
  db: Db;
  config: Config;
  brain: Brain;
  inboxId: string;
  sessionKey: string;
  events: InboxEvent[];
}): Promise<RunResult> {
  const { db, config, brain, inboxId, sessionKey, events } = opts;
  const started = Date.now();
  const memory = loadMemorySnapshot(config.memoryDir);

  const prior = loadSession(db, sessionKey);
  const eventPayload = events.map((e) => ({
    id: e.id,
    source: e.source,
    sourceId: e.source_id,
    payload: safeJson(e.payload),
  }));

  const system: AgentMessage = {
    role: "system",
    content: [
      "You are an always-on agent. Work briefly, persist important facts to memory, prefer silence.",
      "Use tools. Do not claim work is done without evidence.",
      "",
      memory.stablePrefix,
      "",
      "--- reported.md ---",
      memory.reported,
    ].join("\n"),
  };

  const user: AgentMessage = {
    role: "user",
    content: JSON.stringify({ type: "events", events: eventPayload }, null, 2),
  };

  const transcript: AgentMessage[] = prior.length
    ? [...prior, user]
    : [system, user];

  let silenceReason: string | undefined;
  let notified: string | undefined;
  let deferredId: string | undefined;
  let deferredSummary: string | undefined;
  let turns = 0;

  const toolCtx: ToolContext = { db, config, inboxId, sessionKey };

  while (turns < config.maxTurnsPerRun) {
    if (Date.now() - started > config.maxWallMsPerRun) {
      return finish({
        type: "error",
        error: "wall-clock budget exceeded",
      });
    }
    turns += 1;

    const output = await brain.complete({
      messages: transcript,
      tools: TOOL_DEFS,
    });

    if (output.type === "message") {
      transcript.push({ role: "assistant", content: output.content });
      // Treat bare assistant text as a notify candidate only if non-empty;
      // prefer explicit tools in production brains.
      if (!notified && output.content.trim()) {
        const result = executeTool(toolCtx, {
          id: `auto-${turns}`,
          name: "notify_user",
          arguments: { text: output.content.trim() },
        });
        transcript.push({
          role: "tool",
          toolCallId: result.toolCallId,
          content: result.content,
        });
        if (result.content === "enqueued") notified = output.content.trim();
        if (result.content.startsWith("suppressed")) {
          silenceReason = result.content;
        }
      }
      break;
    }

    transcript.push({
      role: "assistant",
      content: output.content ?? "",
      toolCalls: output.toolCalls,
    });

    for (const call of output.toolCalls) {
      const result = executeTool(toolCtx, call);
      transcript.push({
        role: "tool",
        toolCallId: result.toolCallId,
        content: result.content,
      });

      if (call.name === "record_silence" && result.ok) {
        silenceReason = result.content.replace(/^silence:/, "");
      }
      if (call.name === "notify_user" && result.content === "enqueued") {
        notified = String(call.arguments.text ?? "");
      }
      if (result.deferred && result.deferredId) {
        deferredId = result.deferredId;
        deferredSummary = result.content;
      }
    }

    if (deferredId || silenceReason || notified) break;
  }

  if (deferredId) {
    return finish({
      type: "deferred",
      deferredId,
      summary: deferredSummary ?? "approval required",
    });
  }
  if (notified) {
    return finish({ type: "notified", body: notified });
  }
  return finish({
    type: "silence",
    reason: silenceReason ?? "no message produced",
  });

  function finish(outcome: RunOutcome): RunResult {
    saveSession(db, inboxId, sessionKey, transcript);
    persistTranscriptFile(config, sessionKey, events, transcript, outcome);
    logRun(db, inboxId, sessionKey, events, outcome);
    return {
      outcome,
      transcript,
      eventIds: events.map((e) => e.id),
    };
  }
}

function loadSession(db: Db, sessionKey: string): AgentMessage[] {
  const row = db
    .prepare(`SELECT transcript_json FROM sessions WHERE session_key = ?`)
    .get(sessionKey) as { transcript_json: string } | undefined;
  if (!row) return [];
  try {
    return JSON.parse(row.transcript_json) as AgentMessage[];
  } catch {
    return [];
  }
}

function saveSession(
  db: Db,
  inboxId: string,
  sessionKey: string,
  transcript: AgentMessage[],
): void {
  db.prepare(
    `INSERT INTO sessions (session_key, inbox_id, transcript_json, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(session_key) DO UPDATE SET
       transcript_json = excluded.transcript_json,
       updated_at = excluded.updated_at`,
  ).run(sessionKey, inboxId, JSON.stringify(transcript), nowIso());
}

function persistTranscriptFile(
  config: Config,
  sessionKey: string,
  events: InboxEvent[],
  transcript: AgentMessage[],
  outcome: RunOutcome,
): void {
  mkdirSync(config.transcriptsDir, { recursive: true });
  const file = path.join(
    config.transcriptsDir,
    `${sessionKey.replaceAll(/[^a-zA-Z0-9._-]/g, "_")}-${Date.now()}.json`,
  );
  writeFileSync(
    file,
    JSON.stringify(
      {
        sessionKey,
        eventIds: events.map((e) => e.id),
        outcome,
        transcript,
        at: nowIso(),
      },
      null,
      2,
    ),
    "utf8",
  );
}

function logRun(
  db: Db,
  inboxId: string,
  sessionKey: string,
  events: InboxEvent[],
  outcome: RunOutcome,
): void {
  const silence =
    outcome.type === "silence"
      ? outcome.reason
      : outcome.type === "error"
        ? outcome.error
        : null;
  db.prepare(
    `INSERT INTO run_log (inbox_id, session_key, event_ids, outcome, silence_reason)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    inboxId,
    sessionKey,
    JSON.stringify(events.map((e) => e.id)),
    outcome.type,
    silence,
  );
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
