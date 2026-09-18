import { BASE_ATLAS_THEME_ID, buildThemeVars, getAtlasTheme } from "./themes";
import type { ResolvedMode } from "./mode";

// The full set of CSS custom properties a theme may override. Used to clear a
// prior theme's inline overrides before applying the next (and to reset to the
// tokens.css baseline for the Atlas Black default).
const THEME_VARS = Object.keys(buildThemeVars(getAtlasTheme(null).spec));

/**
 * Apply the given Atlas theme id by writing its palette as CSS custom properties
 * onto `document.documentElement`. Overriding the base tokens cascades through
 * both the Tailwind v4 `@theme` utilities and every direct `var(--…)` consumer,
 * so the whole UI reskins while staying dark.
 *
 * A mode's base theme (Atlas Black, Atlas Light) clears all overrides so that
 * mode's `tokens.css` block applies verbatim.
 *
 * Pure DOM, safe to call pre-mount. Mirrors `apply-editor-theme.ts`.
 */
export function applyAtlasTheme(id: string | undefined | null, mode: ResolvedMode = "dark"): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const theme = getAtlasTheme(id, mode);

  if (theme.id === BASE_ATLAS_THEME_ID[theme.mode]) {
    for (const k of THEME_VARS) root.style.removeProperty(k);
    return;
  }

  const vars = buildThemeVars(theme.spec);
  for (const [k, v] of Object.entries(vars)) {
    root.style.setProperty(k, v);
  }
}
