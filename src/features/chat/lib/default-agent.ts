// Which coding agent a BRAND-NEW chat starts on.
//
// The user's pick from Settings -> General, resolved against the agents they
// actually have. The native agent is the floor, not a consolation prize: it is
// in-process, so it needs no install, no sign-in and no probe, and it is the
// one agent a fresh profile is guaranteed to have (ADR-0002: Atlas ships no
// ACP agents). A configured agent that is unknown, or that the catalog no
// longer lists as installed, resolves to the native agent instead of naming a
// dead end -- the agent switcher lives inside the composer that an uninstalled
// agent's absence disables, so naming one would leave the user unable to
// switch away from it.
//
// This used to be the native agent unconditionally, and before that a probe
// that started on Claude Code whenever it was installed and authenticated.
// Two things were wrong with the probe: it named an agent a fresh install does
// not have, and it was asynchronous, which made a first-ever launch hold off
// creating the session at all until it settled. Reading a setting keeps this
// synchronous and total -- the value is already in memory, so there is no
// "not decided yet".

import { NATIVE_AGENT_ID, type SwitchableAgent } from "@/types/agent";
import { switchableAgentIds } from "@/features/agents/lib/agent-meta";
import { useAgentRegistryStore } from "@/features/agents/stores/agent-registry-store";
import { useProjectStore } from "@/features/project/stores/project-store";

/** The agent a new chat starts on. Synchronous and total: there is nothing to
 *  probe, so there is no "not decided yet". */
export function defaultAgentForNewSession(): SwitchableAgent {
  const configured = useProjectStore.getState().settings.defaultAgent;
  if (!configured || configured === NATIVE_AGENT_ID) return NATIVE_AGENT_ID;

  // An empty catalog is "not answered yet", never "you have no agents": boot
  // paths run before the first hydrate, and a failed catalog call keeps the
  // previous one rather than emptying it. Trusting the user's explicit pick
  // there beats overriding it with a fallback that is wrong for everyone who
  // configured one. Once the catalog is here, an agent it does not list as
  // installed is the real "gone" case and falls back.
  if (useAgentRegistryStore.getState().catalog.length === 0) return configured;
  return switchableAgentIds().includes(configured) ? configured : NATIVE_AGENT_ID;
}
