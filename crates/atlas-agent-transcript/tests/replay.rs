//! The rules that decide what a resumed session shows the user.
//!
//! Every case here is a line Claude Code actually writes into its JSONL and a
//! decision about whether it is conversation. Getting one wrong is visible:
//! a compaction summary replayed as a user message is multiple KB of harness
//! prose at the top of the thread, and an un-stripped memory block becomes the
//! session's title.

use atlas_agent_transcript::{
    encode_cwd, is_injected_user_text, strip_injected_context,
};

#[test]
fn cwd_encoding_collapses_every_non_alphanumeric() {
    // Claude Code's own slug rule. A mismatch here means zero history rows
    // for any project whose path has a space or a dot.
    assert_eq!(encode_cwd("/Users/adib/Desktop/atlas"), "-Users-adib-Desktop-atlas");
    assert_eq!(
        encode_cwd("/Users/adib/Codes/Test Atlas"),
        "-Users-adib-Codes-Test-Atlas"
    );
    assert_eq!(encode_cwd("/a/b.c_d"), "-a-b-c-d");
    // A trailing slash is not part of the project path.
    assert_eq!(encode_cwd("/a/b/"), encode_cwd("/a/b"));
}

#[test]
fn injected_user_text_is_recognised() {
    for t in ["", "   ", "<system-reminder>x</system-reminder>", "[Request interrupted by user]", "warmup", "WARMUP"] {
        assert!(is_injected_user_text(t), "{t:?} should read as injected");
    }
    assert!(!is_injected_user_text("fix the bug"));
}

#[test]
fn memory_blocks_are_stripped_but_the_users_words_survive() {
    let text = "--- SHARED MEMORY — UPDATES SINCE LAST TURN ---\nfacts\n--- END SHARED MEMORY ---\n\nwhat changed?";
    assert_eq!(strip_injected_context(text), "what changed?");
}

#[test]
fn an_unterminated_block_does_not_eat_the_rest_of_the_prompt() {
    // Defensive: a truncated transcript line could leave the END marker off.
    // Everything after the start marker is dropped, which is the safe side —
    // scaffolding must never be shown as the user's words.
    let text = "--- PROJECT MEMORY ---\nfacts\nno end marker";
    assert_eq!(strip_injected_context(text), "");
}

#[test]
fn prose_with_horizontal_rules_is_left_alone() {
    // `---` fences are ordinary markdown; only the known block labels count.
    let text = "before\n--- NOT A MEMORY BLOCK ---\nafter";
    assert_eq!(strip_injected_context(text), text);
}

#[test]
fn a_collapsed_memory_block_is_stripped_from_a_title() {
    let text = "--- RELEVANT PROJECT MEMORY --- - AGENTS.md (codex): repo notes --- END RELEVANT PROJECT MEMORY --- abc";
    assert_eq!(strip_injected_context(text), "abc");
}

#[test]
fn a_title_that_is_only_injected_context_strips_to_empty() {
    let text = "--- RELEVANT PROJECT MEMORY --- - AGENTS.md (codex): repo notes --- END RELEVANT PROJECT MEMORY --- --- RECENT SESSION --- User: abc";
    assert_eq!(strip_injected_context(text), "");
}

#[test]
fn prose_after_a_collapsed_block_survives() {
    let text = "before --- PROJECT MEMORY --- facts --- END PROJECT MEMORY --- after";
    assert_eq!(strip_injected_context(text), "before  after");
}

#[test]
fn the_next_steps_directive_is_not_part_of_a_title() {
    let text = "abc\n\n\u{2550}\u{2550}\u{2550} Atlas next-steps \u{2550}\u{2550}\u{2550}\nappend a block";
    assert_eq!(strip_injected_context(text), "abc");
}

#[test]
fn the_codex_boundary_marker_is_cut_and_the_users_words_survive() {
    // What Atlas now puts on the wire for a Codex session: preamble, then the
    // marker Codex strips, then the real request. The marker itself must never
    // reach the UI.
    let text = "--- PROJECT MEMORY ---\nfacts\n--- END PROJECT MEMORY ---\n\n## My request for Codex:\n\nadd a knowledge base";
    assert_eq!(strip_injected_context(text), "add a knowledge base");
}

#[test]
fn a_boundary_marker_alone_still_yields_the_users_words() {
    let text = "## My request for Codex:\n\nfix the flaky test";
    assert_eq!(strip_injected_context(text), "fix the flaky test");
}
