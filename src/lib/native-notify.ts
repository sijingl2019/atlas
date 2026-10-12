/**
 * OS banners, through the Atlas-owned system notifier (`src-tauri/src/notifier`)
 * — never the notification plugin directly; that is only the Rust fallback
 * backend.
 *
 * Permission is primed EAGERLY at startup (`primeNativeNotificationPermission`).
 * The old lazy path only asked the OS the first time a notification fired while
 * unfocused — so if every agent turn finished while Atlas was focused, the
 * first real background notification was lost to the permission prompt. Priming
 * also subscribes to banner responses (clicks) and learns the backend's
 * capabilities.
 *
 * `showNativeNotification` shows unconditionally: whether the user is "away" is
 * the decision layer's call (a focused-but-idle window counts), so there is no
 * focus gate here.
 *
 * Clicks arrive as `SystemNotificationResponse`s; `setNativeResponseHandler`
 * is where the notification pipeline routes them (responses that arrive before
 * a handler exists are held, not dropped).
 */
import {
  listenNotificationResponses,
  notifierInit,
  notifierRemove,
  notifierRemoveGroup,
  notifierRequestAuthorization,
  notifierShow,
  type SystemNotification,
  type SystemNotificationResponse,
} from "@/features/notifications/lib/notifier-api";
import {
  NO_NATIVE_CAPABILITIES,
  fitToCapabilities,
  type NativeCapabilities,
} from "@/features/notifications/lib/native-capabilities";

type PermissionState = "unknown" | "granted" | "denied";
let permission: PermissionState = "unknown";
let priming: Promise<PermissionState> | null = null;
let capabilities: NativeCapabilities = NO_NATIVE_CAPABILITIES;

let responseHandler: ((r: SystemNotificationResponse) => void) | null = null;
const heldResponses: SystemNotificationResponse[] = [];

function handleResponse(r: SystemNotificationResponse): void {
  if (responseHandler) responseHandler(r);
  else heldResponses.push(r);
}

export function setNativeResponseHandler(handler: (r: SystemNotificationResponse) => void): void {
  responseHandler = handler;
  for (const r of heldResponses.splice(0)) handler(r);
}

/** What the active backend can do; the floor until priming has finished. */
export function nativeCapabilities(): NativeCapabilities {
  return capabilities;
}

export function primeNativeNotificationPermission(): Promise<PermissionState> {
  if (permission !== "unknown") return Promise.resolve(permission);
  if (priming) return priming;
  priming = (async () => {
    try {
      // Listen before init: init flushes responses that arrived before the
      // webview was up (a click that launched the app).
      await listenNotificationResponses(handleResponse);
      capabilities = (await notifierInit()).capabilities;
      permission = (await notifierRequestAuthorization()) === "granted" ? "granted" : "denied";
    } catch {
      // Notifier unavailable — notifications silently no-op.
      permission = "denied";
    }
    priming = null;
    return permission;
  })();
  return priming;
}

/**
 * Show a full banner if permission is granted, degraded to what the backend
 * supports. Resolves to whether anything was shown. Never throws.
 */
export async function showNativeNotification(n: SystemNotification): Promise<boolean> {
  try {
    if ((await primeNativeNotificationPermission()) !== "granted") return false;
    await notifierShow(fitToCapabilities(capabilities, n));
    return true;
  } catch (e) {
    console.warn("native notification failed:", e);
    return false;
  }
}

/** Take a delivered banner down (no-op where the backend cannot). */
export function removeNativeNotification(tag: string): void {
  if (capabilities.removal) void notifierRemove(tag).catch(() => {});
}

export function removeNativeNotificationGroup(group: string): void {
  if (capabilities.removal) void notifierRemoveGroup(group).catch(() => {});
}
