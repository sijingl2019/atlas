import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createSelectors } from "@/lib/create-selectors";

interface SessionPinsState {
  pinnedThreadIds: string[];
  actions: {
    toggle: (threadId: string) => void;
    remove: (threadId: string) => void;
  };
}

export const useSessionPinsStore = createSelectors(
  create<SessionPinsState>()(
    persist(
      (set) => ({
        pinnedThreadIds: [],
        actions: {
          toggle: (threadId) =>
            set((state) => ({
              pinnedThreadIds: state.pinnedThreadIds.includes(threadId)
                ? state.pinnedThreadIds.filter((id) => id !== threadId)
                : [...state.pinnedThreadIds, threadId],
            })),
          remove: (threadId) =>
            set((state) => ({
              pinnedThreadIds: state.pinnedThreadIds.filter((id) => id !== threadId),
            })),
        },
      }),
      {
        name: "atlas-session-pins",
        partialize: (state) => ({ pinnedThreadIds: state.pinnedThreadIds }),
      },
    ),
  ),
);
