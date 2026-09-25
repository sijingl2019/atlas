//! Which Knowledge Base notes each conversation used, and the reverse.
//!
//! Three live hooks feed one store (see `docs/superpowers/specs/
//! 2026-09-25-knowledge-refs-design.md`):
//!
//! - `agents_send` → `@note` mentions in the composed prompt ([`KnowledgeRefsState::note_prompt`]);
//! - the delta pipeline → read-shaped tool calls on KB files ([`KnowledgeRefsMiddleware`]);
//! - the memory tool server → KB documents `memory_search` returned
//!   ([`KnowledgeRefsState::note_search`]).
//!
//! History is backfilled on a project's first query. Every write happens on
//! one worker thread, so the live hooks never touch disk on the emit or send
//! path, and the backfill never races a live write for the database.

pub mod backfill;
pub mod extract;
pub mod store;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard};

use atlas_agent_wire::{MessageRole, SessionDelta, SessionDeltaEnvelope, ToolCallStatus};
use atlas_bus::OutboundMiddleware;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use extract::{KbRoots, Ref, RefKind, TitleIndex};
use store::{EntryRefRow, RefStore};

/// Fired after new references land. `sessionId` is absent after a backfill,
/// which may have touched any session in the project.
pub const CHANGED_EVENT: &str = "atlas:knowledge-refs-changed";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChangedPayload {
    cwd: String,
    session_id: Option<String>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

enum Job {
    Record {
        cwd: String,
        session_id: String,
        refs: Vec<Ref>,
        unresolved: Vec<String>,
        unresolved_key: String,
    },
    ReadCall {
        cwd: String,
        session_id: String,
        call_id: String,
        locations: Vec<serde_json::Value>,
        arguments: serde_json::Value,
    },
    Backfill {
        cwd: String,
    },
}

pub struct KnowledgeRefsState {
    tx: Mutex<mpsc::Sender<Job>>,
    shared: Arc<Shared>,
}

/// What the worker and the commands both read.
struct Shared {
    app: Mutex<Option<AppHandle>>,
    /// Session → project, registered by the send path. Deltas and tool calls
    /// carry a session id only.
    sessions: Mutex<HashMap<String, String>>,
    /// Projects whose history is being read now.
    backfilling: Mutex<HashSet<String>>,
    /// Projects whose history this process has already read (or found nothing
    /// to read in), so a query does not re-queue it.
    backfilled: Mutex<HashSet<String>>,
}

impl KnowledgeRefsState {
    pub fn new() -> Self {
        let (tx, rx) = mpsc::channel();
        let shared = Arc::new(Shared {
            app: Mutex::new(None),
            sessions: Mutex::new(HashMap::new()),
            backfilling: Mutex::new(HashSet::new()),
            backfilled: Mutex::new(HashSet::new()),
        });
        let worker_shared = shared.clone();
        let spawned = std::thread::Builder::new()
            .name("knowledge-refs".into())
            .spawn(move || worker(rx, worker_shared));
        if let Err(e) = spawned {
            tracing::error!(target: "atlas::knowledge_refs", "worker failed to start: {e}");
        }
        Self {
            tx: Mutex::new(tx),
            shared,
        }
    }

    /// The handle the worker announces through and finds transcripts with.
    pub fn install(&self, app: AppHandle) {
        *lock(&self.shared.app) = Some(app);
    }

    fn submit(&self, job: Job) {
        let _ = lock(&self.tx).send(job);
    }

    /// The send path: bind the session to its project and record the notes
    /// the composed prompt attached.
    pub fn note_prompt(&self, session_id: &str, cwd: &str, text: &str) {
        if session_id.is_empty() || cwd.is_empty() {
            return;
        }
        lock(&self.shared.sessions).insert(session_id.to_string(), cwd.to_string());
        self.note_mentions(session_id, cwd, text);
    }

    fn note_mentions(&self, session_id: &str, cwd: &str, text: &str) {
        let refs = extract::mentions(text);
        if refs.is_empty() {
            return;
        }
        self.submit(Job::Record {
            cwd: cwd.to_string(),
            session_id: session_id.to_string(),
            refs,
            unresolved: Vec::new(),
            unresolved_key: String::new(),
        });
    }

    /// The memory tool server handed `docs` (corpus ids) to a session.
    pub fn note_search(&self, session_id: &str, cwd: &str, query: &str, doc_ids: &[String]) {
        if session_id.is_empty() || cwd.is_empty() {
            return;
        }
        let key = extract::search_key(query);
        let mut refs: Vec<Ref> = Vec::new();
        for entry_id in doc_ids
            .iter()
            .filter_map(|id| extract::entry_from_doc_id(id))
        {
            if !refs.iter().any(|r| r.entry_id == entry_id) {
                refs.push(Ref {
                    entry_id,
                    kind: RefKind::Retrieved,
                    source_key: key.clone(),
                });
            }
        }
        if refs.is_empty() {
            return;
        }
        self.submit(Job::Record {
            cwd: cwd.to_string(),
            session_id: session_id.to_string(),
            refs,
            unresolved: Vec::new(),
            unresolved_key: String::new(),
        });
    }

    fn cwd_for(&self, session_id: &str) -> Option<String> {
        lock(&self.shared.sessions).get(session_id).cloned()
    }

    /// Queue a backfill for `cwd` unless one ran or is running. Returns
    /// whether history is still being read.
    fn ensure_backfill(&self, cwd: &str) -> bool {
        if lock(&self.shared.backfilled).contains(cwd) {
            return false;
        }
        if !lock(&self.shared.backfilling).insert(cwd.to_string()) {
            return true;
        }
        self.submit(Job::Backfill {
            cwd: cwd.to_string(),
        });
        true
    }
}

impl Default for KnowledgeRefsState {
    fn default() -> Self {
        Self::new()
    }
}

// ── Worker ───────────────────────────────────────────────────────────────────

fn worker(rx: mpsc::Receiver<Job>, shared: Arc<Shared>) {
    let mut stores: HashMap<String, RefStore> = HashMap::new();
    while let Ok(job) = rx.recv() {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            process(job, &mut stores, &shared)
        }));
        if result.is_err() {
            tracing::error!(target: "atlas::knowledge_refs", "job panicked; dropped");
        }
    }
}

fn store_for<'a>(stores: &'a mut HashMap<String, RefStore>, cwd: &str) -> Option<&'a mut RefStore> {
    if !stores.contains_key(cwd) {
        match RefStore::open(cwd, true) {
            Ok(Some(store)) => {
                stores.insert(cwd.to_string(), store);
            }
            Ok(None) => return None,
            Err(e) => {
                tracing::warn!(target: "atlas::knowledge_refs", "open {cwd}: {e}");
                return None;
            }
        }
    }
    stores.get_mut(cwd)
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn process(job: Job, stores: &mut HashMap<String, RefStore>, shared: &Shared) {
    match job {
        Job::Record {
            cwd,
            session_id,
            refs,
            unresolved,
            unresolved_key,
        } => {
            let Some(store) = store_for(stores, &cwd) else {
                return;
            };
            let mut added = store
                .insert(&session_id, &refs, &now())
                .unwrap_or_else(|e| {
                    tracing::warn!(target: "atlas::knowledge_refs", "record: {e}");
                    0
                });
            added += store
                .insert_unresolved(&session_id, &unresolved, &unresolved_key)
                .unwrap_or(0);
            if added > 0 {
                announce(shared, &cwd, Some(&session_id));
            }
        }
        Job::ReadCall {
            cwd,
            session_id,
            call_id,
            locations,
            arguments,
        } => {
            let refs = extract::reads(&KbRoots::load(&cwd), &call_id, &locations, &arguments);
            if refs.is_empty() {
                return;
            }
            let Some(store) = store_for(stores, &cwd) else {
                return;
            };
            if store.insert(&session_id, &refs, &now()).unwrap_or(0) > 0 {
                announce(shared, &cwd, Some(&session_id));
            }
        }
        Job::Backfill { cwd } => {
            run_backfill(&cwd, stores, shared);
            lock(&shared.backfilling).remove(&cwd);
            lock(&shared.backfilled).insert(cwd.clone());
            announce(shared, &cwd, None);
        }
    }
}

fn has_knowledge_base(cwd: &str) -> bool {
    Path::new(cwd).join(".atlas").join("knowledge").is_dir()
        || !super::knowledge::load_sources(cwd).is_empty()
}

fn run_backfill(cwd: &str, stores: &mut HashMap<String, RefStore>, shared: &Shared) {
    // A project with no Knowledge Base has nothing any conversation could
    // have referenced — and must not get a database for asking.
    if !has_knowledge_base(cwd) {
        return;
    }
    let Some(store) = store_for(stores, cwd) else {
        return;
    };
    if store
        .backfill_version()
        .ok()
        .flatten()
        .is_some_and(|v| v >= backfill::EXTRACTOR_VERSION)
    {
        return;
    }

    let started = std::time::Instant::now();
    let config_dir = lock(&shared.app)
        .as_ref()
        .and_then(|app| app.path().app_config_dir().ok());
    let mut outcome = backfill::Outcome::default();
    if let Some(dir) = &config_dir {
        let found = backfill::from_transcripts(store, backfill::recorded_transcripts(dir, cwd));
        outcome.refs += found.refs;
    }

    let root = PathBuf::from(cwd);
    if atlas_checkpoint::atlas_dir(&root)
        .join("sessions.db")
        .exists()
    {
        match atlas_checkpoint::Store::open_reader(atlas_checkpoint::atlas_dir(&root)) {
            Ok(capture) => {
                let roots = KbRoots::load(cwd);
                let titles = title_index(cwd);
                let workspace_id = super::capture::project_id_for(&root);
                let found = backfill::from_capture(store, &capture, &workspace_id, &roots, &titles);
                outcome.refs += found.refs;
                outcome.unresolved += found.unresolved;
            }
            Err(e) => {
                tracing::warn!(target: "atlas::knowledge_refs", "backfill: capture store: {e}")
            }
        }
    }

    if let Err(e) = store.set_backfill_version(backfill::EXTRACTOR_VERSION) {
        tracing::warn!(target: "atlas::knowledge_refs", "backfill: version: {e}");
    }
    tracing::info!(
        target: "atlas::knowledge_refs",
        project = %cwd,
        refs = outcome.refs,
        unresolved = outcome.unresolved,
        elapsed_ms = started.elapsed().as_millis() as u64,
        "backfilled knowledge references"
    );
}

fn title_index(cwd: &str) -> TitleIndex {
    let ids: Vec<String> = super::knowledge::walk_kb(cwd)
        .into_iter()
        .map(|(id, _)| id)
        .collect();
    TitleIndex::build(&ids, &super::knowledge_meta::read_meta_file(cwd))
}

fn announce(shared: &Shared, cwd: &str, session_id: Option<&str>) {
    if let Some(app) = lock(&shared.app).as_ref() {
        let _ = app.emit(
            CHANGED_EVENT,
            ChangedPayload {
                cwd: cwd.to_string(),
                session_id: session_id.map(str::to_string),
            },
        );
    }
}

// ── Delta pipeline ───────────────────────────────────────────────────────────

/// Picks KB reads (and queued-send mentions) off the delta stream. Only
/// enqueues: the path check and the write happen on the worker.
pub struct KnowledgeRefsMiddleware {
    pub app: AppHandle,
}

impl OutboundMiddleware<SessionDeltaEnvelope> for KnowledgeRefsMiddleware {
    fn on_event(&self, envelope: &SessionDeltaEnvelope) {
        let state = self.app.state::<KnowledgeRefsState>();
        match &envelope.delta {
            SessionDelta::ToolCallUpserted { tool_call, .. } => {
                if tool_call.status != ToolCallStatus::Completed {
                    return;
                }
                let name = atlas_checkpoint::canonical_name(
                    Some(&tool_call.tool_name),
                    tool_call.title.as_deref(),
                    tool_call.kind.as_deref(),
                    &tool_call.arguments,
                );
                if name != atlas_checkpoint::tools::ToolName::Read {
                    return;
                }
                let Some(cwd) = state.cwd_for(&envelope.session_id) else {
                    return;
                };
                state.submit(Job::ReadCall {
                    cwd,
                    session_id: envelope.session_id.clone(),
                    call_id: tool_call.id.clone(),
                    locations: tool_call.locations.clone(),
                    arguments: tool_call.arguments.clone(),
                });
            }
            // A queued send reaches the agent without passing `agents_send`;
            // its echo is the only place its mentions appear. The echo of an
            // ordinary send carries the same text, so it lands on the same
            // event key and adds nothing.
            SessionDelta::MessageAppended { message } if message.role == MessageRole::User => {
                if let Some(cwd) = state.cwd_for(&envelope.session_id) {
                    state.note_mentions(&envelope.session_id, &cwd, &message.content);
                }
            }
            _ => {}
        }
    }
}

// ── Commands ─────────────────────────────────────────────────────────────────

/// A note a session referenced, ready to render.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRef {
    pub entry_id: String,
    pub kind: String,
    pub hits: i64,
    pub last_at: String,
    pub title: String,
    pub icon: Option<String>,
    /// False when the note has since been deleted or moved.
    pub exists: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRefs {
    pub refs: Vec<SessionRef>,
    pub unresolved: i64,
    pub backfilling: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryRefs {
    pub sessions: Vec<EntryRefRow>,
    pub backfilling: bool,
}

fn entry_exists(cwd: &str, entry_id: &str) -> bool {
    super::knowledge::note_file(cwd, entry_id).is_ok_and(|p| p.exists())
        || super::knowledge::resolve_kb_path(cwd, entry_id).is_ok_and(|p| p.is_file())
}

fn session_refs_sync(cwd: &str, session_id: &str) -> Result<(Vec<SessionRef>, i64), String> {
    let Some(store) = RefStore::open(cwd, false)? else {
        return Ok((Vec::new(), 0));
    };
    let rows = store.for_session(session_id)?;
    let unresolved = store.unresolved_count(session_id)?;
    let meta = super::knowledge_meta::read_meta_file(cwd);
    let refs = rows
        .into_iter()
        .map(|row| {
            let page = meta.pages.get(&row.entry_id);
            let title = page
                .and_then(|p| p.title.clone())
                .filter(|t| !t.trim().is_empty())
                .unwrap_or_else(|| {
                    row.entry_id
                        .rsplit('/')
                        .next()
                        .unwrap_or(&row.entry_id)
                        .to_string()
                });
            SessionRef {
                exists: entry_exists(cwd, &row.entry_id),
                icon: page.and_then(|p| p.icon.clone()),
                title,
                entry_id: row.entry_id,
                kind: row.kind,
                hits: row.hits,
                last_at: row.last_at,
            }
        })
        .collect();
    Ok((refs, unresolved))
}

/// The notes one conversation referenced.
#[tauri::command]
pub async fn knowledge_refs_for_session(
    state: tauri::State<'_, KnowledgeRefsState>,
    project_path: String,
    session_id: String,
) -> Result<SessionRefs, String> {
    let backfilling = state.ensure_backfill(&project_path);
    let (refs, unresolved) =
        tokio::task::spawn_blocking(move || session_refs_sync(&project_path, &session_id))
            .await
            .map_err(|e| e.to_string())??;
    Ok(SessionRefs {
        refs,
        unresolved,
        backfilling,
    })
}

/// The conversations that referenced one note.
#[tauri::command]
pub async fn knowledge_refs_for_entry(
    state: tauri::State<'_, KnowledgeRefsState>,
    project_path: String,
    entry_id: String,
) -> Result<EntryRefs, String> {
    let backfilling = state.ensure_backfill(&project_path);
    let sessions = tokio::task::spawn_blocking(move || -> Result<Vec<EntryRefRow>, String> {
        match RefStore::open(&project_path, false)? {
            Some(store) => store.for_entry(&entry_id),
            None => Ok(Vec::new()),
        }
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(EntryRefs {
        sessions,
        backfilling,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project_with_kb() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".atlas/knowledge/arch")).unwrap();
        std::fs::write(dir.path().join(".atlas/knowledge/arch/auth.md"), "# a").unwrap();
        dir
    }

    fn wait_for(mut done: impl FnMut() -> bool) {
        for _ in 0..200 {
            if done() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        panic!("timed out");
    }

    #[test]
    fn a_sent_mention_and_a_kb_read_reach_the_store() {
        let dir = project_with_kb();
        let cwd = dir.path().to_string_lossy().to_string();
        let state = KnowledgeRefsState::new();

        state.note_prompt(
            "s1",
            &cwd,
            "why?\n\n---\n# Atlas context\n\n## @note:arch/auth\n",
        );
        state.submit(Job::ReadCall {
            cwd: cwd.clone(),
            session_id: "s1".into(),
            call_id: "c1".into(),
            locations: vec![serde_json::json!({
                "path": format!("{cwd}/.atlas/knowledge/arch/auth.md")
            })],
            arguments: serde_json::Value::Null,
        });
        state.note_search(
            "s1",
            &cwd,
            "auth",
            &["kb:arch/auth".into(), "shared:x:1".into()],
        );

        wait_for(|| {
            session_refs_sync(&cwd, "s1")
                .map(|(refs, _)| refs.len() == 3)
                .unwrap_or(false)
        });
        let (refs, _) = session_refs_sync(&cwd, "s1").unwrap();
        assert!(refs.iter().all(|r| r.entry_id == "arch/auth" && r.exists));
        assert_eq!(refs[0].title, "auth");
    }

    #[test]
    fn a_project_without_a_kb_gets_no_database_from_a_backfill() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_string_lossy().to_string();
        let state = KnowledgeRefsState::new();
        assert!(state.ensure_backfill(&cwd));
        wait_for(|| lock(&state.shared.backfilled).contains(&cwd));
        assert!(!store::db_path(&cwd).exists());
        assert!(!state.ensure_backfill(&cwd));
    }

    #[test]
    fn a_backfill_stamps_the_version_so_it_runs_once() {
        let dir = project_with_kb();
        let cwd = dir.path().to_string_lossy().to_string();
        let state = KnowledgeRefsState::new();
        state.ensure_backfill(&cwd);
        wait_for(|| lock(&state.shared.backfilled).contains(&cwd));
        let store = RefStore::open(&cwd, false).unwrap().unwrap();
        assert_eq!(
            store.backfill_version().unwrap(),
            Some(backfill::EXTRACTOR_VERSION)
        );
    }
}
