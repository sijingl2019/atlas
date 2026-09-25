//! Turning what a conversation carried into Knowledge Base entry ids.
//!
//! Pure over its inputs: the live hooks and the backfill both call these, and
//! that is the whole reason they cannot disagree about what counts as a
//! reference. Nothing here touches the store.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use atlas_checkpoint::tools::resolve_path;
use sha2::{Digest, Sha256};

use super::super::knowledge::{load_sources, KbSource};
use super::super::knowledge_meta::KnowledgeMetaFile;

/// How a conversation came to reference a note.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RefKind {
    /// The user attached it with `@note`.
    Mention,
    /// The agent opened the file with a read-shaped tool.
    Read,
    /// `memory_search` handed it to the agent.
    Retrieved,
}

impl RefKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Mention => "mention",
            Self::Read => "read",
            Self::Retrieved => "retrieved",
        }
    }
}

/// One reference, before it is stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ref {
    pub entry_id: String,
    pub kind: RefKind,
    /// What makes a repeat sighting of the same event idempotent: the live
    /// hook and the backfill derive the same key for the same event.
    pub source_key: String,
}

/// Short, stable content key.
pub fn content_key(prefix: &str, text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    let hex: String = digest[..8].iter().map(|b| format!("{b:02x}")).collect();
    format!("{prefix}:{hex}")
}

/// The note ids a composed prompt attached with `@note`.
///
/// The composer writes each one as a `## @note:<id>` heading under
/// `# Atlas context` (see `docs/reference/knowledge-base-technical.md` §8.2).
pub fn mentions(text: &str) -> Vec<Ref> {
    let key = content_key("mention", text);
    let mut out: Vec<Ref> = Vec::new();
    for line in text.lines() {
        let Some(id) = line.trim_end().strip_prefix("## @note:") else {
            continue;
        };
        let id = id.trim();
        if id.is_empty() || out.iter().any(|r| r.entry_id == id) {
            continue;
        }
        out.push(Ref {
            entry_id: id.to_string(),
            kind: RefKind::Mention,
            source_key: key.clone(),
        });
    }
    out
}

/// Where a project's Knowledge Base lives on disk.
#[derive(Debug, Clone)]
pub struct KbRoots {
    cwd: PathBuf,
    kb: PathBuf,
    mounts: Vec<(String, PathBuf)>,
}

impl KbRoots {
    pub fn load(project_path: &str) -> Self {
        Self::new(project_path, load_sources(project_path))
    }

    pub fn new(project_path: &str, sources: Vec<KbSource>) -> Self {
        let cwd = PathBuf::from(project_path);
        Self {
            kb: cwd.join(".atlas").join("knowledge"),
            cwd,
            mounts: sources
                .into_iter()
                .map(|s| (s.name, PathBuf::from(s.path)))
                .collect(),
        }
    }

    /// The entry id behind a path an agent reported, when it is a KB file.
    ///
    /// Relative paths are the agent's, so they resolve against the project.
    pub fn entry_for_path(&self, raw: &str) -> Option<String> {
        let raw = raw.trim();
        if raw.is_empty() {
            return None;
        }
        let absolute = absolute(raw, &self.cwd);
        if let Some(rel) = relative_to(&absolute, &self.kb) {
            return note_id(&rel, None);
        }
        self.mounts.iter().find_map(|(name, root)| {
            relative_to(&absolute, root).and_then(|rel| note_id(&rel, Some(name)))
        })
    }
}

fn absolute(raw: &str, cwd: &Path) -> String {
    let resolved = resolve_path(raw, cwd);
    if resolved.out_of_repo {
        resolved.path
    } else {
        cwd.join(&resolved.path)
            .to_string_lossy()
            .replace('\\', "/")
    }
}

fn relative_to(absolute: &str, root: &Path) -> Option<String> {
    let resolved = resolve_path(absolute, root);
    (!resolved.out_of_repo && !resolved.path.is_empty()).then_some(resolved.path)
}

/// `rel` (under a KB root) as an entry id, or `None` for KB machinery.
fn note_id(rel: &str, mount: Option<&str>) -> Option<String> {
    if rel.split('/').any(|seg| seg.starts_with('.')) {
        return None;
    }
    if mount.is_none() && (rel == "_meta.json" || rel.starts_with("covers/")) {
        return None;
    }
    let id = rel.strip_suffix(".md").unwrap_or(rel);
    Some(match mount {
        Some(name) => format!("{name}/{id}"),
        None => id.to_string(),
    })
}

/// The KB entries a read-shaped tool call opened.
pub fn reads(
    roots: &KbRoots,
    call_id: &str,
    locations: &[serde_json::Value],
    arguments: &serde_json::Value,
) -> Vec<Ref> {
    let mut out: Vec<Ref> = Vec::new();
    for path in atlas_checkpoint::tools::extract_paths(locations, &[], arguments) {
        let Some(entry_id) = roots.entry_for_path(&path) else {
            continue;
        };
        if out.iter().any(|r| r.entry_id == entry_id) {
            continue;
        }
        out.push(Ref {
            entry_id,
            kind: RefKind::Read,
            source_key: format!("call:{call_id}"),
        });
    }
    out
}

/// Whether a recorded tool call was the memory server's `memory_search`.
///
/// Agents spell MCP tools differently (`mcp__atlas_memory__memory_search`,
/// `atlas_memory/memory_search`, `memory_search (MCP)`, a bare
/// `memory_search`), so this looks for the tool's own name as a whole word in
/// whichever label the call carries.
pub fn is_memory_search(labels: &[Option<&str>]) -> bool {
    const NAME: &str = "memory_search";
    labels.iter().flatten().any(|label| {
        label.match_indices(NAME).any(|(at, _)| {
            let after = label[at + NAME.len()..].chars().next();
            let before = label[..at].chars().next_back();
            !after.is_some_and(|c| c.is_alphanumeric() || c == '_')
                && !before.is_some_and(char::is_alphanumeric)
        })
    })
}

/// The query a `memory_search` call asked, for its source key.
pub fn search_key(query: &str) -> String {
    content_key("search", query.trim())
}

/// Titles → entry ids, for resolving `memory_search` results recorded before
/// they carried an id. Both the page title and the file stem are keys, since
/// the index titles a note by its file name.
#[derive(Debug, Default, Clone)]
pub struct TitleIndex {
    by_title: HashMap<String, Vec<String>>,
}

impl TitleIndex {
    pub fn build(entry_ids: &[String], meta: &KnowledgeMetaFile) -> Self {
        let mut by_title: HashMap<String, Vec<String>> = HashMap::new();
        for id in entry_ids {
            let stem = id.rsplit('/').next().unwrap_or(id).to_string();
            let mut keys = vec![stem];
            if let Some(title) = meta.pages.get(id).and_then(|p| p.title.clone()) {
                keys.push(title);
            }
            keys.dedup();
            for key in keys {
                let ids = by_title.entry(key.trim().to_string()).or_default();
                if !ids.contains(id) {
                    ids.push(id.clone());
                }
            }
        }
        Self { by_title }
    }

    /// The one entry with this title, or `None` when there is none or several.
    pub fn resolve(&self, title: &str) -> Option<&str> {
        match self.by_title.get(title.trim()).map(Vec::as_slice) {
            Some([only]) => Some(only.as_str()),
            _ => None,
        }
    }
}

/// What a `memory_search` result named, as refs plus the titles it could not
/// pin to one entry.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Retrieved {
    pub refs: Vec<Ref>,
    pub unresolved: Vec<String>,
}

/// KB documents in a `memory_search` result (the JSON text the tool returned).
pub fn retrieved(result: &str, query: &str, titles: &TitleIndex) -> Retrieved {
    let mut out = Retrieved::default();
    let Some(docs) = serde_json::from_str::<serde_json::Value>(result)
        .ok()
        .and_then(|v| v.get("documents").cloned())
        .and_then(|d| d.as_array().cloned())
    else {
        return out;
    };
    let key = search_key(query);
    for doc in docs {
        if doc.get("source").and_then(|s| s.as_str()) != Some("note") {
            continue;
        }
        let from_id = doc
            .get("id")
            .and_then(|i| i.as_str())
            .and_then(entry_from_doc_id);
        let title = doc.get("title").and_then(|t| t.as_str()).unwrap_or("");
        let entry_id = from_id.or_else(|| titles.resolve(title).map(str::to_string));
        match entry_id {
            Some(entry_id) => {
                if !out.refs.iter().any(|r| r.entry_id == entry_id) {
                    out.refs.push(Ref {
                        entry_id,
                        kind: RefKind::Retrieved,
                        source_key: key.clone(),
                    });
                }
            }
            None if !title.is_empty() => {
                if !out.unresolved.iter().any(|t| t == title) {
                    out.unresolved.push(title.to_string());
                }
            }
            None => {}
        }
    }
    out
}

/// `kb:<entry>` (optionally with a `#chunk` suffix) → `<entry>`. Any other
/// corpus id is not a KB document.
pub fn entry_from_doc_id(id: &str) -> Option<String> {
    let rest = id.strip_prefix("kb:")?;
    let entry = rest.split('#').next().unwrap_or(rest);
    (!entry.is_empty()).then(|| entry.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::knowledge_meta::PageMeta;
    use serde_json::json;

    fn roots() -> KbRoots {
        KbRoots::new(
            "/work/proj",
            vec![KbSource {
                name: "vault".into(),
                path: "/home/me/vault".into(),
            }],
        )
    }

    #[test]
    fn a_composed_prompt_yields_each_mentioned_note_once() {
        let text = "fix it\n\n---\n# Atlas context\n\n## @note:arch/auth\n\nbody\n\n## @note:vault/x\n\n## @note:arch/auth\n";
        let ids: Vec<_> = mentions(text).into_iter().map(|r| r.entry_id).collect();
        assert_eq!(ids, vec!["arch/auth", "vault/x"]);
    }

    #[test]
    fn prose_that_mentions_the_marker_mid_line_is_not_a_mention() {
        assert!(mentions("see ## @note:foo inline").is_empty());
        assert!(mentions("plain question").is_empty());
    }

    #[test]
    fn the_same_prompt_always_gets_the_same_key() {
        let text = "q\n## @note:a\n";
        assert_eq!(mentions(text)[0].source_key, mentions(text)[0].source_key);
        assert_ne!(
            mentions(text)[0].source_key,
            mentions("other\n## @note:a\n")[0].source_key
        );
    }

    #[test]
    fn a_project_kb_path_maps_to_its_entry_id() {
        let r = roots();
        assert_eq!(
            r.entry_for_path("/work/proj/.atlas/knowledge/arch/auth.md")
                .as_deref(),
            Some("arch/auth")
        );
        assert_eq!(
            r.entry_for_path(".atlas/knowledge/note-1.md").as_deref(),
            Some("note-1")
        );
        assert_eq!(
            r.entry_for_path("src/../.atlas/knowledge/spec.pdf")
                .as_deref(),
            Some("spec.pdf")
        );
    }

    #[test]
    fn a_mounted_path_maps_under_its_mount_name() {
        assert_eq!(
            roots()
                .entry_for_path("/home/me/vault/design/auth.md")
                .as_deref(),
            Some("vault/design/auth")
        );
    }

    #[test]
    fn paths_outside_the_kb_and_kb_machinery_are_not_entries() {
        let r = roots();
        assert_eq!(r.entry_for_path("/work/proj/src/main.rs"), None);
        assert_eq!(
            r.entry_for_path("/work/proj/.atlas/knowledge/_meta.json"),
            None
        );
        assert_eq!(
            r.entry_for_path("/work/proj/.atlas/knowledge/covers/a.png"),
            None
        );
        assert_eq!(r.entry_for_path("/home/me/vault/.obsidian/app.json"), None);
        assert_eq!(r.entry_for_path("/work/proj/.atlas/knowledge"), None);
        assert_eq!(r.entry_for_path(""), None);
    }

    #[test]
    fn a_read_call_names_the_file_from_locations_or_arguments() {
        let r = roots();
        let from_locations = reads(
            &r,
            "c1",
            &[json!({"path": "/work/proj/.atlas/knowledge/a.md"})],
            &json!({}),
        );
        assert_eq!(from_locations[0].entry_id, "a");
        assert_eq!(from_locations[0].source_key, "call:c1");

        let from_args = reads(&r, "c2", &[], &json!({"file_path": "/home/me/vault/b.md"}));
        assert_eq!(from_args[0].entry_id, "vault/b");
        assert!(reads(&r, "c3", &[], &json!({"file_path": "/etc/hosts"})).is_empty());
    }

    #[test]
    fn memory_search_is_recognised_however_the_agent_spells_it() {
        assert!(is_memory_search(&[Some(
            "mcp__atlas_memory__memory_search"
        )]));
        assert!(is_memory_search(&[None, Some("memory_search")]));
        assert!(is_memory_search(&[Some("atlas_memory/memory_search")]));
        assert!(is_memory_search(&[Some("memory_search (MCP)")]));
        assert!(!is_memory_search(&[Some("memory_search_notes")]));
        assert!(!is_memory_search(&[Some("xmemory_search")]));
        assert!(!is_memory_search(&[Some("Read"), None]));
    }

    fn titles() -> TitleIndex {
        let mut meta = KnowledgeMetaFile::default();
        meta.pages.insert(
            "arch/auth".into(),
            PageMeta {
                title: Some("Auth design".into()),
                ..Default::default()
            },
        );
        TitleIndex::build(&["arch/auth".into(), "a/dup".into(), "b/dup".into()], &meta)
    }

    #[test]
    fn a_result_with_ids_resolves_exactly() {
        let result = json!({"entries": [], "documents": [
            {"id": "kb:arch/auth", "title": "whatever", "source": "note", "text": "…"},
            {"id": "shared:decision:4", "title": "x", "source": "memory", "text": "…"},
        ]})
        .to_string();
        let got = retrieved(&result, "auth", &titles());
        assert_eq!(got.refs.len(), 1);
        assert_eq!(got.refs[0].entry_id, "arch/auth");
        assert_eq!(got.refs[0].kind, RefKind::Retrieved);
        assert_eq!(got.refs[0].source_key, search_key("auth"));
        assert!(got.unresolved.is_empty());
    }

    #[test]
    fn an_old_result_resolves_by_a_unique_title_and_reports_the_rest() {
        let result = json!({"documents": [
            {"title": "auth", "source": "note", "text": "…"},
            {"title": "Auth design", "source": "note", "text": "…"},
            {"title": "dup", "source": "note", "text": "…"},
            {"title": "gone", "source": "note", "text": "…"},
        ]})
        .to_string();
        let got = retrieved(&result, "q", &titles());
        let ids: Vec<_> = got.refs.iter().map(|r| r.entry_id.as_str()).collect();
        assert_eq!(ids, vec!["arch/auth"]);
        assert_eq!(got.unresolved, vec!["dup", "gone"]);
    }

    #[test]
    fn a_result_that_is_not_json_yields_nothing() {
        assert_eq!(
            retrieved("switched off", "q", &titles()),
            Retrieved::default()
        );
    }

    #[test]
    fn doc_ids_strip_the_corpus_prefix_and_chunk_suffix() {
        assert_eq!(entry_from_doc_id("kb:a/b#3").as_deref(), Some("a/b"));
        assert_eq!(entry_from_doc_id("kb:a").as_deref(), Some("a"));
        assert_eq!(entry_from_doc_id("shared:x:1"), None);
        assert_eq!(entry_from_doc_id("kb:"), None);
    }
}
