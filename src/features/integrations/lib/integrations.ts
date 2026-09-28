/**
 * Integrations: pull issues from ONES / Jira / a custom endpoint and let an
 * agent develop each one (`src-tauri/src/commands/integrations`). This file is
 * the wire types, the invoke wrappers, the list store and the dialog's open
 * state.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { basename } from "@/lib/paths";

export type JiraDeployment = "cloud" | "server";

export type IntegrationSource =
  | { kind: "jira"; baseUrl: string; deployment: JiraDeployment; email: string; jql: string }
  | {
      kind: "ones";
      baseUrl: string;
      teamUuid: string;
      email: string;
      filter: string;
      orderBy: string;
    }
  | {
      kind: "custom";
      url: string;
      method: string;
      headers: [string, string][];
      body: string;
      itemsPath: string;
      idPath: string;
      titlePath: string;
      bodyPath: string;
      urlPath: string;
      creatorPath: string;
      createdPath: string;
    };

export type SourceKind = IntegrationSource["kind"];

export type BranchMode = { kind: "current" } | { kind: "perIssue"; base: string };

export interface Integration {
  id: string;
  name: string;
  enabled: boolean;
  source: IntegrationSource;
  projectId: string;
  projectPath: string;
  agentId: string;
  /** null = the agent's own default. */
  model: string | null;
  intervalMinutes: number;
  branchMode: BranchMode;
  autoPush: boolean;
  /** Per-issue agent / model, by issue key. */
  issueOverrides: Record<string, IssueOverride>;
  /** Set while it is in the Trash. */
  deletedAt?: string | null;
}

export interface IssueOverride {
  agentId?: string | null;
  model?: string | null;
}

export type RunStatus = "running" | "done" | "failed" | "skipped" | "interrupted";

export interface RunRecord {
  issueKey: string;
  title: string;
  status: RunStatus;
  commit: string | null;
  error: string | null;
  at: string;
  sessionId: string | null;
  /** The connection the session runs on (for showing it while live). */
  agentHandle: string | null;
  agentId: string | null;
  model: string | null;
}

export interface IntegrationView extends Integration {
  hasSecret: boolean;
  lastRun: RunRecord | null;
  pollError: string | null;
}

export interface Issue {
  key: string;
  title: string;
  body: string;
  url: string;
  creator: string;
  /** ISO string, or epoch seconds / ms / µs — see `formatCreated`. */
  createdAt: string;
}

export const INTEGRATIONS_EVENT = "atlas:integrations:changed";

export const integrationsApi = {
  list: () => invoke<IntegrationView[]>("integrations_list"),
  /** `secret: null` keeps the stored one. */
  save: (integration: Integration, secret: string | null) =>
    invoke<void>("integrations_save", { integration, secret }),
  /** Move to the Trash (restorable). */
  remove: (id: string) => invoke<void>("integrations_delete", { id }),
  restore: (id: string) => invoke<void>("integrations_restore", { id }),
  /** Delete for good (emptying the Trash). */
  purge: (id: string) => invoke<void>("integrations_purge", { id }),
  /** Copy an integration (starts disabled); resolves the copy's id. */
  duplicate: (id: string) => invoke<string>("integrations_duplicate", { id }),
  test: (source: IntegrationSource, secret: string | null, id: string | null) =>
    invoke<Issue[]>("integrations_test", { source, secret, id }),
  runNow: (id: string) => invoke<void>("integrations_run_now", { id }),
  /** Run one issue now: continue an interrupted run, else start afresh. */
  rerun: (id: string, issueKey: string) => invoke<void>("integrations_rerun", { id, issueKey }),
  runs: (id: string) => invoke<RunRecord[]>("integrations_runs", { id }),
  /** Fetch the tracker's current list, live. */
  issues: (id: string) => invoke<Issue[]>("integrations_issues", { id }),
};

/** The default ONES filter: work items assigned to me. `$currentUser` is
 *  ONES's own placeholder. Narrow it with `status_in` (status uuids),
 *  `project_in`, `createTime_range: { gte: "2026-06-01" }`, …; a JSON array
 *  is a list of OR'd filters. */
export const DEFAULT_ONES_FILTER = JSON.stringify({ assign_in: ["$currentUser"] }, null, 2);

export const DEFAULT_ONES_ORDER_BY = JSON.stringify({ createTime: "ASC" }, null, 2);

export const DEFAULT_JQL =
  'assignee = currentUser() AND statusCategory = "To Do" ORDER BY priority DESC';

export function defaultSource(kind: SourceKind): IntegrationSource {
  switch (kind) {
    case "jira":
      return { kind, baseUrl: "", deployment: "cloud", email: "", jql: DEFAULT_JQL };
    case "ones":
      return {
        kind,
        baseUrl: "",
        teamUuid: "",
        email: "",
        filter: DEFAULT_ONES_FILTER,
        orderBy: DEFAULT_ONES_ORDER_BY,
      };
    case "custom":
      return {
        kind,
        url: "",
        method: "GET",
        headers: [["Authorization", "Bearer {{secret}}"]],
        body: "",
        itemsPath: "",
        idPath: "id",
        titlePath: "title",
        bodyPath: "description",
        urlPath: "",
        creatorPath: "",
        createdPath: "",
      };
  }
}

// ── List store ─────────────────────────────────────────────────────────────

interface IntegrationsState {
  items: IntegrationView[];
  /** Resolves false when the backend could not answer. */
  refresh: () => Promise<boolean>;
}

export const useIntegrationsStore = create<IntegrationsState>((set) => ({
  items: [],
  refresh: async () => {
    try {
      set({ items: await integrationsApi.list() });
      return true;
    } catch (e) {
      console.warn("[integrations] list failed", e);
      return false;
    }
  },
}));

let listening = false;
/** Load and follow the backend's change event. Idempotent.
 *
 *  The rail mounts while the backend's `setup` may still be running, and a
 *  command whose state is not managed yet fails — so the first load retries
 *  (1s, 2s, 4s …, ten tries) instead of leaving the list empty until the
 *  next change event. */
export function startIntegrationsSync(): void {
  if (listening) return;
  listening = true;
  const { refresh } = useIntegrationsStore.getState();
  void listen(INTEGRATIONS_EVENT, () => void refresh()).catch(() => {});
  const attempt = async (n: number) => {
    if ((await refresh()) || n >= 10) return;
    setTimeout(() => void attempt(n + 1), Math.min(1000 * 2 ** n, 15000));
  };
  void attempt(0);
}

// ── Dialog open state (mounted once in App, like ProjectDialog) ────────────

export type IntegrationDialogState =
  | { mode: "closed" }
  | { mode: "create" }
  | { mode: "edit"; id: string };

export const useIntegrationDialogStore = create<{
  dialog: IntegrationDialogState;
  openCreate: () => void;
  openEdit: (id: string) => void;
  close: () => void;
}>((set) => ({
  dialog: { mode: "closed" },
  openCreate: () => set({ dialog: { mode: "create" } }),
  openEdit: (id) => set({ dialog: { mode: "edit", id } }),
  close: () => set({ dialog: { mode: "closed" } }),
}));

/** What an integration is called in the UI: its project's name (the source
 *  is told apart by its icon). */
export function integrationLabel(item: { projectId: string; projectPath: string }): string {
  const project = useProjectStore.getState().projects.find((p) => p.id === item.projectId);
  return project?.name ?? basename(item.projectPath);
}

/** Open (or focus) an integration's issue-list tab. */
export function openIntegrationTab(item: {
  id: string;
  projectId: string;
  projectPath: string;
}): void {
  useLayoutStore.getState().actions.addTab({
    id: `integration:${item.id}`,
    type: "integration",
    title: integrationLabel(item),
    closable: true,
    dirty: false,
    data: { integrationId: item.id },
  });
}

/** A tracker timestamp for display: ISO strings parsed, epoch numbers read
 *  as seconds, milliseconds or microseconds by magnitude. */
export function formatCreated(raw: string): string {
  if (!raw) return "";
  let ms: number;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    ms = n > 1e14 ? n / 1000 : n > 1e11 ? n : n * 1000;
  } else {
    ms = Date.parse(raw);
  }
  return Number.isNaN(ms) ? raw : new Date(ms).toLocaleString();
}

/** The saved config inside a view (the view's extra fields stripped). */
export function toIntegration(view: IntegrationView): Integration {
  const { hasSecret: _h, lastRun: _l, pollError: _p, ...integration } = view;
  return integration;
}

/** Copy an integration and open the copy for editing. It starts disabled,
 *  so it does not develop the original's issues before it is changed. */
export async function duplicateIntegration(id: string): Promise<void> {
  const copy = await integrationsApi.duplicate(id);
  // The dialog seeds from the list, so the copy must be in it first.
  await useIntegrationsStore.getState().refresh();
  useIntegrationDialogStore.getState().openEdit(copy);
}
