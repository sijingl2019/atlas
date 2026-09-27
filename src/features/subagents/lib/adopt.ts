import { useChatStore } from "@/features/chat/stores/chat-store";
import { agents } from "@/features/chat/lib/agents-api";
import { snapshotMessageToWire } from "@/features/chat/lib/snapshot-message";
import { agentTypeFromPluginId, type AgentStatus } from "@/types/agent";
import { subagentTabId, type SubagentEvent, type SubagentView } from "@/types/subagents";
import { useSubagentsStore } from "../stores/subagents-store";
import { listenSubagents, subagentsApi } from "./subagents-api";

/**
 * Keeps the frontend's picture of the subagents in step with the backend.
 *
 * A child is a session the BACKEND opened, so no tab exists for it: on first
 * sight it is adopted into the chat store under `subagent:<session id>`
 * (bound, not active), and from then on every `atlas:agents` delta routes to
 * it like any chat's. The snapshot read right after adoption covers whatever
 * the child streamed before it was adopted.
 */

async function adopt(record: SubagentView): Promise<void> {
  const tabId = subagentTabId(record.child_session_id);
  // Adoption is synchronous, so the session's presence is what says it was
  // already done — and a mirror dropped since (a discarded project) is
  // adopted again on the child's next update.
  if (useChatStore.getState().sessions[tabId]) return;
  const chat = useChatStore.getState().actions;
  chat.adoptBackgroundSession({
    tabId,
    agentType: agentTypeFromPluginId(record.kind),
    acpAgentId: record.agent_handle,
    acpSessionId: record.child_session_id,
    cwd: record.cwd,
    title: record.name,
  });
  // A mirrored child has no backend session to read: its transcript arrives
  // only as deltas, from the moment it was first reported.
  if (record.mirror) return;
  try {
    const snap = await agents.snapshot({
      agent_id: record.agent_handle,
      session_id: record.child_session_id,
    });
    const messages = snap.messages.map(snapshotMessageToWire);
    // The first prompt is not a delta: when the snapshot predates it, the
    // `prompted` event's copy is the one to keep.
    const local = useChatStore.getState().sessions[tabId]?.messages ?? [];
    if (messages.length >= local.length) chat.replaceMessages(tabId, messages);
    chat.hydrateSessionSnapshot(tabId, snap.status as AgentStatus, snap.plan);
  } catch {
    // A child that closed before its snapshot was read: its `removed` event
    // is on the way.
  }
}

function addPrompt(childSessionId: string, text: string): void {
  const tabId = subagentTabId(childSessionId);
  const store = useChatStore.getState();
  const session = store.sessions[tabId];
  if (!session) return;
  const last = [...session.messages].reverse().find((m) => m.role === "user");
  if (last?.content === text) return;
  store.actions.addMessage(tabId, "user", text);
}

export function applySubagentEvent(event: SubagentEvent): void {
  const store = useSubagentsStore.getState().actions;
  switch (event.kind) {
    case "upsert":
      // No tab is opened here: the chat's floating list announces the
      // child, and a click there opens its detail.
      store.upsert(event.record);
      void adopt(event.record);
      return;
    case "prompted":
      addPrompt(event.child_session_id, event.text);
      return;
    case "removed": {
      store.remove(event.id);
      const tabId = subagentTabId(event.child_session_id);
      // The backend already closed the session; this drops the local mirror.
      useChatStore.getState().actions.removeSession(tabId);
      return;
    }
  }
}

/** Subscribe for the life of the window. Returns the unsubscribe. */
export function startSubagentSync(): () => void {
  let cancelled = false;
  let unlisten: (() => void) | undefined;
  void listenSubagents((event) => {
    if (!cancelled) applySubagentEvent(event);
  }).then((fn) => {
    if (cancelled) fn();
    else unlisten = fn;
  });
  // After a webview reload the backend still has its children; take them back.
  void subagentsApi
    .list()
    .then((records) => {
      if (cancelled) return;
      useSubagentsStore.getState().actions.resync(records);
      for (const record of records) void adopt(record);
    })
    .catch(() => {});
  return () => {
    cancelled = true;
    unlisten?.();
  };
}
