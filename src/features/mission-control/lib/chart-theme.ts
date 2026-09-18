// Recharts theming. Recharts takes color PROPS, which land in SVG presentation
// attributes and inline styles — both resolve CSS variables, so the chart
// follows the interface theme and the appearance mode.

export const CHART = {
  grid: "color-mix(in srgb, var(--contrast) 6%, transparent)",
  axis: "var(--text-tertiary)",
  tickFont: 11,
  tooltipBg: "var(--bg-elevated)",
  tooltipBorder: "var(--border-default)",
} as const;

/** A series color: the light-mode token, or the dark grey that always shipped. */
const series = (name: string, dark: string) => `var(--chart-${name}, ${dark})`;

// Muted, desaturated tones — faint hue separation only. Light mode deepens
// each to ≥ 3:1 (tokens.css `--chart-*`).
export const AGENT_COLOR = {
  // One colour for every Atlas agent: the dashboard folds them into one
  // series rather than growing a column per agent (issue #17).
  agents: series("agents", "#b9b1a6"), // warm gray
  gpt: series("gpt", "#93a3ad"), // muted slate
  gemini: series("gemini", "#9aa6c0"), // muted periwinkle-gray
  byok: series("byok", "#a89fb0"), // muted mauve-gray
  input: series("input", "#c9c9cf"), // light gray
  output: series("output", "#7f8088"), // mid gray
} as const;

// Per-project palette: low-saturation grays with a whisper of hue. Cycles.
const PROJECT_PALETTE = [
  "#cfcfd4", // light gray
  "#9aa3ad", // slate
  "#a8b0a3", // sage-gray
  "#b3aa9e", // warm gray
  "#a39fb0", // mauve-gray
  "#8f96a0", // cool gray
  "#bdb6ab", // sand-gray
  "#9bb0aa", // muted teal-gray
  "#b0a6b3", // dusty lilac-gray
  "#878d92", // graphite
].map((hex, i) => series(`project-${i}`, hex));

export function projectColor(index: number): string {
  return PROJECT_PALETTE[index % PROJECT_PALETTE.length];
}

/** Build a stable path→color map preserving project order. */
export function projectColorMap(paths: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  paths.forEach((p, i) => {
    map[p] = projectColor(i);
  });
  return map;
}
