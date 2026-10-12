/**
 * What the OS notifier backend can do, and the pure helpers the decision layer
 * uses to offer only that — capability-gating, as in ADR-0002: the backend
 * declares, the frontend never asks "which platform is this".
 *
 * Mirrors `Capabilities` in `src-tauri/src/notifier/mod.rs`. Pure — no Tauri.
 */
import type { SystemNotification, SystemNotificationAction } from "./notifier-api";

export interface NativeCapabilities {
  actions: boolean;
  maxActions: number;
  images: boolean;
  removal: boolean;
  grouping: boolean;
  sound: boolean;
  /** Clicks and actions come back as responses. */
  responses: boolean;
}

/** The floor: a backend that can only show a banner. */
export const NO_NATIVE_CAPABILITIES: NativeCapabilities = {
  actions: false,
  maxActions: 0,
  images: false,
  removal: false,
  grouping: false,
  sound: false,
  responses: false,
};

/** Defensive parse of the backend's report; anything missing is "no". */
export function parseNativeCapabilities(raw: unknown): NativeCapabilities {
  if (typeof raw !== "object" || raw === null) return NO_NATIVE_CAPABILITIES;
  const r = raw as Record<string, unknown>;
  const flag = (k: string) => r[k] === true;
  const max = typeof r.maxActions === "number" && r.maxActions > 0 ? Math.floor(r.maxActions) : 0;
  const actions = flag("actions") && max > 0;
  return {
    actions,
    maxActions: actions ? max : 0,
    images: flag("images"),
    removal: flag("removal"),
    grouping: flag("grouping"),
    sound: flag("sound"),
    responses: flag("responses"),
  };
}

/** Actions the backend can show. Actions are meaningless without a response
 *  stream (nothing would hear the choice), so both are required. */
export function offerableActions(
  caps: NativeCapabilities,
  actions: readonly SystemNotificationAction[],
): SystemNotificationAction[] {
  if (!caps.actions || !caps.responses) return [];
  return actions.slice(0, caps.maxActions);
}

/** Strip everything the backend cannot show, so a banner degrades to the
 *  subset it supports instead of being rejected. */
export function fitToCapabilities(
  caps: NativeCapabilities,
  n: SystemNotification,
): SystemNotification {
  const fitted: SystemNotification = { ...n, actions: offerableActions(caps, n.actions ?? []) };
  if (!caps.images) delete fitted.imagePath;
  if (!caps.sound) delete fitted.sound;
  return fitted;
}
