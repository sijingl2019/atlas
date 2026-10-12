import { describe, expect, it } from "vitest";
import { commitCountLabel } from "./git-graph";

describe("commitCountLabel", () => {
  it("shows the total alone when every commit is loaded", () => {
    expect(commitCountLabel(42, 42)).toBe("42 commits");
    expect(commitCountLabel(1, 1)).toBe("1 commit");
  });

  it("shows loaded of total while the list is capped", () => {
    expect(commitCountLabel(1000, 1231)).toBe("1,000 of 1,231 commits");
  });
});
