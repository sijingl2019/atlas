import { describe, expect, it } from "vitest";
import { parseCombo } from "./combo";
import { toNativeAccelerator } from "./native-accelerator";

describe("toNativeAccelerator", () => {
  it("spells the primary modifier per platform", () => {
    expect(toNativeAccelerator(parseCombo("cmd+w")!, true)).toBe("Cmd+W");
    expect(toNativeAccelerator(parseCombo("cmd+w")!, false)).toBe("Control+W");
    expect(toNativeAccelerator(parseCombo("cmd+ctrl+alt+shift+f5")!, true)).toBe(
      "Cmd+Control+Alt+Shift+F5",
    );
    expect(toNativeAccelerator(parseCombo("alt+left")!, true)).toBe("Alt+Left");
  });
  it("declines punctuation rather than guess its spelling", () => {
    expect(toNativeAccelerator(parseCombo("cmd+;")!, true)).toBeNull();
  });
});
