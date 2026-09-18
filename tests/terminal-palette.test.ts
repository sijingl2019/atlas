import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ANSI_KEYS, TERMINAL_PALETTES } from "@/features/terminal/lib/terminal-palette";
import { rootBlockTokens } from "./lib/dark-root-tokens";

/**
 * Two renderers draw terminal colors: xterm (canvas/WebGL, needs resolved
 * colors from TS) and the block renderer (DOM spans, `var(--ansi-N, dark)`).
 * The light values live in both places; this keeps them one palette.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const light = rootBlockTokens(
  readFileSync(path.join(REPO_ROOT, "src", "styles", "tokens.css"), "utf8"),
  ':root[data-mode="light"]',
);

describe("terminal palette", () => {
  it("keeps the dark palette the terminal always had", () => {
    // Every key, not a sample: these are the values the terminal shipped with,
    // and a changed one is invisible in review.
    expect(TERMINAL_PALETTES.dark).toEqual({
      background: "#000000",
      foreground: "#cccccc",
      cursor: "#b3b3b3",
      selectionBackground: "rgba(97,175,239,0.35)",
      selectionInactiveBackground: "rgba(255,255,255,0.16)",
      black: "#1a1a1a",
      red: "#e06c75",
      green: "#98c379",
      yellow: "#e5c07b",
      blue: "#61afef",
      magenta: "#c678dd",
      cyan: "#56b6c2",
      white: "#cccccc",
      brightBlack: "#5c6370",
      brightRed: "#e06c75",
      brightGreen: "#98c379",
      brightYellow: "#e5c07b",
      brightBlue: "#61afef",
      brightMagenta: "#c678dd",
      brightCyan: "#56b6c2",
      brightWhite: "#ffffff",
    });
  });

  it("keeps the light greys distinguishable", () => {
    const { black, brightBlack, white, brightWhite, background } = TERMINAL_PALETTES.light;
    const greys = [black, brightBlack, white, brightWhite];
    expect(new Set(greys).size).toBe(greys.length);
    // Bright white emphasizes, so on a light background it must be darker than
    // plain white rather than brighter — and nothing may match the background.
    expect(greys).not.toContain(background);
  });

  it("matches the light CSS tokens exactly", () => {
    expect(light["--term-bg"]).toBe(TERMINAL_PALETTES.light.background);
    ANSI_KEYS.forEach((key, i) => {
      expect(light[`--ansi-${i}`], key).toBe(TERMINAL_PALETTES.light[key]);
    });
  });
});
