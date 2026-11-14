import { mkdirSync } from "node:fs";
import path from "node:path";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
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
  approvalSecret: string;
  anthropicApiKey: string | undefined;
  anthropicModel: string;
  maxTurnsPerRun: number;
  maxTokensPerRun: number;
  maxWallMsPerRun: number;
  maxRunsPerDay: number;
  schedulerIntervalMs: number;
  dispatcherIntervalMs: number;
  workerIdleMs: number;
  minFollowupSeconds: number;
  maxActiveFollowups: number;
};

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const dataDir = path.resolve(overrides.dataDir ?? process.env.DATA_DIR ?? "./data");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(path.join(dataDir, "memory"), { recursive: true });
  mkdirSync(path.join(dataDir, "transcripts"), { recursive: true });

  return {
    dataDir,
    dbPath: path.join(dataDir, "runtime.db"),
    memoryDir: path.join(dataDir, "memory"),
    transcriptsDir: path.join(dataDir, "transcripts"),
    stopPath: path.join(dataDir, "STOP"),
    host: overrides.host ?? process.env.HOST ?? "127.0.0.1",
    port: overrides.port ?? envInt("PORT", 8787),
    webhookSecret: overrides.webhookSecret ?? process.env.WEBHOOK_SECRET ?? "",
    approvalSecret:
      overrides.approvalSecret ?? process.env.APPROVAL_SECRET ?? "dev-approval-secret",
    anthropicApiKey: overrides.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY,
    anthropicModel:
      overrides.anthropicModel ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5",
    maxTurnsPerRun: overrides.maxTurnsPerRun ?? envInt("MAX_TURNS_PER_RUN", 12),
    maxTokensPerRun: overrides.maxTokensPerRun ?? envInt("MAX_TOKENS_PER_RUN", 8000),
    maxWallMsPerRun: overrides.maxWallMsPerRun ?? envInt("MAX_WALL_MS_PER_RUN", 120_000),
    maxRunsPerDay: overrides.maxRunsPerDay ?? envInt("MAX_RUNS_PER_DAY", 200),
    schedulerIntervalMs:
      overrides.schedulerIntervalMs ?? envInt("SCHEDULER_INTERVAL_MS", 5_000),
    dispatcherIntervalMs:
      overrides.dispatcherIntervalMs ?? envInt("DISPATCHER_INTERVAL_MS", 2_000),
    workerIdleMs: overrides.workerIdleMs ?? envInt("WORKER_IDLE_MS", 1_500),
    minFollowupSeconds:
      overrides.minFollowupSeconds ?? envInt("MIN_FOLLOWUP_SECONDS", 60),
    maxActiveFollowups:
      overrides.maxActiveFollowups ?? envInt("MAX_ACTIVE_FOLLOWUPS", 20),
  };
}
