import { describe, expect, it } from "vitest";
import { extractInjectedContext, stripInjectedContext } from "./atlas-context";

const nextStepsMarker = "\u2550\u2550\u2550 Atlas next-steps \u2550\u2550\u2550";

describe("Atlas injected context", () => {
  it("strips a normal multi-line memory block", () => {
    const text =
      "--- RELEVANT PROJECT MEMORY ---\nnotes\n--- END RELEVANT PROJECT MEMORY ---\n\nwhat changed?";
    expect(stripInjectedContext(text)).toBe("what changed?");
  });

  it("strips a memory block collapsed onto one line", () => {
    const text =
      "--- RELEVANT PROJECT MEMORY --- - AGENTS.md (codex): repo notes --- END RELEVANT PROJECT MEMORY --- abc";
    expect(stripInjectedContext(text)).toBe("abc");
  });

  it("returns nothing when the title is only injected context", () => {
    const text =
      "--- RELEVANT PROJECT MEMORY --- notes --- END RELEVANT PROJECT MEMORY --- --- RECENT SESSION --- User: abc";
    expect(stripInjectedContext(text)).toBe("");
  });

  it("removes the hidden next-steps directive", () => {
    const text = `abc\n\n${nextStepsMarker}\nappend a block`;
    expect(stripInjectedContext(text)).toBe("abc");
  });

  it("still returns block bodies for the Timeline", () => {
    const text = "--- PROJECT MEMORY ---\nfacts\n--- END PROJECT MEMORY ---\n\nafter";
    expect(extractInjectedContext(text)).toEqual({
      prose: "after",
      blocks: [{ label: "PROJECT MEMORY", body: "facts" }],
    });
  });
});
