/**
 * Coalesces a burst of OS banners into one. Parallel agents tend to finish
 * within seconds of each other; N banners for N finishes is noise, so banners
 * collected inside the window leave as a single "3 agents finished".
 *
 * Only the banner is held back — center, toast and badge are delivered
 * immediately by the caller. The timer is injectable for tests.
 */
import type { NotificationDecision } from "./decide";

export interface BannerCoalescer {
  add: (d: NotificationDecision) => void;
  dispose: () => void;
}

export interface BannerCoalescerOptions {
  windowMs: number;
  /** Receives the single decision (or the merged one) when the window closes. */
  emit: (d: NotificationDecision) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const MAX_NAMED = 3;

/** One decision, or a merged "N agents finished" for several. */
export function mergeBanners(batch: NotificationDecision[]): NotificationDecision {
  const first = batch[0];
  if (batch.length === 1) return first;
  const titles = [...new Set(batch.map((d) => d.title))];
  const named = titles.slice(0, MAX_NAMED).join(", ");
  const list = titles.length > MAX_NAMED ? `${named}, …` : named;
  const headline = `${batch.length} agents finished`;
  return {
    ...first,
    title: headline,
    body: list,
    dedupeKey: `${first.dedupeKey}+${batch.length - 1}`,
    groupKey: first.kind,
    native: { title: headline, body: list, sound: first.native.sound },
  };
}

export function createBannerCoalescer(opts: BannerCoalescerOptions): BannerCoalescer {
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let pending: NotificationDecision[] = [];
  let timer: unknown = null;

  const flush = () => {
    timer = null;
    const batch = pending;
    pending = [];
    if (batch.length > 0) opts.emit(mergeBanners(batch));
  };

  return {
    add(d) {
      pending.push(d);
      if (timer === null) timer = setTimer(flush, opts.windowMs);
    },
    dispose() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      pending = [];
    },
  };
}
