import { existsSync } from "node:fs";
import type { Config } from "./config.js";

/** Human-only kill switch. Agent tools must never create/clear this file. */
export function isStopped(config: Config): boolean {
  return existsSync(config.stopPath);
}
