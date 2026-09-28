//! Subagent records across a restart.
//!
//! Every change to a hosted record rewrites `subagents.json`. The next launch
//! reads it back as *dormant* records (no connection yet), and [`restore`]
//! reopens each child's stored session on a connection of its own. A child
//! that was blocked on an approval is told to go on, so it asks again — the
//! request it was waiting on died with its process. One that was mid-turn is
//! left idle: whether it goes on is the user's call.
//!
//! Mirrored children are not saved: they live inside their parent's pi.
//!
//! [`restore`]: SubagentManager::restore

use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;

use atlas_agent_wire::AgentId;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::manager::SubagentManager;
use super::model::{SubagentEvent, SubagentRecord, SubagentStatus};

/// What a child blocked at the quit is told once it is reopened.
pub const RETRY_AFTER_RESTART: &str = "Atlas was restarted while you were waiting for the user's approval, and that request was lost. Retry the action you were about to take, then continue the task.";

pub fn store_file(config_dir: &Path) -> PathBuf {
    config_dir.join("subagents.json")
}

#[derive(Debug, Serialize, Deserialize)]
struct Stored {
    id: Uuid,
    parent_session_id: String,
    plugin_id: String,
    child_session_id: String,
    name: String,
    task: String,
    cwd: String,
    status: SubagentStatus,
    tool_count: u32,
    denied_count: u32,
    #[serde(default)]
    last_error: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

impl Stored {
    fn of(r: &SubagentRecord) -> Self {
        Self {
            id: r.id,
            parent_session_id: r.parent_session_id.clone(),
            plugin_id: r.plugin_id.clone(),
            child_session_id: r.child_session_id.clone(),
            name: r.name.clone(),
            task: r.task.clone(),
            cwd: r.cwd.clone(),
            status: r.status,
            tool_count: r.tool_count,
            denied_count: r.denied_count,
            last_error: r.last_error.clone(),
            created_at: r.created_at,
            updated_at: r.updated_at,
        }
    }

    fn into_record(self) -> SubagentRecord {
        let mut r = SubagentRecord::new(
            self.parent_session_id,
            self.plugin_id,
            // Names no connection until `restore` gives it one.
            AgentId::new(),
            self.child_session_id,
            self.name,
            self.task,
            self.cwd,
        );
        r.id = self.id;
        r.status = self.status;
        r.tool_count = self.tool_count;
        r.denied_count = self.denied_count;
        r.last_error = self.last_error;
        r.created_at = self.created_at;
        r.updated_at = self.updated_at;
        r.dormant = true;
        r
    }
}

impl SubagentManager {
    /// Read the last launch's records back, dormant, and save every change
    /// from here on.
    pub fn enable_persistence(&self, path: PathBuf) {
        let stored: Vec<Stored> = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        {
            let mut registry = self.registry.lock();
            for s in stored {
                if registry.records.contains_key(&s.id) {
                    continue;
                }
                let record = s.into_record();
                registry
                    .by_child
                    .insert(record.child_session_id.clone(), record.id);
                registry.records.insert(record.id, record);
            }
        }
        *self.store.lock() = Some(path);
    }

    pub(super) fn persist(&self) {
        let Some(path) = self.store.lock().clone() else {
            return;
        };
        let stored: Vec<Stored> = self
            .registry
            .lock()
            .records
            .values()
            .filter(|r| r.mirror.is_none())
            .map(Stored::of)
            .collect();
        let Ok(json) = serde_json::to_vec_pretty(&stored) else {
            return;
        };
        // ponytail: rewritten whole on every change; a handful of records.
        let tmp = path.with_extension("json.tmp");
        if let Err(e) = std::fs::write(&tmp, json).and_then(|_| std::fs::rename(&tmp, &path)) {
            tracing::warn!(target: "atlas::subagents", "saving subagents failed: {e}");
        }
    }

    /// The app is quitting: save once more, then stop, so the children dying
    /// with it are not recorded as failed.
    pub fn freeze(&self) {
        self.persist();
        *self.store.lock() = None;
    }

    /// Reopen every dormant child. Runs once per launch; later calls (a
    /// webview reload) find nothing to do.
    pub async fn restore(&self) {
        if self.restore_started.swap(true, Ordering::SeqCst) {
            return;
        }
        let dormant: Vec<(Uuid, String, String, String)> = self
            .registry
            .lock()
            .records
            .values()
            .filter(|r| r.dormant)
            .map(|r| {
                (
                    r.id,
                    r.plugin_id.clone(),
                    r.child_session_id.clone(),
                    r.cwd.clone(),
                )
            })
            .collect();
        for (id, plugin_id, session_id, cwd) in dormant {
            let reopened = self.host.reopen_session(plugin_id, session_id, cwd).await;
            let (view, retry) = {
                let mut registry = self.registry.lock();
                let Some(r) = registry.records.get_mut(&id) else {
                    continue;
                };
                r.dormant = false;
                let mut retry = None;
                match reopened {
                    Ok(key) => {
                        r.agent_handle = key.agent_id;
                        match r.status {
                            SubagentStatus::Blocked => {
                                r.pending.clear();
                                r.note_prompted();
                                retry = Some(key);
                            }
                            SubagentStatus::Working | SubagentStatus::Starting => {
                                r.status = SubagentStatus::Idle;
                            }
                            _ => {}
                        }
                    }
                    Err(e) => {
                        r.status = SubagentStatus::Error;
                        r.last_error = Some(format!("could not reopen after a restart: {e}"));
                    }
                }
                (r.view(), retry)
            };
            self.announce(view);
            if let Some(key) = retry {
                (self.emit)(&SubagentEvent::Prompted {
                    child_session_id: key.session_id.clone(),
                    text: RETRY_AFTER_RESTART.to_string(),
                });
                if let Err(e) = self.host.send(&key, RETRY_AFTER_RESTART.to_string()) {
                    self.fail(id, &e);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_record_survives_the_round_trip_dormant() {
        let mut r = SubagentRecord::new(
            "parent".into(),
            "codex-acp".into(),
            AgentId::new(),
            "child".into(),
            "scout".into(),
            "look around".into(),
            "/tmp".into(),
        );
        r.status = SubagentStatus::Blocked;
        r.tool_count = 3;
        let json = serde_json::to_string(&Stored::of(&r)).unwrap();
        let back = serde_json::from_str::<Stored>(&json).unwrap().into_record();
        assert_eq!(back.id, r.id);
        assert_eq!(back.status, SubagentStatus::Blocked);
        assert_eq!(back.tool_count, 3);
        assert_eq!(back.child_session_id, "child");
        assert!(back.dormant);
        assert_ne!(back.agent_handle, r.agent_handle);
    }
}
