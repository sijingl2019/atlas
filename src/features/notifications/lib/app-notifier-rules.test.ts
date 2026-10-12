import { describe, expect, it } from "vitest";
import { classifySignedOut, decideSignedOut } from "./app-notifier-rules";
import type { NotificationEnv } from "./decide";

const away: NotificationEnv = {
  windowFocused: false,
  sinceInputMs: 999_999,
  targetVisible: false,
  projectActive: true,
  away: true,
};
const present: NotificationEnv = {
  windowFocused: true,
  sinceInputMs: 1_000,
  targetVisible: false,
  projectActive: true,
  away: false,
};

describe("Atlas signed out", () => {
  it("reaches the center, toast, banner, badge and sound when away", () => {
    const d = decideSignedOut("Your session expired.", 0, away);
    expect(d?.kind).toBe("atlas-signed-out");
    expect(d?.channels).toEqual({
      center: true,
      toast: true,
      native: true,
      badge: true,
      sound: true,
    });
    expect(d?.native).toMatchObject({
      title: "Signed out of Atlas",
      body: "Your session expired.",
    });
  });

  it("is a center record and toast, with no banner, while the user is present", () => {
    const d = decideSignedOut("Your session expired.", 0, present);
    expect(d?.channels).toMatchObject({ center: true, toast: true, native: false, badge: false });
    expect(d?.channels.sound).toBe(true);
  });

  it("opens the Atlas sign-in and falls back to default copy", () => {
    const e = classifySignedOut("  ", 3);
    expect(e.target).toEqual({ type: "atlas-sign-in" });
    expect(e.body).toMatch(/sign in again/);
    expect(e.dedupeKey).not.toBe(classifySignedOut("", 4).dedupeKey);
  });
});
