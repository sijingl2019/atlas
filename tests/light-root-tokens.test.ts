import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ATLAS_THEMES, buildThemeVars } from "@/features/theme/themes";
import { darkRootTokens, rootBlockTokens } from "./lib/dark-root-tokens";

/**
 * The light base in tokens.css IS Atlas Light: applying Atlas Light clears all
 * inline overrides, so the block and the theme spec must say the same thing or
 * the picker preview lies. It also carries light values for tokens no theme
 * overrides (hover washes, status colors, shadows, terminal, charts), which
 * every light theme inherits.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(path.join(REPO_ROOT, "src", "styles", "tokens.css"), "utf8");
const LIGHT = ':root[data-mode="light"]';

describe("light :root tokens", () => {
  const light = rootBlockTokens(css, LIGHT);

  it("matches the Atlas Light theme spec exactly", () => {
    const spec = ATLAS_THEMES.find((t) => t.id === "atlas-light")!.spec;
    const mismatched = Object.entries(buildThemeVars(spec))
      .filter(([name, value]) => light[name] !== value)
      .map(([name, value]) => `${name}: spec ${value}, css ${light[name] ?? "(missing)"}`);
    expect(mismatched).toEqual([]);
  });

  it("gives every mode-relative dark token a light value", () => {
    const required = [
      "--contrast", "--shade", "--shadow-popover",
      "--shadow-sm", "--shadow-md", "--shadow-lg", "--shadow-overlay",
      "--bg-hover", "--bg-selected", "--bg-active", "--selection-bg",
      "--comms-outer", "--comms-surface", "--comms-mention-bg", "--comms-mention-text",
      "--comms-mention-other-bg", "--comms-mention-other-text", "--comms-unread", "--comms-unread-deep",
      "--text-accent", "--status-success", "--status-warning", "--status-error", "--status-info",
      "--status-purple", "--status-orange", "--stat-added", "--stat-removed", "--capture-live",
      "--diff-added-bg", "--diff-added-text", "--diff-removed-bg", "--diff-removed-text", "--diff-modified-bg",
    ];
    expect(required.filter((name) => !(name in light))).toEqual([]);
    expect(light["--contrast"]).toBe("#000000");
  });

  it("defines every light-only token the source references", () => {
    // `--term-*`, `--ansi-*` and `--chart-*` exist only in light mode; dark
    // consumers use the old literal as the var() fallback.
    const names = new Set<string>();
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(tsx?|css)$/.test(e.name)) {
          for (const m of readFileSync(p, "utf8").matchAll(/var\((--(?:term|ansi|chart)-[\w-]+)/g)) names.add(m[1]);
        }
      }
    };
    walk(path.join(REPO_ROOT, "src"));
    expect([...names].filter((n) => !(n in light))).toEqual([]);
  });

  it("is not read as part of the dark palette", () => {
    const dark = darkRootTokens(css);
    expect(dark["--bg-base"]).toBe("#000000");
    expect(dark["--contrast"]).toBe("#ffffff");
  });
});
