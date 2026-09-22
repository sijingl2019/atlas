//! Knowledge Base semantic recall backed by the local embedding model.
//!
//! This is intentionally independent from the agent-memory engine: the KB index
//! lives under `<project>/.atlas/knowledge-index/` and is queried with
//! `MemoryEngine::retrieve_embeddings`, so graph/global agent memory never leaks
//! into a KB search result.
//!
//! The first semantic search after a model switch (or on a fresh install) may
//! download the model through the existing Local Model Manager; after that the
//! whole path runs on-device.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use atlas_memory::{CorpusDoc, MemoryEngine};
use dashmap::DashMap;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};
use tokio::sync::RwLock;

use super::knowledge_meta::read_meta_file;
use super::memory_indexer::MemoryRegistry;

const DEFAULT_LIMIT: usize = 20;
const MAX_LIMIT: usize = 50;
const SNIPPET_CHARS: usize = 240;

/// One ranked KB note. Chunks from the same note are collapsed to the best hit.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeRecallHit {
    pub entry_id: String,
    pub title: String,
    pub snippet: String,
    pub source: String,
    pub score: f32,
}

/// Per-project KB engines. Kept separate from [`MemoryRegistry`] so the KB
/// index can never be mixed with agent memory (different dir, different corpus).
pub struct KnowledgeRecallState {
    engines: DashMap<String, Arc<RwLock<MemoryEngine>>>,
}

impl KnowledgeRecallState {
    pub fn new() -> Self {
        Self {
            engines: DashMap::new(),
        }
    }

    fn engine_for(&self, project_path: &str) -> Arc<RwLock<MemoryEngine>> {
        self.engines
            .entry(project_path.to_string())
            .or_insert_with(|| {
                let root = PathBuf::from(project_path);
                let index_dir = root.join(".atlas").join("knowledge-index");
                Arc::new(RwLock::new(MemoryEngine::open_at_dir(root, index_dir)))
            })
            .value()
            .clone()
    }
}

impl Default for KnowledgeRecallState {
    fn default() -> Self {
        Self::new()
    }
}

/// Semantic search across the Knowledge Base.
///
/// The corpus is re-collected on every call and diffed against the persisted
/// manifest, so only changed chunks are embedded. `model_not_downloaded` is
/// returned as a stable prefix when the selected local embedding model is not
/// on disk; title search remains usable without it.
#[tauri::command]
#[expect(
    clippy::await_holding_invalid_type,
    reason = "the KB write lock must span index + query so a concurrent recall cannot observe a half-rebuilt index"
)]
pub async fn knowledge_recall(
    project_path: String,
    query: String,
    limit: Option<usize>,
    app: AppHandle,
    registry: State<'_, Arc<MemoryRegistry>>,
    state: State<'_, Arc<KnowledgeRecallState>>,
) -> Result<Vec<KnowledgeRecallHit>, String> {
    if query.trim().chars().count() < 2 {
        return Ok(Vec::new());
    }

    let model_id = super::models::selected_embedding_id(&app);
    if !super::models::is_downloaded(&app, &model_id) {
        return Err(format!("model_not_downloaded: {model_id}"));
    }
    let provider = registry
        .provider(&app)
        .await
        .ok_or_else(|| format!("model_not_downloaded: {model_id}"))?;

    let path = project_path.clone();
    let (docs, sources) = tokio::task::spawn_blocking(move || collect_docs(&path))
        .await
        .map_err(|e| e.to_string())?;

    let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let engine = state.engine_for(&project_path);

    let hits = {
        let mut guard = engine.write().await;
        if !guard.index_params_match(&provider) {
            guard
                .reset_index(provider.provider_name(), provider.dim())
                .map_err(|e| e.to_string())?;
        }
        guard
            .index_corpus(&docs, &provider)
            .await
            .map_err(|e| e.to_string())?;
        guard
            .retrieve_embeddings(&query, limit, &provider)
            .await
            .map_err(|e| e.to_string())?
    };

    Ok(aggregate(hits, &sources, limit))
}

/// Rebuild the KB semantic index from scratch: wipe the persisted HNSW +
/// manifest + docstore, re-collect the corpus, and re-embed every chunk.
///
/// Used by the sidebar's "Rebuild index" menu when the index is suspected to be
/// stale or corrupt. The caller passes the scoped KB root (`useKbRoot()`), so
/// rebuilding from the "view" scope rebuilds the current project's KB index and
/// from "global" rebuilds the whole global KB.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeRebuildResult {
    /// Number of KB notes collected from the corpus.
    pub notes: usize,
    /// Number of chunks re-embedded and added to the fresh index.
    pub chunks_indexed: usize,
}

#[tauri::command]
#[expect(
    clippy::await_holding_invalid_type,
    reason = "the KB write lock must span reset + re-index so a concurrent recall cannot observe a half-built index"
)]
pub async fn knowledge_rebuild_index(
    project_path: String,
    app: AppHandle,
    registry: State<'_, Arc<MemoryRegistry>>,
    state: State<'_, Arc<KnowledgeRecallState>>,
) -> Result<KnowledgeRebuildResult, String> {
    let model_id = super::models::selected_embedding_id(&app);
    if !super::models::is_downloaded(&app, &model_id) {
        return Err(format!("model_not_downloaded: {model_id}"));
    }
    let provider = registry
        .provider(&app)
        .await
        .ok_or_else(|| format!("model_not_downloaded: {model_id}"))?;

    let path = project_path.clone();
    let (docs, _sources) = tokio::task::spawn_blocking(move || collect_docs(&path))
        .await
        .map_err(|e| e.to_string())?;

    let engine = state.engine_for(&project_path);
    let stats = {
        let mut guard = engine.write().await;
        guard
            .reset_index(provider.provider_name(), provider.dim())
            .map_err(|e| e.to_string())?;
        guard
            .index_corpus(&docs, &provider)
            .await
            .map_err(|e| e.to_string())?
    };

    tracing::info!(
        project = %project_path,
        notes = docs.len(),
        chunks = stats.added,
        "rebuilt knowledge base index"
    );
    Ok(KnowledgeRebuildResult {
        notes: docs.len(),
        chunks_indexed: stats.added,
    })
}

/// Read every KB markdown note into the neutral corpus shape.
///
/// Returns `(docs, entry_id -> file_path)`; the path map lets the UI show a
/// stable source label without a second filesystem walk.
fn collect_docs(project_path: &str) -> (Vec<CorpusDoc>, HashMap<String, String>) {
    let meta = read_meta_file(project_path);
    let mut docs = Vec::new();
    let mut sources = HashMap::new();

    for (id, path) in super::knowledge::walk_kb(project_path) {
        let Ok(body) = std::fs::read_to_string(&path) else {
            continue;
        };
        let page = meta.pages.get(&id);
        let title = page
            .and_then(|p| p.title.as_deref())
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_string)
            .or_else(|| heading_title(&body))
            .unwrap_or_else(|| filename_title(&id, &path));
        let chunk_mode = page.and_then(|p| p.chunk_mode).unwrap_or_default();
        let text = if body.trim().is_empty() {
            title.clone()
        } else {
            format!("{title}\n\n{body}")
        };
        let content_hash = hash_text(&text);

        sources.insert(id.clone(), path.to_string_lossy().to_string());
        docs.push(CorpusDoc {
            id,
            text,
            content_hash,
            corpus: "knowledge".to_string(),
            chunk_mode,
        });
    }

    (docs, sources)
}

fn heading_title(body: &str) -> Option<String> {
    body.lines().find_map(|line| {
        let trimmed = line.trim();
        trimmed
            .strip_prefix("# ")
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(str::to_string)
    })
}

fn filename_title(id: &str, path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| id.to_string())
}

fn hash_text(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    format!("{:x}", h.finalize())
}

fn aggregate(
    hits: Vec<atlas_memory::RetrievedDoc>,
    sources: &HashMap<String, String>,
    limit: usize,
) -> Vec<KnowledgeRecallHit> {
    let total = hits.len().max(1);
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut out: Vec<KnowledgeRecallHit> = Vec::new();

    for (rank, doc) in hits.into_iter().enumerate() {
        let entry_id = if doc.parent_id.is_empty() {
            doc.id.clone()
        } else {
            doc.parent_id.clone()
        };
        if seen.contains_key(&entry_id) {
            continue;
        }
        if out.len() >= limit {
            break;
        }
        seen.insert(entry_id.clone(), rank);

        let title = if doc.title.trim().is_empty() {
            entry_id.clone()
        } else {
            doc.title.clone()
        };
        let body = if doc.text.trim().is_empty() {
            title.clone()
        } else {
            doc.text.clone()
        };
        out.push(KnowledgeRecallHit {
            entry_id: entry_id.clone(),
            title,
            snippet: make_snippet(&body),
            source: sources.get(&entry_id).cloned().unwrap_or_default(),
            score: 1.0 - (rank as f32 / total as f32),
        });
    }

    out
}

fn make_snippet(text: &str) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= SNIPPET_CHARS {
        return collapsed;
    }
    let mut out: String = collapsed.chars().take(SNIPPET_CHARS).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heading_title_prefers_first_h1() {
        assert_eq!(
            heading_title("intro\n# Real title\ntext"),
            Some("Real title".to_string())
        );
        assert_eq!(heading_title("no heading"), None);
    }

    #[test]
    fn snippet_is_collapsed_and_truncated() {
        assert_eq!(make_snippet("a\n\n  b"), "a b");
        let long = "字".repeat(SNIPPET_CHARS + 10);
        let snippet = make_snippet(&long);
        assert_eq!(snippet.chars().count(), SNIPPET_CHARS + 1);
        assert!(snippet.ends_with('…'));
    }

    #[test]
    fn aggregate_keeps_best_chunk_per_entry() {
        let mut sources = HashMap::new();
        sources.insert("kb:a".to_string(), "/tmp/a.md".to_string());
        let hits = vec![
            atlas_memory::RetrievedDoc {
                id: "kb:a#1".to_string(),
                parent_id: "kb:a".to_string(),
                chunk_index: 0,
                title: "A".to_string(),
                source: "knowledge".to_string(),
                text: "first".to_string(),
            },
            atlas_memory::RetrievedDoc {
                id: "kb:a#2".to_string(),
                parent_id: "kb:a".to_string(),
                chunk_index: 1,
                title: "A".to_string(),
                source: "knowledge".to_string(),
                text: "second".to_string(),
            },
        ];
        let out = aggregate(hits, &sources, 10);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].snippet, "first");
        assert_eq!(out[0].source, "/tmp/a.md");
    }
}