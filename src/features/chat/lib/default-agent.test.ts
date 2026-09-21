// Which agent a brand-new chat starts on, now that it is a setting.
//
// The rule worth pinning: the configured id is honoured only while it names an
// agent the catalog actually lists as installed. A stale pick (uninstalled, or
// a typo in config.toml) must resolve to the native agent rather than name a
// dead end -- the agent switcher lives inside the composer an unavailable
// agent's absence disables.

import { beforeEach, describe, expect, it, vi } from "vitest";

type AgentCatalogEntry = import("@/types/agent-catalog").AgentCatalogEntry;

const mocks = vi.hoisted(() => ({
  defaultAgent: "cersei",
  catalog: [] as unknown[],
}));

vi.mock("@/features/project/stores/project-store", () => ({
  useProjectStore: Object.assign(() => undefined, {
    getState: () => ({ settings: { defaultAgent: mocks.defaultAgent } }),
  }),
}));

vi.mock("@/features/agents/stores/agent-registry-store", () => ({
  useAgentRegistryStore: Object.assign(() => undefined, {
    getState: () => ({
      catalog: mocks.catalog,
      catalogById: Object.fromEntries(
        (mocks.catalog as Array<{ id: string; agentType: string }>).flatMap((e) => [
          [e.id, e],
          [e.agentType, e],
        ]),
      ),
    }),
  }),
}));

const { defaultAgentForNewSession } = await import("./default-agent");

/** Fill in the fields these tests don't care about. */
function entry(e: Partial<AgentCatalogEntry> & Pick<AgentCatalogEntry, "id">): AgentCatalogEntry {
  return {
    agentType: e.id,
    name: e.id,
    description: null,
    version: null,
    kind: "external",
    source: "installed",
    resolvedPath: null,
    installed: true,
    supportsModes: true,
    supportsModels: true,
    transcript: "none",
    login: null,
    iconDataUrl: null,
    helpUrl: null,
    repository: null,
    website: null,
    platformSupported: true,
    distributionKind: "binary",
    unverified: false,
    unsupportedReason: null,
    ...e,
  } as AgentCatalogEntry;
}

/** The native agent, which every install has and no install can remove. */
const NATIVE = entry({
  id: "cersei",
  agentType: "cersei",
  name: "Atlas Agent",
  kind: "native",
  source: "in-process",
  installed: false,
});

/** The user installed Codex from the Marketplace. */
const CODEX = entry({ id: "codex", agentType: "codex", name: "Codex", source: "npx" });

beforeEach(() => {
  mocks.defaultAgent = "cersei";
  mocks.catalog = [NATIVE];
});

describe("the agent a new chat starts on", () => {
  it("is the native agent by default", () => {
    // ADR-0002: Atlas ships no ACP agents, so the native agent is the one
    // thing a fresh install is guaranteed to have.
    expect(defaultAgentForNewSession()).toBe("cersei");
  });

  it("is the configured agent once it is installed", () => {
    mocks.catalog = [NATIVE, CODEX];
    mocks.defaultAgent = "codex";
    expect(defaultAgentForNewSession()).toBe("codex");
  });

  it("falls back to the native agent when the configured one is gone", () => {
    // The pick outlived an uninstall. Naming Codex here would render a chat
    // whose composer is disabled by the missing agent, with no way back.
    mocks.defaultAgent = "codex";
    expect(defaultAgentForNewSession()).toBe("cersei");
  });

  it("falls back to the native agent when the configured id is nonsense", () => {
    mocks.defaultAgent = "not-an-agent";
    expect(defaultAgentForNewSession()).toBe("cersei");
  });

  it("trusts the configured agent before the catalog has answered", () => {
    // Boot creates the session before the first hydrate lands, and a failed
    // catalog call keeps the previous one rather than emptying it -- an empty
    // catalog is "not answered yet", never "you have no agents". Overriding
    // the user's explicit pick there would be wrong for everyone who set one.
    mocks.catalog = [];
    mocks.defaultAgent = "codex";
    expect(defaultAgentForNewSession()).toBe("codex");
  });
});
