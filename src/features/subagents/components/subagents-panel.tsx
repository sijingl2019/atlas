import { Fragment, useCallback, useMemo, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { useIsTabVisible } from "@/features/layout/lib/use-tab-visible";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { stripInjectedContext } from "@/features/chat/lib/atlas-context";
import { rollupStatus } from "@/types/subagents";
import { useChildrenOf, useParentSessionIds, useSubagentsStore } from "../stores/subagents-store";
import { subagentsApi } from "../lib/subagents-api";
import { AgentColumn, StatusGlyph, STATUS_LABEL } from "./agent-column";

/** The title of the chat that owns `acpSessionId`, when one is open. */
function useParentTitle(acpSessionId: string | null): string | null {
  return useChatStore((s) => {
    if (!acpSessionId) return null;
    for (const session of Object.values(s.sessions)) {
      if (session.acpSessionId === acpSessionId) {
        const title = stripInjectedContext(session.title).trim();
        return title && title !== "New Chat" ? title : "Chat";
      }
    }
    return null;
  });
}

function ParentPill({
  parentSessionId,
  selected,
  onSelect,
}: {
  parentSessionId: string;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const title = useParentTitle(parentSessionId) ?? "Chat";
  const children = useChildrenOf(parentSessionId);
  const status = rollupStatus(children.map((c) => c.status));
  return (
    <button
      type="button"
      onClick={() => onSelect(parentSessionId)}
      className={cn(
        "flex max-w-[200px] items-center gap-1.5 rounded px-2 h-6 text-xs cursor-pointer",
        selected
          ? "bg-[var(--atlas-element-hover)] text-[var(--foreground)]"
          : "text-[var(--muted-foreground)] hover:text-[var(--foreground)]",
      )}
    >
      {status ? <StatusGlyph status={status} /> : null}
      <span className="truncate">{title}</span>
      <span className="tabular-nums opacity-70">{children.length}</span>
    </button>
  );
}

/**
 * The Subagents panel: one parent chat's subagents side by side, each a
 * column with its live transcript, status, counts and inline approval — the
 * Atlas take on herdr's agents tab. Parents with children are listed across
 * the top when there is more than one.
 */
export function SubagentsPanel({ tabId }: { tabId: string }) {
  const visible = useIsTabVisible(tabId);
  const parents = useParentSessionIds();
  const focusedParent = useSubagentsStore.use.focusedParent();
  const { focusParent } = useSubagentsStore.use.actions();
  const parent =
    focusedParent && parents.includes(focusedParent) ? focusedParent : (parents[0] ?? null);
  const children = useChildrenOf(parent);
  const parentTitle = useParentTitle(parent);
  const [focusedChild, setFocusedChild] = useState<string | null>(null);

  // The keyboard goes to the chosen column, else the first child that is
  // waiting on the user, else the first.
  const keyboardId = useMemo(() => {
    if (focusedChild && children.some((c) => c.id === focusedChild)) return focusedChild;
    return (children.find((c) => c.status === "blocked") ?? children[0])?.id ?? null;
  }, [children, focusedChild]);

  const onFocus = useCallback((id: string) => setFocusedChild(id), []);
  const status = rollupStatus(children.map((c) => c.status));
  const live = children.some((c) => c.status !== "stopped");

  if (!parent) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-sm space-y-2 text-center">
          <Users size={20} className="mx-auto text-[var(--muted-foreground)]" />
          <p className="text-sm text-[var(--foreground)]">No subagents</p>
          <p className="text-xs text-[var(--muted-foreground)]">
            Ask an agent to start subagents with its Atlas agent tools (agent_start). Each one
            appears here as a column you can watch and approve.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        {status ? <StatusGlyph status={status} /> : null}
        <span className="truncate text-sm text-[var(--foreground)]">
          {parentTitle ?? "Subagents"}
        </span>
        <span className="shrink-0 text-xs text-[var(--muted-foreground)]">
          {children.length} {children.length === 1 ? "subagent" : "subagents"}
          {status ? ` · ${STATUS_LABEL[status]}` : ""}
        </span>
        {parents.length > 1 ? (
          <div className="ml-2 flex min-w-0 items-center gap-1 overflow-x-auto">
            {parents.map((id) => (
              <ParentPill
                key={id}
                parentSessionId={id}
                selected={id === parent}
                onSelect={focusParent}
              />
            ))}
          </div>
        ) : null}
        {live ? (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => void subagentsApi.stopAll(parent)}
          >
            Stop all
          </Button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1">
        {children.length === 0 ? null : (
          <Group
            // Keyed by the set of columns so a new child re-lays out evenly.
            key={`${parent}:${children.map((c) => c.id).join(",")}`}
            orientation="horizontal"
            className="h-full"
          >
            {children.map((child, i) => (
              <Fragment key={child.id}>
                {i > 0 && (
                  <Separator className="w-px cursor-col-resize bg-border transition-colors hover:bg-primary data-[separator=active]:bg-primary" />
                )}
                <Panel id={child.id} minSize="15" className="min-h-0 min-w-0">
                  <AgentColumn
                    record={child}
                    visible={visible}
                    focused={visible && keyboardId === child.id}
                    onFocus={onFocus}
                  />
                </Panel>
              </Fragment>
            ))}
          </Group>
        )}
      </div>
    </div>
  );
}
