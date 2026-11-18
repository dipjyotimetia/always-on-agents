import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { BrainKind } from "./agent/factory.js";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envBrain(): BrainKind {
  const raw = process.env.BRAIN;
  if (!raw) return "auto";
  const value = raw.toLowerCase();
  if (
    value === "auto" ||
    value === "mock" ||
    value === "anthropic" ||
    value === "openai" ||
    value === "gemini"
  ) {
    return value;
  }
  throw new Error(`Unknown BRAIN value: ${raw}`);
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

export type Config = {
  dataDir: string;
  dbPath: string;
  memoryDir: string;
  transcriptsDir: string;
  stopPath: string;
  host: string;
  port: number;
  webhookSecret: string;
  requireWebhookSecret: boolean;
  approvalSecret: string;
  deliveryWebhookUrl?: string;
  deliveryTimeoutMs: number;
  agentName: string;
  brain: BrainKind;
  anthropicApiKey: string | undefined;
  anthropicModel: string;
  anthropicBaseUrl: string;
  openaiApiKey: string | undefined;
  openaiModel: string;
  openaiBaseUrl: string;
  geminiApiKey: string | undefined;
  geminiModel: string;
  geminiBaseUrl: string | undefined;
  maxTurnsPerRun: number;
  maxTokensPerRun: number;
  maxWallMsPerRun: number;
  maxRunsPerDay: number;
  maxTokensPerDay: number;
  schedulerIntervalMs: number;
  dispatcherIntervalMs: number;
  workerIdleMs: number;
  minFollowupSeconds: number;
  maxActiveFollowups: number;
  maxBodyBytes: number;
  rateLimitPerMinute: number;
  sessionMaxMessages: number;
  sessionKeepRecent: number;
  eventMaxAttempts: number;
  leaseTtlMs: number;
  autoNotifyBareText: boolean;
  /** Serve the lightweight ops dashboard at /ui (and /). */
  enableUi: boolean;
};

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const dataDir = path.resolve(overrides.dataDir ?? process.env.DATA_DIR ?? "./data");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(path.join(dataDir, "memory"), { recursive: true });
  mkdirSync(path.join(dataDir, "transcripts"), { recursive: true });

  const config: Config = {
    dataDir,
    dbPath: path.join(dataDir, "runtime.db"),
    memoryDir: path.join(dataDir, "memory"),
    transcriptsDir: path.join(dataDir, "transcripts"),
    stopPath: path.join(dataDir, "STOP"),
    host: overrides.host ?? process.env.HOST ?? "127.0.0.1",
    port: overrides.port ?? envInt("PORT", 8787),
    webhookSecret: overrides.webhookSecret ?? process.env.WEBHOOK_SECRET ?? "",
    requireWebhookSecret:
      overrides.requireWebhookSecret ?? envBool("REQUIRE_WEBHOOK_SECRET", false),
    approvalSecret:
      overrides.approvalSecret ?? process.env.APPROVAL_SECRET ?? randomBytes(32).toString("hex"),
    deliveryWebhookUrl: overrides.deliveryWebhookUrl ?? process.env.DELIVERY_WEBHOOK_URL,
    deliveryTimeoutMs: overrides.deliveryTimeoutMs ?? envInt("DELIVERY_TIMEOUT_MS", 10_000),
    agentName: overrides.agentName ?? process.env.AGENT_NAME ?? "Personal agent",
    brain: overrides.brain ?? envBrain(),
    anthropicApiKey: overrides.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY,
    anthropicModel:
      overrides.anthropicModel ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5",
    anthropicBaseUrl:
      overrides.anthropicBaseUrl ??
      process.env.ANTHROPIC_BASE_URL ??
      "https://api.anthropic.com",
    openaiApiKey: overrides.openaiApiKey ?? process.env.OPENAI_API_KEY,
    openaiModel: overrides.openaiModel ?? process.env.OPENAI_MODEL ?? "gpt-5.5",
    openaiBaseUrl:
      overrides.openaiBaseUrl ??
      process.env.OPENAI_BASE_URL ??
      "https://api.openai.com/v1",
    geminiApiKey:
      overrides.geminiApiKey ??
      process.env.GEMINI_API_KEY ??
      process.env.GOOGLE_API_KEY,
    geminiModel:
      overrides.geminiModel ?? process.env.GEMINI_MODEL ?? "gemini-3.8-flash",
    geminiBaseUrl: overrides.geminiBaseUrl ?? process.env.GEMINI_BASE_URL,
    maxTurnsPerRun: overrides.maxTurnsPerRun ?? envInt("MAX_TURNS_PER_RUN", 12),
    maxTokensPerRun: overrides.maxTokensPerRun ?? envInt("MAX_TOKENS_PER_RUN", 8000),
    maxWallMsPerRun: overrides.maxWallMsPerRun ?? envInt("MAX_WALL_MS_PER_RUN", 120_000),
    maxRunsPerDay: overrides.maxRunsPerDay ?? envInt("MAX_RUNS_PER_DAY", 200),
    maxTokensPerDay: overrides.maxTokensPerDay ?? envInt("MAX_TOKENS_PER_DAY", 500_000),
    schedulerIntervalMs:
      overrides.schedulerIntervalMs ?? envInt("SCHEDULER_INTERVAL_MS", 5_000),
    dispatcherIntervalMs:
      overrides.dispatcherIntervalMs ?? envInt("DISPATCHER_INTERVAL_MS", 2_000),
    workerIdleMs: overrides.workerIdleMs ?? envInt("WORKER_IDLE_MS", 1_500),
    minFollowupSeconds:
      overrides.minFollowupSeconds ?? envInt("MIN_FOLLOWUP_SECONDS", 60),
    maxActiveFollowups:
      overrides.maxActiveFollowups ?? envInt("MAX_ACTIVE_FOLLOWUPS", 20),
    maxBodyBytes: overrides.maxBodyBytes ?? envInt("MAX_BODY_BYTES", 256_000),
    rateLimitPerMinute:
      overrides.rateLimitPerMinute ?? envInt("RATE_LIMIT_PER_MINUTE", 120),
    sessionMaxMessages:
      overrides.sessionMaxMessages ?? envInt("SESSION_MAX_MESSAGES", 40),
    sessionKeepRecent:
      overrides.sessionKeepRecent ?? envInt("SESSION_KEEP_RECENT", 12),
    eventMaxAttempts:
      overrides.eventMaxAttempts ?? envInt("EVENT_MAX_ATTEMPTS", 3),
    leaseTtlMs: overrides.leaseTtlMs ?? envInt("LEASE_TTL_MS", 30_000),
    autoNotifyBareText:
      overrides.autoNotifyBareText ?? envBool("AUTO_NOTIFY_BARE_TEXT", false),
    enableUi: overrides.enableUi ?? envBool("ENABLE_UI", true),
  };
  if (!config.approvalSecret.trim()) throw new Error("APPROVAL_SECRET cannot be empty");
  if (!["127.0.0.1", "::1", "localhost"].includes(config.host) &&
      ((!overrides.approvalSecret && !process.env.APPROVAL_SECRET) ||
       config.approvalSecret.length < 24 || !config.webhookSecret)) {
    throw new Error("Non-loopback HTTP requires explicit APPROVAL_SECRET and WEBHOOK_SECRET");
  }
  for (const value of [config.maxWallMsPerRun, config.leaseTtlMs, config.deliveryTimeoutMs,
    config.workerIdleMs, config.schedulerIntervalMs, config.dispatcherIntervalMs]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
      throw new Error("Runtime timeouts and intervals must be positive 32-bit integers");
    }
  }
  return config;
}
