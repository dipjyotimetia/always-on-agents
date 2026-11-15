import type { Config } from "../config.js";
import { createAnthropicBrain } from "./anthropic-brain.js";
import { createGeminiBrain } from "./gemini-brain.js";
import { createMockBrain } from "./mock-brain.js";
import { createOpenAiBrain } from "./openai-brain.js";
import type { Brain } from "./types.js";

export type BrainKind = "auto" | "mock" | "anthropic" | "openai" | "gemini";
export type ResolvedBrain = Exclude<BrainKind, "auto">;

/**
 * auto prefers Anthropic, then OpenAI, then Gemini, and otherwise the offline mock.
 * An explicit kind with a missing key fails here, before a run starts.
 */
export function resolveBrainKind(config: Config): ResolvedBrain {
  switch (config.brain) {
    case "mock":
      return "mock";
    case "anthropic":
      requireKey(config.anthropicApiKey, "ANTHROPIC_API_KEY", "anthropic");
      return "anthropic";
    case "openai":
      requireKey(config.openaiApiKey, "OPENAI_API_KEY", "openai");
      return "openai";
    case "gemini":
      requireKey(config.geminiApiKey, "GEMINI_API_KEY", "gemini");
      return "gemini";
    case "auto":
      if (config.anthropicApiKey) return "anthropic";
      if (config.openaiApiKey) return "openai";
      if (config.geminiApiKey) return "gemini";
      return "mock";
    default: {
      const unknown: never = config.brain;
      throw new Error(`Unknown BRAIN value: ${String(unknown)}`);
    }
  }
}

export function brainLabel(config: Config): { brain: ResolvedBrain; model: string } {
  const brain = resolveBrainKind(config);
  const model =
    brain === "anthropic"
      ? config.anthropicModel
      : brain === "openai"
        ? config.openaiModel
        : brain === "gemini"
          ? config.geminiModel
          : "mock";
  return { brain, model };
}

export function createBrain(config: Config): Brain {
  const kind = resolveBrainKind(config);
  switch (kind) {
    case "mock":
      return createMockBrain();
    case "anthropic":
      return createAnthropicBrain({
        apiKey: config.anthropicApiKey,
        model: config.anthropicModel,
        baseUrl: config.anthropicBaseUrl,
      });
    case "openai":
      return createOpenAiBrain({
        apiKey: config.openaiApiKey,
        model: config.openaiModel,
        baseUrl: config.openaiBaseUrl,
      });
    case "gemini":
      return createGeminiBrain({
        apiKey: config.geminiApiKey,
        model: config.geminiModel,
        ...(config.geminiBaseUrl ? { baseUrl: config.geminiBaseUrl } : {}),
      });
    default: {
      const unknown: never = kind;
      throw new Error(`Unknown brain: ${String(unknown)}`);
    }
  }
}

function requireKey(
  key: string | undefined,
  envName: string,
  brain: string,
): void {
  if (!key) {
    throw new Error(`${envName} is required when BRAIN=${brain}`);
  }
}
