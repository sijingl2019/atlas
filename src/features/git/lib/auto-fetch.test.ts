import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchHint } from "./auto-fetch";

const NOW = new Date("2026-09-30T12:00:00Z").getTime();
const status = (lastFetchedAt: number | null, lastError: string | null = null) => ({
  project: "/repo",
  lastFetchedAt,
  lastError,
});

describe("fetchHint", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("is plain Fetch until anything is known", () => {
    expect(fetchHint(undefined)).toBe("Fetch");
    expect(fetchHint(status(null))).toBe("Fetch");
  });

  it("says how long ago the last fetch was", () => {
    expect(fetchHint(status(NOW - 3 * 60_000))).toBe("Fetch · fetched 3m ago");
  });

  it("leads with the failure and keeps the last success", () => {
    expect(fetchHint(status(null, "Authentication failed.\nremote: more"))).toBe(
      "Fetch · auto-fetch failed: Authentication failed.",
    );
    expect(fetchHint(status(NOW - 10 * 60_000, "Could not reach the remote."))).toBe(
      "Fetch · auto-fetch failed: Could not reach the remote. (last fetched 10m ago)",
    );
  });
});
