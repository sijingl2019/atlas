/**
 * Open the agent session a background run used, in a chat tab: an
 * integration's issue run, or a scheduled task's run.
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

export interface BackgroundSession {
  sessionId: string;
  /** Live process handle; absent once the run ended. */
  agentHandle?: string | null;
  running: boolean;
  pluginId: string;
  cwd: string;
  /** Switched to first when it is one of the user's projects. */
  projectId?: string;
  title: string;
  /** Prefix of the adopted tab's id. */
  tabPrefix: string;
}

export async function openBackgroundSession(s: BackgroundSession): Promise<void> {
  // Chat tabs belong to the active project.
  const projects = useProjectStore.getState();
  const projectId =
    s.projectId ?? projects.projects.find((p) => samePath(p.path, s.cwd))?.id ?? undefined;
  if (projectId && projects.projects.some((p) => p.id === projectId)) {
    await projects.actions.switchTo(projectId);
  }
  const agentType = agentTypeFromPluginId(s.pluginId);

  if (!s.running || !s.agentHandle) {
    await openAgentSession({ acpSessionId: s.sessionId, title: s.title, cwd: s.cwd, agentType });
    return;
  }

  const tabId = `${s.tabPrefix}:${s.sessionId}`;
  const chat = useChatStore.getState().actions;
  if (!useChatStore.getState().sessions[tabId]) {
    chat.adoptBackgroundSession({
      tabId,
      agentType,
      acpAgentId: s.agentHandle,
      acpSessionId: s.sessionId,
      cwd: s.cwd,
      title: s.title,
    });
    try {
      // Everything streamed before the adoption.
      const snap = await agents.snapshot({ agent_id: s.agentHandle, session_id: s.sessionId });
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
    title: s.title.slice(0, 40),
    closable: true,
    dirty: false,
    data: {},
  });
}

const samePath = (a: string, b: string) => {
  const n = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return n(a) === n(b);
};

export async function openRunSession(integration: Integration, run: RunRecord): Promise<void> {
  if (!run.sessionId) return;
  await openBackgroundSession({
    sessionId: run.sessionId,
    agentHandle: run.agentHandle,
    running: run.status === "running",
    pluginId: run.agentId ?? integration.agentId,
    cwd: integration.projectPath,
    projectId: integration.projectId,
    title: `${run.issueKey} ${run.title}`,
    tabPrefix: "integration-run",
  });
}
