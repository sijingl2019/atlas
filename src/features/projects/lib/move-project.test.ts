import { describe, expect, it } from "vitest";
import { moveProjectId } from "./move-project";

describe("moveProjectId", () => {
  const ids = ["a", "b", "c", "d"];
  it("moves down, before the target", () => {
    expect(moveProjectId(ids, "a", "c", false)).toEqual(["b", "a", "c", "d"]);
  });
  it("moves up, after the target", () => {
    expect(moveProjectId(ids, "d", "a", true)).toEqual(["a", "d", "b", "c"]);
  });
  it("is a no-op onto itself or an unknown target", () => {
    expect(moveProjectId(ids, "b", "b", true)).toBe(ids);
    expect(moveProjectId(ids, "b", "zz", true)).toBe(ids);
  });
});
