import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  appendFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import path from "node:path";

export const MEMORY_LAYOUT_VERSION = 2;

const DEFAULT_INSTRUCTIONS = `# Agent instructions (user-owned — agent must not edit)

- Prefer silence unless a decision is needed or something changed that the user would act on today.
- Consider recent confirmed deliveries before notifying again.
- Store only what you cannot look up again; prefer pointers to external systems.
- For high-risk side effects (emailing others, spending money, deleting data), use request_approval.
- Cap proactive follow-ups; do not schedule tight loops.
- When writing notes inferred from untrusted inbox content, mark provenance as inferred_untrusted.
`;

const DEFAULT_INDEX = `# Memory index
layout_version: ${MEMORY_LAYOUT_VERSION}

- notes/preferences.md — user preferences and corrections
- notes/inferred.md — agent-inferred notes (lower trust)
- progress/ — per-task progress files
`;

const DEFAULT_REPORTED = `# Already reported to the user

(empty)
`;

const DEFAULT_PREFERENCES = `# Preferences
provenance: user

(none yet)
`;

const DEFAULT_INFERRED = `# Inferred notes
provenance: inferred_untrusted

(none yet)
`;

export type MemoryProvenance = "user" | "agent" | "inferred_untrusted" | "verified";

export type MemorySnapshot = {
  instructions: string;
  index: string;
  reported: string;
  layoutVersion: number;
  /** Stable prefix for prompt caching: instructions + index */
  stablePrefix: string;
};

export function ensureMemoryLayout(memoryDir: string): void {
  mkdirSync(memoryDir, { recursive: true });
  mkdirSync(path.join(memoryDir, "notes"), { recursive: true });
  mkdirSync(path.join(memoryDir, "progress"), { recursive: true });

  const files: Array<[string, string]> = [
    ["instructions.md", DEFAULT_INSTRUCTIONS],
    ["index.md", DEFAULT_INDEX],
    ["reported.md", DEFAULT_REPORTED],
    ["LAYOUT_VERSION", String(MEMORY_LAYOUT_VERSION)],
    [path.join("notes", "preferences.md"), DEFAULT_PREFERENCES],
    [path.join("notes", "inferred.md"), DEFAULT_INFERRED],
  ];
  for (const [rel, content] of files) {
    const full = path.join(memoryDir, rel);
    if (!existsSync(full)) writeFileSync(full, content, "utf8");
  }

  // Migrate index header if layout version file newer than index mentions
  const ver = Number(readFileSync(path.join(memoryDir, "LAYOUT_VERSION"), "utf8").trim());
  if (ver < MEMORY_LAYOUT_VERSION) {
    writeFileSync(path.join(memoryDir, "LAYOUT_VERSION"), String(MEMORY_LAYOUT_VERSION), "utf8");
    appendFileSync(
      path.join(memoryDir, "index.md"),
      `\n\n<!-- migrated to layout_version ${MEMORY_LAYOUT_VERSION} at ${new Date().toISOString()} -->\n`,
    );
  }
}

export function loadMemorySnapshot(memoryDir: string): MemorySnapshot {
  ensureMemoryLayout(memoryDir);
  const instructions = readFileSync(path.join(memoryDir, "instructions.md"), "utf8");
  const index = readFileSync(path.join(memoryDir, "index.md"), "utf8");
  const reported = readFileSync(path.join(memoryDir, "reported.md"), "utf8");
  const layoutVersion = Number(
    readFileSync(path.join(memoryDir, "LAYOUT_VERSION"), "utf8").trim(),
  );
  return {
    instructions,
    index,
    reported,
    layoutVersion,
    stablePrefix: `${instructions}\n\n---\n\n${index}`,
  };
}

export function readMemoryFile(memoryDir: string, relPath: string): string {
  const resolved = resolveSafe(memoryDir, relPath);
  if (!existsSync(resolved)) throw new Error(`memory file not found: ${relPath}`);
  return readFileSync(resolved, "utf8");
}

export function writeMemoryFile(
  memoryDir: string,
  relPath: string,
  content: string,
  opts: {
    allowInstructions?: boolean;
    provenance?: MemoryProvenance;
  } = {},
): void {
  const resolved = resolveSafe(memoryDir, relPath.replaceAll("\\", "/"));
  const normalized = path.relative(path.resolve(memoryDir), resolved).split(path.sep).join("/");
  if (!opts.allowInstructions && ["instructions.md", "index.md", "reported.md", "LAYOUT_VERSION", "notes/preferences.md"].includes(normalized)) {
    throw new Error("operator-owned memory cannot be modified by the agent");
  }
  const provenance = opts.provenance ?? "agent";
  const body = normalized.startsWith("notes/")
    ? `provenance: ${provenance}\nupdated: ${new Date().toISOString()}\n\n${content.replace(/^provenance:.*$/gm, "")}`
    : content;
  mkdirSync(path.dirname(resolved), { recursive: true });
  const temp = path.join(path.dirname(resolved), `.memory-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, body, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temp, resolved);
  } finally {
    rmSync(temp, { force: true });
  }
}

export function appendReported(memoryDir: string, line: string): void {
  ensureMemoryLayout(memoryDir);
  const full = path.join(memoryDir, "reported.md");
  const existing = readFileSync(full, "utf8");
  const stamp = new Date().toISOString();
  const next = `${existing.trimEnd()}\n- [${stamp}] ${line.trim()}\n`;
  writeFileSync(full, next.length > 40_000 ? next.slice(-40_000) : next, "utf8");
}

export function alreadyReported(memoryDir: string, needle: string): boolean {
  ensureMemoryLayout(memoryDir);
  const reported = readFileSync(path.join(memoryDir, "reported.md"), "utf8");
  return reported.toLowerCase().includes(needle.toLowerCase());
}

export function listProgressFiles(memoryDir: string): string[] {
  const dir = path.join(memoryDir, "progress");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => `progress/${f}`);
}

export function readProvenance(content: string): MemoryProvenance | null {
  const m = content.match(/^provenance:\s*(\S+)/m);
  if (!m) return null;
  return m[1] as MemoryProvenance;
}

function resolveSafe(root: string, relPath: string): string {
  const resolved = path.resolve(root, relPath);
  const rootResolved = path.resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw new Error("path escapes memory directory");
  }
  const rootReal = realpathSync(rootResolved);
  let ancestor = resolved;
  while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const ancestorReal = realpathSync(ancestor);
  if (ancestorReal !== rootReal && !ancestorReal.startsWith(rootReal + path.sep)) {
    throw new Error("memory path escapes through a symlink");
  }
  if (ancestorReal !== path.join(rootReal, path.relative(rootResolved, ancestor))) {
    throw new Error("memory paths cannot contain symlinks");
  }
  return resolved;
}
