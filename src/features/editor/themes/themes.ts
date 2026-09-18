import type { ResolvedMode } from "@/features/theme/mode";
import type { EditorColorTheme, EditorThemeColors } from "./types";

/**
 * Built-in editor color themes. `atlas` is the default; `atlas-mono` keeps the
 * historical monochrome look for anyone who prefers it. The others are the
 * standard dark palettes (Dracula, One Dark, Monokai, Tokyo Night, Catppuccin
 * Frappé/Macchiato/Mocha, Vesper), plus light counterparts (Atlas Light, One
 * Light, Catppuccin Latte) shown when the appearance mode is light.
 *
 * Every theme renders on the interface base surface (see `resolveEditorColors`),
 * which is near-black in dark mode and near-white in light mode. Syntax values
 * are chosen against the bases of their own mode, and `themes.test.ts` holds
 * them to a contrast floor so a new palette can't ship illegible.
 */

/**
 * The default. Restrained rather than colorful — near-monochrome structure with
 * the Atlas `#ffff00` accent kept for function names — but with each token
 * family far enough apart in hue and lightness to actually be *read* as
 * highlighted code.
 *
 * The previous default drew comments at `#555555` and keywords at `#585858`,
 * both under 3:1 on black and within a hair of each other, so a source file
 * arrived looking like unhighlighted grey text (issue #75). Everything here
 * clears 4.5:1 (WCAG AA for body text) against the black it is drawn on;
 * comments sit lowest on purpose, subdued but legible.
 */
const atlas: EditorColorTheme = {
  id: "atlas",
  name: "Atlas",
  description: "AMOLED black with restrained syntax hues and the Atlas yellow accent.",
  dark: true,
  colors: {
    bg: "#000000",
    fg: "#d4d4d4",
    caret: "#d4d4d4",
    gutterBg: "#000000",
    // Line numbers are reference furniture, not prose: dim enough to recede,
    // still above the 3:1 floor for meaningful non-text UI.
    gutterFg: "#666666",
    activeLineGutterFg: "#d4d4d4",
    activeLineBg: "#ffffff0a",
    selectionBg: "#303030",
    matchBracketBg: "#2d2d2d",
    matchBracketOutline: "#3d3d3d",
    foldBg: "#1a1a1a",
    foldBorder: "#2a2a2a",
    foldFg: "#8a8a8a",

    comment: "#8f8f8f",
    keyword: "#c9a2f5",
    string: "#9ecf8a",
    number: "#e0b070",
    type: "#7fd1e8",
    func: "#ffff00",
    variable: "#eaeaea",
    operator: "#9a9a9a",
    tagName: "#7fd1e8",
    attributeName: "#d9b47a",
    constant: "#e0b070",
    regexp: "#e59a72",
    escape: "#e59a72",
    definition: "#ffffff",
    propertyName: "#c8c8c8",
    bool: "#e0b070",
    null: "#e0b070",

    addLineBg: "#0d2211",
    removeLineBg: "#220d0d",
    contextBg: "#0a0a0a",
    addSideBg: "rgba(34,197,94,0.13)",
    removeSideBg: "rgba(244,63,63,0.13)",
    emphAddBg: "rgba(52,211,153,0.34)",
    emphRemoveBg: "rgba(244,63,63,0.34)",
  },
};

/**
 * The original Atlas look — hue-free, one yellow accent — kept as a choice for
 * anyone who wants the editor to match the monochrome interface exactly.
 *
 * Same identity as before, but the ramp is spread across readable lightnesses
 * instead of bunching at the bottom: comments and keywords used to sit under
 * 3:1 on black. Tokens separate by weight of grey and by italics rather than by
 * hue, which is the point of the theme.
 */
const atlasMono: EditorColorTheme = {
  id: "atlas-mono",
  name: "Atlas Mono",
  description: "Monochrome AMOLED black with a single yellow accent.",
  dark: true,
  colors: {
    bg: "#000000",
    fg: "#d0d0d0",
    caret: "#d0d0d0",
    gutterBg: "#000000",
    gutterFg: "#666666",
    activeLineGutterFg: "#d0d0d0",
    activeLineBg: "#ffffff0a",
    selectionBg: "#303030",
    matchBracketBg: "#2d2d2d",
    matchBracketOutline: "#3d3d3d",
    foldBg: "#1a1a1a",
    foldBorder: "#2a2a2a",
    foldFg: "#8a8a8a",

    comment: "#8a8a8a",
    keyword: "#e6e6e6",
    string: "#b0b0b0",
    number: "#c2c2c2",
    type: "#d4d4d4",
    func: "#ffff00",
    variable: "#ffffff",
    operator: "#9c9c9c",
    tagName: "#d4d4d4",
    attributeName: "#a8a8a8",
    constant: "#c2c2c2",
    regexp: "#b0b0b0",
    escape: "#b0b0b0",
    definition: "#ffffff",
    propertyName: "#c8c8c8",
    bool: "#c2c2c2",
    null: "#c2c2c2",

    addLineBg: "#0d2211",
    removeLineBg: "#220d0d",
    contextBg: "#0a0a0a",
    addSideBg: "rgba(34,197,94,0.13)",
    removeSideBg: "rgba(244,63,63,0.13)",
    emphAddBg: "rgba(52,211,153,0.34)",
    emphRemoveBg: "rgba(244,63,63,0.34)",
  },
};

const dracula: EditorColorTheme = {
  id: "dracula",
  name: "Dracula",
  description: "The classic purple-tinted dark theme with vivid syntax.",
  dark: true,
  colors: {
    bg: "#282a36",
    fg: "#f8f8f2",
    caret: "#f8f8f2",
    gutterBg: "#282a36",
    gutterFg: "#6272a4",
    activeLineGutterFg: "#f8f8f2",
    activeLineBg: "#ffffff0a",
    selectionBg: "#44475a",
    matchBracketBg: "#44475a",
    matchBracketOutline: "#6272a4",
    foldBg: "#21222c",
    foldBorder: "#44475a",
    foldFg: "#6272a4",

    comment: "#6272a4",
    keyword: "#ff79c6",
    string: "#f1fa8c",
    number: "#bd93f9",
    type: "#8be9fd",
    func: "#50fa7b",
    variable: "#f8f8f2",
    operator: "#ff79c6",
    tagName: "#ff79c6",
    attributeName: "#50fa7b",
    constant: "#bd93f9",
    regexp: "#ff5555",
    escape: "#ff5555",
    definition: "#f8f8f2",
    propertyName: "#8be9fd",
    bool: "#bd93f9",
    null: "#bd93f9",

    addLineBg: "#1e3a2a",
    removeLineBg: "#3a1e28",
    contextBg: "#21222c",
    addSideBg: "rgba(80,250,123,0.13)",
    removeSideBg: "rgba(255,85,85,0.13)",
    emphAddBg: "rgba(80,250,123,0.30)",
    emphRemoveBg: "rgba(255,85,85,0.30)",
  },
};

const oneDark: EditorColorTheme = {
  id: "one-dark",
  name: "One Dark",
  description: "Atom's balanced blue-and-slate dark theme.",
  dark: true,
  colors: {
    bg: "#282c34",
    fg: "#abb2bf",
    caret: "#528bff",
    gutterBg: "#282c34",
    gutterFg: "#4b5263",
    activeLineGutterFg: "#abb2bf",
    activeLineBg: "#ffffff0a",
    selectionBg: "#3e4451",
    matchBracketBg: "#3e4451",
    matchBracketOutline: "#528bff",
    foldBg: "#21252b",
    foldBorder: "#3e4451",
    foldFg: "#5c6370",

    comment: "#5c6370",
    keyword: "#c678dd",
    string: "#98c379",
    number: "#d19a66",
    type: "#e5c07b",
    func: "#61afef",
    variable: "#e06c75",
    operator: "#56b6c2",
    tagName: "#e06c75",
    attributeName: "#d19a66",
    constant: "#d19a66",
    regexp: "#98c379",
    escape: "#56b6c2",
    definition: "#61afef",
    propertyName: "#abb2bf",
    bool: "#d19a66",
    null: "#d19a66",

    addLineBg: "#1c3323",
    removeLineBg: "#331c1f",
    contextBg: "#21252b",
    addSideBg: "rgba(152,195,121,0.13)",
    removeSideBg: "rgba(224,108,117,0.13)",
    emphAddBg: "rgba(152,195,121,0.30)",
    emphRemoveBg: "rgba(224,108,117,0.30)",
  },
};

const monokai: EditorColorTheme = {
  id: "monokai",
  name: "Monokai",
  description: "High-contrast green/pink palette on warm charcoal.",
  dark: true,
  colors: {
    bg: "#272822",
    fg: "#f8f8f2",
    caret: "#f8f8f0",
    gutterBg: "#272822",
    gutterFg: "#90908a",
    activeLineGutterFg: "#f8f8f2",
    activeLineBg: "#ffffff0a",
    selectionBg: "#49483e",
    matchBracketBg: "#49483e",
    matchBracketOutline: "#75715e",
    foldBg: "#1e1f1c",
    foldBorder: "#49483e",
    foldFg: "#75715e",

    comment: "#75715e",
    keyword: "#f92672",
    string: "#e6db74",
    number: "#ae81ff",
    type: "#66d9ef",
    func: "#a6e22e",
    variable: "#f8f8f2",
    operator: "#f92672",
    tagName: "#f92672",
    attributeName: "#a6e22e",
    constant: "#ae81ff",
    regexp: "#e6db74",
    escape: "#ae81ff",
    definition: "#a6e22e",
    propertyName: "#66d9ef",
    bool: "#ae81ff",
    null: "#ae81ff",

    addLineBg: "#26331c",
    removeLineBg: "#331c22",
    contextBg: "#1e1f1c",
    addSideBg: "rgba(166,226,46,0.13)",
    removeSideBg: "rgba(249,38,114,0.13)",
    emphAddBg: "rgba(166,226,46,0.30)",
    emphRemoveBg: "rgba(249,38,114,0.30)",
  },
};

const tokyoNight: EditorColorTheme = {
  id: "tokyo-night",
  name: "Tokyo Night",
  description: "Cool midnight blue with vivid purple, cyan, and coral syntax.",
  dark: true,
  colors: {
    bg: "#1a1b26",
    fg: "#c0caf5",
    caret: "#c0caf5",
    gutterBg: "#1a1b26",
    gutterFg: "#565f89",
    activeLineGutterFg: "#a9b1d6",
    activeLineBg: "#ffffff0a",
    selectionBg: "#33467c",
    matchBracketBg: "#292e42",
    matchBracketOutline: "#7aa2f7",
    foldBg: "#16161e",
    foldBorder: "#292e42",
    foldFg: "#565f89",

    comment: "#565f89",
    keyword: "#bb9af7",
    string: "#9ece6a",
    number: "#ff9e64",
    type: "#2ac3de",
    func: "#7aa2f7",
    variable: "#c0caf5",
    operator: "#89ddff",
    tagName: "#f7768e",
    attributeName: "#73daca",
    constant: "#ff9e64",
    regexp: "#b4f9f8",
    escape: "#bb9af7",
    definition: "#7aa2f7",
    propertyName: "#7dcfff",
    bool: "#ff9e64",
    null: "#ff9e64",

    addLineBg: "#1b3328",
    removeLineBg: "#3b202b",
    contextBg: "#16161e",
    addSideBg: "rgba(158,206,106,0.13)",
    removeSideBg: "rgba(247,118,142,0.13)",
    emphAddBg: "rgba(158,206,106,0.30)",
    emphRemoveBg: "rgba(247,118,142,0.30)",
  },
};

/**
 * Catppuccin ships four flavors; the three dark ones are here and Latte is the
 * light counterpart further down. The three port scope-for-scope from
 * catppuccin/vscode's own token mapping (mauve keywords, blue functions/tags,
 * green strings, peach numbers/constants/booleans, yellow types/attributes,
 * teal operators/properties, pink regexp/escapes, rosewater caret, mauve
 * accent on the active line number) rather than inventing a new arrangement.
 */
const catppuccinFrappe: EditorColorTheme = {
  id: "catppuccin-frappe",
  name: "Catppuccin Frappé",
  description: "Soft pastel palette, the lightest of the three dark Catppuccin flavors.",
  dark: true,
  colors: {
    bg: "#303446",
    fg: "#c6d0f5",
    caret: "#f2d5cf",
    gutterBg: "#303446",
    gutterFg: "#838ba7",
    activeLineGutterFg: "#ca9ee6",
    activeLineBg: "#ffffff0a",
    selectionBg: "#51576d",
    matchBracketBg: "#414559",
    matchBracketOutline: "#949cbb",
    foldBg: "#292c3c",
    foldBorder: "#414559",
    foldFg: "#838ba7",

    comment: "#949cbb",
    keyword: "#ca9ee6",
    string: "#a6d189",
    number: "#ef9f76",
    type: "#e5c890",
    func: "#8caaee",
    variable: "#c6d0f5",
    operator: "#81c8be",
    tagName: "#8caaee",
    attributeName: "#e5c890",
    constant: "#ef9f76",
    regexp: "#f4b8e4",
    escape: "#f4b8e4",
    definition: "#8caaee",
    propertyName: "#81c8be",
    bool: "#ef9f76",
    null: "#ef9f76",

    addLineBg: "#242c1e",
    removeLineBg: "#301d1d",
    contextBg: "#292c3c",
    addSideBg: "rgba(166,209,137,0.13)",
    removeSideBg: "rgba(231,130,132,0.13)",
    emphAddBg: "rgba(166,209,137,0.30)",
    emphRemoveBg: "rgba(231,130,132,0.30)",
  },
};

const catppuccinMacchiato: EditorColorTheme = {
  id: "catppuccin-macchiato",
  name: "Catppuccin Macchiato",
  description: "Medium-contrast pastel palette, between Frappé and Mocha.",
  dark: true,
  colors: {
    bg: "#24273a",
    fg: "#cad3f5",
    caret: "#f4dbd6",
    gutterBg: "#24273a",
    gutterFg: "#8087a2",
    activeLineGutterFg: "#c6a0f6",
    activeLineBg: "#ffffff0a",
    selectionBg: "#494d64",
    matchBracketBg: "#363a4f",
    matchBracketOutline: "#939ab7",
    foldBg: "#1e2030",
    foldBorder: "#363a4f",
    foldFg: "#8087a2",

    comment: "#939ab7",
    keyword: "#c6a0f6",
    string: "#a6da95",
    number: "#f5a97f",
    type: "#eed49f",
    func: "#8aadf4",
    variable: "#cad3f5",
    operator: "#8bd5ca",
    tagName: "#8aadf4",
    attributeName: "#eed49f",
    constant: "#f5a97f",
    regexp: "#f5bde6",
    escape: "#f5bde6",
    definition: "#8aadf4",
    propertyName: "#8bd5ca",
    bool: "#f5a97f",
    null: "#f5a97f",

    addLineBg: "#242d20",
    removeLineBg: "#311e21",
    contextBg: "#1e2030",
    addSideBg: "rgba(166,218,149,0.13)",
    removeSideBg: "rgba(237,135,150,0.13)",
    emphAddBg: "rgba(166,218,149,0.30)",
    emphRemoveBg: "rgba(237,135,150,0.30)",
  },
};

const catppuccinMocha: EditorColorTheme = {
  id: "catppuccin-mocha",
  name: "Catppuccin Mocha",
  description: "The flagship Catppuccin flavor: soothing pastels on the darkest base.",
  dark: true,
  colors: {
    bg: "#1e1e2e",
    fg: "#cdd6f4",
    caret: "#f5e0dc",
    gutterBg: "#1e1e2e",
    gutterFg: "#7f849c",
    activeLineGutterFg: "#cba6f7",
    activeLineBg: "#ffffff0a",
    selectionBg: "#45475a",
    matchBracketBg: "#313244",
    matchBracketOutline: "#9399b2",
    foldBg: "#181825",
    foldBorder: "#313244",
    foldFg: "#7f849c",

    comment: "#9399b2",
    keyword: "#cba6f7",
    string: "#a6e3a1",
    number: "#fab387",
    type: "#f9e2af",
    func: "#89b4fa",
    variable: "#cdd6f4",
    operator: "#94e2d5",
    tagName: "#89b4fa",
    attributeName: "#f9e2af",
    constant: "#fab387",
    regexp: "#f5c2e7",
    escape: "#f5c2e7",
    definition: "#89b4fa",
    propertyName: "#94e2d5",
    bool: "#fab387",
    null: "#fab387",

    addLineBg: "#242f23",
    removeLineBg: "#321e24",
    contextBg: "#181825",
    addSideBg: "rgba(166,227,161,0.13)",
    removeSideBg: "rgba(243,139,168,0.13)",
    emphAddBg: "rgba(166,227,161,0.30)",
    emphRemoveBg: "rgba(243,139,168,0.30)",
  },
};

const vesper: EditorColorTheme = {
  id: "vesper",
  name: "Vesper",
  description: "Minimal near-black with warm peach and mint accents.",
  dark: true,
  colors: {
    bg: "#101010",
    fg: "#ffffff",
    caret: "#ffc799",
    gutterBg: "#101010",
    gutterFg: "#3a3a3a",
    activeLineGutterFg: "#8b8b8b",
    activeLineBg: "#ffffff0a",
    selectionBg: "rgba(255,255,255,0.13)",
    matchBracketBg: "#2a2a2a",
    matchBracketOutline: "#3a3a3a",
    foldBg: "#1a1a1a",
    foldBorder: "#2a2a2a",
    foldFg: "#555555",

    comment: "#8b8b8b",
    keyword: "#a0a0a0",
    string: "#99ffe4",
    number: "#ffc799",
    type: "#ffcfa8",
    func: "#ffc799",
    variable: "#ffffff",
    operator: "#a0a0a0",
    tagName: "#a0a0a0",
    attributeName: "#ffc799",
    constant: "#ffc799",
    regexp: "#99ffe4",
    escape: "#99ffe4",
    definition: "#ffffff",
    propertyName: "#e0e0e0",
    bool: "#ffc799",
    null: "#ffc799",

    addLineBg: "#14261a",
    removeLineBg: "#2a1414",
    contextBg: "#0d0d0d",
    addSideBg: "rgba(153,255,228,0.10)",
    removeSideBg: "rgba(255,120,120,0.12)",
    emphAddBg: "rgba(153,255,228,0.24)",
    emphRemoveBg: "rgba(255,120,120,0.30)",
  },
};

/** Light diff line backgrounds shared by the light themes. */
const LIGHT_DIFF = {
  addLineBg: "#e6ffec",
  removeLineBg: "#ffebe9",
  contextBg: "#ffffff",
  addSideBg: "rgba(26,127,55,0.10)",
  removeSideBg: "rgba(207,34,46,0.10)",
  emphAddBg: "rgba(26,127,55,0.24)",
  emphRemoveBg: "rgba(207,34,46,0.24)",
};

/**
 * Atlas Light keeps every syntax role's HUE from the dark Atlas theme and only
 * lowers lightness until it clears WCAG AA (4.5:1) on all light interface
 * bases. The signature `#ffff00` would be 1.07:1 on white, so function names
 * land on the same hue at a readable dark gold. Keywords sit darker than the
 * floor so they stay a clear step away from comments.
 */
const atlasLight: EditorColorTheme = {
  id: "atlas-light",
  name: "Atlas Light",
  description: "Clean white with the Atlas syntax hues, deepened for daylight.",
  dark: false,
  colors: {
    bg: "#ffffff",
    fg: "#303030",
    caret: "#303030",
    gutterBg: "#ffffff",
    gutterFg: "#858585",
    activeLineGutterFg: "#303030",
    activeLineBg: "#0000000a",
    selectionBg: "#d6d6d6",
    matchBracketBg: "#e0e0e0",
    matchBracketOutline: "#b0b0b0",
    foldBg: "#f0f0f0",
    foldBorder: "#d8d8d8",
    foldFg: "#6f6f6f",

    comment: "#6f6f6f",
    keyword: "#6815c5",
    string: "#487b33",
    number: "#966421",
    type: "#1a7893",
    func: "#707000",
    variable: "#292929",
    operator: "#666666",
    tagName: "#1a7893",
    attributeName: "#8f6729",
    constant: "#966421",
    regexp: "#b25321",
    escape: "#b25321",
    definition: "#000000",
    propertyName: "#434343",
    bool: "#966421",
    null: "#966421",

    ...LIGHT_DIFF,
  },
};

/**
 * Atom One Light, from atom/atom packages/one-light-syntax (colors.less +
 * syntax-variables.less, compiled with lessc), using the same role mapping as
 * One Dark above. Two published values sit under the 3:1 floor on the light
 * bases and are nudged to just clear it: comment mono-3 #a0a1a7 → #8c8d95,
 * green hue-4 #50a14f → #4f9f4e.
 */
const oneLight: EditorColorTheme = {
  id: "one-light",
  name: "One Light",
  description: "Atom's balanced light theme — purple keywords, blue functions.",
  dark: false,
  colors: {
    bg: "#fafafa",
    fg: "#383a42",
    caret: "#526eff",
    gutterBg: "#fafafa",
    gutterFg: "#9d9d9f",
    activeLineGutterFg: "#383a42",
    activeLineBg: "#383a420d",
    selectionBg: "#e5e5e6",
    matchBracketBg: "#e5e5e6",
    matchBracketOutline: "#526eff",
    foldBg: "#eaeaeb",
    foldBorder: "#dbdbdc",
    foldFg: "#696c77",

    comment: "#8c8d95",
    keyword: "#a626a4",
    string: "#4f9f4e",
    number: "#b76b01",
    type: "#cb7701",
    func: "#4078f2",
    variable: "#e45649",
    operator: "#0184bc",
    tagName: "#e45649",
    attributeName: "#b76b01",
    constant: "#b76b01",
    regexp: "#4f9f4e",
    escape: "#0184bc",
    definition: "#4078f2",
    propertyName: "#383a42",
    bool: "#b76b01",
    null: "#b76b01",

    ...LIGHT_DIFF,
  },
};

/**
 * Catppuccin Latte from catppuccin/palette palette.json, mapped exactly like
 * Mocha (mauve keywords, blue functions/tags, green strings, peach numbers,
 * yellow types/attributes, teal operators/properties, pink regexp/escapes).
 * Latte's peach, yellow and pink sit under the 3:1 floor on the light bases and
 * are deepened just enough: #fe640b → #f45a01, #df8e1d → #c67e1a,
 * #ea76cb → #e555be.
 */
const catppuccinLatte: EditorColorTheme = {
  id: "catppuccin-latte",
  name: "Catppuccin Latte",
  description: "Catppuccin's light flavor: pastel hues on a soft cool white.",
  dark: false,
  colors: {
    bg: "#eff1f5",
    fg: "#4c4f69",
    caret: "#dc8a78",
    gutterBg: "#eff1f5",
    gutterFg: "#8c8fa1",
    activeLineGutterFg: "#8839ef",
    activeLineBg: "#4c4f690a",
    selectionBg: "#bcc0cc",
    matchBracketBg: "#ccd0da",
    matchBracketOutline: "#7c7f93",
    foldBg: "#e6e9ef",
    foldBorder: "#ccd0da",
    foldFg: "#8c8fa1",

    comment: "#7c7f93",
    keyword: "#8839ef",
    string: "#40a02b",
    number: "#f45a01",
    type: "#c67e1a",
    func: "#1e66f5",
    variable: "#4c4f69",
    operator: "#179299",
    tagName: "#1e66f5",
    attributeName: "#c67e1a",
    constant: "#f45a01",
    regexp: "#e555be",
    escape: "#e555be",
    definition: "#1e66f5",
    propertyName: "#179299",
    bool: "#f45a01",
    null: "#f45a01",

    addLineBg: "#dcefd8",
    removeLineBg: "#f5d9df",
    contextBg: "#eff1f5",
    addSideBg: "rgba(64,160,43,0.13)",
    removeSideBg: "rgba(210,15,57,0.13)",
    emphAddBg: "rgba(64,160,43,0.30)",
    emphRemoveBg: "rgba(210,15,57,0.30)",
  },
};

export const EDITOR_THEMES: EditorColorTheme[] = [
  atlas,
  atlasMono,
  dracula,
  oneDark,
  monokai,
  tokyoNight,
  catppuccinFrappe,
  catppuccinMacchiato,
  catppuccinMocha,
  vesper,
  atlasLight,
  oneLight,
  catppuccinLatte,
];

export const DEFAULT_EDITOR_THEME_ID = "atlas";

export const BASE_EDITOR_THEME_ID: Record<ResolvedMode, string> = {
  dark: DEFAULT_EDITOR_THEME_ID,
  light: "atlas-light",
};

/** An unknown id, or a theme from the other mode, falls back to that mode's base. */
export function getEditorTheme(
  id: string | undefined | null,
  mode: ResolvedMode = "dark",
): EditorColorTheme {
  const found = EDITOR_THEMES.find((t) => t.id === id);
  if (found && found.dark === (mode === "dark")) return found;
  return EDITOR_THEMES.find((t) => t.id === BASE_EDITOR_THEME_ID[mode]) ?? atlas;
}

/**
 * Atlas keeps ONE background across every editor theme: the interface base
 * surface (`--bg-base`). A theme only recolors syntax and the
 * diff add/remove signal — never the neutral background. So we always force the
 * editor chrome background, the gutter, and the diff *context* (unchanged-line)
 * background to `--bg-base`, ignoring whatever `bg`/`gutterBg`/`contextBg` a
 * theme declares. Uses the CSS var (not a literal) so it tracks the interface.
 */
export function resolveEditorColors(theme: EditorColorTheme): EditorThemeColors {
  return {
    ...theme.colors,
    bg: "var(--bg-base)",
    gutterBg: "var(--bg-base)",
    contextBg: "var(--bg-base)",
  };
}
