import { describe, expect, it } from "vitest";
import {
  INITIAL_CONTEXT_STATE,
  INITIAL_RATE_STATE,
  INITIAL_RETRY_STATE,
  endRetryEpisode,
  evaluateContextUsage,
  evaluateRateLimits,
  evaluateRetry,
  formatResetTime,
  rateWindowLabel,
  type ContextWarnState,
  type RateWarnState,
  type RateWindowInput,
  type RetryWarnState,
} from "./agent-warning-rules";
import {
  decideAgentNotification,
  describeRateLimit,
  describeRetry,
  retryDedupeKey,
  type AgentCtx,
  type AgentNotifyEvent,
} from "./agent-notifier-rules";
import type { NotificationEnv } from "./decide";
import { DEFAULT_SETTINGS } from "@/features/settings/lib/app-settings";

const SEEDED_CONTEXT: ContextWarnState = evaluateContextUsage(INITIAL_CONTEXT_STATE, 0, 100).state;
const SEEDED_RATE: RateWarnState = evaluateRateLimits(INITIAL_RATE_STATE, {
  primary: null,
  secondary: null,
}).state;

describe("context window warning", () => {
  it("the first observation seeds silently, even when already above 90%", () => {
    const first = evaluateContextUsage(INITIAL_CONTEXT_STATE, 95, 100);
    expect(first.warning).toBeNull();
    expect(evaluateContextUsage(first.state, 97, 100).warning).toBeNull();
    // ...and it re-arms once usage falls, so a later live crossing notifies.
    const down = evaluateContextUsage(first.state, 20, 100);
    expect(evaluateContextUsage(down.state, 92, 100).warning?.percent).toBe(92);
  });
  it("a first observation below 90% leaves the next crossing live", () => {
    const first = evaluateContextUsage(INITIAL_CONTEXT_STATE, 40, 100);
    expect(evaluateContextUsage(first.state, 91, 100).warning?.percent).toBe(91);
  });
  const feed = (usages: number[]) => {
    let state: ContextWarnState = SEEDED_CONTEXT;
    return usages.map((used) => {
      const r = evaluateContextUsage(state, used, 100);
      state = r.state;
      return r.warning?.percent ?? null;
    });
  };

  it("stays quiet below 90%", () => {
    expect(feed([10, 50, 89])).toEqual([null, null, null]);
  });
  it("fires at exactly 90% and only once while above", () => {
    expect(feed([89, 90, 95, 99])).toEqual([null, 90, null, null]);
  });
  it("re-arms after usage drops back below (compaction)", () => {
    expect(feed([92, 20, 91])).toEqual([92, null, 91]);
  });
  it("numbers each crossing so dedupe keys differ", () => {
    let state = SEEDED_CONTEXT;
    const a = evaluateContextUsage(state, 95, 100);
    state = evaluateContextUsage(a.state, 10, 100).state;
    const b = evaluateContextUsage(state, 95, 100);
    expect([a.warning?.crossing, b.warning?.crossing]).toEqual([1, 2]);
  });
  it("ignores a missing window size", () => {
    expect(evaluateContextUsage(INITIAL_CONTEXT_STATE, 50, 0).warning).toBeNull();
  });
});

describe("rate limit warning", () => {
  const win = (used: number, resets: number | null = 1_000_000): RateWindowInput => ({
    used_percent: used,
    window_minutes: 300,
    resets_at: resets,
  });
  const run = (
    state: RateWarnState,
    primary: RateWindowInput | null,
    secondary: RateWindowInput | null = null,
  ) => evaluateRateLimits(state, { primary, secondary });

  it("the first snapshot seeds silently; a later window still warns", () => {
    const first = run(INITIAL_RATE_STATE, win(95, 1_000_000));
    expect(first.warnings).toEqual([]);
    expect(run(first.state, win(96, 1_000_000)).warnings).toEqual([]);
    expect(run(first.state, win(96, 1_018_000)).warnings).toHaveLength(1);
  });
  it("fires at 90% and once per window", () => {
    const a = run(SEEDED_RATE, win(90));
    expect(a.warnings.map((w) => w.percent)).toEqual([90]);
    const b = run(a.state, win(97));
    expect(b.warnings).toEqual([]);
    // Dipping below inside the same window does not re-arm it.
    const c = run(run(b.state, win(40)).state, win(95));
    expect(c.warnings).toEqual([]);
  });
  it("fires again for the next window (new reset time)", () => {
    const a = run(SEEDED_RATE, win(92, 1_000_000));
    const b = run(a.state, win(92, 1_018_000));
    expect(b.warnings).toHaveLength(1);
    expect(b.warnings[0].seq).toBeGreaterThan(a.warnings[0].seq);
  });
  it("re-arms an undated window once usage falls", () => {
    const a = run(SEEDED_RATE, win(95, null));
    expect(run(a.state, win(96, null)).warnings).toEqual([]);
    const b = run(run(a.state, win(10, null)).state, win(95, null));
    expect(b.warnings).toHaveLength(1);
  });
  it("tracks the two windows independently", () => {
    const a = run(SEEDED_RATE, win(50), win(91, 2_000_000));
    expect(a.warnings.map((w) => w.slot)).toEqual(["secondary"]);
    const b = run(a.state, win(93), win(91, 2_000_000));
    expect(b.warnings.map((w) => w.slot)).toEqual(["primary"]);
  });
  it("skips absent windows", () => {
    expect(run(SEEDED_RATE, null, null).warnings).toEqual([]);
  });
});

describe("retry episodes", () => {
  it("is silent for the first attempt", () => {
    const r = evaluateRetry(INITIAL_RETRY_STATE, 1);
    expect(r.update).toBeNull();
  });
  it("creates on attempt 2 and updates in place afterwards", () => {
    let state: RetryWarnState = INITIAL_RETRY_STATE;
    const seen = [1, 2, 3, 4].map((attempt) => {
      const r = evaluateRetry(state, attempt);
      state = r.state;
      return r.update;
    });
    expect(seen).toEqual([
      null,
      { episode: 1, first: true },
      { episode: 1, first: false },
      { episode: 1, first: false },
    ]);
  });
  it("starts a new episode after attempt 1 resets or the turn ends", () => {
    const a = evaluateRetry(INITIAL_RETRY_STATE, 2);
    const reset = evaluateRetry(a.state, 1);
    expect(evaluateRetry(reset.state, 2).update).toEqual({ episode: 2, first: true });
    const ended = endRetryEpisode(a.state);
    expect(evaluateRetry(ended, 2).update).toEqual({ episode: 2, first: true });
  });
});

describe("copy", () => {
  it("labels quota windows", () => {
    expect(rateWindowLabel(300)).toBe("5-hour");
    expect(rateWindowLabel(10080)).toBe("weekly");
    expect(rateWindowLabel(null)).toBe("");
  });
  it("formats the reset time in the given locale", () => {
    const now = new Date(2026, 9, 2, 10, 0);
    const sameDay = new Date(2026, 9, 2, 15, 45).getTime() / 1000;
    expect(formatResetTime(sameDay, now, "en-US")).toMatch(/3:45\s?PM/);
    const later = new Date(2026, 9, 5, 15, 45).getTime() / 1000;
    expect(formatResetTime(later, now, "en-US")).toMatch(/^Mon .*3:45\s?PM$/);
  });
  it("describes a rate limit and a retry", () => {
    const t = new Date(2026, 9, 2, 15, 45).getTime() / 1000;
    expect(describeRateLimit(92, 300, t, new Date(2026, 9, 2, 9, 0), "en-US")).toMatch(
      /^5-hour rate limit 92% used — resets 3:45\s?PM$/,
    );
    expect(describeRateLimit(92, null, null)).toBe("Rate limit 92% used");
    expect(describeRetry(3, 5, "Connection reset. Retrying soon")).toBe(
      "Retrying — attempt 3 of 5 · Connection reset",
    );
    expect(describeRetry(2, 5, "")).toBe("Retrying — attempt 2 of 5");
  });
});

describe("warning decisions", () => {
  const ctx: AgentCtx = {
    tabId: "chat-1",
    sessionId: "acp-1",
    sessionTitle: "Fix the build",
    agentName: "Claude Code",
  };
  const away: NotificationEnv = {
    windowFocused: false,
    sinceInputMs: 999_999,
    targetVisible: false,
    projectActive: true,
    away: true,
  };
  const prefs = DEFAULT_SETTINGS;
  const decide = (e: AgentNotifyEvent, env = away) => decideAgentNotification(e, ctx, env, prefs);

  it("names the agent and thread and uses center + toast, never an OS banner", () => {
    const events: AgentNotifyEvent[] = [
      { type: "context_warning", percent: 91, crossing: 1 },
      {
        type: "rate_limit_warning",
        slot: "primary",
        percent: 92,
        windowMinutes: 300,
        resetsAt: 1,
        seq: 1,
      },
      { type: "retrying", attempt: 2, maxAttempts: 5, lastError: "boom", episode: 1, first: true },
    ];
    for (const e of events) {
      const d = decide(e);
      expect(d?.tier).toBe("warning");
      expect(d?.title).toBe("Claude Code · Fix the build");
      expect(d?.channels).toMatchObject({ center: true, toast: true, native: false, sound: false });
    }
  });
  it("shares one retry dedupe key across attempts of an episode", () => {
    const a = decide({
      type: "retrying",
      attempt: 2,
      maxAttempts: 5,
      lastError: "x",
      episode: 1,
      first: true,
    });
    const b = decide({
      type: "retrying",
      attempt: 3,
      maxAttempts: 5,
      lastError: "y",
      episode: 1,
      first: false,
    });
    expect(a?.dedupeKey).toBe(retryDedupeKey("acp-1", 1));
    expect(b?.dedupeKey).toBe(a?.dedupeKey);
    expect(b?.body).toContain("attempt 3 of 5");
  });
  it("respects the master switch", () => {
    expect(
      decideAgentNotification({ type: "context_warning", percent: 95, crossing: 1 }, ctx, away, {
        ...prefs,
        notificationsEnabled: false,
      }),
    ).toBeNull();
  });
});
