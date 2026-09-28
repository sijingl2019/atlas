// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
const resumeIntoTab = vi.fn(async (..._args: unknown[]) => ({ ok: true as const }));
vi.mock("./open-agent-session", () => ({
  resumeIntoTab: (...a: unknown[]) => resumeIntoTab(...a),
}));

import { useChatStore } from "../stores/chat-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { RETRY_AFTER_RESTART, restoreChatTabs, startChatRestoreTracking } from "./chat-restore";

describe("chat restore", () => {
  it("brings a blocked chat back and has it ask again", async () => {
    const stop = startChatRestoreTracking();
    const chat = useChatStore.getState().actions;
    chat.createSession("chat-a", "codex");
    chat.setAcpBinding("chat-a", "agent-1", "sess-a", "/proj");
    chat.addMessage("chat-a", "user", "hi");
    chat.pushPermission({
      agentId: "agent-1",
      acpSessionId: "sess-a",
      requestId: "r1",
      toolCall: { toolCallId: "tc", title: "rm", kind: "execute", status: "pending" },
      options: [],
    } as never);
    stop();

    // The restart: the tab is back, its session is not.
    chat.removeSession("chat-a");
    useLayoutStore.setState({
      tabs: [{ id: "chat-a", type: "chat", title: "Chat", closable: true, dirty: false, data: {} }],
    } as never);
    const sent = vi.fn();
    window.addEventListener("atlas:chat-send", (e) => sent((e as CustomEvent).detail));

    restoreChatTabs("/proj");
    await vi.waitFor(() => expect(sent).toHaveBeenCalled());
    expect(resumeIntoTab).toHaveBeenCalledWith(
      "chat-a",
      expect.objectContaining({ acpSessionId: "sess-a", cwd: "/proj" }),
    );
    expect(sent).toHaveBeenCalledWith({ tabId: "chat-a", text: RETRY_AFTER_RESTART });
  });
});
