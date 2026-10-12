/**
 * App-level notification rules — pure. Things that are about Atlas itself, not
 * a thread or a terminal. Today: the Atlas session ending (expired or revoked),
 * which stops every agent at once.
 */
import { signedOutDedupeKey } from "./agent-signin-rules";
import {
  decideNotification,
  type NotificationDecision,
  type NotificationEnv,
  type NotificationEvent,
  type NotificationPrefs,
} from "./decide";

/** Signing back in is the only way forward, so neither the banner nor the
 *  sound can be switched off by the agent prefs. */
const SIGNED_OUT_PREFS: NotificationPrefs = {
  "atlas-signed-out": { enabled: true, native: true, sound: true },
};

/** `message` is Rust's explanation (why the session ended). */
export function classifySignedOut(message: string, episode: number): NotificationEvent {
  return {
    kind: "atlas-signed-out",
    title: "Signed out of Atlas",
    body: message.trim() || "Your session ended — sign in again to continue",
    target: { type: "atlas-sign-in" },
    dedupeKey: signedOutDedupeKey(episode),
  };
}

export function decideSignedOut(
  message: string,
  episode: number,
  env: NotificationEnv,
): NotificationDecision | null {
  return decideNotification(classifySignedOut(message, episode), env, SIGNED_OUT_PREFS);
}
