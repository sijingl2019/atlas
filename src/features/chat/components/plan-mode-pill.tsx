import { memo, useMemo } from "react";
import { ClipboardList } from "lucide-react";
import { cn } from "@/lib/utils";

import { useChatStore } from "../stores/chat-store";
import { collaborationModeOf } from "../lib/acp-config-options";
import { composerPillClass } from "./composer-dropup";

/**
 * The agent's plan mode, as a composer-footer pill.
 *
 * Codex spells plan mode as a `category: "collaboration_mode"` config option
 * (`default` | `plan`) rather than an ACP session mode, so it used to be
 * visible only inside the Options popover -- and `/plan`, which is how most
 * people turn it on, was sent to the agent as a prompt. This pill is the
 * always-on indicator: it lights up whenever the option reads `plan`,
 * whichever surface flipped it (the `/plan` command, this pill, or the Options
 * popover), because all three write the same advertised option and all three
 * are fed by the same `config_options_updated` delta.
 *
 * It is driven by the LIVE option blob only -- never the per-agent cache the
 * Options pill falls back to. A cached value belongs to whichever session last
 * wrote it, and lighting up "Plan" from another session's leftover would state
 * a mode this session is not in.
 *
 * Renders nothing for an agent that advertises no plan choice. Claude Code is
 * the case that matters: its plan mode is the ACP `mode` select, which the
 * composer's mode pill already shows -- so there is exactly one indicator per
 * agent, never two disagreeing ones (ADR-0003: render what ACP gives, nothing
 * else).
 */
export const PlanModePill = memo(function PlanModePill({ tabId }: { tabId: string }) {
  const rawConfigOptions = useChatStore((s) => s.sessions[tabId]?.acpConfigOptions);
  const { setAcpConfigOption } = useChatStore.use.actions();

  const mode = useMemo(() => collaborationModeOf(rawConfigOptions), [rawConfigOptions]);
  if (!mode) return null;

  const active = mode.currentValue === mode.planValue;
  return (
    <button
      onClick={() =>
        void setAcpConfigOption(tabId, mode.id, active ? mode.defaultValue : mode.planValue)
      }
      aria-pressed={active}
      // Read by the component test: the pill's contract is its on/off state,
      // and `aria-pressed` alone cannot tell "off" from "absent".
      data-plan-mode={active ? "on" : "off"}
      className={cn(
        composerPillClass(false),
        active && "border-[var(--primary)] bg-[var(--primary)]/15 text-[var(--foreground)]",
      )}
      title={
        active
          ? "Plan mode is on \u2014 the agent plans before making changes. Click to return to Default."
          : "Turn plan mode on: the agent plans before making changes."
      }
    >
      <ClipboardList
        size={11}
        className={cn(
          "shrink-0",
          active ? "text-[var(--primary)]" : "text-[var(--muted-foreground)]",
        )}
      />
      <span className="ml-1.5 whitespace-nowrap">Plan</span>
    </button>
  );
});
