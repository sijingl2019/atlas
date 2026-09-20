import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEffect, useMemo, useState } from "react";
import { createSelectors } from "@/lib/create-selectors";
import { ensureGlobalRoot } from "./kb-scope-store";

export interface Backlink {
  fromEntryId: string;
  fromTitle: string;
  snippet: string;
}

export interface LinkCounts {
  backlinks: number;
  forwardlinks: number;
}

interface KnowledgeLinksState {
  projectPath: string | null;
  /** Bumped on every `atlas:knowledge:links-changed` event so subscribed
   *  hooks know to re-query. We don't cache the lists frontend-side —
   *  Rust already caches and re-pulls are cheap. */
  rev: number;
  actions: {
    bind: (projectPath: string) => Promise<void>;
    unbind: () => void;
    /** Drop Rust's cached graph for the current project + force a
     *  rebuild. Call after every `save_knowledge_note` /
     *  `delete_knowledge_note`. */
    invalidate: () => Promise<void>;
  };
}

let unlisten: UnlistenFn | null = null;

const store = create<KnowledgeLinksState>()((set, get) => ({
  projectPath: null,
  rev: 0,
  actions: {
    bind: async (projectPath) => {
      if (get().projectPath === projectPath && unlisten) return;
      get().actions.unbind();
      set({ projectPath, rev: 0 });
      unlisten = await listen<{ projectPath: string }>("atlas:knowledge:links-changed", (event) => {
        if (!projectPath || event.payload?.projectPath !== projectPath) return;
        set((s) => ({ rev: s.rev + 1 }));
      });
    },
    unbind: () => {
      if (unlisten) {
        unlisten();
        unlisten = null;
      }
      set({ projectPath: null });
    },
    invalidate: async () => {
      const { projectPath } = get();
      if (!projectPath) return;
      // The global KB mounts workspace knowledge as subtrees, so a note saved
      // under the panel's own root also changed the global root's graph — and
      // Rust caches per root. The graph tab always reads the global root, so
      // skipping this leaves it showing a pre-edit (or empty) graph.
      const globalRoot = await ensureGlobalRoot().catch(() => null);
      const roots =
        globalRoot && globalRoot !== projectPath ? [projectPath, globalRoot] : [projectPath];
      await Promise.all(
        roots.map((root) =>
          invoke("knowledge_links_invalidate", { projectPath: root }).catch(() => {
            // ignore — a stale graph is not worth failing the save over
          }),
        ),
      );
    },
  },
}));

export const useKnowledgeLinksStore = createSelectors(store);

/** Hook: fetch backlinks for a given entry id, re-runs when the store
 *  bumps `rev`. Returns an empty array while loading. */
export function useBacklinks(entryId: string | null): Backlink[] {
  const projectPath = useKnowledgeLinksStore.use.projectPath();
  const rev = useKnowledgeLinksStore.use.rev();
  const [items, setItems] = useState<Backlink[]>([]);
  useEffect(() => {
    let cancelled = false;
    if (!projectPath || !entryId) {
      setItems([]);
      return;
    }
    invoke<Backlink[]>("knowledge_backlinks", { projectPath, entryId })
      .then((r) => {
        if (!cancelled) setItems(r);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath, entryId, rev]);
  return items;
}

/** Hook: live counts for the Properties strip's "References" row and
 *  any "N backlinks" badges. */
function useLinkCounts(entryId: string | null): LinkCounts {
  const projectPath = useKnowledgeLinksStore.use.projectPath();
  const rev = useKnowledgeLinksStore.use.rev();
  const [counts, setCounts] = useState<LinkCounts>({ backlinks: 0, forwardlinks: 0 });
  useEffect(() => {
    let cancelled = false;
    if (!projectPath || !entryId) {
      setCounts({ backlinks: 0, forwardlinks: 0 });
      return;
    }
    invoke<LinkCounts>("knowledge_link_counts", { projectPath, entryId })
      .then((c) => {
        if (!cancelled) setCounts(c);
      })
      .catch(() => {
        if (!cancelled) setCounts({ backlinks: 0, forwardlinks: 0 });
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath, entryId, rev]);
  return counts;
}

/** Tiny convenience for rendering the "References" row label. */
export function useReferencesLabel(entryId: string | null): string {
  const counts = useLinkCounts(entryId);
  return useMemo(() => {
    if (counts.backlinks === 0 && counts.forwardlinks === 0) return "—";
    const parts: string[] = [];
    parts.push(`${counts.backlinks} backlinks`);
    parts.push(`${counts.forwardlinks} forward`);
    return parts.join(" · ");
  }, [counts]);
}
