import { applyEditorTheme } from "@/features/editor/themes/apply-editor-theme";
import { applyAtlasTheme } from "./apply-atlas-theme";
import { atlasThemeIdFor, editorThemeIdFor, resolveMode, type ThemeMode } from "./mode";

/** Read by the inline boot script in index.html — keep the two in step
 *  (tests/boot-theme-script.test.ts checks it). */
export const THEME_MODE_CACHE_KEY = "atlas:theme-mode";

const SYSTEM_DARK = "(prefers-color-scheme: dark)";

export type ThemeSettings = {
  themeMode: ThemeMode;
  atlasTheme: string;
  atlasThemeLight: string;
  codeEditorTheme: string;
  codeEditorThemeLight: string;
};

let latest: ThemeSettings | null = null;
let systemQuery: MediaQueryList | null = null;

function onSystemChange(): void {
  if (latest) applyThemeMode(latest);
}

function syncSystemListener(follow: boolean): void {
  if (follow && !systemQuery && typeof matchMedia === "function") {
    systemQuery = matchMedia(SYSTEM_DARK);
    systemQuery.addEventListener("change", onSystemChange);
  } else if (!follow && systemQuery) {
    systemQuery.removeEventListener("change", onSystemChange);
    systemQuery = null;
  }
}

/**
 * Resolve the appearance mode and apply everything that depends on it:
 * `<html data-mode>` (selects the light token block), `color-scheme` (native
 * scrollbars and form controls — set inline because index.html's inline
 * `color-scheme:dark` outranks any stylesheet rule), both themes from that
 * mode's slots, and the boot cache. Under System, re-runs when the OS flips.
 *
 * Pure DOM, safe pre-mount.
 */
export function applyThemeMode(settings: ThemeSettings): void {
  if (typeof document === "undefined") return;
  latest = settings;
  syncSystemListener(settings.themeMode === "system");

  const systemDark = typeof matchMedia !== "function" || matchMedia(SYSTEM_DARK).matches;
  const mode = resolveMode(settings.themeMode, systemDark);
  const root = document.documentElement;
  root.dataset.mode = mode;
  root.style.setProperty("color-scheme", mode);
  document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", mode);

  applyAtlasTheme(atlasThemeIdFor(settings, mode), mode);
  applyEditorTheme(editorThemeIdFor(settings, mode), mode);

  try {
    localStorage.setItem(THEME_MODE_CACHE_KEY, settings.themeMode);
  } catch {
    // The cache only saves a flash at cold start; config.toml is the truth.
  }
}
