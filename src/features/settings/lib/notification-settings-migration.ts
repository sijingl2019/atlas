/**
 * One-time migration of the pre-catalog notification choices into the tier
 * settings. Before ATL-388 the terminal choices lived in `config.toml`
 * (`terminalNotify*`) and the agent choices in localStorage
 * (`atlas-agent-notify-prefs`); now every kind follows one master switch and
 * its tier's banner/sound switches, all in `config.toml`.
 *
 * `migrateNotificationSettings` is pure: settings + the raw legacy agent blob
 * in, a patch out (`null` once `notificationsMigrated` is set). Rules, chosen
 * so nobody is surprised by a new noise:
 *  - master — the agent master (the terminal master becomes the
 *    "Command finished" kind switch, plus failure/attention follow it off);
 *  - banner — on only if the user left both the terminal and the agent banner on;
 *  - sound — on if either had sound on (terminal sound was opt-in, agent
 *    sound defaulted on, so an untouched install keeps the agent default);
 *  - agent minimum duration carries over.
 * Warnings and team kinds had no legacy choice and keep their defaults.
 *
 * A second step (`notifyKindsMigrated`) folds the three per-kind switches the
 * catalog used to name (`terminalNotifications` = command finished,
 * `terminalNotifyOnFailure`, `terminalNotifyOnAttention`) into the one
 * `notifyDisabledKinds` list, so a user who switched one off keeps it off.
 * It runs on its own flag, so installs that already ran the first step get it.
 */
import type { AppSettings } from "./app-settings";

/** localStorage key of the retired agent prefs store (zustand `persist`). */
export const LEGACY_AGENT_PREFS_KEY = "atlas-agent-notify-prefs";

export interface LegacyAgentNotifyPrefs {
  enabled: boolean;
  native: boolean;
  sound: boolean;
  minDurationMs: number;
}

const DEFAULT_LEGACY: LegacyAgentNotifyPrefs = {
  enabled: true,
  native: true,
  sound: true,
  minDurationMs: 0,
};

/** Rust rejects a minimum duration past one hour. */
const MAX_MIN_DURATION_MS = 3_600_000;

/** Keep only well-formed fields; anything else falls back to the old default. */
export function sanitizeLegacyAgentPrefs(raw: unknown): LegacyAgentNotifyPrefs {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  const ms = r.minDurationMs;
  return {
    enabled: bool(r.enabled, DEFAULT_LEGACY.enabled),
    native: bool(r.native, DEFAULT_LEGACY.native),
    sound: bool(r.sound, DEFAULT_LEGACY.sound),
    minDurationMs:
      typeof ms === "number" && Number.isFinite(ms) && ms >= 0
        ? Math.min(Math.round(ms), MAX_MIN_DURATION_MS)
        : DEFAULT_LEGACY.minDurationMs,
  };
}

/** The agent prefs the retired store persisted, or `null` when there were none. */
export function readLegacyAgentPrefs(): unknown {
  try {
    const raw = globalThis.localStorage?.getItem(LEGACY_AGENT_PREFS_KEY);
    if (!raw) return null;
    return (JSON.parse(raw) as { state?: { prefs?: unknown } } | null)?.state?.prefs ?? null;
  } catch {
    return null;
  }
}

/** The per-kind boolean settings the catalog named before `notifyDisabledKinds`
 *  — retired; read only here. */
const LEGACY_KIND_SETTINGS = [
  ["terminal-done", "terminalNotifications"],
  ["terminal-failed", "terminalNotifyOnFailure"],
  ["terminal-attention", "terminalNotifyOnAttention"],
] as const;

function migrateTierSettings(s: AppSettings, legacyAgentPrefs: unknown): Partial<AppSettings> {
  const agent = sanitizeLegacyAgentPrefs(legacyAgentPrefs);
  const banner = s.terminalNotifyNative && agent.native;
  const sound = s.terminalNotifySound || agent.sound;
  return {
    notificationsEnabled: agent.enabled,
    notifyNeedsYouNative: banner,
    notifyOutcomeNative: banner,
    notifyNeedsYouSound: sound,
    notifyOutcomeSound: sound,
    notifyAgentMinDurationMs: agent.minDurationMs,
    // The terminal master used to silence all three terminal kinds; it is now
    // only "Command finished", so carry the "off" over to the other two.
    ...(s.terminalNotifications
      ? {}
      : { terminalNotifyOnFailure: false, terminalNotifyOnAttention: false }),
    notificationsMigrated: true,
  };
}

function migrateKindSwitches(s: AppSettings): Partial<AppSettings> {
  const disabled = [...s.notifyDisabledKinds];
  for (const [kind, key] of LEGACY_KIND_SETTINGS) {
    if (!s[key] && !disabled.includes(kind)) disabled.push(kind);
  }
  return { notifyDisabledKinds: disabled, notifyKindsMigrated: true };
}

export function migrateNotificationSettings(
  s: AppSettings,
  legacyAgentPrefs: unknown,
): Partial<AppSettings> | null {
  if (s.notificationsMigrated && s.notifyKindsMigrated) return null;
  const tiers = s.notificationsMigrated ? {} : migrateTierSettings(s, legacyAgentPrefs);
  const kinds = s.notifyKindsMigrated ? {} : migrateKindSwitches({ ...s, ...tiers });
  return { ...tiers, ...kinds };
}
