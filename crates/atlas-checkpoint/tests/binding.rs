//! Binding a Project, in the three shapes the popover has to handle.
//!
//! The theme is that nothing blocks. Every configuration below is a repository
//! someone actually has, and treating a fingerprint as proof would lock each of
//! them out.

mod support;

use std::path::Path;

use support::{git, git_command, init_repo};

use atlas_checkpoint::model::ProjectMode;
use atlas_checkpoint::{
    bind, detect, disable, enable, refresh_detection, walk_new_commits, Capture, Mode, Role,
    SessionKey, Source, Store, SyncState, TurnContent,
};

const WORKSPACE: &str = "ws-atlas";

fn commit(root: &Path, file: &str, content: &str, message: &str) {
    std::fs::write(root.join(file), content).unwrap();
    git(root, &["add", "-A"]);
    git(root, &["commit", "-m", message]);
}

fn store_in(root: &Path) -> Store {
    Store::open(root.join(".atlas")).expect("store opens")
}

// ── Local binding, the whole point of the ticket ────────────────────────────

#[test]
fn binding_local_needs_no_account_no_network_and_produces_no_error() {
    let dir = tempfile::tempdir().unwrap();
    init_repo(dir.path());
    commit(dir.path(), "a.rs", "one", "initial");

    let store = store_in(dir.path());
    let binding = bind(&store, WORKSPACE, dir.path(), ProjectMode::Local).expect("binds");

    assert_eq!(binding.mode, ProjectMode::Local);
    assert!(binding.is_capturing());
    assert_eq!(binding.slug, None, "a Slug is a Cloud concept");
    assert_eq!(binding.org_id, None);
}

#[test]
fn after_binding_local_sessions_and_checkpoints_are_recorded() {
    let dir = tempfile::tempdir().unwrap();
    init_repo(dir.path());
    commit(dir.path(), "a.rs", "one", "initial");

    let mut store = store_in(dir.path());
    bind(&store, WORKSPACE, dir.path(), ProjectMode::Local).unwrap();

    let mut capture = Capture::new(&mut store, ProjectMode::Local);
    let session = capture
        .record_prompt(
            &SessionKey {
                workspace_id: WORKSPACE.into(),
                source: Source::Acp,
                native_session_id: "s1".into(),
            },
            "Add rate limiting",
            1,
            None,
            None,
            None,
        )
        .expect("capture works after binding");

    assert!(store.session(&session).unwrap().is_some());
    // And the commit walk runs for it.
    walk_new_commits(&store, WORKSPACE, dir.path(), ProjectMode::Local).expect("walk");
}

// ── The identity signals ────────────────────────────────────────────────────

#[test]
fn a_git_repository_stores_its_fingerprint_and_normalised_origin() {
    let dir = tempfile::tempdir().unwrap();
    init_repo(dir.path());
    commit(dir.path(), "a.rs", "one", "initial");
    git(
        dir.path(),
        &[
            "remote",
            "add",
            "origin",
            "git@github.com:tryatlas/atlas.git",
        ],
    );

    let store = store_in(dir.path());
    let binding = bind(&store, WORKSPACE, dir.path(), ProjectMode::Local).unwrap();

    assert!(binding.root_commit_sha.is_some());
    assert_eq!(
        binding.git_url.as_deref(),
        Some("github.com/tryatlas/atlas")
    );
    assert!(!binding.fingerprint_is_shallow);
}

#[test]
fn a_repository_with_no_remote_binds_successfully_with_a_fingerprint_and_no_url() {
    let dir = tempfile::tempdir().unwrap();
    init_repo(dir.path());
    commit(dir.path(), "a.rs", "one", "initial");

    let store = store_in(dir.path());
    let binding = bind(&store, WORKSPACE, dir.path(), ProjectMode::Local).unwrap();

    assert!(binding.root_commit_sha.is_some());
    assert_eq!(binding.git_url, None);
    assert!(binding.is_capturing(), "a local-only repo is not excluded");
}

#[test]
fn a_shallow_clone_binds_and_its_fingerprint_is_flagged_as_not_authoritative() {
    // The grafted boundary is not the true root, so the fingerprint is stored
    // but must never be treated as proof.
    let origin = tempfile::tempdir().unwrap();
    init_repo(origin.path());
    for i in 0..3 {
        commit(
            origin.path(),
            "a.rs",
            &format!("v{i}"),
            &format!("commit {i}"),
        );
    }

    let clone_dir = tempfile::tempdir().unwrap();
    let target = clone_dir.path().join("shallow");
    let output = git_command()
        .args([
            "clone",
            "--depth",
            "1",
            &format!("file://{}", origin.path().display()),
            &target.to_string_lossy(),
        ])
        .output()
        .expect("git clone runs");
    assert!(
        output.status.success(),
        "clone failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let store = store_in(&target);
    let binding = bind(&store, WORKSPACE, &target, ProjectMode::Local).unwrap();

    assert!(
        binding.is_capturing(),
        "a shallow clone must not be blocked"
    );
    assert!(
        binding.fingerprint_is_shallow,
        "the fingerprint must be marked as a graft boundary"
    );
}

// ── Git is optional ─────────────────────────────────────────────────────────

#[test]
fn a_non_git_directory_binds_captures_sessions_and_produces_no_checkpoints() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = store_in(dir.path());

    let binding = bind(&store, WORKSPACE, dir.path(), ProjectMode::Local).expect("binds");
    assert!(binding.is_capturing());
    assert_eq!(binding.root_commit_sha, None);

    let mut capture = Capture::new(&mut store, ProjectMode::Local);
    let session = capture
        .record_prompt(
            &SessionKey {
                workspace_id: WORKSPACE.into(),
                source: Source::Acp,
                native_session_id: "s1".into(),
            },
            "work in a notebook folder",
            1,
            None,
            None,
            None,
        )
        .unwrap();

    walk_new_commits(&store, WORKSPACE, dir.path(), ProjectMode::Local).unwrap();
    assert!(store.checkpoints_for_session(&session).unwrap().is_empty());
    assert_eq!(store.sessions_for_project(WORKSPACE).unwrap().len(), 1);
}

#[test]
fn taking_the_git_init_offer_starts_producing_checkpoints_without_a_re_bind() {
    // The inline offer is framed as unlocking commit linkage, so it has to
    // actually unlock it — with no restart and no second trip through the
    // popover.
    let dir = tempfile::tempdir().unwrap();
    let mut store = store_in(dir.path());

    let before = bind(&store, WORKSPACE, dir.path(), ProjectMode::Local).unwrap();
    assert_eq!(before.root_commit_sha, None);

    // The developer takes the offer.
    init_repo(dir.path());
    commit(dir.path(), "a.rs", "original", "initial");

    let after = refresh_detection(&store, dir.path())
        .unwrap()
        .expect("still bound");
    assert!(
        after.root_commit_sha.is_some(),
        "the fingerprint we could not know before must now be filled in"
    );
    assert!(after.is_capturing());
    assert_eq!(
        after.created_at, before.created_at,
        "\"capturing since\" must not reset"
    );

    // And Checkpoints now form.
    let session = {
        let mut capture = Capture::new(&mut store, ProjectMode::Local);
        capture
            .record_prompt(
                &SessionKey {
                    workspace_id: WORKSPACE.into(),
                    source: Source::Acp,
                    native_session_id: "s1".into(),
                },
                "edit it",
                1,
                None,
                None,
                None,
            )
            .unwrap()
    };
    assert!(store.session(&session).unwrap().is_some());
    walk_new_commits(&store, WORKSPACE, dir.path(), ProjectMode::Local).unwrap();
    assert!(store.commit_cursor(WORKSPACE).unwrap().is_some());
}

#[test]
fn a_repository_with_no_commits_yet_binds_without_a_fingerprint() {
    let dir = tempfile::tempdir().unwrap();
    init_repo(dir.path());

    let detection = detect(dir.path());
    assert!(detection.is_git_repository);
    assert!(!detection.has_commits);
    assert_eq!(detection.root_commit_sha, None);

    let store = store_in(dir.path());
    assert!(bind(&store, WORKSPACE, dir.path(), ProjectMode::Local)
        .unwrap()
        .is_capturing());
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

#[test]
fn binding_is_idempotent_and_reports_current_state_rather_than_duplicating() {
    let dir = tempfile::tempdir().unwrap();
    init_repo(dir.path());
    commit(dir.path(), "a.rs", "one", "initial");
    let store = store_in(dir.path());

    let first = bind(&store, WORKSPACE, dir.path(), ProjectMode::Local).unwrap();
    let second = bind(&store, WORKSPACE, dir.path(), ProjectMode::Local).unwrap();

    assert_eq!(first.workspace_id, second.workspace_id);
    assert_eq!(first.created_at, second.created_at);
    assert_eq!(
        store.binding().unwrap().as_ref(),
        Some(&second),
        "one binding, not two"
    );
}

#[test]
fn a_remote_added_after_binding_is_picked_up_by_a_refresh() {
    let dir = tempfile::tempdir().unwrap();
    init_repo(dir.path());
    commit(dir.path(), "a.rs", "one", "initial");
    let store = store_in(dir.path());

    assert_eq!(
        bind(&store, WORKSPACE, dir.path(), ProjectMode::Local)
            .unwrap()
            .git_url,
        None
    );

    git(
        dir.path(),
        &[
            "remote",
            "add",
            "origin",
            "https://github.com/tryatlas/atlas.git",
        ],
    );
    assert_eq!(
        refresh_detection(&store, dir.path())
            .unwrap()
            .unwrap()
            .git_url
            .as_deref(),
        Some("github.com/tryatlas/atlas")
    );
}

#[test]
fn disabling_stops_capture_without_deleting_what_was_recorded() {
    let dir = tempfile::tempdir().unwrap();
    init_repo(dir.path());
    commit(dir.path(), "a.rs", "one", "initial");
    let mut store = store_in(dir.path());
    bind(&store, WORKSPACE, dir.path(), ProjectMode::Local).unwrap();

    let session = {
        let mut capture = Capture::new(&mut store, ProjectMode::Local);
        capture
            .record_prompt(
                &SessionKey {
                    workspace_id: WORKSPACE.into(),
                    source: Source::Acp,
                    native_session_id: "s1".into(),
                },
                "recorded before disabling",
                1,
                None,
                None,
                None,
            )
            .unwrap()
    };

    disable(&store).unwrap();
    let binding = store.binding().unwrap().unwrap();
    assert!(!binding.is_capturing());

    // Nothing was deleted.
    assert!(store.session(&session).unwrap().is_some());
    assert_eq!(store.sessions_for_project(WORKSPACE).unwrap().len(), 1);

    // And it can be turned back on.
    enable(&store).unwrap();
    assert!(store.binding().unwrap().unwrap().is_capturing());
}

#[test]
fn an_unbound_project_reports_no_binding() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(store_in(dir.path()).binding().unwrap(), None);
}

#[test]
fn the_binding_survives_reopening_the_store() {
    let dir = tempfile::tempdir().unwrap();
    init_repo(dir.path());
    commit(dir.path(), "a.rs", "one", "initial");

    let created = {
        let store = store_in(dir.path());
        bind(&store, WORKSPACE, dir.path(), ProjectMode::Local).unwrap()
    };

    let reopened = store_in(dir.path());
    assert_eq!(reopened.binding().unwrap().as_ref(), Some(&created));
}

// ── Detection, which is what the popover renders ────────────────────────────

#[test]
fn detection_reports_everything_the_popover_shows() {
    let dir = tempfile::tempdir().unwrap();
    init_repo(dir.path());
    commit(dir.path(), "a.rs", "one", "initial");
    git(
        dir.path(),
        &[
            "remote",
            "add",
            "origin",
            "git@github.com:tryatlas/atlas.git",
        ],
    );

    let detection = detect(dir.path());
    assert!(detection.is_git_repository);
    assert!(detection.has_commits);
    assert!(detection.root_commit_sha.is_some());
    assert_eq!(
        detection.git_url.as_deref(),
        Some("github.com/tryatlas/atlas")
    );
    assert!(!detection.suggested_slug.is_empty());
}

// ── Promotion onto an existing Cloud Project ────────────────────────────────

/// Connecting a Local Project to a Project the Organisation already has goes
/// through `promote_to_cloud`, exactly like creating a new one: the binding
/// flip and the `local` → `pending` row flip commit together, so the history
/// the developer was shown in the disclosure is what the drain picks up.
#[test]
fn connecting_a_local_project_to_an_existing_cloud_project_queues_its_history() {
    let dir = tempfile::tempdir().unwrap();
    init_repo(dir.path());
    commit(dir.path(), "a.rs", "one", "initial");

    let mut store = store_in(dir.path());
    bind(&store, WORKSPACE, dir.path(), ProjectMode::Local).unwrap();

    let mut capture = Capture::new(&mut store, ProjectMode::Local);
    let key = SessionKey {
        workspace_id: WORKSPACE.into(),
        source: Source::Acp,
        native_session_id: "s1".into(),
    };
    let session = capture
        .record_prompt(&key, "Add rate limiting", 1, None, None, None)
        .unwrap();
    capture
        .record_turn(
            &session,
            TurnContent {
                turn_seq: 1,
                native_message_id: None,
                role: Role::Assistant,
                mode: Mode::Text,
                body: "done".into(),
                created_at: None,
            },
        )
        .unwrap();
    assert_eq!(
        store.session(&session).unwrap().unwrap().sync_state,
        SyncState::Local
    );

    // What `capture_connect` does once the server has bound the pick.
    let moved = store
        .promote_to_cloud(WORKSPACE, "org-1", "atlas", Some("remote-atlas"))
        .unwrap();
    assert!(
        moved >= 2,
        "the session and its messages were queued, got {moved}"
    );

    let binding = store.binding().unwrap().unwrap();
    assert_eq!(binding.mode, ProjectMode::Cloud);
    assert_eq!(binding.slug.as_deref(), Some("atlas"));
    assert_eq!(binding.org_id.as_deref(), Some("org-1"));
    assert_eq!(binding.remote_workspace_id.as_deref(), Some("remote-atlas"));

    assert_eq!(
        store.session(&session).unwrap().unwrap().sync_state,
        SyncState::Pending
    );
    for message in store.messages_for_session(&session).unwrap() {
        assert_eq!(message.sync_state, SyncState::Pending);
    }
    // Nothing is left stranded for the healer.
    assert_eq!(store.heal_stranded_local_rows(WORKSPACE).unwrap(), 0);
}

/// Changing which Cloud Project a repository syncs to re-sends everything: the
/// server keeps one object per Project and has no move, so rows the old one
/// accepted (`sent`) and rows that failed against it both go back to `pending`
/// with a fresh attempt count, in the same transaction as the binding flip.
#[test]
fn switching_cloud_project_requeues_every_row_for_the_new_destination() {
    let dir = tempfile::tempdir().unwrap();
    init_repo(dir.path());
    commit(dir.path(), "a.rs", "one", "initial");

    let mut store = store_in(dir.path());
    bind(&store, WORKSPACE, dir.path(), ProjectMode::Local).unwrap();
    store
        .promote_to_cloud(WORKSPACE, "org-1", "project1", Some("remote-1"))
        .unwrap();

    let mut capture = Capture::new(&mut store, ProjectMode::Cloud);
    let key = SessionKey {
        workspace_id: WORKSPACE.into(),
        source: Source::Acp,
        native_session_id: "s1".into(),
    };
    let session = capture
        .record_prompt(&key, "hello", 1, None, None, None)
        .unwrap();
    capture
        .record_turn(
            &session,
            TurnContent {
                turn_seq: 1,
                native_message_id: None,
                role: Role::Assistant,
                mode: Mode::Text,
                body: "done".into(),
                created_at: None,
            },
        )
        .unwrap();
    // The old destination accepted the session; a message failed against it.
    store.mark_sent(&session).unwrap();
    let message_id = store.messages_for_session(&session).unwrap()[0].id.clone();
    store.mark_failed(&message_id).unwrap();
    assert_eq!(
        store.session(&session).unwrap().unwrap().sync_state,
        SyncState::Sent
    );
    assert_eq!(
        store.messages_for_session(&session).unwrap()[0].sync_state,
        SyncState::Failed
    );

    let moved = store
        .switch_cloud_project(WORKSPACE, "org-1", "project2", "remote-2")
        .unwrap();
    assert_eq!(moved, 2);

    let binding = store.binding().unwrap().unwrap();
    assert_eq!(binding.mode, ProjectMode::Cloud);
    assert_eq!(binding.slug.as_deref(), Some("project2"));
    assert_eq!(binding.remote_workspace_id.as_deref(), Some("remote-2"));
    assert_eq!(
        store.session(&session).unwrap().unwrap().sync_state,
        SyncState::Pending
    );
    assert_eq!(
        store.messages_for_session(&session).unwrap()[0].sync_state,
        SyncState::Pending
    );
    // Nothing is left in a state the new destination will never see.
    assert_eq!(
        store
            .row_count_in_state(WORKSPACE, SyncState::Sent)
            .unwrap(),
        0
    );
    assert_eq!(
        store
            .row_count_in_state(WORKSPACE, SyncState::Failed)
            .unwrap(),
        0
    );
    assert_eq!(
        store
            .row_count_in_state(WORKSPACE, SyncState::Local)
            .unwrap(),
        0
    );
}
