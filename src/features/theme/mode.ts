import { useSyncExternalStore } from "react";

/** What the user picked. */
export type ThemeMode = "light" | "dark" | "system";
/** What is actually on screen. */
export type ResolvedMode = "light" | "dark";

/** What the user picked, against what the OS reports, is what renders. */
export function resolveMode(mode: ThemeMode, systemDark: boolean): ResolvedMode {
  if (mode === "system") return systemDark ? "dark" : "light";
  return mode;
}

type ThemeSlots = {
  atlasTheme: string;
  atlasThemeLight: string;
  codeEditorTheme: string;
  codeEditorThemeLight: string;
};

/** Each mode remembers its own pick, so System can flip without resetting. */
export function atlasThemeIdFor(s: ThemeSlots, mode: ResolvedMode): string {
  return mode === "light" ? s.atlasThemeLight : s.atlasTheme;
}

/** The editor theme for a mode — the same two-slot arrangement. */
export function editorThemeIdFor(s: ThemeSlots, mode: ResolvedMode): string {
  return mode === "light" ? s.codeEditorThemeLight : s.codeEditorTheme;
}

/** The theme groups a picker shows. Under System both slots are live, so both
 *  are settable without flipping the OS appearance. */
export function pickerModes(mode: ThemeMode, resolved: ResolvedMode): ResolvedMode[] {
  return mode === "system" ? ["light", "dark"] : [resolved];
}

/** The mode currently on `<html data-mode>`, which `applyThemeMode` and the
 *  boot script in index.html will write (both land later in this feature).
 *  Anything but "light" is dark. */
export function currentMode(): ResolvedMode {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.dataset.mode === "light" ? "light" : "dark";
}

/** Call `onChange` whenever `data-mode` changes. Returns the unsubscribe. */
export function subscribeMode(onChange: () => void): () => void {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") return () => {};
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode"] });
  return () => observer.disconnect();
}

/** Re-renders the caller when the resolved mode flips. */
export function useResolvedMode(): ResolvedMode {
  return useSyncExternalStore(subscribeMode, currentMode, () => "dark");
}

/** `r,g,b` of `--contrast` for Canvas 2D code, which cannot read CSS vars:
 *  white on dark, black on light. */
export function inkRgb(): string {
  return currentMode() === "light" ? "0,0,0" : "255,255,255";
}
