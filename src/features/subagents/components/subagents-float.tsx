import { memo, useCallback, useState } from "react";
import { ChevronDown, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { agentMeta } from "@/features/agents/lib/agent-meta";
import { rollupStatus, type SubagentView } from "@/types/subagents";
import { useChildrenOf, useSubagentsStore } from "../stores/subagents-store";
import { AgentColumn, StatusGlyph, STATUS_LABEL } from "./agent-column";

/**
 * The subagents a chat has started, floating at the chat's right edge, and
 * the one the user opened, docked beside it.
 *
 * Wide enough, the list sits in the gutter beside the transcript column and
 * stays open; in a narrower chat it folds to a chip. A row opens that child's
 * detail — its live transcript, status and approval card — to the list's left;
 * the list keeps its place at the edge. Nothing opens in a tab.
 *
 * Renders nothing until the chat's session has a child.
 */
export const SubagentsFloat = memo(function SubagentsFloat({
  parentSessionId,
  visible,
}: {
  parentSessionId: string | undefined;
  /** Whether the chat itself is on screen (drives the detail's live view). */
  visible: boolean;
}) {
  const children = useChildrenOf(parentSessionId);
  const detail = useSubagentsStore.use.detail();
  const { openDetail, closeDetail, focusChild } = useSubagentsStore.use.actions();
  const [open, setOpen] = useState(false);
  const onFocus = useCallback((id: string) => focusChild(id), [focusChild]);
  if (!parentSessionId || children.length === 0) return null;
  const status = rollupStatus(children.map((c) => c.status));
  const waiting = children.filter((c) => c.status === "blocked").length;
  const selected =
    detail?.parentSessionId === parentSessionId
      ? children.find((c) => c.id === detail.childId)
      : undefined;

  const list = (
    <SubagentList
      agents={children}
      waiting={waiting}
      selectedId={selected?.id}
      onSelect={(id) => (selected?.id === id ? closeDetail() : openDetail(parentSessionId, id))}
    />
  );

  return (
    // Its own container, sized by the chat: the breakpoints are the chat's
    // width, not the window's, so a split column gets the chip.
    <div className="pointer-events-none absolute inset-0 z-10 @container">
      <div className="absolute top-16 right-4 bottom-4 flex items-start justify-end gap-3">
        {selected ? (
          // Left of the list, which keeps its place at the edge: whatever the
          // list and the margins leave, up to 640px.
          <div className="pointer-events-auto h-full w-[min(640px,calc(100cqw-19rem))] min-w-[320px] overflow-hidden rounded-lg border border-border bg-[var(--background)] shadow-lg">
            <AgentColumn
              record={selected}
              visible={visible}
              focused={visible}
              onFocus={onFocus}
              onDismiss={closeDetail}
            />
          </div>
        ) : null}
        {selected ? (
          // With a detail open the list stays open too: it is how the user
          // moves between children.
          <div className="pointer-events-auto w-60 shrink-0">{list}</div>
        ) : (
          <>
            <div className="pointer-events-auto hidden w-60 @min-[1360px]:block">{list}</div>
            <div className="pointer-events-auto flex flex-col items-end gap-1.5 @min-[1360px]:hidden">
              <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                aria-expanded={open}
                className="flex h-7 cursor-pointer items-center gap-1.5 rounded-full border border-border bg-[var(--background)] px-2.5 text-xs text-[var(--secondary-foreground)] shadow-sm hover:text-[var(--foreground)]"
              >
                {status ? <StatusGlyph status={status} /> : null}
                <span>
                  {children.length} {children.length === 1 ? "subagent" : "subagents"}
                </span>
                <ChevronDown
                  size={12}
                  className={cn("transition-transform", open && "rotate-180")}
                />
              </button>
              {open ? <div className="w-60">{list}</div> : null}
            </div>
          </>
        )}
      </div>
    </div>
  );
});

function SubagentList({
  agents,
  waiting,
  selectedId,
  onSelect,
}: {
  agents: SubagentView[];
  waiting: number;
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-[var(--background)] shadow-sm">
      <div className="flex h-8 items-center gap-1.5 border-b border-border px-3 text-xs text-[var(--muted-foreground)]">
        <Users size={12} />
        <span className="flex-1">Subagents</span>
        {waiting > 0 ? (
          <span className="text-[var(--atlas-status-warning-foreground)]">{waiting} waiting</span>
        ) : (
          <span className="tabular-nums">{agents.length}</span>
        )}
      </div>
      <ul className="max-h-[50vh] overflow-y-auto py-1">
        {agents.map((child) => (
          <li key={child.id}>
            <button
              type="button"
              onClick={() => onSelect(child.id)}
              aria-pressed={child.id === selectedId}
              title={child.task}
              className={cn(
                "flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left hover:bg-[var(--atlas-element-hover)]",
                child.id === selectedId && "bg-[var(--atlas-element-hover)]",
              )}
            >
              <StatusGlyph status={child.status} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-[var(--foreground)]">
                  {child.name}
                </span>
                <span className="block truncate text-2xs text-[var(--muted-foreground)]">
                  {agentMeta(child.kind).label} ·{" "}
                  {child.status === "blocked" ? "Needs approval" : STATUS_LABEL[child.status]}
                </span>
              </span>
              <span className="shrink-0 text-2xs tabular-nums text-[var(--muted-foreground)]">
                {child.tool_count}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
