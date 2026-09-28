/**
 * An integration's tab: the issues its tracker lists right now, each with
 * where its run stands and the agent / model it runs with. The one being
 * developed is highlighted; a title opens the issue in the browser. An
 * interrupted run can be continued, a failed one retried, and a failure's
 * reason read by expanding its row.
 */
import { Fragment, useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ChevronRight,
  Loader2,
  Pencil,
  Play,
  RefreshCw,
  RotateCcw,
  StepForward,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  formatCreated,
  integrationLabel,
  INTEGRATIONS_EVENT,
  integrationsApi,
  toIntegration,
  useIntegrationDialogStore,
  useIntegrationsStore,
  type IntegrationView,
  type Issue,
  type IssueOverride,
  type RunRecord,
  type RunStatus,
} from "../lib/integrations";
import { ModelSelect, selectClass, useInstalledAgents } from "./agent-model-select";
import { SourceIcon } from "./source-icon";

const STATUS_LABEL: Record<RunStatus, string> = {
  running: "Developing",
  done: "Committed",
  failed: "Failed",
  skipped: "Skipped",
  interrupted: "Interrupted",
};

const STATUS_CLASS: Record<RunStatus, string> = {
  running: "text-[var(--primary)]",
  done: "text-success",
  failed: "text-error",
  skipped: "text-[var(--muted-foreground)]",
  interrupted: "text-warning",
};

const iconButton =
  "flex size-7 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)] cursor-pointer";
const actionButton =
  "inline-flex items-center gap-1 rounded-md border border-[var(--border)] px-1.5 py-0.5 text-xs text-[var(--secondary-foreground)] hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)] cursor-pointer";

export function IntegrationPanel({ integrationId }: { integrationId: string }) {
  const item = useIntegrationsStore((s) => s.items.find((i) => i.id === integrationId));
  const openEdit = useIntegrationDialogStore((s) => s.openEdit);
  const catalog = useInstalledAgents();
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [runs, setRuns] = useState<Record<string, RunRecord>>({});
  const [expanded, setExpanded] = useState<string | null>(null);

  const loadIssues = useCallback(async () => {
    setLoading(true);
    try {
      setIssues(await integrationsApi.issues(integrationId));
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [integrationId]);

  const loadRuns = useCallback(async () => {
    try {
      const list = await integrationsApi.runs(integrationId);
      setRuns(Object.fromEntries(list.map((r) => [r.issueKey, r])));
    } catch {
      // No backend (tests / gallery).
    }
  }, [integrationId]);

  useEffect(() => {
    void loadIssues();
    void loadRuns();
    // Run progress changes often; the tracker's list is re-fetched by hand.
    const off = listen(INTEGRATIONS_EVENT, () => void loadRuns());
    return () => void off.then((f) => f()).catch(() => {});
  }, [loadIssues, loadRuns]);

  if (!item) {
    return (
      <div className="p-6 text-sm text-[var(--muted-foreground)]">
        This integration was deleted.
      </div>
    );
  }

  const current = Object.values(runs).find((r) => r.status === "running");
  const agentName = (id: string) => catalog.find((a) => a.id === id)?.name ?? id;

  const rerun = (key: string, verb: string) =>
    integrationsApi
      .rerun(item.id, key)
      .then(() => toast.success(`${verb} ${key}`))
      .catch((e) => toast.error(String(e)));

  const setOverride = (key: string, next: IssueOverride) => {
    const overrides = { ...item.issueOverrides };
    if (next.agentId || next.model) overrides[key] = next;
    else delete overrides[key];
    integrationsApi
      .save({ ...toIntegration(item), issueOverrides: overrides }, null)
      .catch((e) => toast.error(String(e)));
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-[var(--atlas-border-subtle)] px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 truncate text-sm font-semibold text-[var(--foreground)]">
            <SourceIcon kind={item.source.kind} />
            {integrationLabel(item)}
          </div>
          <div className="truncate text-xs text-[var(--muted-foreground)]">
            {current ? (
              <span className="text-[var(--primary)]">
                Developing {current.issueKey} {current.title}
              </span>
            ) : (
              <>
                {item.projectPath} · {agentName(item.agentId)}
                {item.model && ` · ${item.model}`} · every {item.intervalMinutes} min
                {!item.enabled && " · disabled"}
              </>
            )}
          </div>
        </div>
        <button
          className={iconButton}
          title="Pull and run now"
          onClick={() =>
            integrationsApi
              .runNow(item.id)
              .then(() => toast.success(`Pulling issues for ${integrationLabel(item)}`))
              .catch((e) => toast.error(String(e)))
          }
        >
          <Play size={14} />
        </button>
        <button className={iconButton} title="Refresh list" onClick={() => void loadIssues()}>
          <RefreshCw size={14} className={cn(loading && "animate-spin")} />
        </button>
        <button className={iconButton} title="Edit" onClick={() => openEdit(item.id)}>
          <Pencil size={14} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {error && <div className="px-4 py-3 text-sm text-error">{error}</div>}
        {!issues && !error && (
          <div className="flex items-center gap-2 px-4 py-3 text-sm text-[var(--muted-foreground)]">
            <Loader2 size={14} className="animate-spin" /> Loading issues…
          </div>
        )}
        {issues && issues.length === 0 && (
          <div className="px-4 py-3 text-sm text-[var(--muted-foreground)]">
            No matching issues.
          </div>
        )}
        {issues && issues.length > 0 && (
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-[var(--background)] text-left text-xs text-[var(--muted-foreground)]">
              <tr>
                <th className="px-4 py-2 font-medium">Title</th>
                <th className="px-2 py-2 font-medium whitespace-nowrap">Creator</th>
                <th className="px-2 py-2 font-medium whitespace-nowrap">Created</th>
                <th className="px-2 py-2 font-medium whitespace-nowrap">Agent / Model</th>
                <th className="px-4 py-2 font-medium whitespace-nowrap">Status</th>
              </tr>
            </thead>
            <tbody>
              {issues.map((issue) => (
                <IssueRow
                  key={issue.key}
                  item={item}
                  issue={issue}
                  run={runs[issue.key]}
                  expanded={expanded === issue.key}
                  onToggle={() => setExpanded((k) => (k === issue.key ? null : issue.key))}
                  onRerun={rerun}
                  onOverride={setOverride}
                  catalog={catalog}
                  agentName={agentName}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function IssueRow({
  item,
  issue,
  run,
  expanded,
  onToggle,
  onRerun,
  onOverride,
  catalog,
  agentName,
}: {
  item: IntegrationView;
  issue: Issue;
  run: RunRecord | undefined;
  expanded: boolean;
  onToggle: () => void;
  onRerun: (key: string, verb: string) => void;
  onOverride: (key: string, next: IssueOverride) => void;
  catalog: ReturnType<typeof useInstalledAgents>;
  agentName: (id: string) => string;
}) {
  const active = run?.status === "running";
  const override = item.issueOverrides[issue.key] ?? {};
  const agentId = override.agentId ?? item.agentId;
  // A per-issue agent brings its own model; otherwise the integration's is
  // the default (mirrors `Integration::agent_for`).
  const defaultModel = override.agentId ? null : item.model;
  const hasDetail = !!run && (!!run.error || !!run.commit);

  return (
    <Fragment>
      <tr
        className={cn(
          "border-t border-[var(--atlas-border-subtle)]",
          active && "bg-[var(--atlas-element-active)]",
        )}
      >
        <td className="px-4 py-2">
          <span className="mr-2 text-xs text-[var(--muted-foreground)]">{issue.key}</span>
          {issue.url ? (
            <button
              className="cursor-pointer text-left text-[var(--foreground)] hover:underline"
              title={issue.url}
              onClick={() => void openUrl(issue.url).catch((e) => toast.error(String(e)))}
            >
              {issue.title}
            </button>
          ) : (
            <span className="text-[var(--foreground)]">{issue.title}</span>
          )}
        </td>
        <td className="px-2 py-2 whitespace-nowrap text-[var(--secondary-foreground)]">
          {issue.creator}
        </td>
        <td className="px-2 py-2 whitespace-nowrap text-[var(--secondary-foreground)]">
          {formatCreated(issue.createdAt)}
        </td>
        <td className="px-2 py-1.5">
          <div className="flex w-64 gap-1">
            <select
              className={cn(selectClass, "w-1/2")}
              value={override.agentId ?? ""}
              disabled={active}
              onChange={(e) =>
                onOverride(issue.key, { agentId: e.target.value || null, model: null })
              }
            >
              <option value="">Default ({agentName(item.agentId)})</option>
              {catalog.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
            <ModelSelect
              className="w-1/2"
              agent={catalog.find((a) => a.id === agentId)}
              value={override.model ?? null}
              defaultLabel={defaultModel ? `Default (${defaultModel})` : "Default"}
              onChange={(model) => onOverride(issue.key, { ...override, model })}
            />
          </div>
        </td>
        <td className="px-4 py-2 whitespace-nowrap text-xs">
          <div className="flex items-center gap-2">
            {run ? (
              <button
                className={cn(
                  "inline-flex items-center gap-1",
                  STATUS_CLASS[run.status],
                  hasDetail ? "cursor-pointer hover:underline" : "cursor-default",
                )}
                onClick={hasDetail ? onToggle : undefined}
                title={hasDetail ? "Show details" : undefined}
              >
                {active && <Loader2 size={11} className="animate-spin" />}
                {hasDetail && (
                  <ChevronRight
                    size={11}
                    className={cn("transition-transform", expanded && "rotate-90")}
                  />
                )}
                {STATUS_LABEL[run.status]}
              </button>
            ) : (
              <span className="text-[var(--muted-foreground)]">Queued</span>
            )}
            {run?.status === "interrupted" && (
              <button className={actionButton} onClick={() => onRerun(issue.key, "Continuing")}>
                <StepForward size={11} /> Continue
              </button>
            )}
            {(run?.status === "failed" || run?.status === "skipped") && (
              <button className={actionButton} onClick={() => onRerun(issue.key, "Retrying")}>
                <RotateCcw size={11} /> Retry
              </button>
            )}
            {!run && (
              <button className={actionButton} onClick={() => onRerun(issue.key, "Running")}>
                <Play size={11} /> Run
              </button>
            )}
          </div>
        </td>
      </tr>
      {expanded && run && (
        <tr className="bg-[var(--card)]">
          <td colSpan={5} className="px-4 py-2 text-xs">
            <div className="space-y-1 text-[var(--secondary-foreground)]">
              {run.error && (
                <div>
                  <span className="text-[var(--muted-foreground)]">Reason: </span>
                  <span className="whitespace-pre-wrap break-all text-error">{run.error}</span>
                </div>
              )}
              {run.commit && (
                <div>
                  <span className="text-[var(--muted-foreground)]">Commit: </span>
                  <code>{run.commit}</code>
                </div>
              )}
              <div className="text-[var(--muted-foreground)]">
                {new Date(run.at).toLocaleString()}
                {run.agentId && ` · ${agentName(run.agentId)}`}
                {run.model && ` · ${run.model}`}
              </div>
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
}
