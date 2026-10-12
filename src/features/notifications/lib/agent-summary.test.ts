import { describe, expect, it } from "vitest";
import { SUMMARY_MAX_CHARS, firstSentence, stripMarkdown } from "./agent-summary";

describe("firstSentence", () => {
  it("takes the first sentence of plain prose", () => {
    expect(firstSentence("Moved token refresh into middleware. Updated two tests.")).toBe(
      "Moved token refresh into middleware",
    );
  });

  it("strips markdown emphasis, code spans and links", () => {
    expect(firstSentence("I **fixed** the `parse()` bug in [the lexer](http://x.y/z). Done.")).toBe(
      "I fixed the parse() bug in the lexer",
    );
  });

  it("skips a leading code fence and headings", () => {
    expect(firstSentence("```ts\nconst a = 1.5;\n```\n\n## Summary\n\nAdded the retry loop.")).toBe(
      "Summary",
    );
    expect(firstSentence("```sh\nls\n```\nRan the build.")).toBe("Ran the build");
  });

  it("an unterminated fence yields nothing", () => {
    expect(firstSentence("```ts\nconst a = 1")).toBeNull();
  });

  it("uses the first list item", () => {
    expect(firstSentence("- Renamed the store\n- Fixed the types")).toBe("Renamed the store");
    expect(firstSentence("1. Split the module. 2. Wired it up")).toBe("Split the module");
    expect(firstSentence("- [x] Wrote the migration")).toBe("Wrote the migration");
  });

  it("does not end on dots inside tokens or abbreviations", () => {
    expect(firstSentence("Bumped to v1.2.3 in src/a.ts, e.g. the lockfile. Then more.")).toBe(
      "Bumped to v1.2.3 in src/a.ts, e.g. the lockfile",
    );
  });

  it("keeps ? and ! sentence ends", () => {
    expect(firstSentence("Want me to also update the docs? I can.")).toBe(
      "Want me to also update the docs?",
    );
  });

  it("caps a very long sentence on a word boundary", () => {
    const long = `${"word ".repeat(60)}end.`;
    const out = firstSentence(long) as string;
    expect(out.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/wor…$/);
    expect(out.slice(0, -1).trimEnd().endsWith("word")).toBe(true);
  });

  it("hard-cuts a single enormous token", () => {
    const out = firstSentence("x".repeat(500)) as string;
    expect(out.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
  });

  it("returns null for empty or markup-only text", () => {
    expect(firstSentence("")).toBeNull();
    expect(firstSentence("  \n\n ")).toBeNull();
    expect(firstSentence("---")).toBeNull();
    expect(firstSentence("<next_steps>\n- a\n</next_steps>")).toBeNull();
  });

  it("is deterministic", () => {
    const t = "Fixed it. **Really.**";
    expect(firstSentence(t)).toBe(firstSentence(t));
  });
});

describe("stripMarkdown", () => {
  it("removes blockquote, rules and images", () => {
    expect(stripMarkdown("> quoted\n***\n![alt](a.png)").trim()).toBe("quoted\n\nalt");
  });
});
