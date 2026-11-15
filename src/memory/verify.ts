import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export type VerifyResult = {
  ok: boolean;
  reasons: string[];
};

/**
 * Lightweight verifier before treating a progress file as complete.
 * Requires explicit checklist markers and forbids self-declared done without evidence.
 */
export function verifyProgressFile(
  memoryDir: string,
  relPath: string,
): VerifyResult {
  const reasons: string[] = [];
  const full = path.resolve(memoryDir, relPath);
  if (!full.startsWith(path.resolve(memoryDir) + path.sep)) {
    return { ok: false, reasons: ["path escapes memory directory"] };
  }
  if (!existsSync(full)) {
    return { ok: false, reasons: ["progress file missing"] };
  }
  const text = readFileSync(full, "utf8");

  if (!/status:\s*complete/i.test(text) && !/\[x\]\s*done/i.test(text)) {
    reasons.push("missing status: complete or [x] done marker");
  }
  if (!/evidence:/i.test(text) && !/verified:/i.test(text)) {
    reasons.push("missing evidence: or verified: section");
  }
  if (/status:\s*complete/i.test(text) && /TODO|FIXME|not tested/i.test(text)) {
    reasons.push("marked complete but contains TODO/FIXME/not tested");
  }
  if (/provenance:\s*inferred_untrusted/i.test(text)) {
    reasons.push("inferred_untrusted progress cannot be marked complete");
  }

  return { ok: reasons.length === 0, reasons };
}
