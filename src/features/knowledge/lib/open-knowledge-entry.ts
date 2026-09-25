import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useKnowledgeStore } from "../stores/knowledge-store";
import { kbRootPath } from "./kb-root";

/**
 * Show one note from outside the Knowledge panel: focus the column's
 * Knowledge tab (or open one), then ask the panel to open `entryId` once its
 * entries are loaded — the same hand-off the search overlay uses.
 */
export function openKnowledgeEntry(entryId: string): void {
  const root = kbRootPath();
  const kb = useKnowledgeStore.getState().actions;
  if (root) {
    void kb.loadEntries(root).then(() => kb.requestOpen(entryId));
  } else {
    kb.requestOpen(entryId);
  }

  const st = useLayoutStore.getState();
  const group = st.focusedGroupId;
  const existing = st.tabs.find((t) => (t.groupId ?? "main") === group && t.type === "knowledge");
  if (existing) {
    st.actions.setActiveTab(existing.id);
    return;
  }
  st.actions.addTab({
    id: `knowledge-${Date.now()}`,
    type: "knowledge",
    title: "Knowledge",
    closable: true,
    dirty: false,
    data: {},
  });
}
