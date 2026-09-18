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
    expect(TERMINAL_PALETTES.dark).toMatchObject({
      background: "#000000",
      foreground: "#cccccc",
      black: "#1a1a1a",
      red: "#e06c75",
      brightWhite: "#ffffff",
    });
  });

  it("matches the light CSS tokens exactly", () => {
    expect(light["--term-bg"]).toBe(TERMINAL_PALETTES.light.background);
    ANSI_KEYS.forEach((key, i) => {
      expect(light[`--ansi-${i}`], key).toBe(TERMINAL_PALETTES.light[key]);
    });
  });
});
