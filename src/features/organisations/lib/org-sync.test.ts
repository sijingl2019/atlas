import { describe, expect, it, vi } from "vitest";

/**
 * `isOrgSynced` is the single predicate every account-only surface funnels
 * through, so its truth table is the whole contract of the Chat Sync
 * master switch. The store is mocked: these cases are about the predicate, not
 * about zustand wiring (the reactive `useIsOrgSynced` wrapper is covered by
 * the components that read it).
 */
vi.mock("@/features/settings/stores/settings-store", () => ({
  useSettingsStore: Object.assign(() => false, {
    getState: () => ({ settings: { personalSync: false } }),
  }),
}));

import { isOrgSynced } from "./org-sync";
import type { Organisation } from "../types";

function org(overrides: Partial<Organisation> = {}): Organisation {
  return { id: "local_1", name: "Acme", slug: "acme", syncEnabled: false, ...overrides };
}

const ON = { personalSync: true };
const OFF = { personalSync: false };

describe("isOrgSynced", () => {
  it("is true only when the org is linked AND personal sync is on", () => {
    expect(isOrgSynced(org({ syncEnabled: true, remoteId: "org_1" }), ON)).toBe(true);
  });

  it("is false when personal sync is off, even for a fully linked org", () => {
    // The master switch wins: the server row still exists, but this machine
    // must treat the org as local-only while the switch is off.
    expect(isOrgSynced(org({ syncEnabled: true, remoteId: "org_1" }), OFF)).toBe(false);
  });

  it("is false when the org was never opted into sync", () => {
    expect(isOrgSynced(org({ syncEnabled: false, remoteId: "org_1" }), ON)).toBe(false);
  });

  it("is false when the org has no remote id yet", () => {
    expect(isOrgSynced(org({ syncEnabled: true }), ON)).toBe(false);
  });

  it("is false for a missing org", () => {
    expect(isOrgSynced(null, ON)).toBe(false);
    expect(isOrgSynced(undefined, ON)).toBe(false);
  });
});
