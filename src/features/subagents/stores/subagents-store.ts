import { useMemo } from "react";
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { useShallow } from "zustand/react/shallow";
import { createSelectors } from "@/lib/create-selectors";
import type { SubagentView } from "@/types/subagents";

/**
 * The live subagent records, mirrored from the backend's registry
 * (`atlas:subagents`). The backend owns them; this store only holds the last
 * view of each, keyed by record id.
 */
interface SubagentsState {
  records: Record<string, SubagentView>;
  /** The column that owns the keyboard (its permission card answers keys);
   *  set by a click on the chat's floating list. */
  focusedChild: string | null;
  /** The child whose detail is open beside its parent chat's floating list. */
  detail: { parentSessionId: string; childId: string } | null;
  actions: {
    openDetail: (parentSessionId: string, childId: string) => void;
    closeDetail: () => void;
    focusChild: (id: string | null) => void;
    upsert: (record: SubagentView) => void;
    remove: (id: string) => void;
    /** Replace everything with the backend's list (after a reload). */
    resync: (records: SubagentView[]) => void;
  };
}

const useSubagentsStoreBase = create<SubagentsState>()(
  immer((set) => ({
    records: {},
    focusedChild: null,
    detail: null,
    actions: {
      openDetail: (parentSessionId, childId) =>
        set((s) => {
          s.detail = { parentSessionId, childId };
        }),
      closeDetail: () =>
        set((s) => {
          s.detail = null;
        }),
      focusChild: (id) =>
        set((s) => {
          s.focusedChild = id;
        }),
      upsert: (record) =>
        set((s) => {
          s.records[record.id] = record;
        }),
      remove: (id) =>
        set((s) => {
          delete s.records[id];
          if (s.detail?.childId === id) s.detail = null;
        }),
      resync: (records) =>
        set((s) => {
          s.records = Object.fromEntries(records.map((r) => [r.id, r]));
        }),
    },
  })),
);

export const useSubagentsStore = createSelectors(useSubagentsStoreBase);

const byCreated = (a: SubagentView, b: SubagentView) => a.created_at.localeCompare(b.created_at);

/** The children of one parent session, oldest first. */
export function childrenOf(
  records: Record<string, SubagentView>,
  parentSessionId: string | null | undefined,
): SubagentView[] {
  if (!parentSessionId) return [];
  return Object.values(records)
    .filter((r) => r.parent_session_id === parentSessionId)
    .sort(byCreated);
}

export function useChildrenOf(parentSessionId: string | null | undefined): SubagentView[] {
  return useSubagentsStoreBase(useShallow((s) => childrenOf(s.records, parentSessionId)));
}

/** Child session ids, for surfaces that list sessions and should not list
 *  a subagent as a chat of its own. */
export function useChildSessionIds(): ReadonlySet<string> {
  const ids = useSubagentsStoreBase(
    useShallow((s) => Object.values(s.records).map((r) => r.child_session_id)),
  );
  return useMemo(() => new Set(ids), [ids]);
}
