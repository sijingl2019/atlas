import { describe, expect, it } from "vitest";
import { atlasThemeIdFor, editorThemeIdFor, pickerModes, resolveMode } from "./mode";

const settings = {
  atlasTheme: "chyral",
  atlasThemeLight: "one-light",
  codeEditorTheme: "dracula",
  codeEditorThemeLight: "catppuccin-latte",
};

describe("theme mode", () => {
  it.each([
    ["light", true, "light"],
    ["light", false, "light"],
    ["dark", true, "dark"],
    ["dark", false, "dark"],
    ["system", true, "dark"],
    ["system", false, "light"],
  ] as const)("%s with system dark=%s resolves to %s", (mode, systemDark, expected) => {
    expect(resolveMode(mode, systemDark)).toBe(expected);
  });

  it("reads each mode's own slot", () => {
    expect(atlasThemeIdFor(settings, "dark")).toBe("chyral");
    expect(atlasThemeIdFor(settings, "light")).toBe("one-light");
    expect(editorThemeIdFor(settings, "dark")).toBe("dracula");
    expect(editorThemeIdFor(settings, "light")).toBe("catppuccin-latte");
  });

  it("shows only the resolved mode's themes, or both under System", () => {
    expect(pickerModes("light", "light")).toEqual(["light"]);
    expect(pickerModes("dark", "dark")).toEqual(["dark"]);
    expect(pickerModes("system", "dark")).toEqual(["light", "dark"]);
  });
});
