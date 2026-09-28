/**
 * Integrations: pull issues from ONES / Jira / a custom endpoint and let an
 * agent develop each one (`src-tauri/src/commands/integrations`). This file is
 * the wire types, the invoke wrappers, the list store and the dialog's open
 * state.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";

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
  intervalMinutes: number;
  branchMode: BranchMode;
  autoPush: boolean;
}

export type RunStatus = "running" | "done" | "failed" | "skipped";

export interface RunRecord {
  issueKey: string;
  title: string;
  status: RunStatus;
  commit: string | null;
  error: string | null;
  at: string;
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
}

export const INTEGRATIONS_EVENT = "atlas:integrations:changed";

export const integrationsApi = {
  list: () => invoke<IntegrationView[]>("integrations_list"),
  /** `secret: null` keeps the stored one. */
  save: (integration: Integration, secret: string | null) =>
    invoke<void>("integrations_save", { integration, secret }),
  remove: (id: string) => invoke<void>("integrations_delete", { id }),
  test: (source: IntegrationSource, secret: string | null, id: string | null) =>
    invoke<Issue[]>("integrations_test", { source, secret, id }),
  runNow: (id: string) => invoke<void>("integrations_run_now", { id }),
  runs: (id: string) => invoke<RunRecord[]>("integrations_runs", { id }),
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
      };
  }
}

// ── List store ─────────────────────────────────────────────────────────────

interface IntegrationsState {
  items: IntegrationView[];
  refresh: () => Promise<void>;
}

export const useIntegrationsStore = create<IntegrationsState>((set) => ({
  items: [],
  refresh: async () => {
    try {
      set({ items: await integrationsApi.list() });
    } catch {
      // Outside Tauri (tests, the design gallery) there is no backend.
    }
  },
}));

let listening = false;
/** Load once and follow the backend's change event. Idempotent. */
export function startIntegrationsSync(): void {
  if (listening) return;
  listening = true;
  const { refresh } = useIntegrationsStore.getState();
  void refresh();
  void listen(INTEGRATIONS_EVENT, () => void refresh()).catch(() => {});
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
