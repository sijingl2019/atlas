import { describe, expect, it } from "vitest";
import type { ChatMessage, TurnFile } from "@/types/agent";
import { formatFileCount, formatTurnDuration, turnStats } from "./agent-turn-stats";

const T0 = Date.parse("2026-01-01T10:00:00Z");
const msg = (over: Partial<ChatMessage>): ChatMessage =>
  ({
    id: Math.random().toString(36),
    content: "",
    timestamp: new Date(T0).toISOString(),
    ...over,
  }) as ChatMessage;
const file = (path: string, kind: TurnFile["kind"]): TurnFile => ({
  path,
  kind,
  added: kind === "edit" ? 3 : 0,
  removed: 0,
});

describe("turnStats", () => {
  it("counts edited files (not reads) and reads the stamped duration", () => {
    const messages = [
      msg({ role: "user", content: "refactor auth" }),
      msg({ role: "assistant", mode: "tool", content: "" }),
      msg({
        role: "assistant",
        content: "Moved token refresh into middleware. Touched a few files.",
        workedMs: 252_000,
        turnSummary: {
          turnSeq: 1,
          repoAtTurn: false,
          files: [
            file("a.ts", "edit"),
            file("b.ts", "edit"),
            file("c.ts", "read"),
            file("d.ts", "edit"),
          ],
        },
      }),
    ];
    expect(turnStats(messages, T0 + 999_999)).toEqual({
      durationMs: 252_000,
      filesEdited: 3,
      summary: "Moved token refresh into middleware",
    });
  });

  it("a turn without edits has no files and ignores an earlier turn's footer", () => {
    const messages = [
      msg({ role: "user", content: "first" }),
      msg({
        role: "assistant",
        content: "Edited stuff.",
        turnSummary: { turnSeq: 1, repoAtTurn: false, files: [file("a.ts", "edit")] },
      }),
      msg({ role: "user", content: "second", timestamp: new Date(T0 + 1_000).toISOString() }),
      msg({ role: "assistant", content: "It is a pure function.", workedMs: 8_000 }),
    ];
    expect(turnStats(messages, T0 + 60_000)).toEqual({
      durationMs: 8_000,
      filesEdited: 0,
      summary: "It is a pure function",
    });
  });

  it("falls back to now minus the user message when no duration was stamped", () => {
    const messages = [msg({ role: "user" }), msg({ role: "assistant", content: "Ok." })];
    expect(turnStats(messages, T0 + 30_000).durationMs).toBe(30_000);
  });

  it("takes the final prose, skipping trailing tool rows and next_steps blocks", () => {
    const messages = [
      msg({ role: "user" }),
      msg({
        role: "assistant",
        content: "Fixed the flaky test.\n\n<next_steps>\n- run ci\n</next_steps>",
      }),
      msg({ role: "assistant", mode: "tool", content: "ls" }),
    ];
    expect(turnStats(messages, T0).summary).toBe("Fixed the flaky test");
  });

  it("has no summary when the agent said nothing usable", () => {
    const messages = [msg({ role: "user" }), msg({ role: "assistant", content: "```\ncode\n```" })];
    expect(turnStats(messages, T0).summary).toBeNull();
    expect(turnStats([], T0)).toEqual({ durationMs: undefined, filesEdited: 0, summary: null });
  });
});

describe("formatting", () => {
  it("formats durations", () => {
    expect(formatTurnDuration(undefined)).toBeNull();
    expect(formatTurnDuration(400)).toBeNull();
    expect(formatTurnDuration(45_000)).toBe("45s");
    expect(formatTurnDuration(252_000)).toBe("4m 12s");
    expect(formatTurnDuration(119_600)).toBe("2m 0s");
    expect(formatTurnDuration(3_900_000)).toBe("1h 5m");
  });
  it("formats file counts", () => {
    expect(formatFileCount(0)).toBeNull();
    expect(formatFileCount(1)).toBe("1 file");
    expect(formatFileCount(6)).toBe("6 files");
  });
});
