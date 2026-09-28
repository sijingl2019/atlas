import { lazy, memo, Suspense, useCallback, useEffect, useState } from "react";
import { Square, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { IconButton } from "@/ui/icon-button";
import { AtlasLoader } from "@/components/atlas-loader";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { agentMeta } from "@/features/agents/lib/agent-meta";
import { isBusyAgentStatus } from "@/types/agent";
import { subagentTabId, type SubagentStatus, type SubagentView } from "@/types/subagents";
import { subagentsApi } from "../lib/subagents-api";

const Transcript = lazy(() =>
  import("@/features/chat/components/transcript").then((m) => ({ default: m.Transcript })),
);

const STATUS_LABEL: Record<SubagentStatus, string> = {
  starting: "Starting",
  working: "Working",
  blocked: "Needs approval",
  done: "Done",
  idle: "Idle",
  error: "Error",
  stopped: "Stopped",
};

/**
 * One subagent's state at a glance. House rule: colour only for the running
 * glyph and what needs the user — blocked (warning) and failed (error).
 */
export function StatusGlyph({ status }: { status: SubagentStatus }) {
  if (status === "working" || status === "starting") {
    return <AtlasLoader size={10} className="shrink-0 text-[var(--primary)]" />;
  }
  return (
    <span
      aria-hidden
      className={cn(
        "size-2 shrink-0 rounded-full",
        status === "blocked" && "atlas-live-pulse bg-[var(--atlas-status-warning-foreground)]",
        status === "error" && "bg-[var(--atlas-status-error-foreground)]",
        status === "done" && "bg-[var(--foreground)]",
        (status === "idle" || status === "stopped") && "bg-[var(--muted-foreground)] opacity-50",
      )}
      style={
        status === "blocked"
          ? {
              ["--atlas-pulse-color" as string]:
                "color-mix(in oklab, var(--atlas-status-warning-foreground) 40%, transparent)",
            }
          : undefined
      }
    />
  );
}

export { STATUS_LABEL };

/**
 * One subagent as a column: who it is and what it is doing (header), its live
 * transcript, whether it waits on an approval (answered in the parent chat),
 * and a footer with its counts and a follow-up input.
 */
export const AgentColumn = memo(function AgentColumn({
  record,
  visible,
  focused,
  onFocus,
  onDismiss,
}: {
  record: SubagentView;
  visible: boolean;
  focused: boolean;
  onFocus: (id: string) => void;
  /** Shown as a detail beside the chat: ✕ closes the detail rather than
   *  closing the subagent. */
  onDismiss?: () => void;
}) {
  const tabId = subagentTabId(record.child_session_id);
  const messages = useChatStore((s) => s.sessions[tabId]?.messages);
  const chatStatus = useChatStore((s) => s.sessions[tabId]?.status ?? "idle");
  const agentType = useChatStore((s) => s.sessions[tabId]?.agentType);
  const pendingCount = useChatStore(
    (s) => s.pendingPermissions[record.child_session_id]?.length ?? 0,
  );
  const [followUp, setFollowUp] = useState("");

  // Looking at a finished child is what makes it "seen" (done → idle).
  useEffect(() => {
    if (visible && record.status === "done") void subagentsApi.markSeen(record.id);
  }, [visible, record.status, record.id]);

  const settled = record.status === "done" || record.status === "idle" || record.status === "error";
  const running = record.status === "working" || record.status === "starting";

  const sendFollowUp = useCallback(() => {
    const text = followUp.trim();
    if (!text) return;
    setFollowUp("");
    subagentsApi.prompt(record.id, text).catch((e) => toast.error(String(e)));
  }, [followUp, record.id]);

  return (
    <section
      aria-label={`Subagent ${record.name}`}
      onPointerDownCapture={() => onFocus(record.id)}
      className={cn(
        "flex h-full min-w-0 flex-col",
        // Which of several columns owns the keyboard. A detail is the only
        // one on screen, so it carries no marker.
        !onDismiss && "border-t-2",
        !onDismiss && (focused ? "border-[var(--atlas-border-strong)]" : "border-transparent"),
      )}
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <StatusGlyph status={record.status} />
        <span className="truncate text-sm font-medium text-[var(--foreground)]">{record.name}</span>
        <span className="truncate text-xs text-[var(--muted-foreground)]">
          {agentMeta(record.kind).label} · {STATUS_LABEL[record.status]}
        </span>
        <span className="ml-auto flex items-center gap-0.5">
          {/* Not in a detail: its square read as "maximize", and the header
              there keeps only the ✕ that closes it. */}
          {!onDismiss && !record.mirror && (running || record.status === "blocked") ? (
            <IconButton
              icon={Square}
              label="Stop"
              size="xs"
              variant="ghost"
              onClick={() => void subagentsApi.stop(record.id)}
            />
          ) : null}
          {onDismiss ? (
            <IconButton
              icon={X}
              label="Close details"
              size="xs"
              variant="ghost"
              onClick={onDismiss}
            />
          ) : (
            <IconButton
              icon={X}
              label="Close subagent"
              size="xs"
              variant="ghost"
              onClick={() => void subagentsApi.stop(record.id, true)}
            />
          )}
        </span>
      </header>
      <p
        className="shrink-0 truncate border-b border-border px-3 py-1.5 text-xs text-[var(--muted-foreground)]"
        title={record.task}
      >
        {record.task}
      </p>
      {/* A flex column that clips, as in the chat panel: the transcript's rows
          are positioned, and without the clip they overflowed onto the
          permission card below and took its clicks. */}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {messages ? (
          <Suspense fallback={null}>
            <Transcript
              tabId={tabId}
              acpSessionId={record.child_session_id}
              messages={messages}
              isStreaming={chatStatus === "running"}
              turnInProgress={isBusyAgentStatus(chatStatus)}
              agentType={agentType}
              visibleOverride={visible}
            />
          </Suspense>
        ) : null}
      </div>
      {/* Approvals are answered in the parent chat, like its own; here the
          column only says it is waiting. */}
      {pendingCount > 0 ? (
        <p className="shrink-0 truncate border-t border-border px-3 py-1.5 text-xs text-[var(--atlas-status-warning-foreground)]">
          Waiting for approval in the parent chat
          {pendingCount > 1 ? ` (${pendingCount})` : ""}
        </p>
      ) : null}
      {record.last_error && record.status === "error" ? (
        <p className="shrink-0 truncate px-3 py-1 text-xs text-[var(--atlas-status-error-foreground)]">
          {record.last_error}
        </p>
      ) : null}
      <footer className="flex h-9 shrink-0 items-center gap-2 border-t border-border px-3 text-xs text-[var(--muted-foreground)]">
        <span className="shrink-0 tabular-nums">
          {record.tool_count} {record.tool_count === 1 ? "tool" : "tools"}
          {" · "}
          {record.denied_count} denied
        </span>
        {record.mirror ? (
          <span className="truncate">via pi-subagents</span>
        ) : settled ? (
          <input
            value={followUp}
            onChange={(e) => setFollowUp(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                sendFollowUp();
              }
            }}
            placeholder="Follow up…"
            aria-label={`Follow up with ${record.name}`}
            className="min-w-0 flex-1 bg-transparent text-xs text-[var(--foreground)] outline-none placeholder:text-[var(--muted-foreground)]"
          />
        ) : null}
      </footer>
    </section>
  );
});
