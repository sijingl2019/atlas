import { beforeEach, describe, expect, it, vi } from "vitest";

const respondPermission = vi.fn();
const popPermission = vi.fn();
let pending: Record<string, unknown[]> = {};

vi.mock("@/features/chat/lib/agents-api", () => ({
  agents: { respondPermission: (...a: unknown[]) => respondPermission(...a) },
}));
vi.mock("@/features/chat/stores/chat-store", () => ({
  useChatStore: { getState: () => ({ pendingPermissions: pending, actions: { popPermission } }) },
}));

import { encodeBannerPayload } from "./native-routing";
import { answerPermissionFromBanner } from "./permission-actions";

const payload = encodeBannerPayload(
  { type: "session", tabId: "t" },
  { sessionId: "acp-1", requestId: "r1" },
);
const response = (actionId: string | null, p: string | null = payload) => ({
  tag: "permission:x",
  actionId,
  payload: p,
});
const request = {
  agentId: "agent-1",
  acpSessionId: "acp-1",
  requestId: "r1",
  options: [
    { optionId: "always", name: "Always", kind: "allow_always" },
    { optionId: "once", name: "Once", kind: "allow_once" },
    { optionId: "no", name: "No", kind: "reject_once" },
  ],
};

beforeEach(() => {
  respondPermission.mockReset().mockResolvedValue(undefined);
  popPermission.mockReset();
  pending = { "acp-1": [request] };
});

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("answerPermissionFromBanner", () => {
  it("Allow answers with the allow_once option and closes the in-app request", async () => {
    answerPermissionFromBanner(response("perm:allow"));
    await settle();
    expect(respondPermission).toHaveBeenCalledWith("agent-1", "acp-1", "r1", {
      kind: "selected",
      option_id: "once",
    });
    expect(popPermission).toHaveBeenCalledWith("acp-1", "r1");
  });

  it("Deny answers with reject_once", async () => {
    answerPermissionFromBanner(response("perm:deny"));
    await settle();
    expect(respondPermission).toHaveBeenCalledWith("agent-1", "acp-1", "r1", {
      kind: "selected",
      option_id: "no",
    });
  });

  it("is a no-op for a request that is already resolved or unknown", async () => {
    pending = {};
    answerPermissionFromBanner(response("perm:allow"));
    await settle();
    expect(respondPermission).not.toHaveBeenCalled();
  });

  it("ignores plain clicks, foreign actions and payloads without a request", async () => {
    answerPermissionFromBanner(response(null));
    answerPermissionFromBanner(response("something:else"));
    answerPermissionFromBanner(
      response("perm:allow", encodeBannerPayload({ type: "session", tabId: "t" })),
    );
    await settle();
    expect(respondPermission).not.toHaveBeenCalled();
  });

  it("never answers when only 'always' options remain", async () => {
    pending = { "acp-1": [{ ...request, options: [request.options[0]] }] };
    answerPermissionFromBanner(response("perm:allow"));
    await settle();
    expect(respondPermission).not.toHaveBeenCalled();
  });
});
