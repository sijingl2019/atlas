// @atlas-managed-pi-extension
//
// Installed and refreshed by Atlas (src-tauri/src/commands/subagents/pi_extension.rs).
// Edits are overwritten on the next Atlas launch; delete the marker line above
// to keep a local copy Atlas will leave alone.
//
// Two jobs, both only when pi runs inside Atlas (ATLAS_AGENTS_ENDPOINT is set):
//
// 1. Subagent tools. pi has no MCP, so the `atlas_agent_*` tools reach Atlas's
//    subagent server over its JSON endpoint instead. The session id pi reports
//    is the one Atlas knows the session by (pi-acp uses it as the ACP id).
// 2. A permission guard. pi runs every tool without asking; under Atlas, shell
//    commands and file writes wait for a confirm, which pi-acp turns into an
//    ACP permission request the user answers in Atlas. Set ATLAS_PI_GUARD=0 to
//    switch it off.

import { Type } from "typebox";

const ENDPOINT_ENV = "ATLAS_AGENTS_ENDPOINT";

type Endpoint = { url: string; key: string };

function readEndpoint(): Endpoint | null {
  const path = process.env[ENDPOINT_ENV];
  if (!path) return null;
  try {
    const fs = require("fs");
    const parsed = JSON.parse(fs.readFileSync(path, "utf8"));
    if (typeof parsed?.url === "string" && typeof parsed?.key === "string") {
      return { url: parsed.url, key: parsed.key };
    }
  } catch {
    // Missing while Atlas is starting, or Atlas is gone: the tool reports it.
  }
  return null;
}

async function call(op: string, sessionId: string, params: Record<string, unknown>, signal?: AbortSignal) {
  const endpoint = readEndpoint();
  if (!endpoint) throw new Error("Atlas is not running (no subagent endpoint)");
  const response = await fetch(`${endpoint.url}/v1/agents/${op}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${endpoint.key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ session_id: sessionId, ...params }),
    signal,
  });
  const body = (await response.json().catch(() => null)) as
    | { ok: true; result: unknown }
    | { ok: false; error: { code: string; message: string } }
    | null;
  if (!body) throw new Error(`Atlas answered ${response.status}`);
  if (!body.ok) throw new Error(`${body.error.code}: ${body.error.message}`);
  return body.result;
}

function textResult(result: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    details: result,
  };
}

const timeoutMs = Type.Optional(
  Type.Number({ description: "Milliseconds to wait (default 120000, at most 280000)." }),
);

const TOOLS = [
  {
    op: "start",
    description:
      "Start a subagent (another coding agent the user watches in the Atlas Agents panel) on a self-contained task. kind: codex, claude, pi or atlas; defaults to pi. A subagent whose status is `blocked` waits for the user to approve a permission: tell the user, then wait again.",
    parameters: Type.Object({
      name: Type.String({ description: "Short lowercase name: letters, digits, - or _." }),
      task: Type.String({ description: "The complete task. The subagent does not see this conversation." }),
      kind: Type.Optional(Type.String()),
      wait: Type.Optional(Type.Boolean()),
      timeout_ms: timeoutMs,
    }),
  },
  {
    op: "prompt",
    description: "Give a settled subagent more work. Refused while it is working or blocked.",
    parameters: Type.Object({
      name: Type.String(),
      text: Type.String(),
      wait: Type.Optional(Type.Boolean()),
      timeout_ms: timeoutMs,
    }),
  },
  {
    op: "wait",
    description:
      "Wait until a subagent settles or blocks on a permission. A timed_out result is not a failure: wait again.",
    parameters: Type.Object({
      name: Type.String(),
      until: Type.Optional(Type.Union([Type.Literal("settled"), Type.Literal("done"), Type.Literal("blocked")])),
      timeout_ms: timeoutMs,
    }),
  },
  {
    op: "read",
    description: "Read what a subagent did and said in its last turn.",
    parameters: Type.Object({
      name: Type.String(),
      lines: Type.Optional(Type.Number()),
      source: Type.Optional(Type.Union([Type.Literal("last_turn"), Type.Literal("recent")])),
    }),
  },
  {
    op: "list",
    description: "List the subagents this session started, with their status.",
    parameters: Type.Object({}),
  },
  {
    op: "stop",
    description: "Stop a subagent's current turn; remove also closes it.",
    parameters: Type.Object({
      name: Type.String(),
      remove: Type.Optional(Type.Boolean()),
    }),
  },
];

// Commands that only look. Anything chained, redirected or substituted is
// never read-only, whatever it starts with.
const READ_ONLY = /^(ls|pwd|cat|head|tail|wc|grep|rg|find|fd|tree|echo|which|file|stat|du|df|git (status|log|diff|show|branch|rev-parse))(\s|$)/;
const COMPOUND = /[;&|<>`]|\$\(/;

function needsConfirm(toolName: string, input: Record<string, unknown>): string | null {
  if (toolName.startsWith("atlas_agent_")) return null;
  if (toolName === "bash") {
    const command = String(input.command ?? "").trim();
    if (!COMPOUND.test(command) && READ_ONLY.test(command)) return null;
    return `Run: ${command}`;
  }
  if (toolName === "write" || toolName === "edit" || /write|edit/i.test(toolName)) {
    const path = String(input.path ?? input.file_path ?? input.filePath ?? "");
    return `${toolName === "write" ? "Write" : "Edit"}: ${path}`;
  }
  return null;
}

// ── pi-subagents ─────────────────────────────────────────────────────────
//
// pi-subagents runs its children as pi sessions inside this pi (foreground)
// or in a detached runner (background) — never as Atlas sessions. So Atlas is
// told about them: each child's status and transcript are reported as it
// runs, and every child carries a guard (`atlas-child-guard.ts`, injected
// through pi-subagents' required-child-extension registry) that asks Atlas —
// not the child's absent UI — before a risky tool runs.

const PARENT_SESSION_KEY = Symbol.for("atlas.agents.parent-session.v1");
const REQUIRED_REGISTRY_KEY = Symbol.for("pi-subagents.required-child-extensions.v1");
const CHILD_GUARD_ID = "atlas-child-guard";

function piHome(): string {
  const path = require("path");
  const os = require("os");
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

/** Register the child guard for `sessionId` in pi-subagents' registry. The
 *  registry is a global pi-subagents reads at every launch, so this works
 *  whether or not pi-subagents has loaded yet — and is inert without it. */
function registerChildGuard(sessionId: string): () => void {
  const fs = require("fs");
  const path = require("path");
  const guard = path.join(piHome(), "atlas", "atlas-child-guard.ts");
  if (!fs.existsSync(guard)) return () => {};
  const root = globalThis as any;
  let registry = root[REQUIRED_REGISTRY_KEY];
  if (registry === undefined) {
    registry = { version: 1, bySession: new Map() };
    root[REQUIRED_REGISTRY_KEY] = registry;
  }
  if (registry?.version !== 1 || !(registry.bySession instanceof Map)) return () => {};
  const existing: ReadonlyArray<{ id: string; path: string }> = registry.bySession.get(sessionId) ?? [];
  if (existing.some((e) => e.id === CHILD_GUARD_ID)) return () => {};
  const snapshot = Object.freeze([
    ...existing,
    Object.freeze({ id: CHILD_GUARD_ID, path: fs.realpathSync(guard) }),
  ]);
  registry.bySession.set(sessionId, snapshot);
  return () => {
    if (registry.bySession.get(sessionId) === snapshot) {
      if (existing.length) registry.bySession.set(sessionId, existing);
      else registry.bySession.delete(sessionId);
    }
  };
}

type Item =
  | { type: "user"; text: string }
  | { type: "assistant"; text: string }
  | { type: "tool"; id: string; name: string; title?: string; status: string; args?: unknown; result?: string };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p: any) => p?.type === "text" && typeof p.text === "string")
    .map((p: any) => p.text)
    .join("\n")
    .trim();
}

function toolTitle(name: string, args: any): string {
  if (name === "bash" && typeof args?.command === "string") return args.command;
  const path = args?.path ?? args?.file_path ?? args?.filePath;
  return typeof path === "string" ? `${name} ${path}` : name;
}

/** One pi session-file entry as transcript items. */
function itemsOf(entry: any): Item[] {
  const m = entry?.type === "message" ? entry.message : null;
  if (!m) return [];
  if (m.role === "user") {
    const text = textOf(m.content);
    return text ? [{ type: "user", text }] : [];
  }
  if (m.role === "assistant") {
    const out: Item[] = [];
    // Some models put their reasoning inline as <think>…</think>; the column
    // shows what the child said, not how it got there.
    const text = textOf(m.content).replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    if (text) out.push({ type: "assistant", text });
    for (const part of Array.isArray(m.content) ? m.content : []) {
      if (part?.type === "toolCall" && part.id) {
        out.push({ type: "tool", id: part.id, name: part.name, title: toolTitle(part.name, part.arguments), status: "running", args: part.arguments });
      }
    }
    return out;
  }
  if (m.role === "toolResult" && m.toolCallId) {
    return [{ type: "tool", id: m.toolCallId, name: m.toolName ?? "tool", status: m.isError ? "failed" : "completed", result: textOf(m.content).slice(0, 4000) }];
  }
  return [];
}

interface Child {
  key: string;
  name: string;
  task?: string;
  status?: string;
  toolCount?: number;
  error?: string;
  sessionFile?: string;
  offset: number;
  pending: string;
  dirty: boolean;
}

/** Follows every pi-subagents child of one parent session and reports it. */
class Mirror {
  private children = new Map<string, Child>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private asyncDirs = new Set<string>();
  private busy = false;

  constructor(private sessionId: () => string) {}

  child(key: string, name: string): Child {
    let c = this.children.get(key);
    if (!c) {
      c = { key, name, offset: 0, pending: "", dirty: true };
      this.children.set(key, c);
    }
    this.start();
    return c;
  }

  update(key: string, name: string, patch: Partial<Child>): void {
    const c = this.child(key, name);
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined && (c as any)[k] !== v) {
        (c as any)[k] = v;
        c.dirty = true;
      }
    }
  }

  watchAsync(dir: string): void {
    this.asyncDirs.add(dir);
    this.start();
  }

  private start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 700);
    (this.timer as any).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private readAsync(): void {
    const fs = require("fs");
    const path = require("path");
    for (const dir of this.asyncDirs) {
      let status: any;
      try {
        status = JSON.parse(fs.readFileSync(path.join(dir, "status.json"), "utf8"));
      } catch {
        continue;
      }
      const runId = status?.runId ?? path.basename(dir);
      const steps: any[] = Array.isArray(status?.steps) ? status.steps : [];
      steps.forEach((step, index) => {
        this.update(`${runId}:${step?.index ?? index}`, step?.agent ?? "subagent", {
          status: step?.status,
          toolCount: typeof step?.toolCount === "number" ? step.toolCount : undefined,
          sessionFile: typeof step?.sessionFile === "string" ? step.sessionFile : undefined,
          error: typeof step?.error === "string" ? step.error : undefined,
          task: typeof step?.task === "string" ? step.task : undefined,
        });
      });
      const done = ["complete", "completed", "failed", "stopped", "cancelled"].includes(status?.state);
      if (done && steps.every((s) => ["completed", "failed", "stopped"].includes(s?.status))) {
        this.asyncDirs.delete(dir);
      }
    }
  }

  private readTranscript(c: Child): Item[] {
    if (!c.sessionFile) return [];
    const fs = require("fs");
    let size = 0;
    try {
      size = fs.statSync(c.sessionFile).size;
    } catch {
      return [];
    }
    if (size <= c.offset) return [];
    const fd = fs.openSync(c.sessionFile, "r");
    try {
      const buf = Buffer.alloc(size - c.offset);
      fs.readSync(fd, buf, 0, buf.length, c.offset);
      c.offset = size;
      const text = c.pending + buf.toString("utf8");
      const lines = text.split("\n");
      c.pending = lines.pop() ?? "";
      const items: Item[] = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          items.push(...itemsOf(JSON.parse(line)));
        } catch {
          // A torn line; the rest of the file is still good.
        }
      }
      return items;
    } finally {
      fs.closeSync(fd);
    }
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      this.readAsync();
      for (const c of this.children.values()) {
        const items = this.readTranscript(c);
        if (!items.length && !c.dirty) continue;
        c.dirty = false;
        await call(
          "mirror",
          this.sessionId(),
          { key: c.key, name: c.name, task: c.task, status: c.status, tool_count: c.toolCount, session_file: c.sessionFile, error: c.error, items },
        ).catch(() => {});
      }
    } finally {
      this.busy = false;
    }
  }
}

/** The `subagent` tool's progress (pi-subagents' `details`) into the mirror. */
function mirrorProgress(mirror: Mirror, parentFile: string | undefined, args: any, details: any): void {
  const path = require("path");
  if (!details || typeof details.runId !== "string") return;
  const runId: string = details.runId;
  const root = parentFile ? path.join(path.dirname(parentFile), path.basename(parentFile, ".jsonl")) : null;
  const byIndex = new Map<number, any>();
  for (const r of Array.isArray(details.results) ? details.results : []) byIndex.set(r?.index ?? 0, r);
  const progress: any[] = Array.isArray(details.progress) ? details.progress : [];
  const indexes = new Set<number>([...progress.map((p) => p?.index ?? 0), ...byIndex.keys()]);
  for (const index of indexes) {
    const p = progress.find((x) => (x?.index ?? 0) === index);
    const r = byIndex.get(index);
    const status = p?.status ?? (r ? (r.exitCode === 0 ? "completed" : "failed") : undefined);
    mirror.update(`${runId}:${index}`, p?.agent ?? r?.agent ?? "subagent", {
      status,
      toolCount: typeof p?.toolCount === "number" ? p.toolCount : undefined,
      error: typeof (p?.error ?? r?.error) === "string" ? (p?.error ?? r?.error) : undefined,
      task: typeof args?.task === "string" ? args.task : undefined,
      sessionFile:
        (typeof r?.sessionFile === "string" && r.sessionFile) ||
        (root ? path.join(root, runId, `run-${index}`, "session.jsonl") : undefined),
    });
  }
  if (details.asyncDir) mirror.watchAsync(details.asyncDir);
}

function startSubagentBridge(pi: any): void {
  let sessionId = "";
  let sessionFile: string | undefined;
  let dispose = () => {};
  const mirror = new Mirror(() => sessionId);
  pi.on("session_start", async (_event: any, ctx: any) => {
    sessionId = ctx.sessionManager.getSessionId();
    sessionFile = ctx.sessionManager.getSessionFile?.() ?? undefined;
    // What a foreground child (in this process) reports as its parent.
    (globalThis as any)[PARENT_SESSION_KEY] = sessionId;
    dispose();
    try {
      dispose = registerChildGuard(sessionId);
    } catch {
      dispose = () => {};
    }
  });
  pi.on("session_shutdown", async () => {
    dispose();
    mirror.stop();
  });
  const onTool = (event: any) => {
    if (event?.toolName !== "subagent") return;
    const details = event.partialResult?.details ?? event.result?.details;
    mirrorProgress(mirror, sessionFile, event.args, details);
  };
  pi.on("tool_execution_update", async (event: any) => onTool(event));
  pi.on("tool_execution_end", async (event: any) => onTool(event));
  // Background runs report their own directory; the mirror polls it.
  pi.events?.on?.("subagent:async-started", (data: any) => {
    if (typeof data?.asyncDir === "string") mirror.watchAsync(data.asyncDir);
  });
}

export default function (pi: any): void {
  if (!process.env[ENDPOINT_ENV]) return;
  // Inside a pi-subagents runner every session is a child: the required
  // child guard covers it, and a confirm here would only ever answer "no".
  if (process.env.PI_SUBAGENT_CHILD === "1") return;

  startSubagentBridge(pi);

  for (const tool of TOOLS) {
    pi.registerTool({
      name: `atlas_agent_${tool.op}`,
      label: `atlas agent ${tool.op}`,
      description: tool.description,
      parameters: tool.parameters,
      async execute(_toolCallId: string, params: Record<string, unknown>, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: any) {
        const sessionId = ctx.sessionManager.getSessionId();
        return textResult(await call(tool.op, sessionId, params ?? {}, signal));
      },
    });
  }

  if (process.env.ATLAS_PI_GUARD === "0") return;

  pi.on("tool_call", async (event: any, ctx: any) => {
    const title = needsConfirm(event.toolName, event.input ?? {});
    if (!title) return undefined;
    if (!ctx.hasUI) return { block: true, reason: "Blocked: no one to approve it in Atlas" };
    const detail =
      event.toolName === "bash"
        ? String(event.input?.command ?? "")
        : JSON.stringify(event.input ?? {}, null, 2).slice(0, 2000);
    const approved = await ctx.ui.confirm(title, detail);
    return approved ? undefined : { block: true, reason: "Denied by user in Atlas" };
  });
}
