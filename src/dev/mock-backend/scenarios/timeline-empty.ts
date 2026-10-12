// The Timeline before anything has been recorded: the board answers with no
// Sessions, so the panel lands on its "Nothing captured yet" state. Every
// other surface keeps the default data.

import type { Scenario } from "../types";

export const timelineEmpty: Scenario = {
  name: "timeline-empty",
  description: 'Timeline tab with no recorded Sessions — the "Nothing captured yet" state.',
  commands: {
    artifacts_board: () => ({ sessions: [], cloudPending: false, cloudFailed: false }),
  },
  setup: async () => {
    const { useLayoutStore } = await import("@/features/layout/stores/layout-store");
    const { actions, tabs } = useLayoutStore.getState();
    const existing = tabs.find((t) => t.type === "artifacts");
    if (existing) actions.setActiveTab(existing.id);
    else
      actions.addTab({
        id: "artifacts",
        type: "artifacts",
        title: "Timeline",
        closable: true,
        dirty: false,
        data: {},
      });
  },
};
