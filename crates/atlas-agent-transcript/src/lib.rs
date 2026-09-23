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
//! - [`wrap_memory_envelope`] / [`strip_injected_context`] /
//!   [`is_injected_user_text`] — keeping Atlas's own memory scaffolding from
//!   being mistaken for something the user typed, and out of the agents' own
//!   memory files.
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

/// Opening tag of the envelope every block Atlas prepends to a user message
/// travels inside. One envelope per prompt, however many blocks it holds.
///
/// Mirrored by `MEMORY_ENVELOPE_OPEN` in `src/features/chat/lib/atlas-context.ts`,
/// which parses the same envelope back out of a prompt the agent echoed into a
/// transcript; the two must change together.
pub const MEMORY_ENVELOPE_OPEN: &str = "<atlas-memory>";

/// Closing tag of the injected-context envelope. Mirrored by
/// `MEMORY_ENVELOPE_CLOSE` in `src/features/chat/lib/atlas-context.ts`.
pub const MEMORY_ENVELOPE_CLOSE: &str = "</atlas-memory>";

/// First line inside the envelope, addressed to the agent reading it.
///
/// Load-bearing, not decorative. Claude Code was saving Atlas's injected blocks
/// into its own memory files; Atlas then read those files back into the corpus
/// and injected the copies again, so the memory filled with its own echo. The
/// envelope closes that loop from both ends: this line asks the agent not to
/// persist the text, and [`strip_injected_context`] drops it at every reader in
/// case the agent does it anyway.
pub const MEMORY_ENVELOPE_NOTE: &str = "Background context from Atlas, not part of the user's message. Do not save any of it to your own memory.";

/// Wrap the non-empty `blocks` in one envelope, note line first.
///
/// Returns `None` when nothing survives the filter, so an absent source stays a
/// true no-op: no tag, no note, no allocation.
pub fn wrap_memory_envelope(blocks: &[&str]) -> Option<String> {
    let body = blocks
        .iter()
        .copied()
        .filter(|b| !b.trim().is_empty())
        .collect::<Vec<_>>();
    if body.is_empty() {
        return None;
    }
    Some(format!(
        "{MEMORY_ENVELOPE_OPEN}\n{MEMORY_ENVELOPE_NOTE}\n{}\n{MEMORY_ENVELOPE_CLOSE}",
        body.join("\n\n")
    ))
}

/// Legacy block START labels (the END marker is always `--- END <CORE> ---`).
/// The SHARED MEMORY block's start line may carry a suffix ("— UPDATES SINCE
/// LAST TURN"), so a label matches by prefix.
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
const NEXT_STEPS_MARKER: &str =
    "\u{2550}\u{2550}\u{2550} Atlas next-steps \u{2550}\u{2550}\u{2550}";

/// The boundary marker Codex itself puts between a model-context preamble and
/// the user's real request — `codex_protocol::protocol::USER_MESSAGE_BEGIN`.
/// Older Atlas builds inserted it for Codex sessions, so transcripts and titles
/// on disk still carry it.
const CODEX_USER_MESSAGE_BEGIN: &str = "## My request for Codex:";

struct InjectedStart {
    core: &'static str,
    start: usize,
    marker_end: usize,
}

/// Find the next legacy block marker at or after `from`.
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

/// Strip the Atlas-injected context from a prompt the agent recorded: shared
/// cross-agent memory, retrieved long-term memory, the recent-session recap and
/// the hidden next-steps directive. The coding agent records the prompt it
/// received in its transcript, so a resumed session would otherwise surface
/// the raw scaffolding as the user's message and chat title — and, worse, save
/// it into its own memory files for Atlas to read back.
///
/// Every shape that is on disk is recognised: the [`MEMORY_ENVELOPE_OPEN`] …
/// [`MEMORY_ENVELOPE_CLOSE`] envelope (only a line that IS the tag opens one),
/// the bare `--- LABEL ---` … `--- END LABEL ---` blocks written before the
/// envelope existed — on their own lines or collapsed onto one line by an
/// agent's title summariser — and Codex's request boundary. An unterminated
/// region eats the rest of the text, which is the safe side: scaffolding must
/// never be shown as the user's words.
pub fn strip_injected_context(text: &str) -> String {
    let mut kept: Vec<&str> = Vec::new();
    let mut in_envelope = false;
    for line in text.lines() {
        let l = line.trim();
        if in_envelope {
            if l == MEMORY_ENVELOPE_CLOSE {
                in_envelope = false;
            }
            continue;
        }
        if l == MEMORY_ENVELOPE_OPEN {
            in_envelope = true;
            continue;
        }
        kept.push(line);
    }
    let text = kept.join("\n");

    let text = text
        .find(NEXT_STEPS_MARKER)
        .map_or(text.as_str(), |at| &text[..at]);

    // Codex's boundary marker is authoritative: everything after it is the
    // user's own words, everything before it is preamble.
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
