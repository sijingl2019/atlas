//! **Subagents**: agents that other agents start, in the herdr model.
//!
//! Atlas has no notion of an agent's *internal* subagents — each ACP adapter
//! either hides them or flattens them into its own stream. Instead, like herdr
//! (a terminal multiplexer whose agents start other agents in panes through
//! its CLI), Atlas hands every session a small tool surface — start, prompt,
//! wait, read, list, stop — and each child it starts is an ordinary Atlas
//! session. Everything a session already has (the transcript, the permission
//! queue, `respond_permission`, history) is therefore a child's too; what this
//! module adds is the parent → child link, the status each child is in, and
//! the Agents panel's event stream.
//!
//! - [`manager`]: the registry and the tool semantics.
//! - [`model`]: the record, and the pure delta → status rules.
//! - [`server`]: the loopback tool server — MCP for agents that take HTTP
//!   MCP (Codex, Claude Code, the native agent), plain JSON for the pi
//!   extension (pi has no MCP).
//! - [`pi_extension`]: installs that extension, which also gates pi's risky
//!   tools behind a confirm so a pi session can be approved like any other.
//! - [`commands`]: what the Agents panel calls.
//! - `persist`: the records saved across a restart, and their reopening.

pub mod commands;
#[cfg(test)]
mod e2e;
pub mod manager;
pub mod mirror;
pub mod model;
pub mod persist;
pub mod pi_extension;
pub mod server;

use std::path::{Path, PathBuf};

pub use manager::SubagentManager;

/// The window event every change to a subagent record is announced on.
pub const SUBAGENTS_EVENT: &str = "atlas:subagents";

/// The environment variable that tells an agent's process tree where the
/// endpoint file is. Set on every agent the host spawns.
pub const ENDPOINT_ENV: &str = "ATLAS_AGENTS_ENDPOINT";

/// The name the tool server goes by in every agent's MCP configuration.
pub const AGENTS_SERVER_NAME: &str = "atlas_agents";

/// Where the running tool server's address and key are written, so a process
/// that cannot take MCP (the pi extension) can reach it.
pub fn endpoint_file(config_dir: &Path) -> PathBuf {
    config_dir.join("agents-endpoint.json")
}
