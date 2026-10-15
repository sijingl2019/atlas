//! Scheduled tasks: a prompt Atlas sends to an agent on a schedule.
//!
//! Atlas owns the scheduler for every agent. None of them exposes one a host
//! can drive: Codex's local automations live inside its closed desktop app,
//! and Claude Code's routines run in the cloud on a fresh clone. The model
//! follows Codex's: a wall-clock schedule, one agent session per run (or the
//! previous run's session, reopened), and a banner on failure.
//!
//! Tasks persist as one JSON file in the config dir. A [`TICK`] timer starts
//! every enabled task whose `next_run_at` has passed; a run missed while the
//! app was closed or asleep fires once on the next tick, never once per miss.
//!
//! A run is one unattended turn, run the way integrations run theirs
//! ([`IntegrationsRuntime::await_turn`]): nobody watches the session, so its
//! permission requests are approved, and the run is `done` or `failed` when
//! the turn ends.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Datelike, Days, Local, LocalResult, NaiveTime, TimeZone, Timelike, Utc};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use super::agent_host::{AgentHost, SessionKey};
use super::integrations::IntegrationsRuntime;

/// Fired after any change to the task list; the payload is empty.
pub const CHANGED_EVENT: &str = "atlas:scheduled-tasks";

/// Timer granularity. A due task starts at most this late.
const TICK: Duration = Duration::from_secs(30);

const FILE_NAME: &str = "scheduled_tasks.json";

/// Shortest interval a task may repeat at.
const MIN_INTERVAL_MINUTES: u32 = 5;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Schedule {
    /// Every `minutes`, counted from the last run (or from saving).
    Interval {
        minutes: u32,
    },
    Daily {
        time: String,
    },
    Weekdays {
        time: String,
    },
    /// `days`: 0 = Sunday … 6 = Saturday, as JS `Date.getDay()`.
    Weekly {
        days: Vec<u8>,
        time: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NotifyPolicy {
    All,
    #[default]
    Failures,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RunStatus {
    Running,
    Done,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    /// Epoch ms.
    pub at: i64,
    pub status: RunStatus,
    #[serde(default)]
    pub session_id: Option<String>,
    /// The agent process's handle while the run is live, so the chat can
    /// adopt the session mid-turn.
    #[serde(default)]
    pub agent_handle: Option<atlas_agent_wire::AgentId>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTask {
    /// Empty on a task the frontend is creating; `scheduled_tasks_save` fills it.
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub prompt: String,
    pub plugin_id: String,
    pub project_path: String,
    pub schedule: Schedule,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub notify: NotifyPolicy,
    #[serde(default)]
    pub new_chat_each_run: bool,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default)]
    pub created_at: i64,
    /// Epoch ms; `None` while paused.
    #[serde(default)]
    pub next_run_at: Option<i64>,
    #[serde(default)]
    pub last_run: Option<RunRecord>,
    /// The session the previous run used, reopened when `new_chat_each_run`
    /// is off.
    #[serde(default)]
    pub last_session_id: Option<String>,
}

fn yes() -> bool {
    true
}

fn parse_time(time: &str) -> Option<NaiveTime> {
    NaiveTime::parse_from_str(time, "%H:%M").ok()
}

/// The first run of `schedule` strictly after `after`, in `after`'s zone.
/// `None` only for a schedule that can never fire (bad time, no days).
pub fn next_run<Tz: TimeZone>(schedule: &Schedule, after: &DateTime<Tz>) -> Option<DateTime<Tz>> {
    let (time, allowed): (&str, Box<dyn Fn(u32) -> bool>) = match schedule {
        Schedule::Interval { minutes } => {
            let next = after.clone()
                + chrono::Duration::minutes(i64::from((*minutes).max(MIN_INTERVAL_MINUTES)));
            return next.with_second(0)?.with_nanosecond(0);
        }
        Schedule::Daily { time } => (time, Box::new(|_| true)),
        Schedule::Weekdays { time } => (time, Box::new(|d| (1..=5).contains(&d))),
        Schedule::Weekly { days, time } => {
            let days = days.clone();
            (
                time,
                Box::new(move |d| days.iter().any(|x| u32::from(*x) == d)),
            )
        }
    };
    let time = parse_time(time)?;
    let tz = after.timezone();
    let today = after.date_naive();
    for offset in 0..=7 {
        let date = today.checked_add_days(Days::new(offset))?;
        if !allowed(date.weekday().num_days_from_sunday()) {
            continue;
        }
        let naive = date.and_time(time);
        let at = match tz.from_local_datetime(&naive) {
            LocalResult::Single(t) | LocalResult::Ambiguous(t, _) => t,
            // A DST gap swallowed this minute: run an hour later instead.
            LocalResult::None => tz
                .from_local_datetime(&(naive + chrono::Duration::hours(1)))
                .earliest()?,
        };
        if at > *after {
            return Some(at);
        }
    }
    None
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

fn next_run_ms(schedule: &Schedule, after_ms: i64) -> Option<i64> {
    let after = Local.timestamp_millis_opt(after_ms).single()?;
    next_run(schedule, &after).map(|t| t.timestamp_millis())
}

pub struct ScheduledTasksState {
    path: PathBuf,
    tasks: Mutex<Vec<ScheduledTask>>,
    /// Ids with a run in flight, so a slow spawn never starts a second run.
    running: Mutex<HashSet<String>>,
}

impl ScheduledTasksState {
    pub fn load(config_dir: PathBuf) -> Self {
        let path = config_dir.join(FILE_NAME);
        let mut tasks: Vec<ScheduledTask> = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| match serde_json::from_str(&s) {
                Ok(tasks) => Some(tasks),
                Err(e) => {
                    tracing::warn!("{} unreadable, starting empty: {e}", path.display());
                    None
                }
            })
            .unwrap_or_default();
        // A run still `running` was cut off when Atlas last closed.
        for run in tasks.iter_mut().filter_map(|t| t.last_run.as_mut()) {
            if run.status == RunStatus::Running {
                run.status = RunStatus::Failed;
                run.agent_handle = None;
                run.error = Some("Atlas closed during the run".into());
            }
        }
        Self {
            path,
            tasks: Mutex::new(tasks),
            running: Mutex::new(HashSet::new()),
        }
    }

    fn persist(&self, tasks: &[ScheduledTask]) {
        let write = || -> std::io::Result<()> {
            if let Some(dir) = self.path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            let tmp = self.path.with_extension("json.tmp");
            std::fs::write(&tmp, serde_json::to_vec_pretty(tasks)?)?;
            std::fs::rename(&tmp, &self.path)
        };
        if let Err(e) = write() {
            tracing::warn!("saving {} failed: {e}", self.path.display());
        }
    }

    /// Apply `f` to the task list, persist it, and return what `f` returned.
    fn update<R>(&self, f: impl FnOnce(&mut Vec<ScheduledTask>) -> R) -> R {
        let mut tasks = self.tasks.lock();
        let out = f(&mut tasks);
        self.persist(&tasks);
        out
    }

    fn try_claim(&self, id: &str) -> bool {
        self.running.lock().insert(id.to_string())
    }

    fn release(&self, id: &str) {
        self.running.lock().remove(id);
    }

    /// Claim every enabled task due at `now` and move its `next_run_at` past
    /// `now`, so a run missed many times over fires once.
    fn claim_due(&self, now: i64) -> Vec<ScheduledTask> {
        self.update(|tasks| {
            let mut due = Vec::new();
            for task in tasks.iter_mut() {
                let is_due = task.enabled && task.next_run_at.is_some_and(|t| t <= now);
                if is_due && self.try_claim(&task.id) {
                    task.next_run_at = next_run_ms(&task.schedule, now);
                    due.push(task.clone());
                }
            }
            due
        })
    }
}

fn emit_changed(app: &AppHandle) {
    let _ = app.emit(CHANGED_EVENT, ());
}

/// Start the timer. Once, from `setup`, after the agent host is managed.
pub fn start(app: &AppHandle) {
    let _ = APP.set(app.clone());
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(TICK);
        loop {
            ticker.tick().await;
            let due = app.state::<ScheduledTasksState>().claim_due(now_ms());
            if !due.is_empty() {
                emit_changed(&app);
            }
            for task in due {
                spawn_run(app.clone(), task);
            }
        }
    });
}

/// Record `record` as `id`'s last run (and its session as the one to reopen).
fn record_run(app: &AppHandle, id: &str, record: RunRecord) {
    app.state::<ScheduledTasksState>().update(|tasks| {
        if let Some(t) = tasks.iter_mut().find(|t| t.id == id) {
            if record.session_id.is_some() {
                t.last_session_id = record.session_id.clone();
            }
            t.last_run = Some(record);
        }
    });
    emit_changed(app);
}

/// Run `task` in the background. The caller holds its claim; this releases it.
fn spawn_run(app: AppHandle, task: ScheduledTask) {
    tauri::async_runtime::spawn(async move {
        let started = now_ms();
        let (session_id, result) = match open(&app, &task).await {
            Err(e) => (None, Err(e)),
            Ok((host, key)) => {
                let session_id = Some(key.session_id.clone());
                record_run(
                    &app,
                    &task.id,
                    RunRecord {
                        at: started,
                        status: RunStatus::Running,
                        session_id: session_id.clone(),
                        agent_handle: Some(key.agent_id),
                        error: None,
                    },
                );
                let result = turn(&app, &host, &key, &task).await;
                // Closed like an integration run's; the chat reopens it from
                // history, and the next run reloads it. Off the run's path:
                // `session/close` waits on the agent with no timeout.
                tauri::async_runtime::spawn(async move {
                    let _ = host.drop_session(&key.session_id).await;
                });
                (session_id, result)
            }
        };
        app.state::<ScheduledTasksState>().release(&task.id);
        if let Err(e) = &result {
            tracing::warn!(task = %task.id, "scheduled run failed: {e}");
        }
        record_run(
            &app,
            &task.id,
            RunRecord {
                at: started,
                status: if result.is_ok() {
                    RunStatus::Done
                } else {
                    RunStatus::Failed
                },
                session_id,
                agent_handle: None,
                error: result.as_ref().err().cloned(),
            },
        );
        notify(&app, &task, &result);
    });
}

/// Spawn the agent, open (or reopen) the session, and apply model and effort.
async fn open(
    app: &AppHandle,
    task: &ScheduledTask,
) -> Result<(Arc<AgentHost>, SessionKey), String> {
    let host = app
        .try_state::<Arc<AgentHost>>()
        .ok_or("agents are not ready yet")?
        .inner()
        .clone();
    let cwd = PathBuf::from(&task.project_path);
    if !cwd.is_dir() {
        return Err(format!("project folder not found: {}", task.project_path));
    }
    let info = host
        .spawn(&task.plugin_id)
        .await
        .map_err(|e| e.to_string())?;

    let reopened = match (&task.last_session_id, task.new_chat_each_run) {
        (Some(sid), false) => host
            .load_session(info.agent_id, sid.clone(), cwd.clone())
            .await
            .inspect_err(|e| tracing::info!("reopening {sid} failed, starting a new chat: {e}"))
            .ok(),
        _ => None,
    };
    let key = match reopened {
        Some(key) => key,
        None => {
            host.new_session(info.agent_id, cwd, Vec::new())
                .await
                .map_err(|e| e.to_string())?
                .key
        }
    };

    if let Some(model) = task.model.clone().filter(|m| !m.is_empty()) {
        if let Err(e) = host.set_model(&key, model).await {
            tracing::warn!("scheduled run: set_model failed: {e}");
        }
    }
    if let Some(effort) = task.effort.clone().filter(|e| !e.is_empty()) {
        if let Err(e) = host.set_effort(&key, effort) {
            tracing::warn!("scheduled run: set_effort failed: {e}");
        }
    }
    Ok((host, key))
}

/// The integrations runner's unattended turn: permission requests are
/// approved, and this returns when the turn ends. The prompt goes through
/// `agents_send`, the composer's path, so the chat records it.
async fn turn(
    app: &AppHandle,
    host: &AgentHost,
    key: &SessionKey,
    task: &ScheduledTask,
) -> Result<(), String> {
    let runtime = app
        .try_state::<Arc<IntegrationsRuntime>>()
        .ok_or("agents are not ready yet")?
        .inner()
        .clone();
    runtime
        .await_turn(
            host,
            key,
            super::agents::agents_send(
                key.clone(),
                task.prompt.clone(),
                None,
                None,
                app.state(),
                app.state(),
                app.clone(),
            ),
        )
        .await
}

fn notify(app: &AppHandle, task: &ScheduledTask, result: &Result<(), String>) {
    let body = match (result, task.notify) {
        (_, NotifyPolicy::None) | (Ok(_), NotifyPolicy::Failures) => return,
        (Ok(_), NotifyPolicy::All) => "Done".to_string(),
        (Err(e), _) => format!("Failed: {e}"),
    };
    let Some(notifier) = app.try_state::<Arc<crate::notifier::Notifier>>() else {
        return;
    };
    let shown = notifier.backend().show(crate::notifier::Notification {
        tag: format!("scheduled-{}", task.id),
        group: "scheduled-tasks".into(),
        title: task.name.clone(),
        subtitle: None,
        body,
        image_path: None,
        sound: None,
        urgency: crate::notifier::Urgency::Normal,
        actions: Vec::new(),
        payload: None,
    });
    if let Err(e) = shown {
        tracing::debug!("scheduled-task banner not shown: {e}");
    }
}

fn validate(task: &ScheduledTask) -> Result<(), String> {
    if task.prompt.trim().is_empty() {
        return Err("Describe what the task should do".into());
    }
    if task.plugin_id.is_empty() {
        return Err("Choose an agent".into());
    }
    if !PathBuf::from(&task.project_path).is_dir() {
        return Err(format!("Project folder not found: {}", task.project_path));
    }
    match &task.schedule {
        Schedule::Interval { minutes } if *minutes < MIN_INTERVAL_MINUTES => Err(format!(
            "Interval must be at least {MIN_INTERVAL_MINUTES} minutes"
        )),
        Schedule::Weekly { days, .. } if days.is_empty() || days.iter().any(|d| *d > 6) => {
            Err("Pick at least one day".into())
        }
        Schedule::Daily { time } | Schedule::Weekdays { time } | Schedule::Weekly { time, .. }
            if parse_time(time).is_none() =>
        {
            Err(format!("Invalid time: {time}"))
        }
        _ => Ok(()),
    }
}

#[tauri::command]
pub fn scheduled_tasks_list(state: State<'_, ScheduledTasksState>) -> Vec<ScheduledTask> {
    state.tasks.lock().clone()
}

/// Create (empty `id`) or replace a task. Recomputes `next_run_at`; the run
/// history fields are kept from the stored copy, never taken from the caller.
#[tauri::command]
pub fn scheduled_tasks_save(
    task: ScheduledTask,
    app: AppHandle,
    state: State<'_, ScheduledTasksState>,
) -> Result<ScheduledTask, String> {
    save(&app, &state, task)
}

/// The app, for the agent tool (`agent_schedule`), which is served outside
/// any Tauri command. Set once by [`start`].
// ponytail: a global; thread an AppHandle through SubagentManager if a second
// tool needs one.
static APP: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();

/// What `agent_schedule` takes: the task, without who runs it or where.
#[derive(Deserialize)]
struct ToolArgs {
    prompt: String,
    #[serde(default)]
    name: Option<String>,
    schedule: Schedule,
    #[serde(default = "yes")]
    new_chat_each_run: bool,
}

/// `agent_schedule`: a task the calling session's agent runs in the calling
/// session's project — "check C: free space every 30 minutes" asked in a
/// Codex chat becomes a Codex task.
pub fn create_for_session(
    plugin_id: &str,
    cwd: &str,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let app = APP.get().ok_or("the scheduler is not running")?;
    let args: ToolArgs = serde_json::from_value(args).map_err(|e| e.to_string())?;
    let name = args
        .name
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| {
            args.prompt
                .lines()
                .next()
                .unwrap_or_default()
                .chars()
                .take(60)
                .collect()
        });
    let task = ScheduledTask {
        id: String::new(),
        name,
        prompt: args.prompt,
        plugin_id: plugin_id.to_string(),
        project_path: cwd.to_string(),
        schedule: args.schedule,
        model: None,
        effort: None,
        notify: NotifyPolicy::Failures,
        new_chat_each_run: args.new_chat_each_run,
        enabled: true,
        created_at: 0,
        next_run_at: None,
        last_run: None,
        last_session_id: None,
    };
    let saved = save(app, &app.state::<ScheduledTasksState>(), task)?;
    let next = saved
        .next_run_at
        .and_then(|ms| Local.timestamp_millis_opt(ms).single())
        .map(|t| t.format("%Y-%m-%d %H:%M").to_string());
    Ok(serde_json::json!({
        "id": saved.id,
        "name": saved.name,
        "agent": saved.plugin_id,
        "project": saved.project_path,
        "next_run": next,
        "note": "Created in Atlas > Scheduled. The user can edit, pause or delete it there."
    }))
}

fn save(
    app: &AppHandle,
    state: &ScheduledTasksState,
    mut task: ScheduledTask,
) -> Result<ScheduledTask, String> {
    validate(&task)?;
    let now = now_ms();
    task.next_run_at = if task.enabled {
        next_run_ms(&task.schedule, now)
    } else {
        None
    };
    let saved = state.update(|tasks| {
        match tasks
            .iter_mut()
            .find(|t| !task.id.is_empty() && t.id == task.id)
        {
            Some(existing) => {
                task.created_at = existing.created_at;
                task.last_run = existing.last_run.take();
                task.last_session_id = existing.last_session_id.take();
                *existing = task.clone();
            }
            None => {
                task.id = uuid::Uuid::new_v4().to_string();
                task.created_at = now;
                task.last_run = None;
                task.last_session_id = None;
                tasks.push(task.clone());
            }
        }
        task
    });
    emit_changed(app);
    Ok(saved)
}

#[tauri::command]
pub fn scheduled_tasks_delete(id: String, app: AppHandle, state: State<'_, ScheduledTasksState>) {
    state.update(|tasks| tasks.retain(|t| t.id != id));
    emit_changed(&app);
}

/// Run a task now, outside its schedule. Leaves `next_run_at` alone.
#[tauri::command]
pub fn scheduled_tasks_run_now(
    id: String,
    app: AppHandle,
    state: State<'_, ScheduledTasksState>,
) -> Result<(), String> {
    let task = state
        .tasks
        .lock()
        .iter()
        .find(|t| t.id == id)
        .cloned()
        .ok_or("Task not found")?;
    if !state.try_claim(&id) {
        return Err("This task is already running".into());
    }
    spawn_run(app, task);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;

    fn at(s: &str) -> DateTime<FixedOffset> {
        DateTime::parse_from_rfc3339(s).unwrap()
    }

    fn daily(t: &str) -> Schedule {
        Schedule::Daily { time: t.into() }
    }

    #[test]
    fn daily_runs_later_today_or_tomorrow() {
        // 2026-10-13 is a Tuesday.
        let s = daily("09:00");
        assert_eq!(
            next_run(&s, &at("2026-10-13T08:00:00+08:00")),
            Some(at("2026-10-13T09:00:00+08:00"))
        );
        assert_eq!(
            next_run(&s, &at("2026-10-13T09:00:00+08:00")),
            Some(at("2026-10-14T09:00:00+08:00"))
        );
    }

    #[test]
    fn weekdays_skip_the_weekend() {
        let s = Schedule::Weekdays {
            time: "08:00".into(),
        };
        // Friday after 8 → Monday.
        assert_eq!(
            next_run(&s, &at("2026-10-16T10:00:00+08:00")),
            Some(at("2026-10-19T08:00:00+08:00"))
        );
    }

    #[test]
    fn weekly_picks_the_next_listed_day() {
        let s = Schedule::Weekly {
            days: vec![0, 3],
            time: "07:30".into(),
        };
        // Tuesday → Wednesday (3).
        assert_eq!(
            next_run(&s, &at("2026-10-13T12:00:00+08:00")),
            Some(at("2026-10-14T07:30:00+08:00"))
        );
        // Wednesday after the time → Sunday (0).
        assert_eq!(
            next_run(&s, &at("2026-10-14T08:00:00+08:00")),
            Some(at("2026-10-18T07:30:00+08:00"))
        );
        // The same day a week on, when it is the only day.
        let only_tue = Schedule::Weekly {
            days: vec![2],
            time: "07:30".into(),
        };
        assert_eq!(
            next_run(&only_tue, &at("2026-10-13T08:00:00+08:00")),
            Some(at("2026-10-20T07:30:00+08:00"))
        );
    }

    #[test]
    fn interval_adds_the_minutes_on_the_minute() {
        let s = Schedule::Interval { minutes: 30 };
        assert_eq!(
            next_run(&s, &at("2026-10-13T08:15:42+08:00")),
            Some(at("2026-10-13T08:45:00+08:00"))
        );
    }

    #[test]
    fn the_tool_schedule_shape_parses() {
        let s: Schedule =
            serde_json::from_value(serde_json::json!({ "type": "interval", "minutes": 30 }))
                .unwrap();
        assert_eq!(s, Schedule::Interval { minutes: 30 });
        let s: Schedule = serde_json::from_value(
            serde_json::json!({ "type": "weekly", "days": [1, 3], "time": "09:00" }),
        )
        .unwrap();
        assert_eq!(
            s,
            Schedule::Weekly {
                days: vec![1, 3],
                time: "09:00".into()
            }
        );
    }

    #[test]
    fn unusable_schedules_never_fire() {
        assert_eq!(
            next_run(&daily("25:00"), &at("2026-10-13T08:00:00+08:00")),
            None
        );
        let none = Schedule::Weekly {
            days: vec![],
            time: "08:00".into(),
        };
        assert_eq!(next_run(&none, &at("2026-10-13T08:00:00+08:00")), None);
    }

    #[test]
    fn a_missed_task_is_claimed_once_and_rescheduled_past_now() {
        let dir = std::env::temp_dir().join(format!("atlas-sched-{}", uuid::Uuid::new_v4()));
        let state = ScheduledTasksState::load(dir.clone());
        let now = now_ms();
        state.update(|tasks| {
            tasks.push(ScheduledTask {
                id: "t".into(),
                name: "t".into(),
                prompt: "p".into(),
                plugin_id: "codex".into(),
                project_path: ".".into(),
                schedule: daily("09:00"),
                model: None,
                effort: None,
                notify: NotifyPolicy::Failures,
                new_chat_each_run: true,
                enabled: true,
                created_at: 0,
                next_run_at: Some(now - 3 * 24 * 3600 * 1000),
                last_run: None,
                last_session_id: None,
            })
        });
        assert_eq!(state.claim_due(now).len(), 1);
        assert!(state.tasks.lock()[0].next_run_at.unwrap() > now);
        // Still running, and no longer due: nothing more to claim.
        assert!(state.claim_due(now).is_empty());
        state.release("t");
        // Persisted and reloadable.
        assert_eq!(ScheduledTasksState::load(dir.clone()).tasks.lock().len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }
}
