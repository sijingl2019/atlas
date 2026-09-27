//! What the Agents panel calls. The tools an agent calls are in [`super::server`].

use std::sync::Arc;

use atlas_agent_wire::SessionDeltaEnvelope;
use atlas_bus::OutboundMiddleware;
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

use super::model::SubagentView;
use super::SubagentManager;

/// Feeds each child's deltas to the manager.
///
/// A stage of the delta sink, not a bus subscriber: the bus drops events for
/// a lagging subscriber, and a dropped `turn_finished` would leave a parent's
/// `agent_wait` hanging until it timed out.
pub struct SubagentMiddleware {
    pub app: AppHandle,
}

impl OutboundMiddleware<SessionDeltaEnvelope> for SubagentMiddleware {
    fn on_event(&self, envelope: &SessionDeltaEnvelope) {
        if let Some(manager) = self.app.try_state::<Arc<SubagentManager>>() {
            if manager.tracks(&envelope.session_id) {
                manager.on_delta(envelope);
            }
        }
    }
}

#[tauri::command]
pub fn subagents_list(manager: State<'_, Arc<SubagentManager>>) -> Vec<SubagentView> {
    manager.list_all()
}

#[tauri::command]
pub fn subagents_mark_seen(id: Uuid, manager: State<'_, Arc<SubagentManager>>) {
    manager.mark_seen(id);
}

#[tauri::command]
pub async fn subagents_stop(
    id: Uuid,
    remove: bool,
    manager: State<'_, Arc<SubagentManager>>,
) -> Result<(), String> {
    manager
        .stop_by_id(id, remove)
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn subagents_stop_all(
    parent_session_id: String,
    manager: State<'_, Arc<SubagentManager>>,
) -> Result<(), String> {
    manager.stop_all(&parent_session_id).await;
    Ok(())
}

/// A follow-up the user typed into a child's column.
#[tauri::command]
pub async fn subagents_prompt(
    id: Uuid,
    text: String,
    manager: State<'_, Arc<SubagentManager>>,
) -> Result<(), String> {
    manager
        .prompt_by_id(id, &text, false, None)
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Called with every dropped session (see `agents_drop_session`).
pub async fn session_dropped(app: &AppHandle, session_id: &str) {
    if let Some(manager) = app.try_state::<Arc<SubagentManager>>() {
        let manager = manager.inner().clone();
        manager.on_session_dropped(session_id).await;
    }
}
