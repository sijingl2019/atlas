//! The subagent record and the rules that move it.
//!
//! [`apply_delta`] is the whole state machine and is pure, so every
//! transition is tested without an agent. Status follows herdr's vocabulary:
//! a child is *working*, *blocked* on a permission only the user can answer,
//! *done* (settled, and not yet looked at) or *idle* (settled and seen).

use std::collections::HashSet;

use atlas_agent_wire::{SessionDelta, SessionDeltaEnvelope, SessionStatus};
use chrono::{DateTime, Utc};
use serde::Serialize;
use uuid::Uuid;

use atlas_agent_wire::AgentId;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum SubagentStatus {
    /// Created, first prompt not yet running.
    Starting,
    Working,
    /// Waiting on a permission decision.
    Blocked,
    /// Settled and seen by the user.
    Idle,
    /// Settled and not yet seen.
    Done,
    Error,
    /// Stopped by the parent or the user.
    Stopped,
}

impl SubagentStatus {
    /// Whether the child is between turns (or will never run another).
    pub fn is_settled(self) -> bool {
        matches!(self, Self::Idle | Self::Done | Self::Error | Self::Stopped)
    }
}

/// A permission request the child is blocked on, as far as the panel and the
/// parent need to know it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PendingApproval {
    pub request_id: Uuid,
    pub title: String,
}

#[derive(Debug, Clone)]
pub struct SubagentRecord {
    pub id: Uuid,
    pub parent_session_id: String,
    /// The child's agent kind (plugin id), e.g. `codex-acp`.
    pub plugin_id: String,
    /// The per-process agent handle the child's session key carries.
    pub agent_handle: AgentId,
    pub child_session_id: String,
    pub name: String,
    pub task: String,
    pub cwd: String,
    pub status: SubagentStatus,
    pub tool_count: u32,
    pub tool_ids: HashSet<String>,
    pub denied_count: u32,
    pub pending: Vec<PendingApproval>,
    /// Bumped once per turn that reached an end — what `prompt --wait` and
    /// `wait` watch for.
    pub turns_settled: u64,
    /// A turn was asked for (or is running) and has not ended yet. Guards
    /// against counting one turn's end twice (`turn_finished` and the idle
    /// status that follows it).
    pub turn_open: bool,
    pub last_error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// Set for a child Atlas did not start and does not host — one a pi
    /// extension (pi-subagents) runs inside the parent's pi. Its transcript
    /// and status are reported to Atlas; its session id is synthetic.
    pub mirror: Option<Mirror>,
}

/// Where a mirrored child comes from, and what has been shown of it.
#[derive(Debug, Clone, Default)]
pub struct Mirror {
    /// The reporter's key for the child (`<runId>:<index>`).
    pub key: String,
    /// The child's own pi session file, when known — how an approval asked
    /// from inside the child finds its record.
    pub session_file: Option<String>,
    /// Tool call id → the transcript message that carries it.
    pub tool_messages: std::collections::HashMap<String, String>,
}

impl SubagentRecord {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        parent_session_id: String,
        plugin_id: String,
        agent_handle: AgentId,
        child_session_id: String,
        name: String,
        task: String,
        cwd: String,
    ) -> Self {
        let now = Utc::now();
        Self {
            id: Uuid::new_v4(),
            parent_session_id,
            plugin_id,
            agent_handle,
            child_session_id,
            name,
            task,
            cwd,
            status: SubagentStatus::Starting,
            tool_count: 0,
            tool_ids: HashSet::new(),
            denied_count: 0,
            pending: Vec::new(),
            turns_settled: 0,
            turn_open: false,
            last_error: None,
            created_at: now,
            updated_at: now,
            mirror: None,
        }
    }

    /// A turn was just sent to the child.
    pub fn note_prompted(&mut self) {
        self.turn_open = true;
        self.status = SubagentStatus::Working;
        self.last_error = None;
        self.updated_at = Utc::now();
    }

    fn settle(&mut self, status: SubagentStatus) {
        self.status = status;
        self.pending.clear();
        if self.turn_open {
            self.turn_open = false;
            self.turns_settled += 1;
        }
    }

    pub fn view(&self) -> SubagentView {
        SubagentView {
            id: self.id,
            name: self.name.clone(),
            kind: self.plugin_id.clone(),
            task: self.task.clone(),
            status: self.status,
            parent_session_id: self.parent_session_id.clone(),
            child_session_id: self.child_session_id.clone(),
            agent_handle: self.agent_handle,
            cwd: self.cwd.clone(),
            tool_count: self.tool_count,
            denied_count: self.denied_count,
            pending_approvals: self.pending.clone(),
            last_error: self.last_error.clone(),
            created_at: self.created_at,
            updated_at: self.updated_at,
            mirror: self.mirror.is_some(),
        }
    }
}

/// What the panel and the tools see of a record.
#[derive(Debug, Clone, Serialize)]
pub struct SubagentView {
    pub id: Uuid,
    pub name: String,
    pub kind: String,
    pub task: String,
    pub status: SubagentStatus,
    pub parent_session_id: String,
    pub child_session_id: String,
    pub agent_handle: AgentId,
    pub cwd: String,
    pub tool_count: u32,
    pub denied_count: u32,
    pub pending_approvals: Vec<PendingApproval>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// Reported by a pi extension rather than hosted by Atlas: it cannot be
    /// prompted or stopped from here.
    pub mirror: bool,
}

/// Announced on [`super::SUBAGENTS_EVENT`].
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SubagentEvent {
    Upsert {
        record: SubagentView,
    },
    Removed {
        id: Uuid,
        child_session_id: String,
        parent_session_id: String,
    },
    /// A prompt the host sent to a child. User prompts are not deltas (the
    /// chat panel adds them locally), so a prompt nobody typed would
    /// otherwise never appear in the child's transcript.
    Prompted {
        child_session_id: String,
        text: String,
    },
}

/// Move `rec` by one of its session's deltas. Returns whether anything the
/// panel or a waiter cares about changed.
pub fn apply_delta(rec: &mut SubagentRecord, envelope: &SessionDeltaEnvelope) -> bool {
    let changed = match &envelope.delta {
        SessionDelta::Status { status, .. } => match status {
            SessionStatus::Running => {
                rec.turn_open = true;
                if rec.status != SubagentStatus::Working {
                    rec.status = SubagentStatus::Working;
                    true
                } else {
                    false
                }
            }
            SessionStatus::Waiting => {
                let next = if rec.pending.is_empty() {
                    SubagentStatus::Working
                } else {
                    SubagentStatus::Blocked
                };
                let changed = rec.status != next;
                rec.status = next;
                changed
            }
            SessionStatus::Idle => {
                if matches!(
                    rec.status,
                    SubagentStatus::Working | SubagentStatus::Blocked | SubagentStatus::Starting
                ) && rec.turn_open
                {
                    rec.settle(SubagentStatus::Done);
                    true
                } else {
                    false
                }
            }
            SessionStatus::Error => {
                rec.settle(SubagentStatus::Error);
                true
            }
        },
        SessionDelta::PermissionRequest {
            request_id,
            tool_call,
            ..
        } => {
            let title = tool_call
                .get("title")
                .and_then(|t| t.as_str())
                .unwrap_or("permission")
                .to_string();
            rec.pending.push(PendingApproval {
                request_id: *request_id,
                title,
            });
            rec.status = SubagentStatus::Blocked;
            true
        }
        SessionDelta::PermissionResolved { request_id } => {
            rec.pending.retain(|p| p.request_id != *request_id);
            if rec.status == SubagentStatus::Blocked && rec.pending.is_empty() {
                rec.status = SubagentStatus::Working;
            }
            true
        }
        SessionDelta::ToolCallUpserted { tool_call, .. } => {
            if rec.tool_ids.insert(tool_call.id.clone()) {
                rec.tool_count += 1;
                true
            } else {
                false
            }
        }
        SessionDelta::TurnFinished { .. } => {
            rec.settle(SubagentStatus::Done);
            true
        }
        SessionDelta::TurnFailed { error, .. } => {
            rec.last_error = Some(error.clone());
            rec.settle(SubagentStatus::Error);
            true
        }
        SessionDelta::AgentDisconnected { reason } => {
            rec.last_error = Some(format!("agent process exited: {reason}"));
            rec.settle(SubagentStatus::Error);
            true
        }
        _ => false,
    };
    if changed {
        rec.updated_at = Utc::now();
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use atlas_agent_wire::{ToolCall, ToolCallStatus};

    fn record() -> SubagentRecord {
        SubagentRecord::new(
            "parent".into(),
            "codex-acp".into(),
            AgentId::new(),
            "child".into(),
            "lister".into(),
            "list files".into(),
            "/tmp".into(),
        )
    }

    fn env(delta: SessionDelta) -> SessionDeltaEnvelope {
        SessionDeltaEnvelope {
            agent_id: AgentId::new(),
            session_id: "child".into(),
            delta,
        }
    }

    fn status(s: SessionStatus) -> SessionDeltaEnvelope {
        env(SessionDelta::Status {
            status: s,
            turn_seq: 0,
        })
    }

    fn tool(id: &str) -> SessionDeltaEnvelope {
        env(SessionDelta::ToolCallUpserted {
            message_id: "m".into(),
            tool_call: ToolCall {
                id: id.into(),
                tool_name: "bash".into(),
                title: None,
                kind: None,
                status: ToolCallStatus::Running,
                arguments: serde_json::Value::Null,
                result: None,
                locations: Vec::new(),
                raw_output: None,
                content_blocks: Vec::new(),
            },
        })
    }

    #[test]
    fn running_then_finished_settles_one_turn() {
        let mut r = record();
        r.note_prompted();
        apply_delta(&mut r, &status(SessionStatus::Running));
        assert_eq!(r.status, SubagentStatus::Working);
        apply_delta(
            &mut r,
            &env(SessionDelta::TurnFinished {
                stop_reason: "end_turn".into(),
                turn_seq: 0,
            }),
        );
        // The idle that follows a finished turn must not count it twice.
        apply_delta(&mut r, &status(SessionStatus::Idle));
        assert_eq!(r.status, SubagentStatus::Done);
        assert_eq!(r.turns_settled, 1);
    }

    #[test]
    fn a_permission_blocks_and_its_resolution_unblocks() {
        let mut r = record();
        r.note_prompted();
        let request_id = Uuid::new_v4();
        apply_delta(
            &mut r,
            &env(SessionDelta::PermissionRequest {
                request_id,
                tool_call: serde_json::json!({ "title": "rm -rf dist" }),
                options: serde_json::json!([]),
            }),
        );
        assert_eq!(r.status, SubagentStatus::Blocked);
        assert_eq!(r.pending[0].title, "rm -rf dist");
        apply_delta(&mut r, &status(SessionStatus::Waiting));
        assert_eq!(r.status, SubagentStatus::Blocked);
        apply_delta(
            &mut r,
            &env(SessionDelta::PermissionResolved { request_id }),
        );
        assert_eq!(r.status, SubagentStatus::Working);
        assert!(r.pending.is_empty());
    }

    #[test]
    fn a_failed_turn_is_an_error_that_settles() {
        let mut r = record();
        r.note_prompted();
        apply_delta(
            &mut r,
            &env(SessionDelta::TurnFailed {
                error: "boom".into(),
                turn_seq: 0,
                error_kind: None,
            }),
        );
        assert_eq!(r.status, SubagentStatus::Error);
        assert_eq!(r.last_error.as_deref(), Some("boom"));
        assert_eq!(r.turns_settled, 1);
    }

    #[test]
    fn tool_calls_are_counted_once_per_id() {
        let mut r = record();
        apply_delta(&mut r, &tool("a"));
        apply_delta(&mut r, &tool("a"));
        apply_delta(&mut r, &tool("b"));
        assert_eq!(r.tool_count, 2);
    }
}
