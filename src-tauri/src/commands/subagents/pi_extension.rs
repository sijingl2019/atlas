//! Installs the pi extension that gives pi the subagent tools and the
//! permission guard (`resources/pi/atlas-agents.ts`), and the guard it injects
//! into pi-subagents children (`resources/pi/atlas-child-guard.ts`).
//!
//! The extension goes to `~/.pi/agent/extensions/`, where pi loads it for
//! every run; the child guard to `~/.pi/agent/atlas/`, where pi does NOT look —
//! it must load only into children, through pi-subagents' registry. The
//! extension does nothing unless Atlas started the pi process, so installing
//! it is harmless to the user's own pi runs. The file is refreshed on every
//! launch but only ever overwritten while it still carries the managed marker,
//! so a user who takes it over keeps their copy.

use std::path::{Path, PathBuf};

const SOURCE: &str = include_str!("../../../resources/pi/atlas-agents.ts");
const CHILD_GUARD_SOURCE: &str = include_str!("../../../resources/pi/atlas-child-guard.ts");
const MARKER: &str = "// @atlas-managed-pi-extension";
const FILE_NAME: &str = "atlas-agents.ts";
const CHILD_GUARD_FILE: &str = "atlas-child-guard.ts";

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Written,
    Unchanged,
    /// pi is not set up on this machine.
    NoPi,
    /// The file there is not ours (the marker was removed).
    UserOwned,
}

/// Write `source` to `path` unless it is already there or the user owns it.
fn install_file(path: &Path, source: &str) -> std::io::Result<Outcome> {
    match std::fs::read_to_string(path) {
        Ok(existing) if existing == source => return Ok(Outcome::Unchanged),
        Ok(existing) if !existing.starts_with(MARKER) => return Ok(Outcome::UserOwned),
        _ => {}
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, source)?;
    Ok(Outcome::Written)
}

/// Install into `pi_home` (`~/.pi/agent`) when it exists. The outcome is the
/// extension's; the child guard follows the same rules alongside it.
pub fn install_into(pi_home: &Path) -> std::io::Result<Outcome> {
    if !pi_home.is_dir() {
        return Ok(Outcome::NoPi);
    }
    install_file(
        &pi_home.join("atlas").join(CHILD_GUARD_FILE),
        CHILD_GUARD_SOURCE,
    )?;
    install_file(&pi_home.join("extensions").join(FILE_NAME), SOURCE)
}

fn pi_home() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("PI_CODING_AGENT_DIR") {
        return Some(PathBuf::from(dir));
    }
    dirs::home_dir().map(|home| home.join(".pi").join("agent"))
}

/// Install or refresh the extension. Best-effort: failure is logged.
pub fn install() {
    let Some(home) = pi_home() else {
        return;
    };
    match install_into(&home) {
        Ok(outcome) => tracing::info!(target: "atlas::subagents", ?outcome, "pi extension"),
        Err(e) => tracing::warn!(target: "atlas::subagents", "pi extension not installed: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installs_refreshes_and_respects_a_user_owned_copy() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            install_into(&dir.path().join("missing")).unwrap(),
            Outcome::NoPi
        );
        assert_eq!(install_into(dir.path()).unwrap(), Outcome::Written);
        assert_eq!(install_into(dir.path()).unwrap(), Outcome::Unchanged);
        let path = dir.path().join("extensions").join(FILE_NAME);
        std::fs::write(&path, format!("{MARKER}\nold")).unwrap();
        assert_eq!(install_into(dir.path()).unwrap(), Outcome::Written);
        std::fs::write(&path, "// mine").unwrap();
        assert_eq!(install_into(dir.path()).unwrap(), Outcome::UserOwned);
    }

    #[test]
    fn the_shipped_sources_carry_the_marker() {
        assert!(SOURCE.starts_with(MARKER));
        assert!(CHILD_GUARD_SOURCE.starts_with(MARKER));
    }

    #[test]
    fn the_child_guard_is_kept_out_of_the_extensions_dir() {
        let dir = tempfile::tempdir().unwrap();
        install_into(dir.path()).unwrap();
        assert!(dir.path().join("atlas").join(CHILD_GUARD_FILE).is_file());
        assert!(!dir
            .path()
            .join("extensions")
            .join(CHILD_GUARD_FILE)
            .exists());
    }
}
