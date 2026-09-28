/**
 * The create / edit-integration dialog: three steps.
 *
 * 1. Source: ONES / Jira / Custom.
 * 2. Source settings + the local code folder (reused as a Project when one
 *    already points there, else added as a new one).
 * 3. Schedule, agent, branch strategy, auto-push.
 *
 * Mounted once in App; open state lives in `useIntegrationDialogStore`.
 */
import { useEffect, useMemo, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { FolderPlus, Loader2, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { basename } from "@/lib/paths";
import { Input } from "@/ui/input";
import { SecretInput } from "@/ui/secret-input";
import { Toggle } from "@/features/settings/components/settings-panel";
import { agents } from "@/features/chat/lib/agents-api";
import type { AgentCatalogEntry } from "@/types/agent-catalog";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import {
  defaultSource,
  integrationsApi,
  useIntegrationDialogStore,
  useIntegrationsStore,
  type BranchMode,
  type IntegrationSource,
  type Issue,
  type SourceKind,
} from "../lib/integrations";

const pillButton =
  "inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] px-3 py-1.5 text-xs font-medium leading-none cursor-pointer transition-colors disabled:cursor-not-allowed disabled:opacity-40";
const selectClass =
  "h-7 w-full rounded-md border border-[var(--border)] bg-[var(--card)] px-2 text-xs text-[var(--foreground)]";
const textareaClass =
  "w-full rounded border border-[var(--border)] bg-[var(--atlas-panel-input-background)] px-2 py-1.5 font-mono text-xs text-[var(--foreground)] outline-none focus:border-[var(--atlas-border-strong)]";

const SOURCES: { kind: SourceKind; label: string; hint: string }[] = [
  { kind: "ones", label: "ONES", hint: "ONES Project work items" },
  { kind: "jira", label: "Jira", hint: "Jira Cloud or Server / Data Center, by JQL" },
  { kind: "custom", label: "Custom", hint: "Any HTTP endpoint returning JSON" },
];

const INTERVALS = [5, 15, 30, 60, 180, 720, 1440];

async function pickFolder(): Promise<string | null> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ directory: true });
    return typeof selected === "string" ? selected : null;
  } catch {
    return null;
  }
}

const samePath = (a: string, b: string) => {
  const n = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return n(a) === n(b);
};

/** The project for `path` in the active org: the existing one, else a new
 *  one (`addProject` also switches to it). */
async function projectFor(path: string): Promise<string | null> {
  const org = useOrgStore.getState().activeOrganisationId;
  const existing = useProjectStore
    .getState()
    .projects.find((p) => p.orgId === org && samePath(p.path, path));
  if (existing) return existing.id;
  return useProjectStore.getState().actions.addProject(path);
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-[var(--secondary-foreground)]">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <p className="mt-1 break-all text-2xs text-[var(--muted-foreground)]">{hint}</p>}
    </label>
  );
}

export function IntegrationDialog() {
  const { dialog, close } = useIntegrationDialogStore();
  const open = dialog.mode !== "closed";
  const editId = dialog.mode === "edit" ? dialog.id : null;
  const editing = useIntegrationsStore((s) => s.items.find((i) => i.id === editId));

  const [step, setStep] = useState(1);
  const [name, setName] = useState("");
  const [source, setSource] = useState<IntegrationSource>(defaultSource("ones"));
  const [secret, setSecret] = useState("");
  const [path, setPath] = useState<string | null>(null);
  const [agentId, setAgentId] = useState("");
  const [interval, setIntervalMinutes] = useState(15);
  const [branchMode, setBranchMode] = useState<BranchMode>({ kind: "current" });
  const [autoPush, setAutoPush] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [catalog, setCatalog] = useState<AgentCatalogEntry[]>([]);
  const [testing, setTesting] = useState(false);
  const [preview, setPreview] = useState<Issue[] | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStep(editing ? 2 : 1);
    setName(editing?.name ?? "");
    setSource(editing?.source ?? defaultSource("ones"));
    setSecret("");
    setPath(editing?.projectPath ?? null);
    setAgentId(editing?.agentId ?? "");
    setIntervalMinutes(editing?.intervalMinutes ?? 15);
    setBranchMode(editing?.branchMode ?? { kind: "current" });
    setAutoPush(editing?.autoPush ?? false);
    setEnabled(editing?.enabled ?? true);
    setPreview(null);
    setSubmitting(false);
    agents
      .catalog()
      .then((c) => setCatalog(c.entries.filter((e) => e.installed || e.kind === "native")))
      .catch(() => setCatalog([]));
    // Seed on open only; a background refresh must not wipe what is typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editId]);

  useEffect(() => {
    if (!agentId && catalog.length) setAgentId(catalog[0].id);
  }, [catalog, agentId]);

  const secretStored = Boolean(editing?.hasSecret);
  const needsSecret = source.kind !== "custom";
  const step2Ok = useMemo(() => {
    if (!path) return false;
    if (needsSecret && !secret && !secretStored) return false;
    switch (source.kind) {
      case "jira":
        return (
          !!source.baseUrl && !!source.jql && (source.deployment === "server" || !!source.email)
        );
      case "ones":
        return !!source.baseUrl && !!source.email && !!source.filter;
      case "custom":
        return !!source.url && !!source.idPath && !!source.titlePath;
    }
  }, [source, path, secret, secretStored, needsSecret]);

  if (!open) return null;
  if (editId && !editing) return null;

  const patch = (p: Partial<IntegrationSource>) =>
    setSource((s) => ({ ...s, ...p }) as IntegrationSource);

  const test = async () => {
    setTesting(true);
    setPreview(null);
    try {
      setPreview(await integrationsApi.test(source, secret || null, editId));
    } catch (e) {
      toast.error("Connection failed: " + String(e));
    } finally {
      setTesting(false);
    }
  };

  const submit = async () => {
    if (!path || !agentId || submitting) return;
    setSubmitting(true);
    try {
      const projectId =
        editing && samePath(editing.projectPath, path) ? editing.projectId : await projectFor(path);
      if (!projectId) throw new Error("could not add the project");
      await integrationsApi.save(
        {
          id: editId ?? crypto.randomUUID(),
          name:
            name.trim() ||
            `${SOURCES.find((s) => s.kind === source.kind)!.label} · ${basename(path)}`,
          enabled,
          source,
          projectId,
          projectPath: path,
          agentId,
          intervalMinutes: interval,
          branchMode,
          autoPush,
        },
        secret || null,
      );
      close();
    } catch (e) {
      toast.error("Could not save the integration: " + String(e));
      setSubmitting(false);
    }
  };

  const remove = async () => {
    if (!editId) return;
    await integrationsApi.remove(editId);
    close();
  };

  return (
    <Dialog.Root open onOpenChange={(next) => !next && close()}>
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
              {editing ? "Edit integration" : "New integration"}
            </Dialog.Title>
            <p className="mt-0.5 text-xs text-[var(--muted-foreground)]">
              Step {step} of 3 ·{" "}
              {step === 1
                ? "Issue source"
                : step === 2
                  ? "Connection & code folder"
                  : "Schedule & agent"}
            </p>
          </div>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3.5">
            {step === 1 &&
              SOURCES.map((s) => (
                <button
                  key={s.kind}
                  type="button"
                  onClick={() => {
                    if (s.kind !== source.kind) setSource(defaultSource(s.kind));
                    setStep(2);
                  }}
                  className={cn(
                    "flex w-full cursor-pointer flex-col items-start rounded-lg border px-3 py-2.5 text-left transition-colors hover:bg-[var(--atlas-element-hover)]",
                    s.kind === source.kind
                      ? "border-[var(--atlas-border-strong)]"
                      : "border-[var(--border)]",
                  )}
                >
                  <span className="text-sm font-medium text-[var(--foreground)]">{s.label}</span>
                  <span className="text-xs text-[var(--muted-foreground)]">{s.hint}</span>
                </button>
              ))}

            {step === 2 && (
              <>
                <Field label="Name">
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Optional"
                  />
                </Field>

                {source.kind === "jira" && (
                  <>
                    <Field label="Jira URL">
                      <Input
                        value={source.baseUrl}
                        onChange={(e) => patch({ baseUrl: e.target.value })}
                        placeholder="https://your-team.atlassian.net"
                      />
                    </Field>
                    <Field label="Deployment">
                      <select
                        className={selectClass}
                        value={source.deployment}
                        onChange={(e) =>
                          patch({ deployment: e.target.value as "cloud" | "server" })
                        }
                      >
                        <option value="cloud">Cloud (email + API token)</option>
                        <option value="server">Server / Data Center (personal access token)</option>
                      </select>
                    </Field>
                    {source.deployment === "cloud" && (
                      <Field label="Email">
                        <Input
                          value={source.email}
                          onChange={(e) => patch({ email: e.target.value })}
                        />
                      </Field>
                    )}
                    <Field
                      label={source.deployment === "cloud" ? "API token" : "Personal access token"}
                      hint={secretStored ? "Stored. Leave empty to keep it." : undefined}
                    >
                      <SecretInput value={secret} onValueChange={setSecret} />
                    </Field>
                    <Field label="JQL" hint="Which issues to develop.">
                      <textarea
                        rows={2}
                        className={textareaClass}
                        value={source.jql}
                        onChange={(e) => patch({ jql: e.target.value })}
                      />
                    </Field>
                  </>
                )}

                {source.kind === "ones" && (
                  <>
                    <Field label="ONES URL">
                      <Input
                        value={source.baseUrl}
                        onChange={(e) => patch({ baseUrl: e.target.value })}
                        placeholder="https://ones.example.com"
                      />
                    </Field>
                    <Field label="Email">
                      <Input
                        value={source.email}
                        onChange={(e) => patch({ email: e.target.value })}
                      />
                    </Field>
                    <Field
                      label="Password"
                      hint={secretStored ? "Stored. Leave empty to keep it." : undefined}
                    >
                      <SecretInput value={secret} onValueChange={setSecret} />
                    </Field>
                    <Field label="Team UUID" hint="Empty = your first team.">
                      <Input
                        value={source.teamUuid}
                        onChange={(e) => patch({ teamUuid: e.target.value })}
                      />
                    </Field>
                    <Field
                      label="Filter (JSON)"
                      hint='e.g. "status_in": ["<status uuid>"], "project_in": [...], "createTime_range": { "gte": "2026-06-01" }. $currentUser is you.'
                    >
                      <textarea
                        rows={5}
                        className={textareaClass}
                        value={source.filter}
                        onChange={(e) => patch({ filter: e.target.value })}
                      />
                    </Field>
                    <Field
                      label="Order by (JSON)"
                      hint='e.g. { "createTime": "DESC" }. Empty = oldest first.'
                    >
                      <textarea
                        rows={3}
                        className={textareaClass}
                        value={source.orderBy ?? ""}
                        onChange={(e) => patch({ orderBy: e.target.value })}
                      />
                    </Field>
                  </>
                )}

                {source.kind === "custom" && (
                  <>
                    <div className="flex gap-2">
                      <div className="w-24">
                        <Field label="Method">
                          <select
                            className={selectClass}
                            value={source.method}
                            onChange={(e) => patch({ method: e.target.value })}
                          >
                            <option>GET</option>
                            <option>POST</option>
                          </select>
                        </Field>
                      </div>
                      <div className="flex-1">
                        <Field label="URL">
                          <Input
                            value={source.url}
                            onChange={(e) => patch({ url: e.target.value })}
                          />
                        </Field>
                      </div>
                    </div>
                    <Field
                      label="Headers"
                      hint="One per line, Name: value. {{secret}} is the token below."
                    >
                      <textarea
                        rows={2}
                        className={textareaClass}
                        value={source.headers.map(([k, v]) => `${k}: ${v}`).join("\n")}
                        onChange={(e) =>
                          patch({
                            headers: e.target.value
                              .split("\n")
                              .map((l) => l.split(/:(.*)/s))
                              .filter((p) => p[0]?.trim())
                              .map(([k, v]) => [k.trim(), (v ?? "").trim()] as [string, string]),
                          })
                        }
                      />
                    </Field>
                    {source.method === "POST" && (
                      <Field label="Body (JSON)">
                        <textarea
                          rows={3}
                          className={textareaClass}
                          value={source.body}
                          onChange={(e) => patch({ body: e.target.value })}
                        />
                      </Field>
                    )}
                    <Field
                      label="Token"
                      hint={secretStored ? "Stored. Leave empty to keep it." : "Optional."}
                    >
                      <SecretInput value={secret} onValueChange={setSecret} />
                    </Field>
                    <p className="text-xs text-[var(--muted-foreground)]">
                      Field mapping — dot paths into the JSON, e.g. <code>data.items</code>,{" "}
                      <code>fields.summary</code>.
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                      {(
                        [
                          ["itemsPath", "List", "empty = the response"],
                          ["idPath", "ID", ""],
                          ["titlePath", "Title", ""],
                          ["bodyPath", "Description", ""],
                          ["urlPath", "Link", ""],
                        ] as const
                      ).map(([k, label, placeholder]) => (
                        <Field key={k} label={label}>
                          <Input
                            value={source[k]}
                            placeholder={placeholder}
                            onChange={(e) => patch({ [k]: e.target.value })}
                          />
                        </Field>
                      ))}
                    </div>
                  </>
                )}

                <div>
                  <button
                    type="button"
                    disabled={testing}
                    onClick={() => void test()}
                    className={cn(
                      pillButton,
                      "bg-[var(--card)] text-[var(--foreground)] hover:bg-[var(--atlas-element-hover)]",
                    )}
                  >
                    {testing && <Loader2 size={12} className="animate-spin" />}
                    Test connection
                  </button>
                  {preview && (
                    <ul className="mt-2 space-y-0.5 text-xs text-[var(--secondary-foreground)]">
                      {preview.length === 0 && <li>Connected — no matching issues right now.</li>}
                      {preview.map((i) => (
                        <li key={i.key} className="truncate">
                          <span className="text-[var(--muted-foreground)]">{i.key}</span> {i.title}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <Field
                  label="Local code folder"
                  hint="Reused if it is already a project; otherwise added as a new project."
                >
                  <button
                    type="button"
                    onClick={async () => {
                      const picked = await pickFolder();
                      if (picked) setPath(picked);
                    }}
                    title={path ?? undefined}
                    className="flex w-full cursor-pointer items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--atlas-panel-input-background)] px-3 py-2 text-sm text-[var(--secondary-foreground)] hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)]"
                  >
                    <FolderPlus size={13} className="shrink-0 text-[var(--muted-foreground)]" />
                    <span className="flex-1 truncate text-left">{path ?? "Choose folder"}</span>
                  </button>
                </Field>
              </>
            )}

            {step === 3 && (
              <>
                <Field label="Pull every">
                  <select
                    className={selectClass}
                    value={interval}
                    onChange={(e) => setIntervalMinutes(Number(e.target.value))}
                  >
                    {INTERVALS.map((m) => (
                      <option key={m} value={m}>
                        {m < 60 ? `${m} minutes` : m === 60 ? "1 hour" : `${m / 60} hours`}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field
                  label="Agent"
                  hint="Runs unattended: its permission requests are approved automatically."
                >
                  <select
                    className={selectClass}
                    value={agentId}
                    onChange={(e) => setAgentId(e.target.value)}
                  >
                    {catalog.length === 0 && <option value="">No agents installed</option>}
                    {catalog.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Branch">
                  <select
                    className={selectClass}
                    value={branchMode.kind}
                    onChange={(e) =>
                      setBranchMode(
                        e.target.value === "perIssue"
                          ? { kind: "perIssue", base: "main" }
                          : { kind: "current" },
                      )
                    }
                  >
                    <option value="current">Commit on the current branch</option>
                    <option value="perIssue">New branch per issue (atlas/&lt;key&gt;)</option>
                  </select>
                </Field>
                {branchMode.kind === "perIssue" && (
                  <Field label="Base branch" hint="Each issue branch starts from here.">
                    <Input
                      value={branchMode.base}
                      onChange={(e) => setBranchMode({ kind: "perIssue", base: e.target.value })}
                    />
                  </Field>
                )}
                <p className="text-xs text-[var(--muted-foreground)]">
                  Each issue is committed with its title as the message.
                </p>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-[var(--secondary-foreground)]">
                    Push after commit
                  </span>
                  <Toggle checked={autoPush} onChange={setAutoPush} />
                </div>
                {editing && (
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-[var(--secondary-foreground)]">
                      Enabled
                    </span>
                    <Toggle checked={enabled} onChange={setEnabled} />
                  </div>
                )}
              </>
            )}
          </div>

          <div className="flex items-center gap-2 px-4 pb-4">
            {editing && (
              <button
                onClick={() => void remove()}
                className={cn(
                  pillButton,
                  "border-transparent bg-error/10 text-error hover:bg-error/15",
                )}
              >
                <Trash2 size={12} />
                Delete
              </button>
            )}
            <div className="ml-auto flex gap-2">
              {step > 1 && (
                <button
                  onClick={() => setStep(step - 1)}
                  className={cn(
                    pillButton,
                    "bg-[var(--card)] text-[var(--secondary-foreground)] hover:bg-[var(--atlas-element-hover)]",
                  )}
                >
                  Back
                </button>
              )}
              {step === 2 && (
                <button
                  disabled={!step2Ok}
                  onClick={() => setStep(3)}
                  className={cn(
                    pillButton,
                    "bg-[var(--card)] text-[var(--foreground)] hover:bg-[var(--atlas-element-hover)]",
                  )}
                >
                  Next
                </button>
              )}
              {step === 3 && (
                <button
                  disabled={!agentId || submitting}
                  onClick={() => void submit()}
                  className={cn(
                    pillButton,
                    "bg-[var(--card)] text-[var(--foreground)] hover:bg-[var(--atlas-element-hover)]",
                  )}
                >
                  {submitting && <Loader2 size={12} className="animate-spin" />}
                  {editing ? "Save" : "Create integration"}
                </button>
              )}
            </div>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
