/**
 * The Scheduled tab: every scheduled task on the left (soonest first, paused
 * last), the selected one's details on the right, or the empty state.
 */
import { useState } from "react";
import {
  AlarmClock,
  MessageSquare,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCw,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { basename } from "@/lib/paths";
import { useInstalledAgents } from "@/features/integrations/components/agent-model-select";
import { openBackgroundSession } from "@/features/integrations/lib/open-run-session";
import {
  scheduledApi,
  scheduleLabel,
  useScheduledTasks,
  whenLabel,
  type RunStatus,
  type ScheduledTask,
} from "../lib/scheduled";
import { TaskDialog } from "./task-dialog";

const iconButton =
  "flex size-7 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)] cursor-pointer";
const primaryPill =
  "inline-flex items-center gap-1.5 rounded-full bg-[var(--foreground)] px-4 py-2 text-xs font-medium text-[var(--background)] hover:opacity-90 cursor-pointer";

const STATUS: Record<RunStatus, { label: string; className: string }> = {
  running: { label: "Running", className: "text-[var(--primary)]" },
  done: { label: "Done", className: "text-success" },
  failed: { label: "Failed", className: "text-error" },
};

const fail = (e: unknown) => toast.error(String(e));

function order(tasks: ScheduledTask[]): ScheduledTask[] {
  const key = (t: ScheduledTask) => (t.enabled && t.nextRunAt ? t.nextRunAt : Infinity);
  return [...tasks].sort((a, b) => key(a) - key(b));
}

export function ScheduledPanel() {
  const tasks = useScheduledTasks();
  const catalog = useInstalledAgents();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // `undefined`: closed; `null`: creating; a task: editing it.
  const [dialog, setDialog] = useState<ScheduledTask | null | undefined>(undefined);

  const list = order(tasks ?? []);
  const selected = list.find((t) => t.id === selectedId) ?? null;
  const agentName = (id: string) => catalog.find((a) => a.id === id)?.name ?? id;

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-[300px] shrink-0 flex-col border-r border-[var(--atlas-border-subtle)]">
        <div className="px-4 pt-4 pb-2 text-base font-semibold text-[var(--foreground)]">
          Scheduled
        </div>
        <button
          onClick={() => setDialog(null)}
          className="mx-2 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-[var(--secondary-foreground)] hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)]"
        >
          <Plus size={14} /> New task
        </button>
        {list.length > 0 && (
          <div className="px-4 pt-3 pb-1 text-xs text-[var(--muted-foreground)]">Upcoming</div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {list.map((t) => (
            <button
              key={t.id}
              onClick={() => setSelectedId(t.id)}
              className={cn(
                "flex w-full cursor-pointer flex-col items-start rounded-md px-2 py-1.5 text-left hover:bg-[var(--atlas-element-hover)]",
                t.id === selectedId && "bg-[var(--atlas-element-active)]",
              )}
            >
              <span
                className={cn(
                  "w-full truncate text-sm text-[var(--foreground)]",
                  !t.enabled && "text-[var(--muted-foreground)]",
                )}
              >
                {t.name}
              </span>
              <span className="w-full truncate text-xs text-[var(--muted-foreground)]">
                {t.lastRun?.status === "running"
                  ? "Running now"
                  : t.enabled && t.nextRunAt
                    ? whenLabel(t.nextRunAt)
                    : "Paused"}
                {" · "}
                {scheduleLabel(t.schedule)} · {agentName(t.pluginId)}
              </span>
            </button>
          ))}
        </div>
      </aside>

      <section className="min-w-0 flex-1 overflow-y-auto">
        {selected ? (
          <TaskDetail
            task={selected}
            agentName={agentName(selected.pluginId)}
            onEdit={() => setDialog(selected)}
            onDeleted={() => setSelectedId(null)}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <AlarmClock size={40} strokeWidth={1.5} className="text-[var(--foreground)]" />
            <div className="text-base font-medium text-[var(--foreground)]">Schedule a task</div>
            <p className="max-w-sm text-xs text-[var(--muted-foreground)]">
              An agent runs it for you on a schedule, in its own chat. You can also ask any agent in
              chat, like “every 30 minutes, check the free space on C:”.
            </p>
            <button onClick={() => setDialog(null)} className={cn(primaryPill, "mt-4")}>
              New task
            </button>
          </div>
        )}
      </section>

      {dialog !== undefined && <TaskDialog task={dialog} onClose={() => setDialog(undefined)} />}
    </div>
  );
}

function TaskDetail({
  task,
  agentName,
  onEdit,
  onDeleted,
}: {
  task: ScheduledTask;
  agentName: string;
  onEdit: () => void;
  onDeleted: () => void;
}) {
  const run = task.lastRun;
  const openChat = () => {
    const sessionId = run?.sessionId ?? task.lastSessionId;
    if (!sessionId) return;
    void openBackgroundSession({
      sessionId,
      agentHandle: run?.agentHandle,
      running: run?.status === "running",
      pluginId: task.pluginId,
      cwd: task.projectPath,
      title: task.name,
      tabPrefix: "scheduled-run",
    }).catch(fail);
  };

  return (
    <div className="mx-auto max-w-2xl px-6 py-5">
      <div className="flex items-start gap-2">
        <h2 className="min-w-0 flex-1 text-lg font-semibold break-words text-[var(--foreground)]">
          {task.name}
        </h2>
        <button
          className={iconButton}
          title="Run now"
          onClick={() =>
            scheduledApi
              .runNow(task.id)
              .then(() => toast.success("Started"))
              .catch(fail)
          }
        >
          <RotateCw size={14} />
        </button>
        <button
          className={iconButton}
          title={task.enabled ? "Pause" : "Resume"}
          onClick={() => scheduledApi.save({ ...task, enabled: !task.enabled }).catch(fail)}
        >
          {task.enabled ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <button className={iconButton} title="Edit" onClick={onEdit}>
          <Pencil size={14} />
        </button>
        <button
          className={cn(iconButton, "hover:text-error")}
          title="Delete"
          onClick={() => {
            if (!window.confirm(`Delete “${task.name}”?`)) return;
            scheduledApi.remove(task.id).then(onDeleted).catch(fail);
          }}
        >
          <Trash2 size={14} />
        </button>
      </div>

      <dl className="mt-3 grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5 text-xs">
        <dt className="text-[var(--muted-foreground)]">Repeats</dt>
        <dd className="text-[var(--foreground)]">
          {scheduleLabel(task.schedule)}
          {task.schedule.type !== "interval" && ` at ${task.schedule.time}`}
        </dd>
        <dt className="text-[var(--muted-foreground)]">Next run</dt>
        <dd className="text-[var(--foreground)]">
          {task.enabled && task.nextRunAt ? whenLabel(task.nextRunAt) : "Paused"}
        </dd>
        <dt className="text-[var(--muted-foreground)]">Agent</dt>
        <dd className="text-[var(--foreground)]">
          {agentName}
          {task.model && ` · ${task.model}`}
        </dd>
        <dt className="text-[var(--muted-foreground)]">Project</dt>
        <dd className="truncate text-[var(--foreground)]" title={task.projectPath}>
          {basename(task.projectPath)}
        </dd>
        <dt className="text-[var(--muted-foreground)]">Last run</dt>
        <dd>
          {run ? (
            <span className="flex flex-wrap items-center gap-2">
              <span className={STATUS[run.status].className}>{STATUS[run.status].label}</span>
              <span className="text-[var(--muted-foreground)]">{whenLabel(run.at)}</span>
              {(run.sessionId ?? task.lastSessionId) && (
                <button
                  onClick={openChat}
                  className="inline-flex cursor-pointer items-center gap-1 text-[var(--secondary-foreground)] hover:text-[var(--foreground)]"
                >
                  <MessageSquare size={12} /> Open chat
                </button>
              )}
            </span>
          ) : (
            <span className="text-[var(--muted-foreground)]">Not run yet</span>
          )}
        </dd>
      </dl>
      {run?.error && (
        <pre className="mt-2 rounded-md bg-error/10 px-3 py-2 text-xs whitespace-pre-wrap text-error">
          {run.error}
        </pre>
      )}

      <div className="mt-5 text-xs text-[var(--muted-foreground)]">Instructions</div>
      <p className="mt-1 text-sm whitespace-pre-wrap text-[var(--foreground)]">{task.prompt}</p>
    </div>
  );
}
