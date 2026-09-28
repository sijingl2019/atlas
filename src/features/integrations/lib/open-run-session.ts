/**
 * Open the agent session an integration run used, in a chat tab.
 *
 * A run still going is a live session the BACKEND opened, like a subagent:
 * it is adopted into the chat store (the same way `subagents/lib/adopt.ts`
 * does) so its deltas stream into the tab. A finished run's session is
 * closed, so it opens from history like any past chat.
 */
import { useChatStore } from "@/features/chat/stores/chat-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { agents } from "@/features/chat/lib/agents-api";
import { openAgentSession } from "@/features/chat/lib/open-agent-session";
import { snapshotMessageToWire } from "@/features/chat/lib/snapshot-message";
import { agentTypeFromPluginId, type AgentStatus } from "@/types/agent";
import type { Integration, RunRecord } from "./integrations";

export async function openRunSession(integration: Integration, run: RunRecord): Promise<void> {
  const sessionId = run.sessionId;
  if (!sessionId) return;
  // Chat tabs belong to the active project.
  if (useProjectStore.getState().projects.some((p) => p.id === integration.projectId)) {
    await useProjectStore.getState().actions.switchTo(integration.projectId);
  }
  const agentType = agentTypeFromPluginId(run.agentId ?? integration.agentId);
  const title = `${run.issueKey} ${run.title}`;

  if (run.status !== "running" || !run.agentHandle) {
    await openAgentSession({
      acpSessionId: sessionId,
      title,
      cwd: integration.projectPath,
      agentType,
    });
    return;
  }

  const tabId = `integration-run:${sessionId}`;
  const chat = useChatStore.getState().actions;
  if (!useChatStore.getState().sessions[tabId]) {
    chat.adoptBackgroundSession({
      tabId,
      agentType,
      acpAgentId: run.agentHandle,
      acpSessionId: sessionId,
      cwd: integration.projectPath,
      title,
    });
    try {
      // Everything streamed before the adoption.
      const snap = await agents.snapshot({ agent_id: run.agentHandle, session_id: sessionId });
      chat.replaceMessages(tabId, snap.messages.map(snapshotMessageToWire));
      chat.hydrateSessionSnapshot(tabId, snap.status as AgentStatus, snap.plan);
    } catch {
      // The run ended between the click and the read: the tab shows what
      // arrives from here, and a reopen loads it from history.
    }
  }
  useLayoutStore.getState().actions.addTab({
    id: tabId,
    type: "chat",
    title: title.slice(0, 40),
    closable: true,
    dirty: false,
    data: {},
  });
}
