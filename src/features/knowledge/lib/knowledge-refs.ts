/**
 * Which Knowledge Base notes a conversation used, and the reverse — the
 * frontend half of `src-tauri/src/commands/knowledge_refs/`.
 *
 * Three kinds are recorded: `mention` (the user attached it with `@note`),
 * `read` (the agent opened the file) and `retrieved` (`memory_search` handed
 * it over). The UI shows two groups: "read" — the note's content reached the
 * agent for certain — and "retrieved", which only means it was among the
 * search results. A note in both shows under "read" only.
 */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type KnowledgeRefKind = "mention" | "read" | "retrieved";

/** Fired after new references land. No `sessionId` after a backfill. */
export const KNOWLEDGE_REFS_CHANGED_EVENT = "atlas:knowledge-refs-changed";

export interface SessionRef {
  entryId: string;
  kind: KnowledgeRefKind;
  hits: number;
  lastAt: string;
  title: string;
  icon: string | null;
  /** False when the note has since been deleted or moved. */
  exists: boolean;
}

export interface SessionRefs {
  refs: SessionRef[];
  /** Search results that could no longer be pinned to one note. */
  unresolved: number;
  /** History is still being read; the lists may grow. */
  backfilling: boolean;
}

export interface EntrySessionRef {
  sessionId: string;
  kind: KnowledgeRefKind;
  hits: number;
  lastAt: string;
}

export interface EntryRefs {
  sessions: EntrySessionRef[];
  backfilling: boolean;
}

export function knowledgeRefsForSession(
  projectPath: string,
  sessionId: string,
): Promise<SessionRefs> {
  return invoke<SessionRefs>("knowledge_refs_for_session", { projectPath, sessionId });
}

export function knowledgeRefsForEntry(projectPath: string, entryId: string): Promise<EntryRefs> {
  return invoke<EntryRefs>("knowledge_refs_for_entry", { projectPath, entryId });
}

/** One row of a grouped list: a note (or a session) and how it was used. */
export interface GroupedRef<T> {
  key: string;
  /** The first row seen for this key — carries the display fields. */
  item: T;
  /** `mention` + `read` hits. */
  readHits: number;
  retrievedHits: number;
  lastAt: string;
}

export interface RefGroups<T> {
  read: GroupedRef<T>[];
  retrieved: GroupedRef<T>[];
}

/**
 * Fold per-(key, kind) rows into the two display groups. Order within a group
 * follows the input's first sighting of each key.
 */
export function groupRefs<T extends { kind: KnowledgeRefKind; hits: number; lastAt: string }>(
  rows: T[],
  keyOf: (row: T) => string,
): RefGroups<T> {
  const byKey = new Map<string, GroupedRef<T>>();
  for (const row of rows) {
    const key = keyOf(row);
    let g = byKey.get(key);
    if (!g) {
      g = { key, item: row, readHits: 0, retrievedHits: 0, lastAt: row.lastAt };
      byKey.set(key, g);
    }
    if (row.kind === "retrieved") g.retrievedHits += row.hits;
    else g.readHits += row.hits;
    if (row.lastAt > g.lastAt) g.lastAt = row.lastAt;
  }
  const all = [...byKey.values()];
  return {
    read: all.filter((g) => g.readHits > 0),
    retrieved: all.filter((g) => g.readHits === 0),
  };
}

interface Loaded<T> {
  data: T | null;
  /** Bumps to force a refetch. */
  reload: () => void;
}

/**
 * Load `fetch()` while `enabled`, and again whenever the backend says
 * references for `projectPath` (and `sessionId`, when given) changed.
 */
function useRefsQuery<T>(
  enabled: boolean,
  projectPath: string | null,
  sessionId: string | null,
  deps: unknown[],
  fetch: () => Promise<T>,
): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!enabled || !projectPath) {
      setData(null);
      return;
    }
    let live = true;
    fetch()
      .then((d) => {
        if (live) setData(d);
      })
      .catch(() => {
        if (live) setData(null);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, projectPath, tick, ...deps]);

  useEffect(() => {
    if (!enabled || !projectPath) return;
    const un = listen<{ cwd: string; sessionId: string | null }>(
      KNOWLEDGE_REFS_CHANGED_EVENT,
      (e) => {
        if (e.payload.cwd !== projectPath) return;
        if (sessionId && e.payload.sessionId && e.payload.sessionId !== sessionId) return;
        setTick((t) => t + 1);
      },
    );
    return () => {
      void un.then((f) => f());
    };
  }, [enabled, projectPath, sessionId]);

  return { data, reload: () => setTick((t) => t + 1) };
}

/** The notes one conversation used. */
export function useSessionRefs(projectPath: string | null, sessionId: string | null) {
  return useRefsQuery(!!sessionId, projectPath, sessionId, [sessionId], () =>
    knowledgeRefsForSession(projectPath ?? "", sessionId ?? ""),
  );
}

/** The conversations that used one note. */
export function useEntryRefs(projectPath: string | null, entryId: string | null, enabled = true) {
  return useRefsQuery(enabled && !!entryId, projectPath, null, [entryId], () =>
    knowledgeRefsForEntry(projectPath ?? "", entryId ?? ""),
  );
}
