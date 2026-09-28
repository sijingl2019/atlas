/**
 * Agent and model pickers for integrations.
 *
 * An agent only lists its models once a session is open, so the model list
 * is the one the chat composer last saw for that agent (`acp-models-cache`).
 * An agent never used in a chat has none yet: the picker then takes a model
 * id by hand.
 */
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { agents } from "@/features/chat/lib/agents-api";
import { loadCachedAcpModels } from "@/features/chat/lib/acp-models-cache";
import type { AgentCatalogEntry } from "@/types/agent-catalog";

export const selectClass =
  "h-7 w-full rounded-md border border-[var(--border)] bg-[var(--card)] px-2 text-xs text-[var(--foreground)]";

let catalogCache: AgentCatalogEntry[] | null = null;

/** Installed agents (and the built-in one). */
export function useInstalledAgents(): AgentCatalogEntry[] {
  const [list, setList] = useState<AgentCatalogEntry[]>(catalogCache ?? []);
  useEffect(() => {
    agents
      .catalog()
      .then((c) => {
        catalogCache = c.entries.filter((e) => e.installed || e.kind === "native");
        setList(catalogCache);
      })
      .catch(() => {});
  }, []);
  return list;
}

export function ModelSelect({
  agent,
  value,
  onChange,
  defaultLabel = "Agent default",
  className,
}: {
  /** The agent the model belongs to; undefined while the catalog loads. */
  agent: AgentCatalogEntry | undefined;
  value: string | null;
  onChange: (model: string | null) => void;
  defaultLabel?: string;
  className?: string;
}) {
  const models = agent ? (loadCachedAcpModels(agent.agentType)?.availableModels ?? []) : [];
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => setDraft(value ?? ""), [value]);

  if (models.length === 0) {
    return (
      <input
        className={cn(selectClass, className)}
        value={draft}
        placeholder={`${defaultLabel} (or type a model id)`}
        title="Open a chat with this agent once to list its models here."
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => draft.trim() !== (value ?? "") && onChange(draft.trim() || null)}
      />
    );
  }
  return (
    <select
      className={cn(selectClass, className)}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="">{defaultLabel}</option>
      {value && !models.some((m) => m.id === value) && <option value={value}>{value}</option>}
      {models.map((m) => (
        <option key={m.id} value={m.id}>
          {m.name}
        </option>
      ))}
    </select>
  );
}
