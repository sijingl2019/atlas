//! Permission modes the HOST supplies for an adapter that has none.
//!
//! pi asks for nothing: every tool runs unprompted. Under Atlas the approval
//! gate is Atlas's own pi extension (`src-tauri/resources/pi/atlas-agents.ts`),
//! which turns a shell command or file write into a confirm. Whether that gate
//! asks is therefore Atlas's setting, not the agent's, so the host offers the
//! mode pill for it — Manual or Auto — and answers `session/set_mode` itself.
//! The extension reads the current mode back from Atlas before each confirm.
//!
//! pi-acp's own ACP `modes` are its thinking levels, which it also advertises
//! as a `thought_level` config option — so the level stays reachable from the
//! composer's options while the pill carries permissions, like every other
//! agent's.
//!
//! Like [`crate::server::one_session_per_process`] this is keyed on the
//! adapter because the gate is Atlas's fix for how that adapter behaves, not a
//! capability the adapter advertises.

use agent_client_protocol::schema::v1 as acp;
use atlas_acp_thread::AgentId;

/// Installed ids of adapters whose session modes the host supplies.
const HOST_PERMISSION_MODES: &[&str] = &["pi-acp"];

/// Ask before shell commands and file edits (the extension's confirm).
pub const MANUAL: &str = "manual";
/// Let them run without asking — the extension's gate stands down.
pub const AUTO: &str = "auto";

/// Whether the host supplies `agent_id`'s session modes (an installed id or an
/// instance of one).
pub fn host_permission_modes(agent_id: &AgentId) -> bool {
    let installed = crate::instance::installed_id(agent_id);
    HOST_PERMISSION_MODES.contains(&installed.as_str())
}

/// A fresh session's modes: Manual, the gate's behaviour when nothing is set.
pub fn permission_mode_state() -> acp::SessionModeState {
    acp::SessionModeState::new(
        acp::SessionModeId::new(MANUAL),
        vec![
            acp::SessionMode::new(acp::SessionModeId::new(MANUAL), "Manual").description(Some(
                "Ask before running commands or editing files".to_owned(),
            )),
            acp::SessionMode::new(acp::SessionModeId::new(AUTO), "Auto").description(Some(
                "Run commands and edit files without asking".to_owned(),
            )),
        ],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pi_and_its_instances_get_host_modes() {
        assert!(host_permission_modes(&AgentId::new("pi-acp")));
        assert!(host_permission_modes(&crate::instance::instance_id(
            "pi-acp", "sub-1"
        )));
        assert!(!host_permission_modes(&AgentId::new("codex-acp")));
    }

    #[test]
    fn a_fresh_session_starts_manual() {
        let state = permission_mode_state();
        assert_eq!(state.current_mode_id.to_string(), MANUAL);
        let ids: Vec<String> = state
            .available_modes
            .iter()
            .map(|m| m.id.to_string())
            .collect();
        assert_eq!(ids, [MANUAL, AUTO]);
    }
}
