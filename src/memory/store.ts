import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  appendFileSync,
} from "node:fs";
import path from "node:path";

export const MEMORY_LAYOUT_VERSION = 2;

const DEFAULT_INSTRUCTIONS = `# Agent instructions (user-owned — agent must not edit)

- Prefer silence unless a decision is needed or something changed that the user would act on today.
- Before notifying, check reported.md so you do not repeat yourself.
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
  const normalized = relPath.replaceAll("\\", "/");
  if (normalized === "instructions.md" && !opts.allowInstructions) {
    throw new Error("instructions.md is user-owned; agent cannot write it");
  }
  const provenance = opts.provenance ?? "agent";
  let body = content;
  if (!/^provenance:/m.test(body) && normalized.startsWith("notes/")) {
    body = `provenance: ${provenance}\nupdated: ${new Date().toISOString()}\n\n${body}`;
  }
  // Downgrade path: inferred notes go to inferred.md unless explicitly user/verified
  let target = normalized;
  if (
    provenance === "inferred_untrusted" &&
    normalized.startsWith("notes/") &&
    !normalized.endsWith("inferred.md")
  ) {
    // Keep caller path but stamp provenance; caller may still write preferences only as user
  }
  const resolved = resolveSafe(memoryDir, target);
  mkdirSync(path.dirname(resolved), { recursive: true });
  writeFileSync(resolved, body, "utf8");
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
  return resolved;
}
