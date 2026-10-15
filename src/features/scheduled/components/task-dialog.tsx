/**
 * Create / edit a scheduled task: what to do, when, and (under Advanced) who
 * does it and how the user hears about it.
 */
import { useEffect, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { ChevronDown, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Toggle } from "@/features/settings/components/settings-controls";
import {
  ModelSelect,
  selectClass,
  useInstalledAgents,
} from "@/features/integrations/components/agent-model-select";
import { EFFORT_CYCLE } from "@/features/chat/components/message-input";
import { useProjectStore } from "@/features/projects/stores/project-store";
import {
  nameFromPrompt,
  scheduledApi,
  type NotifyPolicy,
  type Schedule,
  type ScheduledTask,
} from "../lib/scheduled";

const pillButton =
  "inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] px-3 py-1.5 text-xs font-medium leading-none cursor-pointer transition-colors disabled:cursor-not-allowed disabled:opacity-40";
const rowClass =
  "flex items-center justify-between gap-3 px-3 py-2 text-xs text-[var(--secondary-foreground)]";
const groupClass = "rounded-lg border border-[var(--border)] divide-y divide-[var(--border)]";
const inlineSelect = cn(selectClass, "w-auto min-w-[140px]");

const INTERVALS = [5, 10, 15, 30, 60, 120, 180, 360, 720];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const NOTIFY: { value: NotifyPolicy; label: string }[] = [
  { value: "failures", label: "Failures only" },
  { value: "all", label: "Every run" },
  { value: "none", label: "Never" },
];

type Repeat = Schedule["type"];

function timeOf(s: Schedule): string {
  return s.type === "interval" ? "09:00" : s.time;
}

function scheduleFrom(repeat: Repeat, time: string, minutes: number, days: number[]): Schedule {
  switch (repeat) {
    case "interval":
      return { type: "interval", minutes };
    case "daily":
      return { type: "daily", time };
    case "weekdays":
      return { type: "weekdays", time };
    case "weekly":
      return { type: "weekly", days, time };
  }
}

export function TaskDialog({
  task,
  onClose,
}: {
  /** The task to edit; `null` creates one. */
  task: ScheduledTask | null;
  onClose: () => void;
}) {
  const catalog = useInstalledAgents();
  const activePath = useProjectStore(
    (s) => s.projects.find((p) => p.id === s.activeProjectId)?.path ?? "",
  );
  const [prompt, setPrompt] = useState(task?.prompt ?? "");
  const [repeat, setRepeat] = useState<Repeat>(task?.schedule.type ?? "daily");
  const [time, setTime] = useState(task ? timeOf(task.schedule) : "09:00");
  const [minutes, setMinutes] = useState(
    task?.schedule.type === "interval" ? task.schedule.minutes : 30,
  );
  const [days, setDays] = useState<number[]>(
    task?.schedule.type === "weekly" ? task.schedule.days : [1],
  );
  const [advanced, setAdvanced] = useState(false);
  const [notify, setNotify] = useState<NotifyPolicy>(task?.notify ?? "failures");
  const [newChat, setNewChat] = useState(task?.newChatEachRun ?? true);
  const [pluginId, setPluginId] = useState(task?.pluginId ?? "");
  const [model, setModel] = useState<string | null>(task?.model ?? null);
  const [effort, setEffort] = useState(task?.effort ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!pluginId && catalog.length) setPluginId(catalog[0].id);
  }, [catalog, pluginId]);

  const agent = catalog.find((a) => a.id === pluginId);
  const projectPath = task?.projectPath ?? activePath;
  const valid =
    prompt.trim() !== "" &&
    pluginId !== "" &&
    projectPath !== "" &&
    (repeat !== "weekly" || days.length > 0);

  const submit = async () => {
    setSaving(true);
    try {
      await scheduledApi.save({
        id: task?.id ?? "",
        name: nameFromPrompt(prompt),
        prompt: prompt.trim(),
        pluginId,
        projectPath,
        schedule: scheduleFrom(repeat, time, minutes, days),
        model,
        effort: effort || null,
        notify,
        newChatEachRun: newChat,
        enabled: task?.enabled ?? true,
        createdAt: task?.createdAt ?? 0,
        nextRunAt: null,
        lastRun: null,
        lastSessionId: null,
      });
      onClose();
    } catch (e) {
      toast.error(String(e));
      setSaving(false);
    }
  };

  return (
    <Dialog.Root open onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-overlay scrim backdrop-blur-xl" />
        <Dialog.Popup
          className={cn(
            "fixed left-1/2 top-1/2 z-modal -translate-x-1/2 -translate-y-1/2",
            "flex max-h-[86vh] w-[520px] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-[var(--border)]",
            "bg-[var(--card)]/60 backdrop-blur-2xl shadow-lg animate-scale-in",
          )}
        >
          <Dialog.Close
            className="absolute right-2.5 top-2.5 flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--atlas-element-active)] hover:text-[var(--foreground)]"
            aria-label="Close"
          >
            <X size={13} />
          </Dialog.Close>

          <div className="px-4 pt-3.5">
            <Dialog.Title className="text-base font-semibold tracking-[-0.01em] text-[var(--foreground)]">
              {task ? "Edit scheduled task" : "Schedule a task"}
            </Dialog.Title>
            <p
              className="mt-0.5 truncate text-xs text-[var(--muted-foreground)]"
              title={projectPath}
            >
              {projectPath || "Open a project first"}
            </p>
          </div>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3.5">
            <textarea
              rows={4}
              autoFocus
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe what to do on each run…"
              aria-label="Description"
              className="w-full resize-none rounded-lg border border-[var(--border)] bg-[var(--atlas-panel-input-background)] px-3 py-2 text-sm text-[var(--foreground)] outline-none focus:border-[var(--atlas-border-strong)]"
            />

            <div className={groupClass}>
              <label className={rowClass}>
                <span>Repeat</span>
                <select
                  className={inlineSelect}
                  value={repeat}
                  onChange={(e) => setRepeat(e.target.value as Repeat)}
                >
                  <option value="interval">Every…</option>
                  <option value="daily">Daily</option>
                  <option value="weekdays">Weekdays</option>
                  <option value="weekly">Weekly</option>
                </select>
              </label>
              {repeat === "interval" ? (
                <label className={rowClass}>
                  <span>Interval</span>
                  <select
                    className={inlineSelect}
                    value={minutes}
                    onChange={(e) => setMinutes(Number(e.target.value))}
                  >
                    {INTERVALS.map((m) => (
                      <option key={m} value={m}>
                        {m < 60 ? `${m} minutes` : m === 60 ? "1 hour" : `${m / 60} hours`}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <label className={rowClass}>
                  <span>Time</span>
                  <input
                    type="time"
                    className={inlineSelect}
                    value={time}
                    onChange={(e) => setTime(e.target.value)}
                  />
                </label>
              )}
              {repeat === "weekly" && (
                <div className={cn(rowClass, "justify-end gap-1")}>
                  {DAYS.map((d, i) => {
                    const on = days.includes(i);
                    return (
                      <button
                        key={d}
                        type="button"
                        aria-pressed={on}
                        onClick={() =>
                          setDays(on ? days.filter((x) => x !== i) : [...days, i].sort())
                        }
                        className={cn(
                          "h-6 w-9 cursor-pointer rounded-md border border-[var(--border)] text-xs",
                          on
                            ? "bg-[var(--foreground)] text-[var(--background)]"
                            : "hover:bg-[var(--atlas-element-hover)]",
                        )}
                      >
                        {d}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className={groupClass}>
              <label className={rowClass}>
                <span>Agent</span>
                <select
                  className={inlineSelect}
                  value={pluginId}
                  onChange={(e) => {
                    setPluginId(e.target.value);
                    setModel(null);
                    setEffort("");
                  }}
                >
                  {catalog.length === 0 && <option value="">No agents installed</option>}
                  {catalog.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <button
              type="button"
              onClick={() => setAdvanced(!advanced)}
              aria-expanded={advanced}
              className="flex cursor-pointer items-center gap-1 text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
            >
              Advanced
              <ChevronDown
                size={12}
                className={cn("transition-transform", advanced && "rotate-180")}
              />
            </button>

            {advanced && (
              <div className={groupClass}>
                <label className={rowClass}>
                  <span>Model</span>
                  <ModelSelect
                    agent={agent}
                    value={model}
                    onChange={setModel}
                    className="w-auto min-w-[140px]"
                  />
                </label>
                {/* Effort is a native-agent knob, as in the composer. */}
                {agent?.kind === "native" && (
                  <label className={rowClass}>
                    <span>Effort</span>
                    <select
                      className={inlineSelect}
                      value={effort}
                      onChange={(e) => setEffort(e.target.value)}
                    >
                      {EFFORT_CYCLE.map((v) => (
                        <option key={v} value={v}>
                          {v === "" ? "Default" : v[0].toUpperCase() + v.slice(1)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <label className={rowClass}>
                  <span>Notify</span>
                  <select
                    className={inlineSelect}
                    value={notify}
                    onChange={(e) => setNotify(e.target.value as NotifyPolicy)}
                  >
                    {NOTIFY.map((n) => (
                      <option key={n.value} value={n.value}>
                        {n.label}
                      </option>
                    ))}
                  </select>
                </label>
                <div className={rowClass}>
                  <span>New chat on each run</span>
                  <Toggle checked={newChat} onChange={setNewChat} />
                </div>
              </div>
            )}
            <p className="text-2xs text-[var(--muted-foreground)]">
              Runs unattended while Atlas is open: the agent's permission requests are approved
              automatically.
            </p>
          </div>

          <div className="flex justify-end gap-2 px-4 pb-4">
            <button
              onClick={onClose}
              className={cn(
                pillButton,
                "bg-[var(--card)] text-[var(--secondary-foreground)] hover:bg-[var(--atlas-element-hover)]",
              )}
            >
              Cancel
            </button>
            <button
              disabled={!valid || saving}
              onClick={() => void submit()}
              className={cn(
                pillButton,
                "border-transparent bg-[var(--foreground)] text-[var(--background)] hover:opacity-90",
              )}
            >
              {task ? "Save" : "Create"}
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
