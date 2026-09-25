// The inspector's Sessions tab: every conversation that used this note.
//
// Rows come from `knowledge_refs_for_entry` (session ids only); titles and
// agents are resolved against the thread history the sidebar already reads,
// and a click reopens the thread through the same path the sidebar uses.

import { useEffect, useMemo, useState } from "react";
import { timeAgo } from "@/lib/time-ago";
import { onThreadsChanged, threadProjects, type ThreadRow } from "@/features/chat/lib/history-api";
import { openThread } from "@/features/chat/lib/open-agent-session";
import {
  groupRefs,
  useEntryRefs,
  type EntrySessionRef,
  type GroupedRef,
} from "../lib/knowledge-refs";

function useThreadsById(projectPath: string | null): Map<string, ThreadRow> {
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  useEffect(() => {
    if (!projectPath) return;
    let live = true;
    const load = () =>
      threadProjects(projectPath)
        .then((projects) => {
          if (live) setThreads(projects.flatMap((p) => p.threads));
        })
        .catch(() => {});
    load();
    const un = onThreadsChanged(load);
    return () => {
      live = false;
      void un.then((f) => f());
    };
  }, [projectPath]);
  return useMemo(() => {
    const map = new Map<string, ThreadRow>();
    for (const t of threads) if (t.sessionId) map.set(t.sessionId, t);
    return map;
  }, [threads]);
}

export function KnowledgeSessions({
  projectPath,
  entryId,
}: {
  projectPath: string | null;
  entryId: string | null;
}) {
  const { data } = useEntryRefs(projectPath, entryId);
  const threads = useThreadsById(projectPath);
  const groups = useMemo(() => groupRefs(data?.sessions ?? [], (r) => r.sessionId), [data]);
  const empty = groups.read.length + groups.retrieved.length === 0;

  if (empty) {
    return (
      <div className="text-muted-foreground italic text-xs">
        {data?.backfilling
          ? "Reading earlier conversations…"
          : "No conversation has used this note yet."}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Group label="Read" rows={groups.read} threads={threads} />
      <Group label="Retrieved" rows={groups.retrieved} threads={threads} />
      {data?.backfilling && (
        <div className="text-muted-foreground italic text-xs">Reading earlier conversations…</div>
      )}
    </div>
  );
}

function Group({
  label,
  rows,
  threads,
}: {
  label: string;
  rows: GroupedRef<EntrySessionRef>[];
  threads: Map<string, ThreadRow>;
}) {
  if (rows.length === 0) return null;
  return (
    <div>
      <div className="eyebrow mb-1.5">
        {label} · {rows.length}
      </div>
      <div className="flex flex-col gap-0.5">
        {rows.map(({ key, lastAt, readHits, retrievedHits }) => {
          const thread = threads.get(key);
          const hits = readHits + retrievedHits;
          return (
            <button
              key={key}
              type="button"
              disabled={!thread}
              onClick={() => thread && void openThread(thread)}
              className="flex w-full min-w-0 flex-col gap-0.5 rounded-md px-1.5 py-1.5 text-left transition-colors enabled:cursor-pointer enabled:hover:bg-[var(--atlas-element-hover)] disabled:opacity-60"
            >
              <span className="truncate text-sm text-foreground">
                {thread?.title ?? "Conversation no longer in history"}
              </span>
              <span className="text-xs text-muted-foreground">
                {timeAgo(lastAt, { suffix: true })}
                {hits > 1 ? ` · ${hits}×` : ""}
                {thread?.archived ? " · archived" : ""}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
