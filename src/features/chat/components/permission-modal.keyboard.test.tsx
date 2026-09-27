// @vitest-environment happy-dom
//
// Several permission cards can be on screen at once — one per subagent
// column — and each listens for keys on the window. Only the card that owns
// the keyboard may answer; the others must ignore Enter, digits and Esc.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

const invoke = vi.fn(async (..._args: unknown[]) => undefined);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));

import { useChatStore } from "../stores/chat-store";
import { PermissionModal } from "./permission-modal";

function seed(tabId: string, acpSessionId: string, requestId: string) {
  const { actions } = useChatStore.getState();
  actions.createSession(tabId, "codex");
  actions.setAcpBinding(tabId, "agent-1", acpSessionId, "/tmp");
  actions.pushPermission({
    agentId: "agent-1",
    acpSessionId,
    requestId,
    toolCall: { toolCallId: "tc", title: "rm -rf dist", kind: "execute", status: "pending" },
    options: [
      { optionId: "yes", name: "Yes", kind: "allow_once" },
      { optionId: "no", name: "No", kind: "reject_once" },
    ],
  } as never);
}

const responded = () =>
  invoke.mock.calls
    .filter(([cmd]) => cmd === "agents_respond_permission")
    .map(([, args]) => (args as { sessionId: string }).sessionId);

describe("PermissionModal keyboard ownership", () => {
  beforeEach(() => {
    localStorage.clear();
    invoke.mockClear();
    useChatStore.setState({ sessions: {}, pendingPermissions: {}, activeSessionId: null });
    seed("a", "sess-a", "req-a");
    seed("b", "sess-b", "req-b");
  });
  afterEach(cleanup);

  it("answers Enter only on the card that owns the keyboard", () => {
    render(
      <>
        <PermissionModal tabId="a" keyboard={false} />
        <PermissionModal tabId="b" keyboard />
      </>,
    );
    fireEvent.keyDown(window, { key: "Enter" });
    expect(responded()).toEqual(["sess-b"]);
  });

  it("keeps the keyboard by default", () => {
    render(<PermissionModal tabId="a" />);
    fireEvent.keyDown(window, { key: "Enter" });
    expect(responded()).toEqual(["sess-a"]);
  });
});
