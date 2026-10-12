import { describe, expect, it } from "vitest";
import { isActionId } from "./actions";
import { parseCombo } from "./combo";
import { PRESETS } from "./presets";
import { reservedReason } from "./reserved";
import { findConflicts, resolveProfile } from "./resolve";

describe("presets", () => {
  it("name only real actions, with chords that parse", () => {
    for (const preset of PRESETS) {
      for (const [id, chords] of Object.entries(preset.bindings)) {
        expect(isActionId(id), `${preset.id}: ${id}`).toBe(true);
        for (const c of chords ?? []) expect(parseCombo(c), `${preset.id}: ${c}`).not.toBeNull();
      }
    }
  });

  for (const mac of [true, false]) {
    it(`resolve without a hard conflict (${mac ? "macOS" : "Windows/Linux"})`, () => {
      for (const preset of PRESETS) {
        const r = resolveProfile({ id: "p", name: "P", basedOn: preset.id, bindings: {} });
        const hard = [...findConflicts(r.list, mac).values()].filter((c) => c.kind === "hard");
        expect(
          hard.map((c) => `${c.serialized}: ${c.bindings.map((b) => b.actionId).join(", ")}`),
          preset.id,
        ).toEqual([]);
      }
    });

    it(`bind nothing the OS takes first (${mac ? "macOS" : "Windows/Linux"})`, () => {
      for (const preset of PRESETS) {
        for (const chords of Object.values(preset.bindings)) {
          for (const c of chords ?? []) {
            expect(reservedReason(parseCombo(c)!, mac), `${preset.id}: ${c}`).toBeNull();
          }
        }
      }
    });
  }

  it("has unique ids", () => {
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length);
  });
});
