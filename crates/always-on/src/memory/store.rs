use anyhow::{bail, Context, Result};
use regex::Regex;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

pub const MEMORY_LAYOUT_VERSION: i32 = 2;

const DEFAULT_INSTRUCTIONS: &str = r#"# Agent instructions (user-owned — agent must not edit)

- Prefer silence unless a decision is needed or something changed that the user would act on today.
- Before notifying, check reported.md so you do not repeat yourself.
- Store only what you cannot look up again; prefer pointers to external systems.
- For high-risk side effects (emailing others, spending money, deleting data), use request_approval.
- Cap proactive follow-ups; do not schedule tight loops.
- When writing notes inferred from untrusted inbox content, mark provenance as inferred_untrusted.
"#;

const DEFAULT_INDEX: &str = r#"# Memory index
layout_version: 2

- notes/preferences.md — user preferences and corrections
- notes/inferred.md — agent-inferred notes (lower trust)
- progress/ — per-task progress files
"#;

const DEFAULT_REPORTED: &str = "# Already reported to the user\n\n(empty)\n";

const DEFAULT_PREFERENCES: &str = "# Preferences\nprovenance: user\n\n(none yet)\n";

const DEFAULT_INFERRED: &str = "# Inferred notes\nprovenance: inferred_untrusted\n\n(none yet)\n";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryProvenance {
    User,
    Agent,
    InferredUntrusted,
    Verified,
}

impl MemoryProvenance {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Agent => "agent",
            Self::InferredUntrusted => "inferred_untrusted",
            Self::Verified => "verified",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "user" => Some(Self::User),
            "agent" => Some(Self::Agent),
            "inferred_untrusted" => Some(Self::InferredUntrusted),
            "verified" => Some(Self::Verified),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct MemorySnapshot {
    pub instructions: String,
    pub index: String,
    pub reported: String,
    pub layout_version: i32,
    /// Stable prefix for prompt caching: instructions + index
    pub stable_prefix: String,
}

pub fn ensure_memory_layout(memory_dir: &Path) -> Result<()> {
    fs::create_dir_all(memory_dir).context("create memory_dir")?;
    fs::create_dir_all(memory_dir.join("notes")).context("create notes dir")?;
    fs::create_dir_all(memory_dir.join("progress")).context("create progress dir")?;

    let files: [(&str, &str); 5] = [
        ("instructions.md", DEFAULT_INSTRUCTIONS),
        ("index.md", DEFAULT_INDEX),
        ("reported.md", DEFAULT_REPORTED),
        ("notes/preferences.md", DEFAULT_PREFERENCES),
        ("notes/inferred.md", DEFAULT_INFERRED),
    ];

    for (rel, content) in files {
        let full = memory_dir.join(rel);
        if !full.exists() {
            if let Some(parent) = full.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(&full, content)?;
        }
    }

    let layout_path = memory_dir.join("LAYOUT_VERSION");
    if !layout_path.exists() {
        fs::write(&layout_path, MEMORY_LAYOUT_VERSION.to_string())?;
    }

    let ver_path = memory_dir.join("LAYOUT_VERSION");
    let ver: i32 = fs::read_to_string(&ver_path)
        .unwrap_or_default()
        .trim()
        .parse()
        .unwrap_or(0);
    if ver < MEMORY_LAYOUT_VERSION {
        fs::write(&ver_path, MEMORY_LAYOUT_VERSION.to_string())?;
        let stamp = chrono::Utc::now().to_rfc3339();
        let migration =
            format!("\n\n<!-- migrated to layout_version {MEMORY_LAYOUT_VERSION} at {stamp} -->\n");
        let index_path = memory_dir.join("index.md");
        let mut index = fs::read_to_string(&index_path).unwrap_or_default();
        index.push_str(&migration);
        fs::write(index_path, index)?;
    }
    Ok(())
}

pub fn load_memory_snapshot(memory_dir: &Path) -> Result<MemorySnapshot> {
    ensure_memory_layout(memory_dir)?;
    let instructions = fs::read_to_string(memory_dir.join("instructions.md"))?;
    let index = fs::read_to_string(memory_dir.join("index.md"))?;
    let reported = fs::read_to_string(memory_dir.join("reported.md"))?;
    let layout_version: i32 = fs::read_to_string(memory_dir.join("LAYOUT_VERSION"))?
        .trim()
        .parse()
        .unwrap_or(MEMORY_LAYOUT_VERSION);
    Ok(MemorySnapshot {
        stable_prefix: format!("{instructions}\n\n---\n\n{index}"),
        instructions,
        index,
        reported,
        layout_version,
    })
}

pub fn read_memory_file(memory_dir: &Path, rel_path: &str) -> Result<String> {
    let resolved = resolve_safe(memory_dir, rel_path)?;
    if !resolved.exists() {
        bail!("memory file not found: {rel_path}");
    }
    Ok(fs::read_to_string(resolved)?)
}

pub struct WriteMemoryOptions {
    pub allow_instructions: bool,
    pub provenance: Option<MemoryProvenance>,
}

pub fn write_memory_file(
    memory_dir: &Path,
    rel_path: &str,
    content: &str,
    opts: WriteMemoryOptions,
) -> Result<()> {
    let normalized = rel_path.replace('\\', "/");
    if normalized == "instructions.md" && !opts.allow_instructions {
        bail!("instructions.md is user-owned; agent cannot write it");
    }
    let provenance = opts.provenance.unwrap_or(MemoryProvenance::Agent);
    let mut body = content.to_string();
    static PROV_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^provenance:").unwrap());
    if !PROV_RE.is_match(&body) && normalized.starts_with("notes/") {
        let stamp = chrono::Utc::now().to_rfc3339();
        body = format!(
            "provenance: {}\nupdated: {stamp}\n\n{body}",
            provenance.as_str()
        );
    }
    let target = normalized;
    let resolved = resolve_safe(memory_dir, &target)?;
    if let Some(parent) = resolved.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(resolved, body)?;
    Ok(())
}

pub fn append_reported(memory_dir: &Path, line: &str) -> Result<()> {
    ensure_memory_layout(memory_dir)?;
    let full = memory_dir.join("reported.md");
    let existing = fs::read_to_string(&full)?;
    let stamp = chrono::Utc::now().to_rfc3339();
    let next = format!("{}\n- [{stamp}] {}\n", existing.trim_end(), line.trim());
    let trimmed = if next.len() > 40_000 {
        next[next.len() - 40_000..].to_string()
    } else {
        next
    };
    fs::write(full, trimmed)?;
    Ok(())
}

pub fn already_reported(memory_dir: &Path, needle: &str) -> Result<bool> {
    ensure_memory_layout(memory_dir)?;
    let reported = fs::read_to_string(memory_dir.join("reported.md"))?;
    let needle = needle.to_lowercase();
    Ok(reported.to_lowercase().contains(&needle))
}

pub fn list_progress_files(memory_dir: &Path) -> Result<Vec<String>> {
    let dir = memory_dir.join("progress");
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name.ends_with(".md") {
            out.push(format!("progress/{name}"));
        }
    }
    Ok(out)
}

pub fn read_provenance(content: &str) -> Option<MemoryProvenance> {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^provenance:\s*(\S+)").unwrap());
    RE.captures(content)
        .and_then(|c| c.get(1))
        .and_then(|m| MemoryProvenance::parse(m.as_str()))
}

fn resolve_safe(root: &Path, rel_path: &str) -> Result<PathBuf> {
    let resolved = root.join(rel_path);
    let root_resolved = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let resolved = fs::canonicalize(&resolved).unwrap_or(resolved);
    if resolved != root_resolved && !resolved.starts_with(&root_resolved) {
        bail!("path escapes memory directory");
    }
    Ok(resolved)
}
