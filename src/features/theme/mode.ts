import { useSyncExternalStore } from "react";

/** What the user picked. */
export type ThemeMode = "light" | "dark" | "system";
/** What is actually on screen. */
export type ResolvedMode = "light" | "dark";

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
export const atlasThemeIdFor = (s: ThemeSlots, mode: ResolvedMode) =>
  mode === "light" ? s.atlasThemeLight : s.atlasTheme;

export const editorThemeIdFor = (s: ThemeSlots, mode: ResolvedMode) =>
  mode === "light" ? s.codeEditorThemeLight : s.codeEditorTheme;

/** The theme groups a picker shows. Under System both slots are live, so both
 *  are settable without flipping the OS appearance. */
export function pickerModes(mode: ThemeMode, resolved: ResolvedMode): ResolvedMode[] {
  return mode === "system" ? ["light", "dark"] : [resolved];
}

/** The mode currently on `<html data-mode>` (set by `applyThemeMode` and the
 *  boot script in index.html). Anything but "light" is dark. */
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
