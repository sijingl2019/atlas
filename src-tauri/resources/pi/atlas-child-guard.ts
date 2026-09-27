// @atlas-managed-pi-extension
//
// Installed by Atlas next to (not inside) ~/.pi/agent/extensions, and loaded
// only into pi-subagents children: Atlas's pi extension registers it with
// pi-subagents' required-child-extension registry for each parent session.
//
// A pi-subagents child has no UI — its `ctx.ui.confirm` answers "no" at once —
// so this guard asks Atlas instead: the request appears on the child's column
// in Atlas's Subagents panel, and the call waits for the user's answer.

const ENDPOINT_ENV = "ATLAS_AGENTS_ENDPOINT";
const PARENT_SESSION_KEY = Symbol.for("atlas.agents.parent-session.v1");

function readEndpoint(): { url: string; key: string } | null {
  const path = process.env[ENDPOINT_ENV];
  if (!path) return null;
  try {
    const fs = require("fs");
    const parsed = JSON.parse(fs.readFileSync(path, "utf8"));
    if (typeof parsed?.url === "string" && typeof parsed?.key === "string") return parsed;
  } catch {
    // Atlas is gone or starting; the call is refused below.
  }
  return null;
}

/** The Atlas session this child belongs under: its parent's. A foreground
 *  child shares the parent's process (and its global); a background one runs
 *  in a pi-subagents runner that names the parent in its environment. */
function parentSession(): string | undefined {
  const inProcess = (globalThis as any)[PARENT_SESSION_KEY];
  return typeof inProcess === "string" && inProcess ? inProcess : process.env.PI_SUBAGENT_PARENT_SESSION;
}

// Same rule as the parent's guard: commands that only look pass; anything
// chained, redirected or substituted never counts as only looking.
const READ_ONLY = /^(ls|pwd|cat|head|tail|wc|grep|rg|find|fd|tree|echo|which|file|stat|du|df|git (status|log|diff|show|branch|rev-parse))(\s|$)/;
const COMPOUND = /[;&|<>`]|\$\(/;

function needsApproval(toolName: string, input: Record<string, unknown>): string | null {
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

export default function (pi: any): void {
  if (process.env.ATLAS_PI_GUARD === "0") return;

  pi.on("tool_call", async (event: any, ctx: any) => {
    const title = needsApproval(event.toolName, event.input ?? {});
    if (!title) return undefined;
    const endpoint = readEndpoint();
    const parent = parentSession();
    if (!endpoint || !parent) return { block: true, reason: "Blocked: Atlas cannot be asked to approve it" };
    const detail =
      event.toolName === "bash"
        ? String(event.input?.command ?? "")
        : JSON.stringify(event.input ?? {}, null, 2).slice(0, 2000);
    try {
      const response = await fetch(`${endpoint.url}/v1/agents/approve`, {
        method: "POST",
        headers: { Authorization: `Bearer ${endpoint.key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: parent,
          session_file: ctx.sessionManager?.getSessionFile?.() ?? undefined,
          name: ctx.sessionManager?.getSessionName?.() ?? undefined,
          title,
          detail,
        }),
        signal: ctx.signal,
      });
      const body = (await response.json().catch(() => null)) as { ok?: boolean; result?: { allowed?: boolean } } | null;
      if (body?.ok && body.result?.allowed) return undefined;
      return { block: true, reason: "Denied by user in Atlas" };
    } catch {
      return { block: true, reason: "Blocked: Atlas did not answer" };
    }
  });
}
