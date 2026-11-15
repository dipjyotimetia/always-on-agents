use anyhow::Result;
use regex::Regex;
use std::fs;
use std::path::Path;
use std::sync::LazyLock;

use super::store::resolve_within;

#[derive(Debug, Clone)]
pub struct VerifyResult {
    pub ok: bool,
    pub reasons: Vec<String>,
}

/// Lightweight verifier before treating a progress file as complete.
/// Requires explicit checklist markers and forbids self-declared done without evidence.
pub fn verify_progress_file(memory_dir: &Path, rel_path: &str) -> Result<VerifyResult> {
    let mut reasons = Vec::new();
    let full = match resolve_within(memory_dir, rel_path) {
        Ok(path) => path,
        Err(_) => {
            return Ok(VerifyResult {
                ok: false,
                reasons: vec!["path escapes memory directory".to_string()],
            });
        }
    };
    if !full.exists() {
        return Ok(VerifyResult {
            ok: false,
            reasons: vec!["progress file missing".to_string()],
        });
    }
    let text = fs::read_to_string(full)?;

    static STATUS_COMPLETE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)status:\s*complete").unwrap());
    static DONE_MARKER: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)\[x\]\s*done").unwrap());
    static EVIDENCE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)evidence:").unwrap());
    static VERIFIED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)verified:").unwrap());
    static TODO_FIXME: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"TODO|FIXME|not tested").unwrap());
    static INFERRED: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)provenance:\s*inferred_untrusted").unwrap());

    if !STATUS_COMPLETE.is_match(&text) && !DONE_MARKER.is_match(&text) {
        reasons.push("missing status: complete or [x] done marker".to_string());
    }
    if !EVIDENCE.is_match(&text) && !VERIFIED.is_match(&text) {
        reasons.push("missing evidence: or verified: section".to_string());
    }
    if STATUS_COMPLETE.is_match(&text) && TODO_FIXME.is_match(&text) {
        reasons.push("marked complete but contains TODO/FIXME/not tested".to_string());
    }
    if INFERRED.is_match(&text) {
        reasons.push("inferred_untrusted progress cannot be marked complete".to_string());
    }

    Ok(VerifyResult {
        ok: reasons.is_empty(),
        reasons,
    })
}
