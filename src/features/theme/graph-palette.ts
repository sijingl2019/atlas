import { currentMode, type ResolvedMode } from "./mode";

/** Node/edge/label colors for the Pixi graphs (knowledge, memory). Pixi draws
 *  to WebGL and cannot read CSS variables. Dark is the palette the graphs
 *  always used; light inverts the grey ramp. Pixi 8 accepts these hex strings
 *  for both Graphics fills and TextStyle. */
export type GraphPalette = {
  primary: string;
  secondary: string;
  muted: string;
  edgeDefault: string;
  edgeSelected: string;
  edgeDim: string;
  edgeLink: string;
  /** "influenced this" — cool tint, upstream in time */
  ancestor: string;
  /** "this influenced" — strongest ink, downstream in time */
  impact: string;
};

const PALETTES: Record<ResolvedMode, GraphPalette> = {
  dark: {
    primary: "#fafafa",
    secondary: "#c4c4c4",
    muted: "#5e5e5e",
    edgeDefault: "#333333",
    edgeSelected: "#c4c4c4",
    edgeDim: "#262626",
    edgeLink: "#4a4a4a",
    ancestor: "#6796e6",
    impact: "#fafafa",
  },
  light: {
    primary: "#1a1a1a",
    secondary: "#4a4a4a",
    muted: "#9e9e9e",
    edgeDefault: "#bdbdbd",
    edgeSelected: "#4a4a4a",
    edgeDim: "#d6d6d6",
    edgeLink: "#a3a3a3",
    ancestor: "#0969da",
    impact: "#1a1a1a",
  },
};

/** The palette for `mode`, or for the mode on screen. Stable object identity
 *  per mode, so a render loop can compare it to skip unchanged frames. */
export function graphPalette(mode: ResolvedMode = currentMode()): GraphPalette {
  return PALETTES[mode];
}
