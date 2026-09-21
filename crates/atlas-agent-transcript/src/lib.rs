//! Where an agent keeps its record of a conversation, and how to read Atlas's
//! own text back out of one.
//!
//! This crate used to hold the Claude Code JSONL replay — parsing
//! `~/.claude/projects/<encoded-cwd>/<id>.jsonl` so a resumed Claude session
//! painted its history instantly. That is gone: Atlas no longer reads another
//! program's private storage to draw its own UI (ADR-0001), it has recorded
//! every agent's transcript itself since the usage re-source, and anything
//! older replays from the agent through `session/load`.
//!
//! What is left is small and still shared widely:
//!
//! - [`TranscriptKind`] — whether an agent keeps a record Atlas can read, which
//!   is what decides whether Atlas records its own copy.
//! - [`encode_cwd`] — the cwd→folder-name slug the agent CLIs use. Still needed
//!   by the checkpoint importer and the memory corpus, whose contract
//!   (touchpoint #11) explicitly preserves their reads.
//! - [`strip_injected_context`] / [`is_injected_user_text`] — keeping Atlas's
//!   own memory scaffolding from being mistaken for something the user typed.
//!
//! Nothing here names a protocol version, and nothing here should.

use serde::{Deserialize, Serialize};

/// Where an agent keeps its own record of a conversation, if anywhere.
///
/// This is what decides whether Atlas records a second copy: an agent with a
/// readable store of its own would otherwise put two rows in the sidebar for
/// one conversation, with two competing titles.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum TranscriptKind {
    /// No on-disk transcript — sessions are in-memory only and die with the
    /// process. These are the ones Atlas records itself.
    None,
    /// Native Cersei agent — JSON transcript under the app config dir, replayed
    /// by the native agent itself rather than through this module.
    CerseiJson,
}

/// Claude Code encodes the project cwd as a folder name by replacing every
/// character that isn't ASCII alphanumeric with `-` (so `/`, spaces, `.`, `_`
/// all collapse to `-`). E.g. `/Users/adib/Desktop/atlas` →
/// `-Users-adib-Desktop-atlas`, and `/Users/adib/Codes/Test Atlas` →
/// `-Users-adib-Codes-Test-Atlas`. Matching this exactly is required — Atlas
/// reads the JSONL transcripts the Claude Agent SDK writes under that folder,
/// so a path with a space or dot must resolve to the SAME slug or the listing
/// finds nothing (was: only `/` was replaced → 0 rows for any path with a
/// space).
pub fn encode_cwd(cwd: &str) -> String {
    let trimmed = cwd.trim_end_matches('/');
    trimmed
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// Identify user content injected by Claude Code itself (system tags,
/// interruption notices, warmup pings) rather than typed by the user.
pub fn is_injected_user_text(t: &str) -> bool {
    let trimmed = t.trim();
    if trimmed.is_empty() {
        return true;
    }
    if trimmed.starts_with('<') {
        return true;
    }
    if trimmed.starts_with("[Request interrupted") {
        return true;
    }
    if trimmed.eq_ignore_ascii_case("warmup") {
        return true;
    }
    false
}

/// Block START labels Atlas injects into the wire prompt. The END marker is
/// always `--- END <CORE> ---`.
const INJECTED_CONTEXT_CORES: [&str; 4] = [
    "SHARED MEMORY",
    "RELEVANT PROJECT MEMORY",
    "PROJECT MEMORY",
    "RECENT SESSION",
];

/// The hidden directive Atlas appends to the wire prompt. It is not a memory
/// block, but it is the same kind of host machinery and must not become a
/// title. Keep this in sync with `NEXT_STEPS_MARKER` in
/// `src/features/chat/lib/next-steps.ts`.
const NEXT_STEPS_MARKER: &str = "\u{2550}\u{2550}\u{2550} Atlas next-steps \u{2550}\u{2550}\u{2550}";

/// The boundary marker Codex itself puts between a model-context preamble and
/// the user's real request — `codex_protocol::protocol::USER_MESSAGE_BEGIN`.
///
/// `agents_send` inserts it for Codex sessions so Codex's own thread title
/// (`strip_user_message_prefix`) keeps only what the user typed. Keep this in
/// sync with `CODEX_USER_MESSAGE_BEGIN` in `src-tauri/src/commands/memory_pack.rs`
/// and in `src/features/chat/lib/atlas-context.ts`.
const CODEX_USER_MESSAGE_BEGIN: &str = "## My request for Codex:";

struct InjectedStart {
    core: &'static str,
    start: usize,
    marker_end: usize,
}

/// Find the next injected block marker at or after `from`.
///
/// Most blocks are written on their own line, but Codex may collapse the wire
/// prompt into one line before reporting a session title. That turns
/// `--- RELEVANT PROJECT MEMORY ---` plus its body into a single string, so
/// matching whole lines is not enough. A marker still has the same shape:
/// `--- <CORE>` followed by a closing `---` on the same line, then the body.
fn find_injected_start(text: &str, from: usize) -> Option<InjectedStart> {
    let mut search = from;
    while let Some(rel) = text[search..].find("--- ") {
        let start = search + rel;
        let after_prefix = start + 4;
        let Some(core) = INJECTED_CONTEXT_CORES
            .iter()
            .copied()
            .find(|core| text[after_prefix..].starts_with(core))
        else {
            search = after_prefix;
            continue;
        };
        let after_core = after_prefix + core.len();
        let Some(close_rel) = text[after_core..].find("---") else {
            search = after_core;
            continue;
        };
        let close = after_core + close_rel;
        let newline = text[after_core..].find('\n').map(|at| after_core + at);
        if newline.is_some_and(|at| at < close) {
            search = after_core;
            continue;
        }
        let starts_a_word = start > 0
            && !text[..start]
                .chars()
                .next_back()
                .is_some_and(char::is_whitespace);
        if !starts_a_word {
            return Some(InjectedStart {
                core,
                start,
                marker_end: close + 3,
            });
        }
        search = after_core;
    }
    None
}

/// Strip the Atlas-injected context blocks that `agents_send` prepends to the
/// wire prompt (shared cross-agent memory, retrieved long-term memory, recent-
/// session recap) and the hidden next-steps directive it appends.
///
/// The coding agent records the prompt it received in its transcript, so a
/// resumed session would otherwise surface the raw `--- SHARED MEMORY ---` /
/// `--- RELEVANT PROJECT MEMORY ---` scaffolding as the user's message and
/// chat title. The parser accepts both normal multi-line blocks and blocks
/// collapsed onto one line by an agent's title summariser.
pub fn strip_injected_context(text: &str) -> String {
    let text = text
        .find(NEXT_STEPS_MARKER)
        .map_or(text, |at| &text[..at]);

    // Codex's boundary marker is authoritative: everything after it is the
    // user's own words, everything before it is preamble. Cutting here also
    // keeps the marker itself from surfacing as prose.
    let text = text
        .find(CODEX_USER_MESSAGE_BEGIN)
        .map_or(text, |at| &text[at + CODEX_USER_MESSAGE_BEGIN.len()..]);

    let mut out = String::with_capacity(text.len());
    let mut cursor = 0;
    while let Some(start) = find_injected_start(text, cursor) {
        out.push_str(&text[cursor..start.start]);
        let end_marker = format!("--- END {} ---", start.core);
        let end = text[start.marker_end..]
            .find(&end_marker)
            .map_or(text.len(), |at| start.marker_end + at + end_marker.len());
        cursor = end;
    }
    out.push_str(&text[cursor..]);
    out.trim().to_string()
}
