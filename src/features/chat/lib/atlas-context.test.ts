import { describe, expect, it } from "vitest";

import { extractInjectedContext, stripInjectedContext } from "./atlas-context";

/** The wire prompt `agents_send` composes, as an agent echoes it back. Mirrors
 *  `memory_pack::compose_injection` — if the two drift, the chat renders Atlas's
 *  scaffolding as the user's message. */
const NOTE =
  "Background context from Atlas, not part of the user's message. Do not save any of it to your own memory.";
const wire = (blocks: string[], userText: string) =>
  `<atlas-memory>\n${NOTE}\n${blocks.join("\n\n")}\n</atlas-memory>\n\n${userText}`;

describe("the injected-context envelope", () => {
  it("drops the envelope and its note, keeping only what the user typed", () => {
    const text = wire(
      [
        "--- SHARED MEMORY ---\n[DECISIONS]\n- Use RS256 (by codex)\n--- END SHARED MEMORY ---",
        "--- RECENT SESSION ---\nUser: hi\n--- END RECENT SESSION ---",
      ],
      "why is auth failing?",
    );
    expect(stripInjectedContext(text)).toBe("why is auth failing?");
    for (const leaked of ["<atlas-memory>", "</atlas-memory>", NOTE, "RS256"]) {
      expect(stripInjectedContext(text)).not.toContain(leaked);
    }
  });

  it("still recovers each block for the Timeline's per-block cards", () => {
    const { blocks } = extractInjectedContext(
      wire(
        [
          "--- SHARED MEMORY ---\nfacts\n--- END SHARED MEMORY ---",
          "--- PROJECT MEMORY ---\nconventions\n--- END PROJECT MEMORY ---",
        ],
        "go on",
      ),
    );
    expect(blocks).toEqual([
      { label: "SHARED MEMORY", body: "facts" },
      { label: "PROJECT MEMORY", body: "conventions" },
    ]);
  });

  it("drops the session-start briefing's working-memory and index blocks too", () => {
    const text = wire(
      [
        "--- SHARED MEMORY — WORKING MEMORY ---\n[ACTIVE PLAN] (by codex)\nMigrate auth\n--- END SHARED MEMORY ---",
        "--- SHARED MEMORY — INDEX ---\n[DECISIONS]\n- Use RS256 (by codex)\n--- END SHARED MEMORY ---",
      ],
      "why is the token rejected?",
    );
    const { prose, blocks } = extractInjectedContext(text);
    expect(prose).toBe("why is the token rejected?");
    expect(blocks.map((b) => b.label)).toEqual(["SHARED MEMORY", "SHARED MEMORY"]);
  });

  it("still strips the bare blocks written before the envelope existed", () => {
    const legacy = "--- SHARED MEMORY ---\nfacts\n--- END SHARED MEMORY ---\n\nwhat changed?";
    expect(stripInjectedContext(legacy)).toBe("what changed?");
  });

  it("leaves prose that merely mentions the tag alone", () => {
    const text = "we wrap blocks in an <atlas-memory> tag now";
    expect(stripInjectedContext(text)).toBe(text);
  });

  it("strips a truncated envelope whose closing tag was cut off", () => {
    expect(stripInjectedContext(`<atlas-memory>\n${NOTE}\nfacts`)).toBe("");
  });

  /** Regression: the closing tag has to close an unterminated block too. It
   *  didn't, so the block ran on past the tag and ate the user's message —
   *  the chat rendered an empty bubble. The Rust parser cannot reach this
   *  state, and the two must not disagree about where a block ends. */
  it("closes an unterminated block at the closing tag instead of eating the message", () => {
    const text = `<atlas-memory>\n${NOTE}\n--- SHARED MEMORY ---\nfacts\n</atlas-memory>\n\nwhat changed?`;
    const { prose, blocks } = extractInjectedContext(text);
    expect(prose).toBe("what changed?");
    expect(blocks).toEqual([{ label: "SHARED MEMORY", body: "facts" }]);
  });
});

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

  it("cuts at the Codex boundary marker and keeps the user's words", () => {
    const text =
      "--- PROJECT MEMORY ---\nfacts\n--- END PROJECT MEMORY ---\n\n## My request for Codex:\n\nadd a knowledge base";
    expect(stripInjectedContext(text)).toBe("add a knowledge base");
    expect(extractInjectedContext(text)).toEqual({
      prose: "add a knowledge base",
      blocks: [{ label: "PROJECT MEMORY", body: "facts" }],
    });
  });

  it("still returns block bodies for the Timeline", () => {
    const text = "--- PROJECT MEMORY ---\nfacts\n--- END PROJECT MEMORY ---\n\nafter";
    expect(extractInjectedContext(text)).toEqual({
      prose: "after",
      blocks: [{ label: "PROJECT MEMORY", body: "facts" }],
    });
  });
});
