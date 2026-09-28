import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { comparablePath } from "@/features/projects/lib/sidebar-sessions";
import { isSubagentTabId } from "@/types/subagents";
import type { AgentType } from "@/types/agent";
import { useChatStore } from "../stores/chat-store";
import { resumeIntoTab } from "./open-agent-session";

/**
 * Chat tabs across a restart.
 *
 * The layout file brings the tabs back, not what they showed. This keeps, per
 * chat tab, the session it was bound to — and whether it was waiting on an
 * approval — and when a project's tabs load, each one resumes its session in
 * place. A chat that was waiting is told to go on, so the agent asks again:
 * the request it was waiting on died with its process. One that was mid-turn
 * is only reopened; whether it goes on is the user's call.
 *
 * Subagents come back through the backend (`subagents/persist.rs`).
 */

const KEY = "atlas.chat-restore.v1";

export const RETRY_AFTER_RESTART =
  "Atlas was restarted while you were waiting for my approval, and that request was lost. Retry the action you were about to take, then continue.";

interface Saved {
  sessionId: string;
  agentType: AgentType;
  cwd: string;
  title: string;
  blocked: boolean;
}

let cache: Record<string, Saved> | null = null;

function saved(): Record<string, Saved> {
  if (cache) return cache;
  try {
    cache = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, Saved>;
  } catch {
    cache = {};
  }
  return cache;
}

function flush(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(saved()));
  } catch {
    // Best-effort: the tab just comes back empty.
  }
}

const same = (a: Saved | undefined, b: Saved) =>
  !!a &&
  a.sessionId === b.sessionId &&
  a.agentType === b.agentType &&
  a.cwd === b.cwd &&
  a.title === b.title &&
  a.blocked === b.blocked;

/** Keep the saved map in step with the chat store. Returns the unsubscribe. */
export function startChatRestoreTracking(): () => void {
  return useChatStore.subscribe((s) => {
    // Tabs not in the store (another project's, not loaded yet) keep their
    // entry; `restoreChatTabs` prunes the closed ones.
    const map = saved();
    let changed = false;
    for (const [tabId, session] of Object.entries(s.sessions)) {
      if (isSubagentTabId(tabId)) continue;
      // Mid-resume, or a dead process (which clears the approval it was
      // waiting on — at the quit, what was saved before it died is the truth).
      if (session.resumePending || session.transcriptLoading || session.disconnected) continue;
      // An empty chat keeps the tab's last entry: at boot every restored tab
      // mounts one before its session is resumed.
      const sessionId = session.acpSessionId;
      if (!sessionId || session.messages.length === 0) continue;
      const entry: Saved = {
        sessionId,
        agentType: session.agentType,
        cwd: session.workingDirectory,
        title: session.title,
        blocked: !!s.pendingPermissions[sessionId]?.length,
      };
      if (same(map[tabId], entry)) continue;
      map[tabId] = entry;
      changed = true;
    }
    if (changed) flush();
  });
}

/**
 * Resume the saved session of every chat tab of `projectPath` that is open
 * and unbound. Called once the project's tabs have loaded; a warm project's
 * tabs are bound already and are left alone.
 */
export function restoreChatTabs(projectPath: string): void {
  const map = saved();
  const open = new Set(
    useLayoutStore
      .getState()
      .tabs.filter((t) => t.type === "chat")
      .map((t) => t.id),
  );
  const project = comparablePath(projectPath);
  let pruned = false;
  for (const [tabId, entry] of Object.entries(map)) {
    if (comparablePath(entry.cwd) !== project) continue;
    if (!open.has(tabId)) {
      delete map[tabId];
      pruned = true;
      continue;
    }
    const chat = useChatStore.getState();
    if (chat.sessions[tabId]?.acpSessionId) continue;
    if (!chat.sessions[tabId]) chat.actions.createSession(tabId);
    void resumeIntoTab(tabId, {
      acpSessionId: entry.sessionId,
      title: entry.title,
      cwd: entry.cwd,
      agentType: entry.agentType,
    }).then((result) => {
      if (!result.ok || !entry.blocked) return;
      // The chat panel sends it like a typed message.
      window.dispatchEvent(
        new CustomEvent("atlas:chat-send", { detail: { tabId, text: RETRY_AFTER_RESTART } }),
      );
    });
  }
  if (pruned) flush();
}
