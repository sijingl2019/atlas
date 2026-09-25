//! Reading references out of conversations that happened before tracking.
//!
//! Best effort, by construction: history keeps only what it kept.
//!
//! - Atlas's own transcripts are text only, so they yield `@note` mentions —
//!   for every agent, since Atlas records them all.
//! - `sessions.db` (only in projects with capture enabled) keeps every tool
//!   call, so it yields reads and `memory_search` results too.
//!
//! Both go through the same extractors as the live hooks, and the store is
//! idempotent per event, so re-running this — or running it while live
//! sightings arrive — never double-counts.

use std::path::Path;

use atlas_checkpoint::tools::ToolName;
use atlas_checkpoint::Store as CaptureStore;

use super::super::agent_transcript::{self, StoredTranscript};
use super::extract::{self, KbRoots, TitleIndex};
use super::store::RefStore;

/// Bump when the extraction rules change, so every project re-reads history
/// under the new ones on its next query.
pub const EXTRACTOR_VERSION: i64 = 1;

/// What one backfill pass added.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Outcome {
    pub refs: usize,
    pub unresolved: usize,
}

/// `@note` mentions from Atlas's recorded transcripts.
pub fn from_transcripts(
    store: &mut RefStore,
    transcripts: impl IntoIterator<Item = StoredTranscript>,
) -> Outcome {
    let mut outcome = Outcome::default();
    for transcript in transcripts {
        for message in transcript.messages.iter().filter(|m| m.role == "user") {
            let refs = extract::mentions(&message.content);
            match store.insert(&transcript.id, &refs, &message.timestamp) {
                Ok(n) => outcome.refs += n,
                Err(e) => tracing::warn!(target: "atlas::knowledge_refs", "backfill insert: {e}"),
            }
        }
    }
    outcome
}

/// Every transcript Atlas recorded for `cwd`.
pub fn recorded_transcripts(config_dir: &Path, cwd: &str) -> Vec<StoredTranscript> {
    agent_transcript::session_files(&agent_transcript::dir_for(config_dir, cwd))
        .into_iter()
        .filter_map(|file| agent_transcript::read_file(&file.path))
        .collect()
}

/// Reads and `memory_search` results from the capture store's tool calls.
pub fn from_capture(
    store: &mut RefStore,
    capture: &CaptureStore,
    workspace_id: &str,
    roots: &KbRoots,
    titles: &TitleIndex,
) -> Outcome {
    let mut outcome = Outcome::default();
    let sessions = match capture.sessions_for_project(workspace_id) {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!(target: "atlas::knowledge_refs", "backfill: sessions: {e}");
            return outcome;
        }
    };
    for session in sessions {
        let Ok(calls) = capture.tool_calls_for_session(&session.id) else {
            continue;
        };
        let session_id = session.native_session_id.as_str();
        for call in calls {
            let at = call.created_at.to_rfc3339();
            let arguments = arguments_of(capture, &call);
            let call_key = call
                .native_call_id
                .clone()
                .unwrap_or_else(|| call.id.clone());

            if call.tool_name == ToolName::Read {
                let locations = call.locations.as_array().cloned().unwrap_or_default();
                let refs = extract::reads(roots, &call_key, &locations, &arguments);
                outcome.refs += store.insert(session_id, &refs, &at).unwrap_or(0);
                continue;
            }

            if !extract::is_memory_search(&[call.title.as_deref(), call.kind.as_deref()]) {
                continue;
            }
            let Some(result) = capture
                .tool_call_result(&call)
                .ok()
                .flatten()
                .and_then(|bytes| String::from_utf8(bytes).ok())
            else {
                continue;
            };
            let query = arguments
                .get("query")
                .and_then(|q| q.as_str())
                .unwrap_or_default();
            let found = extract::retrieved(&result, query, titles);
            outcome.refs += store.insert(session_id, &found.refs, &at).unwrap_or(0);
            outcome.unresolved += store
                .insert_unresolved(session_id, &found.unresolved, &extract::search_key(query))
                .unwrap_or(0);
        }
    }
    outcome
}

fn arguments_of(capture: &CaptureStore, call: &atlas_checkpoint::ToolCall) -> serde_json::Value {
    let raw = match (&call.arguments, &call.arguments_ref) {
        (Some(inline), _) => Some(inline.clone()),
        (None, Some(key)) => capture
            .blobs()
            .get(key)
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok()),
        (None, None) => None,
    };
    raw.and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::agent_transcript::StoredMessage;

    fn transcript(id: &str, user: &[&str]) -> StoredTranscript {
        StoredTranscript {
            id: id.into(),
            plugin_id: "claude-code".into(),
            cwd: "/p".into(),
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
            messages: user
                .iter()
                .map(|text| StoredMessage {
                    role: "user".into(),
                    content: (*text).into(),
                    timestamp: "2026-01-01T00:00:00Z".into(),
                    model: None,
                    attachments: Vec::new(),
                    live_id: None,
                })
                .collect(),
        }
    }

    #[test]
    fn mentions_in_history_are_recorded_and_a_rerun_adds_nothing() {
        let mut store = RefStore::in_memory();
        let history = vec![
            transcript("s1", &["q\n## @note:a\n", "plain"]),
            transcript("s2", &["q2\n## @note:a\n## @note:b\n"]),
        ];
        let first = from_transcripts(&mut store, history.clone());
        assert_eq!(first.refs, 3);
        assert_eq!(from_transcripts(&mut store, history).refs, 0);

        let mut sessions: Vec<_> = store
            .for_entry("a")
            .unwrap()
            .into_iter()
            .map(|r| r.session_id)
            .collect();
        sessions.sort();
        assert_eq!(sessions, vec!["s1", "s2"]);
    }

    #[test]
    fn a_live_mention_and_its_backfill_are_the_same_event() {
        let mut store = RefStore::in_memory();
        let text = "q\n## @note:a\n";
        store
            .insert("s1", &extract::mentions(text), "live")
            .unwrap();
        let again = from_transcripts(&mut store, vec![transcript("s1", &[text])]);
        assert_eq!(again.refs, 0);
    }

    #[test]
    fn reads_and_searches_come_back_out_of_the_capture_store() {
        use atlas_checkpoint::{
            Capture, ProjectMode, SessionKey, Source, ToolCallContent, ToolStatus,
        };

        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let cwd = root.to_string_lossy().to_string();
        std::fs::create_dir_all(root.join(".atlas/knowledge/arch")).unwrap();
        std::fs::write(root.join(".atlas/knowledge/arch/auth.md"), "# a").unwrap();
        std::fs::write(root.join(".atlas/knowledge/roadmap.md"), "# r").unwrap();

        let mut capture = CaptureStore::open(atlas_checkpoint::atlas_dir(root)).unwrap();
        let key = SessionKey {
            workspace_id: cwd.clone(),
            source: Source::Acp,
            native_session_id: "acp-1".into(),
        };
        let mut writer = Capture::new(&mut capture, ProjectMode::Local);
        let session = writer
            .record_prompt(&key, "hi", 1, None, None, None)
            .unwrap();
        let read_locations =
            serde_json::json!([{ "path": format!("{cwd}/.atlas/knowledge/arch/auth.md") }]);
        writer
            .record_tool_call(
                &session,
                ToolCallContent {
                    turn_seq: 1,
                    native_call_id: Some("call-7"),
                    tool_name: ToolName::Read,
                    title: Some("Read auth.md"),
                    kind: Some("read"),
                    status: ToolStatus::Completed,
                    locations: &read_locations,
                    arguments: None,
                    result: Some(b"# a"),
                },
            )
            .unwrap();
        let result = serde_json::json!({ "entries": [], "documents": [
            { "id": "kb:arch/auth", "title": "auth", "source": "note", "text": "a" },
            { "title": "roadmap", "source": "note", "text": "r" },
            { "title": "gone", "source": "note", "text": "g" },
        ]})
        .to_string();
        let empty = serde_json::json!([]);
        writer
            .record_tool_call(
                &session,
                ToolCallContent {
                    turn_seq: 1,
                    native_call_id: Some("call-8"),
                    tool_name: ToolName::Other,
                    title: Some("mcp__atlas_memory__memory_search"),
                    kind: Some("other"),
                    status: ToolStatus::Completed,
                    locations: &empty,
                    arguments: Some(r#"{"query":"auth"}"#),
                    result: Some(result.as_bytes()),
                },
            )
            .unwrap();

        let mut refs = RefStore::in_memory();
        let roots = KbRoots::load(&cwd);
        let titles =
            TitleIndex::build(&["arch/auth".into(), "roadmap".into()], &Default::default());
        let outcome = from_capture(&mut refs, &capture, &cwd, &roots, &titles);
        assert_eq!(
            outcome,
            Outcome {
                refs: 3,
                unresolved: 1
            }
        );

        let rows = refs.for_session("acp-1").unwrap();
        let mut got: Vec<_> = rows
            .iter()
            .map(|r| (r.entry_id.as_str(), r.kind.as_str()))
            .collect();
        got.sort();
        assert_eq!(
            got,
            vec![
                ("arch/auth", "read"),
                ("arch/auth", "retrieved"),
                ("roadmap", "retrieved")
            ]
        );

        // The live hooks keyed the same events identically: nothing new.
        let live_read = extract::reads(
            &roots,
            "call-7",
            read_locations.as_array().unwrap(),
            &serde_json::Value::Null,
        );
        assert_eq!(refs.insert("acp-1", &live_read, "t").unwrap(), 0);
        assert_eq!(
            from_capture(&mut refs, &capture, &cwd, &roots, &titles),
            Outcome::default()
        );
    }
}
