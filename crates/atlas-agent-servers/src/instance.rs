//! Agent *instances*: more than one connection to the same installed agent.
//!
//! The manager keeps one connection per agent id, and that is right for a
//! chat — but some adapters hold only one live session per process (pi-acp
//! closes every other session when a new one opens), and a subagent should not
//! share its parent's process anyway: a child's crash must not end the parent.
//! An instance id, `<installed id>#<instance>`, is a distinct connection key
//! that resolves to the installed agent everywhere the catalog is consulted
//! (its command, its default mode, its environment quirks, whether it is still
//! installed).

use atlas_acp_thread::AgentId;

pub const INSTANCE_SEPARATOR: char = '#';

/// The installed agent an id names: itself, or an instance's base.
pub fn installed_id(id: &AgentId) -> AgentId {
    match id.as_str().split_once(INSTANCE_SEPARATOR) {
        Some((base, _)) => AgentId::new(base),
        None => id.clone(),
    }
}

/// The id of instance `instance` of `installed`.
pub fn instance_id(installed: &str, instance: &str) -> AgentId {
    AgentId::new(format!("{installed}{INSTANCE_SEPARATOR}{instance}"))
}

/// Whether `id` names an instance rather than the agent itself.
pub fn is_instance(id: &AgentId) -> bool {
    id.as_str().contains(INSTANCE_SEPARATOR)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_instance_resolves_to_its_installed_agent() {
        let id = instance_id("pi-acp", "sub-1");
        assert_eq!(id.as_str(), "pi-acp#sub-1");
        assert!(is_instance(&id));
        assert_eq!(installed_id(&id).as_str(), "pi-acp");
        let plain = AgentId::new("codex-acp");
        assert!(!is_instance(&plain));
        assert_eq!(installed_id(&plain), plain);
    }
}
