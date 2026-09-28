//! The poll loop and one issue's run: branch → agent session → commit → push.
//!
//! Issues run one at a time across all integrations (`run_lock`): two agents
//! editing the same checkout at once would commit each other's work.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use agent_client_protocol::schema::v1 as acp;
use atlas_agent_wire::{SessionDelta, SessionDeltaEnvelope, SessionStatus};
use atlas_bus::OutboundMiddleware;
use atlas_git::GitCommand;
use serde_json::Value;
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;

use super::{announce, now, sources, BranchMode, Integration, Issue, RunRecord, RunStatus, Store};
use crate::commands::agent_host::{AgentHost, PermissionDecision};
use crate::commands::subagents::manager::SubagentHost;

/// How often the loop checks whether an integration is due.
const TICK: Duration = Duration::from_secs(60);
/// The longest one issue's turn may take before it is cancelled.
const TURN_TIMEOUT: Duration = Duration::from_secs(60 * 60);

type Waiter = oneshot::Sender<Result<(), String>>;

pub struct IntegrationsRuntime {
    pub store: Store,
    run_lock: tokio::sync::Mutex<()>,
    /// Sessions this module started, keyed by session id, resolved when the
    /// turn ends.
    waiters: Mutex<HashMap<String, Waiter>>,
    last_poll: Mutex<HashMap<String, Instant>>,
    /// Integrations with a poll queued or running, so a slow run does not
    /// pile up polls behind it.
    in_flight: Mutex<HashSet<String>>,
    /// The last fetch failure per integration, cleared by a good fetch.
    pub poll_errors: Mutex<HashMap<String, String>>,
}

impl IntegrationsRuntime {
    pub fn new(store: Store) -> Self {
        Self {
            store,
            run_lock: Default::default(),
            waiters: Default::default(),
            last_poll: Default::default(),
            in_flight: Default::default(),
            poll_errors: Default::default(),
        }
    }

    pub fn start(self: &Arc<Self>, app: AppHandle) {
        let rt = self.clone();
        tauri::async_runtime::spawn(async move {
            let mut ticker = tokio::time::interval(TICK);
            loop {
                ticker.tick().await;
                for integration in rt.store.integrations().into_iter().filter(|i| i.enabled) {
                    let due = {
                        let mut last = rt.last_poll.lock().unwrap();
                        let every =
                            Duration::from_secs(u64::from(integration.interval_minutes) * 60);
                        // First sight counts as a poll: launching the app
                        // does not start work before the interval passes.
                        let at = *last
                            .entry(integration.id.clone())
                            .or_insert_with(Instant::now);
                        at.elapsed() >= every
                    };
                    if due {
                        let (rt, app) = (rt.clone(), app.clone());
                        tauri::async_runtime::spawn(
                            async move { rt.poll(&app, &integration).await },
                        );
                    }
                }
            }
        });
    }

    fn tracks(&self, session_id: &str) -> bool {
        self.waiters.lock().unwrap().contains_key(session_id)
    }

    fn settle(&self, session_id: &str, outcome: Result<(), String>) {
        if let Some(tx) = self.waiters.lock().unwrap().remove(session_id) {
            let _ = tx.send(outcome);
        }
    }

    /// Fetch and run every issue not seen before, one after another.
    pub async fn poll(&self, app: &AppHandle, integration: &Integration) {
        if !self
            .in_flight
            .lock()
            .unwrap()
            .insert(integration.id.clone())
        {
            return;
        }
        let _guard = self.run_lock.lock().await;
        self.last_poll
            .lock()
            .unwrap()
            .insert(integration.id.clone(), Instant::now());

        let secret = self
            .store
            .secrets()
            .remove(&integration.id)
            .unwrap_or_default();
        match sources::fetch_issues(&integration.source, &secret).await {
            Err(e) => {
                tracing::warn!(target: "atlas::integrations", id = %integration.id, "fetch failed: {e}");
                self.poll_errors
                    .lock()
                    .unwrap()
                    .insert(integration.id.clone(), e);
                announce(app);
            }
            Ok(issues) => {
                if self
                    .poll_errors
                    .lock()
                    .unwrap()
                    .remove(&integration.id)
                    .is_some()
                {
                    announce(app);
                }
                for issue in issues {
                    // Re-read between issues: a delete or disable while a
                    // batch is running stops it after the current one.
                    let Some(current) = self
                        .store
                        .integrations()
                        .into_iter()
                        .find(|i| i.id == integration.id && i.enabled)
                    else {
                        break;
                    };
                    let seen = self.store.runs().remove(&current.id).unwrap_or_default();
                    if seen
                        .iter()
                        .any(|r| r.issue_key == issue.key && r.status != RunStatus::Skipped)
                    {
                        continue;
                    }
                    let rec = self.run_issue(app, &current, &issue, RunMode::Fresh).await;
                    let _ = self.store.put_run(&current.id, rec);
                    announce(app);
                }
            }
        }
        self.in_flight.lock().unwrap().remove(&integration.id);
    }

    /// Run one issue by hand (the tab's Retry / Continue / Run), queued
    /// behind whatever is running.
    pub async fn run_one(
        &self,
        app: &AppHandle,
        integration_id: &str,
        issue: Issue,
        mode: RunMode,
    ) {
        let _guard = self.run_lock.lock().await;
        // Re-read: overrides may have changed while this waited.
        let Some(integration) = self
            .store
            .integrations()
            .into_iter()
            .find(|i| i.id == integration_id)
        else {
            return;
        };
        let rec = self.run_issue(app, &integration, &issue, mode).await;
        let _ = self.store.put_run(&integration.id, rec);
        announce(app);
    }

    async fn run_issue(
        &self,
        app: &AppHandle,
        integration: &Integration,
        issue: &Issue,
        mode: RunMode,
    ) -> RunRecord {
        let (agent_id, model) = integration.agent_for(&issue.key);
        let mut rec = RunRecord {
            issue_key: issue.key.clone(),
            title: issue.title.clone(),
            status: RunStatus::Running,
            commit: None,
            error: None,
            at: now(),
            issue: issue.clone(),
            session_id: None,
            agent_id: Some(agent_id.clone()),
            model: model.clone(),
        };
        let cwd = integration.project_path.as_str();

        let resume = match mode {
            RunMode::Fresh => {
                match git(cwd, &["status", "--porcelain"]) {
                    Ok(out) if !out.trim().is_empty() => {
                        return outcome(
                            &rec,
                            RunStatus::Skipped,
                            None,
                            Some("working tree has uncommitted changes".into()),
                        )
                    }
                    Err(e) => return outcome(&rec, RunStatus::Failed, None, Some(e)),
                    Ok(_) => {}
                }
                if let BranchMode::PerIssue { base } = &integration.branch_mode {
                    let branch = branch_name(&issue.key);
                    let mut args = vec!["checkout", "-B", branch.as_str()];
                    if !base.trim().is_empty() {
                        args.push(base.trim());
                    }
                    if let Err(e) = git(cwd, &args) {
                        return outcome(&rec, RunStatus::Failed, None, Some(e));
                    }
                }
                None
            }
            // The interrupted run's changes are still in the tree: keep them,
            // on the issue's own branch.
            RunMode::Continue { session_id } => {
                if let BranchMode::PerIssue { .. } = &integration.branch_mode {
                    let branch = branch_name(&issue.key);
                    let head = git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default();
                    if head.trim() != branch {
                        if let Err(e) = git(cwd, &["checkout", branch.as_str()]) {
                            return outcome(&rec, RunStatus::Failed, None, Some(e));
                        }
                    }
                }
                Some(session_id)
            }
        };

        let _ = self.store.put_run(&integration.id, rec.clone());
        announce(app);

        if let Err(e) = self
            .develop(
                app,
                integration,
                &mut rec,
                &agent_id,
                model.as_deref(),
                resume,
            )
            .await
        {
            return outcome(&rec, RunStatus::Failed, None, Some(e));
        }

        match git(cwd, &["status", "--porcelain"]) {
            Ok(out) if out.trim().is_empty() => {
                return outcome(
                    &rec,
                    RunStatus::Failed,
                    None,
                    Some("the agent made no changes".into()),
                )
            }
            Err(e) => return outcome(&rec, RunStatus::Failed, None, Some(e)),
            Ok(_) => {}
        }
        let message = if issue.title.trim().is_empty() {
            issue.key.as_str()
        } else {
            issue.title.trim()
        };
        let commit = git(cwd, &["add", "-A"])
            .and_then(|_| git(cwd, &["commit", "-m", message]))
            .and_then(|_| git(cwd, &["rev-parse", "HEAD"]));
        let commit = match commit {
            Ok(hash) => hash.trim().to_string(),
            Err(e) => return outcome(&rec, RunStatus::Failed, None, Some(e)),
        };

        if integration.auto_push {
            let has_upstream = git(cwd, &["rev-parse", "--abbrev-ref", "@{u}"]).is_ok();
            let pushed = if has_upstream {
                git(cwd, &["push"])
            } else {
                git(cwd, &["push", "-u", "origin", "HEAD"])
            };
            if let Err(e) = pushed {
                return outcome(
                    &rec,
                    RunStatus::Failed,
                    Some(commit),
                    Some(format!("committed, but push failed: {e}")),
                );
            }
        }
        outcome(&rec, RunStatus::Done, Some(commit), None)
    }

    /// One agent session, one turn, then the session is closed. `resume`
    /// (`Some`) continues an interrupted run: from its session when the agent
    /// can reopen it, else in a new session told to pick up the tree as is.
    async fn develop(
        &self,
        app: &AppHandle,
        integration: &Integration,
        rec: &mut RunRecord,
        agent_id: &str,
        model: Option<&str>,
        resume: Option<Option<String>>,
    ) -> Result<(), String> {
        let host = app.state::<Arc<AgentHost>>().inner().clone();
        let cwd = integration.project_path.clone();
        let reopened = match resume.clone().flatten() {
            Some(session_id) => {
                match SubagentHost::reopen_session(
                    &host,
                    agent_id.to_string(),
                    session_id,
                    cwd.clone(),
                )
                .await
                {
                    Ok(key) => Some(key),
                    Err(e) => {
                        tracing::warn!(target: "atlas::integrations", "session not reopened, starting anew: {e}");
                        None
                    }
                }
            }
            None => None,
        };
        let key = match reopened {
            Some(key) => key,
            None => SubagentHost::start_session(&host, agent_id.to_string(), cwd, None).await?,
        };
        if let Some(model) = model {
            if let Err(e) = host.set_model(&key, model.to_string()).await {
                let _ = SubagentHost::drop_session(&host, key.session_id).await;
                return Err(format!("model {model} could not be selected: {e}"));
            }
        }
        // Recorded now, so a quit from here on can be continued.
        rec.session_id = Some(key.session_id.clone());
        let _ = self.store.put_run(&integration.id, rec.clone());

        let (tx, rx) = oneshot::channel();
        self.waiters
            .lock()
            .unwrap()
            .insert(key.session_id.clone(), tx);

        let text = if resume.is_some() {
            continue_prompt(&rec.issue)
        } else {
            prompt(&rec.issue)
        };
        // Explicit paths: `SubagentHost` has a `send`/`cancel` of its own.
        let content = vec![acp::ContentBlock::Text(acp::TextContent::new(text))];
        let result = match AgentHost::send(&host, &key, content) {
            Err(e) => Err(e.to_string()),
            Ok(()) => match tokio::time::timeout(TURN_TIMEOUT, rx).await {
                Ok(Ok(result)) => result,
                Ok(Err(_)) => Err("the session went away".into()),
                Err(_) => {
                    let _ = AgentHost::cancel(&host, &key);
                    Err("timed out".into())
                }
            },
        };
        self.waiters.lock().unwrap().remove(&key.session_id);
        let _ = SubagentHost::drop_session(&host, key.session_id).await;
        result
    }
}

/// How a run starts.
pub enum RunMode {
    /// A new session on a clean working tree.
    Fresh,
    /// Pick up an interrupted run where it stopped.
    Continue { session_id: Option<String> },
}

/// `rec` settled as `status`, stamped now.
fn outcome(
    rec: &RunRecord,
    status: RunStatus,
    commit: Option<String>,
    error: Option<String>,
) -> RunRecord {
    RunRecord {
        status,
        commit,
        error,
        at: now(),
        ..rec.clone()
    }
}

fn continue_prompt(issue: &Issue) -> String {
    format!(
        "Your previous run on this issue was interrupted before it finished. The working tree still has the changes made so far — review them and finish the work. Do not run git commit.\n\n{}",
        prompt(issue)
    )
}

fn prompt(issue: &Issue) -> String {
    let mut p = format!(
        "Implement the following issue in this repository. Make the code changes only; do not run git commit — it is committed for you afterwards.\n\n[{}] {}",
        issue.key, issue.title
    );
    if !issue.body.trim().is_empty() {
        p.push_str("\n\n");
        p.push_str(issue.body.trim());
    }
    if !issue.url.is_empty() {
        p.push_str("\n\n");
        p.push_str(&issue.url);
    }
    p
}

/// `atlas/<key>` with anything git would reject in a ref replaced by `-`.
fn branch_name(key: &str) -> String {
    let slug: String = key
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    format!("atlas/{}", slug.trim_matches('-'))
}

fn git(cwd: &str, args: &[&str]) -> Result<String, String> {
    GitCommand::new(cwd, args)
        .run()
        .map(|o| o.stdout)
        .map_err(|e| e.to_string())
}

/// Resolves a run's wait when its turn ends, and approves its permission
/// requests: nobody is watching an integration session to answer them.
///
/// A delta-sink stage, not a bus subscriber, for the same reason as
/// `SubagentMiddleware`: the bus drops events for a lagging subscriber.
pub struct IntegrationMiddleware {
    pub app: AppHandle,
}

impl OutboundMiddleware<SessionDeltaEnvelope> for IntegrationMiddleware {
    fn on_event(&self, envelope: &SessionDeltaEnvelope) {
        let Some(rt) = self.app.try_state::<Arc<IntegrationsRuntime>>() else {
            return;
        };
        if !rt.tracks(&envelope.session_id) {
            return;
        }
        let sid = envelope.session_id.as_str();
        match &envelope.delta {
            SessionDelta::TurnFinished { .. } => rt.settle(sid, Ok(())),
            SessionDelta::TurnFailed { error, .. } => rt.settle(sid, Err(error.clone())),
            SessionDelta::Status {
                status: SessionStatus::Error,
                ..
            } => rt.settle(sid, Err("the agent reported an error".into())),
            SessionDelta::PermissionRequest {
                request_id,
                options,
                ..
            } => {
                let Some(option_id) = allow_option(options) else {
                    return;
                };
                let (app, sid, request_id) = (self.app.clone(), sid.to_string(), *request_id);
                // Off the sink: answering re-enters the host.
                tauri::async_runtime::spawn(async move {
                    let host = app.state::<Arc<AgentHost>>();
                    if let Err(e) = host.respond_permission(
                        &sid,
                        request_id,
                        PermissionDecision::Selected { option_id },
                    ) {
                        tracing::warn!(target: "atlas::integrations", "auto-approve failed: {e}");
                    }
                });
            }
            _ => {}
        }
    }
}

/// The option to pick when approving: allow once, else allow always.
fn allow_option(options: &Value) -> Option<String> {
    let opts = options.as_array()?;
    ["allow_once", "allow_always"]
        .iter()
        .find_map(|kind| {
            opts.iter()
                .find(|o| o.get("kind").and_then(Value::as_str) == Some(kind))
        })
        .and_then(|o| o.get("optionId").and_then(Value::as_str))
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn branch_names() {
        assert_eq!(branch_name("PROJ-12"), "atlas/PROJ-12");
        assert_eq!(branch_name("#42"), "atlas/42");
        assert_eq!(branch_name("a b/c"), "atlas/a-b-c");
    }

    #[test]
    fn picks_allow_option() {
        let opts = json!([
            { "optionId": "no", "kind": "reject_once" },
            { "optionId": "always", "kind": "allow_always" },
            { "optionId": "once", "kind": "allow_once" },
        ]);
        assert_eq!(allow_option(&opts).as_deref(), Some("once"));
        assert_eq!(
            allow_option(&json!([{ "optionId": "no", "kind": "reject_once" }])),
            None
        );
    }
}
