import { describe, expect, it } from "vitest";

import { appendNextStepsDirective } from "./next-steps";

describe("appendNextStepsDirective", () => {
  it("leaves slash commands untouched", () => {
    expect(appendNextStepsDirective("/plan")).toBe("/plan");
    expect(appendNextStepsDirective("  /plan  ")).toBe("  /plan  ");
  });

  it("still appends suggestions to normal prompts", () => {
    expect(appendNextStepsDirective("Implement this")).toContain("<next_steps>");
  });
});
