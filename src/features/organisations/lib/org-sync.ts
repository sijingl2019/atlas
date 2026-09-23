/**
 * Personal-sync gate — the single place that decides whether an organisation
 * counts as SYNCED (linked to the Atlas account) or LOCAL-only on this machine.
 *
 * Two independent things have to hold:
 *
 *  - the org actually exists server-side — `syncEnabled` + `remoteId` — and
 *  - the app-wide **Chat Sync** preference is on.
 *
 * `personalSync` is the master switch (Settings → General → Behaviour), and it
 * is OFF by default: a fresh Atlas is entirely local until the user opts in. It
 * is app-level rather than per-org on purpose — "Personal" is the org every
 * account starts on, and turning it off has to cover orgs created later too.
 * Nothing is deleted server-side, so flipping it back on restores every link.
 *
 * Every account-only surface — members, team chat, AI grants, capture-to-cloud
 * — funnels through here, so the master switch cannot be bypassed by one
 * component re-deriving the predicate.
 */
import { useSettingsStore } from "@/features/settings/stores/settings-store";
import type { AppSettings } from "@/features/settings/lib/app-settings";
import { isSyncedOrg, type Organisation } from "../types";

/** True when `org` is linked to the server AND personal sync is enabled. */
export function isOrgSynced(
  org: Organisation | null | undefined,
  settings: Pick<AppSettings, "personalSync">,
): boolean {
  return !!settings.personalSync && !!org && isSyncedOrg(org);
}

/** Reactive form for components — re-renders when the preference flips. */
export function useIsOrgSynced(org: Organisation | null | undefined): boolean {
  return useSettingsStore((s) => isOrgSynced(org, s.settings));
}
