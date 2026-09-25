// Knowledge Base notes this conversation used, as a header dropdown.
//
// Same recipe as `ChatPinnedMenu`: a pill with a count that renders only when
// there is something to show, and one popup element carrying border + fill +
// blur. Two groups — "Read" (attached with @note or opened by the agent: its
// content certainly reached the agent) and "Retrieved" (only among
// `memory_search` results). See `features/knowledge/lib/knowledge-refs.ts`.

import { useMemo, useState } from "react";
import { Popover } from "@base-ui/react/popover";
import { Library } from "lucide-react";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/time-ago";
import { HintItem } from "@/ui/hint-group";
import {
  groupRefs,
  useSessionRefs,
  type GroupedRef,
  type SessionRef,
} from "@/features/knowledge/lib/knowledge-refs";
import { openKnowledgeEntry } from "@/features/knowledge/lib/open-knowledge-entry";

export function ChatKnowledgeMenu({
  projectPath,
  sessionId,
  className,
}: {
  projectPath: string | null;
  /** The ACP session id; empty while the chat is still a draft. */
  sessionId: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const { data } = useSessionRefs(projectPath, sessionId || null);
  const groups = useMemo(() => groupRefs(data?.refs ?? [], (r) => r.entryId), [data]);
  const total = groups.read.length + groups.retrieved.length;

  if (total === 0) return null;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <HintItem label="Knowledge used in this chat">
        <Popover.Trigger
          render={
            <button
              type="button"
              aria-label={`${total} knowledge notes used in this chat`}
              className={className}
            >
              <Library size={12} />
              <span className="tabular-nums text-xs leading-none">{total}</span>
            </button>
          }
        />
      </HintItem>
      <Popover.Portal>
        <Popover.Positioner className="z-popover" align="end" sideOffset={6}>
          <Popover.Popup className="overflow-hidden rounded-xl select-none inset-highlight shadow-md border border-[var(--atlas-element-active)] bg-[var(--card)]/95 backdrop-blur-2xl atlas-panel-in-tl">
            <div className="hide-scrollbar flex max-h-[min(420px,60vh)] w-[320px] flex-col overflow-y-auto py-1">
              <Group
                label="Read"
                hint="Attached with @note or opened by the agent"
                rows={groups.read}
                onOpen={(id) => {
                  setOpen(false);
                  openKnowledgeEntry(id);
                }}
              />
              <Group
                label="Retrieved"
                hint="Returned by memory search"
                rows={groups.retrieved}
                onOpen={(id) => {
                  setOpen(false);
                  openKnowledgeEntry(id);
                }}
              />
              {!!data?.unresolved && (
                <div className="px-3 py-2 text-3xs text-[var(--muted-foreground)]">
                  {data.unresolved === 1
                    ? "1 search result no longer matches a note"
                    : `${data.unresolved} search results no longer match a note`}
                </div>
              )}
              {data?.backfilling && (
                <div className="px-3 py-2 text-3xs text-[var(--muted-foreground)]">
                  Reading earlier conversations…
                </div>
              )}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Group({
  label,
  hint,
  rows,
  onOpen,
}: {
  label: string;
  hint: string;
  rows: GroupedRef<SessionRef>[];
  onOpen: (entryId: string) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <div>
      <div
        className="px-3 pb-1 pt-2 text-3xs uppercase tracking-wider text-[var(--muted-foreground)]"
        title={hint}
      >
        {label} · {rows.length}
      </div>
      {rows.map(({ key, item, readHits, retrievedHits, lastAt }) => (
        <button
          key={key}
          type="button"
          disabled={!item.exists}
          onClick={() => onOpen(item.entryId)}
          title={
            retrievedHits > 0 && readHits > 0
              ? `Also returned by ${retrievedHits} search${retrievedHits === 1 ? "" : "es"}`
              : item.entryId
          }
          className={cn(
            "flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors",
            item.exists
              ? "cursor-pointer hover:bg-[var(--atlas-element-hover)]"
              : "cursor-default opacity-50",
          )}
        >
          <span className="w-4 shrink-0 text-center text-xs leading-none">{item.icon ?? "📄"}</span>
          <span className="min-w-0 flex-1 truncate text-xs text-[var(--secondary-foreground)]">
            {item.title}
          </span>
          <span className="shrink-0 text-3xs text-[var(--muted-foreground)]">
            {item.exists ? timeAgo(lastAt, { suffix: true }) : "Deleted or moved"}
          </span>
        </button>
      ))}
    </div>
  );
}
