/**
 * Scheduled tasks: a prompt sent to an agent on a schedule. Rust owns the
 * list, the timer and the runs (`commands/scheduled_tasks.rs`); this is the
 * wire shape, the invoke wrappers, and how a schedule reads.
 */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export const SCHEDULED_EVENT = "atlas:scheduled-tasks";

export type Schedule =
  /** Every `minutes` (at least 5), counted from the last run. */
  | { type: "interval"; minutes: number }
  | { type: "daily"; time: string }
  | { type: "weekdays"; time: string }
  /** `days`: 0 = Sunday … 6 = Saturday. */
  | { type: "weekly"; days: number[]; time: string };

export type NotifyPolicy = "all" | "failures" | "none";
export type RunStatus = "running" | "done" | "failed";

export interface RunRecord {
  at: number;
  status: RunStatus;
  sessionId: string | null;
  agentHandle: string | null;
  error: string | null;
}

export interface ScheduledTask {
  /** Empty for a task being created. */
  id: string;
  name: string;
  prompt: string;
  pluginId: string;
  projectPath: string;
  schedule: Schedule;
  model: string | null;
  effort: string | null;
  notify: NotifyPolicy;
  newChatEachRun: boolean;
  enabled: boolean;
  createdAt: number;
  nextRunAt: number | null;
  lastRun: RunRecord | null;
  lastSessionId: string | null;
}

export const scheduledApi = {
  list: () => invoke<ScheduledTask[]>("scheduled_tasks_list"),
  save: (task: ScheduledTask) => invoke<ScheduledTask>("scheduled_tasks_save", { task }),
  remove: (id: string) => invoke<void>("scheduled_tasks_delete", { id }),
  runNow: (id: string) => invoke<void>("scheduled_tasks_run_now", { id }),
};

/** The task list, kept current by the backend's change event. */
export function useScheduledTasks(): ScheduledTask[] | null {
  const [tasks, setTasks] = useState<ScheduledTask[] | null>(null);
  useEffect(() => {
    const load = () =>
      scheduledApi
        .list()
        .then(setTasks)
        // No backend (tests / gallery): an empty list, not a spinner forever.
        .catch(() => setTasks((t) => t ?? []));
    void load();
    const off = listen(SCHEDULED_EVENT, () => void load());
    return () => void off.then((f) => f()).catch(() => {});
  }, []);
  return tasks;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Daily", "Weekdays", "Mon, Wed", "Every 30 min", "Every 2 h". */
export function scheduleLabel(s: Schedule): string {
  switch (s.type) {
    case "interval":
      return s.minutes % 60 === 0 ? `Every ${s.minutes / 60} h` : `Every ${s.minutes} min`;
    case "daily":
      return "Daily";
    case "weekdays":
      return "Weekdays";
    case "weekly":
      return s.days.length === 7
        ? "Daily"
        : [...s.days]
            .sort()
            .map((d) => DAY_NAMES[d])
            .join(", ");
  }
}

/** "Today 09:00", "Tomorrow 08:00", "Fri 08:00", "Oct 30 08:00". */
export function whenLabel(ms: number, now = Date.now()): string {
  const at = new Date(ms);
  const time = at.toTimeString().slice(0, 5);
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(at) - startOf(new Date(now))) / 86_400_000);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  if (days === -1) return `Yesterday ${time}`;
  if (days > 1 && days < 7) return `${DAY_NAMES[at.getDay()]} ${time}`;
  return `${at.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}

/** First line of the prompt, trimmed to a title. */
export function nameFromPrompt(prompt: string): string {
  const line = prompt.trim().split("\n")[0]?.trim() ?? "";
  return line.length > 60 ? `${line.slice(0, 57)}…` : line || "Untitled task";
}
