/**
 * Atlas Themes — complete palettes for the whole UI, dark and light.
 *
 * This replaces the earlier "App Accent" picker: instead of only re-tinting the
 * accent over a fixed AMOLED-black base, a theme swaps the *entire* palette
 * — background, elevations, text tiers, borders AND accent — so Atlas can wear
 * popular editor palettes (One Dark, GitHub Dark, …) as a full skin. A theme
 * belongs to one mode; light themes render on the `:root[data-mode="light"]`
 * base in tokens.css.
 *
 * Applied at runtime by `apply-atlas-theme.ts`, which writes each theme's tokens
 * as CSS custom properties on `document.documentElement` (same mechanism the old
 * accent picker used). The default **Atlas Black** clears all overrides so the
 * original AMOLED look is preserved byte-for-byte.
 *
 * The code-editor *syntax* theme ([[project_editor_themes]]) is independent and
 * composes on top — pick GitHub Dark chrome with One Dark syntax if you like.
 */
import type { ResolvedMode } from "./mode";
export type ThemeSpec = {
  /** --bg-base / --bg-surface — the main content background. */
  base: string;
  /** Sidebar / rail / file-tree panel surface (slightly off base). */
  panel: string;
  /** Raised cards / secondary surfaces. */
  elevated: string;
  /** Popovers / overlays / tertiary surfaces. */
  overlay: string;
  /** Input field background. */
  input: string;
  /** Active editor tab background. */
  tabActive: string;

  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  textGhost: string;
  textMuted: string;

  borderDefault: string;
  borderSubtle: string;
  borderStrong: string;

  accent: string;
  accentHover: string;
  /** Text/icon color on a solid accent fill (primary buttons). */
  accentForeground: string;
};

export type AtlasTheme = {
  id: string;
  name: string;
  /** One-line character sketch shown beside the preview in the picker. */
  description: string;
  mode: ResolvedMode;
  spec: ThemeSpec;
};

export const DEFAULT_ATLAS_THEME_ID = "atlas-black";

/** The theme whose palette IS the CSS base for its mode (`:root` for dark,
 *  `:root[data-mode="light"]` for light). Applying it clears every inline
 *  override instead of writing one. */
export const BASE_ATLAS_THEME_ID: Record<ResolvedMode, string> = {
  dark: DEFAULT_ATLAS_THEME_ID,
  light: "atlas-light",
};

export const ATLAS_THEMES: AtlasTheme[] = [
  {
    id: "atlas-black",
    name: "Atlas Black",
    description: "Pure AMOLED black — maximum contrast, zero glare.",
    mode: "dark",
    // Preview only — the applier CLEARS overrides for this id so the original
    // AMOLED tokens in tokens.css apply verbatim.
    spec: {
      base: "#000000",
      panel: "#0a0a0a",
      elevated: "#0f0f0f",
      overlay: "#1c1c1c",
      input: "#0a0a0a",
      tabActive: "#171717",
      textPrimary: "#ffffff",
      textSecondary: "#aaaaaa",
      textTertiary: "#777777",
      textGhost: "#333333",
      textMuted: "#585858",
      borderDefault: "#1e1e1e",
      borderSubtle: "#141414",
      borderStrong: "#3d3d3d",
      accent: "#ffffff",
      accentHover: "#cccccc",
      accentForeground: "#000000",
    },
  },
  {
    // Deep warm near-black + muted gold — cozy, very low glare.
    id: "chyral",
    name: "Chyral",
    description: "Warm near-black with muted gold — cozy, low glare.",
    mode: "dark",
    spec: {
      // Warm near-black base (darkest, like Atlas Black's #000) with a raised
      // surface ladder + bright warm borders, so panes/cards stay distinct.
      base: "#080604",
      panel: "#100c07",
      elevated: "#171109",
      overlay: "#211a10",
      input: "#0d0a06",
      tabActive: "#1d1610",
      textPrimary: "#ece5d5",
      textSecondary: "#a99f8c",
      textTertiary: "#6f6656",
      textGhost: "#221c13",
      textMuted: "#4c4636",
      borderDefault: "#2a2114",
      borderSubtle: "#1a140c",
      borderStrong: "#473a22",
      accent: "#c9a35a",
      accentHover: "#d9b878",
      accentForeground: "#140f06",
    },
  },
  {
    // Deep neutral graphite + soft periwinkle — clean, restrained.
    id: "mirage",
    name: "Mirage",
    description: "Neutral graphite with soft periwinkle — clean, restrained.",
    mode: "dark",
    spec: {
      // Cool graphite near-black base (darkest) with a raised surface ladder +
      // bright cool borders, mirroring Atlas Black's depth structure.
      base: "#08080a",
      panel: "#0e0e12",
      elevated: "#15151b",
      overlay: "#1f1f27",
      input: "#0b0b0f",
      tabActive: "#1b1b22",
      textPrimary: "#dcdde2",
      textSecondary: "#9b9ca6",
      textTertiary: "#63646d",
      textGhost: "#1e1e24",
      textMuted: "#484852",
      borderDefault: "#28282f",
      borderSubtle: "#17171c",
      borderStrong: "#44444f",
      accent: "#8b9cf0",
      accentHover: "#a3b1f5",
      accentForeground: "#090a12",
    },
  },
  {
    // AMOLED near-black + Rosé Pine's signature rose — soft, focused.
    id: "rose-pine",
    name: "Rosé Pine",
    description: "AMOLED near-black with a soft rose accent — calm, focused.",
    mode: "dark",
    spec: {
      // Keep the recognizable Rosé Pine warmth while pulling its surfaces
      // toward black for OLED displays and preserving Atlas's depth ladder.
      base: "#08070a",
      panel: "#100e14",
      elevated: "#18151e",
      overlay: "#24202c",
      input: "#0d0b10",
      tabActive: "#1e1a25",
      textPrimary: "#e0def4",
      textSecondary: "#aaa6c2",
      textTertiary: "#7a7692",
      textGhost: "#292532",
      textMuted: "#56516a",
      borderDefault: "#302a39",
      borderSubtle: "#1b1721",
      borderStrong: "#51485f",
      accent: "#eb6f92",
      accentHover: "#f08ba7",
      accentForeground: "#16090e",
    },
  },
  {
    // Atom One Dark's blue-slate chrome + vivid selection blue — balanced, familiar.
    id: "one-dark",
    name: "One Dark",
    description: "Deep blue-slate with Atom's cool blue accent — balanced, familiar.",
    mode: "dark",
    spec: {
      base: "#0b0e14",
      panel: "#11151c",
      elevated: "#181d25",
      overlay: "#21252b",
      input: "#0e1117",
      tabActive: "#1d232c",
      textPrimary: "#abb2bf",
      textSecondary: "#8b929f",
      textTertiary: "#5c6370",
      textGhost: "#252a33",
      textMuted: "#4b5263",
      borderDefault: "#282c34",
      borderSubtle: "#1b2028",
      borderStrong: "#3e4451",
      accent: "#528bff",
      accentHover: "#6fa0ff",
      accentForeground: "#08111a",
    },
  },
  {
    // Amber CRT phosphor glow — classic terminal nostalgia, dark and warm.
    id: "phosphor",
    name: "Phosphor",
    description: "Amber CRT phosphor glow — retro terminal warmth in the dark.",
    mode: "dark",
    spec: {
      // Near-black warm-brown base (matching the depth ladder of the other
      // themes) lit up by a saturated amber phosphor accent + text tier.
      base: "#0a0500",
      panel: "#120900",
      elevated: "#1a0d00",
      overlay: "#241300",
      input: "#0d0600",
      tabActive: "#291600",
      textPrimary: "#ffb000",
      textSecondary: "#cc8800",
      textTertiary: "#8a5c00",
      textGhost: "#2e1a00",
      textMuted: "#5c3d00",
      borderDefault: "#3d2200",
      borderSubtle: "#1f1200",
      borderStrong: "#5c3300",
      accent: "#ff9500",
      accentHover: "#ffb347",
      accentForeground: "#170900",
    },
  },
  {
    id: "atlas-light",
    name: "Atlas Light",
    description: "Pure neutral white with a black accent — Atlas Black, inverted.",
    mode: "light",
    // Preview only — the applier CLEARS overrides for this id so the light
    // block in tokens.css applies verbatim. Keep the two identical
    // (tests/light-root-tokens.test.ts holds them together).
    spec: {
      base: "#ffffff",
      panel: "#f7f7f7",
      elevated: "#f3f3f3",
      overlay: "#ffffff",
      input: "#ffffff",
      tabActive: "#ececec",
      textPrimary: "#000000",
      textSecondary: "#555555",
      textTertiary: "#6e6e6e",
      textGhost: "#cccccc",
      textMuted: "#949494",
      borderDefault: "#e3e3e3",
      borderSubtle: "#ededed",
      borderStrong: "#c2c2c2",
      accent: "#000000",
      accentHover: "#333333",
      accentForeground: "#ffffff",
    },
  },
  {
    // Official One Light values (atom/atom packages/one-light-ui + one-light-syntax,
    // compiled with lessc). Surfaces map onto Atlas's ladder: base = pane
    // (@base-background-color), panel = @tool-panel-background-color, popovers
    // lightest (@level-1-color). borderStrong is derived: @base-border-color − 8%.
    id: "one-light",
    name: "One Light",
    description: "Atom's soft light grey with its cool blue accent — calm, familiar.",
    mode: "light",
    spec: {
      base: "#fafafa",
      panel: "#eaeaeb",
      elevated: "#f2f2f2",
      overlay: "#ffffff",
      input: "#ffffff",
      tabActive: "#dbdbdc",
      textPrimary: "#232324",
      textSecondary: "#424243",
      textTertiary: "#8e8e90",
      textGhost: "#dbdbdc",
      textMuted: "#a0a1a7",
      borderDefault: "#dbdbdc",
      borderSubtle: "#eaeaeb",
      borderStrong: "#c6c7c7",
      accent: "#556de8",
      accentHover: "#304ee2",
      accentForeground: "#ffffff",
    },
  },
  {
    // Official Rosé Pine Dawn (rose-pine/palette palette.json, `dawn`): base,
    // surface, overlay, text, subtle, muted, love, rose. Borders/ghost/tab are
    // derived — `muted` mixed into `base` at 25/14/45/30/10% — because the
    // palette publishes no border roles.
    id: "rose-pine-dawn",
    name: "Rosé Pine Dawn",
    description: "Warm parchment with Rosé Pine's rose accent — soft, unhurried.",
    mode: "light",
    spec: {
      base: "#faf4ed",
      panel: "#f2e9e1",
      elevated: "#fffaf3",
      overlay: "#fffaf3",
      input: "#fffaf3",
      tabActive: "#f0eae6",
      textPrimary: "#464261",
      textSecondary: "#797593",
      textTertiary: "#9893a5",
      textGhost: "#ddd7d7",
      textMuted: "#9893a5",
      borderDefault: "#e2dcdb",
      borderSubtle: "#ece6e3",
      borderStrong: "#cec8cd",
      accent: "#b4637a",
      accentHover: "#d7827e",
      accentForeground: "#ffffff",
    },
  },
];

/** Look up a theme for a mode. An unknown id, or one from the other mode (a
 *  hand-edited config), falls back to that mode's base theme rather than
 *  painting a dark palette over a light base. */
export function getAtlasTheme(
  id: string | undefined | null,
  mode: ResolvedMode = "dark",
): AtlasTheme {
  const found = ATLAS_THEMES.find((t) => t.id === id);
  if (found && found.mode === mode) return found;
  return ATLAS_THEMES.find((t) => t.id === BASE_ATLAS_THEME_ID[mode]) ?? ATLAS_THEMES[0];
}

/** Expand a theme spec into the full CSS-custom-property map that reskins the
 *  UI. `--bg-hover/selected/active` are intentionally left as the tokens.css
 *  translucent-white overlays — they read correctly on any dark base. */
export function buildThemeVars(s: ThemeSpec): Record<string, string> {
  return {
    // Backgrounds (aliases --bg-primary/secondary/tertiary follow via var()).
    "--bg-base": s.base,
    "--bg-surface": s.base,
    "--bg-sidebar": s.panel,
    "--bg-rail": s.panel,
    "--bg-canvas": s.panel,
    "--bg-raised": s.elevated,
    "--bg-overlay": s.overlay,
    "--bg-input": s.input,
    "--bg-tab-active": s.tabActive,
    "--bg-elevated": s.elevated,
    "--bg-elevated-2": s.overlay,
    "--panel-rail-bg": s.panel,
    "--panel-bg": s.panel,
    "--panel-bg-2": s.elevated,

    // Text tiers.
    "--text-primary": s.textPrimary,
    "--text-secondary": s.textSecondary,
    "--text-tertiary": s.textTertiary,
    "--text-ghost": s.textGhost,
    "--text-muted": s.textMuted,
    "--text-inverse": s.base,

    // Borders.
    "--border-default": s.borderDefault,
    "--border-subtle": s.borderSubtle,
    "--border-strong": s.borderStrong,
    "--border-focus": s.borderStrong,
    "--border-variant": s.borderSubtle,

    // Accent + shadcn compat.
    "--accent-primary": s.accent,
    "--accent-primary-hover": s.accentHover,
    "--accent-primary-muted": `color-mix(in srgb, ${s.accent} 14%, transparent)`,
    "--accent-secondary": s.textTertiary,
    "--primary-foreground": s.accentForeground,
    "--muted": s.elevated,
    "--accent": s.elevated,
    "--ring": s.accent,
  };
}
