//! The subagent tool server: one loopback HTTP server, two front doors.
//!
//! - **`/mcp`** — streamable HTTP MCP, for every agent that advertised
//!   `mcpCapabilities.http` (Codex, Claude Code) and for the native agent.
//!   Each session is offered the server with a bearer token of its own, the
//!   same way as the memory tool server; the token says which session is
//!   calling, and so whose children it can see.
//! - **`/v1/agents/{op}`** — plain JSON, for the pi extension (pi has no
//!   MCP). The caller names its session in the body and proves it runs under
//!   Atlas with the per-launch key from the endpoint file, which only the
//!   user can read.
//!
//! Both doors dispatch to the same [`SubagentManager`] operations, so the
//! two tool surfaces cannot drift.

use std::borrow::Cow;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use agent_client_protocol::schema::v1 as acp;
use atlas_agent_servers::{SessionMcpOffer, SessionMcpRequest, SessionMcpServers};
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::header::{AUTHORIZATION, CONTENT_TYPE};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware;
use axum::response::{IntoResponse, Response};
use rmcp::handler::server::ServerHandler;
use rmcp::model::{
    CacheScope, CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock as Content,
    JsonObject, ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerInfo, Tool,
};
use rmcp::service::{RequestContext, RoleServer};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::ErrorData as McpError;
use serde::Deserialize;
use serde_json::{json, Value};

use super::manager::{Caller, ReadSource, SubagentError, SubagentManager, Until};
use super::AGENTS_SERVER_NAME;
use crate::commands::memory_server::{require_token, Grant, MemoryTokens};

const MCP_PATH: &str = "/mcp";

/// How long a client may keep the tool list. The set never changes while the
/// app runs (a child's list differs, but a token is one session's for life).
const TOOLS_LIST_TTL_MS: u64 = 60 * 60 * 1000;

/// What every agent is told about the tools. Modelled on herdr's agent skill.
pub const INSTRUCTIONS: &str = "\
Atlas agents: start other coding agents as subagents and coordinate them. Each subagent is a full \
agent session the user watches live in the Atlas Agents panel.
1. agent_start(name, task, kind?) starts a subagent working on `task` in this project. `kind` \
picks the agent (codex, claude, pi, atlas); it defaults to your own. Give each a short lowercase \
name, and a self-contained task: it does not see this conversation.
2. Start several, then agent_wait(name) on each. A timed_out result is not a failure: wait again.
3. agent_read(name) returns what a subagent did and said in its last turn. Read it before \
reporting its work.
4. agent_prompt(name, text) gives a finished subagent more work. agent_stop(name) stops one.
5. A subagent whose status is `blocked` is waiting for the user to approve a permission in the \
Agents panel. You cannot approve it. Tell the user what it is waiting for, then agent_wait again. \
Never retry a blocked prompt.
Subagents cannot start agents of their own.";

// ── Specs ────────────────────────────────────────────────────────────────────

fn tool(name: &'static str, description: &'static str, input: Value) -> Tool {
    let schema = match input {
        Value::Object(map) => Arc::new(map),
        _ => Arc::new(JsonObject::new()),
    };
    Tool::new(Cow::Borrowed(name), Cow::Borrowed(description), schema)
}

fn timeout_prop() -> Value {
    json!({ "type": "integer", "description": "Milliseconds to wait (default 120000, at most 280000)." })
}

/// The tools, less `agent_start` for a caller that is itself a subagent.
pub fn tools(for_child: bool) -> Vec<Tool> {
    let mut tools = Vec::new();
    if !for_child {
        tools.push(tool(
            "agent_start",
            "Start a subagent on a task. Returns at once unless `wait` is true.",
            json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "Short lowercase name, unique in this session: letters, digits, - or _." },
                    "task": { "type": "string", "description": "The complete task. The subagent does not see this conversation." },
                    "kind": { "type": "string", "description": "Agent to run: codex, claude, pi or atlas. Defaults to your own." },
                    "wait": { "type": "boolean", "description": "Wait for the first turn to settle before returning." },
                    "timeout_ms": timeout_prop()
                },
                "required": ["name", "task"]
            }),
        ));
    }
    tools.extend([
        tool(
            "agent_prompt",
            "Give a subagent that has settled more work. Refused while it is working or blocked.",
            json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string" },
                    "text": { "type": "string" },
                    "wait": { "type": "boolean" },
                    "timeout_ms": timeout_prop()
                },
                "required": ["name", "text"]
            }),
        ),
        tool(
            "agent_wait",
            "Wait until a subagent settles (done, error, stopped) or blocks on a permission.",
            json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string" },
                    "until": { "type": "string", "enum": ["settled", "done", "blocked"] },
                    "timeout_ms": timeout_prop()
                },
                "required": ["name"]
            }),
        ),
        tool(
            "agent_read",
            "Read a subagent's transcript as text: its last turn by default.",
            json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string" },
                    "lines": { "type": "integer", "description": "At most this many lines (default 80, max 400)." },
                    "source": { "type": "string", "enum": ["last_turn", "recent"] }
                },
                "required": ["name"]
            }),
        ),
        tool(
            "agent_list",
            "List the subagents this session started, with their status.",
            json!({ "type": "object", "properties": {} }),
        ),
        tool(
            "agent_stop",
            "Stop a subagent's current turn. `remove` also closes it.",
            json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string" },
                    "remove": { "type": "boolean" }
                },
                "required": ["name"]
            }),
        ),
    ]);
    tools
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct StartArgs {
    name: String,
    task: String,
    kind: Option<String>,
    #[serde(default)]
    wait: bool,
    timeout_ms: Option<u64>,
}

#[derive(Deserialize)]
struct PromptArgs {
    name: String,
    text: String,
    #[serde(default)]
    wait: bool,
    timeout_ms: Option<u64>,
}

#[derive(Deserialize)]
struct WaitArgs {
    name: String,
    #[serde(default)]
    until: Until,
    timeout_ms: Option<u64>,
}

#[derive(Deserialize)]
struct ReadArgs {
    name: String,
    lines: Option<usize>,
    #[serde(default)]
    source: ReadSource,
}

#[derive(Deserialize)]
struct ApproveArgs {
    #[serde(default)]
    session_file: Option<String>,
    #[serde(default)]
    name: Option<String>,
    title: String,
    #[serde(default)]
    detail: String,
}

/// The operations the MCP door serves: the tools, and nothing else.
const MCP_OPS: [&str; 6] = ["start", "prompt", "wait", "read", "list", "stop"];

#[derive(Deserialize)]
struct StopArgs {
    name: String,
    #[serde(default)]
    remove: bool,
}

fn parse<T: for<'de> Deserialize<'de>>(args: Value) -> Result<T, SubagentError> {
    serde_json::from_value(args).map_err(|e| SubagentError {
        code: "invalid_arguments",
        message: e.to_string(),
    })
}

/// Run one operation for `session_id`. `op` is the tool name without its
/// `agent_` prefix.
pub async fn dispatch(
    manager: &SubagentManager,
    session_id: &str,
    op: &str,
    args: Value,
) -> Result<Value, SubagentError> {
    let caller: Caller = manager
        .caller_for_session(session_id)
        .ok_or_else(|| SubagentError {
            code: "unknown_session",
            message: "the calling session is not open in Atlas".into(),
        })?;
    match op {
        "start" => {
            let a: StartArgs = parse(args)?;
            manager
                .start(
                    &caller,
                    &a.name,
                    &a.task,
                    a.kind.as_deref(),
                    a.wait,
                    a.timeout_ms,
                )
                .await
        }
        "prompt" => {
            let a: PromptArgs = parse(args)?;
            manager
                .prompt(&caller, &a.name, &a.text, a.wait, a.timeout_ms)
                .await
        }
        "wait" => {
            let a: WaitArgs = parse(args)?;
            let result = manager
                .wait(&caller, &a.name, a.until, a.timeout_ms)
                .await?;
            Ok(serde_json::to_value(result).unwrap_or(Value::Null))
        }
        "read" => {
            let a: ReadArgs = parse(args)?;
            manager.read(&caller, &a.name, a.lines, a.source)
        }
        "list" => Ok(json!({ "agents": manager.list(&caller) })),
        "stop" => {
            let a: StopArgs = parse(args)?;
            manager.stop(&caller, &a.name, a.remove).await
        }
        // The pi extension's reports about pi-subagents children. Not tools:
        // the MCP door refuses them (see `MCP_OPS`), as it does
        // `permission_mode` below.
        "mirror" => {
            let report: super::mirror::MirrorReport = parse(args)?;
            let view = manager.mirror_report(&caller, report)?;
            Ok(json!({ "agent": view }))
        }
        "approve" => {
            let a: ApproveArgs = parse(args)?;
            let allowed = manager
                .mirror_approval(&caller, a.session_file, a.name, a.title, a.detail)
                .await?;
            Ok(json!({ "allowed": allowed }))
        }
        // The pi extension's permission gate asks before each confirm whether
        // the session is in Auto (`atlas_agent_servers::permission_modes`).
        "permission_mode" => Ok(json!({ "mode": manager.permission_mode(&caller) })),
        other => Err(SubagentError {
            code: "unknown_tool",
            message: format!("unknown operation `{other}`"),
        }),
    }
}

fn error_json(e: &SubagentError) -> Value {
    json!({ "error": { "code": e.code, "message": e.message } })
}

// ── MCP ──────────────────────────────────────────────────────────────────────

#[derive(Clone)]
struct SubagentTools {
    manager: Arc<SubagentManager>,
}

fn grant_of(context: &RequestContext<RoleServer>) -> Option<Grant> {
    context
        .extensions
        .get::<axum::http::request::Parts>()
        .and_then(|parts| parts.extensions.get::<Grant>())
        .cloned()
}

impl ServerHandler for SubagentTools {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_instructions(INSTRUCTIONS)
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        let for_child = grant_of(&context).is_some_and(|g| self.manager.is_child(&g.session_id));
        // `ttlMs` and `cacheScope` are required on a modern-era result:
        // Claude Code rejects a list without them and shows no tools at all.
        Ok(ListToolsResult::with_all_items(tools(for_child))
            .with_ttl_ms(TOOLS_LIST_TTL_MS)
            .with_cache_scope(CacheScope::Private))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        let grant = grant_of(&context)
            .ok_or_else(|| McpError::invalid_request("no session token", None))?;
        let name = request.name.to_string();
        let Some(op) = name
            .strip_prefix("agent_")
            .filter(|op| MCP_OPS.contains(op))
        else {
            return Ok(CallToolResult::error(vec![Content::text(format!(
                "unknown tool `{name}`"
            ))])
            .into());
        };
        let args = Value::Object(request.arguments.clone().unwrap_or_default());
        let result = match dispatch(&self.manager, &grant.session_id, op, args).await {
            Ok(value) => CallToolResult::success(vec![Content::text(value.to_string())]),
            Err(e) => CallToolResult::error(vec![Content::text(error_json(&e).to_string())]),
        };
        Ok(result.into())
    }
}

// ── JSON (pi) ────────────────────────────────────────────────────────────────

#[derive(Clone)]
struct JsonState {
    manager: Arc<SubagentManager>,
    key: Arc<str>,
}

fn json_response(status: StatusCode, body: Value) -> Response {
    (
        status,
        [(CONTENT_TYPE, "application/json")],
        body.to_string(),
    )
        .into_response()
}

async fn json_op(
    State(state): State<JsonState>,
    Path(op): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let authorized = headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .is_some_and(|k| k.trim() == &*state.key);
    if !authorized {
        return json_response(
            StatusCode::UNAUTHORIZED,
            json!({ "ok": false, "error": { "code": "unauthorized", "message": "bad key" } }),
        );
    }
    let mut args: Value = match serde_json::from_slice(&body) {
        Ok(Value::Object(map)) => Value::Object(map),
        _ => {
            return json_response(
                StatusCode::BAD_REQUEST,
                json!({ "ok": false, "error": { "code": "invalid_arguments", "message": "body must be a JSON object" } }),
            )
        }
    };
    let session_id = args
        .as_object_mut()
        .and_then(|o| o.remove("session_id"))
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default();
    match dispatch(&state.manager, &session_id, &op, args).await {
        Ok(result) => json_response(StatusCode::OK, json!({ "ok": true, "result": result })),
        Err(e) => {
            let status = if e.code == "unknown_session" {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::OK
            };
            json_response(
                status,
                json!({ "ok": false, "error": { "code": e.code, "message": e.message } }),
            )
        }
    }
}

// ── The server ───────────────────────────────────────────────────────────────

pub struct SubagentServer {
    addr: SocketAddr,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
}

impl SubagentServer {
    pub async fn start(
        manager: Arc<SubagentManager>,
        tokens: Arc<MemoryTokens>,
        key: Arc<str>,
    ) -> std::io::Result<Self> {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
        let addr = listener.local_addr()?;
        let handler = SubagentTools {
            manager: manager.clone(),
        };
        let service = StreamableHttpService::new(
            move || Ok(handler.clone()),
            Arc::new(LocalSessionManager::default()),
            StreamableHttpServerConfig::default(),
        );
        let mcp = axum::Router::new()
            .nest_service(MCP_PATH, service)
            .layer(middleware::from_fn_with_state(tokens, require_token));
        let json = axum::Router::new()
            .route("/v1/agents/{op}", axum::routing::post(json_op))
            .with_state(JsonState { manager, key });
        let router = mcp.merge(json);
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(async move {
            let served = axum::serve(listener, router)
                .with_graceful_shutdown(async move {
                    let _ = stopped.await;
                })
                .await;
            if let Err(e) = served {
                tracing::warn!(target: "atlas::subagents", "subagent tool server stopped: {e}");
            }
        });
        tracing::info!(target: "atlas::subagents", "subagent tool server on http://{addr}");
        Ok(Self {
            addr,
            stop: Some(stop),
        })
    }

    pub fn base_url(&self) -> String {
        format!("http://{}", self.addr)
    }

    pub fn mcp_url(&self) -> String {
        format!("http://{}{MCP_PATH}", self.addr)
    }
}

impl Drop for SubagentServer {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
    }
}

/// The app's one subagent tool server, its session tokens and its per-launch
/// key, as managed state.
pub struct SubagentServerHost {
    tokens: Arc<MemoryTokens>,
    key: Arc<str>,
    endpoint_file: PathBuf,
    server: OnceLock<SubagentServer>,
}

impl SubagentServerHost {
    pub fn new(endpoint_file: PathBuf) -> Self {
        let key = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        Self {
            tokens: Arc::default(),
            key: key.into(),
            endpoint_file,
            server: OnceLock::new(),
        }
    }

    /// Minted at session start, revoked at session end.
    pub fn tokens(&self) -> &Arc<MemoryTokens> {
        &self.tokens
    }

    pub fn mcp_url(&self) -> Option<String> {
        self.server.get().map(SubagentServer::mcp_url)
    }

    /// Start serving on the runtime, then publish the endpoint file.
    pub fn start(self: &Arc<Self>, manager: Arc<SubagentManager>) {
        let host = self.clone();
        tauri::async_runtime::spawn(async move {
            match SubagentServer::start(manager, host.tokens.clone(), host.key.clone()).await {
                Ok(server) => {
                    if let Err(e) =
                        write_endpoint(&host.endpoint_file, &server.base_url(), &host.key)
                    {
                        tracing::warn!(target: "atlas::subagents", "endpoint file not written: {e}");
                    }
                    let _ = host.server.set(server);
                }
                Err(e) => {
                    tracing::warn!(target: "atlas::subagents", "subagent tool server did not start: {e}")
                }
            }
        });
    }
}

/// `{url, key, pid}`, readable by the user only.
pub fn write_endpoint(path: &std::path::Path, url: &str, key: &str) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let body = json!({ "url": url, "key": key, "pid": std::process::id() }).to_string();
    let tmp = path.with_extension("json.tmp");
    {
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp)?;
        file.write_all(body.as_bytes())?;
    }
    std::fs::rename(&tmp, path)
}

/// Offers each session the subagent tool server with a token of its own.
pub struct SubagentSessionOffers {
    host: Arc<SubagentServerHost>,
}

impl SubagentSessionOffers {
    pub fn new(host: Arc<SubagentServerHost>) -> Self {
        Self { host }
    }
}

impl SessionMcpServers for SubagentSessionOffers {
    fn offer(&self, request: &SessionMcpRequest) -> SessionMcpOffer {
        let agent = request.agent_id.as_str().to_string();
        let url = self.host.mcp_url();
        tracing::info!(
            target: "atlas::subagents",
            "atlas_agents offer: agent={agent} http_mcp={} {}",
            request.http_mcp,
            match (&url, request.http_mcp) {
                (_, false) => "omitted reason=\"agent did not advertise mcpCapabilities.http\"",
                (None, _) => "omitted reason=\"server is not running\"",
                _ => "included",
            }
        );
        let (true, Some(url)) = (request.http_mcp, url) else {
            return SessionMcpOffer::none();
        };
        let cwd = request.cwd.to_string_lossy().into_owned();
        let tokens = self.host.tokens().clone();
        let token = tokens.mint_unbound(&agent, &cwd);
        let server = acp::McpServer::Http(
            acp::McpServerHttp::new(AGENTS_SERVER_NAME, url).headers(vec![acp::HttpHeader::new(
                "Authorization",
                format!("Bearer {token}"),
            )]),
        );
        SessionMcpOffer::new(vec![server], move |session| match session {
            Some(id) => tokens.bind(&token, &id.to_string()),
            None => tokens.revoke_token(&token),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::agent_host::SessionKey;
    use crate::commands::subagents::manager::SubagentHost;
    use atlas_agent_wire::AgentId;
    use futures::future::BoxFuture;
    use rmcp::service::RunningService;
    use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
    use rmcp::transport::StreamableHttpClientTransport;
    use rmcp::{RoleClient, ServiceExt};

    /// Every session is live and in `/work`; nothing is ever started.
    struct Host;

    impl SubagentHost for Host {
        fn session_info(&self, _session_id: &str) -> Option<(String, String)> {
            Some(("codex-acp".into(), "/work".into()))
        }
        fn is_installed(&self, _plugin_id: &str) -> bool {
            true
        }
        fn start_session(
            &self,
            _plugin_id: String,
            _cwd: String,
            _mode: Option<String>,
        ) -> BoxFuture<'static, Result<SessionKey, String>> {
            Box::pin(async { Err("not in this test".to_string()) })
        }
        /// Only `auto-session` has modes, and it is in Auto.
        fn current_mode(&self, session_id: &str) -> Option<String> {
            (session_id == "auto-session").then(|| "auto".to_string())
        }
        fn send(&self, _key: &SessionKey, _text: String) -> Result<(), String> {
            Ok(())
        }
        fn cancel(&self, _key: &SessionKey) -> Result<(), String> {
            Ok(())
        }
        fn drop_session(&self, _session_id: String) -> BoxFuture<'static, Result<(), String>> {
            Box::pin(async { Ok(()) })
        }
        fn transcript(&self, _key: &SessionKey) -> Result<Vec<atlas_agent_wire::Message>, String> {
            Ok(Vec::new())
        }
        fn release(&self, _agent_handle: AgentId) {}
    }

    async fn server() -> (SubagentServer, Arc<MemoryTokens>) {
        let manager = SubagentManager::new(Box::new(Host), Arc::new(|_| {}));
        let tokens: Arc<MemoryTokens> = Arc::default();
        let server = SubagentServer::start(manager, tokens.clone(), "k".into())
            .await
            .unwrap();
        (server, tokens)
    }

    async fn connect(url: &str, token: &str) -> Result<RunningService<RoleClient, ()>, String> {
        let transport = StreamableHttpClientTransport::from_config(
            StreamableHttpClientTransportConfig::with_uri(url.to_string())
                .auth_header(token.to_string()),
        );
        ().serve(transport).await.map_err(|e| format!("{e:?}"))
    }

    #[tokio::test]
    async fn a_session_token_lists_and_calls_the_tools_over_mcp() {
        let (server, tokens) = server().await;
        assert!(connect(&server.mcp_url(), "nope").await.is_err());
        let token = tokens.mint("s1", "codex-acp", "/work");
        let client = connect(&server.mcp_url(), &token).await.unwrap();
        let listed = client.list_tools(None).await.unwrap();
        // Required by Claude Code's client on the modern protocol.
        assert!(listed.ttl_ms.is_some() && listed.cache_scope.is_some());
        let tools = client.list_all_tools().await.unwrap();
        let names: Vec<String> = tools.iter().map(|t| t.name.to_string()).collect();
        assert_eq!(
            names,
            [
                "agent_start",
                "agent_prompt",
                "agent_wait",
                "agent_read",
                "agent_list",
                "agent_stop"
            ]
        );
        let result = client
            .call_tool(rmcp::model::CallToolRequestParams::new("agent_list"))
            .await
            .unwrap();
        let text = result.content[0].as_text().unwrap().text.clone();
        assert_eq!(
            serde_json::from_str::<Value>(&text).unwrap(),
            json!({ "agents": [] })
        );
    }

    #[tokio::test]
    async fn the_json_endpoint_wants_the_key_and_a_live_session() {
        let (server, _) = server().await;
        let url = format!("{}/v1/agents/list", server.base_url());
        let http = reqwest::Client::new();
        let unauthorized = http.post(&url).body("{}").send().await.unwrap();
        assert_eq!(unauthorized.status(), 401);
        let ok: Value = http
            .post(&url)
            .bearer_auth("k")
            .body(r#"{"session_id":"s1"}"#)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(ok, json!({ "ok": true, "result": { "agents": [] } }));
    }

    #[tokio::test]
    async fn the_pi_gate_reads_the_session_permission_mode() {
        let (server, _) = server().await;
        let url = format!("{}/v1/agents/permission_mode", server.base_url());
        let http = reqwest::Client::new();
        let mode = |session: &'static str| {
            let request = http
                .post(&url)
                .bearer_auth("k")
                .body(format!(r#"{{"session_id":"{session}"}}"#));
            async move { request.send().await.unwrap().json::<Value>().await.unwrap() }
        };
        assert_eq!(
            mode("auto-session").await,
            json!({ "ok": true, "result": { "mode": "auto" } })
        );
        assert_eq!(
            mode("s1").await,
            json!({ "ok": true, "result": { "mode": null } })
        );
        // Not a tool: an MCP client cannot reach it.
        assert!(!MCP_OPS.contains(&"permission_mode"));
    }

    #[test]
    fn a_child_is_not_offered_agent_start() {
        let names = |child| {
            tools(child)
                .into_iter()
                .map(|t| t.name.to_string())
                .collect::<Vec<_>>()
        };
        assert!(names(false).contains(&"agent_start".to_string()));
        assert!(!names(true).contains(&"agent_start".to_string()));
        assert_eq!(names(false).len(), 6);
    }

    #[cfg(unix)]
    #[test]
    fn the_endpoint_file_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agents-endpoint.json");
        write_endpoint(&path, "http://127.0.0.1:1", "k").unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let body: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(body["key"], "k");
    }
}
