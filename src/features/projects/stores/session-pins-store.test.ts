import { beforeEach, describe, expect, it } from "vitest";
import { useSessionPinsStore } from "./session-pins-store";

describe("session pins", () => {
  beforeEach(() => useSessionPinsStore.setState({ pinnedThreadIds: [] }));

  it("toggles a thread pin without duplicating it", () => {
    const { toggle } = useSessionPinsStore.getState().actions;
    toggle("thread-1");
    expect(useSessionPinsStore.getState().pinnedThreadIds).toEqual(["thread-1"]);
    toggle("thread-1");
    expect(useSessionPinsStore.getState().pinnedThreadIds).toEqual([]);
  });
});
