//! End-to-end check against REAL agents: a parent agent is asked to start a
//! subagent through the tools, the child runs, asks for a permission, a
//! stand-in user answers it, and the parent reads the result back.
//!
//! Ignored by default — it needs the agents installed in Atlas's own data
//! directory, their sign-in, and a model. Run one agent at a time:
//!
//! ```sh
//! ATLAS_E2E_PARENT=codex-acp cargo test -p atlas --lib subagents::e2e -- --ignored --nocapture
//! ATLAS_E2E_PARENT=pi-acp    cargo test -p atlas --lib subagents::e2e -- --ignored --nocapture
//! ATLAS_E2E_PARENT=claude-acp ...
//! ```
//!
//! `ATLAS_E2E_CHILD_KIND` starts the child as another agent; `ATLAS_E2E_DENY=1`
//! makes the stand-in user refuse the child's permissions instead;
//! `ATLAS_E2E_CMD` replaces the child's shell command; `ATLAS_E2E_MODE` sets the
//! parent's mode, which a child of the same agent inherits.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock, Weak};
use std::time::Duration;

use atlas_agent_store::{
    AgentRegistryStore, AgentServerStore, InheritedProjectEnvironment, NodeRuntime, ReqwestClient,
};
use atlas_agent_wire::{DeltaSink, SessionDelta, SessionDeltaEnvelope};
use parking_lot::Mutex;
use serde_json::Value;

use super::manager::SubagentHost;
use super::model::SubagentStatus;
use super::server::{SubagentServerHost, SubagentSessionOffers};
use super::SubagentManager;
use crate::commands::agent_host::{AgentHost, CompositeLifecycle, PermissionDecision, SessionKey};

#[derive(Default)]
struct Log {
    /// Permission requests seen, per session: (title, answer).
    permissions: HashMap<String, Vec<(String, &'static str)>>,
    finished: HashMap<String, u32>,
    text: HashMap<String, String>,
    failures: Vec<String>,
}

struct Sink {
    host: OnceLock<Weak<AgentHost>>,
    manager: OnceLock<Arc<SubagentManager>>,
    log: Arc<Mutex<Log>>,
    deny_children: bool,
}

impl DeltaSink for Sink {
    fn emit(&self, envelope: SessionDeltaEnvelope) {
        let manager = self.manager.get().cloned();
        if let Some(manager) = &manager {
            if manager.tracks(&envelope.session_id) {
                manager.on_delta(&envelope);
            }
        }
        let session = envelope.session_id.clone();
        let mut log = self.log.lock();
        match &envelope.delta {
            SessionDelta::TextChunk { delta, .. } => {
                log.text.entry(session).or_default().push_str(delta);
            }
            SessionDelta::MessageAppended { message } => {
                if matches!(message.role, atlas_agent_wire::MessageRole::Assistant) {
                    log.text
                        .entry(session)
                        .or_default()
                        .push_str(&message.content);
                }
            }
            SessionDelta::TurnFinished { .. } => {
                *log.finished.entry(session).or_default() += 1;
            }
            SessionDelta::TurnFailed { error, .. } => {
                log.failures.push(format!("{session}: {error}"));
                *log.finished.entry(session).or_default() += 1;
            }
            SessionDelta::PermissionRequest {
                request_id,
                tool_call,
                options,
            } => {
                let is_child = manager.as_ref().is_some_and(|m| m.tracks(&session));
                let deny = is_child && self.deny_children;
                let wanted = if deny { "reject_once" } else { "allow_once" };
                let option_id = options.as_array().and_then(|opts| {
                    opts.iter()
                        .find(|o| o.get("kind").and_then(Value::as_str) == Some(wanted))
                        .or_else(|| opts.first())
                        .and_then(|o| o.get("optionId").and_then(Value::as_str))
                        .map(str::to_string)
                });
                let title = tool_call
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("?")
                    .to_string();
                println!(
                    "[e2e] permission on {} ({}): {title} -> {wanted}",
                    session,
                    if is_child { "child" } else { "parent" }
                );
                log.permissions
                    .entry(session.clone())
                    .or_default()
                    .push((title, if deny { "denied" } else { "allowed" }));
                // Answered off this call: the projector may be mid-update.
                let host = self.host.get().and_then(Weak::upgrade);
                let request_id = *request_id;
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    let (Some(host), Some(option_id)) = (host, option_id) else {
                        return;
                    };
                    match host.respond_permission(
                        &session,
                        request_id,
                        PermissionDecision::Selected { option_id },
                    ) {
                        Ok(kind) => {
                            if let Some(m) = manager {
                                m.note_permission_decision(&session, kind.as_ref());
                            }
                        }
                        Err(e) => println!("[e2e] respond failed: {e}"),
                    }
                });
            }
            _ => {}
        }
    }
}

fn prompt_for(parent: &str, child_kind: Option<&str>, command: &str) -> String {
    let (start, wait, read) = if parent.starts_with("pi") {
        ("atlas_agent_start", "atlas_agent_wait", "atlas_agent_read")
    } else {
        (
            "agent_start (atlas_agents MCP server)",
            "agent_wait",
            "agent_read",
        )
    };
    let kind = child_kind
        .map(|k| format!(" with kind `{k}`"))
        .unwrap_or_default();
    format!(
        "This is an automated test of your subagent tools. Do exactly this and nothing else:\n\
         1. Call {start} with name `toucher`{kind} and task: \"Use your shell tool to run exactly: \
         {command}   You MUST attempt it with the tool. If the sandbox blocks it, run it again \
         with escalated permissions, which asks the user for approval. Then reply with its output \
         in one line, or with: refused — only if the user refused.\"\n\
         2. Call {wait} with name `toucher` until it is settled. If the result says timed_out, or the \
         status is blocked, call {wait} again (at most 6 times).\n\
         3. Call {read} with name `toucher`.\n\
         4. Reply with one line: RESULT: <the subagent's final reply>"
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "drives real installed agents; see the module docs"]
async fn a_real_parent_starts_waits_for_and_reads_a_subagent() {
    let parent_plugin = std::env::var("ATLAS_E2E_PARENT").unwrap_or_else(|_| "codex-acp".into());
    let child_kind = std::env::var("ATLAS_E2E_CHILD_KIND").ok();
    let deny = std::env::var("ATLAS_E2E_DENY").as_deref() == Ok("1");

    let data_dir = dirs::data_dir().unwrap().join("dev.atlas.ide");
    let config_dir = std::env::temp_dir().join(format!("atlas-e2e-{}", uuid::Uuid::new_v4()));
    let project = config_dir.join("project");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::write(project.join("README.md"), "# e2e project\n").unwrap();

    let http = Arc::new(ReqwestClient::new("atlas-e2e").unwrap());
    let registry = Arc::new(AgentRegistryStore::new(data_dir.clone(), http.clone()));
    let store: Arc<AgentServerStore> = Arc::new(AgentServerStore::new(
        data_dir.clone(),
        http.clone(),
        NodeRuntime::managed(&data_dir, http),
        Arc::new(InheritedProjectEnvironment),
        Some(registry.clone()),
    ));
    let host_store = store.clone();
    // What the app does at startup: the cached registry, then the installed map.
    registry.load_cached().await.expect("cached registry");
    store
        .set_settings(crate::commands::agent_host::load_installed(&data_dir))
        .await;
    let log = Arc::new(Mutex::new(Log::default()));
    let sink = Arc::new(Sink {
        host: OnceLock::new(),
        manager: OnceLock::new(),
        log: log.clone(),
        deny_children: deny,
    });
    let host = AgentHost::new(sink.clone(), config_dir.clone(), host_store, registry);
    let _ = sink.host.set(Arc::downgrade(&host));

    let events = Arc::new(Mutex::new(Vec::new()));
    let sink_events = events.clone();
    let manager = SubagentManager::new(
        Box::new(host.clone()),
        Arc::new(move |e: &super::model::SubagentEvent| sink_events.lock().push(e.clone())),
    );
    let _ = sink.manager.set(manager.clone());
    // Mirrored children (pi-subagents) are announced straight to the window,
    // not through the host's sink: follow them the same way, and answer
    // their approvals as the stand-in user.
    {
        let sink = sink.clone();
        let weak = Arc::downgrade(&manager);
        manager.set_delta_emitter(Arc::new(move |envelope: SessionDeltaEnvelope| {
            if let SessionDelta::PermissionRequest {
                request_id,
                tool_call,
                ..
            } = &envelope.delta
            {
                let allow = !sink.deny_children;
                let title = tool_call
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("?")
                    .to_string();
                println!(
                    "[e2e] permission on {} (mirrored child): {title} -> {}",
                    envelope.session_id,
                    if allow { "allow" } else { "deny" }
                );
                sink.log
                    .lock()
                    .permissions
                    .entry(envelope.session_id.clone())
                    .or_default()
                    .push((title, if allow { "allowed" } else { "denied" }));
                let request_id = *request_id;
                let weak = weak.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    if let Some(m) = weak.upgrade() {
                        m.resolve_mirror_permission(request_id, allow);
                    }
                });
                return;
            }
            let mut log = sink.log.lock();
            match &envelope.delta {
                SessionDelta::MessageAppended { message } => {
                    let text = log.text.entry(envelope.session_id.clone()).or_default();
                    for call in &message.tool_calls {
                        text.push_str(&format!(
                            "[tool {}] ",
                            call.title.as_deref().unwrap_or(&call.tool_name)
                        ));
                    }
                    text.push_str(&message.content);
                    text.push('\n');
                }
                SessionDelta::TurnFinished { .. } => {
                    *log.finished.entry(envelope.session_id.clone()).or_default() += 1;
                }
                _ => {}
            }
        }));
    }

    let server = Arc::new(SubagentServerHost::new(super::endpoint_file(&config_dir)));
    server.start(manager.clone());
    for _ in 0..50 {
        if server.mcp_url().is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(server.mcp_url().is_some(), "tool server did not start");
    host.set_session_mcp(Arc::new(SubagentSessionOffers::new(server.clone())));
    host.set_session_lifecycle(Arc::new(CompositeLifecycle(vec![server.tokens().clone()])));
    // The pi extension reads the endpoint from the agent's environment, which
    // the host sets from ITS config dir — the same temp dir as here.
    super::pi_extension::install();

    let info = host
        .spawn(&parent_plugin)
        .await
        .expect("parent agent starts");
    let init = host
        .new_session(info.agent_id, project.clone(), Vec::new())
        .await
        .expect("parent session opens");
    let parent: SessionKey = init.key;
    println!("[e2e] parent {parent_plugin} session {}", parent.session_id);
    // The mode the user picked for the parent chat (`ATLAS_E2E_MODE`, e.g.
    // codex's `read-only` = "Ask for approval"); its children inherit it.
    if let Ok(mode) = std::env::var("ATLAS_E2E_MODE") {
        host.set_mode(&parent, mode.clone())
            .await
            .expect("parent mode applies");
        println!("[e2e] parent mode {mode}");
    }

    // `ATLAS_E2E_DELAY_MS`: time for the agent to finish connecting its MCP
    // servers before the prompt, as a person typing would give it.
    if let Some(ms) = std::env::var("ATLAS_E2E_DELAY_MS")
        .ok()
        .and_then(|v| v.parse().ok())
    {
        tokio::time::sleep(Duration::from_millis(ms)).await;
    }
    let file = format!("e2e-{parent_plugin}.txt");
    // `ATLAS_E2E_CMD` swaps in a command that needs an approval (network, a
    // path outside the project) for agents that let a workspace write through.
    let command = std::env::var("ATLAS_E2E_CMD").unwrap_or_else(|_| format!("echo hi > {file}"));
    // `ATLAS_E2E_PI_SUBAGENTS=1`: the pi parent uses pi-subagents' own
    // `subagent` tool instead of Atlas's tools; its child is mirrored.
    let via_pi_subagents = std::env::var("ATLAS_E2E_PI_SUBAGENTS").as_deref() == Ok("1");
    // `ATLAS_E2E_ASYNC=1`: run the pi-subagents child in the background (a
    // detached runner process) and have the parent wait for it with bg_wait.
    let run_async = std::env::var("ATLAS_E2E_ASYNC").as_deref() == Ok("1");
    let prompt = if via_pi_subagents && run_async {
        format!(
            "This is an automated test of the pi-subagents extension. Do NOT use any \
             atlas_agent_* tool. 1) If you do not have the `subagent` tool yet, call \
             `subagents_enable` and then wait for the next step. 2) Call the `subagent` tool \
             with {{\"agent\": \"worker\", \"async\": true, \"task\": \"Run exactly this bash \
             command: {command}  Then reply with the single word: written, or: refused if the \
             command was blocked.\"}}. 3) Call `bg_wait` until that run completes. \
             4) Reply with one line: RESULT: <the subagent's final reply>"
        )
    } else if via_pi_subagents {
        format!(
            "This is an automated test of the pi-subagents extension. Do NOT use any \
             atlas_agent_* tool. 1) If you do not have the `subagent` tool yet, call \
             `subagents_enable` and then wait for the next step. 2) Call the `subagent` tool \
             with {{\"agent\": \"worker\", \"async\": false, \"task\": \"Run exactly this bash \
             command: {command}  Then reply with the single word: written, or: refused if the \
             command was blocked.\"}}. 3) Reply with one line: RESULT: <the subagent's final reply>"
        )
    } else {
        prompt_for(&parent_plugin, child_kind.as_deref(), &command)
    };
    SubagentHost::send(&host, &parent, prompt).expect("prompt sent");

    let deadline = tokio::time::Instant::now() + Duration::from_secs(600);
    loop {
        if log
            .lock()
            .finished
            .get(&parent.session_id)
            .copied()
            .unwrap_or(0)
            > 0
        {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "parent did not finish in time; failures: {:?}",
            log.lock().failures
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    let children = manager.list_all();
    {
        let log = log.lock();
        println!("\n[e2e] ===== summary ({parent_plugin}) =====");
        println!(
            "[e2e] parent said: {}",
            log.text
                .get(&parent.session_id)
                .map(|t| t.trim())
                .unwrap_or("")
        );
        for c in &children {
            println!(
                "[e2e] child {} ({}) status={:?} tools={} denied={} permissions={:?}",
                c.name,
                c.kind,
                c.status,
                c.tool_count,
                c.denied_count,
                log.permissions.get(&c.child_session_id)
            );
            println!(
                "[e2e] child said: {}",
                log.text
                    .get(&c.child_session_id)
                    .map(|t| t.trim())
                    .unwrap_or("")
            );
        }
        println!(
            "[e2e] parent permissions: {:?}",
            log.permissions.get(&parent.session_id)
        );
        println!("[e2e] failures: {:?}", log.failures);
        println!("[e2e] file written: {}", project.join(&file).exists());
        println!("[e2e] events: {}", events.lock().len());

        if let Some(caller) = manager.caller_for_session(&parent.session_id) {
            if let Ok(read) = manager.read(
                &caller,
                "toucher",
                Some(60),
                super::manager::ReadSource::Recent,
            ) {
                println!(
                    "[e2e] child transcript:\n{}",
                    read["text"].as_str().unwrap_or("")
                );
            }
        }
        if via_pi_subagents {
            let child = children
                .iter()
                .find(|c| c.mirror)
                .expect("the pi-subagents child was mirrored");
            println!(
                "[e2e] mirrored transcript:\n{}",
                log.text
                    .get(&child.child_session_id)
                    .map(|t| t.trim())
                    .unwrap_or("")
            );
            assert_eq!(child.parent_session_id, parent.session_id);
            assert!(
                log.permissions.contains_key(&child.child_session_id),
                "the child's approval reached Atlas"
            );
            assert!(
                log.text
                    .get(&parent.session_id)
                    .is_some_and(|t| t.contains("RESULT")),
                "parent reported back"
            );
        } else {
            let child = children
                .iter()
                .find(|c| c.name == "toucher")
                .expect("the parent started `toucher` through the tools");
            assert_eq!(child.parent_session_id, parent.session_id);
            assert!(
                matches!(child.status, SubagentStatus::Done | SubagentStatus::Idle),
                "child settled, got {:?}",
                child.status
            );
            assert!(
                log.text
                    .get(&parent.session_id)
                    .is_some_and(|t| t.contains("RESULT")),
                "parent reported back"
            );
        }
    }
    manager.on_session_dropped(&parent.session_id).await;
    let _ = AgentHost::drop_session(&host, &parent.session_id).await;
    host.shutdown();
}

/// A host over Atlas's real installed agents, whose sink records each
/// session's reply text and finished turns.
async fn real_host() -> (Arc<AgentHost>, Arc<Mutex<Log>>, std::path::PathBuf) {
    let data_dir = dirs::data_dir().unwrap().join("dev.atlas.ide");
    let config_dir = std::env::temp_dir().join(format!("atlas-e2e-{}", uuid::Uuid::new_v4()));
    let project = config_dir.join("project");
    std::fs::create_dir_all(&project).unwrap();
    let http = Arc::new(ReqwestClient::new("atlas-e2e").unwrap());
    let registry = Arc::new(AgentRegistryStore::new(data_dir.clone(), http.clone()));
    let store = Arc::new(AgentServerStore::new(
        data_dir.clone(),
        http.clone(),
        NodeRuntime::managed(&data_dir, http),
        Arc::new(InheritedProjectEnvironment),
        Some(registry.clone()),
    ));
    registry.load_cached().await.expect("cached registry");
    store
        .set_settings(crate::commands::agent_host::load_installed(&data_dir))
        .await;
    let log = Arc::new(Mutex::new(Log::default()));
    let sink = Arc::new(Sink {
        host: OnceLock::new(),
        manager: OnceLock::new(),
        log: log.clone(),
        deny_children: false,
    });
    let host = AgentHost::new(sink.clone(), config_dir, store, registry);
    let _ = sink.host.set(Arc::downgrade(&host));
    (host, log, project)
}

async fn wait_finished(log: &Arc<Mutex<Log>>, session: &str) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(180);
    while log.lock().finished.get(session).copied().unwrap_or(0) == 0 {
        assert!(
            tokio::time::Instant::now() < deadline,
            "{session} never finished"
        );
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

/// pi-acp keeps one live session per process: two chats opened together on
/// one adapter process closed each other's `pi`, and the adapter then crashed
/// on a write to the closed one. Each session now gets a process of its own,
/// and a dead adapter is replaced instead of reused.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "drives the real installed pi-acp; see the module docs"]
async fn two_pi_sessions_open_together_and_a_dead_adapter_is_replaced() {
    let (host, log, project) = real_host().await;
    let info = host.spawn("pi-acp").await.expect("pi-acp starts");
    let (a, b) = tokio::join!(
        host.new_session(info.agent_id, project.clone(), Vec::new()),
        host.new_session(info.agent_id, project.clone(), Vec::new()),
    );
    let (a, b) = (
        a.expect("first session").key,
        b.expect("second session").key,
    );
    println!("[e2e] sessions {} and {}", a.session_id, b.session_id);
    assert_ne!(
        a.agent_id, b.agent_id,
        "each pi session has its own connection"
    );

    for key in [&a, &b] {
        SubagentHost::send(&host, key, "Reply with exactly: OK".into()).expect("sent");
    }
    wait_finished(&log, &a.session_id).await;
    wait_finished(&log, &b.session_id).await;
    let failures = log.lock().failures.clone();
    assert!(failures.is_empty(), "no turn failed: {failures:?}");
    for key in [&a, &b] {
        let text = log
            .lock()
            .text
            .get(&key.session_id)
            .cloned()
            .unwrap_or_default();
        println!("[e2e] {} said: {}", key.session_id, text.trim());
        assert!(text.contains("OK"), "both sessions answered");
    }

    // Kill the first session's adapter out from under it; the next session
    // must start a fresh process instead of failing on the dead one.
    // Only this test's own children: a running Atlas has pi-acp processes too.
    let before = std::process::Command::new("pgrep")
        .args([
            "-P",
            &std::process::id().to_string(),
            "-f",
            "pi-acp/dist/index.js",
        ])
        .output()
        .unwrap();
    let pids: Vec<String> = String::from_utf8_lossy(&before.stdout)
        .split_whitespace()
        .map(str::to_string)
        .collect();
    println!("[e2e] pi-acp processes: {pids:?}");
    assert!(!pids.is_empty(), "found this test's pi-acp processes");
    for pid in &pids {
        let _ = std::process::Command::new("kill").arg(pid).status();
    }
    tokio::time::sleep(Duration::from_secs(2)).await;
    let c = host
        .new_session(info.agent_id, project.clone(), Vec::new())
        .await
        .expect("a session opens after the adapters died")
        .key;
    SubagentHost::send(&host, &c, "Reply with exactly: OK".into()).expect("sent");
    wait_finished(&log, &c.session_id).await;
    let text = log
        .lock()
        .text
        .get(&c.session_id)
        .cloned()
        .unwrap_or_default();
    println!("[e2e] after restart said: {}", text.trim());
    assert!(text.contains("OK"));

    for key in [&a, &b, &c] {
        let _ = AgentHost::drop_session(&host, &key.session_id).await;
    }
    host.shutdown();
}
