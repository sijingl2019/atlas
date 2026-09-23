import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";

/**
 * Which project dialog is open, if any. A tiny store rather than local state
 * because four surfaces open it from different subtrees: the sidebar's
 * "New project" +, the Add-project menu, the welcome screen and the Cmd+Shift+N
 * hotkey. The dialog itself is mounted ONCE in App (like StopAgentsDialog) and
 * reads this.
 */
export type ProjectDialogState =
  | { mode: "closed" }
  | { mode: "create" }
  | { mode: "edit"; projectId: string };

interface ProjectDialogStoreState {
  dialog: ProjectDialogState;
  actions: {
    /** Open the dialog in create mode (blank fields). */
    openCreate: () => void;
    /** Open the dialog in edit mode, pre-filled from the given project. */
    openEdit: (projectId: string) => void;
    close: () => void;
  };
}

export const useProjectDialogStore = createSelectors(
  create<ProjectDialogStoreState>((set) => ({
    dialog: { mode: "closed" },
    actions: {
      openCreate: () => set({ dialog: { mode: "create" } }),
      openEdit: (projectId) => set({ dialog: { mode: "edit", projectId } }),
      close: () => set({ dialog: { mode: "closed" } }),
    },
  })),
);
