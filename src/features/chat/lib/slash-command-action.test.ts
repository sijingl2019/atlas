import { describe, expect, it } from "vitest";

import { configActionOf, resolveSlashSubmission } from "./slash-command-action";

/** The block Codex's adapter attaches to `/plan` (see
 *  @agentclientprotocol/codex-acp's getBuiltinCommands). */
const planMeta = {
  _meta: {
    commandAction: {
      kind: "setConfigOption",
      configId: "collaboration_mode",
      value: "plan",
      resetValue: "default",
      presentation: "state",
    },
  },
};

describe("configActionOf", () => {
  it("reads a setConfigOption action off the command's _meta", () => {
    expect(configActionOf({ name: "plan", ...planMeta })).toEqual({
      configId: "collaboration_mode",
      value: "plan",
    });
  });

  it("ignores a prefixPrompt action", () => {
    // /goal is the other action the adapter knows; Atlas keeps it passthrough
    // rather than guessing at a prompt it would have to synthesize itself.
    expect(
      configActionOf({
        name: "goal",
        _meta: { commandAction: { kind: "prefixPrompt", prefix: "/goal" } },
      }),
    ).toBeNull();
  });

  it("ignores a command with no _meta at all", () => {
    expect(configActionOf({ name: "status" })).toBeNull();
  });

  it("ignores a malformed action rather than guessing", () => {
    expect(configActionOf({ name: "x", _meta: {} })).toBeNull();
    expect(configActionOf({ name: "x", _meta: { commandAction: "nonsense" } })).toBeNull();
    expect(
      configActionOf({
        name: "x",
        _meta: { commandAction: { kind: "setConfigOption", configId: "c" } },
      }),
    ).toBeNull();
    expect(
      configActionOf({
        name: "x",
        _meta: { commandAction: { kind: "setConfigOption", configId: "", value: "v" } },
      }),
    ).toBeNull();
    expect(
      configActionOf({
        name: "x",
        _meta: { commandAction: { kind: "setConfigOption", configId: "c", value: "" } },
      }),
    ).toBeNull();
  });

  it("is null for non-objects", () => {
    expect(configActionOf(null)).toBeNull();
    expect(configActionOf(undefined)).toBeNull();
    expect(configActionOf("plan")).toBeNull();
  });
});

describe("resolveSlashSubmission", () => {
  const plan = {
    name: "plan",
    configAction: { configId: "collaboration_mode", value: "plan" },
  };
  const status = { name: "status" };

  it("resolves a bare /plan to its config action", () => {
    expect(resolveSlashSubmission("/plan", [plan, status])).toEqual({
      configId: "collaboration_mode",
      value: "plan",
    });
  });

  it("tolerates surrounding whitespace", () => {
    expect(resolveSlashSubmission("  /plan  ", [plan])).toEqual({
      configId: "collaboration_mode",
      value: "plan",
    });
  });

  it("does NOT intercept /plan with arguments", () => {
    // The agent's own usage reply is the honest answer; Atlas must not decide
    // which argument was meant to be dropped.
    expect(resolveSlashSubmission("/plan do the thing", [plan])).toBeNull();
  });

  it("leaves passthrough commands and non-slash text alone", () => {
    expect(resolveSlashSubmission("/status", [plan, status])).toBeNull();
    expect(resolveSlashSubmission("/fork", [plan, status])).toBeNull();
    expect(resolveSlashSubmission("hello", [plan, status])).toBeNull();
    expect(resolveSlashSubmission("/", [plan, status])).toBeNull();
    expect(resolveSlashSubmission("", [plan])).toBeNull();
  });

  it("does not resolve a command whose action the mapping dropped", () => {
    expect(resolveSlashSubmission("/plan", [{ name: "plan" }])).toBeNull();
  });
});
