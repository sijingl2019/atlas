// @vitest-environment happy-dom
//
// The Plan pill is the always-on indicator for an agent that spells plan mode
// as a `collaboration_mode` config option (Codex). Its contract is the
// on/off state and which value a click writes back.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

const invoke = vi.fn(async (_cmd?: string, _args?: unknown) => undefined);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd?: string, args?: unknown) => invoke(cmd, args),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

import { useChatStore } from "../stores/chat-store";
import { PlanModePill } from "./plan-mode-pill";

const TAB = "tab-1";

/** A bound session: `setAcpConfigOption` bails without an agent + session id. */
function bind(tabId: string) {
  act(() =>
    useChatStore.setState((s) => {
      const session = s.sessions[tabId];
      if (session) {
        session.acpAgentId = "agent-1";
        session.acpSessionId = "session-1";
      }
    }),
  );
}

const defaultOption = {
  id: "collaboration_mode",
  name: "Collaboration mode",
  category: "collaboration_mode",
  type: "select",
  currentValue: "default",
  options: [
    { value: "default", name: "Default" },
    { value: "plan", name: "Plan" },
  ],
};

const planOption = { ...defaultOption, currentValue: "plan" };

const pill = () => document.querySelector("button[data-plan-mode]") as HTMLButtonElement | null;

beforeEach(() => {
  cleanup();
  localStorage.clear();
  invoke.mockClear();
  useChatStore.setState({ sessions: {}, activeSessionId: null });
  useChatStore.getState().actions.createSession(TAB, "claude-code");
});

describe("PlanModePill", () => {
  it("renders and reads off when the agent advertises default", () => {
    act(() => useChatStore.getState().actions.setAcpConfigOptions(TAB, [defaultOption]));
    render(<PlanModePill tabId={TAB} />);
    expect(pill()).toBeTruthy();
    expect(pill()!.getAttribute("data-plan-mode")).toBe("off");
    expect(pill()!.getAttribute("aria-pressed")).toBe("false");
  });

  it("highlights when the option reads plan", () => {
    act(() => useChatStore.getState().actions.setAcpConfigOptions(TAB, [planOption]));
    render(<PlanModePill tabId={TAB} />);
    expect(pill()!.getAttribute("data-plan-mode")).toBe("on");
    expect(pill()!.getAttribute("aria-pressed")).toBe("true");
  });

  it("clicks back to default while plan is on", async () => {
    act(() => useChatStore.getState().actions.setAcpConfigOptions(TAB, [planOption]));
    bind(TAB);
    render(<PlanModePill tabId={TAB} />);
    await act(async () => {
      pill()!.click();
    });
    expect(invoke).toHaveBeenCalledWith("agents_set_config_option", {
      key: { agent_id: "agent-1", session_id: "session-1" },
      configId: "collaboration_mode",
      value: "default",
    });
  });

  it("clicks into plan while default is on", async () => {
    act(() => useChatStore.getState().actions.setAcpConfigOptions(TAB, [defaultOption]));
    bind(TAB);
    render(<PlanModePill tabId={TAB} />);
    await act(async () => {
      pill()!.click();
    });
    expect(invoke).toHaveBeenCalledWith("agents_set_config_option", {
      key: { agent_id: "agent-1", session_id: "session-1" },
      configId: "collaboration_mode",
      value: "plan",
    });
  });

  it("renders nothing when the agent advertises no plan option", () => {
    render(<PlanModePill tabId={TAB} />);
    expect(pill()).toBeNull();

    act(() =>
      useChatStore.getState().actions.setAcpConfigOptions(TAB, [
        {
          id: "mode",
          name: "Mode",
          type: "select",
          currentValue: "plan",
          options: [{ value: "plan", name: "Plan" }],
        },
      ]),
    );
    expect(pill()).toBeNull();
  });
});
