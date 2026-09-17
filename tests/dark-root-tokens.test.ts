import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { darkRootTokens } from "./lib/dark-root-tokens";

/**
 * The dark `:root` palette in `tokens.css` is Atlas Black — the look the app
 * shipped with — and the default every other dark theme overrides on top of.
 *
 * Moving hardcoded colors onto tokens touches the same file that defines them,
 * and a tweak to one of those values is invisible in review: it reads as one
 * changed hex among hundreds of lines, and every screen still "looks dark".
 * So the values are pinned against a snapshot taken before that work began.
 *
 * Adding a token is fine and is listed in `ADDED` with the value it must have.
 * Changing an existing one is a decision, not a side effect: update the
 * fixture by hand and say why in the commit. Do NOT regenerate the fixture to
 * make this pass.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKENS = path.join(REPO_ROOT, "src", "styles", "tokens.css");
const FIXTURE = path.join(REPO_ROOT, "tests", "fixtures", "dark-root-tokens.json");

/** Tokens added to the dark :root since the snapshot, with their required value. */
const ADDED: Record<string, string> = {
  "--contrast": "#ffffff",
  "--shade": "#000000",
  "--shadow-popover":
    "inset 0 1px 0 color-mix(in srgb, var(--contrast) 8%, transparent), 0 16px 48px color-mix(in srgb, var(--shade) 95%, transparent)",
};

describe("dark :root tokens", () => {
  const snapshot = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, string>;
  const current = darkRootTokens(readFileSync(TOKENS, "utf8"));

  it("keeps every snapshotted value", () => {
    const changed = Object.entries(snapshot)
      .filter(([name, value]) => current[name] !== value)
      .map(([name, value]) => `${name}: was ${value}, now ${current[name] ?? "(removed)"}`);
    expect(changed).toEqual([]);
  });

  it("adds only the listed tokens, with their listed values", () => {
    const extra = Object.fromEntries(Object.entries(current).filter(([name]) => !(name in snapshot)));
    expect(extra).toEqual(ADDED);
  });

  it("parses the palette it is guarding", () => {
    // A parser that silently matched nothing would pass both checks above.
    expect(Object.keys(snapshot).length).toBeGreaterThan(100);
    expect(snapshot["--bg-base"]).toBe("#000000");
  });
});
