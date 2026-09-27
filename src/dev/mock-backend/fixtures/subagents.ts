// A stand-in for the subagent registry (`src-tauri/src/commands/subagents`).
// A scenario starts children with `spawnFakeSubagent`; each is a real fake
// session, so its transcript and permission requests travel as ordinary
// `atlas:agents` deltas, and its record is announced on `atlas:subagents` the
// way the backend's middleware would.

import { emit } from "@tauri-apps/api/event";
import type { SubagentEvent, SubagentStatus, SubagentView } from "@/types/subagents";
import type { TypedHandlers, Unit } from "../types";
import {
  finishTurn,
  inSession,
  openFakeSession,
  playTranscript,
  recordPrompt,
  setPermissionResolvedHook,
  setStatus,
} from "../fake-agent";
import { text, user } from "./chat";

const records = new Map<string, SubagentView>();

function announce(event: SubagentEvent): Promise<void> {
  return emit("atlas:subagents", event);
}

function byName(name: string): SubagentView | undefined {
  return [...records.values()].find((r) => r.name === name);
}

/** Change a record and announce it. */
export function updateSubagent(name: string, patch: Partial<SubagentView>): Promise<void> {
  const record = byName(name);
  if (!record) return Promise.resolve();
  const next = { ...record, ...patch, updated_at: new Date().toISOString() };
  records.set(next.id, next);
  return announce({ kind: "upsert", record: next });
}

export function setSubagentStatus(name: string, status: SubagentStatus): Promise<void> {
  return updateSubagent(name, { status });
}

/** Start a child of `parentSessionId` and announce it. Returns its session id. */
export async function spawnFakeSubagent(opts: {
  parentSessionId: string;
  name: string;
  kind: string;
  task: string;
  cwd?: string;
}): Promise<string> {
  const cwd = opts.cwd ?? "/Users/dev/acme-app";
  const key = openFakeSession(opts.kind, cwd);
  const now = new Date().toISOString();
  const record: SubagentView = {
    id: `sub-${key.session_id}`,
    name: opts.name,
    kind: opts.kind,
    task: opts.task,
    status: "working",
    parent_session_id: opts.parentSessionId,
    child_session_id: key.session_id,
    agent_handle: key.agent_id,
    cwd,
    tool_count: 0,
    mirror: false,
    denied_count: 0,
    pending_approvals: [],
    created_at: now,
    updated_at: now,
  };
  records.set(record.id, record);
  await announce({ kind: "upsert", record });
  await announce({ kind: "prompted", child_session_id: key.session_id, text: opts.task });
  recordPrompt(key.session_id, user(opts.task, now));
  await inSession(key.session_id, () => setStatus("running"));
  return key.session_id;
}

/** Stream a line from a child and optionally end its turn. */
export async function subagentSays(name: string, line: string, finish = false): Promise<void> {
  const record = byName(name);
  if (!record) return;
  await inSession(record.child_session_id, async () => {
    await playTranscript([text(line, new Date().toISOString())]);
    if (finish) await finishTurn();
  });
  if (finish) await setSubagentStatus(name, "done");
}

// A child's answered permission moves its record as the backend would.
setPermissionResolvedHook((sessionId, allowed) => {
  const record = [...records.values()].find((r) => r.child_session_id === sessionId);
  if (!record) return;
  void updateSubagent(record.name, {
    status: "done",
    pending_approvals: [],
    denied_count: record.denied_count + (allowed ? 0 : 1),
  });
});

/** The parent session of the child with `childSessionId`. */
export function parentOf(childSessionId: string | undefined): string | undefined {
  return [...records.values()].find((r) => r.child_session_id === childSessionId)
    ?.parent_session_id;
}

export interface SubagentsResponses {
  subagents_list: SubagentView[];
  subagents_mark_seen: Unit;
  subagents_stop: Unit;
  subagents_stop_all: Unit;
  subagents_prompt: Unit;
}

async function stop(id: string, remove: boolean): Promise<void> {
  const record = records.get(id);
  if (!record) return;
  if (remove) {
    records.delete(id);
    await announce({
      kind: "removed",
      id,
      child_session_id: record.child_session_id,
      parent_session_id: record.parent_session_id,
    });
    return;
  }
  await setSubagentStatus(record.name, "stopped");
}

export const subagentsHandlers: TypedHandlers<SubagentsResponses> = {
  subagents_list: () => [...records.values()],
  subagents_mark_seen: ({ id }) => {
    const record = records.get(id);
    if (record?.status === "done") void setSubagentStatus(record.name, "idle");
    return null;
  },
  subagents_stop: ({ id, remove }) => {
    void stop(id, !!remove);
    return null;
  },
  subagents_stop_all: ({ parentSessionId }) => {
    // `stop` deletes as it goes, so walk the ids first.
    const ids = Array.from(records.values(), (r) =>
      r.parent_session_id === parentSessionId ? r.id : null,
    );
    for (const id of ids) if (id) void stop(id, true);
    return null;
  },
  subagents_prompt: ({ id, text: prompt }) => {
    const record = records.get(id);
    if (!record) return null;
    void (async () => {
      await announce({ kind: "prompted", child_session_id: record.child_session_id, text: prompt });
      await setSubagentStatus(record.name, "working");
      recordPrompt(record.child_session_id, user(prompt, new Date().toISOString()));
      await inSession(record.child_session_id, () => setStatus("running"));
      await new Promise((r) => setTimeout(r, 600));
      await subagentSays(record.name, `(mock) On it: ${prompt}`, true);
    })();
    return null;
  },
};
