//! Mirrored subagents: children Atlas shows but does not host.
//!
//! pi-subagents (a pi extension) runs its children as pi sessions inside the
//! parent's own pi — in-process, or in a detached runner — so they never
//! become Atlas sessions. Atlas's pi extension reports them instead:
//!
//! - **What they do** ([`SubagentManager::mirror_report`]): status, counts and
//!   transcript items, turned into ordinary `atlas:agents` deltas on a
//!   synthetic session id (`mirror:<uuid>`), so the Subagents panel renders a
//!   mirrored column exactly like a hosted one.
//! - **What they ask** ([`SubagentManager::mirror_approval`]): a child has no
//!   UI (its `ctx.ui.confirm` answers "no" at once), so the guard injected
//!   into it asks Atlas over HTTP and waits. The request is raised as a normal
//!   permission request on the child's column; the user's answer comes back
//!   through `agents_respond_permission` ([`SubagentManager::resolve_mirror_permission`]).

use std::sync::Arc;
use std::time::Duration;

use atlas_agent_wire::{
    AgentId, Message, MessageMode, MessageRole, SessionDelta, SessionDeltaEnvelope, SessionStatus,
    ToolCall, ToolCallStatus,
};
use chrono::Utc;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::oneshot;
use uuid::Uuid;

use super::manager::{Caller, Result, SubagentError, SubagentManager};
use super::model::{Mirror, PendingApproval, SubagentRecord, SubagentStatus, SubagentView};

pub type EmitDelta = Arc<dyn Fn(SessionDeltaEnvelope) + Send + Sync>;

/// The most a mirrored child waits for the user before its call is refused.
pub const APPROVAL_TIMEOUT: Duration = Duration::from_secs(15 * 60);

pub struct PendingMirrorApproval {
    answer: oneshot::Sender<bool>,
    child_session_id: String,
}

/// One report about one child, from the pi extension.
#[derive(Debug, Deserialize)]
pub struct MirrorReport {
    /// Stable per child: `<runId>:<index>`.
    pub key: String,
    pub name: String,
    #[serde(default)]
    pub task: Option<String>,
    /// pi-subagents' own word: pending, running, completed, failed, detached,
    /// stopped.
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub tool_count: Option<u32>,
    #[serde(default)]
    pub session_file: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    /// New transcript items since the last report, in order.
    #[serde(default)]
    pub items: Vec<MirrorItem>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum MirrorItem {
    User {
        text: String,
    },
    Assistant {
        text: String,
    },
    /// A tool call, first sighting or an update (same `id`).
    Tool {
        id: String,
        name: String,
        #[serde(default)]
        title: Option<String>,
        /// running, completed or failed.
        status: String,
        #[serde(default)]
        args: Option<Value>,
        #[serde(default)]
        result: Option<String>,
    },
}

fn status_from(word: &str) -> Option<SubagentStatus> {
    Some(match word {
        "pending" | "queued" | "starting" => SubagentStatus::Starting,
        "running" | "working" | "detached" => SubagentStatus::Working,
        "completed" | "complete" | "done" | "success" => SubagentStatus::Done,
        "failed" | "error" => SubagentStatus::Error,
        "stopped" | "cancelled" | "canceled" | "interrupted" => SubagentStatus::Stopped,
        _ => return None,
    })
}

/// `<root>/<runId>/run-<index>/session.jsonl` → `<runId>:<index>`, the key a
/// foreground child is reported under.
pub fn key_from_session_file(path: &str) -> Option<String> {
    let mut parts = std::path::Path::new(path).iter().rev();
    let _file = parts.next()?;
    let run = parts.next()?.to_str()?.strip_prefix("run-")?;
    let run_id = parts.next()?.to_str()?;
    Some(format!("{run_id}:{run}"))
}

fn message(role: MessageRole, mode: MessageMode, content: String, tools: Vec<ToolCall>) -> Message {
    Message {
        id: format!("mirror-{}", Uuid::new_v4().simple()),
        role,
        mode,
        content,
        thinking: String::new(),
        tool_calls: tools,
        plan: None,
        model: None,
        attachments: Vec::new(),
        timestamp: Utc::now(),
    }
}

fn tool_call(
    id: &str,
    name: &str,
    title: Option<&str>,
    status: &str,
    args: Option<&Value>,
    result: Option<&str>,
) -> ToolCall {
    ToolCall {
        id: id.to_string(),
        tool_name: name.to_string(),
        title: Some(title.unwrap_or(name).to_string()),
        kind: Some(if name == "bash" { "execute" } else { "other" }.to_string()),
        status: match status {
            "completed" | "done" => ToolCallStatus::Completed,
            "failed" | "error" => ToolCallStatus::Failed,
            "pending" => ToolCallStatus::Pending,
            _ => ToolCallStatus::Running,
        },
        arguments: args.cloned().unwrap_or(Value::Null),
        result: result.map(str::to_string),
        locations: Vec::new(),
        raw_output: None,
        content_blocks: Vec::new(),
    }
}

impl SubagentManager {
    /// Where mirrored transcripts are announced. Set once, at startup.
    pub fn set_delta_emitter(&self, emit: EmitDelta) {
        let _ = self.emit_delta.set(emit);
    }

    fn emit_mirror_delta(&self, record: &SubagentRecord, delta: SessionDelta) {
        if let Some(emit) = self.emit_delta.get() {
            emit(SessionDeltaEnvelope {
                agent_id: record.agent_handle,
                session_id: record.child_session_id.clone(),
                delta,
            });
        }
    }

    /// The mirrored record for `key` under the caller, made on first sight.
    fn mirror_record<'a>(
        registry: &'a mut super::manager::Registry,
        caller: &Caller,
        key: &str,
        name: &str,
    ) -> (&'a mut SubagentRecord, bool) {
        let existing = registry.records.values().find(|r| {
            r.parent_session_id == caller.session_id
                && r.mirror.as_ref().is_some_and(|m| m.key == key)
        });
        if let Some(id) = existing.map(|r| r.id) {
            return (registry.records.get_mut(&id).expect("just found"), false);
        }
        // Names are how the tools address a child; keep them unique.
        let mut unique = name.to_string();
        let mut n = 2;
        while registry.find(&caller.session_id, &unique).is_some() {
            unique = format!("{name}-{n}");
            n += 1;
        }
        let mut record = SubagentRecord::new(
            caller.session_id.clone(),
            caller.plugin_id.clone(),
            AgentId::new(),
            format!("mirror:{}", Uuid::new_v4()),
            unique,
            String::new(),
            caller.cwd.clone(),
        );
        record.mirror = Some(Mirror {
            key: key.to_string(),
            ..Mirror::default()
        });
        let id = record.id;
        registry
            .by_child
            .insert(record.child_session_id.clone(), id);
        registry.records.insert(id, record);
        (registry.records.get_mut(&id).expect("just inserted"), true)
    }

    /// Apply one report: create or update the child, and play its new
    /// transcript items into its column.
    pub fn mirror_report(&self, caller: &Caller, report: MirrorReport) -> Result<SubagentView> {
        if self.is_child(&caller.session_id) {
            return Err(SubagentError::new(
                "depth_exceeded",
                "a subagent's own subagents are not shown",
            ));
        }
        let mut deltas = Vec::new();
        let (view, created, record_snapshot) = {
            let mut registry = self.registry.lock();
            let (record, created) =
                Self::mirror_record(&mut registry, caller, &report.key, &report.name);
            let mirror = record.mirror.as_mut().expect("a mirrored record");
            if report.session_file.is_some() {
                mirror.session_file = report.session_file.clone();
            }
            if let Some(task) = report.task.filter(|t| !t.trim().is_empty()) {
                record.task = task;
            }
            for item in report.items {
                match item {
                    MirrorItem::User { text } => deltas.push(SessionDelta::MessageAppended {
                        message: message(MessageRole::User, MessageMode::Text, text, Vec::new()),
                    }),
                    MirrorItem::Assistant { text } => deltas.push(SessionDelta::MessageAppended {
                        message: message(
                            MessageRole::Assistant,
                            MessageMode::Text,
                            text,
                            Vec::new(),
                        ),
                    }),
                    MirrorItem::Tool {
                        id,
                        name,
                        title,
                        status,
                        args,
                        result,
                    } => {
                        let call = tool_call(
                            &id,
                            &name,
                            title.as_deref(),
                            &status,
                            args.as_ref(),
                            result.as_deref(),
                        );
                        if record.tool_ids.insert(id.clone()) {
                            record.tool_count += 1;
                        }
                        let mirror = record.mirror.as_mut().expect("a mirrored record");
                        match mirror.tool_messages.get(&id) {
                            Some(message_id) => deltas.push(SessionDelta::ToolCallUpserted {
                                message_id: message_id.clone(),
                                tool_call: call,
                            }),
                            None => {
                                let msg = message(
                                    MessageRole::Assistant,
                                    MessageMode::Tool,
                                    String::new(),
                                    vec![call],
                                );
                                mirror.tool_messages.insert(id, msg.id.clone());
                                deltas.push(SessionDelta::MessageAppended { message: msg });
                            }
                        }
                    }
                }
            }
            if let Some(count) = report.tool_count {
                record.tool_count = record.tool_count.max(count);
            }
            let before = record.status;
            if let Some(next) = report.status.as_deref().and_then(status_from) {
                // A child waiting on the user stays blocked whatever its
                // runner says; the answer moves it on.
                record.status = if record.pending.is_empty() {
                    next
                } else {
                    SubagentStatus::Blocked
                };
            }
            if report.error.is_some() {
                record.last_error = report.error;
            }
            let after = record.status;
            if before != after || created {
                match after {
                    SubagentStatus::Working | SubagentStatus::Starting => {
                        record.turn_open = true;
                        deltas.push(SessionDelta::Status {
                            status: SessionStatus::Running,
                            turn_seq: 0,
                        });
                    }
                    SubagentStatus::Done | SubagentStatus::Stopped => {
                        if record.turn_open {
                            record.turn_open = false;
                            record.turns_settled += 1;
                        }
                        deltas.push(SessionDelta::TurnFinished {
                            stop_reason: if after == SubagentStatus::Done {
                                "end_turn"
                            } else {
                                "cancelled"
                            }
                            .into(),
                            turn_seq: 0,
                        });
                    }
                    SubagentStatus::Error => {
                        if record.turn_open {
                            record.turn_open = false;
                            record.turns_settled += 1;
                        }
                        deltas.push(SessionDelta::TurnFailed {
                            error: record.last_error.clone().unwrap_or_else(|| "failed".into()),
                            turn_seq: 0,
                            error_kind: None,
                        });
                    }
                    _ => {}
                }
            }
            record.updated_at = Utc::now();
            (record.view(), created, record.clone())
        };
        // The record first, so the panel adopts the column before its deltas.
        let _ = created;
        self.announce(view.clone());
        for delta in deltas {
            self.emit_mirror_delta(&record_snapshot, delta);
        }
        Ok(view)
    }

    /// A mirrored child asks the user before running something. Resolves to
    /// whether the user allowed it; refuses after [`APPROVAL_TIMEOUT`].
    pub async fn mirror_approval(
        &self,
        caller: &Caller,
        session_file: Option<String>,
        name: Option<String>,
        title: String,
        detail: String,
    ) -> Result<bool> {
        let request_id = Uuid::new_v4();
        let (tx, rx) = oneshot::channel();
        let (view, record) = {
            let mut registry = self.registry.lock();
            // By the child's session file when it has been reported with one,
            // else by the key its path encodes, else a column of its own.
            let found = session_file.as_deref().and_then(|file| {
                registry
                    .records
                    .values()
                    .find(|r| {
                        r.parent_session_id == caller.session_id
                            && r.mirror
                                .as_ref()
                                .is_some_and(|m| m.session_file.as_deref() == Some(file))
                    })
                    .and_then(|r| r.mirror.as_ref().map(|m| m.key.clone()))
            });
            let key = found
                .or_else(|| session_file.as_deref().and_then(key_from_session_file))
                .or_else(|| session_file.clone())
                .unwrap_or_else(|| format!("approval:{}", name.as_deref().unwrap_or("subagent")));
            let (record, _) = Self::mirror_record(
                &mut registry,
                caller,
                &key,
                name.as_deref().unwrap_or("subagent"),
            );
            if let (Some(file), Some(mirror)) = (session_file, record.mirror.as_mut()) {
                mirror.session_file.get_or_insert(file);
            }
            record.pending.push(PendingApproval {
                request_id,
                title: title.clone(),
            });
            record.status = SubagentStatus::Blocked;
            record.updated_at = Utc::now();
            (record.view(), record.clone())
        };
        self.approvals.lock().insert(
            request_id,
            PendingMirrorApproval {
                answer: tx,
                child_session_id: record.child_session_id.clone(),
            },
        );
        self.announce(view);
        self.emit_mirror_delta(
            &record,
            SessionDelta::PermissionRequest {
                request_id,
                tool_call: json!({
                    "toolCallId": format!("mirror-approval-{request_id}"),
                    "title": title,
                    "kind": "execute",
                    "status": "pending",
                    "rawInput": { "command": detail },
                }),
                options: json!([
                    { "optionId": "allow", "name": "Allow", "kind": "allow_once" },
                    { "optionId": "deny", "name": "Deny", "kind": "reject_once" },
                ]),
            },
        );
        let allowed = matches!(
            tokio::time::timeout(APPROVAL_TIMEOUT, rx).await,
            Ok(Ok(true))
        );
        self.approvals.lock().remove(&request_id);
        let view = {
            let mut registry = self.registry.lock();
            registry.records.get_mut(&record.id).map(|r| {
                r.pending.retain(|p| p.request_id != request_id);
                if !allowed {
                    r.denied_count += 1;
                }
                if r.status == SubagentStatus::Blocked && r.pending.is_empty() {
                    r.status = SubagentStatus::Working;
                }
                r.updated_at = Utc::now();
                r.view()
            })
        };
        self.emit_mirror_delta(&record, SessionDelta::PermissionResolved { request_id });
        if let Some(view) = view {
            self.announce(view);
        }
        Ok(allowed)
    }

    /// The user answered a permission request. `true` when it was a mirrored
    /// child's (and so has been answered here), `false` when it belongs to a
    /// hosted session.
    pub fn resolve_mirror_permission(&self, request_id: Uuid, allowed: bool) -> bool {
        match self.approvals.lock().remove(&request_id) {
            Some(pending) => {
                let _ = pending.answer.send(allowed);
                true
            }
            None => false,
        }
    }

    /// Refuse everything a mirrored child is still waiting on (it is gone).
    pub(super) fn deny_mirror_approvals(&self, child_session_id: &str) {
        let mut approvals = self.approvals.lock();
        let ids: Vec<Uuid> = approvals
            .iter()
            .filter(|(_, p)| p.child_session_id == child_session_id)
            .map(|(id, _)| *id)
            .collect();
        for id in ids {
            if let Some(p) = approvals.remove(&id) {
                let _ = p.answer.send(false);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::agent_host::SessionKey;
    use crate::commands::subagents::manager::SubagentHost;
    use crate::commands::subagents::model::SubagentEvent;
    use futures::future::BoxFuture;
    use parking_lot::Mutex;

    struct Host;
    impl SubagentHost for Host {
        fn session_info(&self, _s: &str) -> Option<(String, String)> {
            Some(("pi-acp".into(), "/work".into()))
        }
        fn is_installed(&self, _p: &str) -> bool {
            true
        }
        fn start_session(
            &self,
            _p: String,
            _c: String,
            _m: Option<String>,
        ) -> BoxFuture<'static, std::result::Result<SessionKey, String>> {
            Box::pin(async { Err("no".to_string()) })
        }
        fn current_mode(&self, _s: &str) -> Option<String> {
            None
        }
        fn send(&self, _k: &SessionKey, _t: String) -> std::result::Result<(), String> {
            Ok(())
        }
        fn cancel(&self, _k: &SessionKey) -> std::result::Result<(), String> {
            Ok(())
        }
        fn drop_session(&self, _s: String) -> BoxFuture<'static, std::result::Result<(), String>> {
            Box::pin(async { Ok(()) })
        }
        fn transcript(&self, _k: &SessionKey) -> std::result::Result<Vec<Message>, String> {
            Ok(Vec::new())
        }
        fn release(&self, _a: AgentId) {}
    }

    type Log = Arc<Mutex<Vec<SessionDeltaEnvelope>>>;

    fn manager() -> (Arc<SubagentManager>, Log) {
        let m = SubagentManager::new(Box::new(Host), Arc::new(|_: &SubagentEvent| {}));
        let log: Log = Arc::default();
        let sink = log.clone();
        m.set_delta_emitter(Arc::new(move |e| sink.lock().push(e)));
        (m, log)
    }

    fn parent() -> Caller {
        Caller {
            session_id: "parent".into(),
            plugin_id: "pi-acp".into(),
            cwd: "/work".into(),
        }
    }

    fn report(json: Value) -> MirrorReport {
        serde_json::from_value(json).unwrap()
    }

    #[test]
    fn a_report_creates_a_column_and_plays_its_transcript() {
        let (m, log) = manager();
        let view = m
            .mirror_report(
                &parent(),
                report(json!({
                    "key": "r1:0", "name": "worker", "task": "fix it", "status": "running",
                    "items": [
                        { "type": "user", "text": "fix it" },
                        { "type": "tool", "id": "t1", "name": "bash", "title": "ls", "status": "running" },
                    ],
                })),
            )
            .unwrap();
        assert!(view.mirror);
        assert_eq!(view.status, SubagentStatus::Working);
        assert_eq!(view.tool_count, 1);
        m.mirror_report(
            &parent(),
            report(json!({
                "key": "r1:0", "name": "worker", "status": "completed",
                "items": [
                    { "type": "tool", "id": "t1", "name": "bash", "status": "completed", "result": "a\n" },
                    { "type": "assistant", "text": "done" },
                ],
            })),
        )
        .unwrap();
        let log = log.lock();
        assert!(log.iter().all(|e| e.session_id == view.child_session_id));
        let kinds: Vec<&str> = log
            .iter()
            .map(|e| match &e.delta {
                SessionDelta::MessageAppended { .. } => "message",
                SessionDelta::ToolCallUpserted { .. } => "tool_update",
                SessionDelta::Status { .. } => "status",
                SessionDelta::TurnFinished { .. } => "finished",
                _ => "other",
            })
            .collect();
        assert_eq!(
            kinds,
            [
                "message",
                "message",
                "status",
                "tool_update",
                "message",
                "finished"
            ]
        );
        assert_eq!(m.list(&parent())[0].status, SubagentStatus::Done);
        assert_eq!(m.list(&parent())[0].tool_count, 1);
    }

    #[test]
    fn a_foreground_child_session_file_names_its_key() {
        assert_eq!(
            key_from_session_file("/s/parent/abc123/run-2/session.jsonl").as_deref(),
            Some("abc123:2")
        );
        assert_eq!(key_from_session_file("/s/async-9/x.jsonl"), None);
    }

    #[tokio::test]
    async fn an_approval_blocks_the_child_until_the_user_answers() {
        let (m, log) = manager();
        m.mirror_report(
            &parent(),
            report(json!({ "key": "r1:0", "name": "worker", "status": "running" })),
        )
        .unwrap();
        let waiter = {
            let m = m.clone();
            tokio::spawn(async move {
                m.mirror_approval(
                    &parent(),
                    Some("/s/p/r1/run-0/session.jsonl".into()),
                    Some("worker".into()),
                    "Run: rm -rf dist".into(),
                    "rm -rf dist".into(),
                )
                .await
            })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        let child = &m.list(&parent())[0];
        assert_eq!(child.status, SubagentStatus::Blocked);
        let request_id = child.pending_approvals[0].request_id;
        assert!(log
            .lock()
            .iter()
            .any(|e| matches!(e.delta, SessionDelta::PermissionRequest { .. })));
        assert!(!m.resolve_mirror_permission(Uuid::new_v4(), true));
        assert!(m.resolve_mirror_permission(request_id, false));
        assert!(!waiter.await.unwrap().unwrap());
        let child = &m.list(&parent())[0];
        assert_eq!(child.denied_count, 1);
        assert_eq!(child.status, SubagentStatus::Working);
    }

    #[tokio::test]
    async fn closing_a_mirrored_column_refuses_what_it_waits_on() {
        let (m, _) = manager();
        let waiter = {
            let m = m.clone();
            tokio::spawn(async move {
                m.mirror_approval(
                    &parent(),
                    None,
                    Some("w".into()),
                    "Run: x".into(),
                    "x".into(),
                )
                .await
            })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        let id = m.list(&parent())[0].id;
        m.stop_by_id(id, true).await.unwrap();
        assert!(!waiter.await.unwrap().unwrap());
        assert!(m.list(&parent()).is_empty());
    }
}
