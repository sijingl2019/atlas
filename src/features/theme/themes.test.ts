import { describe, expect, it } from "vitest";
import { ATLAS_THEMES, BASE_ATLAS_THEME_ID, DEFAULT_ATLAS_THEME_ID, getAtlasTheme } from "./themes";

function luminance(hex: string): number {
  const c = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe("interface themes", () => {
  it("has a unique id per theme", () => {
    const ids = ATLAS_THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every theme a mode that matches its base", () => {
    for (const t of ATLAS_THEMES) {
      expect(t.mode === "light", t.id).toBe(luminance(t.spec.base) > 0.5);
    }
  });

  it("has exactly one base theme per mode, and it exists in that mode", () => {
    for (const mode of ["light", "dark"] as const) {
      const base = ATLAS_THEMES.find((t) => t.id === BASE_ATLAS_THEME_ID[mode]);
      expect(base?.mode).toBe(mode);
    }
    expect(BASE_ATLAS_THEME_ID.dark).toBe(DEFAULT_ATLAS_THEME_ID);
  });

  it("keeps primary text readable on every theme's base", () => {
    for (const t of ATLAS_THEMES) {
      expect(contrast(t.spec.textPrimary, t.spec.base), t.id).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("falls back to the mode's base for an unknown id or a theme from the other mode", () => {
    expect(getAtlasTheme("no-such-theme", "light").id).toBe("atlas-light");
    expect(getAtlasTheme("chyral", "light").id).toBe("atlas-light");
    expect(getAtlasTheme("one-light", "dark").id).toBe("atlas-black");
    expect(getAtlasTheme("one-light", "light").id).toBe("one-light");
    expect(getAtlasTheme(null).id).toBe("atlas-black");
  });
});
