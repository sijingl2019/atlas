/**
 * Subagents: agents another agent started through Atlas's `atlas_agents`
 * tools (the herdr model). Each one is an ordinary ACP session; these types
 * are the parent → child link and the status the Agents panel shows.
 *
 * Mirrors `src-tauri/src/commands/subagents/model.rs`.
 */

export type SubagentStatus =
  | "starting"
  | "working"
  /** Waiting on a permission only the user can answer. */
  | "blocked"
  /** Settled and seen. */
  | "idle"
  /** Settled and not yet seen. */
  | "done"
  | "error"
  | "stopped";

export interface PendingApproval {
  request_id: string;
  title: string;
}

export interface SubagentView {
  id: string;
  name: string;
  /** Plugin id of the child's agent, e.g. `codex-acp`. */
  kind: string;
  task: string;
  status: SubagentStatus;
  parent_session_id: string;
  child_session_id: string;
  /** The child's per-process agent handle (its session key's `agent_id`). */
  agent_handle: string;
  cwd: string;
  tool_count: number;
  denied_count: number;
  pending_approvals: PendingApproval[];
  last_error?: string;
  created_at: string;
  updated_at: string;
  /** Reported by a pi extension (pi-subagents) rather than hosted by Atlas:
   *  its transcript is mirrored, and it cannot be prompted or stopped here. */
  mirror: boolean;
}

export type SubagentEvent =
  | { kind: "upsert"; record: SubagentView }
  | { kind: "removed"; id: string; child_session_id: string; parent_session_id: string }
  | { kind: "prompted"; child_session_id: string; text: string };

const TAB_PREFIX = "subagent:";

/** The chat-store key a child session lives under. It is never a layout tab:
 *  the Agents panel renders it in a column. */
export function subagentTabId(childSessionId: string): string {
  return TAB_PREFIX + childSessionId;
}

export function isSubagentTabId(tabId: string | null | undefined): boolean {
  return !!tabId && tabId.startsWith(TAB_PREFIX);
}

/** herdr's rollup: what a group of children says at a glance. */
const RANK: Record<SubagentStatus, number> = {
  blocked: 6,
  error: 5,
  done: 4,
  working: 3,
  starting: 2,
  idle: 1,
  stopped: 0,
};

export function rollupStatus(statuses: SubagentStatus[]): SubagentStatus | null {
  let best: SubagentStatus | null = null;
  for (const s of statuses) if (best === null || RANK[s] > RANK[best]) best = s;
  return best;
}
