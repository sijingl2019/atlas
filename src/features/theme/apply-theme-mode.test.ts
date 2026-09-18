// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { THEME_MODE_CACHE_KEY, applyThemeMode } from "./apply-theme-mode";

type Listener = () => void;
let systemDark = true;
let listeners: Listener[] = [];

beforeEach(() => {
  systemDark = true;
  listeners = [];
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return query.includes("dark") ? systemDark : !systemDark;
    },
    addEventListener: (_: string, l: Listener) => listeners.push(l),
    removeEventListener: (_: string, l: Listener) => {
      listeners = listeners.filter((x) => x !== l);
    },
  }));
  document.documentElement.removeAttribute("data-mode");
  document.documentElement.removeAttribute("style");
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  applyThemeMode({ ...base, themeMode: "dark" }); // drops any System listener
  vi.unstubAllGlobals();
});

const base = {
  themeMode: "dark" as const,
  atlasTheme: "chyral",
  atlasThemeLight: "atlas-light",
  codeEditorTheme: "dracula",
  codeEditorThemeLight: "one-light",
};
const root = () => document.documentElement;
const inline = (name: string) => root().style.getPropertyValue(name);
const scheme = () => inline("color-scheme");

describe("applyThemeMode", () => {
  it("light: sets data-mode, color-scheme and the light slots", () => {
    applyThemeMode({ ...base, themeMode: "light" });
    expect(root().dataset.mode).toBe("light");
    expect(scheme()).toBe("light");
    // Atlas Light is the light base → no inline palette override.
    expect(inline("--bg-base")).toBe("");
    // One Light editor → its keyword color on the editor vars.
    expect(inline("--cm-keyword")).toBe("#a626a4");
  });

  it("dark: applies the dark slots", () => {
    applyThemeMode(base);
    expect(root().dataset.mode).toBe("dark");
    expect(scheme()).toBe("dark");
    expect(inline("--bg-base")).toBe("#080604"); // Chyral
    expect(inline("--cm-keyword")).toBe("#ff79c6"); // Dracula
  });

  it("leaves no dark theme overrides behind when switching to the light base", () => {
    applyThemeMode(base);
    applyThemeMode({ ...base, themeMode: "light" });
    expect(inline("--bg-base")).toBe("");
    expect(inline("--accent-primary")).toBe("");
  });

  it("falls back to the mode's base when a slot holds the other mode's theme", () => {
    applyThemeMode({ ...base, themeMode: "light", atlasThemeLight: "chyral" });
    expect(inline("--bg-base")).toBe(""); // Atlas Light, not Chyral's #080604
  });

  it("system: follows the OS, and re-applies when it flips", () => {
    systemDark = false;
    applyThemeMode({ ...base, themeMode: "system" });
    expect(root().dataset.mode).toBe("light");
    expect(listeners).toHaveLength(1);

    systemDark = true;
    listeners.forEach((l) => l());
    expect(root().dataset.mode).toBe("dark");
    expect(inline("--bg-base")).toBe("#080604");
  });

  it("stops listening to the OS when leaving System", () => {
    applyThemeMode({ ...base, themeMode: "system" });
    applyThemeMode({ ...base, themeMode: "light" });
    expect(listeners).toHaveLength(0);
  });

  it("does not stack OS listeners across repeated System applies", () => {
    applyThemeMode({ ...base, themeMode: "system" });
    applyThemeMode({ ...base, themeMode: "system", atlasTheme: "mirage" });
    expect(listeners).toHaveLength(1);
  });

  it("caches the chosen mode for the boot script", () => {
    applyThemeMode({ ...base, themeMode: "system" });
    expect(localStorage.getItem(THEME_MODE_CACHE_KEY)).toBe("system");
  });

  it("still applies when storage throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    applyThemeMode({ ...base, themeMode: "light" });
    expect(root().dataset.mode).toBe("light");
  });
});
