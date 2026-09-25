import { describe, expect, it } from "vitest";
import { groupRefs, type KnowledgeRefKind } from "./knowledge-refs";

function row(entryId: string, kind: KnowledgeRefKind, hits = 1, lastAt = "2026-01-01") {
  return { entryId, kind, hits, lastAt };
}

describe("groupRefs", () => {
  it("puts a note that was only retrieved under retrieved", () => {
    const g = groupRefs([row("a", "retrieved", 2)], (r) => r.entryId);
    expect(g.read).toEqual([]);
    expect(g.retrieved.map((x) => [x.key, x.retrievedHits])).toEqual([["a", 2]]);
  });

  it("shows a note that was read and retrieved under read only", () => {
    const g = groupRefs(
      [row("a", "retrieved", 3), row("a", "read", 1), row("b", "retrieved")],
      (r) => r.entryId,
    );
    expect(g.read.map((x) => x.key)).toEqual(["a"]);
    expect(g.read[0].retrievedHits).toBe(3);
    expect(g.retrieved.map((x) => x.key)).toEqual(["b"]);
  });

  it("counts mentions and reads together and keeps the latest time", () => {
    const g = groupRefs(
      [row("a", "mention", 1, "2026-01-01"), row("a", "read", 2, "2026-03-01")],
      (r) => r.entryId,
    );
    expect(g.read[0].readHits).toBe(3);
    expect(g.read[0].lastAt).toBe("2026-03-01");
  });

  it("keeps first-seen order", () => {
    const g = groupRefs(
      [row("b", "read"), row("a", "read"), row("b", "mention")],
      (r) => r.entryId,
    );
    expect(g.read.map((x) => x.key)).toEqual(["b", "a"]);
  });
});
