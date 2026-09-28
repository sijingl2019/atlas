//! The subagent registry, and what each tool does to it.
//!
//! Every operation is scoped to a *caller* — the session the tool call came
//! from — so an agent can only ever see and steer its own children. The
//! semantics follow herdr's `agent` commands:
//!
//! - `start` refuses a name the caller already used, and a caller that is
//!   itself a child (depth 1: a child cannot start agents).
//! - `prompt` refuses a child that is blocked on a permission (`agent_blocked`)
//!   or still working (`agent_busy`) — a second send would supersede the turn.
//! - `wait` returns when the child settles or blocks, and a timeout is a
//!   result (`timed_out: true`), not an error, so the caller just waits again.
//! - Nothing here approves a permission. Only the user does, from the panel.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::schema::v1 as acp;
use atlas_agent_wire::{MessageMode, MessageRole, SessionDeltaEnvelope};
use atlas_native_agent::CERSEI_AGENT_ID;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::watch;
use uuid::Uuid;

use super::model::{apply_delta, SubagentEvent, SubagentRecord, SubagentStatus, SubagentView};
use crate::commands::agent_host::{AgentHost, SessionKey};
use atlas_agent_wire::AgentId;

pub const MAX_CHILDREN_PER_PARENT: usize = 8;
pub const MAX_LIVE_TOTAL: usize = 16;
pub const WAIT_DEFAULT_MS: u64 = 120_000;
/// Under the MCP tool-call timeout of the agents that call `wait` (Codex's is
/// 300 s), so a long wait comes back as `timed_out` rather than as a failed
/// tool call.
pub const WAIT_MAX_MS: u64 = 280_000;
const READ_DEFAULT_LINES: usize = 80;
const READ_MAX_LINES: usize = 400;

/// A tool failure the calling agent can act on: a stable code and a sentence.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SubagentError {
    pub code: &'static str,
    pub message: String,
}

impl SubagentError {
    pub(super) fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn not_found(name: &str) -> Self {
        Self::new(
            "not_found",
            format!("no agent named `{name}` was started by this session"),
        )
    }
}

impl std::fmt::Display for SubagentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

pub type Result<T> = std::result::Result<T, SubagentError>;

/// The session a tool call came from.
#[derive(Debug, Clone)]
pub struct Caller {
    pub session_id: String,
    pub plugin_id: String,
    pub cwd: String,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Until {
    /// Done, idle, errored, stopped — or blocked (a settled state for the
    /// caller: nothing will happen until the user answers).
    #[default]
    Settled,
    /// Finished the turn (blocked does not count).
    Done,
    Blocked,
}

impl Until {
    fn reached(self, status: SubagentStatus) -> bool {
        match self {
            Self::Settled => status.is_settled() || status == SubagentStatus::Blocked,
            Self::Done => status.is_settled(),
            Self::Blocked => status == SubagentStatus::Blocked,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReadSource {
    /// From the last prompt to the end.
    #[default]
    LastTurn,
    /// The last N lines of the whole transcript.
    Recent,
}

#[derive(Debug, Clone, Serialize)]
pub struct WaitResult {
    pub agent: SubagentView,
    pub reached: bool,
    pub timed_out: bool,
}

type Emit = Arc<dyn Fn(&SubagentEvent) + Send + Sync>;

/// The host-side operations the manager needs, behind a seam so the rules
/// can be tested without an agent process.
pub trait SubagentHost: Send + Sync {
    fn session_info(&self, session_id: &str) -> Option<(String, String)>;
    fn is_installed(&self, plugin_id: &str) -> bool;
    /// Open a session for a child. `mode`, when given, is the parent's mode:
    /// a child of the same agent runs under the permissions its parent was
    /// given (a parent set to ask for approval must not start children that
    /// never ask).
    fn start_session(
        &self,
        plugin_id: String,
        cwd: String,
        mode: Option<String>,
    ) -> futures::future::BoxFuture<'static, std::result::Result<SessionKey, String>>;
    /// The mode `session_id` is in, when its agent has modes.
    fn current_mode(&self, session_id: &str) -> Option<String>;
    fn send(&self, key: &SessionKey, text: String) -> std::result::Result<(), String>;
    fn cancel(&self, key: &SessionKey) -> std::result::Result<(), String>;
    fn drop_session(
        &self,
        session_id: String,
    ) -> futures::future::BoxFuture<'static, std::result::Result<(), String>>;
    fn transcript(
        &self,
        key: &SessionKey,
    ) -> std::result::Result<Vec<atlas_agent_wire::Message>, String>;
    /// End a child's own agent connection (and so its process), if it has
    /// one. Called once the child is gone.
    fn release(&self, agent_handle: AgentId);
    /// Reopen a child's stored session after a restart, on a connection of
    /// its own (as [`SubagentHost::start_session`] gives it).
    fn reopen_session(
        &self,
        _plugin_id: String,
        _session_id: String,
        _cwd: String,
    ) -> futures::future::BoxFuture<'static, std::result::Result<SessionKey, String>> {
        Box::pin(async { Err("reopening sessions is not supported".to_string()) })
    }
}

/// The connection a child runs on. Every external child gets one of its own:
/// some adapters keep one live session per process (pi-acp closes the others
/// when a session opens), and a child's crash must not end its parent. The
/// in-process native agent runs many threads on one connection.
async fn child_connection(
    host: &Arc<AgentHost>,
    plugin_id: &str,
) -> std::result::Result<AgentId, String> {
    let connection = if plugin_id == CERSEI_AGENT_ID {
        plugin_id.to_string()
    } else {
        let instance = format!("sub-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
        atlas_agent_servers::instance::instance_id(plugin_id, &instance)
            .as_str()
            .to_string()
    };
    let info = host.spawn(&connection).await.map_err(|e| e.to_string())?;
    Ok(info.agent_id)
}

impl SubagentHost for Arc<AgentHost> {
    fn session_info(&self, session_id: &str) -> Option<(String, String)> {
        AgentHost::session_info(self, session_id)
    }

    fn is_installed(&self, plugin_id: &str) -> bool {
        self.agent_for(plugin_id).is_ok()
    }

    fn start_session(
        &self,
        plugin_id: String,
        cwd: String,
        mode: Option<String>,
    ) -> futures::future::BoxFuture<'static, std::result::Result<SessionKey, String>> {
        let host = self.clone();
        Box::pin(async move {
            let agent_id = child_connection(&host, &plugin_id).await?;
            let init = host
                .new_session(agent_id, cwd.into(), Vec::new())
                .await
                .map_err(|e| e.to_string())?;
            if let Some(mode) = mode.filter(|m| init.current_mode.as_deref() != Some(m)) {
                // Best-effort: a mode the child's agent does not offer leaves
                // it on its own default.
                if let Err(e) = host.set_mode(&init.key, mode.clone()).await {
                    tracing::warn!(target: "atlas::subagents", %mode, "child mode not applied: {e}");
                }
            }
            Ok(init.key)
        })
    }

    fn current_mode(&self, session_id: &str) -> Option<String> {
        AgentHost::current_mode(self, session_id)
    }

    fn send(&self, key: &SessionKey, text: String) -> std::result::Result<(), String> {
        AgentHost::send(
            self,
            key,
            vec![acp::ContentBlock::Text(acp::TextContent::new(text))],
        )
        .map_err(|e| e.to_string())
    }

    fn cancel(&self, key: &SessionKey) -> std::result::Result<(), String> {
        AgentHost::cancel(self, key).map_err(|e| e.to_string())
    }

    fn drop_session(
        &self,
        session_id: String,
    ) -> futures::future::BoxFuture<'static, std::result::Result<(), String>> {
        let host = self.clone();
        Box::pin(async move {
            AgentHost::drop_session(&host, &session_id)
                .await
                .map_err(|e| e.to_string())
        })
    }

    fn release(&self, agent_handle: AgentId) {
        // Only a child's own connection; a shared one (the native agent) stays.
        if AgentHost::is_instance(self, agent_handle) {
            let _ = self.kill(agent_handle);
        }
    }

    fn transcript(
        &self,
        key: &SessionKey,
    ) -> std::result::Result<Vec<atlas_agent_wire::Message>, String> {
        self.snapshot(key)
            .map(|s| s.messages)
            .map_err(|e| e.to_string())
    }

    fn reopen_session(
        &self,
        plugin_id: String,
        session_id: String,
        cwd: String,
    ) -> futures::future::BoxFuture<'static, std::result::Result<SessionKey, String>> {
        let host = self.clone();
        Box::pin(async move {
            let agent_id = child_connection(&host, &plugin_id).await?;
            let reopened = host.load_session(agent_id, session_id, cwd.into()).await;
            if reopened.is_err() {
                SubagentHost::release(&host, agent_id);
            }
            reopened.map_err(|e| e.to_string())
        })
    }
}

#[derive(Default)]
pub(super) struct Registry {
    pub(super) records: HashMap<Uuid, SubagentRecord>,
    pub(super) by_child: HashMap<String, Uuid>,
}

impl Registry {
    pub(super) fn find(&self, parent: &str, name: &str) -> Option<Uuid> {
        self.records
            .values()
            .find(|r| r.parent_session_id == parent && r.name == name)
            .map(|r| r.id)
    }
}

pub struct SubagentManager {
    pub(super) host: Box<dyn SubagentHost>,
    pub(super) emit: Emit,
    /// Where the records are saved for the next launch; `None` while
    /// persistence is off (tests, and from the quit on). See `persist.rs`.
    pub(super) store: Mutex<Option<std::path::PathBuf>>,
    /// Whether this launch's `restore` has run.
    pub(super) restore_started: std::sync::atomic::AtomicBool,
    pub(super) registry: Mutex<Registry>,
    /// Bumped on every change to a record; waiters watch it.
    pub(super) changes: watch::Sender<u64>,
    /// Where a mirrored child's transcript is announced — the `atlas:agents`
    /// channel every chat reads, so its column renders like any other.
    pub(super) emit_delta: std::sync::OnceLock<super::mirror::EmitDelta>,
    /// Approvals a mirrored child is waiting on: request id → the answer's
    /// channel and the child's (synthetic) session id.
    pub(super) approvals: Mutex<HashMap<Uuid, super::mirror::PendingMirrorApproval>>,
}

impl SubagentManager {
    pub fn new(host: Box<dyn SubagentHost>, emit: Emit) -> Arc<Self> {
        Arc::new(Self {
            host,
            emit,
            emit_delta: std::sync::OnceLock::new(),
            approvals: Mutex::new(HashMap::new()),
            registry: Mutex::new(Registry::default()),
            store: Mutex::new(None),
            restore_started: std::sync::atomic::AtomicBool::new(false),
            changes: watch::channel(0).0,
        })
    }

    pub(super) fn announce(&self, view: SubagentView) {
        self.changes.send_modify(|n| *n += 1);
        (self.emit)(&SubagentEvent::Upsert { record: view });
        self.persist();
    }

    // ---- who is calling ---------------------------------------------------

    /// The caller for a live session, or `None` when the host does not hold it.
    pub fn caller_for_session(&self, session_id: &str) -> Option<Caller> {
        let (plugin_id, cwd) = self.host.session_info(session_id)?;
        Some(Caller {
            session_id: session_id.to_string(),
            plugin_id,
            cwd,
        })
    }

    pub fn is_child(&self, session_id: &str) -> bool {
        self.registry.lock().by_child.contains_key(session_id)
    }

    /// Whether a delta's session is a child (the middleware's hot-path check).
    pub fn tracks(&self, session_id: &str) -> bool {
        self.is_child(session_id)
    }

    // ---- tools -------------------------------------------------------------

    /// Which installed plugin an agent-supplied kind names. The default is
    /// the caller's own agent.
    fn resolve_kind(&self, caller: &Caller, kind: Option<&str>) -> Result<String> {
        let Some(kind) = kind.map(str::trim).filter(|k| !k.is_empty()) else {
            return Ok(caller.plugin_id.clone());
        };
        let candidates: Vec<&str> = match kind.to_ascii_lowercase().as_str() {
            "codex" | "codex-acp" => vec!["codex-acp", "codex"],
            "claude" | "claude-code" | "claude-acp" | "claude-agent-acp" => {
                vec!["claude-acp", "claude-code", "claude-agent-acp"]
            }
            "pi" | "pi-acp" => vec!["pi-acp", "pi"],
            "atlas" | "cersei" | "native" => vec![CERSEI_AGENT_ID],
            _ => vec![kind],
        };
        candidates
            .into_iter()
            .find(|id| self.host.is_installed(id))
            .map(str::to_string)
            .ok_or_else(|| {
                SubagentError::new(
                    "kind_unavailable",
                    format!("no installed agent matches `{kind}`"),
                )
            })
    }

    pub async fn start(
        &self,
        caller: &Caller,
        name: &str,
        task: &str,
        kind: Option<&str>,
        wait: bool,
        timeout_ms: Option<u64>,
    ) -> Result<Value> {
        if self.is_child(&caller.session_id) {
            return Err(SubagentError::new(
                "depth_exceeded",
                "a subagent cannot start agents of its own",
            ));
        }
        if !valid_name(name) {
            return Err(SubagentError::new(
                "invalid_name",
                "name must be lowercase letters, digits, `-` or `_`, starting with a letter, at most 32 characters",
            ));
        }
        if task.trim().is_empty() {
            return Err(SubagentError::new("invalid_task", "task must not be empty"));
        }
        {
            let registry = self.registry.lock();
            if registry.find(&caller.session_id, name).is_some() {
                return Err(SubagentError::new(
                    "name_taken",
                    format!("an agent named `{name}` already exists; use agent_prompt to give it more work"),
                ));
            }
            let live = |r: &&SubagentRecord| r.status != SubagentStatus::Stopped;
            let mine = registry
                .records
                .values()
                .filter(|r| r.parent_session_id == caller.session_id)
                .filter(live)
                .count();
            let total = registry.records.values().filter(live).count();
            if mine >= MAX_CHILDREN_PER_PARENT || total >= MAX_LIVE_TOTAL {
                return Err(SubagentError::new(
                    "limit_reached",
                    format!("at most {MAX_CHILDREN_PER_PARENT} agents per session and {MAX_LIVE_TOTAL} in total; stop one first"),
                ));
            }
        }
        let plugin_id = self.resolve_kind(caller, kind)?;
        let mode = (plugin_id == caller.plugin_id)
            .then(|| self.host.current_mode(&caller.session_id))
            .flatten();
        let key = self
            .host
            .start_session(plugin_id.clone(), caller.cwd.clone(), mode)
            .await
            .map_err(|e| SubagentError::new("spawn_failed", e))?;

        let mut record = SubagentRecord::new(
            caller.session_id.clone(),
            plugin_id,
            key.agent_id,
            key.session_id.clone(),
            name.to_string(),
            task.to_string(),
            caller.cwd.clone(),
        );
        let id = record.id;
        // Announced before the prompt goes out, so the panel has adopted the
        // child before its first delta arrives.
        let view = {
            let mut registry = self.registry.lock();
            if registry.find(&caller.session_id, name).is_some() {
                None
            } else {
                record.note_prompted();
                let view = record.view();
                registry.by_child.insert(key.session_id.clone(), id);
                registry.records.insert(id, record);
                Some(view)
            }
        };
        let Some(view) = view else {
            // A racing start with the same name won: undo what this one made.
            let _ = self.host.drop_session(key.session_id.clone()).await;
            self.host.release(key.agent_id);
            return Err(SubagentError::new(
                "name_taken",
                format!("an agent named `{name}` already exists"),
            ));
        };
        self.announce(view);
        (self.emit)(&SubagentEvent::Prompted {
            child_session_id: key.session_id.clone(),
            text: task.to_string(),
        });
        if let Err(e) = self.host.send(&key, task.to_string()) {
            self.fail(id, &e);
            return Err(SubagentError::new("spawn_failed", e));
        }
        if wait {
            let result = self.wait_by_id(id, Until::Settled, 0, timeout_ms).await?;
            return Ok(
                json!({ "agent": result.agent, "reached": result.reached, "timed_out": result.timed_out }),
            );
        }
        Ok(json!({ "agent": self.view(id)? }))
    }

    pub async fn prompt(
        &self,
        caller: &Caller,
        name: &str,
        text: &str,
        wait: bool,
        timeout_ms: Option<u64>,
    ) -> Result<Value> {
        let id = self
            .registry
            .lock()
            .find(&caller.session_id, name)
            .ok_or_else(|| SubagentError::not_found(name))?;
        self.prompt_by_id(id, text, wait, timeout_ms).await
    }

    /// `prompt`, addressed by record id (the panel's follow-up input).
    pub async fn prompt_by_id(
        &self,
        id: Uuid,
        text: &str,
        wait: bool,
        timeout_ms: Option<u64>,
    ) -> Result<Value> {
        if text.trim().is_empty() {
            return Err(SubagentError::new("invalid_text", "text must not be empty"));
        }
        let (key, settled_before, view) = {
            let mut registry = self.registry.lock();
            let record = registry
                .records
                .get_mut(&id)
                .ok_or_else(|| SubagentError::new("not_found", "that agent is gone"))?;
            if record.mirror.is_some() {
                return Err(SubagentError::new(
                    "not_steerable",
                    "this subagent belongs to a pi extension; steer it through that extension",
                ));
            }
            match record.status {
                SubagentStatus::Blocked => {
                    return Err(SubagentError::new(
                        "agent_blocked",
                        format!("`{}` is waiting for the user to approve a permission in the Atlas Agents panel; ask the user, then wait", record.name),
                    ))
                }
                SubagentStatus::Working | SubagentStatus::Starting => {
                    return Err(SubagentError::new(
                        "agent_busy",
                        format!("`{}` is still working; call agent_wait first", record.name),
                    ))
                }
                _ => {}
            }
            let settled_before = record.turns_settled;
            record.note_prompted();
            (
                SessionKey {
                    agent_id: record.agent_handle,
                    session_id: record.child_session_id.clone(),
                },
                settled_before,
                record.view(),
            )
        };
        self.announce(view);
        (self.emit)(&SubagentEvent::Prompted {
            child_session_id: key.session_id.clone(),
            text: text.to_string(),
        });
        if let Err(e) = self.host.send(&key, text.to_string()) {
            self.fail(id, &e);
            return Err(SubagentError::new("send_failed", e));
        }
        if wait {
            let result = self
                .wait_by_id(id, Until::Settled, settled_before, timeout_ms)
                .await?;
            return Ok(serde_json::to_value(result).unwrap_or(Value::Null));
        }
        Ok(json!({ "agent": self.view(id)? }))
    }

    pub async fn wait(
        &self,
        caller: &Caller,
        name: &str,
        until: Until,
        timeout_ms: Option<u64>,
    ) -> Result<WaitResult> {
        let id = self
            .registry
            .lock()
            .find(&caller.session_id, name)
            .ok_or_else(|| SubagentError::not_found(name))?;
        // Plain `wait` is about the child's current state, not a new turn.
        self.wait_by_id(id, until, 0, timeout_ms).await
    }

    /// Wait until `until` holds and, when `after_settled` is non-zero, until
    /// at least one turn has settled past it (so a prompt's own turn is what
    /// is waited for, not the end of the one before it).
    async fn wait_by_id(
        &self,
        id: Uuid,
        until: Until,
        after_settled: u64,
        timeout_ms: Option<u64>,
    ) -> Result<WaitResult> {
        let timeout = Duration::from_millis(timeout_ms.unwrap_or(WAIT_DEFAULT_MS).min(WAIT_MAX_MS));
        let deadline = tokio::time::Instant::now() + timeout;
        let mut changes = self.changes.subscribe();
        loop {
            {
                let registry = self.registry.lock();
                let record = registry
                    .records
                    .get(&id)
                    .ok_or_else(|| SubagentError::new("not_found", "that agent is gone"))?;
                let turn_done = record.turns_settled > after_settled || !record.turn_open;
                let reached = until.reached(record.status)
                    && (record.status == SubagentStatus::Blocked || turn_done);
                if reached {
                    return Ok(WaitResult {
                        agent: record.view(),
                        reached: true,
                        timed_out: false,
                    });
                }
            }
            match tokio::time::timeout_at(deadline, changes.changed()).await {
                Ok(Ok(())) => continue,
                // The sender lives as long as the manager; a closed channel
                // means the app is going away.
                Ok(Err(_)) | Err(_) => {
                    return Ok(WaitResult {
                        agent: self.view(id)?,
                        reached: false,
                        timed_out: true,
                    })
                }
            }
        }
    }

    pub fn read(
        &self,
        caller: &Caller,
        name: &str,
        lines: Option<usize>,
        source: ReadSource,
    ) -> Result<Value> {
        let (key, view) = {
            let registry = self.registry.lock();
            let id = registry
                .find(&caller.session_id, name)
                .ok_or_else(|| SubagentError::not_found(name))?;
            let record = &registry.records[&id];
            (
                SessionKey {
                    agent_id: record.agent_handle,
                    session_id: record.child_session_id.clone(),
                },
                record.view(),
            )
        };
        let messages = self
            .host
            .transcript(&key)
            .map_err(|e| SubagentError::new("read_failed", e))?;
        let limit = lines.unwrap_or(READ_DEFAULT_LINES).clamp(1, READ_MAX_LINES);
        let (text, truncated) = render_transcript(&messages, source, limit);
        Ok(json!({ "agent": view, "text": text, "truncated": truncated }))
    }

    pub fn list(&self, caller: &Caller) -> Vec<SubagentView> {
        let registry = self.registry.lock();
        let mut views: Vec<SubagentView> = registry
            .records
            .values()
            .filter(|r| r.parent_session_id == caller.session_id)
            .map(SubagentRecord::view)
            .collect();
        views.sort_by_key(|v| v.created_at);
        views
    }

    /// Every record, for the panel's resync after a reload. A dormant one is
    /// announced once `restore` has reopened it, with a handle to read it by.
    pub fn list_all(&self) -> Vec<SubagentView> {
        let registry = self.registry.lock();
        let mut views: Vec<SubagentView> = registry
            .records
            .values()
            .filter(|r| !r.dormant)
            .map(SubagentRecord::view)
            .collect();
        views.sort_by_key(|v| v.created_at);
        views
    }

    pub async fn stop(&self, caller: &Caller, name: &str, remove: bool) -> Result<Value> {
        let id = self
            .registry
            .lock()
            .find(&caller.session_id, name)
            .ok_or_else(|| SubagentError::not_found(name))?;
        self.stop_by_id(id, remove).await
    }

    pub async fn stop_by_id(&self, id: Uuid, remove: bool) -> Result<Value> {
        let mirrored = self
            .registry
            .lock()
            .records
            .get(&id)
            .and_then(|r| r.mirror.as_ref().map(|_| r.view()));
        if let Some(view) = mirrored {
            // Not ours to stop: closing its column only forgets it here.
            if !remove {
                return Err(SubagentError::new(
                    "not_steerable",
                    "this subagent belongs to a pi extension; stop it through that extension",
                ));
            }
            self.remove(id).await;
            return Ok(json!({ "agent": view }));
        }
        let view = {
            let mut registry = self.registry.lock();
            let record = registry
                .records
                .get_mut(&id)
                .ok_or_else(|| SubagentError::new("not_found", "that agent is gone"))?;
            let key = SessionKey {
                agent_id: record.agent_handle,
                session_id: record.child_session_id.clone(),
            };
            if !record.status.is_settled() {
                // Cancelled turns report their own end; the stopped status
                // is what stays.
                let _ = self.host.cancel(&key);
            }
            record.status = SubagentStatus::Stopped;
            record.pending.clear();
            if record.turn_open {
                record.turn_open = false;
                record.turns_settled += 1;
            }
            record.updated_at = chrono::Utc::now();
            record.view()
        };
        if remove {
            self.remove(id).await;
        } else {
            self.announce(view.clone());
        }
        Ok(json!({ "agent": view }))
    }

    /// Stop and drop every child of `parent_session_id`.
    pub async fn stop_all(&self, parent_session_id: &str) {
        let ids: Vec<Uuid> = self
            .registry
            .lock()
            .records
            .values()
            .filter(|r| r.parent_session_id == parent_session_id)
            .map(|r| r.id)
            .collect();
        for id in ids {
            let _ = self.stop_by_id(id, true).await;
        }
    }

    /// Forget a record and tear its session down.
    async fn remove(&self, id: Uuid) {
        let Some(record) = ({
            let mut registry = self.registry.lock();
            let record = registry.records.remove(&id);
            if let Some(r) = &record {
                registry.by_child.remove(&r.child_session_id);
            }
            record
        }) else {
            return;
        };
        self.changes.send_modify(|n| *n += 1);
        (self.emit)(&SubagentEvent::Removed {
            id,
            child_session_id: record.child_session_id.clone(),
            parent_session_id: record.parent_session_id.clone(),
        });
        self.persist();
        if record.mirror.is_some() {
            // Nothing hosted: only its waiting approvals, answered "no".
            self.deny_mirror_approvals(&record.child_session_id);
            return;
        }
        let _ = self.host.drop_session(record.child_session_id).await;
        self.host.release(record.agent_handle);
    }

    // ---- host and panel side -----------------------------------------------

    /// A session was closed. A parent takes its children with it; a child
    /// that was closed on its own is forgotten.
    pub async fn on_session_dropped(&self, session_id: &str) {
        let child = self.registry.lock().by_child.get(session_id).copied();
        if let Some(id) = child {
            let removed = {
                let mut registry = self.registry.lock();
                registry.by_child.remove(session_id);
                registry.records.remove(&id)
            };
            if let Some(record) = removed {
                if record.mirror.is_some() {
                    self.deny_mirror_approvals(&record.child_session_id);
                }
                self.changes.send_modify(|n| *n += 1);
                (self.emit)(&SubagentEvent::Removed {
                    id,
                    child_session_id: record.child_session_id,
                    parent_session_id: record.parent_session_id,
                });
                self.persist();
                self.host.release(record.agent_handle);
            }
            return;
        }
        self.stop_all(session_id).await;
    }

    /// One of a child's deltas.
    pub fn on_delta(&self, envelope: &SessionDeltaEnvelope) {
        let view = {
            let mut registry = self.registry.lock();
            let Some(id) = registry.by_child.get(&envelope.session_id).copied() else {
                return;
            };
            let Some(record) = registry.records.get_mut(&id) else {
                return;
            };
            // A stopped child's late deltas (its cancelled turn winding down)
            // change nothing the panel shows.
            if record.status == SubagentStatus::Stopped {
                return;
            }
            if !apply_delta(record, envelope) {
                return;
            }
            record.view()
        };
        self.announce(view);
    }

    /// The user answered one of `child_session_id`'s permission requests:
    /// `None` when they dismissed it, else the kind of option they picked.
    pub fn note_permission_decision(
        &self,
        child_session_id: &str,
        kind: Option<&acp::PermissionOptionKind>,
    ) {
        let denied = match kind {
            None => true,
            Some(
                acp::PermissionOptionKind::RejectOnce | acp::PermissionOptionKind::RejectAlways,
            ) => true,
            Some(_) => false,
        };
        if !denied {
            return;
        }
        let view = {
            let mut registry = self.registry.lock();
            let Some(id) = registry.by_child.get(child_session_id).copied() else {
                return;
            };
            let Some(record) = registry.records.get_mut(&id) else {
                return;
            };
            record.denied_count += 1;
            record.view()
        };
        self.announce(view);
    }

    /// The user looked at a finished child: done becomes idle.
    pub fn mark_seen(&self, id: Uuid) {
        let view = {
            let mut registry = self.registry.lock();
            let Some(record) = registry.records.get_mut(&id) else {
                return;
            };
            if record.status != SubagentStatus::Done {
                return;
            }
            record.status = SubagentStatus::Idle;
            record.view()
        };
        self.announce(view);
    }

    pub(super) fn fail(&self, id: Uuid, error: &str) {
        let view = {
            let mut registry = self.registry.lock();
            let Some(record) = registry.records.get_mut(&id) else {
                return;
            };
            record.status = SubagentStatus::Error;
            record.last_error = Some(error.to_string());
            record.turn_open = false;
            record.turns_settled += 1;
            record.view()
        };
        self.announce(view);
    }

    fn view(&self, id: Uuid) -> Result<SubagentView> {
        self.registry
            .lock()
            .records
            .get(&id)
            .map(SubagentRecord::view)
            .ok_or_else(|| SubagentError::new("not_found", "that agent is gone"))
    }
}

/// `^[a-z][a-z0-9_-]{0,31}$`.
pub fn valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_lowercase())
        && name.len() <= 32
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

/// A child's transcript as plain text for its parent: prompts, replies, and
/// one line per tool call. Returns the text and whether lines were cut.
fn render_transcript(
    messages: &[atlas_agent_wire::Message],
    source: ReadSource,
    limit: usize,
) -> (String, bool) {
    let start = match source {
        ReadSource::LastTurn => messages
            .iter()
            .rposition(|m| m.role == MessageRole::User)
            .unwrap_or(0),
        ReadSource::Recent => 0,
    };
    let mut lines: Vec<String> = Vec::new();
    for message in &messages[start..] {
        match message.role {
            MessageRole::User => {
                lines.push(format!("> {}", message.content.trim()));
            }
            MessageRole::System => {}
            MessageRole::Assistant => {
                if message.mode == MessageMode::Thinking {
                    continue;
                }
                for call in &message.tool_calls {
                    let title = call.title.as_deref().unwrap_or(&call.tool_name);
                    let status = serde_json::to_value(call.status)
                        .ok()
                        .and_then(|v| v.as_str().map(str::to_string))
                        .unwrap_or_default();
                    lines.push(format!("[tool] {title} — {status}"));
                }
                let text = message.content.trim();
                if !text.is_empty() {
                    lines.extend(text.lines().map(str::to_string));
                }
            }
        }
    }
    let truncated = lines.len() > limit;
    let text = lines[lines.len().saturating_sub(limit)..].join("\n");
    (text, truncated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use atlas_agent_wire::{AgentId, SessionDelta, SessionStatus};
    use futures::future::BoxFuture;

    #[derive(Default)]
    struct FakeHost {
        sent: Mutex<Vec<(String, String)>>,
        dropped: Mutex<Vec<String>>,
        cancelled: Mutex<Vec<String>>,
        modes: Mutex<Vec<Option<String>>>,
        released: Mutex<Vec<AgentId>>,
        next: Mutex<u32>,
    }

    impl SubagentHost for Arc<FakeHost> {
        fn session_info(&self, session_id: &str) -> Option<(String, String)> {
            Some(("codex-acp".into(), format!("/work/{session_id}")))
        }
        fn is_installed(&self, plugin_id: &str) -> bool {
            matches!(plugin_id, "codex-acp" | "pi-acp")
        }
        fn current_mode(&self, _session_id: &str) -> Option<String> {
            Some("read-only".into())
        }
        fn start_session(
            &self,
            _plugin_id: String,
            _cwd: String,
            mode: Option<String>,
        ) -> BoxFuture<'static, std::result::Result<SessionKey, String>> {
            self.modes.lock().push(mode);
            let n = {
                let mut next = self.next.lock();
                *next += 1;
                *next
            };
            Box::pin(async move {
                Ok(SessionKey {
                    agent_id: AgentId::new(),
                    session_id: format!("child-{n}"),
                })
            })
        }
        fn send(&self, key: &SessionKey, text: String) -> std::result::Result<(), String> {
            self.sent.lock().push((key.session_id.clone(), text));
            Ok(())
        }
        fn cancel(&self, key: &SessionKey) -> std::result::Result<(), String> {
            self.cancelled.lock().push(key.session_id.clone());
            Ok(())
        }
        fn drop_session(
            &self,
            session_id: String,
        ) -> BoxFuture<'static, std::result::Result<(), String>> {
            self.dropped.lock().push(session_id);
            Box::pin(async { Ok(()) })
        }
        fn transcript(
            &self,
            _key: &SessionKey,
        ) -> std::result::Result<Vec<atlas_agent_wire::Message>, String> {
            Ok(Vec::new())
        }
        fn release(&self, agent_handle: AgentId) {
            self.released.lock().push(agent_handle);
        }
        fn reopen_session(
            &self,
            _plugin_id: String,
            session_id: String,
            _cwd: String,
        ) -> BoxFuture<'static, std::result::Result<SessionKey, String>> {
            Box::pin(async move {
                Ok(SessionKey {
                    agent_id: AgentId::new(),
                    session_id,
                })
            })
        }
    }

    type Events = Arc<Mutex<Vec<SubagentEvent>>>;

    fn manager() -> (Arc<SubagentManager>, Arc<FakeHost>, Events) {
        let host = Arc::new(FakeHost::default());
        let events: Events = Arc::default();
        let sink = events.clone();
        let manager = SubagentManager::new(
            Box::new(host.clone()),
            Arc::new(move |e: &SubagentEvent| sink.lock().push(e.clone())),
        );
        (manager, host, events)
    }

    fn parent() -> Caller {
        Caller {
            session_id: "parent".into(),
            plugin_id: "codex-acp".into(),
            cwd: "/work".into(),
        }
    }

    fn delta(session: &str, delta: SessionDelta) -> SessionDeltaEnvelope {
        SessionDeltaEnvelope {
            agent_id: AgentId::new(),
            session_id: session.into(),
            delta,
        }
    }

    fn finished(session: &str) -> SessionDeltaEnvelope {
        delta(
            session,
            SessionDelta::TurnFinished {
                stop_reason: "end_turn".into(),
                turn_seq: 0,
            },
        )
    }

    #[tokio::test]
    async fn a_restart_reopens_children_and_a_blocked_one_asks_again() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("subagents.json");
        let (first, _, _) = manager();
        first.enable_persistence(file.clone());
        first
            .start(&parent(), "blocked", "a", None, false, None)
            .await
            .unwrap();
        first
            .start(&parent(), "busy", "b", None, false, None)
            .await
            .unwrap();
        {
            let mut registry = first.registry.lock();
            for r in registry.records.values_mut() {
                if r.name == "blocked" {
                    r.status = SubagentStatus::Blocked;
                }
            }
        }
        first.freeze();
        // What the quit does to the children must not reach the file.
        first.stop_all("parent").await;

        let (second, host, _) = manager();
        second.enable_persistence(file);
        assert!(second.list_all().is_empty(), "dormant until reopened");
        second.restore().await;
        let views = second.list_all();
        let status = |name: &str| views.iter().find(|v| v.name == name).unwrap().status;
        assert_eq!(status("blocked"), SubagentStatus::Working);
        assert_eq!(status("busy"), SubagentStatus::Idle);
        let sent = host.sent.lock().clone();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].1, super::super::persist::RETRY_AFTER_RESTART);
        // Once per launch.
        second.restore().await;
        assert_eq!(host.sent.lock().len(), 1);
    }

    #[tokio::test]
    async fn start_announces_the_child_before_prompting_it() {
        let (m, host, events) = manager();
        m.start(&parent(), "lister", "list files", None, false, None)
            .await
            .unwrap();
        let events = events.lock();
        assert!(matches!(events[0], SubagentEvent::Upsert { .. }));
        assert!(matches!(&events[1], SubagentEvent::Prompted { text, .. } if text == "list files"));
        assert_eq!(
            *host.sent.lock(),
            vec![("child-1".to_string(), "list files".to_string())]
        );
        assert!(m.is_child("child-1"));
    }

    #[tokio::test]
    async fn a_child_of_the_same_agent_inherits_the_parents_mode() {
        let (m, host, _) = manager();
        m.start(&parent(), "same", "x", None, false, None)
            .await
            .unwrap();
        m.start(&parent(), "other", "x", Some("pi"), false, None)
            .await
            .unwrap();
        assert_eq!(
            *host.modes.lock(),
            vec![Some("read-only".to_string()), None]
        );
    }

    #[tokio::test]
    async fn names_are_validated_and_unique_per_parent() {
        let (m, _, _) = manager();
        let bad = m.start(&parent(), "Bad Name", "x", None, false, None).await;
        assert_eq!(bad.unwrap_err().code, "invalid_name");
        m.start(&parent(), "a", "x", None, false, None)
            .await
            .unwrap();
        let again = m.start(&parent(), "a", "y", None, false, None).await;
        assert_eq!(again.unwrap_err().code, "name_taken");
    }

    #[tokio::test]
    async fn a_child_cannot_start_agents() {
        let (m, _, _) = manager();
        m.start(&parent(), "a", "x", None, false, None)
            .await
            .unwrap();
        let child = Caller {
            session_id: "child-1".into(),
            ..parent()
        };
        let nested = m.start(&child, "b", "x", None, false, None).await;
        assert_eq!(nested.unwrap_err().code, "depth_exceeded");
    }

    #[tokio::test]
    async fn an_unknown_kind_is_refused_and_aliases_resolve() {
        let (m, _, _) = manager();
        let missing = m
            .start(&parent(), "a", "x", Some("gemini"), false, None)
            .await;
        assert_eq!(missing.unwrap_err().code, "kind_unavailable");
        let pi = m
            .start(&parent(), "p", "x", Some("pi"), false, None)
            .await
            .unwrap();
        assert_eq!(pi["agent"]["kind"], "pi-acp");
    }

    #[tokio::test]
    async fn wait_returns_when_the_turn_finishes_and_times_out_as_a_result() {
        let (m, _, _) = manager();
        m.start(&parent(), "a", "x", None, false, None)
            .await
            .unwrap();
        let timed = m
            .wait(&parent(), "a", Until::Settled, Some(20))
            .await
            .unwrap();
        assert!(timed.timed_out && !timed.reached);

        let waiter = {
            let m = m.clone();
            tokio::spawn(async move { m.wait(&parent(), "a", Until::Settled, Some(5_000)).await })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        m.on_delta(&finished("child-1"));
        let result = waiter.await.unwrap().unwrap();
        assert!(result.reached);
        assert_eq!(result.agent.status, SubagentStatus::Done);
    }

    #[tokio::test]
    async fn prompting_a_blocked_or_busy_child_is_refused() {
        let (m, _, _) = manager();
        m.start(&parent(), "a", "x", None, false, None)
            .await
            .unwrap();
        let busy = m.prompt(&parent(), "a", "more", false, None).await;
        assert_eq!(busy.unwrap_err().code, "agent_busy");
        m.on_delta(&delta(
            "child-1",
            SessionDelta::PermissionRequest {
                request_id: Uuid::new_v4(),
                tool_call: json!({ "title": "rm" }),
                options: json!([]),
            },
        ));
        let blocked = m.prompt(&parent(), "a", "more", false, None).await;
        assert_eq!(blocked.unwrap_err().code, "agent_blocked");
        // A blocked child satisfies a settled wait at once.
        let waited = m
            .wait(&parent(), "a", Until::Settled, Some(5_000))
            .await
            .unwrap();
        assert!(waited.reached);
        assert_eq!(waited.agent.status, SubagentStatus::Blocked);
    }

    #[tokio::test]
    async fn prompt_wait_waits_for_its_own_turn() {
        let (m, host, _) = manager();
        m.start(&parent(), "a", "x", None, false, None)
            .await
            .unwrap();
        m.on_delta(&finished("child-1"));
        let waiter = {
            let m = m.clone();
            tokio::spawn(async move { m.prompt(&parent(), "a", "more", true, Some(5_000)).await })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(host.sent.lock().len(), 2);
        m.on_delta(&delta(
            "child-1",
            SessionDelta::Status {
                status: SessionStatus::Running,
                turn_seq: 0,
            },
        ));
        m.on_delta(&finished("child-1"));
        let result = waiter.await.unwrap().unwrap();
        assert_eq!(result["reached"], true);
    }

    #[tokio::test]
    async fn dropping_the_parent_drops_every_child() {
        let (m, host, events) = manager();
        m.start(&parent(), "a", "x", None, false, None)
            .await
            .unwrap();
        m.start(&parent(), "b", "x", None, false, None)
            .await
            .unwrap();
        m.on_session_dropped("parent").await;
        let mut dropped = host.dropped.lock().clone();
        dropped.sort();
        assert_eq!(dropped, vec!["child-1", "child-2"]);
        // Each child's own connection goes with it.
        assert_eq!(host.released.lock().len(), 2);
        assert!(m.list(&parent()).is_empty());
        let removed = events
            .lock()
            .iter()
            .filter(|e| matches!(e, SubagentEvent::Removed { .. }))
            .count();
        assert_eq!(removed, 2);
    }

    #[tokio::test]
    async fn only_user_denials_are_counted() {
        let (m, _, _) = manager();
        m.start(&parent(), "a", "x", None, false, None)
            .await
            .unwrap();
        m.note_permission_decision("child-1", None);
        m.note_permission_decision("child-1", Some(&acp::PermissionOptionKind::RejectOnce));
        m.note_permission_decision("child-1", Some(&acp::PermissionOptionKind::AllowOnce));
        assert_eq!(m.list(&parent())[0].denied_count, 2);
    }

    #[tokio::test]
    async fn list_is_scoped_to_the_caller() {
        let (m, _, _) = manager();
        m.start(&parent(), "a", "x", None, false, None)
            .await
            .unwrap();
        let other = Caller {
            session_id: "other".into(),
            ..parent()
        };
        assert!(m.list(&other).is_empty());
        assert_eq!(m.list(&parent()).len(), 1);
    }

    #[test]
    fn transcript_renders_the_last_turn() {
        use atlas_agent_wire::{Message, ToolCall, ToolCallStatus};
        let msg = |role, content: &str, tools: Vec<ToolCall>| Message {
            id: "x".into(),
            role,
            mode: MessageMode::Text,
            content: content.into(),
            thinking: String::new(),
            tool_calls: tools,
            plan: None,
            model: None,
            attachments: Vec::new(),
            timestamp: chrono::Utc::now(),
        };
        let call = ToolCall {
            id: "t".into(),
            tool_name: "bash".into(),
            title: Some("ls".into()),
            kind: None,
            status: ToolCallStatus::Completed,
            arguments: Value::Null,
            result: None,
            locations: Vec::new(),
            raw_output: None,
            content_blocks: Vec::new(),
        };
        let messages = vec![
            msg(MessageRole::User, "old", vec![]),
            msg(MessageRole::Assistant, "old reply", vec![]),
            msg(MessageRole::User, "list", vec![]),
            msg(MessageRole::Assistant, "a\nb", vec![call]),
        ];
        let (text, truncated) = render_transcript(&messages, ReadSource::LastTurn, 80);
        assert_eq!(text, "> list\n[tool] ls — completed\na\nb");
        assert!(!truncated);
        let (tail, cut) = render_transcript(&messages, ReadSource::Recent, 2);
        assert_eq!(tail, "a\nb");
        assert!(cut);
    }

    #[test]
    fn names_follow_the_pattern() {
        assert!(valid_name("lister"));
        assert!(valid_name("a-1_b"));
        assert!(!valid_name("1a"));
        assert!(!valid_name("A"));
        assert!(!valid_name(""));
        assert!(!valid_name(&"a".repeat(33)));
    }
}
