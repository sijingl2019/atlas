//! Backlinks engine for the knowledge base.
//!
//! Walks every `.atlas/knowledge/**/*.md` file in a project and pulls
//! out references to other knowledge entries, in two flavors:
//!
//!   - `[[page-id]]` (bare wikilinks)
//!   - `@knowledge:<id>` / `@note:<id>` / `@page:<id>` — Atlas's
//!     existing mention wire formats (kept in sync with the kinds
//!     consumed by `compose_prompt.rs::MentionSpec`).
//!
//! The result is a per-project `LinkGraph` cached in
//! `Arc<RwLock<...>>`. Callers either rebuild on demand (first read,
//! after a `_invalidate` call) or rely on Rust to emit
//! `atlas:knowledge:links-changed` after a rebuild for the frontend
//! store to refresh.
//!
//! No filesystem watcher here — the frontend invalidates explicitly
//! after every `save_knowledge_note` / `delete_knowledge_note`, which
//! is when content actually changes. Adding a watcher later if other
//! tools rewrite the files is a small addition (mirror the
//! `git_watcher` pattern in `git_watcher.rs`).

use std::collections::HashMap;
use std::fs;
use std::sync::Arc;

use parking_lot::RwLock;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

#[path = "knowledge_link_target.rs"]
mod link_target;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Backlink {
    pub from_entry_id: String,
    pub from_title: String,
    pub snippet: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LinkCounts {
    pub backlinks: usize,
    pub forwardlinks: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub id: String,
    pub title: String,
    pub in_degree: u32,
    pub out_degree: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGraph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

#[derive(Debug, Default, Clone)]
struct LinkGraph {
    /// `target_id → [Backlink]` (where target = the page being referenced).
    backlinks: HashMap<String, Vec<Backlink>>,
    /// `from_id → [target_id]` (everything the page references).
    forwardlinks: HashMap<String, Vec<String>>,
    /// Every note walked off disk, in (id, title) order. Used by
    /// `knowledge_links_graph` so the graph view can surface isolated
    /// notes (no incoming or outgoing references) as standalone nodes.
    notes: Vec<NoteSummary>,
}

#[derive(Debug, Clone)]
struct NoteSummary {
    id: String,
    title: String,
}

#[derive(Default)]
pub struct KnowledgeLinksState {
    /// `project_path → LinkGraph`. `None` = "not yet computed".
    by_project: RwLock<HashMap<String, Option<LinkGraph>>>,
}

impl KnowledgeLinksState {
    pub fn new() -> Self {
        Self::default()
    }
}

const SNIPPET_RADIUS: usize = 90;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkDestination {
    entry_id: Option<String>,
    file_path: String,
}

#[tauri::command]
pub async fn knowledge_resolve_link(project_path: String, from_id: String, target: String) -> Result<LinkDestination, String> {
    tokio::task::spawn_blocking(move || {
        let sources = super::knowledge::load_sources(&project_path);
        let source = sources.iter().find(|s| from_id.starts_with(&format!("{}/", s.name)));
        let (root, prefix) = source.map(|s| (std::path::PathBuf::from(&s.path), s.name.clone()))
            .unwrap_or((std::path::Path::new(&project_path).join(".atlas/knowledge"), String::new()));
        let root = root.canonicalize().map_err(|e| e.to_string())?;
        fn walk(root: &std::path::Path, dir: &std::path::Path, prefix: &str, out: &mut Vec<(String, std::path::PathBuf)>) {
            let Ok(entries) = fs::read_dir(dir) else { return; };
            for entry in entries.flatten() {
                if entry.file_name().to_string_lossy().starts_with('.') { continue; }
                // Do not follow symlinks outside the vault or into cycles.
                let Ok(kind) = entry.file_type() else { continue; };
                if kind.is_symlink() { continue; }
                let path = entry.path();
                if kind.is_dir() { walk(root, &path, prefix, out); }
                else if kind.is_file() {
                    let rel = path.strip_prefix(root).unwrap().to_string_lossy().replace('\\', "/");
                    let rel = rel.strip_suffix(".md").unwrap_or(&rel);
                    let id = if prefix.is_empty() { rel.to_string() } else { format!("{prefix}/{rel}") };
                    out.push((id, path));
                }
            }
        }
        let mut files = Vec::new();
        walk(&root, &root, &prefix, &mut files);
        let ids = files.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>();
        let id = link_target::resolve(&target, &from_id, &ids, &prefix).ok_or("Link target missing or ambiguous")?;
        let (_, path) = files.into_iter().find(|(key, _)| key == &id).ok_or("Link target missing")?;
        Ok(LinkDestination {
            entry_id: (path.extension().and_then(|s| s.to_str()) == Some("md")).then_some(id),
            file_path: path.to_string_lossy().into_owned(),
        })
    }).await.map_err(|e| e.to_string())?
}

/// One-shot rebuild — walks every .md file, parses refs, builds the
/// reverse index. Synchronous; callers route through spawn_blocking.
fn build_graph(project_path: &str) -> LinkGraph {
    // (id, title, body). Filename-only title fallback: the user-edited title in
    // `_meta.json` wins on the JS side; deriving from the first `#` would make
    // the graph node label drift to body content (same as `list_knowledge`).
    let docs: Vec<(String, String, String)> = super::knowledge::walk_kb(project_path)
        .into_iter()
        .filter_map(|(id, path)| {
            let body = fs::read_to_string(&path).ok()?;
            let title = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
            Some((id, title, body))
        })
        .collect();

    let ids: Vec<String> = docs.iter().map(|(id, _, _)| id.clone()).collect();
    let sources = super::knowledge::load_sources(project_path);
    let mut graph = LinkGraph::default();
    for (from_id, from_title, body) in &docs {
        graph.notes.push(NoteSummary {
            id: from_id.clone(),
            title: from_title.clone(),
        });
        let mut targets: Vec<String> = Vec::new();
        for mut hit in find_refs(body) {
            let root = sources.iter().find(|s| from_id.starts_with(&format!("{}/", s.name)))
                .map(|s| s.name.as_str()).unwrap_or("");
            hit.target = link_target::resolve(&hit.target, from_id, &ids, root)
                .unwrap_or_else(|| link_target::target(&hit.target));
            // Skip self-references — a page can't backlink to itself.
            if hit.target == *from_id {
                continue;
            }
            let bl = Backlink {
                from_entry_id: from_id.clone(),
                from_title: from_title.clone(),
                snippet: extract_snippet(body, hit.start, hit.end),
            };
            graph
                .backlinks
                .entry(hit.target.clone())
                .or_default()
                .push(bl);
            if !targets.contains(&hit.target) {
                targets.push(hit.target);
            }
        }
        graph.forwardlinks.insert(from_id.clone(), targets);
    }
    graph
}

struct RefHit {
    target: String,
    start: usize,
    end: usize,
}

/// Two-pass extractor: `[[id]]` wikilinks first, then `@kind:id` for
/// the three kinds we treat as knowledge refs. Byte-offset-based so
/// the snippet extractor can highlight the exact match later.
fn find_refs(body: &str) -> Vec<RefHit> {
    // Examples in code are not links. Keep byte offsets for snippets.
    let mut filtered = body.as_bytes().to_vec();
    let mut in_code = false;
    for (event, range) in pulldown_cmark::Parser::new(body).into_offset_iter() {
        match event {
            pulldown_cmark::Event::Start(pulldown_cmark::Tag::CodeBlock(_)) => in_code = true,
            pulldown_cmark::Event::End(pulldown_cmark::TagEnd::CodeBlock) => in_code = false,
            _ => {},
        }
        if in_code || matches!(event, pulldown_cmark::Event::Code(_)) {
            for byte in &mut filtered[range] { if *byte != b'\n' { *byte = b' '; } }
        }
    }
    let filtered = String::from_utf8(filtered).expect("masked UTF-8 ranges");
    let body = filtered.as_str();
    let mut out: Vec<RefHit> = Vec::new();
    let bytes = body.as_bytes();
    let n = bytes.len();

    // [[wikilinks]]
    let mut i = 0;
    while i + 1 < n {
        if bytes[i] == b'[' && bytes[i + 1] == b'[' {
            if let Some(close) = body[i + 2..].find("]]") {
                let inner_start = i + 2;
                let inner_end = i + 2 + close;
                let inner = &body[inner_start..inner_end];
                if !inner.is_empty() && !inner.contains('\n') && inner.len() < 200 {
                    out.push(RefHit {
                        target: inner.to_string(),
                        start: i,
                        end: inner_end + 2,
                    });
                }
                i = inner_end + 2;
                continue;
            }
        }
        i += 1;
    }

    // @kind:id mentions (only the kinds we treat as knowledge refs).
    for kind in &["knowledge", "note", "page"] {
        let needle = format!("@{kind}:");
        let mut search_from = 0;
        while let Some(pos_in_slice) = body[search_from..].find(&needle) {
            let pos = search_from + pos_in_slice;
            let id_start = pos + needle.len();
            // Mention ids end at whitespace / punctuation. Be liberal —
            // accept anything that isn't whitespace or a few break chars.
            let mut id_end = id_start;
            for c in body[id_start..].chars() {
                if c.is_whitespace() || matches!(c, ',' | ';' | ')' | ']' | '}' | '"' | '\'' | '`') {
                    break;
                }
                id_end += c.len_utf8();
            }
            if id_end > id_start {
                let target = body[id_start..id_end].to_string();
                if !target.is_empty() {
                    out.push(RefHit { target, start: pos, end: id_end });
                }
            }
            search_from = id_end.max(pos + 1);
        }
    }

    // HTML-mode fallback: tiptap-markdown's html mode can serialize a
    // Mention chip as `<span data-id="..." data-mention-kind="knowledge">…</span>`.
    // The plain `@kind:id` text version above is preferred (and what our
    // current Mention serializer emits), but old files written before
    // the dedicated serializer landed will still have the HTML span —
    // pick those up too so the graph survives format migrations.
    let mut span_search = 0;
    while let Some(pos_in_slice) = body[span_search..].find("data-mention-kind=") {
        let pos = span_search + pos_in_slice;
        let kind_value = match read_quoted_attr(&body[pos..], "data-mention-kind=") {
            Some(v) => v,
            None => { span_search = pos + 1; continue; }
        };
        let only_knowledge = matches!(kind_value.as_str(), "knowledge" | "note" | "page");
        // The id is typically on the same span; scan a small window.
        let window_end = (pos + 400).min(body.len());
        let window = &body[pos..clamp_to_char_boundary(body, window_end)];
        let id_value = read_quoted_attr(window, "data-id=");
        if only_knowledge {
            if let Some(target) = id_value {
                if !target.is_empty() {
                    out.push(RefHit { target, start: pos, end: pos + 1 });
                }
            }
        }
        span_search = pos + 1;
    }

    out
}

#[cfg(test)]
mod link_tests {
    use super::*;
    #[test]
    fn ignores_examples_and_resolves_nested_vault_links() {
        let hits = find_refs("[[Base]] `[[Example]]`\n\n```md\n[[Sample]]\n```\n![[image.jpg\\|100x145]]");
        assert_eq!(hits.iter().map(|h| h.target.as_str()).collect::<Vec<_>>(), vec!["Base", "image.jpg\\|100x145"]);
        let dir = std::env::temp_dir().join(format!("atlas-link-test-{}", uuid::Uuid::new_v4()));
        let notes = dir.join(".atlas/knowledge/Vault/Hello");
        fs::create_dir_all(&notes).unwrap();
        fs::write(notes.join("Advance.md"), "[[Base]] [[Base#Heading|Alias]]").unwrap();
        fs::write(notes.join("Base.md"), "Hello").unwrap();
        let graph = build_graph(dir.to_str().unwrap());
        assert_eq!(graph.forwardlinks["Vault/Hello/Advance"], vec!["Vault/Hello/Base"]);
        assert!(!graph.backlinks.contains_key("Base"));
        fs::remove_dir_all(dir).unwrap();
    }
}

/// Read the value of `name="…"` or `name='…'` starting at the head of
/// `src`. Returns None if the attribute isn't a `quote/value/quote`
/// shape at the very start of the slice.
fn read_quoted_attr(src: &str, name: &str) -> Option<String> {
    let head = src.find(name)?;
    let after = head + name.len();
    let bytes = src.as_bytes();
    if after >= bytes.len() { return None; }
    let quote = bytes[after];
    if quote != b'"' && quote != b'\'' { return None; }
    let value_start = after + 1;
    let rest = &src[value_start..];
    let end = rest.find(quote as char)?;
    Some(rest[..end].to_string())
}

/// ~120 chars surrounding the match, with the match wrapped in
/// brackets so the UI can highlight it. Clipped at word boundaries
/// where convenient. Safe over UTF-8 boundaries.
fn extract_snippet(body: &str, start: usize, end: usize) -> String {
    let lo = body
        .char_indices()
        .map(|(i, _)| i).find(|i| *i + SNIPPET_RADIUS >= start)
        .unwrap_or(start.saturating_sub(SNIPPET_RADIUS));
    let hi = body
        .char_indices()
        .map(|(i, c)| i + c.len_utf8()).find(|i| *i >= end + SNIPPET_RADIUS)
        .unwrap_or((end + SNIPPET_RADIUS).min(body.len()));

    let lo = clamp_to_char_boundary(body, lo);
    let hi = clamp_to_char_boundary(body, hi.min(body.len()));
    let before = &body[lo..start.min(hi)];
    let matched = &body[start.min(hi)..end.min(hi)];
    let after = &body[end.min(hi)..hi];

    // Strip newlines so the snippet reads as a single line in the UI.
    let cleaned = format!(
        "{}{{{{ {} }}}}{}",
        before.replace('\n', " "),
        matched.replace('\n', " "),
        after.replace('\n', " "),
    );

    let prefix = if lo > 0 { "…" } else { "" };
    let suffix = if hi < body.len() { "…" } else { "" };
    format!("{}{}{}", prefix, cleaned.trim(), suffix)
}

fn clamp_to_char_boundary(s: &str, i: usize) -> usize {
    let mut j = i.min(s.len());
    while j > 0 && !s.is_char_boundary(j) {
        j -= 1;
    }
    j
}

fn ensure_graph(state: &KnowledgeLinksState, project_path: &str) {
    {
        let by_proj = state.by_project.read();
        if matches!(by_proj.get(project_path), Some(Some(_))) {
            return;
        }
    }
    let graph = build_graph(project_path);
    let mut by_proj = state.by_project.write();
    by_proj.insert(project_path.to_string(), Some(graph));
}

/* ── Commands ───────────────────────────────────────────────────── */

#[tauri::command]
pub async fn knowledge_backlinks(
    project_path: String,
    entry_id: String,
    state: State<'_, Arc<KnowledgeLinksState>>,
) -> Result<Vec<Backlink>, String> {
    let state = Arc::clone(state.inner());
    tokio::task::spawn_blocking(move || {
        ensure_graph(&state, &project_path);
        let by_proj = state.by_project.read();
        let graph = match by_proj.get(&project_path) {
            Some(Some(g)) => g,
            _ => return Ok(Vec::new()),
        };
        Ok(graph.backlinks.get(&entry_id).cloned().unwrap_or_default())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn knowledge_link_counts(
    project_path: String,
    entry_id: String,
    state: State<'_, Arc<KnowledgeLinksState>>,
) -> Result<LinkCounts, String> {
    let state = Arc::clone(state.inner());
    tokio::task::spawn_blocking(move || {
        ensure_graph(&state, &project_path);
        let by_proj = state.by_project.read();
        let graph = match by_proj.get(&project_path) {
            Some(Some(g)) => g,
            _ => return Ok(LinkCounts::default()),
        };
        Ok(LinkCounts {
            backlinks: graph.backlinks.get(&entry_id).map(std::vec::Vec::len).unwrap_or(0),
            forwardlinks: graph.forwardlinks.get(&entry_id).map(std::vec::Vec::len).unwrap_or(0),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Drop the cached graph for a KB root + emit `atlas:knowledge:links-changed`.
///
/// The cache is keyed by root and only ever dropped here, so anything that
/// changes what `walk_kb` would see for a root — a note save, a delete, or a
/// folder mounted into / unmounted from it — has to call this. Mounting in
/// particular is easy to miss: no note changed, but the root gained a whole
/// subtree of them, and a root whose graph was already built would otherwise
/// keep serving the pre-mount (often empty) graph for the rest of the session.
pub(crate) fn invalidate(state: &KnowledgeLinksState, app: &AppHandle, project_path: &str) {
    state.by_project.write().remove(project_path);
    let _ = app.emit(
        "atlas:knowledge:links-changed",
        serde_json::json!({ "projectPath": project_path }),
    );
}

/// Drop the cached graph + emit `atlas:knowledge:links-changed` so the
/// frontend re-pulls. Cheap — frontend calls after every save/delete.
#[tauri::command]
pub async fn knowledge_links_invalidate(
    project_path: String,
    state: State<'_, Arc<KnowledgeLinksState>>,
    app: AppHandle,
) -> Result<(), String> {
    invalidate(&state, &app, &project_path);
    Ok(())
}

/// Project-wide graph projection for the Obsidian-style graph view.
/// Surfaces every note as a node (including isolated ones) so the
/// canvas isn't sparse for fresh projects, and dedupes A→B / B→A into
/// a single undirected edge for layout purposes (the picker / inspector
/// keep the directed `LinkGraph` for their own needs).
#[tauri::command]
pub async fn knowledge_links_graph(
    project_path: String,
    state: State<'_, Arc<KnowledgeLinksState>>,
) -> Result<ProjectGraph, String> {
    let state = Arc::clone(state.inner());
    tokio::task::spawn_blocking(move || {
        ensure_graph(&state, &project_path);
        let by_proj = state.by_project.read();
        let graph = match by_proj.get(&project_path) {
            Some(Some(g)) => g,
            _ => return Ok(ProjectGraph::default()),
        };

        // Collect every known id from notes + both link sides.
        // Notes-walk gives us isolated ones; the maps catch any
        // referenced-but-not-on-disk ids (shouldn't happen, but safe).
        let mut titles: HashMap<String, String> = HashMap::new();
        for n in &graph.notes {
            titles.insert(n.id.clone(), n.title.clone());
        }
        for id in graph.backlinks.keys() {
            titles.entry(id.clone()).or_insert_with(|| id.clone());
        }
        for id in graph.forwardlinks.keys() {
            titles.entry(id.clone()).or_insert_with(|| id.clone());
        }

        // Dedupe edges as undirected pairs.
        let mut edges: Vec<GraphEdge> = Vec::new();
        let mut seen_pairs: std::collections::HashSet<(String, String)> = Default::default();
        for (from, targets) in &graph.forwardlinks {
            for to in targets {
                if from == to { continue; }
                let key = if from < to { (from.clone(), to.clone()) } else { (to.clone(), from.clone()) };
                if seen_pairs.insert(key) {
                    edges.push(GraphEdge { from: from.clone(), to: to.clone() });
                }
            }
        }

        // Degrees from the directed graph: out = forwardlinks count,
        // in = backlinks count. Used by the renderer to scale hub nodes
        // bigger.
        let mut nodes: Vec<GraphNode> = titles
            .into_iter()
            .map(|(id, title)| {
                let out_degree = graph
                    .forwardlinks
                    .get(&id)
                    .map(|v| v.len() as u32)
                    .unwrap_or(0);
                let in_degree = graph
                    .backlinks
                    .get(&id)
                    .map(|v| v.len() as u32)
                    .unwrap_or(0);
                GraphNode { id, title, in_degree, out_degree }
            })
            .collect();
        nodes.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(ProjectGraph { nodes, edges })
    })
    .await
    .map_err(|e| e.to_string())?
}
