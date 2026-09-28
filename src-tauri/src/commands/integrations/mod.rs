//! **Integrations**: pull issues from a tracker (ONES / Jira / a custom HTTP
//! endpoint), hand each one to an agent in a project folder, and commit the
//! result with the issue title as the message (optionally pushing it).
//!
//! - [`sources`]: fetching issues from each tracker.
//! - [`runner`]: the poll loop, one issue at a time, and the delta stage that
//!   tells it when an agent's turn is over.
//!
//! Config lives in `integrations.json`, run history in
//! `integrations-runs.json`, and tracker credentials in
//! `integrations-secrets.json` (mode 0600, the same reasoning as
//! `auth/store.rs` for not using the keychain).

pub mod runner;
pub mod sources;

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

pub use runner::{IntegrationMiddleware, IntegrationsRuntime};

/// The window event every change to an integration or its runs is announced on.
pub const INTEGRATIONS_EVENT: &str = "atlas:integrations:changed";

const CONFIG_FILE: &str = "integrations.json";
const RUNS_FILE: &str = "integrations-runs.json";
const SECRETS_FILE: &str = "integrations-secrets.json";
/// Records kept per integration; older ones are dropped.
const RUNS_KEPT: usize = 100;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Integration {
    pub id: String,
    pub name: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    pub source: Source,
    pub project_id: String,
    pub project_path: String,
    pub agent_id: String,
    /// The agent's model; `None` = the agent's own default.
    #[serde(default)]
    pub model: Option<String>,
    pub interval_minutes: u32,
    pub branch_mode: BranchMode,
    #[serde(default)]
    pub auto_push: bool,
    /// Per-issue agent / model, keyed by issue key.
    #[serde(default)]
    pub issue_overrides: HashMap<String, IssueOverride>,
    /// When it was moved to the Trash (RFC 3339); a trashed integration
    /// never runs until restored.
    #[serde(default)]
    pub deleted_at: Option<String>,
}

impl Integration {
    /// Whether the scheduler runs it.
    pub fn active(&self) -> bool {
        self.enabled && self.deleted_at.is_none()
    }

    /// The agent and model an issue runs with. An override that names an
    /// agent brings its own model (the integration's may not exist on it).
    pub fn agent_for(&self, issue_key: &str) -> (String, Option<String>) {
        let o = self.issue_overrides.get(issue_key);
        match o.and_then(|o| o.agent_id.clone()) {
            Some(agent) => (agent, o.and_then(|o| o.model.clone())),
            None => (
                self.agent_id.clone(),
                o.and_then(|o| o.model.clone())
                    .or_else(|| self.model.clone()),
            ),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueOverride {
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Source {
    Jira {
        base_url: String,
        /// `cloud`: Basic `email:api_token`. `server`: Bearer PAT.
        deployment: JiraDeployment,
        #[serde(default)]
        email: String,
        jql: String,
    },
    Ones {
        base_url: String,
        /// Empty = the first team the login returns.
        #[serde(default)]
        team_uuid: String,
        email: String,
        /// GraphQL `filter` as JSON; `{{me}}` is replaced by the user's uuid.
        filter: String,
        /// GraphQL `orderBy` as JSON, e.g. `{"createTime":"DESC"}`. Empty =
        /// oldest first.
        #[serde(default)]
        order_by: String,
    },
    Custom {
        url: String,
        #[serde(default = "get")]
        method: String,
        /// Header values may contain `{{secret}}`.
        #[serde(default)]
        headers: Vec<(String, String)>,
        #[serde(default)]
        body: String,
        /// Dot paths (`data.items`, `fields.summary`); empty `items_path` =
        /// the response itself is the list.
        #[serde(default)]
        items_path: String,
        id_path: String,
        title_path: String,
        #[serde(default)]
        body_path: String,
        #[serde(default)]
        url_path: String,
        #[serde(default)]
        creator_path: String,
        #[serde(default)]
        created_path: String,
    },
}

fn get() -> String {
    "GET".into()
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum JiraDeployment {
    Cloud,
    Server,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BranchMode {
    Current,
    PerIssue { base: String },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub key: String,
    pub title: String,
    pub body: String,
    pub url: String,
    #[serde(default)]
    pub creator: String,
    /// As the tracker gives it: an ISO string, or epoch seconds / ms / µs.
    #[serde(default)]
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RunStatus {
    /// Asked for by hand (Run / Retry / Continue), waiting behind the run in
    /// progress. `RunRecord::resume` says which.
    Queued,
    Running,
    Done,
    Failed,
    /// Not attempted (dirty worktree): picked up again on the next poll.
    Skipped,
    /// Atlas quit mid-run. Continued by hand, from its session when the
    /// agent can reopen it.
    Interrupted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    pub issue_key: String,
    pub title: String,
    pub status: RunStatus,
    #[serde(default)]
    pub commit: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    /// RFC 3339.
    pub at: String,
    /// The issue as it was run, so a retry does not depend on the tracker
    /// still listing it.
    #[serde(default)]
    pub issue: Issue,
    /// The agent session, set once it opens — what an interrupted run is
    /// continued from.
    #[serde(default)]
    pub session_id: Option<String>,
    /// The connection the session runs on — what the chat needs to show a
    /// run while it is live.
    #[serde(default)]
    pub agent_handle: Option<atlas_agent_wire::AgentId>,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    /// While `Queued`: continue `session_id` rather than start afresh.
    #[serde(default)]
    pub resume: bool,
}

impl RunRecord {
    /// How to run this record's issue now: continue its session when it was
    /// interrupted (or queued to continue), else afresh.
    pub fn mode(&self) -> runner::RunMode {
        if self.status == RunStatus::Interrupted
            || (self.status == RunStatus::Queued && self.resume)
        {
            runner::RunMode::Continue {
                session_id: self.session_id.clone(),
            }
        } else {
            runner::RunMode::Fresh
        }
    }
}

/// What the sidebar shows: the config plus its latest run.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationView {
    #[serde(flatten)]
    pub integration: Integration,
    pub has_secret: bool,
    pub last_run: Option<RunRecord>,
    /// Why the last fetch failed, if it did.
    pub poll_error: Option<String>,
}

// ── Store ──────────────────────────────────────────────────────────────────

pub struct Store {
    dir: PathBuf,
}

impl Store {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    pub fn integrations(&self) -> Vec<Integration> {
        read_json(&self.dir.join(CONFIG_FILE))
    }

    pub fn save_integrations(&self, list: &[Integration]) -> Result<(), String> {
        write_json(&self.dir.join(CONFIG_FILE), &list, false)
    }

    pub fn runs(&self) -> HashMap<String, Vec<RunRecord>> {
        read_json(&self.dir.join(RUNS_FILE))
    }

    /// Replace the record for `rec.issue_key` (a Running record becomes its
    /// outcome) or append it.
    pub fn put_run(&self, integration_id: &str, rec: RunRecord) -> Result<(), String> {
        let mut all = self.runs();
        let list = all.entry(integration_id.to_string()).or_default();
        list.retain(|r| r.issue_key != rec.issue_key);
        list.push(rec);
        if list.len() > RUNS_KEPT {
            let cut = list.len() - RUNS_KEPT;
            list.drain(..cut);
        }
        write_json(&self.dir.join(RUNS_FILE), &all, false)
    }

    pub fn remove_runs(&self, integration_id: &str) -> Result<(), String> {
        let mut all = self.runs();
        if all.remove(integration_id).is_some() {
            write_json(&self.dir.join(RUNS_FILE), &all, false)?;
        }
        Ok(())
    }

    pub fn secrets(&self) -> HashMap<String, String> {
        read_json(&self.dir.join(SECRETS_FILE))
    }

    pub fn set_secret(&self, id: &str, secret: Option<String>) -> Result<(), String> {
        let mut all = self.secrets();
        match secret {
            Some(s) => all.insert(id.to_string(), s),
            None => all.remove(id),
        };
        write_json(&self.dir.join(SECRETS_FILE), &all, true)
    }
}

fn read_json<T: DeserializeOwned + Default>(path: &Path) -> T {
    fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// Temp file + rename; `private` creates it 0600 (see `auth/store.rs::save`).
fn write_json<T: Serialize>(path: &Path, value: &T, private: bool) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("tmp");
    {
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            if private {
                opts.mode(0o600);
            }
        }
        #[cfg(not(unix))]
        let _ = private;
        use std::io::Write;
        opts.open(&tmp)
            .and_then(|mut f| f.write_all(&json))
            .map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

pub(crate) fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

// ── Commands ───────────────────────────────────────────────────────────────

fn views(rt: &IntegrationsRuntime) -> Vec<IntegrationView> {
    let runs = rt.store.runs();
    let secrets = rt.store.secrets();
    let errors = rt.poll_errors.lock().unwrap().clone();
    rt.store
        .integrations()
        .into_iter()
        .map(|integration| {
            let last_run = runs
                .get(&integration.id)
                .and_then(|l| l.iter().max_by(|a, b| a.at.cmp(&b.at)).cloned());
            IntegrationView {
                has_secret: secrets.contains_key(&integration.id),
                poll_error: errors.get(&integration.id).cloned(),
                integration,
                last_run,
            }
        })
        .collect()
}

pub(crate) fn announce(app: &AppHandle) {
    let _ = app.emit(INTEGRATIONS_EVENT, ());
}

#[tauri::command]
pub fn integrations_list(rt: State<'_, Arc<IntegrationsRuntime>>) -> Vec<IntegrationView> {
    views(&rt)
}

/// Create or update. `secret: None` keeps the stored one.
#[tauri::command]
pub fn integrations_save(
    integration: Integration,
    secret: Option<String>,
    rt: State<'_, Arc<IntegrationsRuntime>>,
    app: AppHandle,
) -> Result<(), String> {
    if integration.interval_minutes == 0 {
        return Err("interval must be at least one minute".into());
    }
    let mut list = rt.store.integrations();
    match list.iter_mut().find(|i| i.id == integration.id) {
        Some(existing) => *existing = integration.clone(),
        None => list.push(integration.clone()),
    }
    if let Some(s) = secret.filter(|s| !s.is_empty()) {
        rt.store.set_secret(&integration.id, Some(s))?;
    }
    rt.store.save_integrations(&list)?;
    announce(&app);
    Ok(())
}

/// Copy an integration (config, credential and per-issue settings; not its
/// runs). The copy starts disabled so it cannot develop the same issues as
/// the original before it is edited. Returns the copy's id.
#[tauri::command]
pub fn integrations_duplicate(
    id: String,
    rt: State<'_, Arc<IntegrationsRuntime>>,
    app: AppHandle,
) -> Result<String, String> {
    let mut list = rt.store.integrations();
    let mut copy = list
        .iter()
        .find(|i| i.id == id)
        .cloned()
        .ok_or("no such integration")?;
    copy.id = uuid::Uuid::new_v4().to_string();
    copy.enabled = false;
    copy.deleted_at = None;
    if let Some(secret) = rt.store.secrets().remove(&id) {
        rt.store.set_secret(&copy.id, Some(secret))?;
    }
    let new_id = copy.id.clone();
    list.push(copy);
    rt.store.save_integrations(&list)?;
    announce(&app);
    Ok(new_id)
}

/// Move an integration to the Trash: it stops running, and keeps its
/// config, credential and runs so a restore brings all of it back.
#[tauri::command]
pub fn integrations_delete(
    id: String,
    rt: State<'_, Arc<IntegrationsRuntime>>,
    app: AppHandle,
) -> Result<(), String> {
    set_deleted(&rt, &app, &id, Some(now()))
}

/// Take an integration back out of the Trash.
#[tauri::command]
pub fn integrations_restore(
    id: String,
    rt: State<'_, Arc<IntegrationsRuntime>>,
    app: AppHandle,
) -> Result<(), String> {
    set_deleted(&rt, &app, &id, None)
}

fn set_deleted(
    rt: &IntegrationsRuntime,
    app: &AppHandle,
    id: &str,
    deleted_at: Option<String>,
) -> Result<(), String> {
    let mut list = rt.store.integrations();
    let integration = list
        .iter_mut()
        .find(|i| i.id == id)
        .ok_or("no such integration")?;
    integration.deleted_at = deleted_at;
    rt.store.save_integrations(&list)?;
    announce(app);
    Ok(())
}

/// Delete an integration for good (emptying the Trash): config, credential
/// and runs.
#[tauri::command]
pub fn integrations_purge(
    id: String,
    rt: State<'_, Arc<IntegrationsRuntime>>,
    app: AppHandle,
) -> Result<(), String> {
    let mut list = rt.store.integrations();
    list.retain(|i| i.id != id);
    rt.store.save_integrations(&list)?;
    rt.store.set_secret(&id, None)?;
    rt.store.remove_runs(&id)?;
    announce(&app);
    Ok(())
}

/// Pull once without running anything — the dialog's "Test connection".
/// `secret: None` with an `id` uses the stored one (editing without retyping).
#[tauri::command]
pub async fn integrations_test(
    source: Source,
    secret: Option<String>,
    id: Option<String>,
    rt: State<'_, Arc<IntegrationsRuntime>>,
) -> Result<Vec<Issue>, String> {
    let secret = secret
        .filter(|s| !s.is_empty())
        .or_else(|| id.and_then(|id| rt.store.secrets().remove(&id)))
        .unwrap_or_default();
    let mut issues = sources::fetch_issues(&source, &secret).await?;
    issues.truncate(5);
    Ok(issues)
}

#[tauri::command]
pub fn integrations_run_now(id: String, app: AppHandle) -> Result<(), String> {
    let rt = app.state::<Arc<IntegrationsRuntime>>().inner().clone();
    let integration = rt
        .store
        .integrations()
        .into_iter()
        .find(|i| i.id == id)
        .ok_or("no such integration")?;
    tauri::async_runtime::spawn(async move { rt.poll(&app, &integration).await });
    Ok(())
}

/// The integration's issues as its tracker lists them right now.
#[tauri::command]
pub async fn integrations_issues(
    id: String,
    rt: State<'_, Arc<IntegrationsRuntime>>,
) -> Result<Vec<Issue>, String> {
    let integration = rt
        .store
        .integrations()
        .into_iter()
        .find(|i| i.id == id)
        .ok_or("no such integration")?;
    let secret = rt.store.secrets().remove(&id).unwrap_or_default();
    sources::fetch_issues(&integration.source, &secret).await
}

/// Run one issue now: continue it (in its own session) when its last run was
/// interrupted, otherwise start it afresh (a retry, or a queued issue ahead
/// of its turn).
#[tauri::command]
pub async fn integrations_rerun(
    id: String,
    issue_key: String,
    app: AppHandle,
) -> Result<(), String> {
    let rt = app.state::<Arc<IntegrationsRuntime>>().inner().clone();
    let integration = rt
        .store
        .integrations()
        .into_iter()
        .find(|i| i.id == id)
        .ok_or("no such integration")?;
    let last = rt
        .store
        .runs()
        .remove(&id)
        .unwrap_or_default()
        .into_iter()
        .find(|r| r.issue_key == issue_key);
    if last
        .as_ref()
        .is_some_and(|r| matches!(r.status, RunStatus::Running | RunStatus::Queued))
    {
        return Err("this issue is already queued or running".into());
    }
    let issue = match last.as_ref().filter(|r| !r.issue.key.is_empty()) {
        Some(r) => r.issue.clone(),
        // Queued, or recorded before runs kept their issue: ask the tracker.
        None => {
            let secret = rt.store.secrets().remove(&id).unwrap_or_default();
            sources::fetch_issues(&integration.source, &secret)
                .await?
                .into_iter()
                .find(|i| i.key == issue_key)
                .ok_or("the tracker no longer lists this issue")?
        }
    };
    let resume = last
        .as_ref()
        .is_some_and(|r| r.status == RunStatus::Interrupted);
    // Shown as Queued until the run in progress (if any) lets it start; kept
    // on disk so a quit before then still runs it at the next launch.
    let queued = RunRecord {
        issue_key: issue.key.clone(),
        title: issue.title.clone(),
        status: RunStatus::Queued,
        commit: None,
        error: None,
        at: now(),
        issue: issue.clone(),
        session_id: last.as_ref().and_then(|r| r.session_id.clone()),
        agent_handle: None,
        agent_id: last.as_ref().and_then(|r| r.agent_id.clone()),
        model: last.as_ref().and_then(|r| r.model.clone()),
        resume,
    };
    let mode = queued.mode();
    rt.store.put_run(&id, queued)?;
    announce(&app);
    tauri::async_runtime::spawn(async move { rt.run_one(&app, &id, issue, mode).await });
    Ok(())
}

#[tauri::command]
pub fn integrations_runs(id: String, rt: State<'_, Arc<IntegrationsRuntime>>) -> Vec<RunRecord> {
    rt.store.runs().remove(&id).unwrap_or_default()
}

/// Manage the runtime and start the poll loop. Called from `setup`, after
/// the agent host is installed.
pub fn install(app: &AppHandle) {
    let dir = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    let store = Store::new(dir);
    // A run the app quit in the middle of never finishes: mark it
    // interrupted (continuable), rather than running forever. Records from
    // before the Interrupted status said so in their error.
    let mut runs = store.runs();
    let mut interrupted = false;
    for r in runs.values_mut().flatten() {
        let old_style = r.status == RunStatus::Failed
            && r.error
                .as_deref()
                .is_some_and(|e| e.starts_with("interrupted"));
        if r.status == RunStatus::Running || old_style {
            r.status = RunStatus::Interrupted;
            r.error = Some("Atlas quit during the run".into());
            interrupted = true;
        }
    }
    if interrupted {
        let _ = write_json(&store.dir.join(RUNS_FILE), &runs, false);
    }
    let rt = Arc::new(IntegrationsRuntime::new(store));
    app.manage(rt.clone());
    rt.start(app.clone());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queued_records_remember_continue_vs_fresh() {
        let rec = |status, resume| RunRecord {
            issue_key: "K".into(),
            title: "t".into(),
            status,
            commit: None,
            error: None,
            at: now(),
            issue: Issue::default(),
            session_id: Some("s".into()),
            agent_handle: None,
            agent_id: None,
            model: None,
            resume,
        };
        let continues = |r: RunRecord| matches!(r.mode(), runner::RunMode::Continue { .. });
        assert!(continues(rec(RunStatus::Interrupted, false)));
        assert!(continues(rec(RunStatus::Queued, true)));
        // A queued retry of a failed run starts over, session or not.
        assert!(!continues(rec(RunStatus::Queued, false)));
        assert!(!continues(rec(RunStatus::Failed, false)));
    }

    #[test]
    fn issue_overrides_pick_agent_and_model() {
        let mut i: Integration = serde_json::from_value(serde_json::json!({
            "id": "a", "name": "A",
            "source": { "kind": "custom", "url": "u", "idPath": "id", "titlePath": "t" },
            "projectId": "p", "projectPath": "/p", "agentId": "codex-acp", "model": "gpt-5",
            "intervalMinutes": 5, "branchMode": { "kind": "current" },
        }))
        .unwrap();
        let o = |agent: Option<&str>, model: Option<&str>| IssueOverride {
            agent_id: agent.map(Into::into),
            model: model.map(Into::into),
        };
        assert_eq!(i.agent_for("X"), ("codex-acp".into(), Some("gpt-5".into())));
        i.issue_overrides
            .insert("M".into(), o(None, Some("gpt-5-mini")));
        assert_eq!(
            i.agent_for("M"),
            ("codex-acp".into(), Some("gpt-5-mini".into()))
        );
        // Another agent: the integration's model is not carried over.
        i.issue_overrides
            .insert("A".into(), o(Some("claude-code-ts"), None));
        assert_eq!(i.agent_for("A"), ("claude-code-ts".into(), None));
    }

    #[test]
    fn store_round_trip_and_run_replacement() {
        let dir = std::env::temp_dir().join(format!("atlas-int-{}", uuid::Uuid::new_v4()));
        let store = Store::new(dir.clone());
        let i = Integration {
            id: "a".into(),
            name: "A".into(),
            enabled: true,
            source: Source::Jira {
                base_url: "https://x.atlassian.net".into(),
                deployment: JiraDeployment::Cloud,
                email: "e@x".into(),
                jql: "project = X".into(),
            },
            project_id: "p".into(),
            project_path: "/tmp/p".into(),
            agent_id: "atlas-agent".into(),
            interval_minutes: 15,
            branch_mode: BranchMode::PerIssue {
                base: "main".into(),
            },
            auto_push: true,
            model: None,
            issue_overrides: HashMap::new(),
            deleted_at: None,
        };
        store.save_integrations(&[i]).unwrap();
        assert_eq!(
            store.integrations()[0].branch_mode,
            BranchMode::PerIssue {
                base: "main".into()
            }
        );

        let rec = |status| RunRecord {
            issue_key: "X-1".into(),
            title: "t".into(),
            status,
            commit: None,
            error: None,
            at: now(),
            issue: Issue::default(),
            session_id: None,
            agent_handle: None,
            agent_id: None,
            model: None,
            resume: false,
        };
        store.put_run("a", rec(RunStatus::Running)).unwrap();
        store.put_run("a", rec(RunStatus::Done)).unwrap();
        let runs = store.runs();
        assert_eq!(runs["a"].len(), 1);
        assert_eq!(runs["a"][0].status, RunStatus::Done);

        store.set_secret("a", Some("tok".into())).unwrap();
        assert_eq!(store.secrets()["a"], "tok");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(dir.join(SECRETS_FILE))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let _ = fs::remove_dir_all(dir);
    }
}
