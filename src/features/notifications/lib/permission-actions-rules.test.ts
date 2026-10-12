import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@/features/settings/lib/app-settings";
import {
  decideAgentNotification,
  describePermissionDetail,
  type AgentCtx,
  type AgentNotifyEvent,
} from "./agent-notifier-rules";
import type { NotificationEnv } from "./decide";
import { NO_NATIVE_CAPABILITIES } from "./native-capabilities";
import { encodeBannerPayload, permissionForResponse } from "./native-routing";
import {
  PERMISSION_ACTION_ALLOW,
  PERMISSION_ACTION_DENY,
  bannerAnswerable,
  permissionBannerActions,
  permissionDecisionForAction,
} from "./permission-actions-rules";

const opt = (optionId: string, kind: string) => ({ optionId, name: optionId, kind });
const FULL = [
  opt("always", "allow_always"),
  opt("once", "allow_once"),
  opt("reject", "reject_once"),
  opt("never", "reject_always"),
];
const base = { options: FULL, complete: true, answerable: true, enabled: true };
const ids = (a: { id: string }[]) => a.map((x) => x.id);

describe("permissionBannerActions", () => {
  it("offers Allow once and Deny, both behind the unlock", () => {
    const a = permissionBannerActions(base);
    expect(ids(a)).toEqual([PERMISSION_ACTION_ALLOW, PERMISSION_ACTION_DENY]);
    expect(a.every((x) => x.requiresUnlock)).toBe(true);
    expect(a[1].destructive).toBe(true);
  });

  it("never offers an 'always' answer, whatever the agent offered", () => {
    const only = [opt("a", "allow_always"), opt("n", "reject_always")];
    expect(permissionBannerActions({ ...base, options: only })).toEqual([]);
    // With a once option present, the always ones still are not mapped.
    expect(permissionDecisionForAction(PERMISSION_ACTION_ALLOW, FULL)).toEqual({
      kind: "selected",
      option_id: "once",
    });
    expect(permissionDecisionForAction(PERMISSION_ACTION_DENY, FULL)).toEqual({
      kind: "selected",
      option_id: "reject",
    });
    expect(permissionDecisionForAction(PERMISSION_ACTION_ALLOW, only)).toBeNull();
    expect(permissionDecisionForAction(PERMISSION_ACTION_DENY, only)).toBeNull();
  });

  it("omits Allow (keeps Deny) when the command is not shown in full", () => {
    expect(ids(permissionBannerActions({ ...base, complete: false }))).toEqual([
      PERMISSION_ACTION_DENY,
    ]);
  });

  it("omits Allow without an allow_once option, and Deny without reject_once", () => {
    expect(ids(permissionBannerActions({ ...base, options: [opt("r", "reject_once")] }))).toEqual([
      PERMISSION_ACTION_DENY,
    ]);
    expect(ids(permissionBannerActions({ ...base, options: [opt("o", "allow_once")] }))).toEqual([
      PERMISSION_ACTION_ALLOW,
    ]);
  });

  it("offers nothing when the setting is off or the request is not answerable", () => {
    expect(permissionBannerActions({ ...base, enabled: false })).toEqual([]);
    expect(permissionBannerActions({ ...base, answerable: false })).toEqual([]);
  });

  it("is capability-gated", () => {
    const caps = { ...NO_NATIVE_CAPABILITIES, actions: true, maxActions: 2, responses: true };
    expect(permissionBannerActions({ ...base, caps })).toHaveLength(2);
    expect(permissionBannerActions({ ...base, caps: { ...caps, responses: false } })).toEqual([]);
    expect(permissionBannerActions({ ...base, caps: NO_NATIVE_CAPABILITIES })).toEqual([]);
  });

  it("does not answer plans, questions or outward actions from a banner", () => {
    expect(bannerAnswerable({ kind: "execute", rawInput: { command: "ls" } })).toBe(true);
    expect(bannerAnswerable({ rawInput: { plan: "1. do it" } })).toBe(false);
    expect(bannerAnswerable({ rawInput: { questions: [{ question: "q", options: [] }] } })).toBe(
      false,
    );
  });
});

describe("describePermissionDetail", () => {
  it("is complete for a short command or path", () => {
    expect(
      describePermissionDetail({ kind: "execute", rawInput: { command: "npm test" } }),
    ).toEqual({ text: "Run npm test", complete: true });
    expect(describePermissionDetail({ kind: "execute", title: "rm -rf dist" }).complete).toBe(true);
  });

  it("is incomplete when truncated, multi-line, or only a title is known", () => {
    expect(
      describePermissionDetail({ kind: "execute", rawInput: { command: "a".repeat(200) } })
        .complete,
    ).toBe(false);
    expect(
      describePermissionDetail({ kind: "execute", rawInput: { command: "ls\nrm -rf /" } }).complete,
    ).toBe(false);
    expect(describePermissionDetail({ title: "Fetch docs" }).complete).toBe(false);
    expect(describePermissionDetail(null).complete).toBe(false);
  });

  it("an exactly-at-cap command is still complete", () => {
    const cmd = "x".repeat(80 - "Run ".length);
    expect(describePermissionDetail({ kind: "execute", rawInput: { command: cmd } }).complete).toBe(
      true,
    );
  });
});

describe("permission decisions carry the actions", () => {
  const ctx: AgentCtx = { tabId: "t1", sessionId: "acp-1", agentName: "Claude Code" };
  const env: NotificationEnv = {
    windowFocused: false,
    sinceInputMs: 999_999,
    targetVisible: false,
    projectActive: true,
    away: true,
  };
  const ev = (command: string, options: unknown = FULL): AgentNotifyEvent => ({
    type: "permission_requested",
    requestId: "r1",
    toolCall: { kind: "execute", rawInput: { command } },
    options,
  });

  it("attaches both actions and the request ref", () => {
    const d = decideAgentNotification(ev("npm test"), ctx, env, DEFAULT_SETTINGS);
    expect(ids(d?.native.actions ?? [])).toEqual([PERMISSION_ACTION_ALLOW, PERMISSION_ACTION_DENY]);
    expect(d?.native.permission).toEqual({ sessionId: "acp-1", requestId: "r1" });
  });

  it("truncated command: no Allow button", () => {
    const d = decideAgentNotification(ev("a".repeat(300)), ctx, env, DEFAULT_SETTINGS);
    expect(ids(d?.native.actions ?? [])).toEqual([PERMISSION_ACTION_DENY]);
  });

  it("setting off: no actions", () => {
    const d = decideAgentNotification(ev("npm test"), ctx, env, {
      ...DEFAULT_SETTINGS,
      notifyPermissionActions: false,
    });
    expect(d?.native.actions).toBeUndefined();
    expect(d?.native.permission).toBeUndefined();
  });

  it("malformed options: no actions", () => {
    const d = decideAgentNotification(ev("npm test", "nope"), ctx, env, DEFAULT_SETTINGS);
    expect(d?.native.actions).toBeUndefined();
  });
});

describe("permission payload", () => {
  const target = { type: "session", tabId: "t" } as const;
  const resp = (payload: string | null, actionId: string | null) => ({
    tag: "x",
    actionId,
    payload,
  });

  it("round-trips the request ref for an action", () => {
    const p = encodeBannerPayload(target, { sessionId: "s", requestId: "r" });
    expect(permissionForResponse(resp(p, PERMISSION_ACTION_ALLOW))).toEqual({
      sessionId: "s",
      requestId: "r",
    });
  });

  it("ignores plain clicks and payloads without a request", () => {
    const p = encodeBannerPayload(target, { sessionId: "s", requestId: "r" });
    expect(permissionForResponse(resp(p, null))).toBeNull();
    expect(permissionForResponse(resp(encodeBannerPayload(target), "perm:allow"))).toBeNull();
    expect(permissionForResponse(resp("{bad", "perm:allow"))).toBeNull();
    expect(
      permissionForResponse(resp('{"permission":{"sessionId":"s"}}', "perm:allow")),
    ).toBeNull();
  });
});
