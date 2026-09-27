// @vitest-environment happy-dom
//
// A subagent is a session the backend opened, so nothing in the frontend
// asked for it. On first sight it is adopted into the chat store — bound, but
// never made the active chat — and from then on its deltas, its prompts and
// its removal reach it like any chat's.

import { beforeEach, describe, expect, it, vi } from "vitest";

const snapshot = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: unknown) =>
    cmd === "agents_snapshot" ? snapshot(args) : undefined,
  ),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

import { useChatStore } from "@/features/chat/stores/chat-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { subagentTabId, rollupStatus, type SubagentView } from "@/types/subagents";
import { useSubagentsStore, childrenOf } from "../stores/subagents-store";
import { applySubagentEvent } from "./adopt";

function record(over: Partial<SubagentView> = {}): SubagentView {
  return {
    id: "rec-1",
    name: "lister",
    kind: "codex-acp",
    task: "list files",
    status: "working",
    parent_session_id: "parent",
    child_session_id: "child-1",
    agent_handle: "agent-1",
    cwd: "/work",
    tool_count: 0,
    mirror: false,
    denied_count: 0,
    pending_approvals: [],
    created_at: "2026-09-27T00:00:00Z",
    updated_at: "2026-09-27T00:00:00Z",
    ...over,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("subagent adoption", () => {
  beforeEach(() => {
    localStorage.clear();
    snapshot.mockReset();
    snapshot.mockResolvedValue({ messages: [], status: "running", plan: [] });
    useChatStore.setState({ sessions: {}, queues: {}, activeSessionId: "parent-tab" });
    useSubagentsStore.setState({ records: {}, focusedParent: null });
  });

  it("adopts a child bound to its session without making it the active chat", async () => {
    applySubagentEvent({ kind: "upsert", record: record() });
    await tick();
    const tabId = subagentTabId("child-1");
    const session = useChatStore.getState().sessions[tabId];
    expect(session?.acpSessionId).toBe("child-1");
    expect(session?.acpAgentId).toBe("agent-1");
    expect(session?.workingDirectory).toBe("/work");
    expect(useChatStore.getState().activeSessionId).toBe("parent-tab");
    expect(useSubagentsStore.getState().records["rec-1"]?.name).toBe("lister");
  });

  it("routes the child's deltas to it once adopted", async () => {
    applySubagentEvent({ kind: "upsert", record: record() });
    await tick();
    useChatStore.getState().actions.applyAgentDelta({
      kind: "message_appended",
      agent_id: "agent-1",
      session_id: "child-1",
      message: {
        id: "m-1",
        role: "assistant",
        mode: "text",
        content: "README.md, src/",
        tool_calls: [],
        timestamp: "2026-09-27T00:00:01Z",
      },
    });
    const messages = useChatStore.getState().sessions[subagentTabId("child-1")]?.messages ?? [];
    expect(messages[messages.length - 1]?.content).toBe("README.md, src/");
  });

  it("shows a host-sent prompt once, even when the snapshot already has it", async () => {
    applySubagentEvent({ kind: "upsert", record: record() });
    await tick();
    applySubagentEvent({ kind: "prompted", child_session_id: "child-1", text: "list files" });
    applySubagentEvent({ kind: "prompted", child_session_id: "child-1", text: "list files" });
    const messages = useChatStore.getState().sessions[subagentTabId("child-1")]?.messages ?? [];
    expect(messages.filter((m) => m.role === "user")).toHaveLength(1);
  });

  it("adopts a mirrored child without reading a snapshot it does not have", async () => {
    applySubagentEvent({
      kind: "upsert",
      record: record({ id: "m-1", child_session_id: "mirror:1", mirror: true }),
    });
    await tick();
    expect(useChatStore.getState().sessions[subagentTabId("mirror:1")]?.acpSessionId).toBe(
      "mirror:1",
    );
    expect(snapshot).not.toHaveBeenCalled();
  });

  it("drops the child's mirror when it is removed", async () => {
    applySubagentEvent({ kind: "upsert", record: record() });
    await tick();
    applySubagentEvent({
      kind: "removed",
      id: "rec-1",
      child_session_id: "child-1",
      parent_session_id: "parent",
    });
    expect(useChatStore.getState().sessions[subagentTabId("child-1")]).toBeUndefined();
    expect(useSubagentsStore.getState().records["rec-1"]).toBeUndefined();
  });

  it("does not open a tab on its own: the chat's floating list announces it", async () => {
    applySubagentEvent({ kind: "upsert", record: record() });
    await tick();
    expect(useLayoutStore.getState().tabs.some((t) => t.type === "subagents")).toBe(false);
  });
});

describe("rollup and grouping", () => {
  it("puts blocked first, then error, done and working", () => {
    expect(rollupStatus(["working", "done", "idle"])).toBe("done");
    expect(rollupStatus(["working", "blocked", "error"])).toBe("blocked");
    expect(rollupStatus(["idle", "working"])).toBe("working");
    expect(rollupStatus([])).toBeNull();
  });

  it("lists one parent's children oldest first", () => {
    const records = {
      b: record({ id: "b", created_at: "2026-09-27T00:00:02Z" }),
      a: record({ id: "a", created_at: "2026-09-27T00:00:01Z" }),
      x: record({ id: "x", parent_session_id: "other" }),
    };
    expect(childrenOf(records, "parent").map((r) => r.id)).toEqual(["a", "b"]);
    expect(childrenOf(records, null)).toEqual([]);
  });
});
