import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { SubagentEvent, SubagentView } from "@/types/subagents";

/** The Agents panel's commands (`src-tauri/src/commands/subagents/commands.rs`). */
export const subagentsApi = {
  list: () => invoke<SubagentView[]>("subagents_list"),
  markSeen: (id: string) => invoke<void>("subagents_mark_seen", { id }),
  stop: (id: string, remove = false) => invoke<void>("subagents_stop", { id, remove }),
  stopAll: (parentSessionId: string) => invoke<void>("subagents_stop_all", { parentSessionId }),
  /** A follow-up the user typed into a child's column. */
  prompt: (id: string, text: string) => invoke<void>("subagents_prompt", { id, text }),
};

export const listenSubagents = (handler: (event: SubagentEvent) => void): Promise<UnlistenFn> =>
  listen<SubagentEvent>("atlas:subagents", (e) => handler(e.payload));
