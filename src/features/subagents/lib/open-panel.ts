import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useSubagentsStore } from "../stores/subagents-store";

const TAB_TYPE = "subagents" as const;

/**
 * Show the Subagents panel for `parentSessionId`.
 *
 * `focus: false` is the automatic open when a parent starts its first child:
 * the panel appears without taking the user away from the chat they are in.
 * With a split open it lands in the column the user is NOT in, side by side
 * with the parent; otherwise it is added and the previous tab re-activated.
 */
export function openSubagentsPanel(
  parentSessionId: string | null,
  { focus = true }: { focus?: boolean } = {},
): void {
  if (parentSessionId) useSubagentsStore.getState().actions.focusParent(parentSessionId);
  const layout = useLayoutStore.getState();
  const existing = layout.tabs.find((t) => t.type === TAB_TYPE);
  if (existing) {
    if (focus) layout.actions.setActiveTab(existing.id);
    return;
  }
  const other = layout.groupOrder.find((g) => g !== layout.focusedGroupId);
  const previous = layout.activeTabId;
  const previousGroup = layout.focusedGroupId;
  layout.actions.addTab(
    {
      id: `${TAB_TYPE}-${Date.now()}`,
      type: TAB_TYPE,
      title: "Subagents",
      closable: true,
      dirty: false,
      data: {},
    },
    focus ? undefined : other,
  );
  if (!focus && previous) {
    // Back to where the user was typing; the panel stays open beside it.
    const after = useLayoutStore.getState();
    if (other) after.actions.setFocusedGroup(previousGroup);
    else after.actions.setActiveTab(previous);
  }
}
